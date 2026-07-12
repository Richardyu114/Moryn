import type { SemanticConsolidationProposal } from "./context-delta.js";
import { compareLogicalMemoryTargets } from "./logical-memory.js";
import { retrieveSemanticConsolidationCandidates } from "./semantic-consolidation-candidates.js";
import { validateSemanticConsolidationProposal } from "./semantic-consolidation.js";
import { isPrivateTags } from "./sensitive.js";
import type { MorynRecord } from "./types.js";

const AUTOMATIC_DUPLICATE_OVERLAP = 0.9;
const DURABLE_KINDS = new Set<MorynRecord["kind"]>(["memory", "skill", "soul"]);

export function discoverAutomaticDuplicateProposal(
  records: readonly MorynRecord[],
  sourceRecordId: string
): SemanticConsolidationProposal | undefined {
  const source = records.find((record) => record.id === sourceRecordId);
  if (!source || !DURABLE_KINDS.has(source.kind) || isPrivateTags(source.tags)) return undefined;
  const candidate = retrieveSemanticConsolidationCandidates(records, {
    source_record_ids: [sourceRecordId],
    per_source_limit: 8,
    total_limit: 8
  }).candidates.find((item) => item.token_overlap >= AUTOMATIC_DUPLICATE_OVERLAP);
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
