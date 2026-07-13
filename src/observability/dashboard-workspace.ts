import type {
  DashboardAttentionItem,
  DashboardData,
  DashboardEventSummary,
  DashboardRecordSummary
} from "./dashboard.js";

export interface DashboardWorkspaceFragments {
  memory_html: string;
  history_html: string;
  audit_html: string;
  language_toggle_html: string;
}

export interface DashboardDrawerItem {
  id: string;
  kind: "context" | "memory" | "event" | "important";
  title: string;
  summary: string;
  metadata: Array<{ label_en: string; label_zh: string; value: string }>;
  evidence_html: string;
}

export interface DashboardWorkspaceModel {
  task: string;
  project: string;
  agent: string;
  device: string;
  generated_at: string;
  no_action_required: boolean;
  sync_label: string;
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

function eventLabel(event: DashboardEventSummary): string {
  return event.op.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function syncLabel(data: DashboardData): string {
  if (!data.sync.configured) return "Local only";
  if (data.sync.sync_state === "clean") return "Shared copy is current";
  if (data.sync.sync_state === "conflict") return "Shared copy needs review";
  if (data.sync.sync_state === "dirty") return "Local changes are protected";
  return "Shared copy configured";
}

function contextSummary(data: DashboardData): string {
  const context = data.quiet_dashboard.current_context;
  if (!context.task) return "Moryn is ready. No active task is currently recorded.";
  if (context.checkpoint_available && context.handoff_available) return "The active task has both checkpoint and handoff protection.";
  if (context.checkpoint_available) return "The active task is protected by a recent checkpoint.";
  if (context.handoff_available) return "The active task has a recoverable handoff.";
  return "The active task is visible, but no checkpoint or handoff is currently available.";
}

function metricDrawer(id: string, title: string, value: number | string, summary: string, data: DashboardData): DashboardDrawerItem {
  return {
    id,
    kind: "memory",
    title,
    summary,
    metadata: [
      { label_en: "Value", label_zh: "数值", value: String(value) },
      { label_en: "Generated", label_zh: "生成时间", value: data.generated_at },
      { label_en: "Source", label_zh: "数据来源", value: "DashboardData.quiet_dashboard.memory_flow" }
    ],
    evidence_html: `<code>${escapeHtml(data.store.path)}</code>`
  };
}

function buildDrawerItems(data: DashboardData, task: string, project: string, agent: string, device: string, importantRecords: DashboardRecordSummary[]): DashboardDrawerItem[] {
  const context = data.quiet_dashboard.current_context;
  const flow = data.quiet_dashboard.memory_flow;
  const items: DashboardDrawerItem[] = [{
    id: "context-current",
    kind: "context",
    title: task,
    summary: contextSummary(data),
    metadata: [
      { label_en: "Project", label_zh: "项目", value: project },
      { label_en: "Agent", label_zh: "Agent", value: agent },
      { label_en: "Device", label_zh: "设备", value: device },
      { label_en: "Updated", label_zh: "更新时间", value: data.generated_at },
      { label_en: "Checkpoint", label_zh: "检查点", value: context.checkpoint_available ? "Available" : "Not available" },
      { label_en: "Handoff", label_zh: "交接", value: context.handoff_available ? "Available" : "Not available" }
    ],
    evidence_html: [context.checkpoint_record_id, context.handoff_record_id].filter(Boolean).map((id) => `<code>${escapeHtml(id)}</code>`).join(" ") || i18n("No record id available", "暂无记录 ID")
  }];

  items.push(
    metricDrawer("memory-active", "Active knowledge", flow.active_working_set_records, "The bounded working set currently available for agent context.", data),
    metricDrawer("memory-learned", "Learned conclusions", flow.learned_records, "Reusable conclusions learned and retained by Moryn.", data),
    metricDrawer("memory-conflicts", "Material conflicts", flow.conflict_records, "Conflicting active memories preserved for explicit resolution.", data),
    metricDrawer("memory-compaction", "Consolidation", `${Math.round(flow.compaction_ratio * 100)}%`, "The share of logical memory hidden from the active working set through revision, supersession, or duplicate consolidation.", data)
  );

  for (const event of data.recent_events.slice(0, 5)) {
    items.push({
      id: `event-${safeDomId(event.event_id)}`,
      kind: "event",
      title: eventLabel(event),
      summary: event.record_id ? `This event affected record ${event.record_id}.` : "This event is part of the recent local audit history.",
      metadata: [
        { label_en: "Operation", label_zh: "操作", value: event.op },
        { label_en: "Source", label_zh: "来源", value: sourceLabel(event.source) },
        { label_en: "Created", label_zh: "创建时间", value: event.created_at },
        { label_en: "Event id", label_zh: "事件 ID", value: event.event_id }
      ],
      evidence_html: `<code>${escapeHtml(event.citation.timeline_command)}</code>${event.citation.recall_command ? ` <code>${escapeHtml(event.citation.recall_command)}</code>` : ""}`
    });
  }

  for (const record of importantRecords) {
    items.push({
      id: `record-${safeDomId(record.id)}`,
      kind: "important",
      title: record.text || `${record.kind} · ${record.type}`,
      summary: `A ${record.state} ${record.kind} from ${sourceLabel(record.source)}.`,
      metadata: [
        { label_en: "Kind", label_zh: "类别", value: record.kind },
        { label_en: "Type", label_zh: "类型", value: record.type },
        { label_en: "State", label_zh: "状态", value: record.state },
        { label_en: "Updated", label_zh: "更新时间", value: record.updated_at },
        { label_en: "Record id", label_zh: "记录 ID", value: record.id }
      ],
      evidence_html: `<code>${escapeHtml(record.citation.timeline_command)}</code> <code>${escapeHtml(record.citation.recall_command)}</code>`
    });
  }

  return items;
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
  return {
    task,
    project,
    agent,
    device,
    generated_at: data.generated_at,
    no_action_required: data.quiet_dashboard.attention_needed.length === 0,
    sync_label: syncLabel(data),
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
  return `<div class="editorial-event-list">${events.map((event) => `<button type="button" class="editorial-event" data-drawer-target="event-${escapeHtml(safeDomId(event.event_id))}" aria-haspopup="dialog">
    <time datetime="${escapeHtml(event.created_at)}">${escapeHtml(event.created_at.slice(11, 16))}</time>
    <strong>${escapeHtml(eventLabel(event))}</strong>
    <small>${escapeHtml(sourceLabel(event.source))}</small>
  </button>`).join("")}</div>`;
}

function renderImportant(records: DashboardRecordSummary[], model: DashboardWorkspaceModel): string {
  const recordItems = records.map((record) => `<button type="button" class="editorial-important" data-drawer-target="record-${escapeHtml(safeDomId(record.id))}" aria-haspopup="dialog"><strong>${escapeHtml(record.text || `${record.kind} · ${record.type}`)}</strong><p>${escapeHtml(record.state)} · ${escapeHtml(sourceLabel(record.source))}</p></button>`).join("");
  return `<aside class="editorial-sidebar" data-editorial-sidebar="important-now">
    <div class="editorial-sidebar-heading"><div class="editorial-section-title">${i18n("Important Now", "当前重要内容")}</div></div>
    <button type="button" class="editorial-important" data-drawer-target="context-current" aria-haspopup="dialog"><strong>${escapeHtml(model.task)}</strong><p>${i18n("Current task · continuity protected", "当前任务 · 连续性已保护")}</p></button>
    ${recordItems || `<p>${i18n("No additional important items", "暂无其他重要内容")}</p>`}
    <div class="editorial-sync-card"><span>● </span>${i18n(model.sync_label, model.sync_label === "Shared copy is current" ? "共享副本已同步" : "同步状态已记录")}</div>
  </aside>`;
}

function renderDrawer(drawers: DashboardDrawerItem[]): string {
  return `<div data-dashboard-drawer hidden>
    <aside class="editorial-drawer-panel" role="dialog" aria-modal="true" aria-label="Details" tabindex="-1">
      <div class="editorial-drawer-head"><div class="editorial-section-title">${i18n("Read-only details", "只读详情")}</div><button type="button" class="editorial-drawer-close" data-dashboard-drawer-close data-i18n-en="Close details" data-i18n-zh="关闭详情">Close details</button></div>
      ${drawers.map((drawer) => `<section data-drawer-payload="${escapeHtml(drawer.id)}" hidden>
        <div class="editorial-eyebrow">${escapeHtml(drawer.kind)}</div>
        <h2 class="editorial-drawer-title">${escapeHtml(drawer.title)}</h2>
        <p class="editorial-drawer-summary">${escapeHtml(drawer.summary)}</p>
        <dl class="editorial-drawer-meta">${drawer.metadata.map((item) => `<div><dt data-i18n-en="${escapeHtml(item.label_en)}" data-i18n-zh="${escapeHtml(item.label_zh)}">${escapeHtml(item.label_en)}</dt><dd>${escapeHtml(item.value)}</dd></div>`).join("")}</dl>
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
      <div class="editorial-header-status"><span class="editorial-sync">● ${escapeHtml(model.sync_label)}</span>${fragments.language_toggle_html}</div>
    </header>
    <div class="editorial-shell-body">
      <section data-dashboard-view="workspace">
        <div class="editorial-layout">
          <article class="editorial-reading-column">
            <section data-editorial-section="current-context">
              <div class="editorial-eyebrow">${i18n("Current workspace / Moryn", "当前工作区 / Moryn")}</div>
              <button type="button" class="editorial-task-button" data-drawer-target="context-current" aria-haspopup="dialog"><h1 class="editorial-task">${escapeHtml(model.task)}</h1></button>
              <p class="editorial-lead">${escapeHtml(contextSummary(data))}</p>
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
            <section class="editorial-section" data-editorial-section="what-changed"><div class="editorial-section-heading"><div class="editorial-section-title">${i18n("What Changed", "近期变化")}</div><p>${i18n("The latest meaningful local events", "最新的重要本地事件")}</p></div>${renderEvents(model.recent_events)}</section>
          </article>
          ${renderImportant(model.important_records, model)}
        </div>
      </section>
      <section class="editorial-view-page" data-dashboard-view="memory" hidden><header><div class="editorial-eyebrow">${i18n("Knowledge library", "知识库")}</div><h1>${i18n("Memory", "记忆")}</h1><p>${i18n("Search and read what Moryn has saved. This view remains read-only.", "搜索并阅读 Moryn 保存的内容。此视图保持只读。")}</p></header><div class="editorial-compatibility">${fragments.memory_html}</div></section>
      <section class="editorial-view-page" data-dashboard-view="history" hidden><header><div class="editorial-eyebrow">${i18n("Audit history", "审计历史")}</div><h1>${i18n("History", "历史")}</h1><p>${i18n("Recent events, evidence, diagnostics, and traceability.", "近期事件、证据、诊断与追踪信息。")}</p></header><div class="editorial-compatibility">${fragments.history_html}</div></section>
      <div class="editorial-audit">${fragments.audit_html}</div>
    </div>
    ${renderDrawer(model.drawers)}
  </div>`;
}
