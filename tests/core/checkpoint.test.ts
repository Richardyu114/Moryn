import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const baseDelta = {
  session_id: " session-1 ",
  checkpoint_id: " checkpoint-1 ",
  current_task: " Persist checkpoints ",
  progress: [" wrote tests ", "wrote tests", ""],
  decisions: [],
  changed_facts: [],
  blockers: [],
  next_steps: [" implement storage "],
  files: [" src/core/checkpoint.ts "],
  candidate_memories: [],
  candidate_skills: [],
  learnings: []
};

function createTestEngine(storePath: string) {
  let sequence = 0;
  return createEngine({
    storePath,
    now: () => "2026-07-11T00:00:00.000Z",
    id: (prefix) => `${prefix}_${++sequence}`
  });
}

describe("engine.checkpoint", () => {
  it("persists one normalized checkpoint event and replays idempotently", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: " project-a ",
        source: { client: " codex ", session_id: "session-1", model: "gpt" },
        delta: baseDelta,
        tags: [" custom ", "custom", "checkpoint", "session:session-1"]
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first.idempotent_replay).toBe(false);
      expect(replay.idempotent_replay).toBe(true);
      expect(replay.record).toEqual(first.record);
      expect(await readEvents(storePath)).toHaveLength(1);
      expect(first.record).toMatchObject({
        kind: "session_summary",
        type: "checkpoint",
        scope: "project",
        project_id: "project-a",
        state: "candidate",
        confidence: 0.5,
        priority: "normal",
        visibility: "active",
        source: { client: "codex", session_id: "session-1", model: "gpt" },
        provenance: { method: "agent-proposed" },
        content: {
          format: "json",
          checkpoint: {
            session_id: "session-1",
            checkpoint_id: "checkpoint-1",
            current_task: "Persist checkpoints",
            progress: ["wrote tests"]
          }
        }
      });
      expect(first.record.content.text).toContain("Persist checkpoints");
      expect(first.record.tags).toEqual([
        "custom",
        "checkpoint",
        "session:session-1",
        "checkpoint:checkpoint-1"
      ]);
      expect(first.recovery_pack).toMatchObject({
        version: 1,
        available: true,
        bounded: true,
        project_id: "project-a",
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        source: { client: "codex", session_id: "session-1" },
        record_ids: [first.record.id],
        checkpoint: first.record.content.checkpoint
      });
    });
  });

  it("does not confuse distinct idempotency keys", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const variants = [
        { project_id: "project-a", source: { client: "codex", session_id: "session-1" }, delta: baseDelta },
        { project_id: "project-b", source: { client: "codex", session_id: "session-1" }, delta: baseDelta },
        { project_id: "project-a", source: { client: "claude", session_id: "session-1" }, delta: baseDelta },
        { project_id: "project-a", source: { client: "codex", session_id: "session-2" }, delta: { ...baseDelta, session_id: "session-2" } },
        { project_id: "project-a", source: { client: "codex", session_id: "session-1" }, delta: { ...baseDelta, checkpoint_id: "checkpoint-2" } }
      ];

      const results = [];
      for (const variant of variants) results.push(await engine.checkpoint(variant));

      expect(new Set(results.map((result) => result.record.id)).size).toBe(5);
      expect(results.every((result) => result.idempotent_replay === false)).toBe(true);
      expect(await readEvents(storePath)).toHaveLength(5);
    });
  });

  it("rejects invalid project and source identity", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);

      await expect(engine.checkpoint({ project_id: " ", source: { client: "codex", session_id: "session-1" }, delta: baseDelta })).rejects.toThrow();
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: " ", session_id: "session-1" }, delta: baseDelta })).rejects.toThrow();
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: "codex", session_id: " " }, delta: baseDelta })).rejects.toThrow();
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: "codex", session_id: "other" }, delta: baseDelta })).rejects.toThrow(/session_id/i);
      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("finds private checkpoints idempotently but hides recovery content by default", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        source: { client: "codex", session_id: "session-1" },
        delta: baseDelta,
        tags: ["private"]
      };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);
      const included = await engine.checkpoint({ ...input, include_private: true });

      expect(replay.idempotent_replay).toBe(true);
      expect(replay.recovery_pack).toMatchObject({ available: false, bounded: true, record_ids: [first.record.id] });
      expect(replay.recovery_pack).not.toHaveProperty("checkpoint");
      expect(included.idempotent_replay).toBe(true);
      expect(included.recovery_pack).toMatchObject({ available: true, checkpoint: first.record.content.checkpoint });
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("serializes concurrent duplicate calls into one event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1" }, delta: baseDelta };

      const [first, second] = await Promise.all([engine.checkpoint(input), engine.checkpoint(input)]);

      expect([first.idempotent_replay, second.idempotent_replay].sort()).toEqual([false, true]);
      expect(first.record.id).toBe(second.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("does not replay archived or quarantined checkpoints", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1" }, delta: baseDelta };

      const archived = await engine.checkpoint(input);
      await engine.archive({ record_id: archived.record.id, source: input.source });
      const afterArchive = await engine.checkpoint(input);
      await engine.quarantine({ record_id: afterArchive.record.id, source: input.source, reason: "test boundary" });
      const afterQuarantine = await engine.checkpoint(input);

      expect(afterArchive.idempotent_replay).toBe(false);
      expect(afterQuarantine.idempotent_replay).toBe(false);
      expect(new Set([archived.record.id, afterArchive.record.id, afterQuarantine.record.id]).size).toBe(3);
    });
  });
});
