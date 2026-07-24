import { rebuildDerivedViews } from "./derived.js";
import {
  buildEventAuditProof,
  readEventAuditProof,
  readRecordsSnapshotFingerprint,
  removeEventAuditProof,
  sameRecordsSnapshotFingerprint,
  writeEventAuditProof
} from "./event-audit-proof.js";
import {
  buildRecordReadModel,
  type CurrentRecordReadResult,
  eventManifest,
  type RecordReadFallbackReason,
  readCurrentRecords
} from "./record-read-model.js";
import { replayEvents } from "./replay.js";
import { parseEvent } from "./schema.js";
import { withStoreStateLease } from "./state-lease.js";
import { readEventFileManifest, readEventInputs } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export type AutomaticEventAuditFailureStage = "read_events" | "schema" | "replay" | "snapshot";
export type AutomaticEventAuditSnapshotStatus = "not_checked" | "fresh" | "repaired" | "repair_failed";
export type AutomaticEventAuditFailureCode =
  | "EVENT_READ_FAILED"
  | "EVENT_SCHEMA_INVALID"
  | "EVENT_IDENTITY_DUPLICATE"
  | "EVENT_REPLAY_INVALID"
  | "SNAPSHOT_REPAIR_FAILED";

interface AutomaticEventAuditReceiptBase {
  event_count: number;
  record_count: number;
  snapshot_status: AutomaticEventAuditSnapshotStatus;
  snapshot_fallback_reason?: RecordReadFallbackReason;
}

export type AutomaticEventAuditReceipt =
  | (AutomaticEventAuditReceiptBase & {
      status: "completed";
      snapshot_status: "fresh" | "repaired";
    })
  | (AutomaticEventAuditReceiptBase & {
      status: "failed";
      failure_stage: AutomaticEventAuditFailureStage;
      code: AutomaticEventAuditFailureCode;
      reason: string;
    });

export interface AutomaticEventAuditDependencies {
  read_events?: (storePath: string) => Promise<readonly unknown[]>;
  parse_event?: (input: unknown) => MorynEvent;
  replay_events?: (events: MorynEvent[]) => Map<string, MorynRecord>;
  read_current_records?: (storePath: string) => Promise<CurrentRecordReadResult>;
  rebuild_derived_views?: (storePath: string) => Promise<unknown>;
  with_store_state_lease?: typeof withStoreStateLease;
}

function failedReceipt(
  failureStage: AutomaticEventAuditFailureStage,
  code: AutomaticEventAuditFailureCode,
  reason: string,
  counts: Pick<AutomaticEventAuditReceiptBase, "event_count" | "record_count">,
  snapshotStatus: AutomaticEventAuditSnapshotStatus,
  snapshotFallbackReason?: RecordReadFallbackReason
): AutomaticEventAuditReceipt {
  return {
    status: "failed",
    failure_stage: failureStage,
    code,
    reason,
    ...counts,
    snapshot_status: snapshotStatus,
    ...(snapshotFallbackReason ? { snapshot_fallback_reason: snapshotFallbackReason } : {})
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function projectedRecords(events: MorynEvent[], records: ReadonlyMap<string, MorynRecord>): MorynRecord[] {
  return buildRecordReadModel(events, [...records.values()], eventManifest(events)).records;
}

function sameProjectedRecords(expected: readonly MorynRecord[], actual: readonly MorynRecord[]): boolean {
  const stable = (records: readonly MorynRecord[]) =>
    canonicalValue([...records].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)));
  return JSON.stringify(stable(expected)) === JSON.stringify(stable(actual));
}

function snapshotMatches(
  snapshot: CurrentRecordReadResult,
  eventCount: number,
  expectedRecords: readonly MorynRecord[]
): boolean {
  return snapshot.event_manifest.count === eventCount && sameProjectedRecords(expectedRecords, snapshot.records);
}

async function proofFastPath(storePath: string): Promise<AutomaticEventAuditReceipt | undefined> {
  try {
    const proof = await readEventAuditProof(storePath);
    if (!proof) return undefined;
    const manifest = await readEventFileManifest(storePath);
    if (proof.event_manifest.count !== manifest.count || proof.event_manifest.digest !== manifest.digest) {
      return undefined;
    }
    const snapshot = await readRecordsSnapshotFingerprint(storePath);
    if (!sameRecordsSnapshotFingerprint(proof.records_snapshot, snapshot)) return undefined;
    return {
      status: "completed",
      event_count: proof.event_count,
      record_count: proof.record_count,
      snapshot_status: "fresh"
    };
  } catch {
    return undefined;
  }
}

async function refreshProofAfterFullAudit(
  storePath: string,
  events: readonly MorynEvent[],
  recordCount: number
): Promise<void> {
  try {
    const proof = buildEventAuditProof({
      events,
      event_manifest: await readEventFileManifest(storePath),
      record_count: recordCount,
      records_snapshot: await readRecordsSnapshotFingerprint(storePath)
    });
    if (proof) await writeEventAuditProof(storePath, proof);
    else await removeEventAuditProof(storePath);
  } catch {
    await removeEventAuditProof(storePath).catch(() => undefined);
  }
}

/**
 * Performs the lifecycle integrity gate while holding the store state lease.
 * A proof emitted by the latest complete derived-view rebuild is the normal
 * fast path. Missing or stale proof falls back to full schema, identity,
 * replay, projection, and snapshot verification. Receipts contain counts and
 * health states only, never record or event bodies.
 */
async function runAutomaticEventAuditInternal(
  storePath: string,
  dependencies: AutomaticEventAuditDependencies = {}
): Promise<AutomaticEventAuditReceipt> {
  const readStoreEvents = dependencies.read_events ?? readEventInputs;
  const parseStoreEvent = dependencies.parse_event ?? parseEvent;
  const replayStoreEvents = dependencies.replay_events ?? replayEvents;
  const readRecords = dependencies.read_current_records ?? readCurrentRecords;
  const rebuildViews = dependencies.rebuild_derived_views ?? rebuildDerivedViews;

  const proofReceipt = await proofFastPath(storePath);
  if (proofReceipt) return proofReceipt;

  let rawEvents: readonly unknown[];
  try {
    rawEvents = await readStoreEvents(storePath);
  } catch {
    return failedReceipt(
      "read_events",
      "EVENT_READ_FAILED",
      "Stored events could not be read for integrity verification.",
      { event_count: 0, record_count: 0 },
      "not_checked"
    );
  }

  let events: MorynEvent[];
  try {
    events = rawEvents
      .map((event) => parseStoreEvent(event))
      .sort(
        (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
      );
  } catch {
    return failedReceipt(
      "schema",
      "EVENT_SCHEMA_INVALID",
      "One or more stored events failed schema validation.",
      { event_count: rawEvents.length, record_count: 0 },
      "not_checked"
    );
  }

  let records: Map<string, MorynRecord>;
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    return failedReceipt(
      "replay",
      "EVENT_IDENTITY_DUPLICATE",
      "Stored event history contains a duplicate event identity.",
      { event_count: events.length, record_count: 0 },
      "not_checked"
    );
  }
  try {
    records = replayStoreEvents(events);
  } catch {
    return failedReceipt(
      "replay",
      "EVENT_REPLAY_INVALID",
      "Stored event history could not be replayed safely.",
      { event_count: events.length, record_count: 0 },
      "not_checked"
    );
  }

  let expectedRecords: MorynRecord[];
  try {
    expectedRecords = projectedRecords(events, records);
  } catch {
    return failedReceipt(
      "replay",
      "EVENT_REPLAY_INVALID",
      "Stored event history could not be projected safely.",
      { event_count: events.length, record_count: records.size },
      "not_checked"
    );
  }
  let snapshot: CurrentRecordReadResult | undefined;
  try {
    snapshot = await readRecords(storePath);
  } catch {}

  const snapshotCounts = { event_count: events.length, record_count: expectedRecords.length };
  if (snapshot && snapshotMatches(snapshot, events.length, expectedRecords)) {
    if (snapshot.source === "read_model" && !snapshot.repaired) {
      await refreshProofAfterFullAudit(storePath, events, expectedRecords.length);
      return { status: "completed", ...snapshotCounts, snapshot_status: "fresh" };
    }
    if (snapshot.source === "event_replay" && snapshot.repaired) {
      await refreshProofAfterFullAudit(storePath, events, expectedRecords.length);
      return {
        status: "completed",
        ...snapshotCounts,
        snapshot_status: "repaired",
        ...(snapshot.fallback_reason ? { snapshot_fallback_reason: snapshot.fallback_reason } : {})
      };
    }
  }

  const initialFallbackReason = snapshot?.fallback_reason;
  try {
    await rebuildViews(storePath);
    snapshot = await readRecords(storePath);
  } catch {
    return failedReceipt(
      "snapshot",
      "SNAPSHOT_REPAIR_FAILED",
      "The records snapshot did not match authoritative event history and could not be repaired.",
      snapshotCounts,
      "repair_failed",
      initialFallbackReason
    );
  }

  if (snapshotMatches(snapshot, events.length, expectedRecords)) {
    await refreshProofAfterFullAudit(storePath, events, expectedRecords.length);
    return {
      status: "completed",
      ...snapshotCounts,
      snapshot_status: "repaired",
      ...(initialFallbackReason || snapshot.fallback_reason
        ? { snapshot_fallback_reason: initialFallbackReason ?? snapshot.fallback_reason }
        : {})
    };
  }

  return failedReceipt(
    "snapshot",
    "SNAPSHOT_REPAIR_FAILED",
    "The records snapshot repair did not match authoritative event history.",
    snapshotCounts,
    "repair_failed",
    initialFallbackReason ?? snapshot.fallback_reason
  );
}

export async function runAutomaticEventAudit(
  storePath: string,
  dependencies: AutomaticEventAuditDependencies = {}
): Promise<AutomaticEventAuditReceipt> {
  try {
    const withStateLease = dependencies.with_store_state_lease ?? withStoreStateLease;
    return await withStateLease(storePath, () => runAutomaticEventAuditInternal(storePath, dependencies));
  } catch {
    return failedReceipt(
      "snapshot",
      "SNAPSHOT_REPAIR_FAILED",
      "The event integrity audit could not complete safely.",
      { event_count: 0, record_count: 0 },
      "repair_failed"
    );
  }
}
