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

declare global {
  interface Window {
    applyDashboardLanguage?: () => void;
    restoreActionReceipt?: () => void;
    renderActionReceipt?: (result: unknown) => void;
  }
  }

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
  zh_detail?: string;
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

export type DashboardMemoryInventoryStateId = "remembered" | "new_items" | "temporary" | "set_aside";

export interface DashboardMemoryInventoryState {
  id: DashboardMemoryInventoryStateId;
  label: string;
  zh_label: string;
  count: number;
  source_states: MorynRecord["state"][];
}

export interface DashboardMemoryInventoryKind {
  kind: RecordKind;
  label: string;
  zh_label: string;
  count: number;
}

export interface DashboardMemoryInventory {
  summary: {
    remembered: number;
    new_items: number;
    temporary: number;
    set_aside: number;
    total_visible: number;
  };
  review_suggested: boolean;
  states: DashboardMemoryInventoryState[];
  kind_summary: DashboardMemoryInventoryKind[];
}

export interface DashboardSyncPositionChart {
  configured: boolean;
  state: NonNullable<GitSyncStatus["sync_state"]> | "configured" | "not_configured";
  ahead: number;
  behind: number;
  dirty: boolean;
  conflict: boolean;
}

export interface DashboardActivityTrendDay {
  date: string;
  label: string;
  count: number;
  percent: number;
}

export interface DashboardActivityTrendChart {
  days: DashboardActivityTrendDay[];
  total: number;
  peak: number;
}

export interface DashboardCharts {
  agent_activity: DashboardAgentChartItem[];
  activity_trend: DashboardActivityTrendChart;
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
  review_focus: "candidate_triage.review_focus",
  group: "candidate_triage.groups_by_id.<group_id>",
  group_id: "candidate_triage.groups_by_id.<group_id>.id",
  record: "candidate_triage.groups_by_id.<group_id>.records[]",
  record_id: "candidate_triage.groups_by_id.<group_id>.records_by_id.<record_id>.id"
} as const;

const CANDIDATE_TRIAGE_SAMPLE_LIMIT = 3;
const CANDIDATE_TRIAGE_PROMOTION_REASON = "User approved Candidate Triage promotion draft.";

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

export interface DashboardCandidateTriageReviewFocus {
  group_id: DashboardCandidateTriageGroupId;
  label: string;
  summary: string;
  recommended_next_step: string;
  evidence_path: string;
  writes: "none";
  requires_user_confirmation: false;
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
  review_focus?: DashboardCandidateTriageReviewFocus;
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
  provenance_method?: NonNullable<MorynRecord["provenance"]>["method"];
  provenance_reason?: string;
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
  rule_ids: DashboardCaptureNoiseRule["id"][];
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
  memory_inventory: DashboardMemoryInventory;
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
  stored_content_preview: DashboardValueRecord[];
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

export interface DashboardRenderOptions {
  refreshIntervalMs?: number;
  showStoredContent?: boolean;
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

function relativeTimeZh(relative: string): string {
  if (relative === "just now") return "刚刚";
  const minutes = relative.match(/^(\d+)m ago$/);
  if (minutes) return `${minutes[1]} 分钟前`;
  const hours = relative.match(/^(\d+)h ago$/);
  if (hours) return `${hours[1]} 小时前`;
  const days = relative.match(/^(\d+)d ago$/);
  if (days) return `${days[1]} 天前`;
  return relative;
}

function sourceRelativePair(source: string, relative: string): { en: string; zh: string } {
  return {
    en: `${source} | ${relative}`,
    zh: `${source} | ${relativeTimeZh(relative)}`
  };
}

function relativeTimeElement(iso: string, nowIso: string): string {
  const relative = relativeTime(iso, nowIso);
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}" ${i18nAttribute(relative, relativeTimeZh(relative))}>${escapeHtml(relative)}</time>`;
}

function utcDayKey(iso: string): string | undefined {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString().slice(0, 10);
}

function utcDayOffsetKey(base: Date, offsetDays: number): string {
  const next = new Date(base);
  next.setUTCDate(base.getUTCDate() + offsetDays);
  return next.toISOString().slice(0, 10);
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
    explanation: "Everything is synced and no action is waiting.",
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
      title: "Session notes not remembered",
      description: `${raw} session note(s) are searchable for context but not treated as long-term memory.`
    });
  }
  if (candidates > Math.max(8, canonical * 2)) {
    items.push({
      severity: "info",
      title: "Many items to organize",
      description: `${candidates} item(s) are saved and searchable. Organize later if they should become long-term memory.`
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

function buildActivityTrendChart(records: MorynRecord[], generatedAt: string): DashboardActivityTrendChart {
  const end = new Date(generatedAt);
  if (Number.isNaN(end.getTime())) {
    return {
      days: [],
      total: 0,
      peak: 0
    };
  }
  end.setUTCHours(0, 0, 0, 0);

  const counts = new Map<string, number>();
  for (const record of records) {
    const day = utcDayKey(record.updated_at);
    if (!day) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }

  const days = Array.from({ length: 7 }, (_, index) => {
    const date = utcDayOffsetKey(end, index - 6);
    return {
      date,
      label: date.slice(8, 10),
      count: counts.get(date) ?? 0,
      percent: 0
    };
  });
  const peak = Math.max(0, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);

  return {
    days: days.map((day) => ({
      ...day,
      percent: peak > 0 ? Math.round((day.count / peak) * 100) : 0
    })),
    total,
    peak
  };
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

function memoryKindLabel(kind: RecordKind): { en: string; zh: string } {
  if (kind === "memory") return { en: "Memories", zh: "记忆" };
  if (kind === "skill") return { en: "Skills", zh: "技能" };
  if (kind === "soul") return { en: "Preferences", zh: "偏好" };
  if (kind === "session_summary") return { en: "Session notes", zh: "会话记录" };
  return { en: "Agent notes", zh: "代理记录" };
}

function buildMemoryInventory(records: MorynRecord[]): DashboardMemoryInventory {
  const counts = stateCounts(records);
  const remembered = counts.get("canonical") ?? 0;
  const newItems = counts.get("candidate") ?? 0;
  const temporary = counts.get("raw") ?? 0;
  const setAside = (counts.get("archived") ?? 0) + (counts.get("quarantined") ?? 0);
  const kinds: RecordKind[] = ["memory", "skill", "soul", "session_summary", "agent_note"];
  const kindCountsByName = kindCounts(records);
  return {
    summary: {
      remembered,
      new_items: newItems,
      temporary,
      set_aside: setAside,
      total_visible: records.length
    },
    review_suggested: newItems > 0 || temporary > 0 || setAside > 0,
    states: [
      {
        id: "remembered",
        label: "Ready to use",
        zh_label: "可直接使用",
        count: remembered,
        source_states: ["canonical"]
      },
      {
        id: "new_items",
        label: "Saved, not organized",
        zh_label: "已保存待整理",
        count: newItems,
        source_states: ["candidate"]
      },
      {
        id: "temporary",
        label: "Session notes",
        zh_label: "会话记录",
        count: temporary,
        source_states: ["raw"]
      },
      {
        id: "set_aside",
        label: "Kept for history",
        zh_label: "历史留存",
        count: setAside,
        source_states: ["archived", "quarantined"]
      }
    ],
    kind_summary: kinds
      .map((kind) => {
        const label = memoryKindLabel(kind);
        return {
          kind,
          label: label.en,
          zh_label: label.zh,
          count: kindCountsByName.get(kind) ?? 0
        };
      })
      .filter((item) => item.count > 0)
  };
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
    provenance_method: record.provenance?.method,
    provenance_reason: record.provenance?.reason,
    citation: recordCitation(record, eventsByRecord)
  };
}

function valueRecordsNewestFirst(records: MorynRecord[]): MorynRecord[] {
  return [...records]
    .sort((left, right) => {
      const timeDiff = right.updated_at.localeCompare(left.updated_at);
      const scoreDiff = recordValueScore(right) - recordValueScore(left);
      return timeDiff || scoreDiff || left.id.localeCompare(right.id);
    });
}

function buildRecentValue(records: MorynRecord[], generatedAt: string, limit: number, eventsByRecord: Map<string, MorynEvent>): DashboardValueRecord[] {
  return valueRecordsNewestFirst(records)
    .slice(0, limit)
    .map((record) => summarizeValueRecord(record, generatedAt, eventsByRecord));
}

function buildStoredContentPreview(records: MorynRecord[], generatedAt: string, limit: number, eventsByRecord: Map<string, MorynEvent>): DashboardValueRecord[] {
  const sorted = valueRecordsNewestFirst(records);
  const selected = new Map<string, MorynRecord>();
  const stateOrder: MorynRecord["state"][] = ["candidate", "canonical", "raw", "archived", "quarantined"];
  for (const state of stateOrder) {
    if (selected.size >= limit) break;
    const record = sorted.find((candidate) => candidate.state === state);
    if (record) selected.set(record.id, record);
  }
  for (const record of sorted) {
    if (selected.size >= limit) break;
    selected.set(record.id, record);
  }
  return [...selected.values()].map((record) => summarizeValueRecord(record, generatedAt, eventsByRecord));
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
      detail: "Sync pending is shown in the Sync lane and Shared copy details.",
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
      summary: confirmCount === 0 ? "No approvals waiting" : pluralize(confirmCount, "approval waiting"),
      hint: confirmCount === 0 ? "No confirmation needed" : "Open decision summary",
      detail: "Explicit approvals stay in Capture Inbox, Review Queue, and Candidate Triage.",
      next_action_label: confirmCount === 0 ? "Check attention" : "Approval needed",
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
  memoryInventory: DashboardMemoryInventory;
  captureInbox: DashboardCaptureInbox;
}): DashboardOverview {
  const actionPrimary = focusBriefPrimaryItem(input.actionBoard);
  const primary = actionPrimary.next_action_label === "All clear" && input.memoryInventory.review_suggested
    ? memoryInventoryReviewItem(input.memoryInventory, input.captureInbox)
    : actionPrimary;
  const isAllClearPrimary = primary.next_action_label === "All clear";
  const actionCardPrimary = isAllClearPrimary
    ? {
      ...primary,
      next_action_label: input.actionBoard.items_by_id.inspect.value > 0 ? "Inspect checks" : "Check attention",
      target: input.actionBoard.items_by_id.inspect.value > 0 ? "governance-hub" : "needs-attention"
    }
    : primary;
  const primaryTargetLabel = primary.id === "confirm" && primary.value > 0
    ? "Review approvals"
    : actionCardPrimary.next_action_label;
  const headline = primary.next_action_label;
  const primaryActionLabel = primary.id === "confirm" && primary.value > 0
    ? "Review approvals"
    : primary.source === "memory_inventory" ? primary.hint : actionCardPrimary.next_action_label;
  const zhDetail = primary.source === "memory_inventory" ? memoryInventoryReviewDetailZh(input.memoryInventory) : undefined;
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
      target_label: primaryTargetLabel,
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
    headline,
    detail: primary.detail,
    ...(zhDetail ? { zh_detail: zhDetail } : {}),
    primary_action: {
      label: primaryActionLabel,
      target: actionCardPrimary.target,
      source: primary.source ?? `action_board.items_by_id.${primary.id}`
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

function candidateTriageReviewFocus(groups: DashboardCandidateTriageGroup[]): DashboardCandidateTriageReviewFocus | undefined {
  const focusOrder: DashboardCandidateTriageGroupId[] = ["promotable", "likely_noise", "needs_inspection", "session_summaries"];
  const group = focusOrder
    .map((id) => groups.find((candidateGroup) => candidateGroup.id === id))
    .find((candidateGroup): candidateGroup is DashboardCandidateTriageGroup => candidateGroup !== undefined);
  if (!group) return undefined;
  return {
    group_id: group.id,
    label: group.label,
    summary: `Start with ${group.label}: ${group.recommended_next_step}`,
    recommended_next_step: group.recommended_next_step,
    evidence_path: group.evidence_path,
    writes: "none",
    requires_user_confirmation: false
  };
}

function candidateTriageVisibleFocus(summary?: string): string {
  if (!summary) return "";
  const match = /^Start with ([^:]+): (.+)$/.exec(summary);
  if (!match) return `Audit focus: ${summary}`;
  return `Audit focus: ${match[1]} - ${match[2]}`;
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
    review_focus: candidateTriageReviewFocus(groups),
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
  const memoryInventory = buildMemoryInventory(records);
  const dashboardOverviewData = buildDashboardOverview({
    actionBoard: actionBoardData,
    health,
    contextPackReview: contextPackReviewData,
    memoryInventory,
    captureInbox: captureInboxData
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
      activity_trend: buildActivityTrendChart(records, generatedAt),
      memory_states: buildMemoryStateChart(records),
      record_types: buildRecordTypeChart(records),
      sync_position: buildSyncPositionChart(sync)
    },
    memory_inventory: memoryInventory,
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
    stored_content_preview: buildStoredContentPreview(records, generatedAt, 4, eventsByRecord),
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

function i18nText(en: string, zh: string, tag = "span"): string {
  return `<${tag} data-i18n-en="${escapeHtml(en)}" data-i18n-zh="${escapeHtml(zh)}">${escapeHtml(en)}</${tag}>`;
}

function i18nAttribute(en: string, zh: string): string {
  return `data-i18n-en="${escapeHtml(en)}" data-i18n-zh="${escapeHtml(zh)}"`;
}

function dashboardHealthZh(status: DashboardHealthStatus, label: string): string {
  if (status === "healthy" || label === "Healthy") return "正常";
  if (status === "sync_pending" || label === "Sync Pending") return "等待同步";
  if (status === "needs_review" || label === "Needs Review") return "需要查看";
  if (status === "conflict" || label === "Conflict") return "需要处理冲突";
  if (status === "local_only" || label === "Local Only") return "仅本机";
  return label;
}

function dashboardActionLabelZh(label: string): string {
  if (label === "Health") return "健康";
  if (label === "Next") return "下一步";
  if (label === "Context") return "上下文";
  if (label === "Sync") return "共享副本";
  if (label === "Healthy") return "正常";
  if (label === "Sync Pending") return "等待同步";
  if (label === "Needs Review") return "需要查看";
  if (label === "Conflict") return "需要处理冲突";
  if (label === "Local Only") return "仅本机";
  if (label === "Local only") return "仅本机";
  if (label === "Ready") return "已就绪";
  if (label === "Available") return "可用";
  if (label === "Unavailable") return "不可用";
  if (label === "Configured") return "已配置";
  if (label === "Not configured") return "未配置";
  if (label === "Local changes") return "本机有新变化";
  if (label === "Approval needed") return "需要确认";
  if (label === "Review approvals") return "查看确认项";
  if (label === "Review warnings") return "查看提醒";
  if (label === "Review health") return "查看健康状态";
  if (label === "Open info checks") return "查看后台检查";
  if (label === "Open context") return "查看上下文";
  if (label === "Open governance") return "查看安全检查";
  if (label === "Check attention") return "查看需要注意的内容";
  if (label === "Inspect checks") return "查看检查";
  if (label === "Inspect sync") return "检查共享副本";
  if (label === "Browse saved notes") return "浏览已保存内容";
  if (label === "Search saved content") return "搜索已保存内容";
  if (label === "Saved for later") return "已保存，可稍后整理";
  if (label === "Saved, not remembered") return "已保存，未记住";
  if (label === "To organize") return "待整理";
  if (label === "No action needed") return "无需操作";
  if (label === "All clear") return "暂时不用管";
  if (label === "View checks") return "查看检查";
  if (label === "View details") return "查看详情";
  return label;
}

function dashboardDisplayZh(label: string): string {
  const safeCheckAvailable = label.match(/^(\d+) safe check(s)? available$/);
  if (safeCheckAvailable) return `${safeCheckAvailable[1]} 项安全检查可查看`;
  return dashboardActionLabelZh(label);
}

function dashboardActionDetailZh(detail: string): string {
  const savedItems = detail.match(/^(\d+) saved item(s)?$/);
  if (savedItems) return `${savedItems[1]} 条已保存内容`;
  const attentionItems = detail.match(/^(\d+) attention item(s)?$/);
  if (attentionItems) return `${attentionItems[1]} 条提醒`;
  const safeChecks = detail.match(/^(\d+) safe check(s)?$/);
  if (safeChecks) return `${safeChecks[1]} 项安全检查`;
  if (detail === "Clean") return "已同步";
  if (detail === "No action needed") return "无需操作";
  if (detail === "No urgent review") return "没有紧急提醒";
  if (detail === "No safe checks") return "没有安全检查";
  if (detail === "Explicit approvals stay in Capture Inbox, Review Queue, and Candidate Triage.") {
    return "需要明确确认的操作会保留在 Capture Inbox、Review Queue 和 Candidate Triage 中。";
  }
  if (detail === "Sync is not configured; this snapshot is useful locally, but other devices will not see these records yet.") {
    return "同步还没有连接；这份快照在本机可用，但其他设备还看不到这些记录。";
  }
  if (detail === "Local sync changes are waiting to be pushed or pulled; memory data remains usable on this device.") {
    return "本机同步变化还在等待上传或拉取；这台设备上的记忆仍可使用。";
  }
  if (detail === "Everything is synced and no action is waiting.") {
    return "已同步，没有等待处理的事项。";
  }
  if (detail === "Warnings and critical signals remain visible in Needs Attention.") {
    return "提醒和重要信号会继续显示在需要注意的区域。";
  }
  if (detail === "Sync pending is shown in the Sync lane and Shared copy details.") {
    return "同步事项会显示在共享副本和共享副本详情中。";
  }
  if (detail === "Handoff evidence stays read-only") {
    return "交接依据保持只读。";
  }
  if (detail === "Project context is required for Context Pack Review.") {
    return "需要项目上下文才能查看交接上下文。";
  }
  if (detail === "No confirmations, warnings, or sync actions need attention. Read-only inspections remain available below.") {
    return "没有需要确认、提醒或同步的事项；只读检查仍保留在下方。";
  }
  return detail;
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

function sharedCopyLabel(sync: GitSyncStatus): { label: string; zh: string; detail: string; zhDetail: string; severity: DashboardOverviewStatus } {
  const ahead = sync.ahead ?? 0;
  const behind = sync.behind ?? 0;
  if (!sync.configured) {
    return {
      label: "Not connected",
      zh: "未连接",
      detail: "This device only",
      zhDetail: "仅本机可见",
      severity: "info"
    };
  }
  if (sync.sync_state === "conflict") {
    return {
      label: "Needs help",
      zh: "需要处理",
      detail: "Both sides changed",
      zhDetail: "两边都有变化",
      severity: "critical"
    };
  }
  if (sync.sync_state === "dirty") {
    return {
      label: "Waiting to upload",
      zh: "等待上传",
      detail: `${behind} behind · ${ahead} ahead`,
      zhDetail: `落后 ${behind} · 待上传 ${ahead}`,
      severity: "warning"
    };
  }
  if (behind > 0) {
    return {
      label: "New shared updates",
      zh: "共享副本有更新",
      detail: `${behind} behind · ${ahead} ahead`,
      zhDetail: `落后 ${behind} · 待上传 ${ahead}`,
      severity: "warning"
    };
  }
  if (ahead > 0) {
    return {
      label: "Waiting to upload",
      zh: "等待上传",
      detail: `${behind} behind · ${ahead} ahead`,
      zhDetail: `落后 ${behind} · 待上传 ${ahead}`,
      severity: "info"
    };
  }
  return {
    label: "Up to date",
    zh: "已同步",
    detail: "0 behind · 0 ahead",
    zhDetail: "落后 0 · 待上传 0",
    severity: "good"
  };
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

function actionBoardBackgroundShortcuts(items: DashboardActionBoardItem[]): string {
  if (items.length === 0) return "";
  return `
    <details class="action-board-background" aria-label="Background Shortcuts" data-dashboard-detail="action-board" data-dashboard-background-shortcuts>
      <summary class="dashboard-fold-summary action-board-background-fold">
        <span>Background Shortcuts</span>
        <small>Optional section links</small>
      </summary>
      <div class="action-board-background-list" data-dashboard-detail="action-board-quiet-targets">
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
  if (activeItems.length === 0) return actionBoardBackgroundShortcuts(quietItems);
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
    </details>
  `;
}

type DashboardPrimaryFocusItem = DashboardActionBoardItem & { source?: string };

function memoryInventoryReviewDetail(inventory: DashboardMemoryInventory): string {
  const parts = [
    inventory.summary.new_items > 0 ? pluralize(inventory.summary.new_items, "saved item") : "",
    inventory.summary.temporary > 0 ? pluralize(inventory.summary.temporary, "session note") : "",
    inventory.summary.set_aside > 0 ? pluralize(inventory.summary.set_aside, "set-aside item") : ""
  ].filter(Boolean);
  const subject = joinHumanList(parts);
  return `${subject} ${parts.length === 1 ? "is" : "are"} searchable now. Organize later if useful; this summary does not write to memory.`;
}

function zhCount(count: number, label: string): string {
  return `${count} 条${label}`;
}

function joinZhList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]}和 ${items[1]}`;
  return `${items.slice(0, -1).join("、")}和 ${items.at(-1)}`;
}

function memoryInventoryReviewDetailZh(inventory: DashboardMemoryInventory): string {
  const parts = [
    inventory.summary.new_items > 0 ? zhCount(inventory.summary.new_items, "保存内容") : "",
    inventory.summary.temporary > 0 ? zhCount(inventory.summary.temporary, "会话笔记") : "",
    inventory.summary.set_aside > 0 ? zhCount(inventory.summary.set_aside, "历史留存内容") : ""
  ].filter(Boolean);
  const subject = joinZhList(parts);
  return `${subject}现在可搜索；需要时再整理，这个摘要不会写入记忆。`;
}

function memoryInventoryReviewItem(
  inventory: DashboardMemoryInventory,
  captureInbox: DashboardCaptureInbox
): DashboardPrimaryFocusItem {
  const reviewCount = inventory.summary.new_items + inventory.summary.temporary + inventory.summary.set_aside;
  const target = captureInbox.total > 0
    ? "capture-inbox"
    : "stored-content";
  return {
    id: "review",
    label: "Review",
    value: reviewCount,
    severity: "good",
    summary: pluralize(reviewCount, "saved item"),
    hint: "Search saved content",
    detail: memoryInventoryReviewDetail(inventory),
    next_action_label: "No action needed",
    target,
    source: "memory_inventory"
  };
}

function focusBriefPrimaryItem(actionBoardData: DashboardActionBoard): DashboardPrimaryFocusItem {
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
            <span ${i18nAttribute(card.label, dashboardActionLabelZh(card.label))}>${escapeHtml(card.label)}</span>
            <strong ${i18nAttribute(card.value, dashboardDisplayZh(card.value))}>${escapeHtml(card.value)}</strong>
            <p ${i18nAttribute(card.summary, dashboardActionDetailZh(card.summary))}>${escapeHtml(card.summary)}</p>
            <small ${i18nAttribute(card.target_label, dashboardActionLabelZh(card.target_label))}>${escapeHtml(card.target_label)}</small>
          </button>
        `;
}

function dashboardOverviewQuietCards(cards: DashboardOverviewCard[]): string {
  if (cards.length === 0) return "";
  return `
      <details class="dashboard-overview-quiet" data-dashboard-detail="dashboard-overview-quiet-cards">
        <summary class="dashboard-fold-summary dashboard-overview-quiet-fold" aria-label="Other status: supporting signals are ready">
          ${i18nText("Other status", "其他状态")}
          ${i18nText("Ready if needed", "需要时可查看", "small")}
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
  options: { showBackgroundStatus?: boolean; showSafety?: boolean } = {}
): string {
  const visibleCards = data.cards.filter((card) => !isPrimaryDashboardOverviewCard(card, data));
  const showBackgroundStatus = options.showBackgroundStatus ?? true;
  const showSafety = options.showSafety ?? true;
  const isAllClear = data.headline === "All clear";
  const visibleDetail = isAllClear ? "No work needs attention." : data.detail;
  const actionClass = isAllClear
    ? "dashboard-overview-action dashboard-overview-action-quiet"
    : "dashboard-overview-action";
  const actionLabel = isAllClear
    ? data.primary_action.label === "Inspect checks" ? "View checks" : "View details"
    : data.primary_action.label;
  const headlineZh = dashboardActionLabelZh(data.headline);
  const detailZh = data.zh_detail
    ?? (data.headline === "Saved, not remembered" || data.headline === "Saved for later"
      ? data.detail
      .replace("1 saved item and 1 session note are searchable now. They become long-term memory only if you organize them later.", "1 条保存内容和 1 条会话笔记现在可搜索；只有稍后整理后才会进入长期记忆。")
      .replace("1 saved item is searchable now. It becomes long-term memory only if you organize it later.", "1 条保存内容现在可搜索；只有稍后整理后才会进入长期记忆。")
      .replace("1 session note is searchable now. It becomes long-term memory only if you organize it later.", "1 条会话笔记现在可搜索；只有稍后整理后才会进入长期记忆。")
      : dashboardActionDetailZh(visibleDetail));
  const actionLabelZh = dashboardActionLabelZh(actionLabel);
  return `
    <section class="dashboard-overview ${escapeHtml(data.status)}" data-dashboard-overview aria-label="Dashboard Overview">
      <div class="dashboard-overview-main">
        <div>
          <h2>${i18nText("Do I need to act?", "我需要操作吗？")}</h2>
          ${i18nText(data.headline, headlineZh, "strong")}
          <p ${i18nAttribute(visibleDetail, detailZh)}>${escapeHtml(visibleDetail)}</p>
        </div>
        <button type="button" class="${escapeHtml(actionClass)}" data-action-board-target="${escapeHtml(data.primary_action.target)}" aria-controls="${escapeHtml(data.primary_action.target)}" ${i18nAttribute(actionLabel, actionLabelZh)}>${escapeHtml(actionLabel)}</button>
      </div>
      ${showBackgroundStatus ? dashboardOverviewQuietCards(visibleCards) : ""}
      ${showSafety ? `<div class="dashboard-overview-safety" aria-label="Dashboard safety">
        ${i18nText("Read-only summary", "只读摘要")}
        ${i18nText(`Approvals stay in ${joinHumanList(data.safety.mutation_surfaces)}`, `确认操作仍在 ${joinHumanList(data.safety.mutation_surfaces)} 中完成`)}
      </div>` : ""}
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
          <summary class="dashboard-fold-summary dashboard-work-lanes-quiet-fold" aria-label="Other paths: ${escapeHtml(backgroundLaneSummary)}">
            ${i18nText("Other paths", "其他入口")}
            ${i18nText("Ready if needed", "需要时可查看", "small")}
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
              <small>Append-only, guarded in owning surface</small>
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

function shouldRenderHealthCheckActionCommand(action: HealthCheckReport["suggested_actions"][number]): boolean {
  return !action.safe_to_run || action.required_fields.length > 0;
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
          ${shouldRenderHealthCheckActionCommand(action) ? `
          <details class="health-check-action-command" data-dashboard-detail="health-check-action-command:${escapeHtml(action.action_id)}">
            <summary class="dashboard-fold-summary">
              <span>CLI command</span>
              <small>copy from CLI</small>
            </summary>
            <code>${escapeHtml(action.command)}</code>
          </details>
          ` : ""}
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

function dogfoodReviewSummary(report: DogfoodReportResult): string {
  return report.findings.length === 1 ? "Read-only note" : "Read-only notes";
}

function dogfoodReviewReference(report: DogfoodReportResult): string {
  return `
        <article class="dogfood-review-reference" data-dashboard-detail="dogfood-review:index" data-dogfood-review-reference>
          <strong>Dogfood Notes Index</strong>
          <span>${escapeHtml(`${pluralize(report.findings.length, "finding")} indexed`)}</span>
          <code>dogfood_report</code>
        </article>
        <p>Open <code>/api/dashboard</code> for dogfood findings, impact notes, evidence paths, affected records, and safe inspection commands.</p>
  `;
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
        ${dogfoodReviewReference(report)}
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
  const title = item.title;
  const severity = titleCase(item.severity);
  const description = item.description;
  return `
    <details class="attention ${escapeHtml(item.severity)}" data-dashboard-detail="attention:${escapeHtml(item.title)}">
      <summary class="attention-summary">
        <strong ${i18nAttribute(title, attentionTitleZh(title))}>${escapeHtml(title)}</strong>
        <span ${i18nAttribute(severity, attentionSeverityZh(item.severity))}>${escapeHtml(severity)}</span>
      </summary>
      <div class="attention-body">
        <p ${i18nAttribute(description, attentionDescriptionZh(description))}>${escapeHtml(description)}</p>
        ${item.action_command ? `<code>${escapeHtml(item.action_command)}</code>` : ""}
      </div>
    </details>
  `;
}

function attentionSeverityZh(severity: DashboardAttentionSeverity): string {
  if (severity === "critical") return "严重";
  if (severity === "warning") return "提醒";
  return "信息";
}

function attentionTitleZh(title: string): string {
  if (title === "Sync is not configured") return "共享副本未连接";
  if (title === "Sync conflict") return "共享副本有冲突";
  if (title === "Sync changes not pushed") return "本机改动还没上传";
  if (title === "Remote position changed") return "共享副本位置已变化";
  if (title === "Quarantined records hidden") return "部分内容已暂不使用";
  if (title === "Quarantined records superseded") return "隔离内容已有安全替代";
  if (title === "Temporary notes waiting") return "临时笔记待整理";
  if (title === "Many recently saved items") return "较多最近保存内容";
  if (title === "Session notes not remembered") return "会话笔记未记住";
  if (title === "Many items to organize") return "较多内容待整理";
  return title;
}

function attentionDescriptionZh(description: string): string {
  if (description === "This store is local-only until a private Git remote is configured.") {
    return "还没有连接私有共享副本；当前记忆只在这台设备可见。";
  }
  if (description === "Git sync reports a conflict. Resolve it before relying on cross-device handoff.") {
    return "共享副本有冲突；跨设备交接前需要先处理。";
  }
  if (description === "Local event history has changes that are not committed or pushed yet.") {
    return "本机事件历史还有未上传的变化。";
  }
  const remoteMatch = description.match(/^This store is (\d+) commit\(s\) ahead and (\d+) commit\(s\) behind the configured remote\.$/);
  if (remoteMatch) return `这份记忆比共享副本超前 ${remoteMatch[1]} 次提交、落后 ${remoteMatch[2]} 次提交。`;
  const hiddenMatch = description.match(/^(\d+) record\(s\) are hidden because they may contain sensitive or unsafe content\.$/);
  if (hiddenMatch) return `${hiddenMatch[1]} 条内容可能包含敏感或不安全信息，已暂不使用。`;
  const supersededMatch = description.match(/^(\d+) quarantined record\(s\) have active safe replacement index records\.$/);
  if (supersededMatch) return `${supersededMatch[1]} 条隔离内容已有安全替代版本。`;
  const rawMatch = description.match(/^(\d+) temporary note\(s\) are preserved but excluded from normal recall\.$/);
  if (rawMatch) return `${rawMatch[1]} 条临时内容已保留，但不会被当作长期记忆使用。`;
  const sessionNoteMatch = description.match(/^(\d+) session note\(s\) are searchable for context but not treated as long-term memory\.$/);
  if (sessionNoteMatch) return `${sessionNoteMatch[1]} 条会话笔记可作为上下文搜索，但不会被当作长期记忆。`;
  const candidateMatch = description.match(/^(\d+) recently saved item\(s\) may need long-term memory, archive, or cleanup\.$/);
  if (candidateMatch) return `${candidateMatch[1]} 条最近保存内容可以稍后整理：记住、继续保留，或放一边。`;
  const toOrganizeMatch = description.match(/^(\d+) item\(s\) are saved and searchable\. Organize later if they should become long-term memory\.$/);
  if (toOrganizeMatch) return `${toOrganizeMatch[1]} 条内容已保存并可搜索；如果应该成为长期记忆，可以稍后整理。`;
  const savedNotRememberedMatch = description.match(/^(\d+) saved item\(s\) are searchable but not long-term memory yet\.$/);
  if (savedNotRememberedMatch) return `${savedNotRememberedMatch[1]} 条内容已保存并可搜索，但还不是长期记忆。`;
  return description;
}

function routineCheckCountZh(count: number): string {
  return `${count} 项日常检查`;
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
            ${i18nText("Background checks", "后台检查")}
            ${i18nText("Routine checks", "日常检查", "small")}
          </summary>
          ${options.quiet ? `
            <details class="attention-info-details" data-dashboard-detail="attention-info-details">
              <summary class="dashboard-fold-summary">
                ${i18nText("Check details", "检查详情")}
                <small ${i18nAttribute(pluralize(items.length, "routine check"), routineCheckCountZh(items.length))}>${escapeHtml(pluralize(items.length, "routine check"))}</small>
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

function governanceReferenceAudit(items: DashboardGovernanceItem[]): string {
  if (items.length === 0) return "";
  return `
    <details class="governance-reference-audit" data-dashboard-detail="governance-reference-audit">
      <summary class="dashboard-fold-summary">
        <span>Reference audit</span>
        <small>Detection, boundary, and evidence</small>
      </summary>
      <div class="governance-reference-audit-list">
        ${items.map((item) => `
          <article class="governance-reference-audit-item" data-dashboard-detail="governance-audit:${escapeHtml(item.id)}">
            <h4>${escapeHtml(governanceSafeRowTitle(item))}</h4>
            <ol>
              ${item.review_log.map((note) => `<li>${governanceSafeReviewNote(note)}</li>`).join("")}
            </ol>
          </article>
        `).join("")}
      </div>
    </details>
  `;
}

function governanceSafeRow(item: DashboardGovernanceItem): string {
  return `
    <div class="governance-safe-row ${escapeHtml(item.severity)}" data-dashboard-detail="governance:${escapeHtml(item.id)}" data-governance-safe-item="${escapeHtml(item.id)}">
      <span>${escapeHtml(governanceSourceDisplayLabel(item.source))}</span>
      <strong>${escapeHtml(governanceSafeRowTitle(item))}</strong>
      <small>${escapeHtml(`${governanceActionDisplayLabel(item.action_label)} | Read-only`)}</small>
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

function governanceHubSummaryZh(governance: DashboardGovernance, summary: string): string {
  if (isSafeOnlyGovernance(governance)) return "参考检查";
  return summary;
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

function governanceReferenceIndex(safeInspections: DashboardGovernanceItem[]): string {
  const title = "Governance Index";
  const titleZh = "治理索引";
  const summary = `${pluralize(safeInspections.length, "read-only check")} indexed`;
  const summaryZh = `${safeInspections.length} 项只读检查已建立索引`;
  return `
        <article class="governance-reference" data-dashboard-detail="governance:index" data-governance-reference>
          <strong ${i18nAttribute(title, titleZh)}>${escapeHtml(title)}</strong>
          <span ${i18nAttribute(summary, summaryZh)}>${escapeHtml(summary)}</span>
          <code>governance</code>
        </article>
        <p>Open <code>/api/dashboard</code> for governance items, evidence paths, review logs, and safe inspection commands.</p>
  `;
}

function governanceHubBody(governance: DashboardGovernance): string {
  const safeInspections = governance.items.filter(isSafeGovernanceInspection);
  const primaryItems = governance.items.filter((item) => !isSafeGovernanceInspection(item));
  const safeOnly = isSafeOnlyGovernance(governance);
  const title = safeOnly ? "Read-only Governance" : "Governance Hub";
  const titleZh = safeOnly ? "只读治理" : "治理中心";
  const subtitle = safeOnly ? "API-backed governance index" : "Read-only inspection index";
  const subtitleZh = safeOnly ? "API 支持的治理索引" : "只读检查索引";
  const safeGroupTitle = safeOnly ? "Reference Checks" : "Safe Inspections";
  const safeGroupTitleZh = safeOnly ? "参考检查" : "安全检查";
  const safeGroupSummary = safeOnly ? "Read-only, no writes" : "Background checks, read-only";
  const safeGroupSummaryZh = safeOnly ? "只读，不写入" : "后台检查，只读";
  return `
    <div class="governance-hub-body">
      <div class="governance-heading">
        <div>
          <h2 ${i18nAttribute(title, titleZh)}>${escapeHtml(title)}</h2>
          <p ${i18nAttribute(subtitle, subtitleZh)}>${escapeHtml(subtitle)}</p>
        </div>
        <div class="governance-counts">
          ${safeOnly ? "" : governanceCountChips(governance)}
        </div>
      </div>
      <div class="governance-list">
        ${primaryItems.map(governanceItem).join("")}
        ${safeOnly ? governanceReferenceIndex(safeInspections) : ""}
        ${safeInspections.length === 0 ? "" : `
          ${safeOnly ? "" : `<details class="governance-safe-group" data-dashboard-detail="governance-safe-inspections">
            <summary class="dashboard-fold-summary">
              <span ${i18nAttribute(safeGroupTitle, safeGroupTitleZh)}>${escapeHtml(safeGroupTitle)}</span>
              <small ${i18nAttribute(safeGroupSummary, safeGroupSummaryZh)}>${escapeHtml(safeGroupSummary)}</small>
            </summary>
            <div class="governance-safe-list" data-governance-safe-list>
              ${safeInspections.map(governanceSafeRow).join("")}
            </div>
            ${governanceReferenceAudit(safeInspections)}
          </details>`}
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
    const title = safeOnly ? "Read-only Governance" : "Governance Hub";
    const titleZh = safeOnly ? "只读治理" : "治理中心";
    const summary = governanceHubSummaryText(governance);
    return `
      <details id="governance-hub" class="panel governance-hub" data-dashboard-detail="governance-hub" aria-label="Governance Hub">
        <summary class="dashboard-fold-summary governance-hub-fold">
          <span ${i18nAttribute(title, titleZh)}>${escapeHtml(title)}</span>
          <small ${i18nAttribute(summary, governanceHubSummaryZh(governance, summary))}>${escapeHtml(summary)}</small>
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
            <div class="candidate-triage-approval-brief" data-candidate-triage-approval-brief>
              <h4>Approval brief</h4>
              <dl class="candidate-triage-brief-list" aria-label="Approval brief">
                <div><dt>Change</dt><dd>Promote 1 candidate</dd></div>
                <div><dt>Scope</dt><dd>${escapeHtml(`${recordLabel(draft.record_id)} to ${draft.target_state}`)}</dd></div>
                <div><dt>Guard</dt><dd>Server rechecks active candidate before writing</dd></div>
                <div><dt>Writes</dt><dd>Approve Memory appends an append-only promotion event</dd></div>
              </dl>
            </div>
            <details class="candidate-triage-promotion-evidence" data-dashboard-detail="candidate-triage-promotion-evidence:${escapeHtml(draft.record_id)}">
              <summary class="dashboard-fold-summary">
                <span>Draft evidence</span>
                <small>Command and source</small>
              </summary>
              <dl>
                <div><dt>Record</dt><dd><code>${escapeHtml(draft.record_id)}</code></dd></div>
                <div><dt>Reason</dt><dd>${escapeHtml(draft.reason)}</dd></div>
                <div><dt>Command</dt><dd><code>${escapeHtml(draft.command)}</code></dd></div>
                <div><dt>Evidence</dt><dd><code>${escapeHtml(draft.source_path)}</code></dd></div>
              </dl>
            </details>
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

function renderCandidateBacklogReference(triage: DashboardCandidateTriage): string {
  const summary = `${pluralize(triage.summary.total_candidates, "candidate")} across ${pluralize(triage.summary.groups, "group")} indexed`;
  const visibleFocus = candidateTriageVisibleFocus(triage.review_focus?.summary);
  const focus = visibleFocus
    ? `<span data-candidate-triage-focus>${escapeHtml(visibleFocus)}</span>`
    : "";
  return `
    <article class="candidate-triage-reference" data-dashboard-detail="candidate-triage:index" data-candidate-triage-reference>
      ${i18nText("Candidate Backlog Index", "待整理内容索引", "strong")}
      <span>${escapeHtml(summary)}</span>
      ${focus}
      <code>candidate_triage</code>
    </article>
    <p>Open <code>/api/dashboard</code> for candidate groups, record order, evidence paths, and trace commands.</p>
  `;
}

function renderCandidateTriageGroupList(triage: DashboardCandidateTriage): string {
  return `
    <div class="candidate-triage-list">
      ${triage.groups.map((group) => triage.groups_by_id[group.id]).filter((group): group is DashboardCandidateTriageGroup => group !== undefined).map(renderCandidateTriageGroup).join("")}
    </div>
  `;
}

function candidateTriagePanel(triage: DashboardCandidateTriage): string {
  if (!triage.available) return "";
  const hasPromotionDrafts = candidateTriageHasPromotionDrafts(triage);
  const panelLabel = hasPromotionDrafts ? "Candidate Triage" : "Candidate Backlog";
  const ariaLabel = hasPromotionDrafts ? "Candidate Triage Queue" : "Candidate Backlog";
  return `
    <details class="panel candidate-triage" data-dashboard-detail="candidate-triage" aria-label="${escapeHtml(ariaLabel)}">
      <summary class="dashboard-fold-summary candidate-triage-fold">
        <span>${escapeHtml(panelLabel)}</span>
        <small>${escapeHtml(candidateTriageSummary(triage))}</small>
      </summary>
      <div class="candidate-triage-body">
        ${hasPromotionDrafts ? `
          <div class="candidate-triage-heading">
            <div>
              <h2>Candidate Triage Queue</h2>
              <p>Review grouping for memory doctor backlog.</p>
            </div>
            <div class="candidate-triage-counts">
              <span>${escapeHtml(pluralize(triage.summary.total_candidates, "candidate"))}</span>
              <span>${escapeHtml(pluralize(triage.summary.groups, "group"))}</span>
            </div>
          </div>
          ${renderCandidateTriageGroupList(triage)}
        ` : renderCandidateBacklogReference(triage)}
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

function maintenanceReviewWhy(plan: DashboardMaintenancePlan): string {
  return plan.type === "candidate_noise_archive"
    ? "Memory Doctor found smoke/e2e marker candidates."
    : "Memory Doctor found records under an old project id.";
}

function maintenanceReviewChange(plan: DashboardMaintenancePlan): string {
  if (plan.type === "candidate_noise_archive") {
    return `${maintenanceMoveSummary(plan)} after you confirm they are test noise.`;
  }
  return `${maintenanceMoveSummary(plan)} from <code>${escapeHtml(plan.from_project_id ?? "")}</code> to <code>${escapeHtml(plan.to_project_id ?? "")}</code>.`;
}

function maintenanceReviewSafety(plan: DashboardMaintenancePlan): string {
  return `No write happens until ${maintenancePrimaryActionLabel(plan)}; the server re-runs the dry run and checks <code>plan_hash</code> before writing.`;
}

function maintenanceReviewAudit(plan: DashboardMaintenancePlan): string {
  return plan.type === "candidate_noise_archive"
    ? "Raw record ids, equivalent archive commands, and <code>plan_hash</code> stay in Evidence trace."
    : "Raw record ids, rollback path, equivalent CLI command, and <code>plan_hash</code> stay in Evidence trace.";
}

function maintenanceReviewNotes(plan: DashboardMaintenancePlan): string {
  return `
    <div class="maintenance-review-notes" data-maintenance-approval-context>
      <h4>Approval context</h4>
      <dl>
        <div><dt>Why</dt><dd>${escapeHtml(maintenanceReviewWhy(plan))}</dd></div>
        <div><dt>Change</dt><dd>${maintenanceReviewChange(plan)}</dd></div>
        <div><dt>Guard</dt><dd>${maintenanceReviewSafety(plan)}</dd></div>
        <div><dt>Trace</dt><dd>${maintenanceReviewAudit(plan)}</dd></div>
      </dl>
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
                </div>
                ${maintenanceReviewBrief(plan)}
                <details class="maintenance-audit-details" data-dashboard-detail="maintenance-audit:${escapeHtml(plan.plan_id)}">
                  <summary class="dashboard-fold-summary maintenance-audit-details-fold">
                    <span>Decision details</span>
                    <small>Context and evidence</small>
                  </summary>
                  ${maintenanceReviewNotes(plan)}
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

function hasAuditReportData(memoryLifecycle: MemoryLifecycleResult, capturePolicy: CapturePolicyResult): boolean {
  return memoryLifecycle.stats.total_records > 0
    || memoryLifecycle.findings.length > 0
    || memoryLifecycle.suggested_actions.length > 0
    || capturePolicy.stats.total_autocapture_records > 0;
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

function captureInboxNoiseRuleLabel(ruleId: DashboardCaptureNoiseRule["id"]): string {
  return CAPTURE_NOISE_RULES.find((rule) => rule.id === ruleId)?.label ?? ruleId;
}

function captureInboxGroupReviewSignal(group: DashboardCaptureInboxGroup): string {
  if (group.noise.level !== "likely_noise" || group.noise.rule_ids.length === 0) return "";
  const ruleLabels = group.noise.rule_ids.map((ruleId) => `<span>${escapeHtml(captureInboxNoiseRuleLabel(ruleId))}</span>`).join("");
  const reasons = group.noise.reasons.length ? group.noise.reasons.join(" ") : "Noise signals detected before approval.";
  return `
            <div class="capture-inbox-review-signal" data-capture-inbox-review-signal>
              <strong>Review signal</strong>
              <div>${ruleLabels}</div>
              <small>${escapeHtml(reasons)}</small>
            </div>`;
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
        <span>Manual approval</span>
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
            ${captureInboxGroupReviewSignal(group)}
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
                <summary>Trace details</summary>
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
    <details class="store-sync-details" data-dashboard-detail="store-sync-details">
      <summary class="dashboard-fold-summary">
        <span>Sync details</span>
        <small>Position rail</small>
      </summary>
      <section class="signal-card sync-position-focus" data-dashboard-sync-position-focus>
        <h2>Sync Position</h2>
        ${syncRail(data.charts.sync_position)}
      </section>
    </details>
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

function storeSignalsSummary(data: DashboardData): string {
  const syncLane = data.action_board.items_by_id.sync;
  if (syncLane.value > 0 && (syncLane.severity === "warning" || syncLane.severity === "critical")) {
    return "Sync action ready";
  }
  return "Sync details and local status";
}

function storeSignalsSummaryZh(summary: string): string {
  if (summary === "Sync action ready") return "同步操作已就绪";
  if (summary === "Sync details and local status") return "同步详情和本机状态";
  return summary;
}

function storeSignalsPanel(data: DashboardData, options: { open?: boolean; includeTelemetry?: boolean } = {}): string {
  const openAttribute = options.open ? " open" : "";
  const includeTelemetry = options.includeTelemetry ?? true;
  return `
    <details${openAttribute} id="store-signals" class="panel store-signals" data-dashboard-detail="store-signals">
      <summary class="dashboard-fold-summary">
        ${i18nText("Shared copy details", "共享副本详情")}
        <small ${i18nAttribute(storeSignalsSummary(data), storeSignalsSummaryZh(storeSignalsSummary(data)))}>${escapeHtml(storeSignalsSummary(data))}</small>
      </summary>
      ${syncActionBrief(data)}
      ${syncPositionFocus(data)}
      ${includeTelemetry ? storeTelemetryContext(data) : ""}
    </details>
  `;
}

function promotedStoreSignalsPanel(data: DashboardData): string {
  const summary = storeSignalsSummary(data);
  return `
    <section id="store-signals" class="panel store-signals store-signals-promoted" data-dashboard-detail="store-signals" data-dashboard-promoted-store-signals aria-label="Shared copy details">
      <div class="store-signals-promoted-head">
        ${i18nText("Shared copy details", "共享副本详情")}
        <small ${i18nAttribute(summary, storeSignalsSummaryZh(summary))}>${escapeHtml(summary)}</small>
      </div>
      ${syncActionBrief(data)}
      ${syncPositionFocus(data)}
    </section>
  `;
}

function supportingEvidenceSummary(): string {
  return "Optional trace data";
}

type SupportingEvidenceSummaryRow = {
  id: "audit-reports" | "store-snapshot" | "raw-store";
  label: string;
  summary: string;
  route: string;
  paths: Array<{ label: string; route: string }>;
};

function supportingEvidenceSummaryRow(row: SupportingEvidenceSummaryRow): string {
  const labelZh: Record<SupportingEvidenceSummaryRow["label"], string> = {
    "Audit Reports": "审计报告",
    "Store Snapshot": "存储快照",
    "Raw Store": "原始存储"
  };
  const summaryZh: Record<SupportingEvidenceSummaryRow["summary"], string> = {
    "Lifecycle checks indexed": "生命周期检查已建立索引",
    "Store signals indexed": "存储信号已建立索引",
    "Raw evidence indexed": "原始依据已建立索引"
  };
  return `
        <article class="supporting-evidence-summary-row" data-supporting-evidence-summary="${escapeHtml(row.id)}" data-dashboard-detail="${escapeHtml(row.route)}">
          <div>
            <strong ${i18nAttribute(row.label, labelZh[row.label])}>${escapeHtml(row.label)}</strong>
            <span ${i18nAttribute(row.summary, summaryZh[row.summary])}>${escapeHtml(row.summary)}</span>
          </div>
          <small>${row.paths.map((path) => `<code data-dashboard-detail="${escapeHtml(path.route)}">${escapeHtml(path.label)}</code>`).join("")}</small>
        </article>
  `;
}

function supportingEvidencePanel(data: DashboardData, options: { includeStoreSignals?: boolean } = {}): string {
  const includeStoreSignals = options.includeStoreSignals ?? true;
  const hasAuditReports = hasAuditReportData(data.memory_lifecycle, data.capture_policy);
  const summaryRows: SupportingEvidenceSummaryRow[] = [
    ...(hasAuditReports ? [{
      id: "audit-reports" as const,
      label: "Audit Reports",
      summary: "Lifecycle checks indexed",
      route: "supporting-operational-evidence",
      paths: [
        { label: "memory_lifecycle", route: "memory-lifecycle-audit" },
        { label: "capture_policy", route: "capture-policy-audit" }
      ]
    }] : []),
    ...(includeStoreSignals || data.recent_value.length > 0 ? [{
      id: "store-snapshot" as const,
      label: "Store Snapshot",
      summary: "Store signals indexed",
      route: "supporting-operational-snapshots",
      paths: [
        { label: "sync", route: "store-signals" },
        { label: "recent_value", route: "recent-value" }
      ]
    }] : []),
    {
      id: "raw-store" as const,
      label: "Raw Store",
      summary: "Raw evidence indexed",
      route: "debug-inspector",
      paths: [
        { label: "recent_records", route: "inspector:records" },
        { label: "recent_events", route: "inspector:events" },
        { label: "sync", route: "inspector:sync" }
      ]
    }
  ];
  return `
    <details class="panel supporting-evidence" data-dashboard-detail="supporting-evidence" aria-label="Supporting Evidence">
      <summary class="dashboard-fold-summary supporting-evidence-fold">
        <span>Audit Trail</span>
        <small>${escapeHtml(supportingEvidenceSummary())}</small>
      </summary>
      <div class="supporting-evidence-list">
        <div class="supporting-evidence-index" aria-label="Audit Trail API index">
          ${summaryRows.map(supportingEvidenceSummaryRow).join("")}
          <p>Open <code>/api/dashboard</code> for full audit reports, store snapshots, raw records, recent events, sync metadata, and trace commands.</p>
        </div>
      </div>
    </details>
  `;
}

function evidenceLibrarySummary(reviewGroupCount: number, backgroundGroupCount: number): string {
  if (reviewGroupCount === 0 && backgroundGroupCount > 0) return "Reference evidence only";
  if (reviewGroupCount > 0) return "Read-only reference material";
  return "No evidence groups";
}

function evidenceLibraryVisibleSummary(
  reviewGroupCount: number,
  backgroundGroupCount: number,
  options: { auditOnly?: boolean } = {}
): string {
  if (options.auditOnly && (reviewGroupCount > 0 || backgroundGroupCount > 0)) return "Audit evidence only";
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
};

function routineDiagnosticRoute(panel: RoutineDiagnosticPanel): string {
  const source = panel.id === "health-check"
    ? "health_check"
    : panel.id === "recall-eval"
      ? "recall_eval"
      : "context_pack_review";
  return `
          <button type="button" class="routine-diagnostics-route ${escapeHtml(panel.status)}" data-dashboard-detail="${escapeHtml(panel.id)}" data-action-board-target="${escapeHtml(panel.id)}" aria-controls="${escapeHtml(panel.id)}" aria-label="${escapeHtml(`${panel.label}: ${panel.summary}. Full report is available in /api/dashboard.${source}.`)}">
            <span>${escapeHtml(panel.label)}</span>
            <code>${escapeHtml(source)}</code>
          </button>
  `;
}

function routineDiagnosticsPanel(panels: RoutineDiagnosticPanel[]): string {
  if (panels.length === 0) return "";
  const sources = panels
    .map((panel) => panel.id === "health-check" ? "health_check" : panel.id === "recall-eval" ? "recall_eval" : "context_pack_review");
  return `
    <details class="panel routine-diagnostics" data-dashboard-detail="routine-diagnostics" aria-label="Routine Diagnostics">
      <summary class="dashboard-fold-summary routine-diagnostics-fold" aria-label="Routine Diagnostics: Healthy checks and handoff readiness">
        ${i18nText("Routine Diagnostics", "日常诊断")}
        ${i18nText("Checks ready", "检查已就绪", "small")}
      </summary>
      <div class="routine-diagnostics-list">
        <article class="routine-diagnostics-reference" data-dashboard-detail="routine-diagnostics:index" data-routine-diagnostics-reference>
          ${i18nText("Routine Diagnostics Index", "日常诊断索引", "strong")}
          ${i18nText("Health, recall, and handoff readiness indexed", "健康、召回和交接状态已建立索引")}
          ${i18nText("API-backed", "API 支持", "small")}
          <div class="routine-diagnostics-routebar" role="list" aria-label="Routine diagnostic API routes">
${panels.map(routineDiagnosticRoute).join("")}
          </div>
        </article>
        <p>Open <code>/api/dashboard</code> for full routine diagnostic reports, commands, and evidence paths.</p>
        <p class="routine-diagnostics-sources" aria-label="Routine diagnostic API sources">${sources.map((source) => `<code>${escapeHtml(source)}</code>`).join("")}</p>
      </div>
    </details>
  `;
}

function evidenceLibraryReviewGroup(panels: string[]): string {
  if (panels.length === 0) return "";
  return `
    <details class="evidence-library-group evidence-library-review" data-dashboard-detail="evidence-review-evidence">
      <summary class="dashboard-fold-summary evidence-library-group-heading">
        ${i18nText("Review Notes", "审查记录")}
        ${i18nText("Reference notes", "参考记录", "small")}
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
        ${i18nText("Routine Reference", "日常参考")}
        ${i18nText("Checks and audit", "检查和追踪", "small")}
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
        <h3 data-i18n-en="Evidence index" data-i18n-zh="依据索引">Evidence index</h3>
        <div class="evidence-library-routebar" role="list" aria-label="Evidence index">
${routes.join("")}
        </div>
      </div>
  `;
}

function referenceLibraryIndex(input: {
  routinePanels: RoutineDiagnosticPanel[];
  hasDogfood: boolean;
  hasGovernance: boolean;
  hasCandidateTriage: boolean;
  hasAuditTrail: boolean;
  includeStoreSignals: boolean;
  hasRecentValue: boolean;
  hasAuditReports: boolean;
  compact?: boolean;
  dogfoodSummary: string;
  governanceSummary: string;
  candidateTriageSummary: string;
  candidateTriageFocus?: string;
}): string {
  const routes = [
    input.routinePanels.length > 0 ? {
      label: "diagnostics",
      route: "routine-diagnostics"
    } : undefined,
    input.hasDogfood ? {
      label: "dogfood_report",
      route: "dogfood-review"
    } : undefined,
    input.hasGovernance ? {
      label: "governance",
      route: "governance-hub"
    } : undefined,
    input.hasCandidateTriage ? {
      label: "candidate_triage",
      route: "candidate-triage"
    } : undefined,
    input.hasAuditTrail ? {
      label: "audit_trail",
      route: "supporting-evidence"
    } : undefined
  ].filter((route): route is { label: string; route: string } => route !== undefined);
  if (routes.length === 0) return "";
  const diagnosticRoutes = input.routinePanels.map((panel) => {
    const source = panel.id === "health-check"
      ? "health_check"
      : panel.id === "recall-eval"
        ? "recall_eval"
        : "context_pack_review";
    return {
      label: source,
      route: panel.id,
      description: `${panel.label}: ${panel.summary}. Full report is available in /api/dashboard.${source}.`
    };
  });
  const diagnosticSummary = "Routine checks indexed";
  const routeLabel = (route: { label: string; route: string }): string => {
    if (!input.compact) return route.label;
    if (route.route === "routine-diagnostics") return "Health checks";
    if (route.route === "dogfood-review") return "Product notes";
    if (route.route === "governance-hub") return "Safety checks";
    if (route.route === "candidate-triage") return "Saved notes";
    if (route.route === "supporting-evidence") return "History";
    return route.label;
  };
  const uiLabelZh = (label: string): string => {
    if (label === "Health checks") return "健康检查";
    if (label === "Product notes") return "产品记录";
    if (label === "Safety checks") return "安全检查";
    if (label === "Saved notes") return "已保存内容";
    if (label === "History") return "历史记录";
    if (label === "Health Checks") return "健康检查";
    if (label === "Saved Notes") return "已保存内容";
    if (label === "Safety Checks") return "安全检查";
    if (label === "Product Notes") return "产品记录";
    if (label === "Cleanup Checks") return "清理检查";
    if (label === "Shared Copy") return "共享副本";
    if (label === "Health check") return "健康检查";
    if (label === "Recall check") return "召回检查";
    if (label === "Handoff context") return "交接上下文";
    if (label === "Cleanup checks") return "清理检查";
    if (label === "Capture checks") return "捕获检查";
    if (label === "Recent value") return "最近重点";
    if (label === "Recent records") return "最近记录";
    if (label === "Recent events") return "最近事件";
    if (label === "Shared copy") return "共享副本";
    if (label === "Routine checks indexed") return "日常检查已建立索引";
    if (label === "Saved notes indexed") return "已保存内容已建立索引";
    if (label === "Safety checks indexed") return "安全检查已建立索引";
    if (label === "Product notes indexed") return "产品记录已建立索引";
    if (label === "Cleanup checks indexed") return "清理检查已建立索引";
    if (label === "Shared copy indexed") return "共享副本已建立索引";
    if (label === "History indexed") return "历史记录已建立索引";
    if (label === "Diagnostics Index") return "诊断索引";
    if (label === "Candidate Backlog Index") return "待整理内容索引";
    if (label === "Dogfood Notes Index") return "产品记录索引";
    if (label === "Audit Reports") return "审计报告";
    if (label === "Lifecycle checks indexed") return "生命周期检查已建立索引";
    if (label === "Store Snapshot") return "存储快照";
    if (label === "Store signals indexed") return "存储信号已建立索引";
    if (label === "Raw Store") return "原始存储";
    if (label === "Raw evidence indexed") return "原始依据已建立索引";
    return label;
  };
  const i18nInline = (label: string, tag: string, attributes = ""): string => {
    const translation = uiLabelZh(label);
    const translationAttributes = translation !== label ? ` ${i18nAttribute(label, translation)}` : "";
    return `<${tag}${attributes}${translationAttributes}>${escapeHtml(label)}</${tag}>`;
  };
  const routeChips = routes.map((route) => {
    const label = routeLabel(route);
    return i18nInline(label, "code", ` data-reference-library-route="${escapeHtml(route.route)}"`);
  }).join("");
  const indexTitle = input.compact ? "Saved details" : "Reference Library Index";
  const indexTitleZh = input.compact ? "保存细节" : "参考资料索引";
  const indexSummary = input.compact ? "Read-only details available" : "Background reports indexed";
  const indexSummaryZh = input.compact ? "可查看只读详情" : "后台报告已建立索引";
  const routeFaceSummary = input.compact ? "Optional context" : routeChips;
  const routeFaceSummaryZh = input.compact ? "可选上下文" : "";
  const routeFoldTitle = input.compact ? "Detail links" : "Reference routes";
  const routeFoldTitleZh = input.compact ? "详情入口" : "参考入口";
  const routeFoldSummary = input.compact ? "Routes and checks" : "Indexed background sources";
  const routeFoldSummaryZh = input.compact ? "入口和检查" : "已索引的后台来源";
  const detailedApiReferenceHint = "Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.";
  const compactApiReferenceHint = "Full evidence stays in <code>/api/dashboard</code>.";
  const diagnosticsTitle = input.compact ? "Health Checks" : "Diagnostics Index";
  const candidateTriageTitle = input.compact ? "Saved Notes" : "Candidate Backlog Index";
  const governanceTitle = input.compact ? "Safety Checks" : "Governance Index";
  const dogfoodTitle = input.compact ? "Product Notes" : "Dogfood Notes Index";
  const governanceTitleZh = input.compact ? "安全检查" : "治理索引";
  const candidateTriageSummary = input.compact ? "Saved notes indexed" : input.candidateTriageSummary;
  const governanceSummary = input.compact ? "Safety checks indexed" : input.governanceSummary;
  const governanceSummaryZh = input.compact ? "安全检查已建立索引" : input.governanceSummary.replace(/^(\d+) governance note(s)? indexed$/, "$1 条治理记录已建立索引");
  const dogfoodSummary = input.compact ? "Product notes indexed" : input.dogfoodSummary;
  const candidateTriageFocus = input.compact ? "" : input.candidateTriageFocus;
  const auditReportsTitle = input.compact ? "Cleanup Checks" : "Audit Reports";
  const auditReportsSummary = input.compact ? "Cleanup checks indexed" : "Lifecycle checks indexed";
  const storeSnapshotTitle = input.compact ? "Shared Copy" : "Store Snapshot";
  const storeSnapshotSummary = input.compact ? "Shared copy indexed" : "Store signals indexed";
  const rawStoreTitle = input.compact ? "History" : "Raw Store";
  const rawStoreSummary = input.compact ? "History indexed" : "Raw evidence indexed";
  const evidenceLabel = (label: string): string => {
    if (!input.compact) return label;
    if (label === "health_check") return "Health check";
    if (label === "recall_eval") return "Recall check";
    if (label === "context_pack_review") return "Handoff context";
    if (label === "candidate_triage") return "Saved notes";
    if (label === "governance") return "Safety checks";
    if (label === "dogfood_report") return "Product notes";
    if (label === "memory_lifecycle") return "Cleanup checks";
    if (label === "capture_policy") return "Capture checks";
    if (label === "recent_value") return "Recent value";
    if (label === "recent_records") return "Recent records";
    if (label === "recent_events") return "Recent events";
    if (label === "audit_trail") return "History";
    if (label === "sync") return "Shared copy";
    return label;
  };
  const evidenceCode = (label: string, attributes = ""): string => {
    const visibleLabel = evidenceLabel(label);
    return i18nInline(visibleLabel, "code", attributes);
  };
  const routeChipsRow = input.compact ? `
                <div class="reference-library-route-chips" data-reference-library-route-chips>
                  ${routeChips}
                </div>
                <p class="reference-library-api-hint">${compactApiReferenceHint}</p>` : "";
  const indexFooter = input.compact ? "" : `<p>${detailedApiReferenceHint}</p>`;
  const rows = [
    diagnosticRoutes.length > 0 ? `
            <div class="reference-library-index-row" data-reference-library-index-row="diagnostics" data-dashboard-detail="routine-diagnostics" data-routine-diagnostics-reference data-reference-library-index="diagnostics">
              <div>
                ${i18nInline(diagnosticsTitle, "strong")}
                ${i18nInline(diagnosticSummary, "span")}
              </div>
              <small>${diagnosticRoutes.map((route) => evidenceCode(route.label, ` data-dashboard-detail="${escapeHtml(route.route)}" aria-label="${escapeHtml(route.description)}"`)).join("")}</small>
            </div>` : "",
    input.hasCandidateTriage ? `
            <div class="reference-library-index-row" data-reference-library-index-row="candidate-triage" data-dashboard-detail="candidate-triage" data-candidate-triage-reference data-reference-library-index="candidate-triage">
              <div>
                ${i18nInline(candidateTriageTitle, "strong")}
                ${i18nInline(candidateTriageSummary, "span")}
                ${candidateTriageFocus ? `<span data-candidate-triage-focus>${escapeHtml(candidateTriageFocus)}</span>` : ""}
              </div>
              <small>${evidenceCode("candidate_triage", ` data-dashboard-detail="candidate-triage:index"`)}</small>
            </div>` : "",
    input.hasGovernance ? `
            <div class="reference-library-index-row" data-reference-library-index-row="governance" data-dashboard-detail="governance-hub" data-governance-reference data-reference-library-index="governance">
              <div>
                <strong ${i18nAttribute(governanceTitle, governanceTitleZh)}>${escapeHtml(governanceTitle)}</strong>
                <span ${i18nAttribute(governanceSummary, governanceSummaryZh)}>${escapeHtml(governanceSummary)}</span>
              </div>
              <small>${evidenceCode("governance")}</small>
            </div>` : "",
    input.hasDogfood ? `
            <div class="reference-library-index-row" data-reference-library-index-row="dogfood" data-dashboard-detail="dogfood-review" data-dogfood-review-reference data-reference-library-index="dogfood">
              <div>
                ${i18nInline(dogfoodTitle, "strong")}
                ${i18nInline(dogfoodSummary, "span")}
              </div>
              <small>${evidenceCode("dogfood_report")}</small>
            </div>` : "",
    input.hasAuditTrail && input.hasAuditReports ? `
            <div class="reference-library-index-row" data-reference-library-index-row="audit-reports" data-supporting-evidence-summary="audit-reports" data-dashboard-detail="supporting-operational-evidence">
              <div>
                ${i18nInline(auditReportsTitle, "strong")}
                ${i18nInline(auditReportsSummary, "span")}
              </div>
              <small>${evidenceCode("memory_lifecycle", ` data-dashboard-detail="memory-lifecycle-audit"`)}${evidenceCode("capture_policy", ` data-dashboard-detail="capture-policy-audit"`)}</small>
            </div>` : "",
    input.hasAuditTrail && (input.includeStoreSignals || input.hasRecentValue) ? `
            <div class="reference-library-index-row" data-reference-library-index-row="store-snapshot" data-supporting-evidence-summary="store-snapshot" data-dashboard-detail="supporting-operational-snapshots">
              <div>
                ${i18nInline(storeSnapshotTitle, "strong")}
                ${i18nInline(storeSnapshotSummary, "span")}
              </div>
              <small>${evidenceCode("sync", ` data-dashboard-detail="store-signals"`)}${evidenceCode("recent_value", ` data-dashboard-detail="recent-value"`)}</small>
            </div>` : "",
    input.hasAuditTrail ? `
            <div class="reference-library-index-row" data-reference-library-index-row="raw-store" data-supporting-evidence-summary="raw-store" data-dashboard-detail="debug-inspector">
              <div>
                ${i18nInline(rawStoreTitle, "strong")}
                ${i18nInline(rawStoreSummary, "span")}
              </div>
              <small>${evidenceCode("audit_trail", ` data-dashboard-detail="supporting-evidence"`)}${evidenceCode("recent_records", ` data-dashboard-detail="inspector:records"`)}${evidenceCode("recent_events", ` data-dashboard-detail="inspector:events"`)}${evidenceCode("sync", ` data-dashboard-detail="inspector:sync"`)}</small>
            </div>` : ""
  ].filter((row) => row.length > 0).join("");
  return `
        <div class="reference-library-index-wrap">
          <article class="reference-library-index" data-dashboard-detail="reference-library:index" data-reference-library-index>
            <strong ${i18nAttribute(indexTitle, indexTitleZh)}>${escapeHtml(indexTitle)}</strong>
            <span ${i18nAttribute(indexSummary, indexSummaryZh)}>${escapeHtml(indexSummary)}</span>
            ${input.compact
              ? `<small ${i18nAttribute(routeFaceSummary, routeFaceSummaryZh)}>${escapeHtml(routeFaceSummary)}</small>`
              : `<small>${routeFaceSummary}</small>`}
            <details class="reference-library-routes" data-dashboard-detail="reference-library:routes">
              <summary class="dashboard-fold-summary reference-library-routes-fold">
                <span ${i18nAttribute(routeFoldTitle, routeFoldTitleZh)}>${escapeHtml(routeFoldTitle)}</span>
                <small ${i18nAttribute(routeFoldSummary, routeFoldSummaryZh)}>${escapeHtml(routeFoldSummary)}</small>
              </summary>
${routeChipsRow}
              <div class="reference-library-index-rows">
${rows}
              </div>
            </details>
          </article>
          ${indexFooter}
        </div>
  `;
}

function evidenceLibrary(
  data: DashboardData,
  options: { includeStoreSignals?: boolean; showEvidenceIndex?: boolean; compactBackground?: boolean; auditOnly?: boolean } = {}
): string {
  const includeStoreSignals = options.includeStoreSignals ?? true;
  const showEvidenceIndex = options.showEvidenceIndex ?? true;
  const compactBackground = options.compactBackground ?? false;
  const auditOnly = options.auditOnly ?? false;
  const routinePanels: RoutineDiagnosticPanel[] = [];
  if (isRoutineHealthCheck(data.health_check)) {
    routinePanels.push({
      id: "health-check" as const,
      label: "Health Check",
      summary: healthCheckSummary(data.health_check),
      status: "good" as const
    });
  }
  if (isRoutineRecallEval(data.recall_eval)) {
    routinePanels.push({
      id: "recall-eval" as const,
      label: "Recall Eval",
      summary: recallEvalSummary(data.recall_eval),
      status: data.recall_eval.available ? "good" as const : "info" as const
    });
  }
  if (isRoutineContextPackReview(data.context_pack_review)) {
    routinePanels.push({
      id: "context-pack-review" as const,
      label: "Context Pack Review",
      summary: contextPackReviewSummary(data.context_pack_review),
      status: data.context_pack_review.available ? "good" as const : "info" as const
    });
  }
  const candidateTriageNeedsDecision = candidateTriageHasPromotionDrafts(data.candidate_triage);
  const candidateTriage = candidateTriagePanel(data.candidate_triage);
  const governanceNeedsDecision = governanceNeedsReview(data.governance);
  const governance = governanceHub(data.governance);
  const dogfood = dogfoodReviewPanel(data.dogfood_report);
  const hasDogfood = data.dogfood_report.findings.length > 0;
  const hasGovernance = data.governance.summary.total_items > 0;
  const hasCandidateTriage = data.candidate_triage.available;
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
  const visibleEvidenceSummary = evidenceLibraryVisibleSummary(
    reviewPanels.length > 0 ? 1 : 0,
    backgroundPanels.length > 0 ? 1 : 0,
    { auditOnly }
  );
  const indexOnly = reviewPanels.length === 0;
  const detailClass = compactBackground ? "evidence-library evidence-library-compact" : "panel evidence-library";
  const ariaLabel = compactBackground ? "More details" : "Reference Library";
  const summaryClass = compactBackground ? "dashboard-fold-summary evidence-library-fold evidence-library-compact-fold" : "dashboard-fold-summary evidence-library-fold";
  const summaryLabel = compactBackground ? "More details" : "Reference Library";
  const visibleSummary = compactBackground ? "Extra context" : visibleEvidenceSummary;
  const accessibleSummary = compactBackground ? "Extra context" : evidenceSummary;
  const backgroundReferenceAttribute = compactBackground ? " data-dashboard-background-reference" : "";
  return `
    <details class="${detailClass}" data-dashboard-detail="evidence-library"${backgroundReferenceAttribute} aria-label="${escapeHtml(ariaLabel)}">
      <summary class="${summaryClass}" aria-label="${escapeHtml(`${summaryLabel}: ${accessibleSummary}`)}">
        ${compactBackground ? i18nText(summaryLabel, "更多细节") : `<span>${escapeHtml(summaryLabel)}</span>`}
        ${compactBackground ? i18nText(visibleSummary, "补充信息", "small") : `<small>${escapeHtml(visibleSummary)}</small>`}
      </summary>
      ${showRouteIndex ? evidenceLibraryBrief({ reviewCount: reviewPanels.length, routineCount: routinePanels.length, backgroundCount: backgroundPanels.length }) : ""}
      ${indexOnly ? referenceLibraryIndex({
        routinePanels,
        hasDogfood,
        hasGovernance,
        hasCandidateTriage,
        hasAuditTrail: backgroundPanels.length > 0,
        includeStoreSignals,
        hasRecentValue: data.recent_value.length > 0,
        hasAuditReports: hasAuditReportData(data.memory_lifecycle, data.capture_policy),
        compact: compactBackground,
        dogfoodSummary: `${pluralize(data.dogfood_report.findings.length, "finding")} indexed`,
        governanceSummary: `${pluralize(data.governance.summary.total_items, "governance note")} indexed`,
        candidateTriageSummary: `${pluralize(data.candidate_triage.summary.total_candidates, "candidate")} across ${pluralize(data.candidate_triage.summary.groups, "group")} indexed`,
        candidateTriageFocus: candidateTriageVisibleFocus(data.candidate_triage.review_focus?.summary)
      }) : `<div class="evidence-library-list">
        ${evidenceLibraryReviewGroup(reviewPanels)}
        ${evidenceLibraryBackgroundGroup(backgroundPanels)}
      </div>`}
    </details>
  `;
}

function dashboardStatusSummary(data: DashboardData, options: { hideHealthyLine?: boolean } = {}): string {
  const health = data.health;
  const statusClass = healthClass(health.status);
  const healthZh = dashboardHealthZh(health.status, health.label);
  if (health.status === "healthy") {
    if (options.hideHealthyLine) return "";
    return `
    <p class="dashboard-status-line ${statusClass}" data-dashboard-status="${escapeHtml(health.status)}"><strong ${i18nAttribute(health.label, healthZh)}>${escapeHtml(health.label)}</strong><span ${i18nAttribute(health.explanation, dashboardActionDetailZh(health.explanation))}>${escapeHtml(health.explanation)}</span></p>
  `;
}
  if (health.status === "sync_pending") return "";
  return `
    <section class="status-strip ${statusClass}" data-dashboard-status="${escapeHtml(health.status)}">
      <strong>Dashboard Status</strong>
      <span ${i18nAttribute(health.label, healthZh)}>${escapeHtml(health.label)}</span>
      <p>${escapeHtml(health.explanation)}</p>
    </section>
  `;
}

function dashboardGeneratedAtLabel(generatedAt: string): string {
  const date = new Date(generatedAt);
  if (Number.isNaN(date.getTime())) return "Updated";
  const hours = date.getUTCHours().toString().padStart(2, "0");
  const minutes = date.getUTCMinutes().toString().padStart(2, "0");
  return `Updated ${hours}:${minutes} UTC`;
}

function dashboardLanguageToggle(): string {
  return `
      <div class="language-toggle" data-dashboard-language-toggle aria-label="Language">
        <span class="language-toggle-label" data-i18n-en="Language" data-i18n-zh="语言">Language</span>
        <div class="language-options" role="group" aria-label="Language">
          <button type="button" class="language-option active" data-dashboard-language-option="en" aria-pressed="true">EN</button>
          <button type="button" class="language-option" data-dashboard-language-option="zh" aria-pressed="false">中文</button>
        </div>
      </div>
  `;
}

function statusBoardExplainText(data: DashboardData): { en: string; zh: string } {
  const count = data.memory_inventory.summary.total_visible;
  if (count <= 0) {
    return {
      en: "Saved content will appear here first.",
      zh: "保存的内容会先显示在这里。"
    };
  }
  return {
    en: "Only confirmation buttons can change long-term memory.",
    zh: "只有确认按钮会改变长期记忆。"
  };
}

function actionAnswerConclusion(data: DashboardData): { en: string; zh: string } {
  const decisions = data.decision_summary.total_decisions;
  if (decisions > 0) {
    return {
      en: `${pluralize(decisions, "confirmation")} waiting before memory changes.`,
      zh: `${decisions} 个确认项等待处理，之后才会改变记忆。`
    };
  }
  if (data.memory_inventory.summary.total_visible > 0) {
    return {
      en: "Saved items are searchable; no confirmation is waiting.",
      zh: "内容已保存可搜索；没有等待确认的操作。"
    };
  }
  if (data.dashboard_overview.status === "warning" || data.dashboard_overview.status === "critical") {
    return {
      en: "No confirmation is waiting; check the highlighted issue.",
      zh: "没有等待确认的操作；请查看高亮提醒。"
    };
  }
  return {
    en: "No confirmation is waiting.",
    zh: "没有等待确认的操作。"
  };
}

function memoryAnswerConclusion(inventory: DashboardMemoryInventory): { en: string; zh: string } {
  const ready = inventory.summary.remembered;
  const later = inventory.summary.new_items + inventory.summary.temporary;
  const history = inventory.summary.set_aside;
  const enParts = [
    ready > 0 ? `${ready} ready to use` : "",
    later > 0 ? `${later} saved for later` : "",
    history > 0 ? `${history} kept for history` : ""
  ].filter(Boolean);
  const zhParts = [
    ready > 0 ? `${ready} 条可直接使用` : "",
    later > 0 ? `${later} 条稍后整理` : "",
    history > 0 ? `${history} 条历史留存` : ""
  ].filter(Boolean);
  return {
    en: enParts.length > 0 ? enParts.join(" · ") : "No visible saved content yet",
    zh: zhParts.length > 0 ? zhParts.join(" · ") : "还没有可见保存内容"
  };
}

function syncAnswerConclusion(sync: GitSyncStatus): { en: string; zh: string } {
  const ahead = sync.ahead ?? 0;
  const behind = sync.behind ?? 0;
  if (!sync.configured) {
    return {
      en: "Only this device has this memory view.",
      zh: "这份记忆视图目前只在本机可见。"
    };
  }
  if (sync.sync_state === "conflict") {
    return {
      en: "Shared copy needs conflict help.",
      zh: "共享副本需要处理冲突。"
    };
  }
  if (sync.sync_state === "dirty" || ahead > 0) {
    return {
      en: "This device has changes waiting to upload.",
      zh: "这台设备有变化等待上传。"
    };
  }
  if (behind > 0) {
    return {
      en: "Shared copy has updates to pull.",
      zh: "共享副本有更新等待拉取。"
    };
  }
  return {
    en: "Shared copy is current on this device.",
    zh: "这台设备上的共享副本是最新的。"
  };
}

function answerCardConclusionText(conclusion: { en: string; zh: string }): string {
  return `<p class="answer-card-conclusion" ${i18nAttribute(conclusion.en, conclusion.zh)}>${escapeHtml(conclusion.en)}</p>`;
}

function statusTickerItem(id: string, label: string, zhLabel: string, value: string, zhValue: string, valueHtml?: string): string {
  const valueAttribute = valueHtml ? "" : ` ${i18nAttribute(value, zhValue)}`;
  return `<span data-status-ticker-item="${escapeHtml(id)}"><b ${i18nAttribute(label, zhLabel)}>${escapeHtml(label)}</b><strong${valueAttribute}>${valueHtml ?? escapeHtml(value)}</strong></span>`;
}

function statusBoardTicker(data: DashboardData, shared: ReturnType<typeof sharedCopyLabel>): string {
  const latestRecord = data.recent_records[0];
  const latestSource = latestRecord ? humanSourceLabel(latestRecord.source) : "No writes yet";
  const latestSourceZh = latestRecord ? latestSource : "还没有写入";
  const latestWrite = latestRecord ? relativeTime(latestRecord.updated_at, data.generated_at) : "None";
  const latestWriteZh = latestRecord ? relativeTimeZh(latestWrite) : "无";
  const latestWriteHtml = latestRecord ? relativeTimeElement(latestRecord.updated_at, data.generated_at) : escapeHtml(latestWrite);
  const toOrganize = data.memory_inventory.summary.new_items + data.memory_inventory.summary.temporary;
  const toOrganizeLabel = toOrganize > 0 ? `${toOrganize} saved for later` : "Nothing saved for later";
  const toOrganizeZh = toOrganize > 0 ? `${toOrganize} 条已保存待整理` : "没有稍后整理内容";
  return `
      <div class="status-board-ticker" data-status-board-ticker aria-label="Latest status ticker">
        ${statusTickerItem("last-write", "Last write", "最近写入", latestWrite, latestWriteZh, latestWriteHtml)}
        ${statusTickerItem("source", "Source", "来源", latestSource, latestSourceZh)}
        ${statusTickerItem("shared-copy", "Shared copy", "共享副本", shared.label, shared.zh)}
        ${statusTickerItem("to-organize", "Saved for later", "稍后整理", toOrganizeLabel, toOrganizeZh)}
      </div>
  `;
}

function statusBoard(data: DashboardData): string {
  const shared = sharedCopyLabel(data.sync);
  const actionConclusion = actionAnswerConclusion(data);
  const memoryConclusion = memoryAnswerConclusion(data.memory_inventory);
  const syncConclusion = syncAnswerConclusion(data.sync);
  const actionIsCalm = data.decision_summary.total_decisions === 0 && ((data.dashboard_overview.headline === "Saved, not remembered" || data.dashboard_overview.headline === "Saved for later") || (data.dashboard_overview.status !== "critical" && data.dashboard_overview.status !== "warning"));
  const actionClass = actionIsCalm ? "calm" : escapeHtml(data.dashboard_overview.status);
  const healthLabel = data.health.status === "healthy" ? "Healthy" : data.health.label;
  const healthZh = dashboardHealthZh(data.health.status, healthLabel);
  const headlineZh = dashboardActionLabelZh(data.dashboard_overview.headline);
  const primaryActionZh = dashboardActionLabelZh(data.dashboard_overview.primary_action.label);
  const explain = statusBoardExplainText(data);
  return `
    <section class="status-board" data-status-board aria-label="Right now">
      <div class="section-heading status-board-heading">
        <h2 data-i18n-en="Right now" data-i18n-zh="现在情况">Right now</h2>
        ${i18nText("Action, saved content, and shared copy", "要不要操作、存了什么、共享副本是否同步", "small")}
      </div>
      <div class="status-board-rail" data-status-board-rail aria-label="Local and shared status">
        <article class="status-chip ${escapeHtml(overviewStatusFromHealth(data.health.status))}" data-status-chip="device">
          ${i18nText("This device", "本机记忆")}
          ${i18nText(healthLabel, healthZh, "strong")}
          ${i18nText("Local memory is ready", "本机记忆可用", "small")}
        </article>
        <article class="status-chip ${escapeHtml(shared.severity)}" data-status-chip="shared-copy">
          ${i18nText("Shared copy", "共享副本")}
          ${i18nText(shared.label, shared.zh, "strong")}
          <small ${i18nAttribute(shared.detail, shared.zhDetail)}>${escapeHtml(shared.detail)}</small>
        </article>
      </div>
      <div class="status-board-answers" data-status-board-answers>
        <button type="button" class="answer-card action ${actionClass}" data-dashboard-priority="action" data-action-board-target="${escapeHtml(data.dashboard_overview.primary_action.target)}" aria-controls="${escapeHtml(data.dashboard_overview.primary_action.target)}">
          ${i18nText("Do I need to act?", "我需要操作吗？")}
          <strong data-i18n-en="${escapeHtml(data.dashboard_overview.headline)}" data-i18n-zh="${escapeHtml(headlineZh)}">${escapeHtml(data.dashboard_overview.headline)}</strong>
          ${answerCardConclusionText(actionConclusion)}
          <small data-i18n-en="${escapeHtml(data.dashboard_overview.primary_action.label)}" data-i18n-zh="${escapeHtml(primaryActionZh)}">${escapeHtml(data.dashboard_overview.primary_action.label)}</small>
        </button>
        <button type="button" class="answer-card memory" data-dashboard-priority="memory" data-action-board-target="stored-content" aria-controls="stored-content">
          ${i18nText("What is stored?", "存了什么？")}
          <strong>${escapeHtml(data.memory_inventory.summary.total_visible)}</strong>
          ${answerCardConclusionText(memoryConclusion)}
          ${i18nText("visible saved items", "条可见保存内容", "small")}
          ${answerMemoryMix(data.memory_inventory)}
        </button>
        <button type="button" class="answer-card sync ${escapeHtml(shared.severity)}" data-dashboard-priority="sync" data-action-board-target="store-signals" aria-controls="store-signals">
          ${i18nText("Is everything synced?", "都同步了吗？")}
          ${i18nText(shared.label, shared.zh, "strong")}
          ${answerCardConclusionText(syncConclusion)}
          <small data-i18n-en="${escapeHtml(shared.detail)}" data-i18n-zh="${escapeHtml(shared.zhDetail)}">${escapeHtml(shared.detail)}</small>
        </button>
      </div>
      ${statusBoardTicker(data, shared)}
      <div class="status-board-explain" data-status-board-explain>
        ${i18nText("Write safety", "写入边界")}
        <p ${i18nAttribute(explain.en, explain.zh)}>${escapeHtml(explain.en)}</p>
      </div>
    </section>
  `;
}

function chartPercent(count: number, total: number): string {
  if (count <= 0 || total <= 0) return "0";
  const percent = (count / total) * 100;
  return (percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)).replace(/\.0$/, "");
}

function memoryStateClass(id: DashboardMemoryInventoryStateId): string {
  if (id === "remembered") return "memory-state-remembered";
  if (id === "new_items") return "memory-state-to-organize";
  if (id === "temporary") return "memory-state-temporary";
  return "memory-state-set-aside";
}

function memoryInventoryStateExplanation(state: DashboardMemoryInventoryState): { en: string; zh: string } {
  if (state.id === "remembered") return {
    en: "Moryn can use this as long-term memory.",
    zh: "Moryn 可以把这些作为长期记忆使用。"
  };
  if (state.id === "new_items") return {
    en: "Saved and searchable; not long-term memory yet.",
    zh: "已保存并可搜索；还不是长期记忆。"
  };
  if (state.id === "temporary") return {
    en: "Session context kept for lookup.",
    zh: "作为会话上下文保留，可供查找。"
  };
  return {
    en: "Archived or replaced items kept for traceability.",
    zh: "为追溯保留的归档或已替换内容。"
  };
}

function memoryInventoryFilterValue(state: DashboardMemoryInventoryState): string {
  return state.source_states.join(",");
}

function answerMemoryCountLabel(state: DashboardMemoryInventoryState): { en: string; zh: string } {
  if (state.id === "remembered") return {
    en: `${state.count} ready to use`,
    zh: `${state.count} 条可直接使用`
  };
  if (state.id === "new_items") return {
    en: `${state.count} saved, not organized`,
    zh: `${state.count} 条已保存待整理`
  };
  if (state.id === "temporary") return {
    en: pluralize(state.count, "session note"),
    zh: `${state.count} 条会话笔记`
  };
  return {
    en: pluralize(state.count, "set aside"),
    zh: `${state.count} 条历史留存`
  };
}

function answerMemoryMix(inventory: DashboardMemoryInventory): string {
  const total = Math.max(1, inventory.summary.total_visible);
  const visibleStates = inventory.states.filter((state) => state.count > 0);
  return `
          <div class="answer-memory-mix" data-answer-memory-mix aria-label="Stored content mix">
            <div class="answer-memory-track" aria-hidden="true">
              ${visibleStates.map((state) => {
                const percent = Math.max(4, Math.round((state.count / total) * 100));
                return `<span class="answer-memory-segment ${memoryStateClass(state.id)}" style="width: ${escapeHtml(percent)}%" title="${escapeHtml(`${state.label} ${state.count}`)}"></span>`;
              }).join("")}
            </div>
            <div class="answer-memory-counts" data-answer-memory-counts>
              ${visibleStates.slice(0, 3).map((state) => {
                const label = answerMemoryCountLabel(state);
                return `<span ${i18nAttribute(label.en, label.zh)}>${escapeHtml(label.en)}</span>`;
              }).join("")}
            </div>
          </div>
  `;
}

function memoryStateMeter(inventory: DashboardMemoryInventory): string {
  const total = inventory.summary.total_visible;
  const segments = inventory.states
    .filter((state) => state.count > 0)
    .map((state) => {
      const percent = chartPercent(state.count, total);
      return `<span class="${escapeHtml(memoryStateClass(state.id))}" data-memory-state-segment="${escapeHtml(state.id)}" style="width: ${escapeHtml(percent)}%" title="${escapeHtml(`${state.label}: ${state.count}`)}"></span>`;
    })
    .join("");
  return `
      <div class="memory-state-meter" aria-label="Memory state chart">
        ${segments || `<span class="memory-state-empty" style="width: 100%" title="No stored content"></span>`}
      </div>
      <div class="memory-state-key">
        ${inventory.states.map((state) => `
          <button type="button" class="memory-state-filter ${escapeHtml(memoryStateClass(state.id))}" data-memory-state-filter="${escapeHtml(memoryInventoryFilterValue(state))}" data-action-board-target="stored-content" aria-controls="stored-content">
            <i></i>
            <strong>${escapeHtml(state.count)}</strong>
            <span data-i18n-en="${escapeHtml(state.label)}" data-i18n-zh="${escapeHtml(state.zh_label)}">${escapeHtml(state.label)}</span>
          </button>
        `).join("")}
      </div>
  `;
}

function memoryKindBars(inventory: DashboardMemoryInventory): string {
  if (inventory.kind_summary.length === 0) return `<div class="empty-state">No stored content yet.</div>`;
  const max = Math.max(1, ...inventory.kind_summary.map((kind) => kind.count));
  return `
      <div class="kind-bars" aria-label="Stored content types">
        ${inventory.kind_summary.map((kind) => {
          const percent = chartPercent(kind.count, max);
          return `
            <div class="kind-row type-${escapeHtml(kind.kind)}">
              <div class="type-label">
                <strong data-i18n-en="${escapeHtml(kind.label)}" data-i18n-zh="${escapeHtml(kind.zh_label)}">${escapeHtml(kind.label)}</strong>
                <span>${escapeHtml(kind.count)}</span>
              </div>
              <div class="type-track" aria-hidden="true"><span style="width: ${escapeHtml(percent)}%"></span></div>
            </div>
          `;
        }).join("")}
      </div>
  `;
}

function recentActivityBars(agents: DashboardAgentChartItem[]): string {
  if (agents.length === 0) return `<div class="empty-state">No recent activity yet.</div>`;
  return `
      <div class="activity-bars" aria-label="Recent source activity">
        ${agents.map((agent) => {
          const savedEn = `${agent.records} saved | ${agent.relative_time}`;
          const savedZh = `${agent.records} 条保存内容 | ${relativeTimeZh(agent.relative_time)}`;
          return `
          <div class="activity-row">
            <div class="type-label">
              <strong>${escapeHtml(agent.client)}</strong>
              <span ${i18nAttribute(savedEn, savedZh)}>${escapeHtml(savedEn)}</span>
            </div>
            <div class="bar-track" aria-hidden="true"><span style="width: ${escapeHtml(agent.weight)}%"></span></div>
          </div>
        `;
        }).join("")}
      </div>
  `;
}

function activityTrendBars(trend: DashboardActivityTrendChart): string {
  const totalLabel = trend.total === 0 ? "No saved items" : `${trend.total} saved`;
  const totalZh = trend.total === 0 ? "没有保存内容" : `${trend.total} 条保存内容`;
  return `
      <div class="activity-trend-summary">
        <span data-i18n-en="Last 7 days" data-i18n-zh="最近 7 天">Last 7 days</span>
        <strong data-i18n-en="${escapeHtml(totalLabel)}" data-i18n-zh="${escapeHtml(totalZh)}">${escapeHtml(totalLabel)}</strong>
      </div>
      <div class="activity-trend-bars" aria-label="Saved content by day">
        ${trend.days.map((day) => `
          <div class="activity-trend-day">
            <i style="height: ${escapeHtml(day.percent)}%" title="${escapeHtml(`${day.date}: ${pluralize(day.count, "saved item")}`)}"></i>
            <span>${escapeHtml(day.label)}</span>
          </div>
        `).join("")}
      </div>
  `;
}

function glanceSummaryStrip(data: DashboardData): string {
  const recentWrites = data.recent_records.length;
  const remembered = data.memory_inventory.summary.remembered;
  const toOrganize = reviewableSavedItemsCount(data.memory_inventory);
  const topSource = data.charts.agent_activity.reduce<DashboardAgentChartItem | undefined>((best, agent) => {
    if (!best) return agent;
    const score = agent.records + agent.events;
    const bestScore = best.records + best.events;
    if (score !== bestScore) return score > bestScore ? agent : best;
    return agent.latest_at.localeCompare(best.latest_at) > 0 ? agent : best;
  }, undefined);
  const topSourceSignals = topSource ? topSource.records + topSource.events : 0;
  const topSourceLabel = topSource?.client ?? "No source";
  const topSourceLabelZh = topSource?.client ?? "暂无来源";
  const recentWritesLabel = pluralize(recentWrites, "visible record");
  const recentWritesZh = `${recentWrites} 条可见内容`;
  const topSourceDetail = topSource ? pluralize(topSourceSignals, "recent signal") : "No recent signals";
  const topSourceDetailZh = topSource ? `${topSourceSignals} 条最近信号` : "暂无最近信号";
  const topSourceFilter = topSource?.client ?? "all";
  return `
      <div class="glance-summary-strip" data-glance-summary-strip aria-label="Recent activity summary">
        <button type="button" data-glance-summary="recent-writes" data-action-board-target="stored-content" aria-controls="stored-content" data-glance-filter="all">
          <span data-i18n-en="Recent writes" data-i18n-zh="最近写入">Recent writes</span>
          <strong>${escapeHtml(recentWrites)}</strong>
          <small ${i18nAttribute(recentWritesLabel, recentWritesZh)}>${escapeHtml(recentWritesLabel)}</small>
        </button>
        <button type="button" data-glance-summary="remembered-now" data-action-board-target="stored-content" aria-controls="stored-content" data-glance-filter="canonical">
          <span data-i18n-en="Ready to use" data-i18n-zh="可直接使用">Ready to use</span>
          <strong>${escapeHtml(remembered)}</strong>
          <small data-i18n-en="Moryn can use now" data-i18n-zh="Moryn 现在可用">Moryn can use now</small>
        </button>
        <button type="button" data-glance-summary="to-organize" data-action-board-target="stored-content" aria-controls="stored-content" data-glance-filter="candidate,raw,archived,quarantined">
          <span data-i18n-en="Saved for later" data-i18n-zh="稍后整理">Saved for later</span>
          <strong>${escapeHtml(toOrganize)}</strong>
          <small data-i18n-en="Saved for later" data-i18n-zh="稍后整理">Saved for later</small>
        </button>
        <button type="button" data-glance-summary="top-source" data-action-board-target="stored-content" aria-controls="stored-content" data-glance-source="${escapeHtml(topSourceFilter)}">
          <span data-i18n-en="Top source" data-i18n-zh="主要来源">Top source</span>
          <strong data-i18n-en="${escapeHtml(topSourceLabel)}" data-i18n-zh="${escapeHtml(topSourceLabelZh)}">${escapeHtml(topSourceLabel)}</strong>
          <small ${i18nAttribute(topSourceDetail, topSourceDetailZh)}>${escapeHtml(topSourceDetail)}</small>
        </button>
      </div>
  `;
}

function dashboardGlanceBoard(data: DashboardData): string {
  const shared = sharedCopyLabel(data.sync);
  const latestRecord = data.recent_records[0];
  const latestSource = latestRecord ? humanSourceLabel(latestRecord.source) : "No writes yet";
  const latestSourceZh = latestRecord ? latestSource : "还没有写入";
  const latestWhen = latestRecord ? relativeTime(latestRecord.updated_at, data.generated_at) : "None";
  const latestWhenZh = latestRecord ? relativeTimeZh(latestWhen) : "无";
  return `
    <section class="glance-board" data-dashboard-glance aria-label="At a glance">
      <div class="section-heading">
        <h2 data-i18n-en="At a glance" data-i18n-zh="一眼看懂">At a glance</h2>
        ${i18nText("Memory, changes, and shared copy", "记忆、变化和共享副本", "small")}
      </div>
      ${glanceSummaryStrip(data)}
      <div class="glance-grid">
        <article class="glance-chart memory-shape" data-memory-state-chart>
          <h3 data-i18n-en="Stored what?" data-i18n-zh="存了什么？">Stored what?</h3>
          <strong>${escapeHtml(data.memory_inventory.summary.total_visible)}</strong>
          ${i18nText("visible items", "条可见内容", "small")}
          ${memoryStateMeter(data.memory_inventory)}
        </article>
        <article class="glance-chart memory-types" data-memory-kind-chart>
          <h3 data-i18n-en="Content mix" data-i18n-zh="内容类型">Content mix</h3>
          ${memoryKindBars(data.memory_inventory)}
        </article>
        <article class="glance-chart activity-trend" data-activity-trend-chart>
          <h3 data-i18n-en="Saved trend" data-i18n-zh="保存趋势">Saved trend</h3>
          ${activityTrendBars(data.charts.activity_trend)}
        </article>
        <article class="glance-chart shared-copy ${escapeHtml(shared.severity)}" data-shared-copy-chart>
          <h3 data-i18n-en="Shared copy" data-i18n-zh="共享副本">Shared copy</h3>
          <strong data-i18n-en="${escapeHtml(shared.label)}" data-i18n-zh="${escapeHtml(shared.zh)}">${escapeHtml(shared.label)}</strong>
          <small data-i18n-en="${escapeHtml(shared.detail)}" data-i18n-zh="${escapeHtml(shared.zhDetail)}">${escapeHtml(shared.detail)}</small>
          ${syncRail(data.charts.sync_position)}
        </article>
        <article class="glance-chart recent-activity" data-recent-activity-chart>
          <h3 data-i18n-en="Recent activity" data-i18n-zh="最近动态">Recent activity</h3>
          <div class="recent-activity-focus">
            <span data-i18n-en="Last write" data-i18n-zh="最近写入">Last write</span>
            <strong data-i18n-en="${escapeHtml(latestWhen)}" data-i18n-zh="${escapeHtml(latestWhenZh)}">${escapeHtml(latestWhen)}</strong>
            <small data-i18n-en="${escapeHtml(latestSource)}" data-i18n-zh="${escapeHtml(latestSourceZh)}">${escapeHtml(latestSource)}</small>
          </div>
          ${recentActivityBars(data.charts.agent_activity.slice(0, 4))}
        </article>
      </div>
    </section>
  `;
}

function reviewableSavedItemsCount(inventory: DashboardMemoryInventory): number {
  return inventory.summary.new_items + inventory.summary.temporary + inventory.summary.set_aside;
}

function decisionPanelItem(input: {
  kind: "write" | "review";
  status: string;
  zhStatus: string;
  title: string;
  zhTitle: string;
  detail: string;
  zhDetail: string;
  target: string;
  actionLabel: string;
  zhActionLabel: string;
  note: string;
  zhNote: string;
  feedback?: string;
  zhFeedback?: string;
}): string {
  return `
        <article class="decision-panel-item ${escapeHtml(input.kind)}">
          <div>
            <span data-i18n-en="${escapeHtml(input.status)}" data-i18n-zh="${escapeHtml(input.zhStatus)}">${escapeHtml(input.status)}</span>
            <strong data-i18n-en="${escapeHtml(input.title)}" data-i18n-zh="${escapeHtml(input.zhTitle)}">${escapeHtml(input.title)}</strong>
            <p data-i18n-en="${escapeHtml(input.detail)}" data-i18n-zh="${escapeHtml(input.zhDetail)}">${escapeHtml(input.detail)}</p>
            <small data-i18n-en="${escapeHtml(input.note)}" data-i18n-zh="${escapeHtml(input.zhNote)}">${escapeHtml(input.note)}</small>
          </div>
          <button type="button" class="decision-panel-link" data-action-board-target="${escapeHtml(input.target)}" aria-controls="${escapeHtml(input.target)}" data-i18n-en="${escapeHtml(input.actionLabel)}" data-i18n-zh="${escapeHtml(input.zhActionLabel)}">${escapeHtml(input.actionLabel)}</button>
          ${input.feedback ? `<p class="decision-panel-feedback" data-dashboard-action-feedback data-i18n-en="${escapeHtml(input.feedback)}" data-i18n-zh="${escapeHtml(input.zhFeedback ?? input.feedback)}" hidden>${escapeHtml(input.feedback)}</p>` : ""}
        </article>
  `;
}

function dashboardDecisionPanel(data: DashboardData): string {
  const explicitDecisions = data.decision_summary.total_decisions;
  const reviewable = reviewableSavedItemsCount(data.memory_inventory);
  const items: string[] = [];
  if (explicitDecisions > 0) {
    for (const route of decisionSummaryRoutes(data.decision_summary)) {
      const title = `${pluralize(route.count, "approval")} in ${route.label}`;
      items.push(decisionPanelItem({
        kind: "write",
        status: "Approval required",
        zhStatus: "需要确认",
        title,
        zhTitle: `${route.count} 个确认项在 ${route.label}`,
        detail: "Review this before Moryn changes stored memory.",
        zhDetail: "Moryn 改写存储记忆前，需要你先确认。",
        target: route.target,
        actionLabel: route.target_label,
        zhActionLabel: route.label === "Capture Inbox" ? "打开捕获收件箱" : route.label === "Review Queue" ? "打开审核队列" : "打开候选内容",
        note: "Approve or reject buttons live inside the owning row, next to the evidence.",
        zhNote: "批准或拒绝按钮会出现在对应条目旁边，和证据放在一起。"
      }));
  }
  } else if (reviewable > 0) {
    const title = `${reviewable} saved for later`;
    items.push(decisionPanelItem({
      kind: "review",
      status: "Saved safely",
      zhStatus: "已安全保存",
      title,
      zhTitle: `${reviewable} 条已保存待整理`,
      detail: "These are saved safely, but Moryn will not treat them as long-term memory unless you choose to organize them later.",
      zhDetail: "这些内容已经安全保存，但除非你稍后整理，Moryn 不会把它们当作长期记忆。",
      target: "stored-content",
      actionLabel: "Open saved content",
      zhActionLabel: "打开已保存内容",
      note: "This only opens saved content. Nothing becomes long-term memory from this summary.",
      zhNote: "这里只打开已保存内容；这里不会把内容写成长久记忆。",
      feedback: "Nothing to open here yet.",
      zhFeedback: "这里暂时没有可打开的审核队列。"
    }));
  }
  if (items.length === 0) return "";
  const panelLabel = explicitDecisions > 0 ? "Needs your decision" : "Saved for later";
  const panelLabelZh = explicitDecisions > 0 ? "需要你确认" : "稍后整理";
  return `
    <section class="decision-panel${explicitDecisions > 0 ? "" : " saved-later"}" data-dashboard-decision-panel aria-label="${escapeHtml(panelLabel)}">
      <div class="section-heading">
        <h2 data-i18n-en="${escapeHtml(panelLabel)}" data-i18n-zh="${escapeHtml(panelLabelZh)}">${escapeHtml(panelLabel)}</h2>
        ${i18nText(explicitDecisions > 0 ? "Actions are explicit" : "Nothing writes from this summary", explicitDecisions > 0 ? "操作需要明确确认" : "这里不会直接写入", "small")}
      </div>
      <div class="decision-panel-list">
        ${items.join("")}
      </div>
    </section>
  `;
}

function memoryStateLabelFromRecordState(state: MorynRecord["state"]): { en: string; zh: string } {
  if (state === "canonical") return { en: "Ready to use", zh: "可直接使用" };
  if (state === "candidate") return { en: "Saved, not organized", zh: "已保存待整理" };
  if (state === "raw") return { en: "Session notes", zh: "会话记录" };
  return { en: "Kept for history", zh: "历史留存" };
}

function storedContentNextStep(item: DashboardValueRecord): { label: string; zhLabel: string; detail: string; zhDetail: string } {
  if (item.state === "canonical") {
    return {
      label: "Ready to use",
      zhLabel: "可直接使用",
      detail: "Moryn can use this now as long-term memory.",
      zhDetail: "Moryn 现在可把这条作为长期记忆使用。"
    };
  }
  if (item.state === "candidate") {
    return {
      label: "Can be organized",
      zhLabel: "可以整理",
      detail: "Open details first. If this can change memory, Moryn will show real confirm buttons nearby.",
      zhDetail: "先打开详情；如果这条可以改变记忆，Moryn 会在附近显示真正的确认按钮。"
    };
  }
  if (item.state === "raw") {
    return {
      label: "Keep for context",
      zhLabel: "作为上下文保留",
      detail: "Session notes stay searchable for context but are not long-term memory.",
      zhDetail: "会话记录可作为上下文搜索，但不是长期记忆。"
    };
  }
  return {
    label: "Kept for history",
    zhLabel: "历史留存",
    detail: "This stays searchable here without changing long-term memory.",
    zhDetail: "这条仍可在这里搜索，不会改变长期记忆。"
  };
}

function storedContentWhySaved(item: DashboardValueRecord): { label: string; zhLabel: string } {
  if (item.provenance_reason) {
    return {
      label: item.provenance_reason,
      zhLabel: item.provenance_reason
    };
  }
  if (item.provenance_method === "user-confirmed" || item.source_label === "User") {
    return {
      label: "Saved because a user confirmed it.",
      zhLabel: "用户确认后保存。"
    };
  }
  if (item.state === "raw") {
    return {
      label: `Saved as session context by ${item.source_label}.`,
      zhLabel: `${item.source_label} 保存为会话上下文。`
    };
  }
  if (item.state === "canonical") {
    return {
      label: "Saved as long-term memory.",
      zhLabel: "已保存为长期记忆。"
    };
  }
  if (item.state === "candidate") {
    return {
      label: `Saved by ${item.source_label} for later organization.`,
      zhLabel: `${item.source_label} 保存，稍后可整理。`
    };
  }
  return {
    label: "Kept searchable without changing long-term memory.",
    zhLabel: "保持可搜索，但不改变长期记忆。"
  };
}

function storedContentExplainCard(kind: "why-saved" | "status" | "next-step", label: string, zhLabel: string, value: string, zhValue: string, detail?: string, zhDetail?: string): string {
  return `
                <div class="stored-content-explain-card" data-stored-content-explain-card="${escapeHtml(kind)}">
                  <span data-i18n-en="${escapeHtml(label)}" data-i18n-zh="${escapeHtml(zhLabel)}">${escapeHtml(label)}</span>
                  <strong data-i18n-en="${escapeHtml(value)}" data-i18n-zh="${escapeHtml(zhValue)}">${escapeHtml(value)}</strong>
                  ${detail ? `<small data-i18n-en="${escapeHtml(detail)}" data-i18n-zh="${escapeHtml(zhDetail ?? detail)}">${escapeHtml(detail)}</small>` : ""}
                </div>
  `;
}

function memoryExplorerGuidanceCard(kind: "why-saved" | "next-step", label: string, zhLabel: string, value: string, zhValue: string, detail?: string, zhDetail?: string): string {
  const valueAttribute = kind === "why-saved" ? "data-memory-explorer-detail-why" : "data-memory-explorer-detail-next-step";
  return `
        <div class="memory-explorer-guidance-card" data-memory-explorer-guidance-card="${escapeHtml(kind)}">
          <span data-i18n-en="${escapeHtml(label)}" data-i18n-zh="${escapeHtml(zhLabel)}">${escapeHtml(label)}</span>
          <strong ${valueAttribute} data-i18n-en="${escapeHtml(value)}" data-i18n-zh="${escapeHtml(zhValue)}">${escapeHtml(value)}</strong>
          ${kind === "next-step" ? `<small data-memory-explorer-detail-next-step-detail data-i18n-en="${escapeHtml(detail ?? "")}" data-i18n-zh="${escapeHtml(zhDetail ?? detail ?? "")}">${escapeHtml(detail ?? "")}</small>` : ""}
        </div>
  `;
}

function memoryExplorerGuidanceAttributes(input: {
  state: MorynRecord["state"];
  sourceLabel: string;
  provenanceMethod?: NonNullable<MorynRecord["provenance"]>["method"];
  provenanceReason?: string;
}): string {
  const item = {
    state: input.state,
    source_label: input.sourceLabel,
    provenance_method: input.provenanceMethod,
    provenance_reason: input.provenanceReason
  } as DashboardValueRecord;
  const whySaved = storedContentWhySaved(item);
  const nextStep = storedContentNextStep(item);
  return [
    `data-memory-explorer-why-saved="${escapeHtml(whySaved.label)}"`,
    `data-memory-explorer-why-saved-zh="${escapeHtml(whySaved.zhLabel)}"`,
    `data-memory-explorer-next-step="${escapeHtml(nextStep.label)}"`,
    `data-memory-explorer-next-step-zh="${escapeHtml(nextStep.zhLabel)}"`,
    `data-memory-explorer-next-step-detail="${escapeHtml(nextStep.detail)}"`,
    `data-memory-explorer-next-step-detail-zh="${escapeHtml(nextStep.zhDetail)}"`
  ].join(" ");
}

function storedContentItem(item: DashboardValueRecord, selected = false): string {
  const state = memoryStateLabelFromRecordState(item.state);
  const nextStep = storedContentNextStep(item);
  const whySaved = storedContentWhySaved(item);
  const sourceRelative = sourceRelativePair(item.source_label, item.relative_time);
  const updatedEn = `${item.relative_time} | ${item.exact_time}`;
  const updatedZh = `${relativeTimeZh(item.relative_time)} | ${item.exact_time}`;
  const guidanceAttributes = memoryExplorerGuidanceAttributes({
    state: item.state,
    sourceLabel: item.source_label,
    provenanceMethod: item.provenance_method,
    provenanceReason: item.provenance_reason
  });
  return `
            <article class="stored-content-item state-${escapeHtml(item.state)}${selected ? " selected" : ""}" data-stored-content-item="${escapeHtml(item.id)}" data-stored-content-state="${escapeHtml(item.state)}" data-stored-content-source="${escapeHtml(item.source_label)}" data-memory-explorer-item-id="${escapeHtml(item.id)}" data-memory-explorer-title="${escapeHtml(item.title)}" data-memory-explorer-full-text="${escapeHtml(item.summary)}" data-memory-explorer-state="${escapeHtml(state.en)}" data-memory-explorer-state-en="${escapeHtml(state.en)}" data-memory-explorer-state-zh="${escapeHtml(state.zh)}" data-memory-explorer-source="${escapeHtml(item.source_detail || item.source_label)}" data-memory-explorer-updated="${escapeHtml(updatedEn)}" data-memory-explorer-updated-zh="${escapeHtml(updatedZh)}" ${guidanceAttributes} data-memory-explorer-timeline="${escapeHtml(item.citation.timeline_command)}" data-memory-explorer-recall="${escapeHtml(item.citation.recall_command)}" tabindex="0">
              <div class="stored-content-item-head">
                <span data-i18n-en="${escapeHtml(state.en)}" data-i18n-zh="${escapeHtml(state.zh)}">${escapeHtml(state.en)}</span>
                <small ${i18nAttribute(sourceRelative.en, sourceRelative.zh)}>${escapeHtml(sourceRelative.en)}</small>
              </div>
              <strong>${escapeHtml(item.title)}</strong>
              ${textExcerptBlock(item.summary)}
              <div class="stored-content-explain" data-stored-content-explain>
                ${storedContentExplainCard("why-saved", "Why saved", "为什么保存", whySaved.label, whySaved.zhLabel)}
                ${storedContentExplainCard("status", "Status", "状态", state.en, state.zh)}
                ${storedContentExplainCard("next-step", "Next step", "下一步", nextStep.label, nextStep.zhLabel, nextStep.detail, nextStep.zhDetail)}
              </div>
              <button type="button" class="stored-content-open" data-memory-explorer-open data-i18n-en="Open details" data-i18n-zh="打开详情">Open details</button>
            </article>
  `;
}

function storedContentFilterBar(items: DashboardValueRecord[]): string {
  const stateOrder: MorynRecord["state"][] = ["canonical", "candidate", "raw", "archived", "quarantined"];
  const states = stateOrder.filter((state) => items.some((item) => item.state === state));
  return `
      <div class="stored-content-filterbar" data-stored-content-filterbar aria-label="Stored content filters">
        <button type="button" class="stored-content-filter active" data-stored-content-filter="all" aria-pressed="true" data-i18n-en="All" data-i18n-zh="全部">All</button>
        ${states.map((state) => {
          const label = memoryStateLabelFromRecordState(state);
          return `<button type="button" class="stored-content-filter" data-stored-content-filter="${escapeHtml(state)}" aria-pressed="false" data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</button>`;
        }).join("")}
      </div>
  `;
}

function memoryStateGuideCard(
  className: string,
  filter: string,
  label: string,
  zhLabel: string,
  detail: string,
  zhDetail: string
): string {
  return `
          <button type="button" class="memory-state-guide-card ${escapeHtml(className)}" data-memory-state-filter="${escapeHtml(filter)}" data-action-board-target="stored-content" aria-controls="stored-content">
            <strong ${i18nAttribute(label, zhLabel)}>${escapeHtml(label)}</strong>
            <small ${i18nAttribute(detail, zhDetail)}>${escapeHtml(detail)}</small>
          </button>
  `;
}

function memoryStateGuide(): string {
  return `
        <div class="memory-state-guide" data-memory-state-guide aria-label="Memory status guide">
          <span data-i18n-en="Memory status guide" data-i18n-zh="记忆状态说明">Memory status guide</span>
          <div class="memory-state-guide-grid">
            ${memoryStateGuideCard(
              "memory-state-remembered",
              "canonical",
              "Ready to use",
              "可直接使用",
              "Moryn can already use this as long-term memory.",
              "Moryn 已经可以把这些作为长期记忆使用。"
            )}
            ${memoryStateGuideCard(
              "memory-state-to-organize",
              "candidate",
              "Saved for later",
              "稍后整理",
              "Saved and searchable; organize later only if it becomes useful.",
              "已保存并可搜索；有用时再整理。"
            )}
            ${memoryStateGuideCard(
              "memory-state-temporary",
              "raw",
              "Session notes",
              "会话记录",
              "Kept as session context for lookup.",
              "作为会话上下文保留，可供查找。"
            )}
            ${memoryStateGuideCard(
              "memory-state-set-aside",
              "archived,quarantined",
              "Kept for history",
              "历史留存",
              "Archived or replaced items kept for traceability.",
              "为追溯保留的归档或已替换内容。"
            )}
          </div>
        </div>
  `;
}

function memorySearchText(parts: unknown[]): string {
  return parts
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join(" ")
    .toLowerCase();
}

function memorySearchRecordEntry(record: DashboardRecordSummary, generatedAt: string): string {
  const source = humanSourceLabel(record.source);
  const stateLabel = memoryStateLabelFromRecordState(record.state);
  const relative = relativeTime(record.updated_at, generatedAt);
  const metaEn = `${stateLabel.en} | ${source} | ${relative}`;
  const metaZh = `${stateLabel.zh} | ${source} | ${relativeTimeZh(relative)}`;
  const title = titleCase(record.type || record.kind);
  const updatedEn = `${relative} | ${record.updated_at}`;
  const updatedZh = `${relativeTimeZh(relative)} | ${record.updated_at}`;
  const guidanceAttributes = memoryExplorerGuidanceAttributes({
    state: record.state,
    sourceLabel: source
  });
  const searchText = memorySearchText([
    "record",
    record.id,
    record.kind,
    record.type,
    record.scope,
    record.project_id,
    record.state,
    source,
    record.text
  ]);
  return `
          <article class="memory-search-result record" data-memory-search-entry="record:${escapeHtml(record.id)}" data-memory-search-text="${escapeHtml(searchText)}" data-memory-search-state="${escapeHtml(record.state)}" data-memory-search-source="${escapeHtml(source)}" data-memory-search-kind="${escapeHtml(record.kind)}" data-memory-search-record-type="${escapeHtml(record.type)}" data-memory-search-updated-at="${escapeHtml(record.updated_at)}" data-memory-explorer-item-id="record:${escapeHtml(record.id)}" data-memory-explorer-title="${escapeHtml(title)}" data-memory-explorer-full-text="${escapeHtml(record.text)}" data-memory-explorer-state="${escapeHtml(stateLabel.en)}" data-memory-explorer-state-en="${escapeHtml(stateLabel.en)}" data-memory-explorer-state-zh="${escapeHtml(stateLabel.zh)}" data-memory-explorer-source="${escapeHtml(source)}" data-memory-explorer-updated="${escapeHtml(updatedEn)}" data-memory-explorer-updated-zh="${escapeHtml(updatedZh)}" ${guidanceAttributes} data-memory-explorer-timeline="${escapeHtml(record.citation.timeline_command)}" data-memory-explorer-recall="${escapeHtml(record.citation.recall_command)}" tabindex="0">
            <span ${i18nAttribute("Memory", "记忆")}>Memory</span>
            <strong>${escapeHtml(title)}</strong>
            <p>${escapeHtml(record.text)}</p>
            <small ${i18nAttribute(metaEn, metaZh)}>${escapeHtml(metaEn)}</small>
          </article>
  `;
}

function memorySearchEventEntry(event: DashboardEventSummary, generatedAt: string): string {
  const source = humanSourceLabel(event.source);
  const relative = relativeTime(event.created_at, generatedAt);
  const meta = sourceRelativePair(source, relative);
  const updatedEn = `${relative} | ${event.created_at}`;
  const updatedZh = `${relativeTimeZh(relative)} | ${event.created_at}`;
  const detailText = event.record_id ? `Saved item ${event.record_id}` : "Store-level event";
  const detailTextZh = event.record_id ? `保存内容 ${event.record_id}` : "全局事件";
  const eventTarget = event.record_id
    ? `<span ${i18nAttribute("Saved item", "保存内容")}>Saved item</span> <code>${escapeHtml(event.record_id)}</code>`
    : i18nText("Store-level event", "全局事件", "span");
  const searchText = memorySearchText([
    "event",
    event.event_id,
    event.op,
    event.record_id,
    source
  ]);
  return `
          <article class="memory-search-result event" data-memory-search-entry="event:${escapeHtml(event.event_id)}" data-memory-search-text="${escapeHtml(searchText)}" data-memory-search-state="event" data-memory-search-source="${escapeHtml(source)}" data-memory-search-kind="event" data-memory-search-record-type="${escapeHtml(event.op)}" data-memory-search-updated-at="${escapeHtml(event.created_at)}" data-memory-explorer-item-id="event:${escapeHtml(event.event_id)}" data-memory-explorer-title="${escapeHtml(event.op)}" data-memory-explorer-full-text="${escapeHtml(detailText)}" data-memory-explorer-full-text-zh="${escapeHtml(detailTextZh)}" data-memory-explorer-state="Event" data-memory-explorer-state-en="Event" data-memory-explorer-state-zh="事件" data-memory-explorer-source="${escapeHtml(source)}" data-memory-explorer-updated="${escapeHtml(updatedEn)}" data-memory-explorer-updated-zh="${escapeHtml(updatedZh)}" data-memory-explorer-has-guidance="false" data-memory-explorer-timeline="${escapeHtml(event.citation.timeline_command)}" data-memory-explorer-recall="${escapeHtml(event.citation.recall_command ?? "")}" tabindex="0">
            <span ${i18nAttribute("Event", "事件")}>Event</span>
            <strong>${escapeHtml(event.op)}</strong>
            <p>${eventTarget}</p>
            <small ${i18nAttribute(meta.en, meta.zh)}>${escapeHtml(meta.en)}</small>
          </article>
  `;
}

function memorySearchStatusLabel(count: number, filtered = false): { en: string; zh: string } {
  if (filtered) {
    return {
      en: `${pluralize(count, "item")} shown`,
      zh: `显示 ${count} 条内容`
    };
  }
  return {
    en: `${pluralize(count, "item")} to search`,
    zh: `可搜索 ${count} 条内容`
  };
}

function memorySearchMixItem(state: MorynRecord["state"] | "event", count: number): string {
  const label = state === "event" ? { en: "Event", pluralEn: "Events", zh: "事件" } : (() => {
    const stateLabel = memoryStateLabelFromRecordState(state);
    return { en: stateLabel.en, pluralEn: stateLabel.en, zh: stateLabel.zh };
  })();
  const en = `${count} ${count === 1 ? label.en : label.pluralEn}`;
  const zh = `${count} 条${label.zh}`;
  return `<button type="button" class="memory-search-mix-item" data-memory-search-mix-item="${escapeHtml(state)}" data-memory-search-mix-filter="${escapeHtml(state)}" aria-pressed="false" data-i18n-singular-en="${escapeHtml(label.en)}" data-i18n-plural-en="${escapeHtml(label.pluralEn)}" data-i18n-label-zh="${escapeHtml(label.zh)}" ${i18nAttribute(en, zh)}${count === 0 ? " hidden" : ""}>${escapeHtml(en)}</button>`;
}

function memorySearchMix(records: DashboardRecordSummary[], events: DashboardEventSummary[]): string {
  const counts: Record<MorynRecord["state"] | "event", number> = {
    canonical: 0,
    candidate: 0,
    raw: 0,
    archived: 0,
    quarantined: 0,
    event: events.length
  };
  for (const record of records) {
    counts[record.state] = (counts[record.state] ?? 0) + 1;
  }
  return `
        <div class="memory-search-mix" data-memory-search-mix aria-label="Search result mix">
          ${(["canonical", "candidate", "raw", "archived", "quarantined", "event"] as Array<MorynRecord["state"] | "event">).map((state) => memorySearchMixItem(state, counts[state] ?? 0)).join("")}
        </div>
  `;
}

function memorySearchChip(query: string, label: string, zhLabel: string): string {
  return `<button type="button" class="memory-search-chip" data-memory-search-chip="${escapeHtml(query)}" data-i18n-en="${escapeHtml(label)}" data-i18n-zh="${escapeHtml(zhLabel)}">${escapeHtml(label)}</button>`;
}

function memorySearchShortcutChips(input: { sources: string[]; recordStates: MorynRecord["state"][]; hasEvents: boolean }): string {
  const sourceChips = input.sources.slice(0, 3).map((source) => memorySearchChip(`source:${source}`, source, source));
  const stateChips = [
    input.recordStates.includes("canonical") ? memorySearchChip("state:remembered", "Ready to use", "可直接使用") : "",
    input.recordStates.includes("candidate") ? memorySearchChip("state:to-organize", "Saved, not organized", "已保存待整理") : "",
    input.recordStates.includes("raw") ? memorySearchChip("state:session-notes", "Session notes", "会话记录") : "",
    (input.recordStates.includes("archived") || input.recordStates.includes("quarantined")) ? memorySearchChip("state:set-aside", "Kept for history", "历史留存") : ""
  ].filter(Boolean);
  const eventChip = input.hasEvents ? memorySearchChip("type:event", "Events", "事件") : "";
  const chips = [
    ...sourceChips,
    ...stateChips,
    eventChip,
    memorySearchChip("recent:7d", "Recent 7d", "最近 7 天")
  ].filter(Boolean);
  if (chips.length === 0) return "";
  return `
        <div class="memory-search-chips" data-memory-search-chips aria-label="Search shortcuts">
          ${chips.join("")}
        </div>
  `;
}

function memorySearchPanel(data: DashboardData): string {
  const entries = [
    ...data.recent_records.map((record) => memorySearchRecordEntry(record, data.generated_at)),
    ...data.recent_events.map((event) => memorySearchEventEntry(event, data.generated_at))
  ];
  if (entries.length === 0) return "";
  const recordStates = [...new Set(data.recent_records.map((record) => record.state))];
  const sources = [...new Set([
    ...data.recent_records.map((record) => humanSourceLabel(record.source)),
    ...data.recent_events.map((event) => humanSourceLabel(event.source))
  ])].sort((left, right) => left.localeCompare(right));
  const statusLabel = memorySearchStatusLabel(entries.length);
  const chips = memorySearchShortcutChips({
    sources,
    recordStates,
    hasEvents: data.recent_events.length > 0
  });
  return `
      <div id="memory-search-panel" class="memory-search-panel primary-memory-search" data-memory-search-panel data-memory-search-now="${escapeHtml(data.generated_at)}" aria-label="Find memory">
        <label class="memory-search-label" for="memory-search-input" data-i18n-en="Find memory or events" data-i18n-zh="查找记忆或事件">Find memory or events</label>
        <div class="memory-search-controls" data-memory-search-controls>
          <input id="memory-search-input" class="memory-search-input" type="search" data-memory-search-input placeholder="Type a keyword, source, or topic" aria-label="Find memory or events" data-i18n-placeholder-en="Type a keyword, source, or topic" data-i18n-placeholder-zh="输入关键词、来源或主题" data-i18n-aria-label-en="Find memory or events" data-i18n-aria-label-zh="查找记忆或事件">
          <select class="memory-search-select" data-memory-search-state aria-label="Filter search by memory state">
            <option value="all" ${i18nAttribute("All statuses", "全部状态")}>All statuses</option>
            ${recordStates.map((state) => {
              const label = memoryStateLabelFromRecordState(state);
              return `<option value="${escapeHtml(state)}" ${i18nAttribute(label.en, label.zh)}>${escapeHtml(label.en)}</option>`;
            }).join("")}
            <option value="event" ${i18nAttribute("Events", "事件")}>Events</option>
          </select>
          <select class="memory-search-select" data-memory-search-source aria-label="Filter search by source">
            <option value="all" ${i18nAttribute("All sources", "全部来源")}>All sources</option>
            ${sources.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}
          </select>
        </div>
        ${chips}
        <div class="memory-search-meta">
          <span data-memory-search-status ${i18nAttribute(statusLabel.en, statusLabel.zh)}>${escapeHtml(statusLabel.en)}</span>
          <small data-i18n-en="Local search only; no writes happen here." data-i18n-zh="仅本地搜索；这里不会写入。">Local search only; no writes happen here.</small>
        </div>
        ${memoryStateGuide()}
        ${memorySearchMix(data.recent_records, data.recent_events)}
        <div class="memory-search-results" data-memory-search-results>
          ${entries.join("")}
        </div>
      </div>
  `;
}

function memoryExplorerDetailPanel(item?: DashboardValueRecord): string {
  const state = item ? memoryStateLabelFromRecordState(item.state) : undefined;
  const nextStep = item ? storedContentNextStep(item) : undefined;
  const whySaved = item ? storedContentWhySaved(item) : undefined;
  const updatedEn = item ? `${item.relative_time} | ${item.exact_time}` : "";
  const updatedZh = item ? `${relativeTimeZh(item.relative_time)} | ${item.exact_time}` : "";
  const title = item?.title ?? "Select an item";
  const titleAttrs = item ? "" : ` data-i18n-en="Select an item" data-i18n-zh="选择一条内容"`;
  const text = item?.summary ?? "Select a saved item to read its full text, source, and status.";
  const textAttrs = item ? "" : ` data-i18n-en="Select a saved item to read its full text, source, and status." data-i18n-zh="选择一条保存内容，可查看全文、来源和状态。"`;
  const gridHidden = item ? "" : " hidden";
  const guidanceHidden = item ? "" : " hidden";
  const traceHidden = item ? "" : " hidden";
  return `
      <aside class="memory-explorer-detail" data-memory-explorer-detail aria-live="polite">
        <span data-i18n-en="Selected item" data-i18n-zh="当前内容">Selected item</span>
        <strong data-memory-explorer-detail-title${titleAttrs}>${escapeHtml(title)}</strong>
        <p data-memory-explorer-detail-text${textAttrs}>${escapeHtml(text)}</p>
        <dl class="memory-explorer-detail-grid" data-memory-explorer-detail-grid${gridHidden}>
          <div><dt data-i18n-en="State" data-i18n-zh="状态">State</dt><dd data-memory-explorer-detail-state${state ? ` data-i18n-en="${escapeHtml(state.en)}" data-i18n-zh="${escapeHtml(state.zh)}"` : ""}>${state ? escapeHtml(state.en) : ""}</dd></div>
          <div><dt data-i18n-en="Source" data-i18n-zh="来源">Source</dt><dd data-memory-explorer-detail-source>${item ? escapeHtml(item.source_detail || item.source_label) : ""}</dd></div>
          <div><dt data-i18n-en="Updated" data-i18n-zh="更新时间">Updated</dt><dd data-memory-explorer-detail-updated${item ? ` data-i18n-en="${escapeHtml(updatedEn)}" data-i18n-zh="${escapeHtml(updatedZh)}"` : ""}>${item ? escapeHtml(updatedEn) : ""}</dd></div>
        </dl>
        <div class="memory-explorer-guidance" data-memory-explorer-guidance${guidanceHidden}>
          ${whySaved && nextStep ? `
          ${memoryExplorerGuidanceCard("why-saved", "Why saved", "为什么保存", whySaved.label, whySaved.zhLabel)}
          ${memoryExplorerGuidanceCard("next-step", "Next step", "下一步", nextStep.label, nextStep.zhLabel, nextStep.detail, nextStep.zhDetail)}
          ` : `
          ${memoryExplorerGuidanceCard("why-saved", "Why saved", "为什么保存", "", "")}
          ${memoryExplorerGuidanceCard("next-step", "Next step", "下一步", "", "", "", "")}
          `}
        </div>
        <div class="memory-explorer-trace" data-memory-explorer-trace${traceHidden}>
          <span data-i18n-en="History links" data-i18n-zh="历史入口">History links</span>
          <code data-memory-explorer-detail-timeline>${item ? escapeHtml(item.citation.timeline_command) : ""}</code>
          <code data-memory-explorer-detail-recall>${item ? escapeHtml(item.citation.recall_command) : ""}</code>
        </div>
      </aside>
  `;
}

function storedContentPanel(data: DashboardData): string {
  const visibleItems = data.stored_content_preview.length > 0
    ? data.stored_content_preview
    : data.recent_value.slice(0, 4);
  const visibleIds = new Set(visibleItems.map((item) => item.id));
  const overflowItems = data.recent_value.filter((item) => !visibleIds.has(item.id));
  if (visibleItems.length === 0) return "";
  const overflowCount = overflowItems.length;
  const moreLabel = `View ${overflowCount} more`;
  const moreLabelZh = `查看更多 ${overflowCount} 条`;
  return `
    <section id="stored-content" class="stored-content memory-explorer" data-stored-content data-memory-explorer aria-label="Find what Moryn saved">
      <div class="section-heading">
        <h2 data-i18n-en="Find what Moryn saved" data-i18n-zh="查找 Moryn 保存的内容">Find what Moryn saved</h2>
        <div class="stored-content-tools">
          ${i18nText("Search first, then open any item for full text. Nothing writes here.", "先搜索，再打开任何内容查看全文；这里不会写入。", "small")}
        </div>
      </div>
      <div class="memory-explorer-layout" data-memory-explorer-layout>
        <div class="memory-explorer-main" data-memory-explorer-main>
          ${memorySearchPanel(data)}
          ${storedContentFilterBar(data.recent_value)}
          <div class="stored-content-list">
            ${visibleItems.map((item, index) => storedContentItem(item, index === 0)).join("")}
          </div>
          ${overflowItems.length > 0 ? `
            <div id="stored-content-overflow" class="stored-content-list stored-content-overflow" data-stored-content-overflow hidden>
              ${overflowItems.map((item) => storedContentItem(item)).join("")}
            </div>
            <button type="button" class="stored-content-more" data-stored-content-more aria-expanded="false" aria-controls="stored-content-overflow" data-i18n-en="${escapeHtml(moreLabel)}" data-i18n-zh="${escapeHtml(moreLabelZh)}" data-stored-content-collapsed-en="${escapeHtml(moreLabel)}" data-stored-content-collapsed-zh="${escapeHtml(moreLabelZh)}" data-stored-content-expanded-en="Show fewer" data-stored-content-expanded-zh="收起">${escapeHtml(moreLabel)}</button>
          ` : ""}
        </div>
        ${memoryExplorerDetailPanel(visibleItems[0])}
      </div>
    </section>
  `;
}

function memoryInventoryPanel(inventory: DashboardMemoryInventory): string {
  const kindSummary = inventory.kind_summary.length > 0
    ? inventory.kind_summary.map((kind) => `<span ${i18nAttribute(`${kind.label} ${kind.count}`, `${kind.zh_label} ${kind.count}`)}>${escapeHtml(`${kind.label} ${kind.count}`)}</span>`).join("")
    : i18nText("No stored content yet", "还没有存储内容", "span");
  return `
    <section class="memory-inventory" data-memory-inventory aria-label="What Moryn stores">
      <div class="section-heading">
        <h2 data-i18n-en="What Moryn stores" data-i18n-zh="Moryn 存了什么">What Moryn stores</h2>
        ${i18nText(`${inventory.summary.total_visible} visible items`, `${inventory.summary.total_visible} 条可见内容`, "small")}
      </div>
      <div class="memory-inventory-grid">
        ${inventory.states.map((state) => {
          const explanation = memoryInventoryStateExplanation(state);
          return `
          <button type="button" class="memory-inventory-card memory-inventory-${escapeHtml(state.id)}" data-memory-state-filter="${escapeHtml(memoryInventoryFilterValue(state))}" data-action-board-target="stored-content" aria-controls="stored-content">
            <span data-i18n-en="${escapeHtml(state.label)}" data-i18n-zh="${escapeHtml(state.zh_label)}">${escapeHtml(state.label)}</span>
            <strong>${escapeHtml(state.count)}</strong>
            <small data-i18n-en="${escapeHtml(explanation.en)}" data-i18n-zh="${escapeHtml(explanation.zh)}">${escapeHtml(explanation.en)}</small>
          </button>
        `;
        }).join("")}
      </div>
      <div class="memory-kind-strip" aria-label="Memory types">
        ${kindSummary}
      </div>
    </section>
  `;
}

function recentStatusPanel(data: DashboardData): string {
  const latestRecord = data.recent_records[0];
  const latestSource = latestRecord ? humanSourceLabel(latestRecord.source) : "No writes yet";
  const latestSourceZh = latestRecord ? latestSource : "还没有写入";
  const reviewable = data.memory_inventory.summary.new_items + data.memory_inventory.summary.temporary;
  const reviewableLabel = reviewable > 0 ? `${reviewable} saved for later` : "Nothing saved for later";
  const reviewableZh = reviewable > 0 ? `${reviewable} 条已保存待整理` : "没有稍后整理内容";
  const shared = sharedCopyLabel(data.sync);
  return `
    <section class="recent-status" data-recent-status aria-label="Recent status">
      <div class="section-heading">
        <h2 data-i18n-en="Recent status" data-i18n-zh="最近状态">Recent status</h2>
        ${i18nText("Latest changes and sync", "最近变化和同步", "small")}
      </div>
      <div class="recent-status-grid">
        <article>
          ${i18nText("Last write", "最近写入")}
          <strong>${latestRecord ? relativeTimeElement(latestRecord.updated_at, data.generated_at) : escapeHtml("None")}</strong>
        </article>
        <article>
          ${i18nText("Latest source", "最近来源")}
          <strong ${i18nAttribute(latestSource, latestSourceZh)}>${escapeHtml(latestSource)}</strong>
        </article>
        <article>
          ${i18nText("Shared copy", "共享副本")}
          ${i18nText(shared.label, shared.zh, "strong")}
        </article>
        <article>
          ${i18nText("Saved for later", "稍后整理")}
          <strong ${i18nAttribute(reviewableLabel, reviewableZh)}>${escapeHtml(reviewableLabel)}</strong>
        </article>
      </div>
    </section>
  `;
}

function renderDashboardBody(data: DashboardData, options: Pick<DashboardRenderOptions, "showStoredContent"> = {}): string {
  const hasActionSignals = data.attention_items.some(isReviewAttentionItem);
  const actionSignalsPanel = hasActionSignals ? needsAttentionPanel(data.attention_items) : "";
  const hasPendingDecisions = data.decision_summary.total_decisions > 0;
  const shouldHideQuietInfoPanel = data.health.status === "sync_pending" || data.health.status === "conflict";
  const isAllClearOverview = data.dashboard_overview.headline === "All clear";
  const shortcutPanel = hasPendingDecisions || isAllClearOverview ? "" : actionBoard(data.action_board);
  const shouldRenderQuietInfoPanel = !hasActionSignals && !hasPendingDecisions && !shouldHideQuietInfoPanel && !isAllClearOverview;
  const quietInfoPanel = shouldRenderQuietInfoPanel ? needsAttentionPanel(data.attention_items) : "";
  const showBackgroundStatus = !hasPendingDecisions && !shouldHideQuietInfoPanel && !isAllClearOverview;
  const shouldPromoteStoreSignals = !hasPendingDecisions && !hasActionSignals && data.health.status === "sync_pending";
  const isSavedForLaterOverview = data.dashboard_overview.primary_action.source === "memory_inventory";
  const shouldRenderOverview = !isAllClearOverview && !isSavedForLaterOverview;
  const shouldRenderWorkLanes = !shouldPromoteStoreSignals && !isAllClearOverview && !isSavedForLaterOverview;
  const promotedStoreSignals = shouldPromoteStoreSignals ? promotedStoreSignalsPanel(data) : "";
  const healthLabelZh = dashboardHealthZh(data.health.status, data.health.label);
  return `
    <header>
      <div>
        <h1>Moryn Dashboard</h1>
        <p class="store-path" title="${escapeHtml(data.store.path)}" data-i18n-en="Local memory" data-i18n-zh="本机记忆">Local memory</p>
        <p class="dashboard-generated-at"><time datetime="${escapeHtml(data.generated_at)}" title="${escapeHtml(data.generated_at)}">${escapeHtml(dashboardGeneratedAtLabel(data.generated_at))}</time></p>
      </div>
      <div class="dashboard-header-actions">
        <span class="health-badge ${healthClass(data.health.status)}" ${i18nAttribute(data.health.label, healthLabelZh)}>${escapeHtml(data.health.label)}</span>
        ${dashboardLanguageToggle()}
      </div>
    </header>

    ${dashboardStatusSummary(data, { hideHealthyLine: isAllClearOverview || isSavedForLaterOverview })}

    <section id="last-action-receipt" class="panel last-action-receipt" data-action-receipt-anchor aria-live="polite" hidden></section>

    ${statusBoard(data)}

    ${shouldRenderOverview ? dashboardOverview(data.dashboard_overview, { showBackgroundStatus, showSafety: true }) : ""}

    ${dashboardDecisionPanel(data)}

    ${dashboardGlanceBoard(data)}

    ${options.showStoredContent === true ? storedContentPanel(data) : ""}

    ${memoryInventoryPanel(data.memory_inventory)}

    ${recentStatusPanel(data)}

    ${shouldRenderWorkLanes ? dashboardWorkLanes(data, { showBackgroundLanes: !hasPendingDecisions }) : ""}

    ${promotedStoreSignals}

    ${decisionSummary(data.decision_summary)}

    ${actionSignalsPanel}

    ${maintenanceReviewQueue(data.maintenance.plans)}

    ${captureInbox(data.capture_inbox)}

    ${quietInfoPanel}

    ${isSavedForLaterOverview ? "" : shortcutPanel}

    ${evidenceLibrary(data, {
      includeStoreSignals: !shouldPromoteStoreSignals,
      showEvidenceIndex: !hasPendingDecisions,
      compactBackground: shouldPromoteStoreSignals || isAllClearOverview || isSavedForLaterOverview,
      auditOnly: hasPendingDecisions
    })}
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
          if (window.shouldPauseStoredContentRefresh?.()) return;
          const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
          const response = await fetch("fragment", { cache: "no-store" });
          if (!response.ok) return;
          main.innerHTML = await response.text();
          restoreDetailState(detailState);
          window.applyDashboardLanguage?.();
          window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
          window.restoreActionReceipt?.();
        } catch {
          // Keep the last successful render visible if a refresh fails.
        }
      };
      window.setInterval(refresh, interval);
    })();
  </script>`;
}

function dashboardLanguageScript(): string {
  return `
  <script>
    (() => {
      const key = "moryn.dashboard.language";
      const staticTranslations = new Map([
        ["Background checks", "后台检查"],
        ["Check details", "检查详情"],
        ["Routine checks", "日常检查"],
        ["Info", "信息"],
        ["Warning", "警告"],
        ["Critical", "严重"],
        ["Quarantined records superseded", "隔离内容已有安全替代"],
        ["Temporary notes waiting", "临时笔记待整理"],
        ["Many recently saved items", "较多最近保存内容"],
        ["Session notes not remembered", "会话笔记未记住"],
        ["Many items to organize", "较多内容待整理"],
        ["Full evidence stays in /api/dashboard.", "完整依据保留在 /api/dashboard。"],
        ["Health checks", "健康检查"],
        ["Product notes", "产品记录"],
        ["Safety checks", "安全检查"],
        ["Saved notes", "已保存内容"],
        ["History", "历史记录"],
        ["Health Checks", "健康检查"],
        ["Saved Notes", "已保存内容"],
        ["Safety Checks", "安全检查"],
        ["Product Notes", "产品记录"],
        ["Cleanup Checks", "清理检查"],
        ["Shared Copy", "共享副本"],
        ["Health check", "健康检查"],
        ["Recall check", "召回检查"],
        ["Handoff context", "交接上下文"],
        ["Cleanup checks", "清理检查"],
        ["Capture checks", "捕获检查"],
        ["Recent value", "最近重点"],
        ["Recent records", "最近记录"],
        ["Recent events", "最近事件"],
        ["Shared copy", "共享副本"],
        ["Routine checks indexed", "常规检查已建立索引"],
        ["Saved notes indexed", "已保存内容已建立索引"],
        ["Safety checks indexed", "安全检查已建立索引"],
        ["Product notes indexed", "产品记录已建立索引"],
        ["Cleanup checks indexed", "清理检查已建立索引"],
        ["Shared copy indexed", "共享副本已建立索引"],
        ["History indexed", "历史记录已建立索引"]
      ]);
      const validLanguage = (value) => value === "zh" ? "zh" : "en";
      const selectedLanguage = () => validLanguage(localStorage.getItem(key));
      const legacyTranslationScopes = "[data-dashboard-detail='attention-info-checks'], [data-reference-library-index]";
      const translateStaticText = (text) => {
        if (staticTranslations.has(text)) return staticTranslations.get(text);
        const routineMatch = text.match(/^(\\d+) routine check(s)?$/);
        if (routineMatch) return routineMatch[1] + " 项日常检查";
        const supersededMatch = text.match(/^(\\d+) quarantined record\\(s\\) have active safe replacement index records\\.$/);
        if (supersededMatch) return supersededMatch[1] + " 条隔离内容已有可用的安全替代索引。";
        const rawMatch = text.match(/^(\\d+) raw record\\(s\\) are preserved but excluded from normal recall\\.$/);
        if (rawMatch) return rawMatch[1] + " 条临时内容已保留，但不会进入日常回忆。";
        const candidateMatch = text.match(/^(\\d+) candidate record\\(s\\) may need promotion, archival, or cleanup\\.$/);
        if (candidateMatch) return candidateMatch[1] + " 条新内容可能需要记住、归档或清理。";
        return text;
      };
      const translateMixedLegacyText = (node, language) => {
        const original = node.dataset.i18nOriginal || node.textContent || "";
        if (!node.dataset.i18nOriginal) node.dataset.i18nOriginal = original;
        const mixedCopy = new Map([
          ["Full evidence stays in /api/dashboard.", {
            enBefore: "Full evidence stays in ",
            enAfter: ".",
            zhBefore: "完整依据保留在 ",
            zhAfter: "。"
          }],
          ["Open /api/dashboard for full routine diagnostic reports, commands, and evidence paths.", {
            enBefore: "Open ",
            enAfter: " for full routine diagnostic reports, commands, and evidence paths.",
            zhBefore: "打开 ",
            zhAfter: " 可查看完整日常诊断报告、命令和依据路径。"
          }]
        ]);
        const copy = mixedCopy.get(original);
        if (!copy) return false;
        const code = node.querySelector("code");
        if (language === "zh") {
          if (code) {
            node.replaceChildren(copy.zhBefore, code, copy.zhAfter);
            return true;
          }
          node.textContent = copy.zhBefore + "/api/dashboard" + copy.zhAfter;
          return true;
        }
        if (code) {
          node.replaceChildren(copy.enBefore, code, copy.enAfter);
          return true;
        }
        node.innerHTML = copy.enBefore + '<code>/api/dashboard</code>' + copy.enAfter;
        return true;
      };
      const translateLegacyText = (root, language) => {
        const scopes = [
          ...(root.matches?.(legacyTranslationScopes) ? [root] : []),
          ...root.querySelectorAll(legacyTranslationScopes)
        ];
        scopes.forEach((scope) => {
          scope.querySelectorAll("span, strong, small, p, code").forEach((node) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.matches("[data-i18n-en][data-i18n-zh]")) return;
            if (node.children.length > 0 && !translateMixedLegacyText(node, language)) return;
            if (node.children.length > 0) return;
            const original = node.dataset.i18nOriginal || node.textContent || "";
            const translated = translateStaticText(original);
            if (translated === original && !node.dataset.i18nOriginal) return;
            if (!node.dataset.i18nOriginal) node.dataset.i18nOriginal = original;
            node.textContent = language === "zh" ? translated : original;
          });
        });
      };
      const apply = (language = selectedLanguage()) => {
        document.documentElement.lang = language === "zh" ? "zh" : "en";
        document.querySelectorAll("[data-i18n-en][data-i18n-zh]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          node.textContent = language === "zh" ? node.dataset.i18nZh || "" : node.dataset.i18nEn || "";
        });
        document.querySelectorAll("[data-i18n-placeholder-en][data-i18n-placeholder-zh]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          node.setAttribute("placeholder", language === "zh" ? node.dataset.i18nPlaceholderZh || "" : node.dataset.i18nPlaceholderEn || "");
        });
        document.querySelectorAll("[data-i18n-aria-label-en][data-i18n-aria-label-zh]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          node.setAttribute("aria-label", language === "zh" ? node.dataset.i18nAriaLabelZh || "" : node.dataset.i18nAriaLabelEn || "");
        });
        if (document.body) translateLegacyText(document.body, language);
        document.querySelectorAll("[data-dashboard-language-option]").forEach((node) => {
          if (!(node instanceof HTMLButtonElement)) return;
          const active = node.dataset.dashboardLanguageOption === language;
          node.classList.toggle("active", active);
          node.setAttribute("aria-pressed", active ? "true" : "false");
        });
      };
      window.applyDashboardLanguage = () => apply();
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const option = target.closest("[data-dashboard-language-option]");
        if (!(option instanceof HTMLElement)) return;
        const language = validLanguage(option.dataset.dashboardLanguageOption);
        localStorage.setItem(key, language);
        apply(language);
      });
      apply();
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
        const feedback = document.querySelector("[data-dashboard-action-feedback]");
        const target = findDashboardTarget(targetId);
        if (!target) {
          if (feedback instanceof HTMLElement) {
            feedback.hidden = false;
            feedback.textContent = document.documentElement.lang === "zh"
              ? feedback.dataset.i18nZh || "这里暂时没有可打开的内容。"
              : feedback.dataset.i18nEn || "Nothing to open here yet.";
          }
          return;
        }
        if (feedback instanceof HTMLElement) feedback.hidden = true;
        if (target instanceof HTMLDetailsElement) {
          target.open = true;
        }
        if (target.matches("[data-stored-content]")) {
          window.openStoredContentPanel?.();
        }
        target.classList.add("dashboard-target-active");
        window.setTimeout(() => target.classList.remove("dashboard-target-active"), 1800);
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

function dashboardStoredContentScript(): string {
  return `
  <script>
    (() => {
      const storedContentKey = "moryn.dashboard.storedContentState";
      const defaultStoredContentState = () => ({
        overflowOpen: false,
        searchOpen: true,
        searchQuery: "",
        searchStateFilter: "all",
        searchSourceFilter: "all",
        storedContentFilter: "all",
        selectedItemId: null
      });
      let fallbackStoredContentState = defaultStoredContentState();
      const normalizeStoredContentState = (value) => ({
        overflowOpen: value?.overflowOpen === true,
        searchOpen: value?.searchOpen !== false,
        searchQuery: typeof value?.searchQuery === "string" ? value.searchQuery : "",
        searchStateFilter: typeof value?.searchStateFilter === "string" && value.searchStateFilter.length > 0 ? value.searchStateFilter : "all",
        searchSourceFilter: typeof value?.searchSourceFilter === "string" && value.searchSourceFilter.length > 0 ? value.searchSourceFilter : "all",
        storedContentFilter: typeof value?.storedContentFilter === "string" && value.storedContentFilter.length > 0 ? value.storedContentFilter : "all",
        selectedItemId: typeof value?.selectedItemId === "string" && value.selectedItemId.length > 0 ? value.selectedItemId : null
      });
      const readStoredContentState = () => {
        try {
          const stored = sessionStorage.getItem(storedContentKey);
          fallbackStoredContentState = stored ? normalizeStoredContentState(JSON.parse(stored)) : fallbackStoredContentState;
          return fallbackStoredContentState;
        } catch {
          sessionStorage.removeItem(storedContentKey);
          return fallbackStoredContentState;
        }
      };
      const writeStoredContentState = (patch) => {
        const next = normalizeStoredContentState({ ...readStoredContentState(), ...patch });
        fallbackStoredContentState = next;
        try {
          sessionStorage.setItem(storedContentKey, JSON.stringify(next));
        } catch {
          // Keep the in-memory fallback for storage-restricted browser modes.
        }
        return next;
      };
      const cssEscape = (value) => window.CSS?.escape ? window.CSS.escape(value) : value.replaceAll("\\\\", "\\\\\\\\").replaceAll('"', '\\"');
      const selectedLanguage = () => document.documentElement.lang === "zh" ? "zh" : "en";
      const labelFor = (button, expanded) => {
        const language = selectedLanguage();
        if (expanded) return language === "zh" ? button.dataset.storedContentExpandedZh || "收起" : button.dataset.storedContentExpandedEn || "Show fewer";
        return language === "zh" ? button.dataset.storedContentCollapsedZh || button.dataset.i18nZh || "查看更多" : button.dataset.storedContentCollapsedEn || button.dataset.i18nEn || "View more";
      };
      const controlledElementFor = (button) => {
        const section = button.closest("[data-stored-content]");
        const controlId = button.getAttribute("aria-controls");
        return controlId && section instanceof HTMLElement ? section.querySelector("#" + cssEscape(controlId)) : null;
      };
      const setOverflowState = (state) => {
        document.querySelectorAll("[data-stored-content-more]").forEach((node) => {
          if (!(node instanceof HTMLButtonElement)) return;
          const overflow = controlledElementFor(node);
          if (!(overflow instanceof HTMLElement)) return;
          node.setAttribute("aria-expanded", state.overflowOpen ? "true" : "false");
          overflow.hidden = !state.overflowOpen;
          node.textContent = labelFor(node, state.overflowOpen);
        });
      };
      const setStoredFilterButtons = (state) => {
        document.querySelectorAll("[data-stored-content-filter]").forEach((node) => {
          if (!(node instanceof HTMLButtonElement)) return;
          const active = node.dataset.storedContentFilter === state.storedContentFilter;
          node.classList.toggle("active", active);
          node.setAttribute("aria-pressed", active ? "true" : "false");
        });
      };
      const filterStoredContent = (state) => {
        let visible = 0;
        document.querySelectorAll("[data-stored-content-item]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          const matches = state.storedContentFilter === "all" || String(state.storedContentFilter || "").split(",").includes(node.dataset.storedContentState || "");
          node.hidden = !matches;
          if (matches) visible += 1;
        });
        document.querySelectorAll("[data-stored-content-count]").forEach((node) => {
          if (node instanceof HTMLElement) node.textContent = visible + " shown";
        });
        setStoredFilterButtons(state);
      };
      const setDetailText = (selector, value) => {
        document.querySelectorAll(selector).forEach((node) => {
          if (node instanceof HTMLElement) node.textContent = value || "";
        });
      };
      const setMemoryExplorerSelection = (item) => {
        const selectedId = item instanceof HTMLElement ? item.dataset.memoryExplorerItemId || item.dataset.storedContentItem || item.dataset.memorySearchEntry || "" : "";
        document.querySelectorAll("[data-stored-content-item], [data-memory-search-entry]").forEach((node) => {
          if (node instanceof HTMLElement) {
            node.classList.toggle("selected", item instanceof HTMLElement && selectedId.length > 0 && node.dataset.memoryExplorerItemId === selectedId);
          }
        });
      };
      const setLocalizedDetailText = (node, value, zhValue = value) => {
        if (!(node instanceof HTMLElement)) return;
        node.dataset.i18nEn = value || "";
        node.dataset.i18nZh = zhValue || "";
        node.textContent = selectedLanguage() === "zh" ? zhValue || "" : value || "";
      };
      const resetMemoryExplorerDetail = () => {
        document.querySelectorAll("[data-memory-explorer-detail]").forEach((detail) => {
          if (!(detail instanceof HTMLElement)) return;
          const detailTitle = detail.querySelector("[data-memory-explorer-detail-title]");
          const detailText = detail.querySelector("[data-memory-explorer-detail-text]");
          const detailGrid = detail.querySelector("[data-memory-explorer-detail-grid]");
          const guidance = detail.querySelector("[data-memory-explorer-guidance]");
          const trace = detail.querySelector("[data-memory-explorer-trace]");
          if (detailTitle instanceof HTMLElement) {
            detailTitle.dataset.i18nEn = "Select an item";
            detailTitle.dataset.i18nZh = "选择一条内容";
            detailTitle.textContent = selectedLanguage() === "zh" ? "选择一条内容" : "Select an item";
          }
          if (detailText instanceof HTMLElement) {
            detailText.dataset.i18nEn = "Select a saved item to read its full text, source, and status.";
            detailText.dataset.i18nZh = "选择一条保存内容，可查看全文、来源和状态。";
            detailText.textContent = selectedLanguage() === "zh" ? "选择一条保存内容，可查看全文、来源和状态。" : "Select a saved item to read its full text, source, and status.";
          }
          setDetailText("[data-memory-explorer-detail-state]", "");
          setDetailText("[data-memory-explorer-detail-source]", "");
          setDetailText("[data-memory-explorer-detail-updated]", "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-why]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-next-step]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-next-step-detail]"), "");
          setDetailText("[data-memory-explorer-detail-timeline]", "");
          setDetailText("[data-memory-explorer-detail-recall]", "");
          if (detailGrid instanceof HTMLElement) detailGrid.hidden = true;
          if (guidance instanceof HTMLElement) guidance.hidden = true;
          if (trace instanceof HTMLElement) trace.hidden = true;
        });
        setMemoryExplorerSelection(null);
        writeStoredContentState({ selectedItemId: null });
      };
      const visibleMemoryExplorerItem = (section = document) => {
        return Array.from(section.querySelectorAll("[data-stored-content-item], [data-memory-search-entry]")).find((node) => {
          return node instanceof HTMLElement && !node.hidden && node.offsetParent !== null;
        });
      };
      const selectMemoryExplorerItem = (item) => {
        if (!(item instanceof HTMLElement)) return;
        const detail = item.closest("[data-memory-explorer]")?.querySelector("[data-memory-explorer-detail]");
        if (!(detail instanceof HTMLElement)) return;
        const detailTitle = detail.querySelector("[data-memory-explorer-detail-title]");
        const detailText = detail.querySelector("[data-memory-explorer-detail-text]");
        const detailState = detail.querySelector("[data-memory-explorer-detail-state]");
        const detailUpdated = detail.querySelector("[data-memory-explorer-detail-updated]");
        const detailWhy = detail.querySelector("[data-memory-explorer-detail-why]");
        const detailNextStep = detail.querySelector("[data-memory-explorer-detail-next-step]");
        const detailNextStepDetail = detail.querySelector("[data-memory-explorer-detail-next-step-detail]");
        const detailGrid = detail.querySelector("[data-memory-explorer-detail-grid]");
        const guidance = detail.querySelector("[data-memory-explorer-guidance]");
        const trace = detail.querySelector("[data-memory-explorer-trace]");
        setLocalizedDetailText(detailTitle, item.dataset.memoryExplorerTitle || "Saved item");
        setLocalizedDetailText(detailText, item.dataset.memoryExplorerFullText || item.textContent || "", item.dataset.memoryExplorerFullTextZh || item.dataset.memoryExplorerFullText || item.textContent || "");
        setLocalizedDetailText(detailState, item.dataset.memoryExplorerStateEn || item.dataset.memoryExplorerState || "", item.dataset.memoryExplorerStateZh || item.dataset.memoryExplorerState || "");
        const hasGuidance = item.dataset.memoryExplorerHasGuidance !== "false" && (item.dataset.memoryExplorerWhySaved || item.dataset.memoryExplorerNextStep);
        setLocalizedDetailText(detailWhy, item.dataset.memoryExplorerWhySaved || "", item.dataset.memoryExplorerWhySavedZh || item.dataset.memoryExplorerWhySaved || "");
        setLocalizedDetailText(detailNextStep, item.dataset.memoryExplorerNextStep || "", item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerNextStep || "");
        setLocalizedDetailText(detailNextStepDetail, item.dataset.memoryExplorerNextStepDetail || "", item.dataset.memoryExplorerNextStepDetailZh || item.dataset.memoryExplorerNextStepDetail || "");
        setDetailText("[data-memory-explorer-detail-source]", item.dataset.memoryExplorerSource || "");
        setLocalizedDetailText(detailUpdated, item.dataset.memoryExplorerUpdated || "", item.dataset.memoryExplorerUpdatedZh || item.dataset.memoryExplorerUpdated || "");
        setDetailText("[data-memory-explorer-detail-timeline]", item.dataset.memoryExplorerTimeline || "");
        setDetailText("[data-memory-explorer-detail-recall]", item.dataset.memoryExplorerRecall || "");
        if (detailGrid instanceof HTMLElement) detailGrid.hidden = false;
        if (guidance instanceof HTMLElement) guidance.hidden = !hasGuidance;
        if (trace instanceof HTMLElement) trace.hidden = false;
        setMemoryExplorerSelection(item);
        writeStoredContentState({ selectedItemId: item.dataset.memoryExplorerItemId || item.dataset.storedContentItem || item.dataset.memorySearchEntry || null });
      };
      const restoreMemoryExplorerSelection = (state) => {
        const selected = state.selectedItemId ? document.querySelector(\`[data-memory-explorer-item-id="\${cssEscape(state.selectedItemId)}"]\`) : null;
        if (selected instanceof HTMLElement && !selected.hidden && selected.offsetParent !== null) {
          selectMemoryExplorerItem(selected);
          return;
        }
        const firstVisible = visibleMemoryExplorerItem();
        if (firstVisible instanceof HTMLElement) {
          selectMemoryExplorerItem(firstVisible);
          return;
        }
        resetMemoryExplorerDetail();
      };
      const currentSearchFilters = (state) => ({
        query: String(state.searchQuery || ""),
        state: state.searchStateFilter || "all",
        source: state.searchSourceFilter || "all"
      });
      const normalizeMemoryStateQuery = (value) => {
        const normalized = String(value || "").toLowerCase();
        if (normalized === "remembered") return "canonical";
        if (normalized === "to-organize" || normalized === "organize") return "candidate";
        if (normalized === "session-notes" || normalized === "session") return "raw";
        if (normalized === "set-aside") return "archived";
        return normalized;
      };
      const parseMemorySearchQuery = (query) => {
        const parsed = {
          terms: [],
          source: "",
          state: "",
          type: "",
          recentDays: 0
        };
        const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
        for (const token of tokens) {
          const commandMatch = token.match(/^([a-z]+):(.+)$/);
          if (!commandMatch) {
            parsed.terms.push(token);
            continue;
          }
          const [, command, value] = commandMatch;
          if (command === "source") {
            parsed.source = value;
            continue;
          }
          if (command === "state" || command === "status") {
            parsed.state = normalizeMemoryStateQuery(value);
            continue;
          }
          if (command === "type" || command === "kind") {
            parsed.type = value;
            continue;
          }
          if (command === "recent") {
            parsed.recentDays = Number(value.replace(/d$/, ""));
            if (!Number.isFinite(parsed.recentDays) || parsed.recentDays <= 0) parsed.recentDays = 0;
            continue;
          }
          parsed.terms.push(token);
        }
        return parsed;
      };
      const entryIsRecent = (entry, recentDays, nowIso) => {
        const updatedAt = Date.parse(entry.dataset.memorySearchUpdatedAt || "");
        const now = Date.parse(nowIso || "");
        if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) return false;
        return Math.max(0, now - updatedAt) <= recentDays * 24 * 60 * 60 * 1000;
      };
      const setMemorySearchStatus = (status, count, filtered) => {
        if (!(status instanceof HTMLElement)) return;
        status.dataset.i18nEn = filtered ? count + (count === 1 ? " item shown" : " items shown") : count + (count === 1 ? " item" : " items") + " to search";
        status.dataset.i18nZh = filtered ? \`显示 \${count} 条内容\` : \`可搜索 \${count} 条内容\`;
        status.textContent = selectedLanguage() === "zh" ? status.dataset.i18nZh : status.dataset.i18nEn;
      };
      const setMemorySearchMixItem = (item, count) => {
        if (!(item instanceof HTMLElement)) return;
        const singular = item.dataset.i18nSingularEn || item.dataset.i18nLabelEn || "";
        const plural = item.dataset.i18nPluralEn || singular;
        const zhLabel = item.dataset.i18nLabelZh || "";
        item.dataset.i18nEn = count + " " + (count === 1 ? singular : plural);
        item.dataset.i18nZh = count + " 条" + zhLabel;
        item.textContent = selectedLanguage() === "zh" ? item.dataset.i18nZh : item.dataset.i18nEn;
      };
      const updateMemorySearchMix = (panel, visibleEntries) => {
        const counts = {};
        const stateSelect = panel.querySelector("[data-memory-search-state]");
        const selectedState = stateSelect instanceof HTMLSelectElement ? stateSelect.value : "all";
        for (const entry of visibleEntries) {
          if (!(entry instanceof HTMLElement)) continue;
          const key = entry.dataset.memorySearchState || "event";
          counts[key] = (counts[key] || 0) + 1;
        }
        panel.querySelectorAll("[data-memory-search-mix-item]").forEach((item) => {
          if (!(item instanceof HTMLElement)) return;
          const count = counts[item.dataset.memorySearchMixItem || ""] || 0;
          item.hidden = count === 0;
          item.setAttribute("aria-pressed", selectedState === item.dataset.memorySearchMixFilter ? "true" : "false");
          item.classList.toggle("active", selectedState === item.dataset.memorySearchMixFilter);
          setMemorySearchMixItem(item, count);
        });
      };
      const filterMemorySearch = (panel, filters) => {
        const normalizedQuery = String(filters.query || "").trim().toLowerCase();
        const parsed = parseMemorySearchQuery(normalizedQuery);
        const entries = Array.from(panel.querySelectorAll("[data-memory-search-entry]"));
        let visible = 0;
        const visibleEntries = [];
        for (const entry of entries) {
          if (!(entry instanceof HTMLElement)) continue;
          const text = entry.dataset.memorySearchText || entry.textContent || "";
          const searchableText = text.toLowerCase();
          const matchesQuery = parsed.terms.length === 0 || parsed.terms.every((term) => searchableText.includes(term));
          const matchesState = filters.state === "all" || entry.dataset.memorySearchState === filters.state;
          const matchesSource = filters.source === "all" || entry.dataset.memorySearchSource === filters.source;
          const matchesCommandSource = !parsed.source || String(entry.dataset.memorySearchSource || "").toLowerCase() === parsed.source;
          const matchesCommandState = !parsed.state || entry.dataset.memorySearchState === parsed.state;
          const matchesCommandType = !parsed.type || [entry.dataset.memorySearchKind, entry.dataset.memorySearchRecordType, entry.dataset.memorySearchState].some((value) => String(value || "").toLowerCase() === parsed.type);
          const matchesRecent = !parsed.recentDays || entryIsRecent(entry, parsed.recentDays, panel.dataset.memorySearchNow || "");
          const matches = matchesQuery && matchesState && matchesSource && matchesCommandSource && matchesCommandState && matchesCommandType && matchesRecent;
          entry.hidden = !matches;
          if (matches) {
            visible += 1;
            visibleEntries.push(entry);
          }
        }
        const status = panel.querySelector("[data-memory-search-status]");
        const filtered = normalizedQuery.length > 0 || filters.state !== "all" || filters.source !== "all";
        setMemorySearchStatus(status, filtered ? visible : entries.length, filtered);
        updateMemorySearchMix(panel, filtered ? visibleEntries : entries);
      };
      const setSearchState = (state, options = {}) => {
        document.querySelectorAll("[data-memory-search-panel]").forEach((panel) => {
          if (!(panel instanceof HTMLElement)) return;
          const input = panel.querySelector("[data-memory-search-input]");
          if (input instanceof HTMLInputElement) {
            if (input.value !== state.searchQuery) input.value = state.searchQuery;
            if (options.focusSearch === true) input.focus();
          }
          const stateSelect = panel.querySelector("[data-memory-search-state]");
          if (stateSelect instanceof HTMLSelectElement) stateSelect.value = state.searchStateFilter || "all";
          const sourceSelect = panel.querySelector("[data-memory-search-source]");
          if (sourceSelect instanceof HTMLSelectElement) sourceSelect.value = state.searchSourceFilter || "all";
          filterMemorySearch(panel, { ...currentSearchFilters(state) });
        });
      };
      const setStoredContentActive = () => {
        document.querySelectorAll("[data-stored-content]").forEach((section) => {
          if (!(section instanceof HTMLElement)) return;
          section.classList.add("stored-content-active");
          window.setTimeout(() => section.classList.remove("stored-content-active"), 1800);
        });
      };
      const applyStoredContentState = (options = {}) => {
        const state = readStoredContentState();
        setOverflowState(state);
        filterStoredContent(state);
        setSearchState(state, options);
        restoreMemoryExplorerSelection(state);
        if (options.highlight === true) setStoredContentActive();
      };
      window.restoreStoredContentState = applyStoredContentState;
      window.openStoredContentSearch = () => {
        writeStoredContentState({ searchOpen: true });
        applyStoredContentState({ focusSearch: true });
      };
      window.openStoredContentPanel = () => {
        writeStoredContentState({ overflowOpen: true });
        applyStoredContentState({ highlight: true });
      };
      window.shouldPauseStoredContentRefresh = () => {
        const state = readStoredContentState();
        const active = document.activeElement;
        const hasSearchFocus = active instanceof HTMLInputElement && active.matches("[data-memory-search-input]");
        return state.searchOpen === true && (String(state.searchQuery || "").trim().length > 0 || hasSearchFocus);
      };
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const explorerTrigger = target.closest("[data-memory-explorer-open], [data-stored-content-item], [data-memory-search-entry]");
        if (explorerTrigger instanceof HTMLElement) {
          const item = explorerTrigger.matches("[data-stored-content-item], [data-memory-search-entry]") ? explorerTrigger : explorerTrigger.closest("[data-stored-content-item], [data-memory-search-entry]");
          if (item instanceof HTMLElement) selectMemoryExplorerItem(item);
          return;
        }
        const memoryStateFilter = target.closest("[data-memory-state-filter]");
        if (memoryStateFilter instanceof HTMLElement) {
          writeStoredContentState({ overflowOpen: true, storedContentFilter: memoryStateFilter.dataset.memoryStateFilter || "all" });
          applyStoredContentState({ highlight: true });
          document.querySelector("[data-stored-content]")?.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const glanceFilter = target.closest("[data-glance-filter]");
        if (glanceFilter instanceof HTMLElement) {
          writeStoredContentState({ overflowOpen: true, storedContentFilter: glanceFilter.dataset.glanceFilter || "all" });
          applyStoredContentState({ highlight: true });
          document.querySelector("[data-stored-content]")?.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const glanceSource = target.closest("[data-glance-source]");
        if (glanceSource instanceof HTMLElement) {
          writeStoredContentState({ overflowOpen: true, storedContentFilter: "all", searchOpen: true, searchSourceFilter: glanceSource.dataset.glanceSource || "all" });
          applyStoredContentState({ highlight: true });
          document.querySelector("[data-stored-content]")?.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const mixItem = target.closest("[data-memory-search-mix-filter]");
        if (mixItem instanceof HTMLElement) {
          writeStoredContentState({ searchStateFilter: mixItem.dataset.memorySearchMixFilter || "all", searchOpen: true });
          applyStoredContentState({ focusSearch: true });
          return;
        }
        const chip = target.closest("[data-memory-search-chip]");
        if (chip instanceof HTMLElement) {
          writeStoredContentState({ searchQuery: chip.dataset.memorySearchChip || "", searchStateFilter: "all", searchSourceFilter: "all", searchOpen: true });
          applyStoredContentState({ focusSearch: true });
          return;
        }
        const storedFilter = target.closest("[data-stored-content-filter]");
        if (storedFilter instanceof HTMLButtonElement) {
          writeStoredContentState({ storedContentFilter: storedFilter.dataset.storedContentFilter || "all" });
          applyStoredContentState();
          return;
        }
        const button = target.closest("[data-stored-content-more]");
        if (!(button instanceof HTMLButtonElement)) return;
        const overflow = controlledElementFor(button);
        if (!(overflow instanceof HTMLElement)) return;
        const willOpen = !readStoredContentState().overflowOpen;
        writeStoredContentState({ overflowOpen: willOpen });
        applyStoredContentState();
        if (willOpen) overflow.scrollIntoView({ block: "nearest", behavior: "smooth" });
      });
      document.addEventListener("input", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || !target.matches("[data-memory-search-input]")) return;
        const panel = target.closest("[data-memory-search-panel]");
        if (!(panel instanceof HTMLElement)) return;
        const query = target.value.trim().toLowerCase();
        writeStoredContentState({ searchQuery: query, searchOpen: true });
        filterMemorySearch(panel, currentSearchFilters(readStoredContentState()));
      });
      document.addEventListener("change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLSelectElement)) return;
        const panel = target.closest("[data-memory-search-panel]");
        if (!(panel instanceof HTMLElement)) return;
        if (target.matches("[data-memory-search-state]")) {
          writeStoredContentState({ searchStateFilter: target.value, searchOpen: true });
          filterMemorySearch(panel, currentSearchFilters(readStoredContentState()));
          return;
        }
        if (target.matches("[data-memory-search-source]")) {
          writeStoredContentState({ searchSourceFilter: target.value, searchOpen: true });
          filterMemorySearch(panel, currentSearchFilters(readStoredContentState()));
        }
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const item = target.closest("[data-stored-content-item], [data-memory-search-entry]");
        if (!(item instanceof HTMLElement)) return;
        event.preventDefault();
        selectMemoryExplorerItem(item);
      });
      applyStoredContentState();
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
      const i18nPair = (tag, en, zh, className = "") => \`<\${tag}\${className ? \` class="\${className}"\` : ""} data-i18n-en="\${htmlEscape(en)}" data-i18n-zh="\${htmlEscape(zh)}">\${htmlEscape(en)}</\${tag}>\`;
      const pluralize = (count, singular, plural = singular + "s") => count + " " + (count === 1 ? singular : plural);
      const pluralizeZh = (count, noun) => count + " " + noun;
      const changedLabel = (count) => pluralize(count, "record updated", "records updated");
      const changedLabelZh = (count) => pluralizeZh(count, "条记录已更新");
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
      const decisionLabelZh = (result) => {
        const status = String(result.status || "");
        if (result.plan_id) return "你已批准 Review Queue 计划。";
        if (result.surface === "candidate_triage" && status === "approved") return "你已批准候选内容提升草稿。";
        if (result.group_id) {
          if (status === "rejected") return "你已拒绝 Capture Inbox 分组。";
          if (status === "approved") return "你已批准 Capture Inbox 分组。";
          return "你已处理 Capture Inbox 分组。";
        }
        if (status === "rejected") return "你已拒绝 Capture Inbox 候选内容。";
        if (status === "approved") return "你已批准 Capture Inbox 候选内容。";
        return "你已确认 dashboard 操作。";
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
          zh_decision: decisionLabelZh(result),
          write_boundary: "Append-only events",
          zh_write_boundary: "追加事件",
          changed: changedLabel(changedCount),
          zh_changed: changedLabelZh(changedCount),
          audit_status: eventIds.length > 0 ? "Timeline ready" : "No trace id returned",
          zh_audit_status: eventIds.length > 0 ? "时间线已就绪" : "未返回追踪 id",
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
            \${i18nPair("span", "Action receipt", "操作回执", "action-receipt-title")}
            \${i18nPair("strong", "Store updated", "存储已更新")}
            <p data-i18n-en="\${htmlEscape(receipt.decision)}" data-i18n-zh="\${htmlEscape(receipt.zh_decision)}">\${htmlEscape(receipt.decision)}</p>
          </div>
          <div class="action-receipt-summary" aria-label="Action receipt summary">
            <span>\${i18nPair("strong", "Write boundary", "写入边界")}<small data-i18n-en="\${htmlEscape(receipt.write_boundary)}" data-i18n-zh="\${htmlEscape(receipt.zh_write_boundary)}">\${htmlEscape(receipt.write_boundary)}</small></span>
            <span>\${i18nPair("strong", "Changed", "已更新")}<small data-i18n-en="\${htmlEscape(receipt.changed)}" data-i18n-zh="\${htmlEscape(receipt.zh_changed)}">\${htmlEscape(receipt.changed)}</small></span>
            <span>\${i18nPair("strong", "Trace", "追踪")}<small data-i18n-en="\${htmlEscape(receipt.audit_status)}" data-i18n-zh="\${htmlEscape(receipt.zh_audit_status)}">\${htmlEscape(receipt.audit_status)}</small></span>
          </div>
          <details class="action-receipt-audit" data-dashboard-detail="action-receipt-audit">
            <summary class="dashboard-fold-summary">
              \${i18nPair("span", "Trace details", "追踪详情")}
              \${i18nPair("small", "Records and events", "记录和事件")}
            </summary>
            <dl class="action-receipt-grid">
              <div>\${i18nPair("dt", "Decision", "决定")}<dd data-i18n-en="\${htmlEscape(receipt.decision)}" data-i18n-zh="\${htmlEscape(receipt.zh_decision)}">\${htmlEscape(receipt.decision)}</dd></div>
              <div>\${i18nPair("dt", "Audit status", "追踪状态")}<dd data-i18n-en="\${htmlEscape(receipt.audit_status)}" data-i18n-zh="\${htmlEscape(receipt.zh_audit_status)}">\${htmlEscape(receipt.audit_status)}</dd></div>
              \${receipt.context.length > 0 ? \`<div>\${i18nPair("dt", "Context", "上下文")}<dd>\${receipt.context.map((value) => \`<code>\${htmlEscape(value)}</code>\`).join(" ")}</dd></div>\` : ""}
              \${receipt.record_ids.length > 0 ? \`<div>\${i18nPair("dt", "Records", "记录")}<dd>\${receipt.record_ids.map((recordId) => \`<code>\${htmlEscape(recordId)}</code>\`).join(" ")}</dd></div>\` : ""}
              \${receipt.event_ids.length > 0 ? \`<div>\${i18nPair("dt", "Events", "事件")}<dd>\${receipt.event_ids.map((eventId) => \`<code>\${htmlEscape(eventId)}</code>\`).join(" ")}</dd></div>\` : ""}
              <div class="action-receipt-commands">\${i18nPair("dt", "Trace commands", "追踪命令")}<dd>\${receipt.commands.length > 0 ? receipt.commands.map((command) => \`<code>\${htmlEscape(command)}</code>\`).join("") : i18nPair("span", "No read-only trace command returned.", "未返回只读追踪命令。")}</dd></div>
            </dl>
          </details>
        </div>
      \`;
      const renderReceiptInto = (target, receipt) => {
        if (!(target instanceof HTMLElement)) return;
        target.hidden = false;
        target.classList.add("action-receipt");
        target.innerHTML = receiptHtml(receipt);
        window.applyDashboardLanguage?.();
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
      window.renderActionReceipt = (result) => {
        if (!result || typeof result !== "object") return;
        const receipt = receiptFromResult(result);
        sessionStorage.setItem(receiptKey, JSON.stringify(receipt));
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
        const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        hideRejectedPlans();
        window.applyDashboardLanguage?.();
        window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
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
            status.textContent = "Applied. Receipt saved; refreshing dashboard...";
            window.renderActionReceipt?.(result);
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
        const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        window.applyDashboardLanguage?.();
        window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
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
            status.textContent = isReject ? "Rejected. Receipt saved; refreshing dashboard..." : "Approved. Receipt saved; refreshing dashboard...";
            window.renderActionReceipt?.(result);
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
        const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        window.applyDashboardLanguage?.();
        window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
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
            status.textContent = "Approved. Receipt saved; refreshing dashboard...";
            window.renderActionReceipt?.(result);
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

function renderDashboardShell(data: DashboardData, options: DashboardRenderOptions = {}): string {
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
      color-scheme: dark;
      --canvas: #050505;
      --surface: #101216;
      --surface-2: #161a20;
      --surface-3: #20262e;
      --surface-glass: rgba(13, 16, 21, 0.82);
      --ink: #f5f7fb;
      --ink-2: #dce3eb;
      --muted: #9da8b6;
      --subtle: #6f7a88;
      --border: #2b333d;
      --hairline: #202832;
      --signal-blue: #45b9ff;
      --signal-blue-soft: rgba(69, 185, 255, 0.14);
      --signal-green: #74f291;
      --signal-green-soft: rgba(116, 242, 145, 0.13);
      --signal-amber: #ffd166;
      --signal-amber-soft: rgba(255, 209, 102, 0.16);
      --signal-red: #ff5c74;
      --signal-red-soft: rgba(255, 92, 116, 0.15);
      --signal-violet: #d38cff;
      --signal-slate: #9aa6b2;
      --panel-glow: 0 0 0 1px rgba(116, 242, 145, 0.08), 0 24px 70px rgba(0, 0, 0, 0.46);
      --elevation-card: 0 18px 48px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.045);
      --text: var(--ink);
      --main: var(--surface);
      --accent: var(--signal-green);
      --accent-2: var(--signal-blue);
      --warning: var(--signal-amber);
      --critical: var(--signal-red);
      --good: var(--signal-green);
      --info: var(--signal-blue);
      --code: #0b0d10;
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    html, body { max-width: 100%; overflow-x: hidden; }
    body {
      margin: 0;
      background: linear-gradient(180deg, #050505 0, #0a0c0f 360px, var(--canvas) 100%);
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
    .health-badge { min-height: 32px; padding: 5px 13px; box-shadow: 0 12px 24px rgba(0, 0, 0, 0.3); }
    .dashboard-header-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .language-toggle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 3px 4px 3px 9px;
      background: rgba(16, 18, 22, 0.86);
      box-shadow: 0 12px 24px rgba(0, 0, 0, 0.28);
    }
    .language-toggle-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .language-options {
      display: inline-flex;
      gap: 3px;
    }
    .language-option {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 3px 7px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 790;
    }
    .language-option.active {
      border-color: rgba(116, 242, 145, 0.42);
      background: var(--signal-green);
      color: #061007;
    }
    .status-board-answers,
    .status-board-rail,
    .memory-inventory-grid,
    .recent-status-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 12px;
    }
    .status-board {
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
      background:
        linear-gradient(145deg, rgba(69, 185, 255, 0.08), rgba(116, 242, 145, 0.03) 42%, rgba(255, 255, 255, 0.012)),
        var(--surface-glass);
      box-shadow: var(--panel-glow);
    }
    .status-board-heading { margin-bottom: 10px; }
    .status-board-rail {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      margin-bottom: 10px;
    }
    .status-board-answers {
      grid-template-columns: 1.15fr 1fr 1fr;
      margin-bottom: 0;
    }
    .status-board-ticker {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      align-items: center;
      min-height: 44px;
      border: 1px solid rgba(112, 129, 149, 0.2);
      border-radius: 8px;
      padding: 7px 9px;
      margin-top: 10px;
      background:
        linear-gradient(90deg, rgba(255, 255, 255, 0.035), rgba(69, 185, 255, 0.028)),
        rgba(5, 7, 10, 0.58);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .status-board-ticker span {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      white-space: nowrap;
    }
    .status-board-ticker b {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
    }
    .status-board-ticker strong {
      min-width: 0;
      color: var(--ink);
      font-size: 12px;
      font-weight: 820;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-board-ticker time {
      color: inherit;
      font-size: inherit;
    }
    .status-board-explain {
      display: grid;
      gap: 4px;
      min-height: 58px;
      border: 1px solid rgba(69, 185, 255, 0.24);
      border-radius: 8px;
      padding: 10px 12px;
      margin-top: 10px;
      background:
        linear-gradient(90deg, rgba(69, 185, 255, 0.08), rgba(116, 242, 145, 0.026)),
        rgba(7, 9, 12, 0.52);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .status-board-explain span {
      color: #bde6ff;
      font-size: 12px;
      font-weight: 820;
    }
    .status-board-explain p {
      margin: 0;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .status-chip,
    .answer-card,
    .memory-inventory,
    .recent-status {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-glass);
      box-shadow: var(--elevation-card);
    }
    .status-chip,
    .answer-card {
      display: grid;
      gap: 4px;
      min-width: 0;
      border-left-width: 4px;
      padding: 12px;
    }
    .status-chip {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-rows: minmax(1.35em, auto) minmax(2.8em, auto) minmax(1.4em, auto);
      align-items: center;
      min-height: 76px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.035), rgba(255, 255, 255, 0.006)), var(--surface-glass);
      box-shadow: var(--elevation-card);
    }
    .status-chip span,
    .status-chip small { grid-column: 1; }
    .status-chip strong { grid-column: 2; grid-row: 1 / span 2; justify-self: end; text-align: right; }
    .status-chip.good { border-left-color: var(--good); }
    .status-chip.info { border-left-color: var(--info); }
    .status-chip.warning { border-left-color: var(--warning); }
    .status-chip.critical { border-left-color: var(--critical); }
    .answer-card {
      appearance: none;
      text-align: left;
      color: inherit;
      cursor: pointer;
      grid-template-rows: minmax(1.35em, auto) minmax(2.35em, auto) minmax(2.4em, auto) minmax(1.4em, auto) minmax(40px, auto);
      min-height: 148px;
      background:
        linear-gradient(145deg, rgba(255, 255, 255, 0.052), rgba(69, 185, 255, 0.025) 46%, rgba(255, 255, 255, 0.006)),
        var(--surface-glass);
      font: inherit;
      box-shadow: var(--elevation-card);
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .answer-card:hover {
      border-color: rgba(69, 185, 255, 0.38);
      background: linear-gradient(145deg, rgba(69, 185, 255, 0.085), rgba(116, 242, 145, 0.032)), rgba(14, 17, 23, 0.96);
      box-shadow: 0 22px 58px rgba(0, 0, 0, 0.44), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      transform: translateY(-1px);
    }
    .answer-card:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .answer-card.action.calm { border-left-color: var(--signal-blue); }
    .answer-card.action.good { border-left-color: var(--signal-green); }
    .answer-card.action.info { border-left-color: var(--signal-blue); }
    .answer-card.action.warning { border-left-color: var(--signal-amber); }
    .answer-card.action.critical { border-left-color: var(--signal-red); }
    .answer-card.memory { border-left-color: var(--signal-violet); }
    .answer-card.sync.good { border-left-color: var(--signal-green); }
    .answer-card.sync.info { border-left-color: var(--signal-blue); }
    .answer-card.sync.warning { border-left-color: var(--signal-amber); }
    .answer-card.sync.critical { border-left-color: var(--signal-red); }
    .answer-memory-mix {
      display: grid;
      gap: 6px;
      min-width: 0;
      min-height: 40px;
      align-self: end;
    }
    .answer-memory-track {
      display: flex;
      width: 100%;
      height: 8px;
      overflow: hidden;
      border: 1px solid rgba(112, 129, 149, 0.2);
      border-radius: 999px;
      background: rgba(4, 5, 7, 0.56);
    }
    .answer-memory-segment {
      display: block;
      min-width: 4px;
      height: 100%;
    }
    .answer-memory-counts {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      min-height: 20px;
      align-items: center;
    }
    .answer-memory-counts span {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      min-height: 18px;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 6px;
      padding: 1px 5px;
      background: rgba(8, 10, 13, 0.62);
      color: var(--muted);
      font-size: 10.5px;
      line-height: 1.2;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .status-chip span,
    .answer-card span,
    .memory-inventory-card span,
    .recent-status article span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .status-chip strong,
    .answer-card strong,
    .recent-status article strong {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.2;
      font-weight: 830;
      overflow-wrap: anywhere;
    }
    .answer-card strong {
      font-size: 20px;
      line-height: 1.1;
      font-weight: 850;
    }
    .answer-card-conclusion {
      margin: 0;
      min-height: 2.4em;
      color: var(--ink-2);
      font-size: 13px;
      line-height: 1.2;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .memory-inventory,
    .recent-status {
      padding: 14px;
      margin-bottom: 12px;
    }
    .section-heading {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 11px;
    }
    .section-heading h2 {
      margin: 0;
      font-size: 15px;
      font-weight: 800;
    }
    .memory-inventory-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-bottom: 10px;
    }
    .memory-inventory-card,
    .recent-status article {
      display: grid;
      gap: 4px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-radius: 8px;
      padding: 10px;
      background: var(--surface-2);
    }
    .memory-inventory-card {
      appearance: none;
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .memory-inventory-card:hover {
      border-color: rgba(69, 185, 255, 0.38);
      background:
        linear-gradient(145deg, rgba(69, 185, 255, 0.075), rgba(116, 242, 145, 0.025)),
        rgba(18, 23, 30, 0.96);
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.055);
      transform: translateY(-1px);
    }
    .memory-inventory-card:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-inventory-card strong {
      color: var(--ink);
      font-size: 24px;
      line-height: 1;
      font-weight: 850;
    }
    .memory-kind-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .memory-kind-strip span {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 3px 8px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 740;
    }
    .recent-status-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-bottom: 0;
    }
    .decision-panel,
    .stored-content {
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 12px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012)),
        rgba(12, 14, 18, 0.94);
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.36), inset 0 1px 0 rgba(255, 255, 255, 0.045);
    }
    .dashboard-target-active,
    .stored-content-active {
      border-color: rgba(116, 242, 145, 0.78);
      box-shadow: 0 0 0 1px rgba(116, 242, 145, 0.32), 0 20px 52px rgba(0, 0, 0, 0.42), 0 0 34px rgba(116, 242, 145, 0.13), inset 0 1px 0 rgba(255, 255, 255, 0.06);
    }
    .decision-panel-list {
      display: grid;
      gap: 10px;
    }
    .decision-panel-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 11px;
      background: var(--surface-2);
    }
    .decision-panel-item.write { border-left-color: var(--signal-amber); }
    .decision-panel-item.review { border-left-color: var(--signal-blue); }
    .decision-panel-item span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 780;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .decision-panel-item strong {
      display: block;
      margin-top: 3px;
      color: var(--ink);
      font-size: 18px;
      line-height: 1.15;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .decision-panel-item p {
      margin-top: 5px;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .decision-panel-item small {
      margin-top: 6px;
      color: var(--muted);
    }
    .decision-panel-feedback {
      grid-column: 1 / -1;
      margin: -2px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    .decision-panel-link {
      appearance: none;
      border: 1px solid rgba(116, 242, 145, 0.44);
      border-radius: 6px;
      padding: 8px 11px;
      background: var(--signal-green);
      color: #061007;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 820;
      white-space: nowrap;
    }
    .decision-panel-link:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .stored-content-tools {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
    }
    .memory-explorer-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
      gap: 12px;
      align-items: start;
    }
    .memory-explorer-main {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .memory-explorer-detail {
      position: sticky;
      top: 14px;
      display: grid;
      gap: 10px;
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.28);
      border-radius: 8px;
      padding: 14px;
      background:
        linear-gradient(180deg, rgba(69, 185, 255, 0.065), rgba(255, 255, 255, 0.01)),
        rgba(8, 10, 13, 0.9);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .memory-explorer-detail > span,
    .memory-explorer-trace > span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
    }
    .memory-explorer-detail strong {
      color: var(--ink);
      font-size: 17px;
      line-height: 1.18;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .memory-explorer-detail p {
      margin: 0;
      color: var(--ink-2);
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }
    .memory-explorer-detail-grid {
      border-top: 1px solid rgba(112, 129, 149, 0.22);
      padding-top: 10px;
    }
    .memory-explorer-detail-grid div {
      grid-template-columns: 74px minmax(0, 1fr);
    }
    .memory-explorer-guidance {
      display: grid;
      gap: 8px;
      border-top: 1px solid rgba(112, 129, 149, 0.22);
      padding-top: 10px;
    }
    .memory-explorer-guidance-card {
      display: grid;
      gap: 4px;
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 8px;
      padding: 9px;
      background: rgba(255, 255, 255, 0.025);
    }
    .memory-explorer-guidance-card span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
    }
    .memory-explorer-guidance-card strong {
      font-size: 13px;
      line-height: 1.25;
    }
    .memory-explorer-guidance-card small {
      color: var(--muted);
    }
    .memory-explorer-trace {
      display: grid;
      gap: 7px;
      border-top: 1px solid rgba(112, 129, 149, 0.22);
      padding-top: 10px;
    }
    .memory-search-panel {
      display: grid;
      gap: 10px;
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01)),
        rgba(10, 12, 15, 0.72);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }
    .primary-memory-search {
      border-color: rgba(69, 185, 255, 0.42);
      background:
        linear-gradient(180deg, rgba(69, 185, 255, 0.09), rgba(116, 242, 145, 0.025)),
        rgba(8, 10, 13, 0.88);
      box-shadow: 0 18px 38px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.055);
    }
    .memory-search-label {
      color: var(--ink);
      font-size: 13px;
      font-weight: 820;
    }
    .memory-search-controls {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(150px, max-content) minmax(150px, max-content);
      gap: 8px;
      align-items: center;
    }
    .memory-search-input {
      width: 100%;
      min-height: 48px;
      border: 1px solid rgba(112, 129, 149, 0.34);
      border-radius: 7px;
      padding: 8px 12px;
      background: rgba(4, 5, 7, 0.78);
      color: var(--ink);
      font: inherit;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .memory-search-input:focus { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-search-select {
      width: 100%;
      min-height: 44px;
      border: 1px solid rgba(112, 129, 149, 0.34);
      border-radius: 7px;
      padding: 8px 10px;
      background: rgba(8, 10, 13, 0.94);
      color: var(--ink);
      font: inherit;
      font-size: 12px;
      font-weight: 760;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .memory-search-select:focus { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-search-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      min-height: 30px;
    }
    .memory-search-chip {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: 100%;
      min-height: 28px;
      border: 1px solid rgba(69, 185, 255, 0.28);
      border-radius: 999px;
      padding: 4px 9px;
      background: rgba(69, 185, 255, 0.085);
      color: #c7e8ff;
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      font-weight: 820;
      overflow-wrap: anywhere;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }
    .memory-search-chip:hover {
      border-color: rgba(116, 242, 145, 0.48);
      background: rgba(116, 242, 145, 0.12);
      transform: translateY(-1px);
    }
    .memory-search-chip:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-search-meta {
      display: grid;
      grid-template-columns: minmax(12ch, max-content) minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      min-height: 22px;
      color: var(--muted);
      font-size: 12px;
    }
    .memory-search-meta span[data-memory-search-status] {
      display: inline-flex;
      align-items: center;
      min-width: 12ch;
      color: #b9d7ff;
      font-weight: 760;
      white-space: nowrap;
    }
    .memory-search-meta small {
      text-align: right;
      white-space: nowrap;
    }
    .memory-state-guide {
      display: grid;
      gap: 8px;
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 8px;
      padding: 10px;
      background:
        linear-gradient(90deg, rgba(255, 255, 255, 0.032), rgba(116, 242, 145, 0.018)),
        rgba(5, 7, 10, 0.46);
    }
    .memory-state-guide > span {
      color: #bde6ff;
      font-size: 12px;
      font-weight: 820;
    }
    .memory-state-guide-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .memory-state-guide-card {
      appearance: none;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 4px;
      min-width: 0;
      min-height: 82px;
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 9px;
      background: rgba(8, 10, 13, 0.62);
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .memory-state-guide-card:hover {
      border-color: rgba(69, 185, 255, 0.46);
      background: rgba(12, 15, 20, 0.88);
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.045);
      transform: translateY(-1px);
    }
    .memory-state-guide-card:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-state-guide-card strong {
      color: var(--ink);
      font-size: 12.5px;
      line-height: 1.15;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .memory-state-guide-card small {
      color: var(--muted);
      font-size: 11.5px;
      line-height: 1.25;
    }
    .memory-state-guide-card.memory-state-remembered { border-left-color: var(--signal-green); }
    .memory-state-guide-card.memory-state-to-organize { border-left-color: var(--signal-blue); }
    .memory-state-guide-card.memory-state-temporary { border-left-color: var(--signal-amber); }
    .memory-state-guide-card.memory-state-set-aside { border-left-color: var(--signal-violet); }
    .memory-search-mix {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 26px;
      align-items: center;
    }
    .memory-search-mix-item {
      appearance: none;
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 999px;
      padding: 3px 8px;
      background: rgba(4, 5, 7, 0.42);
      color: var(--ink-2);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      font-weight: 800;
      overflow-wrap: anywhere;
      transition: border-color 160ms ease, background 160ms ease, color 160ms ease, transform 160ms ease;
    }
    .memory-search-mix-item:hover,
    .memory-search-mix-item.active {
      border-color: rgba(69, 185, 255, 0.48);
      background: rgba(69, 185, 255, 0.12);
      color: var(--ink);
    }
    .memory-search-mix-item:hover {
      transform: translateY(-1px);
    }
    .memory-search-mix-item:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-search-results {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-content: start;
      gap: 10px;
      height: clamp(320px, 46vh, 520px);
      overflow: auto;
      scrollbar-gutter: stable both-edges;
      padding-right: 2px;
    }
    .memory-search-result {
      display: grid;
      gap: 6px;
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 8px;
      padding: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.006)), rgba(8, 10, 13, 0.92);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .memory-search-result:hover {
      border-color: rgba(69, 185, 255, 0.34);
      background: linear-gradient(180deg, rgba(69, 185, 255, 0.05), rgba(255, 255, 255, 0.008)), rgba(10, 12, 16, 0.96);
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.045);
      transform: translateY(-1px);
    }
    .memory-search-result.selected {
      border-color: rgba(116, 242, 145, 0.56);
      background: linear-gradient(180deg, rgba(116, 242, 145, 0.08), rgba(69, 185, 255, 0.035)), rgba(10, 12, 16, 0.98);
      box-shadow: 0 16px 34px rgba(0, 0, 0, 0.3), inset 4px 0 0 rgba(116, 242, 145, 0.74);
    }
    .memory-search-result:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-search-result span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
    }
    .memory-search-result strong {
      color: var(--ink);
      font-size: 13px;
      line-height: 1.2;
      font-weight: 820;
      overflow-wrap: anywhere;
    }
    .memory-search-result p {
      margin: 0;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .stored-content-filterbar {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
      margin-bottom: 10px;
    }
    .stored-content-filter {
      appearance: none;
      border: 1px solid rgba(112, 129, 149, 0.34);
      border-radius: 7px;
      padding: 6px 9px;
      background: rgba(8, 10, 13, 0.62);
      color: var(--muted);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 790;
      transition: border-color 160ms ease, background 160ms ease, color 160ms ease;
    }
    .stored-content-filter:hover {
      border-color: rgba(69, 185, 255, 0.46);
      color: var(--ink);
    }
    .stored-content-filter.active {
      border-color: rgba(69, 185, 255, 0.62);
      background: rgba(69, 185, 255, 0.13);
      color: #d8efff;
    }
    .stored-content-filter:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .stored-content-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .stored-content-overflow {
      margin-top: 10px;
    }
    .stored-content-item {
      display: grid;
      gap: 8px;
      min-width: 0;
      min-height: 148px;
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 13px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.008)), rgba(18, 21, 27, 0.86);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .stored-content-item:hover {
      border-color: rgba(69, 185, 255, 0.32);
      background: linear-gradient(180deg, rgba(69, 185, 255, 0.045), rgba(255, 255, 255, 0.01)), rgba(20, 23, 29, 0.92);
      box-shadow: 0 14px 30px rgba(0, 0, 0, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.045);
      transform: translateY(-1px);
    }
    .stored-content-item.selected {
      border-color: rgba(69, 185, 255, 0.72);
      background: linear-gradient(180deg, rgba(69, 185, 255, 0.09), rgba(255, 255, 255, 0.012)), rgba(18, 23, 30, 0.96);
      box-shadow: 0 0 0 1px rgba(69, 185, 255, 0.22), 0 14px 34px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .stored-content-item-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 6px;
      min-width: 0;
    }
    .stored-content-item-head span {
      color: var(--ink);
      font-size: 12px;
      font-weight: 820;
    }
    .stored-content-item strong {
      color: var(--ink);
      font-size: 14px;
      line-height: 1.2;
      font-weight: 820;
      overflow-wrap: anywhere;
    }
    .stored-content-item p {
      margin: 0;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .stored-content-explain {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .stored-content-explain-card {
      display: grid;
      gap: 3px;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 7px;
      padding: 8px 9px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.032), rgba(69, 185, 255, 0.012)),
        rgba(5, 7, 10, 0.48);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.032);
    }
    .stored-content-explain-card span {
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 820;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .stored-content-explain-card strong {
      color: #d7ecff;
      font-size: 12px;
      line-height: 1.25;
      font-weight: 830;
      overflow-wrap: anywhere;
    }
    .stored-content-explain-card small {
      color: var(--muted);
      line-height: 1.35;
    }
    .stored-content-open {
      justify-self: start;
      appearance: none;
      border: 1px solid rgba(69, 185, 255, 0.42);
      border-radius: 6px;
      padding: 5px 8px;
      background: rgba(69, 185, 255, 0.1);
      color: #bde6ff;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 820;
    }
    .stored-content-open:hover { border-color: rgba(69, 185, 255, 0.76); background: rgba(69, 185, 255, 0.16); }
    .stored-content-open:focus-visible,
    .stored-content-item:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .stored-content-more {
      appearance: none;
      border: 1px solid rgba(69, 185, 255, 0.42);
      border-radius: 6px;
      padding: 7px 10px;
      background: var(--surface-2);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 10px;
      color: var(--signal-blue);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 820;
    }
    .stored-content-more:hover { border-color: rgba(69, 185, 255, 0.78); background: var(--surface-3); }
    .stored-content-more:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .glance-board {
      margin-bottom: 12px;
    }
    .glance-summary-strip {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .glance-summary-strip button {
      appearance: none;
      display: grid;
      gap: 3px;
      min-width: 0;
      min-height: 78px;
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-radius: 8px;
      padding: 10px;
      background:
        linear-gradient(145deg, rgba(255, 255, 255, 0.048), rgba(69, 185, 255, 0.02) 52%, rgba(255, 255, 255, 0.006)),
        rgba(9, 11, 14, 0.74);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: background 160ms ease, border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .glance-summary-strip button:hover {
      border-color: rgba(69, 185, 255, 0.44);
      background:
        linear-gradient(145deg, rgba(69, 185, 255, 0.085), rgba(116, 242, 145, 0.03)),
        rgba(12, 15, 20, 0.96);
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.055);
      transform: translateY(-1px);
    }
    .glance-summary-strip button:focus-visible {
      outline: 2px solid var(--signal-blue);
      outline-offset: 2px;
    }
    .glance-summary-strip span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .glance-summary-strip strong {
      color: var(--ink);
      font-size: 22px;
      line-height: 1.08;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .glance-grid {
      display: grid;
      grid-template-columns: minmax(240px, 1.25fr) repeat(4, minmax(0, 1fr));
      gap: 10px;
    }
    .glance-chart {
      display: grid;
      gap: 10px;
      align-content: start;
      min-width: 0;
      min-height: 214px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.055), rgba(255, 255, 255, 0.015)), var(--surface);
      box-shadow: 0 18px 38px rgba(0, 0, 0, 0.38);
    }
    .glance-chart h3 {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
      font-weight: 800;
      text-transform: uppercase;
    }
    .glance-chart > strong {
      color: var(--ink);
      font-size: 32px;
      line-height: 1;
      font-weight: 850;
    }
    .memory-state-meter {
      display: flex;
      height: 18px;
      border: 1px solid var(--hairline);
      border-radius: 999px;
      overflow: hidden;
      background: var(--surface-3);
    }
    .memory-state-meter span {
      min-width: 4px;
    }
    .memory-state-key {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 8px;
    }
    .memory-state-filter {
      appearance: none;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 7px;
      padding: 6px;
      background: rgba(9, 11, 14, 0.58);
      cursor: pointer;
      display: flex;
      align-items: center;
      min-width: 0;
      gap: 5px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
      text-align: left;
      transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
    }
    .memory-state-filter:hover {
      border-color: rgba(69, 185, 255, 0.42);
      background: rgba(69, 185, 255, 0.08);
      transform: translateY(-1px);
    }
    .memory-state-filter:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-state-key i {
      flex: 0 0 auto;
      width: 9px;
      height: 9px;
      border-radius: 2px;
    }
    .memory-state-key strong {
      color: var(--ink);
      font-size: 13px;
      line-height: 1;
      font-weight: 820;
    }
    .memory-state-filter > span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .memory-state-meter .memory-state-remembered,
    .memory-state-key .memory-state-remembered i { background: var(--signal-green); }
    .memory-state-meter .memory-state-to-organize,
    .memory-state-key .memory-state-to-organize i { background: var(--signal-blue); }
    .memory-state-meter .memory-state-temporary,
    .memory-state-key .memory-state-temporary i { background: var(--signal-amber); }
    .memory-state-meter .memory-state-set-aside,
    .memory-state-key .memory-state-set-aside i { background: var(--signal-slate); }
    .memory-state-empty { background: var(--surface-3); }
    .kind-bars,
    .activity-bars {
      display: grid;
      gap: 9px;
    }
    .kind-row,
    .activity-row {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .activity-row { --bar-accent: var(--signal-green); }
    .activity-row:nth-child(1) { --bar-accent: var(--signal-green); }
    .activity-row:nth-child(2) { --bar-accent: var(--signal-blue); }
    .activity-row:nth-child(3) { --bar-accent: var(--signal-amber); }
    .activity-row:nth-child(4) { --bar-accent: var(--signal-violet); }
    .recent-activity-focus {
      display: grid;
      gap: 2px;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px;
      background: var(--surface-2);
    }
    .recent-activity-focus span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .recent-activity-focus strong {
      color: var(--ink);
      font-size: 20px;
      line-height: 1.1;
      font-weight: 840;
      overflow-wrap: anywhere;
    }
    .activity-trend {
      --trend-accent: var(--signal-blue);
    }
    .activity-trend-summary {
      display: grid;
      gap: 2px;
      min-height: 50px;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px;
      background: linear-gradient(145deg, rgba(69, 185, 255, 0.095), rgba(116, 242, 145, 0.035)), var(--surface-2);
    }
    .activity-trend-summary span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
    }
    .activity-trend-summary strong {
      color: var(--ink);
      font-size: 20px;
      line-height: 1.1;
      font-weight: 840;
      overflow-wrap: anywhere;
    }
    .activity-trend-bars {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      align-items: end;
      gap: 5px;
      min-height: 94px;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 7px 6px;
      background: rgba(5, 7, 10, 0.36);
    }
    .activity-trend-day {
      display: grid;
      grid-template-rows: minmax(54px, 1fr) 15px;
      align-items: end;
      justify-items: center;
      gap: 5px;
      min-width: 0;
      height: 100%;
    }
    .activity-trend-bars i {
      display: block;
      width: 100%;
      min-height: 4px;
      border-radius: 999px 999px 3px 3px;
      background: linear-gradient(180deg, var(--signal-green), var(--trend-accent));
      box-shadow: 0 0 18px rgba(69, 185, 255, 0.22);
    }
    .activity-trend-bars span {
      color: var(--muted);
      font-size: 10px;
      line-height: 1;
      font-weight: 760;
    }
    .glance-chart.shared-copy {
      border-left-width: 4px;
    }
    .glance-chart.shared-copy.good { border-left-color: var(--signal-green); }
    .glance-chart.shared-copy.info { border-left-color: var(--signal-blue); }
    .glance-chart.shared-copy.warning { border-left-color: var(--signal-amber); }
    .glance-chart.shared-copy.critical { border-left-color: var(--signal-red); }
    .glance-chart.shared-copy > strong {
      color: var(--ink);
      font-size: 22px;
      line-height: 1.1;
      font-weight: 840;
      overflow-wrap: anywhere;
    }
    .glance-chart.shared-copy .sync-rail {
      align-self: end;
    }
    .good, .state-canonical { color: var(--signal-green); border-color: rgba(116, 242, 145, 0.36); background: var(--signal-green-soft); }
    .warning, .state-raw { color: var(--signal-amber); border-color: rgba(255, 209, 102, 0.38); background: var(--signal-amber-soft); }
    .critical, .state-quarantined { color: var(--signal-red); border-color: rgba(255, 92, 116, 0.38); background: var(--signal-red-soft); }
    .info, .state-candidate { color: var(--signal-blue); border-color: rgba(69, 185, 255, 0.36); background: var(--signal-blue-soft); }
    .state-archived { color: var(--signal-slate); border-color: rgba(154, 166, 178, 0.34); background: var(--surface-3); }
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
      background: var(--signal-green);
      color: #061007;
      font: inherit;
      font-size: 12px;
      font-weight: 780;
      cursor: pointer;
      white-space: nowrap;
    }
    .dashboard-overview-action-quiet {
      background: var(--surface);
      color: var(--ink-2);
      box-shadow: none;
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
    .dashboard-overview-card:hover { border-color: rgba(69, 185, 255, 0.62); box-shadow: 0 12px 24px rgba(0, 0, 0, 0.34); transform: translateY(-1px); }
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
    .dashboard-work-lane:hover { border-color: rgba(69, 185, 255, 0.62); box-shadow: 0 12px 26px rgba(0, 0, 0, 0.36); transform: translateY(-1px); }
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
    .dogfood-review-reference {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left: 4px solid var(--warning);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
    }
    .dogfood-review-reference strong {
      color: var(--ink);
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .dogfood-review-reference span,
    .dogfood-review-reference code,
    .dogfood-review-body > p {
      overflow-wrap: anywhere;
    }
    .dogfood-review-reference span,
    .dogfood-review-body > p {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .dogfood-review-reference code {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
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
    .action-board-background {
      margin: 0 0 12px;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      background: var(--surface-2);
    }
    .action-board-background > summary {
      padding: 9px 10px;
    }
    .action-board-background[open] {
      padding: 0 10px 10px;
    }
    .action-board-background[open] > summary {
      margin: 0 -10px 10px;
      border-bottom: 1px solid var(--hairline);
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
    .action-board-quiet-list,
    .action-board-background-list {
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
    .action-board-item:hover { border-color: rgba(69, 185, 255, 0.62); box-shadow: 0 12px 26px rgba(0, 0, 0, 0.36); transform: translateY(-1px); }
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
    .action-board-quiet-list .action-board-item,
    .action-board-background-list .action-board-item {
      border-left-width: 1px;
      padding: 8px;
      background: var(--surface);
      box-shadow: none;
    }
    .action-board-quiet-list .action-board-item strong,
    .action-board-background-list .action-board-item strong {
      font-size: 16px;
      color: var(--muted);
    }
    .action-board-quiet-list .action-board-item p,
    .action-board-background-list .action-board-item p {
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
    .decision-summary-route small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 680;
      overflow-wrap: anywhere;
    }
    .decision-summary-link {
      justify-self: start;
      background: var(--signal-green);
      border-color: var(--signal-green);
      color: #061007;
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
    .store-signals { border-left: 4px solid var(--signal-slate); }
    .capture-inbox { border-left: 4px solid var(--signal-blue); }
    .evidence-library {
      border-left: 4px solid var(--signal-slate);
    }
    .evidence-library-compact {
      margin-bottom: 12px;
      border: 1px solid var(--hairline);
      border-left: 0;
      border-radius: 7px;
      background: var(--surface-2);
    }
    .evidence-library-compact > summary {
      padding: 9px 10px;
    }
    .evidence-library-compact[open] {
      padding: 0 10px 10px;
    }
    .evidence-library-compact[open] > summary {
      margin: 0 -10px 10px;
      border-bottom: 1px solid var(--hairline);
    }
    .evidence-library[open] > summary { margin-bottom: 10px; }
    .evidence-library-compact[open] > summary { margin-bottom: 10px; }
    .reference-library-index-wrap {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
    }
    .reference-library-index {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left: 4px solid var(--signal-slate);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
    }
    .reference-library-index strong {
      color: var(--ink);
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .reference-library-index span,
    .reference-library-index small,
    .reference-library-index code {
      overflow-wrap: anywhere;
    }
    .reference-library-index span,
    .reference-library-index small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .reference-library-index small {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .reference-library-routes {
      margin-top: 4px;
      border-top: 1px solid var(--hairline);
      padding-top: 6px;
    }
    .reference-library-routes[open] > summary { margin-bottom: 6px; }
    .reference-library-routes-fold {
      min-height: 30px;
      padding: 2px 0;
    }
    .reference-library-route-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      padding: 2px 0 6px;
    }
    .reference-library-api-hint {
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .reference-library-index-rows {
      display: grid;
      gap: 6px;
    }
    .reference-library-index-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px 10px;
      align-items: center;
      min-width: 0;
      padding: 5px 0;
      border-top: 1px solid var(--hairline);
    }
    .reference-library-index-row:first-child { border-top: 0; }
    .reference-library-index-row div {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .reference-library-index-row strong,
    .reference-library-index-row span,
    .reference-library-index-row small {
      overflow-wrap: anywhere;
    }
    .reference-library-index-row strong {
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 760;
    }
    .reference-library-index-row span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .reference-library-index-row small {
      justify-content: flex-end;
      min-width: 0;
    }
    .reference-library-index-wrap > p {
      margin: 0;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12.5px;
    }
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
    .evidence-library-route:hover { border-color: rgba(69, 185, 255, 0.62); box-shadow: 0 10px 22px rgba(0, 0, 0, 0.32); transform: translateY(-1px); }
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
    .routine-diagnostics-reference {
      display: grid;
      gap: 8px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left: 4px solid var(--info);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
    }
    .routine-diagnostics-reference strong {
      color: var(--ink);
      font-weight: 780;
    }
    .routine-diagnostics-reference span,
    .routine-diagnostics-reference small,
    .routine-diagnostics-reference code,
    .routine-diagnostics-list p {
      overflow-wrap: anywhere;
    }
    .routine-diagnostics-reference span,
    .routine-diagnostics-reference small,
    .routine-diagnostics-list p {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .routine-diagnostics-routebar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .routine-diagnostics-route {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 6px 8px;
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      font-size: 12px;
      font-weight: 760;
      cursor: pointer;
    }
    .routine-diagnostics-route.good { border-color: rgba(47, 125, 83, 0.28); }
    .routine-diagnostics-route.info { border-color: rgba(46, 108, 166, 0.28); }
    .routine-diagnostics-route code,
    .routine-diagnostics-sources code {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .routine-diagnostics-sources {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 0;
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
    .supporting-evidence-index {
      display: grid;
      gap: 8px;
    }
    .supporting-evidence-index p {
      margin: 0;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12.5px;
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
    .supporting-evidence-summary-row small {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 4px;
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
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 8px;
      align-items: start;
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
    .action-receipt-head p {
      grid-column: 1 / -1;
      margin: 0;
      color: var(--ink-2);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .action-receipt-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .action-receipt-summary span {
      display: grid;
      gap: 2px;
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 7px 8px;
      background: var(--surface-2);
      min-width: 0;
    }
    .action-receipt-summary strong {
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 760;
    }
    .action-receipt-summary small {
      color: var(--ink);
      font-size: 12.5px;
      font-weight: 740;
    }
    .action-receipt-audit {
      border-top: 1px solid var(--hairline);
      padding-top: 7px;
    }
    .action-receipt-audit[open] > summary { margin-bottom: 7px; }
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
    .maintenance-list, .candidate-triage-list, .candidate-triage-records, .governance-list, .capture-inbox-list, .capture-inbox-items { display: grid; gap: 10px; }
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
    .candidate-triage-reference {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface);
    }
    .candidate-triage-reference strong {
      color: var(--ink);
      font-size: 13px;
      font-weight: 760;
      overflow-wrap: anywhere;
    }
    .candidate-triage-reference span {
      color: var(--muted);
      font-size: 12.5px;
      overflow-wrap: anywhere;
    }
    .candidate-triage-reference code {
      overflow-wrap: anywhere;
    }
    .candidate-triage-body > p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
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
    .candidate-triage-approval-brief {
      margin-bottom: 8px;
    }
    .candidate-triage-approval-brief h4 {
      margin: 0 0 6px;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0;
      color: var(--muted);
    }
    .candidate-triage-promotion-evidence {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 7px 9px;
      margin-bottom: 8px;
      background: var(--surface-2);
    }
    .candidate-triage-promotion-evidence[open] > summary {
      margin-bottom: 8px;
    }
    .candidate-triage-promotion-draft dl,
    .candidate-triage-brief-list {
      margin: 0;
      grid-template-columns: minmax(0, 1fr);
    }
    .candidate-triage-promotion-draft dl div,
    .candidate-triage-brief-list div {
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
    .governance-reference {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--hairline);
      border-left: 4px solid var(--info);
      border-radius: 7px;
      padding: 9px;
      background: var(--surface-2);
    }
    .governance-reference strong {
      color: var(--ink);
      font-weight: 780;
      overflow-wrap: anywhere;
    }
    .governance-reference span,
    .governance-reference code,
    .governance-list > p {
      overflow-wrap: anywhere;
    }
    .governance-reference span,
    .governance-list > p {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .governance-reference code {
      color: var(--muted);
      font-size: 11px;
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
    .governance-reference-audit {
      border-top: 1px solid var(--hairline);
      padding-top: 8px;
      margin-top: 8px;
      min-width: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .governance-reference-audit summary {
      cursor: pointer;
      font-weight: 720;
    }
    .governance-reference-audit-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .governance-reference-audit-item {
      border: 1px solid var(--hairline);
      border-radius: 6px;
      padding: 8px;
      background: var(--surface);
    }
    .governance-reference-audit-item h4 {
      margin: 0;
      color: var(--ink);
      font-size: 12px;
      font-weight: 760;
    }
    .governance-reference-audit-item ol {
      margin: 7px 0 0 18px;
      padding: 0;
      display: grid;
      gap: 4px;
    }
    .governance-reference-audit-item li {
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
    .maintenance-plan, .capture-inbox-group, .capture-inbox-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface-2);
    }
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
    .store-signals[open] > summary { margin-bottom: 12px; }
    .store-signals .visual-grid { margin-top: 0; }
    .store-signals-promoted-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .store-signals-promoted-head small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      text-transform: none;
    }
    .sync-position-focus { margin-bottom: 10px; }
    .store-sync-details {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      margin-bottom: 10px;
      background: var(--surface-2);
    }
    .store-sync-details[open] > summary { margin-bottom: 8px; }
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
    .capture-inbox-review-signal {
      display: grid;
      gap: 7px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px 9px;
      margin: 0 0 10px;
      background: var(--surface-2);
    }
    .capture-inbox-review-signal strong {
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .capture-inbox-review-signal div {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .capture-inbox-review-signal span {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 2px 7px;
      background: var(--surface);
      color: var(--muted);
      font-size: 12px;
      font-weight: 720;
    }
    .capture-inbox-review-signal small {
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
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
    .maintenance-review-notes {
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 9px;
      margin: 0 0 8px;
      background: var(--surface-2);
    }
    .maintenance-review-notes h4 {
      margin: 0 0 7px;
      color: var(--ink);
      font-size: 12px;
      font-weight: 780;
    }
    .maintenance-review-notes dl {
      display: grid;
      gap: 7px;
      margin: 0;
    }
    .maintenance-review-notes dl div {
      display: grid;
      grid-template-columns: 76px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .maintenance-review-notes dt { color: var(--ink); font-weight: 760; }
    .maintenance-review-notes dd { color: var(--ink-2); }
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
    .maintenance-summary, .capture-inbox-summary {
      margin: 0 0 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .maintenance-summary div, .capture-inbox-summary div {
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
    .maintenance-summary small, .capture-inbox-summary small { margin-top: 3px; }
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
    button.primary { background: var(--signal-green); border-color: var(--signal-green); color: #061007; }
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
    .citation-links { display: grid; gap: 5px; min-width: 0; }
    .citation-links code { width: 100%; }
    .inspector-grid { display: grid; gap: 12px; }
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
    @media (max-width: 920px) {
      header, .status-board-answers, .status-board-rail, .memory-inventory-grid, .recent-status-grid, .glance-grid, .memory-explorer-layout, .stored-content-list, .stored-content-explain, .memory-search-controls, .dashboard-overview-quiet-list, .dashboard-work-lanes, .dashboard-work-lanes-quiet-list, .action-board-grid, .action-board-quiet-list, .action-board-background-list, .decision-summary-list, .visual-grid { grid-template-columns: 1fr; }
      .memory-state-guide-grid { grid-template-columns: 1fr; }
      .store-path { white-space: normal; overflow-wrap: anywhere; }
      main { padding: 18px 12px 36px; }
      .dashboard-header-actions { justify-content: flex-start; }
      .status-strip { grid-template-columns: 1fr; align-items: start; }
      .dashboard-overview-main { display: grid; align-items: stretch; }
      .dashboard-overview-action { width: 100%; white-space: normal; }
      .decision-panel-item { grid-template-columns: 1fr; align-items: stretch; }
      .decision-panel-link { width: 100%; white-space: normal; }
      .memory-search-meta { grid-template-columns: 1fr; align-items: start; }
      .memory-search-meta small { text-align: left; white-space: normal; }
      .memory-search-results { grid-template-columns: 1fr; height: clamp(320px, 58vh, 520px); }
      .memory-explorer-detail { position: static; }
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
      .maintenance-summary, .context-pack-summary, .context-pack-grid, .health-check-action-groups, .capture-inbox-summary { grid-template-columns: 1fr; }
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
  <main${refreshAttributes}>${renderDashboardBody(data, { showStoredContent: options.showStoredContent })}</main>
  ${dashboardLanguageScript()}
  ${dashboardRefreshScript(options.refreshIntervalMs)}
  ${dashboardActionBoardScript()}
  ${dashboardStoredContentScript()}
  ${dashboardActionReceiptScript()}
  ${dashboardMaintenanceScript()}
  ${dashboardCaptureInboxScript()}
  ${dashboardCandidateTriageScript()}
</body>
</html>
`;
}

export function renderDashboardHtml(data: DashboardData, options: Pick<DashboardRenderOptions, "showStoredContent"> = {}): string {
  return renderDashboardShell(data, options);
}

export function renderDashboardServerHtml(data: DashboardData, refreshIntervalMs: number, options: Pick<DashboardRenderOptions, "showStoredContent"> = {}): string {
  return renderDashboardShell(data, { refreshIntervalMs, showStoredContent: options.showStoredContent });
}

export function renderDashboardFragment(data: DashboardData, options: Pick<DashboardRenderOptions, "showStoredContent"> = {}): string {
  return renderDashboardBody(data, options);
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
  const renderOptions: Pick<DashboardRenderOptions, "showStoredContent"> = {
    showStoredContent: includePrivate !== true
  };
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
        sendResponse(response, 200, renderDashboardServerHtml(data, refreshIntervalMs, renderOptions), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/fragment") {
        const data = await dashboardDataLoader.load();
        sendResponse(response, 200, renderDashboardFragment(data, renderOptions), "text/html; charset=utf-8", includeBody);
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
