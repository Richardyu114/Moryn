import type {
  DashboardCompactionPlanPreview,
  DashboardMemoryMaintenance,
  DashboardSoulProfile,
  DashboardSoulStudio
} from "./dashboard-v04.js";

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

function statusCopy(status: DashboardCompactionPlanPreview["status"]): { en: string; zh: string; css: string } {
  if (status === "ready") return { en: "Ready", zh: "可执行", css: "ready" };
  if (status === "deferred") return { en: "Deferred", zh: "已延后", css: "deferred" };
  return { en: "Review", zh: "需审查", css: "review" };
}

function planRows(plans: DashboardCompactionPlanPreview[]): string {
  return plans
    .slice(0, 8)
    .map((plan) => {
      const status = statusCopy(plan.status);
      const scope = `${plan.scope.kind} · ${plan.scope.key}`;
      return `<tr>
        <td><strong>${escapeHtml(scope)}</strong><small>${escapeHtml(plan.scope.project_id)}</small></td>
        <td><span class="v04-status v04-status-${status.css}" data-i18n-en="${status.en}" data-i18n-zh="${status.zh}">${status.en}</span></td>
        <td><span>${percent(plan.coverage.ratio)}</span><small>${plan.coverage.covered_records}/${plan.coverage.source_records}</small></td>
        <td><span>${integer(plan.token_estimate.reducible)}</span><small>${i18n("estimated tokens", "估算 token")}</small></td>
        <td><span>${escapeHtml(plan.privacy_boundary)}</span><small>${i18n("metadata only", "仅元数据")}</small></td>
      </tr>`;
    })
    .join("");
}

function renderPlanTable(
  titleEn: string,
  titleZh: string,
  counts: { total: number; ready: number; deferred?: number; review_required: number },
  plans: DashboardCompactionPlanPreview[]
): string {
  const queue = [
    `${counts.ready} ready`,
    ...(counts.deferred ? [`${counts.deferred} deferred`] : []),
    ...(counts.review_required ? [`${counts.review_required} review`] : [])
  ].join(" · ");
  const queueZh = [
    `${counts.ready} 个可执行`,
    ...(counts.deferred ? [`${counts.deferred} 个延后`] : []),
    ...(counts.review_required ? [`${counts.review_required} 个需审查`] : [])
  ].join(" · ");
  const body = plans.length
    ? `<div class="v04-table-scroll"><table class="v04-table">
        <thead><tr><th>${i18n("Scope", "范围")}</th><th>${i18n("Status", "状态")}</th><th>${i18n("Coverage", "覆盖率")}</th><th>${i18n("Reducible", "可减少")}</th><th>${i18n("Privacy", "隐私")}</th></tr></thead>
        <tbody>${planRows(plans)}</tbody>
      </table></div>${plans.length > 8 ? `<p class="v04-more">${i18n(`Showing 8 of ${plans.length} previews`, `显示 ${plans.length} 个预览中的 8 个`)}</p>` : ""}`
    : `<p class="v04-empty">${i18n("No eligible groups right now.", "当前没有符合条件的分组。")}</p>`;
  return `<article class="v04-card v04-plan-card">
    <div class="v04-card-head"><div><h3>${i18n(titleEn, titleZh)}</h3><p data-i18n-en="${escapeHtml(queue)}" data-i18n-zh="${escapeHtml(queueZh)}">${escapeHtml(queue)}</p></div><span class="v04-count">${counts.total}</span></div>
    ${body}
  </article>`;
}

function axisRows(items: Array<{ key: string; en: string; zh: string; value: number }>): string {
  const peak = Math.max(1, ...items.map((item) => item.value));
  return items
    .map(
      (item) =>
        `<li><span>${i18n(item.en, item.zh)}</span><span class="v04-axis-track"><span style="width:${Math.round((item.value / peak) * 100)}%"></span></span><strong>${item.value}</strong></li>`
    )
    .join("");
}

export function renderMemoryMaintenance(data: DashboardMemoryMaintenance): string {
  const layers = [
    { key: "L0", en: "L0 Evidence", zh: "L0 原始证据", value: data.inventory.layers.L0 },
    { key: "L1", en: "L1 Episodic", zh: "L1 情景记忆", value: data.inventory.layers.L1 },
    { key: "L2", en: "L2 Knowledge", zh: "L2 语义与流程", value: data.inventory.layers.L2 },
    { key: "L3", en: "L3 Identity", zh: "L3 身份记忆", value: data.inventory.layers.L3 }
  ];
  const tiers = [
    { key: "hot", en: "Hot", zh: "热记忆", value: data.inventory.tiers.hot },
    { key: "warm", en: "Warm", zh: "温记忆", value: data.inventory.tiers.warm },
    { key: "cold", en: "Cold", zh: "冷记忆", value: data.inventory.tiers.cold },
    { key: "purged", en: "Purged", zh: "已清除", value: data.inventory.tiers.purged }
  ];
  return `<section class="v04-section" data-memory-maintenance>
    <div class="v04-section-heading"><div><div class="editorial-eyebrow">${i18n("Memory health", "记忆健康")}</div><h2>${i18n("Memory Maintenance", "记忆维护")}</h2><p>${i18n("A safe preview of memory layers, retention, and possible compaction.", "安全预览记忆层级、保留状态与可压缩空间。")}</p></div><span class="v04-mode">${i18n("Preview only", "仅预览")}</span></div>
    <div class="v04-safety-note"><strong>${i18n("Nothing is changed here.", "这里不会修改任何内容。")}</strong><span>${i18n("Coverage and privacy are checked before apply; sync impact begins only after an append-only operation. Undo remains available while source history is retained.", "执行前会校验覆盖率与隐私；只有追加式操作执行后才会影响同步。只要来源历史仍保留，就可以恢复。")}</span></div>
    <div class="v04-metrics">
      <div><span>${i18n("Records", "记录数")}</span><strong>${integer(data.inventory.records)}</strong></div>
      <div><span>${i18n("Estimated tokens", "估算 token")}</span><strong>${integer(data.tokens.total)}</strong></div>
      <div><span>${i18n("Active working set", "活跃工作集")}</span><strong>${integer(data.tokens.active_working_set)}</strong></div>
      <div><span>${i18n("Reducible now", "当前可减少")}</span><strong>${integer(data.tokens.reducible)}</strong></div>
    </div>
    <div class="v04-axis-grid">
      <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Memory layers", "记忆层级")}</h3><p>${i18n("Evidence becomes more distilled toward identity.", "从证据逐步提炼到身份记忆。")}</p></div></div><ul class="v04-axis-list">${axisRows(layers)}</ul></article>
      <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Retention tiers", "保留层级")}</h3><p>${i18n("Cold is reversible; purged is never implied by archive.", "冷存储可恢复；归档绝不等同于清除。")}</p></div></div><ul class="v04-axis-list">${axisRows(tiers)}</ul></article>
    </div>
    <div class="v04-plan-grid">
      ${renderPlanTable("Session Fold", "会话折叠", data.session_fold, data.session_fold.plans)}
      ${renderPlanTable("Episode Rollup", "情景汇总", data.episode_rollup, data.episode_rollup.plans)}
    </div>
    <p class="v04-footnote">${i18n("Token reduction is a working-set estimate. Preview never deletes physical storage.", "token 减少量是工作集估算值；预览不会删除物理存储。")}</p>
  </section>`;
}

function subjectLabel(profile: DashboardSoulProfile): string {
  return `${profile.subject.kind} · ${profile.subject.subject_id}`;
}

function persistenceCopy(profile: DashboardSoulProfile): { en: string; zh: string } {
  if (profile.persistence.local_saved && profile.persistence.personal_sync_saved) {
    return { en: "Local full + portable projection saved", zh: "本地完整版本 + 可同步投影已保存" };
  }
  if (profile.persistence.local_saved) return { en: "Local only", zh: "仅本地" };
  if (profile.persistence.personal_sync_saved) {
    return { en: "Portable projection saved locally", zh: "可同步投影已本地保存" };
  }
  return { en: "Metadata only", zh: "仅元数据" };
}

function profileRows(profiles: DashboardSoulProfile[]): string {
  return profiles
    .slice(0, 12)
    .map((profile) => {
      const persistence = persistenceCopy(profile);
      const head = profile.active_revision_id ?? profile.head_revision_ids.at(-1);
      const state = profile.conflicted
        ? { en: "Conflict", zh: "冲突", css: "review" }
        : profile.selection_status === "active"
          ? { en: "Active", zh: "生效中", css: "ready" }
          : profile.selection_status === "using_last_known_good"
            ? { en: "Last known good", zh: "使用最后有效版本", css: "deferred" }
            : { en: "Draft", zh: "草稿", css: "neutral" };
      return `<tr>
        <td><strong>${escapeHtml(subjectLabel(profile))}</strong><small title="${escapeHtml(profile.profile_id)}">${escapeHtml(shortId(profile.profile_id))}</small></td>
        <td><span class="v04-status v04-status-${state.css}" data-i18n-en="${state.en}" data-i18n-zh="${state.zh}">${state.en}</span><small title="${escapeHtml(head)}">${escapeHtml(shortId(head))}</small></td>
        <td><span>${profile.revision_count}</span><small>${profile.states.draft} draft · ${profile.states.active} active · ${profile.states.conflicted} conflict</small></td>
        <td><span data-i18n-en="${escapeHtml(persistence.en)}" data-i18n-zh="${escapeHtml(persistence.zh)}">${escapeHtml(persistence.en)}</span><small>${profile.persistence.local_saved ? "local_saved" : ""}${profile.persistence.local_saved && profile.persistence.personal_sync_saved ? " · " : ""}${profile.persistence.personal_sync_saved ? "personal_sync_saved" : ""}</small></td>
        <td><span>${profile.rollback.available ? i18n("Available", "可回滚") : "—"}</span><small>${i18n("confirmation required", "需要确认")}</small></td>
      </tr>`;
    })
    .join("");
}

export function renderSoulStudio(data: DashboardSoulStudio): string {
  const compilationReceipt = data.compilation.receipt.current
    ? { en: "Receipt current", zh: "编译凭证有效", css: "ready" }
    : data.compilation.status === "not_configured"
      ? { en: "Not configured", zh: "尚未配置", css: "neutral" }
      : { en: "Receipt pending", zh: "等待编译凭证", css: "deferred" };
  const delivery = data.delivery.host_context_prepared
    ? { en: "Hook output prepared", zh: "Hook 输出已准备", css: "ready" }
    : data.summary.active > 0
      ? { en: "Not yet prepared", zh: "尚未准备", css: "deferred" }
      : { en: "Waiting for active Soul", zh: "等待生效的 Soul", css: "neutral" };
  const profiles = data.profiles.length
    ? `<div class="v04-table-scroll"><table class="v04-table v04-soul-table"><thead><tr><th>${i18n("Profile", "Profile")}</th><th>${i18n("Head", "当前版本")}</th><th>${i18n("Revisions", "版本")}</th><th>${i18n("Persistence", "保存方式")}</th><th>${i18n("Rollback", "回滚")}</th></tr></thead><tbody>${profileRows(data.profiles)}</tbody></table></div>`
    : `<p class="v04-empty">${i18n("No Soul profile has been configured yet.", "尚未配置 Soul Profile。")}</p>`;
  return `<section class="v04-section" data-soul-studio>
    <div class="v04-section-heading"><div><div class="editorial-eyebrow">${i18n("Portable identity", "可迁移身份")}</div><h2>${i18n("Soul Studio", "Soul 工作室")}</h2><p>${i18n("Version, sync, compilation, and host-context preparation without exposing clause text.", "查看版本、同步、编译与 Host 上下文准备状态，不暴露条款正文。")}</p></div><span class="v04-mode">${i18n("Metadata only", "仅元数据")}</span></div>
    <div class="v04-metrics v04-soul-metrics">
      <div><span>${i18n("Profiles", "Profiles")}</span><strong>${data.summary.profiles}</strong></div>
      <div><span>${i18n("Draft", "草稿")}</span><strong>${data.summary.draft}</strong></div>
      <div><span>${i18n("Active", "生效")}</span><strong>${data.summary.active}</strong></div>
      <div><span>${i18n("Conflicts", "冲突")}</span><strong>${data.summary.conflicted}</strong></div>
    </div>
    <div class="v04-delivery-grid">
      <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Effective Soul", "有效 Soul")}</h3><p>${i18n("Compiled from approved revision heads.", "由已批准的当前版本编译。")}</p></div><span class="v04-status v04-status-${compilationReceipt.css}" data-i18n-en="${compilationReceipt.en}" data-i18n-zh="${compilationReceipt.zh}">${compilationReceipt.en}</span></div><dl class="v04-details"><div><dt>${i18n("Status", "状态")}</dt><dd>${escapeHtml(data.compilation.status)}</dd></div><div><dt>${i18n("Selected revisions", "选中版本")}</dt><dd>${data.compilation.selected_revision_ids.length}</dd></div><div><dt>${i18n("Omissions / conflicts", "省略 / 冲突")}</dt><dd>${data.compilation.omissions} / ${data.compilation.conflicts}</dd></div></dl></article>
      <article class="v04-card"><div class="v04-card-head"><div><h3>${i18n("Host context", "Host 上下文")}</h3><p>${i18n("A receipt proves hook output was prepared, not transport acknowledgement or model obedience.", "凭证只证明 Hook 输出已准备，不代表 Host 已确认接收或模型遵从。")}</p></div><span class="v04-status v04-status-${delivery.css}" data-i18n-en="${delivery.en}" data-i18n-zh="${delivery.zh}">${delivery.en}</span></div><dl class="v04-details"><div><dt>${i18n("Current receipts", "当前凭证")}</dt><dd>${data.delivery.current_receipts}</dd></div><div><dt>${i18n("Latest host", "最近 Host")}</dt><dd>${escapeHtml(data.delivery.latest?.host ?? "—")}</dd></div><div><dt>${i18n("Latest event", "最近事件")}</dt><dd>${escapeHtml(data.delivery.latest?.event ?? "—")}</dd></div></dl></article>
    </div>
    <article class="v04-card v04-profile-card"><div class="v04-card-head"><div><h3>${i18n("Profiles and revisions", "Profiles 与版本")}</h3><p>${i18n("Local-only clauses remain on this device; their text is never rendered here.", "local_only 条款保留在本机，其正文不会在这里呈现。")}</p></div><span class="v04-count">${data.summary.revisions}</span></div>${profiles}</article>
  </section>`;
}

export function renderDashboardV04MemoryPage(
  memoryMaintenance: DashboardMemoryMaintenance,
  soulStudio: DashboardSoulStudio
): string {
  return `<div class="v04-dashboard-sections">${renderMemoryMaintenance(memoryMaintenance)}${renderSoulStudio(soulStudio)}</div>`;
}
