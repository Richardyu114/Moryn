import { describe, expect, it } from "vitest";
import { synthesizeSession } from "../../src/core/session-synthesis.js";

const recovery = {
  version: 1 as const,
  available: true,
  bounded: true,
  project_id: "moryn",
  session_id: "session-1",
  source_record_ids: ["rec-checkpoint-1"],
  checkpoint_count: 1,
  current_task: "Implement autonomous handoff",
  progress: ["Added checkpoint capture", "Verified checkpoint restore"],
  decisions: ["Use durable evidence only"],
  changed_facts: [],
  blockers: ["Codex hook schema remains unknown"],
  next_steps: ["Run cross-device smoke"],
  files: [],
  candidate_memories: [],
  candidate_skills: [],
  learnings: [{ question: "How should summaries be generated?", conclusion: "Use persisted checkpoint evidence.", evidence_type: "source_code" as const, scope: "project" as const, confidence: 0.99, recommended_kind: "memory" as const, recommended_type: "fact", related_record_ids: [] }],
  knowledge_investigations: [{ resolution_id: "activation", question: "Is Codex activation confirmed?", recall_status: "knowledge_gap" as const, recalled_record_ids: [], evidence: [], status: "unresolved" as const, next_step: "Observe a runtime receipt" }],
  semantic_consolidation_proposals: []
};

describe("session synthesis", () => {
  it("preserves an explicit host-authored summary", () => {
    expect(synthesizeSession({ host_summary: "Host explicitly summarized the work.", recovery_pack: recovery })).toEqual(expect.objectContaining({ mode: "host_authored", summary: "Host explicitly summarized the work.", source_record_ids: [] }));
  });

  it("synthesizes a bounded deterministic summary from durable evidence", () => {
    const result = synthesizeSession({ recovery_pack: recovery });
    expect(result).toMatchObject({
      version: 1,
      mode: "evidence_synthesized",
      current_task: recovery.current_task,
      progress: recovery.progress,
      decisions: recovery.decisions,
      blockers: recovery.blockers,
      next_steps: ["Run cross-device smoke", "Observe a runtime receipt"],
      learning_conclusions: ["Use persisted checkpoint evidence."],
      unresolved_investigations: [{ question: "Is Codex activation confirmed?", next_step: "Observe a runtime receipt" }],
      source_record_ids: ["rec-checkpoint-1"]
    });
    expect(result.summary).toContain("Task: Implement autonomous handoff");
    expect(result.summary).toContain("Progress: Added checkpoint capture; Verified checkpoint restore");
    expect(result.summary).toContain("Next: Run cross-device smoke; Observe a runtime receipt");
  });

  it("uses an honest minimal fallback when no durable evidence exists", () => {
    expect(synthesizeSession({ current_task: "Inspect release" })).toMatchObject({ mode: "minimal_fallback", summary: "Session ended for task: Inspect release.", current_task: "Inspect release", source_record_ids: [] });
    expect(synthesizeSession({})).toMatchObject({ mode: "minimal_fallback", summary: "Session ended; no durable progress evidence was available." });
  });
});
