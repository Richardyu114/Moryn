import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runAutomaticEventAudit } from "../../src/core/automatic-event-audit.js";
import { createEngine } from "../../src/core/engine.js";
import { appendEvent, readEventInputs, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore, withTempStore } from "../helpers/temp-store.js";

function withoutStoreLease<T>(_storePath: string, work: () => Promise<T>): Promise<T> {
  return work();
}

describe("automatic event audit", () => {
  it("verifies a healthy event history and fresh records snapshot", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-24T00:00:00.000Z",
        id: (prefix) => `${prefix}_healthy`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Automatic event audit verifies authoritative history." },
        source: { client: "test" }
      });

      let historyReads = 0;
      await expect(
        runAutomaticEventAudit(storePath, {
          read_events: async () => {
            historyReads += 1;
            throw new Error("a fresh rebuild proof must avoid replaying event history");
          }
        })
      ).resolves.toEqual({
        status: "completed",
        event_count: 1,
        record_count: 1,
        snapshot_status: "fresh"
      });
      expect(historyReads).toBe(0);
    });
  });

  it("repairs a same-id snapshot projection mismatch and verifies the readback", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-24T00:00:00.000Z",
        id: (prefix) => `${prefix}_repair`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Authoritative event text." },
        source: { client: "test" }
      });
      const snapshotPath = join(storePath, "snapshots", "records.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      snapshot.records[0].content.text = "Tampered snapshot text that must not survive.";
      await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

      await expect(runAutomaticEventAudit(storePath)).resolves.toEqual({
        status: "completed",
        event_count: 1,
        record_count: 1,
        snapshot_status: "repaired"
      });
      const repaired = JSON.parse(await readFile(snapshotPath, "utf8"));
      expect(repaired.records[0].content.text).toBe("Authoritative event text.");
    });
  });

  it.each([
    ["well-shaped field tampering", (proof: Record<string, unknown>) => ({ ...proof, record_count: 999 })],
    ["invalid JSON", () => "{broken"]
  ])("falls back to full verification when the proof has %s", async (_label, tamper) => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-24T00:00:00.000Z",
        id: (prefix) => `${prefix}_proof_tamper`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "A damaged proof must never override authoritative history." },
        source: { client: "test" }
      });
      const proofPath = join(storePath, "state", "event-audit-proof.json");
      const proof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
      const damaged = tamper(proof);
      await writeFile(proofPath, typeof damaged === "string" ? damaged : `${JSON.stringify(damaged, null, 2)}\n`);

      let historyReads = 0;
      await expect(
        runAutomaticEventAudit(storePath, {
          read_events: async (path) => {
            historyReads += 1;
            return readEventInputs(path);
          }
        })
      ).resolves.toMatchObject({ status: "completed", event_count: 1, record_count: 1 });
      expect(historyReads).toBe(1);
    });
  });

  it("invalidates a healthy proof when the event generation changes", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-24T00:00:00.000Z",
        id: (prefix) => `${prefix}_proof_generation`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "The first event produced the proof." },
        source: { client: "test", device_id: "device-proof" }
      });
      const original = (await readEvents(storePath))[0];
      if (original?.op !== "upsert_record") throw new Error("expected an upsert fixture event");
      await appendEvent(storePath, {
        ...original,
        event_id: "evt_after_proof",
        created_at: "2026-07-24T00:01:00.000Z",
        record: {
          ...original.record,
          id: "rec_after_proof",
          created_at: "2026-07-24T00:01:00.000Z",
          updated_at: "2026-07-24T00:01:00.000Z",
          content: { text: "A later event invalidates the earlier proof." }
        }
      });

      let historyReads = 0;
      await expect(
        runAutomaticEventAudit(storePath, {
          read_events: async (path) => {
            historyReads += 1;
            return readEventInputs(path);
          }
        })
      ).resolves.toMatchObject({ status: "completed", event_count: 2, record_count: 2 });
      expect(historyReads).toBe(1);
    });
  });

  it("invalidates a healthy proof when an existing event file is damaged outside the writer API", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-24T00:00:00.000Z",
        id: (prefix) => `${prefix}_proof_corruption`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "The event file is authoritative." },
        source: { client: "test", device_id: "device-proof-corruption" }
      });
      await writeFile(
        join(storePath, "events", "device-proof-corruption", "2026-07", "evt_proof_corruption.json"),
        "{broken",
        "utf8"
      );

      let historyReads = 0;
      const result = await runAutomaticEventAudit(storePath, {
        read_events: async (path) => {
          historyReads += 1;
          return readEventInputs(path);
        }
      });
      expect(result).toMatchObject({ status: "failed", code: "EVENT_SCHEMA_INVALID" });
      expect(historyReads).toBe(1);
    });
  });

  it("returns fixed schema and read failure receipts without exposing underlying values", async () => {
    const schemaFailure = await runAutomaticEventAudit("/private/store", {
      with_store_state_lease: withoutStoreLease,
      read_events: async () => [{ op: "invalid", private_value: "do-not-return" }]
    });
    expect(schemaFailure).toEqual({
      status: "failed",
      failure_stage: "schema",
      code: "EVENT_SCHEMA_INVALID",
      reason: "One or more stored events failed schema validation.",
      event_count: 1,
      record_count: 0,
      snapshot_status: "not_checked"
    });

    const readFailure = await runAutomaticEventAudit("/private/store", {
      with_store_state_lease: withoutStoreLease,
      read_events: async () => {
        throw new Error("secret payload at /private/store/events/broken.json");
      }
    });
    expect(readFailure).toEqual({
      status: "failed",
      failure_stage: "read_events",
      code: "EVENT_READ_FAILED",
      reason: "Stored events could not be read for integrity verification.",
      event_count: 0,
      record_count: 0,
      snapshot_status: "not_checked"
    });
    expect(JSON.stringify([schemaFailure, readFailure])).not.toContain("secret");
    expect(JSON.stringify([schemaFailure, readFailure])).not.toContain("/private/store");
  });

  it.each([
    ["malformed JSON", "{broken"],
    ["schema-invalid JSON", JSON.stringify({ event_id: "evt_invalid", op: "archive_record" })]
  ])("classifies a real %s event file as EVENT_SCHEMA_INVALID", async (_label, content) => {
    await withInitializedTempStore(async (storePath) => {
      const eventDirectory = join(storePath, "events", "device-corrupt", "2026-07");
      await mkdir(eventDirectory, { recursive: true });
      await writeFile(join(eventDirectory, "evt_invalid.json"), content, "utf8");

      await expect(runAutomaticEventAudit(storePath)).resolves.toEqual({
        status: "failed",
        failure_stage: "schema",
        code: "EVENT_SCHEMA_INVALID",
        reason: "One or more stored events failed schema validation.",
        event_count: 1,
        record_count: 0,
        snapshot_status: "not_checked"
      });
    });
  });

  it("classifies a default reader failure as EVENT_READ_FAILED", async () => {
    await withTempStore(async (storePath) => {
      await expect(runAutomaticEventAudit(storePath)).resolves.toEqual({
        status: "failed",
        failure_stage: "read_events",
        code: "EVENT_READ_FAILED",
        reason: "Stored events could not be read for integrity verification.",
        event_count: 0,
        record_count: 0,
        snapshot_status: "not_checked"
      });
    });
  });

  it("fails closed when schema-valid history references a missing record", async () => {
    const result = await runAutomaticEventAudit("unused", {
      with_store_state_lease: withoutStoreLease,
      read_events: async () => [
        {
          event_id: "evt_missing_target",
          op: "archive_record",
          record_id: "rec_missing",
          created_at: "2026-07-24T00:00:00.000Z",
          source: { client: "test" }
        }
      ]
    });

    expect(result).toEqual({
      status: "failed",
      failure_stage: "replay",
      code: "EVENT_REPLAY_INVALID",
      reason: "Stored event history could not be replayed safely.",
      event_count: 1,
      record_count: 0,
      snapshot_status: "not_checked"
    });
  });

  it("holds the store lease across verification so a concurrent append cannot mix event generations", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = createEngine({
        storePath,
        now: () => "2026-07-24T00:00:00.000Z",
        id: (prefix) => `${prefix}_before_audit`
      });
      await first.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "This event is inside the audited generation." },
        source: { client: "test" }
      });
      await rm(join(storePath, "state", "event-audit-proof.json"), { force: true });

      let signalAuditStarted!: () => void;
      const auditStarted = new Promise<void>((resolve) => {
        signalAuditStarted = resolve;
      });
      let releaseAudit!: () => void;
      const auditRelease = new Promise<void>((resolve) => {
        releaseAudit = resolve;
      });
      const audit = runAutomaticEventAudit(storePath, {
        read_events: async (path) => {
          signalAuditStarted();
          await auditRelease;
          return readEventInputs(path);
        }
      });
      await auditStarted;

      const second = createEngine({
        storePath,
        now: () => "2026-07-24T00:01:00.000Z",
        id: (prefix) => `${prefix}_after_audit`
      });
      let appendSettled = false;
      const append = second
        .write({
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          content: { text: "This event must wait for the audited generation to finish." },
          source: { client: "test" }
        })
        .finally(() => {
          appendSettled = true;
        });

      await delay(100);
      expect(appendSettled).toBe(false);
      releaseAudit();
      await expect(audit).resolves.toMatchObject({ status: "completed", event_count: 1, record_count: 1 });
      await expect(append).resolves.toMatchObject({ record: { content: { text: expect.stringContaining("wait") } } });
    });
  });
});
