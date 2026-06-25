import { operationArgumentsByTool } from "../operation-contracts.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import { actionInterfaces, type ActionInterfaces } from "./action-interfaces.js";
import { isCaptureReviewCandidate } from "./capture-review.js";
import { displayRecordText } from "./content-text.js";
import { commandForTimelineContext } from "./errors.js";
import type { MorynEvent, MorynRecord, RecordKind, RecordState } from "./types.js";
import { withPhasesByName, withRequiredFieldsByName, type RequiredFieldMetadata } from "./workflow.js";

export interface DogfoodReportInput {
  project_id?: string;
  limit?: number;
  include_private?: boolean;
}

export interface DogfoodReportDiagnoseInput extends DogfoodReportInput {
  records: MorynRecord[];
  events: MorynEvent[];
  excluded_private_records?: number;
}

type DogfoodSeverity = "info" | "warning";
type DogfoodCategory = "capture_review" | "duplication" | "friction";
type DogfoodActionTool = "dashboard" | "timeline" | "memory_doctor";

export interface DogfoodFinding {
  id: string;
  category: DogfoodCategory;
  severity: DogfoodSeverity;
  summary: string;
  reason: string;
  project_id?: string;
  record_id?: string;
  record_ids?: string[];
  event_ids?: string[];
  evidence?: Array<{ source: string; record_id?: string; event_id?: string }>;
}

export interface DogfoodSuggestedAction {
  action_id: string;
  recommended_action: string;
  tool: DogfoodActionTool;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  required_fields_by_name: Record<string, RequiredFieldMetadata>;
  arguments_by_name: ReturnType<typeof operationArgumentsByTool>;
  interfaces: ActionInterfaces<Record<string, unknown>>;
  safety: ReturnType<typeof actionSafety>;
  execution: ReturnType<typeof actionExecution>;
  workflow: ReturnType<typeof withPhasesByName<{
    version: 1;
    start: "suggested_action";
    continue_from: string[];
    phases: Array<{
      phase: string;
      order: number;
      action_source: string;
      tool: DogfoodActionTool;
      required_when: string;
      required_fields: string[];
    }>;
  }>>;
}

export interface DogfoodStats {
  total_records: number;
  excluded_private_records: number;
  total_events: number;
  states: Partial<Record<RecordState, number>>;
  kinds: Partial<Record<RecordKind, number>>;
  autocapture_candidates: number;
  duplicate_text_groups: number;
  failure_signal_records: number;
}

export interface DogfoodReportResult {
  read_only: true;
  version: 1;
  scope: "local_store";
  project_id?: string;
  stats: DogfoodStats;
  findings: DogfoodFinding[];
  findings_by_id: Record<string, DogfoodFinding>;
  suggested_actions: DogfoodSuggestedAction[];
  suggested_actions_by_id: Record<string, DogfoodSuggestedAction>;
  records: MorynRecord[];
  records_by_id: Record<string, MorynRecord>;
  events: MorynEvent[];
  events_by_id: Record<string, MorynEvent>;
  selection_sources: typeof DOGFOOD_REPORT_SELECTION_SOURCES;
}

export const DOGFOOD_REPORT_SELECTION_SOURCES = {
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  event: "events_by_id.<event_id>",
  event_id: "events_by_id.<event_id>.event_id"
} as const;

const FAILURE_WORDS = /\b(?:fail(?:ed|ure)?|timeout|timed out|error|blocked|stuck|regression|flaky)\b/i;
const RESOLVED_IMPLEMENTATION_WORDS = /\b(?:added|aligned|completed|complete|finished|fixed|parameterized|resolved|implemented|updated|shipped|landed|committed|pushed|restarted)\b/i;
const VERIFICATION_WORDS = /\b(?:verified|verification completed|passing|passed|typecheck|build|release check|tests? passed|regression tests?|healthy|zero\s+\w+(?:\s+\w+){0,3}\s+(?:backlog|candidates|items)|no\s+dogfood\s+\w+(?:\s+\w+){0,2}\s+backlog)\b/i;

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function recordsById(records: MorynRecord[]): Record<string, MorynRecord> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

function eventsById(events: MorynEvent[]): Record<string, MorynEvent> {
  return Object.fromEntries(events.map((event) => [event.event_id, event]));
}

function recordEventIds(events: MorynEvent[], recordIds: Set<string>): string[] {
  return events
    .filter((event) => {
      if (event.op === "upsert_record") return recordIds.has(event.record.id);
      return recordIds.has(event.record_id);
    })
    .map((event) => event.event_id);
}

function textKey(record: MorynRecord): string {
  return displayRecordText(record).trim().toLowerCase().replace(/\s+/g, " ");
}

function isFailureSignal(record: MorynRecord): boolean {
  if (record.state === "archived" || record.state === "quarantined") return false;
  const haystack = `${record.kind} ${record.type} ${record.tags.join(" ")} ${displayRecordText(record)}`;
  if (record.kind === "session_summary" && isResolvedImplementationHandoff(haystack)) return false;
  return FAILURE_WORDS.test(haystack);
}

function isResolvedImplementationHandoff(text: string): boolean {
  return RESOLVED_IMPLEMENTATION_WORDS.test(text) && VERIFICATION_WORDS.test(text);
}

function duplicateAutocaptureGroups(records: MorynRecord[]): MorynRecord[][] {
  const groups = new Map<string, MorynRecord[]>();
  for (const record of records.filter(isCaptureReviewCandidate)) {
    const key = textKey(record);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function stableRecordSort(left: MorynRecord, right: MorynRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function stats(records: MorynRecord[], events: MorynEvent[], excludedPrivateRecords: number): DogfoodStats {
  const duplicateGroups = duplicateAutocaptureGroups(records);
  return {
    total_records: records.length,
    excluded_private_records: excludedPrivateRecords,
    total_events: events.length,
    states: countBy(records.map((record) => record.state)),
    kinds: countBy(records.map((record) => record.kind)),
    autocapture_candidates: records.filter(isCaptureReviewCandidate).length,
    duplicate_text_groups: duplicateGroups.length,
    failure_signal_records: records.filter(isFailureSignal).length
  };
}

function evidenceForRecords(source: string, records: MorynRecord[], events: MorynEvent[]): Array<{ source: string; record_id: string; event_id?: string }> {
  return records.map((record) => {
    const event = events.find((candidate) => candidate.op === "upsert_record" && candidate.record.id === record.id);
    return {
      source,
      record_id: record.id,
      ...(event ? { event_id: event.event_id } : {})
    };
  });
}

function captureBacklogFinding(records: MorynRecord[], events: MorynEvent[], projectId: string | undefined): DogfoodFinding | undefined {
  const captures = records.filter(isCaptureReviewCandidate);
  if (!captures.length) return undefined;
  const recordIds = captures.map((record) => record.id);
  return {
    id: "capture_review_backlog",
    category: "capture_review",
    severity: captures.length > 1 ? "warning" : "info",
    summary: "Autocaptured handoffs are waiting for review.",
    reason: `${captures.length} autocapture/review candidate record${captures.length === 1 ? " is" : "s are"} active.`,
    ...(projectId ? { project_id: projectId } : {}),
    record_ids: recordIds,
    event_ids: recordEventIds(events, new Set(recordIds)),
    evidence: evidenceForRecords("records.autocapture_candidates[]", captures, events)
  };
}

function duplicateCaptureFinding(records: MorynRecord[], events: MorynEvent[], projectId: string | undefined): DogfoodFinding | undefined {
  const groups = duplicateAutocaptureGroups(records);
  if (!groups.length) return undefined;
  const duplicateRecords = groups.flat();
  const recordIds = duplicateRecords.map((record) => record.id);
  return {
    id: "duplicate_capture_text",
    category: "duplication",
    severity: "warning",
    summary: "Repeated autocapture text suggests review noise.",
    reason: `${groups.length} duplicate autocapture text group${groups.length === 1 ? "" : "s"} found.`,
    ...(projectId ? { project_id: projectId } : {}),
    record_ids: recordIds,
    event_ids: recordEventIds(events, new Set(recordIds)),
    evidence: evidenceForRecords("records.duplicate_autocapture_groups[]", duplicateRecords, events)
  };
}

function failureSignalFinding(records: MorynRecord[], events: MorynEvent[], projectId: string | undefined, limit: number): DogfoodFinding | undefined {
  const failures = records.filter(isFailureSignal).slice(0, limit);
  if (!failures.length) return undefined;
  const recordIds = failures.map((record) => record.id);
  return {
    id: "failure_signals",
    category: "friction",
    severity: "warning",
    summary: "Recent dogfood notes contain failure or timeout language.",
    reason: `${failures.length} active record${failures.length === 1 ? "" : "s"} mention failure, timeout, blocked, or similar friction.`,
    ...(projectId ? { project_id: projectId } : {}),
    record_id: failures[0]?.id,
    record_ids: recordIds,
    event_ids: recordEventIds(events, new Set(recordIds)),
    evidence: evidenceForRecords("records.failure_signals[]", failures, events)
  };
}

function withSuggestedActionMetadata(input: {
  action_id: string;
  recommended_action: string;
  tool: DogfoodActionTool;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields?: string[];
}): DogfoodSuggestedAction {
  const action = withRequiredFieldsByName({
    ...input,
    required_fields: input.required_fields ?? []
  });
  const argumentsByName = operationArgumentsByTool(input.tool);
  return {
    ...action,
    arguments_by_name: argumentsByName,
    interfaces: actionInterfaces({
      tool: input.tool,
      command: input.command,
      arguments: input.arguments
    }),
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      arguments_by_name: argumentsByName,
      required_fields_by_name: action.required_fields_by_name
    }),
    workflow: withPhasesByName({
      version: 1,
      start: "suggested_action",
      continue_from: ["dogfood_report.suggested_actions_by_id.<action_id>", "dogfood_report.suggested_actions[]"],
      phases: [
        {
          phase: input.recommended_action,
          order: 1,
          action_source: "dogfood_report.suggested_actions_by_id.<action_id>",
          tool: input.tool,
          required_when: input.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

function dashboardCommand(projectId: string | undefined): string {
  return `moryn dashboard --serve${projectId ? ` --project-id ${projectId}` : ""}`;
}

function reviewCaptureAction(projectId: string | undefined): DogfoodSuggestedAction {
  return withSuggestedActionMetadata({
    action_id: "review_capture_inbox",
    recommended_action: "review_capture_inbox",
    tool: "dashboard",
    command: dashboardCommand(projectId),
    arguments: {
      serve: true,
      ...(projectId ? { project_id: projectId } : {})
    },
    safe_to_run: true,
    required_when: "When Dogfood Report finds autocaptured handoffs waiting for review."
  });
}

function inspectFailureAction(recordId: string, projectId: string | undefined): DogfoodSuggestedAction {
  const args = {
    record_id: recordId,
    ...(projectId ? { project_id: projectId } : {}),
    before: 3,
    after: 3
  };
  return withSuggestedActionMetadata({
    action_id: "inspect_failure_signals",
    recommended_action: "inspect_failure_signals",
    tool: "timeline",
    command: commandForTimelineContext(args),
    arguments: args,
    safe_to_run: true,
    required_when: "When Dogfood Report finds failure, timeout, or blocked-work signals."
  });
}

export function diagnoseDogfood(input: DogfoodReportDiagnoseInput): DogfoodReportResult {
  const limit = input.limit ?? 20;
  const records = [...input.records].sort(stableRecordSort);
  const events = input.events;
  const reportStats = stats(records, events, input.excluded_private_records ?? 0);
  const findings = [
    captureBacklogFinding(records, events, input.project_id),
    duplicateCaptureFinding(records, events, input.project_id),
    failureSignalFinding(records, events, input.project_id, limit)
  ].filter((finding): finding is DogfoodFinding => finding !== undefined);
  const actions = [
    ...(findings.some((finding) => finding.id === "capture_review_backlog") ? [reviewCaptureAction(input.project_id)] : []),
    ...(findings.some((finding) => finding.id === "failure_signals")
      ? [inspectFailureAction(findings.find((finding) => finding.id === "failure_signals")!.record_id!, input.project_id)]
      : [])
  ].slice(0, limit);
  const referencedRecordIds = new Set(findings.flatMap((finding) => finding.record_ids ?? (finding.record_id ? [finding.record_id] : [])));
  const referencedEventIds = new Set(findings.flatMap((finding) => finding.event_ids ?? []));
  const recordSelection = records.filter((record) => referencedRecordIds.has(record.id)).slice(0, limit);
  const eventSelection = events.filter((event) => referencedEventIds.has(event.event_id)).slice(0, limit);
  return {
    read_only: true,
    version: 1,
    scope: "local_store",
    ...(input.project_id ? { project_id: input.project_id } : {}),
    stats: reportStats,
    findings,
    findings_by_id: Object.fromEntries(findings.map((finding) => [finding.id, finding])),
    suggested_actions: actions,
    suggested_actions_by_id: Object.fromEntries(actions.map((action) => [action.action_id, action])),
    records: recordSelection,
    records_by_id: recordsById(recordSelection),
    events: eventSelection,
    events_by_id: eventsById(eventSelection),
    selection_sources: DOGFOOD_REPORT_SELECTION_SOURCES
  };
}
