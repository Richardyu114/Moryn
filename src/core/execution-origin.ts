import { createStringKeyedRecord } from "./string-keyed-record.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export const EXECUTION_ORIGIN_VERSION = 1 as const;

export const EXECUTION_ORIGIN_POLICY = {
  event_occurrence: "source_device_is_authoritative",
  filesystem_paths: "source_device_scoped",
  remote_path_resolution: "explicit_mapping_required",
  local_path_resolution: "verify_before_access",
  reader_inference: "never_treat_store_presence_as_local_execution"
} as const;

export type SourceDeviceRelation = "current_device" | "other_device" | "unknown";
export type RecordDeviceLineage = "current_device_only" | "remote_device_only" | "multiple_devices" | "unknown";
export type PathResolutionAction =
  | "verify_on_current_device"
  | "require_explicit_device_or_workspace_mapping"
  | "inspect_event_timeline_then_map"
  | "verify_origin_before_access";

export interface SourceExecutionOrigin {
  source_device_id?: string;
  relation_to_current_device: SourceDeviceRelation;
  occurrence: "current_device" | "source_device_only" | "origin_unverified";
}

export interface EventExecutionOrigin extends SourceExecutionOrigin {
  event_id: string;
  path_resolution: PathResolutionAction;
}

export interface RecordExecutionOrigin {
  record_id: string;
  lineage: RecordDeviceLineage;
  source_device_ids: string[];
  has_unknown_source: boolean;
  creation: SourceExecutionOrigin;
  latest_mutation: SourceExecutionOrigin;
  path_resolution: PathResolutionAction;
}

export interface ExecutionOriginContext {
  version: typeof EXECUTION_ORIGIN_VERSION;
  current_device: { device_id?: string };
  policy: typeof EXECUTION_ORIGIN_POLICY;
  summary: {
    current_device_only_records: number;
    remote_device_only_records: number;
    multiple_device_records: number;
    unknown_origin_records: number;
  };
  records_by_id: Record<string, RecordExecutionOrigin>;
  events_by_id: Record<string, EventExecutionOrigin>;
  selection_sources: {
    current_device_id: "current_device.device_id";
    record_origin: "records_by_id.<record_id>";
    event_origin: "events_by_id.<event_id>";
  };
}

function normalizedDeviceId(source: RecordSource | undefined): string | undefined {
  const value = source?.device_id?.trim();
  return value || undefined;
}

function relationToCurrent(
  sourceDeviceId: string | undefined,
  currentDeviceId: string | undefined
): SourceDeviceRelation {
  if (!sourceDeviceId || !currentDeviceId) return "unknown";
  return sourceDeviceId === currentDeviceId ? "current_device" : "other_device";
}

export function sourceExecutionOrigin(
  source: RecordSource | undefined,
  currentDeviceId: string | undefined
): SourceExecutionOrigin {
  const sourceDeviceId = normalizedDeviceId(source);
  const relation = relationToCurrent(sourceDeviceId, currentDeviceId);
  return {
    ...(sourceDeviceId ? { source_device_id: sourceDeviceId } : {}),
    relation_to_current_device: relation,
    occurrence:
      relation === "current_device"
        ? "current_device"
        : relation === "other_device"
          ? "source_device_only"
          : "origin_unverified"
  };
}

function pathResolution(lineage: RecordDeviceLineage): PathResolutionAction {
  if (lineage === "current_device_only") return "verify_on_current_device";
  if (lineage === "remote_device_only") return "require_explicit_device_or_workspace_mapping";
  if (lineage === "multiple_devices") return "inspect_event_timeline_then_map";
  return "verify_origin_before_access";
}

function eventPathResolution(origin: SourceExecutionOrigin): PathResolutionAction {
  if (origin.relation_to_current_device === "current_device") return "verify_on_current_device";
  if (origin.relation_to_current_device === "other_device") return "require_explicit_device_or_workspace_mapping";
  return "verify_origin_before_access";
}

function recordIdsFromEvent(event: MorynEvent): string[] {
  if (event.op === "upsert_record") return [event.record.id];
  if (event.op === "link_records") return [event.record_id, event.linked_record_id];
  return [event.record_id];
}

function compareEvents(left: MorynEvent, right: MorynEvent): number {
  return left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id);
}

function recordLineage(
  record: MorynRecord,
  events: readonly MorynEvent[],
  currentDeviceId: string | undefined
): RecordExecutionOrigin {
  const orderedEvents = [...events].sort(compareEvents);
  const lineageSources = orderedEvents.length ? orderedEvents.map((event) => event.source) : [record.source];
  const sourceDeviceIds = [
    ...new Set(lineageSources.map(normalizedDeviceId).filter((value): value is string => Boolean(value)))
  ].sort();
  const hasUnknownSource = lineageSources.some((source) => !normalizedDeviceId(source));
  let lineage: RecordDeviceLineage;
  if (!currentDeviceId || hasUnknownSource || sourceDeviceIds.length === 0) lineage = "unknown";
  else if (sourceDeviceIds.length > 1) lineage = "multiple_devices";
  else lineage = sourceDeviceIds[0] === currentDeviceId ? "current_device_only" : "remote_device_only";
  const creationSource = orderedEvents[0]?.source ?? record.source;
  const latestSource = orderedEvents.at(-1)?.source ?? record.source;
  return {
    record_id: record.id,
    lineage,
    source_device_ids: sourceDeviceIds,
    has_unknown_source: hasUnknownSource,
    creation: sourceExecutionOrigin(creationSource, currentDeviceId),
    latest_mutation: sourceExecutionOrigin(latestSource, currentDeviceId),
    path_resolution: pathResolution(lineage)
  };
}

export function buildExecutionOriginContext(input: {
  current_device_id?: string;
  records?: readonly MorynRecord[];
  events?: readonly MorynEvent[];
}): ExecutionOriginContext {
  const currentDeviceId = input.current_device_id?.trim() || undefined;
  const records = [...(input.records ?? [])];
  const events = [...(input.events ?? [])];
  const selectedRecordIds = new Set(records.map((record) => record.id));
  const relevantEvents =
    selectedRecordIds.size === 0
      ? events
      : events.filter((event) => recordIdsFromEvent(event).some((recordId) => selectedRecordIds.has(recordId)));
  const eventsByRecordId = new Map<string, MorynEvent[]>();
  for (const event of relevantEvents) {
    for (const recordId of recordIdsFromEvent(event)) {
      if (!selectedRecordIds.has(recordId)) continue;
      const lineage = eventsByRecordId.get(recordId) ?? [];
      lineage.push(event);
      eventsByRecordId.set(recordId, lineage);
    }
  }

  const recordsById = createStringKeyedRecord<RecordExecutionOrigin>();
  for (const record of records) {
    recordsById[record.id] = recordLineage(record, eventsByRecordId.get(record.id) ?? [], currentDeviceId);
  }
  const eventsById = createStringKeyedRecord<EventExecutionOrigin>();
  for (const event of relevantEvents) {
    const origin = sourceExecutionOrigin(event.source, currentDeviceId);
    eventsById[event.event_id] = {
      event_id: event.event_id,
      ...origin,
      path_resolution: eventPathResolution(origin)
    };
  }
  const recordOrigins = Object.values(recordsById);
  return {
    version: EXECUTION_ORIGIN_VERSION,
    current_device: { ...(currentDeviceId ? { device_id: currentDeviceId } : {}) },
    policy: EXECUTION_ORIGIN_POLICY,
    summary: {
      current_device_only_records: recordOrigins.filter((origin) => origin.lineage === "current_device_only").length,
      remote_device_only_records: recordOrigins.filter((origin) => origin.lineage === "remote_device_only").length,
      multiple_device_records: recordOrigins.filter((origin) => origin.lineage === "multiple_devices").length,
      unknown_origin_records: recordOrigins.filter((origin) => origin.lineage === "unknown").length
    },
    records_by_id: recordsById,
    events_by_id: eventsById,
    selection_sources: {
      current_device_id: "current_device.device_id",
      record_origin: "records_by_id.<record_id>",
      event_origin: "events_by_id.<event_id>"
    }
  };
}
