import { createHash } from "node:crypto";
import { type ContextDelta, type ContextDeltaInput, validateContextDelta } from "./context-delta.js";
import type { LearningCandidateReviewWorkflow } from "./learning-candidate-review.js";
import type { SemanticConsolidationReceipt } from "./semantic-consolidation.js";
import type { SemanticConsolidationCandidate } from "./semantic-consolidation-candidates.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord, RecordSource } from "./types.js";

export interface LearningSemanticCandidatesReceipt {
  candidates: SemanticConsolidationCandidate[];
  candidates_by_source_record_id: Record<string, SemanticConsolidationCandidate[]>;
  next_action:
    | {
        action: "recall_then_propose_semantic_relationship";
        recall_tool: "recall";
        proposal_tool: "consolidate_semantic";
        relationships: readonly ("duplicate_of" | "revises" | "supersedes" | "conflicts_with")[];
        instruction: string;
      }
    | { action: "none"; reason: "candidate_discovery_failed" };
  selection_sources?: Record<string, string>;
  error?: string;
}

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
  knowledge_investigations?: ContextDelta["knowledge_investigations"];
  semantic_consolidation_proposals?: ContextDelta["semantic_consolidation_proposals"];
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
  warnings?: Array<{
    code:
      | "DERIVED_VIEW_REBUILD_FAILED"
      | "IDEMPOTENT_EVENT_DIRECTORY_SYNC_UNSUPPORTED"
      | "IDEMPOTENT_EVENT_DIRECTORY_SYNC_FAILED"
      | "IDEMPOTENT_EVENT_DIRECTORY_CLOSE_FAILED"
      | "IDEMPOTENT_EVENT_TEMP_CLEANUP_FAILED";
    reason: string;
  }>;
  recovery_pack: RecoveryPack;
  learning_ingestion: {
    learnings_received: number;
    records_created: number;
    evidence_links_created: number;
    dispositions: Array<{
      record_id: string;
      created: boolean;
      state: "canonical" | "candidate";
      requires_confirmation: boolean;
      policy_reason: string;
    }>;
    semantic_candidates: LearningSemanticCandidatesReceipt;
    candidate_review?: LearningCandidateReviewWorkflow;
  };
  semantic_consolidation: SemanticConsolidationReceipt;
  learning_inbox: {
    selected: number;
    consumed: number;
    already_consumed: number;
    inbox_record_ids: string[];
  };
  selection_sources: typeof CHECKPOINT_SELECTION_SOURCES;
}

export const CHECKPOINT_SELECTION_SOURCES = {
  record: "record",
  idempotent_replay: "idempotent_replay",
  committed: "committed",
  durability: "durability",
  derived_views_refreshed: "derived_views_refreshed",
  warning: "warnings[]",
  recovery_pack: "recovery_pack",
  learning_ingestion: "learning_ingestion",
  learning_inbox: "learning_inbox",
  semantic_consolidation: "semantic_consolidation"
} as const;

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
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function checkpointIdentity(input: Pick<NormalizedCheckpointInput, "project_id" | "source" | "delta">): {
  event_id: string;
  record_id: string;
} {
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
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Invalid argument: ${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function normalizeCheckpointInput(input: CheckpointInput): NormalizedCheckpointInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid argument: checkpoint input must be an object");
  const projectId = requiredString(input.project_id, "project_id");
  if (!input.source || typeof input.source !== "object" || Array.isArray(input.source))
    throw new Error("Invalid argument: source must be an object");
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
  if (source.session_id !== delta.session_id)
    throw new Error("Invalid argument: source.session_id must equal delta.session_id");
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string"))) {
    throw new Error("Invalid argument: tags must be an array of strings");
  }
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
  for (const tag of ["checkpoint", `session:${delta.session_id}`, `checkpoint:${delta.checkpoint_id}`]) {
    if (!tags.includes(tag)) tags.push(tag);
  }
  tags.sort(compareCodeUnits);
  return {
    project_id: projectId,
    source,
    occurred_at: occurredAt,
    delta,
    tags,
    include_private: input.include_private === true
  };
}

export function matchesCheckpoint(record: MorynRecord, input: NormalizedCheckpointInput): boolean {
  const checkpoint = parseCheckpointContent(record.content);
  return (
    record.visibility === "active" &&
    record.state !== "archived" &&
    record.state !== "quarantined" &&
    record.kind === "session_summary" &&
    record.type === "checkpoint" &&
    record.scope === "project" &&
    record.project_id === input.project_id &&
    record.source.client === input.source.client &&
    record.source.session_id === input.source.session_id &&
    checkpoint?.checkpoint_id === input.delta.checkpoint_id &&
    checkpoint.session_id === input.delta.session_id
  );
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
  return (
    Boolean(checkpoint) &&
    record.content.checkpoint_payload_digest === checkpointPayloadDigest(input) &&
    JSON.stringify(canonicalValue(checkpoint)) === JSON.stringify(canonicalValue(input.delta)) &&
    record.project_id === input.project_id &&
    record.created_at === input.occurred_at &&
    JSON.stringify(canonicalValue(record.source)) === JSON.stringify(canonicalValue(input.source))
  );
}

export function checkpointSummary(delta: ContextDelta): string {
  const parts = [
    delta.current_task ? `Task: ${delta.current_task}` : undefined,
    delta.progress.length ? `Progress: ${delta.progress.join("; ")}` : undefined,
    delta.knowledge_investigations.length
      ? `Knowledge investigations: ${delta.knowledge_investigations.length}`
      : undefined,
    delta.semantic_consolidation_proposals.length
      ? `Semantic consolidation proposals: ${delta.semantic_consolidation_proposals.length}`
      : undefined
  ];
  return parts.filter(Boolean).join(" | ");
}

function newestPriorityExactValues(
  checkpoints: readonly ContextDelta[],
  field: keyof Pick<
    ContextDelta,
    "progress" | "decisions" | "changed_facts" | "files" | "candidate_memories" | "candidate_skills"
  >
): string[] {
  const selected = new Set<string>();
  for (const checkpoint of [...checkpoints].reverse()) {
    for (const value of checkpoint[field]) {
      if (selected.size < 10) selected.add(value);
    }
  }
  return checkpoints
    .flatMap((checkpoint) => checkpoint[field])
    .filter((value, index, values) => selected.has(value) && values.indexOf(value) === index);
}

function checkpointOrder(left: MorynRecord, right: MorynRecord): number {
  return (
    compareCodeUnits(left.created_at, right.created_at) ||
    compareCodeUnits(left.updated_at, right.updated_at) ||
    compareCodeUnits(left.id, right.id)
  );
}

function canonicalLearning(learning: ContextDelta["learnings"][number]): unknown {
  return canonicalValue({ ...learning, related_record_ids: [...learning.related_record_ids].sort(compareCodeUnits) });
}

function newestPriorityLearnings(checkpoints: readonly ContextDelta[]): ContextDelta["learnings"] {
  const selectedKeys = new Set<string>();
  for (const checkpoint of [...checkpoints].reverse()) {
    for (const learning of checkpoint.learnings) {
      if (selectedKeys.size < 10) selectedKeys.add(JSON.stringify(canonicalLearning(learning)));
    }
  }
  const displayedKeys = new Set<string>();
  return checkpoints
    .flatMap((checkpoint) => checkpoint.learnings)
    .filter((learning) => {
      const key = JSON.stringify(canonicalLearning(learning));
      if (!selectedKeys.has(key) || displayedKeys.has(key)) return false;
      displayedKeys.add(key);
      return true;
    });
}

function latestKnowledgeInvestigations(checkpoints: readonly ContextDelta[]): ContextDelta["knowledge_investigations"] {
  const latestByResolutionId = new Map<string, ContextDelta["knowledge_investigations"][number]>();
  for (const checkpoint of checkpoints) {
    for (const investigation of checkpoint.knowledge_investigations) {
      latestByResolutionId.set(investigation.resolution_id, investigation);
    }
  }
  return [...latestByResolutionId.values()].slice(-10);
}

function canonicalSemanticConsolidationProposal(
  proposal: ContextDelta["semantic_consolidation_proposals"][number]
): unknown {
  return canonicalValue({
    ...proposal,
    evidence_record_ids: [...proposal.evidence_record_ids].sort(compareCodeUnits),
    material_differences: proposal.material_differences.map((difference) => canonicalValue(difference))
  });
}

function newestPrioritySemanticConsolidationProposals(
  checkpoints: readonly ContextDelta[]
): ContextDelta["semantic_consolidation_proposals"] {
  const selectedKeys = new Set<string>();
  for (const checkpoint of [...checkpoints].reverse()) {
    for (const proposal of checkpoint.semantic_consolidation_proposals) {
      if (selectedKeys.size < 10) selectedKeys.add(JSON.stringify(canonicalSemanticConsolidationProposal(proposal)));
    }
  }
  const displayedKeys = new Set<string>();
  return checkpoints
    .flatMap((checkpoint) => checkpoint.semantic_consolidation_proposals)
    .filter((proposal) => {
      const key = JSON.stringify(canonicalSemanticConsolidationProposal(proposal));
      if (!selectedKeys.has(key) || displayedKeys.has(key)) return false;
      displayedKeys.add(key);
      return true;
    });
}

export function buildCheckpointRecoveryPack(
  records: readonly MorynRecord[],
  input: CheckpointRecoveryPackInput
): RecoveryPack {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5)) {
    throw new Error("Invalid argument: limit must be an integer between 1 and 5");
  }
  const limit = input.limit ?? 5;
  const selected = records
    .filter((record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined")
    .filter((record) => record.kind === "session_summary" && record.type === "checkpoint" && record.scope === "project")
    .filter((record) => record.project_id === input.project_id)
    .filter((record) => input.include_private === true || !isPrivateMemoryBoundary(record))
    .map((record) => ({ record, checkpoint: parseCheckpointContent(record.content) }))
    .filter((candidate): candidate is { record: MorynRecord; checkpoint: ContextDelta } =>
      Boolean(candidate.checkpoint)
    )
    .filter(({ checkpoint }) => checkpoint.session_id === input.session_id)
    .sort((left, right) => checkpointOrder(left.record, right.record))
    .slice(-limit);
  const latest = selected.at(-1);
  const base: RecoveryPack = {
    version: 1,
    available: selected.length > 0,
    bounded: true,
    project_id: input.project_id,
    session_id: input.session_id,
    ...(latest
      ? { latest_checkpoint_id: latest.checkpoint.checkpoint_id, latest_occurred_at: latest.record.created_at }
      : {}),
    source_record_ids: selected.map(({ record }) => record.id),
    checkpoint_count: selected.length
  };
  if (!selected.length) return base;

  const checkpoints = selected.map(({ checkpoint }) => checkpoint);
  const latestVisible = selected.at(-1)?.checkpoint;
  const currentTask = [...selected].reverse().find(({ checkpoint }) => checkpoint.current_task)
    ?.checkpoint.current_task;
  return {
    ...base,
    ...(currentTask ? { current_task: currentTask } : {}),
    progress: newestPriorityExactValues(checkpoints, "progress"),
    decisions: newestPriorityExactValues(checkpoints, "decisions"),
    changed_facts: newestPriorityExactValues(checkpoints, "changed_facts"),
    blockers: latestVisible?.blockers ?? [],
    next_steps: latestVisible?.next_steps ?? [],
    files: newestPriorityExactValues(checkpoints, "files"),
    candidate_memories: newestPriorityExactValues(checkpoints, "candidate_memories"),
    candidate_skills: newestPriorityExactValues(checkpoints, "candidate_skills"),
    learnings: newestPriorityLearnings(checkpoints),
    knowledge_investigations: latestKnowledgeInvestigations(checkpoints),
    semantic_consolidation_proposals: newestPrioritySemanticConsolidationProposals(checkpoints)
  };
}

export function recoveryPack(record: MorynRecord, includePrivate: boolean): RecoveryPack {
  return buildCheckpointRecoveryPack([record], {
    project_id: record.project_id ?? "",
    session_id: parseCheckpointContent(record.content)?.session_id ?? record.source.session_id ?? "",
    include_private: includePrivate
  });
}
