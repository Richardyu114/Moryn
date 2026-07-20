import { createHash } from "node:crypto";
import type { MorynRecord } from "./types.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalMemoryCompactionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalMemoryCompactionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalMemoryCompactionValue(nested)])
    );
  }
  return value;
}

export function memoryCompactionDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalMemoryCompactionValue(value)))
    .digest("hex");
}

export function sameMemoryCompactionValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalMemoryCompactionValue(left)) === JSON.stringify(canonicalMemoryCompactionValue(right));
}

export function memoryCompactionRecordDigest(record: MorynRecord): string {
  return memoryCompactionDigest({
    id: record.id,
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    project_id: record.project_id,
    tags: [...record.tags].sort(compareCodeUnits),
    content: record.content,
    state: record.state,
    confidence: record.confidence,
    priority: record.priority,
    visibility: record.visibility,
    created_at: record.created_at,
    updated_at: record.updated_at,
    source: record.source,
    provenance: record.provenance,
    conflict: record.conflict,
    links: record.links
  });
}
