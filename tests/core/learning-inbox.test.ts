import { describe, expect, it } from "vitest";
import { consumeLearningInbox, pendingLearningInbox, queueLearning } from "../../src/core/learning-inbox.js";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const source = { client: "codex", session_id: "session-a", device_id: "device-a" };

function input(overrides: Record<string, unknown> = {}) {
  return {
    project_id: "moryn",
    question: "What protects learning before compaction?",
    conclusion: "Moryn queues supported learning before lifecycle capture.",
    evidence_type: "source_code",
    source,
    occurred_at: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}

describe("learning inbox", () => {
  it("queues a default project memory with a stable idempotent identity", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await queueLearning(storePath, input());
      const second = await queueLearning(storePath, input({ occurred_at: "2026-07-13T00:01:00.000Z" }));

      expect(first).toMatchObject({ created: true, record: { kind: "agent_note", type: "learning_inbox", scope: "project", project_id: "moryn", state: "candidate", content: { learning_inbox_version: 1, status: "pending", learning_delta: { scope: "project", confidence: 0.8, recommended_kind: "memory", recommended_type: "fact" } } } });
      expect(second).toMatchObject({ created: false, record: { id: first.record.id } });
      expect((await readEvents(storePath)).filter((event) => event.op === "upsert_record")).toHaveLength(1);
    });
  });

  it("selects same-session pending items first and bounds the result", async () => {
    await withInitializedTempStore(async (storePath) => {
      for (let index = 0; index < 25; index += 1) {
        await queueLearning(storePath, input({
          question: `Question ${index}`,
          conclusion: `Conclusion ${index}`,
          source: { ...source, session_id: index >= 20 ? "session-a" : "session-other" },
          occurred_at: `2026-07-13T00:${String(index).padStart(2, "0")}:00.000Z`
        }));
      }

      const pending = await pendingLearningInbox(storePath, { project_id: "moryn", session_id: "session-a" });
      expect(pending).toHaveLength(20);
      expect(pending.slice(0, 5).every((record) => record.source.session_id === "session-a")).toBe(true);
      expect(pending.slice(0, 5).map((record) => record.created_at)).toEqual([...pending.slice(0, 5).map((record) => record.created_at)].sort());
      expect(pending.slice(5).map((record) => record.created_at)).toEqual([...pending.slice(5).map((record) => record.created_at)].sort());
    });
  });

  it("marks queued items consumed with produced record and origin links idempotently", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-13T00:05:00.000Z", id: (() => { let index = 0; return (prefix) => `${prefix}_${++index}`; })() });
      const checkpoint = await engine.write({ kind: "session_summary", type: "checkpoint", scope: "project", project_id: "moryn", content: { text: "Checkpoint" }, source });
      const learning = await engine.write({ kind: "memory", type: "fact", scope: "project", project_id: "moryn", content: { text: "Learning" }, source });
      const queued = await queueLearning(storePath, input());
      const first = await consumeLearningInbox(storePath, {
        inbox_records: [queued.record],
        consumed_at: "2026-07-13T00:10:00.000Z",
        consumed_by_record_id: checkpoint.record.id,
        produced_record_ids: [learning.record.id],
        source
      });
      const second = await consumeLearningInbox(storePath, {
        inbox_records: [queued.record],
        consumed_at: "2026-07-13T00:10:00.000Z",
        consumed_by_record_id: checkpoint.record.id,
        produced_record_ids: [learning.record.id],
        source
      });

      expect(first).toEqual({ consumed: 1, already_consumed: 0, inbox_record_ids: [queued.record.id] });
      expect(second).toEqual({ consumed: 0, already_consumed: 1, inbox_record_ids: [queued.record.id] });
      const [record] = await pendingLearningInbox(storePath, { project_id: "moryn", include_consumed: true });
      expect(record).toMatchObject({ content: { status: "consumed", consumed_at: "2026-07-13T00:10:00.000Z", consumed_by_record_id: checkpoint.record.id, produced_record_ids: [learning.record.id] } });
      expect(record.links).toEqual(expect.arrayContaining([
        expect.objectContaining({ link_type: "consumed_by", record_id: checkpoint.record.id }),
        expect.objectContaining({ link_type: "produced", record_id: learning.record.id })
      ]));
    });
  });

  it("rejects project learning without project identity", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(queueLearning(storePath, input({ project_id: undefined }))).rejects.toThrow("project learning requires project_id");
    });
  });
});
