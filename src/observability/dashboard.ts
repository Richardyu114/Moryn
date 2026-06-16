import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { displayRecordText } from "../core/content-text.js";
import { replayEvents } from "../core/replay.js";
import { readEvents } from "../core/store.js";
import type { MorynEvent, MorynRecord, RecordKind, RecordSource } from "../core/types.js";
import { getGitSyncStatus, type GitSyncStatus } from "../sync/git.js";

const exec = promisify(execFile);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RECENT_VALUE_LIMIT = 8;

export const DASHBOARD_SELECTION_SOURCES = {
  store: "store",
  sync: "sync",
  health: "health",
  attention_item: "attention_items[]",
  charts: "charts",
  totals: "totals",
  recent_value: "recent_value[]",
  record: "recent_records[]",
  event: "recent_events[]",
  agent_activity: "agent_activity[]",
  artifact: "artifact"
} as const;

export interface DashboardOptions {
  limit?: number;
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
}

export interface DashboardEventSummary {
  event_id: string;
  op: MorynEvent["op"];
  record_id?: string;
  source: RecordSource;
  created_at: string;
}

export interface DashboardAgentActivity {
  client: string;
  raw_clients: string[];
  events: number;
  records: number;
  latest_at: string;
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
  recent_value: DashboardValueRecord[];
  recent_records: DashboardRecordSummary[];
  recent_events: DashboardEventSummary[];
  agent_activity: DashboardAgentActivity[];
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

function targetRecordId(event: MorynEvent): string | undefined {
  return event.op === "upsert_record" ? event.record.id : event.record_id;
}

function summarizeRecord(record: MorynRecord): DashboardRecordSummary {
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
    text: recordText(record)
  };
}

function summarizeEvent(event: MorynEvent): DashboardEventSummary {
  return {
    event_id: event.event_id,
    op: event.op,
    record_id: targetRecordId(event),
    source: event.source,
    created_at: event.created_at
  };
}

function latestIso(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

function displayClient(rawClient: string): string {
  const normalized = rawClient.toLowerCase();
  if (["agent", "cli", "codex", "codex-cli", "mcp"].includes(normalized)) return "Codex / Moryn Local";
  if (normalized === "gemini") return "Gemini";
  return titleCase(rawClient || "unknown");
}

function updateAgentActivity(
  activity: Map<string, DashboardAgentActivity>,
  rawClient: string,
  field: "events" | "records",
  latestAt: string
) {
  const client = displayClient(rawClient);
  const existing = activity.get(client) ?? { client, raw_clients: [], events: 0, records: 0, latest_at: latestAt };
  existing[field] += 1;
  existing.latest_at = latestIso(existing.latest_at, latestAt);
  if (!existing.raw_clients.includes(rawClient)) existing.raw_clients.push(rawClient);
  existing.raw_clients.sort();
  activity.set(client, existing);
}

function summarizeAgentActivity(events: MorynEvent[], records: MorynRecord[]): DashboardAgentActivity[] {
  const activity = new Map<string, DashboardAgentActivity>();

  for (const event of events) {
    updateAgentActivity(activity, event.source.client, "events", event.created_at);
  }

  for (const record of records) {
    updateAgentActivity(activity, record.source.client, "records", record.updated_at);
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
  for (const record of records) {
    if (isQuarantined(record) || record.visibility !== "active") continue;
    const superseded = record.content.supersedes_quarantined_record;
    if (typeof superseded === "string" && superseded.length > 0) {
      ids.add(superseded);
    }
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

function summarizeValueRecord(record: MorynRecord, generatedAt: string): DashboardValueRecord {
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
    project_id: record.project_id
  };
}

function buildRecentValue(records: MorynRecord[], generatedAt: string, limit: number): DashboardValueRecord[] {
  return [...records]
    .sort((left, right) => {
      const timeDiff = right.updated_at.localeCompare(left.updated_at);
      const scoreDiff = recordValueScore(right) - recordValueScore(left);
      return timeDiff || scoreDiff || left.id.localeCompare(right.id);
    })
    .slice(0, limit)
    .map((record) => summarizeValueRecord(record, generatedAt));
}

export async function buildDashboardData(storePath: string, options: DashboardOptions = {}): Promise<DashboardData> {
  const limit = dashboardLimit(options.limit);
  const events = await readEvents(storePath);
  const records = [...replayEvents(events).values()];
  const recentRecords = [...records]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
    .slice(0, limit);
  const recentEvents = [...events]
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || left.event_id.localeCompare(right.event_id))
    .slice(0, limit);
  const generatedAt = new Date().toISOString();
  const sync = await getGitSyncStatus(storePath);
  const agentActivity = summarizeAgentActivity(events, records);

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
      events: events.length,
      records: records.length,
      active_records: records.filter((record) => record.visibility === "active").length,
      quarantined_records: records.filter((record) => record.visibility === "quarantined").length
    },
    recent_value: buildRecentValue(records, generatedAt, Math.min(limit, RECENT_VALUE_LIMIT)),
    recent_records: recentRecords.map(summarizeRecord),
    recent_events: recentEvents.map(summarizeEvent),
    agent_activity: agentActivity,
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

function metric(label: string, value: unknown, hint?: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</div>`;
}

function healthClass(status: DashboardHealthStatus): string {
  if (status === "healthy") return "good";
  if (status === "conflict") return "critical";
  if (status === "needs_review") return "warning";
  return "info";
}

function attentionItems(items: DashboardAttentionItem[]): string {
  if (items.length === 0) {
    return `<div class="empty-state">No issues detected in the current snapshot.</div>`;
  }
  return `
    <div class="attention-list">
      ${items.map((item) => `
        <article class="attention ${escapeHtml(item.severity)}">
          <div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(titleCase(item.severity))}</span></div>
          <p>${escapeHtml(item.description)}</p>
          ${item.action_command ? `<code>${escapeHtml(item.action_command)}</code>` : ""}
        </article>
      `).join("")}
    </div>
  `;
}

function agentBars(agents: DashboardAgentChartItem[]): string {
  if (agents.length === 0) return `<div class="empty-state">No agent activity recorded yet.</div>`;
  return `
    <div class="agent-bars">
      ${agents.map((agent) => `
        <div class="bar-row">
          <div class="bar-label">
            <strong>${escapeHtml(agent.client)}</strong>
            <span>${escapeHtml(agent.events)} events | ${escapeHtml(agent.records)} records | ${escapeHtml(agent.relative_time)}</span>
          </div>
          <div class="bar-track" aria-hidden="true"><span style="width: ${escapeHtml(agent.weight)}%"></span></div>
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

function recentValueCards(records: DashboardValueRecord[]): string {
  if (records.length === 0) return `<div class="empty-state">No recent records to summarize.</div>`;
  return `
    <div class="value-grid">
      ${records.map((record) => `
        <article class="value-card">
          <div class="value-card-head">
            <span class="pill state-${escapeHtml(record.state)}">${escapeHtml(record.title)}</span>
            <time title="${escapeHtml(record.exact_time)}">${escapeHtml(record.relative_time)}</time>
          </div>
          <p>${escapeHtml(record.summary)}</p>
          <footer>
            <span>${escapeHtml(record.source_label)}</span>
            <span>${escapeHtml(record.state)}</span>
            <span>${escapeHtml(record.project_id ?? record.scope)}</span>
          </footer>
          <details data-dashboard-detail="value:${escapeHtml(record.id)}">
            <summary>Details</summary>
            <dl>
              <div><dt>ID</dt><dd><code>${escapeHtml(record.id)}</code></dd></div>
              <div><dt>Source</dt><dd>${escapeHtml(record.source_detail)}</dd></div>
              <div><dt>Kind</dt><dd>${escapeHtml(record.kind)} / ${escapeHtml(record.type)}</dd></div>
            </dl>
          </details>
        </article>
      `).join("")}
    </div>
  `;
}

function recordsTable(records: DashboardRecordSummary[]): string {
  const rows = records.map((record) => `
    <tr>
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
          <p>${escapeHtml(record.text)}</p>
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
        <details class="event-row" data-dashboard-detail="event:${escapeHtml(event.event_id)}">
          <summary>
            <span>${escapeHtml(titleCase(event.op))}</span>
            <time>${escapeHtml(event.created_at)}</time>
          </summary>
          <dl>
            <div><dt>Event</dt><dd><code>${escapeHtml(event.event_id)}</code></dd></div>
            ${event.record_id ? `<div><dt>Record</dt><dd><code>${escapeHtml(event.record_id)}</code></dd></div>` : ""}
            <div><dt>Source</dt><dd>${escapeHtml(sourceLabel(event.source))}</dd></div>
          </dl>
        </details>
      `).join("")}
    </div>
  `;
}

function renderDashboardBody(data: DashboardData): string {
  const sync = data.sync;
  const topAgent = data.charts.agent_activity.at(-1);
  return `
    <header>
      <div>
        <h1>Moryn Dashboard</h1>
        <p class="store-path" title="${escapeHtml(data.store.path)}">${escapeHtml(data.store.path)}</p>
        <p>Generated <time title="${escapeHtml(data.generated_at)}">${escapeHtml(data.generated_at)}</time></p>
      </div>
      <span class="health-badge ${healthClass(data.health.status)}">${escapeHtml(data.health.label)}</span>
    </header>

    <section class="hero">
      <h2>${escapeHtml(data.health.label)}</h2>
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

    <section class="visual-grid">
      <div class="panel">
        <h2>Agent Activity</h2>
        ${agentBars(data.charts.agent_activity)}
      </div>
      <div class="panel">
        <h2>Record Quality</h2>
        ${memoryStateStack(data.charts.memory_states)}
      </div>
      <div class="panel">
        <h2>Record Types</h2>
        ${recordTypeBars(data.charts.record_types)}
      </div>
      <div class="panel">
        <h2>Sync Position</h2>
        ${syncRail(data.charts.sync_position)}
      </div>
    </section>

    <section class="panel">
      <h2>Recent Value</h2>
      ${recentValueCards(data.recent_value)}
    </section>

    <section class="panel">
      <h2>Debug Inspector</h2>
      <div class="inspector-grid">
        <details open data-dashboard-detail="inspector:records">
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
    </section>
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
    .panel, .hero, .metric {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 12px 30px rgba(21, 25, 30, 0.055);
    }
    .panel { padding: 16px; margin-bottom: 14px; background: var(--surface); }
    .hero {
      background:
        linear-gradient(135deg, rgba(21,25,30,0.98), rgba(33,43,54,0.96) 62%, rgba(49,95,159,0.88)),
        var(--ink);
      border-color: rgba(255,255,255,0.14);
      color: #fff;
      padding: 20px;
      margin-bottom: 14px;
      box-shadow: 0 22px 44px rgba(21, 25, 30, 0.15);
    }
    .hero h2 { color: #fff; font-size: 19px; font-weight: 820; }
    .hero p { max-width: 780px; color: rgba(255,255,255,0.72); font-size: 14.5px; }
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
    .attention {
      border: 1px solid var(--border);
      border-left-width: 4px;
      border-radius: 7px;
      padding: 11px;
      background: var(--surface);
    }
    .attention div { display: flex; justify-content: space-between; gap: 10px; }
    .attention strong { color: var(--ink); font-weight: 760; }
    .attention span { color: var(--subtle); font-weight: 680; }
    .attention.info { border-left-color: var(--info); }
    .attention.warning { border-left-color: var(--warning); }
    .attention.critical { border-left-color: var(--critical); }
    .empty-state { border: 1px dashed var(--border); border-radius: 7px; padding: 14px; color: var(--muted); background: var(--surface-2); }
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
    .value-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
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
    .event-list { display: grid; gap: 8px; }
    .event-row { border: 1px solid var(--border); border-radius: 7px; padding: 10px; background: var(--surface); }
    .event-row summary { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }
    @media (max-width: 920px) {
      header, .overview-grid, .visual-grid, .value-grid { grid-template-columns: 1fr; }
      .store-path { white-space: normal; overflow-wrap: anywhere; }
      main { padding: 18px 12px 36px; }
      .bar-label { display: grid; }
      .bar-label span { text-align: left; }
    }
  </style>
</head>
<body class="neutral-intelligence">
  <main${refreshAttributes}>${renderDashboardBody(data)}</main>
  ${dashboardRefreshScript(options.refreshIntervalMs)}
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

export async function startDashboardServer(storePath: string, options: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const host = dashboardServerHost(options.host);
  const requestedPort = dashboardServerPort(options.port);
  const refreshIntervalMs = dashboardRefreshInterval(options.refreshIntervalMs);
  const limit = dashboardLimit(options.limit);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${requestedPort}`}`);
    const includeBody = request.method !== "HEAD";
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendResponse(response, 405, "Method not allowed", "text/plain; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const data = await buildDashboardData(storePath, { limit });
        sendResponse(response, 200, renderDashboardServerHtml(data, refreshIntervalMs), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/fragment") {
        const data = await buildDashboardData(storePath, { limit });
        sendResponse(response, 200, renderDashboardFragment(data), "text/html; charset=utf-8", includeBody);
        return;
      }
      if (url.pathname === "/api/dashboard") {
        const data = await buildDashboardData(storePath, { limit });
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
