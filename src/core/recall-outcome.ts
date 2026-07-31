import { searchableRecordText } from "./content-text.js";
import { buildMemoryRetentionView } from "./memory-retention.js";
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

const MAX_QUERY_CODE_POINTS = 512;
const MAX_QUERY_TOKENS = 128;
const CJK_CHARACTER_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_-]/u;

interface TokenizedQuery {
  tokens: string[];
  cjk_bigrams: string[];
}

function tokenizeQuery(value: string): TokenizedQuery {
  const tokens: string[] = [];
  const cjkBigrams: string[] = [];
  const seenTokens = new Set<string>();
  const seenBigrams = new Set<string>();
  let run: string[] = [];
  let runKind: "cjk" | "word" | undefined;

  const append = (output: string[], seen: Set<string>, token: string) => {
    if (!token || seen.has(token) || output.length >= MAX_QUERY_TOKENS) return;
    seen.add(token);
    output.push(token);
  };
  const flush = () => {
    if (runKind === "cjk") {
      // Characters recover paraphrases; adjacent pairs keep scattered character overlap from becoming trusted.
      for (const character of run) append(tokens, seenTokens, character);
      for (let index = 0; index + 1 < run.length; index += 1) {
        append(cjkBigrams, seenBigrams, `${run[index]}${run[index + 1]}`);
      }
    } else if (runKind === "word") {
      append(tokens, seenTokens, run.join(""));
    }
    run = [];
    runKind = undefined;
  };

  for (const character of [...value.normalize("NFKC").toLowerCase()].slice(0, MAX_QUERY_CODE_POINTS)) {
    const kind = CJK_CHARACTER_PATTERN.test(character)
      ? "cjk"
      : WORD_CHARACTER_PATTERN.test(character)
        ? "word"
        : undefined;
    if (!kind) {
      flush();
      continue;
    }
    if (runKind && runKind !== kind) flush();
    runKind = kind;
    run.push(character);
  }
  flush();
  return { tokens, cjk_bigrams: cjkBigrams };
}

function queryCoverageAnalysis(tokenized: TokenizedQuery, record: MorynRecord) {
  const haystack = searchableRecordText(record).normalize("NFKC").toLowerCase();
  const matchedTokens = tokenized.tokens.filter((token) => haystack.includes(token));
  const matchedWord = matchedTokens.some((token) => !CJK_CHARACTER_PATTERN.test(token));
  const matchedCjkBigram = tokenized.cjk_bigrams.some((bigram) => haystack.includes(bigram));
  return {
    matched_tokens: matchedTokens,
    query_tokens: tokenized.tokens,
    coverage: tokenized.tokens.length === 0 ? 0 : matchedTokens.length / tokenized.tokens.length,
    reliable_match_anchor: matchedWord || matchedCjkBigram
  };
}

export function queryRecordMatch(query: string, record: MorynRecord) {
  return queryCoverageAnalysis(tokenizeQuery(query), record);
}

export function queryTokenCoverage(
  query: string,
  record: MorynRecord
): {
  matched_tokens: string[];
  query_tokens: string[];
  coverage: number;
} {
  const match = queryRecordMatch(query, record);
  return {
    matched_tokens: match.matched_tokens,
    query_tokens: match.query_tokens,
    coverage: match.coverage
  };
}

function recordTrust(record: MorynRecord): RecallTrust {
  const method = record.provenance?.method;
  if (
    record.state === "canonical" &&
    record.confidence >= 0.75 &&
    (method === "user-confirmed" || method === "rule-promoted")
  )
    return "trusted";
  return "limited";
}

function isStale(record: MorynRecord, now: string | undefined): boolean {
  const validity = buildMemoryRetentionView(record, now === undefined ? {} : { now }).validity.status;
  return validity === "stale" || validity === "expired";
}

function usableTrustRank(input: { trust: RecallTrust; stale: boolean }): number {
  if (input.stale) return 0;
  if (input.trust === "trusted") return 2;
  if (input.trust === "limited") return 1;
  return 0;
}

export function assessRecallOutcome(input: {
  query: string;
  results: RecallOutcomeResult[];
  now?: string;
}): RecallOutcome {
  const tokenizedQuery = tokenizeQuery(input.query);
  const assessed = input.results
    .map((result) => {
      const match = queryCoverageAnalysis(tokenizedQuery, result.record);
      return {
        ...result,
        coverage: match.coverage,
        reliable_match_anchor: match.reliable_match_anchor,
        trust: recordTrust(result.record),
        stale: isStale(result.record, input.now)
      };
    })
    .sort(
      (left, right) =>
        Number(right.reliable_match_anchor) - Number(left.reliable_match_anchor) ||
        right.coverage - left.coverage ||
        usableTrustRank(right) - usableTrustRank(left) ||
        right.score - left.score ||
        compareCodeUnits(left.record.id, right.record.id)
    );
  const best = assessed[0];
  if (!best || best.coverage < 0.5 || !best.reliable_match_anchor) {
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
  if (best.coverage >= 0.75 && best.reliable_match_anchor && best.trust === "trusted" && !best.stale) {
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
