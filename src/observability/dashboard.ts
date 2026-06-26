import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { normalizeAgentIdentity } from "../core/agent-identity.js";
import { DEFAULT_AUTOCAPTURE_POLICY, type AutocapturePolicyDecision, type AutocapturePolicyRuleId } from "../core/autocapture-policy.js";
import { diagnoseCapturePolicy, type CapturePolicyResult } from "../core/capture-policy-report.js";
import { currentAutocaptureDecisionForRecord, currentPolicyTreatsAsLowRiskCapture, isCaptureReviewCandidate } from "../core/capture-review.js";
import { displayRecordText } from "../core/content-text.js";
import { diagnoseDogfood, type DogfoodReportResult } from "../core/dogfood-report.js";
import { createEngine } from "../core/engine.js";
import { commandForPromoteContext } from "../core/errors.js";
import { diagnoseHealthCheck, type HealthCheckReport } from "../core/health-check.js";
import { diagnoseMemoryLifecycle, type MemoryLifecycleResult } from "../core/memory-lifecycle.js";
import { diagnoseMemory, type MemoryDoctorResult } from "../core/memory-doctor.js";
import type { RecallEvalReport } from "../core/recall-eval.js";
import { replayEvents } from "../core/replay.js";
import { readEvents } from "../core/store.js";
import type { MorynEvent, MorynRecord, RecordKind, RecordSource } from "../core/types.js";
import { getGitSyncStatus, type GitSyncStatus } from "../sync/git.js";
import { approveMaintenancePlan, buildDashboardMaintenance, type DashboardMaintenanceData, type DashboardMaintenancePlan } from "./dashboard-maintenance.js";

const exec = promisify(execFile);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RECENT_VALUE_LIMIT = 8;
const RECENT_VALUE_VISIBLE_LIMIT = 4;
const DASHBOARD_TEXT_EXCERPT_LIMIT = 240;
const MAINTENANCE_RAW_SAMPLE_LIMIT = 3;
const CAPTURE_NOISE_RULES: DashboardCaptureNoiseRule[] = [
  {
    id: "smoke_test_marker",
    label: "Smoke/test marker",
    suggested_action: "archive",
    description: "Matches smoke, test, fixture, e2e, or marker language in tags, type, or text."
  },
  {
    id: "duplicate_text",
    label: "Duplicate capture text",
    suggested_action: "archive",
    description: "Matches repeated normalized capture text in the current dashboard batch."
  }
];
const CAPTURE_INBOX_POLICY: DashboardCaptureInboxPolicy = {
  id: "default_capture_review_policy",
  version: 1,
  mode: "manual_review",
  auto_canonical: false,
  trust_policy: "disabled_by_default",
  canonical_requires_user_action: true,
  grouping: {
    enabled: true,
    group_by: ["project_or_scope", "source_client", "source_session", "capture_day"],
    stale_batch_protection: true
  },
  noise_rules: CAPTURE_NOISE_RULES,
  explanation: "Capture Inbox groups reduce review clicks, but candidates become canonical only after explicit user approval."
};

export type DashboardActionSurface = "capture_inbox" | "capture_policy" | "maintenance_review" | "candidate_triage";
export type DashboardActionKind = "dashboard_api" | "cli_command";
export type DashboardActionIntent = "approve" | "reject" | "inspect";
export type DashboardActionTargetType = "record" | "record_group" | "maintenance_plan" | "policy_decision";
export type DashboardActionWriteBehavior = "none" | "append_only_events";
export type DashboardActionStaleGuard = "active_candidate_record" | "active_candidate_group" | "plan_hash";

export interface DashboardAction {
  action_id: string;
  surface: DashboardActionSurface;
  kind: DashboardActionKind;
  label: string;
  intent: DashboardActionIntent;
  target: {
    type: DashboardActionTargetType;
    id: string;
    record_ids?: string[];
    plan_hash?: string;
  };
  method?: "POST";
  endpoint?: string;
  command?: string;
  request_body?: Record<string, unknown>;
  safety: {
    safe_to_auto_run: boolean;
    requires_user_confirmation: boolean;
    writes: DashboardActionWriteBehavior;
    stale_guard?: DashboardActionStaleGuard;
  };
  source_path: string;
}

export const DASHBOARD_SELECTION_SOURCES = {
  store: "store",
  sync: "sync",
  health: "health",
  attention_item: "attention_items[]",
  dashboard_overview: "dashboard_overview",
  decision_summary: "decision_summary",
  charts: "charts",
  totals: "totals",
  action: "actions_by_id.<action_id>",
  action_id: "actions_by_id.<action_id>.action_id",
  capture_inbox: "capture_inbox",
  capture_policy: "capture_policy",
  memory_doctor: "memory_doctor",
  candidate_triage: "candidate_triage",
  health_check: "health_check",
  context_pack_review: "context_pack_review",
  governance: "governance",
  recall_eval: "recall_eval",
  memory_lifecycle: "memory_lifecycle",
  dogfood_report: "dogfood_report",
  recent_value: "recent_value[]",
  record: "recent_records[]",
  event: "recent_events[]",
  agent_activity: "agent_activity[]",
  artifact: "artifact"
} as const;

export const CONTEXT_PACK_REVIEW_SELECTION_SOURCES = {
  context_pack_review: "context_pack_review",
  handoff_pack: "context_pack_review.handoff_pack",
  current_goal: "context_pack_review.handoff_pack.current_goal",
  recent_decision: "context_pack_review.handoff_pack.recent_decisions[]",
  open_thread: "context_pack_review.handoff_pack.open_threads[]",
  risk: "context_pack_review.handoff_pack.risks[]",
  next_action: "context_pack_review.handoff_pack.next_actions[]",
  quality_gate: "context_pack_review.handoff_pack.quality_gate",
  check: "context_pack_review.handoff_pack.quality_gate.checks_by_id.<check_id>",
  evidence: "context_pack_review.handoff_pack.evidence"
} as const;

export interface DashboardOptions {
  limit?: number;
  include_private?: boolean;
  project_id?: string;
  readiness_host?: string;
  sync_remote?: string;
  now?: string;
}

export interface DashboardRecordSummary {
  id: string;
  kind: MorynRecord["kind"];
  type: string;
  scope: MorynRecord["scope"];
  project_id?: string;
  state: MorynRecord["state"];
  priority: MorynRecord["priority"];
  source: RecordSource;
  created_at: string;
  updated_at: string;
  text: string;
  citation: DashboardRecordCitation;
}

export interface DashboardEventSummary {
  event_id: string;
  op: MorynEvent["op"];
  record_id?: string;
  source: RecordSource;
  created_at: string;
  citation: DashboardEventCitation;
}

export interface DashboardAgentActivity {
  client: string;
  raw_clients: string[];
  events: number;
  records: number;
  latest_at: string;
  citation?: DashboardAgentCitation;
}

export interface DashboardRecordCitation {
  record_id: string;
  event_id?: string;
  timeline_command: string;
  recall_command: string;
}

export interface DashboardEventCitation {
  event_id: string;
  record_id?: string;
  timeline_command: string;
  recall_command?: string;
}

export interface DashboardAgentCitation {
  event_id: string;
  record_id?: string;
  timeline_command: string;
}

export type DashboardHealthStatus = "healthy" | "needs_review" | "sync_pending" | "conflict" | "local_only";
export type DashboardAttentionSeverity = "info" | "warning" | "critical";

export interface DashboardHealth {
  status: DashboardHealthStatus;
  label: string;
  explanation: string;
  generated_at: string;
}

export interface DashboardAttentionItem {
  severity: DashboardAttentionSeverity;
  title: string;
  description: string;
  action_label?: string;
  action_command?: string;
}

export type DashboardActionBoardItemId = "confirm" | "review" | "inspect" | "sync";
export type DashboardActionBoardSeverity = "good" | "info" | "warning" | "critical";

export interface DashboardActionBoardItem {
  id: DashboardActionBoardItemId;
  label: string;
  value: number;
  severity: DashboardActionBoardSeverity;
  summary: string;
  hint: string;
  detail: string;
  next_action_label: string;
  target: string;
}

export interface DashboardActionBoard {
  items: DashboardActionBoardItem[];
  items_by_id: Record<DashboardActionBoardItemId, DashboardActionBoardItem>;
}

export type DashboardDecisionSummarySurface = "capture_inbox" | "maintenance_review" | "candidate_triage";

export interface DashboardDecisionSummaryItem {
  id: string;
  surface: DashboardDecisionSummarySurface;
  title: string;
  summary: string;
  decision_label: string;
  target: "capture-inbox" | "maintenance-review-queue" | "candidate-triage";
  target_label: "Open Capture Inbox" | "Open Review Queue" | "Open Candidate Triage";
  primary_action_id?: string;
  secondary_action_id?: string;
  requires_user_confirmation: true;
  writes: "append_only_events";
  safety_note: string;
  evidence_path: "capture_inbox.groups[]" | "maintenance.plans[]" | `candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.${string}`;
}

export interface DashboardDecisionSummary {
  read_only: true;
  total_decisions: number;
  summary: {
    capture_inbox_groups: number;
    review_queue_plans: number;
    candidate_triage_promotions: number;
  };
  items: DashboardDecisionSummaryItem[];
  items_by_id: Record<string, DashboardDecisionSummaryItem>;
}

export type DashboardOverviewStatus = "good" | "info" | "warning" | "critical";
export type DashboardOverviewCardId = "health" | "action" | "context" | "sync";

export interface DashboardOverviewCard {
  id: DashboardOverviewCardId;
  label: string;
  value: string;
  summary: string;
  severity: DashboardOverviewStatus;
  target: string;
  target_label: string;
  source: string;
}

export interface DashboardOverview {
  status: DashboardOverviewStatus;
  headline: string;
  detail: string;
  primary_action: {
    label: string;
    target: string;
    source: string;
  };
  safety: {
    read_only: true;
    mutation_surfaces: ["Capture Inbox", "Review Queue", "Candidate Triage"];
  };
  cards: DashboardOverviewCard[];
  cards_by_id: Record<DashboardOverviewCardId, DashboardOverviewCard>;
  evidence_sources: {
    action_board: "action_board";
    health_check: "health_check";
    context_pack_review: "context_pack_review";
    governance: "governance";
  };
}

export interface DashboardAgentChartItem extends DashboardAgentActivity {
  weight: number;
  relative_time: string;
}

export interface DashboardMemoryStateChartItem {
  state: MorynRecord["state"];
  count: number;
  percent: number;
}

export interface DashboardRecordTypeChartItem {
  kind: RecordKind;
  label: string;
  count: number;
  percent: number;
}

export interface DashboardSyncPositionChart {
  configured: boolean;
  state: NonNullable<GitSyncStatus["sync_state"]> | "configured" | "not_configured";
  ahead: number;
  behind: number;
  dirty: boolean;
  conflict: boolean;
}

export interface DashboardCharts {
  agent_activity: DashboardAgentChartItem[];
  memory_states: DashboardMemoryStateChartItem[];
  record_types: DashboardRecordTypeChartItem[];
  sync_position: DashboardSyncPositionChart;
}

export const DASHBOARD_GOVERNANCE_SELECTION_SOURCES = {
  governance: "governance",
  item: "governance.items_by_id.<item_id>",
  item_id: "governance.items_by_id.<item_id>.id",
  action: "actions_by_id.<action_id>",
  action_id: "actions_by_id.<action_id>.action_id",
  capture_policy: "capture_policy",
  memory_doctor: "memory_doctor",
  memory_lifecycle: "memory_lifecycle",
  maintenance: "maintenance",
  recall_eval: "recall_eval",
  dogfood_report: "dogfood_report"
} as const;

export const DASHBOARD_RECALL_EVAL_SELECTION_SOURCES = {
  recall_eval: "recall_eval",
  case_source: "recall_eval.case_sources[]",
  report: "recall_eval.report",
  case: "recall_eval.report.cases_by_id.<case_id>",
  suggested_action: "recall_eval.report.suggested_actions_by_id.<action_id>"
} as const;

export const DASHBOARD_CANDIDATE_TRIAGE_SELECTION_SOURCES = {
  candidate_triage: "candidate_triage",
  group: "candidate_triage.groups_by_id.<group_id>",
  group_id: "candidate_triage.groups_by_id.<group_id>.id",
  record: "candidate_triage.groups_by_id.<group_id>.records[]",
  record_id: "candidate_triage.groups_by_id.<group_id>.records_by_id.<record_id>.id"
} as const;

const CANDIDATE_TRIAGE_SAMPLE_LIMIT = 3;
const CANDIDATE_TRIAGE_PROMOTION_REASON = "User approved Candidate Triage promotion draft.";
const DEBUG_INSPECTOR_ROW_LIMIT = 10;

export type DashboardGovernanceSource = "capture_policy" | "memory_doctor" | "memory_lifecycle" | "maintenance" | "recall_eval" | "dogfood_report";
export type DashboardGovernanceCategory =
  | "capture_review"
  | "auto_capture"
  | "policy_archive"
  | "candidate_backlog"
  | "memory_lifecycle"
  | "project_identity"
  | "recall_quality"
  | "dogfood_friction";
export type DashboardGovernanceSeverity = "info" | "warning" | "critical";

export interface DashboardGovernanceItem {
  id: string;
  source: DashboardGovernanceSource;
  category: DashboardGovernanceCategory;
  severity: DashboardGovernanceSeverity;
  title: string;
  summary: string;
  record_ids: string[];
  evidence_path: string;
  action_label: string;
  action_id?: string;
  review_log: string[];
  safe_to_run: boolean;
  requires_user_confirmation: boolean;
  writes: DashboardActionWriteBehavior;
}

export interface DashboardGovernance {
  read_only: true;
  version: 1;
  scope: "local_dashboard";
  summary: {
    total_items: number;
    needs_user_action: number;
    safe_inspections: number;
    hidden_private_records: number;
  };
  sources: Record<DashboardGovernanceSource, boolean>;
  items: DashboardGovernanceItem[];
  items_by_id: Record<string, DashboardGovernanceItem>;
  selection_sources: typeof DASHBOARD_GOVERNANCE_SELECTION_SOURCES;
}

export type DashboardCandidateTriageGroupId = "likely_noise" | "promotable" | "session_summaries" | "needs_inspection";

export interface DashboardCandidateTriageReviewHandoff {
  label: string;
  existing_control: string;
  guidance: string;
  write_boundary: "Review first; approve only through draft rows";
}

export interface DashboardCandidateTriageRecord {
  id: string;
  kind: MorynRecord["kind"];
  type: string;
  text: string;
  source_label: string;
  source_detail: string;
  relative_time: string;
  exact_time: string;
  priority: MorynRecord["priority"];
  confidence: number;
  reason: string;
  citation: DashboardRecordCitation;
}

export interface DashboardCandidateTriageRecordIndex {
  id: string;
  record_index: number;
  evidence_path: string;
}

export interface DashboardCandidateTriagePromotionDraft {
  record_id: string;
  target_state: "canonical";
  reason: string;
  command: string;
  requires_user_confirmation: true;
  writes: "append_only_events";
  source_path: `candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.${string}`;
  approve_endpoint: string;
  action_id: string;
}

export interface DashboardCandidateTriageGroupSummary {
  id: DashboardCandidateTriageGroupId;
  label: string;
  recommended_next_step: string;
  writes: "none";
  requires_user_confirmation: false;
  record_ids: string[];
  evidence_path: string;
}

export interface DashboardCandidateTriageGroup {
  id: DashboardCandidateTriageGroupId;
  label: string;
  description: string;
  recommended_next_step: string;
  review_handoff: DashboardCandidateTriageReviewHandoff;
  writes: "none";
  requires_user_confirmation: false;
  record_ids: string[];
  records: DashboardCandidateTriageRecord[];
  records_by_id: Record<string, DashboardCandidateTriageRecordIndex>;
  promotion_drafts_by_id: Record<string, DashboardCandidateTriagePromotionDraft>;
  evidence_path: string;
}

export interface DashboardCandidateTriage {
  read_only: true;
  version: 1;
  available: boolean;
  generated_from: {
    store: "local_event_history";
    writes: "none";
    sync_pull: false;
  };
  summary: {
    total_candidates: number;
    groups: number;
    likely_noise: number;
    promotable: number;
    session_summaries: number;
    needs_inspection: number;
    shown_records: number;
  };
  groups: DashboardCandidateTriageGroupSummary[];
  groups_by_id: Partial<Record<DashboardCandidateTriageGroupId, DashboardCandidateTriageGroup>>;
  selection_sources: typeof DASHBOARD_CANDIDATE_TRIAGE_SELECTION_SOURCES;
}

export interface DashboardValueRecord {
  id: string;
  title: string;
  summary: string;
  source_label: string;
  source_detail: string;
  relative_time: string;
  exact_time: string;
  state: MorynRecord["state"];
  kind: MorynRecord["kind"];
  type: string;
  scope: MorynRecord["scope"];
  project_id?: string;
  citation: DashboardRecordCitation;
}

export interface DashboardCaptureInboxItem {
  id: string;
  group_id: string;
  kind: MorynRecord["kind"];
  type: string;
  project_id?: string;
  text: string;
  source_label: string;
  source_detail: string;
  relative_time: string;
  exact_time: string;
  confidence: number;
  priority: MorynRecord["priority"];
  provenance_method?: NonNullable<MorynRecord["provenance"]>["method"];
  provenance_reason?: string;
  approve_endpoint: string;
  reject_endpoint: string;
  noise: DashboardCaptureNoise;
  citation: DashboardRecordCitation;
}

export interface DashboardCaptureNoise {
  level: "normal" | "likely_noise";
  reasons: string[];
  rule_ids: string[];
  suggested_action: "review" | "archive";
}

export interface DashboardCaptureInboxGroup {
  id: string;
  total: number;
  record_ids: string[];
  source_label: string;
  source_detail: string;
  project_id?: string;
  latest_at: string;
  relative_time: string;
  summary: string;
  noise: DashboardCaptureNoise;
  approve_endpoint: string;
  reject_endpoint: string;
}

export interface DashboardCaptureInboxPolicy {
  id: "default_capture_review_policy";
  version: 1;
  mode: "manual_review";
  auto_canonical: false;
  trust_policy: "disabled_by_default";
  canonical_requires_user_action: true;
  grouping: {
    enabled: true;
    group_by: ["project_or_scope", "source_client", "source_session", "capture_day"];
    stale_batch_protection: true;
  };
  noise_rules: DashboardCaptureNoiseRule[];
  explanation: string;
}

export interface DashboardCaptureNoiseRule {
  id: "smoke_test_marker" | "duplicate_text";
  label: string;
  suggested_action: "archive";
  description: string;
}

export interface DashboardCaptureInbox {
  total: number;
  group_total: number;
  policy: DashboardCaptureInboxPolicy;
  autocapture_policy: DashboardAutocapturePolicySummary;
  groups: DashboardCaptureInboxGroup[];
  items: DashboardCaptureInboxItem[];
}

export interface DashboardAutocapturePolicySummary {
  id: typeof DEFAULT_AUTOCAPTURE_POLICY.id;
  version: typeof DEFAULT_AUTOCAPTURE_POLICY.version;
  mode: typeof DEFAULT_AUTOCAPTURE_POLICY.mode;
  auto_canonical: false;
  canonical_requires_user_action: true;
  capture_low_risk_without_review: true;
  archive_noise_without_review: true;
  auto_captured_total: number;
  captured_by_rule: Partial<Record<AutocapturePolicyRuleId, number>>;
  auto_captured_examples: Array<{
    id: string;
    text: string;
    rule_ids: AutocapturePolicyRuleId[];
    reason?: string;
  }>;
  archived_total: number;
  archived_by_rule: Partial<Record<AutocapturePolicyRuleId, number>>;
  archived_examples: Array<{
    id: string;
    text: string;
    rule_ids: AutocapturePolicyRuleId[];
    reason?: string;
  }>;
}

export type DashboardContextPackReviewCheckId =
  | "current_goal"
  | "recent_decisions"
  | "open_threads"
  | "risks"
  | "evidence_paths"
  | "capture_next_action";

export interface DashboardContextPackReviewItem {
  text: string;
  evidence: {
    source: string;
    record_id?: string;
  };
}

export interface DashboardContextPackReviewNextAction {
  id: "capture_session";
  command: string;
  required_when: string;
  evidence: {
    source: "next.actions_by_id.capture_session";
    command: string;
  };
}

export interface DashboardContextPackReviewCheck {
  id: DashboardContextPackReviewCheckId;
  label: string;
  status: "pass" | "warn";
  source: string;
  count?: number;
  message: string;
}

export interface DashboardContextPackReviewQualityGate {
  status: "ready" | "needs_review";
  read_only: true;
  checks: DashboardContextPackReviewCheck[];
  checks_by_id: Record<DashboardContextPackReviewCheckId, DashboardContextPackReviewCheck>;
  failed_check_ids: DashboardContextPackReviewCheckId[];
  warnings: string[];
}

export interface DashboardContextPackReview {
  available: boolean;
  project_id?: string;
  unavailable_reason?: string;
  generated_from: {
    store: "local_event_history";
    writes: "none";
    sync_pull: false;
  };
  handoff_pack?: {
    version: 2;
    purpose: "agent_handoff";
    current_goal?: {
      text: string;
      source: "dashboard.project_id";
    };
    recent_decisions: DashboardContextPackReviewItem[];
    open_threads: DashboardContextPackReviewItem[];
    risks: DashboardContextPackReviewItem[];
    next_actions: DashboardContextPackReviewNextAction[];
    evidence: {
      records: "recent_records";
      events: "recent_events";
      next: "context_pack_review.handoff_pack.next_actions[]";
    };
    quality_gate: DashboardContextPackReviewQualityGate;
  };
  selection_sources: typeof CONTEXT_PACK_REVIEW_SELECTION_SOURCES;
}

export interface DashboardRecallEvalCaseSource {
  record_id: string;
  case_count: number;
  evidence_path: string;
}

export interface DashboardRecallEvalError {
  reason: string;
}

export interface DashboardRecallEval {
  available: boolean;
  project_id?: string;
  unavailable_reason?: string;
  generated_from: {
    store: "local_event_history";
    writes: "none";
    sync_pull: false;
  };
  case_sources: DashboardRecallEvalCaseSource[];
  report: RecallEvalReport | null;
  errors: DashboardRecallEvalError[];
  selection_sources: typeof DASHBOARD_RECALL_EVAL_SELECTION_SOURCES;
}

export interface DashboardData {
  generated_at: string;
  store: {
    path: string;
  };
  sync: GitSyncStatus;
  health: DashboardHealth;
  attention_items: DashboardAttentionItem[];
  dashboard_overview: DashboardOverview;
  action_board: DashboardActionBoard;
  decision_summary: DashboardDecisionSummary;
  charts: DashboardCharts;
  totals: {
    events: number;
    records: number;
    active_records: number;
    quarantined_records: number;
  };
  actions: DashboardAction[];
  actions_by_id: Record<string, DashboardAction>;
  context_pack_review: DashboardContextPackReview;
  governance: DashboardGovernance;
  recall_eval: DashboardRecallEval;
  capture_inbox: DashboardCaptureInbox;
  capture_policy: CapturePolicyResult;
  memory_doctor: MemoryDoctorResult;
  candidate_triage: DashboardCandidateTriage;
  health_check: HealthCheckReport;
  memory_lifecycle: MemoryLifecycleResult;
  dogfood_report: DogfoodReportResult;
  recent_value: DashboardValueRecord[];
  recent_records: DashboardRecordSummary[];
  recent_events: DashboardEventSummary[];
  agent_activity: DashboardAgentActivity[];
  maintenance: DashboardMaintenanceData;
  selection_sources: typeof DASHBOARD_SELECTION_SOURCES;
}

export interface DashboardSnapshot {
  generated: true;
  opened: boolean;
  path: string;
  url: string;
}

export interface DashboardOpenOptions {
  command?: string;
}

export interface DashboardServerOptions extends DashboardOptions {
  host?: string;
  port?: number;
  refreshIntervalMs?: number;
}

export interface DashboardServerHandle {
  serving: true;
  host: string;
  port: number;
  url: string;
  refresh_interval_ms: number;
  close: () => Promise<void>;
}

function dashboardLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error("Invalid argument: Invalid dashboard limit; must be an integer between 1 and 100");
  }
  return limit;
}

function recordText(record: MorynRecord): string {
  return record.state === "quarantined" || record.visibility === "quarantined"
    ? "[quarantined]"
    : displayRecordText(record);
}

const PRIVATE_RECORD_TAGS = new Set(["private", "secret", "sensitive"]);

function isPrivateRecord(record: MorynRecord): boolean {
  return record.tags.some((tag) => PRIVATE_RECORD_TAGS.has(tag.toLowerCase()));
}

function isVisibleForDashboard(record: MorynRecord, includePrivate: boolean | undefined): boolean {
  return includePrivate === true || !isPrivateRecord(record);
}

function recordProjectMatchesDashboard(record: MorynRecord, projectId: string | undefined): boolean {
  return !projectId || record.project_id === projectId || record.scope === "global";
}

function recordProjectMatchesDogfood(record: MorynRecord, projectId: string | undefined): boolean {
  return !projectId || record.project_id === projectId;
}

function isRecallEvalCaseRecord(record: MorynRecord): boolean {
  return record.type === "recall_eval_case";
}

function recallEvalRecordCases(record: MorynRecord): unknown[] {
  const cases = record.content.cases;
  return Array.isArray(cases) ? cases : [];
}

function targetRecordId(event: MorynEvent): string | undefined {
  return event.op === "upsert_record" ? event.record.id : event.record_id;
}

function appendProjectId(parts: string[], projectId: string | undefined): void {
  if (projectId) parts.push("--project-id", projectId);
}

function recallCommand(recordId: string, projectId: string | undefined): string {
  const parts = ["moryn", "recall", "--record-id", recordId];
  appendProjectId(parts, projectId);
  return parts.join(" ");
}

function timelineRecordCommand(recordId: string, projectId: string | undefined): string {
  const parts = ["moryn", "timeline", "--record-id", recordId];
  appendProjectId(parts, projectId);
  return parts.join(" ");
}

function timelineEventCommand(eventId: string, projectId: string | undefined): string {
  const parts = ["moryn", "timeline", "--event-id", eventId];
  appendProjectId(parts, projectId);
  return parts.join(" ");
}

function latestEventsByRecord(events: MorynEvent[]): Map<string, MorynEvent> {
  const byRecord = new Map<string, MorynEvent>();
  for (const event of [...events].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id))) {
    byRecord.set(targetRecordId(event) ?? "", event);
  }
  byRecord.delete("");
  return byRecord;
}

function recordCitation(record: MorynRecord, eventsByRecord: Map<string, MorynEvent>): DashboardRecordCitation {
  const event = eventsByRecord.get(record.id);
  return {
    record_id: record.id,
    ...(event ? { event_id: event.event_id } : {}),
    timeline_command: timelineRecordCommand(record.id, record.project_id),
    recall_command: recallCommand(record.id, record.project_id)
  };
}

function eventCitation(event: MorynEvent, recordsById: Map<string, MorynRecord>): DashboardEventCitation {
  const recordId = targetRecordId(event);
  const projectId = recordId ? recordsById.get(recordId)?.project_id : undefined;
  return {
    event_id: event.event_id,
    ...(recordId ? { record_id: recordId } : {}),
    timeline_command: timelineEventCommand(event.event_id, projectId),
    ...(recordId ? { recall_command: recallCommand(recordId, projectId) } : {})
  };
}

function summarizeRecord(record: MorynRecord, eventsByRecord: Map<string, MorynEvent>): DashboardRecordSummary {
  return {
    id: record.id,
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    project_id: record.project_id,
    state: record.state,
    priority: record.priority,
    source: record.source,
    created_at: record.created_at,
    updated_at: record.updated_at,
    text: recordText(record),
    citation: recordCitation(record, eventsByRecord)
  };
}

function summarizeEvent(event: MorynEvent, recordsById: Map<string, MorynRecord>): DashboardEventSummary {
  return {
    event_id: event.event_id,
    op: event.op,
    record_id: targetRecordId(event),
    source: event.source,
    created_at: event.created_at,
    citation: eventCitation(event, recordsById)
  };
}

function latestIso(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function displayClient(rawClient: string): string {
  return normalizeAgentIdentity(rawClient).client;
}

function updateAgentActivity(
  activity: Map<string, DashboardAgentActivity>,
  rawClient: string,
  field: "events" | "records",
  latestAt: string,
  citation?: DashboardAgentCitation
) {
  const client = displayClient(rawClient);
  const existing = activity.get(client) ?? { client, raw_clients: [], events: 0, records: 0, latest_at: latestAt };
  existing[field] += 1;
  if (latestAt.localeCompare(existing.latest_at) >= 0) {
    existing.latest_at = latestAt;
    if (citation) existing.citation = citation;
  }
  if (!existing.raw_clients.includes(rawClient)) existing.raw_clients.push(rawClient);
  existing.raw_clients.sort();
  activity.set(client, existing);
}

function agentEventCitation(event: MorynEvent, recordsById: Map<string, MorynRecord>): DashboardAgentCitation {
  const recordId = targetRecordId(event);
  const projectId = recordId ? recordsById.get(recordId)?.project_id : undefined;
  return {
    event_id: event.event_id,
    ...(recordId ? { record_id: recordId } : {}),
    timeline_command: timelineEventCommand(event.event_id, projectId)
  };
}

function summarizeAgentActivity(events: MorynEvent[], records: MorynRecord[], recordsById: Map<string, MorynRecord>, eventsByRecord: Map<string, MorynEvent>): DashboardAgentActivity[] {
  const activity = new Map<string, DashboardAgentActivity>();

  for (const event of events) {
    updateAgentActivity(activity, event.source.client, "events", event.created_at, agentEventCitation(event, recordsById));
  }

  for (const record of records) {
    const event = eventsByRecord.get(record.id);
    updateAgentActivity(activity, record.source.client, "records", record.updated_at, event ? agentEventCitation(event, recordsById) : undefined);
  }

  return [...activity.values()].sort((left, right) => {
    return left.latest_at.localeCompare(right.latest_at) || left.client.localeCompare(right.client);
  });
}

function sourceLabel(source: RecordSource): string {
  return [source.client, source.session_id].filter(Boolean).join(" / ");
}

function humanSourceLabel(source: RecordSource): string {
  return displayClient(source.client || "unknown");
}

function humanSourceDetail(source: RecordSource): string {
  return sourceLabel(source) || "unknown";
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function relativeTime(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return iso;
  const diffMs = Math.max(0, now - then);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function stateCounts(records: MorynRecord[]): Map<MorynRecord["state"], number> {
  const counts = new Map<MorynRecord["state"], number>();
  for (const record of records) {
    counts.set(record.state, (counts.get(record.state) ?? 0) + 1);
  }
  return counts;
}

function kindCounts(records: MorynRecord[]): Map<RecordKind, number> {
  const counts = new Map<RecordKind, number>();
  for (const record of records) {
    counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  }
  return counts;
}

function isQuarantined(record: MorynRecord): boolean {
  return record.visibility === "quarantined" || record.state === "quarantined";
}

function supersededQuarantinedRecordIds(records: MorynRecord[]): Set<string> {
  const ids = new Set<string>();
  const byId = new Map(records.map((record) => [record.id, record]));
  const addSupersededQuarantine = (record: MorynRecord, visited: Set<string>) => {
    if (visited.has(record.id)) return;
    visited.add(record.id);
    const superseded = record.content.supersedes_quarantined_record;
    if (typeof superseded === "string" && superseded.length > 0) {
      ids.add(superseded);
    }
    const supersededIndex = record.content.supersedes_index_record;
    if (typeof supersededIndex === "string" && supersededIndex.length > 0) {
      const previous = byId.get(supersededIndex);
      if (previous) addSupersededQuarantine(previous, visited);
    }
  };
  for (const record of records) {
    if (isQuarantined(record) || record.visibility !== "active") continue;
    addSupersededQuarantine(record, new Set());
  }
  return ids;
}

function unresolvedQuarantinedRecords(records: MorynRecord[]): MorynRecord[] {
  const superseded = supersededQuarantinedRecordIds(records);
  return records.filter((record) => isQuarantined(record) && !superseded.has(record.id));
}

function supersededQuarantinedCount(records: MorynRecord[]): number {
  const superseded = supersededQuarantinedRecordIds(records);
  return records.filter((record) => isQuarantined(record) && superseded.has(record.id)).length;
}

function quarantinedCount(records: MorynRecord[]): number {
  return records.filter(isQuarantined).length;
}

function buildHealth(sync: GitSyncStatus, records: MorynRecord[], generatedAt: string): DashboardHealth {
  const hidden = unresolvedQuarantinedRecords(records).length;
  if (sync.sync_state === "conflict") {
    return {
      status: "conflict",
      label: "Conflict",
      explanation: "Sync has a conflict that needs manual resolution before cross-device handoff can be trusted.",
      generated_at: generatedAt
    };
  }
  if (!sync.configured) {
    return {
      status: "local_only",
      label: "Local Only",
      explanation: "Sync is not configured; this snapshot is useful locally, but other devices will not see these records yet.",
      generated_at: generatedAt
    };
  }
  if (hidden > 0) {
    return {
      status: "needs_review",
      label: "Needs Review",
      explanation: "Moryn is usable, but unresolved safety signals deserve a quick look.",
      generated_at: generatedAt
    };
  }
  if (sync.sync_state === "dirty" || (sync.ahead ?? 0) > 0 || (sync.behind ?? 0) > 0) {
    return {
      status: "sync_pending",
      label: "Sync Pending",
      explanation: "Local sync changes are waiting to be pushed or pulled; memory data remains usable on this device.",
      generated_at: generatedAt
    };
  }
  return {
    status: "healthy",
    label: "Healthy",
    explanation: "Sync is clean and no urgent safety items were detected in this snapshot.",
    generated_at: generatedAt
  };
}

function buildAttentionItems(sync: GitSyncStatus, records: MorynRecord[]): DashboardAttentionItem[] {
  const items: DashboardAttentionItem[] = [];
  const ahead = sync.ahead ?? 0;
  const behind = sync.behind ?? 0;
  const hidden = unresolvedQuarantinedRecords(records).length;
  const supersededHidden = supersededQuarantinedCount(records);
  const raw = records.filter((record) => record.state === "raw").length;
  const candidates = records.filter((record) => record.state === "candidate").length;
  const canonical = records.filter((record) => record.state === "canonical").length;

  if (!sync.configured) {
    items.push({
      severity: "info",
      title: "Sync is not configured",
      description: "This store is local-only until a private Git remote is configured.",
      action_label: "Configure sync",
      action_command: "moryn sync init <remote>"
    });
  }
  if (sync.sync_state === "conflict") {
    items.push({
      severity: "critical",
      title: "Sync conflict",
      description: "Git sync reports a conflict. Resolve it before relying on cross-device handoff.",
      action_label: "Check sync",
      action_command: "moryn sync --status"
    });
  }
  if (sync.sync_state === "dirty") {
    items.push({
      severity: "warning",
      title: "Sync changes not pushed",
      description: "Local event history has changes that are not committed or pushed yet.",
      action_label: "Push sync",
      action_command: "moryn sync --push"
    });
  }
  if (ahead > 0 || behind > 0) {
    items.push({
      severity: behind > 0 ? "warning" : "info",
      title: "Remote position changed",
      description: `This store is ${ahead} commit(s) ahead and ${behind} commit(s) behind the configured remote.`,
      action_label: behind > 0 ? "Pull sync" : "Push sync",
      action_command: behind > 0 ? "moryn sync --pull" : "moryn sync --push"
    });
  }
  if (hidden > 0) {
    items.push({
      severity: "warning",
      title: "Quarantined records hidden",
      description: `${hidden} record(s) are hidden because they may contain sensitive or unsafe content.`
    });
  }
  if (supersededHidden > 0) {
    items.push({
      severity: "info",
      title: "Quarantined records superseded",
      description: `${supersededHidden} quarantined record(s) have active safe replacement index records.`
    });
  }
  if (raw > 0) {
    items.push({
      severity: "info",
      title: "Raw records waiting for review",
      description: `${raw} raw record(s) are preserved but excluded from normal recall.`
    });
  }
  if (candidates > Math.max(8, canonical * 2)) {
    items.push({
      severity: "info",
      title: "Many candidate records",
      description: `${candidates} candidate record(s) may need promotion, archival, or cleanup.`
    });
  }

  return items;
}

function buildAgentChart(activity: DashboardAgentActivity[], generatedAt: string): DashboardAgentChartItem[] {
  const max = Math.max(1, ...activity.map((agent) => agent.events + agent.records));
  return activity.map((agent) => ({
    ...agent,
    weight: Math.round(((agent.events + agent.records) / max) * 100),
    relative_time: relativeTime(agent.latest_at, generatedAt)
  }));
}

function buildMemoryStateChart(records: MorynRecord[]): DashboardMemoryStateChartItem[] {
  const counts = stateCounts(records);
  const total = Math.max(1, records.length);
  const states: MorynRecord["state"][] = ["canonical", "candidate", "raw", "archived", "quarantined"];
  return states
    .map((state) => ({
      state,
      count: counts.get(state) ?? 0,
      percent: Math.round(((counts.get(state) ?? 0) / total) * 100)
    }))
    .filter((item) => item.count > 0);
}

function buildRecordTypeChart(records: MorynRecord[]): DashboardRecordTypeChartItem[] {
  const counts = kindCounts(records);
  const total = Math.max(1, records.length);
  const kinds: RecordKind[] = ["memory", "skill", "soul", "session_summary", "agent_note"];
  return kinds
    .map((kind) => ({
      kind,
      label: titleCase(kind),
      count: counts.get(kind) ?? 0,
      percent: Math.round(((counts.get(kind) ?? 0) / total) * 100)
    }))
    .filter((item) => item.count > 0);
}

function buildSyncPositionChart(sync: GitSyncStatus): DashboardSyncPositionChart {
  return {
    configured: sync.configured,
    state: sync.configured ? (sync.sync_state ?? "configured") : "not_configured",
    ahead: sync.ahead ?? 0,
    behind: sync.behind ?? 0,
    dirty: sync.sync_state === "dirty",
    conflict: sync.sync_state === "conflict"
  };
}

function recordValueScore(record: MorynRecord): number {
  let score = 0;
  if (record.state === "canonical") score += 60;
  if (record.kind === "memory") score += 22;
  if (record.kind === "session_summary") score += 18;
  if (record.type === "decision" || record.type === "warning") score += 20;
  if (record.type === "status") score += 12;
  if (record.state === "quarantined") score -= 8;
  if (record.state === "raw") score -= 20;
  return score;
}

function summarizeValueRecord(record: MorynRecord, generatedAt: string, eventsByRecord: Map<string, MorynEvent>): DashboardValueRecord {
  return {
    id: record.id,
    title: titleCase(record.type || record.kind),
    summary: recordText(record),
    source_label: humanSourceLabel(record.source),
    source_detail: humanSourceDetail(record.source),
    relative_time: relativeTime(record.updated_at, generatedAt),
    exact_time: record.updated_at,
    state: record.state,
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    project_id: record.project_id,
    citation: recordCitation(record, eventsByRecord)
  };
}

function buildRecentValue(records: MorynRecord[], generatedAt: string, limit: number, eventsByRecord: Map<string, MorynEvent>): DashboardValueRecord[] {
  return [...records]
    .sort((left, right) => {
      const timeDiff = right.updated_at.localeCompare(left.updated_at);
      const scoreDiff = recordValueScore(right) - recordValueScore(left);
      return timeDiff || scoreDiff || left.id.localeCompare(right.id);
    })
    .slice(0, limit)
    .map((record) => summarizeValueRecord(record, generatedAt, eventsByRecord));
}

function captureInboxApproveEndpoint(recordId: string): string {
  return `api/capture-inbox/${encodeURIComponent(recordId)}/approve`;
}

function captureInboxRejectEndpoint(recordId: string): string {
  return `api/capture-inbox/${encodeURIComponent(recordId)}/reject`;
}

function captureInboxGroupApproveEndpoint(groupId: string): string {
  return `api/capture-inbox/groups/${encodeURIComponent(groupId)}/approve`;
}

function captureInboxGroupRejectEndpoint(groupId: string): string {
  return `api/capture-inbox/groups/${encodeURIComponent(groupId)}/reject`;
}

function candidateTriagePromotionApproveEndpoint(recordId: string): string {
  return `api/candidate-triage/promotions/${encodeURIComponent(recordId)}/approve`;
}

function captureInboxRecordActionId(intent: "approve" | "reject", recordId: string): string {
  return `capture_inbox.record.${intent}.${recordId}`;
}

function captureInboxGroupActionId(intent: "approve" | "reject", groupId: string): string {
  return `capture_inbox.group.${intent}.${groupId}`;
}

function candidateTriagePromotionApproveActionId(recordId: string): string {
  return `candidate_triage.promotion.approve.${recordId}`;
}

function capturePolicyInspectActionId(recordId: string): string {
  return `capture_policy.inspect.${recordId}`;
}

function recordCapturePolicyDecision(record: MorynRecord): AutocapturePolicyDecision | undefined {
  const capture = record.content.capture;
  if (typeof capture !== "object" || capture === null || Array.isArray(capture)) return undefined;
  const policy = (capture as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return undefined;
  const decision = (policy as Record<string, unknown>).decision;
  return decision === "capture" || decision === "review" || decision === "archive" ? decision : undefined;
}

function maintenanceApproveActionId(plan: DashboardMaintenancePlan): string {
  return `maintenance.plan.approve.${plan.plan_hash.replace(/^sha256:/, "")}`;
}

function isCaptureInboxCandidate(record: MorynRecord): boolean {
  return record.visibility === "active" && isCaptureReviewCandidate(record);
}

function captureGroupKey(record: MorynRecord): string {
  return [
    record.project_id ?? record.scope,
    displayClient(record.source.client || "unknown"),
    record.source.session_id ?? "no-session",
    record.created_at.slice(0, 10)
  ].join("|");
}

function captureGroupId(groupKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < groupKey.length; index += 1) {
    hash ^= groupKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `capture_group_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizedCaptureText(record: MorynRecord): string {
  return recordText(record).trim().toLowerCase().replace(/\s+/g, " ");
}

function captureNoiseForRecord(record: MorynRecord, duplicateTexts: Set<string>): DashboardCaptureNoise {
  const reasons: string[] = [];
  const ruleIds: DashboardCaptureNoiseRule["id"][] = [];
  const searchable = `${record.tags.join(" ")} ${record.type} ${recordText(record)}`.toLowerCase();
  if (/\b(smoke|test|fixture|e2e|marker)\b/.test(searchable)) {
    ruleIds.push("smoke_test_marker");
    reasons.push("Looks like smoke, test, or fixture output.");
  }
  if (duplicateTexts.has(normalizedCaptureText(record))) {
    ruleIds.push("duplicate_text");
    reasons.push("Duplicate capture text appears in this batch.");
  }
  return {
    level: reasons.length > 0 ? "likely_noise" : "normal",
    reasons,
    rule_ids: ruleIds,
    suggested_action: reasons.length > 0 ? "archive" : "review"
  };
}

function capturePolicyRuleIds(record: MorynRecord): AutocapturePolicyRuleId[] {
  const capture = record.content.capture;
  if (typeof capture !== "object" || capture === null || Array.isArray(capture)) return [];
  const policy = (capture as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return [];
  const ruleIds = (policy as Record<string, unknown>).rule_ids;
  if (!Array.isArray(ruleIds)) return [];
  return ruleIds.filter((ruleId): ruleId is AutocapturePolicyRuleId => {
    return ruleId === "low_risk_handoff_auto_capture"
      || ruleId === "review_risk_marker"
      || ruleId === "default_review_for_agent_handoff"
      || ruleId === "smoke_test_marker"
      || ruleId === "duplicate_text";
  });
}

function isAutoCapturedAutocapture(record: MorynRecord): boolean {
  return record.state === "candidate"
    && record.visibility === "active"
    && record.tags.some((tag) => tag.toLowerCase() === "autocapture")
    && (
      record.tags.some((tag) => tag.toLowerCase() === "auto-captured")
      || recordCapturePolicyDecision(record) === "capture"
      || currentPolicyTreatsAsLowRiskCapture(record)
    );
}

function isPolicyArchivedAutocapture(record: MorynRecord): boolean {
  return record.state === "archived"
    && record.visibility === "archived"
    && record.tags.some((tag) => tag.toLowerCase() === "autocapture")
    && record.tags.some((tag) => tag.toLowerCase() === "policy-archived");
}

function buildAutocapturePolicySummary(records: MorynRecord[], limit: number): DashboardAutocapturePolicySummary {
  const captured = records
    .filter(isAutoCapturedAutocapture)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  const archived = records
    .filter(isPolicyArchivedAutocapture)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  const capturedByRule: Partial<Record<AutocapturePolicyRuleId, number>> = {};
  const archivedByRule: Partial<Record<AutocapturePolicyRuleId, number>> = {};
  for (const record of captured) {
    const ruleIds = currentAutocaptureDecisionForRecord(record)?.rule_ids ?? capturePolicyRuleIds(record);
    for (const ruleId of ruleIds) {
      capturedByRule[ruleId] = (capturedByRule[ruleId] ?? 0) + 1;
    }
  }
  for (const record of archived) {
    const ruleIds = capturePolicyRuleIds(record);
    for (const ruleId of ruleIds) {
      archivedByRule[ruleId] = (archivedByRule[ruleId] ?? 0) + 1;
    }
  }
  return {
    id: DEFAULT_AUTOCAPTURE_POLICY.id,
    version: DEFAULT_AUTOCAPTURE_POLICY.version,
    mode: DEFAULT_AUTOCAPTURE_POLICY.mode,
    auto_canonical: DEFAULT_AUTOCAPTURE_POLICY.auto_canonical,
    canonical_requires_user_action: DEFAULT_AUTOCAPTURE_POLICY.canonical_requires_user_action,
    capture_low_risk_without_review: DEFAULT_AUTOCAPTURE_POLICY.capture_low_risk_without_review,
    archive_noise_without_review: DEFAULT_AUTOCAPTURE_POLICY.archive_noise_without_review,
    auto_captured_total: captured.length,
    captured_by_rule: capturedByRule,
    auto_captured_examples: captured.slice(0, limit).map((record) => ({
      id: record.id,
      text: recordText(record),
      rule_ids: currentAutocaptureDecisionForRecord(record)?.rule_ids ?? capturePolicyRuleIds(record),
      reason: record.provenance?.reason
    })),
    archived_total: archived.length,
    archived_by_rule: archivedByRule,
    archived_examples: archived.slice(0, limit).map((record) => ({
      id: record.id,
      text: recordText(record),
      rule_ids: capturePolicyRuleIds(record),
      reason: record.provenance?.reason
    }))
  };
}

function mergeCaptureNoise(noises: DashboardCaptureNoise[]): DashboardCaptureNoise {
  const reasons = [...new Set(noises.flatMap((noise) => noise.reasons))];
  const ruleIds = [...new Set(noises.flatMap((noise) => noise.rule_ids))];
  return {
    level: reasons.length > 0 ? "likely_noise" : "normal",
    reasons,
    rule_ids: ruleIds,
    suggested_action: reasons.length > 0 ? "archive" : "review"
  };
}

function summarizeCaptureInboxItem(
  record: MorynRecord,
  groupId: string,
  generatedAt: string,
  noise: DashboardCaptureNoise,
  eventsByRecord: Map<string, MorynEvent>
): DashboardCaptureInboxItem {
  return {
    id: record.id,
    group_id: groupId,
    kind: record.kind,
    type: record.type,
    project_id: record.project_id,
    text: recordText(record),
    source_label: humanSourceLabel(record.source),
    source_detail: humanSourceDetail(record.source),
    relative_time: relativeTime(record.updated_at, generatedAt),
    exact_time: record.updated_at,
    confidence: record.confidence,
    priority: record.priority,
    provenance_method: record.provenance?.method,
    provenance_reason: record.provenance?.reason,
    approve_endpoint: captureInboxApproveEndpoint(record.id),
    reject_endpoint: captureInboxRejectEndpoint(record.id),
    noise,
    citation: recordCitation(record, eventsByRecord)
  };
}

function buildCaptureInbox(records: MorynRecord[], generatedAt: string, limit: number, eventsByRecord: Map<string, MorynEvent>): DashboardCaptureInbox {
  const candidates = records
    .filter(isCaptureInboxCandidate)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  const textCounts = new Map<string, number>();
  for (const record of candidates) {
    const text = normalizedCaptureText(record);
    if (!text) continue;
    textCounts.set(text, (textCounts.get(text) ?? 0) + 1);
  }
  const duplicateTexts = new Set([...textCounts].filter(([, count]) => count > 1).map(([text]) => text));
  const groups = new Map<string, { groupId: string; records: MorynRecord[]; noises: DashboardCaptureNoise[] }>();
  const itemInputs: Array<{ record: MorynRecord; groupId: string; noise: DashboardCaptureNoise }> = [];
  for (const record of candidates) {
    const groupKey = captureGroupKey(record);
    const groupId = captureGroupId(groupKey);
    const noise = captureNoiseForRecord(record, duplicateTexts);
    const existing = groups.get(groupKey) ?? { groupId, records: [], noises: [] };
    existing.records.push(record);
    existing.noises.push(noise);
    groups.set(groupKey, existing);
    itemInputs.push({ record, groupId, noise });
  }
  const grouped = [...groups.values()]
    .sort((left, right) => {
      const leftLatest = left.records[0]!.updated_at;
      const rightLatest = right.records[0]!.updated_at;
      return rightLatest.localeCompare(leftLatest) || left.groupId.localeCompare(right.groupId);
    });
  const displayedGroups = grouped.slice(0, limit);
  const displayedItems = displayedGroups.flatMap((group) => group.records);
  const groupSummaries = displayedGroups
    .map((group): DashboardCaptureInboxGroup => {
      const latest = group.records[0]!;
      const groupNoise = mergeCaptureNoise(group.noises);
      return {
        id: group.groupId,
        total: group.records.length,
        record_ids: group.records.map((record) => record.id),
        source_label: humanSourceLabel(latest.source),
        source_detail: humanSourceDetail(latest.source),
        project_id: latest.project_id,
        latest_at: latest.updated_at,
        relative_time: relativeTime(latest.updated_at, generatedAt),
        summary: group.records.map((record) => recordText(record)).join(" "),
        noise: groupNoise,
        approve_endpoint: captureInboxGroupApproveEndpoint(group.groupId),
        reject_endpoint: captureInboxGroupRejectEndpoint(group.groupId)
      };
    });
  return {
    total: candidates.length,
    group_total: grouped.length,
    policy: CAPTURE_INBOX_POLICY,
    autocapture_policy: buildAutocapturePolicySummary(records, limit),
    groups: groupSummaries,
    items: displayedItems
      .map((record) => {
        const item = itemInputs.find((candidate) => candidate.record.id === record.id)!;
        return summarizeCaptureInboxItem(record, item.groupId, generatedAt, item.noise, eventsByRecord);
      })
  };
}

function contextPackReviewItems(records: MorynRecord[], source: string): DashboardContextPackReviewItem[] {
  return records.map((record) => ({
    text: recordText(record),
    evidence: {
      source,
      record_id: record.id
    }
  }));
}

function dashboardCaptureSessionCommand(projectId: string): string {
  return `moryn capture session --project-id ${projectId} --agent <agent> --summary <summary>`;
}

function contextPackReviewCheck(input: {
  id: DashboardContextPackReviewCheckId;
  label: string;
  source: string;
  status: "pass" | "warn";
  count?: number;
  message: string;
}): DashboardContextPackReviewCheck {
  return {
    id: input.id,
    label: input.label,
    source: input.source,
    status: input.status,
    ...(input.count === undefined ? {} : { count: input.count }),
    message: input.message
  };
}

function buildContextPackReviewQualityGate(input: {
  currentGoal: boolean;
  recentDecisions: DashboardContextPackReviewItem[];
  openThreads: DashboardContextPackReviewItem[];
  risks: DashboardContextPackReviewItem[];
  nextActions: DashboardContextPackReviewNextAction[];
}): DashboardContextPackReviewQualityGate {
  const checks: DashboardContextPackReviewCheck[] = [
    contextPackReviewCheck({
      id: "current_goal",
      label: "Current goal",
      source: "context_pack_review.handoff_pack.current_goal",
      status: input.currentGoal ? "pass" : "warn",
      message: input.currentGoal
        ? "Dashboard has explicit project context for this review."
        : "Dashboard was opened without explicit project context."
    }),
    contextPackReviewCheck({
      id: "recent_decisions",
      label: "Recent decisions",
      source: "context_pack_review.handoff_pack.recent_decisions[]",
      status: "pass",
      count: input.recentDecisions.length,
      message: input.recentDecisions.length > 0
        ? "Recent decisions include evidence paths."
        : "No recent decisions are currently available."
    }),
    contextPackReviewCheck({
      id: "open_threads",
      label: "Open threads",
      source: "context_pack_review.handoff_pack.open_threads[]",
      status: "pass",
      count: input.openThreads.length,
      message: input.openThreads.length > 0
        ? "Open handoff threads include evidence paths."
        : "No open handoff threads are currently available."
    }),
    contextPackReviewCheck({
      id: "risks",
      label: "Risks",
      source: "context_pack_review.handoff_pack.risks[]",
      status: "pass",
      count: input.risks.length,
      message: input.risks.length > 0
        ? "Risks include evidence paths."
        : "No explicit risks are currently available."
    }),
    contextPackReviewCheck({
      id: "evidence_paths",
      label: "Evidence paths",
      source: "context_pack_review.handoff_pack.evidence",
      status: "pass",
      message: "Dashboard review links each item back to local record evidence."
    }),
    contextPackReviewCheck({
      id: "capture_next_action",
      label: "Capture next action",
      source: "next.actions_by_id.capture_session",
      status: input.nextActions.some((action) => action.id === "capture_session") ? "pass" : "warn",
      message: input.nextActions.some((action) => action.id === "capture_session")
        ? "Required capture_session end action is visible."
        : "Required capture_session end action is missing."
    })
  ];
  const failedCheckIds = checks.filter((check) => check.status === "warn").map((check) => check.id);
  return {
    status: failedCheckIds.length > 0 ? "needs_review" : "ready",
    read_only: true,
    checks,
    checks_by_id: Object.fromEntries(checks.map((check) => [check.id, check])) as Record<DashboardContextPackReviewCheckId, DashboardContextPackReviewCheck>,
    failed_check_ids: failedCheckIds,
    warnings: checks.filter((check) => check.status === "warn").map((check) => check.message)
  };
}

function buildContextPackReview(records: MorynRecord[], options: DashboardOptions): DashboardContextPackReview {
  const projectId = options.project_id;
  const generatedFrom = {
    store: "local_event_history" as const,
    writes: "none" as const,
    sync_pull: false as const
  };
  if (!projectId) {
    return {
      available: false,
      unavailable_reason: "Open the dashboard with --project-id or --project to review a project context pack.",
      generated_from: generatedFrom,
      selection_sources: CONTEXT_PACK_REVIEW_SELECTION_SOURCES
    };
  }

  const projectRecords = records
    .filter((record) => record.scope === "project" && record.project_id === projectId)
    .filter((record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined");
  const canonicalProjectMemory = projectRecords
    .filter((record) => record.kind === "memory" && record.state === "canonical")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  const recentDecisions = contextPackReviewItems(
    canonicalProjectMemory.filter((record) => record.type === "decision").slice(0, 5),
    CONTEXT_PACK_REVIEW_SELECTION_SOURCES.recent_decision
  );
  const risks = contextPackReviewItems(
    canonicalProjectMemory.filter((record) => record.type === "warning" || record.type === "blocker").slice(0, 5),
    CONTEXT_PACK_REVIEW_SELECTION_SOURCES.risk
  );
  const openThreads = contextPackReviewItems(
    projectRecords
      .filter((record) => record.kind === "session_summary" && record.state !== "raw" && record.type !== "status")
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
      .slice(0, 5),
    CONTEXT_PACK_REVIEW_SELECTION_SOURCES.open_thread
  );
  const captureCommand = dashboardCaptureSessionCommand(projectId);
  const nextActions: DashboardContextPackReviewNextAction[] = [{
    id: "capture_session",
    command: captureCommand,
    required_when: "Before ending a host session, capture a handoff summary for the next agent.",
    evidence: {
      source: "next.actions_by_id.capture_session",
      command: captureCommand
    }
  }];
  const qualityGate = buildContextPackReviewQualityGate({
    currentGoal: Boolean(projectId),
    recentDecisions,
    openThreads,
    risks,
    nextActions
  });

  return {
    available: true,
    project_id: projectId,
    generated_from: generatedFrom,
    handoff_pack: {
      version: 2,
      purpose: "agent_handoff",
      current_goal: {
        text: projectId,
        source: "dashboard.project_id"
      },
      recent_decisions: recentDecisions,
      open_threads: openThreads,
      risks,
      next_actions: nextActions,
      evidence: {
        records: "recent_records",
        events: "recent_events",
        next: "context_pack_review.handoff_pack.next_actions[]"
      },
      quality_gate: qualityGate
    },
    selection_sources: CONTEXT_PACK_REVIEW_SELECTION_SOURCES
  };
}

function captureInboxActions(inbox: DashboardCaptureInbox): DashboardAction[] {
  return [
    ...inbox.items.flatMap((item) => [
      {
        action_id: captureInboxRecordActionId("approve", item.id),
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Approve Memory",
        intent: "approve",
        target: { type: "record", id: item.id },
        method: "POST",
        endpoint: item.approve_endpoint,
        request_body: {},
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "capture_inbox.items[]"
      },
      {
        action_id: captureInboxRecordActionId("reject", item.id),
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Reject",
        intent: "reject",
        target: { type: "record", id: item.id },
        method: "POST",
        endpoint: item.reject_endpoint,
        request_body: { reason: "User rejected Capture Inbox candidate." },
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "capture_inbox.items[]"
      }
    ] satisfies DashboardAction[]),
    ...inbox.groups.flatMap((group) => [
      {
        action_id: captureInboxGroupActionId("approve", group.id),
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Approve Group",
        intent: "approve",
        target: { type: "record_group", id: group.id, record_ids: group.record_ids },
        method: "POST",
        endpoint: group.approve_endpoint,
        request_body: { record_ids: group.record_ids },
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_group"
        },
        source_path: "capture_inbox.groups[]"
      },
      {
        action_id: captureInboxGroupActionId("reject", group.id),
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Reject Group",
        intent: "reject",
        target: { type: "record_group", id: group.id, record_ids: group.record_ids },
        method: "POST",
        endpoint: group.reject_endpoint,
        request_body: {
          record_ids: group.record_ids,
          reason: "User rejected Capture Inbox group."
        },
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_group"
        },
        source_path: "capture_inbox.groups[]"
      }
    ] satisfies DashboardAction[])
  ];
}

function capturePolicyActions(report: CapturePolicyResult): DashboardAction[] {
  return report.suggested_actions
    .filter((action) => action.recommended_action === "inspect_policy_archived_record" || action.recommended_action === "inspect_auto_captured_handoff")
    .flatMap((action): DashboardAction[] => {
      const recordId = typeof action.arguments.record_id === "string" ? action.arguments.record_id : undefined;
      if (!recordId) return [];
      return [{
        action_id: capturePolicyInspectActionId(recordId),
        surface: "capture_policy",
        kind: "cli_command",
        label: action.recommended_action,
        intent: "inspect",
        target: { type: "policy_decision", id: recordId },
        command: action.command,
        safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          writes: "none"
        },
        source_path: `capture_policy.suggested_actions_by_id.${action.action_id}`
      }];
    });
}

function maintenanceActions(plans: DashboardMaintenancePlan[]): DashboardAction[] {
  return plans.map((plan) => ({
    action_id: maintenanceApproveActionId(plan),
    surface: "maintenance_review",
    kind: "dashboard_api",
    label: maintenancePrimaryActionLabel(plan),
    intent: "approve",
    target: {
      type: "maintenance_plan",
      id: plan.plan_id,
      plan_hash: plan.plan_hash
    },
    method: "POST",
    endpoint: maintenancePlanEndpoint(plan),
    request_body: { plan_hash: plan.plan_hash },
    safety: {
      safe_to_auto_run: false,
      requires_user_confirmation: true,
      writes: "append_only_events",
      stale_guard: "plan_hash"
    },
    source_path: "maintenance.plans[]"
  }));
}

function candidateTriageActions(triage: DashboardCandidateTriage): DashboardAction[] {
  return Object.values(triage.groups_by_id)
    .flatMap((group) => group ? Object.values(group.promotion_drafts_by_id) : [])
    .map((draft): DashboardAction => ({
      action_id: draft.action_id,
      surface: "candidate_triage",
      kind: "dashboard_api",
      label: "Approve Memory",
      intent: "approve",
      target: { type: "record", id: draft.record_id },
      method: "POST",
      endpoint: draft.approve_endpoint,
      request_body: {},
      safety: {
        safe_to_auto_run: false,
        requires_user_confirmation: true,
        writes: "append_only_events",
        stale_guard: "active_candidate_record"
      },
      source_path: draft.source_path
    }));
}

function dashboardActions(input: {
  captureInbox: DashboardCaptureInbox;
  capturePolicy: CapturePolicyResult;
  maintenance: DashboardMaintenanceData;
  candidateTriage: DashboardCandidateTriage;
}): DashboardAction[] {
  return [
    ...captureInboxActions(input.captureInbox),
    ...capturePolicyActions(input.capturePolicy),
    ...maintenanceActions(input.maintenance.plans),
    ...candidateTriageActions(input.candidateTriage)
  ];
}

function actionsById(actions: DashboardAction[]): Record<string, DashboardAction> {
  return Object.fromEntries(actions.map((action) => [action.action_id, action]));
}

function buildDecisionSummary(input: {
  captureInbox: DashboardCaptureInbox;
  maintenance: DashboardMaintenanceData;
  candidateTriage: DashboardCandidateTriage;
}): DashboardDecisionSummary {
  const captureInboxItems = input.captureInbox.groups.map((group): DashboardDecisionSummaryItem => ({
    id: `capture_inbox:${group.id}`,
    surface: "capture_inbox",
    title: `Review ${group.source_label} capture group`,
    summary: `${pluralize(group.total, "candidate")} from ${group.source_detail}. ${group.noise.level === "likely_noise" ? "Noise signals detected before approval." : "No noise signals detected."}`,
    decision_label: "Approve Group or Reject Group",
    target: "capture-inbox",
    target_label: "Open Capture Inbox",
    primary_action_id: captureInboxGroupActionId("approve", group.id),
    secondary_action_id: captureInboxGroupActionId("reject", group.id),
    requires_user_confirmation: true,
    writes: "append_only_events",
    safety_note: "Approve Group promotes candidates; Reject Group archives them. Both append audit events.",
    evidence_path: "capture_inbox.groups[]"
  }));
  const maintenanceItems = input.maintenance.plans.map((plan): DashboardDecisionSummaryItem => ({
    id: `maintenance_review:${plan.plan_hash.replace(/^sha256:/, "")}`,
    surface: "maintenance_review",
    title: plan.decision_card.title,
    summary: maintenanceDecisionSummaryText(plan),
    decision_label: maintenancePrimaryActionLabel(plan),
    target: "maintenance-review-queue",
    target_label: "Open Review Queue",
    primary_action_id: maintenanceApproveActionId(plan),
    requires_user_confirmation: true,
    writes: "append_only_events",
    safety_note: maintenanceActionSafetyNote(plan),
    evidence_path: "maintenance.plans[]"
  }));
  const candidateTriagePromotionItems = Object.values(input.candidateTriage.groups_by_id)
    .flatMap((group) => group ? Object.values(group.promotion_drafts_by_id) : [])
    .map((draft): DashboardDecisionSummaryItem => ({
      id: `candidate_triage:promotion:${draft.record_id}`,
      surface: "candidate_triage",
      title: "Approve Candidate Triage promotion",
      summary: `Promote ${recordLabel(draft.record_id)} to ${draft.target_state}.`,
      decision_label: "Approve Memory",
      target: "candidate-triage",
      target_label: "Open Candidate Triage",
      primary_action_id: draft.action_id,
      requires_user_confirmation: true,
      writes: "append_only_events",
      safety_note: "Approve Memory appends a promotion event only after the active candidate guard passes.",
      evidence_path: draft.source_path
    }));
  const items = [...captureInboxItems, ...maintenanceItems, ...candidateTriagePromotionItems];
  return {
    read_only: true,
    total_decisions: items.length,
    summary: {
      capture_inbox_groups: captureInboxItems.length,
      review_queue_plans: maintenanceItems.length,
      candidate_triage_promotions: candidateTriagePromotionItems.length
    },
    items,
    items_by_id: Object.fromEntries(items.map((item) => [item.id, item]))
  };
}

function maintenanceDecisionSummaryText(plan: DashboardMaintenancePlan): string {
  if (plan.type === "candidate_noise_archive") {
    return `${maintenanceMoveSummary(plan)} that look like smoke/e2e marker noise.`;
  }
  return `${maintenanceMoveSummary(plan)} from the old project id into ${plan.to_project_id ?? "the current project"}.`;
}

function actionBoardSeverity(count: number, fallback: DashboardActionBoardSeverity = "good"): DashboardActionBoardSeverity {
  return count > 0 ? "warning" : fallback;
}

function isSyncAttentionItem(item: DashboardAttentionItem): boolean {
  return item.action_command?.startsWith("moryn sync ") === true;
}

function isReviewAttentionItem(item: DashboardAttentionItem): boolean {
  return item.severity !== "info" && !isSyncAttentionItem(item);
}

function reviewActionCopy(attentionItems: DashboardAttentionItem[]): {
  hint: string;
  detail: string;
  next_action_label: string;
} {
  const reviewItems = attentionItems.filter(isReviewAttentionItem);
  const syncActionItems = attentionItems.filter((item) => item.severity !== "info" && isSyncAttentionItem(item));
  if (reviewItems.length === 0 && syncActionItems.length > 0) {
    return {
      hint: "Sync handled separately",
      detail: "Sync pending is shown in the Sync lane and Store Signals.",
      next_action_label: "Open info checks"
    };
  }
  return {
    hint: reviewItems.length === 0 ? "No warning action" : "Review visible warnings",
    detail: "Warnings and critical signals remain visible in Needs Attention.",
    next_action_label: reviewItems.length === 0 ? "Open info checks" : "Review warnings"
  };
}

function buildActionBoard(input: {
  decisionSummary: DashboardDecisionSummary;
  attentionItems: DashboardAttentionItem[];
  governance: DashboardGovernance;
  sync: GitSyncStatus;
  health: DashboardHealth;
}): DashboardActionBoard {
  const confirmCount = input.decisionSummary.total_decisions;
  const reviewCount = input.attentionItems.filter(isReviewAttentionItem).length;
  const reviewCopy = reviewActionCopy(input.attentionItems);
  const inspectCount = input.governance.summary.safe_inspections;
  const syncNeedsAction = input.health.status === "sync_pending" || input.health.status === "conflict" || input.health.status === "local_only";
  const syncSeverity: DashboardActionBoardSeverity = input.health.status === "conflict"
    ? "critical"
    : input.health.status === "sync_pending"
      ? "warning"
      : input.health.status === "local_only"
        ? "info"
        : "good";
  const items: DashboardActionBoardItem[] = [
    {
      id: "confirm",
      label: "Confirm",
      value: confirmCount,
      severity: actionBoardSeverity(confirmCount),
      summary: confirmCount === 0 ? "No approvals waiting" : pluralize(confirmCount, "decision waiting"),
      hint: confirmCount === 0 ? "No confirmation needed" : "Open decision summary",
      detail: "Explicit approvals stay in Capture Inbox, Review Queue, and Candidate Triage.",
      next_action_label: confirmCount === 0 ? "Check attention" : "Review decisions",
      target: confirmCount === 0 ? "needs-attention" : "decision-summary"
    },
    {
      id: "review",
      label: "Review",
      value: reviewCount,
      severity: actionBoardSeverity(reviewCount),
      summary: reviewCount === 0 ? "No urgent review" : pluralize(reviewCount, "attention item"),
      hint: reviewCopy.hint,
      detail: reviewCopy.detail,
      next_action_label: reviewCopy.next_action_label,
      target: "needs-attention"
    },
    {
      id: "inspect",
      label: "Inspect",
      value: inspectCount,
      severity: inspectCount > 0 ? "info" : "good",
      summary: inspectCount === 0 ? "No safe checks" : pluralize(inspectCount, "safe check"),
      hint: inspectCount === 0 ? "No inspection needed" : "Inspect governance",
      detail: "Read-only inspections are grouped in Governance Hub.",
      next_action_label: "Open governance",
      target: "governance-hub"
    },
    {
      id: "sync",
      label: "Sync",
      value: syncNeedsAction ? 1 : 0,
      severity: syncSeverity,
      summary: input.health.label,
      hint: input.sync.remote ? syncLabel(input.sync) : "Local only",
      detail: input.sync.remote ? syncLabel(input.sync) : "Local memory is usable; remote sync is not configured.",
      next_action_label: "Inspect sync",
      target: "store-signals"
    }
  ];
  return {
    items,
    items_by_id: Object.fromEntries(items.map((item) => [item.id, item])) as Record<DashboardActionBoardItemId, DashboardActionBoardItem>
  };
}

function overviewStatusFromActionSeverity(severity: DashboardActionBoardSeverity): DashboardOverviewStatus {
  return severity;
}

function overviewStatusFromHealth(status: DashboardHealthStatus): DashboardOverviewStatus {
  if (status === "healthy") return "good";
  if (status === "conflict") return "critical";
  if (status === "needs_review" || status === "sync_pending") return "warning";
  return "info";
}

function overviewContextStatus(review: DashboardContextPackReview): DashboardOverviewStatus {
  const gate = review.handoff_pack?.quality_gate.status;
  if (gate === "ready") return "good";
  if (gate === "needs_review") return "warning";
  return "info";
}

function buildDashboardOverview(input: {
  actionBoard: DashboardActionBoard;
  health: DashboardHealth;
  contextPackReview: DashboardContextPackReview;
}): DashboardOverview {
  const primary = focusBriefPrimaryItem(input.actionBoard);
  const isAllClearPrimary = primary.next_action_label === "All clear";
  const actionCardPrimary = isAllClearPrimary
    ? {
      ...primary,
      next_action_label: input.actionBoard.items_by_id.inspect.value > 0 ? "Inspect checks" : "Check attention",
      target: input.actionBoard.items_by_id.inspect.value > 0 ? "governance-hub" : "needs-attention"
    }
    : primary;
  const contextGate = input.contextPackReview.handoff_pack?.quality_gate.status;
  const cards: DashboardOverviewCard[] = [
    {
      id: "health",
      label: "Health",
      value: input.health.label,
      summary: input.health.explanation,
      severity: overviewStatusFromHealth(input.health.status),
      target: "needs-attention",
      target_label: "Review health",
      source: "health"
    },
    {
      id: "action",
      label: "Next",
      value: primary.next_action_label,
      summary: primary.summary,
      severity: overviewStatusFromActionSeverity(primary.severity),
      target: actionCardPrimary.target,
      target_label: actionCardPrimary.next_action_label,
      source: `action_board.items_by_id.${primary.id}`
    },
    {
      id: "context",
      label: "Context",
      value: input.contextPackReview.available ? titleCase(contextGate ?? "available") : "Unavailable",
      summary: input.contextPackReview.available
        ? "Handoff evidence stays read-only"
        : input.contextPackReview.unavailable_reason ?? "Project context is required for Context Pack Review.",
      severity: overviewContextStatus(input.contextPackReview),
      target: "context-pack-review",
      target_label: "Open context",
      source: "context_pack_review"
    },
    {
      id: "sync",
      label: "Sync",
      value: input.actionBoard.items_by_id.sync.summary,
      summary: input.actionBoard.items_by_id.sync.detail,
      severity: overviewStatusFromActionSeverity(input.actionBoard.items_by_id.sync.severity),
      target: input.actionBoard.items_by_id.sync.target,
      target_label: input.actionBoard.items_by_id.sync.next_action_label,
      source: "action_board.items_by_id.sync"
    }
  ];
  return {
    status: overviewStatusFromActionSeverity(primary.severity),
    headline: primary.next_action_label,
    detail: primary.detail,
    primary_action: {
      label: actionCardPrimary.next_action_label,
      target: actionCardPrimary.target,
      source: `action_board.items_by_id.${primary.id}`
    },
    safety: {
      read_only: true,
      mutation_surfaces: ["Capture Inbox", "Review Queue", "Candidate Triage"]
    },
    cards,
    cards_by_id: Object.fromEntries(cards.map((card) => [card.id, card])) as Record<DashboardOverviewCardId, DashboardOverviewCard>,
    evidence_sources: {
      action_board: "action_board",
      health_check: "health_check",
      context_pack_review: "context_pack_review",
      governance: "governance"
    }
  };
}

function governanceItemId(source: DashboardGovernanceSource, id: string): string {
  return `${source}:${id}`;
}

function governanceDetectionLabel(source: DashboardGovernanceSource, category: DashboardGovernanceCategory): string {
  if (source === "capture_policy") {
    if (category === "capture_review") return "Some captured records are waiting for a human decision.";
    if (category === "auto_capture") return "Captured handoff records already handled by policy.";
    if (category === "policy_archive") return "Captured records were archived by policy.";
  }
  if (source === "memory_doctor") return "Candidate records are accumulating faster than canonical records.";
  if (source === "memory_lifecycle") return "Memory lifecycle found records worth inspecting.";
  if (source === "maintenance") return "A maintenance plan is ready for explicit review.";
  if (source === "recall_eval") return "Recall eval found a golden case that normal recall missed.";
  return "Dogfood notes surfaced product friction worth inspecting.";
}

function governanceWriteBoundary(item: Pick<DashboardGovernanceItem, "requires_user_confirmation" | "writes">): string {
  if (item.requires_user_confirmation) {
    return "requires explicit approval before append-only memory events.";
  }
  if (item.writes === "none") return "read-only inspection; no memory writes.";
  return "append-only memory events only after explicit approval.";
}

function governanceReviewLog(input: {
  source: DashboardGovernanceSource;
  category: DashboardGovernanceCategory;
  actionLabel: string;
  evidencePath: string;
  requiresUserConfirmation: boolean;
  writes: DashboardActionWriteBehavior;
}): string[] {
  return [
    `Detected: ${governanceDetectionLabel(input.source, input.category)}`,
    `Recommended next step: ${input.actionLabel}.`,
    `Write boundary: ${governanceWriteBoundary({
      requires_user_confirmation: input.requiresUserConfirmation,
      writes: input.writes
    })}`,
    `Evidence source: ${input.evidencePath}`
  ];
}

function firstActionForRecords<T extends { action_id: string; arguments: Record<string, unknown> }>(actions: T[], recordIds: string[]): T | undefined {
  const recordIdSet = new Set(recordIds);
  return actions.find((action) => {
    const recordId = action.arguments.record_id;
    if (typeof recordId === "string" && recordIdSet.has(recordId)) return true;
    const recordIdsArg = action.arguments.record_ids;
    return Array.isArray(recordIdsArg) && recordIdsArg.some((candidate) => typeof candidate === "string" && recordIdSet.has(candidate));
  });
}

function governanceFromCapturePolicy(report: CapturePolicyResult): DashboardGovernanceItem[] {
  return report.findings.map((finding): DashboardGovernanceItem => {
    const firstAction = firstActionForRecords(report.suggested_actions, finding.record_ids);
    const isReview = finding.id === "review_required";
    const category = finding.category === "review_queue" ? "capture_review" : finding.category;
    const evidencePath = `capture_policy.findings_by_id.${finding.id}`;
    const actionLabel = isReview ? "Review in Capture Inbox" : firstAction?.recommended_action ?? "Inspect capture policy finding";
    const writes = isReview ? "append_only_events" : "none";
    return {
      id: governanceItemId("capture_policy", finding.id),
      source: "capture_policy",
      category,
      severity: finding.severity,
      title: finding.summary,
      summary: finding.reason,
      record_ids: finding.record_ids,
      evidence_path: evidencePath,
      action_label: actionLabel,
      ...(firstAction && !isReview ? { action_id: capturePolicyInspectActionId(String(firstAction.arguments.record_id)) } : {}),
      safe_to_run: !isReview,
      requires_user_confirmation: isReview,
      writes,
      review_log: governanceReviewLog({
        source: "capture_policy",
        category,
        actionLabel,
        evidencePath,
        requiresUserConfirmation: isReview,
        writes
      })
    };
  });
}

function governanceFromMemoryLifecycle(report: MemoryLifecycleResult): DashboardGovernanceItem[] {
  return report.findings.map((finding): DashboardGovernanceItem => {
    const firstAction = firstActionForRecords(report.suggested_actions, finding.record_ids);
    const requiresUserConfirmation = firstAction?.safe_to_run === false;
    const evidencePath = `memory_lifecycle.findings_by_id.${finding.id}`;
    const actionLabel = firstAction?.recommended_action ?? "Inspect lifecycle finding";
    const writes = requiresUserConfirmation ? "append_only_events" : "none";
    return {
      id: governanceItemId("memory_lifecycle", finding.id),
      source: "memory_lifecycle",
      category: "memory_lifecycle",
      severity: finding.severity,
      title: finding.summary,
      summary: finding.reason,
      record_ids: finding.record_ids,
      evidence_path: evidencePath,
      action_label: actionLabel,
      safe_to_run: firstAction?.safe_to_run ?? true,
      requires_user_confirmation: requiresUserConfirmation,
      writes,
      review_log: governanceReviewLog({
        source: "memory_lifecycle",
        category: "memory_lifecycle",
        actionLabel,
        evidencePath,
        requiresUserConfirmation,
        writes
      })
    };
  });
}

function governanceFromMemoryDoctor(report: MemoryDoctorResult): DashboardGovernanceItem[] {
  const finding = report.findings_by_id.candidate_backlog;
  if (!finding) return [];
  const evidencePath = "memory_doctor.findings_by_id.candidate_backlog";
  const actionLabel = "Review candidate backlog";
  return [{
    id: governanceItemId("memory_doctor", finding.id),
    source: "memory_doctor",
    category: "candidate_backlog",
    severity: finding.severity,
    title: finding.summary,
    summary: finding.reason,
    record_ids: finding.record_ids ?? (finding.record_id ? [finding.record_id] : []),
    evidence_path: evidencePath,
    action_label: actionLabel,
    safe_to_run: true,
    requires_user_confirmation: false,
    writes: "none",
    review_log: governanceReviewLog({
      source: "memory_doctor",
      category: "candidate_backlog",
      actionLabel,
      evidencePath,
      requiresUserConfirmation: false,
      writes: "none"
    })
  }];
}

function governanceFromMaintenance(maintenance: DashboardMaintenanceData): DashboardGovernanceItem[] {
  return maintenance.plans
    .filter((plan) => !plan.approval.requires_user_confirmation)
    .map((plan): DashboardGovernanceItem => {
    const evidencePath = `maintenance.plans_by_id.${plan.plan_id}`;
    const actionLabel = maintenancePrimaryActionLabel(plan);
    return {
      id: governanceItemId("maintenance", plan.plan_id),
      source: "maintenance",
      category: plan.type === "candidate_noise_archive" ? "candidate_backlog" : "project_identity",
      severity: "warning",
      title: plan.decision_card.issue,
      summary: plan.decision_card.impact,
      record_ids: plan.record_ids,
      evidence_path: evidencePath,
      action_label: actionLabel,
      action_id: maintenanceApproveActionId(plan),
      safe_to_run: false,
      requires_user_confirmation: true,
      writes: "append_only_events",
      review_log: governanceReviewLog({
        source: "maintenance",
        category: plan.type === "candidate_noise_archive" ? "candidate_backlog" : "project_identity",
        actionLabel,
        evidencePath,
        requiresUserConfirmation: true,
        writes: "append_only_events"
      })
    };
  });
}

function governanceFromDogfood(report: DogfoodReportResult): DashboardGovernanceItem[] {
  return report.findings.map((finding): DashboardGovernanceItem => {
    const recordIds = finding.record_ids ?? (finding.record_id ? [finding.record_id] : []);
    const firstAction = finding.id === "capture_review_backlog"
      ? report.suggested_actions_by_id.review_capture_inbox
      : firstActionForRecords(report.suggested_actions, recordIds);
    const evidencePath = `dogfood_report.findings_by_id.${finding.id}`;
    const actionLabel = firstAction?.recommended_action ?? "Inspect dogfood finding";
    return {
      id: governanceItemId("dogfood_report", finding.id),
      source: "dogfood_report",
      category: "dogfood_friction",
      severity: finding.severity,
      title: finding.summary,
      summary: finding.reason,
      record_ids: recordIds,
      evidence_path: evidencePath,
      action_label: actionLabel,
      safe_to_run: firstAction?.safe_to_run ?? true,
      requires_user_confirmation: false,
      writes: "none",
      review_log: governanceReviewLog({
        source: "dogfood_report",
        category: "dogfood_friction",
        actionLabel,
        evidencePath,
        requiresUserConfirmation: false,
        writes: "none"
      })
    };
  });
}

function governanceFromRecallEval(review: DashboardRecallEval): DashboardGovernanceItem[] {
  const report = review.report;
  if (!report) return [];
  return report.cases.filter((testCase) => testCase.status === "fail").map((testCase): DashboardGovernanceItem => {
    const action = report.suggested_actions_by_id[`revise-golden-case:${testCase.case_id}`];
    const evidencePath = `recall_eval.report.cases_by_id.${testCase.case_id}`;
    const actionLabel = action?.recommended_action ?? "Inspect recall eval case";
    return {
      id: governanceItemId("recall_eval", testCase.case_id),
      source: "recall_eval",
      category: "recall_quality",
      severity: "warning",
      title: `Recall eval missed ${testCase.case_id}`,
      summary: `Query "${testCase.query}" missed ${pluralize(testCase.missing_record_ids.length, "expected record")}.`,
      record_ids: testCase.missing_record_ids,
      evidence_path: evidencePath,
      action_label: actionLabel,
      safe_to_run: true,
      requires_user_confirmation: false,
      writes: "none",
      review_log: governanceReviewLog({
        source: "recall_eval",
        category: "recall_quality",
        actionLabel,
        evidencePath,
        requiresUserConfirmation: false,
        writes: "none"
      })
    };
  });
}

function isCandidateTriageNoise(record: MorynRecord): boolean {
  const searchable = `${record.tags.join(" ")} ${record.type} ${recordText(record)}`.toLowerCase();
  return /\b(smoke|test|fixture|e2e|marker)\b/.test(searchable);
}

function isCandidateTriagePromotable(record: MorynRecord): boolean {
  if (record.kind !== "memory") return false;
  if (record.provenance?.method === "user-confirmed" || record.source.client === "user") return true;
  return record.type === "rule" && record.priority === "high" && record.confidence >= 0.9;
}

function toCandidateTriageRecord(
  record: MorynRecord,
  eventsByRecord: Map<string, MorynEvent>,
  nowIso: string,
  reason: string
): DashboardCandidateTriageRecord {
  return {
    id: record.id,
    kind: record.kind,
    type: record.type,
    text: recordText(record),
    source_label: humanSourceLabel(record.source),
    source_detail: humanSourceDetail(record.source),
    relative_time: relativeTime(record.updated_at, nowIso),
    exact_time: record.updated_at,
    priority: record.priority,
    confidence: record.confidence,
    reason,
    citation: recordCitation(record, eventsByRecord)
  };
}

function candidateTriagePromotionDraft(groupId: "promotable", record: DashboardCandidateTriageRecord): DashboardCandidateTriagePromotionDraft {
  const args = {
    record_id: record.id,
    target_state: "canonical",
    reason: CANDIDATE_TRIAGE_PROMOTION_REASON
  } as const;
  return {
    record_id: record.id,
    target_state: "canonical",
    reason: CANDIDATE_TRIAGE_PROMOTION_REASON,
    command: `${commandForPromoteContext(args)} --confirm`,
    requires_user_confirmation: true,
    writes: "append_only_events",
    source_path: `candidate_triage.groups_by_id.${groupId}.promotion_drafts_by_id.${record.id}`,
    approve_endpoint: candidateTriagePromotionApproveEndpoint(record.id),
    action_id: candidateTriagePromotionApproveActionId(record.id)
  };
}

function toCandidateTriageGroup(input: {
  id: DashboardCandidateTriageGroupId;
  label: string;
  description: string;
  recommended_next_step: string;
  review_handoff: DashboardCandidateTriageReviewHandoff;
  records: DashboardCandidateTriageRecord[];
}): DashboardCandidateTriageGroup {
  const sampleRecords = input.records.slice(0, CANDIDATE_TRIAGE_SAMPLE_LIMIT);
  const promotionDrafts = input.id === "promotable"
    ? Object.fromEntries(input.records.map((record) => [record.id, candidateTriagePromotionDraft("promotable", record)]))
    : {};
  return {
    ...input,
    records: sampleRecords,
    writes: "none",
    requires_user_confirmation: false,
    record_ids: input.records.map((record) => record.id),
    records_by_id: Object.fromEntries(input.records.map((record, index) => [record.id, {
      id: record.id,
      record_index: index,
      evidence_path: index < CANDIDATE_TRIAGE_SAMPLE_LIMIT
        ? `candidate_triage.groups_by_id.${input.id}.records[${index}]`
        : `candidate_triage.groups_by_id.${input.id}.record_ids[${index}]`
    }])),
    promotion_drafts_by_id: promotionDrafts,
    evidence_path: `candidate_triage.groups_by_id.${input.id}`
  };
}

function toCandidateTriageGroupSummary(group: DashboardCandidateTriageGroup): DashboardCandidateTriageGroupSummary {
  return {
    id: group.id,
    label: group.label,
    recommended_next_step: group.recommended_next_step,
    writes: group.writes,
    requires_user_confirmation: group.requires_user_confirmation,
    record_ids: group.record_ids,
    evidence_path: group.evidence_path
  };
}

function buildCandidateTriage(
  records: MorynRecord[],
  eventsByRecord: Map<string, MorynEvent>,
  nowIso: string,
  limit: number
): DashboardCandidateTriage {
  const candidateRecords = records
    .filter((record) => record.state === "candidate" && record.visibility === "active")
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  const grouped = new Set<string>();
  const takeGroup = (
    predicate: (record: MorynRecord) => boolean,
    reason: string
  ): DashboardCandidateTriageRecord[] => {
    const group = candidateRecords
      .filter((record) => !grouped.has(record.id))
      .filter(predicate)
      .slice(0, limit)
      .map((record) => toCandidateTriageRecord(record, eventsByRecord, nowIso, reason));
    for (const record of group) grouped.add(record.id);
    return group;
  };

  const likelyNoise = takeGroup(
    isCandidateTriageNoise,
    "Matches smoke, test, fixture, e2e, or marker language."
  );
  const promotable = takeGroup(
    isCandidateTriagePromotable,
    "Looks durable enough for promotion review, but still needs explicit user approval."
  );
  const sessionSummaries = takeGroup(
    (record) => record.kind === "session_summary",
    "Session summary candidate; inspect whether it should remain handoff context or become canonical memory."
  );
  const needsInspection = takeGroup(
    () => true,
    "No automatic bucket matched; inspect before deciding whether to keep, archive, revise, or promote."
  );

  const groups = [
    toCandidateTriageGroup({
      id: "likely_noise",
      label: "Likely noise",
      description: "Candidates that look like smoke/test output or marker records.",
      recommended_next_step: "Inspect likely noise before archive",
      review_handoff: {
        label: "Archive review",
        existing_control: "Capture Inbox or Memory Doctor",
        guidance: "Reject eligible Capture Inbox candidates; archive confirmed noise only through explicit Memory Doctor guidance.",
        write_boundary: "Review first; approve only through draft rows"
      },
      records: likelyNoise
    }),
    toCandidateTriageGroup({
      id: "promotable",
      label: "Promotable candidates",
      description: "High-confidence candidate memories that may deserve explicit promotion.",
      recommended_next_step: "Inspect before promotion",
      review_handoff: {
        label: "Approval review",
        existing_control: "Capture Inbox",
        guidance: "Approve eligible Capture Inbox candidates only after checking provenance and record text.",
        write_boundary: "Review first; approve only through draft rows"
      },
      records: promotable
    }),
    toCandidateTriageGroup({
      id: "session_summaries",
      label: "Session summaries",
      description: "Agent handoff summaries that may be useful context but are not automatically canonical.",
      recommended_next_step: "Inspect handoff value",
      review_handoff: {
        label: "Handoff review",
        existing_control: "Capture Inbox or timeline",
        guidance: "Keep useful handoff summaries available for context; promote only when they describe durable memory.",
        write_boundary: "Review first; approve only through draft rows"
      },
      records: sessionSummaries
    }),
    toCandidateTriageGroup({
      id: "needs_inspection",
      label: "Needs inspection",
      description: "Remaining candidate records that need a human read before any lifecycle decision.",
      recommended_next_step: "Inspect timeline",
      review_handoff: {
        label: "Inspection review",
        existing_control: "Timeline, recall, or Capture Inbox",
        guidance: "Use the trace commands first; decide later through an existing explicit review surface.",
        write_boundary: "Review first; approve only through draft rows"
      },
      records: needsInspection
    })
  ].filter((group) => group.records.length > 0);

  return {
    read_only: true,
    version: 1,
    available: groups.length > 0,
    generated_from: {
      store: "local_event_history",
      writes: "none",
      sync_pull: false
    },
    summary: {
      total_candidates: candidateRecords.length,
      groups: groups.length,
      likely_noise: likelyNoise.length,
      promotable: promotable.length,
      session_summaries: sessionSummaries.length,
      needs_inspection: needsInspection.length,
      shown_records: groups.reduce((total, group) => total + group.records.length, 0)
    },
    groups: groups.map(toCandidateTriageGroupSummary),
    groups_by_id: Object.fromEntries(groups.map((group) => [group.id, group])),
    selection_sources: DASHBOARD_CANDIDATE_TRIAGE_SELECTION_SOURCES
  };
}

async function buildDashboardRecallEval(
  storePath: string,
  records: MorynRecord[],
  options: DashboardOptions
): Promise<DashboardRecallEval> {
  const caseRecords = records
    .filter((record) => record.visibility === "active")
    .filter((record) => recordProjectMatchesDashboard(record, options.project_id))
    .filter(isRecallEvalCaseRecord)
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
  const caseSources = caseRecords
    .map((record): DashboardRecallEvalCaseSource => ({
      record_id: record.id,
      case_count: recallEvalRecordCases(record).length,
      evidence_path: `recent_records.${record.id}.content.cases`
    }))
    .filter((source) => source.case_count > 0);
  const cases = caseRecords.flatMap(recallEvalRecordCases);
  const base = {
    generated_from: {
      store: "local_event_history" as const,
      writes: "none" as const,
      sync_pull: false as const
    },
    case_sources: caseSources,
    selection_sources: DASHBOARD_RECALL_EVAL_SELECTION_SOURCES
  };

  if (cases.length === 0) {
    return {
      available: false,
      ...(options.project_id ? { project_id: options.project_id } : {}),
      unavailable_reason: "No active recall_eval_case records found for this dashboard scope.",
      ...base,
      report: null,
      errors: []
    };
  }

  try {
    const engine = createEngine({ storePath });
    const report = await engine.recallEval({
      project_id: options.project_id,
      include_private: options.include_private === true,
      cases
    });
    return {
      available: true,
      ...(options.project_id ? { project_id: options.project_id } : {}),
      ...base,
      report,
      errors: []
    };
  } catch (error) {
    return {
      available: false,
      ...(options.project_id ? { project_id: options.project_id } : {}),
      unavailable_reason: "Stored recall eval cases could not be evaluated.",
      ...base,
      report: null,
      errors: [{ reason: error instanceof Error ? error.message : String(error) }]
    };
  }
}

function buildDashboardGovernance(input: {
  capturePolicy: CapturePolicyResult;
  memoryDoctor: MemoryDoctorResult;
  memoryLifecycle: MemoryLifecycleResult;
  maintenance: DashboardMaintenanceData;
  recallEval: DashboardRecallEval;
  dogfoodReport?: DogfoodReportResult;
  hiddenPrivateRecords: number;
}): DashboardGovernance {
  const items: DashboardGovernanceItem[] = [
    ...governanceFromCapturePolicy(input.capturePolicy),
    ...governanceFromMemoryDoctor(input.memoryDoctor),
    ...governanceFromMemoryLifecycle(input.memoryLifecycle),
    ...governanceFromMaintenance(input.maintenance),
    ...governanceFromRecallEval(input.recallEval),
    ...(input.dogfoodReport ? governanceFromDogfood(input.dogfoodReport) : [])
  ];
  return {
    read_only: true,
    version: 1,
    scope: "local_dashboard",
    summary: {
      total_items: items.length,
      needs_user_action: items.filter((item) => item.requires_user_confirmation).length,
      safe_inspections: items.filter((item) => item.safe_to_run && item.writes === "none").length,
      hidden_private_records: input.hiddenPrivateRecords
    },
    sources: {
      capture_policy: true,
      memory_doctor: true,
      memory_lifecycle: true,
      maintenance: true,
      recall_eval: input.recallEval.available,
      dogfood_report: input.dogfoodReport !== undefined
    },
    items,
    items_by_id: Object.fromEntries(items.map((item) => [item.id, item])),
    selection_sources: DASHBOARD_GOVERNANCE_SELECTION_SOURCES
  };
}

export async function buildDashboardData(storePath: string, options: DashboardOptions = {}): Promise<DashboardData> {
  const limit = dashboardLimit(options.limit);
  const events = await readEvents(storePath);
  const allRecordsById = replayEvents(events);
  const allRecords = [...allRecordsById.values()];
  const records = allRecords.filter((record) => isVisibleForDashboard(record, options.include_private));
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const visibleRecordIds = new Set(records.map((record) => record.id));
  const visibleEvents = events.filter((event) => {
    const recordId = targetRecordId(event);
    return !recordId || visibleRecordIds.has(recordId);
  });
  const eventsByRecord = latestEventsByRecord(visibleEvents);
  const recentRecords = [...records]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
    .slice(0, limit);
  const recentEvents = [...visibleEvents]
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.event_id.localeCompare(right.event_id))
    .slice(0, limit);
  const generatedAt = options.now ?? new Date().toISOString();
  const sync = await getGitSyncStatus(storePath);
  const agentActivity = summarizeAgentActivity(visibleEvents, records, recordsById, eventsByRecord);
  const lifecycleAllRecords = allRecords.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
  const lifecycleRecords = lifecycleAllRecords.filter((record) => isVisibleForDashboard(record, options.include_private));
  const capturePolicyAllRecords = allRecords.filter((record) => {
    return !options.project_id || record.project_id === options.project_id;
  });
  const capturePolicyRecords = capturePolicyAllRecords.filter((record) => isVisibleForDashboard(record, options.include_private));
  const captureInboxData = buildCaptureInbox(records, generatedAt, limit, eventsByRecord);
  const contextPackReviewData = buildContextPackReview(records, options);
  const capturePolicyData = diagnoseCapturePolicy({
    records: capturePolicyRecords,
    events: visibleEvents,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: capturePolicyAllRecords.length - capturePolicyRecords.length
  });
  const maintenanceData = buildDashboardMaintenance(allRecords, {
    project_id: options.project_id,
    include_private: options.include_private
  });
  const memoryLifecycleData = diagnoseMemoryLifecycle({
    records: lifecycleRecords,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    now: generatedAt,
    private_record_ids: lifecycleAllRecords.filter(isPrivateRecord).map((record) => record.id),
    excluded_private_records: lifecycleAllRecords.length - lifecycleRecords.length
  });
  const memoryDoctorAllRecords = allRecords.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
  const memoryDoctorRecords = memoryDoctorAllRecords.filter((record) => isVisibleForDashboard(record, options.include_private));
  const memoryDoctorData = diagnoseMemory({
    records: memoryDoctorRecords,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: memoryDoctorAllRecords.length - memoryDoctorRecords.length
  });
  const candidateTriageData = buildCandidateTriage(memoryDoctorRecords, eventsByRecord, generatedAt, limit);
  const dogfoodAllRecords = allRecords.filter((record) => recordProjectMatchesDogfood(record, options.project_id));
  const dogfoodRecords = dogfoodAllRecords.filter((record) => isVisibleForDashboard(record, options.include_private));
  const dogfoodRecordIds = new Set(dogfoodRecords.map((record) => record.id));
  const dogfoodEvents = events.filter((event) => {
    const recordId = targetRecordId(event);
    return !recordId || dogfoodRecordIds.has(recordId);
  });
  const dogfoodReportData = diagnoseDogfood({
    records: dogfoodRecords,
    events: dogfoodEvents,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: dogfoodAllRecords.length - dogfoodRecords.length
  });
  const healthCheckAllRecords = allRecords.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
  const healthCheckRecords = healthCheckAllRecords.filter((record) => isVisibleForDashboard(record, options.include_private));
  const healthCheckRecordIds = new Set(healthCheckRecords.map((record) => record.id));
  const healthCheckEvents = events.filter((event) => {
    const recordId = targetRecordId(event);
    return !recordId || healthCheckRecordIds.has(recordId);
  });
  const healthCheckData = diagnoseHealthCheck({
    records: healthCheckRecords,
    events: healthCheckEvents,
    project_id: options.project_id,
    host: options.readiness_host,
    sync_remote: options.sync_remote,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: healthCheckAllRecords.length - healthCheckRecords.length
  });
  const recallEvalData = await buildDashboardRecallEval(storePath, records, options);
  const actions = dashboardActions({
    captureInbox: captureInboxData,
    capturePolicy: capturePolicyData,
    maintenance: maintenanceData,
    candidateTriage: candidateTriageData
  });
  const decisionSummaryData = buildDecisionSummary({
    captureInbox: captureInboxData,
    maintenance: maintenanceData,
    candidateTriage: candidateTriageData
  });
  const health = buildHealth(sync, records, generatedAt);
  const attentionItems = buildAttentionItems(sync, records);
  const governance = buildDashboardGovernance({
    capturePolicy: capturePolicyData,
    memoryDoctor: memoryDoctorData,
    memoryLifecycle: memoryLifecycleData,
    maintenance: maintenanceData,
    recallEval: recallEvalData,
    dogfoodReport: dogfoodReportData,
    hiddenPrivateRecords: lifecycleAllRecords.length - lifecycleRecords.length
  });
  const actionBoardData = buildActionBoard({
    decisionSummary: decisionSummaryData,
    attentionItems,
    governance,
    sync,
    health
  });
  const dashboardOverviewData = buildDashboardOverview({
    actionBoard: actionBoardData,
    health,
    contextPackReview: contextPackReviewData
  });

  return {
    generated_at: generatedAt,
    store: {
      path: storePath
    },
    sync,
    health,
    attention_items: attentionItems,
    dashboard_overview: dashboardOverviewData,
    action_board: actionBoardData,
    decision_summary: decisionSummaryData,
    charts: {
      agent_activity: buildAgentChart(agentActivity, generatedAt),
      memory_states: buildMemoryStateChart(records),
      record_types: buildRecordTypeChart(records),
      sync_position: buildSyncPositionChart(sync)
    },
    totals: {
      events: visibleEvents.length,
      records: records.length,
      active_records: records.filter((record) => record.visibility === "active").length,
      quarantined_records: records.filter((record) => record.visibility === "quarantined").length
    },
    actions,
    actions_by_id: actionsById(actions),
    context_pack_review: contextPackReviewData,
    governance,
    recall_eval: recallEvalData,
    capture_inbox: captureInboxData,
    capture_policy: capturePolicyData,
    memory_doctor: memoryDoctorData,
    candidate_triage: candidateTriageData,
    health_check: healthCheckData,
    memory_lifecycle: memoryLifecycleData,
    dogfood_report: dogfoodReportData,
    recent_value: buildRecentValue(records, generatedAt, Math.min(limit, RECENT_VALUE_LIMIT), eventsByRecord),
    recent_records: recentRecords.map((record) => summarizeRecord(record, eventsByRecord)),
    recent_events: recentEvents.map((event) => summarizeEvent(event, recordsById)),
    agent_activity: agentActivity,
    maintenance: maintenanceData,
    selection_sources: DASHBOARD_SELECTION_SOURCES
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function statusClass(sync: GitSyncStatus): string {
  if (sync.sync_state === "clean") return "good";
  if (sync.sync_state === "conflict") return "critical";
  if (sync.sync_state === "dirty") return "warning";
  return sync.configured ? "info" : "muted";
}

function syncLabel(sync: GitSyncStatus): string {
  if (sync.sync_state === "dirty") return "Local changes";
  if (sync.sync_state) return titleCase(sync.sync_state);
  return sync.configured ? "Configured" : "Not configured";
}

function syncPositionLabel(sync: DashboardSyncPositionChart): string {
  if (sync.state === "dirty") return "Local Changes";
  return titleCase(sync.state);
}

function shortText(text: string): string {
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function textExcerpt(text: string, limit = DASHBOARD_TEXT_EXCERPT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const clipped = text.slice(0, limit).replace(/\s+\S*$/, "").trim();
  return {
    text: `${clipped || text.slice(0, limit).trim()}...`,
    truncated: true
  };
}

function textExcerptBlock(text: string, truncatedAttribute = "data-full-text-hidden"): string {
  const excerpt = textExcerpt(text);
  return `
    <p${excerpt.truncated ? ` ${truncatedAttribute}="true"` : ""}>${escapeHtml(excerpt.text)}</p>
    ${excerpt.truncated ? `<small>Full text available through timeline/recall.</small>` : ""}
  `;
}

function recordLabel(recordId: string): string {
  const generated = recordId.match(/^rec_[0-9a-f]{16,}$/i);
  if (!generated) return recordId;
  return recordId.slice(0, 12);
}

function isReadOnlyInspectActionBoardItem(item: DashboardActionBoardItem): boolean {
  return item.id === "inspect" && item.severity === "info";
}

function isActiveActionBoardItem(item: DashboardActionBoardItem): boolean {
  if (isReadOnlyInspectActionBoardItem(item)) return false;
  return item.value > 0 || item.severity !== "good";
}

function isDuplicatedDecisionShortcut(item: DashboardActionBoardItem): boolean {
  return item.id === "confirm" && item.value > 0;
}

function actionBoardItemButton(item: DashboardActionBoardItem, dataAttribute = "data-action-board-item"): string {
  const hint = item.hint === item.next_action_label ? "" : `<small>${escapeHtml(item.hint)}</small>`;
  return `
    <button type="button" class="action-board-item ${escapeHtml(item.severity)}" ${dataAttribute}="${escapeHtml(item.id)}" data-action-board-target="${escapeHtml(item.target)}" aria-controls="${escapeHtml(item.target)}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <p>${escapeHtml(item.summary)}</p>
      ${hint}
      <em class="action-board-next">${escapeHtml(item.next_action_label)}</em>
    </button>
  `;
}

function actionBoardQuietTargets(items: DashboardActionBoardItem[]): string {
  if (items.length === 0) return "";
  return `
    <details class="action-board-quiet" data-dashboard-detail="action-board-quiet-targets">
      <summary class="dashboard-fold-summary action-board-quiet-fold">
        <span>Quiet Shortcuts</span>
        <small>Background section links</small>
      </summary>
      <div class="action-board-quiet-list">
        ${items.map((item) => actionBoardItemButton(item, "data-action-board-quiet-item")).join("")}
      </div>
    </details>
  `;
}

function actionBoard(data: DashboardActionBoard): string {
  const shortcutItems = data.items.filter((item) => !isDuplicatedDecisionShortcut(item));
  const activeItems = shortcutItems.filter(isActiveActionBoardItem);
  const quietItems = shortcutItems.filter((item) => !isActiveActionBoardItem(item));
  if (activeItems.length === 1) return "";
  const quietTargets = activeItems.length === 0 ? actionBoardQuietTargets(quietItems) : "";
  return `
    <details class="action-board action-board-secondary" aria-label="Page Shortcuts" data-dashboard-detail="action-board" data-action-board-nav>
      <summary class="dashboard-fold-summary action-board-fold">
        <span>Page Shortcuts</span>
        <small>Optional section links</small>
      </summary>
      ${activeItems.length === 0 ? "" : `
        <div class="action-board-grid">
          ${activeItems.map((item) => actionBoardItemButton(item)).join("")}
        </div>
      `}
      ${quietTargets}
    </details>
  `;
}

function focusBriefPrimaryItem(actionBoardData: DashboardActionBoard): DashboardActionBoardItem {
  const priority = ["confirm", "review", "sync"] as const;
  const inspectCount = actionBoardData.items_by_id.inspect.value;
  return priority
    .map((id) => actionBoardData.items_by_id[id])
    .find((item) => item.value > 0 && item.severity !== "good")
    ?? {
      ...actionBoardData.items_by_id.inspect,
      value: 0,
      severity: "good",
      summary: inspectCount > 0 ? `${pluralize(inspectCount, "safe check")} available` : "No action needed",
      hint: "No action needed",
      detail: "No confirmations, warnings, or sync actions need attention. Read-only inspections remain available below.",
      next_action_label: "All clear",
      target: inspectCount > 0 ? "governance-hub" : "needs-attention"
    };
}

function isPrimaryDashboardOverviewCard(card: DashboardOverviewCard, data: DashboardOverview): boolean {
  return card.source === data.primary_action.source;
}

function dashboardOverviewCardButton(card: DashboardOverviewCard, dataAttribute = "data-dashboard-overview-card"): string {
  return `
          <button type="button" class="dashboard-overview-card ${escapeHtml(card.severity)}" ${dataAttribute}="${escapeHtml(card.id)}" data-action-board-target="${escapeHtml(card.target)}" aria-controls="${escapeHtml(card.target)}" data-dashboard-overview-source="${escapeHtml(card.source)}">
            <span>${escapeHtml(card.label)}</span>
            <strong>${escapeHtml(card.value)}</strong>
            <p>${escapeHtml(card.summary)}</p>
            <small>${escapeHtml(card.target_label)}</small>
          </button>
        `;
}

function dashboardOverviewQuietCards(cards: DashboardOverviewCard[]): string {
  if (cards.length === 0) return "";
  return `
      <details class="dashboard-overview-quiet" data-dashboard-detail="dashboard-overview-quiet-cards">
        <summary class="dashboard-fold-summary dashboard-overview-quiet-fold" aria-label="Background Status: Healthy signals kept for context">
          <span>Background Status</span>
          <small>Signals ready</small>
        </summary>
        <div class="dashboard-overview-quiet-list">
          ${cards.map((card) => dashboardOverviewCardButton(card, "data-dashboard-overview-quiet-card")).join("")}
        </div>
      </details>
  `;
}

function joinHumanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function dashboardOverview(
  data: DashboardOverview,
  options: { showBackgroundStatus?: boolean } = {}
): string {
  const visibleCards = data.cards.filter((card) => !isPrimaryDashboardOverviewCard(card, data));
  const showBackgroundStatus = options.showBackgroundStatus ?? true;
  return `
    <section class="dashboard-overview ${escapeHtml(data.status)}" data-dashboard-overview aria-label="Dashboard Overview">
      <div class="dashboard-overview-main">
        <div>
          <h2>Dashboard Overview</h2>
          <strong>${escapeHtml(data.headline)}</strong>
          <p>${escapeHtml(data.detail)}</p>
        </div>
        <button type="button" class="dashboard-overview-action" data-action-board-target="${escapeHtml(data.primary_action.target)}" aria-controls="${escapeHtml(data.primary_action.target)}">${escapeHtml(data.primary_action.label)}</button>
      </div>
      ${showBackgroundStatus ? dashboardOverviewQuietCards(visibleCards) : ""}
      <div class="dashboard-overview-safety" aria-label="Dashboard safety">
        <span>Read-only overview</span>
        <span>Writes stay in ${escapeHtml(joinHumanList(data.safety.mutation_surfaces))}</span>
      </div>
    </section>
  `;
}

function workLaneButton(input: {
  id: "decide" | "context" | "health" | "evidence";
  label: string;
  summary: string;
  nextStep: string;
  target: string;
  severity: DashboardActionBoardSeverity;
}, dataAttribute = "data-dashboard-work-lane"): string {
  return `
        <button type="button" class="dashboard-work-lane ${escapeHtml(input.severity)}" ${dataAttribute}="${escapeHtml(input.id)}" data-action-board-target="${escapeHtml(input.target)}" aria-controls="${escapeHtml(input.target)}">
          <span>${escapeHtml(input.label)}</span>
          <strong>${escapeHtml(input.summary)}</strong>
          <em>${escapeHtml(input.nextStep)}</em>
        </button>
  `;
}

function dashboardHealthWorkLaneItem(board: DashboardActionBoard): DashboardActionBoardItem {
  const review = board.items_by_id.review;
  const sync = board.items_by_id.sync;
  if (review.value === 0 && sync.value > 0) return sync;
  if (review.detail === "Sync changes are the only warning signal in Needs Attention.") return sync;
  return review;
}

function dashboardEvidenceLibrarySummary(data: DashboardData): { summary: string; hasFindings: boolean } {
  const reviewPanelCount = [
    isRoutineHealthCheck(data.health_check) ? undefined : "health",
    isRoutineRecallEval(data.recall_eval) ? undefined : "recall",
    data.dogfood_report.findings.length > 0 ? "dogfood" : undefined,
    data.governance.summary.total_items > 0 ? "governance" : undefined,
    data.candidate_triage.available ? "candidate-triage" : undefined,
    isRoutineContextPackReview(data.context_pack_review) ? undefined : "context"
  ].filter((panel): panel is string => panel !== undefined).length;
  const backgroundPanelCount = [
    "routine-diagnostics",
    "supporting-evidence"
  ].length;
  return {
    summary: evidenceLibrarySummary(reviewPanelCount > 0 ? 1 : 0, backgroundPanelCount > 0 ? 1 : 0),
    hasFindings: reviewPanelCount > 0
  };
}

function dashboardWorkLanes(
  data: DashboardData,
  options: { showBackgroundLanes?: boolean } = {}
): string {
  const confirm = data.action_board.items_by_id.confirm;
  const healthLane = dashboardHealthWorkLaneItem(data.action_board);
  const evidence = dashboardEvidenceLibrarySummary(data);
  const showBackgroundLanes = options.showBackgroundLanes ?? true;
  const contextSummary = data.context_pack_review.available
    ? contextPackReviewSummary(data.context_pack_review)
    : "Context unavailable";
  const lanes = [
    {
      id: "decide" as const,
      label: "Decide",
      summary: confirm.summary,
      nextStep: confirm.value > 0 ? confirm.next_action_label : "Inspect decision surfaces",
      target: confirm.target,
      severity: confirm.severity
    },
    {
      id: "context" as const,
      label: "Context",
      summary: contextSummary,
      nextStep: "Open handoff review",
      target: "context-pack-review",
      severity: overviewContextStatus(data.context_pack_review)
    },
    {
      id: "health" as const,
      label: "Health",
      summary: healthLane.summary,
      nextStep: healthLane.next_action_label,
      target: healthLane.target,
      severity: healthLane.severity
    },
    {
      id: "evidence" as const,
      label: "Evidence",
      summary: evidence.summary,
      nextStep: "Open read-only evidence",
      target: "evidence-library",
      severity: evidence.hasFindings ? "info" as const : "good" as const
    }
  ];
  const activeLanes = lanes.filter((lane) => lane.severity === "warning" || lane.severity === "critical");
  const defaultLanes = activeLanes;
  const backgroundLanes = lanes.filter((lane) => !activeLanes.includes(lane));
  const backgroundLaneNames = backgroundLanes.map((lane) => lane.label);
  const backgroundLaneSummary = backgroundLaneNames.length <= 1
    ? `${backgroundLaneNames.join("")} is quiet`
    : `${backgroundLaneNames.slice(0, -1).join(", ")}, and ${backgroundLaneNames.at(-1)} are quiet`;
  return `
    <section class="dashboard-work-lanes" data-dashboard-work-lanes aria-label="Dashboard Work Lanes">
      ${defaultLanes.map((lane) => workLaneButton(lane)).join("")}
      ${!showBackgroundLanes || backgroundLanes.length === 0 ? "" : `
        <details class="dashboard-work-lanes-quiet" data-dashboard-detail="dashboard-work-lanes-background">
          <summary class="dashboard-fold-summary dashboard-work-lanes-quiet-fold" aria-label="Background Lanes: ${escapeHtml(backgroundLaneSummary)}">
            <span>Background Lanes</span>
            <small>Quiet lanes ready</small>
          </summary>
          <div class="dashboard-work-lanes-quiet-list">
            ${backgroundLanes.map((lane) => workLaneButton(lane, "data-dashboard-work-lane-quiet")).join("")}
          </div>
        </details>
      `}
    </section>
  `;
}

function decisionSummaryChips(summary: DashboardDecisionSummary): string {
  const chips = [
    summary.summary.capture_inbox_groups > 0 ? `${summary.summary.capture_inbox_groups} Capture Inbox` : undefined,
    summary.summary.review_queue_plans > 0 ? `${summary.summary.review_queue_plans} Review Queue` : undefined,
    summary.summary.candidate_triage_promotions > 0 ? `${summary.summary.candidate_triage_promotions} Candidate Triage` : undefined
  ].filter((chip): chip is string => chip !== undefined);
  return chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("");
}

function decisionSummaryWriteLabel(writes: DashboardDecisionSummaryItem["writes"]): string {
  if (writes === "append_only_events") return "Append-only events";
  return "No memory writes";
}

function decisionSummaryIntro(data: DashboardDecisionSummary): string {
  return `Review ${pluralize(data.total_decisions, "explicit approval")} before any memory write.`;
}

interface DashboardDecisionRoute {
  id: "capture-inbox" | "maintenance-review" | "candidate-triage";
  label: "Capture Inbox" | "Review Queue" | "Candidate Triage";
  count: number;
  target: "capture-inbox" | "maintenance-review-queue" | "candidate-triage";
  target_label: "Open Capture Inbox" | "Open Review Queue" | "Open Candidate Triage";
  items: DashboardDecisionSummaryItem[];
}

function decisionSummaryRoutes(data: DashboardDecisionSummary): DashboardDecisionRoute[] {
  const routes: DashboardDecisionRoute[] = [];
  const itemsBySurface = (surface: DashboardDecisionSummarySurface) => data.items.filter((item) => item.surface === surface);
  if (data.summary.capture_inbox_groups > 0) {
    routes.push({
      id: "capture-inbox",
      label: "Capture Inbox",
      count: data.summary.capture_inbox_groups,
      target: "capture-inbox",
      target_label: "Open Capture Inbox",
      items: itemsBySurface("capture_inbox")
    });
  }
  if (data.summary.review_queue_plans > 0) {
    routes.push({
      id: "maintenance-review",
      label: "Review Queue",
      count: data.summary.review_queue_plans,
      target: "maintenance-review-queue",
      target_label: "Open Review Queue",
      items: itemsBySurface("maintenance_review")
    });
  }
  if (data.summary.candidate_triage_promotions > 0) {
    routes.push({
      id: "candidate-triage",
      label: "Candidate Triage",
      count: data.summary.candidate_triage_promotions,
      target: "candidate-triage",
      target_label: "Open Candidate Triage",
      items: itemsBySurface("candidate_triage")
    });
  }
  return routes;
}

function decisionSummaryRouteActionLabel(route: DashboardDecisionRoute): string {
  const firstItem = route.items[0];
  if (route.id === "capture-inbox") return "Group approve/reject";
  return firstItem?.decision_label ?? route.target_label;
}

function decisionSummaryRouteGuardLabel(route: DashboardDecisionRoute): string {
  if (route.id === "maintenance-review") return "Plan hash guard";
  return "Active candidate guard";
}

function decisionSummaryRouteChips(route: DashboardDecisionRoute): string {
  return [
    decisionSummaryRouteActionLabel(route),
    decisionSummaryWriteLabel("append_only_events"),
    decisionSummaryRouteGuardLabel(route)
  ].map((chip) => `<span>${escapeHtml(chip)}</span>`).join("");
}

function decisionSummaryRouteCard(route: DashboardDecisionRoute): string {
  return `
          <article class="decision-summary-item" data-decision-summary-route="${escapeHtml(route.id)}">
            <div class="decision-summary-item-main">
              <div>
                <strong>${escapeHtml(route.label)}</strong>
                <p>${escapeHtml(`${pluralize(route.count, "explicit approval")} waiting in ${route.label}.`)}</p>
              </div>
              <button type="button" class="decision-summary-link" data-action-board-target="${escapeHtml(route.target)}" aria-controls="${escapeHtml(route.target)}">${escapeHtml(route.target_label)}</button>
            </div>
            <div class="decision-summary-route" aria-label="Decision route">
              ${decisionSummaryRouteChips(route)}
            </div>
          </article>
  `;
}

function decisionSummary(data: DashboardDecisionSummary): string {
  if (data.total_decisions === 0) return "";
  const routes = decisionSummaryRoutes(data);
  return `
    <section id="decision-summary" class="panel decision-summary" data-dashboard-detail="decision-summary" aria-label="Decision Summary">
      <div class="decision-summary-heading">
        <div>
          <h2>Pending Decisions</h2>
          <p>${escapeHtml(decisionSummaryIntro(data))}</p>
        </div>
        <div class="decision-summary-counts">
          ${decisionSummaryChips(data)}
        </div>
      </div>
      <div class="decision-summary-list">
        ${routes.map(decisionSummaryRouteCard).join("")}
      </div>
    </section>
  `;
}

function healthCheckClass(status: HealthCheckReport["status"]): string {
  if (status === "healthy") return "good";
  if (status === "unhealthy") return "critical";
  return "warning";
}

function healthCheckSummary(report: HealthCheckReport): string {
  const status = report.status.replace(/_/g, " ");
  if (report.summary.warning_checks === 0 && report.summary.failing_checks === 0) {
    return report.status === "healthy" ? "Healthy local store" : status;
  }

  return [
    status,
    report.summary.warning_checks > 0 ? pluralize(report.summary.warning_checks, "warning") : undefined,
    report.summary.failing_checks > 0 ? pluralize(report.summary.failing_checks, "failed check") : undefined
  ].filter((part): part is string => Boolean(part)).join(" | ");
}

function healthCheckActionSummary(report: HealthCheckReport): { safe: number; needsInput: number } {
  return {
    safe: report.suggested_actions.filter((action) => action.safe_to_run).length,
    needsInput: report.suggested_actions.filter((action) => !action.safe_to_run || action.required_fields.length > 0).length
  };
}

function healthCheckSetupCommandSummary(report: HealthCheckReport): string {
  const summary = healthCheckActionSummary(report);
  return `${pluralize(summary.safe, "safe check")} | ${pluralize(summary.needsInput, "manual input")}`;
}

function healthCheckInstallTrust(report: HealthCheckReport): string {
  const summary = healthCheckActionSummary(report);
  const status = report.summary.failing_checks > 0 ? "Needs setup review" : "Safe to inspect";
  return `
        <section class="health-check-install-trust" aria-label="Install Trust">
          <div>
            <h4>Install Trust</h4>
            <p>Review readiness commands before setup</p>
          </div>
          <strong>${escapeHtml(status)}</strong>
          <div class="health-check-install-trust-chips">
            <span>${escapeHtml(pluralize(summary.safe, "safe check"))}</span>
            <span>${escapeHtml(pluralize(summary.needsInput, "manual input"))}</span>
            <span>No host config writes from dashboard</span>
          </div>
        </section>
  `;
}

function healthCheckCheckSummary(report: HealthCheckReport): string {
  return [
    report.summary.passing_checks > 0 ? pluralize(report.summary.passing_checks, "pass", "pass") : undefined,
    report.summary.info_checks > 0 ? pluralize(report.summary.info_checks, "info", "info") : undefined,
    report.summary.warning_checks > 0 ? pluralize(report.summary.warning_checks, "warning") : undefined,
    report.summary.failing_checks > 0 ? pluralize(report.summary.failing_checks, "failed check") : undefined
  ].filter((part): part is string => Boolean(part)).join(" | ");
}

function healthCheckActionRequirement(action: HealthCheckReport["suggested_actions"][number]): string {
  if (action.required_fields.length === 0) return action.safe_to_run ? "Read-only" : "Needs review";
  return `Requires ${action.required_fields.map((field) => field.replace(/_/g, " ")).join(", ")}`;
}

function healthCheckActionList(actions: HealthCheckReport["suggested_actions"]): string {
  if (actions.length === 0) {
    return `<div class="empty-state">No readiness actions in this group.</div>`;
  }
  return `
    <div class="health-check-action-list">
      ${actions.map((action) => `
        <article class="health-check-action ${action.safe_to_run ? "safe" : "input"}" data-health-check-action="${escapeHtml(action.action_id)}">
          <div>
            <span class="pill ${action.safe_to_run ? "state-canonical" : "warning"}">${escapeHtml(healthCheckActionRequirement(action))}</span>
            <strong>${escapeHtml(titleCase(action.recommended_action))}</strong>
          </div>
          <small>${escapeHtml(action.required_when)}</small>
          <details class="health-check-action-command" data-dashboard-detail="health-check-action-command:${escapeHtml(action.action_id)}">
            <summary class="dashboard-fold-summary">
              <span>CLI command</span>
              <small>copy from CLI</small>
            </summary>
            <code>${escapeHtml(action.command)}</code>
          </details>
        </article>
      `).join("")}
    </div>
  `;
}

function healthCheckReadinessActions(report: HealthCheckReport): string {
  if (report.suggested_actions.length === 0) return "";
  const summary = healthCheckActionSummary(report);
  const safeActions = report.suggested_actions.filter((action) => action.safe_to_run);
  const inputActions = report.suggested_actions.filter((action) => !action.safe_to_run || action.required_fields.length > 0);
  return `
    <details class="health-check-readiness-actions" data-dashboard-detail="health-check-readiness-actions">
      <summary class="dashboard-fold-summary">
        <span>Setup Commands</span>
        <small>${escapeHtml(healthCheckSetupCommandSummary(report))}</small>
      </summary>
      <div class="health-check-action-groups">
        <section class="health-check-action-group">
          <h4>Safe checks</h4>
          ${healthCheckActionList(safeActions)}
        </section>
        <section class="health-check-action-group">
          <h4>Manual input</h4>
          ${healthCheckActionList(inputActions)}
        </section>
      </div>
    </details>
  `;
}

function healthCheckDetails(report: HealthCheckReport): string {
  if (report.checks.length === 0) return "";
  return `
        <details class="health-check-details" data-dashboard-detail="health-check-details">
          <summary class="dashboard-fold-summary">
            <span>Check Details</span>
            <small>${escapeHtml(healthCheckCheckSummary(report))}</small>
          </summary>
          <div class="health-check-list">
            ${report.checks.map((check) => `
              <article class="health-check-item ${escapeHtml(check.status)}">
                <span>${escapeHtml(titleCase(check.status))}</span>
                <strong>${escapeHtml(check.label)}</strong>
                <p>${escapeHtml(check.summary)}</p>
                <small>${escapeHtml(check.reason)}</small>
              </article>
            `).join("")}
          </div>
        </details>
  `;
}

function healthCheckPanel(report: HealthCheckReport): string {
  const summary = healthCheckSummary(report);
  const actionSummary = healthCheckActionSummary(report);
  return `
    <details class="panel health-check-panel" data-dashboard-detail="health-check" data-dashboard-section="health-check">
      <summary class="dashboard-fold-summary">
        <span>Moryn Health Check</span>
        <small>${escapeHtml(summary)}</small>
      </summary>
      <div class="health-check-body">
        <div class="health-check-brief">
          <strong class="${healthCheckClass(report.status)}">${escapeHtml(titleCase(report.status))}</strong>
          <span>Read-only</span>
          <span>${escapeHtml(pluralize(actionSummary.safe, "safe suggestion"))}</span>
          <span>${escapeHtml(`${actionSummary.needsInput} need input`)}</span>
        </div>
        <dl class="health-check-stats">
          <div><dt>Visible records</dt><dd>${escapeHtml(report.stats.visible_records)}</dd></div>
          <div><dt>Private hidden</dt><dd>${escapeHtml(report.stats.excluded_private_records)}</dd></div>
          <div><dt>Events</dt><dd>${escapeHtml(report.stats.total_events)}</dd></div>
          <div><dt>Capture review</dt><dd>${escapeHtml(report.stats.capture_review_candidates)}</dd></div>
        </dl>
        ${healthCheckInstallTrust(report)}
        ${healthCheckReadinessActions(report)}
        ${healthCheckDetails(report)}
      </div>
    </details>
  `;
}

function recallEvalSummary(review: DashboardRecallEval): string {
  if (!review.available || !review.report) {
    return review.errors.length > 0 ? "Recall eval case error" : "No recall eval cases yet";
  }
  const summary = review.report.summary;
  return `${pluralize(summary.total_cases, "case")} | ${pluralize(summary.failed_cases, "miss")} | ${pluralize(summary.privacy_leaks, "privacy leak")}`;
}

function recallEvalStatusClass(review: DashboardRecallEval): "good" | "warning" | "critical" | "info" {
  if (review.errors.length > 0) return "warning";
  if (!review.available || !review.report) return "info";
  if (review.report.summary.privacy_leaks > 0) return "critical";
  return review.report.summary.failed_cases > 0 ? "warning" : "good";
}

function recallEvalPanel(review: DashboardRecallEval): string {
  const status = recallEvalStatusClass(review);
  const report = review.report;
  const failedCases = report?.cases.filter((testCase) => testCase.status === "fail") ?? [];
  return `
    <details class="panel recall-eval-panel" data-dashboard-detail="recall-eval" data-dashboard-section="recall-eval">
      <summary class="dashboard-fold-summary">
        <span>Recall Eval</span>
        <small>${escapeHtml(recallEvalSummary(review))}</small>
      </summary>
      <div class="recall-eval-body">
        <div class="health-check-brief">
          <strong class="${escapeHtml(status)}">${escapeHtml(review.available ? titleCase(status) : "Unavailable")}</strong>
          <span>Read-only</span>
          <code>${escapeHtml(review.available ? "Stored golden cases evaluated through normal recall." : review.unavailable_reason ?? "No recall eval data available.")}</code>
        </div>
        <dl class="health-check-stats">
          <div><dt>Case sources</dt><dd>${escapeHtml(review.case_sources.length)}</dd></div>
          <div><dt>Total cases</dt><dd>${escapeHtml(report?.summary.total_cases ?? 0)}</dd></div>
          <div><dt>Misses</dt><dd>${escapeHtml(report?.summary.failed_cases ?? 0)}</dd></div>
          <div><dt>Privacy leaks</dt><dd>${escapeHtml(report?.summary.privacy_leaks ?? 0)}</dd></div>
        </dl>
        ${review.case_sources.length === 0 ? "" : `
          <details class="recall-eval-sources" data-dashboard-detail="recall-eval-sources">
            <summary>Case Sources</summary>
            <dl>
              ${review.case_sources.map((source) => `
                <div><dt><code>${escapeHtml(source.record_id)}</code></dt><dd>${escapeHtml(pluralize(source.case_count, "case"))} | <code>${escapeHtml(source.evidence_path)}</code></dd></div>
              `).join("")}
            </dl>
          </details>
        `}
        ${failedCases.length === 0 ? "" : `
          <div class="health-check-list">
            ${failedCases.map((testCase) => `
              <article class="health-check-item warning" data-dashboard-detail="recall-eval:${escapeHtml(testCase.case_id)}">
                <span>Miss</span>
                <strong>${escapeHtml(testCase.case_id)}</strong>
                <p>${escapeHtml(testCase.query)}</p>
                <small>${escapeHtml(testCase.missing_record_ids.length ? `Missing ${testCase.missing_record_ids.join(", ")}` : "No missing records listed")}</small>
              </article>
            `).join("")}
          </div>
        `}
        ${review.errors.length === 0 ? "" : `
          <div class="health-check-list">
            ${review.errors.map((error) => `
              <article class="health-check-item warning">
                <span>Error</span>
                <strong>Stored case could not be evaluated</strong>
                <p>${escapeHtml(error.reason)}</p>
              </article>
            `).join("")}
          </div>
        `}
      </div>
    </details>
  `;
}

function dogfoodActionForFinding(
  report: DogfoodReportResult,
  finding: DogfoodReportResult["findings"][number]
): DogfoodReportResult["suggested_actions"][number] | undefined {
  if (finding.id === "capture_review_backlog") return report.suggested_actions_by_id.review_capture_inbox;
  const recordIds = finding.record_ids ?? (finding.record_id ? [finding.record_id] : []);
  return firstActionForRecords(report.suggested_actions, recordIds);
}

function dogfoodReviewSummary(report: DogfoodReportResult): string {
  return report.findings.length === 1 ? "Read-only note" : "Read-only notes";
}

function dogfoodReviewPanel(report: DogfoodReportResult): string {
  if (report.findings.length === 0) return "";
  const highestSeverity = report.findings.some((finding) => finding.severity === "warning") ? "warning" : "info";
  return `
    <details class="panel dogfood-review" data-dashboard-detail="dogfood-review" aria-label="Dogfood Notes">
      <summary class="dashboard-fold-summary">
        <span>Dogfood Notes</span>
        <small>${escapeHtml(dogfoodReviewSummary(report))}</small>
      </summary>
      <div class="dogfood-review-body">
        <div class="health-check-brief">
          <strong class="${escapeHtml(highestSeverity)}">Note</strong>
          <span>Read-only</span>
          <code>dogfood_report.findings_by_id</code>
        </div>
        <div class="dogfood-review-list">
          ${report.findings.map((finding) => {
            const action = dogfoodActionForFinding(report, finding);
            const actionLabel = action?.recommended_action ?? "Inspect dogfood finding";
            const evidencePath = `dogfood_report.findings_by_id.${finding.id}`;
            const recordIds = finding.record_ids ?? (finding.record_id ? [finding.record_id] : []);
            return `
              <article class="dogfood-review-item ${escapeHtml(finding.severity)}" data-dashboard-detail="dogfood:${escapeHtml(finding.id)}" data-dogfood-review-item="${escapeHtml(finding.id)}">
                <div class="dogfood-review-heading">
                  <span>${escapeHtml(titleCase(finding.category))}</span>
                  <strong>${escapeHtml(finding.summary)}</strong>
                  <small>Read-only inspection</small>
                </div>
                <details class="dogfood-note-details" data-dashboard-detail="dogfood-note:${escapeHtml(finding.id)}">
                  <summary class="dashboard-fold-summary">
                    <span>Note Details</span>
                    <small>${escapeHtml(pluralize(recordIds.length, "record"))} | ${escapeHtml(actionLabel)}</small>
                  </summary>
                  <div class="dogfood-brief" data-dogfood-brief>
                    <h4>Issue brief</h4>
                    <dl>
                      <div><dt>Impact</dt><dd>${escapeHtml(finding.reason)}</dd></div>
                      <div><dt>Affected records</dt><dd>${escapeHtml(pluralize(recordIds.length, "record"))}</dd></div>
                      <div><dt>Read-only next step</dt><dd>${escapeHtml(actionLabel)}</dd></div>
                      <div><dt>Evidence</dt><dd><code>${escapeHtml(evidencePath)}</code></dd></div>
                    </dl>
                  </div>
                  ${action?.command ? `<code>${escapeHtml(action.command)}</code>` : ""}
                </details>
              </article>
            `;
          }).join("")}
        </div>
      </div>
    </details>
  `;
}

function healthClass(status: DashboardHealthStatus): string {
  if (status === "healthy") return "good";
  if (status === "conflict") return "critical";
  if (status === "needs_review" || status === "sync_pending") return "warning";
  return "info";
}

function attentionItem(item: DashboardAttentionItem): string {
  return `
    <details class="attention ${escapeHtml(item.severity)}" data-dashboard-detail="attention:${escapeHtml(item.title)}">
      <summary class="attention-summary">
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(titleCase(item.severity))}</span>
      </summary>
      <div class="attention-body">
        <p>${escapeHtml(item.description)}</p>
        ${item.action_command ? `<code>${escapeHtml(item.action_command)}</code>` : ""}
      </div>
    </details>
  `;
}

function attentionFocusNextAction(items: DashboardAttentionItem[]): string {
  const reviewItems = items.filter(isReviewAttentionItem);
  const critical = reviewItems.filter((item) => item.severity === "critical").length;
  const warning = reviewItems.filter((item) => item.severity === "warning").length;
  const reviewCopy = reviewActionCopy(items);
  if (critical > 0) return "Review criticals";
  if (warning > 0) return reviewCopy.next_action_label;
  return "Inspect checks";
}

function attentionFocus(items: DashboardAttentionItem[]): string {
  const reviewItems = items.filter(isReviewAttentionItem);
  const critical = reviewItems.filter((item) => item.severity === "critical").length;
  const warning = reviewItems.filter((item) => item.severity === "warning").length;
  const info = items.filter((item) => item.severity === "info").length;
  const actionSignals = critical + warning;
  const next = attentionFocusNextAction(items);
  const chips: Array<{ severity: DashboardAttentionItem["severity"]; count: number }> = [
    { severity: "critical" as const, count: critical },
    { severity: "warning" as const, count: warning },
    { severity: "info" as const, count: info }
  ].filter((chip) => chip.count > 0);
  const chipLabel = (chip: { severity: DashboardAttentionItem["severity"]; count: number }) =>
    chip.severity === "info" ? pluralize(chip.count, "info check") : pluralize(chip.count, chip.severity);
  return `
    <div class="attention-focus" aria-label="Action Signals focus">
      <span><strong>${escapeHtml(actionSignals)}</strong> ${escapeHtml(actionSignals === 1 ? "action signal" : "action signals")}</span>
      ${chips.map((chip) => `<span class="attention-focus-count ${escapeHtml(chip.severity)}">${escapeHtml(chipLabel(chip))}</span>`).join("")}
      <span class="attention-next-action" data-attention-next-action>${escapeHtml(next)}</span>
    </div>
  `;
}

function attentionItems(items: DashboardAttentionItem[]): string {
  if (items.length === 0) {
    return `<div class="empty-state">No issues detected in the current snapshot.</div>`;
  }
  const primary = items.filter(isReviewAttentionItem);
  const info = items.filter((item) => item.severity === "info");
  return `
    <div class="attention-list">
      ${attentionFocus(items)}
      ${primary.map(attentionItem).join("")}
      ${infoChecksGroup(info)}
    </div>
  `;
}

function infoChecksGroup(items: DashboardAttentionItem[], options: { quiet?: boolean } = {}): string {
  if (items.length === 0) return "";
  const list = `
          <div class="attention-info-list">
            ${items.map(attentionItem).join("")}
          </div>
  `;
  return `
        <details class="attention-info-group" data-dashboard-detail="attention-info-checks">
          <summary class="dashboard-fold-summary">
            <span>Info Checks</span>
            <small>Routine status checks</small>
          </summary>
          ${options.quiet ? `
            <details class="attention-info-details" data-dashboard-detail="attention-info-details">
              <summary class="dashboard-fold-summary">
                <span>Info Details</span>
                <small>${escapeHtml(pluralize(items.length, "routine check"))}</small>
              </summary>
              ${list}
            </details>
          ` : list}
        </details>
  `;
}

function needsAttentionPanel(items: DashboardAttentionItem[]): string {
  const actionSignals = items.filter(isReviewAttentionItem).length;
  if (actionSignals === 0) {
    const info = items.filter((item) => item.severity === "info");
    return `
      <section id="needs-attention" class="needs-attention-quiet-line" data-dashboard-section="needs-attention" data-dashboard-detail="needs-attention">
        ${infoChecksGroup(info, { quiet: true })}
      </section>
    `;
  }
  return `
    <section id="needs-attention" class="panel action-signals" data-dashboard-section="needs-attention" data-dashboard-detail="needs-attention">
      <div class="action-signals-heading">
        <h2>Action Signals</h2>
        <small>Warnings and critical checks</small>
      </div>
      ${attentionItems(items)}
    </section>
  `;
}

function governanceSafetyLabel(item: DashboardGovernanceItem): string {
  if (item.requires_user_confirmation) return "User confirmation";
  if (item.safe_to_run && item.writes === "none") return "Safe inspection";
  return "Review";
}

function isSafeGovernanceInspection(item: DashboardGovernanceItem): boolean {
  return !item.requires_user_confirmation && item.safe_to_run && item.writes === "none";
}

function reviewLogList(items: string[], dataAttribute: string): string {
  return `
    <div class="review-log" ${dataAttribute}>
      <h4>Review notes</h4>
      <ol>
        ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ol>
    </div>
  `;
}

function governanceFindingSummary(item: DashboardGovernanceItem): string {
  return `
    <div class="governance-finding-summary" data-governance-finding-summary>
      <h4>Finding summary</h4>
      <dl>
        <div><dt>Records affected</dt><dd>${escapeHtml(pluralize(item.record_ids.length, "record"))}</dd></div>
        <div><dt>Safe next step</dt><dd>${escapeHtml(item.action_label)}</dd></div>
        <div><dt>Write boundary</dt><dd>${escapeHtml(item.writes === "none" ? "No memory writes" : "Append-only after approval")}</dd></div>
        <div><dt>Evidence source</dt><dd><code>${escapeHtml(item.evidence_path)}</code></dd></div>
      </dl>
    </div>
  `;
}

function governanceItem(item: DashboardGovernanceItem): string {
  return `
    <details class="governance-item ${escapeHtml(item.severity)}" data-dashboard-detail="governance:${escapeHtml(item.id)}" data-governance-item="${escapeHtml(item.id)}">
      <summary class="governance-item-summary">
        <span class="governance-item-main">
          <strong>${escapeHtml(item.title)}</strong>
          <small>${escapeHtml(item.action_label)}</small>
        </span>
        <span class="governance-meta">
          <span>${escapeHtml(governanceSafetyLabel(item))}</span>
          <span>${escapeHtml(item.writes === "none" ? "Read-only" : "Append-only")}</span>
        </span>
      </summary>
      <div class="governance-item-body">
        <p>${escapeHtml(item.summary)}</p>
        ${governanceFindingSummary(item)}
        ${reviewLogList(item.review_log, "data-governance-review-log")}
        <details class="raw-audit-fields" data-dashboard-detail="governance-raw:${escapeHtml(item.id)}">
          <summary>Raw audit fields</summary>
          <dl>
            <div><dt>Source</dt><dd>${escapeHtml(item.source)}</dd></div>
            <div><dt>Category</dt><dd>${escapeHtml(item.category)}</dd></div>
            <div><dt>Action</dt><dd>${escapeHtml(item.action_label)}${item.action_id ? ` <code>${escapeHtml(item.action_id)}</code>` : ""}</dd></div>
            <div data-governance-evidence><dt>Evidence</dt><dd><code>${escapeHtml(item.evidence_path)}</code></dd></div>
            <div><dt>Records</dt><dd>${item.record_ids.length ? item.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ") : "none"}</dd></div>
          </dl>
        </details>
      </div>
    </details>
  `;
}

function governanceSourceDisplayLabel(source: DashboardGovernanceSource): string {
  if (source === "capture_policy") return "Capture Policy";
  if (source === "memory_lifecycle") return "Memory Lifecycle";
  if (source === "maintenance") return "Review Queue";
  if (source === "recall_eval") return "Recall Eval";
  if (source === "dogfood_report") return "Dogfood Review";
  return titleCase(source);
}

function governanceActionDisplayLabel(actionLabel: string): string {
  return titleCase(actionLabel);
}

function governanceSafeRowTitle(item: DashboardGovernanceItem): string {
  if (item.source === "memory_doctor" && item.category === "candidate_backlog") return "Candidate backlog";
  if (item.source === "dogfood_report" && item.category === "dogfood_friction") {
    if (item.action_label === "inspect_failure_signals") return "Failure signals";
    if (item.action_label === "review_capture_inbox") return "Capture review backlog";
  }
  return item.title;
}

function governanceSafeReviewNote(note: string): string {
  const evidencePrefix = "Evidence source: ";
  if (note.startsWith(evidencePrefix)) {
    return `Evidence source: <code>${escapeHtml(note.slice(evidencePrefix.length))}</code>`;
  }
  return escapeHtml(note);
}

function governanceSafeAuditNotes(item: DashboardGovernanceItem): string {
  return `
      <details class="governance-safe-notes" data-dashboard-detail="governance-notes:${escapeHtml(item.id)}">
        <summary class="dashboard-fold-summary">
          <span>Audit notes</span>
          <small>Detection, boundary, and evidence</small>
        </summary>
        <ol>
          ${item.review_log.map((note) => `<li>${governanceSafeReviewNote(note)}</li>`).join("")}
        </ol>
      </details>
  `;
}

function governanceSafeRow(item: DashboardGovernanceItem): string {
  return `
    <div class="governance-safe-row ${escapeHtml(item.severity)}" data-dashboard-detail="governance:${escapeHtml(item.id)}" data-governance-safe-item="${escapeHtml(item.id)}">
      <span>${escapeHtml(governanceSourceDisplayLabel(item.source))}</span>
      <strong>${escapeHtml(governanceSafeRowTitle(item))}</strong>
      <small>${escapeHtml(`${governanceActionDisplayLabel(item.action_label)} | Read-only`)}</small>
      ${governanceSafeAuditNotes(item)}
    </div>
  `;
}

function isSafeOnlyGovernance(governance: DashboardGovernance): boolean {
  return (
    governance.summary.needs_user_action === 0
    && governance.summary.hidden_private_records === 0
    && governance.summary.safe_inspections > 0
  );
}

function governanceNeedsReview(governance: DashboardGovernance): boolean {
  return governance.summary.needs_user_action > 0;
}

function governanceHubSummaryText(governance: DashboardGovernance): string {
  if (isSafeOnlyGovernance(governance)) return "Reference checks";
  const counts = [
    governance.summary.needs_user_action > 0 ? pluralize(governance.summary.needs_user_action, "need confirmation", "need confirmation") : undefined,
    governance.summary.safe_inspections > 0 ? pluralize(governance.summary.safe_inspections, "safe check") : undefined,
    governance.summary.hidden_private_records > 0 ? pluralize(governance.summary.hidden_private_records, "private hidden", "private hidden") : undefined
  ].filter((count): count is string => count !== undefined);
  return counts.length > 0 ? counts.join(" | ") : "All clear";
}

function governanceCountChips(governance: DashboardGovernance): string {
  const chips = [
    governance.summary.needs_user_action > 0 ? `${governance.summary.needs_user_action} need confirmation` : undefined,
    governance.summary.safe_inspections > 0 ? pluralize(governance.summary.safe_inspections, "safe check") : undefined,
    governance.summary.hidden_private_records > 0 ? `${governance.summary.hidden_private_records} private hidden` : undefined
  ].filter((chip): chip is string => chip !== undefined);
  if (chips.length === 0) return `<span>All clear</span>`;
  return chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("");
}

function governanceHubBody(governance: DashboardGovernance): string {
  const safeInspections = governance.items.filter(isSafeGovernanceInspection);
  const primaryItems = governance.items.filter((item) => !isSafeGovernanceInspection(item));
  const safeOnly = isSafeOnlyGovernance(governance);
  return `
    <div class="governance-hub-body">
      <div class="governance-heading">
        <div>
          <h2>${escapeHtml(safeOnly ? "Read-only Governance" : "Governance Hub")}</h2>
          <p>${escapeHtml(safeOnly ? "Reference checks only" : "Read-only inspection index")}</p>
        </div>
        <div class="governance-counts">
          ${governanceCountChips(governance)}
        </div>
      </div>
      <div class="governance-list">
        ${primaryItems.map(governanceItem).join("")}
        ${safeInspections.length === 0 ? "" : `
          <details class="governance-safe-group" data-dashboard-detail="governance-safe-inspections">
            <summary class="dashboard-fold-summary">
              <span>${escapeHtml(safeOnly ? "Reference Checks" : "Safe Inspections")}</span>
              <small>${escapeHtml(safeOnly ? "Read-only, no writes" : "Background checks, read-only")}</small>
            </summary>
            <div class="governance-safe-list" data-governance-safe-list>
              ${safeInspections.map(governanceSafeRow).join("")}
            </div>
          </details>
        `}
      </div>
    </div>
  `;
}

function governanceHub(governance: DashboardGovernance): string {
  if (governance.summary.total_items === 0) return "";
  const body = governanceHubBody(governance);
  const safeOnly = isSafeOnlyGovernance(governance);
  if (governance.summary.needs_user_action === 0) {
    return `
      <details id="governance-hub" class="panel governance-hub" data-dashboard-detail="governance-hub" aria-label="Governance Hub">
        <summary class="dashboard-fold-summary governance-hub-fold">
          <span>${escapeHtml(safeOnly ? "Read-only Governance" : "Governance Hub")}</span>
          <small>${escapeHtml(governanceHubSummaryText(governance))}</small>
        </summary>
        ${body}
      </details>
    `;
  }
  return `
    <section id="governance-hub" class="panel governance-hub" aria-label="Governance Hub">
      ${body}
    </section>
  `;
}

function candidateTriageSummary(triage: DashboardCandidateTriage): string {
  if (!triage.available) return "No candidate backlog";
  const promotionDrafts = candidateTriagePromotionDraftCount(triage);
  if (promotionDrafts > 0) return `${pluralize(promotionDrafts, "promotion draft")} waiting`;
  return "Read-only backlog";
}

function candidateTriagePromotionDraftCount(triage: DashboardCandidateTriage): number {
  if (!triage.available) return 0;
  return Object.values(triage.groups_by_id)
    .reduce((count, group) => count + (group ? Object.keys(group.promotion_drafts_by_id).length : 0), 0);
}

function candidateTriageHasPromotionDrafts(triage: DashboardCandidateTriage): boolean {
  return candidateTriagePromotionDraftCount(triage) > 0;
}

function candidateTriageRecordSampleTitle(record: DashboardCandidateTriageRecord): string {
  const label = record.kind.replace(/[_-]+/g, " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} sample ${recordLabel(record.id)}`;
}

function candidateTriageRecordVisibleTitle(record: DashboardCandidateTriageRecord): string {
  return "Sample";
}

function candidateTriageRecordAccessibleTitle(record: DashboardCandidateTriageRecord): string {
  return `${candidateTriageRecordSampleTitle(record)} from ${record.source_label}, ${record.relative_time}`;
}

function renderCandidateTriageRecord(record: DashboardCandidateTriageRecord): string {
  return `
    <details class="candidate-triage-record" data-dashboard-detail="candidate-triage-record:${escapeHtml(record.id)}">
      <summary class="candidate-triage-record-summary" aria-label="${escapeHtml(candidateTriageRecordAccessibleTitle(record))}">
        <span>
          <strong>${escapeHtml(candidateTriageRecordVisibleTitle(record))}</strong>
          <small>Trace ready</small>
        </span>
        <span class="candidate-triage-record-meta">${escapeHtml(titleCase(record.kind))}</span>
      </summary>
      <dl>
        <div><dt>Content</dt><dd>${escapeHtml(record.text)}</dd></div>
        <div><dt>Reason</dt><dd>${escapeHtml(record.reason)}</dd></div>
        <div><dt>Source</dt><dd>${escapeHtml(record.source_detail)}</dd></div>
        <div><dt>Priority</dt><dd>${escapeHtml(record.priority)}</dd></div>
        <div><dt>Confidence</dt><dd>${escapeHtml(record.confidence.toFixed(2))}</dd></div>
        <div><dt>Record</dt><dd><code>${escapeHtml(record.id)}</code></dd></div>
        <div><dt>Timeline</dt><dd><code>${escapeHtml(record.citation.timeline_command)}</code></dd></div>
        <div><dt>Recall</dt><dd><code>${escapeHtml(record.citation.recall_command)}</code></dd></div>
      </dl>
    </details>
  `;
}

function candidateTriageSampleSummary(group: DashboardCandidateTriageGroup): string {
  const shownRecords = group.records.length;
  const totalRecords = group.record_ids.length;
  if (shownRecords === totalRecords) return `${group.label}: ${pluralize(shownRecords, "sample")} with trace commands`;
  return `${group.label}: ${shownRecords} of ${pluralize(totalRecords, "sample")} with trace commands`;
}

function candidateTriageSampleVisibleSummary(group: DashboardCandidateTriageGroup): string {
  return `${pluralize(group.records.length, "sample")}, trace ready`;
}

function renderCandidateTriageOverflow(group: DashboardCandidateTriageGroup): string {
  const hiddenRecords = Math.max(0, group.record_ids.length - group.records.length);
  if (hiddenRecords === 0) return "";
  const overflowSummary = `${group.label}: ${hiddenRecords} hidden with record index available`;
  return `
    <div class="candidate-triage-overflow">
      <span class="candidate-triage-overflow-count">${escapeHtml(`${pluralize(hiddenRecords, "more record")} indexed`)}</span>
      <details class="candidate-triage-overflow-path" data-dashboard-detail="candidate-triage-overflow:${escapeHtml(group.id)}">
        <summary class="dashboard-fold-summary" aria-label="${escapeHtml(`More samples: ${overflowSummary}`)}">
          <span>More samples</span>
          <small>${escapeHtml(`${hiddenRecords} hidden, indexed`)}</small>
        </summary>
        <p>Open the hidden record index when the displayed samples are not enough.</p>
        <details class="candidate-triage-overflow-evidence" data-dashboard-detail="candidate-triage-overflow-evidence:${escapeHtml(group.id)}">
          <summary class="dashboard-fold-summary">
            <span>Hidden record index</span>
            <small>${escapeHtml(`${group.label} index`)}</small>
          </summary>
          <code>${escapeHtml(`${group.evidence_path}.records_by_id`)}</code>
        </details>
      </details>
    </div>
  `;
}

function renderCandidateTriageHandoff(group: DashboardCandidateTriageGroup): string {
  const reviewPath = `${group.review_handoff.label} via ${group.review_handoff.existing_control}`;
  return `
    <details class="candidate-triage-review-path" data-dashboard-detail="candidate-triage-review-path:${escapeHtml(group.id)}" data-candidate-triage-handoff="${escapeHtml(group.id)}">
      <summary class="dashboard-fold-summary" aria-label="${escapeHtml(`Review path: ${reviewPath}`)}">
        <span>Review path</span>
        <small>${escapeHtml(group.review_handoff.label)}</small>
      </summary>
      <dl>
        <div><dt>Next step</dt><dd>${escapeHtml(group.review_handoff.label)}</dd></div>
        <div><dt>Existing control</dt><dd>${escapeHtml(group.review_handoff.existing_control)}</dd></div>
        <div><dt>Write boundary</dt><dd>${escapeHtml(group.review_handoff.write_boundary)}</dd></div>
      </dl>
      <p>${escapeHtml(group.review_handoff.guidance)}</p>
    </details>
  `;
}

function renderCandidateTriageAuditBoundary(group: DashboardCandidateTriageGroup): string {
  return `
    <details class="candidate-triage-audit-boundary" data-dashboard-detail="candidate-triage-audit:${escapeHtml(group.id)}">
      <summary class="dashboard-fold-summary">
        <span>Audit boundary</span>
        <small>${escapeHtml(`${group.label} audit boundary`)}</small>
      </summary>
      <dl>
        <div><dt>Write boundary</dt><dd>Draft approve appends promotion events only</dd></div>
        <div><dt>Confirmation</dt><dd>User approval required for promotion drafts</dd></div>
        <div><dt>Evidence</dt><dd><code>${escapeHtml(group.evidence_path)}</code></dd></div>
      </dl>
    </details>
  `;
}

function renderCandidateTriagePromotionDrafts(group: DashboardCandidateTriageGroup): string {
  const drafts = Object.values(group.promotion_drafts_by_id);
  if (drafts.length === 0) return "";
  return `
    <details class="candidate-triage-promotion-drafts" data-dashboard-detail="candidate-triage-promotion-drafts:${escapeHtml(group.id)}">
      <summary class="dashboard-fold-summary">
        <span>Promotion draft</span>
        <small>${escapeHtml(`${pluralize(drafts.length, "candidate")} ready`)}</small>
      </summary>
      <div class="candidate-triage-promotion-list">
        ${drafts.map((draft) => `
          <article class="candidate-triage-promotion-draft" data-candidate-triage-promotion-draft="${escapeHtml(draft.record_id)}">
            <dl>
              <div><dt>Record</dt><dd><code>${escapeHtml(draft.record_id)}</code></dd></div>
              <div><dt>Target</dt><dd>${escapeHtml(draft.target_state)}</dd></div>
              <div><dt>Confirmation</dt><dd>${draft.requires_user_confirmation ? "User approval required" : "No confirmation required"}</dd></div>
              <div><dt>Write</dt><dd>${draft.writes === "append_only_events" ? "append-only promotion event" : escapeHtml(draft.writes)}</dd></div>
              <div><dt>Reason</dt><dd>${escapeHtml(draft.reason)}</dd></div>
              <div><dt>Command</dt><dd><code>${escapeHtml(draft.command)}</code></dd></div>
              <div><dt>Evidence</dt><dd><code>${escapeHtml(draft.source_path)}</code></dd></div>
            </dl>
            <div class="candidate-triage-promotion-actions">
              <button
                type="button"
                class="primary"
                data-candidate-triage-promotion-approve
                data-dashboard-action-id="${escapeHtml(draft.action_id)}"
                data-endpoint="${escapeHtml(draft.approve_endpoint)}"
              >Approve Memory</button>
            </div>
            <p class="candidate-triage-promotion-status" data-candidate-triage-promotion-status role="status" aria-live="polite"></p>
          </article>
        `).join("")}
      </div>
    </details>
  `;
}

function candidateTriageGroupFace(group: DashboardCandidateTriageGroup): { label: string; hint: string } {
  if (Object.keys(group.promotion_drafts_by_id).length > 0) {
    return { label: group.review_handoff.label, hint: "Promotion draft ready" };
  }
  if (group.id === "likely_noise") return { label: "Likely noise", hint: "Review before archive" };
  if (group.id === "session_summaries") return { label: "Handoff evidence", hint: "Keep as context" };
  if (group.id === "needs_inspection") return { label: "Needs inspection", hint: "Timeline check" };
  return { label: "Read-only evidence", hint: "Trace indexed" };
}

function renderCandidateTriageGroupContext(group: DashboardCandidateTriageGroup): string {
  return `
    <details class="candidate-triage-group-context" data-dashboard-detail="candidate-triage-context:${escapeHtml(group.id)}">
      <summary class="dashboard-fold-summary">
        <span>Group context</span>
        <small>${escapeHtml(`${group.label}, ${pluralize(group.record_ids.length, "record")}`)}</small>
      </summary>
      <p>${escapeHtml(group.description)}</p>
    </details>
  `;
}

function renderCandidateTriageAuditNotes(group: DashboardCandidateTriageGroup): string {
  return `
    <details class="candidate-triage-audit-notes" data-dashboard-detail="candidate-triage-audit-notes:${escapeHtml(group.id)}">
      <summary class="dashboard-fold-summary">
        <span>Audit notes</span>
        <small>Context and boundary</small>
      </summary>
      ${renderCandidateTriageGroupContext(group)}
      ${renderCandidateTriageAuditBoundary(group)}
    </details>
  `;
}

function renderCandidateTriageGroup(group: DashboardCandidateTriageGroup): string {
  const sampleSummary = candidateTriageSampleSummary(group);
  const groupSummary = `${group.label}, ${pluralize(group.record_ids.length, "record")}, ${group.recommended_next_step}`;
  const face = candidateTriageGroupFace(group);
  return `
    <details class="candidate-triage-group" data-dashboard-detail="candidate-triage:${escapeHtml(group.id)}">
      <summary class="dashboard-fold-summary" aria-label="${escapeHtml(`Candidate group: ${groupSummary}`)}">
        <span>${escapeHtml(group.label)}</span>
        <strong>${escapeHtml(face.label)}</strong>
        <small>${escapeHtml(face.hint)}</small>
      </summary>
      <div class="candidate-triage-group-body">
        <details class="candidate-triage-group-details" data-dashboard-detail="candidate-triage-details:${escapeHtml(group.id)}">
          <summary class="dashboard-fold-summary">
            <span>Triage details</span>
            <small>Review path, audit notes, samples</small>
          </summary>
          ${renderCandidateTriageHandoff(group)}
          ${renderCandidateTriageAuditNotes(group)}
          ${renderCandidateTriagePromotionDrafts(group)}
          <details class="candidate-triage-record-samples" data-dashboard-detail="candidate-triage-records:${escapeHtml(group.id)}">
            <summary class="dashboard-fold-summary" aria-label="Record samples: ${escapeHtml(sampleSummary)}">
              <span>Record samples</span>
              <small>${escapeHtml(candidateTriageSampleVisibleSummary(group))}</small>
            </summary>
            <div class="candidate-triage-records">
              ${group.records.map(renderCandidateTriageRecord).join("")}
            </div>
            ${renderCandidateTriageOverflow(group)}
          </details>
        </details>
      </div>
    </details>
  `;
}

function candidateTriagePanel(triage: DashboardCandidateTriage): string {
  if (!triage.available) return "";
  const hasPromotionDrafts = candidateTriageHasPromotionDrafts(triage);
  const panelLabel = hasPromotionDrafts ? "Candidate Triage" : "Candidate Backlog";
  const panelHeading = hasPromotionDrafts ? "Candidate Triage Queue" : "Candidate Backlog";
  const panelDescription = hasPromotionDrafts
    ? "Review grouping for memory doctor backlog."
    : "Read-only candidate groups; promotion drafts appear as explicit decisions.";
  const ariaLabel = hasPromotionDrafts ? "Candidate Triage Queue" : "Candidate Backlog";
  return `
    <details class="panel candidate-triage" data-dashboard-detail="candidate-triage" aria-label="${escapeHtml(ariaLabel)}">
      <summary class="dashboard-fold-summary candidate-triage-fold">
        <span>${escapeHtml(panelLabel)}</span>
        <small>${escapeHtml(candidateTriageSummary(triage))}</small>
      </summary>
      <div class="candidate-triage-body">
        <div class="candidate-triage-heading">
          <div>
            <h2>${escapeHtml(panelHeading)}</h2>
            <p>${escapeHtml(panelDescription)}</p>
          </div>
          <div class="candidate-triage-counts">
            <span>${escapeHtml(pluralize(triage.summary.total_candidates, "candidate"))}</span>
            <span>${escapeHtml(pluralize(triage.summary.groups, "group"))}</span>
          </div>
        </div>
        <div class="candidate-triage-list">
          ${triage.groups.map((group) => triage.groups_by_id[group.id]).filter((group): group is DashboardCandidateTriageGroup => group !== undefined).map(renderCandidateTriageGroup).join("")}
        </div>
      </div>
    </details>
  `;
}

function maintenancePlanEndpoint(plan: DashboardMaintenancePlan): string {
  return `api/maintenance/plans/${encodeURIComponent(plan.plan_id)}/approve`;
}

function maintenanceStateSummary(states: DashboardMaintenancePlan["dry_run"]["states"]): string {
  const order: Array<keyof typeof states> = ["canonical", "candidate", "raw", "archived", "quarantined"];
  return order
    .filter((state) => states[state])
    .map((state) => `${states[state]} ${state}`)
    .join(", ");
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function maintenancePrivateSummary(plan: DashboardMaintenancePlan): string {
  if (plan.dry_run.included_private_records > 0) {
    return `${pluralize(plan.dry_run.included_private_records, "private record")} included`;
  }
  if (plan.dry_run.skipped_private_records > 0) {
    return `${pluralize(plan.dry_run.skipped_private_records, "private record")} skipped`;
  }
  return "No private records included";
}

function maintenanceEvidenceList(plan: DashboardMaintenancePlan): string {
  return `
    <ul class="maintenance-evidence">
      ${plan.decision_card.evidence.map((evidence) => `<li>${escapeHtml(evidence)}</li>`).join("")}
    </ul>
  `;
}

function maintenancePrimaryActionLabel(plan: DashboardMaintenancePlan): string {
  return plan.type === "candidate_noise_archive" ? "Archive Noise" : "Apply Repair";
}

function maintenanceApprovalEventName(plan: DashboardMaintenancePlan): "archive_record" | "revise_record" {
  return plan.type === "candidate_noise_archive" ? "archive_record" : "revise_record";
}

function maintenanceActionSafetyNote(plan: DashboardMaintenancePlan): string {
  const eventName = maintenanceApprovalEventName(plan);
  return `${maintenancePrimaryActionLabel(plan)} appends ${eventName} events only after the plan_hash guard passes.`;
}

function maintenanceMoveSummary(plan: DashboardMaintenancePlan): string {
  if (plan.type === "candidate_noise_archive") {
    return `Archive ${pluralize(plan.dry_run.matched_records, "candidate")}`;
  }
  return `Move ${pluralize(plan.dry_run.matched_records, "record")}`;
}

function maintenanceChangeDetail(plan: DashboardMaintenancePlan): string {
  if (plan.type === "candidate_noise_archive") {
    return "confirmed smoke/e2e marker noise to archived";
  }
  return `${plan.from_project_id ?? ""} to ${plan.to_project_id ?? ""}`;
}

function maintenanceAuditPath(plan: DashboardMaintenancePlan): string {
  return plan.type === "candidate_noise_archive"
    ? "Raw plan, record ids, equivalent archive commands, and plan_hash stay below."
    : "Raw plan, record ids, rollback path, equivalent CLI command, and plan_hash stay below.";
}

function maintenanceAuditPathHtml(plan: DashboardMaintenancePlan): string {
  const [before, after = ""] = maintenanceAuditPath(plan).split("plan_hash");
  return `${escapeHtml(before)}<code>plan_hash</code>${escapeHtml(after)}`;
}

function maintenanceReviewBrief(plan: DashboardMaintenancePlan): string {
  const change = maintenanceMoveSummary(plan);
  const scope = plan.type === "candidate_noise_archive" ? "Marker noise" : maintenanceChangeDetail(plan);
  const eventName = maintenanceApprovalEventName(plan);
  return `
    <div class="maintenance-brief" data-maintenance-brief>
      <h4>Approval brief</h4>
      <dl class="maintenance-brief-list" aria-label="Approval brief">
        <div><dt>Change</dt><dd>${escapeHtml(change)}</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(scope)}</dd></div>
        <div><dt>Guard</dt><dd>Server rechecks plan hash before writing</dd></div>
        <div><dt>Writes</dt><dd>${escapeHtml(`append-only ${eventName} events`)}</dd></div>
      </dl>
      <p>${escapeHtml(`${maintenancePrivateSummary(plan)}.`)}</p>
    </div>
  `;
}

function maintenanceDecisionRecord(plan: DashboardMaintenancePlan): string {
  const detected = plan.type === "candidate_noise_archive"
    ? "Candidate cleanup found smoke/e2e marker noise."
    : "Project identity repair found records under an old project id.";
  const why = plan.type === "candidate_noise_archive"
    ? "Review stays noisy when verification markers remain active candidates."
    : "Boot and recall can miss these records until the project id is repaired.";
  const proposed = plan.type === "candidate_noise_archive"
    ? `${maintenanceMoveSummary(plan)} after user confirmation.`
    : `${maintenanceMoveSummary(plan)} from ${plan.from_project_id ?? ""} to ${plan.to_project_id ?? ""}.`;
  const eventName = maintenanceApprovalEventName(plan);
  const approvalWrites = `Approving appends ${eventName} events only; Reject hides this card for the browser session.`;
  return `
    <div class="maintenance-decision-record" data-maintenance-decision-record>
      <section class="maintenance-decision-section maintenance-why">
        <h4>Why this matters</h4>
        <dl>
          <div>
            <dt><strong>Detected</strong></dt>
            <dd>${escapeHtml(detected)}</dd>
          </div>
          <div>
            <dt><strong>Impact</strong></dt>
            <dd>${escapeHtml(why)}</dd>
          </div>
        </dl>
      </section>
      <section class="maintenance-decision-section maintenance-write-preview">
        <h4>Write preview</h4>
        <dl>
          <div>
            <dt><strong>Proposed change</strong></dt>
            <dd>${plan.type === "candidate_noise_archive" ? escapeHtml(proposed) : `${escapeHtml(maintenanceMoveSummary(plan))} from <code>${escapeHtml(plan.from_project_id ?? "")}</code> to <code>${escapeHtml(plan.to_project_id ?? "")}</code>.`}</dd>
          </div>
          <div>
            <dt><strong>Safety gate</strong></dt>
            <dd>The server re-runs the dry run and checks <code>plan_hash</code> before writing.</dd>
          </div>
          <div>
            <dt><strong>Approval writes</strong></dt>
            <dd>${escapeHtml(approvalWrites)}</dd>
          </div>
          <div>
            <dt><strong>Evidence trace</strong></dt>
            <dd>${maintenanceAuditPathHtml(plan)}</dd>
          </div>
        </dl>
      </section>
    </div>
  `;
}

function maintenanceRecordIdsDetail(plan: DashboardMaintenancePlan): string {
  const recordIds = plan.decision_card.raw_evidence.record_ids;
  const visibleRecordIds = recordIds.slice(0, MAINTENANCE_RAW_SAMPLE_LIMIT);
  const hiddenRecordIds = recordIds.length - visibleRecordIds.length;
  return `
    <div class="maintenance-record-id-summary">
      <div class="maintenance-record-id-preview">
        ${visibleRecordIds.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}
      </div>
      ${hiddenRecordIds > 0 ? `<span class="maintenance-overflow-count">${escapeHtml(`${pluralize(hiddenRecordIds, "more record id")} kept below`)}</span>` : ""}
      <details class="maintenance-raw-overflow" data-dashboard-detail="maintenance-record-ids:${escapeHtml(plan.plan_id)}">
        <summary class="dashboard-fold-summary" aria-label="${escapeHtml(`All record ids: ${pluralize(recordIds.length, "record id")}`)}">
          <span>All record ids</span>
          <small>${escapeHtml(`${recordIds.length} ids, audit ready`)}</small>
        </summary>
        <div class="maintenance-record-id-list">
          ${recordIds.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}
        </div>
      </details>
    </div>
  `;
}

function maintenanceCommandCount(plan: DashboardMaintenancePlan): string {
  if (plan.type === "candidate_noise_archive") {
    return pluralize(plan.record_ids.length, "archive command");
  }
  return "1 migration command";
}

function maintenanceCommandDetail(plan: DashboardMaintenancePlan): string {
  const commandCount = maintenanceCommandCount(plan);
  return `
    <div class="maintenance-command-summary">
      <code>${escapeHtml(commandCount)}</code>
      <details class="maintenance-raw-overflow" data-dashboard-detail="maintenance-command:${escapeHtml(plan.plan_id)}">
        <summary class="dashboard-fold-summary" aria-label="${escapeHtml(`Full command: ${commandCount}, copy button uses full command`)}">
          <span>Full command</span>
          <small>copy button uses full command</small>
        </summary>
        <div class="maintenance-command-detail">
          <code>${escapeHtml(plan.decision_card.raw_evidence.command)}</code>
          <button type="button" data-maintenance-copy data-command="${escapeHtml(plan.command)}">Copy command</button>
        </div>
      </details>
    </div>
  `;
}

function maintenancePlanEvidence(plan: DashboardMaintenancePlan): string {
  return `
    <details class="maintenance-plan-evidence" data-dashboard-detail="maintenance-plan-evidence:${escapeHtml(plan.plan_id)}">
      <summary class="dashboard-fold-summary maintenance-plan-evidence-fold">
        <span>Evidence trace</span>
        <small>Rollback, raw plan, command</small>
      </summary>
      <div class="maintenance-detail-grid">
        <section data-maintenance-detail="evidence">
          <h4>Evidence</h4>
          ${maintenanceEvidenceList(plan)}
          <ul class="maintenance-checks">
            ${plan.decision_card.raw_evidence.safety_checks.map((check) => `
              <li class="${check.ok ? "good" : "warning"}">
                <span>${check.ok ? "ok" : "review"}</span>
                ${escapeHtml(check.label)}
              </li>
            `).join("")}
          </ul>
        </section>
        <section data-maintenance-detail="rollback">
          <h4>Rollback path</h4>
          <p>${escapeHtml(plan.decision_card.rollback_path)}</p>
        </section>
        <section data-maintenance-detail="raw-plan">
          <h4>Raw plan</h4>
          <dl>
            <div><dt>Plan</dt><dd><code>${escapeHtml(plan.plan_id)}</code></dd></div>
            <div><dt>plan_hash</dt><dd><code>${escapeHtml(plan.decision_card.raw_evidence.plan_hash)}</code></dd></div>
            ${plan.type === "candidate_noise_archive"
              ? `<div><dt>Reason</dt><dd><code>Memory doctor: e2e marker/noise candidate</code></dd></div>
            <div><dt>Project</dt><dd><code>${escapeHtml(plan.to_project_id ?? "")}</code></dd></div>`
              : `<div><dt>Old project id</dt><dd><code>${escapeHtml(plan.from_project_id ?? "")}</code></dd></div>
            <div><dt>Target project</dt><dd><code>${escapeHtml(plan.to_project_id ?? "")}</code></dd></div>`}
            <div><dt>Records</dt><dd>${escapeHtml(maintenanceStateSummary(plan.dry_run.states) || "none")}</dd></div>
            <div><dt>Private records</dt><dd>${escapeHtml(maintenancePrivateSummary(plan))}</dd></div>
            <div><dt>Record ids</dt><dd>${maintenanceRecordIdsDetail(plan)}</dd></div>
            <div><dt>Command</dt><dd>${maintenanceCommandDetail(plan)}</dd></div>
          </dl>
        </section>
      </div>
    </details>
  `;
}

function maintenanceReviewQueue(plans: DashboardMaintenancePlan[]): string {
  if (plans.length === 0) return "";
  return `
    <section class="panel maintenance-review" aria-label="Maintenance review queue">
      <details id="maintenance-review-queue" class="maintenance-review-summary" data-dashboard-detail="maintenance-review-queue">
        <summary class="dashboard-fold-summary maintenance-review-fold">
          <span>Review Queue</span>
          <small>Approval required</small>
        </summary>
        <div class="maintenance-review-body">
          <div class="maintenance-list">
            ${plans.map((plan) => `
              <article
                class="maintenance-plan"
                data-maintenance-plan="${escapeHtml(plan.plan_id)}"
                data-plan-hash="${escapeHtml(plan.plan_hash)}"
              >
                <div class="maintenance-plan-main">
                  <div>
                    <h3>${escapeHtml(plan.decision_card.title)}</h3>
                  </div>
                  <div class="maintenance-plan-flags" aria-label="Maintenance safety">
                    <span>Review before write</span>
                    <span>Plan hash guard</span>
                  </div>
                </div>
                ${maintenanceReviewBrief(plan)}
                <details class="maintenance-audit-details" data-dashboard-detail="maintenance-audit:${escapeHtml(plan.plan_id)}">
                  <summary class="dashboard-fold-summary maintenance-audit-details-fold">
                    <span>Decision details</span>
                    <small>Why, write preview, evidence trace</small>
                  </summary>
                  ${maintenanceDecisionRecord(plan)}
                  ${maintenancePlanEvidence(plan)}
                </details>
                <div class="maintenance-actions">
                  <button type="button" data-maintenance-reject>Reject</button>
                  <button
                    type="button"
                    class="primary"
                    data-maintenance-approve
                    data-dashboard-action-id="${escapeHtml(maintenanceApproveActionId(plan))}"
                    data-endpoint="${escapeHtml(maintenancePlanEndpoint(plan))}"
                    data-plan-hash="${escapeHtml(plan.plan_hash)}"
                    data-loading-label="${escapeHtml(plan.type === "candidate_noise_archive" ? "Archiving noise..." : "Applying repair...")}"
                  >${escapeHtml(maintenancePrimaryActionLabel(plan))}</button>
                </div>
                <p class="maintenance-status" data-maintenance-status role="status" aria-live="polite"></p>
              </article>
            `).join("")}
          </div>
        </div>
      </details>
    </section>
  `;
}
function lifecycleSummary(report: MemoryLifecycleResult): string {
  const stats = report.stats;
  return `
    <dl class="lifecycle-summary">
      <div><dt>Archive candidates</dt><dd>${escapeHtml(stats.archive_candidate_records)}<small>review before archive</small></dd></div>
      <div><dt>Stale records</dt><dd>${escapeHtml(stats.stale_records)}<small>inspect timeline</small></dd></div>
      <div><dt>Retained</dt><dd>${escapeHtml(stats.retained_records)}<small>kept by policy</small></dd></div>
      <div><dt>Private boundary</dt><dd>${escapeHtml(stats.excluded_private_records)} hidden<small>${escapeHtml(stats.private_retained_records)} private retained</small></dd></div>
    </dl>
  `;
}

function lifecycleFindingList(report: MemoryLifecycleResult): string {
  if (report.findings.length === 0) {
    return `<div class="empty-state">No lifecycle findings for this snapshot.</div>`;
  }
  return `
    <div class="lifecycle-findings">
      ${report.findings.map((finding) => `
        <article class="lifecycle-finding ${escapeHtml(finding.severity)}">
          <div>
            <strong>${escapeHtml(finding.summary)}</strong>
            <span>${escapeHtml(titleCase(finding.severity))}</span>
          </div>
          <p>${escapeHtml(finding.reason)}</p>
          <small>${escapeHtml(pluralize(finding.record_ids.length, "record"))}: ${finding.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function lifecycleActions(report: MemoryLifecycleResult): string {
  if (report.suggested_actions.length === 0) {
    return `<div class="empty-state">No lifecycle actions suggested.</div>`;
  }
  return `
    <div class="lifecycle-actions">
      ${report.suggested_actions.slice(0, 6).map((action) => `
        <article class="lifecycle-action ${action.safe_to_run ? "safe" : "review"}">
          <div>
            <span class="pill ${action.safe_to_run ? "state-canonical" : "warning"}">${escapeHtml(action.safe_to_run ? "Read-only" : "Needs review")}</span>
            <strong>${escapeHtml(action.recommended_action)}</strong>
          </div>
          <code>${escapeHtml(action.command)}</code>
          <small>${escapeHtml(action.required_when)}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function memoryLifecycleFoldSummary(report: MemoryLifecycleResult): string {
  const findings = report.findings.length;
  const actions = report.suggested_actions.length;
  if (findings === 0 && actions === 0) return "No lifecycle work";
  return [
    findings > 0 ? pluralize(findings, "finding") : undefined,
    actions > 0 ? pluralize(actions, "action") : undefined
  ].filter((part): part is string => Boolean(part)).join(" | ");
}

function memoryLifecyclePanel(report: MemoryLifecycleResult, panelClass = "panel"): string {
  const totalFindings = report.findings.length;
  const totalActions = report.suggested_actions.length;
  if (report.stats.total_records === 0 && totalFindings === 0 && totalActions === 0) return "";
  return `
    <details class="${escapeHtml(panelClass)} memory-lifecycle" data-dashboard-detail="memory-lifecycle-audit" aria-label="Memory Lifecycle">
      <summary class="dashboard-fold-summary">
        <span>Memory Lifecycle</span>
        <small>${escapeHtml(memoryLifecycleFoldSummary(report))}</small>
      </summary>
      <div class="lifecycle-policy">
        <div>
          <strong>Lifecycle Policy</strong>
          <code>${escapeHtml(report.policy.id)}</code>
        </div>
        <span>Read-only</span>
        <span>${escapeHtml(report.policy.stale_after_days)}d stale</span>
        <span>${escapeHtml(report.policy.archive_after_days)}d archive review</span>
        <span>low confidence &lt; ${escapeHtml(report.policy.low_confidence_threshold)}</span>
      </div>
      ${lifecycleSummary(report)}
      ${lifecycleFindingList(report)}
      <details class="lifecycle-action-details" data-dashboard-detail="memory-lifecycle:${escapeHtml(report.generated_at)}">
        <summary>Lifecycle suggestions</summary>
        ${lifecycleActions(report)}
      </details>
    </details>
  `;
}

function contextPackReviewChecks(review: DashboardContextPackReview): string {
  const checks = review.handoff_pack?.quality_gate.checks ?? [];
  if (checks.length === 0) return `<div class="empty-state">No context pack checks available.</div>`;
  const passed = checks.filter((check) => check.status === "pass").length;
  const needsReview = checks.length - passed;
  const summary = needsReview === 0
    ? "All quality checks passed"
    : `${pluralize(needsReview, "check")} needs review`;
  return `
    <details class="context-pack-checks-fold" data-dashboard-detail="context-pack-checks">
      <summary class="dashboard-fold-summary">
        <span>Quality Checks</span>
        <small>${escapeHtml(summary)}</small>
      </summary>
      <ul class="context-pack-checks">
        ${checks.map((check) => `
          <li class="${check.status === "pass" ? "good" : "warning"}">
            <span>${escapeHtml(check.status)}</span>
            <strong>${escapeHtml(check.label)}</strong>
            ${check.count === undefined ? "" : `<em>${escapeHtml(check.count)}</em>`}
            <small>${escapeHtml(check.message)}</small>
            <code>${escapeHtml(check.source)}</code>
          </li>
        `).join("")}
      </ul>
    </details>
  `;
}

function contextPackReviewItemColumn(title: string, items: DashboardContextPackReviewItem[]): string {
  return `
    <div>
      <h3>${escapeHtml(title)}</h3>
      ${items.length === 0 ? `<div class="empty-state">None in this snapshot.</div>` : `
        <div class="context-pack-items">
          ${items.map((item) => `
            <article class="context-pack-item">
              ${textExcerptBlock(item.text)}
              <small><code>${escapeHtml(item.evidence.source)}</code>${item.evidence.record_id ? ` <code>${escapeHtml(item.evidence.record_id)}</code>` : ""}</small>
            </article>
          `).join("")}
        </div>
      `}
    </div>
  `;
}

function contextPackReviewSummary(review: DashboardContextPackReview): string {
  const pack = review.handoff_pack;
  if (!pack) return "unavailable";
  const gate = pack.quality_gate;
  if (gate.status === "ready" && gate.failed_check_ids.length === 0 && gate.warnings.length === 0) {
    return contextPackEvidenceSummary(pack) === "No handoff evidence"
      ? "Ready handoff context | no handoff evidence"
      : "Ready handoff context";
  }
  const checkSummary = gate.failed_check_ids.length === 0 && gate.warnings.length === 0 ? "all checks passed" : `${pluralize(gate.failed_check_ids.length, "failed check")} | ${pluralize(gate.warnings.length, "warning")}`;
  const evidenceSummary = contextPackEvidenceSummary(pack).toLowerCase();
  return `${gate.status} | ${checkSummary} | ${evidenceSummary}`;
}

function contextPackReadinessSentence(gate: DashboardContextPackReviewQualityGate): string {
  if (gate.status === "ready" && gate.failed_check_ids.length === 0 && gate.warnings.length === 0) {
    return "Ready to hand off: all checks passed.";
  }
  const reviewItems = [
    ...gate.failed_check_ids.map((id) => id.replace(/_/g, " ")),
    ...gate.warnings
  ];
  return `Review before handoff: ${reviewItems.length > 0 ? reviewItems.join(" | ") : "quality gate needs review"}.`;
}

function contextPackQualityBrief(gate: DashboardContextPackReviewQualityGate): string {
  const checks = gate.checks;
  const passedChecks = checks.filter((check) => check.status === "pass").length;
  const needsReview = checks.length - passedChecks;
  return needsReview === 0
    ? "Quality checks passed."
    : `Quality checks: ${passedChecks} passed | ${needsReview} review.`;
}

function contextPackReviewBrief(review: DashboardContextPackReview): string {
  const pack = review.handoff_pack;
  if (!pack) return "";
  const gate = pack.quality_gate;
  const captureCommand = pack.next_actions.find((action) => action.id === "capture_session")?.command ?? "missing";
  return `
        <div class="context-pack-brief" data-context-pack-brief>
          <h4>Handoff readiness</h4>
          <ul>
            <li>${escapeHtml(contextPackReadinessSentence(gate))}</li>
            <li>${escapeHtml(contextPackQualityBrief(gate))}</li>
            <li>Evidence available: ${escapeHtml(contextPackEvidenceSummary(pack))}.</li>
            <li>Capture action: <code>${escapeHtml(captureCommand)}</code>.</li>
          </ul>
        </div>
  `;
}

function contextPackReadinessChips(review: DashboardContextPackReview): string {
  const pack = review.handoff_pack;
  if (!pack) return "";
  const gate = pack.quality_gate;
  const checks = gate.checks;
  const passedChecks = checks.filter((check) => check.status === "pass").length;
  const evidenceCount = pack.recent_decisions.length + pack.open_threads.length + pack.risks.length;
  const captureActionVisible = pack.next_actions.some((action) => action.id === "capture_session");
  return `
        <div class="context-pack-readiness" aria-label="Context Pack readiness">
          <span class="context-pack-chip ${gate.status === "ready" ? "good" : "warning"}">${escapeHtml(titleCase(gate.status))}</span>
          <span class="context-pack-chip ${passedChecks === checks.length ? "good" : "warning"}">${escapeHtml(passedChecks)}/${escapeHtml(checks.length)} checks</span>
          <span class="context-pack-chip info">${escapeHtml(pluralize(evidenceCount, "evidence item"))}</span>
          <span class="context-pack-chip ${captureActionVisible ? "good" : "warning"}">${escapeHtml(captureActionVisible ? "Capture action visible" : "Capture action missing")}</span>
        </div>
  `;
}

function contextPackReviewOpenAttribute(review: DashboardContextPackReview): string {
  const gate = review.handoff_pack?.quality_gate;
  if (!gate) return "";
  return gate.status === "ready" && gate.failed_check_ids.length === 0 && gate.warnings.length === 0 ? "" : " open";
}

function contextPackEvidenceSummary(pack: DashboardContextPackReview["handoff_pack"]): string {
  if (!pack) return "No handoff evidence";
  const counts = [
    pack.recent_decisions.length > 0 ? pluralize(pack.recent_decisions.length, "decision") : undefined,
    pack.open_threads.length > 0 ? pluralize(pack.open_threads.length, "thread") : undefined,
    pack.risks.length > 0 ? pluralize(pack.risks.length, "risk") : undefined
  ].filter((count): count is string => count !== undefined);
  return counts.length > 0 ? counts.join(" | ") : "No handoff evidence";
}

function contextPackEvidenceFoldSummary(pack: DashboardContextPackReview["handoff_pack"]): string {
  return contextPackEvidenceSummary(pack) === "No handoff evidence"
    ? "No handoff evidence"
    : "Handoff evidence available";
}

function contextPackReviewPanel(review: DashboardContextPackReview): string {
  if (!review.available || !review.handoff_pack) {
    return `
      <details class="panel context-pack-review" data-dashboard-detail="context-pack-review" data-context-pack-state="unavailable" aria-label="Context Pack Review">
        <summary class="dashboard-fold-summary context-pack-review-fold">
          <span>Context Pack Review</span>
          <small>unavailable</small>
        </summary>
        <div class="empty-state">${escapeHtml(review.unavailable_reason ?? "Project context is required for Context Pack Review.")}</div>
      </details>
    `;
  }
  const pack = review.handoff_pack;
  const gate = pack.quality_gate;
  return `
    <details${contextPackReviewOpenAttribute(review)} class="panel context-pack-review" data-dashboard-detail="context-pack-review" data-context-pack-state="${escapeHtml(gate.status)}" aria-label="Context Pack Review">
      <summary class="dashboard-fold-summary context-pack-review-fold">
        <span>Context Pack Review</span>
        <small>${escapeHtml(contextPackReviewSummary(review))}</small>
      </summary>
      <div class="context-pack-review-body">
        ${contextPackReadinessChips(review)}
        <div class="context-pack-heading">
          <h2>Context Pack Review</h2>
          <span>${escapeHtml(gate.status)}</span>
        </div>
        <div class="lifecycle-policy">
          <div>
            <strong>${escapeHtml(pack.purpose)}</strong>
            <code>${escapeHtml(review.project_id ?? "unknown")}</code>
          </div>
          <span>Read-only</span>
          <span>${escapeHtml(review.generated_from.store)}</span>
          <span>writes: ${escapeHtml(review.generated_from.writes)}</span>
          <span>sync pull: ${escapeHtml(review.generated_from.sync_pull)}</span>
        </div>
        ${contextPackReviewBrief(review)}
        <dl class="context-pack-summary">
          <div><dt>Current goal</dt><dd>${escapeHtml(pack.current_goal?.text ?? "none")}<small>${escapeHtml(pack.current_goal?.source ?? "missing")}</small></dd></div>
          <div><dt>Quality gate</dt><dd>${escapeHtml(gate.status)}<small>${escapeHtml(gate.failed_check_ids.length ? gate.failed_check_ids.join(", ") : "no failed checks")}</small></dd></div>
          <div><dt>End action</dt><dd><code>${escapeHtml(pack.next_actions[0]?.command ?? "missing")}</code><small>${escapeHtml(pack.next_actions[0]?.evidence.source ?? "missing")}</small></dd></div>
          <div><dt>Evidence</dt><dd><code>${escapeHtml(pack.evidence.records)}</code> <code>${escapeHtml(pack.evidence.events)}</code> <code>${escapeHtml(pack.evidence.next)}</code></dd></div>
        </dl>
        ${contextPackReviewChecks(review)}
        <details class="context-pack-evidence" data-dashboard-detail="context-pack-evidence">
          <summary class="dashboard-fold-summary">
            <span>Context Evidence</span>
            <small>${escapeHtml(contextPackEvidenceFoldSummary(pack))}</small>
          </summary>
          <div class="context-pack-grid">
            ${contextPackReviewItemColumn("Recent Decisions", pack.recent_decisions)}
            ${contextPackReviewItemColumn("Open Threads", pack.open_threads)}
            ${contextPackReviewItemColumn("Risks", pack.risks)}
          </div>
        </details>
      </div>
    </details>
  `;
}

function capturePolicyInspectCommand(report: CapturePolicyResult, recordId: string): string {
  return report.suggested_actions_by_id[`inspect:${recordId}`]?.command
    ?? timelineRecordCommand(recordId, report.records_by_id[recordId]?.project_id);
}

function capturePolicyInspectAction(report: CapturePolicyResult, recordId: string): string {
  return report.suggested_actions_by_id[`inspect:${recordId}`]?.recommended_action
    ?? "inspect_policy_decision";
}

function capturePolicyDecisionCards(report: CapturePolicyResult): string {
  return `
    <div class="capture-policy-decisions">
      ${report.decisions.slice(0, 8).map((decision) => {
        const isReview = decision.decision === "review";
        const isCapture = decision.decision === "capture";
        const isActionableReview = decision.review_required;
        const inspectCommand = capturePolicyInspectCommand(report, decision.record_id);
        const inspectAction = capturePolicyInspectAction(report, decision.record_id);
        const title = isActionableReview
          ? "Review in Capture Inbox"
          : isReview
            ? "Review already handled"
            : isCapture
              ? "Auto-captured handoff"
              : "Policy archived";
        const stateHint = isActionableReview
          ? "User action required"
          : isCapture
            ? "No user action required"
            : "No inbox action";
        return `
          <article
            class="capture-policy-decision ${isReview ? "review" : isCapture ? "captured" : "archived"}"
            data-capture-policy-decision="${escapeHtml(decision.record_id)}"
            ${isActionableReview ? `data-capture-inbox-record="${escapeHtml(decision.record_id)}"` : ""}
          >
            <div class="capture-inbox-main">
              <div>
                <h3>${escapeHtml(title)}</h3>
                ${textExcerptBlock(decision.text)}
              </div>
              <span class="pill ${isReview || isCapture ? "state-candidate" : "state-archived"}">${escapeHtml(decision.decision)}</span>
            </div>
            <dl class="capture-inbox-summary">
              <div><dt>Rule</dt><dd>${decision.rule_ids.map((ruleId) => `<code>${escapeHtml(ruleId)}</code>`).join(" ") || "none"}</dd></div>
              <div><dt>State</dt><dd>${escapeHtml(isActionableReview ? decision.target_state : decision.state)}<small>${escapeHtml(stateHint)}</small></dd></div>
              <div><dt>Evidence</dt><dd>${decision.evidence.map((evidence) => `<code>${escapeHtml(evidence.source)}</code>`).join(" ")}</dd></div>
              <div><dt>Action</dt><dd>${escapeHtml(isActionableReview ? "review_capture_inbox" : inspectAction)}<small>${escapeHtml(isActionableReview ? "Uses Capture Inbox approval endpoints." : "Read-only timeline inspection.")}</small></dd></div>
              <div><dt>Inspect</dt><dd><code>${escapeHtml(inspectCommand)}</code></dd></div>
            </dl>
            ${isActionableReview ? `
              <div class="capture-inbox-actions">
                <button
                  type="button"
                  data-capture-inbox-reject
                  data-dashboard-action-id="${escapeHtml(captureInboxRecordActionId("reject", decision.record_id))}"
                  data-endpoint="${escapeHtml(captureInboxRejectEndpoint(decision.record_id))}"
                >Reject</button>
                <button
                  type="button"
                  class="primary"
                  data-capture-inbox-approve
                  data-dashboard-action-id="${escapeHtml(captureInboxRecordActionId("approve", decision.record_id))}"
                  data-endpoint="${escapeHtml(captureInboxApproveEndpoint(decision.record_id))}"
                >Approve Memory</button>
              </div>
              <p class="capture-inbox-status" data-capture-inbox-status role="status" aria-live="polite"></p>
            ` : ""}
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function capturePolicyFindingList(report: CapturePolicyResult): string {
  if (report.findings.length === 0) {
    return `<div class="empty-state">No capture policy findings for this snapshot.</div>`;
  }
  return `
    <div class="lifecycle-findings">
      ${report.findings.map((finding) => `
        <article class="lifecycle-finding ${escapeHtml(finding.severity)}">
          <div>
            <strong>${escapeHtml(finding.summary)}</strong>
            <span>${escapeHtml(finding.category)}</span>
          </div>
          <p>${escapeHtml(finding.reason)}</p>
          <small>${finding.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function capturePolicyRoutingBrief(report: CapturePolicyResult): string {
  const parts = [
    report.stats.auto_captured_records > 0 ? pluralize(report.stats.auto_captured_records, "auto-captured handoff") : undefined,
    report.stats.policy_archived_records > 0 ? pluralize(report.stats.policy_archived_records, "policy-archived handoff") : undefined
  ].filter((part): part is string => part !== undefined);
  return `
    <div class="capture-policy-routing-brief" aria-label="Capture policy routing brief">
      <h4>Routing brief</h4>
      <div>
        <strong>No capture inbox work</strong>
        ${parts.map((part) => `<span>${escapeHtml(part)}</span>`).join("")}
        <code>capture_policy.decisions_by_record_id</code>
      </div>
    </div>
  `;
}

function capturePolicyActionsList(report: CapturePolicyResult): string {
  if (report.suggested_actions.length === 0) {
    return `<div class="empty-state">No capture policy actions suggested.</div>`;
  }
  return `
    <div class="lifecycle-actions">
      ${report.suggested_actions.slice(0, 6).map((action) => `
        <article class="lifecycle-action safe">
          <div>
            <span class="pill state-canonical">Read-only</span>
            <strong>${escapeHtml(action.recommended_action)}</strong>
          </div>
          <code>${escapeHtml(action.command)}</code>
          <small>${escapeHtml(action.required_when)}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function capturePolicyAuditSummary(report: CapturePolicyResult): string {
  const parts = [
    report.stats.auto_captured_records > 0 ? `${report.stats.auto_captured_records} captured` : undefined,
    report.stats.review_records > 0 ? `${report.stats.review_records} review` : undefined,
    report.stats.policy_archived_records > 0 ? `${report.stats.policy_archived_records} archived` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" | ") : "No capture policy work";
}

function isReadOnlyCapturePolicyEvidence(report: CapturePolicyResult): boolean {
  return report.stats.review_records === 0
    && (report.stats.auto_captured_records > 0 || report.stats.policy_archived_records > 0)
    && (report.findings.length > 0 || report.suggested_actions.length > 0);
}

function capturePolicyAuditPanel(report: CapturePolicyResult, panelClass = "panel"): string {
  if (report.stats.total_autocapture_records === 0) return "";
  const readOnlyEvidence = isReadOnlyCapturePolicyEvidence(report);
  const summaryText = capturePolicyAuditSummary(report);
  const capturedRuleSummary = Object.entries(report.stats.captured_by_rule)
    .map(([ruleId, count]) => `${ruleId}: ${count}`)
    .join(" / ") || "no auto-captured handoffs";
  const ruleSummary = Object.entries(report.stats.archived_by_rule)
    .map(([ruleId, count]) => `${ruleId}: ${count}`)
    .join(" / ") || "no archived noise";
  return `
    <details class="${escapeHtml(panelClass)} capture-policy-audit" data-dashboard-detail="capture-policy-audit" aria-label="Capture Policy Audit">
      <summary class="dashboard-fold-summary"${readOnlyEvidence ? ` aria-label="Capture Policy Audit: ${escapeHtml(summaryText)}"` : ""}>
        <span>${escapeHtml(readOnlyEvidence ? "Policy Decision History" : "Capture Policy Audit")}</span>
        <small>${escapeHtml(readOnlyEvidence ? "Routing evidence" : summaryText)}</small>
      </summary>
      <div class="lifecycle-policy">
        <div>
          <strong>capture_policy</strong>
          <code>${escapeHtml(report.policy.id)}</code>
        </div>
        <span>Report read-only</span>
        <span>No auto-canonical</span>
        <span>${escapeHtml(capturedRuleSummary)}</span>
        <span>${escapeHtml(ruleSummary)}</span>
      </div>
      ${readOnlyEvidence ? capturePolicyRoutingBrief(report) : capturePolicyFindingList(report)}
      <details class="lifecycle-action-details" data-dashboard-detail="capture-policy:${escapeHtml(report.policy.id)}">
        <summary class="dashboard-fold-summary" aria-label="Routing details: Read-only evidence">
          <span>Routing details</span>
          <small>Read-only evidence</small>
        </summary>
        ${readOnlyEvidence ? capturePolicyFindingList(report) : ""}
        ${capturePolicyActionsList(report)}
        ${capturePolicyDecisionCards(report)}
      </details>
    </details>
  `;
}

function isCleanMemoryLifecycle(report: MemoryLifecycleResult): boolean {
  return report.findings.length === 0 && report.suggested_actions.length === 0;
}

function isCleanCapturePolicy(report: CapturePolicyResult): boolean {
  return report.stats.total_autocapture_records > 0
    && report.findings.length === 0
    && report.suggested_actions.length === 0;
}

function auditReports(input: {
  memoryLifecycle: MemoryLifecycleResult;
  capturePolicy: CapturePolicyResult;
}): string {
  const memoryLifecycle = memoryLifecyclePanel(input.memoryLifecycle);
  const capturePolicy = capturePolicyAuditPanel(input.capturePolicy);
  if (!memoryLifecycle && !capturePolicy) return "";
  if (isCleanMemoryLifecycle(input.memoryLifecycle) && isCleanCapturePolicy(input.capturePolicy)) {
    return `
      <details class="panel clean-audit-reports" data-dashboard-detail="clean-audit-reports" aria-label="Clean Audit Reports">
        <summary class="dashboard-fold-summary clean-audit-reports-fold">
          <span>Clean Audit Reports</span>
          <small>Clean lifecycle and capture audits</small>
        </summary>
        <div class="clean-audit-list">
          ${memoryLifecyclePanel(input.memoryLifecycle, "clean-audit-report")}
          ${capturePolicyAuditPanel(input.capturePolicy, "clean-audit-report")}
        </div>
      </details>
    `;
  }
  return `
    ${memoryLifecycle}
    ${capturePolicy}
  `;
}

function agentBars(agents: DashboardAgentChartItem[]): string {
  if (agents.length === 0) return `<div class="empty-state">No agent activity recorded yet.</div>`;
  return `
    <div class="agent-bars">
      ${agents.map((agent) => `
        <div class="bar-row"${agent.citation ? ` data-dashboard-citation="event:${escapeHtml(agent.citation.event_id)}"` : ""}>
          <div class="bar-label">
            <strong>${escapeHtml(agent.client)}</strong>
            <span>${escapeHtml(agent.events)} events | ${escapeHtml(agent.records)} records | ${escapeHtml(agent.relative_time)}</span>
          </div>
          <div class="bar-track" aria-hidden="true"><span style="width: ${escapeHtml(agent.weight)}%"></span></div>
          ${agent.citation ? `<small>${escapeHtml(agent.citation.timeline_command)}</small>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function memoryStateStack(states: DashboardMemoryStateChartItem[]): string {
  if (states.length === 0) return `<div class="empty-state">No records yet.</div>`;
  return `
    <div class="state-stack" aria-label="Record state distribution">
      <div class="stack-bar">
        ${states.map((state) => `<span class="state-${escapeHtml(state.state)}" style="width: ${escapeHtml(state.percent)}%" title="${escapeHtml(state.state)}: ${escapeHtml(state.count)}"></span>`).join("")}
      </div>
      <div class="stack-legend">
        ${states.map((state) => `<span><i class="state-${escapeHtml(state.state)}"></i>${escapeHtml(state.state)} | ${escapeHtml(state.count)}</span>`).join("")}
      </div>
    </div>
  `;
}

function recordTypeBars(types: DashboardRecordTypeChartItem[]): string {
  if (types.length === 0) return `<div class="empty-state">No record types yet.</div>`;
  return `
    <div class="type-bars" aria-label="Record type distribution">
      ${types.map((type) => `
        <div class="type-row type-${escapeHtml(type.kind)}">
          <div class="type-label">
            <strong>${escapeHtml(type.label)}</strong>
            <span>${escapeHtml(type.count)} | ${escapeHtml(type.percent)}%</span>
          </div>
          <div class="type-track" aria-hidden="true"><span style="width: ${escapeHtml(type.percent)}%"></span></div>
        </div>
      `).join("")}
    </div>
  `;
}

function syncRail(sync: DashboardSyncPositionChart): string {
  const behindWidth = Math.min(100, sync.behind * 20);
  const aheadWidth = Math.min(100, sync.ahead * 20);
  return `
    <div class="sync-rail ${sync.conflict ? "critical" : sync.dirty ? "warning" : ""}">
      <div class="rail-labels"><span>Remote</span><strong>${escapeHtml(syncPositionLabel(sync))}</strong><span>Local</span></div>
      <div class="rail">
        <span class="behind" style="width: ${escapeHtml(behindWidth)}%"></span>
        <i></i>
        <span class="ahead" style="width: ${escapeHtml(aheadWidth)}%"></span>
      </div>
      <p>${escapeHtml(sync.behind)} behind | ${escapeHtml(sync.ahead)} ahead</p>
    </div>
  `;
}

function citationCommands(citation: DashboardRecordCitation | DashboardEventCitation | DashboardAgentCitation): string {
  return `
    <div class="citation-links">
      <code>${escapeHtml(citation.timeline_command)}</code>
      ${"recall_command" in citation && citation.recall_command ? `<code>${escapeHtml(citation.recall_command)}</code>` : ""}
    </div>
  `;
}

function recentValueCard(record: DashboardValueRecord, extraClass = ""): string {
  const traceSummary = `${titleCase(record.kind)} ${record.type} ${recordLabel(record.id)}`;
  return `
    <article class="value-card${extraClass ? ` ${extraClass}` : ""}" data-dashboard-citation="record:${escapeHtml(record.id)}">
      <div class="value-card-head">
        <span class="pill state-${escapeHtml(record.state)}">${escapeHtml(record.title)}</span>
        <time title="${escapeHtml(record.exact_time)}">${escapeHtml(record.relative_time)}</time>
      </div>
      ${textExcerptBlock(record.summary, "data-full-summary-hidden")}
      <footer>
        <span>${escapeHtml(`${record.source_label} ${recordLabel(record.id)}`)}</span>
        <span>${escapeHtml(record.state)}</span>
        <span>${escapeHtml(record.project_id ?? record.scope)}</span>
      </footer>
      <details data-dashboard-detail="value:${escapeHtml(record.id)}">
        <summary class="dashboard-fold-summary" aria-label="Audit trace commands: ${escapeHtml(traceSummary)}">
          <span>Trace</span>
          <small>${escapeHtml(recordLabel(record.id))}</small>
        </summary>
        <dl>
          <div><dt>ID</dt><dd><code>${escapeHtml(record.id)}</code></dd></div>
          ${record.citation.event_id ? `<div><dt>Event</dt><dd><code>${escapeHtml(record.citation.event_id)}</code></dd></div>` : ""}
          <div><dt>Source</dt><dd>${escapeHtml(record.source_detail)}</dd></div>
          <div><dt>Kind</dt><dd>${escapeHtml(record.kind)} / ${escapeHtml(record.type)}</dd></div>
          <div><dt>Trace</dt><dd>${citationCommands(record.citation)}</dd></div>
        </dl>
      </details>
    </article>
  `;
}

function recentValueCards(records: DashboardValueRecord[]): string {
  if (records.length === 0) return `<div class="empty-state">No recent records to summarize.</div>`;
  const visible = records.slice(0, RECENT_VALUE_VISIBLE_LIMIT);
  const overflow = records.slice(RECENT_VALUE_VISIBLE_LIMIT);
  return `
    <div class="value-grid">
      ${visible.map((record) => recentValueCard(record)).join("")}
    </div>
    ${overflow.length === 0 ? "" : `
      <details class="recent-value-overflow" data-dashboard-detail="recent-value-overflow">
        <summary class="dashboard-fold-summary">
          <span>More Recent Value</span>
          <small>${escapeHtml(pluralize(overflow.length, "additional record"))}</small>
        </summary>
        <div class="value-grid value-grid-overflow">
          ${overflow.map((record) => recentValueCard(record, "value-card-overflow")).join("")}
        </div>
      </details>
    `}
  `;
}

function captureInboxAuditSummary(items: DashboardCaptureInbox): string {
  return [
    "manual review",
    "no auto-canonical",
    pluralize(items.total, "candidate"),
    `auto-captured ${items.autocapture_policy.auto_captured_total}`,
    `policy archived ${items.autocapture_policy.archived_total}`
  ].join(" | ");
}

function captureInboxAudit(items: DashboardCaptureInbox): string {
  const auditSummary = captureInboxAuditSummary(items);
  return `
      <details class="capture-inbox-audit" data-dashboard-detail="capture-inbox-audit">
        <summary class="dashboard-fold-summary" aria-label="Capture Audit: ${escapeHtml(auditSummary)}">
          <span>Capture Audit</span>
          <small>Manual review, no auto-canonical</small>
        </summary>
        <div class="capture-policy">
          <div>
            <strong>Capture Policy</strong>
            <code>${escapeHtml(items.policy.id)}</code>
          </div>
          <span>Review Policy</span>
          <span>Manual review</span>
          <span>No auto-canonical</span>
          <span>Trust disabled</span>
          <span>User action required</span>
          <span>${escapeHtml(items.policy.grouping.group_by.join(" / "))}</span>
          <span>stale batch protection</span>
        </div>
        <div class="capture-policy">
          <div>
            <strong>Autocapture Policy</strong>
            <code>${escapeHtml(items.autocapture_policy.id)}</code>
          </div>
          <span>No auto-canonical</span>
          <span>Auto-captured ${escapeHtml(items.autocapture_policy.auto_captured_total)}</span>
          <span>Policy archived ${escapeHtml(items.autocapture_policy.archived_total)}</span>
          <span>${escapeHtml(Object.entries(items.autocapture_policy.captured_by_rule).map(([ruleId, count]) => `${ruleId}: ${count}`).join(" / ") || "no auto-captured handoffs")}</span>
          <span>${escapeHtml(Object.entries(items.autocapture_policy.archived_by_rule).map(([ruleId, count]) => `${ruleId}: ${count}`).join(" / ") || "no archived noise")}</span>
        </div>
      ${items.autocapture_policy.auto_captured_examples.length ? `
        <details class="capture-policy-rules" data-dashboard-detail="autocapture-policy-captured:${escapeHtml(items.autocapture_policy.id)}">
          <summary>Auto-captured handoffs</summary>
          <ul class="capture-policy-rule-list">
            ${items.autocapture_policy.auto_captured_examples.map((example) => `
              <li>
                <code>${escapeHtml(example.id)}</code>
                <strong>${escapeHtml(example.rule_ids.join(", ") || "policy")}</strong>
                <span>${escapeHtml(textExcerpt(`${example.text}${example.reason ? ` ${example.reason}` : ""}`).text)}</span>
              </li>
            `).join("")}
          </ul>
        </details>
      ` : ""}
      ${items.autocapture_policy.archived_examples.length ? `
        <details class="capture-policy-rules" data-dashboard-detail="autocapture-policy:${escapeHtml(items.autocapture_policy.id)}">
          <summary>Policy archived captures</summary>
          <ul class="capture-policy-rule-list">
            ${items.autocapture_policy.archived_examples.map((example) => `
              <li>
                <code>${escapeHtml(example.id)}</code>
                <strong>${escapeHtml(example.rule_ids.join(", ") || "policy")}</strong>
                <span>${escapeHtml(textExcerpt(`${example.text}${example.reason ? ` ${example.reason}` : ""}`).text)}</span>
              </li>
            `).join("")}
          </ul>
        </details>
      ` : ""}
      <details class="capture-policy-rules" data-dashboard-detail="capture-policy:${escapeHtml(items.policy.id)}">
        <summary>Policy rules</summary>
        <p>${escapeHtml(items.policy.explanation)}</p>
        <dl>
          <div><dt>Version</dt><dd>${escapeHtml(items.policy.version)}</dd></div>
          <div><dt>Mode</dt><dd>${escapeHtml(items.policy.mode)}</dd></div>
          <div><dt>Grouping</dt><dd>${escapeHtml(items.policy.grouping.group_by.join(", "))}</dd></div>
        </dl>
        <ul class="capture-policy-rule-list">
          ${items.policy.noise_rules.map((rule) => `
            <li>
              <code>${escapeHtml(rule.id)}</code>
              <strong>${escapeHtml(rule.label)}</strong>
              <span>${escapeHtml(rule.description)}</span>
            </li>
          `).join("")}
        </ul>
      </details>
      </details>
    `;
}

function captureInboxDecisionBrief(item: DashboardCaptureInboxItem): string {
  const reason = item.provenance_reason ?? "Candidate memory is waiting for review.";
  return `
    <div class="capture-inbox-brief" data-capture-inbox-brief>
      <h4>Approval brief</h4>
      <dl class="capture-inbox-brief-list" aria-label="Approval brief">
        <div><dt>Change</dt><dd>Review 1 candidate</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(reason)}</dd></div>
        <div><dt>Guard</dt><dd>Server rechecks active candidate before writing</dd></div>
        <div><dt>Writes</dt><dd>Approve appends memory; Reject appends archive</dd></div>
      </dl>
    </div>
  `;
}

function captureInboxGroupBrief(group: DashboardCaptureInboxGroup): string {
  const scope = group.noise.level === "likely_noise" ? "Likely noise" : "Normal review";
  return `
    <div class="capture-inbox-brief" data-capture-inbox-group-brief>
      <h4>Approval brief</h4>
      <dl class="capture-inbox-brief-list" aria-label="Approval brief">
        <div><dt>Change</dt><dd>${escapeHtml(`Review ${pluralize(group.total, "candidate")}`)}</dd></div>
        <div><dt>Scope</dt><dd>${escapeHtml(scope)}</dd></div>
        <div><dt>Guard</dt><dd>Server rechecks selected group records before writing</dd></div>
        <div><dt>Writes</dt><dd>Approve Group appends memory; Reject Group appends archive</dd></div>
      </dl>
    </div>
  `;
}

function captureInboxGroupFaceTitle(group: DashboardCaptureInboxGroup): string {
  return `Review ${pluralize(group.total, "capture")}`;
}

function captureInboxGroupFaceHint(group: DashboardCaptureInboxGroup): string {
  return group.noise.level === "likely_noise" ? "Archive likely noise or inspect items." : "Approve or reject this group.";
}

function captureInboxQueueSummary(items: DashboardCaptureInbox): string {
  const likelyNoise = items.items.filter((item) => item.noise.level === "likely_noise").length;
  const normalReview = Math.max(0, items.total - likelyNoise);
  return `
      <div class="capture-inbox-queue-summary" data-capture-inbox-queue-summary>
        <div>
          <h3>Queue summary</h3>
          <p>${escapeHtml(pluralize(items.total, "candidate"))} grouped into ${escapeHtml(pluralize(items.group_total, "review group"))}.</p>
          <p>Review groups first; open item details only when needed. Canonical memory still requires approval.</p>
        </div>
        <div class="capture-inbox-queue-chips" aria-label="Capture Inbox queue counts">
          <span>${escapeHtml(normalReview)} normal review</span>
          <span>${escapeHtml(likelyNoise)} likely noise</span>
        </div>
      </div>
  `;
}

function captureInbox(items: DashboardCaptureInbox): string {
  if (items.total === 0) return "";
  return `
    <section id="capture-inbox" class="panel capture-inbox" aria-label="Capture Inbox">
      <div class="capture-inbox-heading">
        <h2>Capture Inbox</h2>
        <span>${escapeHtml(pluralize(items.total, "candidate"))} | ${escapeHtml(pluralize(items.group_total, "group"))}</span>
      </div>
      ${items.total > 0 ? captureInboxQueueSummary(items) : ""}
      <div class="capture-inbox-list">
        ${items.groups.map((group) => {
          const groupItems = items.items.filter((item) => item.group_id === group.id);
          return `
          <article class="capture-inbox-group" data-capture-inbox-group="${escapeHtml(group.id)}">
            <div class="capture-inbox-main">
              <div>
                <h3>${escapeHtml(captureInboxGroupFaceTitle(group))}</h3>
                <p>${escapeHtml(captureInboxGroupFaceHint(group))}</p>
              </div>
              <span class="pill ${group.noise.level === "likely_noise" ? "warning" : "state-candidate"}">${escapeHtml(group.noise.level === "likely_noise" ? "Likely noise" : "candidate")}</span>
            </div>
            ${captureInboxGroupBrief(group)}
            <details class="capture-inbox-context" data-dashboard-detail="capture-inbox-context:${escapeHtml(group.id)}">
              <summary>Review context</summary>
              <dl class="capture-inbox-summary" data-capture-inbox-group-summary>
                <div><dt>Source</dt><dd>${escapeHtml(group.source_label)}<small>${escapeHtml(group.source_detail)}</small></dd></div>
                <div><dt>Project</dt><dd><code>${escapeHtml(group.project_id ?? "global")}</code></dd></div>
                <div><dt>Items</dt><dd>${escapeHtml(pluralize(group.total, "candidate"))}<small>${escapeHtml(group.noise.suggested_action)} suggested</small></dd></div>
                <div><dt>Captured</dt><dd><time title="${escapeHtml(group.latest_at)}">${escapeHtml(group.relative_time)}</time></dd></div>
              </dl>
            </details>
            <details class="capture-inbox-item-review" data-dashboard-detail="capture-group:${escapeHtml(group.id)}">
              <summary>Item review</summary>
              <details class="capture-inbox-evidence-index" data-dashboard-detail="capture-inbox-evidence-index:${escapeHtml(group.id)}">
                <summary>Evidence index</summary>
                <dl>
                  <div><dt>Group</dt><dd><code>${escapeHtml(group.id)}</code></dd></div>
                  <div><dt>Records</dt><dd>${group.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}</dd></div>
                  <div><dt>Rules</dt><dd>${group.noise.rule_ids.length ? group.noise.rule_ids.map((ruleId) => `<code>${escapeHtml(ruleId)}</code>`).join(" ") : "none"}</dd></div>
                  <div><dt>Noise</dt><dd>${escapeHtml(group.noise.reasons.length ? group.noise.reasons.join(" ") : "No noise signals detected.")}</dd></div>
                </dl>
              </details>
              <div class="capture-inbox-items">
                ${groupItems.map((item) => `
                  <details class="capture-inbox-item" data-capture-inbox-record="${escapeHtml(item.id)}">
                    <summary class="capture-inbox-item-summary">
                      <span class="capture-inbox-item-main">
                        <h3>${escapeHtml(titleCase(item.type || item.kind))}</h3>
                        ${textExcerptBlock(item.text)}
                      </span>
                      <span class="capture-inbox-item-meta">
                        <span>${escapeHtml(item.relative_time)}</span>
                        <span>${escapeHtml(item.noise.level === "likely_noise" ? "Likely noise" : "candidate")}</span>
                      </span>
                    </summary>
                    <div class="capture-inbox-item-body">
                      <span class="pill ${item.noise.level === "likely_noise" ? "warning" : "state-candidate"}">${escapeHtml(item.noise.level === "likely_noise" ? "Likely noise" : "candidate")}</span>
                      ${captureInboxDecisionBrief(item)}
                      <dl class="capture-inbox-summary">
                        <div><dt>Confidence</dt><dd>${escapeHtml(item.confidence)}<small>${escapeHtml(item.priority)} priority</small></dd></div>
                        <div><dt>Captured</dt><dd><time title="${escapeHtml(item.exact_time)}">${escapeHtml(item.relative_time)}</time></dd></div>
                        <div><dt>Reason</dt><dd>${escapeHtml(item.provenance_reason ?? "Candidate memory is waiting for review.")}</dd></div>
                        <div><dt>Trace</dt><dd>${citationCommands(item.citation)}</dd></div>
                      </dl>
                      <div class="capture-inbox-actions">
                        <button
                          type="button"
                          data-capture-inbox-reject
                          data-dashboard-action-id="${escapeHtml(captureInboxRecordActionId("reject", item.id))}"
                          data-endpoint="${escapeHtml(item.reject_endpoint)}"
                        >Reject</button>
                        <button
                          type="button"
                          class="primary"
                          data-capture-inbox-approve
                          data-dashboard-action-id="${escapeHtml(captureInboxRecordActionId("approve", item.id))}"
                          data-endpoint="${escapeHtml(item.approve_endpoint)}"
                        >Approve Memory</button>
                      </div>
                      <p class="capture-inbox-status" data-capture-inbox-status role="status" aria-live="polite"></p>
                    </div>
                  </details>
                `).join("")}
              </div>
            </details>
            <div class="capture-inbox-actions">
              <button
                type="button"
                data-capture-inbox-group-reject
                data-dashboard-action-id="${escapeHtml(captureInboxGroupActionId("reject", group.id))}"
                data-endpoint="${escapeHtml(group.reject_endpoint)}"
                data-record-ids="${escapeHtml(group.record_ids.join(","))}"
              >Reject Group</button>
              <button
                type="button"
                class="primary"
                data-capture-inbox-group-approve
                data-dashboard-action-id="${escapeHtml(captureInboxGroupActionId("approve", group.id))}"
                data-endpoint="${escapeHtml(group.approve_endpoint)}"
                data-record-ids="${escapeHtml(group.record_ids.join(","))}"
              >Approve Group</button>
            </div>
            <p class="capture-inbox-status" data-capture-inbox-status role="status" aria-live="polite"></p>
          </article>
        `;
        }).join("")}
      </div>
      ${captureInboxAudit(items)}
    </section>
  `;
}

function recordsTable(records: DashboardRecordSummary[]): string {
  const visibleRecords = records.slice(0, DEBUG_INSPECTOR_ROW_LIMIT);
  const overflow = records.length - visibleRecords.length;
  const rows = visibleRecords.map((record) => `
    <tr data-dashboard-citation="record:${escapeHtml(record.id)}">
      <td><code class="copy-id" title="${escapeHtml(record.id)}">${escapeHtml(record.id)}</code></td>
      <td>${escapeHtml(record.kind)}</td>
      <td>${escapeHtml(record.type)}</td>
      <td>${escapeHtml(record.scope)}${record.project_id ? `<small title="${escapeHtml(record.project_id)}">${escapeHtml(record.project_id)}</small>` : ""}</td>
      <td><span class="pill state-${escapeHtml(record.state)}">${escapeHtml(record.state)}</span></td>
      <td><span class="truncate" title="${escapeHtml(sourceLabel(record.source))}">${escapeHtml(humanSourceLabel(record.source))}</span></td>
      <td><time title="${escapeHtml(record.updated_at)}">${escapeHtml(record.updated_at)}</time></td>
      <td>
        <details data-dashboard-detail="record:${escapeHtml(record.id)}">
          <summary aria-label="${escapeHtml(recordIndexAccessibleSummary(record))}">${recordIndexSummary(record)}</summary>
          ${textExcerptBlock(record.text)}
          ${citationCommands(record.citation)}
        </details>
      </td>
    </tr>
  `).join("");
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Kind</th>
            <th>Type</th>
            <th>Scope</th>
            <th>State</th>
            <th>Source</th>
            <th>Updated</th>
            <th>Content</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${overflow > 0 ? debugInspectorOverflow(overflow, "record", "recent_records") : ""}
  `;
}

function recordIndexSummary(record: DashboardRecordSummary): string {
  return `
    <span>${escapeHtml(`Record ${recordLabel(record.id)}`)}</span>
    <small>Details</small>
  `;
}

function recordIndexAccessibleSummary(record: DashboardRecordSummary): string {
  return `Record details: ${titleCase(record.kind)} ${record.type} from ${humanSourceLabel(record.source)} ${recordLabel(record.id)}`;
}

function eventsTimeline(events: DashboardEventSummary[]): string {
  const visibleEvents = events.slice(0, DEBUG_INSPECTOR_ROW_LIMIT);
  const overflow = events.length - visibleEvents.length;
  return `
    <div class="event-list">
      ${visibleEvents.map((event) => `
        <details class="event-row" data-dashboard-detail="event:${escapeHtml(event.event_id)}" data-dashboard-citation="event:${escapeHtml(event.event_id)}">
          <summary>
            <span>${escapeHtml(eventSummaryLabel(event.op))}</span>
            <time>${escapeHtml(event.created_at)}</time>
          </summary>
          <dl>
            <div><dt>Event</dt><dd><code>${escapeHtml(event.event_id)}</code></dd></div>
            ${event.record_id ? `<div><dt>Record</dt><dd><code>${escapeHtml(event.record_id)}</code></dd></div>` : ""}
            <div><dt>Source</dt><dd>${escapeHtml(sourceLabel(event.source))}</dd></div>
            <div><dt>Trace</dt><dd>${citationCommands(event.citation)}</dd></div>
          </dl>
        </details>
      `).join("")}
    </div>
    ${overflow > 0 ? debugInspectorOverflow(overflow, "event", "recent_events") : ""}
  `;
}

function eventSummaryLabel(op: string): string {
  return op === "upsert_record" ? "Record update" : titleCase(op);
}

function debugInspectorOverflow(count: number, kind: "record" | "event", evidencePath: "recent_records" | "recent_events"): string {
  return `
    <div class="debug-inspector-overflow">
      <span class="debug-inspector-overflow-count">${escapeHtml(`${pluralize(count, `more ${kind}`)} kept in /api/dashboard`)}</span>
      <span>Full ${escapeHtml(kind)} list stays in <code>${escapeHtml(evidencePath)}</code>.</span>
    </div>
  `;
}

function syncActionBrief(data: DashboardData): string {
  const syncLane = data.action_board.items_by_id.sync;
  if (syncLane.value === 0 || (syncLane.severity !== "warning" && syncLane.severity !== "critical")) return "";
  const syncAction = data.attention_items.find((item) => item.severity !== "info" && isSyncAttentionItem(item));
  if (!syncAction?.action_command) return "";
  const sync = data.sync;
  return `
    <section class="sync-action-brief ${escapeHtml(syncAction.severity)}" data-dashboard-sync-action>
      <div class="sync-action-main">
        <h3>Sync Action</h3>
        <strong>${escapeHtml(syncAction.action_label)}</strong>
        <small>${escapeHtml(syncLane.detail)}</small>
      </div>
      <code>${escapeHtml(syncAction.action_command)}</code>
      <div class="sync-action-context" aria-label="Sync action context">
        <span>${sync.remote ? "Remote configured" : "Remote not configured"}</span>
        <span>Branch ${escapeHtml(sync.branch ?? "unknown")}</span>
        <span>${escapeHtml(sync.behind ?? 0)} behind</span>
        <span>${escapeHtml(sync.ahead ?? 0)} ahead</span>
      </div>
    </section>
  `;
}

function syncPositionFocus(data: DashboardData): string {
  return `
    <section class="signal-card sync-position-focus" data-dashboard-sync-position-focus>
      <h2>Sync Position</h2>
      ${syncRail(data.charts.sync_position)}
    </section>
  `;
}

function storeTelemetryContext(data: DashboardData): string {
  return `
    <details class="store-telemetry-context" data-dashboard-detail="store-telemetry-context">
      <summary class="dashboard-fold-summary">
        <span>Telemetry Context</span>
        <small>Agent and record signals</small>
      </summary>
      <section class="visual-grid">
        <div class="signal-card">
          <h2>Agent Activity</h2>
          ${agentBars(data.charts.agent_activity)}
        </div>
        <div class="signal-card">
          <h2>Record Quality</h2>
          ${memoryStateStack(data.charts.memory_states)}
        </div>
        <div class="signal-card">
          <h2>Record Types</h2>
          ${recordTypeBars(data.charts.record_types)}
        </div>
      </section>
    </details>
  `;
}

function storeSignalsPanel(data: DashboardData, options: { open?: boolean } = {}): string {
  const openAttribute = options.open ? " open" : "";
  return `
    <details${openAttribute} id="store-signals" class="panel store-signals" data-dashboard-detail="store-signals">
      <summary class="dashboard-fold-summary">
        <span>Store Signals</span>
        <small>Operational health signals</small>
      </summary>
      ${syncActionBrief(data)}
      ${syncPositionFocus(data)}
      ${storeTelemetryContext(data)}
    </details>
  `;
}

function recentValuePanel(records: DashboardValueRecord[]): string {
  const recentValueSummary = `${records.length} recent ${records.length === 1 ? "record" : "records"}`;
  return `
    <details class="panel recent-value-panel" data-dashboard-detail="recent-value">
      <summary class="dashboard-fold-summary recent-value-fold">
        <span>Recent Value</span>
        <small>${escapeHtml(recentValueSummary)}</small>
      </summary>
      <div class="recent-value-body">
        ${recentValueCards(records)}
      </div>
    </details>
  `;
}

function debugInspectorPanel(data: DashboardData): string {
  const sync = data.sync;
  return `
    <details class="panel debug-inspector" data-dashboard-detail="debug-inspector">
      <summary class="dashboard-fold-summary">
        <span>Raw Store Inspector</span>
        <small>Optional raw inspection</small>
      </summary>
      <div class="inspector-grid">
        <details data-dashboard-detail="inspector:records">
          <summary>Record Index</summary>
          ${recordsTable(data.recent_records)}
        </details>
        <details data-dashboard-detail="inspector:events">
          <summary>Event Timeline</summary>
          ${eventsTimeline(data.recent_events)}
        </details>
        <details data-dashboard-detail="inspector:sync">
          <summary>Sync Snapshot</summary>
          <dl>
            <div><dt>Remote</dt><dd>${escapeHtml(sync.remote ?? "not configured")}</dd></div>
            <div><dt>Branch</dt><dd>${escapeHtml(sync.branch ?? "unknown")}</dd></div>
            <div><dt>Ahead</dt><dd>${escapeHtml(sync.ahead ?? 0)}</dd></div>
            <div><dt>Behind</dt><dd>${escapeHtml(sync.behind ?? 0)}</dd></div>
            <div><dt>Commit</dt><dd>${escapeHtml(sync.last_commit ?? "none")}</dd></div>
            ${sync.error ? `<div><dt>Error</dt><dd>${escapeHtml(sync.error)}</dd></div>` : ""}
          </dl>
        </details>
      </div>
    </details>
  `;
}

function supportingEvidenceSummary(): string {
  return "Optional trace data";
}

type SupportingEvidenceSummaryRow = {
  id: "audit-evidence" | "store-snapshot" | "raw-store-reference";
  label: string;
  summary: string;
};

function supportingEvidenceSummaryRow(row: SupportingEvidenceSummaryRow): string {
  return `
        <article class="supporting-evidence-summary-row" data-supporting-evidence-summary="${escapeHtml(row.id)}">
          <div>
            <strong>${escapeHtml(row.label)}</strong>
            <span>${escapeHtml(row.summary)}</span>
          </div>
          <small>Reference</small>
        </article>
  `;
}

function supportingEvidenceOperationalGroup(panels: string[]): string {
  if (panels.length === 0) return "";
  return `
    <details class="supporting-evidence-group supporting-evidence-operational" data-dashboard-detail="supporting-operational-evidence">
      <summary class="dashboard-fold-summary supporting-evidence-group-heading">
        <span>Audit Evidence</span>
        <small>Clean audits and store signals</small>
      </summary>
      <div class="supporting-evidence-group-list">
        ${panels.join("")}
      </div>
    </details>
  `;
}

function supportingOperationalSnapshotsGroup(panels: string[]): string {
  if (panels.length === 0) return "";
  return `
    <details class="supporting-evidence-group supporting-evidence-snapshots" data-dashboard-detail="supporting-operational-snapshots">
      <summary class="dashboard-fold-summary supporting-evidence-group-heading">
        <span>Store Snapshot</span>
        <small>Store context</small>
      </summary>
      <div class="supporting-evidence-group-list">
        ${panels.join("")}
      </div>
    </details>
  `;
}

function supportingEvidenceRawGroup(panels: string[]): string {
  if (panels.length === 0) return "";
  return `
    <details class="supporting-evidence-group supporting-evidence-raw" data-dashboard-detail="supporting-raw-inspector">
      <summary class="dashboard-fold-summary supporting-evidence-group-heading">
        <span>Raw Store Reference</span>
        <small>Optional raw records</small>
      </summary>
      <div class="supporting-evidence-group-list">
        ${panels.join("")}
      </div>
    </details>
  `;
}

function supportingEvidencePanel(data: DashboardData, options: { includeStoreSignals?: boolean } = {}): string {
  const includeStoreSignals = options.includeStoreSignals ?? true;
  const reports = auditReports({
    memoryLifecycle: data.memory_lifecycle,
    capturePolicy: data.capture_policy
  });
  const snapshotPanels = [
    includeStoreSignals ? storeSignalsPanel(data) : "",
    recentValuePanel(data.recent_value)
  ].filter((panel) => panel.length > 0);
  const operationalPanels = [
    reports,
    supportingOperationalSnapshotsGroup(snapshotPanels)
  ].filter((panel) => panel.length > 0);
  const rawPanels = [
    debugInspectorPanel(data)
  ].filter((panel) => panel.length > 0);
  const summaryRows: SupportingEvidenceSummaryRow[] = [
    ...(operationalPanels.length > 0 ? [{
      id: "audit-evidence" as const,
      label: "Audit Evidence",
      summary: "Clean audits and store signals"
    }] : []),
    ...(snapshotPanels.length > 0 ? [{
      id: "store-snapshot" as const,
      label: "Store Snapshot",
      summary: "Store context"
    }] : []),
    ...(rawPanels.length > 0 ? [{
      id: "raw-store-reference" as const,
      label: "Raw Store Reference",
      summary: "Optional raw records"
    }] : [])
  ];
  const detailGroups = [
    supportingEvidenceOperationalGroup(operationalPanels),
    supportingEvidenceRawGroup(rawPanels)
  ].filter((panel) => panel.length > 0);
  const reportSummary = operationalPanels.length > 0 && rawPanels.length > 0
    ? "Store signals and raw reference"
    : operationalPanels.length > 0
      ? "Store signals"
      : rawPanels.length > 0
        ? "Raw reference"
        : "No reports";
  return `
    <details class="panel supporting-evidence" data-dashboard-detail="supporting-evidence" aria-label="Supporting Evidence">
      <summary class="dashboard-fold-summary supporting-evidence-fold">
        <span>Audit Trail</span>
        <small>${escapeHtml(supportingEvidenceSummary())}</small>
      </summary>
      <div class="supporting-evidence-list">
        <div class="supporting-evidence-summary-list" aria-label="Audit Trail summary">
          ${summaryRows.map(supportingEvidenceSummaryRow).join("")}
        </div>
        <details class="supporting-evidence-full-details" data-dashboard-detail="supporting-evidence-full-details">
          <summary class="dashboard-fold-summary">
            <span>Audit Reports</span>
            <small>${escapeHtml(reportSummary)}</small>
          </summary>
          <div class="supporting-evidence-full-list">
            ${detailGroups.join("")}
          </div>
        </details>
      </div>
    </details>
  `;
}

function evidenceLibrarySummary(reviewGroupCount: number, backgroundGroupCount: number): string {
  if (reviewGroupCount === 0 && backgroundGroupCount > 0) return "Reference evidence only";
  if (reviewGroupCount > 0) return "Read-only reference material";
  return "No evidence groups";
}

function evidenceLibraryVisibleSummary(reviewGroupCount: number, backgroundGroupCount: number): string {
  if (reviewGroupCount > 0) return "Reference material";
  return evidenceLibrarySummary(reviewGroupCount, backgroundGroupCount);
}

function isRoutineHealthCheck(report: HealthCheckReport): boolean {
  return report.status === "healthy" && report.summary.warning_checks === 0 && report.summary.failing_checks === 0;
}

function isRoutineRecallEval(review: DashboardRecallEval): boolean {
  if (review.errors.length > 0) return false;
  if (!review.available || !review.report) return true;
  return review.report.summary.failed_cases === 0 && review.report.summary.privacy_leaks === 0;
}

function isRoutineContextPackReview(review: DashboardContextPackReview): boolean {
  const gate = review.handoff_pack?.quality_gate;
  if (!review.available || !gate) return true;
  return gate.status === "ready" && gate.failed_check_ids.length === 0 && gate.warnings.length === 0;
}

type RoutineDiagnosticPanel = {
  id: "health-check" | "recall-eval" | "context-pack-review";
  label: string;
  summary: string;
  status: "good" | "info";
  detail: string;
};

function routineDiagnosticRow(panel: RoutineDiagnosticPanel): string {
  return `
        <article class="routine-diagnostic-row ${escapeHtml(panel.status)}" data-routine-diagnostic="${escapeHtml(panel.id)}">
          <div>
            <strong>${escapeHtml(panel.label)}</strong>
            <span>${escapeHtml(panel.summary)}</span>
          </div>
          <small>${escapeHtml(panel.status === "good" ? "Ready" : "Reference")}</small>
        </article>
  `;
}

function routineDiagnosticsPanel(panels: RoutineDiagnosticPanel[]): string {
  if (panels.length === 0) return "";
  const reportSummary = panels
    .map((panel) => panel.id === "health-check" ? "Health" : panel.id === "recall-eval" ? "recall" : "handoff")
    .join(", ");
  return `
    <details class="panel routine-diagnostics" data-dashboard-detail="routine-diagnostics" aria-label="Routine Diagnostics">
      <summary class="dashboard-fold-summary routine-diagnostics-fold" aria-label="Routine Diagnostics: Healthy checks and handoff readiness">
        <span>Routine Diagnostics</span>
        <small>Checks ready</small>
      </summary>
      <div class="routine-diagnostics-list">
        <div class="routine-diagnostics-summary-list" aria-label="Routine diagnostics summary">
          ${panels.map(routineDiagnosticRow).join("")}
        </div>
        <details class="routine-diagnostics-full-panels" data-dashboard-detail="routine-diagnostics-full-panels">
          <summary class="dashboard-fold-summary">
            <span>Diagnostic Reports</span>
            <small>${escapeHtml(reportSummary)}</small>
          </summary>
          <div class="routine-diagnostics-full-list">
            ${panels.map((panel) => panel.detail).join("")}
          </div>
        </details>
      </div>
    </details>
  `;
}

function evidenceLibraryReviewGroup(panels: string[]): string {
  if (panels.length === 0) return "";
  return `
    <details class="evidence-library-group evidence-library-review" data-dashboard-detail="evidence-review-evidence">
      <summary class="dashboard-fold-summary evidence-library-group-heading">
        <span>Review Notes</span>
        <small>Reference notes</small>
      </summary>
      <div class="evidence-library-group-list">
        ${panels.join("")}
      </div>
    </details>
  `;
}

function evidenceLibraryBackgroundGroup(panels: string[]): string {
  if (panels.length === 0) return "";
  return `
    <details class="evidence-library-group evidence-library-background" data-dashboard-detail="evidence-background-evidence">
      <summary class="dashboard-fold-summary evidence-library-group-heading" aria-label="Routine Reference: Routine checks and audit trail">
        <span>Routine Reference</span>
        <small>Checks and audit</small>
      </summary>
      <div class="evidence-library-group-list">
        ${panels.join("")}
      </div>
    </details>
  `;
}

function evidenceLibraryRoute(input: {
  id: "findings" | "diagnostics" | "audit";
  target: string;
  title: string;
  summary: string;
  note: string;
}): string {
  const ariaLabel = `${input.title}: ${input.summary}. ${input.note}`;
  return `
          <button type="button" class="evidence-library-route" data-evidence-library-route="${escapeHtml(input.id)}" role="listitem" data-action-board-target="${escapeHtml(input.target)}" aria-controls="${escapeHtml(input.target)}" aria-label="${escapeHtml(ariaLabel)}">
            <strong>${escapeHtml(input.title)}</strong><span>${escapeHtml(input.summary)}</span>
          </button>
  `;
}

function evidenceLibraryBrief(input: { reviewCount: number; routineCount: number; backgroundCount: number }): string {
  const routes = [
    input.reviewCount > 0 ? evidenceLibraryRoute({
      id: "findings",
      target: "evidence-review-evidence",
      title: "Findings",
      summary: "Reference notes",
      note: "Read-only dogfood, governance, or non-routine checks."
    }) : "",
    input.routineCount > 0 ? evidenceLibraryRoute({
      id: "diagnostics",
      target: "routine-diagnostics",
      title: "Diagnostics",
      summary: "Healthy checks and handoff readiness",
      note: "Routine health, recall, and handoff context checks."
    }) : "",
    input.backgroundCount > 0 ? evidenceLibraryRoute({
      id: "audit",
      target: "supporting-evidence",
      title: "Audit",
      summary: supportingEvidenceSummary(),
      note: "Clean audits, store signals, recent value, and raw store."
    }) : ""
  ].filter((route) => route.length > 0);

  if (routes.length === 0) return "";
  return `
      <div class="evidence-library-brief" data-evidence-library-brief>
        <h3>Evidence index</h3>
        <div class="evidence-library-routebar" role="list" aria-label="Evidence index">
${routes.join("")}
        </div>
      </div>
  `;
}

function evidenceLibrary(
  data: DashboardData,
  options: { includeStoreSignals?: boolean; showEvidenceIndex?: boolean } = {}
): string {
  const includeStoreSignals = options.includeStoreSignals ?? true;
  const showEvidenceIndex = options.showEvidenceIndex ?? true;
  const routinePanels: RoutineDiagnosticPanel[] = [];
  if (isRoutineHealthCheck(data.health_check)) {
    routinePanels.push({
      id: "health-check" as const,
      label: "Health Check",
      summary: healthCheckSummary(data.health_check),
      status: "good" as const,
      detail: healthCheckPanel(data.health_check)
    });
  }
  if (isRoutineRecallEval(data.recall_eval)) {
    routinePanels.push({
      id: "recall-eval" as const,
      label: "Recall Eval",
      summary: recallEvalSummary(data.recall_eval),
      status: data.recall_eval.available ? "good" as const : "info" as const,
      detail: recallEvalPanel(data.recall_eval)
    });
  }
  if (isRoutineContextPackReview(data.context_pack_review)) {
    routinePanels.push({
      id: "context-pack-review" as const,
      label: "Context Pack Review",
      summary: contextPackReviewSummary(data.context_pack_review),
      status: data.context_pack_review.available ? "good" as const : "info" as const,
      detail: contextPackReviewPanel(data.context_pack_review)
    });
  }
  const candidateTriageNeedsDecision = candidateTriageHasPromotionDrafts(data.candidate_triage);
  const candidateTriage = candidateTriagePanel(data.candidate_triage);
  const governanceNeedsDecision = governanceNeedsReview(data.governance);
  const governance = governanceHub(data.governance);
  const dogfood = dogfoodReviewPanel(data.dogfood_report);
  const reviewPanels = [
    isRoutineHealthCheck(data.health_check) ? undefined : healthCheckPanel(data.health_check),
    isRoutineRecallEval(data.recall_eval) ? undefined : recallEvalPanel(data.recall_eval),
    governanceNeedsDecision ? governance : undefined,
    candidateTriageNeedsDecision ? candidateTriage : undefined,
    isRoutineContextPackReview(data.context_pack_review) ? undefined : contextPackReviewPanel(data.context_pack_review)
  ].filter((panel): panel is string => panel !== undefined && panel.length > 0);
  const backgroundPanels = [
    routineDiagnosticsPanel(routinePanels),
    dogfood,
    governanceNeedsDecision ? undefined : governance,
    candidateTriageNeedsDecision ? undefined : candidateTriage,
    supportingEvidencePanel(data, { includeStoreSignals })
  ].filter((panel): panel is string => panel !== undefined && panel.length > 0);
  const showRouteIndex = showEvidenceIndex && reviewPanels.length > 0;
  const evidenceSummary = evidenceLibrarySummary(reviewPanels.length > 0 ? 1 : 0, backgroundPanels.length > 0 ? 1 : 0);
  const visibleEvidenceSummary = evidenceLibraryVisibleSummary(reviewPanels.length > 0 ? 1 : 0, backgroundPanels.length > 0 ? 1 : 0);
  return `
    <details class="panel evidence-library" data-dashboard-detail="evidence-library" aria-label="Reference Library">
      <summary class="dashboard-fold-summary evidence-library-fold" aria-label="${escapeHtml(`Reference Library: ${evidenceSummary}`)}">
        <span>Reference Library</span>
        <small>${escapeHtml(visibleEvidenceSummary)}</small>
      </summary>
      ${showRouteIndex ? evidenceLibraryBrief({ reviewCount: reviewPanels.length, routineCount: routinePanels.length, backgroundCount: backgroundPanels.length }) : ""}
      <div class="evidence-library-list">
        ${evidenceLibraryReviewGroup(reviewPanels)}
        ${evidenceLibraryBackgroundGroup(backgroundPanels)}
      </div>
    </details>
  `;
}

function dashboardStatusSummary(data: DashboardData): string {
  const health = data.health;
  const statusClass = healthClass(health.status);
  if (health.status === "healthy") {
    return `
    <p class="dashboard-status-line ${statusClass}" data-dashboard-status="${escapeHtml(health.status)}"><strong>${escapeHtml(health.label)}</strong><span>${escapeHtml(health.explanation)}</span></p>
  `;
  }
  if (health.status === "sync_pending") return "";
  return `
    <section class="status-strip ${statusClass}" data-dashboard-status="${escapeHtml(health.status)}">
      <strong>Dashboard Status</strong>
      <span>${escapeHtml(health.label)}</span>
      <p>${escapeHtml(health.explanation)}</p>
    </section>
  `;
}

function renderDashboardBody(data: DashboardData): string {
  const hasActionSignals = data.attention_items.some(isReviewAttentionItem);
  const actionSignalsPanel = hasActionSignals ? needsAttentionPanel(data.attention_items) : "";
  const hasPendingDecisions = data.decision_summary.total_decisions > 0;
  const shouldHideQuietInfoPanel = data.health.status === "sync_pending" || data.health.status === "conflict";
  const shouldRenderQuietInfoPanel = !hasActionSignals && !hasPendingDecisions && !shouldHideQuietInfoPanel;
  const quietInfoPanel = shouldRenderQuietInfoPanel ? needsAttentionPanel(data.attention_items) : "";
  const shortcutPanel = hasPendingDecisions ? "" : actionBoard(data.action_board);
  const showBackgroundStatus = !hasPendingDecisions && !shouldHideQuietInfoPanel;
  const shouldPromoteStoreSignals = !hasPendingDecisions && !hasActionSignals && data.health.status === "sync_pending";
  const promotedStoreSignalsPanel = shouldPromoteStoreSignals ? storeSignalsPanel(data, { open: true }) : "";
  return `
    <header>
      <div>
        <h1>Moryn Dashboard</h1>
        <p class="store-path" title="${escapeHtml(data.store.path)}">${escapeHtml(data.store.path)}</p>
        <p>Generated <time title="${escapeHtml(data.generated_at)}">${escapeHtml(data.generated_at)}</time></p>
      </div>
      <span class="health-badge ${healthClass(data.health.status)}">${escapeHtml(data.health.label)}</span>
    </header>

    ${dashboardStatusSummary(data)}

    <section id="last-action-receipt" class="panel last-action-receipt" data-action-receipt-anchor aria-live="polite" hidden></section>

    ${dashboardOverview(data.dashboard_overview, { showBackgroundStatus })}

    ${dashboardWorkLanes(data, { showBackgroundLanes: !hasPendingDecisions && !shouldPromoteStoreSignals })}

    ${promotedStoreSignalsPanel}

    ${decisionSummary(data.decision_summary)}

    ${actionSignalsPanel}

    ${maintenanceReviewQueue(data.maintenance.plans)}

    ${captureInbox(data.capture_inbox)}

    ${quietInfoPanel}

    ${shortcutPanel}

    ${evidenceLibrary(data, { includeStoreSignals: !shouldPromoteStoreSignals, showEvidenceIndex: !hasPendingDecisions })}
  `;
}

function dashboardRefreshScript(refreshIntervalMs: number | undefined): string {
  if (refreshIntervalMs === undefined) return "";
  return `
  <script>
    (() => {
      const main = document.querySelector("main[data-dashboard-refresh]");
      const interval = Number(main?.dataset.dashboardRefresh || 0);
      if (!main || !Number.isFinite(interval) || interval <= 0) return;
      const captureDetailState = () => {
        const state = new Map();
        main.querySelectorAll("details[data-dashboard-detail]").forEach((detail) => {
          state.set(detail.dataset.dashboardDetail, detail.open);
        });
        return state;
      };
      const detailState = captureDetailState();
      main.addEventListener("toggle", (event) => {
        const detail = event.target;
        if (!(detail instanceof HTMLDetailsElement)) return;
        const key = detail.dataset.dashboardDetail;
        if (key) detailState.set(key, detail.open);
      }, true);
      const restoreDetailState = (state) => {
        main.querySelectorAll("details[data-dashboard-detail]").forEach((detail) => {
          const key = detail.dataset.dashboardDetail;
          if (state.has(key)) detail.open = state.get(key);
        });
      };
      const refresh = async () => {
        try {
          const response = await fetch("fragment", { cache: "no-store" });
          if (!response.ok) return;
          main.innerHTML = await response.text();
          restoreDetailState(detailState);
          window.restoreActionReceipt?.();
        } catch {
          // Keep the last successful render visible if a refresh fails.
        }
      };
      window.setInterval(refresh, interval);
    })();
  </script>`;
}

function dashboardActionBoardScript(): string {
  return `
  <script>
    (() => {
      const main = document.querySelector("main");
      if (!main) return;
      const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(value) : value.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\"');
      const findDashboardTarget = (targetId) => {
        const byId = document.getElementById(targetId);
        if (byId instanceof HTMLElement) return byId;
        const byDetail = document.querySelector(\`[data-dashboard-detail="\${cssEscape(targetId)}"]\`);
        return byDetail instanceof HTMLElement ? byDetail : null;
      };
      main.addEventListener("click", (event) => {
        const clicked = event.target;
        if (!(clicked instanceof HTMLElement)) return;
        const trigger = clicked.closest("[data-action-board-target]");
        if (!(trigger instanceof HTMLElement)) return;
        const targetId = trigger.dataset.actionBoardTarget;
        if (!targetId) return;
        const target = findDashboardTarget(targetId);
        if (!(target instanceof HTMLElement)) return;
        if (target instanceof HTMLDetailsElement) {
          target.open = true;
        }
        let parent = target.closest("details");
        while (parent instanceof HTMLDetailsElement) {
          parent.open = true;
          parent = parent.parentElement?.closest("details") ?? null;
        }
        target.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    })();
  </script>`;
}

function dashboardActionReceiptScript(): string {
  return `
  <script>
    (() => {
      const receiptKey = "moryn.dashboard.lastActionReceipt";
      const htmlEscape = (value) => String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
      const pluralize = (count, singular, plural = singular + "s") => count + " " + (count === 1 ? singular : plural);
      const titleCase = (value) => String(value || "applied")
        .replaceAll("_", " ")
        .replace(/\\b\\w/g, (match) => match.toUpperCase());
      const receiptTarget = () => document.getElementById("last-action-receipt");
      const decisionLabel = (result) => {
        const status = String(result.status || "");
        if (result.plan_id) return "User approved Review Queue plan.";
        if (result.surface === "candidate_triage" && status === "approved") return "User approved Candidate Triage promotion draft.";
        if (result.group_id) {
          if (status === "rejected") return "User rejected Capture Inbox group.";
          if (status === "approved") return "User approved Capture Inbox group.";
          return "User reviewed Capture Inbox group.";
        }
        if (status === "rejected") return "User rejected Capture Inbox candidate.";
        if (status === "approved") return "User approved Capture Inbox candidate.";
        return "User confirmed dashboard action.";
      };
      const receiptFromResult = (result) => {
        const recordIds = Array.isArray(result.record_ids) ? result.record_ids : result.record_id ? [result.record_id] : [];
        const eventIds = Array.isArray(result.event_ids) ? result.event_ids : result.event_id ? [result.event_id] : [];
        const timelineCommands = eventIds.length > 0
          ? eventIds.map((eventId) => "moryn timeline --event-id " + eventId)
          : recordIds.map((recordId) => "moryn timeline --record-id " + recordId);
        const recallCommands = recordIds.map((recordId) => "moryn recall --record-id " + recordId);
        const changedCount = Number(result.records_changed || result.migrated_records || recordIds.length || eventIds.length || 1);
        return {
          status: titleCase(result.status),
          decision: decisionLabel(result),
          write_boundary: "Append-only events",
          changed: pluralize(changedCount, "write target"),
          audit_status: eventIds.length > 0 ? "Traceable by timeline" : "No event id returned",
          context: [result.plan_id, result.group_id].filter(Boolean),
          record_ids: recordIds,
          event_ids: eventIds,
          commands: [...timelineCommands, ...recallCommands],
          saved_at: new Date().toISOString()
        };
      };
      const receiptHtml = (receipt) => \`
        <div class="action-receipt-layout">
          <div class="action-receipt-head">
            <span class="action-receipt-title">Action receipt</span>
            <strong>\${htmlEscape(receipt.status)}</strong>
          </div>
          <dl class="action-receipt-grid">
            <div><dt>Outcome</dt><dd>\${htmlEscape(receipt.status)}</dd></div>
            <div><dt>Decision</dt><dd>\${htmlEscape(receipt.decision)}</dd></div>
            <div><dt>Write boundary</dt><dd>\${htmlEscape(receipt.write_boundary)}</dd></div>
            <div><dt>Write targets</dt><dd>\${htmlEscape(receipt.changed)}</dd></div>
            \${receipt.context.length > 0 ? \`<div><dt>Decision context</dt><dd>\${receipt.context.map((value) => \`<code>\${htmlEscape(value)}</code>\`).join(" ")}</dd></div>\` : ""}
            \${receipt.record_ids.length > 0 ? \`<div><dt>Records</dt><dd>\${receipt.record_ids.map((recordId) => \`<code>\${htmlEscape(recordId)}</code>\`).join(" ")}</dd></div>\` : ""}
            \${receipt.event_ids.length > 0 ? \`<div><dt>Events</dt><dd>\${receipt.event_ids.map((eventId) => \`<code>\${htmlEscape(eventId)}</code>\`).join(" ")}</dd></div>\` : ""}
            <div><dt>Audit status</dt><dd>\${htmlEscape(receipt.audit_status)}</dd></div>
            <div class="action-receipt-commands"><dt>Audit next</dt><dd>\${receipt.commands.length > 0 ? receipt.commands.map((command) => \`<code>\${htmlEscape(command)}</code>\`).join("") : "No read-only trace command returned."}</dd></div>
          </dl>
        </div>
      \`;
      const renderReceiptInto = (target, receipt) => {
        if (!(target instanceof HTMLElement)) return;
        target.hidden = false;
        target.classList.add("action-receipt");
        target.innerHTML = receiptHtml(receipt);
      };
      window.restoreActionReceipt = () => {
        try {
          const stored = sessionStorage.getItem(receiptKey);
          if (!stored) return;
          renderReceiptInto(receiptTarget(), JSON.parse(stored));
        } catch {
          sessionStorage.removeItem(receiptKey);
        }
      };
      window.renderActionReceipt = (status, result) => {
        if (!result || typeof result !== "object") return;
        const receipt = receiptFromResult(result);
        sessionStorage.setItem(receiptKey, JSON.stringify(receipt));
        renderReceiptInto(status, receipt);
        renderReceiptInto(receiptTarget(), receipt);
      };
      window.restoreActionReceipt();
    })();
  </script>`;
}

function dashboardMaintenanceScript(): string {
  return `
  <script>
    (() => {
      const main = document.querySelector("main");
      if (!main) return;
      const hiddenKey = "moryn.dashboard.hiddenMaintenancePlans";
      const hidden = new Set(JSON.parse(sessionStorage.getItem(hiddenKey) || "[]"));
      const persistHidden = () => sessionStorage.setItem(hiddenKey, JSON.stringify([...hidden]));
      const hideRejectedPlans = () => {
        main.querySelectorAll("[data-maintenance-plan]").forEach((plan) => {
          if (hidden.has(plan.dataset.maintenancePlan)) plan.hidden = true;
        });
      };
      const refreshFragment = async () => {
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        hideRejectedPlans();
        window.restoreActionReceipt?.();
      };
      const responseJson = async (response) => {
        const text = await response.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          return { ok: false, message: text };
        }
      };
      hideRejectedPlans();
      main.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const plan = target.closest("[data-maintenance-plan]");
        if (!(plan instanceof HTMLElement)) return;
        const status = plan.querySelector("[data-maintenance-status]");
        if (target.closest("[data-maintenance-reject]")) {
          hidden.add(plan.dataset.maintenancePlan || "");
          persistHidden();
          plan.hidden = true;
          return;
        }
        const copy = target.closest("[data-maintenance-copy]");
        if (copy instanceof HTMLElement) {
          await navigator.clipboard?.writeText(copy.dataset.command || "");
          if (status) status.textContent = "Command copied.";
          return;
        }
        const approve = target.closest("[data-maintenance-approve]");
        if (!(approve instanceof HTMLButtonElement)) return;
        approve.disabled = true;
        if (status) status.textContent = approve.dataset.loadingLabel || "Applying...";
        try {
          const response = await fetch(approve.dataset.endpoint || "", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plan_hash: approve.dataset.planHash })
          });
          const result = await responseJson(response);
          if (!response.ok || result.ok === false) {
            if (status) status.textContent = result.message || "Approval failed.";
            approve.disabled = false;
            return;
          }
          if (status) {
            status.textContent = "Applied. Receipt rendered below; refreshing dashboard...";
            window.renderActionReceipt?.(status, result);
          }
          await refreshFragment();
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : "Approval failed.";
          approve.disabled = false;
        }
      });
    })();
  </script>`;
}

function dashboardCaptureInboxScript(): string {
  return `
  <script>
    (() => {
      const main = document.querySelector("main");
      if (!main) return;
      const refreshFragment = async () => {
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        window.restoreActionReceipt?.();
      };
      const responseJson = async (response) => {
        const text = await response.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          return { ok: false, message: text };
        }
      };
      main.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const approve = target.closest("[data-capture-inbox-approve]");
        const reject = target.closest("[data-capture-inbox-reject]");
        const groupApprove = target.closest("[data-capture-inbox-group-approve]");
        const groupReject = target.closest("[data-capture-inbox-group-reject]");
        const button = approve || reject || groupApprove || groupReject;
        if (!(button instanceof HTMLButtonElement)) return;
        const item = button.closest("[data-capture-inbox-record], [data-capture-inbox-group]");
        if (!(item instanceof HTMLElement)) return;
        const status = item.querySelector("[data-capture-inbox-status]");
        const isReject = Boolean(reject || groupReject);
        const isGroup = Boolean(groupApprove || groupReject);
        const recordIds = (button.dataset.recordIds || "").split(",").filter(Boolean);
        button.disabled = true;
        if (status) status.textContent = isReject ? "Rejecting candidate..." : "Approving memory...";
        try {
          const response = await fetch(button.dataset.endpoint || "", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(isGroup ? { record_ids: recordIds } : {}),
              ...(isReject ? { reason: isGroup ? "User rejected Capture Inbox group." : "User rejected Capture Inbox candidate." } : {})
            })
          });
          const result = await responseJson(response);
          if (!response.ok || result.ok === false) {
            if (status) status.textContent = result.message || "Capture Inbox action failed.";
            button.disabled = false;
            return;
          }
          if (status) {
            status.textContent = isReject ? "Rejected. Receipt rendered below; refreshing dashboard..." : "Approved. Receipt rendered below; refreshing dashboard...";
            window.renderActionReceipt?.(status, result);
          }
          await refreshFragment();
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : "Capture Inbox action failed.";
          button.disabled = false;
        }
      });
    })();
  </script>`;
}

function dashboardCandidateTriageScript(): string {
  return `
  <script>
    (() => {
      const main = document.querySelector("main");
      if (!main) return;
      const refreshFragment = async () => {
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        window.restoreActionReceipt?.();
      };
      const responseJson = async (response) => {
        const text = await response.text();
        if (!text) return {};
        try {
          return JSON.parse(text);
        } catch {
          return { ok: false, message: text };
        }
      };
      main.addEventListener("click", async (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const button = target.closest("[data-candidate-triage-promotion-approve]");
        if (!(button instanceof HTMLButtonElement)) return;
        const draft = button.closest("[data-candidate-triage-promotion-draft]");
        if (!(draft instanceof HTMLElement)) return;
        const status = draft.querySelector("[data-candidate-triage-promotion-status]");
        button.disabled = true;
        if (status) status.textContent = "Approving memory...";
        try {
          const response = await fetch(button.dataset.endpoint || "", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({})
          });
          const result = await responseJson(response);
          if (!response.ok || result.ok === false) {
            if (status) status.textContent = result.message || "Candidate Triage approval failed.";
            button.disabled = false;
            return;
          }
          if (status) {
            status.textContent = "Approved. Receipt rendered below; refreshing dashboard...";
            window.renderActionReceipt?.(status, result);
          }
          await refreshFragment();
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : "Candidate Triage approval failed.";
          button.disabled = false;
        }
      });
    })();
  </script>`;
}

function renderDashboardShell(data: DashboardData, options: { refreshIntervalMs?: number } = {}): string {
  const refreshAttributes = options.refreshIntervalMs === undefined
    ? ""
    : ` data-dashboard-refresh="${escapeHtml(options.refreshIntervalMs)}"`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moryn Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --canvas: #f6f7f8;
      --surface: #ffffff;
      --surface-2: #fafbfc;
      --surface-3: #f1f3f5;
      --ink: #15191e;
      --ink-2: #2a323a;
      --muted: #66717d;
      --subtle: #8b949e;
      --border: #d9dee3;
      --hairline: #e8ebef;
      --signal-blue: #315f9f;
      --signal-blue-soft: #eaf0f8;
      --signal-green: #21715e;
      --signal-green-soft: #e8f3ef;
      --signal-amber: #9b6a20;
      --signal-amber-soft: #f4eee3;
      --signal-red: #b0453c;
      --signal-red-soft: #f5e8e6;
      --signal-violet: #65579d;
      --signal-slate: #53606d;
      --text: var(--ink);
      --main: var(--surface);
      --accent: var(--signal-green);
      --accent-2: var(--signal-blue);
      --warning: var(--signal-amber);
      --critical: var(--signal-red);
      --good: var(--signal-green);
      --info: var(--signal-blue);
      --code: #eef1f4;
    }
    * { box-sizing: border-box; }
    html, body { max-width: 100%; overflow-x: hidden; }
    body {
      margin: 0;
      background:
        linear-gradient(180deg, #fbfcfd 0, var(--canvas) 250px),
        var(--canvas);
      color: var(--text);
      font: 14px/1.55 Inter, "Aptos", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
      font-feature-settings: "tnum" 1, "cv11" 1;
      font-variant-numeric: tabular-nums;
    }
    main { max-width: 1260px; margin: 0 auto; padding: 30px 18px 48px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      margin-bottom: 20px;
    }
    h1 { margin: 0; font-size: 28px; line-height: 1.12; font-weight: 790; letter-spacing: 0; color: var(--ink); }
    h2 { margin: 0 0 12px; font-size: 15px; line-height: 1.2; font-weight: 760; letter-spacing: 0; color: var(--ink); }
    h3 { margin: 0; font-size: 13px; line-height: 1.2; font-weight: 720; letter-spacing: 0; color: var(--ink); }
    p { margin: 5px 0 0; color: var(--muted); }
    code {
      display: inline-block;
      max-width: 100%;
      background: var(--code);
      border-radius: 5px;
      padding: 2px 5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    time { color: var(--muted); font-size: 12px; }
    small { display: block; color: var(--muted); overflow-wrap: anywhere; }
    dl { margin: 8px 0 0; display: grid; gap: 6px; }
    dl div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 8px; }
    dt { color: var(--muted); font-weight: 650; }
    dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
    .store-path { max-width: 760px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .health-badge, .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      max-width: 100%;
      border-radius: 6px;
      padding: 2px 9px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--muted);
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .health-badge { min-height: 32px; padding: 5px 13px; box-shadow: 0 8px 18px rgba(21, 25, 30, 0.06); }
    .good, .state-canonical { color: var(--signal-green); border-color: #bfd8d0; background: var(--signal-green-soft); }
    .warning, .state-raw { color: var(--signal-amber); border-color: #dfcfb2; background: var(--signal-amber-soft); }
    .critical, .state-quarantined { color: var(--signal-red); border-color: #e0c4c0; background: var(--signal-red-soft); }
    .info, .state-candidate { color: var(--signal-blue); border-color: #c9d5e6; background: var(--signal-blue-soft); }
    .state-archived { color: var(--signal-slate); border-color: #ccd2d8; background: var(--surface-3); }
    .muted { color: var(--muted); }
    .panel, .action-board {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 12px 30px rgba(21, 25, 30, 0.055);
    }
    .panel { padding: 16px; margin-bottom: 14px; background: var(--surface); }
    .status-strip {
      display: grid;
      grid-template-columns: auto auto minmax(0, 1fr);
      gap: 8px 10px;
      align-items: center;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 12px;
      background: var(--surface);
      box-shadow: 0 8px 18px rgba(21, 25, 30, 0.04);
    }
    .status-strip strong { color: var(--ink); font-weight: 780; }
    .status-strip span { font-weight: 760; }
    .status-strip p { margin: 0; color: var(--muted); min-width: 0; overflow-wrap: anywhere; }
    .dashboard-status-line {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 9px;
      align-items: center;
      margin: -6px 0 8px;
      color: var(--muted);
      font-size: 12.5px;
      background: transparent;
    }
    .dashboard-status-line strong {
      color: var(--signal-green);
      font-weight: 780;
    }
    .dashboard-status-line.info strong { color: var(--signal-blue); }
    .dashboard-status-line.warning strong { color: var(--signal-amber); }
    .dashboard-status-line.critical strong { color: var(--signal-red); }
    .dashboard-status-line span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .dashboard-overview {
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      background: var(--surface);
      box-shadow: 0 8px 18px rgba(21, 25, 30, 0.04);
    }
    .dashboard-overview.good { border-left-color: var(--good); }
    .dashboard-overview.info { border-left-color: var(--info); }
    .dashboard-overview.warning { border-left-color: var(--warning); }
    .dashboard-overview.critical { border-left-color: var(--critical); }
    .dashboard-overview-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }
    .dashboard-overview h2 {
      margin-bottom: 3px;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 780;
    }
    .dashboard-overview strong {
      display: block;
      color: var(--ink);
      font-size: 18px;
      line-height: 1.2;
      font-weight: 820;
      overflow-wrap: anywhere;
    }
    .dashboard-overview p { margin-top: 4px; color: var(--muted); }
    .dashboard-overview-action {
      appearance: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 10px;
      background: var(--ink);
      color: #fff;
      font: inherit;
      font-size: 12px;
      font-weight: 780;
      cursor: pointer;
      white-space: nowrap;
    }
    .dashboard-overview-action:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .dashboard-overview-quiet {
      margin-top: 9px;
      border-top: 1px solid var(--hairline);
      padding-top: 9px;
    }
    .dashboard-overview-quiet[open] > summary { margin-bottom: 8px; }
    .dashboard-overview-quiet-list {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .dashboard-overview-card {
      appearance: none;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 6px;
      padding: 8px 9px;
      background: var(--surface-2);
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-width: 0;
      text-align: left;
      transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    .dashboard-overview-card:hover { border-color: #b8c0c8; box-shadow: 0 8px 18px rgba(21, 25, 30, 0.045); transform: translateY(-1px); }
    .dashboard-overview-card:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .dashboard-overview-card.good { border-left-color: var(--good); }
    .dashboard-overview-card.info { border-left-color: var(--info); }
    .dashboard-overview-card.warning { border-left-color: var(--warning); }
    .dashboard-overview-card.critical { border-left-color: var(--critical); }
    .dashboard-overview-card span {
      display: block;
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .dashboard-overview-card strong { margin-top: 4px; font-size: 16px; }
    .dashboard-overview-card p { margin: 5px 0 0; color: var(--ink-2); font-size: 12.5px; }
    .dashboard-overview-card small { margin-top: 4px; color: var(--muted); }
    .dashboard-overview-quiet-list .dashboard-overview-card {
      border-left-width: 1px;
      padding: 8px;
      background: var(--surface);
      box-shadow: none;
    }
    .dashboard-overview-quiet-list .dashboard-overview-card strong {
      font-size: 14px;
      color: var(--muted);
    }
    .dashboard-overview-quiet-list .dashboard-overview-card p {
      color: var(--muted);
    }
    .dashboard-overview-safety {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 9px;
    }
    .dashboard-overview-safety span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .dashboard-work-lanes {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin: 0 0 12px;
    }
    .dashboard-work-lanes-quiet {
      grid-column: 1 / -1;
      border-top: 1px solid var(--hairline);
      padding-top: 8px;
    }
    .dashboard-work-lanes-quiet[open] > summary { margin-bottom: 8px; }
    .dashboard-work-lanes-quiet-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .dashboard-work-lane {
      appearance: none;
      display: grid;
      gap: 4px;
      min-width: 0;
      min-height: 86px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 10px;
      background: var(--surface);
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      box-shadow: 0 8px 18px rgba(21, 25, 30, 0.04);
      transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    .dashboard-work-lane:hover { border-color: #b8c0c8; box-shadow: 0 10px 20px rgba(21, 25, 30, 0.055); transform: translateY(-1px); }
    .dashboard-work-lane:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .dashboard-work-lane.good { border-left-color: var(--good); }
    .dashboard-work-lane.info { border-left-color: var(--info); }
    .dashboard-work-lane.warning { border-left-color: var(--warning); }
    .dashboard-work-lane.critical { border-left-color: var(--critical); }
    .dashboard-work-lane span {
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 780;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .dashboard-work-lane strong {
      color: var(--ink);
      font-size: 15px;
      line-height: 1.2;
      font-weight: 820;
      overflow-wrap: anywhere;
    }
    .dashboard-work-lane em {
      align-self: end;
      color: var(--muted);
      font-size: 12px;
      font-style: normal;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .dashboard-work-lanes-quiet-list .dashboard-work-lane {
      min-height: 68px;
      border-left-width: 1px;
      padding: 8px;
      background: var(--surface-2);
      box-shadow: none;
    }
    .dashboard-work-lanes-quiet-list .dashboard-work-lane strong {
      color: var(--ink-2);
      font-size: 13px;
      font-weight: 760;
    }
    .dashboard-work-lanes-quiet-list .dashboard-work-lane em {
      font-size: 11.5px;
    }
    .health-check-panel {
      border-left: 4px solid var(--signal-blue);
      padding: 13px 14px;
    }
    .health-check-panel[open] > summary { margin-bottom: 10px; }
    .health-check-body { display: grid; gap: 10px; }
    .health-check-brief {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
    }
    .health-check-brief strong { color: var(--ink); font-size: 14px; }
    .health-check-brief strong.good { color: var(--good); }
    .health-check-brief strong.warning { color: var(--warning); }
    .health-check-brief strong.critical { color: var(--critical); }
    .health-check-brief span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      font-weight: 730;
    }
    .health-check-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 9px;
      margin: 0;
    }
    .health-check-stats div {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px;
      background: var(--surface-2);
    }
    .health-check-stats dt { color: var(--muted); font-size: 11.5px; font-weight: 720; }
    .health-check-stats dd { margin: 3px 0 0; color: var(--ink); font-size: 17px; font-weight: 800; }
    .health-check-install-trust {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 12px;
      align-items: center;
      border: 1px solid var(--border);
      border-left: 4px solid var(--good);
      border-radius: 8px;
      padding: 10px 11px;
      background: var(--surface-2);
    }
    .health-check-install-trust h4 {
      margin: 0;
      color: var(--ink);
      font-size: 13px;
      font-weight: 780;
    }
    .health-check-install-trust p {
      margin-top: 2px;
      color: var(--muted);
      font-size: 12.5px;
    }
    .health-check-install-trust strong {
      justify-self: end;
      font-size: 13px;
      font-weight: 800;
      white-space: nowrap;
    }
    .health-check-install-trust-chips {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .health-check-install-trust-chips span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .health-check-readiness-actions,
    .health-check-details {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .health-check-readiness-actions[open] > summary,
    .health-check-details[open] > summary { margin-bottom: 9px; }
    .health-check-action-groups {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .health-check-action-group {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .health-check-action-group h4 {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 780;
      text-transform: uppercase;
    }
    .health-check-action-list {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .health-check-action {
      display: grid;
      gap: 6px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .health-check-action.safe { border-left-color: var(--good); }
    .health-check-action.input { border-left-color: var(--warning); }
    .health-check-action div {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }
    .health-check-action strong { color: var(--ink); font-weight: 760; overflow-wrap: anywhere; }
    .health-check-action code,
    .health-check-action small {
      overflow-wrap: anywhere;
    }
    .health-check-action small { color: var(--muted); }
    .health-check-action-command {
      border-top: 1px solid var(--hairline);
      padding-top: 6px;
    }
    .health-check-action-command[open] > summary { margin-bottom: 6px; }
    .health-check-action-command code {
      display: block;
      width: 100%;
      padding: 6px 0 0;
    }
    .health-check-list { display: grid; gap: 8px; }
    .health-check-item {
      display: grid;
      grid-template-columns: minmax(70px, auto) minmax(0, 1fr);
      gap: 4px 9px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .health-check-item.pass { border-left-color: var(--good); }
    .health-check-item.info { border-left-color: var(--info); }
    .health-check-item.warning { border-left-color: var(--warning); }
    .health-check-item.fail { border-left-color: var(--critical); }
    .health-check-item span { color: var(--muted); font-size: 11.5px; font-weight: 760; text-transform: uppercase; }
    .health-check-item strong { color: var(--ink); font-weight: 760; overflow-wrap: anywhere; }
    .health-check-item p,
    .health-check-item small { grid-column: 1 / -1; margin: 0; overflow-wrap: anywhere; }
    .health-check-item p { color: var(--ink-2); }
    .health-check-item small { color: var(--muted); }
    .recall-eval-panel {
      border-left: 4px solid var(--signal-blue);
      padding: 13px 14px;
    }
    .recall-eval-panel[open] > summary { margin-bottom: 10px; }
    .recall-eval-body { display: grid; gap: 10px; }
    .recall-eval-sources {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .recall-eval-sources[open] > summary { margin-bottom: 8px; }
    .recall-eval-sources dl {
      display: grid;
      gap: 7px;
      margin: 0;
    }
    .recall-eval-sources dl div {
      display: grid;
      grid-template-columns: minmax(140px, auto) minmax(0, 1fr);
      gap: 8px;
      min-width: 0;
    }
    .recall-eval-sources dd { margin: 0; color: var(--muted); overflow-wrap: anywhere; }
    .dogfood-review {
      border-left: 4px solid var(--signal-amber);
      padding: 13px 14px;
    }
    .dogfood-review[open] > summary { margin-bottom: 10px; }
    .dogfood-review-body { display: grid; gap: 10px; }
    .dogfood-review-list { display: grid; gap: 9px; }
    .dogfood-review-item {
      display: grid;
      gap: 8px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 9px;
      background: var(--surface);
    }
    .dogfood-review-item.info { border-left-color: var(--info); }
    .dogfood-review-item.warning { border-left-color: var(--warning); }
    .dogfood-review-heading {
      display: grid;
      gap: 3px;
    }
    .dogfood-review-heading span {
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .dogfood-review-heading strong {
      color: var(--ink);
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .dogfood-review-heading small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .dogfood-note-details {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .dogfood-note-details[open] > summary { margin-bottom: 8px; }
    .dogfood-note-details .dogfood-brief {
      border: 0;
      border-radius: 0;
      padding: 0;
      background: transparent;
    }
    .dogfood-brief {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .dogfood-brief h4 {
      margin: 0 0 7px;
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 780;
    }
    .dogfood-brief dl { margin: 0; }
    .dogfood-brief dl div {
      grid-template-columns: 130px minmax(0, 1fr);
    }
    .visual-grid { display: grid; gap: 11px; }
    .visual-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .action-board {
      padding: 14px;
      margin-bottom: 14px;
    }
    .action-board-secondary {
      background: var(--surface-2);
      border-color: var(--hairline);
      box-shadow: none;
      padding: 10px 12px;
      margin: 0 0 14px;
    }
    .action-board-secondary[open] { padding-bottom: 12px; }
    .action-board[open] > summary { margin-bottom: 10px; }
    .action-board-secondary[open] > summary { margin-bottom: 9px; }
    .action-board-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .action-board-quiet {
      margin-top: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .action-board-quiet[open] > summary { margin-bottom: 8px; }
    .action-board-quiet-list {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .action-board-item {
      appearance: none;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 10px;
      background: var(--surface-2);
      color: inherit;
      cursor: pointer;
      font: inherit;
      min-width: 0;
      text-align: left;
      transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    .action-board-item:hover { border-color: #b8c0c8; box-shadow: 0 10px 20px rgba(21, 25, 30, 0.055); transform: translateY(-1px); }
    .action-board-item:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .action-board-item.good { border-left-color: var(--good); }
    .action-board-item.info { border-left-color: var(--info); }
    .action-board-item.warning { border-left-color: var(--warning); }
    .action-board-item.critical { border-left-color: var(--critical); }
    .action-board-item span {
      display: block;
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .action-board-item strong {
      display: block;
      margin-top: 4px;
      color: var(--ink);
      font-size: 24px;
      font-weight: 820;
      line-height: 1;
      overflow-wrap: anywhere;
    }
    .action-board-item p {
      margin: 6px 0 0;
      color: var(--ink-2);
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .action-board-item small { margin-top: 3px; }
    .action-board-quiet-list .action-board-item {
      border-left-width: 1px;
      padding: 8px;
      background: var(--surface);
      box-shadow: none;
    }
    .action-board-quiet-list .action-board-item strong {
      font-size: 16px;
      color: var(--muted);
    }
    .action-board-quiet-list .action-board-item p {
      font-weight: 650;
      color: var(--muted);
    }
    .action-board-next {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--ink-2);
      font-size: 12px;
      font-style: normal;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .decision-summary {
      border-left: 4px solid var(--signal-green);
      padding: 13px 14px;
    }
    .decision-summary-heading {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: flex-start;
      min-width: 0;
      margin-bottom: 10px;
    }
    .decision-summary-heading h2 { margin-bottom: 2px; }
    .decision-summary-heading p {
      margin: 0;
      color: var(--muted);
      font-size: 12.5px;
    }
    .decision-summary-counts {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }
    .decision-summary-counts span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--signal-green-soft);
      color: var(--signal-green);
      font-size: 12px;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .decision-summary-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .decision-summary-item {
      display: grid;
      gap: 7px;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
      min-width: 0;
    }
    .decision-summary-item-main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .decision-summary-item strong {
      display: block;
      color: var(--ink);
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .decision-summary-item p {
      margin-top: 4px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .decision-summary-route {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .decision-summary-route span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .decision-summary-link {
      justify-self: start;
      background: var(--ink);
      border-color: var(--ink);
      color: #fff;
    }
    .needs-attention-quiet-line {
      margin: -2px 0 12px;
      color: var(--muted);
      font-size: 12.5px;
    }
    .needs-attention-quiet-line .attention-info-group { margin: 0; }
    .attention-list { display: grid; gap: 9px; }
    .attention-focus {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
    }
    .action-signals {
      border-left: 4px solid var(--warning);
    }
    .action-signals-heading {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      align-items: baseline;
      margin-bottom: 10px;
    }
    .action-signals-heading h2 { margin: 0; }
    .action-signals-heading small {
      color: var(--muted);
      font-weight: 650;
    }
    .attention-focus strong { color: var(--ink); font-size: 15px; }
    .attention-focus-count {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      font-weight: 730;
    }
    .attention-focus-count.critical { color: var(--critical); }
    .attention-focus-count.warning { color: var(--warning); }
    .attention-focus-count.info { color: var(--info); }
    .attention-next-action {
      margin-left: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--ink-2);
      font-weight: 740;
      overflow-wrap: anywhere;
    }
    .attention-info-group {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 11px;
      background: var(--surface-2);
    }
    .attention-info-group[open] > summary { margin-bottom: 8px; }
    .attention-info-details {
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .attention-info-details[open] > summary { margin-bottom: 8px; }
    .attention-info-list { display: grid; gap: 8px; }
    .attention {
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 9px 11px;
      background: var(--surface);
    }
    .attention[open] > summary { margin-bottom: 8px; }
    .attention-summary { display: flex; justify-content: space-between; gap: 10px; align-items: center; min-width: 0; }
    .attention strong { color: var(--ink); font-weight: 760; }
    .attention span { color: var(--subtle); font-weight: 680; }
    .attention-body { border-top: 1px solid var(--hairline); padding-top: 8px; }
    .attention-body p { margin-top: 0; color: var(--muted); overflow-wrap: anywhere; }
    .attention.info { border-left-color: var(--info); }
    .attention.warning { border-left-color: var(--warning); }
    .attention.critical { border-left-color: var(--critical); }
    .empty-state { border: 1px dashed var(--border); border-radius: 7px; padding: 14px; color: var(--muted); background: var(--surface-2); }
    .maintenance-review { border-left: 4px solid var(--signal-green); }
    .maintenance-review-summary[open] > summary { margin-bottom: 10px; }
    .maintenance-review-body {
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .context-pack-review { border-left: 4px solid var(--signal-blue); }
    .context-pack-review[open] > summary { margin-bottom: 10px; }
    .context-pack-review-body {
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .governance-hub { border-left: 4px solid var(--signal-green); }
    .governance-hub[open] > summary { margin-bottom: 10px; }
    .governance-hub-body {
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    section.governance-hub .governance-hub-body {
      border-top: 0;
      padding-top: 0;
    }
    .candidate-triage { border-left: 4px solid var(--signal-green); }
    .candidate-triage[open] > summary { margin-bottom: 10px; }
    .candidate-triage-body {
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .memory-lifecycle { border-left: 4px solid var(--signal-violet); }
    .clean-audit-reports { border-left: 4px solid var(--signal-violet); }
    .clean-audit-reports[open] > summary { margin-bottom: 10px; }
    .clean-audit-list {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .clean-audit-report {
      border: 1px solid var(--border);
      border-left-width: 3px;
      border-radius: 8px;
      padding: 10px;
      background: var(--surface-2);
    }
    .clean-audit-report[open] > summary { margin-bottom: 8px; }
    .store-signals { border-left: 4px solid var(--signal-slate); }
    .capture-inbox { border-left: 4px solid var(--signal-blue); }
    .evidence-library {
      border-left: 4px solid var(--signal-slate);
    }
    .evidence-library[open] > summary { margin-bottom: 10px; }
    .evidence-library-brief {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
      margin-bottom: 10px;
    }
    .evidence-library-brief h3 {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 780;
      text-transform: uppercase;
    }
    .evidence-library-routebar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .evidence-library-route {
      appearance: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 210px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--surface);
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
    }
    .evidence-library-route:hover { border-color: #b8c0c8; box-shadow: 0 6px 14px rgba(21, 25, 30, 0.04); transform: translateY(-1px); }
    .evidence-library-route:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .evidence-library-route strong,
    .evidence-library-route span {
      overflow-wrap: anywhere;
    }
    .evidence-library-route strong {
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 780;
      white-space: nowrap;
    }
    .evidence-library-route span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .evidence-library-list {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .evidence-library-group {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .evidence-library-review[open] > summary { margin-bottom: 8px; }
    .evidence-library-background {
      border-top: 1px solid var(--hairline);
      padding-top: 9px;
    }
    .evidence-library-background[open] > summary { margin-bottom: 8px; }
    .evidence-library-group-heading {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .evidence-library-group-heading span {
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .evidence-library-group-heading small {
      display: inline;
      text-align: right;
    }
    .evidence-library-group-list {
      display: grid;
      gap: 10px;
    }
    .evidence-library-list > .panel,
    .evidence-library-list > section.panel,
    .evidence-library-list > details.panel,
    .evidence-library-group-list > .panel,
    .evidence-library-group-list > section.panel,
    .evidence-library-group-list > details.panel {
      margin-bottom: 0;
      box-shadow: none;
      background: var(--surface);
    }
    .routine-diagnostics { border-left: 4px solid var(--signal-slate); }
    .routine-diagnostics[open] > summary { margin-bottom: 10px; }
    .routine-diagnostics-list {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .routine-diagnostics-summary-list {
      display: grid;
      gap: 8px;
    }
    .routine-diagnostic-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .routine-diagnostic-row.good { border-left-color: var(--good); }
    .routine-diagnostic-row.info { border-left-color: var(--info); }
    .routine-diagnostic-row div {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .routine-diagnostic-row strong,
    .routine-diagnostic-row span,
    .routine-diagnostic-row small {
      overflow-wrap: anywhere;
    }
    .routine-diagnostic-row strong {
      color: var(--ink);
      font-weight: 760;
    }
    .routine-diagnostic-row span,
    .routine-diagnostic-row small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .routine-diagnostics-full-panels {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .routine-diagnostics-full-panels[open] > summary { margin-bottom: 9px; }
    .routine-diagnostics-full-list {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .routine-diagnostics-full-list > .panel,
    .routine-diagnostics-full-list > section.panel,
    .routine-diagnostics-full-list > details.panel {
      margin-bottom: 0;
      box-shadow: none;
      background: var(--surface);
    }
    .routine-diagnostics-list > .panel,
    .routine-diagnostics-list > section.panel,
    .routine-diagnostics-list > details.panel {
      margin-bottom: 0;
      box-shadow: none;
      background: var(--surface);
    }
    .supporting-evidence { border-left: 4px solid var(--signal-slate); }
    .supporting-evidence[open] > summary { margin-bottom: 10px; }
    .supporting-evidence-list {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .supporting-evidence-summary-list {
      display: grid;
      gap: 8px;
    }
    .supporting-evidence-summary-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left: 4px solid var(--signal-slate);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .supporting-evidence-summary-row div {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .supporting-evidence-summary-row strong,
    .supporting-evidence-summary-row span,
    .supporting-evidence-summary-row small {
      overflow-wrap: anywhere;
    }
    .supporting-evidence-summary-row strong {
      color: var(--ink);
      font-weight: 760;
    }
    .supporting-evidence-summary-row span,
    .supporting-evidence-summary-row small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .supporting-evidence-full-details {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface-2);
    }
    .supporting-evidence-full-details[open] > summary { margin-bottom: 9px; }
    .supporting-evidence-full-list {
      display: grid;
      gap: 10px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .supporting-evidence-group {
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .supporting-evidence-operational[open] > summary { margin-bottom: 8px; }
    .supporting-evidence-snapshots[open] > summary { margin-bottom: 8px; }
    .supporting-evidence-raw {
      border-top: 1px solid var(--hairline);
      padding-top: 9px;
    }
    .supporting-evidence-raw[open] > summary { margin-bottom: 8px; }
    .supporting-evidence-group-heading {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .supporting-evidence-group-heading span {
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .supporting-evidence-group-heading small {
      display: inline;
      text-align: right;
    }
    .supporting-evidence-group-list {
      display: grid;
      gap: 10px;
    }
    .supporting-evidence-list > .panel,
    .supporting-evidence-full-list > .panel,
    .supporting-evidence-full-list > section.panel,
    .supporting-evidence-full-list > details.panel,
    .supporting-evidence-group-list > .panel,
    .supporting-evidence-group-list > section.panel,
    .supporting-evidence-group-list > details.panel {
      margin-bottom: 0;
      box-shadow: none;
      background: var(--surface);
    }
    .maintenance-heading, .maintenance-plan-main, .maintenance-actions,
    .candidate-triage-heading,
    .context-pack-heading,
    .governance-heading,
    .lifecycle-heading,
    .capture-inbox-heading, .capture-inbox-main, .capture-inbox-actions {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .maintenance-heading span, .maintenance-status,
    .candidate-triage-heading span,
    .context-pack-heading span,
    .governance-heading span,
    .lifecycle-heading span,
    .capture-inbox-heading span, .capture-inbox-status { color: var(--muted); font-size: 12px; font-weight: 650; }
    .last-action-receipt[hidden] { display: none; }
    .last-action-receipt {
      margin-top: 0;
      border-left: 4px solid var(--signal-green);
    }
    .action-receipt {
      border: 1px solid var(--border);
      border-left: 3px solid var(--signal-green);
      border-radius: 7px;
      padding: 8px 9px;
      margin-top: 9px;
      background: var(--surface);
      color: var(--ink-2);
    }
    .last-action-receipt.action-receipt { margin-bottom: 12px; }
    .action-receipt-layout { display: grid; gap: 8px; width: 100%; }
    .action-receipt-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 6px;
      align-items: center;
    }
    .action-receipt-title {
      color: var(--ink);
      font-weight: 780;
    }
    .action-receipt-head strong {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--signal-green-soft);
      color: var(--signal-green);
      font-size: 12px;
      font-weight: 800;
    }
    .action-receipt-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin: 0;
    }
    .action-receipt-grid div { grid-template-columns: 112px minmax(0, 1fr); }
    .action-receipt-grid .action-receipt-commands { grid-column: 1 / -1; }
    .action-receipt-commands dd {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .action-receipt code { background: var(--surface-2); }
    .maintenance-list, .candidate-triage-list, .candidate-triage-records, .governance-list, .lifecycle-findings, .lifecycle-actions, .capture-inbox-list, .capture-inbox-items { display: grid; gap: 10px; }
    .candidate-triage-heading { align-items: flex-start; margin-bottom: 10px; }
    .candidate-triage-heading p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .candidate-triage-counts {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .candidate-triage-counts span,
    .candidate-triage-record-meta {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .candidate-triage-group {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      background: var(--surface-2);
    }
    .candidate-triage-group[open] > summary { margin-bottom: 8px; }
    .candidate-triage-group summary strong {
      color: var(--ink);
      font-size: 12px;
      font-weight: 760;
    }
    .candidate-triage-group-body {
      border-top: 1px solid var(--hairline);
      padding-top: 9px;
    }
    .candidate-triage-group-details {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .candidate-triage-group-details[open] > summary {
      margin-bottom: 8px;
    }
    .candidate-triage-group-body p {
      margin-top: 0;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .candidate-triage-group-context {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 7px 9px;
      margin-bottom: 8px;
      background: var(--surface-2);
    }
    .candidate-triage-group-context[open] > summary {
      margin-bottom: 7px;
    }
    .candidate-triage-group-context p {
      margin: 0;
      color: var(--muted);
      font-size: 12.5px;
    }
    .candidate-triage-audit-notes {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 7px 9px;
      margin-bottom: 9px;
      background: var(--surface-2);
    }
    .candidate-triage-audit-notes[open] > summary {
      margin-bottom: 8px;
    }
    .candidate-triage-review-path {
      display: grid;
      gap: 7px;
      border: 1px solid #c9d5e6;
      border-left: 3px solid var(--signal-blue);
      border-radius: 7px;
      padding: 8px 9px;
      margin: 8px 0 9px;
      background: var(--signal-blue-soft);
    }
    .candidate-triage-review-path[open] > summary {
      margin-bottom: 7px;
    }
    .candidate-triage-review-path dl {
      margin: 0;
      grid-template-columns: minmax(0, 1fr);
    }
    .candidate-triage-review-path dl div {
      grid-template-columns: 112px minmax(0, 1fr);
    }
    .candidate-triage-review-path p {
      margin: 0;
      color: var(--ink-2);
      font-size: 12.5px;
    }
    .candidate-triage-audit-boundary {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 7px 9px;
      margin-bottom: 9px;
      background: var(--surface-2);
    }
    .candidate-triage-audit-boundary[open] > summary {
      margin-bottom: 8px;
    }
    .candidate-triage-promotion-drafts {
      border: 1px solid #cfd8c7;
      border-left: 3px solid var(--signal-green);
      border-radius: 7px;
      padding: 7px 9px;
      margin-bottom: 9px;
      background: var(--signal-green-soft);
    }
    .candidate-triage-promotion-drafts[open] > summary {
      margin-bottom: 8px;
    }
    .candidate-triage-promotion-list {
      display: grid;
      gap: 8px;
    }
    .candidate-triage-promotion-draft {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .candidate-triage-promotion-draft dl {
      margin: 0;
      grid-template-columns: minmax(0, 1fr);
    }
    .candidate-triage-promotion-draft dl div {
      grid-template-columns: 112px minmax(0, 1fr);
    }
    .candidate-triage-record-samples {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .candidate-triage-record-samples[open] > summary { margin-bottom: 8px; }
    .candidate-triage-overflow {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      border: 1px dashed var(--border);
      border-radius: 7px;
      padding: 8px 9px;
      margin-top: 8px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12.5px;
    }
    .candidate-triage-overflow-count {
      color: var(--ink);
      font-weight: 740;
    }
    .candidate-triage-record {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .candidate-triage-record[open] > summary { margin-bottom: 8px; }
    .candidate-triage-record-summary {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }
    .candidate-triage-record-summary span:first-child {
      min-width: 0;
    }
    .candidate-triage-record-summary strong,
    .candidate-triage-record-summary small {
      display: block;
      overflow-wrap: anywhere;
    }
    .candidate-triage-record-summary strong {
      color: var(--ink);
      font-weight: 760;
    }
    .candidate-triage-record-summary small {
      margin-top: 3px;
      color: var(--muted);
      font-size: 12px;
    }
    .governance-heading { align-items: flex-start; margin-bottom: 10px; }
    .governance-counts {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .governance-counts span, .governance-meta span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .governance-item {
      border: 1px solid var(--border);
      border-left-width: 3px;
      border-radius: 8px;
      padding: 9px 11px;
      background: var(--surface);
    }
    .governance-item.info { border-left-color: var(--info); }
    .governance-item.warning { border-left-color: var(--warning); }
    .governance-item.critical { border-left-color: var(--critical); }
    .governance-safe-group {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 9px 11px;
      background: var(--surface-2);
    }
    .governance-safe-group[open] > summary { margin-bottom: 8px; }
    .governance-safe-list { display: grid; gap: 8px; }
    .governance-safe-row {
      display: grid;
      grid-template-columns: 118px minmax(0, 1fr);
      gap: 4px 9px;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .governance-safe-row.info { border-left-color: var(--info); }
    .governance-safe-row.warning { border-left-color: var(--warning); }
    .governance-safe-row.critical { border-left-color: var(--critical); }
    .governance-safe-row span {
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 760;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .governance-safe-row strong {
      min-width: 0;
      color: var(--ink);
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .governance-safe-row small,
    .governance-safe-row code {
      grid-column: 2;
    }
    .governance-safe-notes {
      grid-column: 2;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .governance-safe-notes summary {
      cursor: pointer;
      font-weight: 720;
    }
    .governance-safe-notes ol {
      margin: 7px 0 0 18px;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    .governance-safe-notes li {
      overflow-wrap: anywhere;
    }
    .governance-item[open] > summary { margin-bottom: 8px; }
    .governance-item-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }
    .governance-item-main { min-width: 0; }
    .governance-item-summary strong {
      display: block;
      color: var(--ink);
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .governance-item-summary small { font-size: 12px; }
    .governance-item-body {
      border-top: 1px solid var(--hairline);
      padding-top: 8px;
    }
    .governance-item-body p { margin-top: 0; color: var(--muted); overflow-wrap: anywhere; }
    .governance-finding-summary {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      margin: 8px 0;
      background: var(--surface);
    }
    .governance-finding-summary h4 {
      margin: 0 0 7px;
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .governance-finding-summary dl {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
    }
    .governance-finding-summary dl div {
      grid-template-columns: minmax(96px, auto) minmax(0, 1fr);
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 6px 7px;
      background: var(--surface-2);
    }
    .review-log {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      margin: 8px 0;
      background: var(--surface-2);
    }
    .review-log h4 {
      margin: 0 0 6px;
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .review-log ol {
      display: grid;
      gap: 5px;
      margin: 0;
      padding-left: 19px;
    }
    .review-log li {
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .raw-audit-fields {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .raw-audit-fields[open] > summary { margin-bottom: 8px; }
    .raw-audit-fields summary { color: var(--ink); font-weight: 720; }
    .governance-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .context-pack-summary {
      margin: 0 0 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .context-pack-summary div {
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px;
      background: var(--surface);
      min-width: 0;
    }
    .context-pack-review-fold {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 10px;
      align-items: center;
    }
    .context-pack-readiness {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .context-pack-chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 730;
      overflow-wrap: anywhere;
    }
    .context-pack-checks {
      display: grid;
      gap: 7px;
      padding-left: 0;
      margin: 10px 0;
      list-style: none;
    }
    .context-pack-checks-fold {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px;
      margin: 10px 0;
      background: var(--surface);
    }
    .context-pack-checks-fold[open] > summary { margin-bottom: 8px; }
    .context-pack-checks-fold .context-pack-checks { margin-bottom: 0; }
    .context-pack-checks li {
      display: grid;
      grid-template-columns: 58px minmax(120px, 1fr) auto minmax(0, 2fr);
      gap: 8px;
      align-items: center;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px;
      background: var(--surface);
    }
    .context-pack-checks li span {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    .context-pack-checks li em {
      font-style: normal;
      color: var(--muted);
      font-weight: 760;
    }
    .context-pack-checks li code { grid-column: 1 / -1; }
    .context-pack-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .context-pack-grid h3 { margin-bottom: 8px; }
    .context-pack-evidence {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px;
      margin-top: 10px;
      background: var(--surface);
    }
    .context-pack-evidence[open] > summary { margin-bottom: 10px; }
    .context-pack-items { display: grid; gap: 8px; }
    .context-pack-item {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface);
    }
    .context-pack-item p {
      margin: 0 0 6px;
      color: var(--ink);
      font-weight: 560;
      overflow-wrap: anywhere;
    }
    .capture-policy, .lifecycle-policy {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: -4px 0 12px;
      color: var(--muted);
      font-size: 12px;
    }
    .capture-policy div, .lifecycle-policy div {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
    }
    .capture-policy strong, .lifecycle-policy strong {
      color: var(--ink);
      font-weight: 760;
    }
    .capture-policy span, .lifecycle-policy span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      font-weight: 700;
    }
    .capture-policy-summary, .capture-inbox-audit {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px;
      margin: -4px 0 12px;
      background: var(--surface);
    }
    .capture-inbox-audit { margin: 12px 0 0; background: var(--surface-2); }
    .capture-inbox-audit[open] > summary { margin-bottom: 8px; }
    .capture-policy-summary[open] > summary { margin-bottom: 8px; }
    .capture-policy-summary .capture-policy { margin: 0 0 8px; }
    .capture-policy-summary .capture-policy:last-child { margin-bottom: 0; }
    .capture-inbox-audit .capture-policy { margin: 0 0 8px; }
    .capture-inbox-audit .capture-policy:last-of-type { margin-bottom: 0; }
    .capture-inbox-queue-summary {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 10px;
      margin: 0 0 10px;
      background: var(--surface-2);
      min-width: 0;
    }
    .capture-inbox-queue-summary h3 { margin-bottom: 4px; }
    .capture-inbox-queue-summary p {
      margin-top: 3px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .capture-inbox-queue-chips {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .capture-inbox-queue-chips span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      white-space: nowrap;
    }
    .capture-policy-rules {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 10px;
      margin: 8px 0 0;
      background: var(--surface-2);
    }
    .capture-policy-rules summary { font-weight: 760; color: var(--ink); }
    .capture-policy-rule-list {
      display: grid;
      gap: 7px;
      margin: 10px 0 0;
      padding: 0;
      list-style: none;
    }
    .capture-policy-rule-list li {
      display: grid;
      grid-template-columns: minmax(120px, auto) minmax(120px, auto) minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px;
      background: var(--surface);
    }
    .capture-policy-rule-list strong { color: var(--ink); }
    .maintenance-plan, .lifecycle-finding, .lifecycle-action, .capture-policy-decision, .capture-inbox-group, .capture-inbox-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface-2);
    }
    .lifecycle-finding, .lifecycle-action { background: var(--surface); }
    .lifecycle-finding div, .lifecycle-action div {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 7px;
    }
    .lifecycle-finding strong, .lifecycle-action strong { color: var(--ink); font-weight: 760; }
    .lifecycle-finding span, .lifecycle-action small { color: var(--muted); font-size: 12px; font-weight: 650; }
    .lifecycle-action code { display: block; width: 100%; margin: 6px 0; }
    .lifecycle-action.review { border-left: 3px solid var(--warning); }
    .lifecycle-action.safe { border-left: 3px solid var(--good); }
    .lifecycle-action-details { margin-top: 10px; }
    .lifecycle-action-details summary { font-weight: 760; color: var(--ink); }
    .dashboard-fold-summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px 10px;
      min-width: 0;
      color: var(--ink);
      font-weight: 760;
    }
    .dashboard-fold-summary span,
    .dashboard-fold-summary small {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .dashboard-fold-summary small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .memory-lifecycle[open] > summary, .capture-policy-audit[open] > summary, .store-signals[open] > summary { margin-bottom: 12px; }
    .store-signals .visual-grid { margin-top: 0; }
    .sync-position-focus { margin-bottom: 10px; }
    .store-telemetry-context {
      border-top: 1px solid var(--hairline);
      padding-top: 8px;
    }
    .store-telemetry-context[open] > summary { margin-bottom: 9px; }
    .signal-card {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 12px;
      background: var(--surface-2);
      min-width: 0;
    }
    .capture-policy-decisions { display: grid; gap: 10px; margin-top: 10px; }
    .capture-policy-decision { background: var(--surface); }
    .capture-policy-decision.review { border-left: 3px solid var(--signal-blue); }
    .capture-policy-decision.archived { border-left: 3px solid var(--signal-slate); }
    .capture-policy-decision .capture-inbox-summary div:last-child { grid-column: 1 / -1; }
    .capture-inbox-group {
      background: var(--surface);
      box-shadow: 0 8px 18px rgba(21, 25, 30, 0.04);
    }
    .capture-inbox-items { margin-top: 10px; }
    .capture-inbox-context {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      margin: 0 0 10px;
      background: var(--surface-2);
    }
    .capture-inbox-context[open] > summary { margin-bottom: 8px; }
    .capture-inbox-context summary {
      color: var(--ink);
      font-weight: 720;
    }
    .capture-inbox-context .capture-inbox-summary { margin-bottom: 0; }
    .capture-inbox-item-review {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      margin-bottom: 10px;
      background: var(--surface-2);
    }
    .capture-inbox-item-review[open] > summary { margin-bottom: 8px; }
    .capture-inbox-item-review > summary {
      color: var(--ink);
      font-weight: 720;
    }
    .capture-inbox-evidence-index {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 7px 9px;
      margin-bottom: 10px;
      background: var(--surface);
    }
    .capture-inbox-evidence-index[open] > summary { margin-bottom: 8px; }
    .capture-inbox-evidence-index > summary {
      color: var(--ink);
      font-weight: 720;
    }
    .capture-inbox-item { background: var(--surface); }
    .capture-inbox-item[open] > summary { margin-bottom: 10px; }
    .capture-inbox-item-summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 10px;
      align-items: start;
      min-width: 0;
      color: var(--ink);
      cursor: pointer;
    }
    .capture-inbox-item-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .capture-inbox-item-main p { margin: 0; color: var(--muted); }
    .capture-inbox-item-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .capture-inbox-item-meta span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      white-space: nowrap;
    }
    .capture-inbox-item-body {
      display: grid;
      gap: 10px;
    }
    .capture-inbox-item-body > .pill {
      justify-self: start;
    }
    .maintenance-plan-main, .capture-inbox-main { align-items: flex-start; margin-bottom: 10px; }
    .maintenance-plan-flags {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
    }
    .maintenance-plan-flags span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      white-space: nowrap;
    }
    .maintenance-brief, .capture-inbox-brief, .context-pack-brief, .capture-policy-routing-brief {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 10px;
      margin: 0 0 10px;
      background: var(--surface);
    }
    .maintenance-brief h4, .capture-inbox-brief h4, .context-pack-brief h4, .capture-policy-routing-brief h4 {
      margin: 0 0 7px;
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .capture-policy-routing-brief div {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .capture-policy-routing-brief strong {
      color: var(--ink);
      font-size: 13px;
    }
    .capture-policy-routing-brief span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
    }
    .capture-policy-routing-brief code {
      overflow-wrap: anywhere;
    }
    .maintenance-brief-list,
    .capture-inbox-brief-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      margin: 0;
    }
    .maintenance-brief-list div,
    .capture-inbox-brief-list div {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px;
      align-items: baseline;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 6px 7px;
      background: var(--surface-2);
    }
    .maintenance-brief-list dt,
    .capture-inbox-brief-list dt {
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .maintenance-brief-list dd,
    .capture-inbox-brief-list dd {
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 730;
      overflow-wrap: anywhere;
    }
    .maintenance-brief p {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .capture-inbox-brief ul, .context-pack-brief ul {
      display: grid;
      gap: 6px;
      margin: 0;
      padding-left: 18px;
    }
    .capture-inbox-brief li, .context-pack-brief li {
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .maintenance-outcome {
      border-top: 1px solid var(--hairline);
      margin: 8px 0 0;
      padding-top: 8px;
      gap: 6px;
    }
    .maintenance-outcome div {
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 8px;
    }
    .maintenance-outcome dt {
      color: var(--ink);
      font-weight: 780;
    }
    .maintenance-outcome dd {
      color: var(--ink-2);
    }
    .maintenance-audit-details {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      margin: 8px 0 10px;
      background: var(--surface);
    }
    .maintenance-audit-details[open] > summary { margin-bottom: 8px; }
    .maintenance-audit-details summary { color: var(--ink); font-weight: 720; }
    .maintenance-plan-evidence {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      margin-top: 8px;
      background: var(--surface);
    }
    .maintenance-plan-evidence[open] > summary { margin-bottom: 8px; }
    .maintenance-decision-record {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      margin: 0 0 8px;
      background: var(--surface-2);
    }
    .maintenance-decision-section + .maintenance-decision-section {
      border-top: 1px solid var(--hairline);
      margin-top: 9px;
      padding-top: 9px;
    }
    .maintenance-decision-record h4 {
      margin: 0 0 7px;
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .maintenance-decision-record dl {
      display: grid;
      gap: 7px;
      margin: 0;
    }
    .maintenance-decision-record dl div {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .maintenance-decision-record dt { color: var(--ink); }
    .maintenance-decision-record dd { color: var(--ink-2); }
    .maintenance-audit-details .review-log {
      border: 0;
      padding: 0;
      margin: 0;
      background: transparent;
    }
    .capture-inbox-main p {
      color: var(--ink);
      font-size: 14.5px;
      font-weight: 560;
      overflow-wrap: anywhere;
    }
    .maintenance-summary, .lifecycle-summary, .capture-inbox-summary {
      margin: 0 0 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .maintenance-summary div, .lifecycle-summary div, .capture-inbox-summary div {
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px;
      background: var(--surface);
      min-width: 0;
    }
    .maintenance-summary div:last-child { grid-column: 1 / -1; }
    .maintenance-summary small, .lifecycle-summary small, .capture-inbox-summary small { margin-top: 3px; }
    .maintenance-plan > details {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
    }
    .maintenance-plan > details summary { color: var(--ink); font-weight: 760; }
    .maintenance-plan > details[open] summary { margin-bottom: 9px; }
    .maintenance-detail-grid { display: grid; gap: 9px; }
    .maintenance-detail-grid section {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
      min-width: 0;
    }
    .maintenance-detail-grid h4 {
      margin: 0 0 7px;
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .maintenance-checks { display: grid; gap: 6px; padding-left: 0; list-style: none; }
    .maintenance-checks li {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--surface);
    }
    .maintenance-checks li span { font-size: 11px; font-weight: 800; text-transform: uppercase; }
    .maintenance-record-id-summary,
    .maintenance-command-summary {
      display: grid;
      gap: 7px;
      min-width: 0;
    }
    .maintenance-record-id-preview,
    .maintenance-record-id-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      min-width: 0;
    }
    .maintenance-command-detail {
      display: grid;
      gap: 8px;
      align-items: start;
      min-width: 0;
    }
    .maintenance-command-detail button {
      justify-self: start;
    }
    .maintenance-overflow-count {
      display: inline-flex;
      width: fit-content;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
    }
    .maintenance-raw-overflow {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 7px 8px;
      background: var(--surface);
    }
    .maintenance-raw-overflow[open] > summary { margin-bottom: 7px; }
    .maintenance-actions, .capture-inbox-actions { justify-content: flex-end; flex-wrap: wrap; margin-top: 10px; }
    button {
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      color: var(--ink);
      padding: 5px 10px;
      font: inherit;
      font-weight: 720;
      cursor: pointer;
    }
    button.primary { background: var(--signal-green); border-color: var(--signal-green); color: #fff; }
    button:disabled { cursor: wait; opacity: 0.68; }
    .agent-bars { display: grid; gap: 10px; }
    .bar-row { --bar-accent: var(--signal-green); display: grid; gap: 6px; }
    .bar-row:nth-child(1) { --bar-accent: var(--signal-green); }
    .bar-row:nth-child(2) { --bar-accent: var(--signal-blue); }
    .bar-row:nth-child(3) { --bar-accent: var(--signal-amber); }
    .bar-row:nth-child(4) { --bar-accent: var(--signal-violet); }
    .bar-row:nth-child(5) { --bar-accent: var(--signal-red); }
    .bar-label { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
    .bar-label strong { color: var(--ink); font-weight: 760; }
    .bar-label span { color: var(--muted); font-size: 12px; font-weight: 560; text-align: right; }
    .bar-track { height: 11px; border-radius: 999px; background: var(--surface-3); overflow: hidden; box-shadow: inset 0 1px 2px rgba(21,25,30,0.06); }
    .bar-track span { display: block; height: 100%; background: var(--bar-accent); border-radius: inherit; }
    .state-stack { display: grid; gap: 10px; }
    .stack-bar { display: flex; height: 16px; border-radius: 999px; overflow: hidden; background: var(--surface-3); box-shadow: inset 0 1px 2px rgba(21,25,30,0.06); }
    .stack-bar span { min-width: 3px; }
    .stack-legend { display: flex; flex-wrap: wrap; gap: 8px 12px; color: var(--muted); font-size: 12px; }
    .stack-legend span { display: inline-flex; align-items: center; gap: 5px; font-weight: 620; }
    .stack-legend i { width: 9px; height: 9px; border-radius: 2px; }
    .stack-legend .state-canonical, .stack-bar .state-canonical { background: var(--good); }
    .stack-legend .state-candidate, .stack-bar .state-candidate { background: var(--accent-2); }
    .stack-legend .state-raw, .stack-bar .state-raw { background: var(--warning); }
    .stack-legend .state-archived, .stack-bar .state-archived { background: var(--signal-slate); }
    .stack-legend .state-quarantined, .stack-bar .state-quarantined { background: var(--critical); }
    .type-bars { display: grid; gap: 10px; }
    .type-row { --type-accent: var(--signal-blue); display: grid; gap: 6px; }
    .type-memory { --type-accent: var(--signal-blue); }
    .type-skill { --type-accent: var(--signal-green); }
    .type-soul { --type-accent: var(--signal-violet); }
    .type-session_summary { --type-accent: var(--signal-amber); }
    .type-agent_note { --type-accent: var(--signal-slate); }
    .type-label { display: flex; justify-content: space-between; gap: 8px; min-width: 0; }
    .type-label strong { color: var(--ink); font-weight: 760; }
    .type-label span { color: var(--muted); font-size: 12px; font-weight: 560; text-align: right; }
    .type-track { height: 9px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .type-track span { display: block; height: 100%; border-radius: inherit; background: var(--type-accent); }
    .sync-action-brief {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(180px, auto);
      gap: 8px 12px;
      align-items: center;
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 10px 11px;
      margin: 10px 0 12px;
      background: var(--surface-2);
    }
    .sync-action-brief.warning { border-left-color: var(--warning); }
    .sync-action-brief.critical { border-left-color: var(--critical); }
    .sync-action-main {
      min-width: 0;
    }
    .sync-action-main h3 {
      margin: 0 0 2px;
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 780;
      text-transform: uppercase;
    }
    .sync-action-main strong {
      display: block;
      color: var(--ink);
      font-size: 15px;
      line-height: 1.2;
      font-weight: 820;
      overflow-wrap: anywhere;
    }
    .sync-action-main small {
      margin-top: 3px;
    }
    .sync-action-brief > code {
      justify-self: end;
      width: 100%;
      max-width: 360px;
      padding: 6px 7px;
    }
    .sync-action-context {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .sync-action-context span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .sync-rail { display: grid; gap: 8px; }
    .rail-labels { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); font-size: 12px; }
    .rail-labels strong { color: var(--ink); font-weight: 780; }
    .rail { position: relative; height: 14px; display: grid; grid-template-columns: 1fr 16px 1fr; align-items: center; }
    .rail:before { content: ""; position: absolute; left: 0; right: 0; top: 6px; height: 2px; background: var(--border); }
    .rail span { position: relative; height: 8px; background: var(--warning); border-radius: 999px; }
    .rail .behind { justify-self: end; }
    .rail .ahead { justify-self: start; background: var(--accent); }
    .rail i { position: relative; width: 12px; height: 12px; border-radius: 50%; background: var(--surface); border: 3px solid var(--accent); justify-self: center; box-shadow: 0 0 0 4px rgba(33,113,94,0.1); }
    .recent-value-panel[open] > summary { margin-bottom: 10px; }
    .recent-value-body {
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .value-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .value-grid-overflow { margin-top: 10px; }
    .value-card {
      --value-accent: var(--signal-green);
      min-width: 0;
      border: 1px solid var(--border);
      border-top: 3px solid var(--value-accent);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface);
      box-shadow: 0 9px 22px rgba(21,25,30,0.04);
    }
    .value-card:nth-child(1) { --value-accent: var(--signal-green); }
    .value-card:nth-child(2) { --value-accent: var(--signal-blue); }
    .value-card:nth-child(3) { --value-accent: var(--signal-amber); }
    .value-card:nth-child(4) { --value-accent: var(--signal-red); }
    .value-card:nth-child(5) { --value-accent: var(--signal-violet); }
    .value-card-overflow { background: var(--surface-2); box-shadow: none; }
    .value-card-head, .value-card footer { display: flex; justify-content: space-between; gap: 8px; align-items: center; min-width: 0; }
    .value-card p {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
      color: var(--ink);
      font-size: 14.5px;
      font-weight: 560;
      overflow-wrap: anywhere;
    }
    .value-card footer { margin-top: 10px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
    .recent-value-overflow {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px;
      margin-top: 10px;
      background: var(--surface);
    }
    .citation-links { display: grid; gap: 5px; min-width: 0; }
    .citation-links code { width: 100%; }
    .inspector-grid { display: grid; gap: 12px; }
    .debug-inspector[open] > summary { margin-bottom: 12px; }
    .table-wrap { max-width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 7px; background: var(--surface); }
    table { width: 100%; min-width: 940px; table-layout: fixed; border-collapse: collapse; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    th { color: var(--ink); background: var(--surface-2); font-size: 12px; font-weight: 780; }
    td { font-size: 13px; }
    th:nth-child(1), td:nth-child(1) { width: 150px; }
    th:nth-child(6), td:nth-child(6) { width: 120px; }
    th:nth-child(7), td:nth-child(7) { width: 170px; }
    .copy-id { max-width: 130px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
    .truncate { display: inline-block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    details summary { cursor: pointer; }
    .event-list { display: grid; gap: 8px; }
    .event-row { border: 1px solid var(--border); border-radius: 7px; padding: 10px; background: var(--surface); }
    .event-row summary { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }
    .debug-inspector-overflow {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      border: 1px dashed var(--border);
      border-radius: 7px;
      padding: 8px 9px;
      margin-top: 8px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12.5px;
    }
    .debug-inspector-overflow-count {
      color: var(--ink);
      font-weight: 740;
    }
    @media (max-width: 920px) {
      header, .dashboard-overview-quiet-list, .dashboard-work-lanes, .dashboard-work-lanes-quiet-list, .action-board-grid, .action-board-quiet-list, .decision-summary-list, .visual-grid, .value-grid { grid-template-columns: 1fr; }
      .store-path { white-space: normal; overflow-wrap: anywhere; }
      main { padding: 18px 12px 36px; }
      .status-strip { grid-template-columns: 1fr; align-items: start; }
      .dashboard-overview-main { display: grid; align-items: stretch; }
      .dashboard-overview-action { width: 100%; white-space: normal; }
      .sync-action-brief { grid-template-columns: 1fr; }
      .sync-action-brief > code { justify-self: stretch; max-width: none; }
      .decision-summary-heading { display: grid; }
      .decision-summary-counts { justify-content: flex-start; }
      .capture-inbox-queue-summary { display: grid; }
      .capture-inbox-queue-chips { justify-content: flex-start; }
      .attention-summary { display: grid; justify-content: stretch; }
      .action-board-heading,
      .bar-label, .maintenance-heading, .maintenance-plan-main, .maintenance-actions,
      .context-pack-heading, .governance-heading,
      .lifecycle-heading,
      .capture-inbox-heading, .capture-inbox-main, .capture-inbox-actions { display: grid; justify-content: stretch; }
      .capture-inbox-item-summary { grid-template-columns: 1fr; }
      .capture-inbox-item-meta { justify-content: flex-start; }
      .maintenance-summary, .context-pack-summary, .context-pack-grid, .health-check-action-groups, .lifecycle-summary, .capture-inbox-summary { grid-template-columns: 1fr; }
      .governance-finding-summary dl { grid-template-columns: 1fr; }
      .governance-counts { justify-content: flex-start; }
      .governance-item-summary { align-items: flex-start; display: grid; }
      .governance-meta { justify-content: flex-start; }
      .context-pack-checks li { grid-template-columns: 1fr; }
      .bar-label span { text-align: left; }
    }
  </style>
</head>
<body class="neutral-intelligence">
  <main${refreshAttributes}>${renderDashboardBody(data)}</main>
  ${dashboardRefreshScript(options.refreshIntervalMs)}
  ${dashboardActionBoardScript()}
  ${dashboardActionReceiptScript()}
  ${dashboardMaintenanceScript()}
  ${dashboardCaptureInboxScript()}
  ${dashboardCandidateTriageScript()}
</body>
</html>
`;
}

export function renderDashboardHtml(data: DashboardData): string {
  return renderDashboardShell(data);
}

export function renderDashboardServerHtml(data: DashboardData, refreshIntervalMs: number): string {
  return renderDashboardShell(data, { refreshIntervalMs });
}

export function renderDashboardFragment(data: DashboardData): string {
  return renderDashboardBody(data);
}

export function createDashboardDataLoader<T>(build: () => Promise<T>): { load: () => Promise<T> } {
  let inFlight: Promise<T> | undefined;
  return {
    load: () => {
      inFlight ??= build().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    }
  };
}

export async function writeDashboardSnapshot(storePath: string, options: DashboardOptions = {}): Promise<DashboardSnapshot> {
  const outputPath = join(storePath, "state", "dashboard", "index.html");
  const data = await buildDashboardData(storePath, options);
  await mkdir(join(storePath, "state", "dashboard"), { recursive: true });
  await writeFile(outputPath, renderDashboardHtml(data), "utf8");
  return {
    generated: true,
    opened: false,
    path: outputPath,
    url: pathToFileURL(outputPath).href
  };
}

function dashboardServerHost(host: string | undefined): string {
  return host ?? "127.0.0.1";
}

function dashboardServerPort(port: number | undefined): number {
  if (port === undefined) return 8765;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid argument: Invalid dashboard port; must be an integer between 0 and 65535");
  }
  return port;
}

function dashboardRefreshInterval(interval: number | undefined): number {
  if (interval === undefined) return 2000;
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) {
    throw new Error("Invalid argument: Invalid dashboard refresh interval; must be an integer between 250 and 60000");
  }
  return interval;
}

function dashboardServerUrl(host: string, port: number): string {
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${displayHost}:${port}/`;
}

function sendResponse(response: ServerResponse, statusCode: number, body: string, contentType: string, includeBody = true): void {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(includeBody ? body : undefined);
}

async function readRequestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  return JSON.parse(body) as unknown;
}

function approvalPlanId(pathname: string): string | undefined {
  const match = /^\/api\/maintenance\/plans\/(.+)\/approve$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function captureInboxAction(pathname: string): { recordId: string; action: "approve" | "reject" } | undefined {
  const match = /^\/api\/capture-inbox\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (!match?.[1] || (match[2] !== "approve" && match[2] !== "reject")) return undefined;
  return {
    recordId: decodeURIComponent(match[1]),
    action: match[2]
  };
}

function captureInboxGroupAction(pathname: string): { groupId: string; action: "approve" | "reject" } | undefined {
  const match = /^\/api\/capture-inbox\/groups\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (!match?.[1] || (match[2] !== "approve" && match[2] !== "reject")) return undefined;
  return {
    groupId: decodeURIComponent(match[1]),
    action: match[2]
  };
}

function candidateTriagePromotionAction(pathname: string): { recordId: string } | undefined {
  const match = /^\/api\/candidate-triage\/promotions\/([^/]+)\/approve$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return { recordId: decodeURIComponent(match[1]) };
}

async function requireCaptureInboxCandidate(storePath: string, recordId: string, includePrivate: boolean | undefined): Promise<MorynRecord | undefined> {
  const records = replayEvents(await readEvents(storePath));
  const record = records.get(recordId);
  if (!record || !isVisibleForDashboard(record, includePrivate) || !isCaptureInboxCandidate(record)) return undefined;
  return record;
}

async function requireCandidateTriagePromotableRecord(storePath: string, recordId: string, includePrivate: boolean | undefined): Promise<MorynRecord | undefined> {
  const records = replayEvents(await readEvents(storePath));
  const record = records.get(recordId);
  if (!record || !isVisibleForDashboard(record, includePrivate) || record.state !== "candidate" || record.visibility !== "active" || !isCandidateTriagePromotable(record)) {
    return undefined;
  }
  return record;
}

function parseCaptureRecordIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { record_ids?: unknown }).record_ids)) return [];
  return (body as { record_ids: unknown[] }).record_ids.filter((value): value is string => typeof value === "string" && value.length > 0);
}

async function requireCaptureInboxGroup(
  storePath: string,
  groupId: string,
  recordIds: string[],
  includePrivate: boolean | undefined
): Promise<MorynRecord[] | undefined> {
  if (recordIds.length === 0) return undefined;
  const records = [...replayEvents(await readEvents(storePath)).values()]
    .filter((record) => isVisibleForDashboard(record, includePrivate))
    .filter(isCaptureInboxCandidate)
    .filter((record) => captureGroupId(captureGroupKey(record)) === groupId)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  const currentIds = records.map((record) => record.id);
  if (currentIds.length !== recordIds.length) return undefined;
  if (currentIds.some((id, index) => id !== recordIds[index])) return undefined;
  return records;
}

async function applyCaptureInboxAction(
  storePath: string,
  recordId: string,
  action: "approve" | "reject",
  body: unknown,
  includePrivate: boolean | undefined
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const record = await requireCaptureInboxCandidate(storePath, recordId, includePrivate);
  if (!record) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        status: "not_actionable",
        message: "Capture Inbox actions require an active review candidate record."
      }
    };
  }

  const engine = createEngine({ storePath });
  if (action === "approve") {
    const promoted = await engine.promote({
      record_id: record.id,
      target_state: "canonical",
      reason: "User approved Capture Inbox candidate.",
      source: { client: "user" },
      confirmed: true
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: "approved",
        record_id: record.id,
        event_id: promoted.event.event_id
      }
    };
  }

  const reason = body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string" && (body as { reason: string }).reason.trim()
    ? (body as { reason: string }).reason.trim()
    : "User rejected Capture Inbox candidate.";
  const archived = await engine.archive({
    record_id: record.id,
    reason,
    source: { client: "user" }
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      status: "rejected",
      record_id: record.id,
      event_id: archived.event.event_id
    }
  };
}

async function applyCaptureInboxGroupAction(
  storePath: string,
  groupId: string,
  action: "approve" | "reject",
  body: unknown,
  includePrivate: boolean | undefined
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const recordIds = parseCaptureRecordIds(body);
  const records = await requireCaptureInboxGroup(storePath, groupId, recordIds, includePrivate);
  if (!records) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        status: "not_actionable",
        message: "Capture Inbox group actions require current active candidate records from the selected group."
      }
    };
  }

  const engine = createEngine({ storePath });
  const events: string[] = [];
  if (action === "approve") {
    for (const record of records) {
      const promoted = await engine.promote({
        record_id: record.id,
        target_state: "canonical",
        reason: "User approved Capture Inbox group.",
        source: { client: "user" },
        confirmed: true
      });
      events.push(promoted.event.event_id);
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        status: "approved",
        group_id: groupId,
        records_changed: records.length,
        record_ids: records.map((record) => record.id),
        event_ids: events
      }
    };
  }

  const reason = body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string" && (body as { reason: string }).reason.trim()
    ? (body as { reason: string }).reason.trim()
    : "User rejected Capture Inbox group.";
  for (const record of records) {
    const archived = await engine.archive({
      record_id: record.id,
      reason,
      source: { client: "user" }
    });
    events.push(archived.event.event_id);
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      status: "rejected",
      group_id: groupId,
      records_changed: records.length,
      record_ids: records.map((record) => record.id),
      event_ids: events
    }
  };
}

async function applyCandidateTriagePromotionApproval(
  storePath: string,
  recordId: string,
  includePrivate: boolean | undefined
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const record = await requireCandidateTriagePromotableRecord(storePath, recordId, includePrivate);
  if (!record) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        status: "not_actionable",
        message: "Candidate Triage promotion requires a current promotable candidate record."
      }
    };
  }

  const engine = createEngine({ storePath });
  const promoted = await engine.promote({
    record_id: record.id,
    target_state: "canonical",
    reason: CANDIDATE_TRIAGE_PROMOTION_REASON,
    source: { client: "user" },
    confirmed: true
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      status: "approved",
      surface: "candidate_triage",
      record_id: record.id,
      event_id: promoted.event.event_id
    }
  };
}

export async function startDashboardServer(storePath: string, options: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const host = dashboardServerHost(options.host);
  const requestedPort = dashboardServerPort(options.port);
  const refreshIntervalMs = dashboardRefreshInterval(options.refreshIntervalMs);
  const limit = dashboardLimit(options.limit);
  const includePrivate = options.include_private;
  const dashboardDataLoader = createDashboardDataLoader(() => buildDashboardData(storePath, {
    limit,
    include_private: includePrivate,
    project_id: options.project_id,
    readiness_host: options.readiness_host,
    sync_remote: options.sync_remote
  }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${requestedPort}`}`);
    const includeBody = request.method !== "HEAD";
    try {
      if (request.method === "POST") {
        const inboxGroupAction = captureInboxGroupAction(url.pathname);
        if (inboxGroupAction) {
          let body: unknown;
          try {
            body = await readRequestJson(request);
          } catch {
            sendResponse(response, 400, JSON.stringify({ error: "Invalid request: JSON body is required" }), "application/json; charset=utf-8", includeBody);
            return;
          }
          const result = await applyCaptureInboxGroupAction(storePath, inboxGroupAction.groupId, inboxGroupAction.action, body, includePrivate);
          sendResponse(response, result.statusCode, JSON.stringify(result.body), "application/json; charset=utf-8", includeBody);
          return;
        }
        const inboxAction = captureInboxAction(url.pathname);
        if (inboxAction) {
          let body: unknown;
          try {
            body = await readRequestJson(request);
          } catch {
            sendResponse(response, 400, JSON.stringify({ error: "Invalid request: JSON body is required" }), "application/json; charset=utf-8", includeBody);
            return;
          }
          const result = await applyCaptureInboxAction(storePath, inboxAction.recordId, inboxAction.action, body, includePrivate);
          sendResponse(response, result.statusCode, JSON.stringify(result.body), "application/json; charset=utf-8", includeBody);
          return;
        }
        const candidatePromotionAction = candidateTriagePromotionAction(url.pathname);
        if (candidatePromotionAction) {
          let body: unknown;
          try {
            body = await readRequestJson(request);
          } catch {
            sendResponse(response, 400, JSON.stringify({ error: "Invalid request: JSON body is required" }), "application/json; charset=utf-8", includeBody);
            return;
          }
          if (!body || typeof body !== "object") {
            sendResponse(response, 400, JSON.stringify({ error: "Invalid request: JSON body is required" }), "application/json; charset=utf-8", includeBody);
            return;
          }
          const result = await applyCandidateTriagePromotionApproval(storePath, candidatePromotionAction.recordId, includePrivate);
          sendResponse(response, result.statusCode, JSON.stringify(result.body), "application/json; charset=utf-8", includeBody);
          return;
        }
        const planId = approvalPlanId(url.pathname);
        if (!planId) {
          sendResponse(response, 404, JSON.stringify({ error: "Not found" }), "application/json; charset=utf-8", includeBody);
          return;
        }
        let body: unknown;
        try {
          body = await readRequestJson(request);
        } catch {
          sendResponse(response, 400, JSON.stringify({ error: "Invalid request: JSON body is required" }), "application/json; charset=utf-8", includeBody);
          return;
        }
        if (!body || typeof body !== "object" || typeof (body as { plan_hash?: unknown }).plan_hash !== "string") {
          sendResponse(response, 400, JSON.stringify({ error: "Invalid request: plan_hash is required" }), "application/json; charset=utf-8", includeBody);
          return;
        }
        const approval = await approveMaintenancePlan(
          storePath,
          { project_id: options.project_id, include_private: includePrivate },
          planId,
          (body as { plan_hash: string }).plan_hash
        );
        sendResponse(
          response,
          approval.ok ? 200 : approval.status === "stale_plan" ? 409 : 404,
          JSON.stringify(approval),
          "application/json; charset=utf-8",
          includeBody
        );
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendResponse(response, 405, "Method not allowed", "text/plain; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const data = await dashboardDataLoader.load();
        sendResponse(response, 200, renderDashboardServerHtml(data, refreshIntervalMs), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/fragment") {
        const data = await dashboardDataLoader.load();
        sendResponse(response, 200, renderDashboardFragment(data), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/api/dashboard") {
        const data = await dashboardDataLoader.load();
        sendResponse(response, 200, JSON.stringify(data), "application/json; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/healthz") {
        sendResponse(response, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8", includeBody);
        return;
      }
      sendResponse(response, 404, "Not found", "text/plain; charset=utf-8", includeBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendResponse(response, 500, JSON.stringify({ error: message }), "application/json; charset=utf-8", includeBody);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  return {
    serving: true,
    host,
    port,
    url: dashboardServerUrl(host, port),
    refresh_interval_ms: refreshIntervalMs,
    close: () => closeDashboardServer(server)
  };
}

function closeDashboardServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function defaultOpenCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

function commandFromOverride(command: string, url: string): { command: string; args: string[] } {
  return { command, args: [url] };
}

export async function openDashboard(url: string, options: DashboardOpenOptions = {}): Promise<void> {
  const command = options.command ?? process.env.MORYN_DASHBOARD_OPEN_COMMAND;
  const opener = command ? commandFromOverride(command, url) : defaultOpenCommand(url);
  await exec(opener.command, opener.args);
}
