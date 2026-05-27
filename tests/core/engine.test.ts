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

  it("recalls with explicit scope filtering", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "global",
        tags: ["policy"],
        content: { text: "Global policy memory.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["policy"],
        content: { text: "Project policy memory.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const recall = await engine.recall({ query: "policy", scopes: ["project"], project_id: "memora" });

      expect(recall.results.map((result) => result.record.content.text)).toEqual(["Project policy memory."]);
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
        "2026-05-27T00:04:00.000Z",
        "2026-05-27T00:05:00.000Z"
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
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["unrelated"],
        content: { text: "Unrelated global skill.", format: "text" },
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
      expect(boot.skills.map((record) => record.content.text)).not.toContain("Unrelated global skill.");
      expect(boot.recent_changes.map((record) => record.content.text)).not.toContain("Raw note should not boot.");
      expect(boot.sync.cursor).toBe("2026-05-27T00:05:00.000Z");
    });
  });

  it("adds configured default skill selectors to boot context", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const releaseSkill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { name: "safe-release", text: "Run tests, typecheck, build, then publish.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["unrelated"],
        content: { name: "unrelated-skill", text: "Do unrelated work.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const boot = await engine.boot({ project_id: "memora", default_skills: ["safe-release", releaseSkill.record.id] });

      expect(boot.skills.map((record) => record.id)).toEqual([releaseSkill.record.id]);
      expect(boot.skills[0]?.content.text).toBe("Run tests, typecheck, build, then publish.");
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

  it("uses current task text to interrupt only on related blockers and warnings", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      let nextTime = 0;
      const timestamps = [
        "2026-05-27T00:00:00.000Z",
        "2026-05-27T00:01:00.000Z",
        "2026-05-27T00:02:00.000Z"
      ];
      const engine = createEngine({ storePath, now: () => timestamps[nextTime++] ?? "2026-05-27T00:09:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const authWarning = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["auth"],
        content: { text: "Auth middleware has a token refresh blocker.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        tags: ["release"],
        content: { text: "Release workflow needs npm credentials.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });

      const refresh = await engine.refresh({
        project_id: "memora",
        cursor: "2026-05-26T00:00:00.000Z",
        current_task: "fix auth token refresh"
      });

      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: authWarning.record.id,
          importance: "interrupt",
          reason: "current_task_match"
        })
      ]);
    });
  });

  it("keeps raw agent notes out of boot until promotion and preserves skill identity through revision", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const rawNote = await engine.write({
        kind: "agent_note",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use candidate workflow before boot exposure.", format: "text" },
        source: { client: "agent-a" }
      });
      const hiddenBoot = await engine.boot({ project_id: "memora" });
      expect(hiddenBoot.project.important_decisions).toHaveLength(0);

      await engine.promote({ record_id: rawNote.record.id, target_state: "canonical", reason: "User confirmed", source: { client: "user" } });
      const visibleBoot = await engine.boot({ project_id: "memora" });
      expect(visibleBoot.project.important_decisions.map((record) => record.id)).toEqual([rawNote.record.id]);

      const skill = await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        content: { text: "Run tests.", format: "text" },
        state: "canonical",
        source: { client: "agent-a" }
      });
      await engine.revise({
        record_id: skill.record.id,
        patch: { "content.text": "Run tests and typecheck." },
        reason: "Refined workflow",
        source: { client: "agent-b" }
      });
      const recall = await engine.recall({ record_ids: [skill.record.id], kinds: ["skill"] });

      expect(recall.results[0]?.record.id).toBe(skill.record.id);
      expect(recall.results[0]?.record.content.text).toBe("Run tests and typecheck.");
    });
  });

  it("archives, quarantines, links, and recalls hidden records only when explicitly requested", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use durable links between related records.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const superseded = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Old sync strategy.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      const sensitive = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "memora",
        content: { text: "Internal warning that should be quarantined.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      await engine.link({
        record_id: decision.record.id,
        linked_record_id: superseded.record.id,
        link_type: "supersedes",
        source: { client: "test" }
      });
      await engine.archive({ record_id: superseded.record.id, reason: "Superseded", source: { client: "test" } });
      await engine.quarantine({ record_id: sensitive.record.id, reason: "Needs review", source: { client: "test" } });

      expect((await engine.recall({ query: "Old sync", project_id: "memora" })).results).toHaveLength(0);
      expect((await engine.recall({ query: "Internal warning", project_id: "memora" })).results).toHaveLength(0);

      const archived = await engine.recall({ record_ids: [superseded.record.id], states: ["archived"], project_id: "memora" });
      const quarantined = await engine.recall({ record_ids: [sensitive.record.id], states: ["quarantined"], project_id: "memora" });
      const linked = await engine.recall({ record_ids: [decision.record.id], project_id: "memora" });

      expect(archived.results[0]?.record.state).toBe("archived");
      expect(quarantined.results[0]?.record.state).toBe("quarantined");
      expect(linked.results[0]?.record.links).toEqual([
        {
          record_id: superseded.record.id,
          link_type: "supersedes",
          created_at: "2026-05-27T00:00:00.000Z"
        }
      ]);
    });
  });

  it("rejects mutation events that target missing records", async () => {
    await withTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_${++nextId}` });
      const existing = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Existing memory.", format: "text" },
        source: { client: "test" }
      });

      await expect(engine.revise({
        record_id: "rec_missing",
        patch: { "content.text": "No-op" },
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.promote({
        record_id: "rec_missing",
        target_state: "canonical",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.archive({
        record_id: "rec_missing",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.quarantine({
        record_id: "rec_missing",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.link({
        record_id: "rec_missing",
        linked_record_id: existing.record.id,
        link_type: "supersedes",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");
      await expect(engine.link({
        record_id: existing.record.id,
        linked_record_id: "rec_missing",
        link_type: "supersedes",
        source: { client: "test" }
      })).rejects.toThrow("Record not found: rec_missing");

      const recall = await engine.recall({ record_ids: [existing.record.id] });
      expect(recall.results[0]?.record.links).toBeUndefined();
    });
  });
});
