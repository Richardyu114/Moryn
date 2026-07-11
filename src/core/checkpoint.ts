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
  checkpoint_id: string;
  source: RecordSource;
  record_ids: string[];
  checkpoint?: ContextDelta;
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

export function recoveryPack(record: MorynRecord, includePrivate: boolean): RecoveryPack {
  const checkpoint = parseCheckpointContent(record.content);
  const available = Boolean(checkpoint) && (includePrivate || !isPrivateTags(record.tags));
  return {
    version: 1,
    available,
    bounded: true,
    project_id: record.project_id as string,
    session_id: checkpoint?.session_id ?? record.source.session_id ?? "",
    checkpoint_id: checkpoint?.checkpoint_id ?? "",
    source: record.source,
    record_ids: [record.id],
    ...(available && checkpoint ? { checkpoint } : {})
  };
}
