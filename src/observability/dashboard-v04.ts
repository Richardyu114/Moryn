import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { type EpisodeRollupPlan, planEpisodeRollups } from "../core/episode-rollup.js";
import { buildMemoryRetentionReadModel, type MemoryLayer, type MemoryRetentionTier } from "../core/memory-retention.js";
import { estimateMemoryRecordTokens } from "../core/record-read-model.js";
import { planSessionFolds, type SessionFoldPlan } from "../core/session-fold.js";
import { readSoulCompilationReceipt, type SoulCompilationReceipt } from "../core/soul-compilation-receipts.js";
import {
  readSoulProfileStatus,
  type SoulProfileStatus,
  type SoulProfileStatusEntry
} from "../core/soul-profile-management.js";
import type { MorynRecord } from "../core/types.js";

export const DASHBOARD_V04_SELECTION_SOURCES = {
  memory_maintenance: "memory_maintenance",
  memory_layer: "memory_maintenance.inventory.layers.<layer>",
  memory_tier: "memory_maintenance.inventory.tiers.<tier>",
  session_fold: "memory_maintenance.session_fold.plans[]",
  episode_rollup: "memory_maintenance.episode_rollup.plans[]",
  soul_studio: "soul_studio",
  soul_profile: "soul_studio.profiles[]",
  soul_revision: "soul_studio.profiles[].revisions[]",
  soul_compilation: "soul_studio.compilation",
  soul_delivery: "soul_studio.delivery"
} as const;

export interface DashboardCompactionPlanPreview {
  plan_id: string;
  status: "ready" | "deferred" | "review_required";
  scope: {
    project_id: string;
    kind: "session" | "day" | "task" | "project_epoch";
    key: string;
  };
  privacy_boundary: "public" | "private" | "mixed";
  coverage: {
    source_records: number;
    covered_records: number;
    ratio: number;
    verified: boolean;
  };
  token_estimate: {
    before: number;
    after: number;
    reducible: number;
  };
  candidates: {
    cold: number;
    warm: number;
    archive: number;
  };
  review_codes: string[];
  deferred_codes: string[];
  preview_only: true;
  sync_impact: "none_until_apply";
  undo: {
    available_after_apply: true;
    window: "while_append_only_source_history_is_retained";
    physical_purge_included: false;
  };
}

export interface DashboardMemoryMaintenance {
  version: 1;
  read_only: true;
  generated_at: string;
  inventory: {
    records: number;
    layers: Record<MemoryLayer, number>;
    tiers: Record<MemoryRetentionTier, number>;
    pinned: number;
    never_forget: number;
    malformed_metadata: number;
  };
  tokens: {
    estimate: "deterministic_canonical_json";
    total: number;
    active_working_set: number;
    by_layer: Record<MemoryLayer, number>;
    by_tier: Record<MemoryRetentionTier, number>;
    reducible: number;
    physical_storage_deleted: 0;
  };
  session_fold: {
    total: number;
    ready: number;
    review_required: number;
    plans: DashboardCompactionPlanPreview[];
  };
  episode_rollup: {
    total: number;
    ready: number;
    deferred: number;
    review_required: number;
    plans: DashboardCompactionPlanPreview[];
  };
  safety: {
    mode: "preview_only";
    writes: "none";
    coverage: "verified_before_apply";
    privacy: "aggregate_and_metadata_only";
    sync_impact: "none_until_apply_then_append_only_events";
    undo_window: "while_append_only_source_history_is_retained";
    physical_purge_included: false;
  };
}

export interface DashboardSoulRevision {
  revision_id: string;
  generation: number;
  parent_revision_ids: string[];
  state: "draft" | "active" | "superseded" | "conflicted";
  approved: boolean;
  approval_receipt_verified: boolean;
  is_head: boolean;
  is_effective: boolean;
  local_saved: boolean;
  personal_sync_saved: boolean;
  created_at?: string;
}

export interface DashboardSoulProfile {
  profile_id: string;
  subject: SoulProfileStatusEntry["subject"];
  revision_count: number;
  head_revision_ids: string[];
  active_revision_id?: string;
  selection_status: SoulProfileStatusEntry["selection_status"];
  conflicted: boolean;
  states: Record<DashboardSoulRevision["state"], number>;
  persistence: {
    local_saved: boolean;
    personal_sync_saved: boolean;
  };
  revisions: DashboardSoulRevision[];
  rollback: {
    available: boolean;
    requires_confirmation: true;
    target_revision_ids: string[];
    latest_receipt?: {
      receipt_id: string;
      source_revision_id: string;
      approved_revision_id: string;
      approved_at: string;
    };
  };
}

export interface DashboardSoulStudio {
  version: 1;
  read_only: true;
  summary: {
    profiles: number;
    revisions: number;
    draft: number;
    active: number;
    conflicted: number;
    local_saved: number;
    personal_sync_saved: number;
  };
  profiles: DashboardSoulProfile[];
  compilation: {
    status: SoulProfileStatus["compilation"]["status"];
    deliverable: boolean;
    selected_revision_ids: string[];
    omissions: number;
    conflicts: number;
    receipt: {
      found: boolean;
      current: boolean;
      receipt_id?: string;
      compiled_at?: string;
      status?: SoulCompilationReceipt["status"];
    };
  };
  delivery: {
    host_context_prepared: boolean;
    current_receipts: number;
    latest?: {
      receipt_id: string;
      host: "codex" | "claude";
      event: "session_start" | "post_compact";
      occurred_at: string;
      source_revision_ids: string[];
    };
  };
  warnings: {
    count: number;
    codes: string[];
  };
  privacy: {
    clause_payloads_exposed: false;
    local_only_clause_text_exposed: false;
    receipt_payloads: "metadata_only";
  };
}

export interface DashboardV04Data {
  memory_maintenance: DashboardMemoryMaintenance;
  soul_studio: DashboardSoulStudio;
  selection_sources: typeof DASHBOARD_V04_SELECTION_SOURCES;
}

export interface BuildDashboardV04Options {
  project_id?: string;
  now: string;
}

const COMPILATION_RECEIPT_PATTERN = /^[a-f0-9]{64}\.json$/u;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function emptyCounts<T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

function scopedRecords(records: readonly MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return records.filter((record) => !projectId || record.project_id === projectId || record.scope === "global");
}

function tokenSum(recordIds: readonly string[], recordsById: Map<string, MorynRecord>): number {
  return [...new Set(recordIds)].reduce((total, recordId) => {
    const record = recordsById.get(recordId);
    return total + (record ? estimateMemoryRecordTokens(record) : 0);
  }, 0);
}

function foldPreview(plan: SessionFoldPlan, recordsById: Map<string, MorynRecord>): DashboardCompactionPlanPreview {
  const before = tokenSum(plan.source_record_ids, recordsById);
  const after = plan.status === "ready" && plan.rollup_record ? estimateMemoryRecordTokens(plan.rollup_record) : before;
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    scope: {
      project_id: plan.identity.project_id,
      kind: "session",
      key: plan.identity.session_id
    },
    privacy_boundary: plan.privacy_boundary,
    coverage: {
      source_records: plan.coverage.total_source_records,
      covered_records: plan.coverage.covered_source_records,
      ratio: plan.coverage.coverage_ratio,
      verified: plan.coverage.coverage_attestation === "verified"
    },
    token_estimate: {
      before,
      after,
      reducible: Math.max(0, before - after)
    },
    candidates: {
      cold: plan.cold_candidates.length,
      warm: 0,
      archive: plan.archive_candidates.length
    },
    review_codes: [...new Set(plan.review_reasons.map((reason) => reason.code))].sort(compareCodeUnits),
    deferred_codes: [],
    preview_only: true,
    sync_impact: "none_until_apply",
    undo: {
      available_after_apply: true,
      window: "while_append_only_source_history_is_retained",
      physical_purge_included: false
    }
  };
}

function episodePreview(
  plan: EpisodeRollupPlan,
  recordsById: Map<string, MorynRecord>
): DashboardCompactionPlanPreview {
  const before = tokenSum(plan.source_record_ids, recordsById);
  const warmTokens = tokenSum(
    plan.warm_candidates.map((candidate) => candidate.record_id),
    recordsById
  );
  const rollupTokens =
    plan.status === "ready" && plan.rollup_record ? estimateMemoryRecordTokens(plan.rollup_record) : 0;
  const after = plan.status === "ready" ? warmTokens + rollupTokens : before;
  return {
    plan_id: plan.plan_id,
    status: plan.status,
    scope: {
      project_id: plan.identity.project_id,
      kind: plan.identity.bucket_kind,
      key: plan.identity.bucket_key
    },
    privacy_boundary: plan.privacy_boundary,
    coverage: {
      source_records: plan.coverage.total_source_rollups,
      covered_records: plan.coverage.covered_source_rollups,
      ratio: plan.coverage.coverage_ratio,
      verified:
        plan.coverage.total_source_rollups > 0 &&
        plan.coverage.total_source_rollups === plan.coverage.covered_source_rollups
    },
    token_estimate: {
      before,
      after,
      reducible: Math.max(0, before - after)
    },
    candidates: {
      cold: plan.cold_candidates.length,
      warm: plan.warm_candidates.length,
      archive: 0
    },
    review_codes: [...new Set(plan.review_reasons.map((reason) => reason.code))].sort(compareCodeUnits),
    deferred_codes: [...new Set(plan.deferred_reasons.map((reason) => reason.code))].sort(compareCodeUnits),
    preview_only: true,
    sync_impact: "none_until_apply",
    undo: {
      available_after_apply: true,
      window: "while_append_only_source_history_is_retained",
      physical_purge_included: false
    }
  };
}

export function buildDashboardMemoryMaintenance(
  records: readonly MorynRecord[],
  options: BuildDashboardV04Options
): DashboardMemoryMaintenance {
  const selected = scopedRecords(records, options.project_id);
  const recordsById = new Map(selected.map((record) => [record.id, record]));
  const retention = buildMemoryRetentionReadModel(selected, { now: options.now });
  const tokensByLayer = emptyCounts(["L0", "L1", "L2", "L3"] as const);
  const tokensByTier = emptyCounts(["hot", "warm", "cold", "purged"] as const);
  let totalTokens = 0;
  for (const view of retention.records) {
    const record = recordsById.get(view.record_id);
    if (!record) continue;
    const tokens = estimateMemoryRecordTokens(record);
    totalTokens += tokens;
    tokensByLayer[view.layer.level] += tokens;
    tokensByTier[view.retention.tier] += tokens;
  }

  const foldPlans = planSessionFolds(selected, { project_id: options.project_id }).map((plan) =>
    foldPreview(plan, recordsById)
  );
  const episodePlans = planEpisodeRollups(selected, {
    now: options.now,
    project_id: options.project_id,
    bucket_kind: "day"
  }).map((plan) => episodePreview(plan, recordsById));
  const reducible = [...foldPlans, ...episodePlans]
    .filter((plan) => plan.status === "ready")
    .reduce((total, plan) => total + plan.token_estimate.reducible, 0);

  return {
    version: 1,
    read_only: true,
    generated_at: options.now,
    inventory: {
      records: retention.stats.total_records,
      layers: retention.stats.layers,
      tiers: retention.stats.tiers,
      pinned: retention.stats.pinned_records,
      never_forget: retention.stats.never_forget_records,
      malformed_metadata: retention.stats.malformed_metadata_records
    },
    tokens: {
      estimate: "deterministic_canonical_json",
      total: totalTokens,
      active_working_set: tokensByTier.hot + tokensByTier.warm,
      by_layer: tokensByLayer,
      by_tier: tokensByTier,
      reducible,
      physical_storage_deleted: 0
    },
    session_fold: {
      total: foldPlans.length,
      ready: foldPlans.filter((plan) => plan.status === "ready").length,
      review_required: foldPlans.filter((plan) => plan.status === "review_required").length,
      plans: foldPlans
    },
    episode_rollup: {
      total: episodePlans.length,
      ready: episodePlans.filter((plan) => plan.status === "ready").length,
      deferred: episodePlans.filter((plan) => plan.status === "deferred").length,
      review_required: episodePlans.filter((plan) => plan.status === "review_required").length,
      plans: episodePlans
    },
    safety: {
      mode: "preview_only",
      writes: "none",
      coverage: "verified_before_apply",
      privacy: "aggregate_and_metadata_only",
      sync_impact: "none_until_apply_then_append_only_events",
      undo_window: "while_append_only_source_history_is_retained",
      physical_purge_included: false
    }
  };
}

async function listCompilationReceipts(storePath: string): Promise<SoulCompilationReceipt[]> {
  let files: string[];
  try {
    files = await readdir(join(storePath, "state", "soul-compilation"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
  const receipts = await Promise.all(
    files
      .filter((file) => COMPILATION_RECEIPT_PATTERN.test(file))
      .map((file) => readSoulCompilationReceipt(storePath, file.slice(0, -".json".length)))
  );
  return receipts
    .filter((receipt): receipt is SoulCompilationReceipt => receipt !== undefined)
    .sort(
      (left, right) =>
        right.compiled_at.localeCompare(left.compiled_at) || compareCodeUnits(left.receipt_id, right.receipt_id)
    );
}

function revisionStates(profile: SoulProfileStatusEntry): Record<DashboardSoulRevision["state"], number> {
  const counts = emptyCounts(["draft", "active", "superseded", "conflicted"] as const);
  for (const revision of profile.revisions) counts[revision.state] += 1;
  return counts;
}

function soulProfile(profile: SoulProfileStatusEntry, status: SoulProfileStatus): DashboardSoulProfile {
  const rollbackReceipt = status.approval_receipts.find(
    (receipt) => receipt.profile_id === profile.profile_id && receipt.action === "rollback"
  );
  const rollbackTargets = profile.revisions
    .filter(
      (revision) =>
        revision.approved &&
        (revision.state === "active" || revision.state === "superseded") &&
        !profile.head_revision_ids.includes(revision.revision_id)
    )
    .sort((left, right) => right.generation - left.generation || compareCodeUnits(left.revision_id, right.revision_id))
    .map((revision) => revision.revision_id);
  return {
    profile_id: profile.profile_id,
    subject: profile.subject,
    revision_count: profile.revision_count,
    head_revision_ids: profile.head_revision_ids,
    ...(profile.active_revision_id ? { active_revision_id: profile.active_revision_id } : {}),
    selection_status: profile.selection_status,
    conflicted: profile.conflicted,
    states: revisionStates(profile),
    persistence: {
      local_saved: profile.revisions.some((revision) => revision.local_saved),
      personal_sync_saved: profile.revisions.some((revision) => revision.personal_sync_saved)
    },
    revisions: profile.revisions.map((revision) => ({
      revision_id: revision.revision_id,
      generation: revision.generation,
      parent_revision_ids: revision.parent_revision_ids,
      state: revision.state,
      approved: revision.approved,
      approval_receipt_verified: revision.approval_receipt_verified,
      is_head: revision.is_head,
      is_effective: revision.is_effective,
      local_saved: revision.local_saved,
      personal_sync_saved: revision.personal_sync_saved,
      ...(revision.created_at ? { created_at: revision.created_at } : {})
    })),
    rollback: {
      available: rollbackTargets.length > 0,
      requires_confirmation: true,
      target_revision_ids: rollbackTargets,
      ...(rollbackReceipt
        ? {
            latest_receipt: {
              receipt_id: rollbackReceipt.receipt_id,
              source_revision_id: rollbackReceipt.source_revision_id,
              approved_revision_id: rollbackReceipt.approved_revision_id,
              approved_at: rollbackReceipt.approved_at
            }
          }
        : {})
    }
  };
}

export async function buildDashboardSoulStudio(
  storePath: string,
  options: Pick<BuildDashboardV04Options, "project_id">
): Promise<DashboardSoulStudio> {
  const [status, compilationReceipts] = await Promise.all([
    readSoulProfileStatus(storePath, { project_id: options.project_id }),
    listCompilationReceipts(storePath)
  ]);
  const profiles = status.profiles.map((profile) => soulProfile(profile, status));
  const revisions = profiles.flatMap((profile) => profile.revisions);
  const currentCompilation = compilationReceipts.find(
    (receipt) =>
      receipt.source_digest === status.compilation.source_digest &&
      receipt.rendered_digest === status.compilation.rendered_digest &&
      receipt.project_id === options.project_id
  );
  const latestDelivery = status.delivery.receipts.find((receipt) => receipt.current_compilation);
  return {
    version: 1,
    read_only: true,
    summary: {
      profiles: profiles.length,
      revisions: revisions.length,
      draft: revisions.filter((revision) => revision.state === "draft").length,
      active: revisions.filter((revision) => revision.state === "active").length,
      conflicted: revisions.filter((revision) => revision.state === "conflicted").length,
      local_saved: revisions.filter((revision) => revision.local_saved).length,
      personal_sync_saved: revisions.filter((revision) => revision.personal_sync_saved).length
    },
    profiles,
    compilation: {
      status: status.compilation.status,
      deliverable: status.compilation.deliverable,
      selected_revision_ids: status.compilation.selected_revision_ids,
      omissions: status.compilation.omissions.length,
      conflicts: status.compilation.conflicts.length,
      receipt: {
        found: currentCompilation !== undefined,
        current: currentCompilation !== undefined,
        ...(currentCompilation
          ? {
              receipt_id: currentCompilation.receipt_id,
              compiled_at: currentCompilation.compiled_at,
              status: currentCompilation.status
            }
          : {})
      }
    },
    delivery: {
      host_context_prepared: status.delivery.host_context_prepared,
      current_receipts: status.delivery.current_receipt_ids.length,
      ...(latestDelivery
        ? {
            latest: {
              receipt_id: latestDelivery.receipt_id,
              host: latestDelivery.host,
              event: latestDelivery.event,
              occurred_at: latestDelivery.occurred_at,
              source_revision_ids: latestDelivery.source_revision_ids
            }
          }
        : {})
    },
    warnings: {
      count: status.warnings.length,
      codes: [...new Set(status.warnings.map((warning) => warning.code))].sort(compareCodeUnits)
    },
    privacy: {
      clause_payloads_exposed: false,
      local_only_clause_text_exposed: false,
      receipt_payloads: "metadata_only"
    }
  };
}

export async function buildDashboardV04Data(
  storePath: string,
  records: readonly MorynRecord[],
  options: BuildDashboardV04Options
): Promise<DashboardV04Data> {
  const [memoryMaintenance, soulStudio] = await Promise.all([
    Promise.resolve(buildDashboardMemoryMaintenance(records, options)),
    buildDashboardSoulStudio(storePath, options)
  ]);
  return {
    memory_maintenance: memoryMaintenance,
    soul_studio: soulStudio,
    selection_sources: DASHBOARD_V04_SELECTION_SOURCES
  };
}
