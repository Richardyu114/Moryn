import { createHash } from "node:crypto";
import {
  checkpointPayloadDigest,
  checkpointSummary,
  type NormalizedCheckpointInput,
  parseCheckpointContent
} from "./checkpoint.js";
import { buildMemoryRetentionView } from "./memory-retention.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord, RecordSource } from "./types.js";

const FOLDABLE_TYPES = new Set(["status", "checkpoint", "summary"]);
const PRIVATE_TAGS = new Set(["private", "secret", "sensitive"]);
const UNIQUE_OR_PROTECTED_TAGS = new Set([
  "do-not-fold",
  "keep",
  "never-fold",
  "no-compact",
  "no-fold",
  "pinned",
  "protected",
  "unique",
  "unique-evidence"
]);
const STATUS_PROJECTED_CONTENT_KEYS = new Set([
  "blockers",
  "changed_facts",
  "current_task",
  "decisions",
  "files",
  "format",
  "important_files",
  "memory_retention",
  "next_steps",
  "status",
  "synthesis_blockers",
  "synthesis_changed_facts",
  "synthesis_current_task",
  "synthesis_decisions",
  "synthesis_files",
  "synthesis_important_files",
  "synthesis_next_steps",
  "text"
]);
const CHECKPOINT_PROJECTED_FIELDS = new Set([
  "blockers",
  "changed_facts",
  "checkpoint_id",
  "current_task",
  "decisions",
  "files",
  "next_steps",
  "session_id"
]);
const CHECKPOINT_CONTENT_KEYS = new Set([
  "checkpoint",
  "checkpoint_payload_digest",
  "checkpoint_version",
  "format",
  "memory_retention",
  "text"
]);

export type SessionFoldPrivacyBoundary = "public" | "private" | "mixed";

export type SessionFoldReviewReasonCode =
  | "no_final_summary"
  | "updates_after_final"
  | "nothing_to_fold"
  | "unresolved_conflict"
  | "mixed_privacy_boundary"
  | "quarantined_source"
  | "invalid_checkpoint_content"
  | "invalid_coverage_attestation"
  | "unsafe_retention_source"
  | "unverified_source_coverage";

export interface SessionFoldIdentity {
  project_id: string;
  session_id: string;
}

export interface SessionFoldReviewReason {
  code: SessionFoldReviewReasonCode;
  message: string;
  record_ids: string[];
}

export interface SessionFoldSourceDigest {
  record_id: string;
  type: "status" | "checkpoint" | "summary";
  updated_at: string;
  privacy: "public" | "private";
  digest: string;
}

export type SessionFoldCoverageMethod = "deterministic_checkpoint_projection" | "verbatim_final_projection";

export type SessionFoldCoverageBlocker =
  | "canonical_source"
  | "checkpoint_payload_unverified"
  | "high_priority"
  | "never_forget"
  | "non_verbatim_status"
  | "pinned"
  | "prior_final_summary"
  | "protected_content"
  | "protected_type"
  | "unique_or_protected_source"
  | "unsupported_structured_fields";

export interface SessionFoldCoveredSource {
  record_id: string;
  digest: string;
  method: SessionFoldCoverageMethod;
}

export interface SessionFoldUncoveredSource {
  record_id: string;
  digest: string;
  blockers: SessionFoldCoverageBlocker[];
}

export interface SessionFoldCoverageAttestation {
  version: 1;
  project_id: string;
  session_id: string;
  source_digest: string;
  covered_sources: SessionFoldCoveredSource[];
  uncovered_sources: SessionFoldUncoveredSource[];
}

export interface SessionFoldCandidate {
  record_id: string;
  type: "status" | "checkpoint" | "summary";
  reason: "covered_by_rollup" | "superseded_final_handoff";
}

export interface SessionFoldCoverage {
  total_source_records: number;
  covered_source_records: number;
  coverage_ratio: number;
  coverage_attestation: "invalid" | "missing" | "not_required" | "verified";
  verified_source_records: number;
  unverified_source_records: number;
  status_updates: number;
  checkpoints: number;
  final_summaries: number;
  structured_source_records: number;
  unstructured_source_records: number;
  preserved: {
    blockers: number;
    decisions: number;
    changed_facts: number;
    next_steps: number;
    important_files: number;
    source_record_ids: number;
    source_identities: number;
  };
  proposed_active_targets: number;
}

export interface SessionFoldHotFinalHandoff {
  record_id: string;
  updated_at: string;
  text: string;
  source: RecordSource;
}

export interface SessionFoldRollupContent {
  [key: string]: unknown;
  text: string;
  format: "json";
  session_fold_version: 1;
  session_fold_plan_id: string;
  session_id: string;
  closed_at: string;
  hot_final_record_id: string;
  final_handoff_content: MorynRecord["content"];
  current_task?: string;
  blockers: string[];
  decisions: string[];
  changed_facts: string[];
  next_steps: string[];
  important_files: string[];
  source_record_ids: string[];
  source_identities: RecordSource[];
  source_digest: string;
  source_digests: SessionFoldSourceDigest[];
}

export interface SessionFoldRollupRecord extends MorynRecord {
  type: "session_rollup";
  content: SessionFoldRollupContent;
}

export interface SessionFoldPlan {
  version: 1;
  plan_id: string;
  identity: SessionFoldIdentity;
  status: "ready" | "review_required";
  auto_fold: boolean;
  closed: boolean;
  privacy_boundary: SessionFoldPrivacyBoundary;
  source_digest: string;
  source_digests: SessionFoldSourceDigest[];
  source_record_ids: string[];
  source_identities: RecordSource[];
  hot_final_handoff?: SessionFoldHotFinalHandoff;
  rollup_record?: SessionFoldRollupRecord;
  coverage: SessionFoldCoverage;
  archive_candidates: SessionFoldCandidate[];
  cold_candidates: SessionFoldCandidate[];
  proposed_active_target_record_ids: string[];
  review_reasons: SessionFoldReviewReason[];
}

export interface PlanSessionFoldsOptions {
  project_id?: string;
}

interface FoldEvidence {
  current_task?: string;
  blockers: string[];
  decisions: string[];
  changed_facts: string[];
  next_steps: string[];
  important_files: string[];
  structured_record_ids: Set<string>;
}

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

function recordDigest(record: MorynRecord): string {
  return digest({
    id: record.id,
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    project_id: record.project_id,
    tags: [...record.tags].sort(compareCodeUnits),
    content: record.content,
    state: record.state,
    confidence: record.confidence,
    priority: record.priority,
    visibility: record.visibility,
    created_at: record.created_at,
    updated_at: record.updated_at,
    source: record.source,
    provenance: record.provenance,
    conflict: record.conflict,
    links: record.links
  });
}

function recordOrder(left: MorynRecord, right: MorynRecord): number {
  return (
    compareCodeUnits(left.updated_at, right.updated_at) ||
    compareCodeUnits(left.created_at, right.created_at) ||
    compareCodeUnits(left.id, right.id)
  );
}

function isPrivate(record: MorynRecord): boolean {
  return isPrivateMemoryBoundary(record);
}

function activeFoldSource(record: MorynRecord): boolean {
  return (
    record.kind === "session_summary" &&
    FOLDABLE_TYPES.has(record.type) &&
    record.visibility !== "archived" &&
    record.state !== "archived" &&
    Boolean(record.project_id?.trim()) &&
    Boolean(record.source.session_id?.trim())
  );
}

function normalizedSource(source: RecordSource): RecordSource {
  return {
    client: source.client.trim(),
    ...(source.session_id?.trim() ? { session_id: source.session_id.trim() } : {}),
    ...(source.model?.trim() ? { model: source.model.trim() } : {}),
    ...(source.device_id?.trim() ? { device_id: source.device_id.trim() } : {})
  };
}

function sourceIdentityKey(source: RecordSource): string {
  return JSON.stringify(canonicalValue(normalizedSource(source)));
}

function sourceIdentities(records: readonly MorynRecord[]): RecordSource[] {
  const byKey = new Map<string, RecordSource>();
  for (const record of records) {
    const source = normalizedSource(record.source);
    byKey.set(sourceIdentityKey(source), source);
  }
  return [...byKey.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, source]) => source);
}

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function hasStringArray(container: Record<string, unknown>, key: string): boolean {
  return Array.isArray(container[key]) && (container[key] as unknown[]).every((value) => typeof value === "string");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function evidenceContainers(record: MorynRecord): Record<string, unknown>[] {
  const content = record.content as Record<string, unknown>;
  const checkpoint = record.type === "checkpoint" ? objectValue(content.checkpoint) : undefined;
  return checkpoint ? [checkpoint, content] : [content];
}

function valuesForKeys(record: MorynRecord, keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const container of evidenceContainers(record)) {
    for (const key of keys) {
      for (const value of normalizedStrings(container[key])) {
        if (!values.includes(value)) values.push(value);
      }
    }
  }
  return values;
}

function hasAnyKey(record: MorynRecord, keys: readonly string[]): boolean {
  return evidenceContainers(record).some((container) => keys.some((key) => Object.hasOwn(container, key)));
}

function latestSnapshot(records: readonly MorynRecord[], keys: readonly string[]): string[] {
  for (const record of [...records].reverse()) {
    if (hasAnyKey(record, keys)) return valuesForKeys(record, keys);
  }
  return [];
}

function aggregateValues(records: readonly MorynRecord[], keys: readonly string[]): string[] {
  const values: string[] = [];
  for (const record of records) {
    for (const value of valuesForKeys(record, keys)) {
      if (!values.includes(value)) values.push(value);
    }
  }
  return values;
}

function currentTask(records: readonly MorynRecord[]): string | undefined {
  for (const record of [...records].reverse()) {
    for (const container of evidenceContainers(record)) {
      for (const key of ["synthesis_current_task", "current_task"] as const) {
        const value = container[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    }
  }
  return undefined;
}

function foldEvidence(records: readonly MorynRecord[]): FoldEvidence {
  const structuredRecordIds = new Set<string>();
  for (const record of records) {
    const hasStructuredEvidence =
      record.type === "checkpoint" ||
      evidenceContainers(record).some((container) =>
        [
          "blockers",
          "synthesis_blockers",
          "decisions",
          "synthesis_decisions",
          "changed_facts",
          "synthesis_changed_facts",
          "next_steps",
          "synthesis_next_steps",
          "files",
          "important_files",
          "synthesis_files",
          "synthesis_important_files"
        ].some((key) => Object.hasOwn(container, key))
      );
    if (hasStructuredEvidence) structuredRecordIds.add(record.id);
  }
  return {
    current_task: currentTask(records),
    blockers: latestSnapshot(records, ["synthesis_blockers", "blockers"]),
    decisions: aggregateValues(records, ["synthesis_decisions", "decisions"]),
    changed_facts: aggregateValues(records, ["synthesis_changed_facts", "changed_facts"]),
    next_steps: latestSnapshot(records, ["synthesis_next_steps", "next_steps"]),
    important_files: aggregateValues(records, [
      "synthesis_important_files",
      "synthesis_files",
      "important_files",
      "files"
    ]),
    structured_record_ids: structuredRecordIds
  };
}

function invalidCheckpoint(record: MorynRecord, sessionId: string): boolean {
  if (record.type !== "checkpoint") return false;
  return record.source.session_id?.trim() !== sessionId || !verifiedCheckpoint(record);
}

function hasUnresolvedConflict(record: MorynRecord): boolean {
  return (
    record.conflict?.resolution === "needs_review" ||
    record.links?.some((link) => link.link_type === "conflicts_with") === true
  );
}

function uniqueRecords(records: readonly MorynRecord[]): MorynRecord[] {
  const sorted = [...records].sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) ||
      recordOrder(left, right) ||
      compareCodeUnits(recordDigest(left), recordDigest(right))
  );
  const byId = new Map<string, MorynRecord>();
  for (const record of sorted) byId.set(record.id, record);
  return [...byId.values()].sort(recordOrder);
}

function privacyBoundary(records: readonly MorynRecord[]): SessionFoldPrivacyBoundary {
  const privateCount = records.filter(isPrivate).length;
  if (privateCount === 0) return "public";
  return privateCount === records.length ? "private" : "mixed";
}

function sourceDigestList(records: readonly MorynRecord[]): SessionFoldSourceDigest[] {
  return records.map((record) => ({
    record_id: record.id,
    type: record.type as SessionFoldSourceDigest["type"],
    updated_at: record.updated_at,
    privacy: isPrivate(record) ? "private" : "public",
    digest: recordDigest(record)
  }));
}

function sourceListDigest(sourceDigests: readonly SessionFoldSourceDigest[]): string {
  return digest(sourceDigests.map(({ record_id, digest: recordHash }) => ({ record_id, digest: recordHash })));
}

function meaningfulValue(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== false;
}

function uniqueOrProtectedSource(record: MorynRecord): boolean {
  if (record.tags.some((tag) => UNIQUE_OR_PROTECTED_TAGS.has(tag.trim().toLowerCase()))) return true;
  return record.content.unique_evidence === true || record.content.protected === true;
}

function retentionCoverageBlockers(record: MorynRecord): SessionFoldCoverageBlocker[] {
  const view = buildMemoryRetentionView(record);
  const blockers: SessionFoldCoverageBlocker[] = [];
  if (record.priority === "high") blockers.push("high_priority");
  if (record.state === "canonical") blockers.push("canonical_source");
  if (view.retention.pinned) blockers.push("pinned");
  if (view.retention.never_forget) blockers.push("never_forget");
  if (view.safety.protected_type) blockers.push("protected_type");
  // A verified checkpoint is projected field-for-field into the rollup, so a
  // path, number, or requirement inside one is not discarded. Free-form
  // status text does not have that structural guarantee and remains blocked.
  if (record.type !== "checkpoint" && view.safety.protected_signals.length > 0) blockers.push("protected_content");
  if (uniqueOrProtectedSource(record)) blockers.push("unique_or_protected_source");
  return blockers;
}

function statusCoverageBlockers(record: MorynRecord, finalText: string): SessionFoldCoverageBlocker[] {
  const content = record.content as Record<string, unknown>;
  const blockers: SessionFoldCoverageBlocker[] = [];
  if (Object.keys(content).some((key) => !STATUS_PROJECTED_CONTENT_KEYS.has(key))) {
    blockers.push("unsupported_structured_fields");
  }
  for (const key of [
    "blockers",
    "changed_facts",
    "decisions",
    "files",
    "important_files",
    "next_steps",
    "synthesis_blockers",
    "synthesis_changed_facts",
    "synthesis_decisions",
    "synthesis_files",
    "synthesis_important_files",
    "synthesis_next_steps"
  ]) {
    if (Object.hasOwn(content, key) && !hasStringArray(content, key)) blockers.push("unsupported_structured_fields");
  }
  for (const key of ["current_task", "synthesis_current_task"]) {
    if (Object.hasOwn(content, key) && (typeof content[key] !== "string" || !content[key].trim())) {
      blockers.push("unsupported_structured_fields");
    }
  }
  const text = typeof content.text === "string" ? content.text.trim() : "";
  const status = typeof content.status === "string" ? content.status.trim() : undefined;
  if (!text || !finalText.includes(text) || (status !== undefined && status !== text)) {
    blockers.push("non_verbatim_status");
  }
  return blockers;
}

function verifiedCheckpoint(record: MorynRecord): boolean {
  const checkpoint = parseCheckpointContent(record.content);
  if (
    !checkpoint ||
    !record.project_id ||
    !record.source.session_id ||
    !record.source.device_id ||
    record.source.session_id !== checkpoint.session_id
  ) {
    return false;
  }
  const normalized: NormalizedCheckpointInput = {
    project_id: record.project_id,
    source: {
      client: record.source.client,
      session_id: record.source.session_id,
      device_id: record.source.device_id,
      ...(record.source.model ? { model: record.source.model } : {})
    },
    occurred_at: record.created_at,
    delta: checkpoint,
    tags: [...record.tags],
    include_private: false
  };
  return (
    record.content.checkpoint_payload_digest === checkpointPayloadDigest(normalized) &&
    String(record.content.text ?? "").trim() === checkpointSummary(checkpoint)
  );
}

function checkpointCoverageBlockers(record: MorynRecord): SessionFoldCoverageBlocker[] {
  if (!verifiedCheckpoint(record)) return ["checkpoint_payload_unverified"];
  const checkpoint = parseCheckpointContent(record.content)!;
  const blockers: SessionFoldCoverageBlocker[] = [];
  if (Object.keys(record.content).some((key) => !CHECKPOINT_CONTENT_KEYS.has(key))) {
    blockers.push("unsupported_structured_fields");
  }
  if (
    Object.entries(checkpoint).some(([key, value]) => !CHECKPOINT_PROJECTED_FIELDS.has(key) && meaningfulValue(value))
  ) {
    blockers.push("unsupported_structured_fields");
  }
  return blockers;
}

function sourceCoverage(
  record: MorynRecord,
  finalText: string
): { method?: SessionFoldCoverageMethod; blockers: SessionFoldCoverageBlocker[] } {
  const blockers = retentionCoverageBlockers(record);
  if (record.type === "summary") {
    blockers.push("prior_final_summary");
  } else if (record.type === "checkpoint") {
    blockers.push(...checkpointCoverageBlockers(record));
  } else if (record.type === "status") {
    blockers.push(...statusCoverageBlockers(record, finalText));
  } else {
    blockers.push("unsupported_structured_fields");
  }
  const normalizedBlockers = [...new Set(blockers)].sort(compareCodeUnits);
  return {
    ...(normalizedBlockers.length
      ? {}
      : {
          method:
            record.type === "checkpoint"
              ? ("deterministic_checkpoint_projection" as const)
              : ("verbatim_final_projection" as const)
        }),
    blockers: normalizedBlockers
  };
}

function identityRecords(records: readonly MorynRecord[], identity: SessionFoldIdentity): MorynRecord[] {
  const projectId = identity.project_id.trim();
  const sessionId = identity.session_id.trim();
  return uniqueRecords(
    records.filter(
      (record) =>
        activeFoldSource(record) &&
        record.project_id?.trim() === projectId &&
        record.source.session_id?.trim() === sessionId
    )
  );
}

export function buildSessionFoldCoverageAttestation(
  records: readonly MorynRecord[],
  identity: SessionFoldIdentity,
  proposedFinalText: string
): SessionFoldCoverageAttestation {
  const projectId = identity.project_id.trim();
  const sessionId = identity.session_id.trim();
  if (!projectId || !sessionId) throw new Error("Session Fold coverage requires project_id and session_id");
  const finalText = proposedFinalText.trim();
  if (!finalText) throw new Error("Session Fold coverage requires a non-empty proposed final summary");
  const sources = identityRecords(records, { project_id: projectId, session_id: sessionId });
  const sourceDigests = sourceDigestList(sources);
  const digestsById = new Map(sourceDigests.map((source) => [source.record_id, source.digest]));
  const coveredSources: SessionFoldCoveredSource[] = [];
  const uncoveredSources: SessionFoldUncoveredSource[] = [];
  for (const source of sources) {
    const coverage = sourceCoverage(source, finalText);
    const sourceHash = digestsById.get(source.id)!;
    if (coverage.method) {
      coveredSources.push({ record_id: source.id, digest: sourceHash, method: coverage.method });
    } else {
      uncoveredSources.push({ record_id: source.id, digest: sourceHash, blockers: coverage.blockers });
    }
  }
  return {
    version: 1,
    project_id: projectId,
    session_id: sessionId,
    source_digest: sourceListDigest(sourceDigests),
    covered_sources: coveredSources,
    uncovered_sources: uncoveredSources
  };
}

function addReason(
  reasons: SessionFoldReviewReason[],
  code: SessionFoldReviewReasonCode,
  message: string,
  recordIds: readonly string[]
): void {
  reasons.push({ code, message, record_ids: [...new Set(recordIds)].sort(compareCodeUnits) });
}

function planId(identity: SessionFoldIdentity, sourceDigest: string): string {
  return `session_fold_${digest({ version: 1, identity, source_digest: sourceDigest }).slice(0, 32)}`;
}

function combinedLinks(records: readonly MorynRecord[]): NonNullable<MorynRecord["links"]> {
  const links = new Map<string, NonNullable<MorynRecord["links"]>[number]>();
  for (const link of records.flatMap((record) => record.links ?? [])) {
    links.set(JSON.stringify(canonicalValue(link)), structuredClone(link));
  }
  return [...links.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, link]) => link);
}

function rollupRecord(input: {
  id: string;
  planId: string;
  identity: SessionFoldIdentity;
  records: MorynRecord[];
  hotFinal: MorynRecord;
  sourceDigest: string;
  sourceDigests: SessionFoldSourceDigest[];
  identities: RecordSource[];
  evidence: FoldEvidence;
  privacy: Exclude<SessionFoldPrivacyBoundary, "mixed">;
}): SessionFoldRollupRecord {
  const sourceRecordIds = input.records.map((record) => record.id);
  const text = String(input.hotFinal.content.text ?? "").trim();
  const tags = new Set(input.hotFinal.tags.map((tag) => tag.trim()).filter(Boolean));
  const links = combinedLinks(input.records);
  tags.add("session-fold");
  tags.add(`session:${input.identity.session_id}`);
  if (input.privacy === "private" && ![...tags].some((tag) => PRIVATE_TAGS.has(tag.toLowerCase()))) tags.add("private");
  return {
    id: input.id,
    kind: "session_summary",
    type: "session_rollup",
    scope: "project",
    project_id: input.identity.project_id,
    tags: [...tags].sort(compareCodeUnits),
    content: {
      text,
      format: "json",
      session_fold_version: 1,
      session_fold_plan_id: input.planId,
      session_id: input.identity.session_id,
      closed_at: input.hotFinal.updated_at,
      hot_final_record_id: input.hotFinal.id,
      final_handoff_content: structuredClone(input.hotFinal.content),
      ...(input.evidence.current_task ? { current_task: input.evidence.current_task } : {}),
      blockers: input.evidence.blockers,
      decisions: input.evidence.decisions,
      changed_facts: input.evidence.changed_facts,
      next_steps: input.evidence.next_steps,
      important_files: input.evidence.important_files,
      source_record_ids: sourceRecordIds,
      source_identities: input.identities,
      source_digest: input.sourceDigest,
      source_digests: input.sourceDigests
    },
    state: input.hotFinal.state,
    confidence: input.hotFinal.confidence,
    priority: input.hotFinal.priority,
    visibility: "active",
    created_at: input.hotFinal.updated_at,
    updated_at: input.hotFinal.updated_at,
    source: normalizedSource(input.hotFinal.source),
    provenance: {
      derived_from: sourceRecordIds,
      reason: "Deterministic closed-session fold plan.",
      method: "rule-promoted"
    },
    ...(links.length ? { links } : {})
  };
}

function buildPlan(identity: SessionFoldIdentity, inputRecords: readonly MorynRecord[]): SessionFoldPlan {
  const records = uniqueRecords(inputRecords);
  const sourceDigests = sourceDigestList(records);
  const sourceDigest = sourceListDigest(sourceDigests);
  const id = planId(identity, sourceDigest);
  const finals = records.filter((record) => record.type === "summary");
  const validFinals = finals.filter((record) => typeof record.content.text === "string" && record.content.text.trim());
  const hotFinal = validFinals.at(-1);
  const updates = records.filter((record) => record.type === "status" || record.type === "checkpoint");
  const latestUpdate = updates.at(-1);
  const closed = Boolean(hotFinal && (!latestUpdate || recordOrder(latestUpdate, hotFinal) <= 0));
  const privacy = privacyBoundary(records);
  const identities = sourceIdentities(records);
  const evidence = foldEvidence(records);
  const reasons: SessionFoldReviewReason[] = [];
  const coverageSources = hotFinal ? records.filter((record) => record.id !== hotFinal.id) : records;
  const expectedCoverage = hotFinal
    ? buildSessionFoldCoverageAttestation(coverageSources, identity, String(hotFinal.content.text ?? ""))
    : undefined;
  const actualCoverage = hotFinal?.content.session_fold_coverage;
  const requiresCoverageAttestation = Boolean(hotFinal && closed && coverageSources.length > 0);
  const coverageAttestationMatches =
    !requiresCoverageAttestation ||
    (expectedCoverage !== undefined &&
      JSON.stringify(canonicalValue(actualCoverage)) === JSON.stringify(canonicalValue(expectedCoverage)));
  const coverageAttestationStatus: SessionFoldCoverage["coverage_attestation"] = !requiresCoverageAttestation
    ? "not_required"
    : actualCoverage === undefined
      ? "missing"
      : coverageAttestationMatches
        ? "verified"
        : "invalid";

  if (!hotFinal) {
    addReason(
      reasons,
      "no_final_summary",
      "A valid final summary is required before folding a session.",
      finals.map((record) => record.id)
    );
  } else if (!closed && latestUpdate) {
    addReason(
      reasons,
      "updates_after_final",
      "The session has status or checkpoint evidence newer than its latest final summary.",
      [hotFinal.id, latestUpdate.id]
    );
  }
  if (updates.length === 0 && finals.length <= 1) {
    addReason(
      reasons,
      "nothing_to_fold",
      "The session has no superseded updates or final handoffs to compact.",
      records.map((record) => record.id)
    );
  }
  const conflicted = records.filter(hasUnresolvedConflict);
  if (conflicted.length) {
    addReason(
      reasons,
      "unresolved_conflict",
      "At least one source record has an unresolved semantic conflict.",
      conflicted.map((record) => record.id)
    );
  }
  if (privacy === "mixed") {
    addReason(
      reasons,
      "mixed_privacy_boundary",
      "Public and private session evidence must not be merged automatically.",
      records.map((record) => record.id)
    );
  }
  const quarantined = records.filter((record) => record.visibility === "quarantined" || record.state === "quarantined");
  if (quarantined.length) {
    addReason(
      reasons,
      "quarantined_source",
      "Quarantined source records require review before session folding.",
      quarantined.map((record) => record.id)
    );
  }
  const invalidCheckpoints = records.filter((record) => invalidCheckpoint(record, identity.session_id));
  if (invalidCheckpoints.length) {
    addReason(
      reasons,
      "invalid_checkpoint_content",
      "Checkpoint content is missing or malformed and cannot be folded safely.",
      invalidCheckpoints.map((record) => record.id)
    );
  }
  if (requiresCoverageAttestation && !coverageAttestationMatches) {
    addReason(
      reasons,
      "invalid_coverage_attestation",
      "The final handoff is missing an exact coverage attestation for the source records.",
      coverageSources.map((record) => record.id)
    );
  }
  const uncoveredSources = closed ? (expectedCoverage?.uncovered_sources ?? []) : [];
  const retentionUnsafeSources = uncoveredSources.filter((source) =>
    source.blockers.some((blocker) =>
      [
        "canonical_source",
        "high_priority",
        "never_forget",
        "pinned",
        "protected_content",
        "protected_type",
        "unique_or_protected_source"
      ].includes(blocker)
    )
  );
  if (retentionUnsafeSources.length) {
    addReason(
      reasons,
      "unsafe_retention_source",
      "High-priority, canonical, pinned, unique, or protected sources cannot be folded automatically.",
      retentionUnsafeSources.map((source) => source.record_id)
    );
  }
  if (uncoveredSources.length) {
    addReason(
      reasons,
      "unverified_source_coverage",
      "Every archived source must have deterministic structured or verbatim coverage.",
      uncoveredSources.map((source) => source.record_id)
    );
  }

  const autoFold = reasons.length === 0;
  const archiveCandidates = updates.map(
    (record): SessionFoldCandidate => ({
      record_id: record.id,
      type: record.type as SessionFoldCandidate["type"],
      reason: "covered_by_rollup"
    })
  );
  const coldCandidates = finals.map(
    (record): SessionFoldCandidate => ({
      record_id: record.id,
      type: "summary",
      reason: record.id === hotFinal?.id ? "covered_by_rollup" : "superseded_final_handoff"
    })
  );
  const rollupId = `rec_${id}`;
  const rollup =
    autoFold && hotFinal && privacy !== "mixed"
      ? rollupRecord({
          id: rollupId,
          planId: id,
          identity,
          records,
          hotFinal,
          sourceDigest,
          sourceDigests,
          identities,
          evidence,
          privacy
        })
      : undefined;
  const proposedTargets = rollup ? [rollup.id] : [];
  const verifiedNonFinalSources =
    coverageAttestationMatches && expectedCoverage ? expectedCoverage.covered_sources.length : 0;
  const coveredSourceRecords = hotFinal ? 1 + verifiedNonFinalSources : 0;

  return {
    version: 1,
    plan_id: id,
    identity,
    status: autoFold ? "ready" : "review_required",
    auto_fold: autoFold,
    closed,
    privacy_boundary: privacy,
    source_digest: sourceDigest,
    source_digests: sourceDigests,
    source_record_ids: records.map((record) => record.id),
    source_identities: identities,
    ...(hotFinal
      ? {
          hot_final_handoff: {
            record_id: hotFinal.id,
            updated_at: hotFinal.updated_at,
            text: String(hotFinal.content.text).trim(),
            source: normalizedSource(hotFinal.source)
          }
        }
      : {}),
    ...(rollup ? { rollup_record: rollup } : {}),
    coverage: {
      total_source_records: records.length,
      covered_source_records: coveredSourceRecords,
      coverage_ratio: records.length === 0 ? 0 : coveredSourceRecords / records.length,
      coverage_attestation: coverageAttestationStatus,
      verified_source_records: coveredSourceRecords,
      unverified_source_records: records.length - coveredSourceRecords,
      status_updates: records.filter((record) => record.type === "status").length,
      checkpoints: records.filter((record) => record.type === "checkpoint").length,
      final_summaries: finals.length,
      structured_source_records: evidence.structured_record_ids.size,
      unstructured_source_records: records.length - evidence.structured_record_ids.size,
      preserved: {
        blockers: evidence.blockers.length,
        decisions: evidence.decisions.length,
        changed_facts: evidence.changed_facts.length,
        next_steps: evidence.next_steps.length,
        important_files: evidence.important_files.length,
        source_record_ids: records.length,
        source_identities: identities.length
      },
      proposed_active_targets: proposedTargets.length
    },
    archive_candidates: archiveCandidates,
    cold_candidates: coldCandidates,
    proposed_active_target_record_ids: proposedTargets,
    review_reasons: reasons
  };
}

export function planSessionFolds(
  records: readonly MorynRecord[],
  options: PlanSessionFoldsOptions = {}
): SessionFoldPlan[] {
  const requestedProjectId = options.project_id?.trim();
  const groups = new Map<string, { identity: SessionFoldIdentity; records: MorynRecord[] }>();
  for (const record of records) {
    if (!activeFoldSource(record)) continue;
    const projectId = record.project_id!.trim();
    const sessionId = record.source.session_id!.trim();
    if (requestedProjectId && projectId !== requestedProjectId) continue;
    const identity = { project_id: projectId, session_id: sessionId };
    const key = `${projectId}\u0000${sessionId}`;
    const group = groups.get(key) ?? { identity, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        compareCodeUnits(left.identity.project_id, right.identity.project_id) ||
        compareCodeUnits(left.identity.session_id, right.identity.session_id)
    )
    .map((group) => buildPlan(group.identity, group.records));
}

export function planSessionFold(
  records: readonly MorynRecord[],
  identity: SessionFoldIdentity
): SessionFoldPlan | undefined {
  const projectId = identity.project_id.trim();
  const sessionId = identity.session_id.trim();
  return planSessionFolds(records, { project_id: projectId }).find((plan) => plan.identity.session_id === sessionId);
}
