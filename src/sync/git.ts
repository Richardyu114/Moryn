import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AutomaticEventAuditReceipt, runAutomaticEventAudit } from "../core/automatic-event-audit.js";
import { readStoreConfig } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";
import { removeEventAuditProof } from "../core/event-audit-proof.js";
import { parseEvent } from "../core/schema.js";
import { withStoreStateLease } from "../core/state-lease.js";
import type { MorynEvent } from "../core/types.js";
import {
  captureSoulGitFetchRemoteIdentityDigest,
  captureSoulGitPushRemoteIdentityDigest,
  recordPulledAndVerifiedSoulSyncReceipts,
  recordPushedSoulSyncReceipts
} from "./soul-git-receipts.js";

const exec = promisify(execFile);
const LOCAL_ONLY_GIT_PATHS = ["config.json", "snapshots", "indexes", "state", ".moryn"] as const;
const LOCAL_ONLY_GIT_HISTORY_PATHS = LOCAL_ONLY_GIT_PATHS.map((path) => `:(top,icase,literal)${path}`);
const LOCAL_ONLY_GIT_PATHS_DESCRIPTION = LOCAL_ONLY_GIT_PATHS.join(", ");
const MORYN_SYNC_REMOTE_REF = "refs/moryn/sync/main";
const GIT_ERROR_BUFFER_LIMIT = 64 * 1024;

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

export interface PendingSyncEvidence {
  paths: string[];
  events: MorynEvent[];
}

function gitPathLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function porcelainPaths(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      paths.push(entries[index + 1] ?? path);
      index += 1;
    } else {
      paths.push(path);
    }
  }
  return paths;
}

export async function getPendingSyncEvidence(storePath: string): Promise<PendingSyncEvidence> {
  validateRequiredString(storePath, "storePath");
  await ensureGitSyncConfigured(storePath);
  const workingPaths = porcelainPaths(
    await gitRaw(storePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  );
  const aheadPaths = (await gitOk(storePath, ["rev-parse", "--verify", "origin/main"]))
    ? gitPathLines(await git(storePath, ["diff", "--name-only", "origin/main...HEAD"]))
    : [];
  const paths = [...new Set([...workingPaths, ...aheadPaths])].sort();
  const events: MorynEvent[] = [];
  for (const path of paths.filter((path) => path.startsWith("events/") && path.endsWith(".json"))) {
    try {
      events.push(parseEvent(JSON.parse(await readFile(join(storePath, path), "utf8"))));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return { paths, events };
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
  automatic_event_audit?: AutomaticEventAuditReceipt;
  selection_sources: typeof SYNC_RESULT_SELECTION_SOURCES;
}

export interface PushGitSyncDependencies {
  run_automatic_event_audit?: typeof runAutomaticEventAudit;
}

type SyncArgumentRecoveryHint =
  | {
      rejected_argument: { argument: "storePath" | "remoteUrl" | "message"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { argument: "storePath" | "remoteUrl" | "message"; value_placeholder: string };
    }
  | {
      operation_contract: "operations_by_id.sync_init";
      rejected_argument: { argument: "remote"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: { remote: "operations_by_id.sync_init.arguments_by_name.remote" };
      retry_with: { argument: "remote"; value_placeholder: "<remote>" };
    }
  | {
      operation_contract: "operations_by_id.sync_push";
      rejected_argument: { argument: "message"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: { message: "operations_by_id.sync_push.arguments_by_name.message" };
      retry_with: { argument: "message"; value_placeholder: "<message>" };
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
  if (name === "remoteUrl") {
    return new SyncArgumentError("Invalid argument: Invalid remoteUrl", "retry sync with a non-empty remoteUrl", {
      operation_contract: "operations_by_id.sync_init",
      rejected_argument: { argument: "remote", value },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: {
        remote: "operations_by_id.sync_init.arguments_by_name.remote"
      },
      retry_with: { argument: "remote", value_placeholder: "<remote>" }
    });
  }
  if (name === "message") {
    return new SyncArgumentError("Invalid argument: Invalid message", "retry sync with a non-empty message", {
      operation_contract: "operations_by_id.sync_push",
      rejected_argument: { argument: "message", value },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: {
        message: "operations_by_id.sync_push.arguments_by_name.message"
      },
      retry_with: { argument: "message", value_placeholder: "<message>" }
    });
  }
  return new SyncArgumentError(`Invalid argument: Invalid ${name}`, `retry sync with a non-empty ${name}`, {
    rejected_argument: { argument: name, value },
    expected: { kind: "non_empty_string", min_length: 1 },
    retry_with: { argument: name, value_placeholder: `<${name}>` }
  });
}

function invalidSyncOptionsError(options: unknown): SyncArgumentError {
  return new SyncArgumentError("Invalid argument: Invalid sync options", "retry sync with a valid options object", {
    rejected_argument: { argument: "options", value: options },
    expected: { kind: "object", required: false },
    retry_with: { argument: "options", value_placeholder: { message: "<message>" } }
  });
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

function withSyncStatusSelectionSources(status: Omit<GitSyncStatus, "selection_sources">): GitSyncStatus {
  return {
    ...status,
    selection_sources: SYNC_STATUS_SELECTION_SOURCES
  };
}

function withSyncResultSelectionSources(result: Omit<GitSyncResult, "selection_sources">): GitSyncResult {
  return {
    ...result,
    selection_sources: SYNC_RESULT_SELECTION_SOURCES
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
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
  await writeFile(join(storePath, ".gitignore"), "config.json\nsnapshots/\nindexes/\nstate/\n.moryn/\n", "utf8");
}

async function untrackLocalOnlyPaths(storePath: string): Promise<void> {
  await git(storePath, ["rm", "--cached", "-r", "--ignore-unmatch", ...LOCAL_ONLY_GIT_PATHS]);
}

async function assertHistoryExcludesLocalOnlyPaths(
  storePath: string,
  revisions: string[],
  historyLabel: string
): Promise<void> {
  const offendingCommit = await git(storePath, [
    "rev-list",
    "--max-count=1",
    ...revisions,
    "--",
    ...LOCAL_ONLY_GIT_HISTORY_PATHS
  ]);
  if (!offendingCommit) return;
  throw new Error(
    `Git sync refused: ${historyLabel} contains commit ${offendingCommit.slice(0, 12)} that touched local-only Moryn paths (${LOCAL_ONLY_GIT_PATHS_DESCRIPTION}). Rewrite that Git history and verify the paths are untracked before retrying sync.`
  );
}

interface UnsafeGitTreeEntry {
  mode: "120000" | "160000";
  path: string;
}

function parseUnsafeGitTreeEntry(entry: Buffer): UnsafeGitTreeEntry | undefined {
  const mode = entry.subarray(0, 6).toString("ascii");
  if (mode !== "120000" && mode !== "160000") return undefined;
  const pathSeparator = entry.indexOf(0x09);
  return {
    mode,
    path: pathSeparator >= 0 ? entry.subarray(pathSeparator + 1).toString("utf8") : "<unknown>"
  };
}

async function findUnsafeGitTreeEntry(storePath: string, commit: string): Promise<UnsafeGitTreeEntry | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["ls-tree", "-r", "-z", commit], {
      cwd: storePath,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let pending = Buffer.alloc(0);
    let unsafeEntry: UnsafeGitTreeEntry | undefined;
    let errorOutput = Buffer.alloc(0);

    child.stdout.on("data", (chunk: Buffer) => {
      const output = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      for (let separator = output.indexOf(0, start); separator >= 0; separator = output.indexOf(0, start)) {
        unsafeEntry ??= parseUnsafeGitTreeEntry(output.subarray(start, separator));
        start = separator + 1;
      }
      pending = Buffer.from(output.subarray(start));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorOutput.length >= GIT_ERROR_BUFFER_LIMIT) return;
      errorOutput = Buffer.concat([errorOutput, chunk.subarray(0, GIT_ERROR_BUFFER_LIMIT - errorOutput.length)]);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`git ls-tree failed with exit code ${code ?? "unknown"}: ${errorOutput.toString("utf8").trim()}`)
        );
        return;
      }
      if (pending.length !== 0) {
        reject(new Error("git ls-tree returned an unterminated entry"));
        return;
      }
      resolve(unsafeEntry);
    });
  });
}

async function assertCommitTreeExcludesUnsafeEntryModes(
  storePath: string,
  commit: string,
  treeLabel: string
): Promise<void> {
  const unsafeEntry = await findUnsafeGitTreeEntry(storePath, commit);
  if (!unsafeEntry) return;
  const entryType = unsafeEntry.mode === "120000" ? "symlink" : "gitlink";
  throw new Error(
    `Git sync refused: ${treeLabel} contains ${entryType} ${unsafeEntry.path} (mode ${unsafeEntry.mode}). Synchronized Git trees must not contain symlinks or gitlinks.`
  );
}

async function fetchVerifiedRemoteMainCommit(storePath: string): Promise<string> {
  await git(storePath, ["fetch", "--no-tags", "origin", `+refs/heads/main:${MORYN_SYNC_REMOTE_REF}`]);
  const commit = await git(storePath, ["rev-parse", "--verify", `${MORYN_SYNC_REMOTE_REF}^{commit}`]);
  await assertHistoryExcludesLocalOnlyPaths(storePath, [commit], "remote main history");
  await assertCommitTreeExcludesUnsafeEntryModes(storePath, commit, "remote main commit");
  return commit;
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
    await removeEventAuditProof(storePath);
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
  return !(await gitOk(storePath, ["diff", "--cached", "--quiet"]));
}

async function rebuildLocalStateAfterGitUpdate(storePath: string): Promise<void> {
  await rebuildDerivedViews(storePath);
  await ensureGitIgnore(storePath);
  await untrackLocalOnlyPaths(storePath);
  await git(storePath, ["add", ".gitignore"]);
  await ensureGitIdentity(storePath);
  if (await hasStagedChanges(storePath)) {
    await git(storePath, ["commit", "-m", "Enforce Moryn local-only ignores"]);
  }
}

async function ensureGitSyncConfigured(storePath: string): Promise<void> {
  if (!(await gitOk(storePath, ["rev-parse", "--git-dir"]))) {
    throw new Error("Sync not configured: run moryn sync init <remote>");
  }
  if (!(await git(storePath, ["remote", "get-url", "origin"]).catch(() => ""))) {
    throw new Error("Sync not configured: run moryn sync init <remote>");
  }
}

export async function isGitSyncConfigured(storePath: string): Promise<boolean> {
  validateRequiredString(storePath, "storePath");
  if (!(await gitOk(storePath, ["rev-parse", "--git-dir"]))) return false;
  return Boolean(await git(storePath, ["remote", "get-url", "origin"]).catch(() => ""));
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
    (await pathExists(join(storePath, gitDir, "rebase-merge"))) ||
    (await pathExists(join(storePath, gitDir, "rebase-apply")))
      ? "rebase"
      : (await pathExists(join(storePath, gitDir, "MERGE_HEAD")))
        ? "merge"
        : (await pathExists(join(storePath, gitDir, "CHERRY_PICK_HEAD")))
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
    files_by_path: Object.fromEntries(
      files.map((file) => [
        file,
        {
          path: file,
          status: "unmerged",
          safe_to_auto_resolve: false,
          recommended_action: recommendedAction
        }
      ])
    ),
    safe_to_auto_resolve: false,
    safe_to_retry_sync: false,
    recommended_action: recommendedAction
  };
}

export async function initializeGitSync(storePath: string, remoteUrl: string): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  validateRequiredString(remoteUrl, "remoteUrl");
  // Validate the Moryn store before lease acquisition creates its state directory.
  await readStoreConfig(storePath);
  return withStoreStateLease(storePath, async () => {
    await readStoreConfig(storePath);
    if (!(await gitOk(storePath, ["rev-parse", "--git-dir"]))) {
      await git(storePath, ["init"]);
    }
    await ensureGitIdentity(storePath);
    const hasLocalCommits = await hasCommits(storePath);
    if (hasLocalCommits) {
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "local history");
      const localCommit = await git(storePath, ["rev-parse", "HEAD"]);
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, localCommit, "local commit");
    }
    await ensureMainBranch(storePath);
    await ensureGitIgnore(storePath);
    await ensureRemote(storePath, remoteUrl);

    const remoteMainExists = await hasRemoteHead(storePath);
    let importedRemoteIdentityDigest: string | undefined;
    let importedRemoteCommit: string | undefined;
    if (remoteMainExists) {
      if (!hasLocalCommits) {
        importedRemoteIdentityDigest = await captureSoulGitFetchRemoteIdentityDigest(storePath);
      }
      const remoteCommit = await fetchVerifiedRemoteMainCommit(storePath);
      if (!hasLocalCommits) {
        importedRemoteCommit = remoteCommit;
        await removeEventAuditProof(storePath);
        await git(storePath, ["reset", "--hard", remoteCommit]);
      }
    }
    if (remoteMainExists && !hasLocalCommits) {
      await rebuildDerivedViews(storePath);
    }

    await ensureGitIgnore(storePath);
    await untrackLocalOnlyPaths(storePath);
    await git(storePath, ["add", "events", ".gitignore"]);
    const shouldPushInitialCommit = !remoteMainExists;
    let committed = false;
    if (await hasStagedChanges(storePath)) {
      await git(storePath, ["commit", "-m", "Initialize Moryn store"]);
      committed = true;
    }
    let automaticEventAudit: AutomaticEventAuditReceipt | undefined;
    if (shouldPushInitialCommit && (await hasCommits(storePath))) {
      automaticEventAudit = await runAutomaticEventAudit(storePath);
      if (automaticEventAudit.status === "failed") {
        return withSyncResultSelectionSources({
          ok: false,
          committed,
          pushed: false,
          message: "Automatic event integrity verification failed; initial remote push was skipped.",
          automatic_event_audit: automaticEventAudit
        });
      }
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "history selected for initial push");
      const pushedCommit = await git(storePath, ["rev-parse", "HEAD"]);
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, pushedCommit, "commit selected for initial push");
      const remoteIdentityDigest = await captureSoulGitPushRemoteIdentityDigest(storePath);
      await git(storePath, ["push", "-u", "origin", "main"]);
      await recordPushedSoulSyncReceipts(storePath, remoteIdentityDigest, pushedCommit);
    }
    if (importedRemoteIdentityDigest && importedRemoteCommit) {
      await recordPulledAndVerifiedSoulSyncReceipts(
        storePath,
        "init",
        importedRemoteIdentityDigest,
        importedRemoteCommit
      );
    }
    await writeLastSync(storePath, "init");
    return withSyncResultSelectionSources({
      ok: true,
      message: "Git sync initialized",
      ...(automaticEventAudit ? { automatic_event_audit: automaticEventAudit } : {})
    });
  });
}

export async function getGitSyncStatus(storePath: string): Promise<GitSyncStatus> {
  validateRequiredString(storePath, "storePath");
  try {
    const configured = await gitOk(storePath, ["rev-parse", "--git-dir"]);
    if (!configured) return withSyncStatusSelectionSources({ configured: false, error: "Not a git repository" });

    const branch = await git(storePath, ["branch", "--show-current"]);
    const remote = await git(storePath, ["remote", "get-url", "origin"]).catch(() => undefined);
    let remoteCommit: string | undefined;
    if (remote) {
      await git(storePath, ["fetch", "origin", "main"]).catch(() => undefined);
      remoteCommit = await git(storePath, ["rev-parse", "--verify", "origin/main^{commit}"]).catch(() => undefined);
    }
    const porcelain = await git(storePath, ["status", "--porcelain"]);
    const conflict = await gitConflictStatus(storePath);
    const lastCommit = await git(storePath, ["rev-parse", "--short", "HEAD"]).catch(() => undefined);
    const lastSync = await readLastSync(storePath);
    let ahead = 0;
    let behind = 0;
    if (remoteCommit) {
      const counts = await git(storePath, ["rev-list", "--left-right", "--count", `HEAD...${remoteCommit}`]);
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
  return withStoreStateLease(storePath, async () => {
    await ensureGitSyncConfigured(storePath);
    await readStoreConfig(storePath);
    if (!(await hasRemoteHead(storePath))) {
      return withSyncResultSelectionSources({
        ok: true,
        pulled: false,
        message: "Remote branch main does not exist yet"
      });
    }
    const remoteIdentityDigest = await captureSoulGitFetchRemoteIdentityDigest(storePath);
    const remoteCommit = await fetchVerifiedRemoteMainCommit(storePath);
    const hasLocal = await hasCommits(storePath);
    if (hasLocal) {
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "local history selected for rebase");
      const localCommit = await git(storePath, ["rev-parse", "HEAD"]);
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, localCommit, "local commit selected for rebase");
    }
    if (!hasLocal) {
      await removeEventAuditProof(storePath);
      await git(storePath, ["checkout", "-B", "main", remoteCommit]);
      await rebuildLocalStateAfterGitUpdate(storePath);
      await recordPulledAndVerifiedSoulSyncReceipts(storePath, "pull", remoteIdentityDigest, remoteCommit);
      await writeLastSync(storePath, "pull");
      return withSyncResultSelectionSources({ ok: true, pulled: true });
    }
    await removeEventAuditProof(storePath);
    await git(storePath, ["rebase", remoteCommit]);
    await rebuildLocalStateAfterGitUpdate(storePath);
    await recordPulledAndVerifiedSoulSyncReceipts(storePath, "pull", remoteIdentityDigest, remoteCommit);
    await writeLastSync(storePath, "pull");
    return withSyncResultSelectionSources({ ok: true, pulled: true });
  });
}

export async function pushGitSync(
  storePath: string,
  options: { message?: string } = {},
  dependencies: PushGitSyncDependencies = {}
): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  validateSyncOptions(options);
  return withStoreStateLease(storePath, async () => {
    await ensureGitSyncConfigured(storePath);
    await readStoreConfig(storePath);
    await ensureGitIdentity(storePath);
    const hasLocalCommits = await hasCommits(storePath);
    if (hasLocalCommits) {
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "local history selected for push");
      const localCommit = await git(storePath, ["rev-parse", "HEAD"]);
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, localCommit, "local commit selected for push");
    }
    await ensureMainBranch(storePath);
    await ensureGitIgnore(storePath);
    await untrackLocalOnlyPaths(storePath);
    await git(storePath, ["add", "events", ".gitignore"]);

    let pulledRemoteIdentityDigest: string | undefined;
    let remoteCommit: string | undefined;
    if (await hasRemoteHead(storePath)) {
      pulledRemoteIdentityDigest = await captureSoulGitFetchRemoteIdentityDigest(storePath);
      remoteCommit = await fetchVerifiedRemoteMainCommit(storePath);
    }

    let committed = false;
    if (await hasStagedChanges(storePath)) {
      await git(storePath, ["commit", "-m", options.message ?? "Sync Moryn events"]);
      committed = true;
    }

    let automaticEventAudit: AutomaticEventAuditReceipt | undefined;
    if (remoteCommit && pulledRemoteIdentityDigest) {
      await removeEventAuditProof(storePath);
      await git(storePath, ["rebase", remoteCommit]);
      try {
        await rebuildLocalStateAfterGitUpdate(storePath);
      } catch {
        automaticEventAudit = await (dependencies.run_automatic_event_audit ?? runAutomaticEventAudit)(storePath);
        if (automaticEventAudit.status === "failed") {
          return withSyncResultSelectionSources({
            ok: false,
            committed,
            pushed: false,
            message: "Automatic event integrity verification failed; remote push was skipped.",
            automatic_event_audit: automaticEventAudit
          });
        }
        return withSyncResultSelectionSources({
          ok: false,
          committed,
          pushed: false,
          message: "Local derived state could not be refreshed; remote push was skipped.",
          automatic_event_audit: automaticEventAudit
        });
      }
      await recordPulledAndVerifiedSoulSyncReceipts(storePath, "pull", pulledRemoteIdentityDigest, remoteCommit);
    }
    automaticEventAudit ??= await (dependencies.run_automatic_event_audit ?? runAutomaticEventAudit)(storePath);
    if (automaticEventAudit.status === "failed") {
      return withSyncResultSelectionSources({
        ok: false,
        committed,
        pushed: false,
        message: "Automatic event integrity verification failed; remote push was skipped.",
        automatic_event_audit: automaticEventAudit
      });
    }
    await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "history selected for push");
    const pushedCommit = await git(storePath, ["rev-parse", "HEAD"]);
    await assertCommitTreeExcludesUnsafeEntryModes(storePath, pushedCommit, "commit selected for push");
    const remoteIdentityDigest = await captureSoulGitPushRemoteIdentityDigest(storePath);
    await git(storePath, ["push", "-u", "origin", "main"]);
    await recordPushedSoulSyncReceipts(storePath, remoteIdentityDigest, pushedCommit);
    await writeLastSync(storePath, "push");
    return withSyncResultSelectionSources({
      ok: true,
      committed,
      pushed: true,
      automatic_event_audit: automaticEventAudit
    });
  });
}
