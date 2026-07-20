import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { rebuildDerivedViews } from "./derived.js";
import { type EpisodeRollupPlan, type EpisodeRollupRecord, planEpisodeRollup } from "./episode-rollup.js";
import {
  assertEventDurabilityAttestation,
  createEventDurabilityAttestation,
  type EventDurabilityAttestation
} from "./event-durability-attestation.js";
import { readCurrentRecords } from "./record-read-model.js";
import { replayEvents } from "./replay.js";
import { type AppendEventIfAbsentResult, appendEventIfAbsent, readEvents } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export interface EpisodeRollupReceipt {
  version: 1;
  status: "committed";
  plan_id: string;
  project_id: string;
  bucket_kind: EpisodeRollupPlan["identity"]["bucket_kind"];
  bucket_key: string;
  source_digest: string;
  observation_digest: string;
  source_record_ids: string[];
  archived_source_record_ids: string[];
  preserved_warm_record_ids: string[];
  rollup_record_id: string;
  event_ids: string[];
  durability: EventDurabilityAttestation;
  completed_at: string;
  integrity_digest: string;
}

export interface EpisodeRollupApplyResult {
  receipt: EpisodeRollupReceipt;
  created_event_ids: string[];
  existing_event_ids: string[];
  durability: {
    confirmed: number;
    best_effort: number;
    failed: number;
  };
}

export interface EpisodeRollupTransactionDeps {
  append_event?: typeof appendEventIfAbsent;
  read_events?: typeof readEvents;
  read_records?: typeof readCurrentRecords;
  rebuild?: typeof rebuildDerivedViews;
  write_receipt?: typeof writeEpisodeRollupReceipt;
}

const TRANSACTION_SOURCE: RecordSource = {
  client: "moryn",
  session_id: "episode-rollup-v1",
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

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function sameEvent(left: MorynEvent, right: MorynEvent): boolean {
  return sameValue(left, right);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function assertPlanId(planId: string): void {
  if (!/^episode_rollup_[a-f0-9]{32}$/u.test(planId)) throw new Error("Invalid Episode Rollup plan id");
}

function archiveEventId(planId: string, recordId: string): string {
  return `evt_${planId}_archive_${digest(recordId)}`;
}

function expectedEventIds(planId: string, archivedRecordIds: readonly string[]): string[] {
  return [
    `evt_${planId}_rollup`,
    ...uniqueSorted(archivedRecordIds).map((recordId) => archiveEventId(planId, recordId))
  ];
}

function assertReadyPlan(plan: EpisodeRollupPlan): asserts plan is EpisodeRollupPlan & {
  rollup_record: EpisodeRollupRecord;
} {
  assertPlanId(plan.plan_id);
  if (
    plan.version !== 1 ||
    !plan.identity.project_id.trim() ||
    !plan.identity.bucket_key.trim() ||
    !["day", "task", "project_epoch"].includes(plan.identity.bucket_kind)
  ) {
    throw new Error("Invalid Episode Rollup plan identity");
  }
  if (!/^[a-f0-9]{64}$/u.test(plan.source_digest) || !/^[a-f0-9]{64}$/u.test(plan.observation_digest)) {
    throw new Error("Invalid Episode Rollup source digest");
  }
  if (
    plan.status !== "ready" ||
    !plan.rollup_record ||
    plan.review_reasons.length > 0 ||
    plan.deferred_reasons.length > 0
  ) {
    throw new Error("Episode Rollup plan is not safe to apply");
  }
  const sourceIds = uniqueSorted(plan.source_record_ids);
  if (sourceIds.length === 0 || sourceIds.length !== plan.source_record_ids.length) {
    throw new Error("Episode Rollup sources must be unique and non-empty");
  }
  if (plan.source_record_ids.includes(plan.rollup_record.id)) {
    throw new Error("Episode Rollup cannot replace a source rollup");
  }
  if (
    JSON.stringify(uniqueSorted(plan.source_digests.map((source) => source.record_id))) !== JSON.stringify(sourceIds)
  ) {
    throw new Error("Episode Rollup source digests must cover every source rollup");
  }
  const archivedIds = uniqueSorted(plan.cold_candidates.map((candidate) => candidate.record_id));
  if (archivedIds.length === 0 || archivedIds.length !== plan.cold_candidates.length) {
    throw new Error("Episode Rollup must transition at least one unique old source to cold");
  }
  if (archivedIds.some((recordId) => !sourceIds.includes(recordId))) {
    throw new Error("Episode Rollup cold candidates must be source rollups");
  }
  const warmIds = uniqueSorted(plan.warm_candidates.map((candidate) => candidate.record_id));
  if (warmIds.some((recordId) => archivedIds.includes(recordId))) {
    throw new Error("Episode Rollup cannot preserve and archive the same source");
  }
  if (
    plan.coverage.total_source_rollups !== sourceIds.length ||
    plan.coverage.covered_source_rollups !== sourceIds.length ||
    plan.coverage.coverage_ratio !== 1 ||
    plan.coverage.claims_with_leaf_evidence !== plan.claims.length ||
    plan.claims.length === 0 ||
    plan.claims.some(
      (claim) =>
        claim.leaf_evidence.length === 0 ||
        claim.source_rollup_ids.length === 0 ||
        claim.source_rollup_ids.some((recordId) => !sourceIds.includes(recordId))
    )
  ) {
    throw new Error("Episode Rollup plan does not provide complete leaf-evidence coverage");
  }
  if (
    plan.rollup_record.id !== `rec_${plan.plan_id}` ||
    plan.rollup_record.content.episode_rollup_plan_id !== plan.plan_id ||
    plan.rollup_record.content.source_digest !== plan.source_digest ||
    !sameValue(plan.rollup_record.content.claims, plan.claims) ||
    !sameValue(plan.rollup_record.content.leaf_evidence, plan.leaf_evidence)
  ) {
    throw new Error("Episode Rollup output does not match its plan");
  }
}

function eventTimestamp(plan: EpisodeRollupPlan, offset: number): string {
  const latest = plan.source_digests.reduce((current, source) => {
    const timestamp = Date.parse(source.updated_at);
    return Number.isFinite(timestamp) ? Math.max(current, timestamp) : current;
  }, 0);
  if (latest === 0) throw new Error("Episode Rollup plan has no valid source timestamp");
  const timestamp = latest + offset + 1;
  if (!Number.isSafeInteger(timestamp)) throw new Error("Episode Rollup event timestamp is outside the safe range");
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new Error("Episode Rollup event timestamp is outside the valid range");
  return date.toISOString();
}

export function buildEpisodeRollupEvents(plan: EpisodeRollupPlan): MorynEvent[] {
  assertReadyPlan(plan);
  const upsert: MorynEvent = {
    event_id: `evt_${plan.plan_id}_rollup`,
    op: "upsert_record",
    record: plan.rollup_record,
    created_at: eventTimestamp(plan, 0),
    source: TRANSACTION_SOURCE
  };
  const archives = uniqueSorted(plan.cold_candidates.map((candidate) => candidate.record_id)).map(
    (recordId, index): MorynEvent => ({
      event_id: archiveEventId(plan.plan_id, recordId),
      op: "archive_record",
      record_id: recordId,
      reason: `Episode Rollup ${plan.plan_id}: old source fully covered by ${plan.rollup_record.id}`,
      created_at: eventTimestamp(plan, index + 1),
      source: TRANSACTION_SOURCE
    })
  );
  const events = [upsert, ...archives];
  if (new Set(events.map((event) => event.event_id)).size !== events.length) {
    throw new Error("Episode Rollup generated duplicate event ids");
  }
  return events;
}

function receiptPath(storePath: string, planId: string): string {
  assertPlanId(planId);
  return join(storePath, "state", "episode-rollup", `${planId}.json`);
}

type EpisodeRollupReceiptPayload = Omit<EpisodeRollupReceipt, "integrity_digest">;

function receiptIntegrityDigest(receipt: EpisodeRollupReceiptPayload): string {
  return digest(receipt);
}

function parseReceipt(value: unknown): EpisodeRollupReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Partial<EpisodeRollupReceipt>;
  if (
    receipt.version !== 1 ||
    receipt.status !== "committed" ||
    typeof receipt.plan_id !== "string" ||
    typeof receipt.project_id !== "string" ||
    !["day", "task", "project_epoch"].includes(receipt.bucket_kind ?? "") ||
    typeof receipt.bucket_key !== "string" ||
    typeof receipt.source_digest !== "string" ||
    typeof receipt.observation_digest !== "string" ||
    !Array.isArray(receipt.source_record_ids) ||
    !Array.isArray(receipt.archived_source_record_ids) ||
    !Array.isArray(receipt.preserved_warm_record_ids) ||
    typeof receipt.rollup_record_id !== "string" ||
    !Array.isArray(receipt.event_ids) ||
    !receipt.durability ||
    typeof receipt.completed_at !== "string" ||
    typeof receipt.integrity_digest !== "string"
  ) {
    return undefined;
  }
  const sourceRecordIds = receipt.source_record_ids as string[];
  const archivedSourceRecordIds = receipt.archived_source_record_ids as string[];
  const preservedWarmRecordIds = receipt.preserved_warm_record_ids as string[];
  const eventIds = receipt.event_ids as string[];
  const stringArrays = [sourceRecordIds, archivedSourceRecordIds, preservedWarmRecordIds, eventIds];
  if (stringArrays.some((values) => values.some((value) => typeof value !== "string" || !value.trim()))) {
    return undefined;
  }
  try {
    assertPlanId(receipt.plan_id);
    if (!receipt.project_id.trim() || !receipt.bucket_key.trim()) return undefined;
    if (!/^[a-f0-9]{64}$/u.test(receipt.source_digest) || !/^[a-f0-9]{64}$/u.test(receipt.observation_digest)) {
      return undefined;
    }
    if (
      sourceRecordIds.length === 0 ||
      archivedSourceRecordIds.length === 0 ||
      stringArrays.slice(0, 3).some((values) => JSON.stringify(values) !== JSON.stringify(uniqueSorted(values)))
    ) {
      return undefined;
    }
    if (archivedSourceRecordIds.some((recordId) => !sourceRecordIds.includes(recordId))) {
      return undefined;
    }
    if (preservedWarmRecordIds.some((recordId) => archivedSourceRecordIds.includes(recordId))) {
      return undefined;
    }
    if (receipt.rollup_record_id !== `rec_${receipt.plan_id}`) return undefined;
    if (JSON.stringify(eventIds) !== JSON.stringify(expectedEventIds(receipt.plan_id, archivedSourceRecordIds))) {
      return undefined;
    }
    assertEventDurabilityAttestation(receipt.durability, eventIds, "Episode Rollup receipt");
    if (!validCanonicalIso(receipt.completed_at)) return undefined;
    const payload: EpisodeRollupReceiptPayload = {
      version: 1,
      status: "committed",
      plan_id: receipt.plan_id,
      project_id: receipt.project_id,
      bucket_kind: receipt.bucket_kind!,
      bucket_key: receipt.bucket_key,
      source_digest: receipt.source_digest,
      observation_digest: receipt.observation_digest,
      source_record_ids: sourceRecordIds,
      archived_source_record_ids: archivedSourceRecordIds,
      preserved_warm_record_ids: preservedWarmRecordIds,
      rollup_record_id: receipt.rollup_record_id,
      event_ids: eventIds,
      durability: receipt.durability,
      completed_at: receipt.completed_at
    };
    if (receipt.integrity_digest !== receiptIntegrityDigest(payload)) return undefined;
    return { ...payload, integrity_digest: receipt.integrity_digest };
  } catch {
    return undefined;
  }
}

function validCanonicalIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export async function readEpisodeRollupReceipt(
  storePath: string,
  planId: string
): Promise<EpisodeRollupReceipt | undefined> {
  try {
    const parsed = parseReceipt(JSON.parse(await readFile(receiptPath(storePath, planId), "utf8")));
    return parsed?.plan_id === planId ? parsed : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeEpisodeRollupReceipt(storePath: string, receipt: EpisodeRollupReceipt): Promise<void> {
  const validated = parseReceipt(receipt);
  if (!validated) throw new Error("Invalid Episode Rollup receipt");
  const path = receiptPath(storePath, validated.plan_id);
  const directory = dirname(path);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function publishedEventIds(expected: readonly MorynEvent[], existing: readonly MorynEvent[]): Set<string> {
  const expectedById = new Map(expected.map((event) => [event.event_id, event]));
  const published = new Set<string>();
  for (const event of existing) {
    const expectedEvent = expectedById.get(event.event_id);
    if (!expectedEvent) continue;
    if (!sameEvent(event, expectedEvent)) throw new Error(`Episode Rollup event id collision: ${event.event_id}`);
    published.add(event.event_id);
  }
  return published;
}

async function assertFreshPlan(
  plan: EpisodeRollupPlan,
  expectedEvents: readonly MorynEvent[],
  currentEvents: readonly MorynEvent[]
): Promise<void> {
  const ownEventIds = new Set(expectedEvents.map((event) => event.event_id));
  const originalRecords = [
    ...replayEvents(currentEvents.filter((event) => !ownEventIds.has(event.event_id)) as MorynEvent[]).values()
  ];
  const current = planEpisodeRollup(originalRecords, plan.identity, plan.policy);
  if (!current || !sameValue(current, plan)) {
    throw new Error("Stale Episode Rollup plan: source rollups changed; create a new plan before applying");
  }
}

function findRecord(records: readonly MorynRecord[], recordId: string): MorynRecord | undefined {
  return records.find((record) => record.id === recordId);
}

async function assertRollupReadback(
  storePath: string,
  rollup: EpisodeRollupRecord,
  readRecords: typeof readCurrentRecords
): Promise<void> {
  const published = findRecord((await readRecords(storePath)).records, rollup.id);
  if (!published || !sameValue(published, rollup)) {
    throw new Error("Episode Rollup publication readback failed; no sources were archived");
  }
}

async function assertFinalReadback(
  storePath: string,
  plan: EpisodeRollupPlan & { rollup_record: EpisodeRollupRecord },
  readRecords: typeof readCurrentRecords
): Promise<void> {
  const records = (await readRecords(storePath)).records;
  const rollup = findRecord(records, plan.rollup_record.id);
  if (!rollup || !sameValue(rollup, plan.rollup_record)) {
    throw new Error("Episode Rollup final readback failed: rollup record is missing or changed");
  }
  for (const candidate of plan.cold_candidates) {
    const source = findRecord(records, candidate.record_id);
    if (source?.state !== "archived" || source.visibility !== "archived") {
      throw new Error(`Episode Rollup final readback failed: source was not archived: ${candidate.record_id}`);
    }
  }
}

function durabilityCounts(results: readonly AppendEventIfAbsentResult[]): EpisodeRollupApplyResult["durability"] {
  return {
    confirmed: results.filter((result) => result.durability === "confirmed").length,
    best_effort: results.filter((result) => result.durability === "best_effort").length,
    failed: results.filter((result) => result.durability === "failed").length
  };
}

function assertReceiptMatchesPlan(
  receipt: EpisodeRollupReceipt,
  plan: EpisodeRollupPlan & { rollup_record: EpisodeRollupRecord },
  events: readonly MorynEvent[]
): void {
  if (
    receipt.plan_id !== plan.plan_id ||
    receipt.project_id !== plan.identity.project_id ||
    receipt.bucket_kind !== plan.identity.bucket_kind ||
    receipt.bucket_key !== plan.identity.bucket_key ||
    receipt.source_digest !== plan.source_digest ||
    receipt.observation_digest !== plan.observation_digest ||
    !sameValue(receipt.source_record_ids, uniqueSorted(plan.source_record_ids)) ||
    !sameValue(
      receipt.archived_source_record_ids,
      uniqueSorted(plan.cold_candidates.map((candidate) => candidate.record_id))
    ) ||
    !sameValue(
      receipt.preserved_warm_record_ids,
      uniqueSorted(plan.warm_candidates.map((candidate) => candidate.record_id))
    ) ||
    receipt.rollup_record_id !== plan.rollup_record.id ||
    !sameValue(
      receipt.event_ids,
      events.map((event) => event.event_id)
    ) ||
    receipt.completed_at !== events.at(-1)!.created_at
  ) {
    throw new Error("Episode Rollup receipt plan collision");
  }
}

async function appendChecked(
  storePath: string,
  event: MorynEvent,
  append: typeof appendEventIfAbsent
): Promise<AppendEventIfAbsentResult> {
  const result = await append(storePath, event);
  if (!sameEvent(result.event, event)) throw new Error(`Episode Rollup event id collision: ${event.event_id}`);
  if (result.durability === "failed") throw new Error(`Episode Rollup event durability failed: ${event.event_id}`);
  return result;
}

export async function applyEpisodeRollupPlan(
  storePath: string,
  plan: EpisodeRollupPlan,
  deps: EpisodeRollupTransactionDeps = {}
): Promise<EpisodeRollupApplyResult> {
  assertReadyPlan(plan);
  const events = buildEpisodeRollupEvents(plan);
  const readStoreEvents = deps.read_events ?? readEvents;
  const readRecords = deps.read_records ?? readCurrentRecords;
  const append = deps.append_event ?? appendEventIfAbsent;
  let currentEvents = await readStoreEvents(storePath);
  let published = publishedEventIds(events, currentEvents);
  const upsert = events[0]!;
  if (!published.has(upsert.event_id) && events.slice(1).some((event) => published.has(event.event_id))) {
    throw new Error("Invalid Episode Rollup partial transaction: archive event exists without rollup publication");
  }
  await assertFreshPlan(plan, events, currentEvents);

  const priorReceipt = await readEpisodeRollupReceipt(storePath, plan.plan_id);
  if (priorReceipt) {
    assertReceiptMatchesPlan(priorReceipt, plan, events);
    if (published.size !== events.length) {
      throw new Error("Episode Rollup receipt event readback failed");
    }
    await assertFinalReadback(storePath, plan, readRecords);
    return {
      receipt: priorReceipt,
      created_event_ids: [],
      existing_event_ids: events.map((event) => event.event_id),
      durability: durabilityCounts([])
    };
  }

  const appendResults: AppendEventIfAbsentResult[] = [];
  if (!published.has(upsert.event_id)) appendResults.push(await appendChecked(storePath, upsert, append));

  currentEvents = await readStoreEvents(storePath);
  published = publishedEventIds(events, currentEvents);
  if (!published.has(upsert.event_id)) {
    throw new Error("Episode Rollup publication incomplete; no sources were archived");
  }
  await assertRollupReadback(storePath, plan.rollup_record, readRecords);
  await assertFreshPlan(plan, events, currentEvents);

  for (const event of events.slice(1)) {
    currentEvents = await readStoreEvents(storePath);
    published = publishedEventIds(events, currentEvents);
    await assertFreshPlan(plan, events, currentEvents);
    if (!published.has(event.event_id)) appendResults.push(await appendChecked(storePath, event, append));
  }

  currentEvents = await readStoreEvents(storePath);
  published = publishedEventIds(events, currentEvents);
  if (published.size !== events.length) {
    throw new Error("Episode Rollup event publication incomplete; retry before writing a receipt");
  }
  await assertFinalReadback(storePath, plan, readRecords);
  await (deps.rebuild ?? rebuildDerivedViews)(storePath);

  const archivedIds = uniqueSorted(plan.cold_candidates.map((candidate) => candidate.record_id));
  const warmIds = uniqueSorted(plan.warm_candidates.map((candidate) => candidate.record_id));
  const receiptPayload: EpisodeRollupReceiptPayload = {
    version: 1,
    status: "committed",
    plan_id: plan.plan_id,
    project_id: plan.identity.project_id,
    bucket_kind: plan.identity.bucket_kind,
    bucket_key: plan.identity.bucket_key,
    source_digest: plan.source_digest,
    observation_digest: plan.observation_digest,
    source_record_ids: uniqueSorted(plan.source_record_ids),
    archived_source_record_ids: archivedIds,
    preserved_warm_record_ids: warmIds,
    rollup_record_id: plan.rollup_record.id,
    event_ids: events.map((event) => event.event_id),
    durability: createEventDurabilityAttestation({
      event_ids: events.map((event) => event.event_id),
      append_results: appendResults
    }),
    completed_at: events.at(-1)!.created_at
  };
  const receipt: EpisodeRollupReceipt = {
    ...receiptPayload,
    integrity_digest: receiptIntegrityDigest(receiptPayload)
  };
  await (deps.write_receipt ?? writeEpisodeRollupReceipt)(storePath, receipt);

  const createdIds = new Set(appendResults.filter((result) => result.created).map((result) => result.event.event_id));
  return {
    receipt,
    created_event_ids: events.map((event) => event.event_id).filter((eventId) => createdIds.has(eventId)),
    existing_event_ids: events.map((event) => event.event_id).filter((eventId) => !createdIds.has(eventId)),
    durability: durabilityCounts(appendResults)
  };
}
