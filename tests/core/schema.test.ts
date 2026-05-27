import { describe, expect, it } from "vitest";
import { parseEvent, parseRecord } from "../../src/core/schema.js";

describe("record schema", () => {
  const validRecord = {
    id: "rec_test",
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "memora",
    tags: ["sync"],
    content: { text: "Use append-only events.", format: "text" },
    state: "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-05-27T00:00:00.000Z",
    updated_at: "2026-05-27T00:00:00.000Z",
    source: { client: "codex", session_id: "sess_1", model: "gpt-5" }
  };

  it("accepts a valid memory record", () => {
    const record = parseRecord(validRecord);

    expect(record.kind).toBe("memory");
  });

  it("rejects invalid state values", () => {
    expect(() =>
      parseRecord({
        id: "rec_test",
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Bad state", format: "text" },
        state: "published",
        source: { client: "codex" }
      })
    ).toThrow(/Invalid record/);
  });

  it("rejects empty record content text", () => {
    expect(() =>
      parseRecord({
        ...validRecord,
        content: { text: "", format: "text" }
      })
    ).toThrow(/Invalid record/);
  });

  it("rejects empty record metadata strings", () => {
    expect(() => parseRecord({ ...validRecord, tags: [""] })).toThrow(/Invalid record/);
    expect(() => parseRecord({
      ...validRecord,
      provenance: { derived_from: ["rec_source", ""] }
    })).toThrow(/Invalid record/);
    expect(() => parseRecord({
      ...validRecord,
      provenance: { reason: "" }
    })).toThrow(/Invalid record/);
  });

  it("rejects empty mutation event reasons", () => {
    const baseEvent = {
      event_id: "evt_test",
      op: "revise_record",
      record_id: "rec_test",
      patch: { "content.text": "Updated text." },
      created_at: "2026-05-27T00:01:00.000Z",
      source: { client: "codex" }
    };

    expect(() => parseEvent({ ...baseEvent, reason: "" })).toThrow(/Invalid event/);
    expect(() => parseEvent({
      event_id: "evt_promote",
      op: "promote_record",
      record_id: "rec_test",
      target_state: "canonical",
      reason: "",
      created_at: "2026-05-27T00:01:00.000Z",
      source: { client: "codex" }
    })).toThrow(/Invalid event/);
  });

  it("rejects empty revision event patches", () => {
    expect(() => parseEvent({
      event_id: "evt_empty_patch",
      op: "revise_record",
      record_id: "rec_test",
      patch: {},
      created_at: "2026-05-27T00:01:00.000Z",
      source: { client: "codex" }
    })).toThrow(/Invalid event/);
  });

  it("rejects invalid state mutation event shapes", () => {
    expect(() => parseEvent({
      event_id: "evt_missing_target",
      op: "promote_record",
      record_id: "rec_test",
      created_at: "2026-05-27T00:01:00.000Z",
      source: { client: "codex" }
    })).toThrow(/Invalid event/);

    expect(() => parseEvent({
      event_id: "evt_archive_target",
      op: "archive_record",
      record_id: "rec_test",
      target_state: "canonical",
      created_at: "2026-05-27T00:01:00.000Z",
      source: { client: "codex" }
    })).toThrow(/Invalid event/);

    expect(() => parseEvent({
      event_id: "evt_quarantine_target",
      op: "quarantine_record",
      record_id: "rec_test",
      target_state: "archived",
      created_at: "2026-05-27T00:01:00.000Z",
      source: { client: "codex" }
    })).toThrow(/Invalid event/);
  });
});
