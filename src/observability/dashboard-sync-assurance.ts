import type { GitSyncStatus } from "../sync/git.js";

export const PENDING_SYNC_ATTENTION_AGE_MS = 24 * 60 * 60 * 1000;
export const PENDING_SYNC_ATTENTION_EVENT_FILES = 25;

export type DashboardSyncAssuranceState =
  | "remote_current"
  | "local_pending"
  | "remote_updates_pending"
  | "conflict"
  | "local_only"
  | "remote_unverified";

export interface DashboardSyncAssurance {
  state: DashboardSyncAssuranceState;
  headline: string;
  headline_zh: string;
  detail: string;
  detail_zh: string;
  remote_copy: {
    proof: "verified_committed_version" | "not_verified" | "not_configured";
    proof_source?: "live_observation" | "last_successful_push";
    verified_at?: string;
    durable: boolean;
    covers_all_local_content: boolean;
    reachable?: boolean;
    contains_local_commit?: boolean;
    message: string;
    message_zh: string;
  };
  local_pending: {
    present: boolean;
    /** Moryn-managed files that can affect the shared memory copy. */
    dirty_files: number;
    /** Unrelated worktree changes, exposed only as technical context. */
    unmanaged_files: number;
    event_files: number;
    untracked_event_files: number;
    added_event_files: number;
    modified_event_files: number;
    ignored_event_files: number;
    committed_ahead: number;
    oldest_pending_file_mtime?: string;
    age_basis?: "filesystem_mtime";
    age_ms?: number;
    age_label?: string;
    age_label_zh?: string;
    overdue: boolean;
    significant: boolean;
  };
  attention_required: boolean;
  attention_reasons: Array<"oldest_pending_file_modified_over_24_hours" | "many_pending_event_files">;
  technical: {
    branch?: string;
    ahead: number;
    behind: number;
    suggested_command?: string;
  };
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function pendingAge(
  oldestPendingFileMtime: string | undefined,
  nowIso: string
): Pick<
  DashboardSyncAssurance["local_pending"],
  "oldest_pending_file_mtime" | "age_basis" | "age_ms" | "age_label" | "age_label_zh" | "overdue"
> {
  if (!oldestPendingFileMtime) return { overdue: false };
  const oldestMs = Date.parse(oldestPendingFileMtime);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(oldestMs) || !Number.isFinite(nowMs) || nowMs < oldestMs) {
    return { oldest_pending_file_mtime: oldestPendingFileMtime, age_basis: "filesystem_mtime", overdue: false };
  }
  const ageMs = nowMs - oldestMs;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  const ageLabel = days >= 1 ? pluralize(days, "day") : hours >= 1 ? pluralize(hours, "hour") : "less than an hour";
  const ageLabelZh = days >= 1 ? `${days} 天` : hours >= 1 ? `${hours} 小时` : "不到 1 小时";
  return {
    oldest_pending_file_mtime: oldestPendingFileMtime,
    age_basis: "filesystem_mtime",
    age_ms: ageMs,
    age_label: ageLabel,
    age_label_zh: ageLabelZh,
    overdue: ageMs >= PENDING_SYNC_ATTENTION_AGE_MS
  };
}

function remoteCopy(sync: GitSyncStatus, pending: boolean, nowIso: string): DashboardSyncAssurance["remote_copy"] {
  if (!sync.remote) {
    return {
      proof: "not_configured",
      durable: false,
      covers_all_local_content: false,
      message: "No shared copy is connected.",
      message_zh: "尚未连接共享副本。"
    };
  }
  const observation = sync.remote_observation;
  const containsLocalCommit = observation?.reachable === true && observation.contains_local_head === true;
  const lastSuccessfulPushContainsLocalCommit =
    observation?.reachable !== true &&
    sync.last_sync?.operation === "push" &&
    isCanonicalIsoTimestamp(sync.last_sync.at) &&
    sync.last_sync?.commit !== undefined &&
    sync.last_commit !== undefined &&
    sync.last_sync.commit === sync.last_commit &&
    (sync.ahead ?? 0) === 0;
  if (containsLocalCommit || lastSuccessfulPushContainsLocalCommit) {
    const liveProof = containsLocalCommit;
    return {
      proof: "verified_committed_version",
      proof_source: liveProof ? "live_observation" : "last_successful_push",
      verified_at: liveProof ? nowIso : sync.last_sync?.at,
      durable: true,
      covers_all_local_content: !pending,
      ...(observation ? { reachable: observation.reachable } : {}),
      contains_local_commit: true,
      message: liveProof
        ? pending
          ? "The shared copy contains the previous committed version, but not the pending local changes."
          : "The shared copy was checked and contains the current local version."
        : pending
          ? "The last successful push saved the previous committed version, but pending local changes are not covered; this live check did not finish."
          : "The last successful push saved the current local version in the shared copy; this live check did not finish.",
      message_zh: liveProof
        ? pending
          ? "共享副本包含上一次已提交版本，但尚不包含本机待同步内容。"
          : "已检查共享副本，其中包含本机当前版本。"
        : pending
          ? "上次成功推送已将此前提交版本保存到共享副本，但不包含本机待同步内容；本次在线检查未能完成。"
          : "上次成功推送已将本机当前版本保存到共享副本；本次在线检查未能完成。"
    };
  }
  return {
    proof: "not_verified",
    durable: false,
    covers_all_local_content: false,
    ...(observation ? { reachable: observation.reachable } : {}),
    ...(observation?.contains_local_head !== undefined
      ? { contains_local_commit: observation.contains_local_head }
      : {}),
    message:
      observation?.reachable === false
        ? "The shared copy could not be reached, so no current remote proof is available."
        : "Moryn has not verified that the shared copy contains the current local version.",
    message_zh:
      observation?.reachable === false
        ? "目前无法连接共享副本，因此没有最新的远端保存证明。"
        : "Moryn 尚未确认共享副本包含本机当前版本。"
  };
}

function pendingCopy(
  eventFiles: number,
  dirtyFiles: number,
  ahead: number,
  remote: DashboardSyncAssurance["remote_copy"],
  ageLabel?: string,
  ageLabelZh?: string
): Pick<DashboardSyncAssurance, "headline" | "headline_zh" | "detail" | "detail_zh"> {
  const subjectEn =
    eventFiles > 0
      ? pluralize(eventFiles, "saved change")
      : dirtyFiles > 0
        ? pluralize(dirtyFiles, "local saved change")
        : pluralize(ahead, "local update");
  const subjectZh =
    eventFiles > 0
      ? `${eventFiles} 项待同步的保存变更`
      : dirtyFiles > 0
        ? `${dirtyFiles} 项本机变更`
        : `${ahead} 个本机更新`;
  const waitingEn = ageLabel ? ` The oldest pending file was last changed ${ageLabel} ago.` : "";
  const waitingZh = ageLabelZh ? `最早的待同步文件变更发生在 ${ageLabelZh}前。` : "";
  return {
    headline: `${subjectEn} ${eventFiles === 1 || (eventFiles === 0 && dirtyFiles === 1) || (eventFiles === 0 && dirtyFiles === 0 && ahead === 1) ? "is" : "are"} waiting for the shared copy`,
    headline_zh: `${subjectZh}目前只确认保存在本机，正在等待同步到共享副本`,
    detail: remote.durable
      ? `The shared copy still has the previous committed version; these newer changes do not have remote proof yet.${waitingEn}`
      : `These changes are written and available on this device, but Moryn has not proved that they reached the shared copy.${waitingEn}`,
    detail_zh: remote.durable
      ? `共享副本仍保留上一次已提交版本；这些新内容还没有远端保存证明。${waitingZh}`
      : `这些内容已写入本机、目前可用，但 Moryn 尚未确认它们已到达共享副本。${waitingZh}`
  };
}

export function buildDashboardSyncAssurance(sync: GitSyncStatus, nowIso: string): DashboardSyncAssurance {
  const dirty = sync.pending_changes;
  const dirtyFiles = dirty?.managed_files ?? dirty?.event_files ?? (sync.dirty ? 1 : 0);
  const unmanagedFiles = dirty?.unmanaged_files ?? Math.max(0, (dirty?.total_files ?? dirtyFiles) - dirtyFiles);
  const eventFiles = dirty?.event_files ?? 0;
  const ahead = sync.ahead ?? 0;
  const behind = sync.behind ?? 0;
  const localPendingPresent = dirtyFiles > 0 || ahead > 0;
  const age = pendingAge(dirty?.pending_time_complete === true ? dirty.oldest_pending_file_mtime : undefined, nowIso);
  const significant = eventFiles >= PENDING_SYNC_ATTENTION_EVENT_FILES;
  const remote = remoteCopy(sync, localPendingPresent, nowIso);
  const attentionReasons: DashboardSyncAssurance["attention_reasons"] = [
    ...(age.overdue ? (["oldest_pending_file_modified_over_24_hours"] as const) : []),
    ...(significant ? (["many_pending_event_files"] as const) : [])
  ];
  const localPending: DashboardSyncAssurance["local_pending"] = {
    present: localPendingPresent,
    dirty_files: dirtyFiles,
    unmanaged_files: unmanagedFiles,
    event_files: eventFiles,
    untracked_event_files: dirty?.untracked_event_files ?? 0,
    added_event_files: dirty?.added_event_files ?? 0,
    modified_event_files: dirty?.modified_event_files ?? 0,
    ignored_event_files: dirty?.ignored_event_files ?? 0,
    committed_ahead: ahead,
    ...age,
    significant
  };
  const technical: DashboardSyncAssurance["technical"] = {
    ...(sync.branch ? { branch: sync.branch } : {}),
    ahead,
    behind,
    ...(sync.remote ? { suggested_command: behind > 0 ? "moryn sync --pull" : "moryn sync --push" } : {})
  };
  const common = {
    remote_copy: remote,
    local_pending: localPending,
    attention_required: localPendingPresent && attentionReasons.length > 0,
    attention_reasons: attentionReasons,
    technical
  };

  if (sync.sync_state === "conflict") {
    return {
      state: "conflict",
      headline: "The shared copy needs repair",
      headline_zh: "共享副本需要修复",
      detail:
        "Saved content on this device remains available, but cross-device updates are paused until the conflict is resolved.",
      detail_zh: "本机已保存内容仍可使用，但在冲突解决前，跨设备更新会暂停。",
      ...common,
      attention_required: true
    };
  }
  if (!sync.remote) {
    return {
      state: "local_only",
      headline: "Memory is saved on this device only",
      headline_zh: "记忆仅保存在这台设备上",
      detail: "No shared copy is connected, so another device cannot recover these memories from Moryn yet.",
      detail_zh: "尚未连接共享副本，因此其他设备暂时无法通过 Moryn 恢复这些记忆。",
      ...common
    };
  }
  if (localPendingPresent) {
    return {
      state: "local_pending",
      ...pendingCopy(eventFiles, dirtyFiles, ahead, remote, age.age_label, age.age_label_zh),
      ...common
    };
  }
  if (behind > 0) {
    return {
      state: "remote_updates_pending",
      headline: `${pluralize(behind, "newer shared update")} waiting to arrive here`,
      headline_zh: `共享副本有 ${behind} 个新更新等待同步到本机`,
      detail: "This device remains usable, but it does not yet include the newest shared changes.",
      detail_zh: "本机仍可使用，但尚未包含共享副本中的最新变化。",
      ...common
    };
  }
  if (remote.covers_all_local_content && remote.reachable === true) {
    return {
      state: "remote_current",
      headline: "Everything saved here is also in the shared copy",
      headline_zh: "本机保存的内容均已进入共享副本",
      detail: "Moryn checked the shared copy and verified the current committed version.",
      detail_zh: "Moryn 已检查共享副本，并确认其中包含当前已提交版本。",
      ...common
    };
  }
  return {
    state: "remote_unverified",
    headline: remote.durable
      ? "Shared copy saved; the live check is incomplete"
      : "Local memory is ready; the shared copy is not verified",
    headline_zh: remote.durable ? "共享副本已保存；在线检查未完成" : "本机记忆可用；共享副本尚未验证",
    detail: remote.message,
    detail_zh: remote.message_zh,
    ...common
  };
}
