import { describe, expect, it } from "vitest";
import { readSyncCompensationReceipt, assessSyncCompensation, writeSyncCompensationReceipt } from "../../src/core/sync-compensation.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";

function continuityRecord(id: string, projectId = "moryn", type = "checkpoint"): MorynRecord {
  return { id, kind: "session_summary", type, scope: "project", project_id: projectId, tags: [], content: { text: id, format: "text" }, state: "candidate", confidence: 0.5, priority: "normal", visibility: "active", created_at: "2026-07-12T00:00:00.000Z", updated_at: "2026-07-12T00:00:00.000Z", source: { client: "codex", session_id: "session" } };
}

function upsert(record: MorynRecord): MorynEvent {
  return { event_id: `evt-${record.id}`, op: "upsert_record", record, created_at: record.created_at, source: record.source };
}

describe("sync compensation", () => {
  it("allows one safe compensation push for current-project continuity events", () => {
    expect(assessSyncCompensation({ project_id: "moryn", status: { configured: true, remote: "origin", sync_state: "dirty", ahead: 0, behind: 0 }, pending_paths: ["events/2026/07/evt.jsonl"], pending_events: [upsert(continuityRecord("rec-checkpoint"))] })).toEqual({ decision: "safe_to_push", reason: "pending_continuity_events", pending_paths: ["events/2026/07/evt.jsonl"], continuity_record_ids: ["rec-checkpoint"] });
  });

  it("skips pending event writes that do not carry continuity state", () => {
    const memory = { ...continuityRecord("rec-memory"), kind: "memory" as const, type: "fact" };
    expect(assessSyncCompensation({ project_id: "moryn", status: { configured: true, remote: "origin", sync_state: "dirty", ahead: 0, behind: 0 }, pending_paths: ["events/a.jsonl"], pending_events: [upsert(memory)] })).toMatchObject({ decision: "not_needed", reason: "no_pending_continuity_events" });
  });

  it.each([
    [{ configured: true, remote: "origin", sync_state: "clean", ahead: 0, behind: 1 }, ["events/a.jsonl"], "remote_updates_pending"],
    [{ configured: true, remote: "origin", sync_state: "conflict", ahead: 0, behind: 0 }, ["events/a.jsonl"], "sync_conflict"],
    [{ configured: true, remote: "origin", sync_state: "dirty", ahead: 0, behind: 0 }, ["events/a.jsonl", "notes.txt"], "unowned_pending_paths"]
  ] as const)("blocks unsafe compensation", (status, pendingPaths, reason) => {
    expect(assessSyncCompensation({ project_id: "moryn", status, pending_paths: [...pendingPaths], pending_events: [upsert(continuityRecord("rec-checkpoint"))] })).toMatchObject({ decision: "blocked", reason });
  });

  it("does not compensate a Git repository without a sync remote", () => {
    expect(assessSyncCompensation({ project_id: "moryn", status: { configured: true, sync_state: "dirty", ahead: 0, behind: 0 }, pending_paths: ["events/a.jsonl"], pending_events: [upsert(continuityRecord("rec-checkpoint"))] })).toMatchObject({ decision: "not_needed", reason: "sync_not_configured" });
  });

  it("persists the latest compensation outcome as local-only evidence", async () => {
    const storePath = `/tmp/moryn-compensation-receipt-${process.pid}-${Date.now()}`;
    try {
      await writeSyncCompensationReceipt(storePath, { occurred_at: "2026-07-12T00:00:00.000Z", project_id: "moryn", decision: "pushed", reason: "pending_continuity_events", pending_paths: ["events/a.json"], continuity_record_ids: ["rec-checkpoint"] });
      expect(await readSyncCompensationReceipt(storePath)).toEqual({ version: 1, occurred_at: "2026-07-12T00:00:00.000Z", project_id: "moryn", decision: "pushed", reason: "pending_continuity_events", pending_paths: ["events/a.json"], continuity_record_ids: ["rec-checkpoint"] });
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(storePath, { recursive: true, force: true });
    }
  });
});
