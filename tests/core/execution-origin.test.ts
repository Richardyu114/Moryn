import { describe, expect, it } from "vitest";
import {
  buildExecutionOriginContext,
  EXECUTION_ORIGIN_POLICY,
  sourceExecutionOrigin
} from "../../src/core/execution-origin.js";
import type { MorynEvent, MorynRecord, RecordSource } from "../../src/core/types.js";

function record(source: RecordSource = { client: "codex", device_id: "device-a" }): MorynRecord {
  return {
    id: "rec-origin",
    kind: "memory",
    type: "workspace_path",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: "The source checkout is /home/alice/project." },
    state: "canonical",
    confidence: 1,
    priority: "normal",
    visibility: "active",
    created_at: "2026-08-18T00:00:00.000Z",
    updated_at: "2026-08-18T00:00:00.000Z",
    source
  };
}

function upsert(source: RecordSource = { client: "codex", device_id: "device-a" }): MorynEvent {
  const value = record(source);
  return {
    event_id: "evt-upsert",
    op: "upsert_record",
    record: value,
    created_at: value.created_at,
    source
  };
}

describe("execution origin context", () => {
  it("marks another device's event and paths as remote references", () => {
    const value = record();
    const event = upsert();
    const context = buildExecutionOriginContext({
      current_device_id: "device-b",
      records: [value],
      events: [event]
    });

    expect(context.policy).toEqual(EXECUTION_ORIGIN_POLICY);
    expect(context.records_by_id[value.id]).toMatchObject({
      lineage: "remote_device_only",
      source_device_ids: ["device-a"],
      creation: {
        source_device_id: "device-a",
        relation_to_current_device: "other_device",
        occurrence: "source_device_only"
      },
      latest_mutation: { relation_to_current_device: "other_device" },
      path_resolution: "require_explicit_device_or_workspace_mapping"
    });
    expect(context.events_by_id[event.event_id]).toMatchObject({
      relation_to_current_device: "other_device",
      occurrence: "source_device_only",
      path_resolution: "require_explicit_device_or_workspace_mapping"
    });
    expect(context.summary.remote_device_only_records).toBe(1);
  });

  it("still requires existence checks for paths from the current device", () => {
    const context = buildExecutionOriginContext({
      current_device_id: "device-a",
      records: [record()],
      events: [upsert()]
    });

    expect(context.records_by_id["rec-origin"]).toMatchObject({
      lineage: "current_device_only",
      path_resolution: "verify_on_current_device"
    });
    expect(context.summary.current_device_only_records).toBe(1);
  });

  it("marks records changed on multiple devices as timeline-dependent", () => {
    const created = upsert();
    const revised: MorynEvent = {
      event_id: "evt-revise",
      op: "revise_record",
      record_id: "rec-origin",
      patch: { "content.text": "The checkout moved to C:\\work\\project." },
      created_at: "2026-08-18T01:00:00.000Z",
      source: { client: "codex", device_id: "device-b" }
    };
    const context = buildExecutionOriginContext({
      current_device_id: "device-b",
      records: [record()],
      events: [created, revised]
    });

    expect(context.records_by_id["rec-origin"]).toMatchObject({
      lineage: "multiple_devices",
      source_device_ids: ["device-a", "device-b"],
      creation: { relation_to_current_device: "other_device" },
      latest_mutation: { relation_to_current_device: "current_device" },
      path_resolution: "inspect_event_timeline_then_map"
    });
    expect(context.summary.multiple_device_records).toBe(1);
  });

  it("keeps legacy records without device provenance explicitly unknown", () => {
    const legacy = record({ client: "legacy" });
    const context = buildExecutionOriginContext({
      current_device_id: "device-b",
      records: [legacy]
    });

    expect(context.records_by_id[legacy.id]).toMatchObject({
      lineage: "unknown",
      source_device_ids: [],
      has_unknown_source: true,
      path_resolution: "verify_origin_before_access"
    });
    expect(sourceExecutionOrigin(legacy.source, "device-b")).toMatchObject({
      relation_to_current_device: "unknown",
      occurrence: "origin_unverified"
    });
  });

  it("does not expose unrelated event origins when records are bounded", () => {
    const unrelated = {
      ...upsert({ client: "claude", device_id: "device-secret" }),
      event_id: "evt-unrelated",
      record: { ...record(), id: "rec-unrelated" }
    } satisfies MorynEvent;
    const context = buildExecutionOriginContext({
      current_device_id: "device-b",
      records: [record()],
      events: [upsert(), unrelated]
    });

    expect(Object.keys(context.events_by_id)).toEqual(["evt-upsert"]);
    expect(context.events_by_id["evt-unrelated"]).toBeUndefined();
  });
});
