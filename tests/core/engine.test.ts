import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("core engine", () => {
  it("writes, recalls, revises, and promotes records", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use GitHub sync.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await engine.revise({ record_id: written.record.id, patch: { "content.text": "Use private GitHub sync." }, reason: "Clarify privacy" });
      await engine.promote({ record_id: written.record.id, target_state: "canonical", reason: "User confirmed" });

      const recall = await engine.recall({ query: "github sync", project_id: "memora", limit: 5 });
      expect(recall.results[0]?.record.content.text).toBe("Use private GitHub sync.");
      expect(recall.results[0]?.record.state).toBe("canonical");
    });
  });

  it("quarantines sensitive content on write", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const written = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "API_KEY=sk-1234567890abcdef", format: "text" },
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
    });
  });
});
