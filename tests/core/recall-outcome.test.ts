import { describe, expect, it } from "vitest";
import { assessRecallOutcome, queryTokenCoverage } from "../../src/core/recall-outcome.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "rec-a",
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: "Moryn pulls on agent enter and pushes on agent finish" },
    state: "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    source: { client: "codex" },
    provenance: { method: "rule-promoted" },
    ...overrides
  };
}

describe("query token coverage", () => {
  it("measures distinct meaningful query tokens", () => {
    expect(queryTokenCoverage("when does moryn pull push", record())).toEqual({
      matched_tokens: ["moryn", "pull", "push"],
      query_tokens: ["when", "does", "moryn", "pull", "push"],
      coverage: 0.6
    });
  });
});

describe("recall outcomes", () => {
  it("returns a trusted match for relevant trusted current knowledge", () => {
    expect(assessRecallOutcome({
      query: "moryn pull push",
      now: "2026-07-11T01:00:00.000Z",
      results: [{ record: record(), score: 25, reason: [] }]
    })).toMatchObject({
      status: "trusted_match",
      best_record_id: "rec-a",
      coverage: 1,
      trust: "trusted",
      recommended_action: "use_recalled_knowledge"
    });
  });

  it.each([
    ["candidate", record({ state: "candidate", confidence: 0.6, provenance: { method: "agent-proposed" } })],
    ["stale", record({ content: { text: "Moryn pulls on enter", valid_until: "2026-07-10T00:00:00.000Z" } })],
    ["partial", record({ content: { text: "Moryn pulls on enter" } })]
  ])("requires verification for %s matches", (_label, candidate) => {
    expect(assessRecallOutcome({
      query: "moryn pull push",
      now: "2026-07-11T01:00:00.000Z",
      results: [{ record: candidate, score: 12, reason: [] }]
    })).toMatchObject({
      status: "verification_required",
      recommended_action: "verify_then_use_or_learn"
    });
  });

  it("returns an explicit knowledge gap for absent or incidental matches", () => {
    expect(assessRecallOutcome({ query: "database migration policy", results: [] })).toEqual({
      status: "knowledge_gap",
      best_record_id: undefined,
      best_score: 0,
      coverage: 0,
      trust: "none",
      stale: false,
      recommended_action: "explore_then_capture_learning"
    });
    expect(assessRecallOutcome({
      query: "database migration policy",
      results: [{ record: record({ content: { text: "Moryn database" } }), score: 9, reason: [] }]
    }).status).toBe("knowledge_gap");
  });
});
