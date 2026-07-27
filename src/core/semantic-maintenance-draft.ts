import { createHash } from "node:crypto";
import type { SemanticConsolidationProposal, StructuredSemanticMergeField } from "./context-delta.js";
import { estimateMemoryRecordTokens } from "./record-read-model.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import {
  canonicalStructuredSemanticMergeValue,
  losslessSemanticMergeSegmentUnionText,
  losslessSemanticMergeTextSegments,
  planStructuredSemanticMerge,
  projectStructuredSemanticMergeFinalRecord,
  STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY,
  type StructuredSemanticMergePlan,
  structuredSemanticMergeSourceDigest
} from "./structured-semantic-merge.js";
import type { MorynRecord } from "./types.js";

export const AUTOMATIC_SEMANTIC_MERGE_MINIMUM_TOKEN_OVERLAP = 0.6;

export type SemanticMaintenanceDraftBlockerCode =
  | "automatic_scope_not_allowed"
  | "conflicting_field_values"
  | "lossless_text_unavailable"
  | "record_reduction_not_proven"
  | "source_not_canonical"
  | "source_not_found"
  | "structured_merge_input_not_flat"
  | "structured_merge_rejected"
  | "token_reduction_not_proven"
  | "weak_topic_evidence";

export interface SemanticMaintenanceDraftCandidate {
  candidate_id: string;
  source_record_id: string;
  target_record_id: string;
  token_overlap: number;
  signals: Array<
    "exact_fingerprint" | "shared_file" | "shared_tag" | "shared_provenance" | "token_overlap" | "recency"
  >;
}

export interface SemanticMaintenanceMergeDraft {
  draft_id: string;
  candidate_id: string;
  source_record_ids: string[];
  status: "ready" | "blocked";
  blocker_codes: SemanticMaintenanceDraftBlockerCode[];
  proof: {
    topic: {
      verified: boolean;
      minimum_token_overlap: number;
      token_overlap: number;
      strong_signals: Array<"shared_file" | "shared_provenance" | "high_token_overlap" | "shared_specific_tag">;
    };
    coverage: {
      strategy: "source_backed_fields";
      source_text_units: number;
      covered_source_text_units: number;
      all_source_text_units_covered: boolean;
      synthesized_fields: string[];
      unioned_fields: string[];
      unchanged_fields: string[];
      dropped_fields: 0;
    };
    projection: {
      before_current_records: 2;
      after_current_records: 1 | 2;
      current_record_reduction: 0 | 1;
      before_estimated_tokens: number;
      after_estimated_tokens: number;
      estimated_token_reduction: number;
      strict_record_decrease: boolean;
      strict_token_decrease: boolean;
    };
    recovery: {
      source_history_retained: true;
      physical_delete: false;
      source_digests_verified: boolean;
    };
  };
  merged_record_id?: string;
  merge_digest?: string;
}

export interface AuthoredSemanticMaintenanceMergeDraft extends SemanticMaintenanceMergeDraft {
  proposal?: SemanticConsolidationProposal;
  plan?: StructuredSemanticMergePlan;
  projected_record?: MorynRecord;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalStructuredSemanticMergeValue(value));
}

function draftId(candidate: SemanticMaintenanceDraftCandidate, records: readonly MorynRecord[]): string {
  const identity = {
    version: 1,
    candidate_id: candidate.candidate_id,
    sources: records
      .map((record) => ({ id: record.id, digest: structuredSemanticMergeSourceDigest(record) }))
      .sort((left, right) => compareCodeUnits(left.id, right.id))
  };
  return `semantic_draft_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

const genericTags = new Set([
  "agent",
  "codex",
  "dashboard",
  "lifecycle",
  "memory",
  "moryn",
  "project",
  "session",
  "status",
  "summary"
]);

const protectedTypeMarkers = ["credential", "permission", "preference", "principle", "rule", "security"];

function protectedType(type: string): boolean {
  const normalized = type.toLocaleLowerCase();
  return protectedTypeMarkers.some((marker) => normalized.includes(marker));
}

function sharedSpecificTag(records: readonly MorynRecord[]): boolean {
  const [left, right] = records;
  if (!left || !right) return false;
  const rightTags = new Set(right.tags.map((tag) => tag.toLocaleLowerCase()));
  return left.tags.some((tag) => {
    const normalized = tag.toLocaleLowerCase();
    return !genericTags.has(normalized) && rightTags.has(normalized);
  });
}

function topicProof(candidate: SemanticMaintenanceDraftCandidate, records: readonly MorynRecord[]) {
  const strongSignals: SemanticMaintenanceMergeDraft["proof"]["topic"]["strong_signals"] = [];
  if (candidate.signals.includes("shared_file")) strongSignals.push("shared_file");
  if (candidate.signals.includes("shared_provenance")) strongSignals.push("shared_provenance");
  if (candidate.token_overlap >= AUTOMATIC_SEMANTIC_MERGE_MINIMUM_TOKEN_OVERLAP)
    strongSignals.push("high_token_overlap");
  if (candidate.token_overlap >= 0.45 && sharedSpecificTag(records)) strongSignals.push("shared_specific_tag");
  return {
    verified: strongSignals.length > 0,
    minimum_token_overlap: AUTOMATIC_SEMANTIC_MERGE_MINIMUM_TOKEN_OVERLAP,
    token_overlap: candidate.token_overlap,
    strong_signals: strongSignals
  };
}

function allowedAutomaticScope(records: readonly MorynRecord[], projectId: string): boolean {
  return records.every(
    (record) =>
      (record.kind === "memory" || record.kind === "skill") &&
      record.scope === "project" &&
      record.project_id === projectId &&
      record.priority !== "high" &&
      !protectedType(record.type) &&
      !isPrivateMemoryBoundary(record) &&
      (!record.conflict || record.conflict.resolution === "resolved")
  );
}

function emptyCoverage(): SemanticMaintenanceMergeDraft["proof"]["coverage"] {
  return {
    strategy: "source_backed_fields",
    source_text_units: 0,
    covered_source_text_units: 0,
    all_source_text_units_covered: false,
    synthesized_fields: [],
    unioned_fields: [],
    unchanged_fields: [],
    dropped_fields: 0
  };
}

function blockedDraft(
  candidate: SemanticMaintenanceDraftCandidate,
  records: readonly MorynRecord[],
  blockers: readonly SemanticMaintenanceDraftBlockerCode[],
  topic = topicProof(candidate, records),
  coverage = emptyCoverage()
): AuthoredSemanticMaintenanceMergeDraft {
  const beforeTokens = records.reduce((total, record) => total + estimateMemoryRecordTokens(record), 0);
  return {
    draft_id: draftId(candidate, records),
    candidate_id: candidate.candidate_id,
    source_record_ids: records.map((record) => record.id).sort(compareCodeUnits),
    status: "blocked",
    blocker_codes: [...new Set(blockers)].sort(compareCodeUnits),
    proof: {
      topic,
      coverage,
      projection: {
        before_current_records: 2,
        after_current_records: 2,
        current_record_reduction: 0,
        before_estimated_tokens: beforeTokens,
        after_estimated_tokens: beforeTokens,
        estimated_token_reduction: 0,
        strict_record_decrease: false,
        strict_token_decrease: false
      },
      recovery: {
        source_history_retained: true,
        physical_delete: false,
        source_digests_verified: records.length === 2
      }
    }
  };
}

function authoredFields(records: readonly MorynRecord[]):
  | {
      fields: StructuredSemanticMergeField[];
      coverage: SemanticMaintenanceMergeDraft["proof"]["coverage"];
    }
  | { blocker: "conflicting_field_values" | "lossless_text_unavailable" } {
  const fields: StructuredSemanticMergeField[] = [];
  const coverage = emptyCoverage();
  const fieldNames = [...new Set(records.flatMap((record) => Object.keys(record.content)))].sort(compareCodeUnits);
  for (const field of fieldNames) {
    const present = records.filter((record) => Object.hasOwn(record.content, field));
    const values = new Set(present.map((record) => canonicalJson(record.content[field])));
    if (values.size <= 1) {
      coverage.unchanged_fields.push(field);
      continue;
    }
    const sourceRecordIds = present.map((record) => record.id).sort(compareCodeUnits);
    if (field === "text") {
      const value = losslessSemanticMergeSegmentUnionText(present);
      if (!value) return { blocker: "lossless_text_unavailable" };
      fields.push({
        field,
        disposition: "synthesize",
        strategy: "lossless_segment_union",
        source_record_ids: sourceRecordIds,
        value
      });
      const sourceTexts = present.flatMap((record) => losslessSemanticMergeTextSegments([record]) ?? []);
      const outputSegments = new Set(
        losslessSemanticMergeTextSegments([{ ...present[0]!, content: { text: value } }]) ?? []
      );
      coverage.source_text_units = sourceTexts.length;
      coverage.covered_source_text_units = sourceTexts.filter((text) => outputSegments.has(text)).length;
      coverage.all_source_text_units_covered = coverage.covered_source_text_units === coverage.source_text_units;
      coverage.synthesized_fields.push(field);
      continue;
    }
    if (present.every((record) => Array.isArray(record.content[field]))) {
      fields.push({ field, disposition: "union", source_record_ids: sourceRecordIds });
      coverage.unioned_fields.push(field);
      continue;
    }
    return { blocker: "conflicting_field_values" };
  }
  if (coverage.source_text_units === 0) {
    const sourceTexts = records.flatMap((record) =>
      typeof record.content.text === "string" ? [record.content.text.trim()] : []
    );
    coverage.source_text_units = sourceTexts.length;
    coverage.covered_source_text_units = sourceTexts.length;
    coverage.all_source_text_units_covered = sourceTexts.length === records.length;
  }
  return { fields, coverage };
}

export function authorSemanticMaintenanceMergeDraft(
  records: readonly MorynRecord[],
  candidate: SemanticMaintenanceDraftCandidate,
  options: { project_id: string }
): AuthoredSemanticMaintenanceMergeDraft {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const sources = [candidate.source_record_id, candidate.target_record_id]
    .map((recordId) => recordsById.get(recordId))
    .filter((record): record is MorynRecord => Boolean(record));
  if (sources.length !== 2) return blockedDraft(candidate, sources, ["source_not_found"]);
  const topic = topicProof(candidate, sources);
  const blockers: SemanticMaintenanceDraftBlockerCode[] = [];
  if (!allowedAutomaticScope(sources, options.project_id)) blockers.push("automatic_scope_not_allowed");
  if (sources.some((record) => record.state !== "canonical" || record.visibility !== "active"))
    blockers.push("source_not_canonical");
  if (sources.some((record) => Object.hasOwn(record.content, STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY)))
    blockers.push("structured_merge_input_not_flat");
  if (!topic.verified) blockers.push("weak_topic_evidence");
  if (blockers.length) return blockedDraft(candidate, sources, blockers, topic);

  const authored = authoredFields(sources);
  if ("blocker" in authored) return blockedDraft(candidate, sources, [authored.blocker], topic);
  if (!authored.coverage.all_source_text_units_covered)
    return blockedDraft(candidate, sources, ["lossless_text_unavailable"], topic, authored.coverage);

  const proposal: SemanticConsolidationProposal = {
    proposal_id: draftId(candidate, sources),
    source_record_id: candidate.source_record_id,
    target_record_id: candidate.target_record_id,
    relationship: "revises",
    confidence: 0.99,
    rationale: "Deterministic lossless consolidation with complete source-backed field coverage.",
    semantic_equivalence: "refinement",
    material_differences: authored.fields.map((field) => ({ field: field.field, significance: "minor" })),
    evidence_record_ids: sources.map((record) => record.id).sort(compareCodeUnits),
    structured_merge: { version: 1, requested_state: "canonical", fields: authored.fields }
  };
  const planning = planStructuredSemanticMerge(records, proposal);
  if (planning.status !== "ready")
    return blockedDraft(candidate, sources, ["structured_merge_rejected"], topic, authored.coverage);
  if (planning.plan.final_state !== "canonical")
    return blockedDraft(candidate, sources, ["record_reduction_not_proven"], topic, authored.coverage);
  const projected = projectStructuredSemanticMergeFinalRecord(planning.plan, "revises");
  const beforeTokens = sources.reduce((total, record) => total + estimateMemoryRecordTokens(record), 0);
  const afterTokens = estimateMemoryRecordTokens(projected);
  if (afterTokens >= beforeTokens)
    return blockedDraft(candidate, sources, ["token_reduction_not_proven"], topic, authored.coverage);
  return {
    draft_id: proposal.proposal_id,
    candidate_id: candidate.candidate_id,
    source_record_ids: planning.plan.source_record_ids,
    status: "ready",
    blocker_codes: [],
    proof: {
      topic,
      coverage: authored.coverage,
      projection: {
        before_current_records: 2,
        after_current_records: 1,
        current_record_reduction: 1,
        before_estimated_tokens: beforeTokens,
        after_estimated_tokens: afterTokens,
        estimated_token_reduction: beforeTokens - afterTokens,
        strict_record_decrease: true,
        strict_token_decrease: true
      },
      recovery: {
        source_history_retained: true,
        physical_delete: false,
        source_digests_verified: planning.plan.source_record_ids.every(
          (recordId) =>
            planning.plan.source_digests[recordId] === structuredSemanticMergeSourceDigest(recordsById.get(recordId)!)
        )
      }
    },
    merged_record_id: planning.plan.initial_record.id,
    merge_digest: planning.plan.merge_digest,
    proposal,
    plan: planning.plan,
    projected_record: projected
  };
}

export function publicSemanticMaintenanceMergeDraft(
  draft: AuthoredSemanticMaintenanceMergeDraft
): SemanticMaintenanceMergeDraft {
  const { proposal: _proposal, plan: _plan, projected_record: _projectedRecord, ...publicDraft } = draft;
  return publicDraft;
}
