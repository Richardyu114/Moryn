import { searchableRecordText } from "./content-text.js";
import type { MorynRecord } from "./types.js";

export type RecallOutcomeStatus = "trusted_match" | "verification_required" | "knowledge_gap";
export type RecallTrust = "trusted" | "limited" | "none";

export interface RecallOutcomeResult {
  record: MorynRecord;
  score: number;
  reason: string[];
}

export interface RecallOutcome {
  status: RecallOutcomeStatus;
  best_record_id?: string;
  best_score: number;
  coverage: number;
  trust: RecallTrust;
  stale: boolean;
  recommended_action: "use_recalled_knowledge" | "verify_then_use_or_learn" | "explore_then_capture_learning";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedTokens(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

export function queryTokenCoverage(query: string, record: MorynRecord): {
  matched_tokens: string[];
  query_tokens: string[];
  coverage: number;
} {
  const queryTokens = normalizedTokens(query);
  const haystack = searchableRecordText(record).toLowerCase();
  const matchedTokens = queryTokens.filter((token) => haystack.includes(token));
  return {
    matched_tokens: matchedTokens,
    query_tokens: queryTokens,
    coverage: queryTokens.length === 0 ? 0 : matchedTokens.length / queryTokens.length
  };
}

function recordTrust(record: MorynRecord): RecallTrust {
  const method = record.provenance?.method;
  if (record.state === "canonical" && record.confidence >= 0.75 && (method === "user-confirmed" || method === "rule-promoted")) return "trusted";
  return "limited";
}

function recordValidUntil(record: MorynRecord): string | undefined {
  const value = record.content.valid_until;
  return typeof value === "string" ? value : undefined;
}

function isStale(record: MorynRecord, now: string | undefined): boolean {
  const validUntil = recordValidUntil(record);
  if (!validUntil || !now) return false;
  return Date.parse(validUntil) < Date.parse(now);
}

export function assessRecallOutcome(input: {
  query: string;
  results: RecallOutcomeResult[];
  now?: string;
}): RecallOutcome {
  const assessed = input.results.map((result) => ({
    ...result,
    coverage: queryTokenCoverage(input.query, result.record).coverage,
    trust: recordTrust(result.record),
    stale: isStale(result.record, input.now)
  })).sort((left, right) => right.coverage - left.coverage
    || right.score - left.score
    || compareCodeUnits(left.record.id, right.record.id));
  const best = assessed[0];
  if (!best || best.coverage < 0.5) {
    return {
      status: "knowledge_gap",
      best_record_id: undefined,
      best_score: best?.score ?? 0,
      coverage: best?.coverage ?? 0,
      trust: "none",
      stale: false,
      recommended_action: "explore_then_capture_learning"
    };
  }
  if (best.coverage >= 0.75 && best.trust === "trusted" && !best.stale) {
    return {
      status: "trusted_match",
      best_record_id: best.record.id,
      best_score: best.score,
      coverage: best.coverage,
      trust: best.trust,
      stale: false,
      recommended_action: "use_recalled_knowledge"
    };
  }
  return {
    status: "verification_required",
    best_record_id: best.record.id,
    best_score: best.score,
    coverage: best.coverage,
    trust: best.trust,
    stale: best.stale,
    recommended_action: "verify_then_use_or_learn"
  };
}
