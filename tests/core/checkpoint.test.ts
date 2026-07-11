import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEngine } from "../../src/core/engine.js";
import { checkpointIdentity, normalizeCheckpointInput, recoveryPack } from "../../src/core/checkpoint.js";
import { appendEvent, appendEventIfAbsent, readEvents } from "../../src/core/store.js";
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
const execFileAsync = promisify(execFile);
const authored = {
  occurred_at: "2026-07-11T00:00:00.000Z",
  source: { client: "codex", session_id: "session-1", device_id: "device-test" }
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
        source: { client: " codex ", session_id: "session-1", model: "gpt", device_id: "device-test" },
        occurred_at: "2026-07-11T00:00:00.000Z",
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
        { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta },
        { project_id: "project-b", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta },
        { project_id: "project-a", source: { client: "claude", session_id: "session-1", device_id: "device-test" }, occurred_at: authored.occurred_at, delta: baseDelta },
        { project_id: "project-a", source: { client: "codex", session_id: "session-2", device_id: "device-test" }, occurred_at: authored.occurred_at, delta: { ...baseDelta, session_id: "session-2" } },
        { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { ...baseDelta, checkpoint_id: "checkpoint-2" } }
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

      await expect(engine.checkpoint({ project_id: " ", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta })).rejects.toThrow();
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: " ", session_id: "session-1", device_id: "device-test" }, occurred_at: authored.occurred_at, delta: baseDelta })).rejects.toThrow();
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: "codex", session_id: " ", device_id: "device-test" }, occurred_at: authored.occurred_at, delta: baseDelta })).rejects.toThrow();
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: "codex", session_id: "other", device_id: "device-test" }, occurred_at: authored.occurred_at, delta: baseDelta })).rejects.toThrow(/session_id/i);
      await expect(engine.checkpoint({ project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "" }, occurred_at: authored.occurred_at, delta: baseDelta })).rejects.toThrow(/device_id/i);
      await expect(engine.checkpoint({ project_id: "project-a", source: authored.source, occurred_at: "2026-07-11", delta: baseDelta })).rejects.toThrow(/occurred_at/i);
      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("finds private checkpoints idempotently but hides recovery content by default", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = {
        project_id: "project-a",
        ...authored,
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
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };

      const [first, second] = await Promise.all([engine.checkpoint(input), engine.checkpoint(input)]);

      expect([first.idempotent_replay, second.idempotent_replay].sort()).toEqual([false, true]);
      expect(first.record.id).toBe(second.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("serializes duplicate calls across engine instances", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstEngine = createTestEngine(storePath);
      const secondEngine = createTestEngine(storePath);
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };

      const [first, second] = await Promise.all([firstEngine.checkpoint(input), secondEngine.checkpoint(input)]);

      expect([first.idempotent_replay, second.idempotent_replay].sort()).toEqual([false, true]);
      expect(first.record.id).toBe(second.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("uses deterministic event and record ids for the same authored input", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstEngine = createEngine({ storePath, now: () => "2026-07-11T00:00:00.000Z", id: () => "random_a" });
      const secondEngine = createEngine({ storePath, now: () => "2026-07-12T00:00:00.000Z", id: () => "random_b" });
      const firstInput = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-a" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };
      const secondInput = { ...firstInput };

      const [first, second] = await Promise.all([firstEngine.checkpoint(firstInput), secondEngine.checkpoint(secondInput)]);

      expect(first.record.id).toBe(second.record.id);
      expect(first.record.id).toMatch(/^rec_checkpoint_[a-f0-9]{64}$/);
      const [event] = await readEvents(storePath);
      expect(event?.event_id).toMatch(/^evt_checkpoint_[a-f0-9]{64}$/);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each([
    { field: "progress", delta: { ...baseDelta, progress: ["different progress"] } },
    { field: "current_task", delta: { ...baseDelta, current_task: "Different task" } },
    { field: "learnings", delta: { ...baseDelta, learnings: [{ question: "Q", conclusion: "C", evidence_type: "source_code", scope: "project", confidence: 0.8, recommended_kind: "memory", recommended_type: "fact" }] } }
  ])("rejects same-key payload collision for $field", async ({ delta }) => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };
      await engine.checkpoint(input);

      await expect(engine.checkpoint({ ...input, delta })).rejects.toThrow("Checkpoint idempotency collision");
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each([
    { field: "occurred_at", change: { occurred_at: "2026-07-11T00:00:01.000Z" } },
    { field: "device_id", change: { source: { ...authored.source, device_id: "different-device" } } }
  ])("rejects same-key authored payload collision for $field", async ({ change }) => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", ...authored, delta: baseDelta };
      await engine.checkpoint(input);

      await expect(engine.checkpoint({ ...input, ...change })).rejects.toThrow("Checkpoint idempotency collision");
    });
  });

  it("writes byte-identical events for identical authored input in independent stores", async () => {
    const outputs: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      await withInitializedTempStore(async (storePath) => {
        const engine = createEngine({ storePath, now: () => index ? "2030-01-01T00:00:00.000Z" : "2020-01-01T00:00:00.000Z" });
        const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "authored-device" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };
        const result = await engine.checkpoint(input);
        const identity = checkpointIdentity(normalizeCheckpointInput(input));
        outputs.push(await readFile(join(storePath, "events", "idempotent", `${identity.event_id}.json`), "utf8"));
        expect(result.record.created_at).toBe(input.occurred_at);
      });
    }
    expect(outputs[0]).toBe(outputs[1]);
  });

  it("rejects deterministic event collisions with mismatched checkpoint content", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };
      const normalized = normalizeCheckpointInput(input);
      const identity = checkpointIdentity(normalized);
      await appendEventIfAbsent(storePath, {
        event_id: identity.event_id,
        op: "upsert_record",
        created_at: "2026-07-10T00:00:00.000Z",
        source: normalized.source,
        record: {
          id: identity.record_id,
          kind: "session_summary",
          type: "checkpoint",
          scope: "project",
          project_id: "other-project",
          tags: ["checkpoint", "session:session-1", "checkpoint:checkpoint-1"],
          content: { format: "json", text: "collision", checkpoint_version: 1, checkpoint: normalized.delta },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-07-10T00:00:00.000Z",
          updated_at: "2026-07-10T00:00:00.000Z",
          source: normalized.source,
          provenance: { method: "agent-proposed" }
        }
      });

      await expect(engine.checkpoint(input)).rejects.toThrow(/idempotency collision/i);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("deduplicates checkpoint creation across child processes", async () => {
    await withInitializedTempStore(async (storePath) => {
      const script = `
        import { createEngine } from './src/core/engine.ts';
        const [storePath, deviceId] = process.argv.slice(1);
        const engine = createEngine({ storePath, now: () => '2026-07-11T00:00:00.000Z' });
        const result = await engine.checkpoint({
          project_id: 'project-a',
          source: { client: 'codex', session_id: 'session-1', device_id: deviceId },
          occurred_at: '2026-07-11T00:00:00.000Z',
          delta: ${JSON.stringify(baseDelta)}
        });
        process.stdout.write(JSON.stringify({ id: result.record.id, replay: result.idempotent_replay }));
      `;
      const options = { cwd: process.cwd(), maxBuffer: 1024 * 1024 };
      const [first, second] = await Promise.all([
        execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, storePath, "shared-device"], options),
        execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, storePath, "shared-device"], options)
      ]);
      const results = [JSON.parse(first.stdout), JSON.parse(second.stdout)] as Array<{ id: string; replay: boolean }>;

      expect(new Set(results.map((result) => result.id)).size).toBe(1);
      expect(results.map((result) => result.replay).sort()).toEqual([false, true]);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it.each(["private", "PRIVATE", "Secret", "sEnSiTiVe"])("hides %s checkpoint recovery by default", async (privateTag) => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const result = await engine.checkpoint({
        project_id: "project-a",
        ...authored,
        delta: baseDelta,
        tags: [privateTag]
      });

      expect(result.recovery_pack.available).toBe(false);
      expect(result.recovery_pack).not.toHaveProperty("checkpoint");
    });
  });

  it("versions checkpoint content and ignores malformed manual checkpoint records", async () => {
    await withInitializedTempStore(async (storePath) => {
      await appendEvent(storePath, {
        event_id: "evt_manual",
        op: "upsert_record",
        created_at: "2026-07-10T00:00:00.000Z",
        source: { client: "codex", session_id: "session-1" },
        record: {
          id: "rec_manual",
          kind: "session_summary",
          type: "checkpoint",
          scope: "project",
          project_id: "project-a",
          tags: ["checkpoint", "session:session-1", "checkpoint:checkpoint-1"],
          content: { format: "json", text: "manual", checkpoint_version: 1, checkpoint: { session_id: "session-1", checkpoint_id: "checkpoint-1" } },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-07-10T00:00:00.000Z",
          updated_at: "2026-07-10T00:00:00.000Z",
          ...authored,
          provenance: { method: "agent-proposed" }
        }
      });
      const engine = createTestEngine(storePath);

      const result = await engine.checkpoint({ project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta });

      expect(result.idempotent_replay).toBe(false);
      expect(result.record.id).not.toBe("rec_manual");
      expect(result.record.content.checkpoint_version).toBe(1);
      expect(result.recovery_pack.available).toBe(true);
      expect(await readEvents(storePath)).toHaveLength(2);
    });
  });

  it("returns unavailable recovery for malformed checkpoint content", () => {
    const pack = recoveryPack({
      id: "rec_bad",
      kind: "session_summary",
      type: "checkpoint",
      scope: "project",
      project_id: "project-a",
      tags: [],
      content: { format: "json", checkpoint_version: 1, checkpoint: { session_id: "session-1" } },
      state: "candidate",
      confidence: 0.5,
      priority: "normal",
      visibility: "active",
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:00:00.000Z",
      source: { client: "codex", session_id: "session-1" },
      provenance: { method: "agent-proposed" }
    }, true);

    expect(pack).toMatchObject({ available: false, session_id: "session-1", checkpoint_id: "", record_ids: ["rec_bad"] });
    expect(pack).not.toHaveProperty("checkpoint");
  });

  it("returns committed checkpoint when derived view rebuild fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-11T00:00:00.000Z",
        id: (() => { let sequence = 0; return (prefix: string) => `${prefix}_${++sequence}`; })(),
        rebuild: async () => { throw new Error("rebuild failed"); }
      });
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };

      const first = await engine.checkpoint(input);
      const replay = await engine.checkpoint(input);

      expect(first).toMatchObject({ committed: true, derived_views_refreshed: false, warning: { code: "DERIVED_VIEW_REBUILD_FAILED" } });
      expect(replay).toMatchObject({ committed: true, idempotent_replay: true, derived_views_refreshed: false, warning: { code: "DERIVED_VIEW_REBUILD_FAILED" } });
      expect(replay.record.id).toBe(first.record.id);
      expect(await readEvents(storePath)).toHaveLength(1);
    });
  });

  it("rejects sensitive checkpoint content without appending an event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const delta = { ...baseDelta, current_task: "Use api_key=abcdefghijklmnop" };

      await expect(engine.checkpoint({ project_id: "project-a", ...authored, delta })).rejects.toThrow(/Sensitive content detected/i);
      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });

  it("keeps the deterministic idempotency key after archive or quarantine", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createTestEngine(storePath);
      const input = { project_id: "project-a", source: { client: "codex", session_id: "session-1", device_id: "device-test" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: baseDelta };

      const archived = await engine.checkpoint(input);
      await engine.archive({ record_id: archived.record.id, source: input.source });
      const afterArchive = await engine.checkpoint(input);
      await engine.quarantine({ record_id: afterArchive.record.id, source: input.source, reason: "test boundary" });
      const afterQuarantine = await engine.checkpoint(input);

      expect(afterArchive.idempotent_replay).toBe(true);
      expect(afterQuarantine.idempotent_replay).toBe(true);
      expect(new Set([archived.record.id, afterArchive.record.id, afterQuarantine.record.id]).size).toBe(1);
    });
  });
});
