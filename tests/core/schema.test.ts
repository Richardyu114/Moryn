import { describe, expect, it } from "vitest";
import { parseRecord } from "../../src/core/schema.js";

describe("record schema", () => {
  it("accepts a valid memory record", () => {
    const record = parseRecord({
      id: "rec_test",
      kind: "memory",
      type: "decision",
      scope: "project",
      project_id: "memora",
      tags: ["sync"],
      content: { text: "Use append-only events.", format: "text" },
      state: "canonical",
      confidence: 0.9,
      priority: "normal",
      visibility: "active",
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      source: { client: "codex", session_id: "sess_1", model: "gpt-5" }
    });

    expect(record.kind).toBe("memory");
  });

  it("rejects invalid state values", () => {
    expect(() =>
      parseRecord({
        id: "rec_test",
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Bad state", format: "text" },
        state: "published",
        source: { client: "codex" }
      })
    ).toThrow(/Invalid record/);
  });
});
