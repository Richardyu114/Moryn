import { searchableRecordText } from "./content-text.js";
import { buildActiveLogicalMemoryView, logicalMemoryFingerprint } from "./logical-memory.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import { createStringKeyedRecord } from "./string-keyed-record.js";
import type { MorynRecord } from "./types.js";

export const SEMANTIC_CONSOLIDATION_CANDIDATE_SELECTION_SOURCES = {
  candidate: "candidates_by_source_record_id.<source_record_id>[]",
  source_record_id: "candidates_by_source_record_id.<source_record_id>[].source_record_id",
  record_id: "candidates_by_source_record_id.<source_record_id>[].record_id",
  score: "candidates_by_source_record_id.<source_record_id>[].score",
  signal: "candidates_by_source_record_id.<source_record_id>[].signals[]"
} as const;

export const SEMANTIC_CONSOLIDATION_DISCOVERY_SELECTION_SOURCES = {
  candidate: "candidate_pairs[]",
  source_record_id: "candidate_pairs[].source_record_id",
  target_record_id: "candidate_pairs[].record_id",
  score: "candidate_pairs[].score",
  signal: "candidate_pairs[].signals[]",
  omitted_private_record_count: "omitted_private_record_count"
} as const;

export interface SemanticConsolidationCandidateOptions {
  source_record_ids: string[];
  include_private?: boolean;
  per_source_limit?: number;
  total_limit?: number;
}

export interface SemanticConsolidationCandidate {
  source_record_id: string;
  record_id: string;
  score: number;
  exact_fingerprint: boolean;
  token_overlap: number;
  signals: Array<
    "exact_fingerprint" | "shared_file" | "shared_tag" | "shared_provenance" | "token_overlap" | "recency"
  >;
}

export interface SemanticConsolidationDiscoveryOptions {
  project_id?: string;
  include_global?: boolean;
  include_private?: boolean;
  minimum_token_overlap?: number;
  limit?: number;
}

export interface SemanticConsolidationDiscoveryResult {
  inspected_source_record_count: number;
  eligible_source_record_count: number;
  omitted_private_record_count: number;
  candidate_pairs: SemanticConsolidationCandidate[];
  truncated: boolean;
  selection_sources: typeof SEMANTIC_CONSOLIDATION_DISCOVERY_SELECTION_SOURCES;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireLimit(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new Error(`Invalid argument: ${name} must be an integer between 1 and ${maximum}`);
  }
  return normalized;
}

function requireRatio(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error(`Invalid argument: ${name} must be a number between 0 and 1`);
  }
  return normalized;
}

function normalizedTokens(record: MorynRecord): Set<string> {
  return new Set(
    searchableRecordText(record)
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+(?:[._/-][\p{L}\p{N}]+)*/gu) ?? []
  );
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / Math.max(left.size, right.size);
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  return [];
}

function recordFiles(record: MorynRecord): Set<string> {
  return new Set(
    stringValues(record.content.files)
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function sameDomain(source: MorynRecord, candidate: MorynRecord): boolean {
  return (
    source.kind === candidate.kind &&
    source.type === candidate.type &&
    source.scope === candidate.scope &&
    source.project_id === candidate.project_id
  );
}

interface CandidateFeatures {
  fingerprint: string;
  tokens: Set<string>;
  files: Set<string>;
  tags: Set<string>;
  provenance: Set<string>;
}

function candidateFeatures(record: MorynRecord): CandidateFeatures {
  return {
    fingerprint: logicalMemoryFingerprint(record),
    tokens: normalizedTokens(record),
    files: recordFiles(record),
    tags: new Set(record.tags),
    provenance: new Set(record.provenance?.derived_from ?? [])
  };
}

function candidateFor(
  source: MorynRecord,
  candidate: MorynRecord,
  sourceFeatures = candidateFeatures(source),
  candidateFeaturesValue = candidateFeatures(candidate)
): SemanticConsolidationCandidate {
  const exactFingerprint = sourceFeatures.fingerprint === candidateFeaturesValue.fingerprint;
  const tokenOverlap = overlapRatio(sourceFeatures.tokens, candidateFeaturesValue.tokens);
  const sharedFile = intersects(sourceFeatures.files, candidateFeaturesValue.files);
  const sharedTag = intersects(sourceFeatures.tags, candidateFeaturesValue.tags);
  const sharedProvenance = intersects(sourceFeatures.provenance, candidateFeaturesValue.provenance);
  const recency = candidate.updated_at >= source.updated_at;
  const signals: SemanticConsolidationCandidate["signals"] = [];
  if (exactFingerprint) signals.push("exact_fingerprint");
  if (sharedFile) signals.push("shared_file");
  if (sharedTag) signals.push("shared_tag");
  if (sharedProvenance) signals.push("shared_provenance");
  if (tokenOverlap > 0) signals.push("token_overlap");
  if (recency) signals.push("recency");
  const score =
    (exactFingerprint ? 1000 : 0) +
    (sharedFile ? 80 : 0) +
    (sharedProvenance ? 70 : 0) +
    (sharedTag ? 30 : 0) +
    tokenOverlap * 100 +
    (recency ? 1 : 0);
  return {
    source_record_id: source.id,
    record_id: candidate.id,
    score: Number(score.toFixed(6)),
    exact_fingerprint: exactFingerprint,
    token_overlap: Number(tokenOverlap.toFixed(6)),
    signals
  };
}

export function retrieveSemanticConsolidationCandidates(
  records: readonly MorynRecord[],
  options: SemanticConsolidationCandidateOptions
) {
  const perSourceLimit = requireLimit(options.per_source_limit, 8, 8, "per_source_limit");
  const totalLimit = requireLimit(options.total_limit, 24, 24, "total_limit");
  const activeRecords = buildActiveLogicalMemoryView([...records]).active_records.filter(
    (record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined"
  );
  const activeById = new Map(activeRecords.map((record) => [record.id, record]));
  const candidates: SemanticConsolidationCandidate[] = [];
  const candidatesBySourceRecordId = createStringKeyedRecord<SemanticConsolidationCandidate[]>();

  for (const sourceRecordId of [...new Set(options.source_record_ids)]) {
    if (candidates.length >= totalLimit) break;
    const source = activeById.get(sourceRecordId);
    const sourcePrivate = source ? isPrivateMemoryBoundary(source) : false;
    if (!source || (sourcePrivate && options.include_private !== true)) {
      candidatesBySourceRecordId[sourceRecordId] = [];
      continue;
    }
    const ranked = activeRecords
      .filter((candidate) => candidate.id !== source.id)
      .filter((candidate) => sameDomain(source, candidate))
      .filter((candidate) => isPrivateMemoryBoundary(candidate) === sourcePrivate)
      .map((candidate) => candidateFor(source, candidate))
      .sort((left, right) => right.score - left.score || compareCodeUnits(left.record_id, right.record_id))
      .slice(0, Math.min(perSourceLimit, totalLimit - candidates.length));
    candidatesBySourceRecordId[sourceRecordId] = ranked;
    candidates.push(...ranked);
  }

  return {
    candidates,
    candidates_by_source_record_id: candidatesBySourceRecordId,
    selection_sources: SEMANTIC_CONSOLIDATION_CANDIDATE_SELECTION_SOURCES
  };
}

/**
 * Discovers bounded candidate pairs across the current logical working set.
 * This is intentionally read-only: scores identify records worth comparing,
 * never proof that two records are semantically equivalent.
 */
export function discoverSemanticConsolidationCandidates(
  records: readonly MorynRecord[],
  options: SemanticConsolidationDiscoveryOptions = {}
): SemanticConsolidationDiscoveryResult {
  const limit = requireLimit(options.limit, 100, 500, "limit");
  const minimumTokenOverlap = requireRatio(options.minimum_token_overlap, 0.15, "minimum_token_overlap");
  const projectId = options.project_id?.trim();
  if (options.project_id !== undefined && !projectId) {
    throw new Error("Invalid argument: project_id must be a non-empty string");
  }

  const scoped = buildActiveLogicalMemoryView([...records])
    .active_records.filter(
      (record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined"
    )
    .filter(
      (record) =>
        !projectId || record.project_id === projectId || (options.include_global !== false && record.scope === "global")
    )
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || compareCodeUnits(left.id, right.id));
  const omittedPrivateRecordCount = scoped.filter(isPrivateMemoryBoundary).length;
  const eligible = scoped.filter((record) => options.include_private === true || !isPrivateMemoryBoundary(record));
  const eligibleById = new Map(eligible.map((record) => [record.id, record]));
  const featuresById = new Map(eligible.map((record) => [record.id, candidateFeatures(record)]));
  const pairs: SemanticConsolidationCandidate[] = [];

  for (let sourceIndex = 0; sourceIndex < eligible.length; sourceIndex += 1) {
    const source = eligible[sourceIndex] as MorynRecord;
    for (let targetIndex = sourceIndex + 1; targetIndex < eligible.length; targetIndex += 1) {
      const target = eligible[targetIndex] as MorynRecord;
      if (!sameDomain(source, target)) continue;
      if (isPrivateMemoryBoundary(source) !== isPrivateMemoryBoundary(target)) continue;
      const candidate = candidateFor(
        source,
        target,
        featuresById.get(source.id) as CandidateFeatures,
        featuresById.get(target.id) as CandidateFeatures
      );
      const meaningful =
        candidate.exact_fingerprint ||
        candidate.token_overlap >= minimumTokenOverlap ||
        candidate.signals.includes("shared_file") ||
        candidate.signals.includes("shared_provenance");
      if (meaningful) pairs.push(candidate);
    }
  }

  pairs.sort(
    (left, right) =>
      Number(right.exact_fingerprint) - Number(left.exact_fingerprint) ||
      Number(
        Boolean(
          projectId &&
            eligibleById.get(right.source_record_id)?.scope === "project" &&
            eligibleById.get(right.source_record_id)?.project_id === projectId
        )
      ) -
        Number(
          Boolean(
            projectId &&
              eligibleById.get(left.source_record_id)?.scope === "project" &&
              eligibleById.get(left.source_record_id)?.project_id === projectId
          )
        ) ||
      right.score - left.score ||
      compareCodeUnits(left.source_record_id, right.source_record_id) ||
      compareCodeUnits(left.record_id, right.record_id)
  );
  return {
    inspected_source_record_count: scoped.length,
    eligible_source_record_count: eligible.length,
    omitted_private_record_count: options.include_private === true ? 0 : omittedPrivateRecordCount,
    candidate_pairs: pairs.slice(0, limit),
    truncated: pairs.length > limit,
    selection_sources: SEMANTIC_CONSOLIDATION_DISCOVERY_SELECTION_SOURCES
  };
}
