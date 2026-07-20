import { chmod, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  applyEpisodeRollupPlan,
  buildEpisodeRollupEvents,
  type EpisodeRollupApplyResult,
  type EpisodeRollupReceipt
} from "./episode-rollup-transaction.js";
import {
  assertEventDurabilityAttestation,
  type EventDurabilityAttestation,
  mergeEventDurabilityAttestations
} from "./event-durability-attestation.js";
import {
  assertMemoryCompactionPlanEnvelope,
  type MemoryCompactionKind,
  type MemoryCompactionPlanEnvelope,
  type MemoryCompactionSourceBeforeState,
  memoryCompactionDigest,
  memoryCompactionRecordDigest,
  sameMemoryCompactionValue
} from "./memory-compaction.js";
import { readCurrentRecords } from "./record-read-model.js";
import {
  applySessionFoldPlan,
  buildSessionFoldEvents,
  type SessionFoldApplyResult,
  type SessionFoldReceipt
} from "./session-fold-transaction.js";
import { readEvents } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export interface MemoryCompactionChildReceiptReference {
  kind: MemoryCompactionKind;
  plan_id: string;
  receipt_id: string;
  integrity_digest: string;
  rollup_record_id: string;
  event_ids: string[];
  durability: EventDurabilityAttestation;
  completed_at: string;
}

export interface MemoryCompactionSourceTransitionReceipt {
  record_id: string;
  before_state: MemoryCompactionSourceBeforeState["state"];
  before_visibility: MemoryCompactionSourceBeforeState["visibility"];
  before_trust_state: MemoryCompactionSourceBeforeState["trust_state"];
  before_record_digest: string;
  post_apply_record_digest: string;
}

export interface MemoryCompactionDerivedRecordReceipt {
  record_id: string;
  post_apply_record_digest: string;
}

export interface MemoryCompactionReceipt {
  version: 1;
  status: "committed";
  plan_id: string;
  envelope_digest: string;
  project_ids: string[];
  child_receipts: MemoryCompactionChildReceiptReference[];
  source_transitions: MemoryCompactionSourceTransitionReceipt[];
  derived_records: MemoryCompactionDerivedRecordReceipt[];
  event_ids: string[];
  durability: EventDurabilityAttestation;
  completed_at: string;
  purge_performed: false;
  git_history_erased: false;
  integrity_digest: string;
}

export interface MemoryCompactionChildApplySummary {
  kind: MemoryCompactionKind;
  plan_id: string;
  created_event_ids: string[];
  existing_event_ids: string[];
  durability: {
    confirmed: number;
    best_effort: number;
    failed: number;
  };
}

export interface MemoryCompactionApplyResult {
  receipt: MemoryCompactionReceipt;
  child_results: MemoryCompactionChildApplySummary[];
  created_event_ids: string[];
  existing_event_ids: string[];
}

export interface ApplyMemoryCompactionInput {
  plan: MemoryCompactionPlanEnvelope;
  confirmed: boolean;
}

export interface MemoryCompactionApplyDeps {
  apply_session_fold?: typeof applySessionFoldPlan;
  apply_episode_rollup?: typeof applyEpisodeRollupPlan;
  read_records?: typeof readCurrentRecords;
  read_events?: typeof readEvents;
  write_receipt?: typeof writeMemoryCompactionReceipt;
}

type MemoryCompactionReceiptPayload = Omit<MemoryCompactionReceipt, "integrity_digest">;
type ChildApplyResult = SessionFoldApplyResult | EpisodeRollupApplyResult;
type ChildReceipt = SessionFoldReceipt | EpisodeRollupReceipt;

const VALID_TRUST_STATES = new Set(["raw", "candidate", "canonical", "quarantined", "legacy_unknown"]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function validCanonicalIso(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function assertPlanId(planId: string): void {
  if (!/^memory_compaction_[a-f0-9]{32}$/u.test(planId)) {
    throw new Error("Invalid Memory Compaction plan id");
  }
}

function receiptPath(storePath: string, planId: string): string {
  assertPlanId(planId);
  return join(storePath, "state", "memory-compaction", `${planId}.json`);
}

function receiptIntegrityDigest(receipt: MemoryCompactionReceiptPayload): string {
  return memoryCompactionDigest(receipt);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && Boolean(item.trim()));
}

function parseChildReference(value: unknown): MemoryCompactionChildReceiptReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const child = value as Partial<MemoryCompactionChildReceiptReference>;
  if (
    !["session_fold", "episode_rollup"].includes(child.kind ?? "") ||
    typeof child.plan_id !== "string" ||
    typeof child.receipt_id !== "string" ||
    child.receipt_id !== child.plan_id ||
    typeof child.integrity_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(child.integrity_digest) ||
    typeof child.rollup_record_id !== "string" ||
    !child.rollup_record_id.trim() ||
    !isStringArray(child.event_ids) ||
    new Set(child.event_ids).size !== child.event_ids.length ||
    !child.durability ||
    typeof child.completed_at !== "string" ||
    !validCanonicalIso(child.completed_at)
  ) {
    return undefined;
  }
  const expectedPrefix = child.kind === "session_fold" ? "session_fold_" : "episode_rollup_";
  if (!child.plan_id.startsWith(expectedPrefix) || child.rollup_record_id !== `rec_${child.plan_id}`) return undefined;
  try {
    assertEventDurabilityAttestation(child.durability, child.event_ids, "Memory Compaction child receipt");
  } catch {
    return undefined;
  }
  return child as MemoryCompactionChildReceiptReference;
}

function parseSourceTransition(value: unknown): MemoryCompactionSourceTransitionReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const transition = value as Partial<MemoryCompactionSourceTransitionReceipt>;
  if (
    typeof transition.record_id !== "string" ||
    !transition.record_id.trim() ||
    !["raw", "candidate", "canonical"].includes(transition.before_state ?? "") ||
    transition.before_visibility !== "active" ||
    !VALID_TRUST_STATES.has(transition.before_trust_state ?? "") ||
    typeof transition.before_record_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(transition.before_record_digest) ||
    typeof transition.post_apply_record_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(transition.post_apply_record_digest)
  ) {
    return undefined;
  }
  return transition as MemoryCompactionSourceTransitionReceipt;
}

function parseDerivedRecord(value: unknown): MemoryCompactionDerivedRecordReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const derived = value as Partial<MemoryCompactionDerivedRecordReceipt>;
  if (
    typeof derived.record_id !== "string" ||
    !derived.record_id.trim() ||
    typeof derived.post_apply_record_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(derived.post_apply_record_digest)
  ) {
    return undefined;
  }
  return derived as MemoryCompactionDerivedRecordReceipt;
}

function parseReceipt(value: unknown): MemoryCompactionReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Partial<MemoryCompactionReceipt>;
  if (
    receipt.version !== 1 ||
    receipt.status !== "committed" ||
    typeof receipt.plan_id !== "string" ||
    typeof receipt.envelope_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.envelope_digest) ||
    !isStringArray(receipt.project_ids) ||
    !Array.isArray(receipt.child_receipts) ||
    !Array.isArray(receipt.source_transitions) ||
    !Array.isArray(receipt.derived_records) ||
    !isStringArray(receipt.event_ids) ||
    !receipt.durability ||
    typeof receipt.completed_at !== "string" ||
    receipt.purge_performed !== false ||
    receipt.git_history_erased !== false ||
    typeof receipt.integrity_digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.integrity_digest)
  ) {
    return undefined;
  }
  try {
    assertPlanId(receipt.plan_id);
    if (!validCanonicalIso(receipt.completed_at)) return undefined;
    if (receipt.plan_id !== `memory_compaction_${receipt.envelope_digest.slice(0, 32)}`) return undefined;
    const children = receipt.child_receipts.map(parseChildReference);
    const transitions = receipt.source_transitions.map(parseSourceTransition);
    const derived = receipt.derived_records.map(parseDerivedRecord);
    if (
      children.some((item) => !item) ||
      transitions.some((item) => !item) ||
      derived.some((item) => !item) ||
      children.length === 0 ||
      transitions.length === 0 ||
      derived.length === 0
    ) {
      return undefined;
    }
    const parsedChildren = children as MemoryCompactionChildReceiptReference[];
    const parsedTransitions = transitions as MemoryCompactionSourceTransitionReceipt[];
    const parsedDerived = derived as MemoryCompactionDerivedRecordReceipt[];
    const sortedProjects = uniqueSorted(receipt.project_ids);
    if (JSON.stringify(receipt.project_ids) !== JSON.stringify(sortedProjects)) return undefined;
    const childKeys = parsedChildren.map((child) => `${child.kind}\u0000${child.plan_id}`);
    if (new Set(childKeys).size !== childKeys.length) return undefined;
    if (new Set(parsedTransitions.map((item) => item.record_id)).size !== parsedTransitions.length) return undefined;
    if (new Set(parsedDerived.map((item) => item.record_id)).size !== parsedDerived.length) return undefined;
    if (new Set(receipt.event_ids).size !== receipt.event_ids.length) return undefined;
    const expectedEventIds = parsedChildren.flatMap((child) => child.event_ids);
    if (JSON.stringify(receipt.event_ids) !== JSON.stringify(expectedEventIds)) return undefined;
    assertEventDurabilityAttestation(receipt.durability, receipt.event_ids, "Memory Compaction receipt");
    if (
      !sameMemoryCompactionValue(
        receipt.durability,
        mergeEventDurabilityAttestations(
          receipt.event_ids,
          parsedChildren.map((child) => child.durability)
        )
      )
    ) {
      return undefined;
    }
    const payload: MemoryCompactionReceiptPayload = {
      version: 1,
      status: "committed",
      plan_id: receipt.plan_id,
      envelope_digest: receipt.envelope_digest,
      project_ids: receipt.project_ids,
      child_receipts: parsedChildren,
      source_transitions: parsedTransitions,
      derived_records: parsedDerived,
      event_ids: receipt.event_ids,
      durability: receipt.durability,
      completed_at: receipt.completed_at,
      purge_performed: false,
      git_history_erased: false
    };
    if (receipt.integrity_digest !== receiptIntegrityDigest(payload)) return undefined;
    return { ...payload, integrity_digest: receipt.integrity_digest };
  } catch {
    return undefined;
  }
}

async function readReceiptFile(
  storePath: string,
  planId: string
): Promise<{ exists: boolean; receipt?: MemoryCompactionReceipt }> {
  try {
    return {
      exists: true,
      receipt: parseReceipt(JSON.parse(await readFile(receiptPath(storePath, planId), "utf8")))
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { exists: false };
    return { exists: true };
  }
}

export async function readMemoryCompactionReceipt(
  storePath: string,
  planId: string
): Promise<MemoryCompactionReceipt | undefined> {
  return (await readReceiptFile(storePath, planId)).receipt;
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

export async function writeMemoryCompactionReceipt(storePath: string, receipt: MemoryCompactionReceipt): Promise<void> {
  const validated = parseReceipt(receipt);
  if (!validated) throw new Error("Invalid Memory Compaction receipt");
  const path = receiptPath(storePath, validated.plan_id);
  const directory = dirname(path);
  const existing = await readReceiptFile(storePath, validated.plan_id);
  if (existing.exists) {
    if (!existing.receipt || !sameMemoryCompactionValue(existing.receipt, validated)) {
      throw new Error("Memory Compaction receipt collision or corruption");
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
      const raced = await readReceiptFile(storePath, validated.plan_id);
      if (!raced.receipt || !sameMemoryCompactionValue(raced.receipt, validated)) {
        throw new Error("Memory Compaction receipt collision or corruption");
      }
    }
    await chmod(path, 0o600);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
  const readback = await readMemoryCompactionReceipt(storePath, validated.plan_id);
  if (!readback || !sameMemoryCompactionValue(readback, validated)) {
    throw new Error("Memory Compaction receipt durability readback failed");
  }
}

function assertChildReceipt(
  kind: MemoryCompactionKind,
  planId: string,
  receipt: ChildReceipt
): MemoryCompactionChildReceiptReference {
  if (
    receipt.status !== "committed" ||
    receipt.plan_id !== planId ||
    !/^[a-f0-9]{64}$/u.test(receipt.integrity_digest) ||
    receipt.rollup_record_id !== `rec_${planId}` ||
    receipt.event_ids.length === 0 ||
    new Set(receipt.event_ids).size !== receipt.event_ids.length
  ) {
    throw new Error(`Invalid ${kind} child receipt`);
  }
  return {
    kind,
    plan_id: planId,
    receipt_id: planId,
    integrity_digest: receipt.integrity_digest,
    rollup_record_id: receipt.rollup_record_id,
    event_ids: [...receipt.event_ids],
    durability: { ...receipt.durability },
    completed_at: receipt.completed_at
  };
}

function childSummary(
  kind: MemoryCompactionKind,
  planId: string,
  result: ChildApplyResult
): MemoryCompactionChildApplySummary {
  return {
    kind,
    plan_id: planId,
    created_event_ids: [...result.created_event_ids],
    existing_event_ids: [...result.existing_event_ids],
    durability: { ...result.durability }
  };
}

async function verifyPublishedEvents(
  storePath: string,
  expectedEvents: readonly MorynEvent[],
  readStoreEvents: typeof readEvents
): Promise<void> {
  const expectedById = new Map(expectedEvents.map((event) => [event.event_id, event]));
  const published = new Set<string>();
  for (const event of await readStoreEvents(storePath)) {
    const expected = expectedById.get(event.event_id);
    if (!expected) continue;
    if (!sameMemoryCompactionValue(event, expected)) {
      throw new Error(`Memory Compaction child event collision: ${event.event_id}`);
    }
    published.add(event.event_id);
  }
  const missing = expectedEvents.map((event) => event.event_id).filter((eventId) => !published.has(eventId));
  if (missing.length > 0) {
    throw new Error(`Memory Compaction child event readback failed: ${missing.join(", ")}`);
  }
}

function expectedChildEvents(plan: MemoryCompactionPlanEnvelope): MorynEvent[] {
  const priority = { episode_rollup: 0, session_fold: 1 } satisfies Record<MemoryCompactionKind, number>;
  return [...plan.plans]
    .sort((left, right) => priority[left.kind] - priority[right.kind] || compareCodeUnits(left.plan_id, right.plan_id))
    .flatMap((entry) =>
      entry.kind === "episode_rollup" ? buildEpisodeRollupEvents(entry.plan) : buildSessionFoldEvents(entry.plan)
    );
}

function currentRecord(records: readonly MorynRecord[], recordId: string, label: string): MorynRecord {
  const record = records.find((candidate) => candidate.id === recordId);
  if (!record) throw new Error(`Memory Compaction ${label} readback failed: ${recordId}`);
  return record;
}

function buildReceipt(
  plan: MemoryCompactionPlanEnvelope,
  childReceipts: readonly MemoryCompactionChildReceiptReference[],
  records: readonly MorynRecord[]
): MemoryCompactionReceipt {
  const sourceStates = plan.plans
    .flatMap((entry) => entry.source_before_states)
    .sort((left, right) => compareCodeUnits(left.record_id, right.record_id));
  if (new Set(sourceStates.map((state) => state.record_id)).size !== sourceStates.length) {
    throw new Error("Memory Compaction source transition collision");
  }
  const sourceTransitions = sourceStates.map((state): MemoryCompactionSourceTransitionReceipt => {
    if (state.visibility !== "active" || !["raw", "candidate", "canonical"].includes(state.state)) {
      throw new Error(`Memory Compaction cannot create a reversible transition for ${state.record_id}`);
    }
    const current = currentRecord(records, state.record_id, "source");
    if (current.state !== "archived" || current.visibility !== "archived") {
      throw new Error(`Memory Compaction source archive readback failed: ${state.record_id}`);
    }
    return {
      record_id: state.record_id,
      before_state: state.state,
      before_visibility: state.visibility,
      before_trust_state: state.trust_state,
      before_record_digest: state.record_digest,
      post_apply_record_digest: memoryCompactionRecordDigest(current)
    };
  });
  const derivedRecords = plan.plans
    .map((entry) => entry.derived_record_id)
    .filter((recordId): recordId is string => Boolean(recordId))
    .sort(compareCodeUnits)
    .map((recordId): MemoryCompactionDerivedRecordReceipt => {
      const current = currentRecord(records, recordId, "derived record");
      if (current.state === "archived" || current.visibility !== "active") {
        throw new Error(`Memory Compaction derived record readback failed: ${recordId}`);
      }
      return { record_id: recordId, post_apply_record_digest: memoryCompactionRecordDigest(current) };
    });
  const lastEventAt = childReceipts
    .map((child) => child.completed_at)
    .sort(compareCodeUnits)
    .at(-1)!;
  const eventIds = childReceipts.flatMap((child) => child.event_ids);
  const payload: MemoryCompactionReceiptPayload = {
    version: 1,
    status: "committed",
    plan_id: plan.plan_id,
    envelope_digest: plan.envelope_digest,
    project_ids: uniqueSorted(plan.plans.map((entry) => entry.project_id)),
    child_receipts: [...childReceipts],
    source_transitions: sourceTransitions,
    derived_records: derivedRecords,
    event_ids: eventIds,
    durability: mergeEventDurabilityAttestations(
      eventIds,
      childReceipts.map((child) => child.durability)
    ),
    completed_at: lastEventAt,
    purge_performed: false,
    git_history_erased: false
  };
  return { ...payload, integrity_digest: receiptIntegrityDigest(payload) };
}

function existingApplyResult(receipt: MemoryCompactionReceipt): MemoryCompactionApplyResult {
  return {
    receipt,
    child_results: receipt.child_receipts.map((child) => ({
      kind: child.kind,
      plan_id: child.plan_id,
      created_event_ids: [],
      existing_event_ids: [...child.event_ids],
      durability: { confirmed: 0, best_effort: 0, failed: 0 }
    })),
    created_event_ids: [],
    existing_event_ids: [...receipt.event_ids]
  };
}

export async function applyMemoryCompactionPlan(
  storePath: string,
  input: ApplyMemoryCompactionInput,
  deps: MemoryCompactionApplyDeps = {}
): Promise<MemoryCompactionApplyResult> {
  if (input.confirmed !== true) {
    throw new Error("Memory Compaction apply requires explicit confirmed: true");
  }
  assertMemoryCompactionPlanEnvelope(input.plan);
  const plan = input.plan;
  if (
    plan.status !== "ready" ||
    plan.plans.length === 0 ||
    plan.blockers.length > 0 ||
    plan.plans.some((entry) => entry.status !== "ready")
  ) {
    throw new Error("Memory Compaction plan is not ready to apply");
  }
  const prior = await readReceiptFile(storePath, plan.plan_id);
  const expectedEvents = expectedChildEvents(plan);
  if (prior.exists) {
    if (!prior.receipt) throw new Error("Memory Compaction receipt is corrupt or tampered");
    if (prior.receipt.envelope_digest !== plan.envelope_digest) {
      throw new Error("Memory Compaction receipt plan collision");
    }
    if (
      !sameMemoryCompactionValue(
        prior.receipt.event_ids,
        expectedEvents.map((event) => event.event_id)
      )
    ) {
      throw new Error("Memory Compaction receipt child event mismatch");
    }
    await verifyPublishedEvents(storePath, expectedEvents, deps.read_events ?? readEvents);
    return existingApplyResult(prior.receipt);
  }

  const childReceipts: MemoryCompactionChildReceiptReference[] = [];
  const childResults: MemoryCompactionChildApplySummary[] = [];
  const dispatchOrder = [...plan.plans].sort((left, right) => {
    const priority = { episode_rollup: 0, session_fold: 1 } satisfies Record<MemoryCompactionKind, number>;
    return priority[left.kind] - priority[right.kind] || compareCodeUnits(left.plan_id, right.plan_id);
  });
  for (const entry of dispatchOrder) {
    if (entry.kind === "episode_rollup") {
      const result = await (deps.apply_episode_rollup ?? applyEpisodeRollupPlan)(storePath, entry.plan);
      childReceipts.push(assertChildReceipt(entry.kind, entry.plan_id, result.receipt));
      childResults.push(childSummary(entry.kind, entry.plan_id, result));
    } else {
      const result = await (deps.apply_session_fold ?? applySessionFoldPlan)(storePath, entry.plan);
      childReceipts.push(assertChildReceipt(entry.kind, entry.plan_id, result.receipt));
      childResults.push(childSummary(entry.kind, entry.plan_id, result));
    }
  }
  const eventIds = childReceipts.flatMap((child) => child.event_ids);
  if (
    !sameMemoryCompactionValue(
      eventIds,
      expectedEvents.map((event) => event.event_id)
    )
  ) {
    throw new Error("Memory Compaction child receipt event mismatch");
  }
  await verifyPublishedEvents(storePath, expectedEvents, deps.read_events ?? readEvents);
  const records = (await (deps.read_records ?? readCurrentRecords)(storePath)).records;
  const receipt = buildReceipt(plan, childReceipts, records);
  await (deps.write_receipt ?? writeMemoryCompactionReceipt)(storePath, receipt);
  const persisted = await readMemoryCompactionReceipt(storePath, plan.plan_id);
  if (!persisted || !sameMemoryCompactionValue(persisted, receipt)) {
    throw new Error("Memory Compaction receipt publication readback failed; retry safely");
  }
  const createdEventIds = childResults.flatMap((result) => result.created_event_ids);
  const existingEventIds = childResults.flatMap((result) => result.existing_event_ids);
  return {
    receipt,
    child_results: childResults,
    created_event_ids: createdEventIds,
    existing_event_ids: existingEventIds
  };
}
