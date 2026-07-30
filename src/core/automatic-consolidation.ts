import type { SemanticConsolidationProposal } from "./context-delta.js";
import { compareLogicalMemoryTargets } from "./logical-memory.js";
import { validateSemanticConsolidationProposal } from "./semantic-consolidation.js";
import { retrieveSemanticConsolidationCandidates } from "./semantic-consolidation-candidates.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord } from "./types.js";

const AUTOMATIC_DUPLICATE_OVERLAP = 0.9;
const DURABLE_KINDS = new Set<MorynRecord["kind"]>(["memory", "skill", "soul"]);

export function discoverAutomaticDuplicateProposal(
  records: readonly MorynRecord[],
  sourceRecordId: string
): SemanticConsolidationProposal | undefined {
  const source = records.find((record) => record.id === sourceRecordId);
  if (
    !source ||
    !DURABLE_KINDS.has(source.kind) ||
    isPrivateMemoryBoundary(source) ||
    source.conflict?.resolution === "needs_review"
  )
    return undefined;
  const candidate = retrieveSemanticConsolidationCandidates(records, {
    source_record_ids: [sourceRecordId],
    per_source_limit: 8,
    total_limit: 8
  }).candidates.find(
    (item) =>
      item.token_overlap >= AUTOMATIC_DUPLICATE_OVERLAP &&
      records.find((record) => record.id === item.record_id)?.conflict?.resolution !== "needs_review"
  );
  if (!candidate) return undefined;
  const target = records.find((record) => record.id === candidate.record_id);
  if (!target) return undefined;
  const ordered = [source, target].sort(compareLogicalMemoryTargets);
  const proposal: SemanticConsolidationProposal = {
    proposal_id: `automatic-duplicate:${ordered[1].id}:${ordered[0].id}`,
    source_record_id: ordered[1].id,
    target_record_id: ordered[0].id,
    relationship: "duplicate_of",
    confidence: 0.99,
    rationale: `Automatic near-duplicate consolidation with token overlap ${candidate.token_overlap.toFixed(3)}.`,
    semantic_equivalence: "equivalent",
    material_differences: [],
    evidence_record_ids: []
  };
  const validation = validateSemanticConsolidationProposal([...records], proposal);
  if (validation.status !== "accepted" && validation.status !== "idempotent") return undefined;
  return { ...proposal, source_record_id: validation.source_record_id, target_record_id: validation.target_record_id };
}
