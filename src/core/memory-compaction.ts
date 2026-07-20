import { type EpisodeBucketKind, type EpisodeRollupPlan, planEpisodeRollups } from "./episode-rollup.js";
import { memoryCompactionDigest, memoryCompactionRecordDigest } from "./memory-compaction-integrity.js";
import { assertMemoryCompactionPreview } from "./memory-compaction-validation.js";
import { buildMemoryRetentionView, type MemoryTrustState } from "./memory-retention.js";
import { estimateMemoryRecordTokens } from "./record-read-model.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import { planSessionFolds, type SessionFoldPlan } from "./session-fold.js";
import type { MorynRecord, RecordState, RecordVisibility } from "./types.js";

export {
  canonicalMemoryCompactionValue,
  memoryCompactionDigest,
  memoryCompactionRecordDigest,
  sameMemoryCompactionValue
} from "./memory-compaction-integrity.js";
export {
  assertMemoryCompactionPlanEnvelope,
  assertMemoryCompactionPreview
} from "./memory-compaction-validation.js";

export type MemoryCompactionKind = "session_fold" | "episode_rollup";
export type MemoryCompactionEntryStatus = "ready" | "review_required" | "deferred";
export type MemoryCompactionPlanStatus = "ready" | "review_required" | "empty";

export interface MemoryCompactionPreviewOptions {
  project_id?: string;
  session_id?: string;
  bucket_kind?: EpisodeBucketKind;
  bucket_key?: string;
  /** Canonical ISO planning time. Defaults deterministically to the latest input update. */
  now?: string;
  recent_window_days?: number;
  /**
   * Explicit private-read authorization. All public callers default this to false.
   */
  include_private?: boolean;
}

export interface MemoryCompactionFilters {
  project_id?: string;
  session_id?: string;
  bucket_kind?: EpisodeBucketKind;
  bucket_key?: string;
  include_private: boolean;
  recent_window_days: number;
}

export interface MemoryCompactionBlocker {
  code: string;
  message: string;
  record_ids: string[];
  disposition: "review_required" | "deferred";
  /** Count-only metadata for privacy omissions; private record ids are never returned. */
  omitted_source_count?: number;
}

export interface MemoryCompactionPrivateAccessSummary {
  include_private: boolean;
  scope_complete: boolean;
  omitted_private_source_count: number;
  omission_reason?: "private_sources_require_explicit_include_private";
}

export interface MemoryCompactionCoverageSummary {
  total_sources: number;
  covered_sources: number;
  coverage_ratio: number;
  complete: boolean;
  verification: "verified" | "incomplete";
  leaf_evidence?: {
    total: number;
    covered: number;
    claims: number;
    claims_with_evidence: number;
  };
}

export interface MemoryCompactionPrivacySummary {
  boundary: "public" | "private" | "mixed";
  public_source_records: number;
  private_source_records: number;
  crosses_privacy_boundary: boolean;
  receipt_payload: "metadata_only";
}

export interface MemoryCompactionTokenMetrics {
  before_estimated_tokens: number;
  after_estimated_tokens: number;
  reducible_estimated_tokens: number;
  archived_source_estimated_tokens: number;
  derived_record_estimated_tokens: number;
}

export interface MemoryCompactionEntryMetrics extends MemoryCompactionTokenMetrics {
  before_active_record_count: number;
  after_active_record_count: number;
  preserved_warm_record_count: number;
  preserved_warm_estimated_tokens: number;
}

export interface MemoryCompactionSourceBeforeState {
  record_id: string;
  state: RecordState;
  visibility: RecordVisibility;
  trust_state: MemoryTrustState;
  record_digest: string;
  estimated_tokens: number;
}

export interface MemoryCompactionSyncImpact {
  event_model: "append_only";
  derived_record_events: number;
  archive_events: number;
  estimated_total_events: number;
  propagates_via_normal_sync: true;
  git_history_retained: true;
  physical_purge: false;
}

export interface MemoryCompactionUndoSemantics {
  supported: boolean;
  mode: "append_only_logical_restore";
  requires_committed_receipt: true;
  restores_source_trust_states: true;
  archives_derived_rollups: true;
  rollback_window: "while_receipt_and_event_history_are_available";
  erases_git_history: false;
}

interface MemoryCompactionPlanEntryBase {
  kind: MemoryCompactionKind;
  plan_id: string;
  child_plan_digest: string;
  status: MemoryCompactionEntryStatus;
  project_id: string;
  identity_key: string;
  privacy: MemoryCompactionPrivacySummary;
  coverage: MemoryCompactionCoverageSummary;
  blockers: MemoryCompactionBlocker[];
  metrics: MemoryCompactionEntryMetrics;
  source_before_states: MemoryCompactionSourceBeforeState[];
  archived_source_record_ids: string[];
  derived_record_id?: string;
  sync_impact: MemoryCompactionSyncImpact;
  undo: MemoryCompactionUndoSemantics;
}

export interface SessionFoldCompactionEntry extends MemoryCompactionPlanEntryBase {
  kind: "session_fold";
  plan: SessionFoldPlan;
}

export interface EpisodeRollupCompactionEntry extends MemoryCompactionPlanEntryBase {
  kind: "episode_rollup";
  plan: EpisodeRollupPlan;
}

export type MemoryCompactionPlanEntry = SessionFoldCompactionEntry | EpisodeRollupCompactionEntry;

export interface MemoryCompactionEnvelopeMetrics extends MemoryCompactionTokenMetrics {
  before_active_record_count: number;
  after_active_record_count: number;
  ready_plan_count: number;
  blocked_plan_count: number;
}

export interface MemoryCompactionArtifactBody {
  version: 1;
  status: MemoryCompactionPlanStatus;
  planning_time: string;
  filters: MemoryCompactionFilters;
  private_access: MemoryCompactionPrivateAccessSummary;
  plans: MemoryCompactionPlanEntry[];
  blockers: MemoryCompactionBlocker[];
  metrics: MemoryCompactionEnvelopeMetrics;
  sync_impact: MemoryCompactionSyncImpact;
  undo: MemoryCompactionUndoSemantics;
  purge: {
    included: false;
    reason: "Purge is a separate explicit lifecycle operation and is never part of compaction apply.";
  };
}

export interface MemoryCompactionPreview extends MemoryCompactionArtifactBody {
  preview_id: string;
  preview_digest: string;
  /** Deterministic id of the plan that `planMemoryCompaction` will seal. */
  plan_id: string;
  proposed_plan_id: string;
}

export interface MemoryCompactionPlanEnvelope extends MemoryCompactionArtifactBody {
  plan_id: string;
  envelope_digest: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizedOptional(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`Memory Compaction ${label} must not be empty`);
  return normalized;
}

function planningTime(records: readonly MorynRecord[], requested: string | undefined): string {
  if (requested !== undefined) {
    if (!canonicalIso(requested)) throw new Error("Memory Compaction now must be a canonical ISO timestamp");
    return requested;
  }
  const latest = records
    .map((record) => record.updated_at)
    .filter(canonicalIso)
    .sort(compareCodeUnits)
    .at(-1);
  return latest ?? "1970-01-01T00:00:00.000Z";
}

function isActive(record: MorynRecord): boolean {
  return record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined";
}

function isPrivateCompactionSource(record: MorynRecord): boolean {
  return isPrivateMemoryBoundary(record);
}

function beforeStates(
  recordById: ReadonlyMap<string, MorynRecord>,
  recordIds: readonly string[],
  now: string
): MemoryCompactionSourceBeforeState[] {
  return [...new Set(recordIds)].sort(compareCodeUnits).map((recordId) => {
    const record = recordById.get(recordId);
    if (!record) throw new Error(`Memory Compaction source record is missing: ${recordId}`);
    const retention = buildMemoryRetentionView(record, { now });
    return {
      record_id: record.id,
      state: record.state,
      visibility: record.visibility,
      trust_state: retention.trust.state,
      record_digest: memoryCompactionRecordDigest(record),
      estimated_tokens: estimateMemoryRecordTokens(record)
    };
  });
}

function privacySummary(
  boundary: "public" | "private" | "mixed",
  sourcePrivacy: readonly ("public" | "private")[]
): MemoryCompactionPrivacySummary {
  return {
    boundary,
    public_source_records: sourcePrivacy.filter((privacy) => privacy === "public").length,
    private_source_records: sourcePrivacy.filter((privacy) => privacy === "private").length,
    crosses_privacy_boundary: boundary === "mixed",
    receipt_payload: "metadata_only"
  };
}

function entryMetrics(
  states: readonly MemoryCompactionSourceBeforeState[],
  preservedWarm: readonly MorynRecord[],
  derived: MorynRecord | undefined,
  ready: boolean
): MemoryCompactionEntryMetrics {
  const archivedTokens = states.reduce((total, state) => total + state.estimated_tokens, 0);
  const warmTokens = preservedWarm.reduce((total, record) => total + estimateMemoryRecordTokens(record), 0);
  const beforeTokens = archivedTokens + warmTokens;
  const derivedTokens = derived ? estimateMemoryRecordTokens(derived) : 0;
  const afterTokens = ready ? warmTokens + derivedTokens : beforeTokens;
  return {
    before_active_record_count:
      states.filter(
        (state) => state.visibility === "active" && state.state !== "archived" && state.state !== "quarantined"
      ).length + preservedWarm.filter(isActive).length,
    after_active_record_count: ready
      ? preservedWarm.filter(isActive).length + (derived ? 1 : 0)
      : states.length + preservedWarm.filter(isActive).length,
    preserved_warm_record_count: preservedWarm.length,
    preserved_warm_estimated_tokens: warmTokens,
    before_estimated_tokens: beforeTokens,
    after_estimated_tokens: afterTokens,
    reducible_estimated_tokens: Math.max(0, beforeTokens - afterTokens),
    archived_source_estimated_tokens: ready ? archivedTokens : 0,
    derived_record_estimated_tokens: ready ? derivedTokens : 0
  };
}

function syncImpact(archiveEvents: number, derivedEvents: number): MemoryCompactionSyncImpact {
  return {
    event_model: "append_only",
    derived_record_events: derivedEvents,
    archive_events: archiveEvents,
    estimated_total_events: archiveEvents + derivedEvents,
    propagates_via_normal_sync: true,
    git_history_retained: true,
    physical_purge: false
  };
}

function undoSemantics(supported: boolean): MemoryCompactionUndoSemantics {
  return {
    supported,
    mode: "append_only_logical_restore",
    requires_committed_receipt: true,
    restores_source_trust_states: true,
    archives_derived_rollups: true,
    rollback_window: "while_receipt_and_event_history_are_available",
    erases_git_history: false
  };
}

function sessionEntry(
  plan: SessionFoldPlan,
  recordById: ReadonlyMap<string, MorynRecord>,
  now: string
): SessionFoldCompactionEntry {
  const ready = plan.status === "ready" && plan.auto_fold && Boolean(plan.rollup_record);
  const archivedIds = ready ? plan.source_record_ids : [];
  const states = beforeStates(recordById, archivedIds, now);
  const blockers: MemoryCompactionBlocker[] = plan.review_reasons.map((reason) => ({
    code: reason.code,
    message: reason.message,
    record_ids: [...reason.record_ids].sort(compareCodeUnits),
    disposition: "review_required"
  }));
  return {
    kind: "session_fold",
    plan_id: plan.plan_id,
    child_plan_digest: memoryCompactionDigest(plan),
    status: ready ? "ready" : "review_required",
    project_id: plan.identity.project_id,
    identity_key: `${plan.identity.project_id}\u0000${plan.identity.session_id}`,
    privacy: privacySummary(
      plan.privacy_boundary,
      plan.source_digests.map((source) => source.privacy)
    ),
    coverage: {
      total_sources: plan.coverage.total_source_records,
      covered_sources: plan.coverage.covered_source_records,
      coverage_ratio: plan.coverage.coverage_ratio,
      complete: plan.coverage.coverage_ratio === 1,
      verification: plan.coverage.coverage_ratio === 1 ? "verified" : "incomplete"
    },
    blockers,
    metrics: entryMetrics(states, [], ready ? plan.rollup_record : undefined, ready),
    source_before_states: states,
    archived_source_record_ids: archivedIds,
    ...(ready && plan.rollup_record ? { derived_record_id: plan.rollup_record.id } : {}),
    sync_impact: syncImpact(archivedIds.length, ready ? 1 : 0),
    undo: undoSemantics(ready),
    plan
  };
}

function episodeEntry(
  plan: EpisodeRollupPlan,
  recordById: ReadonlyMap<string, MorynRecord>,
  now: string
): EpisodeRollupCompactionEntry {
  const ready = plan.status === "ready" && Boolean(plan.rollup_record);
  const candidateArchiveIds = plan.cold_candidates.map((candidate) => candidate.record_id);
  const archivedIds = ready ? candidateArchiveIds : [];
  const candidateStates = beforeStates(recordById, candidateArchiveIds, now);
  const states = ready ? candidateStates : [];
  const preservedWarm = plan.warm_candidates.map((candidate) => {
    const record = recordById.get(candidate.record_id);
    if (!record) throw new Error(`Memory Compaction warm source record is missing: ${candidate.record_id}`);
    return record;
  });
  const reviewBlockers: MemoryCompactionBlocker[] = plan.review_reasons.map((reason) => ({
    code: reason.code,
    message: reason.message,
    record_ids: [...reason.record_ids].sort(compareCodeUnits),
    disposition: "review_required"
  }));
  const deferredBlockers: MemoryCompactionBlocker[] = plan.deferred_reasons.map((reason) => ({
    code: reason.code,
    message: reason.message,
    record_ids: [...reason.record_ids].sort(compareCodeUnits),
    disposition: "deferred"
  }));
  const status: MemoryCompactionEntryStatus = ready
    ? "ready"
    : plan.status === "deferred"
      ? "deferred"
      : "review_required";
  return {
    kind: "episode_rollup",
    plan_id: plan.plan_id,
    child_plan_digest: memoryCompactionDigest(plan),
    status,
    project_id: plan.identity.project_id,
    identity_key: `${plan.identity.project_id}\u0000${plan.identity.bucket_kind}\u0000${plan.identity.bucket_key}`,
    privacy: privacySummary(
      plan.privacy_boundary,
      plan.source_digests.map((source) => source.privacy)
    ),
    coverage: {
      total_sources: plan.coverage.total_source_rollups,
      covered_sources: plan.coverage.covered_source_rollups,
      coverage_ratio: plan.coverage.coverage_ratio,
      complete: plan.coverage.coverage_ratio === 1,
      verification: plan.coverage.coverage_ratio === 1 ? "verified" : "incomplete",
      leaf_evidence: {
        total: plan.coverage.source_leaf_evidence,
        covered: plan.coverage.covered_leaf_evidence,
        claims: plan.coverage.output_claims,
        claims_with_evidence: plan.coverage.claims_with_leaf_evidence
      }
    },
    blockers: [...reviewBlockers, ...deferredBlockers],
    metrics: entryMetrics(candidateStates, preservedWarm, ready ? plan.rollup_record : undefined, ready),
    source_before_states: states,
    archived_source_record_ids: [...archivedIds].sort(compareCodeUnits),
    ...(ready && plan.rollup_record ? { derived_record_id: plan.rollup_record.id } : {}),
    sync_impact: syncImpact(archivedIds.length, ready ? 1 : 0),
    undo: undoSemantics(ready),
    plan
  };
}

function envelopeMetrics(
  records: readonly MorynRecord[],
  plans: readonly MemoryCompactionPlanEntry[]
): MemoryCompactionEnvelopeMetrics {
  const activeRecords = records.filter(isActive);
  const activeById = new Map(activeRecords.map((record) => [record.id, record]));
  const ready = plans.filter((plan) => plan.status === "ready");
  const archivedIds = new Set(ready.flatMap((plan) => plan.archived_source_record_ids));
  const derived = ready
    .map((entry) => entry.plan.rollup_record)
    .filter((record): record is NonNullable<typeof record> => Boolean(record));
  const beforeTokens = activeRecords.reduce((total, record) => total + estimateMemoryRecordTokens(record), 0);
  const archivedTokens = [...archivedIds].reduce(
    (total, recordId) => total + (activeById.has(recordId) ? estimateMemoryRecordTokens(activeById.get(recordId)!) : 0),
    0
  );
  const derivedTokens = derived.reduce((total, record) => total + estimateMemoryRecordTokens(record), 0);
  const addedDerived = derived.filter((record) => !activeById.has(record.id)).length;
  const archivedActive = [...archivedIds].filter((recordId) => activeById.has(recordId)).length;
  const afterTokens = beforeTokens - archivedTokens + derivedTokens;
  return {
    before_active_record_count: activeRecords.length,
    after_active_record_count: activeRecords.length - archivedActive + addedDerived,
    before_estimated_tokens: beforeTokens,
    after_estimated_tokens: afterTokens,
    reducible_estimated_tokens: Math.max(0, beforeTokens - afterTokens),
    archived_source_estimated_tokens: archivedTokens,
    derived_record_estimated_tokens: derivedTokens,
    ready_plan_count: ready.length,
    blocked_plan_count: plans.length - ready.length
  };
}

function metricsScopeRecords(
  records: readonly MorynRecord[],
  filters: MemoryCompactionFilters,
  plans: readonly MemoryCompactionPlanEntry[]
): MorynRecord[] {
  let scoped = filters.project_id ? records.filter((record) => record.project_id === filters.project_id) : [...records];
  if (filters.session_id) {
    scoped = scoped.filter((record) => record.source.session_id === filters.session_id);
  }
  if (filters.bucket_kind) {
    const bucketRecordIds = new Set(
      plans.flatMap((entry) =>
        entry.kind === "episode_rollup"
          ? [...entry.plan.source_record_ids, ...entry.plan.warm_candidates.map((candidate) => candidate.record_id)]
          : []
      )
    );
    scoped = scoped.filter((record) => bucketRecordIds.has(record.id));
  }
  return scoped;
}

function scopedSourceRecordIds(
  records: readonly MorynRecord[],
  options: {
    project_id?: string;
    session_id?: string;
    bucket_kind?: EpisodeBucketKind;
    bucket_key?: string;
    now: string;
    recent_window_days: number;
  }
): Set<string> {
  const sessionPlans = options.bucket_kind
    ? []
    : planSessionFolds(records, {
        ...(options.project_id ? { project_id: options.project_id } : {})
      }).filter((plan) => !options.session_id || plan.identity.session_id === options.session_id);
  const episodePlans = options.session_id
    ? []
    : planEpisodeRollups(records, {
        now: options.now,
        recent_window_days: options.recent_window_days,
        ...(options.project_id ? { project_id: options.project_id } : {}),
        ...(options.bucket_kind ? { bucket_kind: options.bucket_kind } : {})
      }).filter((plan) => !options.bucket_key || plan.identity.bucket_key === options.bucket_key);
  return new Set([
    ...sessionPlans.flatMap((plan) => plan.source_record_ids),
    ...episodePlans.flatMap((plan) => [
      ...plan.source_record_ids,
      ...plan.warm_candidates.map((candidate) => candidate.record_id)
    ])
  ]);
}

function overlapBlockers(plans: readonly MemoryCompactionPlanEntry[]): MemoryCompactionBlocker[] {
  const owners = new Map<string, string[]>();
  for (const plan of plans.filter((entry) => entry.status === "ready")) {
    for (const recordId of plan.archived_source_record_ids) {
      const current = owners.get(recordId) ?? [];
      current.push(plan.plan_id);
      owners.set(recordId, current);
    }
  }
  return [...owners.entries()]
    .filter(([, planIds]) => planIds.length > 1)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([recordId, planIds]) => ({
      code: "overlapping_source_transition",
      message: `Multiple compaction plans would archive the same source: ${planIds.sort(compareCodeUnits).join(", ")}`,
      record_ids: [recordId],
      disposition: "review_required" as const
    }));
}

function envelopeBody(envelope: MemoryCompactionArtifactBody): unknown {
  return envelope;
}

function previewBody(preview: MemoryCompactionArtifactBody): unknown {
  return { artifact: "memory_compaction_preview_v1", ...preview };
}

/**
 * Produces a deterministic, integrity-bound preview. It never mutates records and never performs purge.
 */
export function previewMemoryCompaction(
  records: readonly MorynRecord[],
  options: MemoryCompactionPreviewOptions = {}
): MemoryCompactionPreview {
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw new Error("Memory Compaction preview requires unique record ids");
  }
  const projectId = normalizedOptional(options.project_id, "project_id");
  const sessionId = normalizedOptional(options.session_id, "session_id");
  const bucketKey = normalizedOptional(options.bucket_key, "bucket_key");
  if (sessionId && (options.bucket_kind || bucketKey)) {
    throw new Error("Memory Compaction session and bucket filters are mutually exclusive");
  }
  if (bucketKey && !options.bucket_kind) {
    throw new Error("Memory Compaction bucket_key requires bucket_kind");
  }
  if (options.include_private !== undefined && typeof options.include_private !== "boolean") {
    throw new Error("Memory Compaction include_private must be a boolean");
  }
  const includePrivate = options.include_private === true;
  const recentWindowDays = options.recent_window_days ?? 7;
  const visibleRecords = includePrivate ? [...records] : records.filter((record) => !isPrivateCompactionSource(record));
  const now = planningTime(visibleRecords, options.now);
  const filters: MemoryCompactionFilters = {
    ...(projectId ? { project_id: projectId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(options.bucket_kind ? { bucket_kind: options.bucket_kind } : {}),
    ...(bucketKey ? { bucket_key: bucketKey } : {}),
    include_private: includePrivate,
    recent_window_days: recentWindowDays
  };
  const scopedSourceIds = includePrivate
    ? new Set<string>()
    : scopedSourceRecordIds(records, {
        ...(projectId ? { project_id: projectId } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
        ...(options.bucket_kind ? { bucket_kind: options.bucket_kind } : {}),
        ...(bucketKey ? { bucket_key: bucketKey } : {}),
        now,
        recent_window_days: recentWindowDays
      });
  const omittedPrivateSourceCount = includePrivate
    ? 0
    : records.filter((record) => scopedSourceIds.has(record.id) && isPrivateCompactionSource(record)).length;
  const privateAccess: MemoryCompactionPrivateAccessSummary = {
    include_private: includePrivate,
    scope_complete: omittedPrivateSourceCount === 0,
    omitted_private_source_count: omittedPrivateSourceCount,
    ...(omittedPrivateSourceCount > 0
      ? { omission_reason: "private_sources_require_explicit_include_private" as const }
      : {})
  };
  const recordById = new Map(visibleRecords.map((record) => [record.id, record]));
  const sessionPlans = options.bucket_kind
    ? []
    : planSessionFolds(visibleRecords, { ...(projectId ? { project_id: projectId } : {}) }).filter(
        (plan) => !sessionId || plan.identity.session_id === sessionId
      );
  const episodePlans = sessionId
    ? []
    : planEpisodeRollups(visibleRecords, {
        now,
        recent_window_days: recentWindowDays,
        ...(projectId ? { project_id: projectId } : {}),
        ...(options.bucket_kind ? { bucket_kind: options.bucket_kind } : {})
      }).filter((plan) => !bucketKey || plan.identity.bucket_key === bucketKey);
  const plans: MemoryCompactionPlanEntry[] = [
    ...sessionPlans.map((plan) => sessionEntry(plan, recordById, now)),
    ...episodePlans.map((plan) => episodeEntry(plan, recordById, now))
  ].sort(
    (left, right) =>
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.project_id, right.project_id) ||
      compareCodeUnits(left.identity_key, right.identity_key) ||
      compareCodeUnits(left.plan_id, right.plan_id)
  );
  const overlaps = overlapBlockers(plans);
  const privacyOmissionBlockers: MemoryCompactionBlocker[] =
    omittedPrivateSourceCount > 0
      ? [
          {
            code: "private_sources_omitted",
            message:
              "Private compaction sources were omitted. Explicit include_private authorization is required before this scope can be planned or applied.",
            record_ids: [],
            disposition: "review_required",
            omitted_source_count: omittedPrivateSourceCount
          }
        ]
      : [];
  const blockers = [...plans.flatMap((plan) => plan.blockers), ...overlaps, ...privacyOmissionBlockers].sort(
    (left, right) =>
      compareCodeUnits(left.disposition, right.disposition) ||
      compareCodeUnits(left.code, right.code) ||
      compareCodeUnits(left.record_ids.join("\u0000"), right.record_ids.join("\u0000"))
  );
  const status: MemoryCompactionPlanStatus =
    privacyOmissionBlockers.length > 0
      ? "review_required"
      : plans.length === 0
        ? "empty"
        : plans.every((plan) => plan.status === "ready") && overlaps.length === 0
          ? "ready"
          : "review_required";
  const metrics = envelopeMetrics(metricsScopeRecords(visibleRecords, filters, plans), plans);
  const totalArchiveEvents = plans.reduce((total, plan) => total + plan.sync_impact.archive_events, 0);
  const totalDerivedEvents = plans.reduce((total, plan) => total + plan.sync_impact.derived_record_events, 0);
  const body: MemoryCompactionArtifactBody = {
    version: 1,
    status,
    planning_time: now,
    filters,
    private_access: privateAccess,
    plans,
    blockers,
    metrics,
    sync_impact: syncImpact(totalArchiveEvents, totalDerivedEvents),
    undo: undoSemantics(status === "ready"),
    purge: {
      included: false,
      reason: "Purge is a separate explicit lifecycle operation and is never part of compaction apply."
    }
  };
  const envelopeDigest = memoryCompactionDigest(envelopeBody(body));
  const previewDigest = memoryCompactionDigest(previewBody(body));
  return {
    ...body,
    preview_id: `memory_compaction_preview_${previewDigest.slice(0, 32)}`,
    preview_digest: previewDigest,
    plan_id: `memory_compaction_${envelopeDigest.slice(0, 32)}`,
    proposed_plan_id: `memory_compaction_${envelopeDigest.slice(0, 32)}`
  };
}

/** Seals a deterministic preview into the only artifact accepted by apply. */
export function planMemoryCompaction(preview: MemoryCompactionPreview): MemoryCompactionPlanEnvelope {
  assertMemoryCompactionPreview(preview);
  const {
    preview_id: _previewId,
    preview_digest: _previewDigest,
    plan_id: _planId,
    proposed_plan_id: _proposedPlanId,
    ...body
  } = preview;
  const envelopeDigest = memoryCompactionDigest(envelopeBody(body));
  return {
    ...body,
    plan_id: `memory_compaction_${envelopeDigest.slice(0, 32)}`,
    envelope_digest: envelopeDigest
  };
}
