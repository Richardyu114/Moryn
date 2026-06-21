import type { RecordKind, RecordScope, RecordState } from "./types.js";

export const RECALL_EVAL_SELECTION_SOURCES = {
  case: "cases_by_id.<case_id>",
  case_id: "cases_by_id.<case_id>.case_id",
  expected_record: "cases_by_id.<case_id>.expected_record_ids[]",
  matched_record: "cases_by_id.<case_id>.matched_record_ids[]",
  missing_record: "cases_by_id.<case_id>.missing_record_ids[]",
  privacy_check: "privacy",
  suggested_action: "suggested_actions_by_id.<action_id>",
  suggested_action_id: "suggested_actions_by_id.<action_id>.action_id"
} as const;

export interface RecallEvalInput {
  project_id?: unknown;
  cases?: unknown;
  include_private?: unknown;
}

export interface RecallEvalCaseInput {
  case_id?: unknown;
  query?: unknown;
  expected_record_ids?: unknown;
  limit?: unknown;
  kinds?: unknown;
  scopes?: unknown;
  types?: unknown;
  states?: unknown;
  tags?: unknown;
  files?: unknown;
}

export interface RecallEvalRecallInput {
  query?: string;
  project_id?: string;
  kinds?: RecordKind[];
  scopes?: RecordScope[];
  types?: string[];
  states?: RecordState[];
  tags?: string[];
  files?: string[];
  limit?: number;
  include_private?: boolean;
}

export interface RecallEvalRecallResult {
  results: Array<{
    record: {
      id: string;
      tags: string[];
      provenance?: { method?: string };
    };
    score: number;
    reason: string[];
  }>;
}

export interface RecallEvalCaseResult {
  case_id: string;
  status: "pass" | "fail";
  query: string;
  expected_record_ids: string[];
  matched_record_ids: string[];
  missing_record_ids: string[];
  top_record_id?: string;
  recall: RecallEvalRecallInput;
  results: Array<{
    record_id: string;
    rank: number;
    score: number;
    reason: string[];
    provenance_method: string;
  }>;
}

export interface RecallEvalSuggestedAction {
  action_id: string;
  recommended_action: "revise_golden_case_or_memory";
  tool: "recall";
  command: string;
  case_id: string;
  missing_record_ids: string[];
}

export interface RecallEvalReport {
  summary: {
    total_cases: number;
    passed_cases: number;
    failed_cases: number;
    hit_rate: number;
    privacy_leaks: number;
  };
  cases: RecallEvalCaseResult[];
  cases_by_id: Record<string, RecallEvalCaseResult>;
  privacy: {
    include_private: boolean;
    leaked_private_record_ids: string[];
    leak_count: number;
  };
  suggested_actions: RecallEvalSuggestedAction[];
  suggested_actions_by_id: Record<string, RecallEvalSuggestedAction>;
  selection_sources: typeof RECALL_EVAL_SELECTION_SOURCES;
}

type RecallFunction = (input: RecallEvalRecallInput) => Promise<RecallEvalRecallResult>;

function requireObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid argument: Invalid ${label}`);
  }
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid argument: Invalid ${label}`);
  }
  return value;
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`Invalid argument: Invalid ${label}`);
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Invalid argument: Invalid ${label}`);
  return value;
}

function limit(value: unknown, fallback = 10): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error("Invalid argument: Invalid limit");
  }
  return value;
}

function parseCase(value: unknown, index: number): RecallEvalCaseInput & {
  case_id: string;
  query: string;
  expected_record_ids: string[];
  limit: number;
  kinds?: RecordKind[];
  scopes?: RecordScope[];
  types?: string[];
  states?: RecordState[];
  tags?: string[];
  files?: string[];
} {
  requireObject(value, `cases[${index}]`);
  const caseId = optionalString(value.case_id, `cases[${index}].case_id`) ?? `case-${index + 1}`;
  const query = optionalString(value.query, `cases[${index}].query`);
  if (!query) throw new Error(`Invalid argument: Invalid cases[${index}].query`);
  const expected = optionalStringArray(value.expected_record_ids, `cases[${index}].expected_record_ids`);
  if (!expected?.length) throw new Error(`Invalid argument: Invalid cases[${index}].expected_record_ids`);
  return {
    case_id: caseId,
    query,
    expected_record_ids: expected,
    limit: limit(value.limit, 10),
    kinds: optionalStringArray(value.kinds, `cases[${index}].kinds`) as RecordKind[] | undefined,
    scopes: optionalStringArray(value.scopes, `cases[${index}].scopes`) as RecordScope[] | undefined,
    types: optionalStringArray(value.types, `cases[${index}].types`),
    states: optionalStringArray(value.states, `cases[${index}].states`) as RecordState[] | undefined,
    tags: optionalStringArray(value.tags, `cases[${index}].tags`),
    files: optionalStringArray(value.files, `cases[${index}].files`)
  };
}

function commandForRecall(input: RecallEvalRecallInput): string {
  const parts = ["moryn", "recall", JSON.stringify(input.query ?? "")];
  if (input.project_id) parts.push("--project-id", input.project_id);
  for (const kind of input.kinds ?? []) parts.push("--kind", kind);
  for (const scope of input.scopes ?? []) parts.push("--scope", scope);
  for (const type of input.types ?? []) parts.push("--type", type);
  for (const state of input.states ?? []) parts.push("--state", state);
  for (const tag of input.tags ?? []) parts.push("--tag", tag);
  for (const file of input.files ?? []) parts.push("--file", file);
  if (input.limit !== undefined) parts.push("--limit", String(input.limit));
  if (input.include_private) parts.push("--include-private");
  return parts.join(" ");
}

export async function evaluateRecall(
  input: RecallEvalInput,
  recall: RecallFunction
): Promise<RecallEvalReport> {
  requireObject(input, "recall_eval input");
  const projectId = optionalString(input.project_id, "project_id");
  const includePrivate = optionalBoolean(input.include_private, "include_private") === true;
  if (!Array.isArray(input.cases) || !input.cases.length) {
    throw new Error("Invalid argument: Invalid cases");
  }
  const cases = input.cases.map(parseCase);
  const results: RecallEvalCaseResult[] = [];
  const leakedPrivate = new Set<string>();

  for (const testCase of cases) {
    const recallInput: RecallEvalRecallInput = {
      query: testCase.query,
      project_id: projectId,
      kinds: testCase.kinds,
      scopes: testCase.scopes,
      types: testCase.types,
      states: testCase.states,
      tags: testCase.tags,
      files: testCase.files,
      limit: testCase.limit,
      include_private: includePrivate
    };
    const recalled = await recall(recallInput);
    const ranked = recalled.results.map((result, index) => {
      if (!includePrivate && result.record.tags.includes("private")) leakedPrivate.add(result.record.id);
      return {
        record_id: result.record.id,
        rank: index + 1,
        score: result.score,
        reason: result.reason,
        provenance_method: result.record.provenance?.method ?? "agent-proposed"
      };
    });
    const matched = testCase.expected_record_ids.filter((recordId) => ranked.some((result) => result.record_id === recordId));
    const missing = testCase.expected_record_ids.filter((recordId) => !matched.includes(recordId));
    results.push({
      case_id: testCase.case_id,
      status: missing.length ? "fail" : "pass",
      query: testCase.query,
      expected_record_ids: testCase.expected_record_ids,
      matched_record_ids: matched,
      missing_record_ids: missing,
      ...(ranked[0] ? { top_record_id: ranked[0].record_id } : {}),
      recall: recallInput,
      results: ranked
    });
  }

  const failedCases = results.filter((result) => result.status === "fail");
  const suggestedActions = failedCases.map((result) => ({
    action_id: `revise-golden-case:${result.case_id}`,
    recommended_action: "revise_golden_case_or_memory" as const,
    tool: "recall" as const,
    command: commandForRecall(result.recall),
    case_id: result.case_id,
    missing_record_ids: result.missing_record_ids
  }));

  return {
    summary: {
      total_cases: results.length,
      passed_cases: results.length - failedCases.length,
      failed_cases: failedCases.length,
      hit_rate: results.length ? (results.length - failedCases.length) / results.length : 0,
      privacy_leaks: leakedPrivate.size
    },
    cases: results,
    cases_by_id: Object.fromEntries(results.map((result) => [result.case_id, result])),
    privacy: {
      include_private: includePrivate,
      leaked_private_record_ids: [...leakedPrivate],
      leak_count: leakedPrivate.size
    },
    suggested_actions: suggestedActions,
    suggested_actions_by_id: Object.fromEntries(suggestedActions.map((action) => [action.action_id, action])),
    selection_sources: RECALL_EVAL_SELECTION_SOURCES
  };
}
