import { createHash } from "node:crypto";
import { buildMemoryRetentionView, type MemoryLayer, type MemoryRetentionTier } from "./memory-retention.js";
import { estimateMemoryRecordTokens } from "./record-read-model.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import {
  STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY,
  structuredSemanticMergeSourceDigest
} from "./structured-semantic-merge.js";
import type { MorynRecord } from "./types.js";

export type MemoryExpansionRelation = "covered_record" | "derived_from" | "episode_leaf" | "provenance";

export type MemoryExpansionVerification = "mismatch" | "unavailable" | "verified";

export interface MemoryExpansionInput {
  records: readonly MorynRecord[];
  record_id: string;
  include_private?: boolean;
  max_depth?: number;
  max_records?: number;
}

export interface MemoryExpansionRecord {
  record: MorynRecord;
  depth: number;
  path: string[];
  layer: MemoryLayer;
  tier: MemoryRetentionTier;
  estimated_tokens: number;
  private: boolean;
  conflicted: boolean;
  quarantined: boolean;
}

export interface MemoryExpansionEdge {
  from_record_id: string;
  to_record_id: string;
  relation: MemoryExpansionRelation;
  expected_digest?: string;
  actual_digest: string;
  current_record_digest: string;
  verification: MemoryExpansionVerification;
  verification_basis: "current_record" | "pre_archive_projection" | "structured_semantic_merge_v1" | "none";
}

export type MemoryExpansionOmissionReason =
  | "cycle"
  | "depth_limit"
  | "missing_source"
  | "private_boundary"
  | "record_limit";

export interface MemoryExpansionOmission {
  from_record_id: string;
  record_id: string;
  reason: MemoryExpansionOmissionReason;
}

export interface MemoryExpansionResult {
  version: 1;
  status: "complete" | "partial";
  root_record_id: string;
  include_private: boolean;
  limits: { max_depth: number; max_records: number };
  records: MemoryExpansionRecord[];
  records_by_id: Record<string, MemoryExpansionRecord>;
  edges: MemoryExpansionEdge[];
  omissions: MemoryExpansionOmission[];
  stats: {
    returned_records: number;
    returned_source_records: number;
    estimated_tokens: number;
    verified_edges: number;
    mismatched_edges: number;
    unverifiable_edges: number;
    omitted_records: number;
    private_records_omitted: number;
  };
  selection_sources: typeof MEMORY_EXPANSION_SELECTION_SOURCES;
}

export const MEMORY_EXPANSION_SELECTION_SOURCES = {
  root: "records_by_id.<root_record_id>",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.record.id",
  edge: "edges[]",
  omission: "omissions[]"
} as const;

interface SourceReference {
  record_id: string;
  relation: MemoryExpansionRelation;
  expected_digest?: string;
  source_updated_at?: string;
  digest_method?: "structured_semantic_merge_v1";
}

interface DigestReference {
  record_id: string;
  digest: string;
  updated_at?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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

export function memoryRecordDigest(record: MorynRecord): string {
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function digestEntries(value: unknown): DigestReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const entry = objectValue(item);
      const recordId = entry?.record_id;
      const digest = entry?.digest;
      const updatedAt = entry?.updated_at;
      return typeof recordId === "string" && typeof digest === "string" && SHA256_PATTERN.test(digest)
        ? [
            {
              record_id: recordId,
              digest,
              ...(typeof updatedAt === "string" ? { updated_at: updatedAt } : {})
            }
          ]
        : [];
    });
  }
  const object = objectValue(value);
  if (!object) return [];
  return Object.entries(object).flatMap(([recordId, digest]) =>
    typeof digest === "string" && SHA256_PATTERN.test(digest) ? [{ record_id: recordId, digest }] : []
  );
}

function leafReferences(value: unknown): SourceReference[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const leaf = objectValue(item);
    const recordId = leaf?.record_id;
    const expectedDigest = leaf?.digest;
    if (typeof recordId !== "string" || !recordId.trim()) return [];
    return [
      {
        record_id: recordId.trim(),
        relation: "episode_leaf" as const,
        ...(typeof expectedDigest === "string" && SHA256_PATTERN.test(expectedDigest)
          ? { expected_digest: expectedDigest }
          : {})
      }
    ];
  });
}

function sourceReferences(record: MorynRecord): SourceReference[] {
  const content = record.content as Record<string, unknown>;
  const retention = objectValue(content.memory_retention);
  const lineage = objectValue(retention?.lineage);
  const structuredMerge = objectValue(content[STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY]);
  const expectedDigestReferences = [
    ...digestEntries(lineage?.source_digests),
    ...digestEntries(content.source_digests)
  ];
  const expectedDigests = new Map(expectedDigestReferences.map((entry) => [entry.record_id, entry.digest]));
  const sourceUpdatedAt = new Map(
    expectedDigestReferences.flatMap((entry) => (entry.updated_at ? [[entry.record_id, entry.updated_at]] : []))
  );
  const structuredDigests = new Map(
    digestEntries(structuredMerge?.source_digests).map((entry) => [entry.record_id, entry.digest])
  );
  const references: SourceReference[] = [];
  const add = (
    recordId: string,
    relation: MemoryExpansionRelation,
    expectedDigest?: string,
    digestMethod?: SourceReference["digest_method"]
  ) => {
    const normalized = recordId.trim();
    if (!normalized || normalized === record.id) return;
    references.push({
      record_id: normalized,
      relation,
      ...((expectedDigest ?? expectedDigests.get(normalized))
        ? { expected_digest: expectedDigest ?? expectedDigests.get(normalized) }
        : {}),
      ...(sourceUpdatedAt.get(normalized) ? { source_updated_at: sourceUpdatedAt.get(normalized) } : {}),
      ...(digestMethod ? { digest_method: digestMethod } : {})
    });
  };

  for (const recordId of stringArray(lineage?.covered_record_ids)) add(recordId, "covered_record");
  for (const recordId of stringArray(content.source_record_ids)) add(recordId, "covered_record");
  for (const recordId of stringArray(structuredMerge?.source_record_ids)) {
    add(recordId, "covered_record", structuredDigests.get(recordId), "structured_semantic_merge_v1");
  }
  for (const recordId of stringArray(lineage?.derived_from)) add(recordId, "derived_from");
  for (const recordId of record.provenance?.derived_from ?? []) add(recordId, "provenance");
  for (const leaf of leafReferences(content.leaf_evidence)) add(leaf.record_id, leaf.relation, leaf.expected_digest);
  if (Array.isArray(content.claims)) {
    for (const claim of content.claims) {
      for (const leaf of leafReferences(objectValue(claim)?.leaf_evidence)) {
        add(leaf.record_id, leaf.relation, leaf.expected_digest);
      }
    }
  }

  const relationPriority: Record<MemoryExpansionRelation, number> = {
    episode_leaf: 4,
    covered_record: 3,
    derived_from: 2,
    provenance: 1
  };
  const byId = new Map<string, SourceReference>();
  for (const reference of references) {
    const prior = byId.get(reference.record_id);
    if (!prior || relationPriority[reference.relation] > relationPriority[prior.relation]) {
      byId.set(reference.record_id, reference);
    } else if (!prior.expected_digest && reference.expected_digest) {
      byId.set(reference.record_id, {
        ...prior,
        expected_digest: reference.expected_digest,
        ...(reference.digest_method ? { digest_method: reference.digest_method } : {})
      });
    } else if (!prior.digest_method && reference.digest_method) {
      byId.set(reference.record_id, { ...prior, digest_method: reference.digest_method });
    }
  }
  return [...byId.values()].sort((left, right) => compareCodeUnits(left.record_id, right.record_id));
}

function canonicalTimestamp(value: string | undefined): value is string {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function verifySourceReference(
  source: MorynRecord,
  reference: SourceReference
): Pick<MemoryExpansionEdge, "actual_digest" | "current_record_digest" | "verification" | "verification_basis"> {
  const currentDigest = memoryRecordDigest(source);
  if (reference.digest_method === "structured_semantic_merge_v1") {
    const actualDigest = structuredSemanticMergeSourceDigest(source);
    return {
      actual_digest: actualDigest,
      current_record_digest: currentDigest,
      verification: reference.expected_digest === actualDigest ? "verified" : "mismatch",
      verification_basis: "structured_semantic_merge_v1"
    };
  }
  if (!reference.expected_digest) {
    return {
      actual_digest: currentDigest,
      current_record_digest: currentDigest,
      verification: "unavailable",
      verification_basis: "none"
    };
  }
  if (reference.expected_digest === currentDigest) {
    return {
      actual_digest: currentDigest,
      current_record_digest: currentDigest,
      verification: "verified",
      verification_basis: "current_record"
    };
  }
  if (
    (source.state === "archived" || source.visibility === "archived") &&
    canonicalTimestamp(reference.source_updated_at)
  ) {
    for (const state of ["raw", "candidate", "canonical", "quarantined"] as const) {
      const projected: MorynRecord = {
        ...source,
        state,
        visibility: state === "quarantined" ? "quarantined" : "active",
        updated_at: reference.source_updated_at
      };
      const projectedDigest = memoryRecordDigest(projected);
      if (projectedDigest === reference.expected_digest) {
        return {
          actual_digest: projectedDigest,
          current_record_digest: currentDigest,
          verification: "verified",
          verification_basis: "pre_archive_projection"
        };
      }
    }
  }
  return {
    actual_digest: currentDigest,
    current_record_digest: currentDigest,
    verification: "mismatch",
    verification_basis: "none"
  };
}

function normalizedLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new Error(`Invalid memory expansion ${name}`);
  }
  return resolved;
}

function expansionRecord(record: MorynRecord, depth: number, path: string[]): MemoryExpansionRecord {
  const retention = buildMemoryRetentionView(record);
  return {
    record,
    depth,
    path,
    layer: retention.layer.level,
    tier: retention.retention.tier,
    estimated_tokens: estimateMemoryRecordTokens(record),
    private: retention.safety.private,
    conflicted: retention.safety.conflicted,
    quarantined: record.state === "quarantined" || record.visibility === "quarantined"
  };
}

/**
 * Expands a compressed memory record back to its available source evidence.
 * Expansion is explicit, bounded, privacy-filtered, cycle-safe, and reports
 * digest mismatches instead of treating a rollup as an unquestioned source.
 */
export function expandMemorySources(input: MemoryExpansionInput): MemoryExpansionResult {
  const rootId = input.record_id.trim();
  if (!rootId) throw new Error("Memory expansion requires record_id");
  const maxDepth = normalizedLimit(input.max_depth, 2, 16, "max_depth");
  const maxRecords = normalizedLimit(input.max_records, 100, 10_000, "max_records");
  if (maxRecords < 1) throw new Error("Invalid memory expansion max_records");
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const root = recordsById.get(rootId);
  if (!root) throw new Error(`Record not found: ${rootId}`);
  if (isPrivateMemoryBoundary(root) && input.include_private !== true) {
    throw new Error("Private memory expansion requires include_private");
  }

  const selected: MemoryExpansionRecord[] = [];
  const edges: MemoryExpansionEdge[] = [];
  const omissions: MemoryExpansionOmission[] = [];
  const visited = new Set<string>();
  const queued = new Set<string>([root.id]);
  const queue: Array<{ record: MorynRecord; depth: number; path: string[] }> = [
    { record: root, depth: 0, path: [root.id] }
  ];

  while (queue.length) {
    const current = queue.shift()!;
    queued.delete(current.record.id);
    if (visited.has(current.record.id)) continue;
    visited.add(current.record.id);
    selected.push(expansionRecord(current.record, current.depth, current.path));

    const references = sourceReferences(current.record);
    if (current.depth >= maxDepth) {
      for (const reference of references) {
        omissions.push({
          from_record_id: current.record.id,
          record_id: reference.record_id,
          reason: "depth_limit"
        });
      }
      continue;
    }

    for (const reference of references) {
      const source = recordsById.get(reference.record_id);
      if (!source) {
        omissions.push({
          from_record_id: current.record.id,
          record_id: reference.record_id,
          reason: "missing_source"
        });
        continue;
      }
      const verification = verifySourceReference(source, reference);
      edges.push({
        from_record_id: current.record.id,
        to_record_id: source.id,
        relation: reference.relation,
        ...(reference.expected_digest ? { expected_digest: reference.expected_digest } : {}),
        ...verification
      });
      if (current.path.includes(source.id)) {
        omissions.push({ from_record_id: current.record.id, record_id: source.id, reason: "cycle" });
        continue;
      }
      if (isPrivateMemoryBoundary(source) && input.include_private !== true) {
        omissions.push({
          from_record_id: current.record.id,
          record_id: source.id,
          reason: "private_boundary"
        });
        continue;
      }
      if (visited.has(source.id) || queued.has(source.id)) continue;
      if (selected.length + queue.length >= maxRecords) {
        omissions.push({ from_record_id: current.record.id, record_id: source.id, reason: "record_limit" });
        continue;
      }
      queued.add(source.id);
      queue.push({ record: source, depth: current.depth + 1, path: [...current.path, source.id] });
    }
  }

  selected.sort((left, right) => left.depth - right.depth || compareCodeUnits(left.record.id, right.record.id));
  edges.sort(
    (left, right) =>
      compareCodeUnits(left.from_record_id, right.from_record_id) ||
      compareCodeUnits(left.to_record_id, right.to_record_id) ||
      compareCodeUnits(left.relation, right.relation)
  );
  omissions.sort(
    (left, right) =>
      compareCodeUnits(left.from_record_id, right.from_record_id) ||
      compareCodeUnits(left.record_id, right.record_id) ||
      compareCodeUnits(left.reason, right.reason)
  );
  return {
    version: 1,
    status: omissions.length || edges.some((edge) => edge.verification === "mismatch") ? "partial" : "complete",
    root_record_id: root.id,
    include_private: input.include_private === true,
    limits: { max_depth: maxDepth, max_records: maxRecords },
    records: selected,
    records_by_id: Object.fromEntries(selected.map((entry) => [entry.record.id, entry])),
    edges,
    omissions,
    stats: {
      returned_records: selected.length,
      returned_source_records: Math.max(0, selected.length - 1),
      estimated_tokens: selected.reduce((total, entry) => total + entry.estimated_tokens, 0),
      verified_edges: edges.filter((edge) => edge.verification === "verified").length,
      mismatched_edges: edges.filter((edge) => edge.verification === "mismatch").length,
      unverifiable_edges: edges.filter((edge) => edge.verification === "unavailable").length,
      omitted_records: omissions.length,
      private_records_omitted: omissions.filter((omission) => omission.reason === "private_boundary").length
    },
    selection_sources: MEMORY_EXPANSION_SELECTION_SOURCES
  };
}
