import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore, withTempStore } from "../helpers/temp-store.js";

describe("event store", () => {
  it("requires store initialization before reading or appending events", async () => {
    await withTempStore(async (storePath) => {
      const uninitialized = join(storePath, "uninitialized");

      await expect(readEvents(uninitialized)).rejects.toThrow(/Store not initialized/);
      await expect(appendEvent(uninitialized, {
        event_id: "evt_missing_store",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_missing_store",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Should not write before init.", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      })).rejects.toThrow(/Store not initialized/);
    });
  });

  it("appends events under device and month partitions", async () => {
    await withInitializedTempStore(async (storePath) => {
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
    await withInitializedTempStore(async (storePath) => {
      const path = join(storePath, "events", "device_default", "2026-05", "evt_invalid.json");
      await mkdir(join(storePath, "events", "device_default", "2026-05"), { recursive: true });
      await writeFile(path, `${JSON.stringify({
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
      })}\n`, "utf8");

      await expect(readEvents(storePath)).rejects.toThrow(/Invalid event/);
    });
  });

  it("rejects invalid events before appending", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(appendEvent(storePath, {
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
      } as never)).rejects.toThrow(/Invalid event/);
    });
  });

  it("rejects unredacted sensitive events before appending", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(appendEvent(storePath, {
        event_id: "evt_secret",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_secret",
          kind: "memory",
          type: "warning",
          scope: "project",
          tags: [],
          content: {
            text: "Review deployment settings.",
            format: "text",
            token: "abcdef1234567890"
          },
          state: "quarantined",
          confidence: 0.5,
          priority: "normal",
          visibility: "quarantined",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      })).rejects.toThrow(/Sensitive content detected/);

      expect(await readEvents(storePath)).toHaveLength(0);
    });
  });
});
