import { createHash } from "node:crypto";
import type { MorynRecord, RecordPriority, RecordState } from "./types.js";

export const LOGICAL_RELATIONSHIP_TYPES = [
  "duplicate_of",
  "supports",
  "revises",
  "supersedes",
  "conflicts_with"
] as const;

export type LogicalRelationshipType = (typeof LOGICAL_RELATIONSHIP_TYPES)[number];

export interface LogicalRelationshipInput {
  record_id: string;
  linked_record_id: string;
  relationship: LogicalRelationshipType;
  reason: string;
}

export interface ValidatedLogicalRelationship {
  record: MorynRecord;
  linked_record: MorynRecord;
  relationship: LogicalRelationshipType;
  direction: "directed" | "symmetric";
  reason: string;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const stateTrustRank: Record<RecordState, number> = {
  canonical: 3,
  candidate: 2,
  raw: 1,
  archived: 0,
  quarantined: 0
};

const priorityRank: Record<RecordPriority, number> = { high: 3, normal: 2, low: 1 };

export function compareLogicalMemoryTargets(left: MorynRecord, right: MorynRecord): number {
  return (
    stateTrustRank[right.state] - stateTrustRank[left.state] ||
    priorityRank[right.priority] - priorityRank[left.priority] ||
    compareCodeUnits(right.updated_at, left.updated_at) ||
    compareCodeUnits(left.id, right.id)
  );
}

function normalizeContentValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    return key === "text" ? value.trim().replace(/\s+/g, " ") : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeContentValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([entryKey, item]) => [entryKey, normalizeContentValue(item, entryKey)])
    );
  }
  return value;
}

export function logicalMemoryFingerprint(record: MorynRecord): string {
  const logicalIdentity = {
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    project_id: record.project_id ?? null,
    tags: [...new Set(record.tags)].sort(compareCodeUnits),
    content: normalizeContentValue(record.content)
  };
  return createHash("sha256").update(JSON.stringify(logicalIdentity)).digest("hex");
}

function requireRecord(records: MorynRecord[], recordId: string): MorynRecord {
  const record = records.find((candidate) => candidate.id === recordId);
  if (!record) throw new Error(`Logical memory record not found: ${recordId}`);
  return record;
}

function isActive(record: MorynRecord): boolean {
  return record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined";
}

function sameLogicalDomain(record: MorynRecord, linkedRecord: MorynRecord): boolean {
  return (
    record.kind === linkedRecord.kind &&
    record.type === linkedRecord.type &&
    record.scope === linkedRecord.scope &&
    record.project_id === linkedRecord.project_id
  );
}

export function validateLogicalRelationship(
  records: MorynRecord[],
  input: LogicalRelationshipInput
): ValidatedLogicalRelationship {
  if (!LOGICAL_RELATIONSHIP_TYPES.includes(input.relationship)) {
    throw new Error(`Invalid argument: unsupported logical relationship: ${String(input.relationship)}`);
  }
  if (input.record_id === input.linked_record_id) {
    throw new Error("Invalid argument: logical memory records must be different");
  }
  if (typeof input.reason !== "string" || !input.reason.trim()) {
    throw new Error("Invalid argument: logical relationship reason must be a non-empty string");
  }
  const record = requireRecord(records, input.record_id);
  const linkedRecord = requireRecord(records, input.linked_record_id);
  if (!isActive(record) || !isActive(linkedRecord)) {
    throw new Error("Invalid argument: logical memory records must be active");
  }
  if (!sameLogicalDomain(record, linkedRecord)) {
    throw new Error("Invalid argument: incompatible logical memory records");
  }
  return {
    record,
    linked_record: linkedRecord,
    relationship: input.relationship,
    direction: input.relationship === "conflicts_with" ? "symmetric" : "directed",
    reason: input.reason.trim()
  };
}

export interface ActiveLogicalMemoryView {
  active_records: MorynRecord[];
  hidden_by_record_id: Record<
    string,
    { relationship: "duplicate_of" | "supersedes" | "revises"; active_record_id: string }
  >;
  conflict_record_ids: string[];
  findings: Array<{ code: "LOGICAL_RELATIONSHIP_CYCLE"; record_ids: string[] }>;
}

export function buildActiveLogicalMemoryView(records: MorynRecord[]): ActiveLogicalMemoryView {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const replacementEdges = new Map<string, string>();
  const conflictIds = new Set<string>();
  for (const record of records) {
    for (const link of record.links ?? []) {
      if (!recordsById.has(link.record_id)) continue;
      if (link.link_type === "duplicate_of") replacementEdges.set(record.id, link.record_id);
      if (link.link_type === "supersedes" || link.link_type === "revises")
        replacementEdges.set(link.record_id, record.id);
      if (link.link_type === "conflicts_with") {
        conflictIds.add(record.id);
        conflictIds.add(link.record_id);
      }
    }
  }
  const cyclicIds = new Set<string>();
  const findings: ActiveLogicalMemoryView["findings"] = [];
  const reportedCycles = new Set<string>();
  for (const start of replacementEdges.keys()) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && replacementEdges.has(current)) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart).sort(compareCodeUnits);
        const key = cycle.join("\u0000");
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          cycle.forEach((id) => {
            cyclicIds.add(id);
          });
          findings.push({ code: "LOGICAL_RELATIONSHIP_CYCLE", record_ids: cycle });
        }
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = replacementEdges.get(current);
    }
  }
  const hiddenByRecordId: ActiveLogicalMemoryView["hidden_by_record_id"] = {};
  for (const record of records) {
    if (cyclicIds.has(record.id)) continue;
    for (const link of record.links ?? []) {
      if (!recordsById.has(link.record_id)) continue;
      if (link.link_type === "duplicate_of") {
        hiddenByRecordId[record.id] = { relationship: "duplicate_of", active_record_id: link.record_id };
      } else if ((link.link_type === "supersedes" || link.link_type === "revises") && !cyclicIds.has(link.record_id)) {
        hiddenByRecordId[link.record_id] = { relationship: link.link_type, active_record_id: record.id };
      }
    }
  }
  return {
    active_records: records.filter((record) => hiddenByRecordId[record.id] === undefined),
    hidden_by_record_id: hiddenByRecordId,
    conflict_record_ids: [...conflictIds].sort(compareCodeUnits),
    findings
  };
}
