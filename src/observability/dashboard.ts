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
import { displayRecordText } from "../core/content-text.js";
import { diagnoseDogfood, type DogfoodReportResult } from "../core/dogfood-report.js";
import { createEngine } from "../core/engine.js";
import { diagnoseMemoryLifecycle, type MemoryLifecycleResult } from "../core/memory-lifecycle.js";
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

export type DashboardActionSurface = "capture_inbox" | "capture_policy" | "maintenance_review";
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
  charts: "charts",
  totals: "totals",
  action: "actions_by_id.<action_id>",
  action_id: "actions_by_id.<action_id>.action_id",
  capture_inbox: "capture_inbox",
  capture_policy: "capture_policy",
  context_pack_review: "context_pack_review",
  governance: "governance",
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

export type DashboardHealthStatus = "healthy" | "needs_review" | "conflict" | "local_only";
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
  memory_lifecycle: "memory_lifecycle",
  maintenance: "maintenance",
  dogfood_report: "dogfood_report"
} as const;

export type DashboardGovernanceSource = "capture_policy" | "memory_lifecycle" | "maintenance" | "dogfood_report";
export type DashboardGovernanceCategory =
  | "capture_review"
  | "auto_capture"
  | "policy_archive"
  | "memory_lifecycle"
  | "project_identity"
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

export interface DashboardData {
  generated_at: string;
  store: {
    path: string;
  };
  sync: GitSyncStatus;
  health: DashboardHealth;
  attention_items: DashboardAttentionItem[];
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
  capture_inbox: DashboardCaptureInbox;
  capture_policy: CapturePolicyResult;
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
  if (sync.sync_state === "dirty" || (sync.ahead ?? 0) > 0 || (sync.behind ?? 0) > 0 || hidden > 0) {
    return {
      status: "needs_review",
      label: "Needs Review",
      explanation: "Moryn is usable, but sync position or safety signals deserve a quick look.",
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
      title: "Local store has uncommitted sync state",
      description: "Local event history changed and has not been fully committed or pushed.",
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

function captureInboxRecordActionId(intent: "approve" | "reject", recordId: string): string {
  return `capture_inbox.record.${intent}.${recordId}`;
}

function captureInboxGroupActionId(intent: "approve" | "reject", groupId: string): string {
  return `capture_inbox.group.${intent}.${groupId}`;
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
  const decision = recordCapturePolicyDecision(record);
  return record.state === "candidate"
    && record.visibility === "active"
    && record.tags.some((tag) => {
      const normalized = tag.toLowerCase();
      return normalized === "review";
    })
    && decision !== "capture";
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
    && (record.tags.some((tag) => tag.toLowerCase() === "auto-captured") || recordCapturePolicyDecision(record) === "capture");
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
    const ruleIds = capturePolicyRuleIds(record);
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
      rule_ids: capturePolicyRuleIds(record),
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
    label: "Apply Repair",
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

function dashboardActions(input: {
  captureInbox: DashboardCaptureInbox;
  capturePolicy: CapturePolicyResult;
  maintenance: DashboardMaintenanceData;
}): DashboardAction[] {
  return [
    ...captureInboxActions(input.captureInbox),
    ...capturePolicyActions(input.capturePolicy),
    ...maintenanceActions(input.maintenance.plans)
  ];
}

function actionsById(actions: DashboardAction[]): Record<string, DashboardAction> {
  return Object.fromEntries(actions.map((action) => [action.action_id, action]));
}

function governanceItemId(source: DashboardGovernanceSource, id: string): string {
  return `${source}:${id}`;
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
    return {
      id: governanceItemId("capture_policy", finding.id),
      source: "capture_policy",
      category: finding.category === "review_queue" ? "capture_review" : finding.category,
      severity: finding.severity,
      title: finding.summary,
      summary: finding.reason,
      record_ids: finding.record_ids,
      evidence_path: `capture_policy.findings_by_id.${finding.id}`,
      action_label: isReview ? "Review in Capture Inbox" : firstAction?.recommended_action ?? "Inspect capture policy finding",
      ...(firstAction && !isReview ? { action_id: capturePolicyInspectActionId(String(firstAction.arguments.record_id)) } : {}),
      safe_to_run: !isReview,
      requires_user_confirmation: isReview,
      writes: isReview ? "append_only_events" : "none"
    };
  });
}

function governanceFromMemoryLifecycle(report: MemoryLifecycleResult): DashboardGovernanceItem[] {
  return report.findings.map((finding): DashboardGovernanceItem => {
    const firstAction = firstActionForRecords(report.suggested_actions, finding.record_ids);
    const requiresUserConfirmation = firstAction?.safe_to_run === false;
    return {
      id: governanceItemId("memory_lifecycle", finding.id),
      source: "memory_lifecycle",
      category: "memory_lifecycle",
      severity: finding.severity,
      title: finding.summary,
      summary: finding.reason,
      record_ids: finding.record_ids,
      evidence_path: `memory_lifecycle.findings_by_id.${finding.id}`,
      action_label: firstAction?.recommended_action ?? "Inspect lifecycle finding",
      safe_to_run: firstAction?.safe_to_run ?? true,
      requires_user_confirmation: requiresUserConfirmation,
      writes: requiresUserConfirmation ? "append_only_events" : "none"
    };
  });
}

function governanceFromMaintenance(maintenance: DashboardMaintenanceData): DashboardGovernanceItem[] {
  return maintenance.plans.map((plan): DashboardGovernanceItem => ({
    id: governanceItemId("maintenance", plan.plan_id),
    source: "maintenance",
    category: "project_identity",
    severity: "warning",
    title: plan.decision_card.issue,
    summary: plan.decision_card.impact,
    record_ids: plan.record_ids,
    evidence_path: `maintenance.plans_by_id.${plan.plan_id}`,
    action_label: "Apply Repair",
    action_id: maintenanceApproveActionId(plan),
    safe_to_run: false,
    requires_user_confirmation: true,
    writes: "append_only_events"
  }));
}

function governanceFromDogfood(report: DogfoodReportResult): DashboardGovernanceItem[] {
  return report.findings.map((finding): DashboardGovernanceItem => {
    const recordIds = finding.record_ids ?? (finding.record_id ? [finding.record_id] : []);
    const firstAction = finding.id === "capture_review_backlog"
      ? report.suggested_actions_by_id.review_capture_inbox
      : firstActionForRecords(report.suggested_actions, recordIds);
    return {
      id: governanceItemId("dogfood_report", finding.id),
      source: "dogfood_report",
      category: "dogfood_friction",
      severity: finding.severity,
      title: finding.summary,
      summary: finding.reason,
      record_ids: recordIds,
      evidence_path: `dogfood_report.findings_by_id.${finding.id}`,
      action_label: firstAction?.recommended_action ?? "Inspect dogfood finding",
      safe_to_run: firstAction?.safe_to_run ?? true,
      requires_user_confirmation: false,
      writes: "none"
    };
  });
}

function buildDashboardGovernance(input: {
  capturePolicy: CapturePolicyResult;
  memoryLifecycle: MemoryLifecycleResult;
  maintenance: DashboardMaintenanceData;
  dogfoodReport?: DogfoodReportResult;
  hiddenPrivateRecords: number;
}): DashboardGovernance {
  const items: DashboardGovernanceItem[] = [
    ...governanceFromCapturePolicy(input.capturePolicy),
    ...governanceFromMemoryLifecycle(input.memoryLifecycle),
    ...governanceFromMaintenance(input.maintenance),
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
      memory_lifecycle: true,
      maintenance: true,
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
  const dogfoodAllRecords = allRecords.filter((record) => recordProjectMatchesDashboard(record, options.project_id));
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
  const actions = dashboardActions({
    captureInbox: captureInboxData,
    capturePolicy: capturePolicyData,
    maintenance: maintenanceData
  });

  return {
    generated_at: generatedAt,
    store: {
      path: storePath
    },
    sync,
    health: buildHealth(sync, records, generatedAt),
    attention_items: buildAttentionItems(sync, records),
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
    governance: buildDashboardGovernance({
      capturePolicy: capturePolicyData,
      memoryLifecycle: memoryLifecycleData,
      maintenance: maintenanceData,
      dogfoodReport: dogfoodReportData,
      hiddenPrivateRecords: lifecycleAllRecords.length - lifecycleRecords.length
    }),
    capture_inbox: captureInboxData,
    capture_policy: capturePolicyData,
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
  if (sync.sync_state) return titleCase(sync.sync_state);
  return sync.configured ? "Configured" : "Not configured";
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

function metric(label: string, value: unknown, hint?: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>`;
}

function healthClass(status: DashboardHealthStatus): string {
  if (status === "healthy") return "good";
  if (status === "conflict") return "critical";
  if (status === "needs_review") return "warning";
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

function attentionItems(items: DashboardAttentionItem[]): string {
  if (items.length === 0) {
    return `<div class="empty-state">No issues detected in the current snapshot.</div>`;
  }
  const primary = items.filter((item) => item.severity !== "info");
  const info = items.filter((item) => item.severity === "info");
  return `
    <div class="attention-list">
      ${primary.map(attentionItem).join("")}
      ${info.length === 0 ? "" : `
        <details class="attention-info-group" data-dashboard-detail="attention-info-checks">
          <summary class="dashboard-fold-summary">
            <span>Info Checks</span>
            <small>${escapeHtml(pluralize(info.length, "info item"))}</small>
          </summary>
          <div class="attention-info-list">
            ${info.map(attentionItem).join("")}
          </div>
        </details>
      `}
    </div>
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
        <dl>
          <div><dt>Source</dt><dd>${escapeHtml(item.source)}</dd></div>
          <div><dt>Category</dt><dd>${escapeHtml(item.category)}</dd></div>
          <div><dt>Action</dt><dd>${escapeHtml(item.action_label)}${item.action_id ? ` <code>${escapeHtml(item.action_id)}</code>` : ""}</dd></div>
          <div data-governance-evidence><dt>Evidence</dt><dd><code>${escapeHtml(item.evidence_path)}</code></dd></div>
          <div><dt>Records</dt><dd>${item.record_ids.length ? item.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ") : "none"}</dd></div>
        </dl>
      </div>
    </details>
  `;
}

function governanceHub(governance: DashboardGovernance): string {
  if (governance.summary.total_items === 0) return "";
  const safeInspections = governance.items.filter(isSafeGovernanceInspection);
  const primaryItems = governance.items.filter((item) => !isSafeGovernanceInspection(item));
  return `
    <section class="panel governance-hub" aria-label="Governance Hub">
      <div class="governance-heading">
        <div>
          <h2>Governance Hub</h2>
          <p><code>governance.summary</code></p>
        </div>
        <div class="governance-counts">
          <span>${escapeHtml(governance.summary.needs_user_action)} need confirmation</span>
          <span>${escapeHtml(governance.summary.safe_inspections)} safe checks</span>
          <span>${escapeHtml(governance.summary.hidden_private_records)} private hidden</span>
        </div>
      </div>
      <div class="governance-list">
        ${primaryItems.map(governanceItem).join("")}
        ${safeInspections.length === 0 ? "" : `
          <details class="governance-safe-group" data-dashboard-detail="governance-safe-inspections">
            <summary class="dashboard-fold-summary">
              <span>Safe Inspections</span>
              <small>${escapeHtml(pluralize(safeInspections.length, "read-only check"))}</small>
            </summary>
            <div class="governance-safe-list">
              ${safeInspections.map(governanceItem).join("")}
            </div>
          </details>
        `}
      </div>
    </section>
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

function maintenanceMoveSummary(plan: DashboardMaintenancePlan): string {
  return `Move ${pluralize(plan.dry_run.matched_records, "record")}`;
}

function maintenanceReviewQueueSummary(plans: DashboardMaintenancePlan[]): string {
  const recordTotal = plans.reduce((total, plan) => total + plan.dry_run.matched_records, 0);
  return `${pluralize(plans.length, "plan")} | ${pluralize(recordTotal, "record")} to move | explicit approval`;
}

function maintenanceReviewQueue(plans: DashboardMaintenancePlan[]): string {
  if (plans.length === 0) return "";
  return `
    <section class="panel maintenance-review" aria-label="Maintenance review queue">
      <details class="maintenance-review-summary" data-dashboard-detail="maintenance-review-queue">
        <summary class="dashboard-fold-summary maintenance-review-fold">
          <span>Review Queue</span>
          <small>${escapeHtml(maintenanceReviewQueueSummary(plans))}</small>
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
                    <p>${escapeHtml(plan.decision_card.issue)}</p>
                  </div>
                  <div class="maintenance-plan-flags" aria-label="Maintenance safety">
                    <span>Review before write</span>
                    <span>Plan hash guard</span>
                  </div>
                </div>
                <dl class="maintenance-summary maintenance-decision-summary" data-maintenance-decision-summary>
                  <div><dt>Why</dt><dd>${escapeHtml(plan.decision_card.impact)}</dd></div>
                  <div><dt>Change</dt><dd>${escapeHtml(maintenanceMoveSummary(plan))}<small>${escapeHtml(`${plan.from_project_id} to ${plan.to_project_id}`)}</small></dd></div>
                  <div><dt>Safety</dt><dd>${escapeHtml("Server re-runs the dry run and checks plan_hash before applying.")}<small>${escapeHtml(maintenancePrivateSummary(plan))}</small></dd></div>
                  <div><dt>Action</dt><dd>${escapeHtml(plan.decision_card.recommended_action)}</dd></div>
                </dl>
                <details data-dashboard-detail="maintenance:${escapeHtml(plan.plan_id)}">
                  <summary>Evidence, rollback, and raw plan</summary>
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
                        <div><dt>Old project id</dt><dd><code>${escapeHtml(plan.from_project_id)}</code></dd></div>
                        <div><dt>Target project</dt><dd><code>${escapeHtml(plan.to_project_id)}</code></dd></div>
                        <div><dt>Records</dt><dd>${escapeHtml(maintenanceStateSummary(plan.dry_run.states) || "none")}</dd></div>
                        <div><dt>Private records</dt><dd>${escapeHtml(maintenancePrivateSummary(plan))}</dd></div>
                        <div><dt>Record ids</dt><dd>${plan.decision_card.raw_evidence.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}</dd></div>
                        <div><dt>Command</dt><dd><code>${escapeHtml(plan.decision_card.raw_evidence.command)}</code></dd></div>
                      </dl>
                    </section>
                  </div>
                </details>
                <div class="maintenance-actions">
                  <button type="button" data-maintenance-reject>Reject</button>
                  <button type="button" data-maintenance-copy data-command="${escapeHtml(plan.command)}">Copy command</button>
                  <button
                    type="button"
                    class="primary"
                    data-maintenance-approve
                    data-dashboard-action-id="${escapeHtml(maintenanceApproveActionId(plan))}"
                    data-endpoint="${escapeHtml(maintenancePlanEndpoint(plan))}"
                    data-plan-hash="${escapeHtml(plan.plan_hash)}"
                  >Apply Repair</button>
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

function memoryLifecyclePanel(report: MemoryLifecycleResult): string {
  const totalFindings = report.findings.length;
  const totalActions = report.suggested_actions.length;
  if (report.stats.total_records === 0 && totalFindings === 0 && totalActions === 0) return "";
  return `
    <details class="panel memory-lifecycle" data-dashboard-detail="memory-lifecycle-audit" aria-label="Memory Lifecycle">
      <summary class="dashboard-fold-summary">
        <span>Memory Lifecycle</span>
        <small>${escapeHtml(pluralize(totalFindings, "finding"))} | ${escapeHtml(pluralize(totalActions, "action"))}</small>
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
        <summary>Suggested actions</summary>
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
  return `
    <details class="context-pack-checks-fold" data-dashboard-detail="context-pack-checks">
      <summary class="dashboard-fold-summary">
        <span>Quality Checks</span>
        <small>${escapeHtml(passed)} passed | ${escapeHtml(needsReview)} review</small>
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
  return `${gate.status} | ${pluralize(pack.recent_decisions.length, "decision")} | ${pluralize(pack.open_threads.length, "thread")} | ${pluralize(pack.risks.length, "risk")}`;
}

function contextPackReviewPanel(review: DashboardContextPackReview): string {
  if (!review.available || !review.handoff_pack) {
    return `
      <section class="panel context-pack-review" aria-label="Context Pack Review">
        <div class="context-pack-heading">
          <h2>Context Pack Review</h2>
          <span>Unavailable</span>
        </div>
        <div class="empty-state">${escapeHtml(review.unavailable_reason ?? "Project context is required for Context Pack Review.")}</div>
      </section>
    `;
  }
  const pack = review.handoff_pack;
  const gate = pack.quality_gate;
  return `
    <details class="panel context-pack-review" data-dashboard-detail="context-pack-review" aria-label="Context Pack Review">
      <summary class="dashboard-fold-summary context-pack-review-fold">
        <span>Context Pack Review</span>
        <small>${escapeHtml(contextPackReviewSummary(review))}</small>
      </summary>
      <div class="context-pack-review-body">
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
            <small>${escapeHtml(pluralize(pack.recent_decisions.length, "decision"))} | ${escapeHtml(pluralize(pack.open_threads.length, "thread"))} | ${escapeHtml(pluralize(pack.risks.length, "risk"))}</small>
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

function capturePolicyAuditPanel(report: CapturePolicyResult): string {
  if (report.stats.total_autocapture_records === 0) return "";
  const capturedRuleSummary = Object.entries(report.stats.captured_by_rule)
    .map(([ruleId, count]) => `${ruleId}: ${count}`)
    .join(" / ") || "no auto-captured handoffs";
  const ruleSummary = Object.entries(report.stats.archived_by_rule)
    .map(([ruleId, count]) => `${ruleId}: ${count}`)
    .join(" / ") || "no archived noise";
  return `
    <details class="panel capture-policy-audit" data-dashboard-detail="capture-policy-audit" aria-label="Capture Policy Audit">
      <summary class="dashboard-fold-summary">
        <span>Capture Policy Audit</span>
        <small>${escapeHtml(pluralize(report.stats.auto_captured_records, "auto-captured"))} | ${escapeHtml(pluralize(report.stats.review_records, "review"))} | ${escapeHtml(pluralize(report.stats.policy_archived_records, "archived"))}</small>
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
      <details class="lifecycle-action-details" data-dashboard-detail="capture-policy:${escapeHtml(report.policy.id)}">
        <summary>Policy decisions and read-only actions</summary>
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
        ${capturePolicyDecisionCards(report)}
      </details>
    </details>
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
      <div class="rail-labels"><span>Remote</span><strong>${escapeHtml(titleCase(sync.state))}</strong><span>Local</span></div>
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
  return `
    <article class="value-card${extraClass ? ` ${extraClass}` : ""}" data-dashboard-citation="record:${escapeHtml(record.id)}">
      <div class="value-card-head">
        <span class="pill state-${escapeHtml(record.state)}">${escapeHtml(record.title)}</span>
        <time title="${escapeHtml(record.exact_time)}">${escapeHtml(record.relative_time)}</time>
      </div>
      ${textExcerptBlock(record.summary, "data-full-summary-hidden")}
      <footer>
        <span>${escapeHtml(record.source_label)}</span>
        <span>${escapeHtml(record.state)}</span>
        <span>${escapeHtml(record.project_id ?? record.scope)}</span>
      </footer>
      <details data-dashboard-detail="value:${escapeHtml(record.id)}">
        <summary>Details</summary>
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

function captureInbox(items: DashboardCaptureInbox): string {
  if (items.total === 0 && items.autocapture_policy.auto_captured_total === 0 && items.autocapture_policy.archived_total === 0) return "";
  return `
    <section class="panel capture-inbox" aria-label="Capture Inbox">
      <div class="capture-inbox-heading">
        <h2>Capture Inbox</h2>
        <span>${escapeHtml(pluralize(items.total, "candidate"))} | ${escapeHtml(pluralize(items.group_total, "group"))}</span>
      </div>
      <details class="capture-policy-summary" data-dashboard-detail="capture-policy-summary">
        <summary class="dashboard-fold-summary">
          <span>Capture Policy</span>
          <small>manual review | no auto-canonical | ${escapeHtml(pluralize(items.total, "candidate"))}</small>
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
      </details>
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
      <div class="capture-inbox-list">
        ${items.groups.map((group) => {
          const groupItems = items.items.filter((item) => item.group_id === group.id);
          return `
          <article class="capture-inbox-group" data-capture-inbox-group="${escapeHtml(group.id)}">
            <div class="capture-inbox-main">
              <div>
                <h3>${escapeHtml(group.source_label)} capture group</h3>
                ${textExcerptBlock(group.summary)}
              </div>
              <span class="pill ${group.noise.level === "likely_noise" ? "warning" : "state-candidate"}">${escapeHtml(group.noise.level === "likely_noise" ? "Likely noise" : "candidate")}</span>
            </div>
            <dl class="capture-inbox-summary">
              <div><dt>Source</dt><dd>${escapeHtml(group.source_label)}<small>${escapeHtml(group.source_detail)}</small></dd></div>
              <div><dt>Project</dt><dd><code>${escapeHtml(group.project_id ?? "global")}</code></dd></div>
              <div><dt>Items</dt><dd>${escapeHtml(pluralize(group.total, "candidate"))}<small>${escapeHtml(group.noise.suggested_action)} suggested</small></dd></div>
              <div><dt>Captured</dt><dd><time title="${escapeHtml(group.latest_at)}">${escapeHtml(group.relative_time)}</time></dd></div>
            </dl>
            <details data-dashboard-detail="capture-group:${escapeHtml(group.id)}">
              <summary>Group details</summary>
              <dl>
                <div><dt>Group</dt><dd><code>${escapeHtml(group.id)}</code></dd></div>
                <div><dt>Records</dt><dd>${group.record_ids.map((recordId) => `<code>${escapeHtml(recordId)}</code>`).join(" ")}</dd></div>
                <div><dt>Rules</dt><dd>${group.noise.rule_ids.length ? group.noise.rule_ids.map((ruleId) => `<code>${escapeHtml(ruleId)}</code>`).join(" ") : "none"}</dd></div>
                <div><dt>Noise</dt><dd>${escapeHtml(group.noise.reasons.length ? group.noise.reasons.join(" ") : "No noise signals detected.")}</dd></div>
              </dl>
              <div class="capture-inbox-items">
                ${groupItems.map((item) => `
                  <article class="capture-inbox-item" data-capture-inbox-record="${escapeHtml(item.id)}">
                    <div class="capture-inbox-main">
                      <div>
                        <h3>${escapeHtml(titleCase(item.type || item.kind))}</h3>
                        ${textExcerptBlock(item.text)}
                      </div>
                      <span class="pill ${item.noise.level === "likely_noise" ? "warning" : "state-candidate"}">${escapeHtml(item.noise.level === "likely_noise" ? "Likely noise" : "candidate")}</span>
                    </div>
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
                  </article>
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
    </section>
  `;
}

function recordsTable(records: DashboardRecordSummary[]): string {
  const rows = records.map((record) => `
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
          <summary>${escapeHtml(shortText(record.text))}</summary>
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
            <th>Text</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function eventsTimeline(events: DashboardEventSummary[]): string {
  return `
    <div class="event-list">
      ${events.map((event) => `
        <details class="event-row" data-dashboard-detail="event:${escapeHtml(event.event_id)}" data-dashboard-citation="event:${escapeHtml(event.event_id)}">
          <summary>
            <span>${escapeHtml(titleCase(event.op))}</span>
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
  `;
}

function renderDashboardBody(data: DashboardData): string {
  const sync = data.sync;
  const topAgent = data.charts.agent_activity.at(-1);
  const recentValueSummary = `${pluralize(data.recent_value.length, "record")} | newest first | full details kept`;
  return `
    <header>
      <div>
        <h1>Moryn Dashboard</h1>
        <p class="store-path" title="${escapeHtml(data.store.path)}">${escapeHtml(data.store.path)}</p>
        <p>Generated <time title="${escapeHtml(data.generated_at)}">${escapeHtml(data.generated_at)}</time></p>
      </div>
      <span class="health-badge ${healthClass(data.health.status)}">${escapeHtml(data.health.label)}</span>
    </header>

    <section class="status-strip ${healthClass(data.health.status)}" data-dashboard-status="${escapeHtml(data.health.status)}">
      <strong>Dashboard Status</strong>
      <span>${escapeHtml(data.health.label)}</span>
      <p>${escapeHtml(data.health.explanation)}</p>
    </section>

    <section class="overview-grid" aria-label="Dashboard overview">
      ${metric("Sync", syncLabel(sync), sync.remote ?? "no remote")}
      ${metric("Remote", sync.remote ? `${sync.branch ?? "unknown"} | ${sync.ahead ?? 0}/${sync.behind ?? 0}` : "not configured")}
      ${metric("Records", `${data.totals.active_records} active`, `${data.totals.quarantined_records} hidden`)}
      ${metric("Agents", topAgent ? `${data.charts.agent_activity.length} clients` : "none yet", topAgent ? `${topAgent.client} ${topAgent.relative_time}` : undefined)}
    </section>

    <section class="panel">
      <h2>Needs Attention</h2>
      ${attentionItems(data.attention_items)}
    </section>

    ${governanceHub(data.governance)}

    ${maintenanceReviewQueue(data.maintenance.plans)}

    ${contextPackReviewPanel(data.context_pack_review)}

    ${memoryLifecyclePanel(data.memory_lifecycle)}

    ${capturePolicyAuditPanel(data.capture_policy)}

    ${captureInbox(data.capture_inbox)}

    <details class="panel store-signals" data-dashboard-detail="store-signals">
      <summary class="dashboard-fold-summary">
        <span>Store Signals</span>
        <small>agent activity / record quality / sync</small>
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
        <div class="signal-card">
          <h2>Sync Position</h2>
          ${syncRail(data.charts.sync_position)}
        </div>
      </section>
    </details>

    <details class="panel recent-value-panel" data-dashboard-detail="recent-value">
      <summary class="dashboard-fold-summary recent-value-fold">
        <span>Recent Value</span>
        <small>${escapeHtml(recentValueSummary)}</small>
      </summary>
      <div class="recent-value-body">
        ${recentValueCards(data.recent_value)}
      </div>
    </details>

    <details class="panel debug-inspector" data-dashboard-detail="debug-inspector">
      <summary class="dashboard-fold-summary">
        <span>Debug Inspector</span>
        <small>records / events / sync</small>
      </summary>
      <div class="inspector-grid">
        <details data-dashboard-detail="inspector:records">
          <summary>Records</summary>
          ${recordsTable(data.recent_records)}
        </details>
        <details data-dashboard-detail="inspector:events">
          <summary>Events</summary>
          ${eventsTimeline(data.recent_events)}
        </details>
        <details data-dashboard-detail="inspector:sync">
          <summary>Sync</summary>
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
        } catch {
          // Keep the last successful render visible if a refresh fails.
        }
      };
      window.setInterval(refresh, interval);
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
        if (status) status.textContent = "Applying repair...";
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
          if (status) status.textContent = "Applied. Refreshing dashboard...";
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
          if (status) status.textContent = isReject ? "Rejected. Refreshing dashboard..." : "Approved. Refreshing dashboard...";
          await refreshFragment();
        } catch (error) {
          if (status) status.textContent = error instanceof Error ? error.message : "Capture Inbox action failed.";
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
    .panel, .metric {
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
    .overview-grid, .visual-grid { display: grid; gap: 11px; }
    .overview-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 14px; }
    .visual-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .metric {
      --metric-accent: var(--signal-green);
      position: relative;
      min-width: 0;
      overflow: hidden;
      padding: 13px 13px 12px;
      background: var(--surface);
    }
    .metric:before { content: ""; position: absolute; inset: 0 0 auto; height: 3px; background: var(--metric-accent); }
    .metric:nth-child(1) { --metric-accent: var(--signal-green); }
    .metric:nth-child(2) { --metric-accent: var(--signal-blue); }
    .metric:nth-child(3) { --metric-accent: var(--signal-violet); }
    .metric:nth-child(4) { --metric-accent: var(--signal-slate); }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 11.5px;
      font-weight: 760;
      text-transform: uppercase;
    }
    .metric strong { display: block; margin-top: 4px; font-size: 20px; font-weight: 820; line-height: 1.18; color: var(--ink); overflow-wrap: anywhere; }
    .metric small { margin-top: 4px; }
    .attention-list { display: grid; gap: 9px; }
    .attention-info-group {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 11px;
      background: var(--surface-2);
    }
    .attention-info-group[open] > summary { margin-bottom: 8px; }
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
    .memory-lifecycle { border-left: 4px solid var(--signal-violet); }
    .store-signals { border-left: 4px solid var(--signal-slate); }
    .capture-inbox { border-left: 4px solid var(--signal-blue); }
    .maintenance-heading, .maintenance-plan-main, .maintenance-actions,
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
    .context-pack-heading span,
    .governance-heading span,
    .lifecycle-heading span,
    .capture-inbox-heading span, .capture-inbox-status { color: var(--muted); font-size: 12px; font-weight: 650; }
    .maintenance-list, .governance-list, .lifecycle-findings, .lifecycle-actions, .capture-inbox-list, .capture-inbox-items { display: grid; gap: 10px; }
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
    .governance-safe-list .governance-item { background: var(--surface); }
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
    .capture-policy-summary {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px;
      margin: -4px 0 12px;
      background: var(--surface);
    }
    .capture-policy-summary[open] > summary { margin-bottom: 8px; }
    .capture-policy-summary .capture-policy { margin: 0 0 8px; }
    .capture-policy-summary .capture-policy:last-child { margin-bottom: 0; }
    .capture-policy-rules {
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 9px 10px;
      margin: 0 0 12px;
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
    .capture-inbox-item { background: var(--surface); }
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
    @media (max-width: 920px) {
      header, .overview-grid, .visual-grid, .value-grid { grid-template-columns: 1fr; }
      .store-path { white-space: normal; overflow-wrap: anywhere; }
      main { padding: 18px 12px 36px; }
      .status-strip { grid-template-columns: 1fr; align-items: start; }
      .attention-summary { display: grid; justify-content: stretch; }
      .bar-label, .maintenance-heading, .maintenance-plan-main, .maintenance-actions,
      .context-pack-heading, .governance-heading,
      .lifecycle-heading,
      .capture-inbox-heading, .capture-inbox-main, .capture-inbox-actions { display: grid; justify-content: stretch; }
      .maintenance-summary, .context-pack-summary, .context-pack-grid, .lifecycle-summary, .capture-inbox-summary { grid-template-columns: 1fr; }
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
  ${dashboardMaintenanceScript()}
  ${dashboardCaptureInboxScript()}
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

async function requireCaptureInboxCandidate(storePath: string, recordId: string, includePrivate: boolean | undefined): Promise<MorynRecord | undefined> {
  const records = replayEvents(await readEvents(storePath));
  const record = records.get(recordId);
  if (!record || !isVisibleForDashboard(record, includePrivate) || !isCaptureInboxCandidate(record)) return undefined;
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

export async function startDashboardServer(storePath: string, options: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const host = dashboardServerHost(options.host);
  const requestedPort = dashboardServerPort(options.port);
  const refreshIntervalMs = dashboardRefreshInterval(options.refreshIntervalMs);
  const limit = dashboardLimit(options.limit);
  const includePrivate = options.include_private;
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
        const data = await buildDashboardData(storePath, { limit, include_private: includePrivate, project_id: options.project_id });
        sendResponse(response, 200, renderDashboardServerHtml(data, refreshIntervalMs), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/fragment") {
        const data = await buildDashboardData(storePath, { limit, include_private: includePrivate, project_id: options.project_id });
        sendResponse(response, 200, renderDashboardFragment(data), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/api/dashboard") {
        const data = await buildDashboardData(storePath, { limit, include_private: includePrivate, project_id: options.project_id });
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
