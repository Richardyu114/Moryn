import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rebuildDerivedViews } from "./derived.js";
import {
  assertEventDurabilityAttestation,
  createEventDurabilityAttestation,
  type EventDurabilityAttestation
} from "./event-durability-attestation.js";
import { readCurrentRecords } from "./record-read-model.js";
import { replayEvents } from "./replay.js";
import { planSessionFold, type SessionFoldPlan } from "./session-fold.js";
import { type AppendEventIfAbsentResult, appendEventIfAbsent, readEvents } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export interface SessionFoldReceipt {
  version: 1;
  status: "committed";
  plan_id: string;
  project_id: string;
  session_id: string;
  source_digest: string;
  source_record_ids: string[];
  rollup_record_id: string;
  event_ids: string[];
  durability: EventDurabilityAttestation;
  completed_at: string;
  integrity_digest: string;
}

export interface SessionFoldApplyResult {
  receipt: SessionFoldReceipt;
  created_event_ids: string[];
  existing_event_ids: string[];
  durability: {
    confirmed: number;
    best_effort: number;
    failed: number;
  };
}

export interface SessionFoldTransactionDeps {
  append_event?: typeof appendEventIfAbsent;
  read_events?: typeof readEvents;
  read_records?: typeof readCurrentRecords;
  rebuild?: (storePath: string) => Promise<unknown>;
  write_receipt?: typeof writeSessionFoldReceipt;
}

const TRANSACTION_SOURCE: RecordSource = {
  client: "moryn",
  session_id: "session-fold-v1",
  device_id: "moryn-derived-v1"
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function sameEvent(left: MorynEvent, right: MorynEvent): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function assertPlanId(planId: string): void {
  if (!/^session_fold_[a-f0-9]{32}$/u.test(planId)) throw new Error("Invalid Session Fold plan id");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function archiveEventId(planId: string, recordId: string): string {
  return `evt_${planId}_archive_${digest(recordId)}`;
}

function assertReadyPlan(plan: SessionFoldPlan): asserts plan is SessionFoldPlan & {
  rollup_record: NonNullable<SessionFoldPlan["rollup_record"]>;
} {
  assertPlanId(plan.plan_id);
  if (plan.version !== 1 || !plan.identity.project_id.trim() || !plan.identity.session_id.trim()) {
    throw new Error("Invalid Session Fold plan identity");
  }
  if (!/^[a-f0-9]{64}$/u.test(plan.source_digest)) throw new Error("Invalid Session Fold source digest");
  if (plan.status !== "ready" || !plan.auto_fold || !plan.closed || !plan.rollup_record) {
    throw new Error("Session Fold plan is not safe to apply");
  }
  if (
    plan.source_record_ids.length === 0 ||
    plan.source_record_ids.some((recordId) => !recordId.trim()) ||
    uniqueSorted(plan.source_record_ids).length !== plan.source_record_ids.length
  ) {
    throw new Error("Session Fold plan must contain unique, non-empty source record ids");
  }
  if (plan.source_record_ids.includes(plan.rollup_record.id)) {
    throw new Error("Session Fold rollup must not replace a source record");
  }
  if (
    JSON.stringify(uniqueSorted(plan.source_digests.map((source) => source.record_id))) !==
    JSON.stringify(uniqueSorted(plan.source_record_ids))
  ) {
    throw new Error("Session Fold source digests must cover every source record");
  }
  if (plan.coverage.coverage_ratio !== 1 || plan.coverage.covered_source_records !== plan.source_record_ids.length) {
    throw new Error("Session Fold plan does not provide complete source coverage");
  }
  if (
    plan.proposed_active_target_record_ids.length !== 1 ||
    plan.proposed_active_target_record_ids[0] !== plan.rollup_record.id
  ) {
    throw new Error("Session Fold plan must produce exactly one active rollup target");
  }
  const retentionCandidates = uniqueSorted([
    ...plan.archive_candidates.map((candidate) => candidate.record_id),
    ...plan.cold_candidates.map((candidate) => candidate.record_id)
  ]);
  if (JSON.stringify(retentionCandidates) !== JSON.stringify(uniqueSorted(plan.source_record_ids))) {
    throw new Error("Session Fold plan must account for every source retention transition");
  }
}

function eventTimestamp(plan: SessionFoldPlan, offset: number): string {
  const latest = plan.source_digests.reduce((current, source) => {
    const timestamp = Date.parse(source.updated_at);
    return Number.isFinite(timestamp) ? Math.max(current, timestamp) : current;
  }, 0);
  if (latest === 0) throw new Error("Session Fold plan has no valid source timestamp");
  const timestamp = latest + offset + 1;
  if (!Number.isSafeInteger(timestamp)) throw new Error("Session Fold event timestamp is outside the safe range");
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Session Fold event timestamp is outside the valid range");
  return date.toISOString();
}

export function buildSessionFoldEvents(plan: SessionFoldPlan): MorynEvent[] {
  assertReadyPlan(plan);
  const upsert: MorynEvent = {
    event_id: `evt_${plan.plan_id}_rollup`,
    op: "upsert_record",
    record: plan.rollup_record,
    created_at: eventTimestamp(plan, 0),
    source: TRANSACTION_SOURCE
  };
  const archives = uniqueSorted(plan.source_record_ids).map(
    (recordId, index): MorynEvent => ({
      event_id: archiveEventId(plan.plan_id, recordId),
      op: "archive_record",
      record_id: recordId,
      reason: `Session Fold ${plan.plan_id}: source covered by ${plan.rollup_record.id}`,
      created_at: eventTimestamp(plan, index + 1),
      source: TRANSACTION_SOURCE
    })
  );
  const events = [upsert, ...archives];
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new Error("Session Fold generated duplicate event ids");
  }
  return events;
}

function receiptPath(storePath: string, planId: string): string {
  assertPlanId(planId);
  return join(storePath, "state", "session-fold", `${planId}.json`);
}

type SessionFoldReceiptPayload = Omit<SessionFoldReceipt, "integrity_digest">;

function receiptIntegrityDigest(receipt: SessionFoldReceiptPayload): string {
  return digest(receipt);
}

function expectedReceiptEventIds(planId: string, sourceRecordIds: readonly string[]): string[] {
  return [`evt_${planId}_rollup`, ...uniqueSorted(sourceRecordIds).map((recordId) => archiveEventId(planId, recordId))];
}

function parseReceipt(value: unknown): SessionFoldReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Partial<SessionFoldReceipt>;
  if (
    receipt.version !== 1 ||
    receipt.status !== "committed" ||
    typeof receipt.plan_id !== "string" ||
    typeof receipt.project_id !== "string" ||
    typeof receipt.session_id !== "string" ||
    typeof receipt.source_digest !== "string" ||
    !Array.isArray(receipt.source_record_ids) ||
    receipt.source_record_ids.some((recordId) => typeof recordId !== "string") ||
    typeof receipt.rollup_record_id !== "string" ||
    !Array.isArray(receipt.event_ids) ||
    receipt.event_ids.some((eventId) => typeof eventId !== "string") ||
    !receipt.durability ||
    typeof receipt.completed_at !== "string" ||
    typeof receipt.integrity_digest !== "string"
  ) {
    return undefined;
  }
  try {
    assertPlanId(receipt.plan_id);
    if (!receipt.project_id.trim() || !receipt.session_id.trim()) return undefined;
    if (!/^[a-f0-9]{64}$/u.test(receipt.source_digest)) return undefined;
    if (
      receipt.source_record_ids.length === 0 ||
      receipt.source_record_ids.some((recordId) => !recordId.trim()) ||
      JSON.stringify(receipt.source_record_ids) !== JSON.stringify(uniqueSorted(receipt.source_record_ids))
    ) {
      return undefined;
    }
    if (receipt.rollup_record_id !== `rec_${receipt.plan_id}`) return undefined;
    if (
      JSON.stringify(receipt.event_ids) !==
      JSON.stringify(expectedReceiptEventIds(receipt.plan_id, receipt.source_record_ids))
    ) {
      return undefined;
    }
    assertEventDurabilityAttestation(receipt.durability, receipt.event_ids, "Session Fold receipt");
    if (
      !Number.isFinite(Date.parse(receipt.completed_at)) ||
      new Date(receipt.completed_at).toISOString() !== receipt.completed_at
    ) {
      return undefined;
    }
    const payload: SessionFoldReceiptPayload = {
      version: 1,
      status: "committed",
      plan_id: receipt.plan_id,
      project_id: receipt.project_id,
      session_id: receipt.session_id,
      source_digest: receipt.source_digest,
      source_record_ids: receipt.source_record_ids,
      rollup_record_id: receipt.rollup_record_id,
      event_ids: receipt.event_ids,
      durability: receipt.durability,
      completed_at: receipt.completed_at
    };
    if (receipt.integrity_digest !== receiptIntegrityDigest(payload)) return undefined;
    return { ...payload, integrity_digest: receipt.integrity_digest };
  } catch {
    return undefined;
  }
}

export async function readSessionFoldReceipt(
  storePath: string,
  planId: string
): Promise<SessionFoldReceipt | undefined> {
  try {
    const receipt = parseReceipt(JSON.parse(await readFile(receiptPath(storePath, planId), "utf8")));
    return receipt?.plan_id === planId ? receipt : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeSessionFoldReceipt(storePath: string, receipt: SessionFoldReceipt): Promise<void> {
  const validated = parseReceipt(receipt);
  if (!validated) throw new Error("Invalid Session Fold receipt");
  const path = receiptPath(storePath, validated.plan_id);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function assertNoEventCollisions(events: readonly MorynEvent[], existing: readonly MorynEvent[]): Set<string> {
  const expectedById = new Map(events.map((event) => [event.event_id, event]));
  const existingIds = new Set<string>();
  for (const event of existing) {
    const expected = expectedById.get(event.event_id);
    if (!expected) continue;
    if (!sameEvent(event, expected)) throw new Error(`Session Fold event id collision: ${event.event_id}`);
    existingIds.add(event.event_id);
  }
  return existingIds;
}

function findRecord(records: readonly MorynRecord[], recordId: string): MorynRecord | undefined {
  return records.find((record) => record.id === recordId);
}

async function assertRollupReadback(
  storePath: string,
  plan: SessionFoldPlan & { rollup_record: NonNullable<SessionFoldPlan["rollup_record"]> },
  readRecords: typeof readCurrentRecords
): Promise<void> {
  const published = findRecord((await readRecords(storePath)).records, plan.rollup_record.id);
  if (!published || !sameValue(published, plan.rollup_record)) {
    throw new Error("Session Fold rollup publication readback failed; no sources were archived");
  }
}

async function assertFinalReadback(
  storePath: string,
  plan: SessionFoldPlan & { rollup_record: NonNullable<SessionFoldPlan["rollup_record"]> },
  readRecords: typeof readCurrentRecords
): Promise<void> {
  const records = (await readRecords(storePath)).records;
  const rollup = findRecord(records, plan.rollup_record.id);
  if (!rollup || !sameValue(rollup, plan.rollup_record)) {
    throw new Error("Session Fold final readback failed: rollup record is missing or changed");
  }
  for (const recordId of plan.source_record_ids) {
    const source = findRecord(records, recordId);
    if (source?.state !== "archived" || source.visibility !== "archived") {
      throw new Error(`Session Fold final readback failed: source was not archived: ${recordId}`);
    }
  }
}

async function appendChecked(
  storePath: string,
  event: MorynEvent,
  append: typeof appendEventIfAbsent
): Promise<AppendEventIfAbsentResult> {
  const result = await append(storePath, event);
  if (!sameEvent(result.event, event)) throw new Error(`Session Fold event id collision: ${event.event_id}`);
  if (result.durability === "failed") {
    throw new Error(`Session Fold event durability failed: ${event.event_id}`);
  }
  return result;
}

async function assertFreshPlan(
  storePath: string,
  plan: SessionFoldPlan,
  events: readonly MorynEvent[],
  existingIds: ReadonlySet<string>,
  readRecords: typeof readCurrentRecords
): Promise<void> {
  const records =
    existingIds.size === 0
      ? (await readRecords(storePath)).records
      : [...replayEvents(events.filter((event) => !existingIds.has(event.event_id)) as MorynEvent[]).values()];
  const current = planSessionFold(records, plan.identity);
  if (!current || JSON.stringify(canonicalValue(current)) !== JSON.stringify(canonicalValue(plan))) {
    throw new Error("Stale Session Fold plan: source records changed; create a new plan before applying");
  }
}

function durabilityCounts(results: readonly AppendEventIfAbsentResult[]): SessionFoldApplyResult["durability"] {
  return {
    confirmed: results.filter((result) => result.durability === "confirmed").length,
    best_effort: results.filter((result) => result.durability === "best_effort").length,
    failed: results.filter((result) => result.durability === "failed").length
  };
}

function assertReceiptMatchesPlan(
  receipt: SessionFoldReceipt,
  plan: SessionFoldPlan & { rollup_record: NonNullable<SessionFoldPlan["rollup_record"]> },
  events: readonly MorynEvent[]
): void {
  if (
    receipt.plan_id !== plan.plan_id ||
    receipt.project_id !== plan.identity.project_id ||
    receipt.session_id !== plan.identity.session_id ||
    receipt.source_digest !== plan.source_digest ||
    !sameValue(receipt.source_record_ids, uniqueSorted(plan.source_record_ids)) ||
    receipt.rollup_record_id !== plan.rollup_record.id ||
    !sameValue(
      receipt.event_ids,
      events.map((event) => event.event_id)
    ) ||
    receipt.completed_at !== events.at(-1)!.created_at
  ) {
    throw new Error("Session Fold receipt plan collision");
  }
}

export async function applySessionFoldPlan(
  storePath: string,
  plan: SessionFoldPlan,
  deps: SessionFoldTransactionDeps = {}
): Promise<SessionFoldApplyResult> {
  assertReadyPlan(plan);
  const events = buildSessionFoldEvents(plan);
  const readStoreEvents = deps.read_events ?? readEvents;
  const readRecords = deps.read_records ?? readCurrentRecords;
  let existingEvents = await readStoreEvents(storePath);
  let existingIds = assertNoEventCollisions(events, existingEvents);
  const upsert = events[0]!;
  if (!existingIds.has(upsert.event_id) && events.slice(1).some((event) => existingIds.has(event.event_id))) {
    throw new Error("Invalid Session Fold partial transaction: archive event exists without rollup publication");
  }
  await assertFreshPlan(storePath, plan, existingEvents, existingIds, deps.read_records ?? readCurrentRecords);

  const priorReceipt = await readSessionFoldReceipt(storePath, plan.plan_id);
  if (priorReceipt) {
    assertReceiptMatchesPlan(priorReceipt, plan, events);
    if (existingIds.size !== events.length) {
      throw new Error("Session Fold receipt event readback failed");
    }
    await assertFinalReadback(storePath, plan, readRecords);
    return {
      receipt: priorReceipt,
      created_event_ids: [],
      existing_event_ids: events.map((event) => event.event_id),
      durability: durabilityCounts([])
    };
  }

  const append = deps.append_event ?? appendEventIfAbsent;
  const appendResults: AppendEventIfAbsentResult[] = [];
  if (!existingIds.has(upsert.event_id)) {
    appendResults.push(await appendChecked(storePath, upsert, append));
  }

  existingEvents = await readStoreEvents(storePath);
  existingIds = assertNoEventCollisions(events, existingEvents);
  if (!existingIds.has(upsert.event_id)) {
    throw new Error("Session Fold event publication incomplete; no sources were archived");
  }
  await assertRollupReadback(storePath, plan, readRecords);
  await assertFreshPlan(storePath, plan, existingEvents, existingIds, readRecords);

  for (const event of events.slice(1)) {
    existingEvents = await readStoreEvents(storePath);
    existingIds = assertNoEventCollisions(events, existingEvents);
    await assertFreshPlan(storePath, plan, existingEvents, existingIds, readRecords);
    if (!existingIds.has(event.event_id)) appendResults.push(await appendChecked(storePath, event, append));
  }
  const publishedIds = assertNoEventCollisions(events, await readStoreEvents(storePath));
  if (publishedIds.size !== events.length) {
    throw new Error("Session Fold event publication incomplete; retry the plan before writing a receipt");
  }
  await assertFinalReadback(storePath, plan, readRecords);
  await (deps.rebuild ?? rebuildDerivedViews)(storePath);

  const receiptPayload: SessionFoldReceiptPayload = {
    version: 1,
    status: "committed",
    plan_id: plan.plan_id,
    project_id: plan.identity.project_id,
    session_id: plan.identity.session_id,
    source_digest: plan.source_digest,
    source_record_ids: uniqueSorted(plan.source_record_ids),
    rollup_record_id: plan.rollup_record!.id,
    event_ids: events.map((event) => event.event_id),
    durability: createEventDurabilityAttestation({
      event_ids: events.map((event) => event.event_id),
      append_results: appendResults
    }),
    completed_at: events.at(-1)!.created_at
  };
  const receipt: SessionFoldReceipt = {
    ...receiptPayload,
    integrity_digest: receiptIntegrityDigest(receiptPayload)
  };
  await (deps.write_receipt ?? writeSessionFoldReceipt)(storePath, receipt);
  const createdIds = new Set(appendResults.filter((result) => result.created).map((result) => result.event.event_id));
  return {
    receipt,
    created_event_ids: events.map((event) => event.event_id).filter((eventId) => createdIds.has(eventId)),
    existing_event_ids: events.map((event) => event.event_id).filter((eventId) => !createdIds.has(eventId)),
    durability: durabilityCounts(appendResults)
  };
}
