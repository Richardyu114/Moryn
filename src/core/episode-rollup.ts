import { createHash } from "node:crypto";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord, RecordSource } from "./types.js";

export const EPISODE_BUCKET_KINDS = ["day", "task", "project_epoch"] as const;
export type EpisodeBucketKind = (typeof EPISODE_BUCKET_KINDS)[number];

export type EpisodeClaimKind =
  | "summary"
  | "current_task"
  | "blocker"
  | "decision"
  | "changed_fact"
  | "next_step"
  | "important_file"
  | "custom";

export type EpisodePrivacyBoundary = "public" | "private" | "mixed";
export type EpisodeRollupStatus = "ready" | "deferred" | "review_required";

export type EpisodeRollupReviewCode =
  | "claim_identity_conflict"
  | "incomplete_coverage"
  | "invalid_closed_at"
  | "leaf_digest_conflict"
  | "lineage_digest_mismatch"
  | "missing_lineage"
  | "mixed_privacy_boundary"
  | "not_l1_session_rollup"
  | "quarantined_source"
  | "unique_protected_information"
  | "unresolved_conflict";

export type EpisodeRollupDeferredCode = "bucket_not_closed" | "no_closed_sessions" | "recent_sources_preserved";

export interface EpisodeRollupIdentity {
  project_id: string;
  bucket_kind: EpisodeBucketKind;
  bucket_key: string;
}

export interface EpisodeRollupPlanningPolicy {
  now: string;
  recent_window_days: number;
}

export interface EpisodeLeafEvidence {
  record_id: string;
  digest: string;
}

export interface EpisodeClaim {
  claim_id: string;
  kind: EpisodeClaimKind;
  text: string;
  source_rollup_ids: string[];
  source_claim_ids: string[];
  leaf_evidence: EpisodeLeafEvidence[];
}

export interface EpisodeSourceDigest {
  record_id: string;
  closed_at: string;
  updated_at: string;
  privacy: Exclude<EpisodePrivacyBoundary, "mixed">;
  digest: string;
}

export interface EpisodeRollupReviewReason {
  code: EpisodeRollupReviewCode;
  message: string;
  record_ids: string[];
}

export interface EpisodeRollupDeferredReason {
  code: EpisodeRollupDeferredCode;
  message: string;
  record_ids: string[];
}

export interface EpisodeColdCandidate {
  record_id: string;
  closed_at: string;
  reason: "old_and_fully_covered";
}

export interface EpisodeWarmCandidate {
  record_id: string;
  reason: "incomplete_coverage" | "recent" | "safety_review" | "unfinished";
  digest: string;
  closed_at?: string;
}

export interface EpisodeRollupCoverage {
  total_source_rollups: number;
  covered_source_rollups: number;
  coverage_ratio: number;
  source_leaf_evidence: number;
  covered_leaf_evidence: number;
  output_claims: number;
  claims_with_leaf_evidence: number;
  cold_source_rollups: number;
  preserved_warm_rollups: number;
}

export interface EpisodeRollupContent {
  [key: string]: unknown;
  text: string;
  format: "json";
  episode_rollup_version: 1;
  episode_rollup_plan_id: string;
  bucket: EpisodeRollupIdentity;
  closed_from: string;
  closed_through: string;
  source_rollup_ids: string[];
  source_digest: string;
  source_digests: EpisodeSourceDigest[];
  leaf_evidence: EpisodeLeafEvidence[];
  claims: EpisodeClaim[];
  coverage: EpisodeRollupCoverage;
  memory_retention: {
    version: 2;
    layer: "L1";
    trust_state: "candidate";
    retention: { tier: "warm" };
    lineage: {
      derived_from: string[];
      covered_record_ids: string[];
      source_digests: Record<string, string>;
      compression_level: 2;
      coverage_verified: true;
    };
  };
}

export interface EpisodeRollupRecord extends MorynRecord {
  type: "episode_rollup";
  content: EpisodeRollupContent;
}

export interface EpisodeRollupPlan {
  version: 1;
  plan_id: string;
  identity: EpisodeRollupIdentity;
  policy: EpisodeRollupPlanningPolicy;
  status: EpisodeRollupStatus;
  auto_rollup: boolean;
  privacy_boundary: EpisodePrivacyBoundary;
  source_digest: string;
  observation_digest: string;
  source_digests: EpisodeSourceDigest[];
  source_record_ids: string[];
  leaf_evidence: EpisodeLeafEvidence[];
  claims: EpisodeClaim[];
  rollup_record?: EpisodeRollupRecord;
  coverage: EpisodeRollupCoverage;
  cold_candidates: EpisodeColdCandidate[];
  warm_candidates: EpisodeWarmCandidate[];
  review_reasons: EpisodeRollupReviewReason[];
  deferred_reasons: EpisodeRollupDeferredReason[];
}

export interface PlanEpisodeRollupsOptions {
  now: string;
  recent_window_days?: number;
  project_id?: string;
  bucket_kind?: EpisodeBucketKind;
}

interface InputClaim {
  kind: EpisodeClaimKind;
  text: string;
  source_claim_id: string;
  leaf_evidence: EpisodeLeafEvidence[];
  protected: boolean;
}

interface ParsedLineage {
  leaf_evidence: EpisodeLeafEvidence[];
  claims: InputClaim[];
  missing: boolean;
  digest_mismatch: boolean;
  incomplete: boolean;
  protected: boolean;
}

interface BucketRecord {
  record: MorynRecord;
  closed_at?: string;
}

export interface EpisodeRollupSourceBucket {
  identity: EpisodeRollupIdentity;
  closed_at?: string;
}

interface ClaimAccumulator {
  kind: EpisodeClaimKind;
  text: string;
  source_rollup_ids: Set<string>;
  source_claim_ids: Set<string>;
  leaf_evidence: Map<string, string>;
}

interface SourceAnalysis {
  input: BucketRecord;
  lineage: ParsedLineage;
  private: boolean;
  l1: boolean;
  conflicted: boolean;
  quarantined: boolean;
  protected: boolean;
  fully_covered: boolean;
}

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const PROTECTED_TAGS = new Set(["never-forget", "never_forget", "pinned", "protected"]);
const CLAIM_KINDS = new Set<EpisodeClaimKind>([
  "summary",
  "current_task",
  "blocker",
  "decision",
  "changed_fact",
  "next_step",
  "important_file",
  "custom"
]);

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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized || undefined;
}

function normalizedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value) {
    const normalized = normalizedText(item);
    if (normalized) result.add(normalized);
  }
  return [...result];
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function normalizedPolicy(
  options: Pick<PlanEpisodeRollupsOptions, "now" | "recent_window_days">
): EpisodeRollupPlanningPolicy {
  if (!validIso(options.now)) throw new Error("Episode Rollup requires now as a canonical ISO timestamp");
  const recentWindowDays = options.recent_window_days ?? 7;
  if (!Number.isInteger(recentWindowDays) || recentWindowDays < 0 || recentWindowDays > 3650) {
    throw new Error("Episode Rollup recent_window_days must be an integer from 0 through 3650");
  }
  return { now: options.now, recent_window_days: recentWindowDays };
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

function sessionRollupMarker(record: MorynRecord): boolean {
  if (record.kind !== "session_summary" || record.type === "episode_rollup") return false;
  const content = record.content as Record<string, unknown>;
  return (
    record.type === "session_rollup" ||
    content.rollup_kind === "session" ||
    content.session_rollup_version === 1 ||
    content.session_fold_version === 1
  );
}

function retentionMetadata(record: MorynRecord): Record<string, unknown> | undefined {
  return objectValue((record.content as Record<string, unknown>).memory_retention);
}

function isL1SessionRollup(record: MorynRecord): boolean {
  const layer = retentionMetadata(record)?.layer;
  if (layer !== undefined) return layer === "L1";
  return record.type === "session_rollup" || (record.content as Record<string, unknown>).session_fold_version === 1;
}

function recordPrivacy(record: MorynRecord): Exclude<EpisodePrivacyBoundary, "mixed"> {
  return isPrivateMemoryBoundary(record) ? "private" : "public";
}

function unresolvedConflict(record: MorynRecord): boolean {
  return (
    record.conflict?.resolution === "needs_review" ||
    record.links?.some((link) => link.link_type === "conflicts_with") === true
  );
}

function quarantined(record: MorynRecord): boolean {
  return record.state === "quarantined" || record.visibility === "quarantined";
}

function protectedRecord(record: MorynRecord): boolean {
  const retention = retentionMetadata(record);
  const retentionFlags = objectValue(retention?.retention);
  const content = record.content as Record<string, unknown>;
  return (
    record.priority === "high" ||
    record.tags.some((tag) => PROTECTED_TAGS.has(tag.trim().toLowerCase())) ||
    retentionFlags?.pinned === true ||
    retentionFlags?.never_forget === true ||
    content.protected === true
  );
}

function bucketKey(record: MorynRecord, kind: EpisodeBucketKind, closedAt?: string): string | undefined {
  const content = record.content as Record<string, unknown>;
  if (kind === "day") {
    const timestamp = closedAt ?? (validIso(record.updated_at) ? record.updated_at : undefined);
    return timestamp?.slice(0, 10);
  }
  if (kind === "task") {
    return normalizedText(content.task_id) ?? normalizedText(content.task_key);
  }
  return normalizedText(content.project_epoch_id) ?? normalizedText(content.epoch_id);
}

function closedAt(record: MorynRecord): string | undefined {
  const content = record.content as Record<string, unknown>;
  if (content.closed === false) return undefined;
  return validIso(content.closed_at) ? content.closed_at : undefined;
}

export function episodeRollupSourceBucket(
  record: MorynRecord,
  kind: EpisodeBucketKind
): EpisodeRollupSourceBucket | undefined {
  if (!sessionRollupMarker(record) || record.state === "archived" || record.visibility === "archived") {
    return undefined;
  }
  const projectId = record.project_id?.trim();
  if (!projectId) return undefined;
  const closed = closedAt(record);
  const key = bucketKey(record, kind, closed);
  if (!key) return undefined;
  return {
    identity: { project_id: projectId, bucket_kind: kind, bucket_key: key },
    ...(closed ? { closed_at: closed } : {})
  };
}

function uniqueBucketRecords(records: readonly BucketRecord[]): BucketRecord[] {
  const ordered = [...records].sort(
    (left, right) =>
      compareCodeUnits(left.record.id, right.record.id) ||
      compareCodeUnits(recordDigest(left.record), recordDigest(right.record))
  );
  const byId = new Map<string, BucketRecord>();
  for (const item of ordered) byId.set(item.record.id, item);
  return [...byId.values()].sort((left, right) => compareCodeUnits(left.record.id, right.record.id));
}

function parseLeafEvidence(value: unknown): { evidence: EpisodeLeafEvidence[]; invalid: boolean; conflict: boolean } {
  if (!Array.isArray(value)) return { evidence: [], invalid: true, conflict: false };
  const byId = new Map<string, string>();
  let invalid = false;
  let conflict = false;
  for (const item of value) {
    const leaf = objectValue(item);
    const recordId = normalizedText(leaf?.record_id);
    const leafDigest = normalizedText(leaf?.digest);
    if (!recordId || !leafDigest || !SHA256_PATTERN.test(leafDigest)) {
      invalid = true;
      continue;
    }
    const existing = byId.get(recordId);
    if (existing && existing !== leafDigest) conflict = true;
    byId.set(recordId, leafDigest);
  }
  return {
    evidence: [...byId.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([record_id, leafDigest]) => ({ record_id, digest: leafDigest })),
    invalid,
    conflict
  };
}

function parseSourceLeafEvidence(record: MorynRecord): {
  evidence: EpisodeLeafEvidence[];
  missing: boolean;
  digest_mismatch: boolean;
  incomplete: boolean;
} {
  const content = record.content as Record<string, unknown>;
  const retentionLineage = objectValue(retentionMetadata(record)?.lineage);
  const retentionSourceDigests = objectValue(retentionLineage?.source_digests);
  const sourceDigestValue =
    content.source_digests ??
    (retentionSourceDigests
      ? Object.entries(retentionSourceDigests)
          .sort(([left], [right]) => compareCodeUnits(left, right))
          .map(([record_id, sourceDigest]) => ({ record_id, digest: sourceDigest }))
      : undefined);
  const parsed = parseLeafEvidence(sourceDigestValue);
  const sourceIds = normalizedStrings(content.source_record_ids ?? retentionLineage?.derived_from).sort(
    compareCodeUnits
  );
  const evidenceIds = parsed.evidence.map((leaf) => leaf.record_id);
  let missing = parsed.invalid || parsed.evidence.length === 0;
  let incomplete = parsed.conflict;
  if (sourceIds.length > 0 && JSON.stringify(sourceIds) !== JSON.stringify(evidenceIds)) incomplete = true;

  const derivedFrom = [...new Set(record.provenance?.derived_from ?? [])].sort(compareCodeUnits);
  if (derivedFrom.length > 0 && JSON.stringify(derivedFrom) !== JSON.stringify(evidenceIds)) incomplete = true;

  let digestMismatch = false;
  if (typeof content.source_digest === "string") {
    if (!SHA256_PATTERN.test(content.source_digest)) {
      digestMismatch = true;
    } else if (Array.isArray(sourceDigestValue)) {
      const ordered = sourceDigestValue.flatMap((item) => {
        const source = objectValue(item);
        const recordId = normalizedText(source?.record_id);
        const sourceDigest = normalizedText(source?.digest);
        return recordId && sourceDigest && SHA256_PATTERN.test(sourceDigest)
          ? [{ record_id: recordId, digest: sourceDigest }]
          : [];
      });
      if (ordered.length !== parsed.evidence.length || digest(ordered) !== content.source_digest) digestMismatch = true;
    }
  }
  if (sourceIds.length === 0) missing = true;
  return { evidence: parsed.evidence, missing, digest_mismatch: digestMismatch, incomplete };
}

function claimKind(value: unknown): EpisodeClaimKind {
  return typeof value === "string" && CLAIM_KINDS.has(value as EpisodeClaimKind)
    ? (value as EpisodeClaimKind)
    : "custom";
}

function parseExplicitClaims(record: MorynRecord): {
  present: boolean;
  claims: InputClaim[];
  incomplete: boolean;
  conflict: boolean;
} {
  const value = (record.content as Record<string, unknown>).claims;
  if (value === undefined) return { present: false, claims: [], incomplete: false, conflict: false };
  if (!Array.isArray(value)) return { present: true, claims: [], incomplete: true, conflict: false };
  const claims: InputClaim[] = [];
  let incomplete = false;
  let conflict = false;
  for (const [index, item] of value.entries()) {
    const input = objectValue(item);
    const text = normalizedText(input?.text);
    const parsedLeafs = parseLeafEvidence(input?.leaf_evidence);
    if (!input || !text || parsedLeafs.invalid || parsedLeafs.evidence.length === 0) {
      incomplete = true;
      continue;
    }
    if (parsedLeafs.conflict) conflict = true;
    const kind = claimKind(input.kind);
    const sourceClaimId =
      normalizedText(input.claim_id) ??
      `session_claim_${digest({ version: 1, record_id: record.id, index, kind, text }).slice(0, 32)}`;
    claims.push({
      kind,
      text,
      source_claim_id: sourceClaimId,
      leaf_evidence: parsedLeafs.evidence,
      protected: input.protected === true
    });
  }
  if (claims.length === 0) incomplete = true;
  return { present: true, claims, incomplete, conflict };
}

function derivedClaims(record: MorynRecord, leafEvidence: EpisodeLeafEvidence[]): InputClaim[] {
  const content = record.content as Record<string, unknown>;
  const values: Array<{ kind: EpisodeClaimKind; text: string }> = [];
  const summary = normalizedText(content.text);
  const currentTask = normalizedText(content.current_task);
  if (summary) values.push({ kind: "summary", text: summary });
  if (currentTask) values.push({ kind: "current_task", text: currentTask });
  const arrays: Array<[EpisodeClaimKind, string[]]> = [
    ["blocker", normalizedStrings(content.blockers)],
    ["decision", normalizedStrings(content.decisions)],
    ["changed_fact", normalizedStrings(content.changed_facts)],
    ["next_step", normalizedStrings(content.next_steps)],
    ["important_file", normalizedStrings(content.important_files)]
  ];
  for (const [kind, texts] of arrays) {
    for (const text of texts) values.push({ kind, text });
  }
  return values.map(({ kind, text }) => ({
    kind,
    text,
    source_claim_id: `session_claim_${digest({ version: 1, record_id: record.id, kind, text }).slice(0, 32)}`,
    leaf_evidence: leafEvidence,
    protected: false
  }));
}

function parseLineage(record: MorynRecord): ParsedLineage {
  const source = parseSourceLeafEvidence(record);
  const explicit = parseExplicitClaims(record);
  const content = record.content as Record<string, unknown>;
  const retentionLineage = objectValue(retentionMetadata(record)?.lineage);
  const explicitlyVerified = content.lineage_verified === true || retentionLineage?.coverage_verified === true;

  const explicitLeafs = new Map<string, string>();
  let leafConflict = explicit.conflict;
  for (const claim of explicit.claims) {
    for (const leaf of claim.leaf_evidence) {
      const existing = explicitLeafs.get(leaf.record_id);
      if (existing && existing !== leaf.digest) leafConflict = true;
      explicitLeafs.set(leaf.record_id, leaf.digest);
    }
  }
  let rootLeafs = source.evidence;
  let missing = source.missing;
  if (rootLeafs.length === 0 && explicitLeafs.size > 0 && explicitlyVerified) {
    rootLeafs = [...explicitLeafs.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([record_id, leafDigest]) => ({ record_id, digest: leafDigest }));
    missing = false;
  }

  const claims = explicit.present ? explicit.claims : derivedClaims(record, rootLeafs);
  const rootById = new Map(rootLeafs.map((leaf) => [leaf.record_id, leaf.digest]));
  const coveredIds = new Set<string>();
  let incomplete = source.incomplete || explicit.incomplete || claims.length === 0 || leafConflict;
  for (const claim of claims) {
    if (claim.leaf_evidence.length === 0) incomplete = true;
    for (const leaf of claim.leaf_evidence) {
      if (rootById.get(leaf.record_id) !== leaf.digest) incomplete = true;
      else coveredIds.add(leaf.record_id);
    }
  }
  if (rootLeafs.some((leaf) => !coveredIds.has(leaf.record_id))) incomplete = true;

  return {
    leaf_evidence: rootLeafs,
    claims,
    missing,
    digest_mismatch: source.digest_mismatch,
    incomplete,
    protected: explicit.claims.some((claim) => claim.protected)
  };
}

function analyzeSource(input: BucketRecord): SourceAnalysis {
  const lineage = parseLineage(input.record);
  const sourceProtected = protectedRecord(input.record) || lineage.protected;
  const sourceQuarantined = quarantined(input.record);
  const sourceConflicted = unresolvedConflict(input.record);
  return {
    input,
    lineage,
    private: recordPrivacy(input.record) === "private",
    l1: isL1SessionRollup(input.record),
    conflicted: sourceConflicted,
    quarantined: sourceQuarantined,
    protected: sourceProtected,
    fully_covered:
      !lineage.missing &&
      !lineage.digest_mismatch &&
      !lineage.incomplete &&
      !sourceProtected &&
      !sourceQuarantined &&
      !sourceConflicted
  };
}

function addReviewReason(
  reasons: EpisodeRollupReviewReason[],
  code: EpisodeRollupReviewCode,
  message: string,
  recordIds: readonly string[]
): void {
  if (recordIds.length === 0) return;
  reasons.push({ code, message, record_ids: [...new Set(recordIds)].sort(compareCodeUnits) });
}

function addDeferredReason(
  reasons: EpisodeRollupDeferredReason[],
  code: EpisodeRollupDeferredCode,
  message: string,
  recordIds: readonly string[]
): void {
  reasons.push({ code, message, record_ids: [...new Set(recordIds)].sort(compareCodeUnits) });
}

function privacyBoundary(sources: readonly SourceAnalysis[]): EpisodePrivacyBoundary {
  const privateCount = sources.filter((source) => source.private).length;
  if (privateCount === 0) return "public";
  return privateCount === sources.length ? "private" : "mixed";
}

function claimSemanticKey(kind: EpisodeClaimKind, text: string): string {
  return `${kind}\u0000${text.toLocaleLowerCase("en-US")}`;
}

function mergeClaims(sources: readonly SourceAnalysis[], reasons: EpisodeRollupReviewReason[]): EpisodeClaim[] {
  const claims = new Map<string, ClaimAccumulator>();
  const sourceClaimSemantics = new Map<string, string>();
  const globalLeafDigests = new Map<string, { digest: string; source_ids: Set<string> }>();
  const conflictingClaimSources = new Set<string>();
  const conflictingLeafSources = new Set<string>();

  for (const source of sources) {
    for (const claim of source.lineage.claims) {
      const semantic = claimSemanticKey(claim.kind, claim.text);
      const existingSemantic = sourceClaimSemantics.get(claim.source_claim_id);
      if (existingSemantic && existingSemantic !== semantic) conflictingClaimSources.add(source.input.record.id);
      sourceClaimSemantics.set(claim.source_claim_id, semantic);
      const accumulator = claims.get(semantic) ?? {
        kind: claim.kind,
        text: claim.text,
        source_rollup_ids: new Set<string>(),
        source_claim_ids: new Set<string>(),
        leaf_evidence: new Map<string, string>()
      };
      accumulator.source_rollup_ids.add(source.input.record.id);
      accumulator.source_claim_ids.add(claim.source_claim_id);
      for (const leaf of claim.leaf_evidence) {
        const existing = accumulator.leaf_evidence.get(leaf.record_id);
        if (existing && existing !== leaf.digest) conflictingLeafSources.add(source.input.record.id);
        accumulator.leaf_evidence.set(leaf.record_id, leaf.digest);

        const global = globalLeafDigests.get(leaf.record_id);
        if (global && global.digest !== leaf.digest) {
          conflictingLeafSources.add(source.input.record.id);
          for (const sourceId of global.source_ids) conflictingLeafSources.add(sourceId);
        } else if (global) {
          global.source_ids.add(source.input.record.id);
        } else {
          globalLeafDigests.set(leaf.record_id, { digest: leaf.digest, source_ids: new Set([source.input.record.id]) });
        }
      }
      claims.set(semantic, accumulator);
    }
  }

  addReviewReason(
    reasons,
    "claim_identity_conflict",
    "The same source claim id resolves to different claim semantics.",
    [...conflictingClaimSources]
  );
  addReviewReason(
    reasons,
    "leaf_digest_conflict",
    "The same leaf evidence id resolves to different immutable digests.",
    [...conflictingLeafSources]
  );

  return [...claims.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([, claim]) => ({
      claim_id: `episode_claim_${digest({
        version: 1,
        kind: claim.kind,
        normalized_text: claimSemanticKey(claim.kind, claim.text)
      }).slice(0, 32)}`,
      kind: claim.kind,
      text: claim.text,
      source_rollup_ids: [...claim.source_rollup_ids].sort(compareCodeUnits),
      source_claim_ids: [...claim.source_claim_ids].sort(compareCodeUnits),
      leaf_evidence: [...claim.leaf_evidence.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([record_id, leafDigest]) => ({ record_id, digest: leafDigest }))
    }));
}

function allLeafEvidence(sources: readonly SourceAnalysis[]): EpisodeLeafEvidence[] {
  const leaves = new Map<string, string>();
  for (const source of sources) {
    for (const leaf of source.lineage.leaf_evidence) leaves.set(leaf.record_id, leaf.digest);
  }
  return [...leaves.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([record_id, leafDigest]) => ({ record_id, digest: leafDigest }));
}

function coverageFor(
  sources: readonly SourceAnalysis[],
  claims: readonly EpisodeClaim[],
  leaves: readonly EpisodeLeafEvidence[],
  coldCount: number,
  warmCount: number
): EpisodeRollupCoverage {
  const coveredSourceIds = new Set(claims.flatMap((claim) => claim.source_rollup_ids));
  const coveredLeaves = new Set(
    claims.flatMap((claim) => claim.leaf_evidence.map((leaf) => `${leaf.record_id}\u0000${leaf.digest}`))
  );
  const coveredSources = sources.filter(
    (source) =>
      source.fully_covered &&
      coveredSourceIds.has(source.input.record.id) &&
      source.lineage.leaf_evidence.every((leaf) => coveredLeaves.has(`${leaf.record_id}\u0000${leaf.digest}`))
  ).length;
  return {
    total_source_rollups: sources.length,
    covered_source_rollups: coveredSources,
    coverage_ratio: sources.length === 0 ? 0 : coveredSources / sources.length,
    source_leaf_evidence: leaves.length,
    covered_leaf_evidence: leaves.filter((leaf) => coveredLeaves.has(`${leaf.record_id}\u0000${leaf.digest}`)).length,
    output_claims: claims.length,
    claims_with_leaf_evidence: claims.filter((claim) => claim.leaf_evidence.length > 0).length,
    cold_source_rollups: coldCount,
    preserved_warm_rollups: warmCount
  };
}

function normalizedSource(source: RecordSource): RecordSource {
  return {
    client: source.client.trim(),
    ...(source.session_id?.trim() ? { session_id: source.session_id.trim() } : {}),
    ...(source.model?.trim() ? { model: source.model.trim() } : {}),
    ...(source.device_id?.trim() ? { device_id: source.device_id.trim() } : {})
  };
}

function buildRollupRecord(input: {
  planId: string;
  identity: EpisodeRollupIdentity;
  sources: SourceAnalysis[];
  privacy: Exclude<EpisodePrivacyBoundary, "mixed">;
  sourceDigest: string;
  sourceDigests: EpisodeSourceDigest[];
  leafEvidence: EpisodeLeafEvidence[];
  claims: EpisodeClaim[];
  coverage: EpisodeRollupCoverage;
  coldCandidates: EpisodeColdCandidate[];
}): EpisodeRollupRecord {
  const sourceIds = input.sources.map((source) => source.input.record.id).sort(compareCodeUnits);
  const closedTimes = input.sources.map((source) => source.input.closed_at!).sort(compareCodeUnits);
  const updatedAt = input.sources
    .map((source) => source.input.record.updated_at)
    .sort(compareCodeUnits)
    .at(-1)!;
  const tags = new Set(["episode-rollup", `episode-bucket:${input.identity.bucket_kind}`]);
  if (input.privacy === "private") tags.add("private");
  const sourceDigestMap = Object.fromEntries(input.sourceDigests.map((source) => [source.record_id, source.digest]));
  return {
    id: `rec_${input.planId}`,
    kind: "session_summary",
    type: "episode_rollup",
    scope: "project",
    project_id: input.identity.project_id,
    tags: [...tags].sort(compareCodeUnits),
    content: {
      text: `Episode ${input.identity.bucket_kind} ${input.identity.bucket_key}: ${sourceIds.length} closed sessions, ${input.claims.length} lineage-backed claims.`,
      format: "json",
      episode_rollup_version: 1,
      episode_rollup_plan_id: input.planId,
      bucket: input.identity,
      closed_from: closedTimes[0]!,
      closed_through: closedTimes.at(-1)!,
      source_rollup_ids: sourceIds,
      source_digest: input.sourceDigest,
      source_digests: input.sourceDigests,
      leaf_evidence: input.leafEvidence,
      claims: input.claims,
      coverage: input.coverage,
      memory_retention: {
        version: 2,
        layer: "L1",
        trust_state: "candidate",
        retention: { tier: "warm" },
        lineage: {
          derived_from: sourceIds,
          covered_record_ids: input.coldCandidates.map((candidate) => candidate.record_id).sort(compareCodeUnits),
          source_digests: sourceDigestMap,
          compression_level: 2,
          coverage_verified: true
        }
      }
    },
    state: "candidate",
    confidence: Math.min(...input.sources.map((source) => source.input.record.confidence)),
    priority: "normal",
    visibility: "active",
    created_at: updatedAt,
    updated_at: updatedAt,
    source: normalizedSource({ client: "moryn", session_id: "episode-rollup-v1", device_id: "moryn-derived-v1" }),
    provenance: {
      derived_from: sourceIds,
      reason: "Deterministic multi-session episode rollup with leaf-evidence lineage.",
      method: "rule-promoted"
    }
  };
}

function sourceDigestList(sources: readonly SourceAnalysis[]): EpisodeSourceDigest[] {
  return sources
    .map((source) => ({
      record_id: source.input.record.id,
      closed_at: source.input.closed_at!,
      updated_at: source.input.record.updated_at,
      privacy: source.private ? ("private" as const) : ("public" as const),
      digest: recordDigest(source.input.record)
    }))
    .sort((left, right) => compareCodeUnits(left.record_id, right.record_id));
}

function buildPlan(
  identity: EpisodeRollupIdentity,
  inputRecords: readonly BucketRecord[],
  policy: EpisodeRollupPlanningPolicy
): EpisodeRollupPlan {
  const bucketRecords = uniqueBucketRecords(inputRecords);
  const closedInputs = bucketRecords.filter((input) => input.closed_at !== undefined);
  const sources = closedInputs.map(analyzeSource);
  const reasons: EpisodeRollupReviewReason[] = [];
  const deferredReasons: EpisodeRollupDeferredReason[] = [];
  const privacy = privacyBoundary(sources);

  addReviewReason(
    reasons,
    "invalid_closed_at",
    "A rollup declares closed_at, but it is not a canonical ISO timestamp.",
    bucketRecords
      .filter(
        ({ record, closed_at }) =>
          closed_at === undefined && (record.content as Record<string, unknown>).closed_at !== undefined
      )
      .map(({ record }) => record.id)
  );
  addReviewReason(
    reasons,
    "not_l1_session_rollup",
    "Episode Rollup only accepts lineage-verified L1 session rollups.",
    sources.filter((source) => !source.l1).map((source) => source.input.record.id)
  );
  addReviewReason(
    reasons,
    "missing_lineage",
    "A closed session rollup has no verified leaf-evidence lineage.",
    sources.filter((source) => source.lineage.missing).map((source) => source.input.record.id)
  );
  addReviewReason(
    reasons,
    "lineage_digest_mismatch",
    "A session rollup source digest does not match its declared leaf lineage.",
    sources.filter((source) => source.lineage.digest_mismatch).map((source) => source.input.record.id)
  );
  addReviewReason(
    reasons,
    "incomplete_coverage",
    "At least one source rollup cannot expand every claim to all declared leaf evidence.",
    sources.filter((source) => source.lineage.incomplete).map((source) => source.input.record.id)
  );
  addReviewReason(
    reasons,
    "unresolved_conflict",
    "Conflicted session rollups require review before cross-session compaction.",
    sources.filter((source) => source.conflicted).map((source) => source.input.record.id)
  );
  addReviewReason(
    reasons,
    "quarantined_source",
    "Quarantined session rollups cannot be consumed automatically.",
    sources.filter((source) => source.quarantined).map((source) => source.input.record.id)
  );
  addReviewReason(
    reasons,
    "unique_protected_information",
    "Pinned, high-priority, or explicitly protected information must remain independently reviewable.",
    sources.filter((source) => source.protected).map((source) => source.input.record.id)
  );
  if (privacy === "mixed") {
    addReviewReason(
      reasons,
      "mixed_privacy_boundary",
      "Public and private session rollups must not cross an Episode Rollup boundary automatically.",
      sources.map((source) => source.input.record.id)
    );
  }

  const claims = mergeClaims(sources, reasons);
  const leafEvidence = allLeafEvidence(sources);
  const hasGlobalSafetyReview = reasons.length > 0;
  const cutoff = Date.parse(policy.now) - policy.recent_window_days * DAY_MILLISECONDS;
  const coldCandidates: EpisodeColdCandidate[] = hasGlobalSafetyReview
    ? []
    : sources
        .filter((source) => source.fully_covered && Date.parse(source.input.closed_at!) <= cutoff)
        .map((source) => ({
          record_id: source.input.record.id,
          closed_at: source.input.closed_at!,
          reason: "old_and_fully_covered" as const
        }))
        .sort((left, right) => compareCodeUnits(left.record_id, right.record_id));

  const warmCandidates: EpisodeWarmCandidate[] = [];
  for (const input of bucketRecords) {
    const source = sources.find((candidate) => candidate.input.record.id === input.record.id);
    if (!input.closed_at) {
      warmCandidates.push({ record_id: input.record.id, reason: "unfinished", digest: recordDigest(input.record) });
    } else if (hasGlobalSafetyReview || !source?.fully_covered) {
      warmCandidates.push({
        record_id: input.record.id,
        reason: source?.lineage.incomplete ? "incomplete_coverage" : "safety_review",
        digest: recordDigest(input.record),
        closed_at: input.closed_at
      });
    } else if (Date.parse(input.closed_at) > cutoff) {
      warmCandidates.push({
        record_id: input.record.id,
        reason: "recent",
        digest: recordDigest(input.record),
        closed_at: input.closed_at
      });
    }
  }
  warmCandidates.sort((left, right) => compareCodeUnits(left.record_id, right.record_id));

  const sourceDigests = sourceDigestList(sources);
  const sourceDigest = digest(
    sourceDigests.map(({ record_id, digest: sourceHash }) => ({ record_id, digest: sourceHash }))
  );
  const observationDigest = digest(
    bucketRecords.map(({ record, closed_at }) => ({ record_id: record.id, closed_at, digest: recordDigest(record) }))
  );
  const planId = `episode_rollup_${digest({
    version: 1,
    identity,
    policy,
    source_digest: sourceDigest,
    observation_digest: observationDigest
  }).slice(0, 32)}`;
  const coverage = coverageFor(sources, claims, leafEvidence, coldCandidates.length, warmCandidates.length);

  if (closedInputs.length === 0) {
    addDeferredReason(
      deferredReasons,
      "no_closed_sessions",
      "Only unfinished session rollups are present; they remain warm.",
      bucketRecords.map(({ record }) => record.id)
    );
  } else if (coldCandidates.length === 0 && reasons.length === 0) {
    addDeferredReason(
      deferredReasons,
      "recent_sources_preserved",
      "All fully covered session rollups are still inside the warm recency window.",
      sources.map((source) => source.input.record.id)
    );
  }
  if (identity.bucket_kind === "day" && identity.bucket_key >= policy.now.slice(0, 10)) {
    addDeferredReason(
      deferredReasons,
      "bucket_not_closed",
      "The current or future UTC day is not eligible for automatic Episode Rollup.",
      bucketRecords.map(({ record }) => record.id)
    );
  }

  const status: EpisodeRollupStatus =
    reasons.length > 0 ? "review_required" : deferredReasons.length > 0 ? "deferred" : "ready";
  const rollup =
    reasons.length === 0 && sources.length > 0 && privacy !== "mixed"
      ? buildRollupRecord({
          planId,
          identity,
          sources,
          privacy,
          sourceDigest,
          sourceDigests,
          leafEvidence,
          claims,
          coverage,
          coldCandidates
        })
      : undefined;

  return {
    version: 1,
    plan_id: planId,
    identity,
    policy,
    status,
    auto_rollup: status === "ready" && identity.bucket_kind === "day",
    privacy_boundary: privacy,
    source_digest: sourceDigest,
    observation_digest: observationDigest,
    source_digests: sourceDigests,
    source_record_ids: sources.map((source) => source.input.record.id).sort(compareCodeUnits),
    leaf_evidence: leafEvidence,
    claims,
    ...(rollup ? { rollup_record: rollup } : {}),
    coverage,
    cold_candidates: coldCandidates,
    warm_candidates: warmCandidates,
    review_reasons: reasons,
    deferred_reasons: deferredReasons
  };
}

export function planEpisodeRollups(
  records: readonly MorynRecord[],
  options: PlanEpisodeRollupsOptions
): EpisodeRollupPlan[] {
  const policy = normalizedPolicy(options);
  const kind = options.bucket_kind ?? "day";
  const requestedProject = options.project_id?.trim();
  const groups = new Map<string, { identity: EpisodeRollupIdentity; records: BucketRecord[] }>();
  for (const record of records) {
    const source = episodeRollupSourceBucket(record, kind);
    if (!source || (requestedProject && source.identity.project_id !== requestedProject)) continue;
    const groupKey = `${source.identity.project_id}\u0000${kind}\u0000${source.identity.bucket_key}`;
    const group = groups.get(groupKey) ?? { identity: source.identity, records: [] };
    group.records.push({ record, ...(source.closed_at ? { closed_at: source.closed_at } : {}) });
    groups.set(groupKey, group);
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        compareCodeUnits(left.identity.project_id, right.identity.project_id) ||
        compareCodeUnits(left.identity.bucket_kind, right.identity.bucket_kind) ||
        compareCodeUnits(left.identity.bucket_key, right.identity.bucket_key)
    )
    .map((group) => buildPlan(group.identity, group.records, policy));
}

export function planEpisodeRollup(
  records: readonly MorynRecord[],
  identity: EpisodeRollupIdentity,
  policy: EpisodeRollupPlanningPolicy
): EpisodeRollupPlan | undefined {
  const projectId = identity.project_id.trim();
  const bucketKeyValue = identity.bucket_key.trim();
  if (!projectId || !bucketKeyValue || !EPISODE_BUCKET_KINDS.includes(identity.bucket_kind)) {
    throw new Error("Invalid Episode Rollup identity");
  }
  return planEpisodeRollups(records, {
    now: policy.now,
    recent_window_days: policy.recent_window_days,
    project_id: projectId,
    bucket_kind: identity.bucket_kind
  }).find((plan) => plan.identity.bucket_key === bucketKeyValue);
}
