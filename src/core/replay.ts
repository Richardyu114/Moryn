import type { MemoraEvent, MemoraRecord, RecordState } from "./types.js";

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

export function replayEvents(events: MemoraEvent[]): Map<string, MemoraRecord> {
  const records = new Map<string, MemoraRecord>();

  for (const event of events) {
    if (event.op === "upsert_record") {
      records.set(event.record.id, structuredClone(event.record));
      continue;
    }

    if (event.op === "revise_record") {
      const record = records.get(event.record_id);
      if (!record) continue;
      const next = structuredClone(record) as unknown as Record<string, unknown>;
      for (const [path, value] of Object.entries(event.patch)) {
        setPath(next, path, value);
      }
      next.updated_at = event.created_at;
      records.set(event.record_id, next as unknown as MemoraRecord);
      continue;
    }

    if (event.op === "promote_record" || event.op === "archive_record" || event.op === "quarantine_record") {
      const record = records.get(event.record_id);
      if (!record) continue;
      const state = event.target_state ?? (event.op === "archive_record" ? "archived" : "quarantined");
      records.set(event.record_id, {
        ...record,
        state: state as RecordState,
        visibility: state === "canonical" || state === "candidate" || state === "raw" ? "active" : state,
        updated_at: event.created_at
      });
      continue;
    }

    if (event.op === "link_records") {
      const record = records.get(event.record_id);
      if (!record) continue;
      records.set(event.record_id, {
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
      });
    }
  }

  return records;
}
