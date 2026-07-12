import { describe, expect, it } from "vitest";
import { buildLearningCandidateReviewWorkflow, unresolvedLearningCandidates } from "../../src/core/learning-candidate-review.js";
import type { SemanticConsolidationCandidate } from "../../src/core/semantic-consolidation-candidates.js";

function candidate(index: number): SemanticConsolidationCandidate {
  return {
    source_record_id: `rec_source_${Math.floor(index / 3)}`,
    record_id: `rec_candidate_${index}`,
    score: 50 - index,
    exact_fingerprint: false,
    token_overlap: 0.5,
    signals: ["token_overlap"]
  };
}

describe("learning candidate review workflow", () => {
  it("preserves bounded id-only candidate pairs without record text", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index));
    const workflow = buildLearningCandidateReviewWorkflow("project-a", candidates);

    expect(workflow?.candidate_pairs).toHaveLength(12);
    expect(workflow).toMatchObject({
      action: "review_learning_candidates",
      owner: "agent",
      safe_to_run: true,
      requires_user_confirmation: false
    });
    expect(workflow?.candidate_pairs[0]).toMatchObject({
      source_recall: { tool: "recall", arguments: { project_id: "project-a", record_ids: ["rec_source_0"] } },
      candidate_recall: { tool: "recall", arguments: { project_id: "project-a", record_ids: ["rec_candidate_0"] } }
    });
    expect(JSON.stringify(workflow)).not.toContain("content");
    expect(JSON.stringify(workflow)).not.toContain("text");
  });

  it("removes accepted and idempotent pairs in either direction", () => {
    const candidates = [candidate(0), candidate(1), candidate(2)];
    const unresolved = unresolvedLearningCandidates(candidates, {
      proposal_results: [
        { ...candidate(0), target_record_id: candidate(0).record_id, relationship: "duplicate_of", proposal_digest: "a", status: "accepted", reason: "accepted" },
        { source_record_id: candidate(1).record_id, target_record_id: candidate(1).source_record_id, relationship: "revises", proposal_digest: "b", status: "idempotent", reason: "existing_relationship" }
      ]
    });

    expect(unresolved).toEqual([candidate(2)]);
  });

  it("stays absent for an empty candidate set", () => {
    expect(buildLearningCandidateReviewWorkflow("project-a", [])).toBeUndefined();
  });
});
