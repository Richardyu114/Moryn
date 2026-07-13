import { createHash } from "node:crypto";
import { rebuildDerivedViews } from "./derived.js";
import { learningDeltaSchema, type LearningDelta } from "./context-delta.js";
import { readCurrentRecords } from "./record-read-model.js";
import { appendEventIfAbsent } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export interface QueueLearningInput {
  project_id?: string;
  question: unknown;
  conclusion: unknown;
  evidence_type: unknown;
  scope?: unknown;
  confidence?: unknown;
  valid_until?: unknown;
  recommended_kind?: unknown;
  recommended_type?: unknown;
  related_record_ids?: unknown;
  current_task?: unknown;
  source: RecordSource;
  occurred_at: string;
}

export interface LearningInboxRecord extends MorynRecord {
  kind: "agent_note";
  type: "learning_inbox";
  content: MorynRecord["content"] & {
    learning_inbox_version: 1;
    status: "pending" | "consumed";
    learning_fingerprint: string;
    learning_delta: LearningDelta;
    current_task?: string;
    consumed_at?: string;
    consumed_by_record_id?: string;
    produced_record_ids?: string[];
  };
}

function canonicalLearning(learning: LearningDelta): string {
  return JSON.stringify({
    question: learning.question,
    conclusion: learning.conclusion,
    evidence_type: learning.evidence_type,
    scope: learning.scope,
    confidence: learning.confidence,
    valid_until: learning.valid_until ?? null,
    recommended_kind: learning.recommended_kind,
    recommended_type: learning.recommended_type,
    related_record_ids: [...learning.related_record_ids].sort()
  });
}

function parseTimestamp(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new Error(`Invalid argument: ${name} must be a canonical ISO timestamp`);
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid argument: ${name} must be a non-empty string`);
  return value.trim();
}

function normalizedLearning(input: QueueLearningInput): LearningDelta {
  return learningDeltaSchema.parse({
    question: input.question,
    conclusion: input.conclusion,
    evidence_type: input.evidence_type,
    scope: input.scope ?? "project",
    confidence: input.confidence ?? 0.8,
    ...(input.valid_until !== undefined ? { valid_until: input.valid_until } : {}),
    recommended_kind: input.recommended_kind ?? "memory",
    recommended_type: input.recommended_type ?? "fact",
    related_record_ids: input.related_record_ids ?? []
  });
}

export function learningInboxIdentity(input: { project_id?: string; learning: LearningDelta }) {
  const digest = createHash("sha256").update(JSON.stringify({ project_id: input.project_id ?? null, learning: canonicalLearning(input.learning) })).digest("hex");
  return { digest, record_id: `rec_learning_inbox_${digest.slice(0, 32)}`, event_id: `evt_learning_inbox_${digest.slice(0, 32)}` };
}

export async function queueLearning(storePath: string, input: QueueLearningInput) {
  const occurredAt = parseTimestamp(input.occurred_at, "occurred_at");
  const learning = normalizedLearning(input);
  if (learning.scope === "project" && !input.project_id) throw new Error("Invalid argument: project learning requires project_id");
  const identity = learningInboxIdentity({ project_id: input.project_id, learning });
  const currentTask = optionalText(input.current_task, "current_task");
  const record: LearningInboxRecord = {
    id: identity.record_id,
    kind: "agent_note",
    type: "learning_inbox",
    scope: learning.scope === "project" ? "project" : learning.scope,
    ...(learning.scope === "project" ? { project_id: input.project_id } : {}),
    tags: ["learning", "learning-inbox", "pending"],
    content: {
      format: "json",
      text: `Pending learning: ${learning.conclusion}`,
      learning_inbox_version: 1,
      status: "pending",
      learning_fingerprint: identity.digest,
      learning_delta: learning,
      ...(currentTask ? { current_task: currentTask } : {})
    },
    state: "candidate",
    confidence: learning.confidence,
    priority: "normal",
    visibility: "active",
    created_at: occurredAt,
    updated_at: occurredAt,
    source: input.source,
    provenance: { method: "agent-proposed", reason: learning.question }
  };
  const event: MorynEvent = { event_id: identity.event_id, op: "upsert_record", record, created_at: occurredAt, source: input.source };
  const appended = await appendEventIfAbsent(storePath, event);
  if (appended.event.op !== "upsert_record" || appended.event.record.id !== identity.record_id) throw new Error(`Learning inbox idempotency collision: ${identity.event_id}`);
  if (appended.created) await rebuildDerivedViews(storePath);
  return { created: appended.created, record: appended.event.record as LearningInboxRecord, durability: appended.durability };
}

function isLearningInboxRecord(record: MorynRecord): record is LearningInboxRecord {
  return record.kind === "agent_note" && record.type === "learning_inbox" && record.content.learning_inbox_version === 1 && (record.content.status === "pending" || record.content.status === "consumed");
}

export async function pendingLearningInbox(storePath: string, input: { project_id?: string; session_id?: string; include_consumed?: boolean; limit?: number }) {
  const limit = Math.max(1, Math.min(20, input.limit ?? 20));
  const records = (await readCurrentRecords(storePath)).records
    .filter(isLearningInboxRecord)
    .filter((record) => input.include_consumed === true || record.content.status === "pending")
    .filter((record) => record.scope !== "project" || record.project_id === input.project_id)
    .sort((left, right) => {
      const leftSession = input.session_id && left.source.session_id === input.session_id ? 0 : 1;
      const rightSession = input.session_id && right.source.session_id === input.session_id ? 0 : 1;
      return leftSession - rightSession || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
    });
  return records.slice(0, limit);
}

export async function learningInboxForLifecycle(storePath: string, input: { project_id: string; session_id?: string; consumed_by_record_id: string; limit?: number }) {
  const records = await pendingLearningInbox(storePath, { project_id: input.project_id, session_id: input.session_id, include_consumed: true, limit: 20 });
  return records
    .filter((record) => record.content.status === "pending" || record.content.consumed_by_record_id === input.consumed_by_record_id)
    .slice(0, Math.max(1, Math.min(20, input.limit ?? 20)));
}

function revisionEventId(recordId: string, consumedBy: string): string {
  return `evt_learning_inbox_consumed_${createHash("sha256").update(`${recordId}\u0000${consumedBy}`).digest("hex").slice(0, 32)}`;
}

function linkEventId(recordId: string, linkedRecordId: string, linkType: string): string {
  return `evt_learning_inbox_link_${createHash("sha256").update(`${recordId}\u0000${linkedRecordId}\u0000${linkType}`).digest("hex").slice(0, 32)}`;
}

export async function consumeLearningInbox(storePath: string, input: { inbox_records: LearningInboxRecord[]; consumed_at: string; consumed_by_record_id: string; produced_record_ids: string[]; source: RecordSource }) {
  const requestedConsumedAt = parseTimestamp(input.consumed_at, "consumed_at");
  const current = new Map((await readCurrentRecords(storePath)).records.map((record) => [record.id, record]));
  let consumed = 0;
  let alreadyConsumed = 0;
  for (const candidate of input.inbox_records) {
    const record = current.get(candidate.id);
    if (!record || !isLearningInboxRecord(record)) throw new Error(`Learning inbox record not found: ${candidate.id}`);
    if (record.content.status === "consumed") {
      alreadyConsumed += 1;
      continue;
    }
    const consumedAt = new Date(Math.max(Date.parse(requestedConsumedAt), Date.parse(record.updated_at) + 1)).toISOString();
    const revision: MorynEvent = {
      event_id: revisionEventId(record.id, input.consumed_by_record_id),
      op: "revise_record",
      record_id: record.id,
      patch: {
        "content.status": "consumed",
        "content.consumed_at": consumedAt,
        "content.consumed_by_record_id": input.consumed_by_record_id,
        "content.produced_record_ids": [...new Set(input.produced_record_ids)].sort(),
        "tags": ["consumed", "learning", "learning-inbox"]
      },
      reason: "Learning Inbox consumed by lifecycle capture",
      created_at: consumedAt,
      source: input.source
    };
    await appendEventIfAbsent(storePath, revision);
    for (const [linkedRecordId, linkType] of [[input.consumed_by_record_id, "consumed_by"], ...input.produced_record_ids.map((id) => [id, "produced"])] as Array<[string, string]>) {
      await appendEventIfAbsent(storePath, {
        event_id: linkEventId(record.id, linkedRecordId, linkType),
        op: "link_records",
        record_id: record.id,
        linked_record_id: linkedRecordId,
        link_type: linkType,
        reason: "Learning Inbox lifecycle evidence",
        created_at: consumedAt,
        source: input.source
      });
    }
    consumed += 1;
  }
  if (consumed > 0) await rebuildDerivedViews(storePath);
  return { consumed, already_consumed: alreadyConsumed, inbox_record_ids: input.inbox_records.map((record) => record.id) };
}
