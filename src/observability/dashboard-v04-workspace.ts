import type { DashboardRecordSummary } from "./dashboard.js";
import { dashboardDrawerId } from "./dashboard-drawer-id.js";
import type {
  DashboardCompactionPlanPreview,
  DashboardMemoryMaintenance,
  DashboardSoulItem,
  DashboardSoulProfile,
  DashboardSoulStudio
} from "./dashboard-v04.js";

const PLAN_RENDER_LIMIT = 8;
const RELATED_RECORD_RENDER_LIMIT = 3;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function i18n(en: string, zh: string, tag = "span"): string {
  return `<${tag} data-i18n-en="${escapeHtml(en)}" data-i18n-zh="${escapeHtml(zh)}">${escapeHtml(en)}</${tag}>`;
}

function integer(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function shortId(value: string | undefined): string {
  if (!value) return "—";
  if (value.length <= 24) return value;
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized
    .slice(0, limit)
    .replace(/\s+\S*$/u, "")
    .trim()}…`;
}

function statusCopy(status: DashboardCompactionPlanPreview["status"]): { en: string; zh: string; css: string } {
  if (status === "ready") return { en: "Safe to organize", zh: "可以安全整理", css: "ready" };
  if (status === "deferred") return { en: "Keep as-is for now", zh: "暂时保持原样", css: "deferred" };
  return { en: "Not organizing yet", zh: "暂不整理", css: "review" };
}

function recordKindCopy(kind: DashboardRecordSummary["kind"]): { en: string; zh: string } {
  if (kind === "memory") return { en: "Memory", zh: "记忆" };
  if (kind === "skill") return { en: "Skill", zh: "技能" };
  if (kind === "soul") return { en: "Preference", zh: "偏好" };
  if (kind === "session_summary") return { en: "Session note", zh: "会话记录" };
  return { en: "Work note", zh: "工作记录" };
}

function recordStateCopy(state: DashboardRecordSummary["state"]): { en: string; zh: string } {
  if (state === "canonical") return { en: "Ready to use", zh: "可直接使用" };
  if (state === "candidate") return { en: "Saved for later", zh: "已保存，稍后整理" };
  if (state === "raw") return { en: "Temporary note", zh: "临时记录" };
  if (state === "archived") return { en: "Available through search", zh: "可通过搜索查看" };
  return { en: "Set aside for review", zh: "已搁置待查" };
}

function privacyCopy(privacy: DashboardCompactionPlanPreview["privacy_boundary"]): { en: string; zh: string } {
  if (privacy === "public") return { en: "Visible content only", zh: "仅当前可见内容" };
  if (privacy === "private") return { en: "Private content only", zh: "仅私密内容" };
  return { en: "Mixed visibility; no automatic merge", zh: "可见性不同，不会自动合并" };
}

function axisRows(items: Array<{ en: string; zh: string; value: number }>): string {
  const peak = Math.max(1, ...items.map((item) => item.value));
  return items
    .map(
      (item) =>
        `<li><span>${i18n(item.en, item.zh)}</span><span class="v04-axis-track"><span style="width:${Math.round((item.value / peak) * 100)}%"></span></span><strong>${item.value}</strong></li>`
    )
    .join("");
}

function planDescription(
  kind: "session" | "episode",
  plan: DashboardCompactionPlanPreview
): { titleEn: string; titleZh: string; bodyEn: string; bodyZh: string } {
  const count = plan.related_records.total;
  const itemEn = `${count} saved ${count === 1 ? "item" : "items"}`;
  const itemZh = `${count} 条已保存内容`;
  const itemWithVerbEn = `${itemEn} ${count === 1 ? "is" : "are"}`;
  if (kind === "session") {
    if (plan.status === "ready") {
      return {
        titleEn: "Organize one work session",
        titleZh: "整理一次工作记录",
        bodyEn: `Moryn can organize ${itemEn} from the same session into one session note. The originals remain available.`,
        bodyZh: `Moryn 可以把同一次工作的 ${itemZh}整理成一条会话记录，原内容仍会保留。`
      };
    }
    return {
      titleEn: "Keep this work session as-is",
      titleZh: "暂时保留这次工作记录",
      bodyEn: `${itemWithVerbEn} being left unchanged until Moryn has enough confirmation to organize safely.`,
      bodyZh: `这 ${itemZh}会保持原样，直到有足够信息确认可以安全整理。`
    };
  }
  if (plan.status === "ready") {
    return {
      titleEn: "Combine completed session notes",
      titleZh: "汇总多个已完成会话",
      bodyEn: `Moryn can combine ${itemEn} into one period summary. Older source notes remain recoverable.`,
      bodyZh: `Moryn 可以把${itemZh}汇总成一条阶段总结，较旧的来源记录仍可恢复。`
    };
  }
  if (plan.status === "deferred") {
    return {
      titleEn: "Keep recent session notes separate",
      titleZh: "暂时分别保留这些会话记录",
      bodyEn: `${itemWithVerbEn} still recent or unfinished. Moryn will wait before combining them.`,
      bodyZh: `这 ${itemZh}仍较新或尚未完成，Moryn 会等一等再考虑汇总。`
    };
  }
  return {
    titleEn: "Do not combine these session notes yet",
    titleZh: "暂不汇总这些会话记录",
    bodyEn: `${itemWithVerbEn} being left unchanged until Moryn has enough confirmation to combine safely.`,
    bodyZh: `这 ${itemZh}会保持原样，直到有足够信息确认可以安全汇总。`
  };
}

function relatedRecordButtons(
  plan: DashboardCompactionPlanPreview,
  recordsById: ReadonlyMap<string, DashboardRecordSummary>
): string {
  const records = plan.related_records.record_ids
    .map((recordId) => recordsById.get(recordId))
    .filter((record): record is DashboardRecordSummary => record !== undefined)
    .slice(0, RELATED_RECORD_RENDER_LIMIT);
  if (records.length === 0) {
    return `<p class="v04-source-empty">${i18n(
      "Related content is not shown under the current privacy settings.",
      "相关内容未在当前隐私设置下展示。"
    )}</p>`;
  }
  const buttons = records
    .map((record) => {
      const kind = recordKindCopy(record.kind);
      const state = recordStateCopy(record.state);
      const body = clip(record.text || `${record.kind} · ${record.type}`, 190);
      const metaEn = `${kind.en} · ${state.en} · updated ${record.updated_at.slice(0, 10)}`;
      const metaZh = `${kind.zh} · ${state.zh} · 更新于 ${record.updated_at.slice(0, 10)}`;
      return `<button type="button" class="v04-source" data-v04-source data-drawer-target="${escapeHtml(dashboardDrawerId("record", record.id))}" aria-haspopup="dialog">
        <strong>${escapeHtml(body)}</strong>
        <span data-i18n-en="${escapeHtml(metaEn)}" data-i18n-zh="${escapeHtml(metaZh)}">${escapeHtml(metaEn)}</span>
        <small>${i18n("Open content and recent changes", "查看正文与近期变更")}</small>
      </button>`;
    })
    .join("");
  const notShown = Math.max(0, plan.related_records.visible - records.length);
  const notes = [
    ...(notShown > 0
      ? [
          i18n(
            `${notShown} more visible ${notShown === 1 ? "item is" : "items are"} not shown in this preview.`,
            `另有 ${notShown} 条可见内容未在此预览中展开。`
          )
        ]
      : []),
    ...(plan.related_records.hidden > 0
      ? [
          i18n(
            `${plan.related_records.hidden} related ${plan.related_records.hidden === 1 ? "item is" : "items are"} hidden by the current privacy settings.`,
            `${plan.related_records.hidden} 条相关内容受当前隐私设置保护，未展示。`
          )
        ]
      : [])
  ].join(" ");
  return `<div class="v04-source-list">${buttons}</div>${notes ? `<p class="v04-source-note">${notes}</p>` : ""}`;
}

function renderPlanTechnicalDetails(plan: DashboardCompactionPlanPreview): string {
  const privacy = privacyCopy(plan.privacy_boundary);
  const codes = [...plan.review_codes, ...plan.deferred_codes];
  return `<details class="v04-plan-technical">
    <summary>${i18n("Why Moryn reached this result", "查看判断依据（高级）")}</summary>
    <dl class="v04-details">
      <div><dt>${i18n("Original content included", "原内容是否完整覆盖")}</dt><dd>${plan.coverage.covered_records}/${plan.coverage.source_records} · ${percent(plan.coverage.ratio)}</dd></div>
      <div><dt>${i18n("Estimated working-set reduction", "预计减少的日常上下文")}</dt><dd>${integer(plan.token_estimate.reducible)} token</dd></div>
      <div><dt>${i18n("Visibility boundary", "可见性边界")}</dt><dd data-i18n-en="${escapeHtml(privacy.en)}" data-i18n-zh="${escapeHtml(privacy.zh)}">${escapeHtml(privacy.en)}</dd></div>
      <div><dt>${i18n("Plan ID", "计划 ID")}</dt><dd>${escapeHtml(shortId(plan.plan_id))}</dd></div>
      ${codes.length > 0 ? `<div><dt>${i18n("Diagnostic codes", "诊断代码")}</dt><dd>${escapeHtml(codes.join(", "))}</dd></div>` : ""}
    </dl>
  </details>`;
}

function renderPlanCard(
  kind: "session" | "episode",
  plan: DashboardCompactionPlanPreview,
  recordsById: ReadonlyMap<string, DashboardRecordSummary>
): string {
  const status = statusCopy(plan.status);
  const copy = planDescription(kind, plan);
  return `<article class="v04-card v04-plan-card">
    <div class="v04-card-head"><div><h3>${i18n(copy.titleEn, copy.titleZh)}</h3><p data-i18n-en="${escapeHtml(copy.bodyEn)}" data-i18n-zh="${escapeHtml(copy.bodyZh)}">${escapeHtml(copy.bodyEn)}</p></div><span class="v04-status v04-status-${status.css}" data-i18n-en="${escapeHtml(status.en)}" data-i18n-zh="${escapeHtml(status.zh)}">${escapeHtml(status.en)}</span></div>
    ${relatedRecordButtons(plan, recordsById)}
    ${renderPlanTechnicalDetails(plan)}
  </article>`;
}

function visiblePlans(data: DashboardMemoryMaintenance): Array<{
  kind: "session" | "episode";
  plan: DashboardCompactionPlanPreview;
}> {
  const plans = [
    ...data.session_fold.plans.map((plan) => ({ kind: "session" as const, plan })),
    ...data.episode_rollup.plans.map((plan) => ({ kind: "episode" as const, plan }))
  ].filter(({ plan }) => plan.related_records.visible > 0);
  const statusRank: Record<DashboardCompactionPlanPreview["status"], number> = {
    ready: 0,
    review_required: 1,
    deferred: 2
  };
  return plans.sort(
    (left, right) =>
      statusRank[left.plan.status] - statusRank[right.plan.status] ||
      left.plan.plan_id.localeCompare(right.plan.plan_id)
  );
}

export function renderedPlanSourceRecords(
  data: DashboardMemoryMaintenance,
  visibleRecords: readonly DashboardRecordSummary[]
): DashboardRecordSummary[] {
  const recordsById = new Map(visibleRecords.map((record) => [record.id, record]));
  return visiblePlans(data)
    .slice(0, PLAN_RENDER_LIMIT)
    .flatMap(({ plan }) =>
      plan.related_records.record_ids
        .map((recordId) => recordsById.get(recordId))
        .filter((record): record is DashboardRecordSummary => record !== undefined)
        .slice(0, RELATED_RECORD_RENDER_LIMIT)
    );
}

function maintenanceSummary(
  visibleRecordCount: number,
  plans: Array<{ plan: DashboardCompactionPlanPreview }>
): { titleEn: string; titleZh: string; bodyEn: string; bodyZh: string } {
  const ready = plans.filter(({ plan }) => plan.status === "ready").length;
  const waiting = plans.length - ready;
  const savedEn = `${visibleRecordCount} saved ${visibleRecordCount === 1 ? "item is" : "items are"} in this scope.`;
  const savedZh = `当前范围内有 ${visibleRecordCount} 条已保存内容。`;
  if (plans.length === 0) {
    return {
      titleEn: "Your memories are ready to use",
      titleZh: "记忆可以正常使用",
      bodyEn: `${savedEn} There is nothing to organize or confirm right now.`,
      bodyZh: `${savedZh}目前没有需要整理或确认的内容。`
    };
  }
  if (ready === 0) {
    return {
      titleEn: "Moryn is leaving these memories unchanged",
      titleZh: "Moryn 暂时不会整理这些记忆",
      bodyEn: `${savedEn} ${waiting} ${waiting === 1 ? "group needs" : "groups need"} more confirmation before Moryn can organize safely.`,
      bodyZh: `${savedZh}有 ${waiting} 组内容需要进一步确认，当前会保持原样。`
    };
  }
  return {
    titleEn: "Moryn found memories that can be organized",
    titleZh: "Moryn 找到了可以整理的记忆",
    bodyEn: `${savedEn} ${ready} ${ready === 1 ? "group can" : "groups can"} be organized safely${waiting > 0 ? `; ${waiting} will remain unchanged` : ""}. This page only previews the result.`,
    bodyZh: `${savedZh}其中 ${ready} 组可以安全整理${waiting > 0 ? `，${waiting} 组会保持原样` : ""}。此页面只展示预览，不会执行修改。`
  };
}

export function renderMemoryMaintenance(
  data: DashboardMemoryMaintenance,
  visibleRecords: readonly DashboardRecordSummary[] = []
): string {
  const recordsById = new Map(visibleRecords.map((record) => [record.id, record]));
  const plans = visiblePlans(data);
  const summary = maintenanceSummary(visibleRecords.length, plans);
  const layers = [
    { en: "Original notes (L0)", zh: "原始笔记（L0）", value: data.inventory.layers.L0 },
    { en: "Session summaries (L1)", zh: "会话总结（L1）", value: data.inventory.layers.L1 },
    { en: "Facts and processes (L2)", zh: "事实与流程（L2）", value: data.inventory.layers.L2 },
    { en: "Long-term rules and identity (L3)", zh: "长期规则与身份（L3）", value: data.inventory.layers.L3 }
  ];
  const tiers = [
    { en: "Usually kept close at hand (hot)", zh: "通常优先取用（hot）", value: data.inventory.tiers.hot },
    { en: "Normally available (warm)", zh: "正常保留（warm）", value: data.inventory.tiers.warm },
    { en: "Available through search (cold)", zh: "仅搜索时使用（cold）", value: data.inventory.tiers.cold },
    { en: "Removed from the working view (purged)", zh: "已移出工作视图（purged）", value: data.inventory.tiers.purged }
  ];
  const renderedPlans = plans
    .slice(0, PLAN_RENDER_LIMIT)
    .map(({ kind, plan }) => renderPlanCard(kind, plan, recordsById))
    .join("");
  return `<section class="v04-section" data-memory-maintenance>
    <div class="v04-outcome" data-v04-summary>
      <div class="editorial-eyebrow">${i18n("Memory status", "记忆状态")}</div>
      <h2>${i18n(summary.titleEn, summary.titleZh)}</h2>
      <p data-i18n-en="${escapeHtml(summary.bodyEn)}" data-i18n-zh="${escapeHtml(summary.bodyZh)}">${escapeHtml(summary.bodyEn)}</p>
      <span class="v04-mode">${i18n("Read only", "只读")}</span>
    </div>
    ${renderedPlans ? `<div class="v04-plan-list">${renderedPlans}</div>` : ""}
    ${plans.length > PLAN_RENDER_LIMIT ? `<p class="v04-more">${i18n(`Showing ${PLAN_RENDER_LIMIT} of ${plans.length} suggestions.`, `显示 ${plans.length} 条建议中的 ${PLAN_RENDER_LIMIT} 条。`)}</p>` : ""}
    <details class="v04-diagnostics" data-v04-diagnostics>
      <summary><span>${i18n("How Moryn stores and organizes memory", "Moryn 如何保存和整理记忆")}</span><small>${i18n("Advanced details", "高级诊断")}</small></summary>
      <div class="v04-diagnostics-body">
        <div class="v04-safety-note"><strong>${i18n("Nothing is changed here.", "这里不会修改任何内容。")}</strong><span>${i18n("Organization previews retain their source history and never imply physical deletion.", "整理预览会保留来源历史，也不代表物理删除。")}</span></div>
        <div class="v04-metrics">
          <div><span>${i18n("Inventory records", "库存记录数")}</span><strong>${integer(data.inventory.records)}</strong></div>
          <div><span>${i18n("Stored-content estimate", "保存内容估算")}</span><strong>${integer(data.tokens.total)}</strong></div>
          <div><span>${i18n("Normally available estimate", "日常可用内容估算")}</span><strong>${integer(data.tokens.active_working_set)}</strong></div>
          <div><span>${i18n("Potential reduction", "预计可减少")}</span><strong>${integer(data.tokens.reducible)}</strong></div>
        </div>
        <div class="v04-axis-grid">
          <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("What kind of memory it is", "内容被提炼到什么程度")}</h3><p>${i18n("L0-L3 are internal labels; the plain-language names explain what each level contains.", "L0-L3 是内部代号，人话名称说明每一层实际保存什么。")}</p></div></div><ul class="v04-axis-list">${axisRows(layers)}</ul></article>
          <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("When it is normally used", "这些内容通常何时使用")}</h3><p>${i18n("Older searchable content is still retained and can be opened.", "较旧、仅搜索时使用的内容仍然保留，也可以打开查看。")}</p></div></div><ul class="v04-axis-list">${axisRows(tiers)}</ul></article>
        </div>
        <p class="v04-footnote">${i18n("Token figures compare stored working-set content. They are not the size of one model request or a billing estimate.", "token 数字用于比较存储中的工作内容，不代表单次发送给模型的上下文大小，也不是计费估算。")}</p>
      </div>
    </details>
  </section>`;
}

function subjectLabel(profile: DashboardSoulProfile): string {
  return `${profile.subject.kind} · ${profile.subject.subject_id}`;
}

function persistenceCopy(profile: DashboardSoulProfile): { en: string; zh: string } {
  if (profile.persistence.local_saved && profile.persistence.personal_sync_saved) {
    return { en: "Saved here and in the portable copy", zh: "已保存在本机和可迁移副本中" };
  }
  if (profile.persistence.local_saved) return { en: "Saved on this device", zh: "保存在本机" };
  if (profile.persistence.personal_sync_saved) return { en: "Portable copy saved", zh: "已保存可迁移副本" };
  return { en: "Only status information is available", zh: "仅有状态信息" };
}

function profileRows(profiles: DashboardSoulProfile[]): string {
  return profiles
    .slice(0, 12)
    .map((profile) => {
      const persistence = persistenceCopy(profile);
      const head = profile.active_revision_id ?? profile.head_revision_ids.at(-1);
      const state = profile.conflicted
        ? { en: "Needs review", zh: "需要检查", css: "review" }
        : profile.selection_status === "active"
          ? { en: "In use", zh: "正在使用", css: "ready" }
          : profile.selection_status === "using_last_known_good"
            ? { en: "Using last safe version", zh: "使用上一个安全版本", css: "deferred" }
            : { en: "Draft", zh: "草稿", css: "neutral" };
      return `<tr>
        <td><strong>${escapeHtml(subjectLabel(profile))}</strong><small title="${escapeHtml(profile.profile_id)}">${escapeHtml(shortId(profile.profile_id))}</small></td>
        <td><span class="v04-status v04-status-${state.css}" data-i18n-en="${escapeHtml(state.en)}" data-i18n-zh="${escapeHtml(state.zh)}">${escapeHtml(state.en)}</span><small title="${escapeHtml(head)}">${escapeHtml(shortId(head))}</small></td>
        <td><span>${profile.revision_count}</span><small>${profile.states.draft} draft · ${profile.states.active} active · ${profile.states.conflicted} conflict</small></td>
        <td><span data-i18n-en="${escapeHtml(persistence.en)}" data-i18n-zh="${escapeHtml(persistence.zh)}">${escapeHtml(persistence.en)}</span></td>
        <td><span>${profile.rollback.available ? i18n("Available", "可回到旧版本") : "—"}</span><small>${i18n("confirmation required", "需要确认")}</small></td>
      </tr>`;
    })
    .join("");
}

function soulCategoryCopy(category: DashboardSoulItem["category"]): { en: string; zh: string } {
  if (category === "identity") return { en: "Identity", zh: "身份定位" };
  if (category === "mission") return { en: "Goal", zh: "目标" };
  if (category === "value") return { en: "Working principle", zh: "工作原则" };
  if (category === "boundary") return { en: "Boundary", zh: "边界" };
  if (category === "communication") return { en: "Communication", zh: "沟通方式" };
  if (category === "decision_style") return { en: "Decision style", zh: "决策方式" };
  return { en: "Collaboration", zh: "协作方式" };
}

function soulScopeCopy(scope: DashboardSoulItem["scope"]): { en: string; zh: string } {
  if (scope.kind === "global") return { en: "Applies across projects", zh: "适用于所有项目" };
  return { en: `Applies to project ${scope.project_id}`, zh: `适用于项目 ${scope.project_id}` };
}

function soulSubjectCopy(subject: DashboardSoulItem["subject"]): { en: string; zh: string } {
  const name = subject.display_name?.trim() || subject.subject_id;
  if (subject.kind === "user") return { en: `Your preference · ${name}`, zh: `你的偏好 · ${name}` };
  return { en: `Assistant preference · ${name}`, zh: `助手偏好 · ${name}` };
}

function soulItemStatusCopy(status: DashboardSoulItem["status"]): { en: string; zh: string; css: string } {
  if (status === "using_last_known_good") {
    return { en: "Using last safe version", zh: "使用上一个安全版本", css: "deferred" };
  }
  return { en: "In use", zh: "正在使用", css: "ready" };
}

function renderSoulItems(items: readonly DashboardSoulItem[]): string {
  if (items.length === 0) {
    return `<p class="v04-empty">${i18n(
      "No portable preference text is currently in use. Device-only preferences remain hidden.",
      "当前没有正在使用的可迁移偏好正文；仅本机偏好仍保持隐藏。"
    )}</p>`;
  }
  return `<div class="v04-plan-list">${items
    .map((item) => {
      const category = soulCategoryCopy(item.category);
      const scope = soulScopeCopy(item.scope);
      const subject = soulSubjectCopy(item.subject);
      const status = soulItemStatusCopy(item.status);
      return `<article class="v04-card v04-soul-item">
        <div class="v04-card-head"><div><div class="editorial-eyebrow">${i18n(category.en, category.zh)}</div><h3 data-i18n-en="${escapeHtml(subject.en)}" data-i18n-zh="${escapeHtml(subject.zh)}">${escapeHtml(subject.en)}</h3></div><span class="v04-status v04-status-${status.css}" data-i18n-en="${escapeHtml(status.en)}" data-i18n-zh="${escapeHtml(status.zh)}">${escapeHtml(status.en)}</span></div>
        <p class="v04-soul-item-text">${escapeHtml(item.text)}</p>
        <small data-i18n-en="${escapeHtml(scope.en)}" data-i18n-zh="${escapeHtml(scope.zh)}">${escapeHtml(scope.en)}</small>
      </article>`;
    })
    .join("")}</div>`;
}

function soulSummary(data: DashboardSoulStudio): { titleEn: string; titleZh: string; bodyEn: string; bodyZh: string } {
  if (data.summary.profiles === 0) {
    return {
      titleEn: "No collaboration preferences have been set",
      titleZh: "尚未设置协作偏好",
      bodyEn: "Moryn has no saved tone, workflow, or identity preferences to apply.",
      bodyZh: "Moryn 目前没有可应用的语气、工作方式或身份偏好。"
    };
  }
  if (data.summary.conflicted > 0) {
    return {
      titleEn: `${data.summary.conflicted} collaboration ${data.summary.conflicted === 1 ? "profile needs" : "profiles need"} review`,
      titleZh: `${data.summary.conflicted} 个协作偏好存在不同版本`,
      bodyEn:
        "Moryn keeps using the last safe version where possible and does not expose private preference text here.",
      bodyZh: "Moryn 会尽量继续使用上一个安全版本，也不会在这里显示私密偏好正文。"
    };
  }
  const omissionEn = data.compilation.omissions
    ? ` ${data.compilation.omissions} optional ${data.compilation.omissions === 1 ? "preference was" : "preferences were"} left out of the current context; the active settings remain usable.`
    : " Approved preferences are ready when an assistant asks for them.";
  const omissionZh = data.compilation.omissions
    ? `有 ${data.compilation.omissions} 条可选偏好未放入本次上下文，当前设置仍可正常使用。`
    : "已批准的偏好会在助手需要时提供。";
  return {
    titleEn: `${data.summary.active} approved preference ${data.summary.active === 1 ? "version is" : "versions are"} in use`,
    titleZh: `${data.summary.active} 个已批准的偏好版本正在生效`,
    bodyEn: `There are no version conflicts.${omissionEn}`,
    bodyZh: `当前没有版本冲突。${omissionZh}`
  };
}

export function renderSoulStudio(data: DashboardSoulStudio): string {
  const summary = soulSummary(data);
  const compilation = data.compilation.deliverable
    ? { en: "Preferences are usable", zh: "偏好可以使用", css: "ready" }
    : data.compilation.status === "not_configured"
      ? { en: "No preferences yet", zh: "尚未设置偏好", css: "neutral" }
      : { en: "Using a safe fallback", zh: "使用安全备用版本", css: "deferred" };
  const delivery = data.delivery.host_context_prepared
    ? { en: "Prepared for the assistant", zh: "已为助手准备", css: "ready" }
    : data.summary.active > 0
      ? { en: "Prepared when needed", zh: "需要时再准备", css: "neutral" }
      : { en: "Waiting for an active preference", zh: "等待生效的偏好", css: "neutral" };
  const profiles = data.profiles.length
    ? `<div class="v04-table-scroll"><table class="v04-table v04-soul-table"><thead><tr><th>${i18n("Applies to", "适用对象")}</th><th>${i18n("Current version", "当前版本")}</th><th>${i18n("Versions", "版本数")}</th><th>${i18n("Saved where", "保存位置")}</th><th>${i18n("Older version", "旧版本")}</th></tr></thead><tbody>${profileRows(data.profiles)}</tbody></table></div>`
    : `<p class="v04-empty">${i18n("No collaboration preference profile has been configured yet.", "尚未配置协作偏好。")}</p>`;
  return `<details class="v04-section v04-soul-disclosure" data-soul-studio open>
    <summary data-v04-soul-summary>
      <span class="v04-soul-summary-copy"><span class="editorial-eyebrow">${i18n("Collaboration preferences", "协作偏好")}</span><strong>${i18n(summary.titleEn, summary.titleZh)}</strong><small data-i18n-en="${escapeHtml(summary.bodyEn)}" data-i18n-zh="${escapeHtml(summary.bodyZh)}">${escapeHtml(summary.bodyEn)}</small></span>
      <span class="v04-disclosure-label">${i18n("Preferences shown below", "下方显示偏好正文")}</span>
    </summary>
    <div class="v04-soul-body">
      <div class="v04-safety-note"><strong>${i18n("Only portable preferences in use are shown.", "这里只显示正在使用的可迁移偏好。")}</strong><span>${i18n("Device-only preference text stays hidden, including when private records are visible elsewhere.", "仅本机偏好正文始终隐藏，即使其他区域允许查看私密记录也不会显示。")}</span></div>
      ${renderSoulItems(data.items)}
      <details class="v04-diagnostics v04-soul-diagnostics" data-v04-soul-diagnostics>
        <summary><span>${i18n("Version and delivery diagnostics", "版本与交付诊断")}</span><small>${i18n("Advanced details", "高级详情")}</small></summary>
        <div class="v04-diagnostics-body">
          <div class="v04-delivery-grid">
            <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("What Moryn can use", "Moryn 当前可用的设置")}</h3><p>${i18n(`${data.compilation.selected_revision_ids.length} approved version sources selected.`, `已选择 ${data.compilation.selected_revision_ids.length} 个批准版本来源。`)}</p></div><span class="v04-status v04-status-${compilation.css}" data-i18n-en="${escapeHtml(compilation.en)}" data-i18n-zh="${escapeHtml(compilation.zh)}">${escapeHtml(compilation.en)}</span></div></article>
            <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Availability to assistants", "对助手的可用状态")}</h3><p>${i18n("Moryn prepares these settings when a supported assistant starts. No preparation yet is normal.", "受支持的助手启动时，Moryn 才会准备这些设置；当前尚未准备也属于正常状态。")}</p></div><span class="v04-status v04-status-${delivery.css}" data-i18n-en="${escapeHtml(delivery.en)}" data-i18n-zh="${escapeHtml(delivery.zh)}">${escapeHtml(delivery.en)}</span></div></article>
          </div>
          <div class="v04-metrics v04-soul-metrics">
            <div><span>${i18n("Preference profiles", "偏好配置")}</span><strong>${data.summary.profiles}</strong></div>
            <div><span>${i18n("Draft versions", "草稿版本")}</span><strong>${data.summary.draft}</strong></div>
            <div><span>${i18n("Active versions", "生效版本")}</span><strong>${data.summary.active}</strong></div>
            <div><span>${i18n("Version conflicts", "版本冲突")}</span><strong>${data.summary.conflicted}</strong></div>
          </div>
          <div class="v04-delivery-grid">
            <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Effective Soul", "有效 Soul")}</h3><p>${i18n("Internal compilation metadata only.", "仅显示内部编译元数据。")}</p></div></div><dl class="v04-details"><div><dt>${i18n("Raw status", "原始状态")}</dt><dd>${escapeHtml(data.compilation.status)}</dd></div><div><dt>${i18n("Selected revisions", "选中版本")}</dt><dd>${data.compilation.selected_revision_ids.length}</dd></div><div><dt>${i18n("Omissions / conflicts", "省略 / 冲突")}</dt><dd>${data.compilation.omissions} / ${data.compilation.conflicts}</dd></div></dl></article>
            <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Host context", "Host 上下文")}</h3><p>${i18n("Preparation receipts do not prove model obedience.", "准备凭证不代表模型一定遵从。")}</p></div></div><dl class="v04-details"><div><dt>${i18n("Current receipts", "当前凭证")}</dt><dd>${data.delivery.current_receipts}</dd></div><div><dt>${i18n("Latest host", "最近 Host")}</dt><dd>${escapeHtml(data.delivery.latest?.host ?? "—")}</dd></div><div><dt>${i18n("Latest event", "最近事件")}</dt><dd>${escapeHtml(data.delivery.latest?.event ?? "—")}</dd></div></dl></article>
          </div>
          <article class="v04-card v04-profile-card"><div class="v04-card-head"><div><h3>${i18n("Profiles and revisions", "配置与版本")}</h3><p>${i18n("Local-only preference text is never rendered here.", "仅本地保存的偏好正文不会在这里显示。")}</p></div><span class="v04-count">${data.summary.revisions}</span></div>${profiles}</article>
        </div>
      </details>
    </div>
  </details>`;
}

export function renderDashboardV04MemoryPage(
  memoryMaintenance: DashboardMemoryMaintenance,
  soulStudio: DashboardSoulStudio,
  visibleRecords: readonly DashboardRecordSummary[] = []
): string {
  return `<div class="v04-dashboard-sections">${renderMemoryMaintenance(memoryMaintenance, visibleRecords)}${renderSoulStudio(soulStudio)}</div>`;
}
