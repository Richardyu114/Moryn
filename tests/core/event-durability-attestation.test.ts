import { describe, expect, it } from "vitest";
import {
  assertEventDurabilityAttestation,
  createEventDurabilityAttestation,
  mergeEventDurabilityAttestations
} from "../../src/core/event-durability-attestation.js";
import type { AppendEventIfAbsentResult, EventDurability } from "../../src/core/store.js";

function appendResult(eventId: string, created: boolean, durability: EventDurability): AppendEventIfAbsentResult {
  return {
    created,
    event: {
      event_id: eventId,
      op: "archive_record",
      record_id: `record-${eventId}`,
      reason: "test",
      created_at: "2026-07-20T00:00:00.000Z",
      source: { client: "test", device_id: "device-a" }
    },
    path: `/store/events/${eventId}.json`,
    durability
  };
}

describe("event durability attestation", () => {
  it("partitions confirmed, best-effort, and existing readback events in event order", () => {
    const attestation = createEventDurabilityAttestation({
      event_ids: ["evt-a", "evt-b", "evt-c"],
      append_results: [
        appendResult("evt-a", true, "confirmed"),
        appendResult("evt-b", true, "best_effort"),
        appendResult("evt-c", false, "best_effort")
      ]
    });

    expect(attestation).toEqual({
      confirmed_event_ids: ["evt-a"],
      best_effort_event_ids: ["evt-b"],
      existing_readback_event_ids: ["evt-c"],
      all_events_read_back: true
    });
  });

  it("rejects overlap, missing coverage, and partition reordering", () => {
    expect(() =>
      assertEventDurabilityAttestation(
        {
          confirmed_event_ids: ["evt-a"],
          best_effort_event_ids: ["evt-a"],
          existing_readback_event_ids: ["evt-b"],
          all_events_read_back: true
        },
        ["evt-a", "evt-b"],
        "test"
      )
    ).toThrow("overlap");
    expect(() =>
      assertEventDurabilityAttestation(
        {
          confirmed_event_ids: ["evt-a"],
          best_effort_event_ids: [],
          existing_readback_event_ids: [],
          all_events_read_back: true
        },
        ["evt-a", "evt-b"],
        "test"
      )
    ).toThrow("coverage");
    expect(() =>
      assertEventDurabilityAttestation(
        {
          confirmed_event_ids: ["evt-b", "evt-a"],
          best_effort_event_ids: [],
          existing_readback_event_ids: [],
          all_events_read_back: true
        },
        ["evt-a", "evt-b"],
        "test"
      )
    ).toThrow("order");
  });

  it("merges child attestations into one exact parent partition", () => {
    const first = createEventDurabilityAttestation({
      event_ids: ["evt-a", "evt-b"],
      append_results: [appendResult("evt-a", true, "confirmed")]
    });
    const second = createEventDurabilityAttestation({
      event_ids: ["evt-c"],
      append_results: [appendResult("evt-c", true, "best_effort")]
    });

    expect(mergeEventDurabilityAttestations(["evt-a", "evt-b", "evt-c"], [first, second])).toEqual({
      confirmed_event_ids: ["evt-a"],
      best_effort_event_ids: ["evt-c"],
      existing_readback_event_ids: ["evt-b"],
      all_events_read_back: true
    });
  });
});
