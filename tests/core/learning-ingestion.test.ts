import { describe, expect, it } from "vitest";
import { learningRecordIdentity, normalizeLearningRecord } from "../../src/core/learning-ingestion.js";
import type { LearningDelta } from "../../src/core/context-delta.js";

const learning: LearningDelta = {
  question: "When does Moryn pull?",
  conclusion: "Moryn pulls on agent enter.",
  evidence_type: "source_code",
  scope: "project",
  confidence: 0.9,
  recommended_kind: "memory",
  recommended_type: "fact",
  related_record_ids: []
};

describe("learning ingestion identity", () => {
  it("is stable across agents, sessions, devices, and timestamps", () => {
    const first = learningRecordIdentity({ project_id: "moryn", learning });
    const second = learningRecordIdentity({ project_id: "moryn", learning: { ...learning, related_record_ids: [] } });
    expect(first).toEqual(second);
    expect(first.record_id).toMatch(/^rec_learning_/);
    expect(first.event_id).toMatch(/^evt_learning_/);
    expect(learningRecordIdentity({ project_id: "moryn", learning: { ...learning, question: "What happens at agent startup?" } })).toEqual(first);
  });

  it("normalizes learning into an auditable policy-controlled record", () => {
    expect(normalizeLearningRecord({
      project_id: "moryn",
      learning,
      source: { client: "codex", session_id: "session-a", device_id: "device-a" },
      occurred_at: "2026-07-11T00:00:00.000Z"
    })).toMatchObject({
      kind: "memory",
      type: "fact",
      scope: "project",
      project_id: "moryn",
      content: { text: "Moryn pulls on agent enter." },
      state: "canonical",
      confidence: 0.9,
      source: { client: "codex", session_id: "session-a", device_id: "device-a" },
      provenance: { reason: "When does Moryn pull?", method: "rule-promoted" }
    });
  });
});
