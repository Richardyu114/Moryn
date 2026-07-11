import { createHash } from "node:crypto";
import type { MorynRecord } from "./types.js";

export const LOGICAL_RELATIONSHIP_TYPES = [
  "duplicate_of",
  "supports",
  "revises",
  "supersedes",
  "conflicts_with"
] as const;

export type LogicalRelationshipType = typeof LOGICAL_RELATIONSHIP_TYPES[number];

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
  return record.kind === linkedRecord.kind
    && record.type === linkedRecord.type
    && record.scope === linkedRecord.scope
    && record.project_id === linkedRecord.project_id;
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
