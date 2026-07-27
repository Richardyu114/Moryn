import { createHash } from "node:crypto";
import {
  buildActiveLogicalMemoryView,
  compareLogicalMemoryTargets,
  logicalMemoryFingerprint
} from "./logical-memory.js";
import { estimateMemoryRecordTokens } from "./record-read-model.js";
import {
  discoverSemanticConsolidationCandidates,
  type SemanticConsolidationCandidate
} from "./semantic-consolidation-candidates.js";
import {
  authorSemanticMaintenanceMergeDraft,
  publicSemanticMaintenanceMergeDraft,
  type SemanticMaintenanceDraftBlockerCode,
  type SemanticMaintenanceMergeDraft
} from "./semantic-maintenance-draft.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord, RecordKind } from "./types.js";

export const SEMANTIC_MAINTENANCE_SHADOW_SELECTION_SOURCES = {
  candidate: "candidates[]",
  candidate_id: "candidates[].candidate_id",
  source_record_id: "candidates[].source_record_id",
  target_record_id: "candidates[].target_record_id",
  action: "candidates[].action",
  blocker: "candidates[].blocker_codes[]",
  before_current_records: "projection.before.current_records",
  guaranteed_after_current_records: "projection.guaranteed_after.current_records",
  potential_after_current_records: "projection.potential_after.current_records",
  guaranteed_record_reduction: "projection.guaranteed_reduction.current_records",
  potential_record_reduction: "projection.potential_reduction.current_records",
  authored_merge_draft: "authored_merge_drafts[]",
  authored_merge_draft_status: "authored_merge_drafts[].status",
  authored_merge_draft_blocker: "authored_merge_drafts[].blocker_codes[]",
  authored_merge_draft_record_proof: "authored_merge_drafts[].proof.projection.strict_record_decrease",
  authored_merge_draft_token_proof: "authored_merge_drafts[].proof.projection.strict_token_decrease",
  growth_status: "growth.status"
} as const;

export const DEFAULT_SEMANTIC_SHADOW_CANDIDATE_LIMIT = 100;
export const DEFAULT_SEMANTIC_SHADOW_MINIMUM_TOKEN_OVERLAP = 0.15;

const AUTOMATIC_EXACT_KINDS = new Set<RecordKind>(["memory", "skill", "soul"]);
const SEMANTIC_REVIEW_KINDS = new Set<RecordKind>(["memory", "skill"]);

export type SemanticMaintenanceShadowBlockerCode =
  | "authored_semantic_merge_required"
  | "conflict_requires_review"
  | "global_scope_requires_review"
  | "high_priority_requires_review"
  | "private_boundary_requires_explicit_authorization"
  | "protected_record_kind"
  | "project_scope_required"
  | "token_reduction_not_proven"
  | SemanticMaintenanceDraftBlockerCode;

export interface SemanticMaintenanceShadowOptions {
  project_id?: string;
  include_global?: boolean;
  include_private?: boolean;
  candidate_limit?: number;
  minimum_token_overlap?: number;
}

export interface SemanticMaintenanceShadowCandidate {
  candidate_id: string;
  classification: "exact_duplicate" | "semantic_overlap";
  source_record_id: string;
  target_record_id: string;
  score: number;
  token_overlap: number;
  signals: SemanticConsolidationCandidate["signals"];
  action: "auto_link_exact_duplicate" | "auto_merge_lossless" | "review_semantic_merge" | "blocked";
  auto_apply_safe: boolean;
  blocker_codes: SemanticMaintenanceShadowBlockerCode[];
  projection: {
    before_current_records: 2;
    guaranteed_after_current_records: 1 | 2;
    potential_after_current_records: 1;
    guaranteed_current_record_reduction: 0 | 1;
    potential_current_record_reduction: 1;
    before_estimated_tokens: number;
    guaranteed_after_estimated_tokens: number;
    guaranteed_estimated_token_reduction: number;
  };
}

export interface SemanticMaintenanceShadowReport {
  version: 1;
  mode: "shadow";
  read_only: true;
  scope: {
    mode: "store" | "project";
    project_id?: string;
    includes_global: boolean;
    includes_private: boolean;
  };
  inspected: {
    current_records: number;
    current_estimated_tokens: number;
    eligible_candidate_source_records: number;
    omitted_private_records: number;
  };
  candidates: SemanticMaintenanceShadowCandidate[];
  authored_merge_drafts: SemanticMaintenanceMergeDraft[];
  summary: {
    exact_duplicate_groups: number;
    exact_duplicate_records: number;
    semantic_candidate_pairs: number;
    authored_drafts_ready: number;
    authored_drafts_blocked: number;
    auto_safe_candidates: number;
    review_candidates: number;
    blocked_candidates: number;
    blocker_counts: Partial<Record<SemanticMaintenanceShadowBlockerCode, number>>;
    truncated: boolean;
  };
  projection: {
    strict_decrease_required: true;
    before: { current_records: number; estimated_tokens: number };
    guaranteed_after: { current_records: number; estimated_tokens: number };
    potential_after: {
      current_records: number;
      estimated_tokens: null;
      token_projection: "not_proven_until_authored_merge";
    };
    guaranteed_reduction: { current_records: number; estimated_tokens: number; strict_decrease: boolean };
    potential_reduction: { current_records: number; strict_decrease: boolean };
  };
  growth: {
    policy: "strictly_decreasing_current_set";
    monotonic_non_growth: true;
    strict_decrease_available: boolean;
    current_record_delta: number;
    estimated_token_delta: number;
    status: "guaranteed_decrease_available" | "review_required" | "no_decrease_proven";
  };
  safety: {
    writes: "none";
    scores_prove_equivalence: false;
    semantic_auto_apply: true;
    proof_gated_semantic_auto_apply: true;
    exact_duplicates_may_auto_apply: true;
    protected_content_auto_merged: false;
    physical_purge: false;
  };
  selection_sources: typeof SEMANTIC_MAINTENANCE_SHADOW_SELECTION_SOURCES;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedProjectId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error("Invalid argument: project_id must be a non-empty string");
  return normalized;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`Invalid argument: ${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return normalized;
}

function boundedRatio(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error(`Invalid argument: ${name} must be a number between 0 and 1`);
  }
  return normalized;
}

function candidateId(
  classification: SemanticMaintenanceShadowCandidate["classification"],
  left: string,
  right: string
): string {
  const ids = [left, right].sort(compareCodeUnits);
  return `shadow_${createHash("sha256").update(`${classification}\u0000${ids[0]}\u0000${ids[1]}`).digest("hex").slice(0, 32)}`;
}

function scopedActiveRecords(
  records: readonly MorynRecord[],
  options: { project_id?: string; include_global: boolean; include_private: boolean }
): { records: MorynRecord[]; omitted_private_records: number } {
  const scoped = buildActiveLogicalMemoryView([...records])
    .active_records.filter(
      (record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined"
    )
    .filter(
      (record) =>
        !options.project_id ||
        record.project_id === options.project_id ||
        (options.include_global && record.scope === "global")
    );
  const omittedPrivateRecords = scoped.filter(isPrivateMemoryBoundary).length;
  return {
    records: scoped.filter((record) => options.include_private || !isPrivateMemoryBoundary(record)),
    omitted_private_records: options.include_private ? 0 : omittedPrivateRecords
  };
}

function hasConflict(record: MorynRecord): boolean {
  return record.conflict?.resolution === "needs_review";
}

function exactAutoBlockers(
  records: readonly MorynRecord[],
  projectId: string | undefined
): SemanticMaintenanceShadowBlockerCode[] {
  const blockers = new Set<SemanticMaintenanceShadowBlockerCode>();
  if (!projectId || records.some((record) => record.project_id !== projectId || record.scope === "global")) {
    blockers.add(projectId ? "global_scope_requires_review" : "project_scope_required");
  }
  if (records.some(isPrivateMemoryBoundary)) blockers.add("private_boundary_requires_explicit_authorization");
  if (records.some(hasConflict)) blockers.add("conflict_requires_review");
  if (records.some((record) => !AUTOMATIC_EXACT_KINDS.has(record.kind))) blockers.add("protected_record_kind");
  return [...blockers].sort(compareCodeUnits);
}

function semanticBlockers(records: readonly MorynRecord[]): SemanticMaintenanceShadowBlockerCode[] {
  const blockers = new Set<SemanticMaintenanceShadowBlockerCode>([
    "authored_semantic_merge_required",
    "token_reduction_not_proven"
  ]);
  if (records.some((record) => !SEMANTIC_REVIEW_KINDS.has(record.kind))) blockers.add("protected_record_kind");
  if (records.some(isPrivateMemoryBoundary)) blockers.add("private_boundary_requires_explicit_authorization");
  if (records.some(hasConflict)) blockers.add("conflict_requires_review");
  if (records.some((record) => record.scope === "global")) blockers.add("global_scope_requires_review");
  if (records.some((record) => record.priority === "high")) blockers.add("high_priority_requires_review");
  return [...blockers].sort(compareCodeUnits);
}

function recordTokens(record: MorynRecord | undefined): number {
  return record ? estimateMemoryRecordTokens(record) : 0;
}

function exactFingerprintGroups(records: readonly MorynRecord[]): MorynRecord[][] {
  const groups = new Map<string, MorynRecord[]>();
  for (const record of records) {
    const fingerprint = logicalMemoryFingerprint(record);
    const group = groups.get(fingerprint) ?? [];
    group.push(record);
    groups.set(fingerprint, group);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort(compareLogicalMemoryTargets))
    .sort((left, right) => compareCodeUnits((left[0] as MorynRecord).id, (right[0] as MorynRecord).id));
}

function semanticOpportunityCount(
  candidates: readonly SemanticMaintenanceShadowCandidate[],
  reserved: Set<string>
): number {
  let count = 0;
  for (const candidate of candidates) {
    if (candidate.classification !== "semantic_overlap" || candidate.action !== "review_semantic_merge") continue;
    if (reserved.has(candidate.source_record_id) || reserved.has(candidate.target_record_id)) continue;
    reserved.add(candidate.source_record_id);
    reserved.add(candidate.target_record_id);
    count += 1;
  }
  return count;
}

export function buildSemanticMaintenanceShadowReport(
  records: readonly MorynRecord[],
  options: SemanticMaintenanceShadowOptions = {}
): SemanticMaintenanceShadowReport {
  const projectId = normalizedProjectId(options.project_id);
  const includeGlobal = options.include_global !== false;
  const includePrivate = options.include_private === true;
  const candidateLimit = boundedInteger(
    options.candidate_limit,
    DEFAULT_SEMANTIC_SHADOW_CANDIDATE_LIMIT,
    1,
    500,
    "candidate_limit"
  );
  const minimumTokenOverlap = boundedRatio(
    options.minimum_token_overlap,
    DEFAULT_SEMANTIC_SHADOW_MINIMUM_TOKEN_OVERLAP,
    "minimum_token_overlap"
  );
  const scoped = scopedActiveRecords(records, {
    project_id: projectId,
    include_global: includeGlobal,
    include_private: includePrivate
  });
  const recordsById = new Map(scoped.records.map((record) => [record.id, record]));
  const beforeTokens = scoped.records.reduce((total, record) => total + estimateMemoryRecordTokens(record), 0);
  const exactGroups = exactFingerprintGroups(scoped.records);

  const candidates: SemanticMaintenanceShadowCandidate[] = [];
  const guaranteedRemovedRecordIds = new Set<string>();
  let guaranteedTokenReduction = 0;
  for (const group of exactGroups) {
    const target = group[0] as MorynRecord;
    const blockers = exactAutoBlockers(group, projectId);
    const autoApplySafe = blockers.length === 0;
    for (const duplicate of group.slice(1)) {
      const duplicateTokens = recordTokens(duplicate);
      if (autoApplySafe) {
        guaranteedRemovedRecordIds.add(duplicate.id);
        guaranteedTokenReduction += duplicateTokens;
      }
      candidates.push({
        candidate_id: candidateId("exact_duplicate", duplicate.id, target.id),
        classification: "exact_duplicate",
        source_record_id: duplicate.id,
        target_record_id: target.id,
        score: 1000,
        token_overlap: 1,
        signals: ["exact_fingerprint"],
        action: autoApplySafe ? "auto_link_exact_duplicate" : "blocked",
        auto_apply_safe: autoApplySafe,
        blocker_codes: blockers,
        projection: {
          before_current_records: 2,
          guaranteed_after_current_records: autoApplySafe ? 1 : 2,
          potential_after_current_records: 1,
          guaranteed_current_record_reduction: autoApplySafe ? 1 : 0,
          potential_current_record_reduction: 1,
          before_estimated_tokens: recordTokens(duplicate) + recordTokens(target),
          guaranteed_after_estimated_tokens: autoApplySafe
            ? recordTokens(target)
            : recordTokens(duplicate) + recordTokens(target),
          guaranteed_estimated_token_reduction: autoApplySafe ? duplicateTokens : 0
        }
      });
    }
  }

  const discovery = discoverSemanticConsolidationCandidates(
    scoped.records.filter((record) => SEMANTIC_REVIEW_KINDS.has(record.kind)),
    {
      project_id: projectId,
      include_global: includeGlobal,
      include_private: true,
      minimum_token_overlap: minimumTokenOverlap,
      limit: candidateLimit
    }
  );
  for (const discovered of discovery.candidate_pairs) {
    if (discovered.exact_fingerprint) continue;
    if (
      guaranteedRemovedRecordIds.has(discovered.source_record_id) ||
      guaranteedRemovedRecordIds.has(discovered.record_id)
    ) {
      continue;
    }
    const source = recordsById.get(discovered.source_record_id);
    const target = recordsById.get(discovered.record_id);
    if (!source || !target) continue;
    const blockers = semanticBlockers([source, target]);
    const hardBlocked = blockers.some(
      (blocker) => blocker !== "authored_semantic_merge_required" && blocker !== "token_reduction_not_proven"
    );
    candidates.push({
      candidate_id: candidateId("semantic_overlap", source.id, target.id),
      classification: "semantic_overlap",
      source_record_id: source.id,
      target_record_id: target.id,
      score: discovered.score,
      token_overlap: discovered.token_overlap,
      signals: discovered.signals,
      action: hardBlocked ? "blocked" : "review_semantic_merge",
      auto_apply_safe: false,
      blocker_codes: blockers,
      projection: {
        before_current_records: 2,
        guaranteed_after_current_records: 2,
        potential_after_current_records: 1,
        guaranteed_current_record_reduction: 0,
        potential_current_record_reduction: 1,
        before_estimated_tokens: recordTokens(source) + recordTokens(target),
        guaranteed_after_estimated_tokens: recordTokens(source) + recordTokens(target),
        guaranteed_estimated_token_reduction: 0
      }
    });
  }
  const authoredDrafts = candidates
    .filter(
      (candidate) => candidate.classification === "semantic_overlap" && candidate.action === "review_semantic_merge"
    )
    .map((candidate) =>
      authorSemanticMaintenanceMergeDraft(scoped.records, candidate, { project_id: projectId ?? "" })
    );
  const authoredDraftsByCandidateId = new Map(authoredDrafts.map((draft) => [draft.candidate_id, draft]));
  for (const candidate of candidates) {
    const draft = authoredDraftsByCandidateId.get(candidate.candidate_id);
    if (!draft) continue;
    candidate.blocker_codes = draft.blocker_codes;
    if (draft.status !== "ready") continue;
    candidate.action = "auto_merge_lossless";
    candidate.auto_apply_safe = true;
    candidate.projection.guaranteed_after_current_records = 1;
    candidate.projection.guaranteed_current_record_reduction = 1;
    candidate.projection.guaranteed_after_estimated_tokens = draft.proof.projection.after_estimated_tokens;
    candidate.projection.guaranteed_estimated_token_reduction = draft.proof.projection.estimated_token_reduction;
  }
  candidates.sort(
    (left, right) =>
      Number(right.auto_apply_safe) - Number(left.auto_apply_safe) ||
      Number(right.action === "review_semantic_merge") - Number(left.action === "review_semantic_merge") ||
      Number(right.classification === "exact_duplicate") - Number(left.classification === "exact_duplicate") ||
      right.score - left.score ||
      compareCodeUnits(left.candidate_id, right.candidate_id)
  );
  const reserved = new Set(guaranteedRemovedRecordIds);
  let guaranteedSemanticReduction = 0;
  for (const candidate of candidates) {
    if (candidate.action !== "auto_merge_lossless" || !candidate.auto_apply_safe) continue;
    if (reserved.has(candidate.source_record_id) || reserved.has(candidate.target_record_id)) continue;
    const draft = authoredDraftsByCandidateId.get(candidate.candidate_id);
    if (draft?.status !== "ready") continue;
    reserved.add(candidate.source_record_id);
    reserved.add(candidate.target_record_id);
    guaranteedSemanticReduction += 1;
    guaranteedTokenReduction += draft.proof.projection.estimated_token_reduction;
  }
  const guaranteedRecordReduction = guaranteedRemovedRecordIds.size + guaranteedSemanticReduction;
  const semanticOpportunity = semanticOpportunityCount(candidates, reserved);
  const potentialRecordReduction = guaranteedRecordReduction + semanticOpportunity;
  const guaranteedAfterRecords = Math.max(0, scoped.records.length - guaranteedRecordReduction);
  const potentialAfterRecords = Math.max(0, scoped.records.length - potentialRecordReduction);
  const guaranteedAfterTokens = Math.max(0, beforeTokens - guaranteedTokenReduction);
  const blockerCounts: Partial<Record<SemanticMaintenanceShadowBlockerCode, number>> = {};
  for (const candidate of candidates) {
    for (const blocker of candidate.blocker_codes) blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1;
  }
  const growthStatus =
    guaranteedRecordReduction > 0
      ? "guaranteed_decrease_available"
      : semanticOpportunity > 0
        ? "review_required"
        : "no_decrease_proven";

  return {
    version: 1,
    mode: "shadow",
    read_only: true,
    scope: {
      mode: projectId ? "project" : "store",
      ...(projectId ? { project_id: projectId } : {}),
      includes_global: includeGlobal,
      includes_private: includePrivate
    },
    inspected: {
      current_records: scoped.records.length,
      current_estimated_tokens: beforeTokens,
      eligible_candidate_source_records: discovery.eligible_source_record_count,
      omitted_private_records: scoped.omitted_private_records
    },
    candidates: candidates.slice(0, candidateLimit),
    authored_merge_drafts: authoredDrafts.map(publicSemanticMaintenanceMergeDraft).slice(0, candidateLimit),
    summary: {
      exact_duplicate_groups: exactGroups.length,
      exact_duplicate_records: exactGroups.reduce((total, group) => total + group.length - 1, 0),
      semantic_candidate_pairs: candidates.filter((candidate) => candidate.classification === "semantic_overlap")
        .length,
      authored_drafts_ready: authoredDrafts.filter((draft) => draft.status === "ready").length,
      authored_drafts_blocked: authoredDrafts.filter((draft) => draft.status === "blocked").length,
      auto_safe_candidates: candidates.filter((candidate) => candidate.auto_apply_safe).length,
      review_candidates: candidates.filter((candidate) => candidate.action === "review_semantic_merge").length,
      blocked_candidates: candidates.filter((candidate) => candidate.action === "blocked").length,
      blocker_counts: blockerCounts,
      truncated: discovery.truncated || candidates.length > candidateLimit
    },
    projection: {
      strict_decrease_required: true,
      before: { current_records: scoped.records.length, estimated_tokens: beforeTokens },
      guaranteed_after: { current_records: guaranteedAfterRecords, estimated_tokens: guaranteedAfterTokens },
      potential_after: {
        current_records: potentialAfterRecords,
        estimated_tokens: null,
        token_projection: "not_proven_until_authored_merge"
      },
      guaranteed_reduction: {
        current_records: guaranteedRecordReduction,
        estimated_tokens: guaranteedTokenReduction,
        strict_decrease: guaranteedRecordReduction > 0
      },
      potential_reduction: {
        current_records: potentialRecordReduction,
        strict_decrease: potentialRecordReduction > 0
      }
    },
    growth: {
      policy: "strictly_decreasing_current_set",
      monotonic_non_growth: true,
      strict_decrease_available: guaranteedRecordReduction > 0,
      current_record_delta: guaranteedAfterRecords - scoped.records.length,
      estimated_token_delta: guaranteedAfterTokens - beforeTokens,
      status: growthStatus
    },
    safety: {
      writes: "none",
      scores_prove_equivalence: false,
      semantic_auto_apply: true,
      proof_gated_semantic_auto_apply: true,
      exact_duplicates_may_auto_apply: true,
      protected_content_auto_merged: false,
      physical_purge: false
    },
    selection_sources: SEMANTIC_MAINTENANCE_SHADOW_SELECTION_SOURCES
  };
}
