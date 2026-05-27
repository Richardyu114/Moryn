import { describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../../src/core/store.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("event store", () => {
  it("appends events under device and month partitions", async () => {
    await withTempStore(async (storePath) => {
      await appendEvent(storePath, {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_1",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "A", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      });

      const events = await readEvents(storePath);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_id).toBe("evt_1");
    });
  });

  it("rejects invalid event files while reading", async () => {
    await withTempStore(async (storePath) => {
      await appendEvent(storePath, {
        event_id: "evt_invalid",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_bad",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Bad", format: "text" },
          state: "published",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      } as never);

      await expect(readEvents(storePath)).rejects.toThrow(/Invalid event/);
    });
  });
});
