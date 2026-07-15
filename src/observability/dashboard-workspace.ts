import type {
  DashboardAttentionItem,
  DashboardData,
  DashboardEventSummary,
  DashboardRecordSummary,
  DashboardMemoryStateChartItem,
  DashboardRecordTypeChartItem,
  DashboardActivityTrendChart,
  DashboardAgentChartItem
} from "./dashboard.js";
import { dashboardRecordTitleLabel, memoryStateLabelFromRecordState, memoryKindLabel } from "./dashboard.js";

export interface DashboardWorkspaceFragments {
  memory_html: string;
  history_html: string;
  language_toggle_html: string;
}

export interface DashboardDrawerItem {
  id: string;
  kind: "context" | "memory" | "event" | "important";
  title_en: string;
  title_zh: string;
  summary_en: string;
  summary_zh: string;
  body_en?: string;
  body_zh?: string;
  truncated?: boolean;
  github_url?: string;
  recall_command?: string;
  store_path?: string;
  metadata: Array<{ label_en: string; label_zh: string; value_en: string; value_zh?: string }>;
  evidence_html: string;
}

export interface DashboardWorkspaceModel {
  task: string;
  project: string;
  agent: string;
  device: string;
  generated_at: string;
  no_action_required: boolean;
  sync_label_en: string;
  sync_label_zh: string;
  memory: {
    active: number;
    learned: number;
    conflicts: number;
    compaction_ratio: number;
  };
  recent_events: DashboardEventSummary[];
  important_records: DashboardRecordSummary[];
  drawers: DashboardDrawerItem[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function githubBaseFromRemote(remote: string | undefined, branch: string | undefined): string | undefined {
  if (!remote) return undefined;
  const match = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) return undefined;
  const [, owner, repo] = match;
  return `https://github.com/${owner}/${repo}/blob/${branch || "main"}`;
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function i18n(en: string, zh: string, tag = "span"): string {
  return `<${tag} data-i18n-en="${escapeHtml(en)}" data-i18n-zh="${escapeHtml(zh)}">${escapeHtml(en)}</${tag}>`;
}

function sourceLabel(source: DashboardEventSummary["source"] | DashboardRecordSummary["source"]): string {
  const parts = [source.client, source.device_id, source.session_id].filter((value): value is string => typeof value === "string" && value.length > 0);
  return parts.join(" · ") || "unknown";
}

function eventLabel(event: DashboardEventSummary): { en: string; zh: string } {
  const en = event.op.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  const zhByOp: Partial<Record<DashboardEventSummary["op"], string>> = {
    upsert_record: "写入记录",
    promote_record: "提升记录",
    revise_record: "修订记录",
    archive_record: "归档记录",
    quarantine_record: "隔离记录",
    link_records: "关联记录"
  };
  return { en, zh: zhByOp[event.op] ?? en };
}

function syncLabel(data: DashboardData): { en: string; zh: string } {
  if (!data.sync.configured) return { en: "Local only", zh: "仅保存在本机" };
  if (data.sync.sync_state === "clean") return { en: "Shared copy is current", zh: "共享副本已同步" };
  if (data.sync.sync_state === "conflict") return { en: "Shared copy needs review", zh: "共享副本需要检查" };
  if (data.sync.sync_state === "dirty") return { en: "Local changes are protected", zh: "本地变更已保护" };
  return { en: "Shared copy configured", zh: "共享副本已配置" };
}

function contextSummary(data: DashboardData): { en: string; zh: string } {
  const context = data.quiet_dashboard.current_context;
  if (!context.task) return { en: "Moryn is ready. No active task is currently recorded.", zh: "Moryn 已就绪，目前没有记录中的活跃任务。" };
  if (context.checkpoint_available && context.handoff_available) return { en: "The active task has both checkpoint and handoff protection.", zh: "当前任务同时具有检查点和交接保护。" };
  if (context.checkpoint_available) return { en: "The active task is protected by a recent checkpoint.", zh: "当前任务已由最近的检查点保护。" };
  if (context.handoff_available) return { en: "The active task has a recoverable handoff.", zh: "当前任务已有可恢复的交接记录。" };
  return { en: "The active task is visible, but no checkpoint or handoff is currently available.", zh: "当前任务可见，但暂时没有可用的检查点或交接记录。" };
}

function metricDrawer(id: string, titleEn: string, titleZh: string, value: number | string, summaryEn: string, summaryZh: string, data: DashboardData): DashboardDrawerItem {
  return {
    id,
    kind: "memory",
    title_en: titleEn,
    title_zh: titleZh,
    summary_en: summaryEn,
    summary_zh: summaryZh,
    metadata: [
      { label_en: "Value", label_zh: "数值", value_en: String(value) },
      { label_en: "Generated", label_zh: "生成时间", value_en: data.generated_at },
      { label_en: "Source", label_zh: "数据来源", value_en: "DashboardData.quiet_dashboard.memory_flow" }
    ],
    evidence_html: `<code>${escapeHtml(data.store.path)}</code>`
  };
}

function buildDrawerItems(data: DashboardData, task: string, project: string, agent: string, device: string, importantRecords: DashboardRecordSummary[]): DashboardDrawerItem[] {
  const context = data.quiet_dashboard.current_context;
  const flow = data.quiet_dashboard.memory_flow;
  const contextCopy = contextSummary(data);
  const githubBase = githubBaseFromRemote(data.sync.remote, data.sync.branch);
  const storePath = data.store.path;
  const BODY_LIMIT = 4000;
  const items: DashboardDrawerItem[] = [{
    id: "context-current",
    kind: "context",
    title_en: task,
    title_zh: task,
    summary_en: contextCopy.en,
    summary_zh: contextCopy.zh,
    metadata: [
      { label_en: "Project", label_zh: "项目", value_en: project },
      { label_en: "Agent", label_zh: "Agent", value_en: agent },
      { label_en: "Device", label_zh: "设备", value_en: device },
      { label_en: "Updated", label_zh: "更新时间", value_en: data.generated_at },
      { label_en: "Checkpoint", label_zh: "检查点", value_en: context.checkpoint_available ? "Available" : "Not available", value_zh: context.checkpoint_available ? "可用" : "不可用" },
      { label_en: "Handoff", label_zh: "交接", value_en: context.handoff_available ? "Available" : "Not available", value_zh: context.handoff_available ? "可用" : "不可用" }
    ],
    evidence_html: [context.checkpoint_record_id, context.handoff_record_id].filter(Boolean).map((id) => `<code>${escapeHtml(id)}</code>`).join(" ") || i18n("No record id available", "暂无记录 ID")
  }];

  items.push(
    metricDrawer("memory-active", "Active knowledge", "活跃知识", flow.active_working_set_records, "The bounded working set currently available for agent context.", "当前可供 Agent 上下文使用的有界工作记忆。", data),
    metricDrawer("memory-learned", "Learned conclusions", "已学习结论", flow.learned_records, "Reusable conclusions learned and retained by Moryn.", "Moryn 已学习并保留的可复用结论。", data),
    metricDrawer("memory-conflicts", "Material conflicts", "重要冲突", flow.conflict_records, "Conflicting active memories preserved for explicit resolution.", "为明确处理而保留的活跃记忆冲突。", data),
    metricDrawer("memory-compaction", "Consolidation", "记忆收敛", `${Math.round(flow.compaction_ratio * 100)}%`, "The share of logical memory hidden from the active working set through revision, supersession, or duplicate consolidation.", "通过修订、替代或重复合并，从活跃工作记忆中隐藏的逻辑记忆比例。", data)
  );

  for (const event of data.recent_events.slice(0, 5)) {
    const label = eventLabel(event);
    items.push({
      id: `event-${safeDomId(event.event_id)}`,
      kind: "event",
      title_en: label.en,
      title_zh: label.zh,
      summary_en: event.record_id ? `This event affected record ${event.record_id}.` : "This event is part of the recent local audit history.",
      summary_zh: event.record_id ? `此事件影响了记录 ${event.record_id}。` : "此事件属于近期本地审计历史。",
      metadata: [
        { label_en: "Operation", label_zh: "操作", value_en: event.op },
        { label_en: "Source", label_zh: "来源", value_en: sourceLabel(event.source) },
        { label_en: "Created", label_zh: "创建时间", value_en: event.created_at },
        { label_en: "Event id", label_zh: "事件 ID", value_en: event.event_id }
      ],
      evidence_html: `<code>${escapeHtml(event.citation.timeline_command)}</code>${event.citation.recall_command ? ` <code>${escapeHtml(event.citation.recall_command)}</code>` : ""}`
    });
  }

  const recordDrawer = (record: DashboardRecordSummary, kind: DashboardDrawerItem["kind"]): DashboardDrawerItem => {
    const titleLabel = dashboardRecordTitleLabel(record.kind, record.type);
    const fullText = record.text || "";
    const truncated = fullText.length > BODY_LIMIT;
    const eventPath = record.citation.event_path;
    const githubUrl = githubBase && eventPath ? `${githubBase}/${eventPath}` : undefined;
    return {
    id: `record-${safeDomId(record.id)}`,
    kind,
    title_en: titleLabel.en,
    title_zh: titleLabel.zh,
    summary_en: `A ${record.state} ${record.kind} from ${sourceLabel(record.source)}.`,
    summary_zh: `来自 ${sourceLabel(record.source)} 的 ${record.state} ${record.kind}。`,
    body_en: clip(fullText, BODY_LIMIT),
    body_zh: clip(fullText, BODY_LIMIT),
    truncated,
    github_url: githubUrl,
    recall_command: record.citation.recall_command,
    store_path: storePath,
    metadata: [
      { label_en: "Kind", label_zh: "类别", value_en: record.kind },
      { label_en: "Type", label_zh: "类型", value_en: record.type },
      { label_en: "State", label_zh: "状态", value_en: record.state },
      { label_en: "Updated", label_zh: "更新时间", value_en: record.updated_at },
      { label_en: "Record id", label_zh: "记录 ID", value_en: record.id }
    ],
    evidence_html: `<code>${escapeHtml(record.citation.timeline_command)}</code> <code>${escapeHtml(record.citation.recall_command)}</code>`
    };
  };

  const seenRecordIds = new Set<string>();
  for (const record of importantRecords) {
    items.push(recordDrawer(record, "important"));
    seenRecordIds.add(record.id);
  }
  for (const record of data.all_records) {
    if (seenRecordIds.has(record.id)) continue;
    items.push(recordDrawer(record, "memory"));
    seenRecordIds.add(record.id);
  }

  return items;
}

export interface DashboardMemorySearchEntry {
  id: string;
  drawer_id: string;
  kind: DashboardRecordSummary["kind"];
  title_en: string;
  title_zh: string;
  meta_en: string;
  meta_zh: string;
  search_text: string;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/\s+\S*$/, "").trim()}…`;
}

function buildMemorySearchEntries(data: DashboardData): DashboardMemorySearchEntry[] {
  return data.all_records.map((record) => {
    const source = sourceLabel(record.source);
    const rawTitle = record.text || `${record.kind} · ${record.type}`;
    const title = clip(rawTitle.replace(/\s+/g, " "), 120);
    const metaEn = `${record.kind} · ${record.state} · ${source}`;
    const metaZh = `${record.kind} · ${record.state} · ${source}`;
    return {
      id: record.id,
      drawer_id: `record-${safeDomId(record.id)}`,
      kind: record.kind,
      title_en: title,
      title_zh: title,
      meta_en: metaEn,
      meta_zh: metaZh,
      search_text: `${clip(rawTitle.replace(/\s+/g, " "), 400)} ${record.kind} ${record.type} ${record.state} ${source}`.toLowerCase()
    };
  });
}

export function buildDashboardWorkspaceModel(data: DashboardData): DashboardWorkspaceModel {
  const context = data.quiet_dashboard.current_context;
  const flow = data.quiet_dashboard.memory_flow;
  const task = context.task ?? "No active task";
  const project = context.project_id ?? "Local store";
  const agent = context.agent ?? "Unknown agent";
  const device = context.device_id ?? "Unknown device";
  const importantRecordIds = new Set([context.checkpoint_record_id, context.handoff_record_id].filter((value): value is string => typeof value === "string"));
  const importantRecords = data.recent_records.filter((record) => importantRecordIds.has(record.id)).slice(0, 3);
  const sync = syncLabel(data);
  return {
    task,
    project,
    agent,
    device,
    generated_at: data.generated_at,
    no_action_required: data.quiet_dashboard.attention_needed.length === 0,
    sync_label_en: sync.en,
    sync_label_zh: sync.zh,
    memory: {
      active: flow.active_working_set_records,
      learned: flow.learned_records,
      conflicts: flow.conflict_records,
      compaction_ratio: flow.compaction_ratio
    },
    recent_events: data.recent_events.slice(0, 5),
    important_records: importantRecords,
    drawers: buildDrawerItems(data, task, project, agent, device, importantRecords)
  };
}

function renderAttention(items: DashboardAttentionItem[]): string {
  if (items.length === 0) return "";
  return `<section class="editorial-section editorial-attention" data-editorial-section="attention">
    <div class="editorial-section-title">${i18n("Attention", "需要关注")}</div>
    ${items.map((item) => `<article><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p></article>`).join("")}
  </section>`;
}

function renderMetric(id: string, labelEn: string, labelZh: string, value: number | string): string {
  return `<button type="button" class="editorial-metric" data-drawer-target="${escapeHtml(id)}" aria-haspopup="dialog">
    <span data-i18n-en="${escapeHtml(labelEn)}" data-i18n-zh="${escapeHtml(labelZh)}">${escapeHtml(labelEn)}</span><strong>${escapeHtml(value)}</strong>
  </button>`;
}

function renderEvents(events: DashboardEventSummary[]): string {
  if (events.length === 0) return `<p>${i18n("No recent changes", "暂无近期变化")}</p>`;
  return `<div class="editorial-event-list">${events.map((event) => {
    const label = eventLabel(event);
    return `<button type="button" class="editorial-event" data-drawer-target="event-${escapeHtml(safeDomId(event.event_id))}" aria-haspopup="dialog">
    <time datetime="${escapeHtml(event.created_at)}">${escapeHtml(event.created_at.slice(11, 16))}</time>
    <strong data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</strong>
    <small>${escapeHtml(sourceLabel(event.source))}</small>
  </button>`;
  }).join("")}</div>`;
}

function renderImportant(records: DashboardRecordSummary[], model: DashboardWorkspaceModel): string {
  const recordItems = records.map((record) => `<button type="button" class="editorial-important" data-drawer-target="record-${escapeHtml(safeDomId(record.id))}" aria-haspopup="dialog"><strong>${escapeHtml(record.text || `${record.kind} · ${record.type}`)}</strong><p>${escapeHtml(record.state)} · ${escapeHtml(sourceLabel(record.source))}</p></button>`).join("");
  return `<aside class="editorial-sidebar" data-editorial-sidebar="important-now">
    <div class="editorial-sidebar-heading"><div class="editorial-section-title">${i18n("Important Now", "当前重要内容")}</div></div>
    <button type="button" class="editorial-important" data-drawer-target="context-current" aria-haspopup="dialog"><strong>${escapeHtml(model.task)}</strong><p>${i18n("Current task · continuity protected", "当前任务 · 连续性已保护")}</p></button>
    ${recordItems || `<p>${i18n("No additional important items", "暂无其他重要内容")}</p>`}
    <div class="editorial-sync-card"><span>● </span>${i18n(model.sync_label_en, model.sync_label_zh)}</div>
  </aside>`;
}

function stateSwatchClass(state: DashboardMemoryStateChartItem["state"]): string {
  return `swatch-${state}`;
}

function renderMemoryCompositionChart(items: DashboardMemoryStateChartItem[]): string {
  const shown = items.filter((item) => item.count > 0);
  if (shown.length === 0) return "";
  const bar = shown.map((item) => `<span class="glance-bar-seg ${stateSwatchClass(item.state)}" style="width:${item.percent}%" title="${escapeHtml(memoryStateLabelFromRecordState(item.state).en)} ${item.count}"></span>`).join("");
  const legend = shown.map((item) => {
    const label = memoryStateLabelFromRecordState(item.state);
    return `<li><span class="glance-dot ${stateSwatchClass(item.state)}"></span><span class="glance-legend-label" data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</span><span class="glance-legend-value">${item.count}</span></li>`;
  }).join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Memory composition" data-i18n-zh="记忆组成">Memory composition</div>
      <div class="glance-stack">${bar}</div>
      <ul class="glance-legend">${legend}</ul>
    </article>`;
}

function renderContentTypeChart(items: DashboardRecordTypeChartItem[]): string {
  const shown = items.filter((item) => item.count > 0).slice(0, 5);
  if (shown.length === 0) return "";
  const rows = shown.map((item) => `<li class="glance-row">
      <span class="glance-row-label">${escapeHtml(item.label)}</span>
      <span class="glance-row-track"><span class="glance-row-fill" style="width:${item.percent}%"></span></span>
      <span class="glance-row-value">${item.count}</span>
    </li>`).join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Content types" data-i18n-zh="内容类型">Content types</div>
      <ul class="glance-rows">${rows}</ul>
    </article>`;
}

function renderTrendChart(trend: DashboardActivityTrendChart): string {
  if (!trend.days || trend.days.length === 0 || trend.total === 0) return "";
  const peak = Math.max(1, trend.peak);
  const bars = trend.days.map((day) => {
    const h = Math.round((day.count / peak) * 100);
    return `<span class="glance-trend-bar" style="height:${Math.max(3, h)}%" title="${escapeHtml(day.label)}: ${day.count}"></span>`;
  }).join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Recent saves" data-i18n-zh="近期保存">Recent saves</div>
      <div class="glance-trend">${bars}</div>
      <div class="glance-trend-caption"><span data-i18n-en="Last ${trend.days.length} days" data-i18n-zh="最近 ${trend.days.length} 天">Last ${trend.days.length} days</span><span class="glance-legend-value">${trend.total}</span></div>
    </article>`;
}

function renderSourceChart(agents: DashboardAgentChartItem[]): string {
  const shown = [...agents].sort((a, b) => (b.records + b.events) - (a.records + a.events)).slice(0, 4);
  const withSignal = shown.filter((agent) => agent.records + agent.events > 0);
  if (withSignal.length === 0) return "";
  const peak = Math.max(1, ...withSignal.map((agent) => agent.records + agent.events));
  const rows = withSignal.map((agent) => {
    const signals = agent.records + agent.events;
    return `<li class="glance-row">
      <span class="glance-row-label">${escapeHtml(agent.client)}</span>
      <span class="glance-row-track"><span class="glance-row-fill" style="width:${Math.round((signals / peak) * 100)}%"></span></span>
      <span class="glance-row-value">${signals}</span>
    </li>`;
  }).join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Where it comes from" data-i18n-zh="来源分布">Where it comes from</div>
      <ul class="glance-rows">${rows}</ul>
    </article>`;
}

function renderGlance(data: DashboardData): string {
  const cards = [
    renderMemoryCompositionChart(data.charts.memory_states),
    renderContentTypeChart(data.charts.record_types),
    renderTrendChart(data.charts.activity_trend),
    renderSourceChart(data.charts.agent_activity)
  ].filter((card) => card.length > 0);
  if (cards.length === 0) return "";
  return `<section class="editorial-section" data-editorial-section="glance">
      <div class="editorial-section-heading"><div class="editorial-section-title">${i18n("At a Glance", "一眼概览")}</div><p>${i18n("How your memory breaks down", "记忆的构成一览")}</p></div>
      <div class="glance-grid">${cards.join("")}</div>
    </section>`;
}

export function renderMemorySearch(data: DashboardData): string {
  const entries = buildMemorySearchEntries(data);
  if (entries.length === 0) {
    return `<div class="memory-search"><p class="memory-search-empty" data-i18n-en="Nothing has been saved yet. Saved memories will be searchable here." data-i18n-zh="还没有保存任何内容。保存的记忆会在这里可搜索。">Nothing has been saved yet. Saved memories will be searchable here.</p></div>`;
  }
  const countLabel = (n: number) => ({ en: `${n} ${n === 1 ? "memory" : "memories"}`, zh: `${n} 条记忆` });
  const total = countLabel(entries.length);
  const results = entries.map((entry) => `
        <button type="button" class="memory-result" data-memory-result data-search-text="${escapeHtml(entry.search_text)}" data-kind="${escapeHtml(entry.kind)}" data-drawer-target="${escapeHtml(entry.drawer_id)}" aria-haspopup="dialog">
          <span class="memory-result-title" data-i18n-en="${escapeHtml(entry.title_en)}" data-i18n-zh="${escapeHtml(entry.title_zh)}">${escapeHtml(entry.title_en)}</span>
          <span class="memory-result-meta" data-i18n-en="${escapeHtml(entry.meta_en)}" data-i18n-zh="${escapeHtml(entry.meta_zh)}">${escapeHtml(entry.meta_en)}</span>
        </button>`).join("");
  const kindOrder: DashboardRecordSummary["kind"][] = ["memory", "skill", "soul", "session_summary", "agent_note"];
  const kindCounts = new Map<string, number>();
  for (const entry of entries) kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1);
  const presentKinds = kindOrder.filter((kind) => (kindCounts.get(kind) ?? 0) > 0);
  const allChip = `<button type="button" class="memory-chip" data-memory-chip data-chip-kind="all" aria-pressed="true"><span data-i18n-en="All" data-i18n-zh="全部">All</span><span class="memory-chip-count">${entries.length}</span></button>`;
  const kindChips = presentKinds.map((kind) => {
    const label = memoryKindLabel(kind);
    return `<button type="button" class="memory-chip" data-memory-chip data-chip-kind="${escapeHtml(kind)}" aria-pressed="false"><span data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</span><span class="memory-chip-count">${kindCounts.get(kind) ?? 0}</span></button>`;
  }).join("");
  return `
    <div class="memory-search" data-memory-search>
      <div class="memory-search-field">
        <input type="search" data-memory-search-input placeholder="Search saved memories" aria-label="Search saved memories" data-i18n-placeholder-en="Search saved memories" data-i18n-placeholder-zh="搜索已保存的记忆" data-i18n-aria-label-en="Search saved memories" data-i18n-aria-label-zh="搜索已保存的记忆">
      </div>
      <div class="memory-chips" data-memory-chips>${allChip}${kindChips}</div>
      <p class="memory-search-count" data-memory-search-count role="status" aria-live="polite" data-total="${entries.length}" data-i18n-en="${escapeHtml(total.en)}" data-i18n-zh="${escapeHtml(total.zh)}">${escapeHtml(total.en)}</p>
      <div class="ms-results" data-memory-search-results>${results}</div>
      <p class="memory-search-empty" data-memory-search-noresults hidden role="status" aria-live="polite" data-i18n-en="No memories match your search." data-i18n-zh="没有匹配的记忆。">No memories match your search.</p>
    </div>`;
}

function renderDrawer(drawers: DashboardDrawerItem[]): string {
  return `<div data-dashboard-drawer hidden>
    <aside class="editorial-drawer-panel" role="dialog" aria-modal="true" aria-label="Details" tabindex="-1">
      <div class="editorial-drawer-head"><div class="editorial-section-title">${i18n("Read-only details", "只读详情")}</div><button type="button" class="editorial-drawer-close" data-dashboard-drawer-close data-i18n-en="Close details" data-i18n-zh="关闭详情">Close details</button></div>
      ${drawers.map((drawer) => `<section data-drawer-payload="${escapeHtml(drawer.id)}" hidden>
        <div class="editorial-eyebrow">${i18n(drawer.kind, drawer.kind === "context" ? "上下文" : drawer.kind === "memory" ? "记忆" : drawer.kind === "event" ? "事件" : "重要内容")}</div>
        <h2 class="editorial-drawer-title" data-i18n-en="${escapeHtml(drawer.title_en)}" data-i18n-zh="${escapeHtml(drawer.title_zh)}">${escapeHtml(drawer.title_en)}</h2>
        <p class="editorial-drawer-summary" data-i18n-en="${escapeHtml(drawer.summary_en)}" data-i18n-zh="${escapeHtml(drawer.summary_zh)}">${escapeHtml(drawer.summary_en)}</p>
        ${drawer.body_en ? `<div class="editorial-drawer-body" data-i18n-en="${escapeHtml(drawer.body_en)}" data-i18n-zh="${escapeHtml(drawer.body_zh ?? drawer.body_en)}">${escapeHtml(drawer.body_en)}</div>` : ""}
        ${drawer.truncated ? `<p class="editorial-drawer-truncated" data-i18n-en="Content truncated — open the full memory below." data-i18n-zh="内容已截断 —— 可在下方查看完整记忆。">Content truncated — open the full memory below.</p>` : ""}
        ${(drawer.github_url || drawer.recall_command || drawer.store_path) ? `<div class="editorial-drawer-source">
          <div class="editorial-section-title">${i18n("View full memory", "查看完整记忆")}</div>
          ${drawer.github_url ? `<a class="editorial-drawer-link" href="${escapeHtml(drawer.github_url)}" target="_blank" rel="noopener noreferrer" data-i18n-en="Open on GitHub" data-i18n-zh="在 GitHub 打开">Open on GitHub</a><small class="editorial-drawer-hint" data-i18n-en="If newly saved, it may need a sync first." data-i18n-zh="若为新记忆，可能需要先同步。">If newly saved, it may need a sync first.</small>` : ""}
          ${drawer.recall_command ? `<div class="editorial-drawer-cmd"><span data-i18n-en="Or via CLI" data-i18n-zh="或通过 CLI">Or via CLI</span><code lang="en">${escapeHtml(drawer.recall_command)}</code></div>` : ""}
          ${drawer.store_path ? `<div class="editorial-drawer-cmd"><span data-i18n-en="Local store" data-i18n-zh="本地存储">Local store</span><code lang="en">${escapeHtml(drawer.store_path)}</code></div>` : ""}
        </div>` : ""}
        <dl class="editorial-drawer-meta">${drawer.metadata.map((item) => `<div><dt data-i18n-en="${escapeHtml(item.label_en)}" data-i18n-zh="${escapeHtml(item.label_zh)}">${escapeHtml(item.label_en)}</dt><dd data-i18n-en="${escapeHtml(item.value_en)}" data-i18n-zh="${escapeHtml(item.value_zh ?? item.value_en)}">${escapeHtml(item.value_en)}</dd></div>`).join("")}</dl>
        <div class="editorial-drawer-evidence"><div class="editorial-section-title">${i18n("Evidence", "证据")}</div><p>${drawer.evidence_html}</p></div>
      </section>`).join("")}
    </aside>
  </div>`;
}

export function renderDashboardWorkspace(data: DashboardData, fragments: DashboardWorkspaceFragments): string {
  const model = buildDashboardWorkspaceModel(data);
  const compaction = `${Math.round(model.memory.compaction_ratio * 100)}%`;
  return `<div data-dashboard-editorial-shell>
    <header class="editorial-header">
      <div class="editorial-brand">Moryn</div>
      <nav class="editorial-navigation" aria-label="Dashboard views">
        <button type="button" class="editorial-nav-button" data-dashboard-nav="workspace" aria-current="page">${i18n("Workspace", "工作区")}</button>
        <button type="button" class="editorial-nav-button" data-dashboard-nav="memory">${i18n("Memory", "记忆")}</button>
        <button type="button" class="editorial-nav-button" data-dashboard-nav="history">${i18n("History", "历史")}</button>
      </nav>
      <div class="editorial-header-status"><span class="editorial-sync">● ${i18n(model.sync_label_en, model.sync_label_zh)}</span><button type="button" class="editorial-refresh" data-dashboard-refresh-button><span data-i18n-en="Refresh" data-i18n-zh="刷新">Refresh</span></button>${fragments.language_toggle_html}</div>
    </header>
    <div class="editorial-shell-body">
      <section data-dashboard-view="workspace">
        <div class="editorial-layout">
          <article class="editorial-reading-column">
            <section data-editorial-section="current-context">
              <div class="editorial-eyebrow">${i18n("Current workspace / Moryn", "当前工作区 / Moryn")}</div>
              <button type="button" class="editorial-task-button" data-drawer-target="context-current" aria-haspopup="dialog"><h1 class="editorial-task">${escapeHtml(model.task)}</h1></button>
              <p class="editorial-lead">${i18n(contextSummary(data).en, contextSummary(data).zh)}</p>
              <div class="editorial-context-meta"><span>${escapeHtml(model.project)}</span><span>${escapeHtml(model.agent)}</span><span>${escapeHtml(model.device)}</span><time datetime="${escapeHtml(model.generated_at)}">${escapeHtml(model.generated_at)}</time></div>
              ${model.no_action_required ? `<div class="editorial-conclusion" data-editorial-conclusion="no-action-required"><div class="editorial-conclusion-mark">✓</div><div><strong>${i18n("No action required", "无需操作")}</strong><span>${i18n("Moryn is handling continuity in the background.", "Moryn 正在后台处理上下文连续性。")}</span></div></div>` : ""}
            </section>
            ${renderAttention(data.quiet_dashboard.attention_needed)}
            <section class="editorial-section" data-editorial-section="memory-state"><div class="editorial-section-heading"><div class="editorial-section-title">${i18n("Memory State", "记忆状态")}</div><p>${i18n("A bounded view of what agents can use now", "Agent 当前可用的有界记忆视图")}</p></div><div class="editorial-memory-grid">
              ${renderMetric("memory-active", "Active", "活跃记忆", model.memory.active)}
              ${renderMetric("memory-learned", "Learned", "已学习", model.memory.learned)}
              ${renderMetric("memory-conflicts", "Conflicts", "冲突", model.memory.conflicts)}
              ${renderMetric("memory-compaction", "Consolidated", "已收敛", compaction)}
            </div></section>
            ${renderGlance(data)}
            <section class="editorial-section" data-editorial-section="what-changed"><div class="editorial-section-heading"><div class="editorial-section-title">${i18n("What Changed", "近期变化")}</div><p>${i18n("The latest meaningful local events", "最新的重要本地事件")}</p></div>${renderEvents(model.recent_events)}</section>
          </article>
          ${renderImportant(model.important_records, model)}
        </div>
      </section>
      <section class="editorial-view-page" data-dashboard-view="memory" hidden><header><div class="editorial-eyebrow">${i18n("Knowledge library", "知识库")}</div><h1>${i18n("Memory", "记忆")}</h1><p>${i18n("Search what Moryn has saved, then open any item to read it in full. Nothing is written here.", "搜索 Moryn 保存的内容，点开任意一条即可查看全文。此处不会写入。")}</p></header>${fragments.memory_html}</section>
      <section class="editorial-view-page" data-dashboard-view="history" hidden><header><div class="editorial-eyebrow">${i18n("Recent activity", "近期动态")}</div><h1>${i18n("History", "历史")}</h1><p>${i18n("A plain-language record of what has happened, newest first.", "用日常语言记录发生过的事，最新在前。")}</p></header>${fragments.history_html}</section>
    </div>
    ${renderDrawer(model.drawers)}
  </div>`;
}
