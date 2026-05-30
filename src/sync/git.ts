import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { StoreConfig } from "../core/config.js";
import { readStoreConfig } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";

const exec = promisify(execFile);

export const SYNC_STATUS_SELECTION_SOURCES = {
  configured: "configured",
  branch: "branch",
  remote: "remote",
  dirty: "dirty",
  sync_state: "sync_state",
  conflict: "conflict",
  conflict_file: "conflict.files_by_path.<path>",
  conflict_file_path: "conflict.files_by_path.<path>.path",
  ordered_conflict_file: "conflict.files[]",
  ahead: "ahead",
  behind: "behind",
  last_sync: "last_sync",
  last_commit: "last_commit",
  error: "error"
} as const;

export const SYNC_RESULT_SELECTION_SOURCES = {
  ok: "ok",
  committed: "committed",
  pushed: "pushed",
  pulled: "pulled",
  message: "message"
} as const;

export interface GitSyncStatus {
  configured: boolean;
  branch?: string;
  remote?: string;
  dirty?: boolean;
  sync_state?: "clean" | "dirty" | "conflict";
  conflict?: GitSyncConflictStatus;
  ahead?: number;
  behind?: number;
  last_sync?: GitLastSync;
  last_commit?: string;
  error?: string;
  selection_sources: typeof SYNC_STATUS_SELECTION_SOURCES;
}

export interface GitSyncConflictStatus {
  operation: "merge" | "rebase" | "cherry-pick" | "unknown";
  files: string[];
  files_by_path: Record<string, GitSyncConflictFileStatus>;
  safe_to_auto_resolve: boolean;
  safe_to_retry_sync: boolean;
  recommended_action: string;
}

export interface GitSyncConflictFileStatus {
  path: string;
  status: "unmerged";
  safe_to_auto_resolve: boolean;
  recommended_action: string;
}

export interface GitLastSync {
  operation: "init" | "pull" | "push";
  at: string;
  commit?: string;
}

export interface GitSyncResult {
  ok: boolean;
  committed?: boolean;
  pushed?: boolean;
  pulled?: boolean;
  message?: string;
  selection_sources: typeof SYNC_RESULT_SELECTION_SOURCES;
}

type SyncArgumentRecoveryHint =
  | {
      rejected_argument: { argument: "storePath" | "remoteUrl" | "message"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { argument: "storePath" | "remoteUrl" | "message"; value_placeholder: string };
    }
  | {
      rejected_argument: { argument: "options"; value: unknown };
      expected: { kind: "object"; required: false };
      retry_with: { argument: "options"; value_placeholder: { message: "<message>" } };
    };

class SyncArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: SyncArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: SyncArgumentRecoveryHint) {
    super(message);
    this.name = "SyncArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidSyncStringError(name: "storePath" | "remoteUrl" | "message", value: unknown): SyncArgumentError {
  return new SyncArgumentError(
    `Invalid argument: Invalid ${name}`,
    `retry sync with a non-empty ${name}`,
    {
      rejected_argument: { argument: name, value },
      expected: { kind: "non_empty_string", min_length: 1 },
      retry_with: { argument: name, value_placeholder: `<${name}>` }
    }
  );
}

function invalidSyncOptionsError(options: unknown): SyncArgumentError {
  return new SyncArgumentError(
    "Invalid argument: Invalid sync options",
    "retry sync with a valid options object",
    {
      rejected_argument: { argument: "options", value: options },
      expected: { kind: "object", required: false },
      retry_with: { argument: "options", value_placeholder: { message: "<message>" } }
    }
  );
}

function validateRequiredString(value: unknown, name: "storePath" | "remoteUrl"): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidSyncStringError(name, value);
  }
}

function validateOptionalString(value: unknown, name: "message"): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw invalidSyncStringError(name, value);
  }
}

function validateSyncOptions(options: unknown): asserts options is { message?: string } {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw invalidSyncOptionsError(options);
  }
  validateOptionalString((options as { message?: unknown }).message, "message");
}

function withSyncStatusSelectionSources(
  status: Omit<GitSyncStatus, "selection_sources">
): GitSyncStatus {
  return {
    ...status,
    selection_sources: SYNC_STATUS_SELECTION_SOURCES
  };
}

function withSyncResultSelectionSources(
  result: Omit<GitSyncResult, "selection_sources">
): GitSyncResult {
  return {
    ...result,
    selection_sources: SYNC_RESULT_SELECTION_SOURCES
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function ensureGitIdentity(storePath: string): Promise<void> {
  const hasName = await gitOk(storePath, ["config", "user.name"]);
  const hasEmail = await gitOk(storePath, ["config", "user.email"]);
  if (!hasName) await git(storePath, ["config", "user.name", "Moryn"]);
  if (!hasEmail) await git(storePath, ["config", "user.email", "moryn@example.local"]);
}

async function ensureGitIgnore(storePath: string): Promise<void> {
  await writeFile(join(storePath, ".gitignore"), "config.json\nsnapshots/\nindexes/\nstate/\n", "utf8");
}

async function writeStoreConfig(storePath: string, config: StoreConfig): Promise<void> {
  await writeFile(join(storePath, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function untrackLocalOnlyPaths(storePath: string): Promise<void> {
  await git(storePath, ["rm", "--cached", "-r", "--ignore-unmatch", "config.json", "snapshots", "indexes", "state"]);
}

async function readLastSync(storePath: string): Promise<GitLastSync | undefined> {
  const statePath = join(storePath, "state", "sync-status.json");
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as GitLastSync;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  try {
    return JSON.parse(await readFile(join(storePath, "indexes", "sync-status.json"), "utf8")) as GitLastSync;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeLastSync(storePath: string, operation: GitLastSync["operation"]): Promise<void> {
  await mkdir(join(storePath, "state"), { recursive: true });
  const commit = await git(storePath, ["rev-parse", "--short", "HEAD"]).catch(() => undefined);
  const status: GitLastSync = {
    operation,
    at: new Date().toISOString(),
    commit
  };
  await writeFile(join(storePath, "state", "sync-status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function ensureMainBranch(storePath: string): Promise<void> {
  const branch = await git(storePath, ["branch", "--show-current"]).catch(() => "");
  if (branch !== "main") {
    await git(storePath, ["checkout", "-B", "main"]);
  }
}

async function hasCommits(storePath: string): Promise<boolean> {
  return gitOk(storePath, ["rev-parse", "--verify", "HEAD"]);
}

async function hasRemoteHead(storePath: string): Promise<boolean> {
  return gitOk(storePath, ["ls-remote", "--exit-code", "--heads", "origin", "main"]);
}

async function hasStagedChanges(storePath: string): Promise<boolean> {
  return !await gitOk(storePath, ["diff", "--cached", "--quiet"]);
}

async function restoreLocalOnlyStateAfterGitUpdate(storePath: string, localConfig: StoreConfig): Promise<void> {
  await writeStoreConfig(storePath, localConfig);
  await rebuildDerivedViews(storePath);
  await ensureGitIgnore(storePath);
  await untrackLocalOnlyPaths(storePath);
  await git(storePath, ["add", ".gitignore"]);
  await ensureGitIdentity(storePath);
  if (await hasStagedChanges(storePath)) {
    await git(storePath, ["commit", "-m", "Migrate Moryn local-only files"]);
  }
}

async function ensureGitSyncConfigured(storePath: string): Promise<void> {
  if (!await gitOk(storePath, ["rev-parse", "--git-dir"])) {
    throw new Error("Sync not configured: run moryn sync init <remote>");
  }
  if (!await git(storePath, ["remote", "get-url", "origin"]).catch(() => "")) {
    throw new Error("Sync not configured: run moryn sync init <remote>");
  }
}

async function ensureRemote(storePath: string, remoteUrl: string): Promise<void> {
  const current = await git(storePath, ["remote", "get-url", "origin"]).catch(() => "");
  if (!current) {
    await git(storePath, ["remote", "add", "origin", remoteUrl]);
    return;
  }
  if (current !== remoteUrl) {
    await git(storePath, ["remote", "set-url", "origin", remoteUrl]);
  }
}

async function gitConflictStatus(storePath: string): Promise<GitSyncConflictStatus | undefined> {
  const gitDir = await git(storePath, ["rev-parse", "--git-dir"]);
  const operation =
    await pathExists(join(storePath, gitDir, "rebase-merge")) || await pathExists(join(storePath, gitDir, "rebase-apply"))
      ? "rebase"
      : await pathExists(join(storePath, gitDir, "MERGE_HEAD"))
        ? "merge"
        : await pathExists(join(storePath, gitDir, "CHERRY_PICK_HEAD"))
          ? "cherry-pick"
          : "unknown";
  const files = (await git(storePath, ["diff", "--name-only", "--diff-filter=U"]))
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
  if (operation === "unknown" && files.length === 0) return undefined;
  const recommendedAction = "resolve Git conflicts before retrying sync";
  return {
    operation,
    files,
    files_by_path: Object.fromEntries(files.map((file) => [file, {
      path: file,
      status: "unmerged",
      safe_to_auto_resolve: false,
      recommended_action: recommendedAction
    }])),
    safe_to_auto_resolve: false,
    safe_to_retry_sync: false,
    recommended_action: recommendedAction
  };
}

export async function initializeGitSync(storePath: string, remoteUrl: string): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  validateRequiredString(remoteUrl, "remoteUrl");
  const localConfig = await readStoreConfig(storePath);
  if (!await gitOk(storePath, ["rev-parse", "--git-dir"])) {
    await git(storePath, ["init"]);
  }
  await ensureGitIdentity(storePath);
  await ensureMainBranch(storePath);
  await ensureGitIgnore(storePath);
  await ensureRemote(storePath, remoteUrl);

  if (!await hasCommits(storePath) && await hasRemoteHead(storePath)) {
    await git(storePath, ["fetch", "origin", "main"]);
    await git(storePath, ["reset", "--hard", "origin/main"]);
    await writeStoreConfig(storePath, localConfig);
    await rebuildDerivedViews(storePath);
  }

  await ensureGitIgnore(storePath);
  await untrackLocalOnlyPaths(storePath);
  await git(storePath, ["add", "events", ".gitignore"]);
  const shouldPushInitialCommit = !await hasRemoteHead(storePath);
  if (await hasStagedChanges(storePath)) {
    await git(storePath, ["commit", "-m", "Initialize Moryn store"]);
    if (shouldPushInitialCommit) {
      await git(storePath, ["push", "-u", "origin", "main"]);
    }
  }
  await writeLastSync(storePath, "init");
  return withSyncResultSelectionSources({ ok: true, message: "Git sync initialized" });
}

export async function getGitSyncStatus(storePath: string): Promise<GitSyncStatus> {
  validateRequiredString(storePath, "storePath");
  try {
    const configured = await gitOk(storePath, ["rev-parse", "--git-dir"]);
    if (!configured) return withSyncStatusSelectionSources({ configured: false, error: "Not a git repository" });

    const branch = await git(storePath, ["branch", "--show-current"]);
    const remote = await git(storePath, ["remote", "get-url", "origin"]).catch(() => undefined);
    if (remote) {
      await git(storePath, ["fetch", "origin", "main"]).catch(() => undefined);
    }
    const porcelain = await git(storePath, ["status", "--porcelain"]);
    const conflict = await gitConflictStatus(storePath);
    const lastCommit = await git(storePath, ["rev-parse", "--short", "HEAD"]).catch(() => undefined);
    const lastSync = await readLastSync(storePath);
    let ahead = 0;
    let behind = 0;
    if (remote && await gitOk(storePath, ["rev-parse", "--verify", "origin/main"])) {
      const counts = await git(storePath, ["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
      const [left, right] = counts.split(/\s+/).map((value) => Number(value));
      ahead = left ?? 0;
      behind = right ?? 0;
    }
    return withSyncStatusSelectionSources({
      configured: true,
      branch,
      remote,
      dirty: porcelain.length > 0,
      sync_state: conflict ? "conflict" : porcelain.length > 0 ? "dirty" : "clean",
      ...(conflict ? { conflict } : {}),
      ahead,
      behind,
      last_sync: lastSync,
      last_commit: lastCommit
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return withSyncStatusSelectionSources({ configured: false, error: message });
  }
}

export async function pullGitSync(storePath: string): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  await ensureGitSyncConfigured(storePath);
  const localConfig = await readStoreConfig(storePath);
  if (!await hasRemoteHead(storePath)) {
    return withSyncResultSelectionSources({ ok: true, pulled: false, message: "Remote branch main does not exist yet" });
  }
  await git(storePath, ["fetch", "origin", "main"]);
  const hasLocal = await hasCommits(storePath);
  if (!hasLocal) {
    await git(storePath, ["checkout", "-B", "main", "origin/main"]);
    await restoreLocalOnlyStateAfterGitUpdate(storePath, localConfig);
    await writeLastSync(storePath, "pull");
    return withSyncResultSelectionSources({ ok: true, pulled: true });
  }
  await git(storePath, ["pull", "--rebase", "origin", "main"]);
  await restoreLocalOnlyStateAfterGitUpdate(storePath, localConfig);
  await writeLastSync(storePath, "pull");
  return withSyncResultSelectionSources({ ok: true, pulled: true });
}

export async function pushGitSync(storePath: string, options: { message?: string } = {}): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  validateSyncOptions(options);
  await ensureGitSyncConfigured(storePath);
  const localConfig = await readStoreConfig(storePath);
  await ensureGitIgnore(storePath);
  await ensureGitIdentity(storePath);
  await ensureMainBranch(storePath);
  await untrackLocalOnlyPaths(storePath);
  await git(storePath, ["add", "events", ".gitignore"]);

  let committed = false;
  if (await hasStagedChanges(storePath)) {
    await git(storePath, ["commit", "-m", options.message ?? "Sync Moryn events"]);
    committed = true;
  }

  if (await hasRemoteHead(storePath)) {
    await git(storePath, ["pull", "--rebase", "origin", "main"]);
    await restoreLocalOnlyStateAfterGitUpdate(storePath, localConfig);
  }
  await git(storePath, ["push", "-u", "origin", "main"]);
  await writeLastSync(storePath, "push");
  return withSyncResultSelectionSources({ ok: true, committed, pushed: true });
}
