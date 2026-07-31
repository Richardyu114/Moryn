import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { buildActiveLogicalMemoryView } from "../../src/core/logical-memory.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("automatic semantic maintenance", () => {
  it("applies at most one proof-gated merge and verifies the actual working set decreases", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.parse("2026-07-20T00:00:00.000Z") + tick++).toISOString()
      });
      const shared = `The verified maintenance procedure retains this complete evidence ${"shared ".repeat(600)}.`;
      const base = {
        kind: "skill" as const,
        type: "procedure",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["maintenance"],
        state: "canonical" as const,
        confirmed: true,
        confidence: 0.99,
        source: { client: "codex" }
      };
      const old = (await engine.write({ ...base, content: { text: `${shared} Old endpoint remains available.` } }))
        .record;
      const next = (await engine.write({ ...base, content: { text: `${shared} New endpoint is canonical.` } })).record;
      const beforeEvents = await readEvents(storePath);

      const result = await engine.applyAutomaticSemanticMaintenance({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-1" }
      });

      expect(result).toMatchObject({
        status: "committed",
        maximum_merges: 1,
        drafts_ready: 1,
        merges_attempted: 1,
        merges_committed: 1,
        before: { current_records: 2 },
        after: { current_records: 1 },
        proof: {
          strict_record_decrease_observed: true,
          strict_token_decrease_observed: true,
          source_history_retained: true,
          physical_delete: false
        }
      });
      expect(result.after.estimated_tokens).toBeLessThan(result.before.estimated_tokens);
      expect(result.committed[0]).toMatchObject({
        source_record_ids: [next.id, old.id].sort(),
        projected_record_reduction: 1,
        result: { status: "accepted", merged_record_state: "canonical" }
      });
      const records = (await readCurrentRecords(storePath)).records;
      const logical = buildActiveLogicalMemoryView(records);
      expect(logical.active_records.filter((record) => record.visibility === "active")).toHaveLength(1);
      expect(records).toHaveLength(3);
      expect(records.find((record) => record.id === old.id)).toBeDefined();
      expect(records.find((record) => record.id === next.id)).toBeDefined();

      const eventCount = (await readEvents(storePath)).length;
      const replay = await engine.applyAutomaticSemanticMaintenance({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-1" }
      });
      expect(replay).toMatchObject({ status: "skipped", merges_attempted: 0, merges_committed: 0 });
      expect(await readEvents(storePath)).toHaveLength(eventCount);
      expect(eventCount).toBeGreaterThan(beforeEvents.length);
    });
  });

  it("runs once for a new checkpoint and does not rerun on an idempotent replay", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.parse("2026-07-20T00:00:00.000Z") + tick++).toISOString()
      });
      const shared = `The verified checkpoint procedure retains this complete evidence ${"shared ".repeat(600)}.`;
      const base = {
        kind: "skill" as const,
        type: "procedure",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["checkpoint-maintenance"],
        state: "canonical" as const,
        confirmed: true,
        confidence: 0.99,
        source: { client: "codex" }
      };
      await engine.write({ ...base, content: { text: `${shared} Old endpoint remains available.` } });
      await engine.write({ ...base, content: { text: `${shared} New endpoint is canonical.` } });
      const input = {
        project_id: "moryn",
        source: { client: "codex", session_id: "session-checkpoint", device_id: "device-checkpoint" },
        occurred_at: "2026-07-20T00:01:00.000Z",
        delta: {
          session_id: "session-checkpoint",
          checkpoint_id: "semantic-maintenance",
          current_task: "Maintain compact memory",
          progress: [],
          decisions: [],
          changed_facts: [],
          blockers: [],
          next_steps: [],
          files: [],
          candidate_memories: [],
          candidate_skills: [],
          learnings: []
        }
      };

      const first = await engine.checkpoint(input);
      const eventCount = (await readEvents(storePath)).length;
      const replay = await engine.checkpoint(input);

      expect(first.automatic_semantic_maintenance).toMatchObject({
        status: "committed",
        maximum_merges: 1,
        merges_attempted: 1,
        merges_committed: 1,
        proof: {
          strict_record_decrease_observed: true,
          strict_token_decrease_observed: true,
          source_history_retained: true,
          physical_delete: false
        }
      });
      expect(replay.automatic_semantic_maintenance).toBeUndefined();
      expect(await readEvents(storePath)).toHaveLength(eventCount);
    });
  });
});
