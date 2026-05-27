import type { MemoraEvent, MemoraRecord, RecordState } from "./types.js";
import { parseRecord } from "./schema.js";

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

export function applyRecordPatch(record: MemoraRecord, patch: Record<string, unknown>): MemoraRecord {
  const next = structuredClone(record) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    setPath(next, path, value);
  }
  return next as unknown as MemoraRecord;
}

function validateReplayRecord(event: MemoraEvent, record: MemoraRecord): MemoraRecord {
  try {
    return parseRecord(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid replay result for event ${event.event_id}: ${message}`);
  }
}

export function replayEvents(events: MemoraEvent[]): Map<string, MemoraRecord> {
  const records = new Map<string, MemoraRecord>();

  for (const event of events) {
    if (event.op === "upsert_record") {
      const record = validateReplayRecord(event, structuredClone(event.record));
      records.set(record.id, record);
      continue;
    }

    if (event.op === "revise_record") {
      const record = records.get(event.record_id);
      if (!record) continue;
      const next = applyRecordPatch(record, event.patch) as unknown as Record<string, unknown>;
      next.updated_at = event.created_at;
      if (event.conflict) {
        next.conflict = event.conflict;
      } else {
        delete next.conflict;
      }
      records.set(event.record_id, validateReplayRecord(event, next as unknown as MemoraRecord));
      continue;
    }

    if (event.op === "promote_record" || event.op === "archive_record" || event.op === "quarantine_record") {
      const record = records.get(event.record_id);
      if (!record) continue;
      const state = event.target_state ?? (event.op === "archive_record" ? "archived" : "quarantined");
      records.set(event.record_id, validateReplayRecord(event, {
        ...record,
        state: state as RecordState,
        visibility: state === "canonical" || state === "candidate" || state === "raw" ? "active" : state,
        updated_at: event.created_at,
        conflict: event.op === "promote_record" && state === "canonical" && event.conflict
          ? event.conflict
          : record.conflict,
        provenance: event.op === "promote_record" && state === "canonical"
          ? {
              ...(record.provenance ?? {}),
              reason: event.reason ?? record.provenance?.reason,
              method: event.confirmed === true || event.source.client === "user" ? "user-confirmed" : "rule-promoted",
              promoted_at: event.created_at
            }
          : record.provenance
      }));
      continue;
    }

    if (event.op === "link_records") {
      const record = records.get(event.record_id);
      if (!record) continue;
      records.set(event.record_id, validateReplayRecord(event, {
        ...record,
        links: [
          ...(record.links ?? []),
          {
            record_id: event.linked_record_id,
            link_type: event.link_type,
            created_at: event.created_at
          }
        ],
        updated_at: event.created_at
      }));
    }
  }

  return records;
}
