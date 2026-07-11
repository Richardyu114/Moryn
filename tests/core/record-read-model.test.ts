import { describe, expect, it } from "vitest";
import { buildRecordReadModel, eventManifest } from "../../src/core/record-read-model.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";

function record(id: string): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: id, format: "text" },
    state: "canonical",
    confidence: 1,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    source: { client: "test" }
  };
}

function event(eventId: string, value: MorynRecord, createdAt = "2026-07-12T00:00:00.000Z"): MorynEvent {
  return { event_id: eventId, op: "upsert_record", record: value, created_at: createdAt, source: { client: "test" } };
}

describe("record read model", () => {
  it("builds deterministic manifests independent of input order", () => {
    const first = event("evt-b", record("rec-b"));
    const second = event("evt-a", record("rec-a"));
    expect(eventManifest([first, second])).toEqual(eventManifest([second, first]));
    expect(eventManifest([first, second])).toMatchObject({ count: 2, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("stores complete records in deterministic order", () => {
    const first = record("rec-b");
    const second = record("rec-a");
    second.links = [{ record_id: first.id, link_type: "duplicate_of", created_at: "2026-07-12T00:01:00.000Z" }];
    const model = buildRecordReadModel([event("evt-b", first), event("evt-a", second)], [first, second]);
    expect(model).toMatchObject({ version: 1, generated_at: "2026-07-12T00:00:00.000Z", records: [{ id: "rec-a", links: second.links }, { id: "rec-b" }] });
  });
});
