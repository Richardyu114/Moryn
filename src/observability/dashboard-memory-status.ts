import { type ActiveLogicalMemoryView, buildActiveLogicalMemoryView } from "../core/logical-memory.js";
import type { MorynRecord } from "../core/types.js";

export type DashboardOrganizationRelationship = ActiveLogicalMemoryView["hidden_by_record_id"][string]["relationship"];

export interface DashboardOrganizationOlderRecord {
  record: MorynRecord;
  relationship: DashboardOrganizationRelationship;
}

export interface DashboardOrganizationGroup {
  active_record_id: string;
  current_record: MorynRecord;
  older_records: DashboardOrganizationOlderRecord[];
}

export interface DashboardMemoryStatus {
  scoped_records: MorynRecord[];
  usable_records: MorynRecord[];
  history_records: MorynRecord[];
  quarantined_records: MorynRecord[];
  logical_active_records: MorynRecord[];
  logical_hidden_by_record_id: ActiveLogicalMemoryView["hidden_by_record_id"];
  logical_conflict_record_ids: string[];
  absorbed_learning_records: MorynRecord[];
  pending_learning_inbox_records: MorynRecord[];
  organization_groups: DashboardOrganizationGroup[];
}

function belongsToDashboardScope(record: MorynRecord, projectId: string | undefined): boolean {
  return projectId === undefined || record.scope === "global" || record.project_id === projectId;
}

function isQuarantined(record: MorynRecord): boolean {
  return record.visibility === "quarantined" || record.state === "quarantined";
}

function isHistory(record: MorynRecord): boolean {
  return !isQuarantined(record) && (record.visibility === "archived" || record.state === "archived");
}

function isUsable(record: MorynRecord): boolean {
  return record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined";
}

function isLearningInbox(record: MorynRecord): boolean {
  return record.kind === "agent_note" && record.type === "learning_inbox";
}

function compareRecordsNewestFirst(left: MorynRecord, right: MorynRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function buildOrganizationGroups(
  usableRecords: MorynRecord[],
  hiddenByRecordId: ActiveLogicalMemoryView["hidden_by_record_id"]
): DashboardOrganizationGroup[] {
  const recordsById = new Map(usableRecords.map((record) => [record.id, record]));
  const groupsByActiveId = new Map<string, DashboardOrganizationGroup>();

  for (const [olderRecordId, hidden] of Object.entries(hiddenByRecordId)) {
    const currentRecord = recordsById.get(hidden.active_record_id);
    const olderRecord = recordsById.get(olderRecordId);
    if (!currentRecord || !olderRecord) continue;

    const group = groupsByActiveId.get(hidden.active_record_id) ?? {
      active_record_id: hidden.active_record_id,
      current_record: currentRecord,
      older_records: []
    };
    group.older_records.push({ record: olderRecord, relationship: hidden.relationship });
    groupsByActiveId.set(hidden.active_record_id, group);
  }

  return [...groupsByActiveId.values()]
    .map((group) => ({
      ...group,
      older_records: [...group.older_records].sort((left, right) =>
        compareRecordsNewestFirst(left.record, right.record)
      )
    }))
    .sort((left, right) => compareRecordsNewestFirst(left.current_record, right.current_record));
}

/**
 * Builds the content-bearing memory status used by the human Dashboard.
 *
 * Callers must apply the Dashboard privacy boundary before invoking this
 * helper. This function only applies project, lifecycle, logical-memory, and
 * learning-inbox semantics and returns the original record references for a
 * later safe presentation projection.
 */
export function buildDashboardMemoryStatus(
  privacyFilteredRecords: readonly MorynRecord[],
  projectId?: string
): DashboardMemoryStatus {
  const scopedRecords = privacyFilteredRecords.filter((record) => belongsToDashboardScope(record, projectId));
  const quarantinedRecords = scopedRecords.filter(isQuarantined);
  const historyRecords = scopedRecords.filter(isHistory);
  const usableRecords = scopedRecords.filter(isUsable);
  const logicalView = buildActiveLogicalMemoryView(usableRecords);
  const logicalActiveRecords = logicalView.active_records;

  return {
    scoped_records: scopedRecords,
    usable_records: usableRecords,
    history_records: historyRecords,
    quarantined_records: quarantinedRecords,
    logical_active_records: logicalActiveRecords,
    logical_hidden_by_record_id: logicalView.hidden_by_record_id,
    logical_conflict_record_ids: logicalView.conflict_record_ids,
    absorbed_learning_records: logicalActiveRecords.filter(
      (record) => record.tags.includes("learning") && !isLearningInbox(record)
    ),
    pending_learning_inbox_records: logicalActiveRecords.filter(
      (record) => isLearningInbox(record) && record.content.status === "pending"
    ),
    organization_groups: buildOrganizationGroups(usableRecords, logicalView.hidden_by_record_id)
  };
}
