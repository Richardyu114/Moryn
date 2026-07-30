import { createHash } from "node:crypto";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord, RecordKind, RecordMemoryUsage, RecordScope, RecordState } from "./types.js";

export const MEMORY_RETENTION_METADATA_KEY = "memory_retention" as const;

export const MEMORY_LAYERS = ["L0", "L1", "L2", "L3"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export const MEMORY_RETENTION_TIERS = ["hot", "warm", "cold", "purged"] as const;
export type MemoryRetentionTier = (typeof MEMORY_RETENTION_TIERS)[number];

export const MEMORY_TRUST_STATES = ["raw", "candidate", "canonical", "quarantined", "legacy_unknown"] as const;
export type MemoryTrustState = (typeof MEMORY_TRUST_STATES)[number];

export type MemoryLayerName = "evidence" | "episodic" | "semantic_procedural" | "identity";
export type MemoryValidityStatus = "current" | "stale" | "expired" | "unbounded" | "not_evaluated";
export type RetentionWindowStatus = "active" | "elapsed" | "unbounded" | "not_evaluated";
export type ProtectedMemorySignal =
  | "command"
  | "date"
  | "negation_or_requirement"
  | "number"
  | "path"
  | "permission_or_security"
  | "preference_or_identity"
  | "version";

export type AutomaticRetentionBlocker =
  | "already_cold_or_purged"
  | "already_purged"
  | "canonical"
  | "conflict"
  | "durable_kind"
  | "high_priority"
  | "identity_layer"
  | "legacy_unknown_trust"
  | "never_forget"
  | "not_cold"
  | "not_evidence_layer"
  | "not_verified_covered"
  | "pinned"
  | "private"
  | "protected_content"
  | "protected_type"
  | "quarantined"
  | "unsupported_trust_state";

export type MemoryRetentionWarningCode =
  | "inconsistent_value"
  | "invalid_timestamp"
  | "invalid_type"
  | "invalid_value"
  | "limit_exceeded"
  | "unsupported_version";

export interface MemoryRetentionWarning {
  code: MemoryRetentionWarningCode;
  path: string;
}

export interface MemoryRetentionReason {
  axis: "layer" | "lineage" | "retention" | "safety" | "trust" | "validity";
  code: string;
  explanation: string;
}

export interface MemoryRetentionMetadataV2 {
  version: 2;
  layer?: MemoryLayer;
  trust_state?: Exclude<MemoryTrustState, "legacy_unknown">;
  retention?: {
    tier?: MemoryRetentionTier;
    pinned?: boolean;
    never_forget?: boolean;
  };
  policy?: {
    id?: string;
    retain_until?: string;
  };
  validity?: {
    valid_until?: string;
    stale_at?: string;
    last_verified_at?: string;
  };
  usage?: {
    last_recalled_at?: string;
    last_useful_at?: string;
    last_rejected_at?: string;
    recall_count?: number;
    useful_count?: number;
    rejected_count?: number;
  };
  lineage?: {
    derived_from?: string[];
    covered_record_ids?: string[];
    covered_by_record_ids?: string[];
    source_digests?: Record<string, string>;
    compression_level?: number;
    coverage_verified?: boolean;
  };
}

export interface NormalizedMemoryRetentionMetadataV2 {
  layer?: MemoryLayer;
  trust_state?: Exclude<MemoryTrustState, "legacy_unknown">;
  retention: {
    tier?: MemoryRetentionTier;
    pinned?: boolean;
    never_forget?: boolean;
  };
  policy: {
    id?: string;
    retain_until?: string;
  };
  validity: {
    valid_until?: string;
    stale_at?: string;
    last_verified_at?: string;
  };
  usage: {
    last_recalled_at?: string;
    last_useful_at?: string;
    last_rejected_at?: string;
    recall_count?: number;
    useful_count?: number;
    rejected_count?: number;
  };
  lineage: {
    derived_from: string[];
    covered_record_ids: string[];
    covered_by_record_ids: string[];
    source_digests: Record<string, string>;
    compression_level?: number;
    coverage_verified?: boolean;
  };
}

export interface ParsedMemoryRetentionMetadataV2 {
  present: boolean;
  supported: boolean;
  valid: boolean;
  metadata?: NormalizedMemoryRetentionMetadataV2;
  warnings: MemoryRetentionWarning[];
}

export interface MemoryLayerAxisV2 {
  level: MemoryLayer;
  name: MemoryLayerName;
  source: "inferred" | "metadata" | "safety_floor";
}

export interface MemoryTrustAxisV2 {
  state: MemoryTrustState;
  source_state: RecordState;
  source: "record" | "metadata" | "legacy";
}

export interface MemoryRetentionPolicyViewV2 {
  id: string;
  source: "default" | "metadata";
  retain_until?: string;
  window_status: RetentionWindowStatus;
}

export interface MemoryRetentionAxisV2 {
  tier: MemoryRetentionTier;
  source: "compatibility" | "default" | "metadata" | "safety";
  pinned: boolean;
  never_forget: boolean;
  policy: MemoryRetentionPolicyViewV2;
}

export interface MemoryValidityViewV2 {
  status: MemoryValidityStatus;
  valid_until?: string;
  stale_at?: string;
  last_verified_at?: string;
}

export interface MemoryUsageViewV2 {
  last_recalled_at?: string;
  last_useful_at?: string;
  last_rejected_at?: string;
  recall_count: number;
  useful_count: number;
  rejected_count: number;
}

export interface MemoryLineageViewV2 {
  derived_from: string[];
  covered_record_ids: string[];
  covered_by_record_ids: string[];
  source_digests: Record<string, string>;
  compression_level: number;
  coverage_verified: boolean;
}

export interface MemoryRetentionSafetyV2 {
  private: boolean;
  conflicted: boolean;
  protected_type: boolean;
  protected_signals: ProtectedMemorySignal[];
  automatic_archive_safe: boolean;
  automatic_purge_safe: boolean;
  archive_blockers: AutomaticRetentionBlocker[];
  purge_blockers: AutomaticRetentionBlocker[];
}

export interface MemoryRetentionViewV2 {
  version: 2;
  record_id: string;
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  layer: MemoryLayerAxisV2;
  trust: MemoryTrustAxisV2;
  retention: MemoryRetentionAxisV2;
  validity: MemoryValidityViewV2;
  usage: MemoryUsageViewV2;
  lineage: MemoryLineageViewV2;
  safety: MemoryRetentionSafetyV2;
  metadata: {
    present: boolean;
    supported: boolean;
    valid: boolean;
    warnings: MemoryRetentionWarning[];
  };
  warnings: MemoryRetentionWarning[];
  reasons: MemoryRetentionReason[];
}

export interface MemoryRetentionReadModelV2 {
  version: 2;
  generated_at?: string;
  records: MemoryRetentionViewV2[];
  records_by_id: Record<string, MemoryRetentionViewV2>;
  stats: {
    total_records: number;
    layers: Record<MemoryLayer, number>;
    trust_states: Record<MemoryTrustState, number>;
    tiers: Record<MemoryRetentionTier, number>;
    pinned_records: number;
    never_forget_records: number;
    automatic_archive_safe_records: number;
    automatic_purge_safe_records: number;
    malformed_metadata_records: number;
  };
}

export interface MemoryRetentionViewOptions {
  now?: string;
  default_policy_ids?: Partial<Record<MemoryLayer, string>>;
}

const LAYER_NAMES: Record<MemoryLayer, MemoryLayerName> = {
  L0: "evidence",
  L1: "episodic",
  L2: "semantic_procedural",
  L3: "identity"
};

export const DEFAULT_MEMORY_RETENTION_POLICY_IDS: Readonly<Record<MemoryLayer, string>> = Object.freeze({
  L0: "default_l0_evidence_v2",
  L1: "default_l1_episodic_v2",
  L2: "default_l2_semantic_v2",
  L3: "default_l3_identity_v2"
});

const SESSION_EVIDENCE_TYPES = new Set([
  "checkpoint",
  "handoff_status",
  "learning_inbox",
  "observation",
  "status",
  "trace",
  "transcript"
]);

const EPISODIC_TYPES = new Set([
  "daily_rollup",
  "final_summary",
  "handoff",
  "session_summary",
  "summary",
  "task_rollup",
  "task_summary"
]);

const IDENTITY_TYPES = new Set([
  "collaboration_preference",
  "identity",
  "identity_rule",
  "preference",
  "principle",
  "process_preference",
  "user_preference",
  "working_principle",
  "writing_style_preference"
]);

const PROTECTED_TYPES = new Set([
  "blocker",
  "conflict",
  "credential_rule",
  "deployment_rule",
  "identity",
  "identity_rule",
  "permission_rule",
  "preference",
  "principle",
  "rule",
  "security",
  "security_rule",
  "sync_config",
  "sync_configuration",
  "warning"
]);

const PROTECTED_SIGNAL_PATTERNS: ReadonlyArray<readonly [ProtectedMemorySignal, RegExp]> = [
  ["command", /\b(?:npm|pnpm|yarn|git|moryn|node|npx|python|cargo|go)\s+[\p{L}\p{N}:@._/-]+/iu],
  ["date", /\b\d{4}-\d{2}-\d{2}(?:[tT]\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?[zZ]?)?\b/u],
  [
    "negation_or_requirement",
    /\b(?:not|never|must|should|cannot|can't|forbid(?:den)?)\b|(?:禁止|必须|不应|不能|不要|应当)/iu
  ],
  ["number", /\b\d+(?:\.\d+)?%?\b/u],
  ["path", /(?:^|\s)(?:\.?\.?\/|[\p{L}\p{N}_.-]+\/)[\p{L}\p{N}_./-]+/u],
  [
    "permission_or_security",
    /\b(?:permission|security|credential|token|password|secret|destructive|delete|push|publish)\b|\bprivate\s+(?:key|credential|token|data|file|record|content|repository|repo|endpoint)\b|(?:权限|安全|凭据|令牌|密码|私有(?:密钥|凭据|令牌|数据|文件|记录|内容|仓库|端点)|删除|发布)/iu
  ],
  [
    "preference_or_identity",
    /\b(?:prefer(?:s|red|ring)?|preference|principle|identity)\b|(?:偏好|原则|身份|协作风格)/iu
  ],
  ["version", /\bv?\d+(?:\.\d+){1,3}(?:[-+][\p{L}\p{N}.-]+)?\b/iu]
];

const MAX_METADATA_LIST_ITEMS = 256;
const MAX_METADATA_STRING_LENGTH = 512;
const MAX_POLICY_ID_LENGTH = 200;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizedType(type: string): string {
  return type
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function warning(warnings: MemoryRetentionWarning[], code: MemoryRetentionWarningCode, path: string): void {
  warnings.push({ code, path });
}

function sortedWarnings(warnings: readonly MemoryRetentionWarning[]): MemoryRetentionWarning[] {
  const keyed = new Map(warnings.map((item) => [`${item.path}\u0000${item.code}`, item]));
  return [...keyed.values()].sort(
    (left, right) => compareCodeUnits(left.path, right.path) || compareCodeUnits(left.code, right.code)
  );
}

function nestedObject(
  value: unknown,
  path: string,
  warnings: MemoryRetentionWarning[]
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    warning(warnings, "invalid_type", path);
    return undefined;
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  warnings: MemoryRetentionWarning[]
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    warning(warnings, "invalid_value", path);
    return undefined;
  }
  return value as T[number];
}

function booleanValue(value: unknown, path: string, warnings: MemoryRetentionWarning[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    warning(warnings, "invalid_type", path);
    return undefined;
  }
  return value;
}

function boundedString(
  value: unknown,
  path: string,
  warnings: MemoryRetentionWarning[],
  maximum = MAX_METADATA_STRING_LENGTH
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    warning(warnings, "invalid_type", path);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    warning(warnings, "invalid_value", path);
    return undefined;
  }
  return normalized;
}

function timestampValue(value: unknown, path: string, warnings: MemoryRetentionWarning[]): string | undefined {
  if (value === undefined) return undefined;
  if (!canonicalTimestamp(value)) {
    warning(warnings, "invalid_timestamp", path);
    return undefined;
  }
  return value;
}

function countValue(value: unknown, path: string, warnings: MemoryRetentionWarning[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    warning(warnings, "invalid_value", path);
    return undefined;
  }
  return value;
}

function stringList(value: unknown, path: string, warnings: MemoryRetentionWarning[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warning(warnings, "invalid_type", path);
    return [];
  }
  if (value.length > MAX_METADATA_LIST_ITEMS) warning(warnings, "limit_exceeded", path);
  const selected: string[] = [];
  for (const [index, item] of value.slice(0, MAX_METADATA_LIST_ITEMS).entries()) {
    if (typeof item !== "string") {
      warning(warnings, "invalid_type", `${path}.${index}`);
      continue;
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > MAX_METADATA_STRING_LENGTH) {
      warning(warnings, "invalid_value", `${path}.${index}`);
      continue;
    }
    selected.push(normalized);
  }
  return uniqueSorted(selected);
}

function sourceDigests(value: unknown, path: string, warnings: MemoryRetentionWarning[]): Record<string, string> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    warning(warnings, "invalid_type", path);
    return {};
  }
  const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
  if (entries.length > MAX_METADATA_LIST_ITEMS) warning(warnings, "limit_exceeded", path);
  const selected: Array<[string, string]> = [];
  for (const [recordId, digest] of entries.slice(0, MAX_METADATA_LIST_ITEMS)) {
    const normalizedId = recordId.trim();
    if (
      !normalizedId ||
      normalizedId.length > MAX_METADATA_STRING_LENGTH ||
      typeof digest !== "string" ||
      !SHA256_PATTERN.test(digest)
    ) {
      warning(warnings, "invalid_value", `${path}.${recordId}`);
      continue;
    }
    selected.push([normalizedId, digest.toLowerCase()]);
  }
  return Object.fromEntries(selected);
}

export function parseMemoryRetentionMetadata(record: MorynRecord): ParsedMemoryRetentionMetadataV2 {
  const raw = record.content[MEMORY_RETENTION_METADATA_KEY];
  if (raw === undefined) return { present: false, supported: true, valid: true, warnings: [] };
  const warnings: MemoryRetentionWarning[] = [];
  const rootPath = `content.${MEMORY_RETENTION_METADATA_KEY}`;
  if (!isPlainObject(raw)) {
    warning(warnings, "invalid_type", rootPath);
    return { present: true, supported: false, valid: false, warnings: sortedWarnings(warnings) };
  }
  if (raw.version !== 2) {
    warning(warnings, "unsupported_version", `${rootPath}.version`);
    return { present: true, supported: false, valid: false, warnings: sortedWarnings(warnings) };
  }

  const retention = nestedObject(raw.retention, `${rootPath}.retention`, warnings);
  const policy = nestedObject(raw.policy, `${rootPath}.policy`, warnings);
  const validity = nestedObject(raw.validity, `${rootPath}.validity`, warnings);
  const usage = nestedObject(raw.usage, `${rootPath}.usage`, warnings);
  const lineage = nestedObject(raw.lineage, `${rootPath}.lineage`, warnings);

  const recallCount = countValue(usage?.recall_count, `${rootPath}.usage.recall_count`, warnings);
  let usefulCount = countValue(usage?.useful_count, `${rootPath}.usage.useful_count`, warnings);
  if (recallCount !== undefined && usefulCount !== undefined && usefulCount > recallCount) {
    warning(warnings, "inconsistent_value", `${rootPath}.usage.useful_count`);
    usefulCount = recallCount;
  }
  let rejectedCount = countValue(usage?.rejected_count, `${rootPath}.usage.rejected_count`, warnings);
  if (recallCount !== undefined && rejectedCount !== undefined && (usefulCount ?? 0) + rejectedCount > recallCount) {
    warning(warnings, "inconsistent_value", `${rootPath}.usage.rejected_count`);
    rejectedCount = Math.max(0, recallCount - (usefulCount ?? 0));
  }

  const coveredRecordIds = stringList(lineage?.covered_record_ids, `${rootPath}.lineage.covered_record_ids`, warnings);
  const coveredByRecordIds = stringList(
    lineage?.covered_by_record_ids,
    `${rootPath}.lineage.covered_by_record_ids`,
    warnings
  );
  let coverageVerified = booleanValue(lineage?.coverage_verified, `${rootPath}.lineage.coverage_verified`, warnings);
  if (coverageVerified === true && coveredRecordIds.length === 0 && coveredByRecordIds.length === 0) {
    warning(warnings, "inconsistent_value", `${rootPath}.lineage.coverage_verified`);
    coverageVerified = false;
  }

  const metadata: NormalizedMemoryRetentionMetadataV2 = {
    layer: enumValue(raw.layer, MEMORY_LAYERS, `${rootPath}.layer`, warnings),
    trust_state: enumValue(
      raw.trust_state,
      ["raw", "candidate", "canonical", "quarantined"] as const,
      `${rootPath}.trust_state`,
      warnings
    ),
    retention: {
      tier: enumValue(retention?.tier, MEMORY_RETENTION_TIERS, `${rootPath}.retention.tier`, warnings),
      pinned: booleanValue(retention?.pinned, `${rootPath}.retention.pinned`, warnings),
      never_forget: booleanValue(retention?.never_forget, `${rootPath}.retention.never_forget`, warnings)
    },
    policy: {
      id: boundedString(policy?.id, `${rootPath}.policy.id`, warnings, MAX_POLICY_ID_LENGTH),
      retain_until: timestampValue(policy?.retain_until, `${rootPath}.policy.retain_until`, warnings)
    },
    validity: {
      valid_until: timestampValue(validity?.valid_until, `${rootPath}.validity.valid_until`, warnings),
      stale_at: timestampValue(validity?.stale_at, `${rootPath}.validity.stale_at`, warnings),
      last_verified_at: timestampValue(validity?.last_verified_at, `${rootPath}.validity.last_verified_at`, warnings)
    },
    usage: {
      last_recalled_at: timestampValue(usage?.last_recalled_at, `${rootPath}.usage.last_recalled_at`, warnings),
      last_useful_at: timestampValue(usage?.last_useful_at, `${rootPath}.usage.last_useful_at`, warnings),
      last_rejected_at: timestampValue(usage?.last_rejected_at, `${rootPath}.usage.last_rejected_at`, warnings),
      recall_count: recallCount,
      useful_count: usefulCount,
      rejected_count: rejectedCount
    },
    lineage: {
      derived_from: stringList(lineage?.derived_from, `${rootPath}.lineage.derived_from`, warnings),
      covered_record_ids: coveredRecordIds,
      covered_by_record_ids: coveredByRecordIds,
      source_digests: sourceDigests(lineage?.source_digests, `${rootPath}.lineage.source_digests`, warnings),
      compression_level: countValue(lineage?.compression_level, `${rootPath}.lineage.compression_level`, warnings),
      coverage_verified: coverageVerified
    }
  };
  if (
    metadata.lineage.coverage_verified === true &&
    warnings.some((item) => item.path.startsWith(`${rootPath}.lineage.`))
  ) {
    metadata.lineage.coverage_verified = false;
    warning(warnings, "inconsistent_value", `${rootPath}.lineage.coverage_verified`);
  }
  const normalizedWarnings = sortedWarnings(warnings);
  return {
    present: true,
    supported: true,
    valid: normalizedWarnings.length === 0,
    metadata,
    warnings: normalizedWarnings
  };
}

interface InferredLayer {
  level: MemoryLayer;
  reason: string;
  explanation: string;
}

function inferredLayer(record: MorynRecord): InferredLayer {
  const type = normalizedType(record.type);
  if (record.kind === "soul") {
    return { level: "L3", reason: "layer.kind.soul", explanation: "Soul records belong to identity memory." };
  }
  if (record.kind === "agent_note") {
    return { level: "L0", reason: "layer.kind.agent_note", explanation: "Agent notes are evidence by default." };
  }
  if (record.kind === "skill") {
    return {
      level: "L2",
      reason: "layer.kind.skill",
      explanation: "Skills are durable procedural knowledge."
    };
  }
  if (record.kind === "session_summary") {
    if (SESSION_EVIDENCE_TYPES.has(type)) {
      return {
        level: "L0",
        reason: "layer.session.evidence_type",
        explanation: "Intermediate session status and checkpoints are evidence."
      };
    }
    return {
      level: "L1",
      reason: "layer.session.episodic",
      explanation: "Final and rollup session summaries are episodic memory."
    };
  }
  if (record.scope === "global" && isIdentityType(type)) {
    return {
      level: "L3",
      reason: "layer.memory.global_identity",
      explanation: "Global preferences and principles belong to identity memory."
    };
  }
  if (SESSION_EVIDENCE_TYPES.has(type)) {
    return {
      level: "L0",
      reason: "layer.memory.evidence_type",
      explanation: "Status, checkpoint, and observation records are evidence."
    };
  }
  if (record.scope === "session" || (EPISODIC_TYPES.has(type) && type !== "summary")) {
    return {
      level: "L1",
      reason: "layer.memory.episodic",
      explanation: "Session-scoped and handoff records are episodic memory."
    };
  }
  return {
    level: "L2",
    reason: "layer.memory.semantic",
    explanation: "Memory records are semantic knowledge by default."
  };
}

function isIdentityType(type: string): boolean {
  return (
    IDENTITY_TYPES.has(type) ||
    type.endsWith("_preference") ||
    type.endsWith("_principle") ||
    type.startsWith("identity_")
  );
}

function protectedType(record: MorynRecord): boolean {
  const type = normalizedType(record.type);
  return (
    record.kind === "soul" ||
    PROTECTED_TYPES.has(type) ||
    type.endsWith("_rule") ||
    type.endsWith("_preference") ||
    type.endsWith("_principle") ||
    /^(?:credential|deployment|identity|permission|security)_/u.test(type)
  );
}

function hardMinimumLayer(record: MorynRecord): MemoryLayer {
  if (record.kind === "soul") return "L3";
  if (record.kind === "skill") return "L2";
  if (record.kind === "memory" && record.scope === "global" && isIdentityType(normalizedType(record.type))) return "L3";
  return "L0";
}

function layerRank(layer: MemoryLayer): number {
  return MEMORY_LAYERS.indexOf(layer);
}

export function inferMemoryLayer(record: MorynRecord): MemoryLayer {
  return inferredLayer(record).level;
}

function addReason(
  reasons: MemoryRetentionReason[],
  axis: MemoryRetentionReason["axis"],
  code: string,
  explanation: string
): void {
  reasons.push({ axis, code, explanation });
}

function sortedReasons(reasons: readonly MemoryRetentionReason[]): MemoryRetentionReason[] {
  const keyed = new Map(reasons.map((item) => [`${item.axis}\u0000${item.code}`, item]));
  return [...keyed.values()].sort(
    (left, right) => compareCodeUnits(left.axis, right.axis) || compareCodeUnits(left.code, right.code)
  );
}

function layerAxis(
  record: MorynRecord,
  metadata: NormalizedMemoryRetentionMetadataV2 | undefined,
  reasons: MemoryRetentionReason[]
): MemoryLayerAxisV2 {
  const inferred = inferredLayer(record);
  const explicit = metadata?.layer;
  const minimum = hardMinimumLayer(record);
  if (explicit && layerRank(explicit) < layerRank(minimum)) {
    addReason(
      reasons,
      "layer",
      "layer.metadata.safety_floor",
      "The explicit layer was below the record's safe minimum and was ignored."
    );
    return { level: minimum, name: LAYER_NAMES[minimum], source: "safety_floor" };
  }
  if (explicit) {
    addReason(reasons, "layer", "layer.metadata.accepted", "A valid v2 metadata layer was applied.");
    return { level: explicit, name: LAYER_NAMES[explicit], source: "metadata" };
  }
  addReason(reasons, "layer", inferred.reason, inferred.explanation);
  return { level: inferred.level, name: LAYER_NAMES[inferred.level], source: "inferred" };
}

function archivedRecord(record: MorynRecord): boolean {
  return record.state === "archived" || record.visibility === "archived";
}

function quarantinedRecord(record: MorynRecord): boolean {
  return record.state === "quarantined" || record.visibility === "quarantined";
}

function trustAxis(
  record: MorynRecord,
  metadata: NormalizedMemoryRetentionMetadataV2 | undefined,
  reasons: MemoryRetentionReason[]
): MemoryTrustAxisV2 {
  if (record.state === "archived") {
    if (metadata?.trust_state) {
      addReason(
        reasons,
        "trust",
        "trust.metadata.restored_for_archived",
        "V2 metadata preserved the trust state of a legacy archived record."
      );
      return { state: metadata.trust_state, source_state: record.state, source: "metadata" };
    }
    addReason(
      reasons,
      "trust",
      "trust.legacy_archived_unknown",
      "Legacy archived records do not preserve their prior trust state."
    );
    return { state: "legacy_unknown", source_state: record.state, source: "legacy" };
  }
  const state = record.state as Exclude<RecordState, "archived">;
  if (metadata?.trust_state && metadata.trust_state !== state) {
    addReason(
      reasons,
      "trust",
      "trust.metadata.ignored_for_active_record",
      "The replayed active record state remains authoritative over retention metadata."
    );
  }
  addReason(reasons, "trust", `trust.record.${state}`, "Trust comes from the replayed record state.");
  return { state, source_state: record.state, source: "record" };
}

function collectContentStrings(value: unknown, output: string[], depth = 0): void {
  if (output.length >= 256 || depth > 12) return;
  if (typeof value === "string") {
    if (value.trim()) output.push(value.slice(0, 4_000));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 256)) collectContentStrings(item, output, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (key === MEMORY_RETENTION_METADATA_KEY) continue;
    collectContentStrings(nested, output, depth + 1);
    if (output.length >= 256) break;
  }
}

export function protectedMemorySignals(record: MorynRecord): ProtectedMemorySignal[] {
  const fragments: string[] = [];
  collectContentStrings(record.content, fragments);
  const text = fragments.join("\n");
  return PROTECTED_SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([signal]) => signal);
}

function normalizeProvenanceIds(record: MorynRecord): string[] {
  const values = record.provenance?.derived_from;
  if (!Array.isArray(values)) return [];
  return uniqueSorted(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= MAX_METADATA_STRING_LENGTH)
  );
}

function lineageView(
  record: MorynRecord,
  metadata: NormalizedMemoryRetentionMetadataV2 | undefined,
  warnings: MemoryRetentionWarning[],
  reasons: MemoryRetentionReason[],
  projectedCoveredBy: readonly string[] = []
): MemoryLineageViewV2 {
  const projected = uniqueSorted(projectedCoveredBy);
  const coveredBy = uniqueSorted([...(metadata?.lineage.covered_by_record_ids ?? []), ...projected]);
  let coverageVerified = metadata?.lineage.coverage_verified === true || projected.length > 0;
  if (coverageVerified && coveredBy.length === 0 && (metadata?.lineage.covered_record_ids.length ?? 0) === 0) {
    coverageVerified = false;
    warning(warnings, "inconsistent_value", `content.${MEMORY_RETENTION_METADATA_KEY}.lineage.coverage_verified`);
  }
  const derivedFrom = uniqueSorted([...normalizeProvenanceIds(record), ...(metadata?.lineage.derived_from ?? [])]);
  if (derivedFrom.length) {
    addReason(reasons, "lineage", "lineage.sources_present", "The record retains source record identifiers.");
  }
  if (coverageVerified) {
    addReason(
      reasons,
      "lineage",
      "lineage.coverage_verified",
      "Coverage lineage was verified before lifecycle reduction."
    );
  }
  if (projected.length) {
    addReason(
      reasons,
      "lineage",
      "lineage.coverage_projected_from_verified_rollup",
      "Verified rollup digests projected reverse coverage onto this source record."
    );
  }
  return {
    derived_from: derivedFrom,
    covered_record_ids: metadata?.lineage.covered_record_ids ?? [],
    covered_by_record_ids: coveredBy,
    source_digests: metadata?.lineage.source_digests ?? {},
    compression_level: metadata?.lineage.compression_level ?? 0,
    coverage_verified: coverageVerified
  };
}

function resolvedNow(options: MemoryRetentionViewOptions, warnings: MemoryRetentionWarning[]): string | undefined {
  if (options.now === undefined) return undefined;
  if (!canonicalTimestamp(options.now)) {
    warning(warnings, "invalid_timestamp", "options.now");
    return undefined;
  }
  return options.now;
}

function legacyValidUntil(record: MorynRecord, warnings: MemoryRetentionWarning[]): string | undefined {
  const value = record.content.valid_until;
  if (value === undefined) return undefined;
  if (!canonicalTimestamp(value)) {
    warning(warnings, "invalid_timestamp", "content.valid_until");
    return undefined;
  }
  return value;
}

function validityView(
  record: MorynRecord,
  metadata: NormalizedMemoryRetentionMetadataV2 | undefined,
  feedback: RecordMemoryUsage | undefined,
  now: string | undefined,
  warnings: MemoryRetentionWarning[],
  reasons: MemoryRetentionReason[]
): MemoryValidityViewV2 {
  const metadataValidUntil = metadata?.validity.valid_until;
  const legacy = metadataValidUntil ? undefined : legacyValidUntil(record, warnings);
  const validUntil = metadataValidUntil ?? legacy;
  const staleAt = metadata?.validity.stale_at;
  const lastVerifiedAt = latestTimestamp(metadata?.validity.last_verified_at, feedback?.last_verified_at);
  if (legacy) {
    addReason(
      reasons,
      "validity",
      "validity.legacy_valid_until",
      "The v1 learning valid_until field was retained in the v2 view."
    );
  }
  let status: MemoryValidityStatus;
  if (!validUntil && !staleAt) status = "unbounded";
  else if (!now) status = "not_evaluated";
  else if (validUntil && validUntil <= now) status = "expired";
  else if (staleAt && staleAt <= now) status = "stale";
  else status = "current";
  addReason(reasons, "validity", `validity.${status}`, `Validity was classified as ${status}.`);
  return {
    status,
    ...(validUntil ? { valid_until: validUntil } : {}),
    ...(staleAt ? { stale_at: staleAt } : {}),
    ...(lastVerifiedAt ? { last_verified_at: lastVerifiedAt } : {})
  };
}

function retentionWindowStatus(retainUntil: string | undefined, now: string | undefined): RetentionWindowStatus {
  if (!retainUntil) return "unbounded";
  if (!now) return "not_evaluated";
  return retainUntil <= now ? "elapsed" : "active";
}

function defaultTier(layer: MemoryLayer, trust: MemoryTrustState): MemoryRetentionTier {
  if (layer === "L3") return "hot";
  if (layer === "L2" && trust === "canonical") return "hot";
  return "warm";
}

function purgeProtection(input: {
  record: MorynRecord;
  layer: MemoryLayer;
  pinned: boolean;
  never_forget: boolean;
  privateRecord: boolean;
  conflicted: boolean;
  protectedType: boolean;
  protectedSignals: ProtectedMemorySignal[];
}): boolean {
  return Boolean(
    input.pinned ||
      input.never_forget ||
      input.privateRecord ||
      input.conflicted ||
      input.protectedType ||
      input.protectedSignals.length ||
      input.layer === "L3" ||
      input.record.kind === "soul" ||
      input.record.kind === "skill" ||
      input.record.state === "canonical" ||
      input.record.priority === "high" ||
      quarantinedRecord(input.record)
  );
}

function retentionAxis(input: {
  record: MorynRecord;
  layer: MemoryLayer;
  trust: MemoryTrustState;
  metadata?: NormalizedMemoryRetentionMetadataV2;
  options: MemoryRetentionViewOptions;
  now?: string;
  privateRecord: boolean;
  conflicted: boolean;
  protectedType: boolean;
  protectedSignals: ProtectedMemorySignal[];
  reasons: MemoryRetentionReason[];
}): MemoryRetentionAxisV2 {
  const intrinsicNeverForget = input.layer === "L3" || input.record.kind === "soul";
  const pinned = input.metadata?.retention.pinned === true;
  const neverForget = intrinsicNeverForget || input.metadata?.retention.never_forget === true;
  if (pinned) addReason(input.reasons, "retention", "retention.pinned", "Pinned records stay in the hot working set.");
  if (neverForget) {
    addReason(
      input.reasons,
      "retention",
      intrinsicNeverForget ? "retention.identity_never_forget" : "retention.never_forget",
      "This record is protected from automatic forgetting."
    );
  }

  let tier = input.metadata?.retention.tier ?? defaultTier(input.layer, input.trust);
  let source: MemoryRetentionAxisV2["source"] = input.metadata?.retention.tier ? "metadata" : "default";
  addReason(
    input.reasons,
    "retention",
    input.metadata?.retention.tier ? "retention.metadata.tier" : `retention.default.${tier}`,
    input.metadata?.retention.tier
      ? "A valid explicit retention tier was applied."
      : `The default ${tier} tier was inferred from layer and trust.`
  );

  if (
    tier === "purged" &&
    purgeProtection({
      record: input.record,
      layer: input.layer,
      pinned,
      never_forget: neverForget,
      privateRecord: input.privateRecord,
      conflicted: input.conflicted,
      protectedType: input.protectedType,
      protectedSignals: input.protectedSignals
    })
  ) {
    tier = "cold";
    source = "safety";
    addReason(
      input.reasons,
      "retention",
      "retention.purged_blocked_by_safety",
      "Protected content cannot be represented as purged without an authorized destructive receipt."
    );
  }
  if (pinned && !archivedRecord(input.record) && !quarantinedRecord(input.record) && tier !== "purged") {
    tier = "hot";
    source = "safety";
    addReason(input.reasons, "retention", "retention.pinned_hot", "Pinning keeps an active record hot.");
  }
  if (archivedRecord(input.record)) {
    tier = "cold";
    source = "compatibility";
    addReason(
      input.reasons,
      "retention",
      "retention.v1_archived_to_cold",
      "V1 archived records map to the v2 cold tier."
    );
  } else if (quarantinedRecord(input.record)) {
    tier = "cold";
    source = "safety";
    addReason(
      input.reasons,
      "retention",
      "retention.quarantined_cold",
      "Quarantined records stay outside the default working set."
    );
  }

  const policyId =
    input.metadata?.policy.id ??
    input.options.default_policy_ids?.[input.layer] ??
    DEFAULT_MEMORY_RETENTION_POLICY_IDS[input.layer];
  const policySource = input.metadata?.policy.id ? "metadata" : "default";
  const retainUntil = input.metadata?.policy.retain_until;
  const windowStatus = retentionWindowStatus(retainUntil, input.now);
  addReason(
    input.reasons,
    "retention",
    `retention.window.${windowStatus}`,
    `The retention window was classified as ${windowStatus}.`
  );
  return {
    tier,
    source,
    pinned,
    never_forget: neverForget,
    policy: {
      id: policyId,
      source: policySource,
      ...(retainUntil ? { retain_until: retainUntil } : {}),
      window_status: windowStatus
    }
  };
}

function conflictedRecord(record: MorynRecord): boolean {
  return Boolean(
    record.conflict?.resolution === "needs_review" || record.links?.some((link) => link.link_type === "conflicts_with")
  );
}

function sortedBlockers(values: readonly AutomaticRetentionBlocker[]): AutomaticRetentionBlocker[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function safetyView(input: {
  record: MorynRecord;
  layer: MemoryLayer;
  trust: MemoryTrustState;
  retention: MemoryRetentionAxisV2;
  lineage: MemoryLineageViewV2;
  privateRecord: boolean;
  conflicted: boolean;
  protectedType: boolean;
  protectedSignals: ProtectedMemorySignal[];
  reasons: MemoryRetentionReason[];
}): MemoryRetentionSafetyV2 {
  const archiveBlockers: AutomaticRetentionBlocker[] = [];
  const purgeBlockers: AutomaticRetentionBlocker[] = [];
  const both = (blocker: AutomaticRetentionBlocker) => {
    archiveBlockers.push(blocker);
    purgeBlockers.push(blocker);
  };

  if (input.retention.tier === "cold" || input.retention.tier === "purged")
    archiveBlockers.push("already_cold_or_purged");
  if (input.retention.tier === "purged") purgeBlockers.push("already_purged");
  else if (input.retention.tier !== "cold") purgeBlockers.push("not_cold");
  if (input.retention.pinned) both("pinned");
  if (input.retention.never_forget) both("never_forget");
  if (input.privateRecord) both("private");
  if (input.conflicted) both("conflict");
  if (quarantinedRecord(input.record)) both("quarantined");
  if (input.layer === "L3") both("identity_layer");
  if (input.record.kind === "soul" || input.record.kind === "skill") both("durable_kind");
  if (input.record.state === "canonical") both("canonical");
  if (input.record.priority === "high") both("high_priority");

  const verifiedSourceCoverage = input.lineage.coverage_verified && input.lineage.covered_by_record_ids.length > 0;
  if (input.protectedType) {
    purgeBlockers.push("protected_type");
    if (!verifiedSourceCoverage) archiveBlockers.push("protected_type");
  }
  if (input.protectedSignals.length) {
    purgeBlockers.push("protected_content");
    if (!verifiedSourceCoverage) archiveBlockers.push("protected_content");
  }
  if (input.layer !== "L0") purgeBlockers.push("not_evidence_layer");
  if (!verifiedSourceCoverage) purgeBlockers.push("not_verified_covered");
  if (input.trust === "legacy_unknown") purgeBlockers.push("legacy_unknown_trust");
  if (input.trust !== "raw" && input.trust !== "candidate" && input.trust !== "legacy_unknown")
    purgeBlockers.push("unsupported_trust_state");

  const normalizedArchiveBlockers = sortedBlockers(archiveBlockers);
  const normalizedPurgeBlockers = sortedBlockers(purgeBlockers);
  for (const signal of input.protectedSignals) {
    addReason(
      input.reasons,
      "safety",
      `safety.protected_signal.${signal}`,
      `The record contains the protected ${signal} signal.`
    );
  }
  if (input.privateRecord)
    addReason(input.reasons, "safety", "safety.private", "Private records require an explicit trusted boundary.");
  if (input.conflicted)
    addReason(input.reasons, "safety", "safety.conflict", "Conflicting records require review before reduction.");
  if (input.protectedType)
    addReason(input.reasons, "safety", "safety.protected_type", "This record type has protected semantics.");
  addReason(
    input.reasons,
    "safety",
    normalizedArchiveBlockers.length ? "safety.archive.requires_review" : "safety.archive.structurally_safe",
    normalizedArchiveBlockers.length
      ? "Automatic archive has one or more safety blockers."
      : "No structural blocker prevents an archive proposal."
  );
  addReason(
    input.reasons,
    "safety",
    normalizedPurgeBlockers.length ? "safety.purge.requires_review" : "safety.purge.structurally_safe",
    normalizedPurgeBlockers.length
      ? "Automatic purge has one or more safety blockers."
      : "The record satisfies structural purge prerequisites; this is not destructive authorization."
  );
  return {
    private: input.privateRecord,
    conflicted: input.conflicted,
    protected_type: input.protectedType,
    protected_signals: [...input.protectedSignals],
    automatic_archive_safe: normalizedArchiveBlockers.length === 0,
    automatic_purge_safe: normalizedPurgeBlockers.length === 0,
    archive_blockers: normalizedArchiveBlockers,
    purge_blockers: normalizedPurgeBlockers
  };
}

function latestTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function usageView(
  metadata: NormalizedMemoryRetentionMetadataV2 | undefined,
  feedback: RecordMemoryUsage | undefined
): MemoryUsageViewV2 {
  const lastRecalledAt = latestTimestamp(metadata?.usage.last_recalled_at, feedback?.last_recalled_at);
  const lastUsefulAt = latestTimestamp(metadata?.usage.last_useful_at, feedback?.last_useful_at);
  const lastRejectedAt = latestTimestamp(metadata?.usage.last_rejected_at, feedback?.last_rejected_at);
  return {
    ...(lastRecalledAt ? { last_recalled_at: lastRecalledAt } : {}),
    ...(lastUsefulAt ? { last_useful_at: lastUsefulAt } : {}),
    ...(lastRejectedAt ? { last_rejected_at: lastRejectedAt } : {}),
    recall_count: (metadata?.usage.recall_count ?? 0) + (feedback?.recall_count ?? 0),
    useful_count: (metadata?.usage.useful_count ?? 0) + (feedback?.useful_count ?? 0),
    rejected_count: (metadata?.usage.rejected_count ?? 0) + (feedback?.rejected_count ?? 0)
  };
}

function buildMemoryRetentionViewInternal(
  record: MorynRecord,
  options: MemoryRetentionViewOptions,
  projectedCoveredBy: readonly string[] = []
): MemoryRetentionViewV2 {
  const parsed = parseMemoryRetentionMetadata(record);
  const metadata = parsed.metadata;
  const warnings = [...parsed.warnings];
  const reasons: MemoryRetentionReason[] = [];
  const now = resolvedNow(options, warnings);
  const layer = layerAxis(record, metadata, reasons);
  const trust = trustAxis(record, metadata, reasons);
  const privateRecord = isPrivateMemoryBoundary(record);
  const conflicted = conflictedRecord(record);
  const isProtectedType = protectedType(record);
  const protectedSignals = protectedMemorySignals(record);
  const lineage = lineageView(record, metadata, warnings, reasons, projectedCoveredBy);
  const validity = validityView(record, metadata, record.memory_usage, now, warnings, reasons);
  const retention = retentionAxis({
    record,
    layer: layer.level,
    trust: trust.state,
    metadata,
    options,
    now,
    privateRecord,
    conflicted,
    protectedType: isProtectedType,
    protectedSignals,
    reasons
  });
  const safety = safetyView({
    record,
    layer: layer.level,
    trust: trust.state,
    retention,
    lineage,
    privateRecord,
    conflicted,
    protectedType: isProtectedType,
    protectedSignals,
    reasons
  });
  const normalizedWarnings = sortedWarnings(warnings);
  return {
    version: 2,
    record_id: record.id,
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    ...(record.project_id ? { project_id: record.project_id } : {}),
    layer,
    trust,
    retention,
    validity,
    usage: usageView(metadata, record.memory_usage),
    lineage,
    safety,
    metadata: {
      present: parsed.present,
      supported: parsed.supported,
      valid: parsed.valid,
      warnings: parsed.warnings
    },
    warnings: normalizedWarnings,
    reasons: sortedReasons(reasons)
  };
}

export function buildMemoryRetentionView(
  record: MorynRecord,
  options: MemoryRetentionViewOptions = {}
): MemoryRetentionViewV2 {
  return buildMemoryRetentionViewInternal(record, options);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function stableRecordKey(record: MorynRecord): string {
  return JSON.stringify(canonicalValue(record));
}

function sessionFoldV1RecordDigest(record: MorynRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalValue({
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
        })
      )
    )
    .digest("hex");
}

function rollupSourceTimestamps(rollup: MorynRecord, sourceId: string, expectedDigest: string): string[] {
  const raw = rollup.content.source_digests;
  if (!Array.isArray(raw)) return [];
  const timestamps: string[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    if (
      item.record_id === sourceId &&
      typeof item.digest === "string" &&
      item.digest.toLowerCase() === expectedDigest &&
      canonicalTimestamp(item.updated_at)
    ) {
      timestamps.push(item.updated_at);
    }
  }
  return uniqueSorted(timestamps);
}

function sourceDigestMatches(source: MorynRecord, rollup: MorynRecord, expectedDigest: string): boolean {
  if (sessionFoldV1RecordDigest(source) === expectedDigest) return true;
  if (!archivedRecord(source)) return false;
  const originalStates = ["raw", "candidate", "canonical"] as const;
  for (const updatedAt of rollupSourceTimestamps(rollup, source.id, expectedDigest)) {
    for (const state of originalStates) {
      const reconstructed: MorynRecord = {
        ...source,
        state,
        visibility: "active",
        updated_at: updatedAt
      };
      if (sessionFoldV1RecordDigest(reconstructed) === expectedDigest) return true;
    }
  }
  return false;
}

function verifiedReverseCoverage(
  records: readonly MorynRecord[],
  views: readonly MemoryRetentionViewV2[]
): Map<string, string[]> {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const coveredBy = new Map<string, Set<string>>();
  for (const rollupView of views) {
    if (!rollupView.lineage.coverage_verified || rollupView.lineage.covered_record_ids.length === 0) continue;
    const rollup = recordsById.get(rollupView.record_id);
    if (!rollup) continue;
    for (const sourceId of rollupView.lineage.covered_record_ids) {
      if (sourceId === rollup.id) continue;
      const source = recordsById.get(sourceId);
      const expectedDigest = rollupView.lineage.source_digests[sourceId];
      if (!source || !expectedDigest || !sourceDigestMatches(source, rollup, expectedDigest)) continue;
      const rollups = coveredBy.get(sourceId) ?? new Set<string>();
      rollups.add(rollup.id);
      coveredBy.set(sourceId, rollups);
    }
  }
  return new Map(
    [...coveredBy.entries()].map(([sourceId, rollupIds]) => [sourceId, [...rollupIds].sort(compareCodeUnits)])
  );
}

function emptyCounts<T extends readonly string[]>(values: T): Record<T[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<T[number], number>;
}

export function buildMemoryRetentionReadModel(
  records: readonly MorynRecord[],
  options: MemoryRetentionViewOptions = {}
): MemoryRetentionReadModelV2 {
  const sortedRecords = [...records].sort(
    (left, right) =>
      compareCodeUnits(left.id, right.id) ||
      compareCodeUnits(left.updated_at, right.updated_at) ||
      compareCodeUnits(stableRecordKey(left), stableRecordKey(right))
  );
  const baseViews = sortedRecords.map((record) => buildMemoryRetentionView(record, options));
  const projectedCoverage = verifiedReverseCoverage(sortedRecords, baseViews);
  const views = sortedRecords.map((record, index) => {
    const coveredBy = projectedCoverage.get(record.id);
    return coveredBy?.length ? buildMemoryRetentionViewInternal(record, options, coveredBy) : baseViews[index]!;
  });
  const layers = emptyCounts(MEMORY_LAYERS);
  const trustStates = emptyCounts(MEMORY_TRUST_STATES);
  const tiers = emptyCounts(MEMORY_RETENTION_TIERS);
  for (const view of views) {
    layers[view.layer.level] += 1;
    trustStates[view.trust.state] += 1;
    tiers[view.retention.tier] += 1;
  }
  return {
    version: 2,
    ...(canonicalTimestamp(options.now) ? { generated_at: options.now } : {}),
    records: views,
    records_by_id: Object.fromEntries(views.map((view) => [view.record_id, view])),
    stats: {
      total_records: views.length,
      layers,
      trust_states: trustStates,
      tiers,
      pinned_records: views.filter((view) => view.retention.pinned).length,
      never_forget_records: views.filter((view) => view.retention.never_forget).length,
      automatic_archive_safe_records: views.filter((view) => view.safety.automatic_archive_safe).length,
      automatic_purge_safe_records: views.filter((view) => view.safety.automatic_purge_safe).length,
      malformed_metadata_records: views.filter((view) => view.metadata.present && !view.metadata.valid).length
    }
  };
}
