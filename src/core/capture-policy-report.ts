import { operationArgumentsByTool } from "../operation-contracts.js";
import { type ActionInterfaces, actionInterfaces } from "./action-interfaces.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import {
  type AutocapturePolicyDecision,
  type AutocapturePolicyRuleId,
  DEFAULT_AUTOCAPTURE_POLICY
} from "./autocapture-policy.js";
import { currentAutocaptureDecisionForRecord, currentPolicyTreatsAsLowRiskCapture } from "./capture-review.js";
import { displayRecordText } from "./content-text.js";
import { commandForTimelineContext } from "./errors.js";
import type { MorynEvent, MorynRecord, RecordState } from "./types.js";
import { type RequiredFieldMetadata, withPhasesByName, withRequiredFieldsByName } from "./workflow.js";

export interface CapturePolicyInput {
  project_id?: string;
  limit?: number;
  include_private?: boolean;
}

export interface CapturePolicyDiagnoseInput extends CapturePolicyInput {
  records: MorynRecord[];
  events: MorynEvent[];
  excluded_private_records?: number;
}

type CapturePolicyCategory = "auto_capture" | "review_queue" | "policy_archive";
type CapturePolicySeverity = "info" | "warning";
type CapturePolicyActionTool = "dashboard" | "timeline";

export interface CapturePolicyDecisionAudit {
  record_id: string;
  decision: AutocapturePolicyDecision;
  target_state: RecordState;
  review_required: boolean;
  auto_canonical: false;
  rule_ids: AutocapturePolicyRuleId[];
  reasons: string[];
  duplicate_of_record_id?: string;
  updated_at: string;
  state: RecordState;
  text: string;
  evidence: Array<{ source: string; record_id: string; event_id?: string }>;
}

export interface CapturePolicyFinding {
  id: string;
  category: CapturePolicyCategory;
  severity: CapturePolicySeverity;
  summary: string;
  reason: string;
  record_ids: string[];
}

export interface CapturePolicySuggestedAction {
  action_id: string;
  recommended_action: string;
  tool: CapturePolicyActionTool;
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
  workflow: ReturnType<
    typeof withPhasesByName<{
      version: 1;
      start: "suggested_action";
      continue_from: string[];
      phases: Array<{
        phase: string;
        order: number;
        action_source: string;
        tool: CapturePolicyActionTool;
        required_when: string;
        required_fields: string[];
      }>;
    }>
  >;
}

export interface CapturePolicyStats {
  total_autocapture_records: number;
  excluded_private_records: number;
  auto_captured_records: number;
  review_records: number;
  policy_archived_records: number;
  captured_by_rule: Partial<Record<AutocapturePolicyRuleId, number>>;
  archived_by_rule: Partial<Record<AutocapturePolicyRuleId, number>>;
}

export interface CapturePolicyResult {
  read_only: true;
  version: 1;
  scope: "local_store";
  project_id?: string;
  policy: typeof DEFAULT_AUTOCAPTURE_POLICY;
  stats: CapturePolicyStats;
  decisions: CapturePolicyDecisionAudit[];
  decisions_by_record_id: Record<string, CapturePolicyDecisionAudit>;
  findings: CapturePolicyFinding[];
  findings_by_id: Record<string, CapturePolicyFinding>;
  suggested_actions: CapturePolicySuggestedAction[];
  suggested_actions_by_id: Record<string, CapturePolicySuggestedAction>;
  records: MorynRecord[];
  records_by_id: Record<string, MorynRecord>;
  events: MorynEvent[];
  events_by_id: Record<string, MorynEvent>;
  selection_sources: typeof CAPTURE_POLICY_SELECTION_SOURCES;
}

export const CAPTURE_POLICY_SELECTION_SOURCES = {
  decision: "decisions_by_record_id.<record_id>",
  decision_record_id: "decisions_by_record_id.<record_id>.record_id",
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  event: "events_by_id.<event_id>",
  event_id: "events_by_id.<event_id>.event_id"
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutocaptureRecord(record: MorynRecord): boolean {
  return record.kind === "session_summary" && record.tags.some((tag) => tag.toLowerCase() === "autocapture");
}

function isRuleId(value: unknown): value is AutocapturePolicyRuleId {
  return DEFAULT_AUTOCAPTURE_POLICY.rules.some((rule) => rule.id === value);
}

function policyPayload(record: MorynRecord): Record<string, unknown> | undefined {
  const capture = record.content.capture;
  if (!isRecord(capture)) return undefined;
  const policy = capture.policy;
  return isRecord(policy) ? policy : undefined;
}

function captureRuleIds(record: MorynRecord): AutocapturePolicyRuleId[] {
  const payload = policyPayload(record);
  const payloadRuleIds = Array.isArray(payload?.rule_ids) ? payload.rule_ids.filter(isRuleId) : [];
  const tagRuleIds = record.tags.map((tag) => tag.match(/^(?:noise|capture):(.+)$/)?.[1]).filter(isRuleId);
  if (payloadRuleIds.length || tagRuleIds.length) return [...new Set([...payloadRuleIds, ...tagRuleIds])];
  if (record.tags.includes("policy-archived") || record.state === "archived") return ["smoke_test_marker"];
  if (record.tags.includes("auto-captured")) return ["low_risk_handoff_auto_capture"];
  return ["default_review_for_agent_handoff"];
}

function captureReasons(record: MorynRecord, ruleIds: AutocapturePolicyRuleId[]): string[] {
  const payload = policyPayload(record);
  const reasons = Array.isArray(payload?.reasons)
    ? payload.reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : [];
  return reasons.length ? reasons : ruleIds;
}

function captureDecision(record: MorynRecord): AutocapturePolicyDecision {
  const payloadDecision = policyPayload(record)?.decision;
  if (payloadDecision === "capture" || payloadDecision === "review" || payloadDecision === "archive")
    return payloadDecision;
  if (record.state === "archived" || record.tags.includes("policy-archived")) return "archive";
  if (record.tags.includes("auto-captured")) return "capture";
  return "review";
}

function duplicateOfRecordId(record: MorynRecord): string | undefined {
  const duplicate = policyPayload(record)?.duplicate_of_record_id;
  return typeof duplicate === "string" && duplicate.length > 0 ? duplicate : undefined;
}

function currentCaptureDecision(record: MorynRecord):
  | {
      decision: AutocapturePolicyDecision;
      rule_ids: AutocapturePolicyRuleId[];
      reasons: string[];
      duplicate_of_record_id?: string;
    }
  | undefined {
  const storedDecision = captureDecision(record);
  const current = currentAutocaptureDecisionForRecord(record);
  if (
    storedDecision !== "review" ||
    record.state !== "candidate" ||
    record.visibility !== "active" ||
    current?.decision !== "capture" ||
    !currentPolicyTreatsAsLowRiskCapture(record)
  ) {
    return undefined;
  }
  return {
    decision: current.decision,
    rule_ids: current.rule_ids,
    reasons: current.reasons,
    ...(current.duplicate_of_record_id ? { duplicate_of_record_id: current.duplicate_of_record_id } : {})
  };
}

function eventForRecord(events: MorynEvent[], recordId: string): MorynEvent | undefined {
  return events.find((event) => event.op === "upsert_record" && event.record.id === recordId);
}

function evidenceForRecord(record: MorynRecord, events: MorynEvent[]): CapturePolicyDecisionAudit["evidence"] {
  const event = eventForRecord(events, record.id);
  const base = { record_id: record.id, ...(event ? { event_id: event.event_id } : {}) };
  return [
    { source: "record.content.capture.policy", ...base },
    { source: "record.tags[]", ...base },
    { source: "record.state", ...base }
  ];
}

function decisionAudit(record: MorynRecord, events: MorynEvent[]): CapturePolicyDecisionAudit {
  const currentDecision = currentCaptureDecision(record);
  const decision = currentDecision?.decision ?? captureDecision(record);
  const ruleIds = currentDecision?.rule_ids ?? captureRuleIds(record);
  const reviewRequired = decision === "review" && record.state === "candidate" && record.visibility === "active";
  const duplicateRecordId = currentDecision?.duplicate_of_record_id ?? duplicateOfRecordId(record);
  return {
    record_id: record.id,
    decision,
    target_state: decision === "archive" ? "archived" : "candidate",
    review_required: reviewRequired,
    auto_canonical: false,
    rule_ids: ruleIds,
    reasons: currentDecision?.reasons ?? captureReasons(record, ruleIds),
    ...(duplicateRecordId ? { duplicate_of_record_id: duplicateRecordId } : {}),
    updated_at: record.updated_at,
    state: record.state,
    text: displayRecordText(record),
    evidence: evidenceForRecord(record, events)
  };
}

function stableRecordSort(left: MorynRecord, right: MorynRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function stableDecisionSort(left: CapturePolicyDecisionAudit, right: CapturePolicyDecisionAudit): number {
  const priority = { review: 3, capture: 2, archive: 1 } satisfies Record<AutocapturePolicyDecision, number>;
  return (
    priority[right.decision] - priority[left.decision] ||
    right.updated_at.localeCompare(left.updated_at) ||
    left.record_id.localeCompare(right.record_id)
  );
}

function recordsById(records: MorynRecord[]): Record<string, MorynRecord> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

function eventsById(events: MorynEvent[]): Record<string, MorynEvent> {
  return Object.fromEntries(events.map((event) => [event.event_id, event]));
}

function stats(decisions: CapturePolicyDecisionAudit[], excludedPrivateRecords: number): CapturePolicyStats {
  const capturedByRule: Partial<Record<AutocapturePolicyRuleId, number>> = {};
  const archivedByRule: Partial<Record<AutocapturePolicyRuleId, number>> = {};
  for (const decision of decisions.filter((item) => item.decision === "capture")) {
    for (const ruleId of decision.rule_ids) {
      capturedByRule[ruleId] = (capturedByRule[ruleId] ?? 0) + 1;
    }
  }
  for (const decision of decisions.filter((item) => item.decision === "archive")) {
    for (const ruleId of decision.rule_ids) {
      archivedByRule[ruleId] = (archivedByRule[ruleId] ?? 0) + 1;
    }
  }
  return {
    total_autocapture_records: decisions.length,
    excluded_private_records: excludedPrivateRecords,
    auto_captured_records: decisions.filter((decision) => decision.decision === "capture").length,
    review_records: decisions.filter(isActionableReviewDecision).length,
    policy_archived_records: decisions.filter((decision) => decision.decision === "archive").length,
    captured_by_rule: capturedByRule,
    archived_by_rule: archivedByRule
  };
}

function isActionableReviewDecision(decision: CapturePolicyDecisionAudit): boolean {
  return decision.decision === "review" && decision.review_required && decision.state === "candidate";
}

function captureFinding(decisions: CapturePolicyDecisionAudit[]): CapturePolicyFinding | undefined {
  const recordIds = decisions
    .filter((decision) => decision.decision === "capture")
    .map((decision) => decision.record_id);
  if (!recordIds.length) return undefined;
  return {
    id: "auto_captured",
    category: "auto_capture",
    severity: "info",
    summary: "Autocapture policy retained low-risk handoffs without review.",
    reason: `${recordIds.length} autocapture record${recordIds.length === 1 ? "" : "s"} were retained for context packs without canonical promotion.`,
    record_ids: recordIds
  };
}

function reviewFinding(decisions: CapturePolicyDecisionAudit[]): CapturePolicyFinding | undefined {
  const recordIds = decisions.filter(isActionableReviewDecision).map((decision) => decision.record_id);
  if (!recordIds.length) return undefined;
  return {
    id: "review_required",
    category: "review_queue",
    severity: recordIds.length > 5 ? "warning" : "info",
    summary: "Autocapture policy routed risk-marked handoffs to manual review.",
    reason: `${recordIds.length} autocapture record${recordIds.length === 1 ? "" : "s"} require user review before canonical memory.`,
    record_ids: recordIds
  };
}

function archiveFinding(decisions: CapturePolicyDecisionAudit[]): CapturePolicyFinding | undefined {
  const recordIds = decisions
    .filter((decision) => decision.decision === "archive")
    .map((decision) => decision.record_id);
  if (!recordIds.length) return undefined;
  return {
    id: "policy_archived",
    category: "policy_archive",
    severity: "info",
    summary: "Autocapture policy archived noise before it entered the review inbox.",
    reason: `${recordIds.length} autocapture record${recordIds.length === 1 ? " was" : "s were"} archived by policy rules.`,
    record_ids: recordIds
  };
}

function withSuggestedActionMetadata(input: {
  action_id: string;
  recommended_action: string;
  tool: CapturePolicyActionTool;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields?: string[];
}): CapturePolicySuggestedAction {
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
      continue_from: ["capture_policy.suggested_actions_by_id.<action_id>", "capture_policy.suggested_actions[]"],
      phases: [
        {
          phase: input.recommended_action,
          order: 1,
          action_source: "capture_policy.suggested_actions_by_id.<action_id>",
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

function reviewCaptureAction(projectId: string | undefined): CapturePolicySuggestedAction {
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
    required_when: "When Capture Policy Audit finds autocaptured handoffs waiting for manual review."
  });
}

function inspectDecisionAction(
  decision: AutocapturePolicyDecision,
  recordId: string,
  projectId: string | undefined
): CapturePolicySuggestedAction {
  const args = {
    record_id: recordId,
    ...(projectId ? { project_id: projectId } : {}),
    before: 3,
    after: 3
  };
  const autoCaptured = decision === "capture";
  return withSuggestedActionMetadata({
    action_id: `inspect:${recordId}`,
    recommended_action: autoCaptured ? "inspect_auto_captured_handoff" : "inspect_policy_archived_record",
    tool: "timeline",
    command: commandForTimelineContext(args),
    arguments: args,
    safe_to_run: true,
    required_when: autoCaptured
      ? "When inspecting a low-risk handoff retained automatically outside Capture Inbox."
      : "When reviewing why an autocapture was archived by policy instead of shown in Capture Inbox."
  });
}

function uniqueActions(actions: CapturePolicySuggestedAction[], limit: number): CapturePolicySuggestedAction[] {
  const byId = new Map<string, CapturePolicySuggestedAction>();
  for (const action of actions) {
    if (!byId.has(action.action_id)) byId.set(action.action_id, action);
  }
  return [...byId.values()].slice(0, limit);
}

export function diagnoseCapturePolicy(input: CapturePolicyDiagnoseInput): CapturePolicyResult {
  const limit = input.limit ?? 20;
  const records = [...input.records].filter(isAutocaptureRecord).sort(stableRecordSort);
  const decisions = records.map((record) => decisionAudit(record, input.events)).sort(stableDecisionSort);
  const findings = [captureFinding(decisions), reviewFinding(decisions), archiveFinding(decisions)].filter(
    (finding): finding is CapturePolicyFinding => finding !== undefined
  );
  const sourceRecordsById = recordsById(records);
  const actions = uniqueActions(
    [
      ...(decisions.some(isActionableReviewDecision) ? [reviewCaptureAction(input.project_id)] : []),
      ...decisions
        .filter((decision) => decision.decision === "capture" || decision.decision === "archive")
        .map((decision) =>
          inspectDecisionAction(
            decision.decision,
            decision.record_id,
            input.project_id ?? sourceRecordsById[decision.record_id]?.project_id
          )
        )
    ],
    limit
  );
  const referencedRecordIds = new Set([
    ...findings.flatMap((finding) => finding.record_ids),
    ...actions.flatMap((action) => {
      const recordId = action.arguments.record_id;
      return typeof recordId === "string" ? [recordId] : [];
    })
  ]);
  const referencedEventIds = new Set(
    decisions
      .filter((decision) => referencedRecordIds.has(decision.record_id))
      .flatMap((decision) =>
        decision.evidence
          .map((evidence) => evidence.event_id)
          .filter((eventId): eventId is string => typeof eventId === "string")
      )
  );
  const recordSelection = records.filter((record) => referencedRecordIds.has(record.id)).slice(0, limit);
  const eventSelection = input.events.filter((event) => referencedEventIds.has(event.event_id)).slice(0, limit);
  return {
    read_only: true,
    version: 1,
    scope: "local_store",
    ...(input.project_id ? { project_id: input.project_id } : {}),
    policy: DEFAULT_AUTOCAPTURE_POLICY,
    stats: stats(decisions, input.excluded_private_records ?? 0),
    decisions,
    decisions_by_record_id: Object.fromEntries(decisions.map((decision) => [decision.record_id, decision])),
    findings,
    findings_by_id: Object.fromEntries(findings.map((finding) => [finding.id, finding])),
    suggested_actions: actions,
    suggested_actions_by_id: Object.fromEntries(actions.map((action) => [action.action_id, action])),
    records: recordSelection,
    records_by_id: recordsById(recordSelection),
    events: eventSelection,
    events_by_id: eventsById(eventSelection),
    selection_sources: CAPTURE_POLICY_SELECTION_SOURCES
  };
}
