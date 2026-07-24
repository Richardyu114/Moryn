import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { normalizeAgentIdentity } from "../core/agent-identity.js";
import {
  type AutocapturePolicyDecision,
  type AutocapturePolicyRuleId,
  DEFAULT_AUTOCAPTURE_POLICY
} from "../core/autocapture-policy.js";
import { type CapturePolicyResult, diagnoseCapturePolicy } from "../core/capture-policy-report.js";
import {
  currentAutocaptureDecisionForRecord,
  currentPolicyTreatsAsLowRiskCapture,
  isCaptureReviewCandidate
} from "../core/capture-review.js";
import { displayRecordText } from "../core/content-text.js";
import { type DogfoodReportResult, diagnoseDogfood } from "../core/dogfood-report.js";
import { createEngine } from "../core/engine.js";
import { commandForPromoteContext } from "../core/errors.js";
import { diagnoseHealthCheck, type HealthCheckReport } from "../core/health-check.js";
import { buildActiveLogicalMemoryView } from "../core/logical-memory.js";
import { diagnoseMemory, type MemoryDoctorResult } from "../core/memory-doctor.js";
import { diagnoseMemoryLifecycle, type MemoryLifecycleResult } from "../core/memory-lifecycle.js";
import type { RecallEvalReport } from "../core/recall-eval.js";
import { readCurrentRecords } from "../core/record-read-model.js";
import { replayEvents } from "../core/replay.js";
import { readRetrievalCandidates } from "../core/retrieval-index.js";
import { isPrivateMemoryBoundary, redactSensitiveContent } from "../core/sensitive.js";
import { readEvents } from "../core/store.js";
import { readSyncCompensationReceipt } from "../core/sync-compensation.js";
import type { MorynEvent, MorynRecord, RecordKind, RecordSource } from "../core/types.js";
import { summarizeWorkingSet } from "../core/working-set-report.js";
import { type GitSyncStatus, getGitSyncStatus } from "../sync/git.js";
import { dashboardDrawerId } from "./dashboard-drawer-id.js";
import {
  approveMaintenancePlan,
  buildDashboardMaintenance,
  type DashboardMaintenanceData,
  type DashboardMaintenancePlan
} from "./dashboard-maintenance.js";
import { buildDashboardV04Data, type DashboardMemoryMaintenance, type DashboardSoulStudio } from "./dashboard-v04.js";
import { dashboardWorkspaceCss } from "./dashboard-workspace.css.js";
import { renderDashboardWorkspace, renderMemorySearch } from "./dashboard-workspace.js";
import { dashboardWorkspaceScript } from "./dashboard-workspace-script.js";

const exec = promisify(execFile);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RECENT_VALUE_LIMIT = 8;
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
  explanation:
    "Capture Inbox groups reduce review clicks, but candidates become canonical only after explicit user approval."
};

declare global {
  interface Window {
    applyDashboardLanguage?: () => void;
    currentDashboardLanguage?: () => "en" | "zh";
    restoreActionReceipt?: () => void;
    renderActionReceipt?: (result: unknown) => void;
    initializeDashboardWorkspace?: () => void;
    restoreDashboardWorkspaceAfterFragment?: (state?: {
      view?: string;
      drawer?: string | null;
      scrollY?: number;
    }) => void;
    dashboardWorkspaceInteraction?: {
      mark: () => void;
      isActive: () => boolean;
    };
    dashboardWorkspaceState?: {
      activateView: (view: string) => void;
      openDrawer: (id: string, trigger?: HTMLElement | null, options?: { focus?: boolean }) => boolean;
      closeDrawer: (options?: { restoreFocus?: boolean }) => void;
      capture: () => { view: string; drawer: string | null; scrollY: number };
      restore: (state?: { view?: string; drawer?: string | null; scrollY?: number }) => void;
      initialize: () => void;
    };
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
  memory_maintenance: "memory_maintenance",
  soul_studio: "soul_studio",
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
  linked_record_id?: string;
  link_type?: string;
  reason?: {
    value: string;
    truncated: boolean;
  };
  target_state?: MorynRecord["state"];
  changes: Array<{
    field: "content" | "category" | "labels" | "confidence" | "priority" | "project" | "other";
    value?: string;
    truncated: boolean;
  }>;
  changes_truncated: boolean;
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
  event_path?: string;
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
  evidence_path:
    | "capture_inbox.groups[]"
    | "maintenance.plans[]"
    | `candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.${string}`;
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

export type DashboardGovernanceSource =
  | "capture_policy"
  | "memory_doctor"
  | "memory_lifecycle"
  | "maintenance"
  | "recall_eval"
  | "dogfood_report";
export type DashboardGovernanceCategory =
  | "capture_review"
  | "auto_capture"
  | "policy_archive"
  | "candidate_backlog"
  | "candidate_quality"
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
  title_zh: string;
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
  current_task?: string;
  files?: string[];
  policy_decision?: string;
  policy_route?: string;
  policy_rule_ids: string[];
  policy_reasons: string[];
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
  logical_memory: {
    store_records: number;
    active_working_set_records: number;
    hidden_logical_records: number;
    conflict_records: number;
    cycle_findings: number;
    learned_records: number;
    learned_canonical_records: number;
    learned_candidate_records: number;
    learning_evidence_links: number;
  };
  quiet_dashboard: {
    system_pulse: {
      healthy: boolean;
      status: DashboardHealthStatus;
      store_ready: boolean;
      sync_state: string;
      context_protected: boolean;
      autopilot_active: boolean;
      autopilot: {
        status: "active" | "configured" | "degraded" | "not_installed";
        host: "codex" | "claude" | "unknown";
        last_event?: string;
        last_seen_at?: string;
      };
    };
    current_context: {
      project_id?: string;
      task?: string;
      agent?: string;
      device_id?: string;
      checkpoint_available: boolean;
      handoff_available: boolean;
      checkpoint_record_id?: string;
      handoff_record_id?: string;
    };
    memory_flow: {
      store_events: number;
      store_records: number;
      active_working_set_records: number;
      hidden_logical_records: number;
      hidden_duplicate_records: number;
      hidden_superseded_records: number;
      hidden_revised_records: number;
      conflict_records: number;
      cycle_findings: number;
      default_boot_records?: number;
      compaction_ratio: number;
      learned_records: number;
      semantic_equivalent_links: number;
      semantic_revision_links: number;
      semantic_superseded_links: number;
      semantic_conflict_links: number;
      semantic_rejected_proposals: number;
      recent_records: number;
      recent_events: number;
      sync_state: string;
    };
    knowledge_loop: {
      learned_records: number;
      learned_canonical_records: number;
      learned_candidate_records: number;
      investigations: number;
      resolved_investigations: number;
      unresolved_investigations: number;
      preserved_before_compact: number;
    };
    session_synthesis: {
      host_authored: number;
      evidence_synthesized: number;
      minimal_fallback: number;
    };
    attention_needed: DashboardAttentionItem[];
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
  memory_maintenance: DashboardMemoryMaintenance;
  soul_studio: DashboardSoulStudio;
  dogfood_report: DogfoodReportResult;
  stored_content_preview: DashboardValueRecord[];
  recent_value: DashboardValueRecord[];
  recent_records: DashboardRecordSummary[];
  all_records: DashboardRecordSummary[];
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
  memorySearchEndpoint?: string;
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

function isVisibleForDashboard(record: MorynRecord, includePrivate: boolean | undefined): boolean {
  // Soul/profile bodies are never part of the generic Dashboard content lane,
  // even when private records were explicitly requested. Soul Studio exposes
  // status metadata without rendering collaboration-clause text.
  if (record.kind === "soul") return false;
  return includePrivate === true || !isPrivateMemoryBoundary(record);
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

function eventRecordIds(event: MorynEvent): string[] {
  if (event.op === "upsert_record") return [event.record.id];
  if (event.op === "link_records") return [event.record_id, event.linked_record_id];
  return [event.record_id];
}

function eventEndpointsAreVisible(event: MorynEvent, visibleRecordIds: ReadonlySet<string>): boolean {
  return eventRecordIds(event).every((recordId) => visibleRecordIds.has(recordId));
}

function patchIntroducesPrivateBoundary(patch: Record<string, unknown>): boolean {
  const content = patch.content;
  const tags = patch.tags;
  const dottedPrivateTag = Object.entries(patch).some(
    ([path, value]) =>
      /^tags\.\d+$/u.test(path) &&
      typeof value === "string" &&
      ["private", "secret", "sensitive"].includes(value.trim().toLowerCase())
  );
  return (
    dottedPrivateTag ||
    (Array.isArray(tags) &&
      tags.some(
        (tag) => typeof tag === "string" && ["private", "secret", "sensitive"].includes(tag.trim().toLowerCase())
      )) ||
    (typeof content === "object" &&
      content !== null &&
      !Array.isArray(content) &&
      ((content as Record<string, unknown>).privacy === "private" ||
        (content as Record<string, unknown>).distribution === "local_only")) ||
    patch["content.privacy"] === "private" ||
    patch["content.distribution"] === "local_only"
  );
}

function recordIdsWithPrivateEventHistory(events: readonly MorynEvent[], records: readonly MorynRecord[]): Set<string> {
  const recordIds = new Set(records.filter(isPrivateMemoryBoundary).map((record) => record.id));
  for (const event of events) {
    if (event.op === "upsert_record" && isPrivateMemoryBoundary(event.record)) recordIds.add(event.record.id);
    if (event.op === "revise_record" && patchIntroducesPrivateBoundary(event.patch)) recordIds.add(event.record_id);
  }
  return recordIds;
}

function projectVisibleRecordReferences(record: MorynRecord, visibleRecordIds: ReadonlySet<string>): MorynRecord {
  const links = record.links?.filter((link) => visibleRecordIds.has(link.record_id));
  const conflictWith = record.conflict?.with.filter((recordId) => visibleRecordIds.has(recordId));
  const derivedFrom = record.provenance?.derived_from?.filter((recordId) => visibleRecordIds.has(recordId));
  const linksChanged = links?.length !== record.links?.length;
  const conflictChanged = conflictWith?.length !== record.conflict?.with.length;
  const provenanceChanged = derivedFrom?.length !== record.provenance?.derived_from?.length;
  if (!linksChanged && !conflictChanged && !provenanceChanged) return record;

  const projected = { ...record };
  if (linksChanged) projected.links = links;
  if (conflictChanged) {
    if (conflictWith?.length) projected.conflict = { ...record.conflict!, with: conflictWith };
    else delete projected.conflict;
  }
  if (provenanceChanged) {
    projected.provenance = { ...record.provenance };
    if (derivedFrom?.length) projected.provenance.derived_from = derivedFrom;
    else delete projected.provenance.derived_from;
  }
  return projected;
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

function actionTrace(
  eventId: string,
  recordId: string,
  projectId: string | undefined
): { timeline_command: string; recall_command: string } {
  return {
    timeline_command: timelineEventCommand(eventId, projectId),
    recall_command: recallCommand(recordId, projectId)
  };
}

function actionBatchTrace(
  eventIds: string[],
  recordIds: string[],
  projectId: string | undefined
): { timeline_commands: string[]; recall_commands: string[] } {
  return {
    timeline_commands: eventIds.map((eventId) => timelineEventCommand(eventId, projectId)),
    recall_commands: recordIds.map((recordId) => recallCommand(recordId, projectId))
  };
}

function latestEventsByRecord(events: MorynEvent[]): Map<string, MorynEvent> {
  const byRecord = new Map<string, MorynEvent>();
  for (const event of [...events].sort(
    (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
  )) {
    byRecord.set(targetRecordId(event) ?? "", event);
  }
  byRecord.delete("");
  return byRecord;
}

function eventRepoPath(event: MorynEvent): string {
  const deviceId = event.source.device_id ?? "device_default";
  const month = event.created_at.slice(0, 7);
  return `events/${deviceId}/${month}/${event.event_id}.json`;
}

function recordCitation(record: MorynRecord, eventsByRecord: Map<string, MorynEvent>): DashboardRecordCitation {
  const event = eventsByRecord.get(record.id);
  return {
    record_id: record.id,
    ...(event ? { event_id: event.event_id, event_path: eventRepoPath(event) } : {}),
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

const DASHBOARD_EVENT_CHANGE_LIMIT = 12;
const DASHBOARD_EVENT_CHANGE_VALUE_LIMIT = 2_000;

function eventChangeValue(value: unknown): { value: string; truncated: boolean } {
  const raw =
    typeof value === "string" ? value : value === undefined ? "—" : (JSON.stringify(value, null, 2) ?? String(value));
  const serialized = redactSensitiveContent(raw);
  if (serialized.length <= DASHBOARD_EVENT_CHANGE_VALUE_LIMIT) return { value: serialized, truncated: false };
  return {
    value: `${serialized.slice(0, DASHBOARD_EVENT_CHANGE_VALUE_LIMIT).trimEnd()}…`,
    truncated: true
  };
}

function flattenedEventChanges(
  value: Record<string, unknown>,
  prefix = "",
  depth = 0
): Array<{ path: string; value: unknown }> {
  const changes: Array<{ path: string; value: unknown }> = [];
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (nested && typeof nested === "object" && !Array.isArray(nested) && depth < 3) {
      const nestedChanges = flattenedEventChanges(nested as Record<string, unknown>, path, depth + 1);
      if (nestedChanges.length > 0) changes.push(...nestedChanges);
      else changes.push({ path, value: nested });
    } else {
      changes.push({ path, value: nested });
    }
  }
  return changes;
}

function dashboardEventChange(path: string, value: unknown): DashboardEventSummary["changes"][number] {
  if (path === "content.text") return { field: "content", ...eventChangeValue(value) };
  if (path === "type") return { field: "category", ...eventChangeValue(value) };
  if (path === "tags") return { field: "labels", ...eventChangeValue(value) };
  if (path === "confidence") return { field: "confidence", ...eventChangeValue(value) };
  if (path === "priority") return { field: "priority", ...eventChangeValue(value) };
  if (path === "project_id") return { field: "project", ...eventChangeValue(value) };
  // Do not copy arbitrary historical patch values into the Dashboard. The
  // event remains concrete through its affected content, outcome, reason, and
  // a bounded indication that another setting changed.
  return { field: "other", truncated: false };
}

function summarizeEvent(event: MorynEvent, recordsById: Map<string, MorynRecord>): DashboardEventSummary {
  const rawChanges =
    event.op === "upsert_record"
      ? [{ path: "content.text", value: recordText(event.record) }]
      : event.op === "revise_record"
        ? flattenedEventChanges(event.patch)
        : [];
  const mappedChanges = rawChanges
    .slice(0, DASHBOARD_EVENT_CHANGE_LIMIT)
    .map((change) => dashboardEventChange(change.path, change.value));
  const shownChanges = mappedChanges.filter(
    (change, index) => mappedChanges.findIndex((candidate) => candidate.field === change.field) === index
  );
  const targetState =
    event.op === "upsert_record"
      ? event.record.state
      : event.op === "promote_record"
        ? (event.target_state ?? "canonical")
        : event.op === "archive_record"
          ? (event.target_state ?? "archived")
          : event.op === "quarantine_record"
            ? (event.target_state ?? "quarantined")
            : undefined;
  return {
    event_id: event.event_id,
    op: event.op,
    record_id: targetRecordId(event),
    ...(event.op === "link_records" ? { linked_record_id: event.linked_record_id, link_type: event.link_type } : {}),
    ...(event.op !== "upsert_record" && event.reason ? { reason: eventChangeValue(event.reason) } : {}),
    ...(targetState ? { target_state: targetState } : {}),
    changes: shownChanges,
    changes_truncated: rawChanges.length > shownChanges.length,
    source: event.source,
    created_at: event.created_at,
    citation: eventCitation(event, recordsById)
  };
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

function summarizeAgentActivity(
  events: MorynEvent[],
  records: MorynRecord[],
  recordsById: Map<string, MorynRecord>,
  eventsByRecord: Map<string, MorynEvent>
): DashboardAgentActivity[] {
  const activity = new Map<string, DashboardAgentActivity>();

  for (const event of events) {
    updateAgentActivity(
      activity,
      event.source.client,
      "events",
      event.created_at,
      agentEventCitation(event, recordsById)
    );
  }

  for (const record of records) {
    const event = eventsByRecord.get(record.id);
    updateAgentActivity(
      activity,
      record.source.client,
      "records",
      record.updated_at,
      event ? agentEventCitation(event, recordsById) : undefined
    );
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

function sourceLabelZh(label: string): string {
  if (label === "User") return "用户";
  if (label === "Moryn Local") return "Moryn 本机";
  return label;
}

function titleCase(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

export function dashboardRecordTitleLabel(kind: MorynRecord["kind"], type?: string): { en: string; zh: string } {
  const raw = type || kind;
  const normalized = raw.toLowerCase();
  const en = titleCase(raw);
  if (normalized === "decision") return { en, zh: "决策" };
  if (normalized === "status") return { en, zh: "状态" };
  if (normalized === "summary") return { en, zh: "摘要" };
  if (normalized === "raw_note") return { en, zh: "临时笔记" };
  if (normalized === "warning") return { en, zh: "提醒" };
  if (normalized === "blocker") return { en, zh: "阻塞项" };
  if (normalized === "memory") return { en, zh: "记忆" };
  if (normalized === "skill") return { en, zh: "技能" };
  if (normalized === "soul") return { en, zh: "偏好" };
  if (normalized === "session_summary") return { en, zh: "会话记录" };
  if (normalized === "agent_note") return { en, zh: "代理记录" };
  return { en, zh: en };
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
      explanation:
        "Sync is not configured; this snapshot is useful locally, but other devices will not see these records yet.",
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
      description: `${candidates} item(s) are saved and searchable. They stay searchable unless you choose to make them long-term memory.`
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

export function memoryKindLabel(kind: RecordKind): { en: string; zh: string } {
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
        label: "Saved for later",
        zh_label: "已保存，稍后整理",
        count: newItems,
        source_states: ["candidate"]
      },
      {
        id: "temporary",
        label: "Saved briefly",
        zh_label: "临时保存",
        count: temporary,
        source_states: ["raw"]
      },
      {
        id: "set_aside",
        label: "Set aside",
        zh_label: "已放一边",
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

function summarizeValueRecord(
  record: MorynRecord,
  generatedAt: string,
  eventsByRecord: Map<string, MorynEvent>
): DashboardValueRecord {
  const title = dashboardRecordTitleLabel(record.kind, record.type);
  return {
    id: record.id,
    title: title.en,
    title_zh: title.zh,
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
  return [...records].sort((left, right) => {
    const timeDiff = right.updated_at.localeCompare(left.updated_at);
    const scoreDiff = recordValueScore(right) - recordValueScore(left);
    return timeDiff || scoreDiff || left.id.localeCompare(right.id);
  });
}

function buildRecentValue(
  records: MorynRecord[],
  generatedAt: string,
  limit: number,
  eventsByRecord: Map<string, MorynEvent>
): DashboardValueRecord[] {
  return valueRecordsNewestFirst(records)
    .slice(0, limit)
    .map((record) => summarizeValueRecord(record, generatedAt, eventsByRecord));
}

function buildStoredContentPreview(
  records: MorynRecord[],
  generatedAt: string,
  limit: number,
  eventsByRecord: Map<string, MorynEvent>
): DashboardValueRecord[] {
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
    return (
      ruleId === "low_risk_handoff_auto_capture" ||
      ruleId === "review_risk_marker" ||
      ruleId === "default_review_for_agent_handoff" ||
      ruleId === "smoke_test_marker" ||
      ruleId === "duplicate_text"
    );
  });
}

function captureEvidenceForRecord(record: MorynRecord): {
  current_task?: string;
  files?: string[];
  policy_decision?: string;
  policy_route?: string;
  policy_rule_ids: AutocapturePolicyRuleId[];
  policy_reasons: string[];
} {
  const capture = record.content.capture;
  if (typeof capture !== "object" || capture === null || Array.isArray(capture)) {
    return { policy_rule_ids: [], policy_reasons: [] };
  }
  const captureObject = capture as Record<string, unknown>;
  const policy = captureObject.policy;
  const policyObject =
    typeof policy === "object" && policy !== null && !Array.isArray(policy) ? (policy as Record<string, unknown>) : {};
  const files = Array.isArray(captureObject.files)
    ? captureObject.files.filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
  const reasons = Array.isArray(policyObject.reasons)
    ? policyObject.reasons.filter((reason): reason is string => typeof reason === "string" && reason.length > 0)
    : [];
  const decision = typeof policyObject.decision === "string" ? policyObject.decision : undefined;
  const route = typeof policyObject.route === "string" ? policyObject.route : undefined;
  const currentTask =
    typeof captureObject.current_task === "string" && captureObject.current_task.length > 0
      ? captureObject.current_task
      : undefined;
  return {
    ...(currentTask ? { current_task: currentTask } : {}),
    ...(files.length ? { files } : {}),
    ...(decision ? { policy_decision: decision } : {}),
    ...(route ? { policy_route: route } : {}),
    policy_rule_ids: capturePolicyRuleIds(record),
    policy_reasons: reasons
  };
}

function isAutoCapturedAutocapture(record: MorynRecord): boolean {
  return (
    record.state === "candidate" &&
    record.visibility === "active" &&
    record.tags.some((tag) => tag.toLowerCase() === "autocapture") &&
    (record.tags.some((tag) => tag.toLowerCase() === "auto-captured") ||
      recordCapturePolicyDecision(record) === "capture" ||
      currentPolicyTreatsAsLowRiskCapture(record))
  );
}

function isPolicyArchivedAutocapture(record: MorynRecord): boolean {
  return (
    record.state === "archived" &&
    record.visibility === "archived" &&
    record.tags.some((tag) => tag.toLowerCase() === "autocapture") &&
    record.tags.some((tag) => tag.toLowerCase() === "policy-archived")
  );
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
  const captureEvidence = captureEvidenceForRecord(record);
  return {
    id: record.id,
    group_id: groupId,
    kind: record.kind,
    type: record.type,
    project_id: record.project_id,
    text: recordText(record),
    ...captureEvidence,
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

function buildCaptureInbox(
  records: MorynRecord[],
  generatedAt: string,
  limit: number,
  eventsByRecord: Map<string, MorynEvent>
): DashboardCaptureInbox {
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
  const grouped = [...groups.values()].sort((left, right) => {
    const leftLatest = left.records[0]!.updated_at;
    const rightLatest = right.records[0]!.updated_at;
    return rightLatest.localeCompare(leftLatest) || left.groupId.localeCompare(right.groupId);
  });
  const displayedGroups = grouped.slice(0, limit);
  const displayedItems = displayedGroups.flatMap((group) => group.records);
  const groupSummaries = displayedGroups.map((group): DashboardCaptureInboxGroup => {
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
    items: displayedItems.map((record) => {
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
      message:
        input.recentDecisions.length > 0
          ? "Recent decisions include evidence paths."
          : "No recent decisions are currently available."
    }),
    contextPackReviewCheck({
      id: "open_threads",
      label: "Open threads",
      source: "context_pack_review.handoff_pack.open_threads[]",
      status: "pass",
      count: input.openThreads.length,
      message:
        input.openThreads.length > 0
          ? "Open handoff threads include evidence paths."
          : "No open handoff threads are currently available."
    }),
    contextPackReviewCheck({
      id: "risks",
      label: "Risks",
      source: "context_pack_review.handoff_pack.risks[]",
      status: "pass",
      count: input.risks.length,
      message: input.risks.length > 0 ? "Risks include evidence paths." : "No explicit risks are currently available."
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
    checks_by_id: Object.fromEntries(checks.map((check) => [check.id, check])) as Record<
      DashboardContextPackReviewCheckId,
      DashboardContextPackReviewCheck
    >,
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
    .filter(
      (record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined"
    );
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
  const nextActions: DashboardContextPackReviewNextAction[] = [
    {
      id: "capture_session",
      command: captureCommand,
      required_when: "Before ending a host session, capture a handoff summary for the next agent.",
      evidence: {
        source: "next.actions_by_id.capture_session",
        command: captureCommand
      }
    }
  ];
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
    ...inbox.items.flatMap(
      (item) =>
        [
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
        ] satisfies DashboardAction[]
    ),
    ...inbox.groups.flatMap(
      (group) =>
        [
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
        ] satisfies DashboardAction[]
    )
  ];
}

function capturePolicyActions(report: CapturePolicyResult): DashboardAction[] {
  return report.suggested_actions
    .filter(
      (action) =>
        action.recommended_action === "inspect_policy_archived_record" ||
        action.recommended_action === "inspect_auto_captured_handoff"
    )
    .flatMap((action): DashboardAction[] => {
      const recordId = typeof action.arguments.record_id === "string" ? action.arguments.record_id : undefined;
      if (!recordId) return [];
      return [
        {
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
        }
      ];
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
    .flatMap((group) => (group ? Object.values(group.promotion_drafts_by_id) : []))
    .map(
      (draft): DashboardAction => ({
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
      })
    );
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
  const captureInboxItems = input.captureInbox.groups.map(
    (group): DashboardDecisionSummaryItem => ({
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
    })
  );
  const maintenanceItems = input.maintenance.plans.map(
    (plan): DashboardDecisionSummaryItem => ({
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
    })
  );
  const candidateTriagePromotionItems = Object.values(input.candidateTriage.groups_by_id)
    .flatMap((group) => (group ? Object.values(group.promotion_drafts_by_id) : []))
    .map(
      (draft): DashboardDecisionSummaryItem => ({
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
      })
    );
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

function actionBoardSeverity(
  count: number,
  fallback: DashboardActionBoardSeverity = "good"
): DashboardActionBoardSeverity {
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
      next_action_label: "Open checks"
    };
  }
  return {
    hint: reviewItems.length === 0 ? "No check needed" : "Important checks found",
    detail: "Important checks stay visible in Needs a look.",
    next_action_label: reviewItems.length === 0 ? "Open checks" : "Review what changed"
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
  const syncNeedsAction =
    input.health.status === "sync_pending" ||
    input.health.status === "conflict" ||
    input.health.status === "local_only";
  const syncSeverity: DashboardActionBoardSeverity =
    input.health.status === "conflict"
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
    items_by_id: Object.fromEntries(items.map((item) => [item.id, item])) as Record<
      DashboardActionBoardItemId,
      DashboardActionBoardItem
    >
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
  const primary =
    actionPrimary.next_action_label === "All clear" && input.memoryInventory.review_suggested
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
  const primaryTargetLabel =
    primary.id === "confirm" && primary.value > 0 ? "Review approvals" : actionCardPrimary.next_action_label;
  const headline = primary.next_action_label;
  const primaryActionLabel =
    primary.id === "confirm" && primary.value > 0
      ? "Review approvals"
      : primary.source === "memory_inventory"
        ? primary.hint
        : actionCardPrimary.next_action_label;
  const zhDetail =
    primary.source === "memory_inventory" ? memoryInventoryReviewDetailZh(input.memoryInventory) : undefined;
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
        : (input.contextPackReview.unavailable_reason ?? "Project context is required for Context Pack Review."),
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
    cards_by_id: Object.fromEntries(cards.map((card) => [card.id, card])) as Record<
      DashboardOverviewCardId,
      DashboardOverviewCard
    >,
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

function firstActionForRecords<T extends { action_id: string; arguments: Record<string, unknown> }>(
  actions: T[],
  recordIds: string[]
): T | undefined {
  const recordIdSet = new Set(recordIds);
  return actions.find((action) => {
    const recordId = action.arguments.record_id;
    if (typeof recordId === "string" && recordIdSet.has(recordId)) return true;
    const recordIdsArg = action.arguments.record_ids;
    return (
      Array.isArray(recordIdsArg) &&
      recordIdsArg.some((candidate) => typeof candidate === "string" && recordIdSet.has(candidate))
    );
  });
}

function governanceFromCapturePolicy(report: CapturePolicyResult): DashboardGovernanceItem[] {
  return report.findings.map((finding): DashboardGovernanceItem => {
    const firstAction = firstActionForRecords(report.suggested_actions, finding.record_ids);
    const isReview = finding.id === "review_required";
    const category = finding.category === "review_queue" ? "capture_review" : finding.category;
    const evidencePath = `capture_policy.findings_by_id.${finding.id}`;
    const actionLabel = isReview
      ? "Review in Capture Inbox"
      : (firstAction?.recommended_action ?? "Inspect capture policy finding");
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
      ...(firstAction && !isReview
        ? { action_id: capturePolicyInspectActionId(String(firstAction.arguments.record_id)) }
        : {}),
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
  return report.findings.map((finding) => {
    const evidencePath = `memory_doctor.findings_by_id.${finding.id}`;
    const category: DashboardGovernanceCategory =
      finding.id === "candidate_backlog"
        ? "candidate_backlog"
        : finding.category === "candidate_quality"
          ? "candidate_quality"
          : finding.category === "project_identity"
            ? "project_identity"
            : "candidate_backlog";
    const actionLabel =
      finding.id === "candidate_backlog"
        ? "Review candidate backlog"
        : finding.id === "duplicate_candidates"
          ? "Review duplicate candidates"
          : finding.id === "conflicting_candidates"
            ? "Review conflicting candidates"
            : "Review memory doctor finding";
    return {
      id: governanceItemId("memory_doctor", finding.id),
      source: "memory_doctor",
      category,
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
        category,
        actionLabel,
        evidencePath,
        requiresUserConfirmation: false,
        writes: "none"
      })
    };
  });
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
    const firstAction =
      finding.id === "capture_review_backlog"
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
  return report.cases
    .filter((testCase) => testCase.status === "fail")
    .map((testCase): DashboardGovernanceItem => {
      const action =
        report.suggested_actions_by_id[`revise-golden-case:${testCase.case_id}`] ??
        report.suggested_actions_by_id[`inspect-hidden-records:${testCase.case_id}`];
      const evidencePath = `recall_eval.report.cases_by_id.${testCase.case_id}`;
      const actionLabel = action?.recommended_action ?? "Inspect recall eval case";
      const recordIds = recallEvalCaseRecordIds(testCase);
      return {
        id: governanceItemId("recall_eval", testCase.case_id),
        source: "recall_eval",
        category: "recall_quality",
        severity: "warning",
        title: `Recall eval missed ${testCase.case_id}`,
        summary: `Query "${testCase.query}" ${recallEvalCaseFindingText(testCase)}.`,
        record_ids: recordIds,
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

function recallEvalCaseRecordIds(testCase: RecallEvalReport["cases"][number]): string[] {
  return [...new Set([...testCase.missing_record_ids, ...testCase.hidden_record_ids])];
}

function recallEvalCaseFindingText(testCase: RecallEvalReport["cases"][number]): string {
  const parts = [
    testCase.missing_record_ids.length
      ? `missed ${pluralize(testCase.missing_record_ids.length, "expected record")}`
      : "",
    testCase.hidden_record_ids.length ? `hid ${pluralize(testCase.hidden_record_ids.length, "expected record")}` : ""
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : "failed without listed missing or hidden records";
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

function candidateTriagePromotionDraft(
  groupId: "promotable",
  record: DashboardCandidateTriageRecord
): DashboardCandidateTriagePromotionDraft {
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
  const promotionDrafts =
    input.id === "promotable"
      ? Object.fromEntries(
          input.records.map((record) => [record.id, candidateTriagePromotionDraft("promotable", record)])
        )
      : {};
  return {
    ...input,
    records: sampleRecords,
    writes: "none",
    requires_user_confirmation: false,
    record_ids: input.records.map((record) => record.id),
    records_by_id: Object.fromEntries(
      input.records.map((record, index) => [
        record.id,
        {
          id: record.id,
          record_index: index,
          evidence_path:
            index < CANDIDATE_TRIAGE_SAMPLE_LIMIT
              ? `candidate_triage.groups_by_id.${input.id}.records[${index}]`
              : `candidate_triage.groups_by_id.${input.id}.record_ids[${index}]`
        }
      ])
    ),
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

function candidateTriageReviewFocus(
  groups: DashboardCandidateTriageGroup[]
): DashboardCandidateTriageReviewFocus | undefined {
  const focusOrder: DashboardCandidateTriageGroupId[] = [
    "promotable",
    "likely_noise",
    "needs_inspection",
    "session_summaries"
  ];
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
  const takeGroup = (predicate: (record: MorynRecord) => boolean, reason: string): DashboardCandidateTriageRecord[] => {
    const group = candidateRecords
      .filter((record) => !grouped.has(record.id))
      .filter(predicate)
      .slice(0, limit)
      .map((record) => toCandidateTriageRecord(record, eventsByRecord, nowIso, reason));
    for (const record of group) grouped.add(record.id);
    return group;
  };

  const likelyNoise = takeGroup(isCandidateTriageNoise, "Matches smoke, test, fixture, e2e, or marker language.");
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
        guidance:
          "Reject eligible Capture Inbox candidates; archive confirmed noise only through explicit Memory Doctor guidance.",
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
        guidance:
          "Keep useful handoff summaries available for context; promote only when they describe durable memory.",
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
    .map(
      (record): DashboardRecallEvalCaseSource => ({
        record_id: record.id,
        case_count: recallEvalRecordCases(record).length,
        evidence_path: `recent_records.${record.id}.content.cases`
      })
    )
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
  const currentRecordRead = await readCurrentRecords(storePath);
  const allRecordsById = new Map(currentRecordRead.records.map((record) => [record.id, record]));
  const allRecords = [...allRecordsById.values()];
  const dashboardContentRecords = allRecords.filter((record) => record.kind !== "soul");
  const privateHistoryRecordIds = recordIdsWithPrivateEventHistory(events, dashboardContentRecords);
  const visibleRecordIds = new Set(
    dashboardContentRecords
      .filter((record) => isVisibleForDashboard(record, options.include_private))
      .map((record) => record.id)
  );
  const records = dashboardContentRecords
    .filter((record) => visibleRecordIds.has(record.id))
    .map((record) => {
      const projected = projectVisibleRecordReferences(record, visibleRecordIds);
      if (options.include_private === true || !privateHistoryRecordIds.has(record.id)) return projected;
      return { ...projected, source: { client: "protected-history" } };
    });
  const logicalView = buildActiveLogicalMemoryView(records);
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const eventVisibleRecordIds =
    options.include_private === true
      ? visibleRecordIds
      : new Set([...visibleRecordIds].filter((recordId) => !privateHistoryRecordIds.has(recordId)));
  const memoryMaintenanceVisibleRecordIds = new Set(
    [...eventVisibleRecordIds].filter((recordId) => {
      const record = allRecordsById.get(recordId);
      return record !== undefined && recordProjectMatchesDashboard(record, options.project_id);
    })
  );
  const visibleEvents = events.filter((event) => eventEndpointsAreVisible(event, eventVisibleRecordIds));
  const eventsByRecord = latestEventsByRecord(visibleEvents);
  const allRecordsSorted = [...records].sort(
    (left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id)
  );
  const recentRecords = allRecordsSorted.slice(0, limit);
  const recentEvents = [...visibleEvents]
    .sort(
      (left, right) => right.created_at.localeCompare(left.created_at) || left.event_id.localeCompare(right.event_id)
    )
    .slice(0, limit);
  const generatedAt = options.now ?? new Date().toISOString();
  const activationReceipts = records
    .filter(
      (record) =>
        record.type === "activation_receipt" && (!options.project_id || record.project_id === options.project_id)
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.id.localeCompare(right.id));
  const latestActivationReceipt = activationReceipts[0];
  const activationHost: "codex" | "claude" | "unknown" =
    latestActivationReceipt?.content.host === "codex" || latestActivationReceipt?.content.host === "claude"
      ? latestActivationReceipt.content.host
      : "unknown";
  const activationFresh = latestActivationReceipt
    ? Date.parse(generatedAt) - Date.parse(latestActivationReceipt.created_at) <= 24 * 60 * 60 * 1000
    : false;
  const autopilot: DashboardData["quiet_dashboard"]["system_pulse"]["autopilot"] = latestActivationReceipt
    ? {
        status: activationFresh ? ("active" as const) : ("degraded" as const),
        host: activationHost,
        ...(typeof latestActivationReceipt.content.event === "string"
          ? { last_event: latestActivationReceipt.content.event }
          : {}),
        last_seen_at: latestActivationReceipt.created_at
      }
    : { status: "not_installed" as const, host: "unknown" as const };
  const semanticLinkEvents = visibleEvents.filter(
    (event) => event.op === "link_records" && event.event_id.startsWith("evt_semantic_consolidation_")
  );
  const semanticLinkKeys = new Set(
    semanticLinkEvents.map((event) =>
      event.op === "link_records" ? `${event.record_id}\u0000${event.linked_record_id}\u0000${event.link_type}` : ""
    )
  );
  const checkpointProposals = records.flatMap((record) => {
    const checkpoint = record.content.checkpoint;
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return [];
    const proposals = (checkpoint as Record<string, unknown>).semantic_consolidation_proposals;
    return Array.isArray(proposals)
      ? proposals.filter((proposal): proposal is Record<string, unknown> =>
          Boolean(proposal && typeof proposal === "object" && !Array.isArray(proposal))
        )
      : [];
  });
  const semanticRejectedProposals = checkpointProposals.filter(
    (proposal) =>
      !semanticLinkKeys.has(
        `${proposal.source_record_id}\u0000${proposal.target_record_id}\u0000${proposal.relationship}`
      )
  ).length;
  const investigationsById = new Map<string, Record<string, unknown>>();
  for (const record of [...records].sort(
    (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
  )) {
    const checkpoint = record.content.checkpoint;
    if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) continue;
    const investigations = (checkpoint as Record<string, unknown>).knowledge_investigations;
    if (!Array.isArray(investigations)) continue;
    for (const investigation of investigations) {
      if (!investigation || typeof investigation !== "object" || Array.isArray(investigation)) continue;
      const resolutionId = (investigation as Record<string, unknown>).resolution_id;
      if (typeof resolutionId === "string")
        investigationsById.set(resolutionId, investigation as Record<string, unknown>);
    }
  }
  const knowledgeInvestigations = [...investigationsById.values()];
  const learnedRecords = records.filter((record) => record.tags.includes("learning"));
  const sync = await getGitSyncStatus(storePath);
  const agentActivity = summarizeAgentActivity(visibleEvents, records, recordsById, eventsByRecord);
  const lifecycleAllRecords = dashboardContentRecords.filter((record) =>
    recordProjectMatchesDashboard(record, options.project_id)
  );
  const lifecycleRecords = records.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
  const capturePolicyAllRecords = dashboardContentRecords.filter((record) => {
    return !options.project_id || record.project_id === options.project_id;
  });
  const capturePolicyRecords = records.filter(
    (record) => !options.project_id || record.project_id === options.project_id
  );
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
  const maintenanceData = buildDashboardMaintenance(dashboardContentRecords, {
    project_id: options.project_id,
    include_private: options.include_private
  });
  const memoryLifecycleData = diagnoseMemoryLifecycle({
    records: lifecycleRecords,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    now: generatedAt,
    private_record_ids: lifecycleAllRecords.filter(isPrivateMemoryBoundary).map((record) => record.id),
    excluded_private_records: lifecycleAllRecords.length - lifecycleRecords.length
  });
  const memoryDoctorAllRecords = dashboardContentRecords.filter((record) =>
    recordProjectMatchesDashboard(record, options.project_id)
  );
  const memoryDoctorRecords = records.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
  const memoryDoctorData = diagnoseMemory({
    records: memoryDoctorRecords,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: memoryDoctorAllRecords.length - memoryDoctorRecords.length
  });
  const candidateTriageData = buildCandidateTriage(memoryDoctorRecords, eventsByRecord, generatedAt, limit);
  const dogfoodAllRecords = dashboardContentRecords.filter((record) =>
    recordProjectMatchesDogfood(record, options.project_id)
  );
  const dogfoodRecords = records.filter((record) => recordProjectMatchesDogfood(record, options.project_id));
  const dogfoodRecordIds = new Set(dogfoodRecords.map((record) => record.id));
  const dogfoodEvents = visibleEvents.filter((event) => eventEndpointsAreVisible(event, dogfoodRecordIds));
  const dogfoodReportData = diagnoseDogfood({
    records: dogfoodRecords,
    events: dogfoodEvents,
    project_id: options.project_id,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: dogfoodAllRecords.length - dogfoodRecords.length
  });
  const healthCheckAllRecords = dashboardContentRecords.filter((record) =>
    recordProjectMatchesDashboard(record, options.project_id)
  );
  const healthCheckRecords = records.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
  const healthCheckRecordIds = new Set(healthCheckRecords.map((record) => record.id));
  const healthCheckEvents = visibleEvents.filter((event) => eventEndpointsAreVisible(event, healthCheckRecordIds));
  const latestSyncCompensation = await readSyncCompensationReceipt(storePath);
  const syncCompensation =
    latestSyncCompensation && (!options.project_id || latestSyncCompensation.project_id === options.project_id)
      ? latestSyncCompensation
      : undefined;
  const healthCheckData = diagnoseHealthCheck({
    records: healthCheckRecords,
    events: healthCheckEvents,
    project_id: options.project_id,
    host: options.readiness_host,
    sync_remote: options.sync_remote,
    limit,
    include_private: options.include_private === true,
    excluded_private_records: healthCheckAllRecords.length - healthCheckRecords.length,
    record_read_model: currentRecordRead,
    ...(options.project_id
      ? {
          retrieval_index: await readRetrievalCandidates(storePath, {
            project_id: options.project_id,
            read_current_records: async () => currentRecordRead
          })
        }
      : {}),
    ...(syncCompensation ? { sync_compensation: syncCompensation } : {})
  });
  const recallEvalData = await buildDashboardRecallEval(storePath, records, options);
  const dashboardV04Data = await buildDashboardV04Data(storePath, allRecords, {
    project_id: options.project_id,
    now: generatedAt,
    visible_record_ids: memoryMaintenanceVisibleRecordIds
  });
  const workingSetReport = summarizeWorkingSet(records, visibleEvents);
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
  const latestCheckpoint = recentRecords.find(
    (record) => record.kind === "session_summary" && record.type === "checkpoint"
  );
  const latestHandoff = recentRecords.find((record) => record.kind === "session_summary" && record.type === "summary");
  const activeContextRecord = latestCheckpoint ?? latestHandoff ?? recentRecords[0];
  const checkpointContent = latestCheckpoint ? allRecordsById.get(latestCheckpoint.id)?.content.checkpoint : undefined;
  const checkpointTask =
    checkpointContent &&
    typeof checkpointContent === "object" &&
    checkpointContent !== null &&
    typeof (checkpointContent as Record<string, unknown>).current_task === "string"
      ? ((checkpointContent as Record<string, unknown>).current_task as string)
      : undefined;
  const sessionSynthesis = {
    host_authored: records.filter(
      (record) => record.kind === "session_summary" && record.content.synthesis_mode === "host_authored"
    ).length,
    evidence_synthesized: records.filter(
      (record) => record.kind === "session_summary" && record.content.synthesis_mode === "evidence_synthesized"
    ).length,
    minimal_fallback: records.filter(
      (record) => record.kind === "session_summary" && record.content.synthesis_mode === "minimal_fallback"
    ).length
  };
  const routineMaintenanceDecisionIds = new Set(
    maintenanceData.plans
      .filter((plan) => plan.type === "candidate_noise_archive")
      .map((plan) => `maintenance_review:${plan.plan_hash.replace(/^sha256:/, "")}`)
  );
  const exceptionalAttention: DashboardAttentionItem[] = [
    ...attentionItems.filter(
      (item) =>
        (item.severity === "warning" || item.severity === "critical") && item.title !== "Sync changes not pushed"
    ),
    ...decisionSummaryData.items
      .filter((item) => !routineMaintenanceDecisionIds.has(item.id))
      .map((item) => ({
        severity: "warning" as const,
        title: item.title,
        description: item.summary,
        action_label: item.target_label
      }))
  ];
  if (sessionSynthesis.minimal_fallback >= 2) {
    exceptionalAttention.push({
      severity: "warning",
      title: "Session summaries lack durable evidence",
      description: `${sessionSynthesis.minimal_fallback} session summaries used minimal fallback because no durable checkpoint evidence was available.`
    });
  }
  const currentTaskTokens = new Set((checkpointTask ?? "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const materialSemanticConflicts = semanticLinkEvents.filter((event) => {
    if (event.op !== "link_records" || event.link_type !== "conflicts_with" || !currentTaskTokens.size) return false;
    const text =
      `${allRecordsById.get(event.record_id)?.content.text ?? ""} ${allRecordsById.get(event.linked_record_id)?.content.text ?? ""}`.toLocaleLowerCase();
    return [...currentTaskTokens].some((token) => token.length > 3 && text.includes(token));
  });
  exceptionalAttention.push(
    ...materialSemanticConflicts.map(() => ({
      severity: "warning" as const,
      title: "Semantic memory conflict",
      description:
        "A material memory conflict overlaps the current task. Inspect the conflicting records under Technical details."
    }))
  );

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
    logical_memory: {
      store_records: records.length,
      active_working_set_records: logicalView.active_records.length,
      hidden_logical_records: Object.keys(logicalView.hidden_by_record_id).length,
      conflict_records: logicalView.conflict_record_ids.length,
      cycle_findings: logicalView.findings.length,
      learned_records: records.filter((record) => record.tags.includes("learning")).length,
      learned_canonical_records: records.filter(
        (record) => record.tags.includes("learning") && record.state === "canonical"
      ).length,
      learned_candidate_records: records.filter(
        (record) => record.tags.includes("learning") && record.state === "candidate"
      ).length,
      learning_evidence_links: records.reduce(
        (count, record) =>
          count +
          (record.links?.filter(
            (link) => link.link_type === "supports" && link.reason?.startsWith("Learning evidence:")
          ).length ?? 0),
        0
      )
    },
    quiet_dashboard: {
      system_pulse: {
        healthy: health.status !== "conflict" && health.status !== "needs_review" && exceptionalAttention.length === 0,
        status: health.status,
        store_ready: true,
        sync_state: sync.sync_state ?? (sync.configured ? "unknown" : "local_only"),
        context_protected: Boolean(latestCheckpoint || latestHandoff),
        autopilot_active: autopilot.status === "active",
        autopilot
      },
      current_context: {
        project_id: options.project_id ?? activeContextRecord?.project_id,
        task: checkpointTask,
        agent: activeContextRecord?.source.client,
        device_id: activeContextRecord?.source.device_id,
        checkpoint_available: Boolean(latestCheckpoint),
        handoff_available: Boolean(latestHandoff),
        checkpoint_record_id: latestCheckpoint?.id,
        handoff_record_id: latestHandoff?.id
      },
      memory_flow: {
        store_events: workingSetReport.total_events,
        store_records: workingSetReport.total_records,
        active_working_set_records: workingSetReport.active_logical_records,
        hidden_logical_records:
          workingSetReport.hidden_duplicate_records +
          workingSetReport.hidden_superseded_records +
          workingSetReport.hidden_revised_records,
        hidden_duplicate_records: workingSetReport.hidden_duplicate_records,
        hidden_superseded_records: workingSetReport.hidden_superseded_records,
        hidden_revised_records: workingSetReport.hidden_revised_records,
        conflict_records: workingSetReport.conflict_records,
        cycle_findings: workingSetReport.cycle_findings,
        default_boot_records: workingSetReport.default_boot_records,
        compaction_ratio: workingSetReport.compaction_ratio,
        learned_records: records.filter((record) => record.tags.includes("learning")).length,
        semantic_equivalent_links: semanticLinkEvents.filter(
          (event) => event.op === "link_records" && event.link_type === "duplicate_of"
        ).length,
        semantic_revision_links: semanticLinkEvents.filter(
          (event) => event.op === "link_records" && event.link_type === "revises"
        ).length,
        semantic_superseded_links: semanticLinkEvents.filter(
          (event) => event.op === "link_records" && event.link_type === "supersedes"
        ).length,
        semantic_conflict_links: semanticLinkEvents.filter(
          (event) => event.op === "link_records" && event.link_type === "conflicts_with"
        ).length,
        semantic_rejected_proposals: semanticRejectedProposals,
        recent_records: recentRecords.length,
        recent_events: recentEvents.length,
        sync_state: sync.sync_state ?? (sync.configured ? "unknown" : "local_only")
      },
      knowledge_loop: {
        learned_records: learnedRecords.length,
        learned_canonical_records: learnedRecords.filter((record) => record.state === "canonical").length,
        learned_candidate_records: learnedRecords.filter((record) => record.state === "candidate").length,
        investigations: knowledgeInvestigations.length,
        resolved_investigations: knowledgeInvestigations.filter((investigation) => investigation.status === "resolved")
          .length,
        unresolved_investigations: knowledgeInvestigations.filter(
          (investigation) => investigation.status === "unresolved"
        ).length,
        preserved_before_compact: knowledgeInvestigations.filter(
          (investigation) => investigation.status === "unresolved" && typeof investigation.next_step === "string"
        ).length
      },
      session_synthesis: sessionSynthesis,
      attention_needed: exceptionalAttention
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
    memory_maintenance: dashboardV04Data.memory_maintenance,
    soul_studio: dashboardV04Data.soul_studio,
    dogfood_report: dogfoodReportData,
    stored_content_preview: buildStoredContentPreview(records, generatedAt, 4, eventsByRecord),
    recent_value: buildRecentValue(records, generatedAt, Math.min(limit, RECENT_VALUE_LIMIT), eventsByRecord),
    recent_records: recentRecords.map((record) => summarizeRecord(record, eventsByRecord)),
    all_records: allRecordsSorted.map((record) => summarizeRecord(record, eventsByRecord)),
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
  if (label === "Local Ready") return "本机可用";
  if (status === "sync_pending" || label === "Sync Pending") return "等待同步";
  if (status === "needs_review" || label === "Needs Review") return "需要查看";
  if (status === "conflict" || label === "Conflict") return "需要处理冲突";
  if (status === "local_only" || label === "Local Only") return "仅本机";
  return label;
}

function dashboardDisplayHealth(data: DashboardData): { label: string; status: DashboardHealthStatus | "local_ready" } {
  if (data.health.status === "conflict") return { label: data.health.label, status: data.health.status };
  if (data.quiet_dashboard.attention_needed.length > 0) return { label: "Needs Review", status: "needs_review" };
  if (data.health.status === "sync_pending") return { label: "Local Ready", status: "local_ready" };
  return { label: data.health.label, status: data.health.status };
}

function syncLabel(sync: GitSyncStatus): string {
  if (sync.sync_state === "dirty") return "Local changes";
  if (sync.sync_state) return titleCase(sync.sync_state);
  return sync.configured ? "Configured" : "Not configured";
}

function recordLabel(recordId: string): string {
  const generated = recordId.match(/^rec_[0-9a-f]{16,}$/i);
  if (!generated) return recordId;
  return recordId.slice(0, 12);
}

function deviceLabel(deviceId: string): string {
  const generated = deviceId.match(/^device_([0-9a-f]{12,})$/i);
  return generated ? `device · ${generated[1]?.slice(0, 6)}` : deviceId;
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
  const target = captureInbox.total > 0 ? "capture-inbox" : "stored-content";
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
  return (
    priority
      .map((id) => actionBoardData.items_by_id[id])
      .find((item) => item.value > 0 && item.severity !== "good") ?? {
      ...actionBoardData.items_by_id.inspect,
      value: 0,
      severity: "good",
      summary: inspectCount > 0 ? `${pluralize(inspectCount, "safe check")} available` : "No action needed",
      hint: "No action needed",
      detail:
        "No confirmations, warnings, or sync actions need attention. Read-only inspections remain available below.",
      next_action_label: "All clear",
      target: inspectCount > 0 ? "governance-hub" : "needs-attention"
    }
  );
}

function joinHumanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function healthClass(status: DashboardHealthStatus | "local_ready"): string {
  if (status === "healthy") return "good";
  if (status === "conflict") return "critical";
  if (status === "needs_review" || status === "sync_pending") return "warning";
  return "info";
}

function maintenancePlanEndpoint(plan: DashboardMaintenancePlan): string {
  return `api/maintenance/plans/${encodeURIComponent(plan.plan_id)}/approve`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
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

function dashboardLanguageToggle(): string {
  return `
      <div data-dashboard-language-toggle class="editorial-language-switch" aria-label="Language">
        <span class="editorial-language-label" data-i18n-en="Language" data-i18n-zh="语言">Language</span>
        <div class="editorial-language-options" role="group" aria-label="Language">
          <button type="button" class="language-option active" data-dashboard-language-option="en" aria-pressed="true"><span>EN</span></button>
          <button type="button" class="language-option" data-dashboard-language-option="zh" aria-pressed="false"><span>中文</span></button>
        </div>
      </div>
  `;
}

export function memoryStateLabelFromRecordState(state: MorynRecord["state"]): { en: string; zh: string } {
  if (state === "canonical") return { en: "Ready to use", zh: "可直接使用" };
  if (state === "candidate") return { en: "Saved for later", zh: "已保存，稍后整理" };
  if (state === "raw") return { en: "Saved briefly", zh: "临时保存" };
  if (state === "archived") return { en: "Archived", zh: "已归档" };
  if (state === "quarantined") return { en: "Set aside", zh: "已隔离" };
  return { en: "Set aside", zh: "已放一边" };
}

function quietSystemPulse(data: DashboardData): string {
  const pulse = data.quiet_dashboard.system_pulse;
  const displayHealth = dashboardDisplayHealth(data);
  const pulseLabel = pulse.healthy
    ? data.health.status === "sync_pending"
      ? "Local memory ready"
      : "All systems steady"
    : displayHealth.label;
  const pulseLabelZh = pulse.healthy
    ? data.health.status === "sync_pending"
      ? "本机记忆可用"
      : "系统运行平稳"
    : dashboardHealthZh(
        displayHealth.status === "local_ready" ? "local_only" : displayHealth.status,
        displayHealth.label
      );
  const autopilotLabel =
    pulse.autopilot.status === "not_installed"
      ? "Not installed"
      : `${pulse.autopilot.status[0]?.toUpperCase()}${pulse.autopilot.status.slice(1)} · ${pulse.autopilot.host === "claude" ? "Claude" : pulse.autopilot.host === "codex" ? "Codex" : "Unknown"}`;
  return `
    <section class="quiet-pulse-band ${pulse.healthy ? "healthy" : "attention"}" data-quiet-section="system-pulse">
      <div class="quiet-panel-heading">
        ${i18nText("System Pulse", "系统脉搏", "span")}
        <strong ${i18nAttribute(pulseLabel, pulseLabelZh)}>${escapeHtml(pulseLabel)}</strong>
      </div>
      <div class="quiet-signal-grid">
        <div><span>Store</span><strong>${pulse.store_ready ? "Ready" : "Unavailable"}</strong></div>
        <div><span>Sync</span><strong>${escapeHtml(pulse.sync_state.replaceAll("_", " "))}</strong></div>
        <div><span>Context</span><strong>${pulse.context_protected ? "Protected" : "Waiting"}</strong></div>
        <div><span>Autopilot</span><strong>${escapeHtml(autopilotLabel)}</strong></div>
      </div>
    </section>`;
}

function quietCurrentContext(data: DashboardData): string {
  const context = data.quiet_dashboard.current_context;
  return `
    <section class="quiet-context-primary" data-quiet-section="current-context">
      <div class="quiet-panel-heading">${i18nText("Current Context", "当前上下文", "span")}<strong class="quiet-current-task">${escapeHtml(context.task ?? "No active task")}</strong></div>
      <dl class="quiet-context-list">
        <div><dt>Project</dt><dd>${escapeHtml(context.project_id ?? "Not resolved")}</dd></div>
        <div><dt>Agent</dt><dd>${escapeHtml(context.agent ?? "No recent agent")}</dd></div>
        <div><dt>Device</dt><dd${context.device_id ? ` title="${escapeHtml(context.device_id)}"` : ""}>${escapeHtml(context.device_id ? deviceLabel(context.device_id) : "Unknown")}</dd></div>
        <div><dt>Continuity</dt><dd>${context.checkpoint_available ? "Checkpoint protected" : context.handoff_available ? "Handoff available" : "No checkpoint yet"}</dd></div>
      </dl>
    </section>`;
}

function quietMemoryFlow(data: DashboardData): string {
  const flow = data.quiet_dashboard.memory_flow;
  const loop = data.quiet_dashboard.knowledge_loop;
  const consolidationPercent = Math.round(flow.compaction_ratio * 100);
  return `
    <section class="quiet-memory-secondary" data-quiet-section="memory-flow">
      <div class="quiet-panel-heading">${i18nText("Memory Flow", "记忆流", "span")}<strong>${flow.active_working_set_records} active</strong></div>
      <div class="quiet-flow-strip" data-quiet-flow-summary aria-label="Memory flow summary">
        <div><span>Available</span><strong>${flow.active_working_set_records}</strong><small>active knowledge</small></div>
        <div><span>Reduced</span><strong>${consolidationPercent}%</strong><small>${flow.hidden_logical_records} duplicate or replaced</small></div>
        <div><span>Learned</span><strong>${flow.learned_records}</strong><small>${loop.resolved_investigations} investigations resolved</small></div>
      </div>
      <details class="quiet-flow-details" data-dashboard-detail="quiet-flow-details">
        <summary><span>Flow details</span><small>${escapeHtml(`sync ${flow.sync_state.replaceAll("_", " ")}`)}</small></summary>
        <div class="quiet-flow-detail-grid">
          <div><span>Store</span><strong>${flow.store_records} records · ${flow.store_events} events</strong></div>
          <div><span>Recent</span><strong>${flow.recent_records} records · ${flow.recent_events} events</strong></div>
          <div><span>Relationships</span><strong>${flow.semantic_equivalent_links} equivalent · ${flow.semantic_revision_links} revised · ${flow.semantic_superseded_links} superseded · ${flow.semantic_conflict_links} conflicts</strong></div>
          <div><span>Knowledge loop</span><strong>${loop.learned_canonical_records} canonical · ${loop.learned_candidate_records} candidate · ${loop.unresolved_investigations} unresolved preserved</strong></div>
        </div>
      </details>
    </section>`;
}

function quietAttention(data: DashboardData): string {
  const items = data.quiet_dashboard.attention_needed;
  if (!items.length) return "";
  return `
    <section class="quiet-attention" data-quiet-section="attention-needed">
      <div class="quiet-panel-heading">${i18nText("Attention Needed", "需要关注", "span")}<strong>${items.length}</strong></div>
      <div class="quiet-attention-list">${items.map((item) => `<article><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p>${item.action_label ? `<small>${escapeHtml(item.action_label)}</small>` : ""}</article>`).join("")}</div>
    </section>`;
}

function quietDashboardFirstScreen(data: DashboardData): string {
  return `
    <section class="quiet-dashboard" data-quiet-dashboard="first-screen" aria-label="Moryn monitoring overview">
      <div class="quiet-dashboard-shell">
        ${quietSystemPulse(data)}
        <div class="quiet-context-flow">${quietCurrentContext(data)}${quietMemoryFlow(data)}</div>
        ${quietAttention(data)}
      </div>
    </section>`;
}

function plainEventSentence(event: DashboardEventSummary): { en: string; zh: string } {
  const source = humanSourceLabel(event.source);
  const sourceZh = sourceLabelZh(source);
  const byEn = source && source !== "unknown" ? ` from ${source}` : "";
  const byZh = sourceZh && sourceZh !== "unknown" ? `${sourceZh} ` : "";
  const map: Partial<Record<DashboardEventSummary["op"], { en: string; zh: string }>> = {
    upsert_record: { en: `Saved a memory${byEn}`, zh: `${byZh}保存了一条记忆` },
    revise_record: { en: `Updated a memory${byEn}`, zh: `${byZh}更新了一条记忆` },
    promote_record: { en: `Confirmed a memory as ready${byEn}`, zh: `${byZh}将一条记忆确认为可用` },
    archive_record: { en: `Archived a memory${byEn}`, zh: `${byZh}归档了一条记忆` },
    quarantine_record: { en: `Set a memory aside for review${byEn}`, zh: `${byZh}将一条记忆搁置待查` },
    link_records: { en: `Linked related memories${byEn}`, zh: `${byZh}关联了相关记忆` }
  };
  return map[event.op] ?? { en: `${titleCase(event.op)}${byEn}`, zh: `${byZh}${titleCase(event.op)}` };
}

function plainHistoryTimeline(data: DashboardData): string {
  const events = data.recent_events.slice(0, 12);
  if (events.length === 0) {
    return `<section class="history-timeline" data-history-timeline aria-label="Recent activity"><p class="history-empty" data-i18n-en="Nothing has happened yet. New saves and changes will appear here." data-i18n-zh="还没有任何动态。新的保存和变化会显示在这里。">Nothing has happened yet. New saves and changes will appear here.</p></section>`;
  }
  const rows = events
    .map((event) => {
      const sentence = plainEventSentence(event);
      const relative = relativeTime(event.created_at, data.generated_at);
      const relativeZh = relativeTimeZh(relative);
      return `
        <li><button type="button" class="history-row" data-drawer-target="${escapeHtml(dashboardDrawerId("event", event.event_id))}" aria-haspopup="dialog">
          <time class="history-when" datetime="${escapeHtml(event.created_at)}" ${i18nAttribute(relative, relativeZh)}>${escapeHtml(relative)}</time>
          <span class="history-what" ${i18nAttribute(sentence.en, sentence.zh)}>${escapeHtml(sentence.en)}</span>
          <small class="history-open" data-i18n-en="Open what changed" data-i18n-zh="查看具体内容">Open what changed</small>
        </button></li>`;
    })
    .join("");
  return `
    <section class="history-timeline" data-history-timeline aria-label="Recent activity">
      <ol class="history-list">${rows}</ol>
    </section>`;
}

function memoryViewRecords(data: DashboardData): DashboardRecordSummary[] {
  const projectId = data.memory_maintenance.scope.project_id;
  if (data.memory_maintenance.scope.mode === "store" || !projectId) return data.all_records;
  return data.all_records.filter((record) => record.scope === "global" || record.project_id === projectId);
}

const DASHBOARD_MEMORY_SEARCH_PAGE_SIZE = 20;
const DASHBOARD_MEMORY_SEARCH_MAX_PAGE_SIZE = 50;
const DASHBOARD_MEMORY_SEARCH_KINDS = new Set<MorynRecord["kind"]>([
  "memory",
  "skill",
  "soul",
  "session_summary",
  "agent_note"
]);

function boundedSearchInteger(value: string | null, fallback: number, maximum: number): number {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, maximum);
}

function dashboardMemorySearch(data: DashboardData, searchParams: URLSearchParams) {
  const query = (searchParams.get("q") ?? "").trim().slice(0, 500);
  const normalizedQuery = query.toLocaleLowerCase();
  const requestedKind = searchParams.get("kind");
  const kind =
    requestedKind && DASHBOARD_MEMORY_SEARCH_KINDS.has(requestedKind as MorynRecord["kind"])
      ? (requestedKind as MorynRecord["kind"])
      : undefined;
  const offset = boundedSearchInteger(searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(
    1,
    boundedSearchInteger(
      searchParams.get("limit"),
      DASHBOARD_MEMORY_SEARCH_PAGE_SIZE,
      DASHBOARD_MEMORY_SEARCH_MAX_PAGE_SIZE
    )
  );
  const visibleRecords = memoryViewRecords(data);
  const matches = visibleRecords.filter((record) => {
    if (kind && record.kind !== kind) return false;
    if (!normalizedQuery) return true;
    return `${record.text} ${record.kind} ${record.type} ${record.state} ${record.source.client}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  });
  const records = matches.slice(offset, offset + limit);
  return {
    read_only: true as const,
    query,
    ...(kind ? { kind } : {}),
    total_visible: visibleRecords.length,
    total_matches: matches.length,
    offset,
    limit,
    has_more: offset + records.length < matches.length,
    records
  };
}

function renderDashboardBody(
  data: DashboardData,
  options: Pick<DashboardRenderOptions, "showStoredContent" | "memorySearchEndpoint"> = {}
): string {
  const displayHealth = dashboardDisplayHealth(data);
  const healthLabelZh = dashboardHealthZh(
    displayHealth.status === "local_ready" ? "local_only" : displayHealth.status,
    displayHealth.label
  );
  const memoryRecords = memoryViewRecords(data);
  const memoryHtml = renderMemorySearch(data, memoryRecords, { endpoint: options.memorySearchEndpoint });
  const historyHtml = plainHistoryTimeline(data);
  return `<div hidden aria-hidden="true"><header><span class="health-badge ${healthClass(displayHealth.status)}" ${i18nAttribute(displayHealth.label, healthLabelZh)}>${escapeHtml(displayHealth.label)}</span></header>${quietDashboardFirstScreen(data)}<span data-quiet-dashboard-end></span></div>
    ${renderDashboardWorkspace(data, {
      memory_html: memoryHtml,
      memory_records: memoryRecords,
      history_html: historyHtml,
      language_toggle_html: dashboardLanguageToggle()
    })}
    <section id="last-action-receipt" class="panel last-action-receipt" data-action-receipt-anchor aria-live="polite" hidden></section>`;
}

function dashboardRefreshScript(_refreshIntervalMs: number | undefined): string {
  return `
  <script>
    (() => {
      const main = document.querySelector("main");
      if (!main) return;
      let refreshing = false;
      const setButtonState = (state) => {
        document.querySelectorAll("[data-dashboard-refresh-button]").forEach((button) => {
          if (button instanceof HTMLElement) button.dataset.refreshing = state ? "true" : "false";
        });
      };
      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        setButtonState(true);
        try {
          const workspaceState = window.dashboardWorkspaceState?.capture();
          const response = await fetch("fragment", { cache: "no-store" });
          if (!response.ok) return;
          main.innerHTML = await response.text();
          window.restoreDashboardWorkspaceAfterFragment?.(workspaceState);
          window.applyDashboardLanguage?.();
          window.restoreActionReceipt?.();
        } catch {
          // Keep the last successful render visible if a refresh fails.
        } finally {
          refreshing = false;
          setButtonState(false);
        }
      };
      window.refreshDashboard = refresh;
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-dashboard-refresh-button]")) {
          event.preventDefault();
          refresh();
        }
      });
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
        ["Info Checks", "后台检查"],
        ["Info Details", "检查详情"],
        ["Routine status checks", "日常检查"],
        ["Check records", "检查记录"],
        ["Read-only details available", "可查看只读详情"],
        ["Optional details", "可选详情"],
        ["Detail links", "详情入口"],
        ["Routes and checks", "路线和检查"],
        ["Needs a look", "需要看一下"],
        ["Warnings and important checks", "提醒和重要检查"],
        ["Review what changed", "查看变化"],
        ["Info", "信息"],
        ["Warning", "警告"],
        ["Critical", "严重"],
        ["Some saved content is paused", "部分保存内容已暂停使用"],
        ["Paused content has a safe replacement", "暂停内容已有安全替代"],
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
        ["Routine checks indexed", "日常检查已建立索引"],
        ["Saved notes indexed", "已保存内容已建立索引"],
        ["Safety checks indexed", "安全检查已建立索引"],
        ["Product notes indexed", "产品记录已建立索引"],
        ["Cleanup checks indexed", "清理检查已建立索引"],
        ["Shared copy indexed", "共享副本已建立索引"],
        ["History indexed", "历史记录已建立索引"],
        ["Sync details", "同步详情"],
        ["Position rail", "位置状态"],
        ["Sync Position", "同步位置"],
        ["Sync Action", "同步操作"],
        ["Push sync", "上传同步"],
        ["Pull sync", "拉取同步"],
        ["Check sync", "检查同步"],
        ["Remote configured", "远端已连接"],
        ["Remote not configured", "远端未连接"]
      ]);
      const validLanguage = (value) => value === "zh" ? "zh" : "en";
      const browserLanguage = () => {
        const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language];
        return languages.some((language) => /^zh(?:-|$)/i.test(language || "")) ? "zh" : "en";
      };
      const selectedLanguage = () => {
        const stored = localStorage.getItem(key);
        return stored === "en" || stored === "zh" ? stored : browserLanguage();
      };
      const legacyTranslationScopes = "[data-dashboard-detail='attention-info-checks'], [data-reference-library-index], [data-dashboard-sync-action], [data-dashboard-detail='store-sync-details']";
      const translateStaticText = (text) => {
        if (staticTranslations.has(text)) return staticTranslations.get(text);
        const routineMatch = text.match(/^(\\d+) routine check(s)?$/);
        if (routineMatch) return routineMatch[1] + " 项日常检查";
        const branchMatch = text.match(/^Branch (.+)$/);
        if (branchMatch) return "分支 " + branchMatch[1];
        const behindMatch = text.match(/^(\\d+) behind$/);
        if (behindMatch) return "落后 " + behindMatch[1];
        const aheadMatch = text.match(/^(\\d+) ahead$/);
        if (aheadMatch) return "待上传 " + aheadMatch[1];
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
          ["Raw technical details stay in /api/dashboard.", {
            enBefore: "Raw technical details stay in ",
            enAfter: ".",
            zhBefore: "原始技术细节保留在 ",
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
        document.querySelectorAll("[data-i18n-title-en][data-i18n-title-zh]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          node.setAttribute("title", language === "zh" ? node.dataset.i18nTitleZh || "" : node.dataset.i18nTitleEn || "");
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
      window.currentDashboardLanguage = () => selectedLanguage();
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
          window.openStoredContentPanel?.(trigger);
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
      let memorySearchInputTimer = 0;
      let memorySearchInteractionUntil = 0;
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
      const markMemorySearchInteraction = () => {
        memorySearchInteractionUntil = Date.now() + 1400;
      };
      const memorySearchResultPanels = () => Array.from(document.querySelectorAll("[data-memory-search-results]")).filter((node) => node instanceof HTMLElement);
      const captureMemorySearchScrollState = () => {
        return memorySearchResultPanels().map((panel, index) => {
          const searchPanel = panel.closest("[data-memory-search-panel]");
          return {
            id: searchPanel instanceof HTMLElement ? searchPanel.id || "" : "",
            index,
            top: panel.scrollTop,
            left: panel.scrollLeft
          };
        });
      };
      const restoreMemorySearchScrollState = (scrollState) => {
        if (!Array.isArray(scrollState)) return;
        window.requestAnimationFrame(() => {
          const panels = memorySearchResultPanels();
          for (const item of scrollState) {
            if (!item || typeof item !== "object") continue;
            const id = typeof item.id === "string" ? item.id : "";
            const index = Number.isInteger(item.index) ? item.index : 0;
            const panel = id
              ? document.querySelector("#" + cssEscape(id) + " [data-memory-search-results]")
              : panels[index];
            if (!(panel instanceof HTMLElement)) continue;
            panel.scrollTop = Number.isFinite(item.top) ? item.top : 0;
            panel.scrollLeft = Number.isFinite(item.left) ? item.left : 0;
          }
        });
      };
      window.captureMemorySearchScrollState = captureMemorySearchScrollState;
      window.restoreMemorySearchScrollState = restoreMemorySearchScrollState;
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
        document.querySelectorAll("[data-recent-change-select]").forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          node.classList.toggle("selected", selectedId.length > 0 && node.dataset.recentChangeSelect === selectedId);
          node.setAttribute("aria-pressed", selectedId.length > 0 && node.dataset.recentChangeSelect === selectedId ? "true" : "false");
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
          const meaning = detail.querySelector("[data-memory-explorer-meaning]");
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
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-source]"), "");
          setDetailText("[data-memory-explorer-detail-updated]", "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-why]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-next-step]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-next-step-detail]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-meaning]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-meaning-detail]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-summary-state]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-summary-meaning]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-summary-why]"), "");
          setLocalizedDetailText(detail.querySelector("[data-memory-explorer-summary-next]"), "");
          setDetailText("[data-memory-explorer-detail-timeline]", "");
          setDetailText("[data-memory-explorer-detail-recall]", "");
          if (detailGrid instanceof HTMLElement) detailGrid.hidden = true;
          if (meaning instanceof HTMLElement) meaning.hidden = true;
          if (guidance instanceof HTMLElement) guidance.hidden = true;
          if (trace instanceof HTMLElement) trace.hidden = true;
        });
        setMemoryExplorerSelection(null);
        setMemorySearchSummaryValue(document.querySelectorAll("[data-memory-search-summary-selected]"), "Nothing selected", "未选择");
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
        const detailMeaning = detail.querySelector("[data-memory-explorer-detail-meaning]");
        const detailMeaningDetail = detail.querySelector("[data-memory-explorer-detail-meaning-detail]");
        const summaryState = detail.querySelector("[data-memory-explorer-summary-state]");
        const summaryMeaning = detail.querySelector("[data-memory-explorer-summary-meaning]");
        const summaryWhy = detail.querySelector("[data-memory-explorer-summary-why]");
        const summaryNext = detail.querySelector("[data-memory-explorer-summary-next]");
        const detailGrid = detail.querySelector("[data-memory-explorer-detail-grid]");
        const meaning = detail.querySelector("[data-memory-explorer-meaning]");
        const guidance = detail.querySelector("[data-memory-explorer-guidance]");
        const trace = detail.querySelector("[data-memory-explorer-trace]");
        setLocalizedDetailText(detailTitle, item.dataset.memoryExplorerTitle || "Saved item", item.dataset.memoryExplorerTitleZh || item.dataset.memoryExplorerTitle || "Saved item");
        setLocalizedDetailText(detailText, item.dataset.memoryExplorerFullText || item.textContent || "", item.dataset.memoryExplorerFullTextZh || item.dataset.memoryExplorerFullText || item.textContent || "");
        setLocalizedDetailText(detailState, item.dataset.memoryExplorerStateEn || item.dataset.memoryExplorerState || "", item.dataset.memoryExplorerStateZh || item.dataset.memoryExplorerState || "");
        const hasGuidance = item.dataset.memoryExplorerHasGuidance !== "false" && (item.dataset.memoryExplorerWhySaved || item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep);
        setLocalizedDetailText(summaryState, item.dataset.memoryExplorerStateEn || item.dataset.memoryExplorerState || "", item.dataset.memoryExplorerStateZh || item.dataset.memoryExplorerState || "");
        setLocalizedDetailText(summaryMeaning, item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || "", item.dataset.memoryExplorerMeaningZh || item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || "");
        setLocalizedDetailText(summaryWhy, item.dataset.memoryExplorerWhySaved || "", item.dataset.memoryExplorerWhySavedZh || item.dataset.memoryExplorerWhySaved || "");
        setLocalizedDetailText(summaryNext, item.dataset.memoryExplorerNextStep || "", item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerNextStep || "");
        setLocalizedDetailText(detailWhy, item.dataset.memoryExplorerWhySaved || "", item.dataset.memoryExplorerWhySavedZh || item.dataset.memoryExplorerWhySaved || "");
        setLocalizedDetailText(detailNextStep, item.dataset.memoryExplorerNextStep || "", item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerNextStep || "");
        setLocalizedDetailText(detailNextStepDetail, item.dataset.memoryExplorerNextStepDetail || "", item.dataset.memoryExplorerNextStepDetailZh || item.dataset.memoryExplorerNextStepDetail || "");
        setLocalizedDetailText(detailMeaning, item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || "", item.dataset.memoryExplorerMeaningZh || item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || "");
        setLocalizedDetailText(detailMeaningDetail, item.dataset.memoryExplorerMeaningDetail || item.dataset.memoryExplorerNextStepDetail || "", item.dataset.memoryExplorerMeaningDetailZh || item.dataset.memoryExplorerNextStepDetailZh || item.dataset.memoryExplorerMeaningDetail || item.dataset.memoryExplorerNextStepDetail || "");
        setLocalizedDetailText(detail.querySelector("[data-memory-explorer-detail-source]"), item.dataset.memoryExplorerSource || "", item.dataset.memoryExplorerSourceZh || item.dataset.memoryExplorerSource || "");
        setLocalizedDetailText(detailUpdated, item.dataset.memoryExplorerUpdated || "", item.dataset.memoryExplorerUpdatedZh || item.dataset.memoryExplorerUpdated || "");
        setDetailText("[data-memory-explorer-detail-timeline]", item.dataset.memoryExplorerTimeline || "");
        setDetailText("[data-memory-explorer-detail-recall]", item.dataset.memoryExplorerRecall || "");
        if (detailGrid instanceof HTMLElement) detailGrid.hidden = false;
        if (meaning instanceof HTMLElement) meaning.hidden = !hasGuidance;
        if (guidance instanceof HTMLElement) guidance.hidden = !hasGuidance;
        if (trace instanceof HTMLElement) trace.hidden = false;
        setMemoryExplorerSelection(item);
        setMemorySearchSummaryValue(document.querySelectorAll("[data-memory-search-summary-selected]"), item.dataset.memoryExplorerTitle || "Selected item", item.dataset.memoryExplorerTitleZh || item.dataset.memoryExplorerTitle || "Selected item");
        writeStoredContentState({ selectedItemId: item.dataset.memoryExplorerItemId || item.dataset.storedContentItem || item.dataset.memorySearchEntry || null });
      };
      const restoreMemoryExplorerSelection = (state) => {
        const selected = state.selectedItemId ? document.querySelector(\`[data-stored-content-item][data-memory-explorer-item-id="\${cssEscape(state.selectedItemId)}"], [data-memory-search-entry][data-memory-explorer-item-id="\${cssEscape(state.selectedItemId)}"]\`) : null;
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
        if (normalized === "long-term" || normalized === "remembered") return "canonical";
        if (normalized === "recently-saved" || normalized === "to-organize" || normalized === "organize") return "candidate";
        if (normalized === "for-this-session" || normalized === "session-notes" || normalized === "session") return "raw";
        if (normalized === "kept-for-history" || normalized === "set-aside") return "archived";
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
        const tokens = String(query || "").trim().toLowerCase().split(/s+/).filter(Boolean);
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
      const itemCountLabel = (count) => ({
        en: count + " " + (count === 1 ? "item" : "items"),
        zh: count + " 条内容"
      });
      const activeQueryLabel = (query) => {
        const trimmed = String(query || "").trim();
        if (!trimmed) return { en: "All keywords", zh: "全部关键词" };
        return { en: trimmed, zh: trimmed };
      };
      const activeStateLabel = (state) => {
        const value = String(state || "all");
        if (value === "all") return { en: "All statuses", zh: "全部状态" };
        const labels = value.split(",").filter(Boolean).map((part) => {
          if (part === "canonical") return { en: "Ready to use", zh: "可直接使用" };
          if (part === "candidate") return { en: "Saved for later", zh: "已保存，稍后整理" };
          if (part === "raw") return { en: "Saved briefly", zh: "临时保存" };
          if (part === "archived" || part === "quarantined") return { en: "Set aside", zh: "已放一边" };
          if (part === "event") return { en: "Events", zh: "事件" };
          return { en: part, zh: part };
        });
        return {
          en: labels.map((label) => label.en).join(", ") || "All statuses",
          zh: labels.map((label) => label.zh).join("，") || "全部状态"
        };
      };
      const activeSourceLabel = (source) => {
        const value = String(source || "all");
        if (value === "all") return { en: "All sources", zh: "全部来源" };
        return { en: value, zh: value };
      };
      const setMemorySearchSummaryValue = (targets, en, zh = en) => {
        const nodes = targets instanceof NodeList ? Array.from(targets) : [targets];
        for (const node of nodes) {
          if (!(node instanceof HTMLElement)) continue;
          node.dataset.i18nEn = en || "";
          node.dataset.i18nZh = zh || en || "";
          node.textContent = selectedLanguage() === "zh" ? node.dataset.i18nZh : node.dataset.i18nEn;
        }
      };
      const updateMemorySearchSummary = (panel, totalCount, visibleCount) => {
        if (!(panel instanceof HTMLElement)) return;
        setMemorySearchSummaryValue(panel.querySelector("[data-memory-search-summary-total]"), itemCountLabel(totalCount).en, itemCountLabel(totalCount).zh);
        setMemorySearchSummaryValue(panel.querySelector("[data-memory-search-summary-visible]"), itemCountLabel(visibleCount).en, itemCountLabel(visibleCount).zh);
      };
      const updateMemorySearchActiveFilters = (panel, filters) => {
        if (!(panel instanceof HTMLElement)) return;
        setMemorySearchSummaryValue(panel.querySelector("[data-memory-search-active-query]"), activeQueryLabel(filters.query).en, activeQueryLabel(filters.query).zh);
        setMemorySearchSummaryValue(panel.querySelector("[data-memory-search-active-state]"), activeStateLabel(filters.state).en, activeStateLabel(filters.state).zh);
        setMemorySearchSummaryValue(panel.querySelector("[data-memory-search-active-source]"), activeSourceLabel(filters.source).en, activeSourceLabel(filters.source).zh);
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
          const stateFilters = String(filters.state || "all").split(",").filter(Boolean);
          const matchesState = filters.state === "all" || stateFilters.includes(entry.dataset.memorySearchState || "");
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
        updateMemorySearchSummary(panel, entries.length, filtered ? visible : entries.length);
        updateMemorySearchActiveFilters(panel, filters);
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
          if (stateSelect instanceof HTMLSelectElement) {
            const requestedState = state.searchStateFilter || "all";
            stateSelect.value = Array.from(stateSelect.options).some((option) => option.value === requestedState)
              ? requestedState
              : "all";
          }
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
      const explorerIntentFromTrigger = (triggerOrIntent) => {
        if (!(triggerOrIntent instanceof HTMLElement)) {
          const intent = triggerOrIntent && typeof triggerOrIntent === "object" ? triggerOrIntent : {};
          return {
            storedContentFilter: typeof intent.storedContentFilter === "string" ? intent.storedContentFilter : undefined,
            searchStateFilter: typeof intent.searchStateFilter === "string" ? intent.searchStateFilter : undefined,
            searchSourceFilter: typeof intent.searchSourceFilter === "string" ? intent.searchSourceFilter : undefined,
            selectedItemId: typeof intent.selectedItemId === "string" ? intent.selectedItemId : undefined,
            focusSearch: intent.focusSearch === true
          };
        }
        return {
          storedContentFilter: triggerOrIntent.dataset.memoryExplorerStoredFilter || undefined,
          searchStateFilter: triggerOrIntent.dataset.memoryExplorerStateFilter || undefined,
          searchSourceFilter: triggerOrIntent.dataset.memoryExplorerSourceFilter || undefined,
          selectedItemId: triggerOrIntent.dataset.memoryExplorerSelectedId || undefined,
          focusSearch: triggerOrIntent.dataset.memoryExplorerFocusSearch === "true"
        };
      };
      window.openStoredContentPanel = (triggerOrIntent) => {
        const intent = explorerIntentFromTrigger(triggerOrIntent);
        writeStoredContentState({ overflowOpen: true, searchOpen: true, ...intent });
        applyStoredContentState({ highlight: true, focusSearch: intent.focusSearch === true });
      };
      window.shouldPauseStoredContentRefresh = () => {
        const state = readStoredContentState();
        const active = document.activeElement;
        const hasSearchFocus = active instanceof HTMLInputElement && active.matches("[data-memory-search-input]");
        const hasActiveMemorySearchInteraction = Date.now() < memorySearchInteractionUntil;
        return state.searchOpen === true && (String(state.searchQuery || "").trim().length > 0 || hasSearchFocus || hasActiveMemorySearchInteraction);
      };
      document.addEventListener("scroll", (event) => {
        if (event.target instanceof HTMLElement && event.target.matches("[data-memory-search-results]")) {
          markMemorySearchInteraction();
        }
      }, true);
      document.addEventListener("wheel", (event) => {
        if (event.target instanceof HTMLElement && event.target.closest("[data-memory-search-results]")) {
          markMemorySearchInteraction();
        }
      }, { passive: true });
      document.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const recentChange = target.closest("[data-recent-change-select]");
        if (recentChange instanceof HTMLElement) {
          writeStoredContentState({
            overflowOpen: true,
            searchOpen: true,
            storedContentFilter: "all",
            searchStateFilter: "all",
            searchSourceFilter: "all",
            selectedItemId: recentChange.dataset.recentChangeSelect || null
          });
          applyStoredContentState({ highlight: true });
          document.querySelector("[data-stored-content]")?.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const explorerTrigger = target.closest("[data-memory-explorer-open], [data-stored-content-item], [data-memory-search-entry]");
        if (explorerTrigger instanceof HTMLElement) {
          const item = explorerTrigger.matches("[data-stored-content-item], [data-memory-search-entry]") ? explorerTrigger : explorerTrigger.closest("[data-stored-content-item], [data-memory-search-entry]");
          if (item instanceof HTMLElement) selectMemoryExplorerItem(item);
          return;
        }
        const memoryStateFilter = target.closest("[data-memory-state-filter]");
        if (memoryStateFilter instanceof HTMLElement) {
          writeStoredContentState({ overflowOpen: true, storedContentFilter: memoryStateFilter.dataset.memoryStateFilter || "all", searchOpen: true, searchStateFilter: memoryStateFilter.dataset.memoryStateFilter || "all" });
          applyStoredContentState({ highlight: true });
          document.querySelector("[data-stored-content]")?.scrollIntoView({ block: "start", behavior: "smooth" });
          return;
        }
        const glanceFilter = target.closest("[data-glance-filter]");
        if (glanceFilter instanceof HTMLElement) {
          writeStoredContentState({ overflowOpen: true, storedContentFilter: glanceFilter.dataset.glanceFilter || "all", searchOpen: true, searchStateFilter: glanceFilter.dataset.glanceFilter || "all" });
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
          writeStoredContentState({ storedContentFilter: storedFilter.dataset.storedContentFilter || "all", searchOpen: true, searchStateFilter: storedFilter.dataset.storedContentFilter || "all" });
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
        window.clearTimeout(memorySearchInputTimer);
        memorySearchInputTimer = window.setTimeout(() => {
          filterMemorySearch(panel, currentSearchFilters(readStoredContentState()));
        }, 90);
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
        main.querySelectorAll(".editorial-attention").forEach((section) => {
          const visibleCards = [...section.querySelectorAll("[data-decision-card]")].some((card) => !card.hidden);
          const notices = section.querySelectorAll(".editorial-decision-notice").length > 0;
          section.hidden = !visibleCards && !notices;
        });
      };
      window.restoreDashboardMaintenanceDismissals = hideRejectedPlans;
      const refreshFragment = async () => {
        const workspaceState = window.dashboardWorkspaceState?.capture();
        const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
        const memorySearchScrollState = window.captureMemorySearchScrollState?.();
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        hideRejectedPlans();
        window.restoreDashboardWorkspaceAfterFragment?.(workspaceState);
        window.applyDashboardLanguage?.();
        window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
        window.restoreMemorySearchScrollState?.(memorySearchScrollState);
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
          hideRejectedPlans();
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
        const workspaceState = window.dashboardWorkspaceState?.capture();
        const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
        const memorySearchScrollState = window.captureMemorySearchScrollState?.();
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        window.restoreDashboardWorkspaceAfterFragment?.(workspaceState);
        window.applyDashboardLanguage?.();
        window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
        window.restoreMemorySearchScrollState?.(memorySearchScrollState);
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
      const setActionStatus = (status, en, zh = en) => {
        if (!(status instanceof HTMLElement)) return;
        status.dataset.i18nEn = en;
        status.dataset.i18nZh = zh;
        status.textContent = window.currentDashboardLanguage?.() === "zh" ? zh : en;
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
        if (isReject) {
          setActionStatus(status, "Rejecting candidate...", "正在拒绝候选内容...");
        } else {
          setActionStatus(status, "Approving memory...", "正在批准为记忆...");
        }
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
            if (result.message) {
              setActionStatus(status, result.message);
            } else {
              setActionStatus(status, "Capture Inbox action failed.", "Capture Inbox 操作失败。");
            }
            button.disabled = false;
            return;
          }
          if (isReject) {
            setActionStatus(status, "Rejected. Receipt saved; refreshing dashboard...", "已拒绝。回执已保存，正在刷新 dashboard...");
          } else {
            setActionStatus(status, "Approved. Receipt saved; refreshing dashboard...", "已批准。回执已保存，正在刷新 dashboard...");
          }
          window.renderActionReceipt?.(result);
          await refreshFragment();
        } catch (error) {
          if (error instanceof Error) {
            setActionStatus(status, error.message);
          } else {
            setActionStatus(status, "Capture Inbox action failed.", "Capture Inbox 操作失败。");
          }
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
        const workspaceState = window.dashboardWorkspaceState?.capture();
        const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches("[data-memory-search-input]");
        const memorySearchScrollState = window.captureMemorySearchScrollState?.();
        const response = await fetch("fragment", { cache: "no-store" });
        if (!response.ok) return;
        main.innerHTML = await response.text();
        window.restoreDashboardWorkspaceAfterFragment?.(workspaceState);
        window.applyDashboardLanguage?.();
        window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });
        window.restoreMemorySearchScrollState?.(memorySearchScrollState);
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
      const setActionStatus = (status, en, zh = en) => {
        if (!(status instanceof HTMLElement)) return;
        status.dataset.i18nEn = en;
        status.dataset.i18nZh = zh;
        status.textContent = window.currentDashboardLanguage?.() === "zh" ? zh : en;
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
        setActionStatus(status, "Applying memory approval...", "正在批准为记忆...");
        try {
          const response = await fetch(button.dataset.endpoint || "", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({})
          });
          const result = await responseJson(response);
          if (!response.ok || result.ok === false) {
            if (result.message) {
              setActionStatus(status, result.message);
            } else {
              setActionStatus(status, "Candidate Triage approval failed.", "候选内容批准失败。");
            }
            button.disabled = false;
            return;
          }
          setActionStatus(status, "Approved. Receipt saved; refreshing dashboard...", "已批准。回执已保存，正在刷新 dashboard...");
          window.renderActionReceipt?.(result);
          await refreshFragment();
        } catch (error) {
          if (error instanceof Error) {
            setActionStatus(status, error.message);
          } else {
            setActionStatus(status, "Candidate Triage approval failed.", "候选内容批准失败。");
          }
          button.disabled = false;
        }
      });
    })();
  </script>`;
}

function renderDashboardShell(data: DashboardData, options: DashboardRenderOptions = {}): string {
  const refreshAttributes =
    options.refreshIntervalMs === undefined ? "" : ` data-dashboard-refresh="${escapeHtml(options.refreshIntervalMs)}"`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Moryn Dashboard</title>
  <style>
    :root {
      color-scheme: light;
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
      --surface-hover: linear-gradient(145deg, rgba(69, 185, 255, 0.075), rgba(116, 242, 145, 0.026)), rgba(15, 19, 25, 0.96);
      --panel-highlight: rgba(69, 185, 255, 0.42);
      --ring-soft: 0 0 0 1px rgba(69, 185, 255, 0.18);
      --panel-glow: 0 0 0 1px rgba(116, 242, 145, 0.08), 0 24px 70px rgba(0, 0, 0, 0.46);
      --elevation-card: 0 18px 48px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.045);
      --elevation-hover: 0 18px 44px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.055);
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
      background: var(--canvas);
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
      grid-template-columns: repeat(4, minmax(0, 1fr));
      margin-bottom: 0;
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
    .answer-card.recent { border-left-color: var(--signal-amber); }
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
      grid-template-rows: minmax(1.25em, auto) minmax(30px, 1fr) minmax(2.6em, auto);
      gap: 4px;
      align-content: stretch;
      min-width: 0;
      min-height: 86px;
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
      border-color: var(--panel-highlight);
      background: var(--surface-hover);
      box-shadow: var(--elevation-hover);
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
    .recent-changes {
      display: grid;
      gap: 8px;
      border-top: 1px solid var(--hairline);
      padding-top: 10px;
      margin-top: 10px;
    }
    .recent-changes-heading {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .recent-changes-heading span {
      color: var(--ink);
      font-size: 12px;
      font-weight: 820;
      overflow-wrap: anywhere;
    }
    .recent-changes-heading small { text-align: right; }
    .recent-change-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .recent-change-row {
      appearance: none;
      display: grid;
      gap: 4px;
      min-width: 0;
      min-height: 76px;
      border: 1px solid var(--hairline);
      border-left-width: 4px;
      border-radius: 8px;
      padding: 9px;
      background: rgba(8, 10, 13, 0.58);
      color: inherit;
      cursor: pointer;
      font: inherit;
      text-align: left;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .recent-change-row.state-canonical { border-left-color: var(--signal-green); }
    .recent-change-row.state-candidate { border-left-color: var(--signal-blue); }
    .recent-change-row.state-raw { border-left-color: var(--signal-amber); }
    .recent-change-row.state-archived,
    .recent-change-row.state-quarantined { border-left-color: var(--signal-slate); }
    .recent-change-row:hover {
      border-color: var(--panel-highlight);
      background: var(--surface-hover);
      box-shadow: var(--elevation-hover);
      transform: translateY(-1px);
    }
    .recent-change-row.selected {
      border-color: rgba(116, 242, 145, 0.52);
      background:
        linear-gradient(145deg, rgba(116, 242, 145, 0.105), rgba(69, 185, 255, 0.04)),
        rgba(12, 15, 20, 0.9);
      box-shadow: inset 0 0 0 1px rgba(116, 242, 145, 0.16), 0 14px 34px rgba(0, 0, 0, 0.3);
    }
    .recent-change-row:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .recent-change-row span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .recent-change-row strong {
      color: var(--ink);
      font-size: 13px;
      line-height: 1.2;
      font-weight: 840;
      overflow-wrap: anywhere;
    }
    .recent-change-row small { color: var(--muted); }
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
    .memory-explorer-read-first {
      display: grid;
      gap: 8px;
      min-width: 0;
      border: 1px solid rgba(69, 185, 255, 0.24);
      border-radius: 8px;
      padding: 10px;
      background:
        linear-gradient(135deg, rgba(69, 185, 255, 0.08), rgba(116, 242, 145, 0.026)),
        rgba(5, 7, 10, 0.54);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .memory-explorer-read-first > span {
      color: var(--signal-blue);
      font-size: 11px;
      font-weight: 850;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .memory-explorer-read-first-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
    }
    .memory-explorer-read-first-grid article {
      display: grid;
      gap: 4px;
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 7px;
      padding: 8px;
      background: rgba(255, 255, 255, 0.026);
    }
    .memory-explorer-read-first-grid span {
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 820;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .memory-explorer-read-first-grid strong {
      color: var(--ink);
      font-size: 12.5px;
      line-height: 1.25;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .memory-explorer-full-text {
      display: grid;
      gap: 6px;
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 8px;
      padding: 10px;
      background: rgba(5, 7, 10, 0.52);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .memory-explorer-full-text span,
    .memory-explorer-meaning span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .memory-explorer-meaning {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid rgba(69, 185, 255, 0.26);
      border-radius: 8px;
      padding: 10px;
      background:
        linear-gradient(90deg, rgba(69, 185, 255, 0.07), rgba(116, 242, 145, 0.026)),
        rgba(5, 7, 10, 0.5);
    }
    .memory-explorer-meaning strong {
      color: var(--ink);
      font-size: 14px;
      font-weight: 850;
    }
    .memory-explorer-meaning small {
      color: var(--muted);
      line-height: 1.35;
      overflow-wrap: anywhere;
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
    .memory-explorer-trace summary {
      color: var(--muted);
      cursor: pointer;
      font-size: 12px;
      font-weight: 820;
      list-style-position: inside;
    }
    .memory-explorer-trace summary:hover { color: var(--ink-2); }
    .memory-explorer-trace summary:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }
    .memory-explorer-trace code {
      margin-top: 6px;
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
    .memory-search-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr)) minmax(220px, 1.05fr);
      gap: 8px;
      align-items: stretch;
    }
    .memory-search-summary-card,
    .memory-search-summary-readonly {
      min-width: 0;
      border: 1px solid rgba(112, 129, 149, 0.24);
      border-radius: 8px;
      background: rgba(5, 7, 10, 0.54);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
    }
    .memory-search-summary-card {
      display: grid;
      gap: 4px;
      min-height: 64px;
      padding: 9px 10px;
    }
    .memory-search-summary-card span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 820;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .memory-search-summary-card strong {
      color: var(--ink);
      font-size: 14px;
      line-height: 1.2;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .memory-search-summary-readonly {
      display: flex;
      align-items: center;
      min-height: 64px;
      padding: 9px 10px;
      color: #bde6ff;
      font-size: 12px;
      line-height: 1.35;
      font-weight: 740;
      overflow-wrap: anywhere;
    }
    .memory-search-active-filters {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      min-width: 0;
      border: 1px solid rgba(69, 185, 255, 0.22);
      border-radius: 8px;
      padding: 8px;
      background: rgba(5, 7, 10, 0.48);
    }
    .memory-search-active-filters > span {
      color: #bde6ff;
      font-size: 11px;
      font-weight: 840;
      text-transform: uppercase;
    }
    .memory-search-active-filter {
      display: inline-grid;
      grid-template-columns: auto minmax(0, max-content);
      gap: 5px;
      align-items: center;
      max-width: 100%;
      min-height: 28px;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 999px;
      padding: 3px 9px;
      background: rgba(16, 20, 26, 0.78);
    }
    .memory-search-active-filter small {
      color: var(--muted);
      font-size: 10.5px;
      font-weight: 820;
      text-transform: uppercase;
    }
    .memory-search-active-filter strong {
      color: var(--ink);
      font-size: 12px;
      font-weight: 840;
      overflow-wrap: anywhere;
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
      grid-template-rows: auto auto minmax(3.9em, 3.9em) auto;
      gap: 6px;
      min-width: 0;
      min-height: 148px;
      border: 1px solid rgba(112, 129, 149, 0.22);
      border-radius: 8px;
      padding: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(255, 255, 255, 0.006)), rgba(8, 10, 13, 0.92);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.035);
      contain: content;
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
    }
    .memory-search-result:hover {
      border-color: rgba(69, 185, 255, 0.34);
      background: linear-gradient(180deg, rgba(69, 185, 255, 0.05), rgba(255, 255, 255, 0.008)), rgba(10, 12, 16, 0.96);
      box-shadow: 0 10px 22px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.045);
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
    .memory-search-result-preview {
      display: -webkit-box;
      min-height: 3.9em;
      max-height: 3.9em;
      overflow: hidden;
      line-height: 1.3;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 3;
    }
    .memory-search-result-full-hint {
      min-height: 1.35em;
      color: var(--muted);
      font-size: 11.5px;
      line-height: 1.25;
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
    .stored-content-item:hover,
    .glance-summary-strip button:hover,
    .memory-state-filter:hover,
    .memory-state-guide-card:hover,
    .memory-inventory-card:hover,
    .stored-content-filter:hover,
    .memory-search-chip:hover,
    .memory-search-mix-item:hover,
    .evidence-library-route:hover,
    .reference-library-index-row:hover,
    .routine-diagnostics-route:hover {
      border-color: var(--panel-highlight);
      background: var(--surface-hover);
      box-shadow: var(--elevation-hover);
      transform: translateY(-1px);
    }
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
    .dashboard-command-flow {
      display: grid;
      gap: 10px;
      border: 1px solid rgba(112, 129, 149, 0.26);
      border-radius: 10px;
      padding: 12px;
      margin-bottom: 14px;
      background: linear-gradient(180deg, rgba(69, 185, 255, 0.075), rgba(116, 242, 145, 0.026) 42%, rgba(255, 255, 255, 0.012)), rgba(8, 10, 13, 0.86);
      box-shadow: var(--panel-glow);
    }
    .dashboard-command-flow-head {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 8px 12px;
      align-items: baseline;
      min-width: 0;
      border: 1px solid rgba(69, 185, 255, 0.18);
      border-radius: 8px;
      padding: 9px 10px;
      background: rgba(5, 7, 10, 0.42);
    }
    .dashboard-command-flow-head span {
      color: var(--signal-blue);
      font-size: 11px;
      font-weight: 850;
      text-transform: uppercase;
      overflow-wrap: anywhere;
    }
    .dashboard-command-flow-head strong {
      color: var(--ink);
      font-size: 15px;
      line-height: 1.2;
      font-weight: 850;
      overflow-wrap: anywhere;
    }
    .dashboard-command-flow-head small {
      justify-self: end;
      color: var(--muted);
      font-size: 12px;
      text-align: right;
    }
    .dashboard-command-flow > .status-board,
    .dashboard-command-flow > .decision-panel,
    .dashboard-command-flow > .glance-board,
    .dashboard-command-flow > .stored-content,
    .dashboard-command-flow > .dashboard-overview {
      margin-bottom: 0;
      box-shadow: none;
    }
    .dashboard-command-flow > .status-board,
    .dashboard-command-flow > .stored-content,
    .dashboard-command-flow > .decision-panel {
      background: rgba(12, 15, 20, 0.72);
    }
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
      grid-template-rows: minmax(15px, auto) minmax(2.3em, auto) minmax(0, 1fr);
      gap: 10px;
      align-content: stretch;
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
    .glance-chart-insight {
      margin: 0;
      min-height: 2.3em;
      border: 1px solid rgba(69, 185, 255, 0.18);
      border-radius: 7px;
      padding: 7px 8px;
      color: var(--ink-2);
      background:
        linear-gradient(135deg, rgba(69, 185, 255, 0.09), rgba(116, 242, 145, 0.032)),
        rgba(5, 7, 10, 0.34);
      font-size: 12px;
      line-height: 1.25;
      font-weight: 760;
      overflow-wrap: anywhere;
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
    .memory-state-filter [data-memory-state-percent] {
      margin-left: auto;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 999px;
      padding: 1px 5px;
      background: rgba(255, 255, 255, 0.045);
      color: var(--ink-2);
      font-size: 11px;
      font-weight: 820;
      white-space: nowrap;
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
    .memory-state-key,
    .kind-bars,
    .activity-bars { align-self: end; }
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
    .quiet-dashboard {
      margin-bottom: 26px;
    }
    .quiet-dashboard-shell {
      overflow: hidden;
      border: 1px solid rgba(143, 156, 173, 0.14);
      border-radius: 16px;
      background: rgba(13, 16, 21, 0.72);
      box-shadow: 0 22px 60px rgba(0, 0, 0, 0.24);
    }
    .quiet-context-flow {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.65fr);
      gap: 0;
      border-top: 1px solid rgba(143, 156, 173, 0.14);
    }
    .quiet-panel-heading {
      display: grid;
      gap: 5px;
      margin-bottom: 20px;
    }
    .quiet-panel-heading > span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    .quiet-panel-heading > strong {
      color: var(--ink);
      font-size: 20px;
      line-height: 1.18;
      font-weight: 720;
      overflow-wrap: anywhere;
    }
    .quiet-pulse-band {
      display: grid;
      grid-template-columns: minmax(220px, 0.7fr) minmax(0, 1.3fr);
      align-items: center;
      gap: 24px;
      padding: 16px 24px;
      background: rgba(255, 255, 255, 0.018);
    }
    .quiet-pulse-band.attention {
      box-shadow: inset 3px 0 0 rgba(255, 209, 102, 0.72);
      background: rgba(255, 209, 102, 0.045);
    }
    .quiet-pulse-band .quiet-panel-heading { margin-bottom: 0; }
    .quiet-signal-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    .quiet-signal-grid > div {
      display: grid;
      gap: 3px;
      min-width: 0;
      padding: 6px 10px;
    }
    .quiet-signal-grid > div + div { border-left: 1px solid rgba(143, 156, 173, 0.13); }
    .quiet-signal-grid span,
    .quiet-context-list dt {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
    }
    .quiet-signal-grid strong { color: var(--ink-2); font-size: 13px; text-transform: capitalize; }
    .quiet-context-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px 24px;
    }
    .quiet-context-list div { display: grid; grid-template-columns: 1fr; gap: 2px; }
    .quiet-context-list dd { color: var(--ink-2); }
    .quiet-context-primary {
      min-width: 0;
      padding: 32px 34px 34px;
    }
    .quiet-current-task {
      max-width: 760px;
      font-size: clamp(25px, 3vw, 38px) !important;
      line-height: 1.08 !important;
      letter-spacing: -0.025em;
      font-weight: 730 !important;
    }
    .quiet-memory-secondary {
      min-width: 0;
      padding: 32px 30px;
      border-left: 1px solid rgba(143, 156, 173, 0.14);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.012);
    }
    .quiet-flow-strip {
      display: grid;
      gap: 0;
    }
    .quiet-flow-strip > div {
      display: grid;
      grid-template-columns: minmax(70px, 0.7fr) auto;
      gap: 3px 12px;
      align-items: baseline;
      min-width: 0;
      padding: 12px 0;
      border-bottom: 1px solid rgba(143, 156, 173, 0.1);
    }
    .quiet-flow-strip > div:last-child { border-bottom: 0; }
    .quiet-flow-strip span,
    .quiet-flow-detail-grid span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .quiet-flow-strip strong { color: var(--ink); font-size: 19px; line-height: 1.1; font-weight: 720; text-align: right; }
    .quiet-flow-strip small { grid-column: 1 / -1; margin-top: 1px; color: var(--muted); }
    .quiet-flow-details {
      margin-top: 20px;
      padding-top: 12px;
      border-top: 1px solid rgba(143, 156, 173, 0.12);
    }
    .quiet-flow-details > summary {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      cursor: pointer;
      font-size: 12px;
      font-weight: 680;
    }
    .quiet-flow-details > summary small { display: inline; margin: 0; }
    .quiet-flow-detail-grid { display: grid; gap: 9px; margin-top: 14px; }
    .quiet-flow-detail-grid > div { display: grid; gap: 3px; }
    .quiet-flow-detail-grid strong { color: var(--ink-2); font-size: 12px; font-weight: 600; }
    .quiet-attention {
      padding: 22px 28px 24px;
      border-top: 1px solid rgba(255, 209, 102, 0.22);
      box-shadow: inset 3px 0 0 rgba(255, 209, 102, 0.72);
      background: rgba(255, 209, 102, 0.04);
    }
    .quiet-attention-list { display: grid; gap: 8px; }
    .quiet-attention-list article {
      padding: 12px 14px;
      border-left: 2px solid var(--signal-amber);
      background: rgba(255, 255, 255, 0.025);
    }
    .quiet-attention-list p { margin-top: 3px; }
    .audit-details {
      border-top: 1px solid rgba(143, 156, 173, 0.18);
      padding-top: 12px;
    }
    .audit-details > summary {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 2px;
      color: var(--ink-2);
      cursor: pointer;
      font-weight: 720;
    }
    .audit-details > summary small { display: inline; font-weight: 500; }
    .audit-details-content { padding-top: 12px; }
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
      border: 1px solid var(--hairline);
      border-radius: 7px;
      padding: 8px 9px;
      background: rgba(5, 7, 10, 0.34);
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
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
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
    }
    .evidence-library-route:hover { border-color: var(--panel-highlight); background: var(--surface-hover); box-shadow: var(--elevation-hover); transform: translateY(-1px); }
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
      transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
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
      header, .quiet-context-flow, .status-board-answers, .status-board-rail, .memory-inventory-grid, .recent-status-grid, .recent-change-list, .glance-grid, .memory-explorer-layout, .stored-content-list, .stored-content-explain, .memory-search-controls, .memory-search-summary, .dashboard-overview-quiet-list, .dashboard-work-lanes, .dashboard-work-lanes-quiet-list, .action-board-grid, .action-board-quiet-list, .action-board-background-list, .decision-summary-list, .visual-grid { grid-template-columns: 1fr; }
      .quiet-pulse-band { grid-template-columns: 1fr; gap: 14px; }
      .quiet-signal-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .quiet-signal-grid > div + div { border-left: 0; }
      .quiet-signal-grid > div:nth-child(even) { border-left: 1px solid rgba(143, 156, 173, 0.13); }
      .quiet-context-primary { min-height: 0; }
      .quiet-memory-secondary { border-top: 1px solid rgba(143, 156, 173, 0.14); border-left: 0; }
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
    @media (max-width: 560px) {
      .quiet-context-primary, .quiet-memory-secondary { padding: 24px 20px; }
      .quiet-context-list { grid-template-columns: 1fr; }
      .quiet-current-task { font-size: 26px !important; }
    }
    ${dashboardWorkspaceCss()}
  </style>
</head>
<body class="neutral-intelligence">
  <main${refreshAttributes}>${renderDashboardBody(data, {
    showStoredContent: options.showStoredContent,
    memorySearchEndpoint: options.memorySearchEndpoint
  })}</main>
  ${dashboardLanguageScript()}
  ${dashboardRefreshScript(options.refreshIntervalMs)}
  ${dashboardActionBoardScript()}
  ${dashboardStoredContentScript()}
  ${dashboardActionReceiptScript()}
  ${dashboardMaintenanceScript()}
  ${dashboardCaptureInboxScript()}
  ${dashboardCandidateTriageScript()}
  ${dashboardWorkspaceScript()}
</body>
</html>
`;
}

export function renderDashboardHtml(
  data: DashboardData,
  options: Pick<DashboardRenderOptions, "showStoredContent"> = {}
): string {
  return renderDashboardShell(data, options);
}

export function renderDashboardServerHtml(
  data: DashboardData,
  refreshIntervalMs: number,
  options: Pick<DashboardRenderOptions, "showStoredContent" | "memorySearchEndpoint"> = {}
): string {
  return renderDashboardShell(data, {
    refreshIntervalMs,
    showStoredContent: options.showStoredContent,
    memorySearchEndpoint: options.memorySearchEndpoint ?? "api/memory/search"
  });
}

export function renderDashboardFragment(
  data: DashboardData,
  options: Pick<DashboardRenderOptions, "showStoredContent" | "memorySearchEndpoint"> = {}
): string {
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

export async function writeDashboardSnapshot(
  storePath: string,
  options: DashboardOptions = {}
): Promise<DashboardSnapshot> {
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

function sendResponse(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  includeBody = true
): void {
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

async function requireCaptureInboxCandidate(
  storePath: string,
  recordId: string,
  includePrivate: boolean | undefined
): Promise<MorynRecord | undefined> {
  const records = replayEvents(await readEvents(storePath));
  const record = records.get(recordId);
  if (!record || !isVisibleForDashboard(record, includePrivate) || !isCaptureInboxCandidate(record)) return undefined;
  return record;
}

async function requireCandidateTriagePromotableRecord(
  storePath: string,
  recordId: string,
  includePrivate: boolean | undefined
): Promise<MorynRecord | undefined> {
  const records = replayEvents(await readEvents(storePath));
  const record = records.get(recordId);
  if (
    !record ||
    !isVisibleForDashboard(record, includePrivate) ||
    record.state !== "candidate" ||
    record.visibility !== "active" ||
    !isCandidateTriagePromotable(record)
  ) {
    return undefined;
  }
  return record;
}

function parseCaptureRecordIds(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { record_ids?: unknown }).record_ids)) return [];
  return (body as { record_ids: unknown[] }).record_ids.filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
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
        event_id: promoted.event.event_id,
        trace: actionTrace(promoted.event.event_id, record.id, record.project_id)
      }
    };
  }

  const reason =
    body &&
    typeof body === "object" &&
    typeof (body as { reason?: unknown }).reason === "string" &&
    (body as { reason: string }).reason.trim()
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
      event_id: archived.event.event_id,
      trace: actionTrace(archived.event.event_id, record.id, record.project_id)
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
        event_ids: events,
        trace: actionBatchTrace(
          events,
          records.map((record) => record.id),
          records[0]?.project_id
        )
      }
    };
  }

  const reason =
    body &&
    typeof body === "object" &&
    typeof (body as { reason?: unknown }).reason === "string" &&
    (body as { reason: string }).reason.trim()
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
      event_ids: events,
      trace: actionBatchTrace(
        events,
        records.map((record) => record.id),
        records[0]?.project_id
      )
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
      event_id: promoted.event.event_id,
      trace: actionTrace(promoted.event.event_id, record.id, record.project_id)
    }
  };
}

export async function startDashboardServer(
  storePath: string,
  options: DashboardServerOptions = {}
): Promise<DashboardServerHandle> {
  const host = dashboardServerHost(options.host);
  const requestedPort = dashboardServerPort(options.port);
  const refreshIntervalMs = dashboardRefreshInterval(options.refreshIntervalMs);
  const limit = dashboardLimit(options.limit);
  const includePrivate = options.include_private;
  const renderOptions: Pick<DashboardRenderOptions, "showStoredContent"> = {
    showStoredContent: includePrivate !== true
  };
  const dashboardDataLoader = createDashboardDataLoader(() =>
    buildDashboardData(storePath, {
      limit,
      include_private: includePrivate,
      project_id: options.project_id,
      readiness_host: options.readiness_host,
      sync_remote: options.sync_remote
    })
  );
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
            sendResponse(
              response,
              400,
              JSON.stringify({ error: "Invalid request: JSON body is required" }),
              "application/json; charset=utf-8",
              includeBody
            );
            return;
          }
          const result = await applyCaptureInboxGroupAction(
            storePath,
            inboxGroupAction.groupId,
            inboxGroupAction.action,
            body,
            includePrivate
          );
          sendResponse(
            response,
            result.statusCode,
            JSON.stringify(result.body),
            "application/json; charset=utf-8",
            includeBody
          );
          return;
        }
        const inboxAction = captureInboxAction(url.pathname);
        if (inboxAction) {
          let body: unknown;
          try {
            body = await readRequestJson(request);
          } catch {
            sendResponse(
              response,
              400,
              JSON.stringify({ error: "Invalid request: JSON body is required" }),
              "application/json; charset=utf-8",
              includeBody
            );
            return;
          }
          const result = await applyCaptureInboxAction(
            storePath,
            inboxAction.recordId,
            inboxAction.action,
            body,
            includePrivate
          );
          sendResponse(
            response,
            result.statusCode,
            JSON.stringify(result.body),
            "application/json; charset=utf-8",
            includeBody
          );
          return;
        }
        const candidatePromotionAction = candidateTriagePromotionAction(url.pathname);
        if (candidatePromotionAction) {
          let body: unknown;
          try {
            body = await readRequestJson(request);
          } catch {
            sendResponse(
              response,
              400,
              JSON.stringify({ error: "Invalid request: JSON body is required" }),
              "application/json; charset=utf-8",
              includeBody
            );
            return;
          }
          if (!body || typeof body !== "object") {
            sendResponse(
              response,
              400,
              JSON.stringify({ error: "Invalid request: JSON body is required" }),
              "application/json; charset=utf-8",
              includeBody
            );
            return;
          }
          const result = await applyCandidateTriagePromotionApproval(
            storePath,
            candidatePromotionAction.recordId,
            includePrivate
          );
          sendResponse(
            response,
            result.statusCode,
            JSON.stringify(result.body),
            "application/json; charset=utf-8",
            includeBody
          );
          return;
        }
        const planId = approvalPlanId(url.pathname);
        if (!planId) {
          sendResponse(
            response,
            404,
            JSON.stringify({ error: "Not found" }),
            "application/json; charset=utf-8",
            includeBody
          );
          return;
        }
        let body: unknown;
        try {
          body = await readRequestJson(request);
        } catch {
          sendResponse(
            response,
            400,
            JSON.stringify({ error: "Invalid request: JSON body is required" }),
            "application/json; charset=utf-8",
            includeBody
          );
          return;
        }
        if (!body || typeof body !== "object" || typeof (body as { plan_hash?: unknown }).plan_hash !== "string") {
          sendResponse(
            response,
            400,
            JSON.stringify({ error: "Invalid request: plan_hash is required" }),
            "application/json; charset=utf-8",
            includeBody
          );
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
        sendResponse(
          response,
          200,
          renderDashboardServerHtml(data, refreshIntervalMs, renderOptions),
          "text/html; charset=utf-8",
          includeBody
        );
        return;
      }
      if (url.pathname === "/fragment") {
        const data = await dashboardDataLoader.load();
        sendResponse(
          response,
          200,
          renderDashboardFragment(data, { ...renderOptions, memorySearchEndpoint: "api/memory/search" }),
          "text/html; charset=utf-8",
          includeBody
        );
        return;
      }
      if (url.pathname === "/api/memory/search") {
        const data = await dashboardDataLoader.load();
        sendResponse(
          response,
          200,
          JSON.stringify(dashboardMemorySearch(data, url.searchParams)),
          "application/json; charset=utf-8",
          includeBody
        );
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
