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
      },
      {
        event_id: "evt_4",
        op: "link_records",
        record_id: "rec_1",
        linked_record_id: "rec_2",
        link_type: "supersedes",
        created_at: "2026-05-27T00:03:00.000Z",
        source: { client: "test" }
      }
    ]);

    const record = records.get("rec_1");
    expect(record?.content.text).toBe("New");
    expect(record?.confidence).toBe(0.9);
    expect(record?.state).toBe("canonical");
    expect(record?.links).toEqual([
      {
        record_id: "rec_2",
        link_type: "supersedes",
        created_at: "2026-05-27T00:03:00.000Z"
      }
    ]);
  });

  it("treats confirmed canonical promotion as user-confirmed provenance", () => {
    const records = replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "codex" },
        record: {
          id: "rec_1",
          kind: "soul",
          type: "preference",
          scope: "global",
          tags: [],
          content: { text: "Prefer concise answers.", format: "text" },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "codex" }
        }
      },
      {
        event_id: "evt_2",
        op: "promote_record",
        record_id: "rec_1",
        target_state: "canonical",
        reason: "User confirmed",
        confirmed: true,
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "cli" }
      }
    ]);

    expect(records.get("rec_1")?.provenance).toEqual({
      reason: "User confirmed",
      method: "user-confirmed",
      promoted_at: "2026-05-27T00:01:00.000Z"
    });
  });

  it("replays conflict metadata from confirmed revisions", () => {
    const records = replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_1",
          kind: "memory",
          type: "warning",
          scope: "project",
          project_id: "memora",
          tags: ["sync"],
          content: { text: "Use private Git remotes.", format: "text" },
          state: "canonical",
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
        patch: {
          type: "decision",
          "content.text": "Use SQLite as the source of truth."
        },
        reason: "User confirmed",
        confirmed: true,
        conflict: {
          kind: "semantic",
          with: ["rec_existing"],
          resolution: "needs_review"
        },
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "cli" }
      }
    ]);

    expect(records.get("rec_1")?.type).toBe("decision");
    expect(records.get("rec_1")?.content.text).toBe("Use SQLite as the source of truth.");
    expect(records.get("rec_1")?.conflict).toEqual({
      kind: "semantic",
      with: ["rec_existing"],
      resolution: "needs_review"
    });
  });
});
