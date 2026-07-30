import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { logicalMemoryFingerprint } from "../../src/core/logical-memory.js";
import { memoryCompactionRecordDigest } from "../../src/core/memory-compaction-integrity.js";
import { buildMemoryRetentionView } from "../../src/core/memory-retention.js";
import { estimateMemoryRecordTokens, selectMemoryWorkingSet } from "../../src/core/record-read-model.js";
import { replayEvents } from "../../src/core/replay.js";
import { readEvents } from "../../src/core/store.js";
import { structuredSemanticMergeSourceDigest } from "../../src/core/structured-semantic-merge.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";
import { getOperationContract } from "../../src/operation-contracts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const baseRecord: MorynRecord = {
  id: "rec-feedback",
  kind: "memory",
  type: "decision",
  scope: "project",
  project_id: "moryn",
  tags: ["dashboard"],
  content: { text: "Deploy the dashboard through the release workflow." },
  state: "canonical",
  confidence: 0.9,
  priority: "normal",
  visibility: "active",
  created_at: "2026-07-30T00:00:00.000Z",
  updated_at: "2026-07-30T00:00:00.000Z",
  source: { client: "test" }
};

function upsert(record: MorynRecord = baseRecord): MorynEvent {
  return {
    event_id: "evt-upsert",
    op: "upsert_record",
    record,
    created_at: record.created_at,
    source: { client: "test" }
  };
}

function feedback(
  eventId: string,
  outcome: "recalled" | "used" | "verified" | "rejected",
  createdAt: string,
  recordId = baseRecord.id
): MorynEvent {
  return {
    event_id: eventId,
    op: "record_feedback",
    record_id: recordId,
    outcome,
    created_at: createdAt,
    source: { client: "test" }
  };
}

describe("record feedback projection", () => {
  it("publishes one consistent CLI and MCP operation contract", () => {
    const contract = getOperationContract("memory_feedback").operation;
    expect(contract).toMatchObject({
      safe_to_run: false,
      required_fields: ["record_id", "outcome", "idempotency_key"],
      interfaces: {
        cli: {
          argv: ["memory", "feedback", "<record_id>", "--outcome", "<outcome>", "--idempotency-key", "<interaction_id>"]
        },
        mcp: { tool: "memory_feedback" }
      }
    });
    expect(contract.arguments_by_name.outcome?.allowed_values).toEqual(["recalled", "used", "verified", "rejected"]);
  });

  it("projects feedback after semantic replay without changing semantic identity", () => {
    const projected = replayEvents([
      feedback("evt-used", "used", "2026-07-30T00:03:00.000Z"),
      upsert({
        ...baseRecord,
        memory_usage: {
          version: 1,
          recall_count: 50,
          useful_count: 50,
          rejected_count: 0
        }
      }),
      feedback("evt-rejected", "rejected", "2026-07-30T00:01:00.000Z"),
      feedback("evt-verified", "verified", "2026-07-30T00:02:00.000Z")
    ]).get(baseRecord.id)!;

    expect(projected.content).toEqual(baseRecord.content);
    expect(projected.updated_at).toBe(baseRecord.updated_at);
    expect(projected.memory_usage).toEqual({
      version: 1,
      last_recalled_at: "2026-07-30T00:03:00.000Z",
      last_useful_at: "2026-07-30T00:03:00.000Z",
      last_rejected_at: "2026-07-30T00:01:00.000Z",
      last_verified_at: "2026-07-30T00:02:00.000Z",
      recall_count: 3,
      useful_count: 2,
      rejected_count: 1
    });
    expect(buildMemoryRetentionView(projected).validity.last_verified_at).toBe("2026-07-30T00:02:00.000Z");
    expect(logicalMemoryFingerprint(projected)).toBe(logicalMemoryFingerprint(baseRecord));
    expect(memoryCompactionRecordDigest(projected)).toBe(memoryCompactionRecordDigest(baseRecord));
    expect(structuredSemanticMergeSourceDigest(projected)).toBe(structuredSemanticMergeSourceDigest(baseRecord));
    expect(estimateMemoryRecordTokens(projected)).toBe(estimateMemoryRecordTokens(baseRecord));
  });

  it("ignores orphan feedback during cross-device replay", () => {
    expect(replayEvents([feedback("evt-orphan", "used", "2026-07-30T00:01:00.000Z", "rec-missing")])).toEqual(
      new Map()
    );
  });

  it("uses positive and negative outcomes as a conservative ranking signal", () => {
    const useful: MorynRecord = {
      ...baseRecord,
      id: "rec-useful",
      memory_usage: { version: 1, recall_count: 1, useful_count: 1, rejected_count: 0 }
    };
    const rejected: MorynRecord = {
      ...baseRecord,
      id: "rec-reject",
      memory_usage: { version: 1, recall_count: 1, useful_count: 0, rejected_count: 1 }
    };

    const selection = selectMemoryWorkingSet([rejected, useful], { layer_limits: { L2: 1 } });
    expect(selection.selected.map((entry) => entry.record.id)).toEqual(["rec-useful"]);
    expect(selection.excluded.map((entry) => entry.record.id)).toEqual(["rec-reject"]);
  });

  it("records exactly one final outcome per idempotency key", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-30T00:00:00.000Z" });
      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Use the release workflow." },
        state: "candidate",
        source: { client: "test" }
      });
      const eventCountBeforeRecall = (await readEvents(storePath)).length;

      await engine.recall({ record_ids: [written.record.id] });
      expect(await readEvents(storePath)).toHaveLength(eventCountBeforeRecall);

      const first = await engine.recordFeedback({
        record_id: written.record.id,
        outcome: "used",
        occurred_at: "2026-07-30T00:01:00.000Z",
        idempotency_key: "interaction-1"
      });
      const retry = await engine.recordFeedback({
        record_id: written.record.id,
        outcome: "used",
        occurred_at: "2026-07-30T00:01:00.000Z",
        idempotency_key: "interaction-1"
      });

      expect(first.usage).toMatchObject({ recall_count: 1, useful_count: 1, rejected_count: 0 });
      expect(retry).toMatchObject({ idempotent_replay: true });
      expect(retry.usage).toMatchObject({ recall_count: 1, useful_count: 1, rejected_count: 0 });
      await expect(
        engine.recordFeedback({
          record_id: written.record.id,
          outcome: "rejected",
          occurred_at: "2026-07-30T00:01:00.000Z",
          idempotency_key: "interaction-1"
        })
      ).rejects.toThrow(/Idempotency collision/i);

      const second = await engine.recordFeedback({
        record_id: written.record.id,
        outcome: "rejected",
        occurred_at: "2026-07-30T00:02:00.000Z",
        idempotency_key: "interaction-2"
      });
      expect(second.usage).toMatchObject({ recall_count: 2, useful_count: 1, rejected_count: 1 });
      const feedbackEvents = (await readEvents(storePath)).filter((event) => event.op === "record_feedback");
      expect(feedbackEvents).toHaveLength(2);
      expect(feedbackEvents[0]).not.toHaveProperty("query");
      expect(feedbackEvents[0]).not.toHaveProperty("answer");

      await expect(
        engine.revise({
          record_id: written.record.id,
          patch: {
            memory_usage: { version: 1, recall_count: 99, useful_count: 99, rejected_count: 0 }
          }
        })
      ).rejects.toThrow(/managed field memory_usage/i);
    });
  });
});
