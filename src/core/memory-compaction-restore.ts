import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rebuildDerivedViews } from "./derived.js";
import {
  assertEventDurabilityAttestation,
  createEventDurabilityAttestation,
  type EventDurabilityAttestation
} from "./event-durability-attestation.js";
import {
  memoryCompactionDigest,
  memoryCompactionRecordDigest,
  sameMemoryCompactionValue
} from "./memory-compaction.js";
import { type MemoryCompactionReceipt, readMemoryCompactionReceipt } from "./memory-compaction-receipts.js";
import { buildMemoryRetentionView } from "./memory-retention.js";
import { readCurrentRecords } from "./record-read-model.js";
import { replayEvents } from "./replay.js";
import { type AppendEventIfAbsentResult, appendEventIfAbsent, readEvents } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export interface MemoryCompactionRestoreReceipt {
  version: 1;
  status: "restored";
  restore_id: string;
  compaction_plan_id: string;
  compaction_receipt_digest: string;
  source_record_ids: string[];
  derived_record_ids: string[];
  event_ids: string[];
  durability: EventDurabilityAttestation;
  completed_at: string;
  logical_restore: true;
  purge_performed: false;
  git_history_erased: false;
  integrity_digest: string;
}

export interface MemoryCompactionRestoreResult {
  receipt: MemoryCompactionRestoreReceipt;
  created_event_ids: string[];
  existing_event_ids: string[];
  durability: {
    confirmed: number;
    best_effort: number;
    failed: number;
  };
}

export interface RestoreMemoryCompactionInput {
  plan_id: string;
  confirmed: boolean;
}

export interface MemoryCompactionRestoreDeps {
  append_event?: typeof appendEventIfAbsent;
  read_events?: typeof readEvents;
  read_records?: typeof readCurrentRecords;
  read_compaction_receipt?: typeof readMemoryCompactionReceipt;
  rebuild?: typeof rebuildDerivedViews;
  write_receipt?: typeof writeMemoryCompactionRestoreReceipt;
}

type RestoreReceiptPayload = Omit<MemoryCompactionRestoreReceipt, "integrity_digest">;

const RESTORE_SOURCE: RecordSource = {
  client: "moryn",
  session_id: "memory-compaction-restore-v1",
  device_id: "moryn-derived-v1"
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function validCanonicalIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertCompactionPlanId(planId: string): void {
  if (!/^memory_compaction_[a-f0-9]{32}$/u.test(planId)) {
    throw new Error("Invalid Memory Compaction plan id");
  }
}

function assertRestoreId(restoreId: string): void {
  if (!/^memory_compaction_restore_[a-f0-9]{32}$/u.test(restoreId)) {
    throw new Error("Invalid Memory Compaction restore id");
  }
}

function restoreId(receipt: MemoryCompactionReceipt): string {
  return `memory_compaction_restore_${memoryCompactionDigest({
    version: 1,
    compaction_plan_id: receipt.plan_id,
    compaction_receipt_digest: receipt.integrity_digest
  }).slice(0, 32)}`;
}

function restoreReceiptPath(storePath: string, id: string): string {
  assertRestoreId(id);
  return join(storePath, "state", "memory-compaction-restores", `${id}.json`);
}

function eventTimestamp(receipt: MemoryCompactionReceipt, offset: number): string {
  const base = Date.parse(receipt.completed_at);
  const timestamp = base + offset + 1;
  if (!Number.isSafeInteger(timestamp))
    throw new Error("Memory Compaction restore timestamp is outside the safe range");
  const value = new Date(timestamp);
  if (!Number.isFinite(value.getTime()))
    throw new Error("Memory Compaction restore timestamp is outside the valid range");
  return value.toISOString();
}

function sourceRestoreEventId(id: string, recordId: string): string {
  return `evt_${id}_source_${memoryCompactionDigest(recordId)}`;
}

function derivedArchiveEventId(id: string, recordId: string): string {
  return `evt_${id}_derived_${memoryCompactionDigest(recordId)}`;
}

export function buildMemoryCompactionRestoreEvents(receipt: MemoryCompactionReceipt): MorynEvent[] {
  const id = restoreId(receipt);
  const sourceEvents = [...receipt.source_transitions]
    .sort((left, right) => compareCodeUnits(left.record_id, right.record_id))
    .map(
      (transition, index): MorynEvent => ({
        event_id: sourceRestoreEventId(id, transition.record_id),
        op: "promote_record",
        record_id: transition.record_id,
        target_state: transition.before_state,
        reason: `Logical restore for Memory Compaction ${receipt.plan_id}; source trust state restored from receipt`,
        confirmed: true,
        created_at: eventTimestamp(receipt, index),
        source: RESTORE_SOURCE
      })
    );
  const derivedEvents = [...receipt.derived_records]
    .sort((left, right) => compareCodeUnits(left.record_id, right.record_id))
    .map(
      (derived, index): MorynEvent => ({
        event_id: derivedArchiveEventId(id, derived.record_id),
        op: "archive_record",
        record_id: derived.record_id,
        reason: `Logical restore for Memory Compaction ${receipt.plan_id}; derived rollup superseded, history retained`,
        confirmed: true,
        created_at: eventTimestamp(receipt, sourceEvents.length + index),
        source: RESTORE_SOURCE
      })
    );
  const events = [...sourceEvents, ...derivedEvents];
  if (events.length === 0 || new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new Error("Invalid Memory Compaction restore event set");
  }
  return events;
}

function restoreReceiptIntegrityDigest(receipt: RestoreReceiptPayload): string {
  return memoryCompactionDigest(receipt);
}

function isUniqueStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && Boolean(item.trim())) &&
    new Set(value).size === value.length
  );
}

function parseRestoreReceipt(value: unknown): MemoryCompactionRestoreReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Partial<MemoryCompactionRestoreReceipt>;
  if (
    receipt.version !== 1 ||
    receipt.status !== "restored" ||
    typeof receipt.restore_id !== "string" ||
    typeof receipt.compaction_plan_id !== "string" ||
    typeof receipt.compaction_receipt_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.compaction_receipt_digest) ||
    !isUniqueStringArray(receipt.source_record_ids) ||
    !isUniqueStringArray(receipt.derived_record_ids) ||
    !isUniqueStringArray(receipt.event_ids) ||
    !receipt.durability ||
    typeof receipt.completed_at !== "string" ||
    !validCanonicalIso(receipt.completed_at) ||
    receipt.logical_restore !== true ||
    receipt.purge_performed !== false ||
    receipt.git_history_erased !== false ||
    typeof receipt.integrity_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.integrity_digest)
  ) {
    return undefined;
  }
  try {
    assertRestoreId(receipt.restore_id);
    assertCompactionPlanId(receipt.compaction_plan_id);
    if (JSON.stringify(receipt.source_record_ids) !== JSON.stringify(uniqueSorted(receipt.source_record_ids))) {
      return undefined;
    }
    if (JSON.stringify(receipt.derived_record_ids) !== JSON.stringify(uniqueSorted(receipt.derived_record_ids))) {
      return undefined;
    }
    assertEventDurabilityAttestation(receipt.durability, receipt.event_ids, "Memory Compaction restore receipt");
    const expectedId = `memory_compaction_restore_${memoryCompactionDigest({
      version: 1,
      compaction_plan_id: receipt.compaction_plan_id,
      compaction_receipt_digest: receipt.compaction_receipt_digest
    }).slice(0, 32)}`;
    if (receipt.restore_id !== expectedId) return undefined;
    const payload: RestoreReceiptPayload = {
      version: 1,
      status: "restored",
      restore_id: receipt.restore_id,
      compaction_plan_id: receipt.compaction_plan_id,
      compaction_receipt_digest: receipt.compaction_receipt_digest,
      source_record_ids: receipt.source_record_ids,
      derived_record_ids: receipt.derived_record_ids,
      event_ids: receipt.event_ids,
      durability: receipt.durability,
      completed_at: receipt.completed_at,
      logical_restore: true,
      purge_performed: false,
      git_history_erased: false
    };
    if (receipt.integrity_digest !== restoreReceiptIntegrityDigest(payload)) return undefined;
    return { ...payload, integrity_digest: receipt.integrity_digest };
  } catch {
    return undefined;
  }
}

async function readRestoreReceiptFile(
  storePath: string,
  id: string
): Promise<{ exists: boolean; receipt?: MemoryCompactionRestoreReceipt }> {
  try {
    return {
      exists: true,
      receipt: parseRestoreReceipt(JSON.parse(await readFile(restoreReceiptPath(storePath, id), "utf8")))
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exists: false };
    return { exists: true };
  }
}

export async function readMemoryCompactionRestoreReceipt(
  storePath: string,
  id: string
): Promise<MemoryCompactionRestoreReceipt | undefined> {
  return (await readRestoreReceiptFile(storePath, id)).receipt;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeMemoryCompactionRestoreReceipt(
  storePath: string,
  receipt: MemoryCompactionRestoreReceipt
): Promise<void> {
  const validated = parseRestoreReceipt(receipt);
  if (!validated) throw new Error("Invalid Memory Compaction restore receipt");
  const path = restoreReceiptPath(storePath, validated.restore_id);
  const directory = dirname(path);
  const existing = await readRestoreReceiptFile(storePath, validated.restore_id);
  if (existing.exists) {
    if (!existing.receipt || !sameMemoryCompactionValue(existing.receipt, validated)) {
      throw new Error("Memory Compaction restore receipt collision or corruption");
    }
    await chmod(directory, 0o700);
    await chmod(path, 0o600);
    return;
  }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const raced = await readRestoreReceiptFile(storePath, validated.restore_id);
      if (!raced.receipt || !sameMemoryCompactionValue(raced.receipt, validated)) {
        throw new Error("Memory Compaction restore receipt collision or corruption");
      }
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
  const readback = await readMemoryCompactionRestoreReceipt(storePath, validated.restore_id);
  if (!readback || !sameMemoryCompactionValue(readback, validated)) {
    throw new Error("Memory Compaction restore receipt durability readback failed");
  }
}

function publishedEventIds(expected: readonly MorynEvent[], existing: readonly MorynEvent[]): Set<string> {
  const expectedById = new Map(expected.map((event) => [event.event_id, event]));
  const published = new Set<string>();
  for (const event of existing) {
    const expectedEvent = expectedById.get(event.event_id);
    if (!expectedEvent) continue;
    if (!sameMemoryCompactionValue(event, expectedEvent)) {
      throw new Error(`Memory Compaction restore event id collision: ${event.event_id}`);
    }
    published.add(event.event_id);
  }
  return published;
}

function recordById(records: readonly MorynRecord[], id: string): MorynRecord {
  const record = records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Memory Compaction restore record is missing: ${id}`);
  return record;
}

function assertFreshRestoreBaseline(
  receipt: MemoryCompactionReceipt,
  expectedEvents: readonly MorynEvent[],
  currentEvents: readonly MorynEvent[]
): void {
  const restoreEventIds = new Set(expectedEvents.map((event) => event.event_id));
  const baselineEvents = currentEvents.filter((event) => !restoreEventIds.has(event.event_id));
  const baselineRecords = [...replayEvents(baselineEvents as MorynEvent[]).values()];
  const baselineEventIds = new Set(baselineEvents.map((event) => event.event_id));
  const missingChildEvents = receipt.event_ids.filter((eventId) => !baselineEventIds.has(eventId));
  if (missingChildEvents.length > 0) {
    throw new Error(`Memory Compaction restore is stale: child events missing: ${missingChildEvents.join(", ")}`);
  }
  for (const transition of receipt.source_transitions) {
    const record = recordById(baselineRecords, transition.record_id);
    if (
      record.state !== "archived" ||
      record.visibility !== "archived" ||
      memoryCompactionRecordDigest(record) !== transition.post_apply_record_digest
    ) {
      throw new Error(`Memory Compaction restore is stale: source changed after compaction: ${transition.record_id}`);
    }
  }
  for (const derived of receipt.derived_records) {
    const record = recordById(baselineRecords, derived.record_id);
    if (
      record.state === "archived" ||
      record.visibility !== "active" ||
      memoryCompactionRecordDigest(record) !== derived.post_apply_record_digest
    ) {
      throw new Error(
        `Memory Compaction restore is stale: derived record changed after compaction: ${derived.record_id}`
      );
    }
  }
}

async function appendChecked(
  storePath: string,
  event: MorynEvent,
  append: typeof appendEventIfAbsent
): Promise<AppendEventIfAbsentResult> {
  const result = await append(storePath, event);
  if (!sameMemoryCompactionValue(result.event, event)) {
    throw new Error(`Memory Compaction restore event id collision: ${event.event_id}`);
  }
  if (result.durability === "failed") {
    throw new Error(`Memory Compaction restore event durability failed: ${event.event_id}`);
  }
  return result;
}

async function assertSourcesRestored(
  storePath: string,
  receipt: MemoryCompactionReceipt,
  readRecords: typeof readCurrentRecords
): Promise<void> {
  const records = (await readRecords(storePath)).records;
  for (const transition of receipt.source_transitions) {
    const record = recordById(records, transition.record_id);
    const trust = buildMemoryRetentionView(record).trust.state;
    if (
      record.state !== transition.before_state ||
      record.visibility !== transition.before_visibility ||
      trust !== transition.before_trust_state
    ) {
      throw new Error(`Memory Compaction source restore readback failed: ${transition.record_id}`);
    }
  }
}

async function assertFinalRestoreReadback(
  storePath: string,
  receipt: MemoryCompactionReceipt,
  readRecords: typeof readCurrentRecords
): Promise<void> {
  await assertSourcesRestored(storePath, receipt, readRecords);
  const records = (await readRecords(storePath)).records;
  for (const derived of receipt.derived_records) {
    const record = recordById(records, derived.record_id);
    if (record.state !== "archived" || record.visibility !== "archived") {
      throw new Error(`Memory Compaction derived archive readback failed: ${derived.record_id}`);
    }
  }
}

function durabilityCounts(results: readonly AppendEventIfAbsentResult[]): MemoryCompactionRestoreResult["durability"] {
  return {
    confirmed: results.filter((result) => result.durability === "confirmed").length,
    best_effort: results.filter((result) => result.durability === "best_effort").length,
    failed: results.filter((result) => result.durability === "failed").length
  };
}

function buildRestoreReceipt(
  compaction: MemoryCompactionReceipt,
  events: readonly MorynEvent[],
  appendResults: readonly AppendEventIfAbsentResult[]
): MemoryCompactionRestoreReceipt {
  const payload: RestoreReceiptPayload = {
    version: 1,
    status: "restored",
    restore_id: restoreId(compaction),
    compaction_plan_id: compaction.plan_id,
    compaction_receipt_digest: compaction.integrity_digest,
    source_record_ids: uniqueSorted(compaction.source_transitions.map((transition) => transition.record_id)),
    derived_record_ids: uniqueSorted(compaction.derived_records.map((derived) => derived.record_id)),
    event_ids: events.map((event) => event.event_id),
    durability: createEventDurabilityAttestation({
      event_ids: events.map((event) => event.event_id),
      append_results: appendResults
    }),
    completed_at: events.at(-1)!.created_at,
    logical_restore: true,
    purge_performed: false,
    git_history_erased: false
  };
  return { ...payload, integrity_digest: restoreReceiptIntegrityDigest(payload) };
}

export async function restoreMemoryCompactionPlan(
  storePath: string,
  input: RestoreMemoryCompactionInput,
  deps: MemoryCompactionRestoreDeps = {}
): Promise<MemoryCompactionRestoreResult> {
  if (input.confirmed !== true) {
    throw new Error("Memory Compaction restore requires explicit confirmed: true");
  }
  assertCompactionPlanId(input.plan_id);
  const compaction = await (deps.read_compaction_receipt ?? readMemoryCompactionReceipt)(storePath, input.plan_id);
  if (!compaction) throw new Error("Memory Compaction receipt is missing, corrupt, or tampered");
  const id = restoreId(compaction);
  const expected = buildMemoryCompactionRestoreEvents(compaction);
  const prior = await readRestoreReceiptFile(storePath, id);
  if (prior.exists) {
    if (!prior.receipt) throw new Error("Memory Compaction restore receipt is corrupt or tampered");
    if (prior.receipt.compaction_receipt_digest !== compaction.integrity_digest) {
      throw new Error("Memory Compaction restore receipt collision");
    }
    const events = await (deps.read_events ?? readEvents)(storePath);
    const published = publishedEventIds(expected, events);
    if (
      !sameMemoryCompactionValue(
        prior.receipt.event_ids,
        expected.map((event) => event.event_id)
      ) ||
      published.size !== expected.length
    ) {
      throw new Error("Memory Compaction restore receipt event readback failed");
    }
    await assertFinalRestoreReadback(storePath, compaction, deps.read_records ?? readCurrentRecords);
    return {
      receipt: prior.receipt,
      created_event_ids: [],
      existing_event_ids: [...prior.receipt.event_ids],
      durability: { confirmed: 0, best_effort: 0, failed: 0 }
    };
  }

  const readStoreEvents = deps.read_events ?? readEvents;
  const readRecords = deps.read_records ?? readCurrentRecords;
  const append = deps.append_event ?? appendEventIfAbsent;
  let currentEvents = await readStoreEvents(storePath);
  let published = publishedEventIds(expected, currentEvents);
  assertFreshRestoreBaseline(compaction, expected, currentEvents);
  const appendResults: AppendEventIfAbsentResult[] = [];
  const sourceEventCount = compaction.source_transitions.length;
  for (const event of expected.slice(0, sourceEventCount)) {
    currentEvents = await readStoreEvents(storePath);
    published = publishedEventIds(expected, currentEvents);
    assertFreshRestoreBaseline(compaction, expected, currentEvents);
    if (!published.has(event.event_id)) appendResults.push(await appendChecked(storePath, event, append));
  }
  await assertSourcesRestored(storePath, compaction, readRecords);
  for (const event of expected.slice(sourceEventCount)) {
    currentEvents = await readStoreEvents(storePath);
    published = publishedEventIds(expected, currentEvents);
    assertFreshRestoreBaseline(compaction, expected, currentEvents);
    if (!published.has(event.event_id)) appendResults.push(await appendChecked(storePath, event, append));
  }
  currentEvents = await readStoreEvents(storePath);
  published = publishedEventIds(expected, currentEvents);
  if (published.size !== expected.length) {
    throw new Error("Memory Compaction restore publication incomplete; retry before writing a receipt");
  }
  await assertFinalRestoreReadback(storePath, compaction, readRecords);
  await (deps.rebuild ?? rebuildDerivedViews)(storePath);
  const receipt = buildRestoreReceipt(compaction, expected, appendResults);
  await (deps.write_receipt ?? writeMemoryCompactionRestoreReceipt)(storePath, receipt);
  const persisted = await readMemoryCompactionRestoreReceipt(storePath, id);
  if (!persisted || !sameMemoryCompactionValue(persisted, receipt)) {
    throw new Error("Memory Compaction restore receipt publication readback failed; retry safely");
  }
  const createdIds = new Set(appendResults.filter((result) => result.created).map((result) => result.event.event_id));
  return {
    receipt,
    created_event_ids: expected.map((event) => event.event_id).filter((eventId) => createdIds.has(eventId)),
    existing_event_ids: expected.map((event) => event.event_id).filter((eventId) => !createdIds.has(eventId)),
    durability: durabilityCounts(appendResults)
  };
}
