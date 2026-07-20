import type { AppendEventIfAbsentResult } from "./store.js";

/**
 * Metadata-only evidence for the durability level actually observed for an
 * append-only event set. `committed` means every event was atomically published
 * and read back exactly; only `confirmed_event_ids` additionally prove that the
 * containing directory entry was synced during this transaction.
 */
export interface EventDurabilityAttestation {
  confirmed_event_ids: string[];
  best_effort_event_ids: string[];
  existing_readback_event_ids: string[];
  all_events_read_back: true;
}

function orderedUniqueStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && Boolean(item.trim())) &&
    new Set(value).size === value.length
  );
}

export function assertEventDurabilityAttestation(
  value: unknown,
  eventIds: readonly string[],
  label: string
): asserts value is EventDurabilityAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${label} durability attestation`);
  }
  const candidate = value as Partial<EventDurabilityAttestation>;
  if (
    !orderedUniqueStrings(candidate.confirmed_event_ids) ||
    !orderedUniqueStrings(candidate.best_effort_event_ids) ||
    !orderedUniqueStrings(candidate.existing_readback_event_ids) ||
    candidate.all_events_read_back !== true
  ) {
    throw new Error(`Invalid ${label} durability attestation`);
  }
  const expectedIds = [...eventIds];
  if (!orderedUniqueStrings(expectedIds)) throw new Error(`Invalid ${label} event ids`);
  const partitions = [
    candidate.confirmed_event_ids,
    candidate.best_effort_event_ids,
    candidate.existing_readback_event_ids
  ];
  const flattened = partitions.flat();
  if (new Set(flattened).size !== flattened.length) {
    throw new Error(`Invalid ${label} durability partition overlap`);
  }
  const partitionSet = new Set(flattened);
  if (partitionSet.size !== expectedIds.length || expectedIds.some((eventId) => !partitionSet.has(eventId))) {
    throw new Error(`Invalid ${label} durability partition coverage`);
  }
  for (const partition of partitions) {
    const partitionIds = new Set(partition);
    const expectedOrder = expectedIds.filter((eventId) => partitionIds.has(eventId));
    if (JSON.stringify(partition) !== JSON.stringify(expectedOrder)) {
      throw new Error(`Invalid ${label} durability partition order`);
    }
  }
}

export function createEventDurabilityAttestation(input: {
  event_ids: readonly string[];
  append_results: readonly AppendEventIfAbsentResult[];
}): EventDurabilityAttestation {
  const eventIds = [...input.event_ids];
  if (!orderedUniqueStrings(eventIds)) throw new Error("Invalid event durability event ids");
  const expectedIds = new Set(eventIds);
  const results = new Map<string, AppendEventIfAbsentResult>();
  for (const result of input.append_results) {
    const eventId = result.event.event_id;
    if (!expectedIds.has(eventId) || results.has(eventId) || result.durability === "failed") {
      throw new Error(`Invalid event durability append result: ${eventId}`);
    }
    results.set(eventId, result);
  }
  const confirmed: string[] = [];
  const bestEffort: string[] = [];
  const existing: string[] = [];
  for (const eventId of eventIds) {
    const result = results.get(eventId);
    if (!result?.created) existing.push(eventId);
    else if (result.durability === "confirmed") confirmed.push(eventId);
    else bestEffort.push(eventId);
  }
  const attestation: EventDurabilityAttestation = {
    confirmed_event_ids: confirmed,
    best_effort_event_ids: bestEffort,
    existing_readback_event_ids: existing,
    all_events_read_back: true
  };
  assertEventDurabilityAttestation(attestation, eventIds, "event");
  return attestation;
}

export function mergeEventDurabilityAttestations(
  eventIds: readonly string[],
  attestations: readonly EventDurabilityAttestation[]
): EventDurabilityAttestation {
  const confirmed = new Set(attestations.flatMap((attestation) => attestation.confirmed_event_ids));
  const bestEffort = new Set(attestations.flatMap((attestation) => attestation.best_effort_event_ids));
  const existing = new Set(attestations.flatMap((attestation) => attestation.existing_readback_event_ids));
  const merged: EventDurabilityAttestation = {
    confirmed_event_ids: eventIds.filter((eventId) => confirmed.has(eventId)),
    best_effort_event_ids: eventIds.filter((eventId) => bestEffort.has(eventId)),
    existing_readback_event_ids: eventIds.filter((eventId) => existing.has(eventId)),
    all_events_read_back: true
  };
  assertEventDurabilityAttestation(merged, eventIds, "merged event");
  return merged;
}
