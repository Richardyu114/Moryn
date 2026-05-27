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

  it("recalls with record id, kind, type, state, tag, and file filters", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => `2026-05-27T00:00:0${nextId}.000Z`, id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["auth", "src/auth.ts"],
        content: { text: "Auth middleware uses signed cookies.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { text: "Run npm test before release.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "other",
        tags: ["auth"],
        content: { text: "Unrelated project warning.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({
        record_ids: [decision.record.id],
        project_id: "memora",
        kinds: ["memory"],
        types: ["decision"],
        states: ["canonical"],
        tags: ["auth"],
        files: ["src/auth.ts"],
        limit: 5
      });

      expect(recall.results).toHaveLength(1);
      expect(recall.results[0]?.record.id).toBe(decision.record.id);
      expect(recall.results[0]?.reason).toContain("record_id_match");
      expect(recall.results[0]?.reason).toContain("tag_match:auth");
      expect(recall.results[0]?.reason).toContain("file_match:src/auth.ts");
    });
  });

  it("builds boot context from trusted profile, project, skill, and recent records", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z",
        "2026-05-27T00:03:00.000Z",
        "2026-05-27T00:04:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer concise engineering updates.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use append-only events.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Do not include secrets in memory.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["memora"],
        content: { text: "Run tests before committing.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "Raw note should not boot.", format: "text" },
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "memora" });

      expect(boot.profile.soul.map((record) => record.content.text)).toEqual(["Prefer concise engineering updates."]);
      expect(boot.project.important_decisions.map((record) => record.content.text)).toEqual(["Use append-only events."]);
      expect(boot.project.warnings.map((record) => record.content.text)).toEqual(["Do not include secrets in memory."]);
      expect(boot.skills.map((record) => record.content.text)).toEqual(["Run tests before committing."]);
      expect(boot.recent_changes.map((record) => record.content.text)).not.toContain("Raw note should not boot.");
      expect(boot.sync.cursor).toBe("2026-05-27T00:04:00.000Z");
    });
  });

  it("reports refresh changes since a cursor with notice and interrupt importance", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:05:00.000Z",
        "2026-05-27T00:06:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Session finished.", format: "text" },
        state: "raw",
        source: { client: "test" }
      });
      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use MCP for agent access.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const blocker = await engine.write({
        kind: "memory",
        type: "blocker",
        scope: "project",
        project_id: "memora",
        content: { text: "Sync must not overwrite local events.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });

      const refresh = await engine.refresh({ project_id: "memora", cursor: "2026-05-27T00:00:00.000Z" });

      expect(refresh.cursor).toBe("2026-05-27T00:06:00.000Z");
      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.changes).toEqual([
        expect.objectContaining({ record_id: decision.record.id, importance: "notice" }),
        expect.objectContaining({ record_id: blocker.record.id, importance: "interrupt" })
      ]);
    });
  });
});
