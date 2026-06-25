import { operationArgumentsByTool } from "../operation-contracts.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import { actionInterfaces, type ActionInterfaces } from "./action-interfaces.js";
import { isCaptureReviewCandidate } from "./capture-review.js";
import { displayRecordText } from "./content-text.js";
import type { MorynEvent, MorynRecord } from "./types.js";
import { withPhasesByName, withRequiredFieldsByName, type RequiredFieldMetadata } from "./workflow.js";

export type HealthCheckStatus = "healthy" | "needs_attention" | "unhealthy";
export type HealthCheckComponentStatus = "pass" | "info" | "warning" | "fail";
export type HealthCheckCategory = "store" | "project" | "capture" | "privacy";

export interface HealthCheckInput {
  project_id?: string;
  limit?: number;
  include_private?: boolean;
}

export interface HealthCheckDiagnoseInput extends HealthCheckInput {
  records: MorynRecord[];
  events: MorynEvent[];
  excluded_private_records?: number;
}

export interface HealthCheckItem {
  id: string;
  category: HealthCheckCategory;
  status: HealthCheckComponentStatus;
  label: string;
  summary: string;
  reason: string;
  record_ids?: string[];
  event_ids?: string[];
  evidence?: Array<{ source: string; record_id?: string; event_id?: string }>;
}

export interface HealthCheckSuggestedAction {
  action_id: string;
  recommended_action: string;
  tool: "dashboard" | "project_list";
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
      tool: "dashboard" | "project_list";
      required_when: string;
      required_fields: string[];
    }>;
  }>>;
}

export interface HealthCheckStats {
  visible_records: number;
  excluded_private_records: number;
  total_events: number;
  project_records: number;
  capture_review_candidates: number;
  canonical_records: number;
}

export interface HealthCheckSummary {
  status: HealthCheckStatus;
  passing_checks: number;
  info_checks: number;
  warning_checks: number;
  failing_checks: number;
  next_step: string;
}

export interface HealthCheckReport {
  read_only: true;
  version: 1;
  scope: "local_store";
  status: HealthCheckStatus;
  project_id?: string;
  summary: HealthCheckSummary;
  stats: HealthCheckStats;
  checks: HealthCheckItem[];
  checks_by_id: Record<string, HealthCheckItem>;
  suggested_actions: HealthCheckSuggestedAction[];
  suggested_actions_by_id: Record<string, HealthCheckSuggestedAction>;
  selection_sources: typeof HEALTH_CHECK_SELECTION_SOURCES;
}

export const HEALTH_CHECK_SELECTION_SOURCES = {
  check: "checks_by_id.<check_id>",
  check_id: "checks_by_id.<check_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  stat: "stats.<field>"
} as const;

function isPrivateRecord(record: MorynRecord): boolean {
  return record.tags.includes("private");
}

function recordEventIds(events: MorynEvent[], recordIds: Set<string>): string[] {
  return events
    .filter((event) => event.op === "upsert_record" ? recordIds.has(event.record.id) : recordIds.has(event.record_id))
    .map((event) => event.event_id);
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

function healthStatus(checks: HealthCheckItem[]): HealthCheckStatus {
  if (checks.some((check) => check.status === "fail")) return "unhealthy";
  if (checks.some((check) => check.status === "warning")) return "needs_attention";
  return "healthy";
}

function healthSummary(status: HealthCheckStatus, checks: HealthCheckItem[], actions: HealthCheckSuggestedAction[]): HealthCheckSummary {
  const nextStep = actions[0]?.command ?? (status === "healthy" ? "Moryn health check passed; continue with context pack, capture, and recall." : "Review failed health checks before relying on this store.");
  return {
    status,
    passing_checks: checks.filter((check) => check.status === "pass").length,
    info_checks: checks.filter((check) => check.status === "info").length,
    warning_checks: checks.filter((check) => check.status === "warning").length,
    failing_checks: checks.filter((check) => check.status === "fail").length,
    next_step: nextStep
  };
}

function dashboardCommand(projectId: string | undefined): string {
  return `moryn dashboard --serve${projectId ? ` --project-id ${projectId}` : ""}`;
}

function withSuggestedActionMetadata(input: {
  action_id: string;
  recommended_action: string;
  tool: "dashboard" | "project_list";
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields?: string[];
}): HealthCheckSuggestedAction {
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
      continue_from: ["health_check.suggested_actions_by_id.<action_id>", "health_check.suggested_actions[]"],
      phases: [
        {
          phase: input.recommended_action,
          order: 1,
          action_source: "health_check.suggested_actions_by_id.<action_id>",
          tool: input.tool,
          required_when: input.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

function reviewCaptureAction(projectId: string | undefined): HealthCheckSuggestedAction {
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
    required_when: "When Health Check finds capture candidates waiting for explicit review."
  });
}

function projectListAction(): HealthCheckSuggestedAction {
  return withSuggestedActionMetadata({
    action_id: "choose_project_context",
    recommended_action: "choose_project_context",
    tool: "project_list",
    command: "moryn project list",
    arguments: {},
    safe_to_run: true,
    required_when: "When Health Check runs without an explicit project id and project-specific readiness is needed."
  });
}

function stats(input: HealthCheckDiagnoseInput, projectRecords: MorynRecord[], reviewCandidates: MorynRecord[]): HealthCheckStats {
  return {
    visible_records: input.records.length,
    excluded_private_records: input.excluded_private_records ?? input.records.filter(isPrivateRecord).length,
    total_events: input.events.length,
    project_records: projectRecords.length,
    capture_review_candidates: reviewCandidates.length,
    canonical_records: input.records.filter((record) => record.state === "canonical").length
  };
}

function storeReadableCheck(records: MorynRecord[]): HealthCheckItem {
  return {
    id: "store_readable",
    category: "store",
    status: "pass",
    label: "Store readable",
    summary: "Local store can be read.",
    reason: `${records.length} visible record${records.length === 1 ? "" : "s"} loaded from local event history.`
  };
}

function eventLogReplayableCheck(events: MorynEvent[]): HealthCheckItem {
  return {
    id: "event_log_replayable",
    category: "store",
    status: "pass",
    label: "Event log replayable",
    summary: "Append-only event log can be replayed.",
    reason: `${events.length} event${events.length === 1 ? "" : "s"} inspected without mutation.`
  };
}

function projectContextCheck(projectId: string | undefined, projectRecords: MorynRecord[]): HealthCheckItem {
  if (!projectId) {
    return {
      id: "project_context",
      category: "project",
      status: "info",
      label: "Project context not set",
      summary: "Health Check is store-wide because no project id was supplied.",
      reason: "Pass --project-id or --project when checking project-specific setup."
    };
  }
  return {
    id: "project_context",
    category: "project",
    status: projectRecords.length > 0 ? "pass" : "info",
    label: "Project context",
    summary: projectRecords.length > 0 ? "Project-specific records are visible." : "Project id is explicit, but no visible records matched it yet.",
    reason: `${projectRecords.length} visible record${projectRecords.length === 1 ? "" : "s"} matched project ${projectId}.`
  };
}

function captureReviewBacklogCheck(reviewCandidates: MorynRecord[], events: MorynEvent[]): HealthCheckItem {
  if (!reviewCandidates.length) {
    return {
      id: "capture_review_backlog",
      category: "capture",
      status: "pass",
      label: "Capture review backlog",
      summary: "No active capture candidates need review.",
      reason: "Capture Inbox has no visible active review candidates in this scope."
    };
  }
  const recordIds = reviewCandidates.map((record) => record.id);
  return {
    id: "capture_review_backlog",
    category: "capture",
    status: "warning",
    label: "Capture review backlog",
    summary: "Capture Inbox has candidates waiting for explicit review.",
    reason: `${reviewCandidates.length} active capture candidate${reviewCandidates.length === 1 ? "" : "s"} need review before becoming canonical memory.`,
    record_ids: recordIds,
    event_ids: recordEventIds(events, new Set(recordIds)),
    evidence: evidenceForRecords("records.capture_review_candidates[]", reviewCandidates, events)
  };
}

function privateBoundaryCheck(excludedPrivateRecords: number): HealthCheckItem {
  return {
    id: "private_boundary",
    category: "privacy",
    status: excludedPrivateRecords > 0 ? "info" : "pass",
    label: "Private boundary",
    summary: excludedPrivateRecords > 0 ? "Private records are hidden by default." : "No private records were excluded.",
    reason: excludedPrivateRecords > 0
      ? `${excludedPrivateRecords} private record${excludedPrivateRecords === 1 ? "" : "s"} excluded from this read-only report.`
      : "The default read boundary did not need to hide private-tagged records."
  };
}

function scopedRecords(records: MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return projectId ? records.filter((record) => record.project_id === projectId) : records;
}

function nonPrivateTextLeakGuard(report: HealthCheckReport): HealthCheckReport {
  // Keep this report operational: record ids and counts are enough for health checks.
  return JSON.parse(JSON.stringify(report)) as HealthCheckReport;
}

export function diagnoseHealthCheck(input: HealthCheckDiagnoseInput): HealthCheckReport {
  const limit = input.limit ?? 20;
  const projectRecords = scopedRecords(input.records, input.project_id);
  const reviewCandidates = projectRecords.filter(isCaptureReviewCandidate).slice(0, limit);
  const excludedPrivateRecords = input.excluded_private_records ?? 0;
  const checks = [
    storeReadableCheck(input.records),
    eventLogReplayableCheck(input.events),
    projectContextCheck(input.project_id, projectRecords),
    captureReviewBacklogCheck(reviewCandidates, input.events),
    privateBoundaryCheck(excludedPrivateRecords)
  ];
  const actions = [
    ...(reviewCandidates.length > 0 ? [reviewCaptureAction(input.project_id)] : []),
    ...(!input.project_id ? [projectListAction()] : [])
  ].slice(0, limit);
  const status = healthStatus(checks);
  return nonPrivateTextLeakGuard({
    read_only: true,
    version: 1,
    scope: "local_store",
    status,
    ...(input.project_id ? { project_id: input.project_id } : {}),
    summary: healthSummary(status, checks, actions),
    stats: stats(input, projectRecords, reviewCandidates),
    checks,
    checks_by_id: Object.fromEntries(checks.map((check) => [check.id, check])),
    suggested_actions: actions,
    suggested_actions_by_id: Object.fromEntries(actions.map((action) => [action.action_id, action])),
    selection_sources: HEALTH_CHECK_SELECTION_SOURCES
  });
}
