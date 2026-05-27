import { describe, expect, it } from "vitest";
import { replayEvents } from "../../src/core/replay.js";

describe("event replay", () => {
  it("applies upsert, revise, and promote events", () => {
    const records = replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_1",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Old", format: "text" },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      },
      {
        event_id: "evt_2",
        op: "revise_record",
        record_id: "rec_1",
        patch: { "content.text": "New", confidence: 0.9 },
        reason: "Refined",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      },
      {
        event_id: "evt_3",
        op: "promote_record",
        record_id: "rec_1",
        target_state: "canonical",
        reason: "Confirmed",
        created_at: "2026-05-27T00:02:00.000Z",
        source: { client: "test" }
      }
    ]);

    const record = records.get("rec_1");
    expect(record?.content.text).toBe("New");
    expect(record?.confidence).toBe(0.9);
    expect(record?.state).toBe("canonical");
  });
});
