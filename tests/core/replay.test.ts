import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { replayEvents } from "../../src/core/replay.js";

describe("event replay", () => {
  const baseRecord = {
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
  } as const;

  function expectReplayRecoveryHint(action: () => unknown, expectedHint: Record<string, unknown>): void {
    let caught: unknown;
    try {
      action();
    } catch (error) {
      caught = error;
    }

    if (!caught) {
      throw new Error("Expected replay failure");
    }

    const envelope = toErrorEnvelope(caught);
    expect(envelope.error.code).toBe("INVALID_RECORD");
    expect(envelope.error.recommended_action).toBe("inspect the reported event or record and rebuild from valid history");
    expect(envelope.error.recovery_hint).toEqual(expect.objectContaining(expectedHint));
  }

  it("applies upsert, revise, and promote events", () => {
    const records = replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: baseRecord
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
        op: "upsert_record",
        created_at: "2026-05-27T00:02:30.000Z",
        source: { client: "test" },
        record: {
          ...baseRecord,
          id: "rec_2",
          content: { text: "Superseded", format: "text" },
          created_at: "2026-05-27T00:02:30.000Z",
          updated_at: "2026-05-27T00:02:30.000Z"
        }
      },
      {
        event_id: "evt_5",
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

  it("rejects replayed revisions that would make records invalid", () => {
    expectReplayRecoveryHint(() => replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: baseRecord
      },
      {
        event_id: "evt_2",
        op: "revise_record",
        record_id: "rec_1",
        patch: { "content.text": "" },
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ]), {
      failure: "invalid_replay_result",
      event_id: "evt_2",
      event_op: "revise_record",
      record_id: "rec_1",
      inspect: {
        event_source: "events.<device>.<month>.evt_2.json",
        rebuild_with: "moryn rebuild"
      }
    });
  });

  it("rejects replayed state events that use invalid state transitions", () => {
    const upsert = {
      event_id: "evt_1",
      op: "upsert_record",
      created_at: "2026-05-27T00:00:00.000Z",
      source: { client: "test" },
      record: baseRecord
    } as const;

    expect(() => replayEvents([
      upsert,
      {
        event_id: "evt_2",
        op: "promote_record",
        record_id: "rec_1",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ])).toThrow(/Invalid replay state transition for event evt_2/);

    expect(() => replayEvents([
      upsert,
      {
        event_id: "evt_3",
        op: "archive_record",
        record_id: "rec_1",
        target_state: "canonical",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ])).toThrow(/Invalid replay state transition for event evt_3/);

    expect(() => replayEvents([
      upsert,
      {
        event_id: "evt_4",
        op: "quarantine_record",
        record_id: "rec_1",
        target_state: "archived",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ])).toThrow(/Invalid replay state transition for event evt_4/);
  });

  it("rejects replayed mutation events that target missing records", () => {
    expectReplayRecoveryHint(() => replayEvents([
      {
        event_id: "evt_missing_revision",
        op: "revise_record",
        record_id: "rec_missing",
        patch: { "content.text": "No target exists." },
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ]), {
      failure: "missing_replay_target",
      event_id: "evt_missing_revision",
      event_op: "revise_record",
      record_id: "rec_missing",
      label: "Record",
      inspect: {
        event_source: "events.<device>.<month>.evt_missing_revision.json",
        rebuild_with: "moryn rebuild"
      }
    });

    expect(() => replayEvents([
      {
        event_id: "evt_missing_promotion",
        op: "promote_record",
        record_id: "rec_missing",
        target_state: "canonical",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ])).toThrow(/Invalid replay target for event evt_missing_promotion: Record not found: rec_missing/);

    expect(() => replayEvents([
      {
        event_id: "evt_missing_link",
        op: "link_records",
        record_id: "rec_missing",
        linked_record_id: "rec_other",
        link_type: "supersedes",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ])).toThrow(/Invalid replay target for event evt_missing_link: Record not found: rec_missing/);

    expect(() => replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: baseRecord
      },
      {
        event_id: "evt_missing_linked_record",
        op: "link_records",
        record_id: "rec_1",
        linked_record_id: "rec_missing",
        link_type: "supersedes",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      }
    ])).toThrow(/Invalid replay target for event evt_missing_linked_record: Linked record not found: rec_missing/);
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
          project_id: "moryn",
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

  it("clears replayed conflict metadata when a revision has no conflict", () => {
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
          project_id: "moryn",
          tags: ["sync"],
          content: { text: "Use SQLite as the source of truth.", format: "text" },
          state: "canonical",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" },
          conflict: {
            kind: "semantic",
            with: ["rec_existing"],
            resolution: "needs_review"
          }
        }
      },
      {
        event_id: "evt_2",
        op: "revise_record",
        record_id: "rec_1",
        patch: { "content.text": "Use append-only JSON events." },
        reason: "Resolved conflict",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "cli" }
      }
    ]);

    expect(records.get("rec_1")?.content.text).toBe("Use append-only JSON events.");
    expect(records.get("rec_1")?.conflict).toBeUndefined();
  });
});
