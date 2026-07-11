import { createHash } from "node:crypto";
import type { MorynEvent, MorynRecord } from "./types.js";

export interface EventManifest {
  count: number;
  digest: string;
}

export interface RecordReadModelV1 {
  version: 1;
  generated_at: string;
  event_manifest: EventManifest;
  records: MorynRecord[];
}

export function eventManifest(events: MorynEvent[]): EventManifest {
  const identities = [...events]
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id))
    .map((event) => `${event.created_at}\u0000${event.event_id}\u0000${event.op}`);
  return {
    count: identities.length,
    digest: createHash("sha256").update(identities.join("\n")).digest("hex")
  };
}

export function buildRecordReadModel(events: MorynEvent[], records: MorynRecord[]): RecordReadModelV1 {
  return {
    version: 1,
    generated_at: [...events].sort((left, right) => right.created_at.localeCompare(left.created_at) || right.event_id.localeCompare(left.event_id))[0]?.created_at ?? "1970-01-01T00:00:00.000Z",
    event_manifest: eventManifest(events),
    records: [...records].sort((left, right) => left.id.localeCompare(right.id))
  };
}
