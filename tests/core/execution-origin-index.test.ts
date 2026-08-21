import { describe, expect, it } from "vitest";
import {
  buildExecutionOriginIndex,
  loadExecutionOriginIndex,
  writeExecutionOriginIndex
} from "../../src/core/execution-origin-index.js";
import type { EventManifest } from "../../src/core/record-read-model.js";
import type { MorynEvent } from "../../src/core/types.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

function event(index: number): MorynEvent {
  const recordId = `rec_${index % 100}`;
  return {
    event_id: `evt_${index.toString().padStart(8, "0")}`,
    op: "revise_record",
    record_id: recordId,
    patch: { priority: index % 2 === 0 ? "normal" : "high" },
    reason: "origin index fixture",
    created_at: new Date(Date.UTC(2026, 7, 21, 0, 0, index)).toISOString(),
    source: { client: "test", device_id: index % 3 === 0 ? "device-a" : "device-b" }
  };
}

describe("execution origin derived index", () => {
  it("condenses a large event history into bounded per-record lineage", () => {
    const events = Array.from({ length: 25_000 }, (_, index) => event(index));
    const manifest: EventManifest = { count: events.length, digest: "a".repeat(64) };
    const index = buildExecutionOriginIndex(events, manifest);

    expect(Object.keys(index.records_by_id)).toHaveLength(100);
    expect(index.records_by_id.rec_0).toMatchObject({
      source_device_ids: ["device-a", "device-b"],
      has_unknown_source: false
    });
    expect(JSON.stringify(index)).not.toContain("origin index fixture");
  });

  it("serves a matching index without replaying event files", async () => {
    await withInitializedTempStore(async (storePath) => {
      const events = [event(0), event(1)];
      const manifest: EventManifest = { count: events.length, digest: "b".repeat(64) };
      await writeExecutionOriginIndex(storePath, buildExecutionOriginIndex(events, manifest));
      let eventReads = 0;

      const loaded = await loadExecutionOriginIndex(storePath, manifest, {
        read_events: async () => {
          eventReads += 1;
          return events;
        }
      });

      expect(loaded.source).toBe("derived_index");
      expect(eventReads).toBe(0);
      expect(loaded.index.event_manifest).toEqual(manifest);
    });
  });

  it("retries one unstable manifest read and publishes only the stable generation", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstEvents = [event(0)];
      const secondEvents = [event(0), event(1)];
      const firstManifest: EventManifest = { count: 1, digest: "c".repeat(64) };
      const secondManifest: EventManifest = { count: 2, digest: "d".repeat(64) };
      const manifests = [firstManifest, secondManifest, secondManifest, secondManifest];
      let eventReads = 0;

      const loaded = await loadExecutionOriginIndex(storePath, undefined, {
        read_event_manifest: async () => manifests.shift() ?? secondManifest,
        read_events: async () => {
          eventReads += 1;
          return eventReads === 1 ? firstEvents : secondEvents;
        },
        write_index: async () => undefined
      });

      expect(loaded.source).toBe("event_replay");
      expect(loaded.index.event_manifest).toEqual(secondManifest);
      expect(eventReads).toBe(2);
    });
  });

  it("does not combine an earlier record manifest with a later origin generation", async () => {
    await withInitializedTempStore(async (storePath) => {
      const expectedManifest: EventManifest = { count: 1, digest: "e".repeat(64) };
      const laterManifest: EventManifest = { count: 2, digest: "f".repeat(64) };

      await expect(
        loadExecutionOriginIndex(storePath, expectedManifest, {
          read_event_manifest: async () => laterManifest,
          read_events: async () => [event(0), event(1)],
          write_index: async () => undefined
        })
      ).rejects.toThrow("Execution origin index source changed during rebuild");
    });
  });
});
