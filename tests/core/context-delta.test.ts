import { describe, expect, it } from "vitest";
import {
  validateContextDelta,
  type ContextDelta,
  type ContextDeltaInput,
  type LearningDelta,
  type LearningDeltaInput
} from "../../src/index.js";

describe("validateContextDelta", () => {
  it("normalizes strings, defaults arrays, filters blanks, and deduplicates in first-seen order", () => {
    const input: ContextDeltaInput = {
      session_id: " session-1 ",
      checkpoint_id: " checkpoint-1 ",
      current_task: " ship contracts ",
      progress: [" wrote tests ", "", "wrote tests", "  ", " ran tests "],
      decisions: [" use zod ", "use zod"],
      files: [" src/a.ts ", "src/a.ts", " src/b.ts "],
      learnings: [
        {
          question: " What changed? ",
          conclusion: " Contracts are explicit. ",
          evidence_type: "source_code",
          scope: "project",
          confidence: 0.9,
          recommended_kind: "memory",
          recommended_type: " contract ",
          related_record_ids: [" rec-2 ", "", "rec-1", "rec-2", "  "]
        }
      ]
    };

    const result: ContextDelta = validateContextDelta(input);

    expect(result).toEqual({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      current_task: "ship contracts",
      progress: ["wrote tests", "ran tests"],
      decisions: ["use zod"],
      changed_facts: [],
      blockers: [],
      next_steps: [],
      files: ["src/a.ts", "src/b.ts"],
      candidate_memories: [],
      candidate_skills: [],
      learnings: [
        {
          question: "What changed?",
          conclusion: "Contracts are explicit.",
          evidence_type: "source_code",
          scope: "project",
          confidence: 0.9,
          recommended_kind: "memory",
          recommended_type: "contract",
          related_record_ids: ["rec-2", "rec-1"]
        }
      ]
    });
  });

  it("accepts current_task as the only semantic content", () => {
    expect(validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      current_task: "Investigate context loss"
    })).toMatchObject({ current_task: "Investigate context loss" });
  });

  it("filters an empty optional current_task when other semantic content exists", () => {
    const result = validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      current_task: "  ",
      progress: ["done"]
    });

    expect(result.current_task).toBeUndefined();
  });

  it("rejects empty identity fields and identity-only deltas", () => {
    expect(() => validateContextDelta({
      session_id: " ",
      checkpoint_id: "checkpoint-1",
      progress: ["done"]
    })).toThrow();
    expect(() => validateContextDelta({
      session_id: "session-1",
      checkpoint_id: " ",
      progress: ["done"]
    })).toThrow();
    expect(() => validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      progress: ["", "  "]
    })).toThrow();
  });

  it("validates learning enums, confidence, and required strings", () => {
    const base: LearningDeltaInput = {
      question: "What is stable?",
      conclusion: "The contract shape.",
      evidence_type: "user_confirmed",
      scope: "session",
      confidence: 1,
      recommended_kind: "skill",
      recommended_type: "workflow"
    };
    const valid: LearningDelta = validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      learnings: [base]
    }).learnings[0];
    expect(valid.related_record_ids).toEqual([]);

    for (const patch of [
      { question: " " },
      { conclusion: " " },
      { recommended_type: " " },
      { evidence_type: "guess" },
      { scope: "workspace" },
      { recommended_kind: "note" },
      { confidence: -0.01 },
      { confidence: 1.01 }
    ]) {
      expect(() => validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        learnings: [{ ...base, ...patch }]
      })).toThrow();
    }
  });

  it("requires a strict parseable ISO timestamp and preserves its canonical string", () => {
    const result = validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      learnings: [{
        question: "How long is it valid?",
        conclusion: "Until the release.",
        evidence_type: "documentation",
        scope: "global",
        confidence: 0.75,
        valid_until: "2026-07-11T12:34:56.000Z",
        recommended_kind: "memory",
        recommended_type: "release_fact"
      }]
    });
    expect(result.learnings[0].valid_until).toBe("2026-07-11T12:34:56.000Z");

    for (const valid_until of [
      "2026-07-11",
      "2026-07-11T12:34:56Z",
      "2026-07-11T20:34:56.000+08:00",
      "not-a-date",
      "2026-02-30T12:34:56.000Z"
    ]) {
      expect(() => validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        learnings: [{
          question: "How long is it valid?",
          conclusion: "Until the release.",
          evidence_type: "web",
          scope: "global",
          confidence: 0.5,
          valid_until,
          recommended_kind: "memory",
          recommended_type: "release_fact"
        }]
      })).toThrow();
    }
  });
});
