import { searchableRecordText } from "./content-text.js";
import { buildActiveLogicalMemoryView, logicalMemoryFingerprint } from "./logical-memory.js";
import { isPrivateTags } from "./sensitive.js";
import type { MorynRecord } from "./types.js";

export const SEMANTIC_CONSOLIDATION_CANDIDATE_SELECTION_SOURCES = {
  candidate: "candidates_by_source_record_id.<source_record_id>[]",
  source_record_id: "candidates_by_source_record_id.<source_record_id>[].source_record_id",
  record_id: "candidates_by_source_record_id.<source_record_id>[].record_id",
  score: "candidates_by_source_record_id.<source_record_id>[].score",
  signal: "candidates_by_source_record_id.<source_record_id>[].signals[]"
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

function candidateFor(source: MorynRecord, candidate: MorynRecord): SemanticConsolidationCandidate {
  const exactFingerprint = logicalMemoryFingerprint(source) === logicalMemoryFingerprint(candidate);
  const tokenOverlap = overlapRatio(normalizedTokens(source), normalizedTokens(candidate));
  const sharedFile = intersects(recordFiles(source), recordFiles(candidate));
  const sharedTag = intersects(new Set(source.tags), new Set(candidate.tags));
  const sharedProvenance = intersects(
    new Set(source.provenance?.derived_from ?? []),
    new Set(candidate.provenance?.derived_from ?? [])
  );
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
  const candidatesBySourceRecordId: Record<string, SemanticConsolidationCandidate[]> = {};

  for (const sourceRecordId of [...new Set(options.source_record_ids)]) {
    if (candidates.length >= totalLimit) break;
    const source = activeById.get(sourceRecordId);
    const sourcePrivate = source ? isPrivateTags(source.tags) : false;
    if (!source || (sourcePrivate && options.include_private !== true)) {
      candidatesBySourceRecordId[sourceRecordId] = [];
      continue;
    }
    const ranked = activeRecords
      .filter((candidate) => candidate.id !== source.id)
      .filter((candidate) => sameDomain(source, candidate))
      .filter((candidate) => isPrivateTags(candidate.tags) === sourcePrivate)
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
