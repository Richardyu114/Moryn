import type {
  DashboardAction,
  DashboardActivityTrendChart,
  DashboardAgentChartItem,
  DashboardAttentionItem,
  DashboardData,
  DashboardDecisionSummaryItem,
  DashboardEventSummary,
  DashboardMemoryStateChartItem,
  DashboardRecordSummary,
  DashboardRecordTypeChartItem
} from "./dashboard.js";
import { dashboardRecordTitleLabel, memoryKindLabel, memoryStateLabelFromRecordState } from "./dashboard.js";
import { dashboardDrawerId } from "./dashboard-drawer-id.js";
import type { DashboardMaintenanceData, DashboardMaintenancePlan } from "./dashboard-maintenance.js";
import { renderedPlanSourceRecords, renderMemoryMaintenance, renderSoulStudio } from "./dashboard-v04-workspace.js";

export interface DashboardWorkspaceFragments {
  memory_html: string;
  memory_records: readonly DashboardRecordSummary[];
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
  body_label_en?: string;
  body_label_zh?: string;
  body_en?: string;
  body_zh?: string;
  truncated?: boolean;
  sections?: Array<{
    label_en: string;
    label_zh: string;
    body_en: string;
    body_zh?: string;
    truncated?: boolean;
  }>;
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
    saved: number;
    current: number;
    history: number;
    quarantined: number;
    learned: number;
    pending_learning: number;
    conflicts: number;
    organized: number;
    organization_groups: number;
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

function i18n(en: string, zh: string, tag = "span"): string {
  return `<${tag} data-i18n-en="${escapeHtml(en)}" data-i18n-zh="${escapeHtml(zh)}">${escapeHtml(en)}</${tag}>`;
}

function sourceLabel(source: DashboardEventSummary["source"] | DashboardRecordSummary["source"]): string {
  if (source.client === "protected-history") return "protected source";
  const parts = [source.client, source.device_id, source.session_id].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return parts.join(" · ") || "unknown";
}

function readableSource(source: DashboardRecordSummary["source"]): { en: string; zh: string } {
  const client = source.client.trim();
  const normalized = client.toLowerCase();
  if (normalized === "codex") return { en: "Codex", zh: "Codex" };
  if (normalized === "claude") return { en: "Claude", zh: "Claude" };
  if (normalized === "user") return { en: "you", zh: "用户" };
  if (normalized === "moryn" || normalized === "moryn-local") return { en: "Moryn", zh: "Moryn" };
  if (normalized === "protected-history") return { en: "a protected source", zh: "受保护来源" };
  return { en: client || "unknown source", zh: client || "未知来源" };
}

function eventLabel(event: DashboardEventSummary): { en: string; zh: string } {
  const copyByOp: Partial<Record<DashboardEventSummary["op"], { en: string; zh: string }>> = {
    upsert_record: { en: "Saved a memory", zh: "保存了一条记忆" },
    promote_record: { en: "Confirmed a memory", zh: "确认了一条记忆" },
    revise_record: { en: "Updated a memory", zh: "更新了一条记忆" },
    archive_record: { en: "Archived a memory", zh: "归档了一条记忆" },
    quarantine_record: { en: "Set a memory aside", zh: "将一条记忆搁置待查" },
    link_records: { en: "Linked related memories", zh: "关联了相关记忆" }
  };
  return (
    copyByOp[event.op] ?? {
      en: event.op.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      zh: event.op
    }
  );
}

function eventChangeLabel(field: DashboardEventSummary["changes"][number]["field"]): {
  en: string;
  zh: string;
} {
  const labels: Record<DashboardEventSummary["changes"][number]["field"], { en: string; zh: string }> = {
    content: { en: "Content saved in this change", zh: "这次变更保存的内容" },
    category: { en: "Memory category", zh: "记忆类别" },
    labels: { en: "Labels", zh: "标签" },
    confidence: { en: "Confidence", zh: "可信度" },
    priority: { en: "Priority", zh: "优先级" },
    project: { en: "Project", zh: "项目" },
    other: { en: "Other memory settings changed", zh: "其他记忆设置发生了变化" }
  };
  return labels[field];
}

function eventStateCopy(state: DashboardEventSummary["target_state"]): { en: string; zh: string } | undefined {
  if (!state) return undefined;
  return memoryStateLabelFromRecordState(state);
}

function linkTypeCopy(linkType: string | undefined): { en: string; zh: string } {
  const relations: Record<string, { en: string; zh: string }> = {
    duplicate_of: { en: "These memories describe the same thing.", zh: "这两条记忆描述的是同一件事。" },
    revises: { en: "The first memory updates the related memory.", zh: "第一条记忆是对另一条记忆的更新。" },
    supersedes: { en: "The first memory replaces the related memory.", zh: "第一条记忆替代了另一条记忆。" },
    supports: {
      en: "The first memory provides support for the related memory.",
      zh: "第一条记忆为另一条记忆提供依据。"
    },
    conflicts_with: { en: "These memories may disagree and need review.", zh: "这两条记忆可能存在分歧，需要检查。" }
  };
  return (
    (linkType ? relations[linkType] : undefined) ?? {
      en: `Moryn marked these memories as related${linkType ? ` (${linkType.replace(/_/g, " ")})` : ""}.`,
      zh: `Moryn 将这两条记忆标记为相关${linkType ? `（${linkType.replace(/_/g, " ")}）` : ""}。`
    }
  );
}

function recentEventLine(event: DashboardEventSummary): { en: string; zh: string } {
  const label = eventLabel(event);
  const detailsEn: string[] = [];
  const detailsZh: string[] = [];
  for (const change of event.changes.slice(0, 3)) {
    const field = eventChangeLabel(change.field);
    const value = change.value ? clip(change.value, 320) : undefined;
    detailsEn.push(value ? `${field.en}: ${value}` : field.en);
    detailsZh.push(value ? `${field.zh}：${value}` : field.zh);
  }
  const state = eventStateCopy(event.target_state);
  if (state) {
    detailsEn.push(`Result: ${state.en}`);
    detailsZh.push(`结果：${state.zh}`);
  }
  if (event.reason) {
    detailsEn.push(`Why: ${clip(event.reason.value, 240)}`);
    detailsZh.push(`原因：${clip(event.reason.value, 240)}`);
  }
  const date = event.created_at.replace("T", " ").slice(0, 19);
  return {
    en: `${date} — ${label.en}${detailsEn.length ? `\n${detailsEn.join("\n")}` : ""}`,
    zh: `${date} — ${label.zh}${detailsZh.length ? `\n${detailsZh.join("\n")}` : ""}`
  };
}

function syncLabel(data: DashboardData): { en: string; zh: string } {
  const assurance = data.sync_assurance;
  if (assurance.state === "local_pending") {
    const count = assurance.local_pending.event_files;
    return count > 0
      ? { en: `${count} saved changes waiting to sync`, zh: `${count} 项保存变更等待同步` }
      : { en: "Saved changes waiting to sync", zh: "保存变更等待同步" };
  }
  if (assurance.state === "remote_current") return { en: "Shared copy is current", zh: "共享副本已同步" };
  if (assurance.state === "conflict") return { en: "Shared copy needs repair", zh: "共享副本需要修复" };
  if (assurance.state === "local_only") return { en: "Saved on this device only", zh: "仅保存在本机" };
  if (assurance.state === "remote_updates_pending")
    return { en: "New shared updates are waiting", zh: "共享副本有新更新待接收" };
  return { en: "Shared copy not verified", zh: "共享副本尚未验证" };
}

function renderSyncAssurance(data: DashboardData): string {
  const assurance = data.sync_assurance;
  if (assurance.state === "remote_current") return "";
  const pending = assurance.local_pending;
  const proof =
    assurance.state === "local_only"
      ? { en: "No shared copy is connected", zh: "尚未连接共享副本" }
      : assurance.remote_copy.durable
        ? {
            en: assurance.remote_copy.covers_all_local_content
              ? "Remote proof covers all local content"
              : "Remote proof covers the previous committed version only",
            zh: assurance.remote_copy.covers_all_local_content
              ? "远端保存证明覆盖本机全部内容"
              : "远端保存证明仅覆盖上一次已提交版本"
          }
        : { en: "No current remote durability proof", zh: "当前没有远端保存证明" };
  const age = pending.age_label
    ? `<div><dt>${i18n("Oldest pending file change", "最早待同步文件变更")}</dt><dd>${i18n(`${pending.age_label} ago`, `${pending.age_label_zh ?? pending.age_label}前`)}</dd></div>`
    : "";
  const suggestedCommand =
    assurance.technical.suggested_command ??
    (assurance.state === "local_only" ? "moryn sync init <remote>" : undefined);
  const command = suggestedCommand
    ? `<div><dt>${i18n("Setup or diagnostic command", "设置或诊断命令")}</dt><dd><code>${escapeHtml(suggestedCommand)}</code></dd></div>`
    : "";
  const position = {
    en: `${assurance.technical.ahead} local updates ahead · ${assurance.technical.behind} shared updates waiting`,
    zh: `本机领先 ${assurance.technical.ahead} 个更新 · 共享副本有 ${assurance.technical.behind} 个更新待接收`
  };
  return `<section class="editorial-sync-assurance${assurance.attention_required ? " attention" : ""}" data-sync-assurance="${escapeHtml(assurance.state)}">
    <div class="editorial-sync-assurance-mark" aria-hidden="true">${assurance.attention_required ? "!" : assurance.state === "remote_unverified" ? "?" : "↑"}</div>
    <div class="editorial-sync-assurance-copy">
      <strong>${i18n(assurance.headline, assurance.headline_zh)}</strong>
      <p>${i18n(assurance.detail, assurance.detail_zh)}</p>
      <details class="editorial-sync-technical">
        <summary>${i18n("Technical details", "技术详情")}</summary>
        <dl>
          <div><dt>${i18n("Remote durability", "远端保存状态")}</dt><dd>${i18n(proof.en, proof.zh)}</dd></div>
          <div><dt>${i18n("Memory event files", "记忆事件文件")}</dt><dd>${pending.event_files}</dd></div>
          <div><dt>${i18n("Untracked / added / modified / ignored", "未跟踪 / 新增 / 已修改 / 已忽略")}</dt><dd>${pending.untracked_event_files} / ${pending.added_event_files} / ${pending.modified_event_files} / ${pending.ignored_event_files}</dd></div>
          ${age}
          <div><dt>${i18n("Local / shared position", "本机 / 共享位置")}</dt><dd>${i18n(position.en, position.zh)}</dd></div>
          ${command}
        </dl>
      </details>
    </div>
  </section>`;
}

function contextSummary(data: DashboardData): { en: string; zh: string } {
  const context = data.quiet_dashboard.current_context;
  if (!context.task)
    return {
      en: "Moryn is ready. No active task is currently recorded.",
      zh: "Moryn 已就绪，目前没有记录中的活跃任务。"
    };
  if (context.checkpoint_available && context.handoff_available)
    return {
      en: "The latest progress and work summary are saved, so this task is ready to continue.",
      zh: "当前工作的最新进度和总结都已保存，可随时继续。"
    };
  if (context.checkpoint_available)
    return {
      en: "The latest progress is saved, so this task is ready to continue.",
      zh: "当前工作的最新进度已保存，可随时继续。"
    };
  if (context.handoff_available)
    return {
      en: "The previous work summary is saved, so this task is ready to continue.",
      zh: "上一段工作的总结已保存，可随时继续。"
    };
  return {
    en: "The current task is recorded, but its latest progress has not been saved yet.",
    zh: "当前任务已记录，但最新进度尚未保存。"
  };
}

function metricDrawer(
  id: string,
  titleEn: string,
  titleZh: string,
  value: number | string,
  summaryEn: string,
  summaryZh: string,
  data: DashboardData,
  content: Pick<DashboardDrawerItem, "body_label_en" | "body_label_zh" | "body_en" | "body_zh" | "sections"> = {}
): DashboardDrawerItem {
  return {
    id,
    kind: "memory",
    title_en: titleEn,
    title_zh: titleZh,
    summary_en: summaryEn,
    summary_zh: summaryZh,
    ...content,
    metadata: [
      { label_en: "Value", label_zh: "数值", value_en: String(value) },
      { label_en: "Generated", label_zh: "生成时间", value_en: data.generated_at },
      { label_en: "Source", label_zh: "数据来源", value_en: "DashboardData.memory_status" }
    ],
    evidence_html: `<code>${escapeHtml(data.store.path)}</code>`
  };
}

function buildDrawerItems(
  data: DashboardData,
  task: string,
  project: string,
  agent: string,
  device: string,
  importantRecords: DashboardRecordSummary[],
  memoryRecords: readonly DashboardRecordSummary[]
): DashboardDrawerItem[] {
  const context = data.quiet_dashboard.current_context;
  const contextCopy = contextSummary(data);
  const githubBase = githubBaseFromRemote(data.sync.remote, data.sync.branch);
  const storePath = data.store.path;
  const BODY_LIMIT = 4000;
  const items: DashboardDrawerItem[] = [
    {
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
        {
          label_en: "Checkpoint",
          label_zh: "检查点",
          value_en: context.checkpoint_available ? "Available" : "Not available",
          value_zh: context.checkpoint_available ? "可用" : "不可用"
        },
        {
          label_en: "Handoff",
          label_zh: "交接",
          value_en: context.handoff_available ? "Available" : "Not available",
          value_zh: context.handoff_available ? "可用" : "不可用"
        }
      ],
      evidence_html:
        [context.checkpoint_record_id, context.handoff_record_id]
          .filter(Boolean)
          .map((id) => `<code>${escapeHtml(id)}</code>`)
          .join(" ") || i18n("No record id available", "暂无记录 ID")
    }
  ];

  const currentSections: NonNullable<DashboardDrawerItem["sections"]> = data.memory_status.recent_current_records
    .slice(0, 10)
    .map((record) => {
      const kind = memoryKindLabel(record.kind);
      const state = memoryStateLabelFromRecordState(record.state);
      return {
        label_en: `${state.en} · ${kind.en}`,
        label_zh: `${state.zh} · ${kind.zh}`,
        body_en: clip(record.text, BODY_LIMIT),
        body_zh: clip(record.text, BODY_LIMIT),
        truncated: record.text.length > BODY_LIMIT
      };
    });
  const learnedSections: NonNullable<DashboardDrawerItem["sections"]> = [
    ...data.memory_status.learning.absorbed_records.map((record) => {
      const ready = record.state === "canonical";
      return {
        label_en: ready ? "Learned conclusion · ready to use" : "Learned conclusion · checked when used",
        label_zh: ready ? "已吸收结论 · 可直接使用" : "已吸收结论 · 使用时会核对",
        body_en: clip(record.text, BODY_LIMIT),
        body_zh: clip(record.text, BODY_LIMIT),
        truncated: record.text.length > BODY_LIMIT
      };
    }),
    ...data.memory_status.learning.pending_records.map((record) => {
      const text = record.text.replace(/^Pending learning:\s*/i, "");
      return {
        label_en: "New finding · being absorbed automatically",
        label_zh: "新发现 · 正在自动吸收",
        body_en: clip(text, BODY_LIMIT),
        body_zh: clip(text, BODY_LIMIT),
        truncated: text.length > BODY_LIMIT
      };
    })
  ];
  const conflictSections: NonNullable<DashboardDrawerItem["sections"]> = data.memory_status.conflict_records.map(
    (record) => ({
      label_en: "Content kept for a careful decision",
      label_zh: "等待谨慎判断的内容",
      body_en: clip(record.text, BODY_LIMIT),
      body_zh: clip(record.text, BODY_LIMIT),
      truncated: record.text.length > BODY_LIMIT
    })
  );
  const organizationSections: NonNullable<DashboardDrawerItem["sections"]> =
    data.memory_status.organization.groups.flatMap((group) => [
      {
        label_en: "Current conclusion",
        label_zh: "当前结论",
        body_en: clip(group.current.text, BODY_LIMIT),
        body_zh: clip(group.current.text, BODY_LIMIT),
        truncated: group.current.text.length > BODY_LIMIT
      },
      ...group.older.map(({ record, relationship }) => {
        const relation =
          relationship === "duplicate_of"
            ? { en: "Matching older copy · kept in history", zh: "内容相同的旧副本 · 原文保留在历史中" }
            : relationship === "supersedes"
              ? { en: "Older conclusion · replaced by the current one", zh: "较早结论 · 已由当前结论替代" }
              : { en: "Older wording · corrected by the current one", zh: "较早表述 · 已由当前结论修正" };
        return {
          label_en: relation.en,
          label_zh: relation.zh,
          body_en: clip(record.text, BODY_LIMIT),
          body_zh: clip(record.text, BODY_LIMIT),
          truncated: record.text.length > BODY_LIMIT
        };
      })
    ]);

  items.push(
    metricDrawer(
      "memory-active",
      "Current usable content",
      "当前可用内容",
      data.memory_status.summary.current_total,
      `${data.memory_status.summary.current_total} of ${data.memory_status.summary.saved_total} saved items are current and not set aside as history or review material.`,
      `共保存 ${data.memory_status.summary.saved_total} 条，其中 ${data.memory_status.summary.current_total} 条处于当前可用状态；历史与待查内容不计入。`,
      data,
      {
        body_label_en: "What is usable now",
        body_label_zh: "当前可用的具体内容",
        body_en: currentSections.length
          ? "The newest items are shown below. Open Memory to browse and search the complete library."
          : "No saved content is currently available for use.",
        body_zh: currentSections.length
          ? "下面展示最近的具体内容；可前往“记忆”浏览和搜索完整知识库。"
          : "目前没有处于可用状态的保存内容。",
        sections: currentSections
      }
    ),
    metricDrawer(
      "memory-learned",
      "Absorbed conclusions",
      "已吸收结论",
      data.memory_status.learning.absorbed_total,
      `${data.memory_status.learning.absorbed_total} reusable conclusions have been absorbed. ${data.memory_status.learning.pending_total} new findings are being processed automatically.`,
      `已吸收 ${data.memory_status.learning.absorbed_total} 条可复用结论；另有 ${data.memory_status.learning.pending_total} 条新发现正在自动处理。`,
      data,
      {
        body_label_en: "What Moryn learned",
        body_label_zh: "Moryn 学到了什么",
        body_en:
          data.memory_status.learning.pending_total > 0
            ? "Pending findings are absorbed during the next progress-save cycle. You do not need to manage them."
            : "There are no pending findings. You do not need to manage this process.",
        body_zh:
          data.memory_status.learning.pending_total > 0
            ? "这些新发现会在下一次保存进度时自动吸收，你无需手动管理。"
            : "目前没有等待吸收的新发现，你无需管理这个过程。",
        sections: learnedSections
      }
    ),
    metricDrawer(
      "memory-conflicts",
      "Needs review",
      "存在分歧",
      data.memory_status.summary.conflict_total,
      "Memories that disagree and have been kept for a careful decision.",
      "内容有分歧的记忆会被保留，等待谨慎处理。",
      data,
      {
        body_label_en: "What needs attention",
        body_label_zh: "需要关注什么",
        body_en: conflictSections.length
          ? "The concrete statements are shown below; neither side is silently discarded."
          : "No conflicting saved statements need your attention.",
        body_zh: conflictSections.length
          ? "下面列出存在分歧的具体表述；Moryn 不会静默丢弃任何一方。"
          : "目前没有需要你关注的记忆分歧。",
        sections: conflictSections
      }
    ),
    metricDrawer(
      "memory-compaction",
      "Older versions tucked away",
      "已收起旧版本",
      data.memory_status.organization.hidden_total,
      `${data.memory_status.organization.hidden_total} older or matching versions were grouped under ${data.memory_status.organization.group_total} current conclusions. Original text is retained.`,
      `已将 ${data.memory_status.organization.hidden_total} 条较旧或相同版本归入 ${data.memory_status.organization.group_total} 条当前结论，所有原文仍然保留。`,
      data,
      {
        body_label_en: "What was organized",
        body_label_zh: "具体整理了什么",
        body_en: organizationSections.length
          ? "Current conclusions and their retained older versions are shown together below."
          : "No older or matching versions have been tucked away in this project.",
        body_zh: organizationSections.length
          ? "下面将当前结论与保留的旧版本放在一起展示。"
          : "当前项目还没有需要收起的旧版本或相同内容。",
        sections: organizationSections
      }
    )
  );

  for (const event of data.recent_events.slice(0, 12)) {
    const label = eventLabel(event);
    const eventSource = readableSource(event.source);
    const eventSourceDetail = sourceLabel(event.source);
    const relatedRecord = event.record_id
      ? data.all_records.find((record) => record.id === event.record_id)
      : undefined;
    const linkedRecord = event.linked_record_id
      ? data.all_records.find((record) => record.id === event.linked_record_id)
      : undefined;
    const state = eventStateCopy(event.target_state);
    const changeSections: NonNullable<DashboardDrawerItem["sections"]> = event.changes.map((change) => {
      const changeLabel = eventChangeLabel(change.field);
      return {
        label_en: changeLabel.en,
        label_zh: changeLabel.zh,
        body_en: change.value || "This setting was updated.",
        body_zh: change.value || "这项设置已更新。",
        truncated: change.truncated
      };
    });
    if (event.changes_truncated) {
      changeSections.push({
        label_en: "Additional changes",
        label_zh: "其他变更",
        body_en: "More changed fields are available in Advanced details.",
        body_zh: "更多变更内容可在“高级详情”中查看。"
      });
    }
    if (state) {
      changeSections.push({
        label_en: "Result of this change",
        label_zh: "这次变更的结果",
        body_en: `The memory became: ${state.en}.`,
        body_zh: `这条记忆变为：${state.zh}。`
      });
    }
    if (event.reason) {
      changeSections.push({
        label_en: "Why it changed",
        label_zh: "为什么发生这次变更",
        body_en: event.reason.value,
        body_zh: event.reason.value,
        truncated: event.reason.truncated
      });
    }
    if (event.op === "link_records") {
      const relation = linkTypeCopy(event.link_type);
      changeSections.push({
        label_en: "How the memories are related",
        label_zh: "两条记忆的关系",
        body_en: relation.en,
        body_zh: relation.zh
      });
    }
    const changedContent = event.changes.find((change) => change.field === "content");
    const currentContentAlreadyShown =
      relatedRecord && changedContent && !changedContent.truncated && changedContent.value === relatedRecord.text;
    if (relatedRecord && !currentContentAlreadyShown) {
      changeSections.push({
        label_en: event.op === "link_records" ? "First memory" : "Current content of the affected memory",
        label_zh: event.op === "link_records" ? "第一条记忆" : "受影响记忆的当前内容",
        body_en: clip(relatedRecord.text, BODY_LIMIT),
        body_zh: clip(relatedRecord.text, BODY_LIMIT),
        truncated: relatedRecord.text.length > BODY_LIMIT
      });
    }
    if (linkedRecord) {
      changeSections.push({
        label_en: "Related memory",
        label_zh: "另一条相关记忆",
        body_en: clip(linkedRecord.text, BODY_LIMIT),
        body_zh: clip(linkedRecord.text, BODY_LIMIT),
        truncated: linkedRecord.text.length > BODY_LIMIT
      });
    }
    const eventSummaryEn = relatedRecord
      ? `${label.en}. The exact change and affected content are shown below.`
      : "This change is part of the recent local history.";
    const eventSummaryZh = relatedRecord
      ? `${label.zh}。下方展示了具体变更及受影响内容。`
      : "这项变化属于近期本地历史。";
    items.push({
      id: dashboardDrawerId("event", event.event_id),
      kind: "event",
      title_en: label.en,
      title_zh: label.zh,
      summary_en: eventSummaryEn,
      summary_zh: eventSummaryZh,
      sections: changeSections,
      ...(relatedRecord ? { recall_command: relatedRecord.citation.recall_command, store_path: storePath } : {}),
      metadata: [
        { label_en: "What happened", label_zh: "发生了什么", value_en: label.en, value_zh: label.zh },
        { label_en: "Changed by", label_zh: "变更来源", value_en: eventSource.en, value_zh: eventSource.zh },
        { label_en: "When", label_zh: "发生时间", value_en: event.created_at },
        { label_en: "Technical event type", label_zh: "技术事件类型", value_en: event.op },
        ...(eventSourceDetail !== eventSource.en
          ? [{ label_en: "Technical source", label_zh: "技术来源", value_en: eventSourceDetail }]
          : []),
        { label_en: "Event ID", label_zh: "事件 ID", value_en: event.event_id },
        ...(event.record_id
          ? [{ label_en: "Affected memory ID", label_zh: "受影响记忆 ID", value_en: event.record_id }]
          : []),
        ...(event.linked_record_id
          ? [{ label_en: "Related memory ID", label_zh: "相关记忆 ID", value_en: event.linked_record_id }]
          : [])
      ],
      evidence_html: `<code>${escapeHtml(event.citation.timeline_command)}</code>${event.citation.recall_command ? ` <code>${escapeHtml(event.citation.recall_command)}</code>` : ""}${linkedRecord ? ` <code>${escapeHtml(linkedRecord.citation.recall_command)}</code>` : ""}`
    });
  }

  const recordDrawer = (record: DashboardRecordSummary, kind: DashboardDrawerItem["kind"]): DashboardDrawerItem => {
    const titleLabel = dashboardRecordTitleLabel(record.kind, record.type);
    const fullText = record.text || "";
    const truncated = fullText.length > BODY_LIMIT;
    const eventPath = record.citation.event_path;
    const githubUrl = githubBase && eventPath ? `${githubBase}/${eventPath}` : undefined;
    const kindLabel = dashboardRecordTitleLabel(record.kind, record.type);
    const stateLabel = memoryStateLabelFromRecordState(record.state);
    const source = readableSource(record.source);
    const recentChanges = data.recent_events
      .filter((event) => event.record_id === record.id || event.linked_record_id === record.id)
      .slice(0, 5)
      .map(recentEventLine);
    return {
      id: dashboardDrawerId("record", record.id),
      kind,
      title_en: titleLabel.en,
      title_zh: titleLabel.zh,
      summary_en: `${kindLabel.en} · ${stateLabel.en} · saved by ${source.en}.`,
      summary_zh: `${kindLabel.zh} · ${stateLabel.zh} · 保存来源：${source.zh}。`,
      body_label_en: "Current saved content",
      body_label_zh: "当前保存的正文",
      body_en: clip(fullText, BODY_LIMIT),
      body_zh: clip(fullText, BODY_LIMIT),
      truncated,
      ...(recentChanges.length > 0
        ? {
            sections: [
              {
                label_en: "Recent changes",
                label_zh: "近期变更",
                body_en: recentChanges.map((change) => change.en).join("\n\n"),
                body_zh: recentChanges.map((change) => change.zh).join("\n\n")
              }
            ]
          }
        : {}),
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
  for (const record of renderedPlanSourceRecords(data.memory_maintenance, memoryRecords)) {
    if (seenRecordIds.has(record.id)) continue;
    items.push(recordDrawer(record, "memory"));
    seenRecordIds.add(record.id);
  }
  // Only build drawer payloads for the records the Memory view can actually open
  // (the capped, newest-first search set). Without this bound the single-file
  // dashboard embeds a full-text payload per record and grows without limit on
  // large stores. Older records stay reachable via CLI recall.
  for (const record of memoryRecords.slice(0, MEMORY_SEARCH_RENDER_LIMIT)) {
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
  state_en: string;
  state_zh: string;
  meta_en: string;
  meta_zh: string;
  search_text: string;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text
    .slice(0, limit)
    .replace(/\s+\S*$/, "")
    .trim()}…`;
}

function buildMemorySearchEntries(records: readonly DashboardRecordSummary[]): DashboardMemorySearchEntry[] {
  return records.map((record) => {
    const source = readableSource(record.source);
    const sourceDetail = sourceLabel(record.source);
    const kind = dashboardRecordTitleLabel(record.kind);
    const state = memoryStateLabelFromRecordState(record.state);
    const rawTitle = record.text || `${record.kind} · ${record.type}`;
    const title = clip(rawTitle.replace(/\s+/g, " "), 120);
    const metaEn = `${kind.en} · from ${source.en}`;
    const metaZh = `${kind.zh} · 来源：${source.zh}`;
    return {
      id: record.id,
      drawer_id: dashboardDrawerId("record", record.id),
      kind: record.kind,
      title_en: title,
      title_zh: title,
      state_en: state.en,
      state_zh: state.zh,
      meta_en: metaEn,
      meta_zh: metaZh,
      search_text:
        `${clip(rawTitle.replace(/\s+/g, " "), 400)} ${record.kind} ${record.type} ${record.state} ${sourceDetail}`.toLowerCase()
    };
  });
}

export function buildDashboardWorkspaceModel(
  data: DashboardData,
  memoryRecords: readonly DashboardRecordSummary[] = data.all_records
): DashboardWorkspaceModel {
  const context = data.quiet_dashboard.current_context;
  const task = context.task ?? "No active task";
  const project = context.project_id ?? "Local store";
  const agent = context.agent ?? "Unknown agent";
  const device = context.device_id ?? "Unknown device";
  const importantRecordIds = new Set(
    [context.checkpoint_record_id, context.handoff_record_id].filter(
      (value): value is string => typeof value === "string"
    )
  );
  const importantRecords = data.recent_records.filter((record) => importantRecordIds.has(record.id)).slice(0, 3);
  const sync = syncLabel(data);
  return {
    task,
    project,
    agent,
    device,
    generated_at: data.generated_at,
    no_action_required:
      data.quiet_dashboard.attention_needed.length === 0 && data.action_board.items_by_id.sync.value === 0,
    sync_label_en: sync.en,
    sync_label_zh: sync.zh,
    memory: {
      saved: data.memory_status.summary.saved_total,
      current: data.memory_status.summary.current_total,
      history: data.memory_status.summary.history_total,
      quarantined: data.memory_status.summary.quarantined_total,
      learned: data.memory_status.learning.absorbed_total,
      pending_learning: data.memory_status.learning.pending_total,
      conflicts: data.memory_status.summary.conflict_total,
      organized: data.memory_status.summary.organized_total,
      organization_groups: data.memory_status.organization.group_total
    },
    recent_events: data.recent_events.slice(0, 5),
    important_records: importantRecords,
    drawers: buildDrawerItems(data, task, project, agent, device, importantRecords, memoryRecords)
  };
}

interface DecisionCardCopy {
  title_en: string;
  title_zh: string;
  approve_en: string;
  approve_zh: string;
  reject_en?: string;
  reject_zh?: string;
}

function decisionCardCopy(
  item: DashboardDecisionSummaryItem,
  maintenancePlan: DashboardMaintenancePlan | undefined
): DecisionCardCopy {
  switch (item.surface) {
    case "maintenance_review":
      if (maintenancePlan?.type === "candidate_noise_archive") {
        const count = maintenancePlan.dry_run.matched_records;
        return {
          title_en: "Review candidate cleanup",
          title_zh: "审查候选记录清理",
          approve_en: `Archive ${count} ${count === 1 ? "record" : "records"}`,
          approve_zh: `归档 ${count} 条记录`,
          reject_en: "Not now",
          reject_zh: "暂不处理"
        };
      }
      return {
        title_en: "Review project identity change",
        title_zh: "审查项目归属变更",
        approve_en: `Move ${maintenancePlan?.dry_run.matched_records ?? 0} records`,
        approve_zh: `迁移 ${maintenancePlan?.dry_run.matched_records ?? 0} 条记录`,
        reject_en: "Not now",
        reject_zh: "暂不处理"
      };
    default:
      return {
        title_en: "Remember this?",
        title_zh: "记住这条？",
        approve_en: "Remember",
        approve_zh: "记住",
        reject_en: "Don't",
        reject_zh: "不用"
      };
  }
}

function maintenancePlanForItem(
  item: DashboardDecisionSummaryItem,
  actionsById: Record<string, DashboardAction>,
  maintenance: DashboardMaintenanceData
): DashboardMaintenancePlan | undefined {
  if (item.surface !== "maintenance_review" || !item.primary_action_id) return undefined;
  const action = actionsById[item.primary_action_id];
  return action?.target.type === "maintenance_plan" ? maintenance.plans_by_id[action.target.id] : undefined;
}

function maintenanceChange(plan: DashboardMaintenancePlan): { en: string; zh: string } {
  const count = plan.dry_run.matched_records;
  if (plan.type === "candidate_noise_archive") {
    return {
      en: `${count} candidate ${count === 1 ? "record moves" : "records move"} to Archived. Nothing is deleted, and the event history remains available.`,
      zh: `${count} 条候选记录将变为“已归档”。不会删除内容，事件历史仍可追溯。`
    };
  }
  return {
    en: `${count} ${count === 1 ? "record changes" : "records change"} project id from ${plan.from_project_id ?? "unknown"} to ${plan.to_project_id ?? "unknown"}. Content, state, and history stay unchanged.`,
    zh: `${count} 条记录的项目 ID 将从 ${plan.from_project_id ?? "unknown"} 改为 ${plan.to_project_id ?? "unknown"}。内容、状态和历史保持不变。`
  };
}

function maintenancePrivacy(plan: DashboardMaintenancePlan): { en: string; zh: string } {
  const skipped = plan.dry_run.skipped_private_records;
  const included = plan.dry_run.included_private_records;
  if (included > 0) return { en: `${included} private records are included.`, zh: `包含 ${included} 条私密记录。` };
  if (skipped > 0) return { en: `${skipped} private records are excluded.`, zh: `已排除 ${skipped} 条私密记录。` };
  return { en: "No private records are included.", zh: "不包含私密记录。" };
}

function maintenanceStateSummary(plan: DashboardMaintenancePlan): string {
  return Object.entries(plan.dry_run.states)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .map(([state, count]) => `${count} ${state}`)
    .join(" · ");
}

function renderMaintenanceDetails(plan: DashboardMaintenancePlan): string {
  const change = maintenanceChange(plan);
  const privacy = maintenancePrivacy(plan);
  const examples = plan.decision_card.examples
    .map(
      (example) => `<li class="editorial-decision-example">
        <div><span>${escapeHtml(example.kind)} / ${escapeHtml(example.type)}</span><span>${escapeHtml(example.state)}</span></div>
        <p>${escapeHtml(example.preview)}</p>
        <code>${escapeHtml(example.record_id)}</code>
      </li>`
    )
    .join("");
  const safetyChecks = plan.safety_checks
    .map(
      (check) =>
        `<li><span aria-hidden="true">${check.ok ? "✓" : "!"}</span><span>${escapeHtml(check.label)}</span></li>`
    )
    .join("");
  const shownIds = plan.record_ids.slice(0, 12);
  const overflow = plan.record_ids.length - shownIds.length;
  return `<div class="editorial-decision-context">
      <div class="editorial-decision-reason">
        <span class="editorial-decision-label">${i18n("Why this needs review", "为什么需要你审查")}</span>
        <p>${escapeHtml(plan.decision_card.issue)} ${escapeHtml(plan.decision_card.impact)}</p>
      </div>
      <dl class="editorial-decision-scope">
        <div><dt>${i18n("Exact change", "具体变更")}</dt><dd data-i18n-en="${escapeHtml(change.en)}" data-i18n-zh="${escapeHtml(change.zh)}">${escapeHtml(change.en)}</dd></div>
        <div><dt>${i18n("Current states", "当前状态")}</dt><dd>${escapeHtml(maintenanceStateSummary(plan))}</dd></div>
        <div><dt>${i18n("Privacy", "隐私范围")}</dt><dd data-i18n-en="${escapeHtml(privacy.en)}" data-i18n-zh="${escapeHtml(privacy.zh)}">${escapeHtml(privacy.en)}</dd></div>
      </dl>
      <div class="editorial-decision-examples">
        <div class="editorial-decision-label">${i18n(`Examples (${plan.decision_card.examples.length} of ${plan.record_ids.length})`, `内容样例（${plan.decision_card.examples.length}/${plan.record_ids.length}）`)}</div>
        <ul>${examples}</ul>
      </div>
      <details class="editorial-decision-evidence">
        <summary>${i18n("Affected records and safeguards", "受影响记录与安全校验")}</summary>
        <p>${escapeHtml(plan.decision_card.recommended_action)}</p>
        <ul class="editorial-decision-checks">${safetyChecks}</ul>
        <div class="editorial-decision-record-ids">${shownIds.map((id) => `<code>${escapeHtml(id)}</code>`).join("")}${overflow > 0 ? `<span>+${overflow} more</span>` : ""}</div>
        <p class="editorial-decision-guard">${i18n("The server recalculates the plan and verifies its hash immediately before writing.", "服务器会在写入前重新计算计划并校验哈希。")}</p>
      </details>
    </div>`;
}

function decisionActionAttributes(action: DashboardAction | undefined): string {
  if (!action?.endpoint || action.method !== "POST") return "";
  const body = JSON.stringify(action.request_body ?? {});
  return `data-decision-endpoint="${escapeHtml(action.endpoint.replace(/^\//, ""))}" data-decision-body="${escapeHtml(body)}"`;
}

function renderDecisionCard(
  item: DashboardDecisionSummaryItem,
  actionsById: Record<string, DashboardAction>,
  maintenancePlan: DashboardMaintenancePlan | undefined
): string {
  const copy = decisionCardCopy(item, maintenancePlan);
  const approveAction = item.primary_action_id ? actionsById[item.primary_action_id] : undefined;
  const rejectAction = item.secondary_action_id ? actionsById[item.secondary_action_id] : undefined;
  const approveAttrs = decisionActionAttributes(approveAction);
  if (!approveAttrs) return "";
  const rejectAttrs = copy.reject_en ? decisionActionAttributes(rejectAction) : "";
  const rejectButton = maintenancePlan
    ? `<button type="button" class="editorial-decision-button ghost" data-maintenance-reject><span data-i18n-en="Not now" data-i18n-zh="暂不处理">Not now</span></button>`
    : rejectAttrs
      ? `<button type="button" class="editorial-decision-button ghost" data-decision-action="reject" ${rejectAttrs}><span data-i18n-en="${escapeHtml(copy.reject_en ?? "")}" data-i18n-zh="${escapeHtml(copy.reject_zh ?? "")}">${escapeHtml(copy.reject_en ?? "")}</span></button>`
      : "";
  const maintenanceAttributes = maintenancePlan
    ? ` data-maintenance-plan="${escapeHtml(maintenancePlan.plan_hash)}"`
    : "";
  const details = maintenancePlan ? renderMaintenanceDetails(maintenancePlan) : "";
  const loading =
    maintenancePlan?.type === "candidate_noise_archive" ? "Archiving records..." : "Changing project ids...";
  const loadingZh = maintenancePlan?.type === "candidate_noise_archive" ? "正在归档记录..." : "正在变更项目归属...";
  return `<article class="editorial-decision-card" data-decision-card${maintenanceAttributes}>
      <div class="editorial-decision-head">
        <strong data-i18n-en="${escapeHtml(copy.title_en)}" data-i18n-zh="${escapeHtml(copy.title_zh)}">${escapeHtml(copy.title_en)}</strong>
        <span class="editorial-decision-source">${escapeHtml(item.title)}</span>
      </div>
      <p class="editorial-decision-summary">${escapeHtml(item.summary)}</p>
      ${details || `<p class="editorial-decision-note">${escapeHtml(item.safety_note)}</p>`}
      <div class="editorial-decision-actions">
        <button type="button" class="editorial-decision-button primary" data-decision-action="approve" data-decision-loading-en="${escapeHtml(loading)}" data-decision-loading-zh="${escapeHtml(loadingZh)}" ${approveAttrs}><span data-i18n-en="${escapeHtml(copy.approve_en)}" data-i18n-zh="${escapeHtml(copy.approve_zh)}">${escapeHtml(copy.approve_en)}</span></button>
        ${rejectButton}
        <span class="editorial-decision-status" data-decision-status aria-live="polite"></span>
      </div>
    </article>`;
}

function isDecisionAttentionItem(item: DashboardAttentionItem, decisionTitles: Set<string>): boolean {
  return decisionTitles.has(item.title);
}

function renderAttention(
  items: DashboardAttentionItem[],
  decisionItems: DashboardDecisionSummaryItem[],
  actionsById: Record<string, DashboardAction>,
  maintenance: DashboardMaintenanceData
): string {
  const cards = decisionItems
    .map((item) => renderDecisionCard(item, actionsById, maintenancePlanForItem(item, actionsById, maintenance)))
    .filter((html) => html !== "");
  const decisionTitles = new Set(decisionItems.map((item) => item.title));
  const notices = items.filter((item) => item.category !== "sync" && !isDecisionAttentionItem(item, decisionTitles));
  if (cards.length === 0 && notices.length === 0) return "";
  const noticesHtml = notices
    .map(
      (item) =>
        `<article class="editorial-decision-notice"><strong data-i18n-en="${escapeHtml(item.title)}" data-i18n-zh="${escapeHtml(item.title_zh ?? item.title)}">${escapeHtml(item.title)}</strong><p data-i18n-en="${escapeHtml(item.description)}" data-i18n-zh="${escapeHtml(item.description_zh ?? item.description)}">${escapeHtml(item.description)}</p></article>`
    )
    .join("");
  const heading =
    cards.length > 0
      ? {
          title_en: "Decision required",
          title_zh: "需要你决定",
          detail_en: "Review the proposed records and exact outcome before choosing.",
          detail_zh: "请先查看涉及的记录和具体结果，再做决定。"
        }
      : {
          title_en: "Needs attention",
          title_zh: "需要关注",
          detail_en: "Routine work remains automatic; this item has waited unusually long or needs a closer look.",
          detail_zh: "日常工作仍会自动处理；这里仅显示等待异常过久或确实需要查看的事项。"
        };
  return `<section class="editorial-section editorial-attention" data-editorial-section="attention">
    <div class="editorial-section-heading"><div class="editorial-section-title">${i18n(heading.title_en, heading.title_zh)}</div><p>${i18n(heading.detail_en, heading.detail_zh)}</p></div>
    ${cards.join("")}
    ${noticesHtml}
  </section>`;
}

function renderMetric(
  id: string,
  labelEn: string,
  labelZh: string,
  value: number | string,
  detailEn: string,
  detailZh: string
): string {
  return `<button type="button" class="editorial-metric" data-drawer-target="${escapeHtml(id)}" aria-haspopup="dialog">
    <span data-i18n-en="${escapeHtml(labelEn)}" data-i18n-zh="${escapeHtml(labelZh)}">${escapeHtml(labelEn)}</span><strong>${escapeHtml(value)}</strong><small data-i18n-en="${escapeHtml(detailEn)}" data-i18n-zh="${escapeHtml(detailZh)}">${escapeHtml(detailEn)}</small>
  </button>`;
}

function renderEvents(events: DashboardEventSummary[]): string {
  if (events.length === 0) return `<p>${i18n("No recent changes", "暂无近期变化")}</p>`;
  return `<div class="editorial-event-list">${events
    .map((event) => {
      const label = eventLabel(event);
      const source = readableSource(event.source);
      return `<button type="button" class="editorial-event" data-drawer-target="${escapeHtml(dashboardDrawerId("event", event.event_id))}" aria-haspopup="dialog">
    <time class="editorial-event-time" datetime="${escapeHtml(event.created_at)}">${escapeHtml(event.created_at.slice(11, 16))}</time>
    <strong class="editorial-event-operation" data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</strong>
    <small class="editorial-event-source" data-i18n-en="${escapeHtml(source.en)}" data-i18n-zh="${escapeHtml(source.zh)}">${escapeHtml(source.en)}</small>
  </button>`;
    })
    .join("")}</div>`;
}

function renderImportant(records: DashboardRecordSummary[], model: DashboardWorkspaceModel): string {
  const recordItems = records
    .map((record) => {
      const state = memoryStateLabelFromRecordState(record.state);
      const source = readableSource(record.source);
      const metaEn = `${state.en} · from ${source.en}`;
      const metaZh = `${state.zh} · 来源：${source.zh}`;
      return `<button type="button" class="editorial-important" data-drawer-target="${escapeHtml(dashboardDrawerId("record", record.id))}" aria-haspopup="dialog"><strong>${escapeHtml(record.text || `${record.kind} · ${record.type}`)}</strong><p data-i18n-en="${escapeHtml(metaEn)}" data-i18n-zh="${escapeHtml(metaZh)}">${escapeHtml(metaEn)}</p></button>`;
    })
    .join("");
  return `<aside class="editorial-sidebar" data-editorial-sidebar="important-now">
    <div class="editorial-sidebar-heading"><div class="editorial-section-title">${i18n("Important Now", "当前重要内容")}</div></div>
    <button type="button" class="editorial-important" data-drawer-target="context-current" aria-haspopup="dialog"><strong>${escapeHtml(model.task)}</strong><p>${i18n("Current task · latest work saved", "当前任务 · 最新进度已保存")}</p></button>
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
  const bar = shown
    .map(
      (item) =>
        `<span class="glance-bar-seg ${stateSwatchClass(item.state)}" style="width:${item.percent}%" title="${escapeHtml(memoryStateLabelFromRecordState(item.state).en)} ${item.count}"></span>`
    )
    .join("");
  const legend = shown
    .map((item) => {
      const label = memoryStateLabelFromRecordState(item.state);
      return `<li><span class="glance-dot ${stateSwatchClass(item.state)}"></span><span class="glance-legend-label" data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</span><span class="glance-legend-value">${item.count}</span></li>`;
    })
    .join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Memory composition" data-i18n-zh="记忆组成">Memory composition</div>
      <div class="glance-stack">${bar}</div>
      <ul class="glance-legend">${legend}</ul>
    </article>`;
}

function renderContentTypeChart(items: DashboardRecordTypeChartItem[]): string {
  const shown = items.filter((item) => item.count > 0).slice(0, 5);
  if (shown.length === 0) return "";
  const rows = shown
    .map(
      (item) => `<li class="glance-row">
      <span class="glance-row-label">${escapeHtml(item.label)}</span>
      <span class="glance-row-track"><span class="glance-row-fill" style="width:${item.percent}%"></span></span>
      <span class="glance-row-value">${item.count}</span>
    </li>`
    )
    .join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Content types" data-i18n-zh="内容类型">Content types</div>
      <ul class="glance-rows">${rows}</ul>
    </article>`;
}

function renderTrendChart(trend: DashboardActivityTrendChart): string {
  if (!trend.days || trend.days.length === 0 || trend.total === 0) return "";
  const peak = Math.max(1, trend.peak);
  const bars = trend.days
    .map((day) => {
      const h = Math.round((day.count / peak) * 100);
      return `<span class="glance-trend-bar" style="height:${Math.max(3, h)}%" title="${escapeHtml(day.label)}: ${day.count}"></span>`;
    })
    .join("");
  return `<article class="glance-card">
      <div class="glance-card-title" data-i18n-en="Recent saves" data-i18n-zh="近期保存">Recent saves</div>
      <div class="glance-trend">${bars}</div>
      <div class="glance-trend-caption"><span data-i18n-en="Last ${trend.days.length} days" data-i18n-zh="最近 ${trend.days.length} 天">Last ${trend.days.length} days</span><span class="glance-legend-value">${trend.total}</span></div>
    </article>`;
}

function renderSourceChart(agents: DashboardAgentChartItem[]): string {
  const shown = [...agents].sort((a, b) => b.records + b.events - (a.records + a.events)).slice(0, 4);
  const withSignal = shown.filter((agent) => agent.records + agent.events > 0);
  if (withSignal.length === 0) return "";
  const peak = Math.max(1, ...withSignal.map((agent) => agent.records + agent.events));
  const rows = withSignal
    .map((agent) => {
      const signals = agent.records + agent.events;
      return `<li class="glance-row">
      <span class="glance-row-label">${escapeHtml(agent.client)}</span>
      <span class="glance-row-track"><span class="glance-row-fill" style="width:${Math.round((signals / peak) * 100)}%"></span></span>
      <span class="glance-row-value">${signals}</span>
    </li>`;
    })
    .join("");
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

const MEMORY_SEARCH_RENDER_LIMIT = 600;

export interface DashboardMemorySearchOptions {
  endpoint?: string;
}

export function renderMemorySearch(
  data: DashboardData,
  records: readonly DashboardRecordSummary[] = data.all_records,
  options: DashboardMemorySearchOptions = {}
): string {
  const genericMemoryRecords = records.filter((record) => record.kind !== "soul");
  const allEntries = buildMemorySearchEntries(genericMemoryRecords);
  if (allEntries.length === 0) {
    return `<div class="memory-search" id="saved-memory-library"><div class="memory-search-heading"><div class="editorial-eyebrow">${i18n("Saved content", "已保存内容")}</div><h2>${i18n("What Moryn remembers", "Moryn 记住了什么")}</h2><p>${i18n("These are the actual saved items. Open any one to read its content and recent changes.", "下面都是实际保存的内容。点开任意一条，即可查看正文和近期变更。")}</p></div><p class="memory-search-empty" data-i18n-en="Nothing has been saved yet. Saved memories will be searchable here." data-i18n-zh="还没有保存任何内容。保存的记忆会在这里可搜索。">Nothing has been saved yet. Saved memories will be searchable here.</p></div>`;
  }
  // Bound the embedded result set so the single-file dashboard stays small even
  // for very large stores. all_records is newest-first, so this keeps the most
  // recent memories searchable; older ones remain reachable via CLI recall.
  const capped = allEntries.length > MEMORY_SEARCH_RENDER_LIMIT;
  const entries = capped ? allEntries.slice(0, MEMORY_SEARCH_RENDER_LIMIT) : allEntries;
  const stateBreakdown = data.memory_status.summary;
  const organizedEn = `${stateBreakdown.organized_total} older ${stateBreakdown.organized_total === 1 ? "version" : "versions"} tucked away`;
  const countLabel = (n: number) => ({ en: `${n} ${n === 1 ? "memory" : "memories"}`, zh: `${n} 条记忆` });
  const total = capped
    ? {
        en: `${entries.length} of ${allEntries.length} memories`,
        zh: `${allEntries.length} 条中的 ${entries.length} 条`
      }
    : countLabel(entries.length);
  const cappedNotice = capped
    ? options.endpoint
      ? `<p class="memory-search-capped" data-memory-search-scope-note data-i18n-en="The newest ${MEMORY_SEARCH_RENDER_LIMIT} memories are ready to browse. Show more to continue, or type a search to look across every visible saved memory." data-i18n-zh="可直接浏览最近 ${MEMORY_SEARCH_RENDER_LIMIT} 条记忆。点击显示更多可继续浏览，也可输入内容搜索全部可见记忆。">The newest ${MEMORY_SEARCH_RENDER_LIMIT} memories are ready to browse. Show more to continue, or type a search to look across every visible saved memory.</p>`
      : `<p class="memory-search-capped" data-memory-search-scope-note data-i18n-en="This saved dashboard contains the ${MEMORY_SEARCH_RENDER_LIMIT} most recent memories. Open the live Dashboard to search older saved memories here." data-i18n-zh="这份 Dashboard 快照包含最近 ${MEMORY_SEARCH_RENDER_LIMIT} 条记忆。打开实时 Dashboard 后，可在此搜索更早的已保存记忆。">This saved dashboard contains the ${MEMORY_SEARCH_RENDER_LIMIT} most recent memories. Open the live Dashboard to search older saved memories here.</p>`
    : "";
  const results = entries
    .map(
      (entry) => `
        <button type="button" class="memory-result" data-memory-result data-search-text="${escapeHtml(entry.search_text)}" data-kind="${escapeHtml(entry.kind)}" data-drawer-target="${escapeHtml(entry.drawer_id)}" aria-haspopup="dialog">
          <span class="memory-result-copy">
            <span class="memory-result-title" data-i18n-en="${escapeHtml(entry.title_en)}" data-i18n-zh="${escapeHtml(entry.title_zh)}">${escapeHtml(entry.title_en)}</span>
            <span class="memory-result-meta" data-i18n-en="${escapeHtml(entry.meta_en)}" data-i18n-zh="${escapeHtml(entry.meta_zh)}">${escapeHtml(entry.meta_en)}</span>
          </span>
          <span class="memory-result-state" data-i18n-en="${escapeHtml(entry.state_en)}" data-i18n-zh="${escapeHtml(entry.state_zh)}">${escapeHtml(entry.state_en)}</span>
        </button>`
    )
    .join("");
  const kindOrder: DashboardRecordSummary["kind"][] = ["memory", "skill", "session_summary", "agent_note"];
  const kindCounts = new Map<string, number>();
  for (const entry of entries) kindCounts.set(entry.kind, (kindCounts.get(entry.kind) ?? 0) + 1);
  const presentKinds = kindOrder.filter((kind) => (kindCounts.get(kind) ?? 0) > 0);
  const allChip = `<button type="button" class="memory-chip" data-memory-chip data-chip-kind="all" aria-pressed="true"><span data-i18n-en="All" data-i18n-zh="全部">All</span><span class="memory-chip-count">${entries.length}</span></button>`;
  const kindChips = presentKinds
    .map((kind) => {
      const label = memoryKindLabel(kind);
      return `<button type="button" class="memory-chip" data-memory-chip data-chip-kind="${escapeHtml(kind)}" aria-pressed="false"><span data-i18n-en="${escapeHtml(label.en)}" data-i18n-zh="${escapeHtml(label.zh)}">${escapeHtml(label.en)}</span><span class="memory-chip-count">${kindCounts.get(kind) ?? 0}</span></button>`;
    })
    .join("");
  return `
    <div class="memory-search" id="saved-memory-library" data-memory-search${options.endpoint ? ` data-memory-search-endpoint="${escapeHtml(options.endpoint)}"` : ""}>
      <div class="memory-search-heading"><div class="editorial-eyebrow">${i18n("Saved content", "已保存内容")}</div><h2>${i18n("What Moryn remembers", "Moryn 记住了什么")}</h2><p>${i18n("These are the actual saved items. Open any one to read its content and recent changes.", "下面都是实际保存的内容。点开任意一条，即可查看正文和近期变更。")}</p></div>
      <div class="memory-search-field">
        <input type="search" data-memory-search-input placeholder="Search saved memories" aria-label="Search saved memories" data-i18n-placeholder-en="Search saved memories" data-i18n-placeholder-zh="搜索已保存的记忆" data-i18n-aria-label-en="Search saved memories" data-i18n-aria-label-zh="搜索已保存的记忆">
      </div>
      <div class="memory-chips" data-memory-chips>${allChip}${kindChips}</div>
      <p class="memory-search-count" data-memory-search-count role="status" aria-live="polite" data-total="${entries.length}" data-visible-total="${allEntries.length}" data-i18n-en="${escapeHtml(total.en)}" data-i18n-zh="${escapeHtml(total.zh)}">${escapeHtml(total.en)}</p>
      <p class="memory-search-breakdown" data-i18n-en="${escapeHtml(`${genericMemoryRecords.length} saved here: ${stateBreakdown.current_total} current · ${stateBreakdown.history_total} history · ${organizedEn} · ${stateBreakdown.quarantined_total} set aside`)}" data-i18n-zh="${escapeHtml(`这里共保存 ${genericMemoryRecords.length} 条：${stateBreakdown.current_total} 条当前可用 · ${stateBreakdown.history_total} 条历史 · ${stateBreakdown.organized_total} 条旧版本已收起 · ${stateBreakdown.quarantined_total} 条待查`)}"><strong>${genericMemoryRecords.length}</strong> saved here: ${stateBreakdown.current_total} current · ${stateBreakdown.history_total} history · ${organizedEn} · ${stateBreakdown.quarantined_total} set aside</p>
      ${cappedNotice}
      <div class="ms-results" data-memory-search-results>${results}</div>
      <button type="button" class="memory-search-more" data-memory-search-more${capped && options.endpoint ? "" : " hidden"} data-i18n-en="Show more saved memories" data-i18n-zh="显示更多已保存记忆">Show more saved memories</button>
      <p class="memory-search-empty" data-memory-search-noresults hidden role="status" aria-live="polite" data-i18n-en="No memories match your search." data-i18n-zh="没有匹配的记忆。">No memories match your search.</p>
    </div>`;
}

function renderDrawer(drawers: DashboardDrawerItem[]): string {
  const kindLabel = (kind: DashboardDrawerItem["kind"]): { en: string; zh: string } => {
    if (kind === "context") return { en: "Current work", zh: "当前工作" };
    if (kind === "memory") return { en: "Memory", zh: "记忆" };
    if (kind === "event") return { en: "Change", zh: "变化" };
    return { en: "Important", zh: "重要内容" };
  };
  return `<div data-dashboard-drawer hidden>
    <aside class="editorial-drawer-panel" role="dialog" aria-modal="true" aria-label="Details" tabindex="-1">
      <div class="editorial-drawer-head"><div class="editorial-section-title">${i18n("Read-only details", "只读详情")}</div><button type="button" class="editorial-drawer-close" data-dashboard-drawer-close data-i18n-en="Close details" data-i18n-zh="关闭详情">Close details</button></div>
      ${drawers
        .map(
          (drawer) => `<section data-drawer-payload="${escapeHtml(drawer.id)}" hidden>
        <div class="editorial-eyebrow">${i18n(kindLabel(drawer.kind).en, kindLabel(drawer.kind).zh)}</div>
        <h2 class="editorial-drawer-title" data-i18n-en="${escapeHtml(drawer.title_en)}" data-i18n-zh="${escapeHtml(drawer.title_zh)}">${escapeHtml(drawer.title_en)}</h2>
        <p class="editorial-drawer-summary" data-i18n-en="${escapeHtml(drawer.summary_en)}" data-i18n-zh="${escapeHtml(drawer.summary_zh)}">${escapeHtml(drawer.summary_en)}</p>
        ${drawer.body_en ? `${drawer.body_label_en ? `<div class="editorial-drawer-body-label">${i18n(drawer.body_label_en, drawer.body_label_zh ?? drawer.body_label_en)}</div>` : ""}<div class="editorial-drawer-body" data-i18n-en="${escapeHtml(drawer.body_en)}" data-i18n-zh="${escapeHtml(drawer.body_zh ?? drawer.body_en)}">${escapeHtml(drawer.body_en)}</div>` : ""}
        ${drawer.truncated ? `<p class="editorial-drawer-truncated" data-i18n-en="This long memory is shortened here. An original source link is shown below when one is available." data-i18n-zh="这条较长的记忆在此做了缩略。若有可用的原始来源，会显示在下方。">This long memory is shortened here. An original source link is shown below when one is available.</p>` : ""}
        ${(drawer.sections ?? [])
          .map(
            (section) => `<section class="editorial-drawer-content-section">
          <div class="editorial-drawer-body-label">${i18n(section.label_en, section.label_zh)}</div>
          <div class="editorial-drawer-body" data-i18n-en="${escapeHtml(section.body_en)}" data-i18n-zh="${escapeHtml(section.body_zh ?? section.body_en)}">${escapeHtml(section.body_en)}</div>
          ${section.truncated ? `<p class="editorial-drawer-truncated" data-i18n-en="This value is shortened here. Its technical trace is available under Advanced details." data-i18n-zh="此处内容已缩短，技术追溯信息可在“高级详情”中查看。">This value is shortened here. Its technical trace is available under Advanced details.</p>` : ""}
        </section>`
          )
          .join("")}
        ${
          drawer.github_url
            ? `<div class="editorial-drawer-source">
          <div class="editorial-section-title">${i18n("Original saved file", "原始保存文件")}</div>
          ${drawer.github_url ? `<a class="editorial-drawer-link" href="${escapeHtml(drawer.github_url)}" target="_blank" rel="noopener noreferrer" data-i18n-en="Open on GitHub" data-i18n-zh="在 GitHub 打开">Open on GitHub</a><small class="editorial-drawer-hint" data-i18n-en="If newly saved, it may need a sync first." data-i18n-zh="若为新记忆，可能需要先同步。">If newly saved, it may need a sync first.</small>` : ""}
        </div>`
            : ""
        }
        <details class="editorial-drawer-advanced">
          <summary>${i18n("Advanced details", "高级详情")}</summary>
          <div class="editorial-drawer-advanced-body">
            ${drawer.recall_command ? `<div class="editorial-drawer-cmd"><span data-i18n-en="Command-line lookup" data-i18n-zh="命令行查找">Command-line lookup</span><code lang="en">${escapeHtml(drawer.recall_command)}</code></div>` : ""}
            ${drawer.store_path ? `<div class="editorial-drawer-cmd"><span data-i18n-en="Local store path" data-i18n-zh="本地存储路径">Local store path</span><code lang="en">${escapeHtml(drawer.store_path)}</code></div>` : ""}
            <dl class="editorial-drawer-meta">${drawer.metadata.map((item) => `<div><dt data-i18n-en="${escapeHtml(item.label_en)}" data-i18n-zh="${escapeHtml(item.label_zh)}">${escapeHtml(item.label_en)}</dt><dd data-i18n-en="${escapeHtml(item.value_en)}" data-i18n-zh="${escapeHtml(item.value_zh ?? item.value_en)}">${escapeHtml(item.value_en)}</dd></div>`).join("")}</dl>
            <div class="editorial-drawer-evidence"><div class="editorial-section-title">${i18n("Technical evidence", "技术依据")}</div><p>${drawer.evidence_html}</p></div>
          </div>
        </details>
      </section>`
        )
        .join("")}
    </aside>
  </div>`;
}

export function renderDashboardWorkspace(data: DashboardData, fragments: DashboardWorkspaceFragments): string {
  const model = buildDashboardWorkspaceModel(data, fragments.memory_records);
  const savedItemsEn = `${model.memory.saved} ${model.memory.saved === 1 ? "item" : "items"}`;
  const organizedSummaryEn = `${model.memory.organized} older ${model.memory.organized === 1 ? "version" : "versions"} tucked away`;
  const retainedNonCurrent = Math.max(0, model.memory.saved - model.memory.current);
  const retainedNonCurrentEn = `${retainedNonCurrent} ${retainedNonCurrent === 1 ? "item remains" : "items remain"} outside current use as older-version, history, or review material`;
  const memoryScope =
    data.memory_maintenance.scope.mode === "project"
      ? {
          en: "Search memories saved for this project together with shared memories. Open any item to read its content and recent changes. Nothing is written here.",
          zh: "搜索为当前项目保存的记忆以及共享记忆。点开任意一条即可查看正文和近期变更；此处不会写入。"
        }
      : {
          en: "Search all visible memories in this store. Open any item to read its content and recent changes. Nothing is written here.",
          zh: "搜索当前存储中的全部可见记忆。点开任意一条即可查看正文和近期变更；此处不会写入。"
        };
  return `<div data-dashboard-editorial-shell>
    <header class="editorial-header">
      <div class="editorial-brand">Moryn</div>
      <nav class="editorial-navigation" aria-label="Dashboard views">
        <button type="button" class="editorial-nav-button" data-dashboard-nav="workspace" aria-current="page">${i18n("Overview", "概览")}</button>
        <button type="button" class="editorial-nav-button" data-dashboard-nav="memory">${i18n("Memory", "记忆")}</button>
        <button type="button" class="editorial-nav-button" data-dashboard-nav="preferences">${i18n("Preferences", "协作偏好")}</button>
        <button type="button" class="editorial-nav-button" data-dashboard-nav="history">${i18n("History", "历史")}</button>
      </nav>
      <div class="editorial-header-status"><span class="editorial-sync">● ${i18n(model.sync_label_en, model.sync_label_zh)}</span><button type="button" class="editorial-refresh" data-dashboard-refresh-button><span data-i18n-en="Refresh" data-i18n-zh="刷新">Refresh</span></button>${fragments.language_toggle_html}</div>
    </header>
    <div class="editorial-shell-body">
      <section data-dashboard-view="workspace">
        <div class="editorial-layout">
          <article class="editorial-reading-column">
            <section data-editorial-section="current-context">
              <div class="editorial-eyebrow">${i18n("Current work", "当前工作")}</div>
              <button type="button" class="editorial-task-button" data-drawer-target="context-current" aria-haspopup="dialog"><h1 class="editorial-task">${escapeHtml(model.task)}</h1></button>
              <p class="editorial-lead">${i18n(contextSummary(data).en, contextSummary(data).zh)}</p>
              ${renderSyncAssurance(data)}
              ${model.no_action_required ? `<div class="editorial-conclusion" data-editorial-conclusion="no-action-required"><div class="editorial-conclusion-mark">✓</div><div><strong>${i18n("No action required", "无需操作")}</strong><span>${i18n("Moryn has saved the latest work and is taking care of routine organization.", "Moryn 已保存最新进度，并在后台处理日常整理。")}</span></div></div>` : ""}
            </section>
            ${renderAttention(data.quiet_dashboard.attention_needed, data.decision_summary.items, data.actions_by_id, data.maintenance)}
            <section class="editorial-section" data-editorial-section="memory-state"><div class="editorial-section-heading"><div class="editorial-section-title">${i18n("Memory State", "记忆状态")}</div><p>${i18n("Concrete content and its current status", "具体保存了什么，以及当前状态")}</p></div>
              <p class="editorial-memory-summary"><strong>${i18n(`${savedItemsEn} saved in total for this project and shared use`, `当前项目及共享范围共保存 ${model.memory.saved} 条内容（含当前、历史与待查）`)}</strong><span>${i18n(`Breakdown: ${model.memory.current} current + ${organizedSummaryEn} + ${model.memory.history} history + ${model.memory.quarantined} set aside`, `构成：${model.memory.current} 条当前可用 + ${model.memory.organized} 条旧版本已收起 + ${model.memory.history} 条历史 + ${model.memory.quarantined} 条待查`)}</span></p>
              <div class="editorial-memory-grid">
              ${renderMetric("memory-active", "Current", "当前可用", model.memory.current, retainedNonCurrentEn, `另有 ${retainedNonCurrent} 条作为旧版本、历史或待查内容保留`)}
              ${renderMetric("memory-learned", "Absorbed", "已吸收结论", model.memory.learned, `${model.memory.pending_learning} new findings processing`, `${model.memory.pending_learning} 条新发现正在处理`)}
              ${renderMetric("memory-conflicts", "Needs review", "存在分歧", model.memory.conflicts, model.memory.conflicts ? "Concrete statements are preserved" : "Nothing needs your attention", model.memory.conflicts ? "相关具体表述均已保留" : "目前无需你处理")}
              ${renderMetric("memory-compaction", "Older versions tucked away", "已收起旧版本", model.memory.organized, `${model.memory.organization_groups} current conclusions`, `归入 ${model.memory.organization_groups} 条当前结论`)}
            </div></section>
            ${renderGlance(data)}
            <section class="editorial-section" data-editorial-section="what-changed"><div class="editorial-section-heading"><div class="editorial-section-title">${i18n("What Changed", "近期变化")}</div><p>${i18n("Recent saves and updates, in plain language", "最近保存和整理的内容变化")}</p></div>${renderEvents(model.recent_events)}</section>
          </article>
          ${renderImportant(model.important_records, model)}
        </div>
      </section>
      <section class="editorial-view-page" data-dashboard-view="memory" hidden><header><div class="editorial-eyebrow">${i18n("Knowledge library", "知识库")}</div><h1>${i18n("Memory", "记忆")}</h1><p>${i18n(memoryScope.en, memoryScope.zh)}</p></header>${fragments.memory_html}<div class="v04-dashboard-sections">${renderMemoryMaintenance(data.memory_maintenance, fragments.memory_records)}</div></section>
      <section class="editorial-view-page" data-dashboard-view="preferences" hidden><header><div class="editorial-eyebrow">${i18n("How assistants work with you", "你希望 Agent 如何与你协作")}</div><h1>${i18n("Collaboration Preferences", "协作偏好")}</h1><p>${i18n("Read the concrete preferences currently guiding supported assistants. Device-only text remains hidden.", "查看当前实际指导 Agent 的具体偏好；仅本机内容仍保持隐藏。")}</p></header><div class="v04-dashboard-sections">${renderSoulStudio(data.soul_studio)}</div></section>
      <section class="editorial-view-page" data-dashboard-view="history" hidden><header><div class="editorial-eyebrow">${i18n("Recent activity", "近期动态")}</div><h1>${i18n("History", "历史")}</h1><p>${i18n("A plain-language record of what has happened, newest first.", "用日常语言记录发生过的事，最新在前。")}</p></header>${fragments.history_html}</section>
    </div>
    ${renderDrawer(model.drawers)}
  </div>`;
}
