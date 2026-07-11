import { createEngine } from "./engine.js";
import { buildActiveLogicalMemoryView } from "./logical-memory.js";
import { replayEvents } from "./replay.js";
import { isPrivateTags } from "./sensitive.js";
import { readEvents } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export interface WorkingSetReportOptions {
  project_id?: string;
  current_task?: string;
  include_private?: boolean;
}

export const WORKING_SET_REPORT_SELECTION_SOURCES = {
  total_events: "store.events",
  total_records: "store.records",
  active_logical_records: "logical_memory.active_records",
  hidden_duplicate_records: "logical_memory.hidden_by_record_id.duplicate_of",
  hidden_superseded_records: "logical_memory.hidden_by_record_id.supersedes",
  hidden_revised_records: "logical_memory.hidden_by_record_id.revises",
  conflict_records: "logical_memory.conflict_record_ids",
  cycle_findings: "logical_memory.findings",
  default_boot_records: "boot.records_by_id",
  compaction_ratio: "logical_memory.hidden_records/store.records"
} as const;

export interface WorkingSetSummaryOptions {
  default_boot_records?: number;
  excluded_private_records?: number;
}

function eventRecordIds(event: MorynEvent): string[] {
  if (event.op === "upsert_record") return [event.record.id];
  if (event.op === "link_records") return [event.record_id, event.linked_record_id];
  return [event.record_id];
}

export function summarizeWorkingSet(records: MorynRecord[], events: MorynEvent[], options: WorkingSetSummaryOptions = {}) {
  const logicalView = buildActiveLogicalMemoryView(records);
  const hiddenRelationships = Object.values(logicalView.hidden_by_record_id);
  const hiddenRecords = hiddenRelationships.length;

  return {
    total_events: events.length,
    total_records: records.length,
    active_logical_records: logicalView.active_records.length,
    hidden_duplicate_records: hiddenRelationships.filter((item) => item.relationship === "duplicate_of").length,
    hidden_superseded_records: hiddenRelationships.filter((item) => item.relationship === "supersedes").length,
    hidden_revised_records: hiddenRelationships.filter((item) => item.relationship === "revises").length,
    conflict_records: logicalView.conflict_record_ids.length,
    cycle_findings: logicalView.findings.length,
    ...(options.default_boot_records !== undefined ? { default_boot_records: options.default_boot_records } : {}),
    compaction_ratio: records.length === 0 ? 0 : Number((hiddenRecords / records.length).toFixed(4)),
    excluded_private_records: options.excluded_private_records ?? 0,
    selection_sources: WORKING_SET_REPORT_SELECTION_SOURCES
  };
}

export async function buildWorkingSetReport(storePath: string, options: WorkingSetReportOptions = {}) {
  const events = await readEvents(storePath);
  const allRecords = [...replayEvents(events).values()];
  const excludedPrivateRecords = options.include_private === true ? 0 : allRecords.filter((record) => isPrivateTags(record.tags)).length;
  const records = options.include_private === true ? allRecords : allRecords.filter((record) => !isPrivateTags(record.tags));
  const visibleRecordIds = new Set(records.map((record) => record.id));
  const visibleEvents = events.filter((event) => eventRecordIds(event).every((recordId) => visibleRecordIds.has(recordId)));
  const boot = await createEngine({ storePath }).boot({ project_id: options.project_id, current_task: options.current_task, include_private: options.include_private === true });
  return summarizeWorkingSet(records, visibleEvents, {
    default_boot_records: Object.keys(boot.records_by_id).length,
    excluded_private_records: excludedPrivateRecords
  });
}
