import { createHash } from "node:crypto";
import type { SemanticConsolidationProposal, StructuredSemanticMergeField } from "./context-delta.js";
import { buildActiveLogicalMemoryView } from "./logical-memory.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord, RecordPriority, RecordSource, RecordState } from "./types.js";

export const STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY = "structured_semantic_merge";
export const STRUCTURED_SEMANTIC_MERGE_DEVICE_ID = "device_structured_semantic_merge";
export const STRUCTURED_SEMANTIC_MERGE_HIDE_REASON =
  "Source is represented by a verified canonical structured semantic merge.";
export const STRUCTURED_SEMANTIC_MERGE_ACTIVATION_REASON =
  "The deterministic source-snapshot claim was projected before candidate activation.";
export const STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON =
  "All structured merge fields are source-backed and passed deterministic trust validation.";
export const STRUCTURED_SEMANTIC_MERGE_CLAIM_OFFSET_MS = 1;
export const STRUCTURED_SEMANTIC_MERGE_ACTIVATION_OFFSET_MS = 2;
export const STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS = 3;
export const STRUCTURED_SEMANTIC_MERGE_RELATIONSHIP_OFFSET_MS = 4;

export type StructuredSemanticMergeRejectionReason =
  | "missing_record"
  | "inactive_record"
  | "incompatible_domain"
  | "private_boundary"
  | "structured_merge_conflict_relationship"
  | "structured_merge_missing_field_disposition"
  | "structured_merge_invalid_field_disposition"
  | "structured_merge_missing_evidence"
  | "structured_merge_untrusted_evidence"
  | "structured_merge_protected_replacement_requires_user_evidence"
  | "structured_merge_protected_obsolete_requires_user_evidence"
  | "structured_merge_reserved_field_collision"
  | "structured_merge_unsafe_field_name"
  | "structured_merge_empty_content";

export interface StructuredSemanticMergePlanningOptions {
  include_private?: boolean;
}

export interface StructuredSemanticMergeValueLineage {
  value_digest: string;
  source_record_ids: string[];
}

export interface StructuredSemanticMergeFieldLineage {
  field: string;
  disposition: "retain" | "union" | "replace" | "obsolete";
  source_record_ids: string[];
  evidence_record_ids: string[];
  evidence_digests: Record<string, string>;
  values: StructuredSemanticMergeValueLineage[];
}

export interface StructuredSemanticMergeMetadata {
  version: 1;
  relationship: Exclude<SemanticConsolidationProposal["relationship"], "conflicts_with">;
  proposal_source_record_id: string;
  proposal_target_record_id: string;
  source_record_ids: string[];
  source_digests: Record<string, string>;
  evidence_record_ids: string[];
  evidence_digests: Record<string, string>;
  field_lineage: StructuredSemanticMergeFieldLineage[];
}

export interface StructuredSemanticMergePlan {
  version: 1;
  merge_digest: string;
  claim_digest: string;
  source_record_ids: string[];
  source_digests: Record<string, string>;
  evidence_record_ids: string[];
  evidence_digests: Record<string, string>;
  initial_record: MorynRecord;
  final_state: Extract<RecordState, "candidate" | "canonical">;
}

export type StructuredSemanticMergePlanningResult =
  | { status: "ready"; plan: StructuredSemanticMergePlan }
  | { status: "rejected"; reason: StructuredSemanticMergeRejectionReason };

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalStructuredSemanticMergeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalStructuredSemanticMergeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalStructuredSemanticMergeValue(nested)])
    );
  }
  return value;
}

export function structuredSemanticMergeDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalStructuredSemanticMergeValue(value)))
    .digest("hex");
}

export function structuredSemanticMergeTimestamp(plan: StructuredSemanticMergePlan, offset: number): string {
  return new Date(Date.parse(plan.initial_record.created_at) + offset).toISOString();
}

/**
 * Excludes replay-only `updated_at`, preserves meaningful links, and ignores only this
 * transaction's deterministic duplicate-hide link so an exact-plan retry keeps its claim.
 */
export function structuredSemanticMergeSourceDigest(record: MorynRecord): string {
  const semanticLinks = (record.links ?? []).filter(
    (link) =>
      !(
        link.reason === STRUCTURED_SEMANTIC_MERGE_HIDE_REASON &&
        link.link_type === "duplicate_of" &&
        link.record_id.startsWith("rec_semantic_merge_")
      )
  );
  return structuredSemanticMergeDigest({
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
    source: record.source,
    provenance: record.provenance,
    conflict: record.conflict,
    links: semanticLinks
  });
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalStructuredSemanticMergeValue(value));
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function own(record: MorynRecord, field: string): boolean {
  return Object.hasOwn(record.content, field);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function exactIds(actual: readonly string[], expected: readonly string[]): boolean {
  return canonicalJson(sortedUnique(actual)) === canonicalJson(sortedUnique(expected));
}

function activeEvidence(record: MorynRecord | undefined): record is MorynRecord {
  return Boolean(
    record && record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined"
  );
}

function trustedEvidence(record: MorynRecord | undefined): boolean {
  return activeEvidence(record) && (record.state === "canonical" || record.provenance?.method === "user-confirmed");
}

function userConfirmedEvidence(record: MorynRecord | undefined): boolean {
  return activeEvidence(record) && (record.provenance?.method === "user-confirmed" || record.source.client === "user");
}

interface StructuredSemanticMergeEvidence {
  authorized: boolean;
  records: MorynRecord[];
}

function resolveEvidence(
  recordIds: readonly string[],
  recordsById: ReadonlyMap<string, MorynRecord>,
  sources: readonly MorynRecord[],
  options: StructuredSemanticMergePlanningOptions
): StructuredSemanticMergeEvidence {
  const source = sources[0];
  const sourcePrivate = source ? isPrivateMemoryBoundary(source) : false;
  const requested = recordIds.map((recordId) => recordsById.get(recordId));
  const evidence = requested.filter(
    (record): record is MorynRecord =>
      activeEvidence(record) &&
      record.scope === source?.scope &&
      record.project_id === source?.project_id &&
      isPrivateMemoryBoundary(record) === sourcePrivate &&
      (!sourcePrivate || options.include_private === true)
  );
  return {
    authorized: evidence.length === requested.length,
    records: evidence.sort((left, right) => compareCodeUnits(left.id, right.id))
  };
}

function evidenceDigests(records: readonly MorynRecord[]): Record<string, string> {
  return Object.fromEntries(records.map((record) => [record.id, structuredSemanticMergeSourceDigest(record)]));
}

const protectedPatterns = [
  /\b(?:not|never|must|should|may|cannot|can't|forbid(?:den)?|deny|denied)\b/iu,
  /(?:禁止|必须|不应|不能|不得|权限|安全|偏好|密钥|凭据)/u,
  /\b(?:permission|security|credential|token|password|private|public|secret|destructive|delete|push|publish)\b/iu,
  /\b(?:prefer(?:s|red|ring)?|preference|principle)\b/iu,
  /\bv?\d+(?:\.\d+){1,3}(?:[-+][\p{L}\p{N}.-]+)?\b/iu,
  /\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?z?)?\b/iu,
  /\b\d+(?:\.\d+)?%?\b/u,
  /(?:^|\s)(?:\.?\.?\/|[\p{L}\p{N}_.-]+\/)[\p{L}\p{N}_./-]+/u,
  /\b(?:npm|pnpm|yarn|git|moryn|node|npx|python|cargo|go)\s+[\p{L}\p{N}:@._/-]+/iu
];

function protectedDisposition(field: string, records: readonly MorynRecord[]): boolean {
  const text = `${field} ${records
    .filter((record) => own(record, field))
    .map((record) => canonicalJson(record.content[field]))
    .join(" ")}`;
  return protectedPatterns.some((pattern) => pattern.test(text));
}

function fieldEvidence(
  field: Extract<StructuredSemanticMergeField, { disposition: "replace" | "obsolete" }>,
  recordsById: ReadonlyMap<string, MorynRecord>,
  sources: readonly MorynRecord[],
  options: StructuredSemanticMergePlanningOptions
): { authorized: boolean; trusted: boolean; user_confirmed: boolean; records: MorynRecord[] } {
  const evidence = resolveEvidence(field.evidence_record_ids, recordsById, sources, options);
  return {
    authorized: evidence.authorized,
    trusted: evidence.records.some(trustedEvidence),
    user_confirmed: evidence.records.some(userConfirmedEvidence),
    records: evidence.records
  };
}

function automaticLineage(field: string, records: readonly MorynRecord[]): StructuredSemanticMergeFieldLineage {
  const present = records.filter((record) => own(record, field));
  const value = present[0]?.content[field];
  return {
    field,
    disposition: "retain",
    source_record_ids: present.map((record) => record.id).sort(compareCodeUnits),
    evidence_record_ids: [],
    evidence_digests: {},
    values:
      value === undefined
        ? []
        : [
            {
              value_digest: structuredSemanticMergeDigest(value),
              source_record_ids: present.map((record) => record.id).sort(compareCodeUnits)
            }
          ]
  };
}

function cumulativeValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    const nested = sortedUnique(value.map(cumulativeValueShape));
    return `array<${nested.join("|")}>`;
  }
  if (typeof value === "object") {
    const fields = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => `${key}:${cumulativeValueShape(nested)}`);
    return `object<${fields.join(",")}>`;
  }
  return typeof value;
}

function unionValues(
  field: string,
  sources: readonly MorynRecord[]
): { output: unknown[]; lineage: StructuredSemanticMergeValueLineage[] } | undefined {
  if (sources.some((record) => !Array.isArray(record.content[field]))) return undefined;
  const shapes = new Set(sources.flatMap((record) => (record.content[field] as unknown[]).map(cumulativeValueShape)));
  if (shapes.size > 1) return undefined;
  const values = new Map<string, { value: unknown; source_record_ids: string[] }>();
  for (const source of sources) {
    for (const value of source.content[field] as unknown[]) {
      const key = canonicalJson(value);
      const existing = values.get(key);
      if (existing) existing.source_record_ids.push(source.id);
      else values.set(key, { value, source_record_ids: [source.id] });
    }
  }
  const ordered = [...values.entries()].sort(([left], [right]) => compareCodeUnits(left, right));
  return {
    output: ordered.map(([, value]) => structuredClone(value.value)),
    lineage: ordered.map(([, value]) => ({
      value_digest: structuredSemanticMergeDigest(value.value),
      source_record_ids: sortedUnique(value.source_record_ids)
    }))
  };
}

function priority(records: readonly MorynRecord[]): RecordPriority {
  const rank: Record<RecordPriority, number> = { low: 0, normal: 1, high: 2 };
  return [...records].sort((left, right) => rank[right.priority] - rank[left.priority])[0]?.priority ?? "normal";
}

function derivedCreatedAt(records: readonly MorynRecord[]): string {
  const latest = Math.max(...records.map((record) => Date.parse(record.updated_at)));
  return new Date(latest + 1).toISOString();
}

const unsafeFieldNames = new Set(["__proto__", "constructor", "prototype"]);

function canonicalEligible(
  allRecords: readonly MorynRecord[],
  sources: readonly MorynRecord[],
  proposal: SemanticConsolidationProposal
): boolean {
  const conflicted = new Set(buildActiveLogicalMemoryView([...allRecords]).conflict_record_ids);
  return (
    proposal.structured_merge?.requested_state === "canonical" &&
    sources.every(
      (record) =>
        record.state === "canonical" &&
        record.visibility === "active" &&
        !conflicted.has(record.id) &&
        (!record.conflict || record.conflict.resolution === "resolved")
    )
  );
}

export function planStructuredSemanticMerge(
  records: readonly MorynRecord[],
  proposal: SemanticConsolidationProposal,
  options: StructuredSemanticMergePlanningOptions = {}
): StructuredSemanticMergePlanningResult {
  const merge = proposal.structured_merge;
  if (!merge) throw new Error("Structured semantic merge planning requires structured_merge");
  if (proposal.relationship === "conflicts_with") {
    return { status: "rejected", reason: "structured_merge_conflict_relationship" };
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const sources = sortedUnique([proposal.source_record_id, proposal.target_record_id]).flatMap((recordId) => {
    const record = recordsById.get(recordId);
    return record ? [record] : [];
  });
  if (sources.length !== 2) return { status: "rejected", reason: "missing_record" };
  if (sources.some((record) => !activeEvidence(record))) {
    return { status: "rejected", reason: "inactive_record" };
  }
  const sourceDomain = sources[0]!;
  if (
    sources.some(
      (record) =>
        record.kind !== sourceDomain.kind ||
        record.type !== sourceDomain.type ||
        record.scope !== sourceDomain.scope ||
        record.project_id !== sourceDomain.project_id
    )
  ) {
    return { status: "rejected", reason: "incompatible_domain" };
  }
  const sourcePrivacy = sources.map(isPrivateMemoryBoundary);
  if (sourcePrivacy[0] !== sourcePrivacy[1] || (sourcePrivacy[0] && options.include_private !== true)) {
    return { status: "rejected", reason: "private_boundary" };
  }
  if (sources.some((record) => own(record, STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY))) {
    return { status: "rejected", reason: "structured_merge_reserved_field_collision" };
  }

  const semanticFields = sortedUnique(
    sources.flatMap((record) =>
      Object.keys(record.content).filter((field) => field !== STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY)
    )
  );
  if (semanticFields.some((field) => unsafeFieldNames.has(field))) {
    return { status: "rejected", reason: "structured_merge_unsafe_field_name" };
  }
  const declaredEvidenceIds = new Set(proposal.evidence_record_ids);
  if (
    merge.fields.some(
      (field) =>
        (field.disposition === "replace" || field.disposition === "obsolete") &&
        field.evidence_record_ids.some((recordId) => !declaredEvidenceIds.has(recordId))
    )
  ) {
    return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
  }
  const evidence = resolveEvidence(proposal.evidence_record_ids, recordsById, sources, options);
  if (!evidence.authorized) {
    return { status: "rejected", reason: "structured_merge_untrusted_evidence" };
  }
  const evidenceRecordIds = evidence.records.map((record) => record.id);
  const allEvidenceDigests = evidenceDigests(evidence.records);
  const dispositions = new Map(merge.fields.map((field) => [field.field, field]));
  if ([...dispositions.keys()].some((field) => !semanticFields.includes(field))) {
    return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
  }

  const content: Record<string, unknown> = {};
  const fieldLineage: StructuredSemanticMergeFieldLineage[] = [];
  for (const fieldName of semanticFields) {
    const present = sources.filter((record) => own(record, fieldName));
    const distinctValues = new Set(present.map((record) => canonicalJson(record.content[fieldName])));
    const disposition = dispositions.get(fieldName);
    if (distinctValues.size <= 1 && !disposition) {
      content[fieldName] = structuredClone(present[0]?.content[fieldName]);
      fieldLineage.push(automaticLineage(fieldName, sources));
      continue;
    }
    if (!disposition) {
      return { status: "rejected", reason: "structured_merge_missing_field_disposition" };
    }
    if (disposition.disposition === "retain") {
      const selected = recordsById.get(disposition.source_record_id);
      if (
        !selected ||
        !present.some((record) => record.id === selected.id) ||
        present.some((record) => !sameValue(record.content[fieldName], selected.content[fieldName]))
      ) {
        return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
      }
      content[fieldName] = structuredClone(selected.content[fieldName]);
      fieldLineage.push(automaticLineage(fieldName, sources));
      continue;
    }
    if (disposition.disposition === "union") {
      if (
        !exactIds(
          disposition.source_record_ids,
          present.map((record) => record.id)
        )
      ) {
        return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
      }
      const union = unionValues(fieldName, present);
      if (!union) return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
      content[fieldName] = union.output;
      fieldLineage.push({
        field: fieldName,
        disposition: "union",
        source_record_ids: sortedUnique(disposition.source_record_ids),
        evidence_record_ids: [],
        evidence_digests: {},
        values: union.lineage
      });
      continue;
    }
    const evidence = fieldEvidence(disposition, recordsById, sources, options);
    if (disposition.evidence_record_ids.length === 0) {
      return { status: "rejected", reason: "structured_merge_missing_evidence" };
    }
    if (!evidence.authorized) return { status: "rejected", reason: "structured_merge_untrusted_evidence" };
    if (!evidence.trusted) return { status: "rejected", reason: "structured_merge_untrusted_evidence" };
    if (disposition.disposition === "replace") {
      const selected = recordsById.get(disposition.source_record_id);
      const replaced = present.filter((record) => record.id !== selected?.id);
      if (
        !selected ||
        !present.some((record) => record.id === selected.id) ||
        !exactIds(
          disposition.replaced_source_record_ids,
          replaced.map((record) => record.id)
        )
      ) {
        return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
      }
      if (protectedDisposition(fieldName, present) && !evidence.user_confirmed) {
        return {
          status: "rejected",
          reason: "structured_merge_protected_replacement_requires_user_evidence"
        };
      }
      content[fieldName] = structuredClone(selected.content[fieldName]);
      fieldLineage.push({
        field: fieldName,
        disposition: "replace",
        source_record_ids: [selected.id, ...sortedUnique(disposition.replaced_source_record_ids)],
        evidence_record_ids: evidence.records.map((record) => record.id),
        evidence_digests: evidenceDigests(evidence.records),
        values: [
          {
            value_digest: structuredSemanticMergeDigest(selected.content[fieldName]),
            source_record_ids: [selected.id]
          }
        ]
      });
      continue;
    }
    if (
      !exactIds(
        disposition.source_record_ids,
        present.map((record) => record.id)
      )
    ) {
      return { status: "rejected", reason: "structured_merge_invalid_field_disposition" };
    }
    if (protectedDisposition(fieldName, present) && !evidence.user_confirmed) {
      return {
        status: "rejected",
        reason: "structured_merge_protected_obsolete_requires_user_evidence"
      };
    }
    fieldLineage.push({
      field: fieldName,
      disposition: "obsolete",
      source_record_ids: sortedUnique(disposition.source_record_ids),
      evidence_record_ids: evidence.records.map((record) => record.id),
      evidence_digests: evidenceDigests(evidence.records),
      values: []
    });
  }
  if (Object.keys(content).length === 0) {
    return { status: "rejected", reason: "structured_merge_empty_content" };
  }

  const sourceRecordIds = sources.map((record) => record.id);
  const sourceDigests = Object.fromEntries(
    sources.map((record) => [record.id, structuredSemanticMergeSourceDigest(record)])
  );
  const metadata: StructuredSemanticMergeMetadata = {
    version: 1,
    relationship: proposal.relationship,
    proposal_source_record_id: proposal.source_record_id,
    proposal_target_record_id: proposal.target_record_id,
    source_record_ids: sourceRecordIds,
    source_digests: sourceDigests,
    evidence_record_ids: evidenceRecordIds,
    evidence_digests: allEvidenceDigests,
    field_lineage: fieldLineage.sort((left, right) => compareCodeUnits(left.field, right.field))
  };
  content[STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY] = metadata;
  const mergeIdentity = {
    version: 1,
    domain: {
      kind: sources[0]?.kind,
      type: sources[0]?.type,
      scope: sources[0]?.scope,
      project_id: sources[0]?.project_id
    },
    content
  };
  const mergeDigest = structuredSemanticMergeDigest(mergeIdentity);
  const claimDigest = structuredSemanticMergeDigest({ version: 1, source_digests: sourceDigests });
  const mergedRecordId = `rec_semantic_merge_${mergeDigest.slice(0, 32)}`;
  const logicalView = buildActiveLogicalMemoryView([...records]);
  if (
    sourceRecordIds.some((recordId) => {
      const hidden = logicalView.hidden_by_record_id[recordId];
      return hidden !== undefined && hidden.active_record_id !== mergedRecordId;
    })
  ) {
    return { status: "rejected", reason: "inactive_record" };
  }
  if (
    evidenceRecordIds.some((recordId) => {
      const hidden = logicalView.hidden_by_record_id[recordId];
      return hidden !== undefined && hidden.active_record_id !== mergedRecordId;
    })
  ) {
    return { status: "rejected", reason: "structured_merge_untrusted_evidence" };
  }
  const createdAt = recordsById.get(mergedRecordId)?.created_at ?? derivedCreatedAt([...sources, ...evidence.records]);
  const recordSource: RecordSource = { client: "moryn", device_id: STRUCTURED_SEMANTIC_MERGE_DEVICE_ID };
  const initialRecord: MorynRecord = {
    id: mergedRecordId,
    kind: sources[0]?.kind ?? "memory",
    type: sources[0]?.type ?? "fact",
    scope: sources[0]?.scope ?? "project",
    ...(sources[0]?.project_id ? { project_id: sources[0].project_id } : {}),
    tags: sortedUnique([...sources.flatMap((record) => record.tags), ...(sourcePrivacy[0] ? ["private"] : [])]),
    content,
    state: "quarantined",
    confidence: Math.min(proposal.confidence, ...sources.map((record) => record.confidence)),
    priority: priority(sources),
    visibility: "quarantined",
    created_at: createdAt,
    updated_at: createdAt,
    source: recordSource,
    provenance: {
      derived_from: sourceRecordIds,
      reason: "Deterministic structured semantic merge with source-backed field lineage.",
      method: "agent-proposed"
    }
  };
  return {
    status: "ready",
    plan: {
      version: 1,
      merge_digest: mergeDigest,
      claim_digest: claimDigest,
      source_record_ids: sourceRecordIds,
      source_digests: sourceDigests,
      evidence_record_ids: evidenceRecordIds,
      evidence_digests: allEvidenceDigests,
      initial_record: initialRecord,
      final_state: canonicalEligible(records, sources, proposal) ? "canonical" : "candidate"
    }
  };
}

export function structuredSemanticMergeSourcesMatch(
  records: readonly MorynRecord[],
  plan: StructuredSemanticMergePlan
): boolean {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return plan.source_record_ids.every((recordId) => {
    const record = recordsById.get(recordId);
    return record && structuredSemanticMergeSourceDigest(record) === plan.source_digests[recordId];
  });
}

export function structuredSemanticMergeEvidenceMatches(
  records: readonly MorynRecord[],
  plan: StructuredSemanticMergePlan
): boolean {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  return plan.evidence_record_ids.every((recordId) => {
    const record = recordsById.get(recordId);
    return record && structuredSemanticMergeSourceDigest(record) === plan.evidence_digests[recordId];
  });
}

export function structuredSemanticMergeDependenciesMatch(
  records: readonly MorynRecord[],
  plan: StructuredSemanticMergePlan
): boolean {
  return structuredSemanticMergeSourcesMatch(records, plan) && structuredSemanticMergeEvidenceMatches(records, plan);
}

function structuredSemanticMergeImmutableRecordMatches(record: MorynRecord, expected: MorynRecord): boolean {
  return (
    record.id === expected.id &&
    record.kind === expected.kind &&
    record.type === expected.type &&
    record.scope === expected.scope &&
    record.project_id === expected.project_id &&
    sameValue(record.tags, expected.tags) &&
    sameValue(record.content, expected.content) &&
    record.confidence === expected.confidence &&
    record.priority === expected.priority &&
    record.created_at === expected.created_at &&
    sameValue(record.source, expected.source) &&
    record.conflict === undefined
  );
}

export function structuredSemanticMergeProvisionalRecordMatches(
  record: MorynRecord,
  plan: StructuredSemanticMergePlan
): boolean {
  const expected = plan.initial_record;
  return (
    structuredSemanticMergeImmutableRecordMatches(record, expected) &&
    record.state === "quarantined" &&
    record.visibility === "quarantined" &&
    sameValue(record.provenance, expected.provenance)
  );
}

export function structuredSemanticMergeRecordMatches(record: MorynRecord, plan: StructuredSemanticMergePlan): boolean {
  const expected = plan.initial_record;
  const expectedProvenance = expected.provenance;
  const promotedAt = record.provenance?.promoted_at;
  const provenanceMatches =
    record.state === "canonical"
      ? promotedAt === structuredSemanticMergeTimestamp(plan, STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS) &&
        sameValue(record.provenance, {
          ...expectedProvenance,
          reason: STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON,
          method: "rule-promoted",
          promoted_at: promotedAt
        })
      : sameValue(record.provenance, expectedProvenance);
  return (
    structuredSemanticMergeImmutableRecordMatches(record, expected) &&
    (record.state === "candidate" || record.state === "canonical") &&
    record.visibility === "active" &&
    provenanceMatches
  );
}

export function structuredSemanticMergeInitialRecordMatches(
  record: MorynRecord,
  plan: StructuredSemanticMergePlan
): boolean {
  return sameValue(record, plan.initial_record);
}
