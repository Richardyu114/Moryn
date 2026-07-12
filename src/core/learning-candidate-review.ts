import type { SemanticConsolidationReceipt } from "./semantic-consolidation.js";
import type { SemanticConsolidationCandidate } from "./semantic-consolidation-candidates.js";

export interface LearningCandidateReviewPair {
  source_record_id: string;
  candidate_record_id: string;
  score: number;
  signals: SemanticConsolidationCandidate["signals"];
  source_recall: { tool: "recall"; arguments: { project_id: string; record_ids: string[] } };
  candidate_recall: { tool: "recall"; arguments: { project_id: string; record_ids: string[] } };
}

export interface LearningCandidateReviewWorkflow {
  action: "review_learning_candidates";
  owner: "agent";
  safe_to_run: true;
  requires_user_confirmation: false;
  candidate_pairs: LearningCandidateReviewPair[];
  after_recall: {
    tool: "consolidate_semantic";
    allowed_relationships: readonly ["duplicate_of", "revises", "supersedes", "conflicts_with"];
    no_relationship_is_valid: true;
    instruction: string;
  };
  workflow: {
    version: 1;
    owner: "agent";
    steps: Array<Record<string, unknown>>;
  };
}

export function unresolvedLearningCandidates(
  candidates: SemanticConsolidationCandidate[],
  receipt: Pick<SemanticConsolidationReceipt, "proposal_results">
): SemanticConsolidationCandidate[] {
  const resolvedPairs = new Set(receipt.proposal_results
    .filter((result) => result.status === "accepted" || result.status === "idempotent")
    .flatMap((result) => [
      `${result.source_record_id}\u0000${result.target_record_id}`,
      `${result.target_record_id}\u0000${result.source_record_id}`
    ]));
  return candidates.filter((candidate) => !resolvedPairs.has(`${candidate.source_record_id}\u0000${candidate.record_id}`));
}

export function buildLearningCandidateReviewWorkflow(
  projectId: string,
  candidates: SemanticConsolidationCandidate[]
): LearningCandidateReviewWorkflow | undefined {
  if (candidates.length === 0) return undefined;
  return {
    action: "review_learning_candidates",
    owner: "agent",
    safe_to_run: true,
    requires_user_confirmation: false,
    candidate_pairs: candidates.map((candidate) => ({
      source_record_id: candidate.source_record_id,
      candidate_record_id: candidate.record_id,
      score: candidate.score,
      signals: candidate.signals,
      source_recall: {
        tool: "recall",
        arguments: { project_id: projectId, record_ids: [candidate.source_record_id] }
      },
      candidate_recall: {
        tool: "recall",
        arguments: { project_id: projectId, record_ids: [candidate.record_id] }
      }
    })),
    after_recall: {
      tool: "consolidate_semantic",
      allowed_relationships: ["duplicate_of", "revises", "supersedes", "conflicts_with"],
      no_relationship_is_valid: true,
      instruction: "Recall both records and propose a relationship only when evidence supports it; similarity score alone is insufficient."
    },
    workflow: {
      version: 1,
      owner: "agent",
      steps: [
        { step: "recall_source_and_candidate", source: "candidate_pairs[]" },
        { step: "evaluate_semantic_relationship", allowed_relationships_source: "after_recall.allowed_relationships" },
        { step: "submit_supported_proposal_or_continue", no_relationship_is_valid: true }
      ]
    }
  };
}
