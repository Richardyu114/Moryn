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
  compaction_ratio: "logical_memory.hidden_records/store.records",
  semantic_equivalent_links: "store.events.link_records.duplicate_of",
  semantic_revision_links: "store.events.link_records.revises",
  semantic_superseded_links: "store.events.link_records.supersedes",
  semantic_conflict_links: "store.events.link_records.conflicts_with",
  semantic_rejected_proposals: "checkpoint.semantic_consolidation_proposals - store.events.semantic_links"
} as const;

export interface WorkingSetSummaryOptions {
  default_boot_records?: number;
  excluded_private_records?: number;
  excluded_private_record_ids?: string[];
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
  const semanticLinks = events.filter((event) => event.op === "link_records" && event.event_id.startsWith("evt_semantic_consolidation_"));
  const semanticLinkKeys = new Set(semanticLinks.map((event) => event.op === "link_records" ? `${event.record_id}\u0000${event.linked_record_id}\u0000${event.link_type}` : ""));
  const excludedPrivateRecordIds = new Set(options.excluded_private_record_ids ?? []);
  const semanticRejectedProposals = records.flatMap((record) => {
    const checkpoint = record.content.checkpoint;
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return [];
    const proposals = (checkpoint as Record<string, unknown>).semantic_consolidation_proposals;
    return Array.isArray(proposals) ? proposals.filter((proposal): proposal is Record<string, unknown> => Boolean(proposal && typeof proposal === "object" && !Array.isArray(proposal))) : [];
  }).filter((proposal) => !excludedPrivateRecordIds.has(String(proposal.source_record_id)) && !excludedPrivateRecordIds.has(String(proposal.target_record_id)))
    .filter((proposal) => !semanticLinkKeys.has(`${proposal.source_record_id}\u0000${proposal.target_record_id}\u0000${proposal.relationship}`)).length;

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
    semantic_equivalent_links: semanticLinks.filter((event) => event.op === "link_records" && event.link_type === "duplicate_of").length,
    semantic_revision_links: semanticLinks.filter((event) => event.op === "link_records" && event.link_type === "revises").length,
    semantic_superseded_links: semanticLinks.filter((event) => event.op === "link_records" && event.link_type === "supersedes").length,
    semantic_conflict_links: semanticLinks.filter((event) => event.op === "link_records" && event.link_type === "conflicts_with").length,
    semantic_rejected_proposals: semanticRejectedProposals,
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
    excluded_private_records: excludedPrivateRecords,
    excluded_private_record_ids: options.include_private === true ? [] : allRecords.filter((record) => isPrivateTags(record.tags)).map((record) => record.id)
  });
}
