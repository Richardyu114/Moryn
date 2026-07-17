import { describe, expect, it } from "vitest";
import type { LearningDelta } from "../../src/core/context-delta.js";
import { learningStatePolicy } from "../../src/core/learning-policy.js";

function learning(overrides: Partial<LearningDelta> = {}): LearningDelta {
  return {
    question: "When does Moryn pull?",
    conclusion: "Moryn pulls on agent enter.",
    evidence_type: "source_code",
    scope: "project",
    confidence: 0.9,
    recommended_kind: "memory",
    recommended_type: "fact",
    related_record_ids: [],
    ...overrides
  };
}

describe("learning state policy", () => {
  it("canonicalizes reliable ordinary project memory", () => {
    expect(learningStatePolicy(learning(), { now: "2026-07-11T00:00:00.000Z" })).toEqual({
      state: "canonical",
      requires_confirmation: false,
      reason: "reliable_project_memory"
    });
  });

  it.each([
    ["skill", learning({ recommended_kind: "skill", recommended_type: "procedure" }), "reusable_skill_candidate"],
    ["global", learning({ scope: "global", recommended_type: "preference" }), "global_learning_candidate"],
    ["inference", learning({ evidence_type: "inference" }), "unverified_evidence_candidate"],
    ["low confidence", learning({ confidence: 0.7 }), "low_confidence_candidate"],
    ["session", learning({ scope: "session" }), "session_learning_candidate"],
    ["expired", learning({ valid_until: "2026-07-10T00:00:00.000Z" }), "expired_learning_candidate"]
  ])("keeps %s learning as candidate", (_label, input, reason) => {
    expect(learningStatePolicy(input, { now: "2026-07-11T00:00:00.000Z" })).toEqual({
      state: "candidate",
      requires_confirmation: false,
      reason
    });
  });

  it.each([
    ["identity", learning({ recommended_type: "identity" })],
    ["security", learning({ recommended_type: "security_rule" })],
    ["sync", learning({ recommended_type: "sync_configuration" })],
    ["sensitive", learning({ conclusion: "API_TOKEN=secret-value-123456", recommended_type: "fact" })]
  ])("requires confirmation for %s learning", (_label, input) => {
    expect(learningStatePolicy(input, { now: "2026-07-11T00:00:00.000Z" })).toEqual({
      state: "candidate",
      requires_confirmation: true,
      reason: "high_risk_learning_requires_confirmation"
    });
  });
});
