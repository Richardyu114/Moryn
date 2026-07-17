import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("verified current record reads", () => {
  it("uses a fresh read model and repairs a missing artifact from event replay", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-12T00:00:00.000Z",
        id: (prefix) => `${prefix}_one`
      });
      const written = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Verified read models avoid replay." },
        source: { client: "test" }
      });

      const fresh = await readCurrentRecords(storePath);
      expect(fresh).toMatchObject({ source: "read_model", repaired: false, records: [{ id: written.record.id }] });

      await rm(join(storePath, "snapshots", "records.json"));
      const repaired = await readCurrentRecords(storePath);
      expect(repaired).toMatchObject({
        source: "event_replay",
        repaired: true,
        fallback_reason: "missing",
        records: [{ id: written.record.id }]
      });
      await expect(readFile(join(storePath, "snapshots", "records.json"), "utf8")).resolves.toContain(
        written.record.id
      );
    });
  });

  it("repairs corrupt and stale artifacts without losing authoritative events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-12T00:00:00.000Z",
        id: (prefix) => `${prefix}_one`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "First event." },
        source: { client: "test" }
      });
      await writeFile(join(storePath, "snapshots", "records.json"), "{broken", "utf8");
      expect(await readCurrentRecords(storePath)).toMatchObject({
        source: "event_replay",
        repaired: true,
        fallback_reason: "invalid",
        records: [{ content: { text: "First event." } }]
      });

      const externalEvent = {
        event_id: "evt_external",
        op: "upsert_record",
        record: {
          id: "rec_external",
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          tags: [],
          content: { text: "External event.", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-07-12T00:01:00.000Z",
          updated_at: "2026-07-12T00:01:00.000Z",
          source: { client: "other", device_id: "device-other" }
        },
        created_at: "2026-07-12T00:01:00.000Z",
        source: { client: "other", device_id: "device-other" }
      };
      const eventDir = join(storePath, "events", "device-other", "2026-07");
      await mkdir(eventDir, { recursive: true });
      await writeFile(join(eventDir, "evt_external.json"), `${JSON.stringify(externalEvent, null, 2)}\n`, "utf8");

      const stale = await readCurrentRecords(storePath);
      expect(stale).toMatchObject({ source: "event_replay", repaired: true, fallback_reason: "stale" });
      expect(stale.records.map((record) => record.id).sort()).toEqual(["rec_external", "rec_one"]);
    });
  });

  it("falls back on incompatible versions and does not block when repair persistence fails", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-12T00:00:00.000Z",
        id: (prefix) => `${prefix}_one`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Authoritative fallback survives." },
        source: { client: "test" }
      });
      const path = join(storePath, "snapshots", "records.json");
      const current = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, `${JSON.stringify({ ...current, version: 2 })}\n`, "utf8");

      const result = await readCurrentRecords(storePath, {
        write_read_model: async () => {
          throw new Error("disk full");
        }
      });
      expect(result).toMatchObject({
        source: "event_replay",
        repaired: false,
        fallback_reason: "version_mismatch",
        records: [{ content: { text: "Authoritative fallback survives." } }]
      });
      expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
    });
  });
});
