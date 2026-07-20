import type {
  MemoryCompactionArtifactBody,
  MemoryCompactionEntryStatus,
  MemoryCompactionPlanEntry,
  MemoryCompactionPlanEnvelope,
  MemoryCompactionPlanStatus,
  MemoryCompactionPreview,
  MemoryCompactionTokenMetrics
} from "./memory-compaction.js";
import { memoryCompactionDigest } from "./memory-compaction-integrity.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort(compareCodeUnits)) === JSON.stringify([...right].sort(compareCodeUnits));
}

function overlapCount(plans: readonly MemoryCompactionPlanEntry[]): number {
  const owners = new Map<string, number>();
  for (const plan of plans.filter((entry) => entry.status === "ready")) {
    for (const recordId of plan.archived_source_record_ids) {
      owners.set(recordId, (owners.get(recordId) ?? 0) + 1);
    }
  }
  return [...owners.values()].filter((count) => count > 1).length;
}

function envelopeBody(envelope: MemoryCompactionArtifactBody): unknown {
  return envelope;
}

function previewBody(preview: MemoryCompactionArtifactBody): unknown {
  return { artifact: "memory_compaction_preview_v1", ...preview };
}

function assertTokenMetrics(metrics: MemoryCompactionTokenMetrics, label: string): void {
  const values = [
    metrics.before_estimated_tokens,
    metrics.after_estimated_tokens,
    metrics.reducible_estimated_tokens,
    metrics.archived_source_estimated_tokens,
    metrics.derived_record_estimated_tokens
  ];
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Invalid Memory Compaction ${label} token metrics`);
  }
  if (
    metrics.reducible_estimated_tokens !== Math.max(0, metrics.before_estimated_tokens - metrics.after_estimated_tokens)
  ) {
    throw new Error(`Invalid Memory Compaction ${label} token reduction`);
  }
}

function assertArtifactBody(body: MemoryCompactionArtifactBody): void {
  if (
    body.purge.included !== false ||
    body.purge.reason !== "Purge is a separate explicit lifecycle operation and is never part of compaction apply." ||
    body.sync_impact.event_model !== "append_only" ||
    body.sync_impact.propagates_via_normal_sync !== true ||
    body.sync_impact.git_history_retained !== true ||
    body.sync_impact.physical_purge !== false ||
    body.undo.mode !== "append_only_logical_restore" ||
    body.undo.requires_committed_receipt !== true ||
    body.undo.restores_source_trust_states !== true ||
    body.undo.archives_derived_rollups !== true ||
    body.undo.rollback_window !== "while_receipt_and_event_history_are_available" ||
    body.undo.erases_git_history !== false
  ) {
    throw new Error("Invalid Memory Compaction safety semantics");
  }
  if (
    typeof body.filters.include_private !== "boolean" ||
    !Number.isSafeInteger(body.filters.recent_window_days) ||
    body.filters.recent_window_days < 0 ||
    body.filters.recent_window_days > 3650 ||
    !body.private_access ||
    body.private_access.include_private !== body.filters.include_private ||
    typeof body.private_access.scope_complete !== "boolean" ||
    !Number.isSafeInteger(body.private_access.omitted_private_source_count) ||
    body.private_access.omitted_private_source_count < 0 ||
    body.private_access.scope_complete !== (body.private_access.omitted_private_source_count === 0) ||
    (body.private_access.include_private && body.private_access.omitted_private_source_count !== 0) ||
    (!body.private_access.include_private &&
      body.plans.some((entry) => entry.privacy.private_source_records > 0 || entry.privacy.boundary !== "public")) ||
    (body.private_access.omitted_private_source_count > 0
      ? body.private_access.omission_reason !== "private_sources_require_explicit_include_private"
      : body.private_access.omission_reason !== undefined)
  ) {
    throw new Error("Invalid Memory Compaction private-read boundary");
  }
  const privacyOmissionBlockers = body.blockers.filter((blocker) => blocker.code === "private_sources_omitted");
  if (
    body.private_access.omitted_private_source_count > 0
      ? privacyOmissionBlockers.length !== 1 ||
        privacyOmissionBlockers[0]!.disposition !== "review_required" ||
        privacyOmissionBlockers[0]!.record_ids.length !== 0 ||
        privacyOmissionBlockers[0]!.omitted_source_count !== body.private_access.omitted_private_source_count
      : privacyOmissionBlockers.length !== 0
  ) {
    throw new Error("Invalid Memory Compaction private-source omission blocker");
  }
  const planKeys = body.plans.map((entry) => `${entry.kind}\u0000${entry.plan_id}`);
  if (new Set(planKeys).size !== planKeys.length) throw new Error("Duplicate Memory Compaction child plan");
  for (const entry of body.plans) {
    if (
      !entry?.plan ||
      !["session_fold", "episode_rollup"].includes(entry.kind) ||
      !["ready", "review_required", "deferred"].includes(entry.status) ||
      entry.plan_id !== entry.plan.plan_id ||
      entry.child_plan_digest !== memoryCompactionDigest(entry.plan) ||
      !entry.project_id.trim() ||
      !entry.identity_key.trim()
    ) {
      throw new Error("Invalid Memory Compaction child plan");
    }
    const ready = entry.status === "ready";
    const expectedArchiveIds =
      entry.kind === "session_fold"
        ? ready
          ? entry.plan.source_record_ids
          : []
        : ready
          ? entry.plan.cold_candidates.map((candidate) => candidate.record_id)
          : [];
    const expectedDerivedId = ready ? entry.plan.rollup_record?.id : undefined;
    const expectedIdentityKey =
      entry.kind === "session_fold"
        ? `${entry.plan.identity.project_id}\u0000${entry.plan.identity.session_id}`
        : `${entry.plan.identity.project_id}\u0000${entry.plan.identity.bucket_kind}\u0000${entry.plan.identity.bucket_key}`;
    const childReady =
      entry.kind === "session_fold"
        ? entry.plan.status === "ready" && entry.plan.auto_fold && Boolean(entry.plan.rollup_record)
        : entry.plan.status === "ready" && Boolean(entry.plan.rollup_record);
    const expectedStatus: MemoryCompactionEntryStatus = childReady
      ? "ready"
      : entry.kind === "episode_rollup" && entry.plan.status === "deferred"
        ? "deferred"
        : "review_required";
    if (
      entry.status !== expectedStatus ||
      entry.project_id !== entry.plan.identity.project_id ||
      entry.identity_key !== expectedIdentityKey ||
      !sameStrings(entry.archived_source_record_ids, expectedArchiveIds) ||
      !sameStrings(
        entry.source_before_states.map((state) => state.record_id),
        expectedArchiveIds
      ) ||
      entry.derived_record_id !== expectedDerivedId ||
      entry.privacy.boundary !== entry.plan.privacy_boundary ||
      entry.privacy.crosses_privacy_boundary !== (entry.plan.privacy_boundary === "mixed") ||
      entry.privacy.receipt_payload !== "metadata_only" ||
      entry.sync_impact.event_model !== "append_only" ||
      entry.sync_impact.archive_events !== expectedArchiveIds.length ||
      entry.sync_impact.derived_record_events !== (ready ? 1 : 0) ||
      entry.sync_impact.estimated_total_events !==
        entry.sync_impact.archive_events + entry.sync_impact.derived_record_events ||
      entry.sync_impact.git_history_retained !== true ||
      entry.sync_impact.physical_purge !== false ||
      entry.undo.supported !== ready ||
      (ready && (entry.blockers.length > 0 || entry.coverage.coverage_ratio !== 1))
    ) {
      throw new Error("Inconsistent Memory Compaction child plan metadata");
    }
    if (
      entry.source_before_states.some(
        (state) =>
          !state.record_id.trim() ||
          !["raw", "candidate", "canonical"].includes(state.state) ||
          state.visibility !== "active" ||
          !/^[a-f0-9]{64}$/u.test(state.record_digest) ||
          !Number.isSafeInteger(state.estimated_tokens) ||
          state.estimated_tokens < 1
      )
    ) {
      throw new Error("Invalid Memory Compaction source before-state metadata");
    }
    assertTokenMetrics(entry.metrics, "entry");
    if (
      !Number.isSafeInteger(entry.metrics.before_active_record_count) ||
      !Number.isSafeInteger(entry.metrics.after_active_record_count) ||
      !Number.isSafeInteger(entry.metrics.preserved_warm_record_count) ||
      !Number.isSafeInteger(entry.metrics.preserved_warm_estimated_tokens) ||
      entry.metrics.before_active_record_count < 0 ||
      entry.metrics.after_active_record_count < 0 ||
      entry.metrics.preserved_warm_record_count < 0 ||
      entry.metrics.preserved_warm_estimated_tokens < 0
    ) {
      throw new Error("Invalid Memory Compaction entry metrics");
    }
  }
  const expectedStatus: MemoryCompactionPlanStatus =
    body.private_access.omitted_private_source_count > 0
      ? "review_required"
      : body.plans.length === 0
        ? "empty"
        : body.plans.every((entry) => entry.status === "ready") && overlapCount(body.plans) === 0
          ? "ready"
          : "review_required";
  const expectedArchiveEvents = body.plans.reduce((total, entry) => total + entry.sync_impact.archive_events, 0);
  const expectedDerivedEvents = body.plans.reduce((total, entry) => total + entry.sync_impact.derived_record_events, 0);
  if (
    body.status !== expectedStatus ||
    body.undo.supported !== (body.status === "ready") ||
    body.metrics.ready_plan_count !== body.plans.filter((entry) => entry.status === "ready").length ||
    body.metrics.blocked_plan_count !== body.plans.filter((entry) => entry.status !== "ready").length ||
    body.sync_impact.archive_events !== expectedArchiveEvents ||
    body.sync_impact.derived_record_events !== expectedDerivedEvents ||
    body.sync_impact.estimated_total_events !== expectedArchiveEvents + expectedDerivedEvents ||
    (body.status === "ready" && body.blockers.length > 0)
  ) {
    throw new Error("Inconsistent Memory Compaction envelope metadata");
  }
  assertTokenMetrics(body.metrics, "envelope");
  if (
    !Number.isSafeInteger(body.metrics.before_active_record_count) ||
    !Number.isSafeInteger(body.metrics.after_active_record_count) ||
    body.metrics.before_active_record_count < 0 ||
    body.metrics.after_active_record_count < 0
  ) {
    throw new Error("Invalid Memory Compaction envelope metrics");
  }
}

export function assertMemoryCompactionPreview(value: unknown): asserts value is MemoryCompactionPreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Memory Compaction preview");
  }
  const preview = value as Partial<MemoryCompactionPreview>;
  if (
    preview.version !== 1 ||
    typeof preview.preview_id !== "string" ||
    !/^memory_compaction_preview_[a-f0-9]{32}$/u.test(preview.preview_id) ||
    typeof preview.preview_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(preview.preview_digest) ||
    typeof preview.plan_id !== "string" ||
    !/^memory_compaction_[a-f0-9]{32}$/u.test(preview.plan_id) ||
    typeof preview.proposed_plan_id !== "string" ||
    !/^memory_compaction_[a-f0-9]{32}$/u.test(preview.proposed_plan_id) ||
    !["ready", "review_required", "empty"].includes(preview.status ?? "") ||
    typeof preview.planning_time !== "string" ||
    !canonicalIso(preview.planning_time) ||
    !preview.filters ||
    !preview.private_access ||
    !Array.isArray(preview.plans) ||
    !Array.isArray(preview.blockers) ||
    !preview.metrics ||
    !preview.sync_impact ||
    !preview.undo ||
    !preview.purge
  ) {
    throw new Error("Invalid Memory Compaction preview");
  }
  const {
    preview_id: _previewId,
    preview_digest: _previewDigest,
    plan_id: _planId,
    proposed_plan_id: _proposedPlanId,
    ...body
  } = preview as MemoryCompactionPreview;
  const expectedPreviewDigest = memoryCompactionDigest(previewBody(body));
  const expectedEnvelopeDigest = memoryCompactionDigest(envelopeBody(body));
  if (
    preview.preview_digest !== expectedPreviewDigest ||
    preview.preview_id !== `memory_compaction_preview_${expectedPreviewDigest.slice(0, 32)}` ||
    preview.plan_id !== `memory_compaction_${expectedEnvelopeDigest.slice(0, 32)}` ||
    preview.proposed_plan_id !== `memory_compaction_${expectedEnvelopeDigest.slice(0, 32)}`
  ) {
    throw new Error("Memory Compaction preview digest mismatch");
  }
  assertArtifactBody(body);
}

export function assertMemoryCompactionPlanEnvelope(value: unknown): asserts value is MemoryCompactionPlanEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Memory Compaction plan envelope");
  }
  const envelope = value as Partial<MemoryCompactionPlanEnvelope>;
  if (
    envelope.version !== 1 ||
    typeof envelope.plan_id !== "string" ||
    typeof envelope.envelope_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(envelope.envelope_digest) ||
    !/^memory_compaction_[a-f0-9]{32}$/u.test(envelope.plan_id) ||
    !["ready", "review_required", "empty"].includes(envelope.status ?? "") ||
    typeof envelope.planning_time !== "string" ||
    !canonicalIso(envelope.planning_time) ||
    !envelope.filters ||
    !envelope.private_access ||
    !Array.isArray(envelope.plans) ||
    !Array.isArray(envelope.blockers) ||
    !envelope.metrics ||
    !envelope.sync_impact ||
    !envelope.undo ||
    !envelope.purge
  ) {
    throw new Error("Invalid Memory Compaction plan envelope");
  }
  const { plan_id: _planId, envelope_digest: _digest, ...body } = envelope as MemoryCompactionPlanEnvelope;
  const expectedDigest = memoryCompactionDigest(envelopeBody(body));
  if (
    envelope.envelope_digest !== expectedDigest ||
    envelope.plan_id !== `memory_compaction_${expectedDigest.slice(0, 32)}`
  ) {
    throw new Error("Memory Compaction plan digest mismatch");
  }
  assertArtifactBody(body);
}
