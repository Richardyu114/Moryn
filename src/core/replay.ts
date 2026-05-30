import type { MorynEvent, MorynRecord, RecordState } from "./types.js";
import { parseRecord } from "./schema.js";

type ReplayFailure = "invalid_replay_result" | "missing_replay_target" | "invalid_state_transition";

interface ReplayRecoveryHint {
  failure: ReplayFailure;
  event_id: string;
  event_op: MorynEvent["op"];
  record_id?: string;
  label?: string;
  inspect: {
    event_source: string;
    rebuild_with: "moryn rebuild";
  };
}

class ReplayHistoryError extends Error {
  readonly recovery_hint: ReplayRecoveryHint;

  constructor(message: string, event: MorynEvent, hint: Omit<ReplayRecoveryHint, "event_id" | "event_op" | "inspect">) {
    super(message);
    this.name = "ReplayHistoryError";
    this.recovery_hint = {
      ...hint,
      event_id: event.event_id,
      event_op: event.op,
      inspect: {
        event_source: `events.<device>.<month>.${event.event_id}.json`,
        rebuild_with: "moryn rebuild"
      }
    };
  }
}

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

export function applyRecordPatch(record: MorynRecord, patch: Record<string, unknown>): MorynRecord {
  const next = structuredClone(record) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    setPath(next, path, value);
  }
  return next as unknown as MorynRecord;
}

function validateReplayRecord(event: MorynEvent, record: MorynRecord): MorynRecord {
  try {
    return parseRecord(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ReplayHistoryError(`Invalid replay result for event ${event.event_id}: ${message}`, event, {
      failure: "invalid_replay_result",
      record_id: record.id
    });
  }
}

function requireReplayRecord(records: Map<string, MorynRecord>, event: MorynEvent, recordId: string, label = "Record"): MorynRecord {
  const record = records.get(recordId);
  if (!record) {
    throw new ReplayHistoryError(`Invalid replay target for event ${event.event_id}: ${label} not found: ${recordId}`, event, {
      failure: "missing_replay_target",
      record_id: recordId,
      label
    });
  }
  return record;
}

function replayStateTransition(event: Extract<MorynEvent, { op: "promote_record" | "archive_record" | "quarantine_record" }>): RecordState {
  if (event.op === "promote_record") {
    if (!event.target_state) {
      throw new ReplayHistoryError(`Invalid replay state transition for event ${event.event_id}: promote_record requires target_state`, event, {
        failure: "invalid_state_transition",
        record_id: event.record_id
      });
    }
    return event.target_state;
  }

  if (event.target_state !== undefined) {
    throw new ReplayHistoryError(`Invalid replay state transition for event ${event.event_id}: ${event.op} must not include target_state`, event, {
      failure: "invalid_state_transition",
      record_id: event.record_id
    });
  }

  return event.op === "archive_record" ? "archived" : "quarantined";
}

export function replayEvents(events: MorynEvent[]): Map<string, MorynRecord> {
  const records = new Map<string, MorynRecord>();

  for (const event of events) {
    if (event.op === "upsert_record") {
      const record = validateReplayRecord(event, structuredClone(event.record));
      records.set(record.id, record);
      continue;
    }

    if (event.op === "revise_record") {
      const record = requireReplayRecord(records, event, event.record_id);
      const next = applyRecordPatch(record, event.patch) as unknown as Record<string, unknown>;
      next.updated_at = event.created_at;
      if (event.conflict) {
        next.conflict = event.conflict;
      } else {
        delete next.conflict;
      }
      records.set(event.record_id, validateReplayRecord(event, next as unknown as MorynRecord));
      continue;
    }

    if (event.op === "promote_record" || event.op === "archive_record" || event.op === "quarantine_record") {
      const record = requireReplayRecord(records, event, event.record_id);
      const state = replayStateTransition(event);
      records.set(event.record_id, validateReplayRecord(event, {
        ...record,
        state,
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
      const record = requireReplayRecord(records, event, event.record_id);
      requireReplayRecord(records, event, event.linked_record_id, "Linked record");
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
