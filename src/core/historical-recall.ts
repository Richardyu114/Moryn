import { displayRecordText, searchableRecordText } from "./content-text.js";
import { buildActiveLogicalMemoryView } from "./logical-memory.js";
import { expandMemorySources } from "./memory-expansion.js";
import {
  buildMemoryRetentionReadModel,
  type MemoryLayer,
  type MemoryRetentionTier,
  type MemoryValidityStatus
} from "./memory-retention.js";
import { queryTokenCoverage } from "./recall-outcome.js";
import { estimateMemoryRecordTokens } from "./record-read-model.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import { stringKeyedRecordFromEntries } from "./string-keyed-record.js";
import type { MorynRecord, RecordKind, RecordScope } from "./types.js";

export const DEFAULT_HISTORICAL_RECALL_MAX_RECORDS = 3;
export const DEFAULT_HISTORICAL_RECALL_TOKEN_BUDGET = 2_000;

const GENERIC_HISTORICAL_RECALL_TOKENS = new Set([
  "about",
  "does",
  "from",
  "have",
  "please",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would"
]);

export type HistoricalRecallReason = "archived" | "cold" | "logical_history" | "working_set_omitted";
export type HistoricalRecallTrigger = "active_working_set_knowledge_gap" | "active_working_set_verification_required";

export interface HistoricalRecallInput {
  records: readonly MorynRecord[];
  active_working_set_record_ids: readonly string[];
  query: string;
  project_id?: string;
  kinds?: readonly RecordKind[];
  scopes?: readonly RecordScope[];
  types?: readonly string[];
  tags?: readonly string[];
  files?: readonly string[];
  include_private?: boolean;
  excluded_record_ids?: readonly string[];
  trigger?: HistoricalRecallTrigger;
  max_records?: number;
  token_budget?: number;
  now?: string;
}

export interface HistoricalRecallMatch {
  record_id: string;
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  state: MorynRecord["state"];
  visibility: MorynRecord["visibility"];
  confidence: number;
  priority: MorynRecord["priority"];
  updated_at: string;
  layer: MemoryLayer;
  tier: MemoryRetentionTier;
  validity_status: MemoryValidityStatus;
  stale: boolean;
  reasons: HistoricalRecallReason[];
  covered_by_record_ids: string[];
  logical_successor_record_id?: string;
  matched_tokens: string[];
  query_tokens: string[];
  coverage: number;
  score: number;
  content_mode: "full" | "excerpt";
  source_estimated_tokens: number;
  returned_estimated_tokens: number;
  record?: MorynRecord;
  excerpt?: string;
}

export type HistoricalRecallMatchSummary = Omit<HistoricalRecallMatch, "record" | "excerpt">;

export interface HistoricalRecallRecovery {
  version: 1;
  attempted: true;
  status: "not_found" | "recovered" | "unavailable";
  trigger: HistoricalRecallTrigger;
  read_scope: "current_replay_history";
  include_private: boolean;
  limits: { max_records: number; token_budget: number };
  matches: HistoricalRecallMatchSummary[];
  matches_by_record_id: Record<string, HistoricalRecallMatch>;
  stats: {
    scanned_records: number;
    historical_candidates: number;
    matching_candidates: number;
    returned_records: number;
    full_records: number;
    excerpt_records: number;
    returned_estimated_tokens: number;
    private_records_omitted: number;
    quarantined_records_omitted: number;
    purged_records_omitted: number;
    result_limit_omissions: number;
    token_budget_omissions: number;
  };
  upgrade: {
    mode: "capture_learning_delta_after_verification";
    automatic_source_reactivation: false;
    evidence_record_ids: string[];
    candidate_record_ids: string[];
  };
  limitations: {
    point_in_time_revisions_restored: false;
  };
  failure?: {
    code: "HISTORICAL_RECALL_UNAVAILABLE";
    reason: "fallback_failed_closed";
  };
  selection_sources: typeof HISTORICAL_RECALL_SELECTION_SOURCES;
}

export const HISTORICAL_RECALL_SELECTION_SOURCES = {
  match: "historical_recovery.matches_by_record_id.<record_id>",
  record_id: "historical_recovery.matches_by_record_id.<record_id>.record_id",
  full_record: "historical_recovery.matches_by_record_id.<record_id>.record",
  excerpt: "historical_recovery.matches_by_record_id.<record_id>.excerpt",
  covered_by_record_id: "historical_recovery.matches_by_record_id.<record_id>.covered_by_record_ids[]",
  upgrade_evidence_record_id: "historical_recovery.upgrade.evidence_record_ids[]",
  upgrade_candidate_record_id: "historical_recovery.upgrade.candidate_record_ids[]"
} as const;

function emptyStats(): HistoricalRecallRecovery["stats"] {
  return {
    scanned_records: 0,
    historical_candidates: 0,
    matching_candidates: 0,
    returned_records: 0,
    full_records: 0,
    excerpt_records: 0,
    returned_estimated_tokens: 0,
    private_records_omitted: 0,
    quarantined_records_omitted: 0,
    purged_records_omitted: 0,
    result_limit_omissions: 0,
    token_budget_omissions: 0
  };
}

export function unavailableHistoricalRecall(
  input: {
    include_private?: boolean;
    trigger?: HistoricalRecallTrigger;
    max_records?: number;
    token_budget?: number;
  } = {}
): HistoricalRecallRecovery {
  return {
    version: 1,
    attempted: true,
    status: "unavailable",
    trigger: input.trigger ?? "active_working_set_knowledge_gap",
    read_scope: "current_replay_history",
    include_private: input.include_private === true,
    limits: {
      max_records: input.max_records ?? DEFAULT_HISTORICAL_RECALL_MAX_RECORDS,
      token_budget: input.token_budget ?? DEFAULT_HISTORICAL_RECALL_TOKEN_BUDGET
    },
    matches: [],
    matches_by_record_id: stringKeyedRecordFromEntries([]),
    stats: emptyStats(),
    upgrade: {
      mode: "capture_learning_delta_after_verification",
      automatic_source_reactivation: false,
      evidence_record_ids: [],
      candidate_record_ids: []
    },
    limitations: { point_in_time_revisions_restored: false },
    failure: { code: "HISTORICAL_RECALL_UNAVAILABLE", reason: "fallback_failed_closed" },
    selection_sources: HISTORICAL_RECALL_SELECTION_SOURCES
  };
}

interface RankedHistoricalCandidate {
  record: MorynRecord;
  layer: MemoryLayer;
  tier: MemoryRetentionTier;
  validity_status: MemoryValidityStatus;
  stale: boolean;
  reasons: HistoricalRecallReason[];
  covered_by_record_ids: string[];
  logical_successor_record_id?: string;
  matched_tokens: string[];
  query_tokens: string[];
  coverage: number;
  score: number;
  estimated_tokens: number;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new Error(`Invalid historical recall ${name}`);
  }
  return normalized;
}

function estimateTextTokens(value: string): number {
  let asciiBytes = 0;
  let nonAsciiBytes = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (bytes === 1) asciiBytes += 1;
    else nonAsciiBytes += bytes;
  }
  return Math.max(1, Math.ceil(asciiBytes / 4 + nonAsciiBytes / 3));
}

function normalizedText(record: MorynRecord): string {
  return searchableRecordText(record).replace(/\s+/g, " ").trim();
}

function excerptAroundMatch(
  text: string,
  query: string,
  matchedTokens: readonly string[],
  tokenBudget: number
): string {
  if (!text) return `${query.trim()} [historical record content unavailable]`;
  const lower = text.toLocaleLowerCase();
  const needles = [query.trim(), ...matchedTokens]
    .map((value) => value.toLocaleLowerCase())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || compareCodeUnits(left, right));
  const anchor = needles.map((needle) => lower.indexOf(needle)).find((position) => position >= 0) ?? 0;
  let radius = Math.max(48, tokenBudget * 2);
  let excerpt = text;
  while (estimateTextTokens(excerpt) > tokenBudget && radius >= 24) {
    const start = Math.max(0, anchor - Math.floor(radius / 3));
    const end = Math.min(text.length, start + radius);
    excerpt = `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
    radius = Math.floor(radius * 0.8);
  }
  while (estimateTextTokens(excerpt) > tokenBudget && excerpt.length > 24) {
    excerpt = `${excerpt.slice(0, Math.max(20, Math.floor(excerpt.length * 0.8))).trim()}...`;
  }
  return excerpt;
}

function projectMatches(record: MorynRecord, projectId: string | undefined): boolean {
  return !projectId || record.scope === "global" || record.project_id === projectId;
}

function relatedRecordAllowed(input: {
  record: MorynRecord | undefined;
  project_id?: string;
  include_private: boolean;
  excluded: ReadonlySet<string>;
  retention_by_id: ReadonlyMap<string, { retention: { tier: MemoryRetentionTier } }>;
}): input is typeof input & { record: MorynRecord } {
  const record = input.record;
  if (!record || input.excluded.has(record.id) || !projectMatches(record, input.project_id)) return false;
  if (record.state === "raw") return false;
  if (record.state === "quarantined" || record.visibility === "quarantined") return false;
  if (input.retention_by_id.get(record.id)?.retention.tier === "purged") return false;
  if (isPrivateMemoryBoundary(record) && !input.include_private) return false;
  return true;
}

function directSourceRecordIds(record: MorynRecord): string[] {
  const value = record.content.source_record_ids;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function verifiedCoveringRecordIds(input: {
  source: MorynRecord;
  records: readonly MorynRecord[];
  records_by_id: ReadonlyMap<string, MorynRecord>;
  retention_covered_by_record_ids: readonly string[];
  project_id?: string;
  include_private: boolean;
  excluded: ReadonlySet<string>;
  retention_by_id: ReadonlyMap<string, { retention: { tier: MemoryRetentionTier } }>;
}): string[] {
  const covering = new Set<string>();
  const allowed = (record: MorynRecord | undefined) =>
    relatedRecordAllowed({
      record,
      project_id: input.project_id,
      include_private: input.include_private,
      excluded: input.excluded,
      retention_by_id: input.retention_by_id
    });
  for (const recordId of input.retention_covered_by_record_ids) {
    if (allowed(input.records_by_id.get(recordId))) covering.add(recordId);
  }
  for (const candidate of input.records) {
    if (
      candidate.id === input.source.id ||
      covering.has(candidate.id) ||
      !directSourceRecordIds(candidate).includes(input.source.id) ||
      !allowed(candidate)
    )
      continue;
    try {
      const expansion = expandMemorySources({
        records: input.records,
        record_id: candidate.id,
        include_private: input.include_private,
        max_depth: 1,
        max_records: 1
      });
      if (
        expansion.edges.some(
          (edge) =>
            edge.from_record_id === candidate.id &&
            edge.to_record_id === input.source.id &&
            edge.verification === "verified"
        )
      )
        covering.add(candidate.id);
    } catch {}
  }
  return [...covering].sort(compareCodeUnits);
}

function redactUnsafeRecordIds(value: unknown, unsafeRecordIds: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const recordId of unsafeRecordIds) redacted = redacted.replaceAll(recordId, "[redacted-record-id]");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactUnsafeRecordIds(item, unsafeRecordIds));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsafeRecordIds.has(key))
      .map(([key, nested]) => [key, redactUnsafeRecordIds(nested, unsafeRecordIds)])
  );
}

function safeHistoricalRecord(input: {
  record: MorynRecord;
  records_by_id: ReadonlyMap<string, MorynRecord>;
  unsafe_record_ids: ReadonlySet<string>;
}): MorynRecord {
  const projected = redactUnsafeRecordIds(input.record, input.unsafe_record_ids) as MorynRecord;
  const links = projected.links?.filter(
    (_link, index) =>
      input.records_by_id.has(input.record.links?.[index]?.record_id ?? "") &&
      !input.unsafe_record_ids.has(input.record.links?.[index]?.record_id ?? "")
  );
  const derivedFrom = input.record.provenance?.derived_from?.filter(
    (recordId) => input.records_by_id.has(recordId) && !input.unsafe_record_ids.has(recordId)
  );
  return {
    ...projected,
    ...(projected.links ? { links: links as MorynRecord["links"] } : {}),
    ...(projected.provenance
      ? {
          provenance: {
            ...projected.provenance,
            ...(projected.provenance.derived_from ? { derived_from: derivedFrom } : {})
          }
        }
      : {}),
    ...(projected.conflict
      ? {
          conflict: {
            ...projected.conflict,
            with:
              input.record.conflict?.with.filter(
                (recordId) => input.records_by_id.has(recordId) && !input.unsafe_record_ids.has(recordId)
              ) ?? []
          }
        }
      : {})
  };
}

function filtersMatch(record: MorynRecord, input: HistoricalRecallInput): boolean {
  if (!projectMatches(record, input.project_id)) return false;
  if (input.kinds?.length && !input.kinds.includes(record.kind)) return false;
  if (input.scopes?.length && !input.scopes.includes(record.scope)) return false;
  if (input.types?.length && !input.types.includes(record.type)) return false;
  if (input.tags?.length && !input.tags.some((tag) => record.tags.includes(tag))) return false;
  if (
    input.files?.length &&
    !input.files.some((file) =>
      `${searchableRecordText(record)} ${record.tags.join(" ")}`.toLocaleLowerCase().includes(file.toLocaleLowerCase())
    )
  )
    return false;
  return true;
}

function historicalReasons(input: {
  record: MorynRecord;
  tier: MemoryRetentionTier;
  selected: ReadonlySet<string>;
  logicalHidden: Readonly<Record<string, { active_record_id: string }>>;
}): HistoricalRecallReason[] {
  const reasons = new Set<HistoricalRecallReason>();
  if (input.record.state === "archived" || input.record.visibility === "archived") reasons.add("archived");
  if (input.tier === "cold") reasons.add("cold");
  if (input.logicalHidden[input.record.id]) reasons.add("logical_history");
  if (
    input.record.state !== "raw" &&
    input.record.state !== "archived" &&
    input.record.state !== "quarantined" &&
    input.record.visibility === "active" &&
    !input.selected.has(input.record.id)
  )
    reasons.add("working_set_omitted");
  return [...reasons].sort(compareCodeUnits);
}

function candidateScore(
  record: MorynRecord,
  query: string,
  coverage: number,
  reasons: readonly HistoricalRecallReason[]
) {
  const exactPhrase = normalizedText(record).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const reasonWeight = reasons.includes("working_set_omitted") ? 4 : reasons.includes("logical_history") ? 3 : 2;
  const priorityWeight = { low: 0, normal: 1, high: 2 }[record.priority];
  return (
    Math.round(coverage * 1_000) + Number(exactPhrase) * 100 + reasonWeight * 10 + priorityWeight + record.confidence
  );
}

function sufficientHistoricalMatch(match: ReturnType<typeof queryTokenCoverage>): boolean {
  const distinctiveToken = (token: string) => {
    const normalized = token.toLocaleLowerCase();
    return [...normalized].length >= 4 && !GENERIC_HISTORICAL_RECALL_TOKENS.has(normalized);
  };
  const distinctive = match.matched_tokens.filter(distinctiveToken);
  const distinctiveQuery = match.query_tokens.filter(distinctiveToken);
  if (distinctiveQuery.length && distinctive.length / distinctiveQuery.length >= 0.5) return true;
  return distinctive.length >= 2 || (distinctive.length === 1 && [...distinctive[0]!].length >= 12);
}

function contentForCandidate(
  candidate: RankedHistoricalCandidate,
  query: string,
  allowance: number,
  safeRecord: MorynRecord
): Pick<
  HistoricalRecallMatch,
  "content_mode" | "record" | "excerpt" | "source_estimated_tokens" | "returned_estimated_tokens"
> {
  if (candidate.estimated_tokens <= allowance) {
    return {
      content_mode: "full",
      record: safeRecord,
      source_estimated_tokens: candidate.estimated_tokens,
      returned_estimated_tokens: candidate.estimated_tokens
    };
  }
  const excerpt = excerptAroundMatch(
    normalizedText(safeRecord) || displayRecordText(safeRecord),
    query,
    candidate.matched_tokens,
    allowance
  );
  return {
    content_mode: "excerpt",
    excerpt,
    source_estimated_tokens: candidate.estimated_tokens,
    returned_estimated_tokens: estimateTextTokens(excerpt)
  };
}

export function recoverHistoricalRecall(input: HistoricalRecallInput): HistoricalRecallRecovery {
  const query = input.query.trim();
  if (!query) throw new Error("Historical recall requires a non-empty query");
  const trigger = input.trigger ?? "active_working_set_knowledge_gap";
  const maxRecords = boundedInteger(input.max_records, DEFAULT_HISTORICAL_RECALL_MAX_RECORDS, 1, 20, "max_records");
  const tokenBudget = boundedInteger(
    input.token_budget,
    DEFAULT_HISTORICAL_RECALL_TOKEN_BUDGET,
    128,
    16_000,
    "token_budget"
  );
  const selected = new Set(input.active_working_set_record_ids);
  const excluded = new Set(input.excluded_record_ids ?? []);
  const logical = buildActiveLogicalMemoryView([...input.records]);
  const retention = buildMemoryRetentionReadModel(input.records, { now: input.now });
  const retentionById = new Map(retention.records.map((view) => [view.record_id, view]));
  const recordsById = new Map(input.records.map((record) => [record.id, record]));
  const unsafeRecordIds = new Set(
    input.records
      .filter(
        (record) =>
          !relatedRecordAllowed({
            record,
            project_id: input.project_id,
            include_private: input.include_private === true,
            excluded,
            retention_by_id: retentionById
          })
      )
      .map((record) => record.id)
  );
  let privateRecordsOmitted = 0;
  let quarantinedRecordsOmitted = 0;
  let purgedRecordsOmitted = 0;
  let historicalCandidates = 0;
  const ranked: RankedHistoricalCandidate[] = [];

  for (const record of input.records) {
    if (excluded.has(record.id) || selected.has(record.id) || !filtersMatch(record, input)) continue;
    const view = retentionById.get(record.id);
    if (!view) continue;
    if (record.state === "quarantined" || record.visibility === "quarantined") {
      quarantinedRecordsOmitted += 1;
      continue;
    }
    if (view.retention.tier === "purged") {
      purgedRecordsOmitted += 1;
      continue;
    }
    if (isPrivateMemoryBoundary(record) && input.include_private !== true) {
      privateRecordsOmitted += 1;
      continue;
    }
    if (record.state === "raw") continue;
    const reasons = historicalReasons({
      record,
      tier: view.retention.tier,
      selected,
      logicalHidden: logical.hidden_by_record_id
    });
    if (!reasons.length) continue;
    historicalCandidates += 1;
    const match = queryTokenCoverage(query, record);
    if (!sufficientHistoricalMatch(match)) continue;
    const logicalSuccessor = logical.hidden_by_record_id[record.id]
      ? recordsById.get(logical.hidden_by_record_id[record.id]!.active_record_id)
      : undefined;
    const safeLogicalSuccessor = relatedRecordAllowed({
      record: logicalSuccessor,
      project_id: input.project_id,
      include_private: input.include_private === true,
      excluded,
      retention_by_id: retentionById
    })
      ? logicalSuccessor
      : undefined;
    ranked.push({
      record,
      layer: view.layer.level,
      tier: view.retention.tier,
      validity_status: view.validity.status,
      stale: view.validity.status === "stale" || view.validity.status === "expired",
      reasons,
      covered_by_record_ids: [],
      ...(safeLogicalSuccessor ? { logical_successor_record_id: safeLogicalSuccessor.id } : {}),
      ...match,
      score: candidateScore(record, query, match.coverage, reasons),
      estimated_tokens: estimateMemoryRecordTokens(record)
    });
  }

  ranked.sort(
    (left, right) =>
      right.coverage - left.coverage ||
      Number(left.stale) - Number(right.stale) ||
      right.score - left.score ||
      compareCodeUnits(right.record.updated_at, left.record.updated_at) ||
      compareCodeUnits(left.record.id, right.record.id)
  );

  const detailedMatches: HistoricalRecallMatch[] = [];
  let remainingTokens = tokenBudget;
  let tokenBudgetOmissions = 0;
  const resultLimitOmissions = Math.max(0, ranked.length - maxRecords);
  const boundedCandidates = ranked.slice(0, maxRecords);
  for (const candidate of boundedCandidates) {
    if (remainingTokens < 32) {
      tokenBudgetOmissions += 1;
      continue;
    }
    const remainingSlots = Math.max(1, boundedCandidates.length - detailedMatches.length);
    const allowance = Math.max(32, Math.min(remainingTokens, Math.floor(tokenBudget / remainingSlots)));
    const safeRecord = safeHistoricalRecord({
      record: candidate.record,
      records_by_id: recordsById,
      unsafe_record_ids: unsafeRecordIds
    });
    const content = contentForCandidate(candidate, query, allowance, safeRecord);
    if (content.returned_estimated_tokens > remainingTokens) {
      tokenBudgetOmissions += 1;
      continue;
    }
    const record = candidate.record;
    candidate.covered_by_record_ids = verifiedCoveringRecordIds({
      source: record,
      records: input.records,
      records_by_id: recordsById,
      retention_covered_by_record_ids: retentionById.get(record.id)?.lineage.coverage_verified
        ? (retentionById.get(record.id)?.lineage.covered_by_record_ids ?? [])
        : [],
      project_id: input.project_id,
      include_private: input.include_private === true,
      excluded,
      retention_by_id: retentionById
    });
    detailedMatches.push({
      record_id: record.id,
      kind: record.kind,
      type: record.type,
      scope: record.scope,
      ...(record.project_id ? { project_id: record.project_id } : {}),
      state: record.state,
      visibility: record.visibility,
      confidence: record.confidence,
      priority: record.priority,
      updated_at: record.updated_at,
      layer: candidate.layer,
      tier: candidate.tier,
      validity_status: candidate.validity_status,
      stale: candidate.stale,
      reasons: candidate.reasons,
      covered_by_record_ids: candidate.covered_by_record_ids,
      ...(candidate.logical_successor_record_id
        ? { logical_successor_record_id: candidate.logical_successor_record_id }
        : {}),
      matched_tokens: candidate.matched_tokens,
      query_tokens: candidate.query_tokens,
      coverage: candidate.coverage,
      score: candidate.score,
      ...content
    });
    remainingTokens -= content.returned_estimated_tokens;
  }

  const matches = detailedMatches.map((match): HistoricalRecallMatchSummary => {
    const { record: _record, excerpt: _excerpt, ...summary } = match;
    return summary;
  });
  const candidateRecordIds = matches.map((match) => match.record_id);
  const evidenceRecordIds = candidateRecordIds.slice(0, 1);
  return {
    version: 1,
    attempted: true,
    status: matches.length ? "recovered" : "not_found",
    trigger,
    read_scope: "current_replay_history",
    include_private: input.include_private === true,
    limits: { max_records: maxRecords, token_budget: tokenBudget },
    matches,
    matches_by_record_id: stringKeyedRecordFromEntries(
      detailedMatches.map((match) => [match.record_id, match] as const)
    ),
    stats: {
      scanned_records: input.records.length,
      historical_candidates: historicalCandidates,
      matching_candidates: ranked.length,
      returned_records: matches.length,
      full_records: detailedMatches.filter((match) => match.content_mode === "full").length,
      excerpt_records: detailedMatches.filter((match) => match.content_mode === "excerpt").length,
      returned_estimated_tokens: detailedMatches.reduce((total, match) => total + match.returned_estimated_tokens, 0),
      private_records_omitted: privateRecordsOmitted,
      quarantined_records_omitted: quarantinedRecordsOmitted,
      purged_records_omitted: purgedRecordsOmitted,
      result_limit_omissions: resultLimitOmissions,
      token_budget_omissions: tokenBudgetOmissions
    },
    upgrade: {
      mode: "capture_learning_delta_after_verification",
      automatic_source_reactivation: false,
      evidence_record_ids: evidenceRecordIds,
      candidate_record_ids: candidateRecordIds
    },
    limitations: { point_in_time_revisions_restored: false },
    selection_sources: HISTORICAL_RECALL_SELECTION_SOURCES
  };
}
