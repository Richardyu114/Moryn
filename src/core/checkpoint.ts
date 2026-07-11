import { createHash } from "node:crypto";
import { validateContextDelta, type ContextDelta, type ContextDeltaInput } from "./context-delta.js";
import { isPrivateTags } from "./sensitive.js";
import type { MorynRecord, RecordSource } from "./types.js";

export interface CheckpointInput {
  project_id: string;
  source: RecordSource;
  occurred_at: string;
  delta: ContextDeltaInput;
  tags?: string[];
  include_private?: boolean;
}

export interface RecoveryPack {
  version: 1;
  available: boolean;
  bounded: true;
  project_id: string;
  session_id: string;
  latest_checkpoint_id?: string;
  latest_occurred_at?: string;
  source_record_ids: string[];
  checkpoint_count: number;
  current_task?: string;
  progress?: string[];
  decisions?: string[];
  changed_facts?: string[];
  blockers?: string[];
  next_steps?: string[];
  files?: string[];
  candidate_memories?: string[];
  candidate_skills?: string[];
  learnings?: ContextDelta["learnings"];
}

export interface CheckpointRecoveryPackInput {
  project_id: string;
  session_id: string;
  include_private?: boolean;
  limit?: number;
}

export interface CheckpointResult {
  record: MorynRecord;
  idempotent_replay: boolean;
  committed: true;
  durability: "confirmed" | "best_effort" | "failed";
  derived_views_refreshed: boolean;
  warnings?: Array<{ code: "DERIVED_VIEW_REBUILD_FAILED" | "IDEMPOTENT_EVENT_DIRECTORY_SYNC_UNSUPPORTED" | "IDEMPOTENT_EVENT_DIRECTORY_SYNC_FAILED" | "IDEMPOTENT_EVENT_DIRECTORY_CLOSE_FAILED" | "IDEMPOTENT_EVENT_TEMP_CLEANUP_FAILED"; reason: string }>;
  recovery_pack: RecoveryPack;
}

export interface NormalizedCheckpointInput {
  project_id: string;
  source: RecordSource & { session_id: string };
  occurred_at: string;
  delta: ContextDelta;
  tags: string[];
  include_private: boolean;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

export function checkpointIdentity(input: Pick<NormalizedCheckpointInput, "project_id" | "source" | "delta">): { event_id: string; record_id: string } {
  const key = JSON.stringify({
    version: 1,
    project_id: input.project_id,
    client: input.source.client,
    session_id: input.source.session_id,
    checkpoint_id: input.delta.checkpoint_id
  });
  const digest = createHash("sha256").update(key).digest("hex");
  return { event_id: `evt_checkpoint_${digest}`, record_id: `rec_checkpoint_${digest}` };
}

export function checkpointPayloadDigest(input: NormalizedCheckpointInput): string {
  return sha256({
    version: 1,
    project_id: input.project_id,
    source: input.source,
    occurred_at: input.occurred_at,
    delta: input.delta,
    tags: input.tags
  });
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid argument: ${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function normalizeCheckpointInput(input: CheckpointInput): NormalizedCheckpointInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid argument: checkpoint input must be an object");
  const projectId = requiredString(input.project_id, "project_id");
  if (!input.source || typeof input.source !== "object" || Array.isArray(input.source)) throw new Error("Invalid argument: source must be an object");
  const source = {
    client: requiredString(input.source.client, "source.client"),
    session_id: requiredString(input.source.session_id, "source.session_id"),
    model: optionalString(input.source.model),
    device_id: optionalString(input.source.device_id)
  };
  if (!source.device_id) throw new Error("Invalid argument: source.device_id must be a non-empty string");
  const occurredAt = requiredString(input.occurred_at, "occurred_at");
  if (!Number.isFinite(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt) {
    throw new Error("Invalid argument: occurred_at must be a canonical ISO timestamp");
  }
  const delta = validateContextDelta(input.delta);
  if (source.session_id !== delta.session_id) throw new Error("Invalid argument: source.session_id must equal delta.session_id");
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string"))) {
    throw new Error("Invalid argument: tags must be an array of strings");
  }
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  for (const tag of ["checkpoint", `session:${delta.session_id}`, `checkpoint:${delta.checkpoint_id}`]) {
    if (!tags.includes(tag)) tags.push(tag);
  }
  tags.sort(compareCodeUnits);
  return { project_id: projectId, source, occurred_at: occurredAt, delta, tags, include_private: input.include_private === true };
}

export function matchesCheckpoint(record: MorynRecord, input: NormalizedCheckpointInput): boolean {
  const checkpoint = parseCheckpointContent(record.content);
  return record.visibility === "active"
    && record.state !== "archived"
    && record.state !== "quarantined"
    && record.kind === "session_summary"
    && record.type === "checkpoint"
    && record.scope === "project"
    && record.project_id === input.project_id
    && record.source.client === input.source.client
    && record.source.session_id === input.source.session_id
    && checkpoint?.checkpoint_id === input.delta.checkpoint_id
    && checkpoint.session_id === input.delta.session_id;
}

export function parseCheckpointContent(content: MorynRecord["content"]): ContextDelta | undefined {
  if (content.checkpoint_version !== 1) return undefined;
  try {
    return validateContextDelta(content.checkpoint);
  } catch {
    return undefined;
  }
}

export function matchesCheckpointPayload(record: MorynRecord, input: NormalizedCheckpointInput): boolean {
  const checkpoint = parseCheckpointContent(record.content);
  return Boolean(checkpoint)
    && record.content.checkpoint_payload_digest === checkpointPayloadDigest(input)
    && JSON.stringify(canonicalValue(checkpoint)) === JSON.stringify(canonicalValue(input.delta))
    && record.project_id === input.project_id
    && record.created_at === input.occurred_at
    && JSON.stringify(canonicalValue(record.source)) === JSON.stringify(canonicalValue(input.source));
}

export function checkpointSummary(delta: ContextDelta): string {
  const parts = [delta.current_task ? `Task: ${delta.current_task}` : undefined, delta.progress.length ? `Progress: ${delta.progress.join("; ")}` : undefined];
  return parts.filter(Boolean).join(" | ");
}

function appendExactBounded(target: string[], values: string[], limit = 10): void {
  for (const value of values) {
    if (!target.includes(value) && target.length < limit) target.push(value);
  }
}

function checkpointOrder(left: MorynRecord, right: MorynRecord): number {
  return compareCodeUnits(left.created_at, right.created_at)
    || compareCodeUnits(left.updated_at, right.updated_at)
    || compareCodeUnits(left.id, right.id);
}

function canonicalLearning(learning: ContextDelta["learnings"][number]): unknown {
  return canonicalValue({ ...learning, related_record_ids: [...learning.related_record_ids].sort(compareCodeUnits) });
}

export function buildCheckpointRecoveryPack(records: readonly MorynRecord[], input: CheckpointRecoveryPackInput): RecoveryPack {
  const limit = Number.isInteger(input.limit) && (input.limit as number) > 0 ? input.limit as number : 5;
  const candidates = records
    .filter((record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined")
    .filter((record) => record.kind === "session_summary" && record.type === "checkpoint" && record.scope === "project")
    .filter((record) => record.project_id === input.project_id)
    .map((record) => ({ record, checkpoint: parseCheckpointContent(record.content) }))
    .filter((candidate): candidate is { record: MorynRecord; checkpoint: ContextDelta } => Boolean(candidate.checkpoint))
    .filter(({ checkpoint }) => checkpoint.session_id === input.session_id)
    .sort((left, right) => checkpointOrder(left.record, right.record))
    .slice(-limit);
  const visible = candidates.filter(({ record }) => input.include_private === true || !isPrivateTags(record.tags));
  const latest = visible.at(-1);
  const base: RecoveryPack = {
    version: 1,
    available: visible.length > 0,
    bounded: true,
    project_id: input.project_id,
    session_id: input.session_id,
    ...(latest ? { latest_checkpoint_id: latest.checkpoint.checkpoint_id, latest_occurred_at: latest.record.created_at } : {}),
    source_record_ids: candidates.map(({ record }) => record.id),
    checkpoint_count: candidates.length
  };
  if (!visible.length) return base;

  const progress: string[] = [];
  const decisions: string[] = [];
  const changedFacts: string[] = [];
  const files: string[] = [];
  const candidateMemories: string[] = [];
  const candidateSkills: string[] = [];
  const learnings: ContextDelta["learnings"] = [];
  const learningKeys = new Set<string>();
  for (const { checkpoint } of visible) {
    appendExactBounded(progress, checkpoint.progress);
    appendExactBounded(decisions, checkpoint.decisions);
    appendExactBounded(changedFacts, checkpoint.changed_facts);
    appendExactBounded(files, checkpoint.files);
    appendExactBounded(candidateMemories, checkpoint.candidate_memories);
    appendExactBounded(candidateSkills, checkpoint.candidate_skills);
    for (const learning of checkpoint.learnings) {
      const key = JSON.stringify(canonicalLearning(learning));
      if (!learningKeys.has(key) && learnings.length < 10) {
        learningKeys.add(key);
        learnings.push(learning);
      }
    }
  }
  const latestVisible = visible.at(-1)?.checkpoint;
  const currentTask = [...visible].reverse().find(({ checkpoint }) => checkpoint.current_task)?.checkpoint.current_task;
  return {
    ...base,
    ...(currentTask ? { current_task: currentTask } : {}),
    progress,
    decisions,
    changed_facts: changedFacts,
    blockers: latestVisible?.blockers ?? [],
    next_steps: latestVisible?.next_steps ?? [],
    files,
    candidate_memories: candidateMemories,
    candidate_skills: candidateSkills,
    learnings
  };
}

export function recoveryPack(record: MorynRecord, includePrivate: boolean): RecoveryPack {
  return buildCheckpointRecoveryPack([record], {
    project_id: record.project_id ?? "",
    session_id: parseCheckpointContent(record.content)?.session_id ?? record.source.session_id ?? "",
    include_private: includePrivate
  });
}
