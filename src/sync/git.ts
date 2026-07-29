import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AutomaticEventAuditReceipt, runAutomaticEventAudit } from "../core/automatic-event-audit.js";
import { readStoreConfig } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";
import { removeEventAuditProof } from "../core/event-audit-proof.js";
import {
  execOperationChildProcess,
  isOperationDeadlineExceeded,
  type OperationChildProcessResult,
  rethrowIfOperationDeadlineExceeded,
  spawnOperationChildProcess
} from "../core/operation-deadline.js";
import { replayEvents } from "../core/replay.js";
import { parseEvent } from "../core/schema.js";
import { withStoreStateLease } from "../core/state-lease.js";
import type { MorynEvent } from "../core/types.js";
import {
  captureSoulGitFetchRemoteIdentityDigest,
  captureSoulGitPushRemoteIdentityDigest,
  recordPulledAndVerifiedSoulSyncReceipts,
  recordPushedSoulSyncReceipts
} from "./soul-git-receipts.js";

const LOCAL_ONLY_GIT_PATHS = ["config.json", "snapshots", "indexes", "state", ".moryn"] as const;
const LOCAL_ONLY_GIT_HISTORY_PATHS = LOCAL_ONLY_GIT_PATHS.map((path) => `:(top,icase,literal)${path}`);
const LOCAL_ONLY_GIT_PATHS_DESCRIPTION = LOCAL_ONLY_GIT_PATHS.join(", ");
const MORYN_SYNC_REMOTE_REF = "refs/moryn/sync/main";
const GIT_ERROR_BUFFER_LIMIT = 64 * 1024;
const GIT_EVENT_BLOB_SIZE_LIMIT = 64 * 1024 * 1024;
const SYNC_STATUS_PENDING_TIME_FILE_LIMIT = 500;
const DEFAULT_REMOTE_OBSERVATION_TIMEOUT_MS = 5_000;
const EVENT_HISTORY_MUTATION_MESSAGE =
  "Git sync refused because append-only event history could not be verified safely. Existing events must remain byte-for-byte unchanged, and only new regular .json event files may be added.";
const EVENT_HISTORY_MUTATION_RECOMMENDED_ACTION =
  "restore existing event files, clear event ignore or hidden-index rules, and append a corrective event before retrying sync";

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
  pending_changes: "pending_changes",
  remote_observation: "remote_observation",
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
  pending_changes?: GitPendingChangesStatus;
  remote_observation?: GitRemoteObservation;
  error?: string;
  selection_sources: typeof SYNC_STATUS_SELECTION_SOURCES;
}

export interface GitSyncStatusOptions {
  remote_timeout_ms?: number;
}

export interface GitPendingChangesStatus {
  total_files: number;
  /** Changes under paths Moryn publishes (`events/**` and `.gitignore`). */
  managed_files: number;
  /** Other worktree changes, retained for technical diagnostics only. */
  unmanaged_files: number;
  event_files: number;
  untracked_event_files: number;
  added_event_files: number;
  modified_event_files: number;
  ignored_event_files: number;
  oldest_pending_file_mtime?: string;
  pending_time_complete: boolean;
}

export interface GitRemoteObservation {
  checked: true;
  reachable: boolean;
  remote_commit?: string;
  contains_local_head?: boolean;
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

interface GitPorcelainEntry {
  index_status: string;
  worktree_status: string;
  path: string;
  original_path?: string;
}

function porcelainEntries(output: string): GitPorcelainEntry[] {
  const entries = output.split("\0").filter(Boolean);
  const parsed: GitPorcelainEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      parsed.push({
        index_status: status[0] ?? " ",
        worktree_status: status[1] ?? " ",
        path,
        original_path: entries[index + 1]
      });
      index += 1;
    } else {
      parsed.push({ index_status: status[0] ?? " ", worktree_status: status[1] ?? " ", path });
    }
  }
  return parsed;
}

function porcelainPaths(output: string): string[] {
  return porcelainEntries(output).map((entry) => entry.path);
}

function isEventPath(path: string): boolean {
  return path.startsWith("events/") && path.endsWith(".json");
}

function isManagedSyncPath(path: string): boolean {
  return isEventTreePath(path) || path === ".gitignore";
}

function isManagedSyncEntry(entry: GitPorcelainEntry): boolean {
  return isManagedSyncPath(entry.path) || (entry.original_path !== undefined && isManagedSyncPath(entry.original_path));
}

function isUntrackedEntry(entry: GitPorcelainEntry): boolean {
  return entry.index_status === "?" && entry.worktree_status === "?";
}

function isAddedEntry(entry: GitPorcelainEntry): boolean {
  return (
    !isUntrackedEntry(entry) && !isIgnoredEntry(entry) && (entry.index_status === "A" || entry.worktree_status === "A")
  );
}

function isIgnoredEntry(entry: GitPorcelainEntry): boolean {
  return entry.index_status === "!" && entry.worktree_status === "!";
}

async function pendingRegularFileMtime(storePath: string, eventPath: string): Promise<string | undefined> {
  const segments = eventPath.split("/");
  if (
    eventPath.startsWith("/") ||
    segments.length === 0 ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  let current = storePath;
  try {
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]!);
      const file = await lstat(current);
      const isLast = index === segments.length - 1;
      if (isLast) return file.isFile() && !file.isSymbolicLink() ? file.mtime.toISOString() : undefined;
      if (!file.isDirectory() || file.isSymbolicLink()) return undefined;
    }
  } catch (error) {
    rethrowIfOperationDeadlineExceeded(error);
    return undefined;
  }
  return undefined;
}

async function summarizePendingChanges(
  storePath: string,
  entries: GitPorcelainEntry[]
): Promise<GitPendingChangesStatus> {
  const uniqueEntries = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  const managedEntries = uniqueEntries.filter(isManagedSyncEntry);
  const eventEntries = uniqueEntries.filter((entry) => isEventPath(entry.path));
  const canInspectPendingTime = eventEntries.length > 0 && eventEntries.length <= SYNC_STATUS_PENDING_TIME_FILE_LIMIT;
  const pendingFileTimes = canInspectPendingTime
    ? await Promise.all(eventEntries.map((entry) => pendingRegularFileMtime(storePath, entry.path)))
    : [];
  const pendingTimeComplete =
    canInspectPendingTime && pendingFileTimes.length === eventEntries.length && pendingFileTimes.every(Boolean);
  const oldestPendingFileMtime = pendingTimeComplete
    ? (pendingFileTimes as string[]).sort((left, right) => left.localeCompare(right))[0]
    : undefined;
  return {
    total_files: uniqueEntries.length,
    managed_files: managedEntries.length,
    unmanaged_files: uniqueEntries.length - managedEntries.length,
    event_files: eventEntries.length,
    untracked_event_files: eventEntries.filter(isUntrackedEntry).length,
    added_event_files: eventEntries.filter(isAddedEntry).length,
    modified_event_files: eventEntries.filter(
      (entry) => !isUntrackedEntry(entry) && !isAddedEntry(entry) && !isIgnoredEntry(entry)
    ).length,
    ignored_event_files: eventEntries.filter(isIgnoredEntry).length,
    ...(oldestPendingFileMtime ? { oldest_pending_file_mtime: oldestPendingFileMtime } : {}),
    pending_time_complete: pendingTimeComplete
  };
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

class EventHistoryMutationError extends Error {
  readonly code = "EVENT_HISTORY_MUTATION";
  readonly recommended_action = EVENT_HISTORY_MUTATION_RECOMMENDED_ACTION;

  constructor() {
    super(EVENT_HISTORY_MUTATION_MESSAGE);
    this.name = "EventHistoryMutationError";
  }
}

function eventHistoryMutationError(): EventHistoryMutationError {
  return new EventHistoryMutationError();
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

async function runGit(cwd: string, args: string[], timeoutCapMs?: number): Promise<string> {
  return (await execOperationChildProcess("git", args, { cwd, timeoutMs: timeoutCapMs })).stdout;
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await runGit(cwd, args)).trim();
}

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  return runGit(cwd, args);
}

async function gitWithTimeout(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return (await runGit(cwd, args, timeoutMs)).trim();
}

async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (error) {
    if (isOperationDeadlineExceeded(error)) throw error;
    return false;
  }
}

function spawnGit(cwd: string, args: string[]) {
  return spawnOperationChildProcess("git", args, { cwd });
}

function gitChildError(result: OperationChildProcessResult, args: readonly string[], detail = ""): Error | undefined {
  if (result.termination_error) return result.termination_error;
  if (result.spawn_error) return result.spawn_error;
  if (result.code === 0) return undefined;
  return new Error(
    `git ${args.join(" ")} failed with exit code ${result.code ?? "unknown"}${detail ? `: ${detail}` : ""}`
  );
}

async function fallbackUnlessDeadline<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work;
  } catch (error) {
    rethrowIfOperationDeadlineExceeded(error);
    return fallback;
  }
}

function isEventTreePath(path: string): boolean {
  return path === "events" || path.startsWith("events/");
}

function isExpectedEventTreeFile(path: string): boolean {
  return isEventPath(path) || path === "events/.gitkeep";
}

function isAllowedNewEventStatus(entry: GitPorcelainEntry): boolean {
  const status = `${entry.index_status}${entry.worktree_status}`;
  return status === "??" || status === "A " || status === "AM" || status === " A";
}

/**
 * Verifies that the workspace can only contribute new, visible, regular JSON
 * event files. Existing event changes fail before sync mutates the index.
 */
async function assertEventWorkspaceAppendOnly(storePath: string): Promise<void> {
  try {
    const [porcelain, tracked] = await Promise.all([
      gitRaw(storePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"]),
      gitRaw(storePath, ["ls-files", "-v", "-z", "--", "events"])
    ]);

    for (const item of tracked.split("\0").filter(Boolean)) {
      const marker = item[0];
      const path = item.slice(2);
      if (marker !== "H" || !isExpectedEventTreeFile(path)) throw eventHistoryMutationError();
    }

    const newEventPaths: string[] = [];
    for (const entry of porcelainEntries(porcelain)) {
      const touchesEvents = [entry.path, entry.original_path]
        .filter((path): path is string => typeof path === "string")
        .some(isEventTreePath);
      if (!touchesEvents) continue;
      if (
        isIgnoredEntry(entry) ||
        entry.original_path ||
        !isAllowedNewEventStatus(entry) ||
        !isExpectedEventTreeFile(entry.path)
      ) {
        throw eventHistoryMutationError();
      }
      newEventPaths.push(entry.path);
    }

    for (const path of newEventPaths) {
      if (!(await pendingRegularFileMtime(storePath, path))) throw eventHistoryMutationError();
      const text = await readFile(join(storePath, path), "utf8");
      if (path === "events/.gitkeep") {
        if (text !== "") throw eventHistoryMutationError();
      } else {
        parseEvent(JSON.parse(text));
      }
    }
  } catch (error) {
    if (isOperationDeadlineExceeded(error)) throw error;
    if (error instanceof EventHistoryMutationError) throw error;
    throw eventHistoryMutationError();
  }
}

function historyNameStatusTouchesEvents(output: string): boolean {
  const fields = output.split("\0").filter(Boolean);
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++]!.trim();
    const path = fields[index++];
    if (!status || !path) throw eventHistoryMutationError();
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (!destination) throw eventHistoryMutationError();
      if (isEventTreePath(path) || isEventTreePath(destination)) return true;
    } else if (isEventTreePath(path)) {
      return true;
    }
  }
  return false;
}

async function assertEventHistoryAppendOnly(storePath: string, revision: string): Promise<void> {
  try {
    const offendingChanges = await gitRaw(storePath, [
      "log",
      "--root",
      "-m",
      "--format=",
      "--name-status",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-filter=MDRCTUXB",
      "--find-renames",
      revision
    ]);
    if (historyNameStatusTouchesEvents(offendingChanges)) throw eventHistoryMutationError();
  } catch (error) {
    if (isOperationDeadlineExceeded(error)) throw error;
    if (error instanceof EventHistoryMutationError) throw error;
    throw eventHistoryMutationError();
  }
}

interface InspectedEventTreeEntry {
  invalid: boolean;
  blob?: {
    object_id: string;
    payload: "event" | "gitkeep";
  };
}

function inspectEventTreeEntry(entry: Buffer): InspectedEventTreeEntry {
  const tab = entry.indexOf(0x09);
  if (tab < 0) return { invalid: true };
  const header = entry.subarray(0, tab).toString("ascii").split(" ");
  const mode = header[0];
  const type = header[1];
  const objectId = header[2];
  const path = entry.subarray(tab + 1).toString("utf8");
  const invalid =
    type !== "blob" ||
    (mode !== "100644" && mode !== "100755") ||
    !isExpectedEventTreeFile(path) ||
    !objectId ||
    !/^[a-f0-9]{40,64}$/u.test(objectId);
  return {
    invalid,
    ...(!invalid
      ? {
          blob: {
            object_id: objectId,
            payload: isEventPath(path) ? ("event" as const) : ("gitkeep" as const)
          }
        }
      : {})
  };
}

async function inspectCommitEventTree(
  storePath: string,
  commit: string
): Promise<{ invalid: boolean; blobs: Array<NonNullable<InspectedEventTreeEntry["blob"]>> }> {
  return new Promise((resolve, reject) => {
    const args = ["ls-tree", "-r", "-z", commit, "--", "events"];
    const spawned = spawnGit(storePath, args);
    const { child } = spawned;
    child.stdin.end();
    let pending = Buffer.alloc(0);
    let invalid = false;
    const blobs: Array<NonNullable<InspectedEventTreeEntry["blob"]>> = [];

    child.stdout.on("data", (chunk: Buffer) => {
      const output = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let start = 0;
      for (let separator = output.indexOf(0, start); separator >= 0; separator = output.indexOf(0, start)) {
        const inspected = inspectEventTreeEntry(output.subarray(start, separator));
        invalid ||= inspected.invalid;
        if (inspected.blob) blobs.push(inspected.blob);
        start = separator + 1;
      }
      pending = Buffer.from(output.subarray(start));
    });
    child.stderr.resume();
    void spawned.completed.then((result) => {
      const error = gitChildError(result, args);
      if (error) {
        reject(error);
        return;
      }
      if (pending.length !== 0) {
        reject(new Error("git ls-tree returned an unterminated entry"));
        return;
      }
      resolve({ invalid, blobs });
    });
  });
}

class GitBatchBuffer {
  private chunks: Buffer[] = [];
  private head = 0;
  private headOffset = 0;
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  indexOf(byte: number): number {
    let relativeOffset = 0;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]!;
      const start = index === this.head ? this.headOffset : 0;
      const found = chunk.indexOf(byte, start);
      if (found >= 0) return relativeOffset + found - start;
      relativeOffset += chunk.length - start;
    }
    return -1;
  }

  take(size: number): Buffer {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.length) throw eventHistoryMutationError();
    if (size === 0) return Buffer.alloc(0);
    const first = this.chunks[this.head]!;
    if (this.headOffset + size <= first.length) {
      const output = first.subarray(this.headOffset, this.headOffset + size);
      this.consume(size);
      return output;
    }
    const output = Buffer.allocUnsafe(size);
    let written = 0;
    while (written < size) {
      const chunk = this.chunks[this.head]!;
      const available = Math.min(size - written, chunk.length - this.headOffset);
      chunk.copy(output, written, this.headOffset, this.headOffset + available);
      this.consume(available);
      written += available;
    }
    return output;
  }

  private consume(size: number): void {
    this.length -= size;
    this.headOffset += size;
    while (this.head < this.chunks.length && this.headOffset === this.chunks[this.head]!.length) {
      this.head += 1;
      this.headOffset = 0;
    }
    if (this.head > 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }
}

async function assertEventBlobsParse(
  storePath: string,
  blobs: ReadonlyArray<NonNullable<InspectedEventTreeEntry["blob"]>>
): Promise<void> {
  if (blobs.length === 0) return;
  const spawned = spawnGit(storePath, ["cat-file", "--batch"]);
  const { child } = spawned;
  child.stderr.resume();
  child.stdin.on("error", () => {
    // The close/error result below owns the stable fail-closed outcome.
  });
  child.stdin.end(`${blobs.map((blob) => blob.object_id).join("\n")}\n`);

  const pending = new GitBatchBuffer();
  let expectedSize: number | undefined;
  let blobIndex = 0;
  const events: MorynEvent[] = [];
  try {
    for await (const chunk of child.stdout) {
      pending.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      while (blobIndex < blobs.length) {
        if (expectedSize === undefined) {
          const newline = pending.indexOf(0x0a);
          if (newline < 0) break;
          const header = pending
            .take(newline + 1)
            .subarray(0, newline)
            .toString("ascii");
          const [objectId, type, sizeText, extra] = header.split(" ");
          const size = Number(sizeText);
          if (
            extra !== undefined ||
            objectId !== blobs[blobIndex]?.object_id ||
            type !== "blob" ||
            !Number.isSafeInteger(size) ||
            size < 0 ||
            size > GIT_EVENT_BLOB_SIZE_LIMIT
          ) {
            throw eventHistoryMutationError();
          }
          expectedSize = size;
        }
        if (pending.length < expectedSize + 1) break;
        const body = pending.take(expectedSize);
        if (pending.take(1)[0] !== 0x0a) throw eventHistoryMutationError();
        if (blobs[blobIndex]?.payload === "gitkeep") {
          if (body.length !== 0) throw eventHistoryMutationError();
        } else {
          events.push(parseEvent(JSON.parse(body.toString("utf8"))));
        }
        expectedSize = undefined;
        blobIndex += 1;
      }
    }
    const result = await spawned.completed;
    const childError = gitChildError(result, ["cat-file", "--batch"]);
    if (childError) throw childError;
    if (blobIndex !== blobs.length || expectedSize !== undefined || pending.length !== 0) {
      throw eventHistoryMutationError();
    }
    events.sort(
      (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
    );
    if (new Set(events.map((event) => event.event_id)).size !== events.length) throw eventHistoryMutationError();
    replayEvents(events);
  } catch (error) {
    spawned.terminate();
    const result = await spawned.completed;
    if (result.termination_error) throw result.termination_error;
    throw error;
  }
}

async function assertEventCommitTreeShape(storePath: string, commit: string): Promise<void> {
  try {
    const inspected = await inspectCommitEventTree(storePath, commit);
    if (inspected.invalid) throw eventHistoryMutationError();
    await assertEventBlobsParse(storePath, inspected.blobs);
  } catch (error) {
    if (isOperationDeadlineExceeded(error)) throw error;
    if (error instanceof EventHistoryMutationError) throw error;
    throw eventHistoryMutationError();
  }
}

async function assertEventTreePreserved(storePath: string, baseline: string, candidate: string): Promise<void> {
  const preserved = await gitOk(storePath, [
    "diff",
    "--quiet",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--diff-filter=MDT",
    baseline,
    candidate,
    "--",
    "events"
  ]);
  if (!preserved) throw eventHistoryMutationError();
}

async function assertEventPublicationCandidate(
  storePath: string,
  commit: string,
  baselines: readonly string[] = []
): Promise<void> {
  await assertEventHistoryAppendOnly(storePath, commit);
  await assertEventPublicationTree(storePath, commit, baselines);
}

async function assertEventPublicationTree(
  storePath: string,
  commit: string,
  baselines: readonly string[] = []
): Promise<void> {
  await assertEventCommitTreeShape(storePath, commit);
  for (const baseline of new Set(baselines)) await assertEventTreePreserved(storePath, baseline, commit);
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
    const args = ["ls-tree", "-r", "-z", commit];
    const spawned = spawnGit(storePath, args);
    const { child } = spawned;
    child.stdin.end();
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
    void spawned.completed.then((result) => {
      const error = gitChildError(result, args, errorOutput.toString("utf8").trim());
      if (error) {
        reject(error);
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
  await assertEventPublicationCandidate(storePath, commit);
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
  const commit = await fallbackUnlessDeadline(git(storePath, ["rev-parse", "--short", "HEAD"]), undefined);
  const status: GitLastSync = {
    operation,
    at: new Date().toISOString(),
    commit
  };
  await writeFile(join(storePath, "state", "sync-status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function ensureMainBranch(storePath: string): Promise<void> {
  const branch = await fallbackUnlessDeadline(git(storePath, ["branch", "--show-current"]), "");
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
  if (!(await fallbackUnlessDeadline(git(storePath, ["remote", "get-url", "origin"]), ""))) {
    throw new Error("Sync not configured: run moryn sync init <remote>");
  }
}

export async function isGitSyncConfigured(storePath: string): Promise<boolean> {
  validateRequiredString(storePath, "storePath");
  if (!(await gitOk(storePath, ["rev-parse", "--git-dir"]))) return false;
  return Boolean(await fallbackUnlessDeadline(git(storePath, ["remote", "get-url", "origin"]), ""));
}

/**
 * Read-only preflight for local automation that may append events. It accepts a
 * non-Git store, but a Git-backed store must preserve every existing event and
 * contain only schema-valid, replayable append-only history.
 */
export async function assertGitEventHistoryAppendOnly(storePath: string): Promise<void> {
  validateRequiredString(storePath, "storePath");
  if (!(await gitOk(storePath, ["rev-parse", "--git-dir"]))) return;
  await assertEventWorkspaceAppendOnly(storePath);
  if (!(await hasCommits(storePath))) return;
  const head = await git(storePath, ["rev-parse", "HEAD"]);
  await assertEventPublicationCandidate(storePath, head);
}

async function ensureRemote(storePath: string, remoteUrl: string): Promise<void> {
  const current = await fallbackUnlessDeadline(git(storePath, ["remote", "get-url", "origin"]), "");
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
    const localBaselineCommit = (await hasCommits(storePath)) ? await git(storePath, ["rev-parse", "HEAD"]) : undefined;
    await assertEventWorkspaceAppendOnly(storePath);
    await ensureGitIdentity(storePath);
    const hasLocalCommits = Boolean(localBaselineCommit);
    if (localBaselineCommit) {
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "local history");
      await assertEventPublicationCandidate(storePath, localBaselineCommit);
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, localBaselineCommit, "local commit");
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
    const finalCommit = (await hasCommits(storePath)) ? await git(storePath, ["rev-parse", "HEAD"]) : undefined;
    if (finalCommit) {
      await assertEventPublicationTree(storePath, finalCommit, [
        ...(localBaselineCommit ? [localBaselineCommit] : []),
        ...(importedRemoteCommit ? [importedRemoteCommit] : [])
      ]);
    }
    let automaticEventAudit: AutomaticEventAuditReceipt | undefined;
    if (shouldPushInitialCommit && finalCommit) {
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
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, finalCommit, "commit selected for initial push");
      const remoteIdentityDigest = await captureSoulGitPushRemoteIdentityDigest(storePath);
      await git(storePath, ["push", "-u", "origin", "main"]);
      await recordPushedSoulSyncReceipts(storePath, remoteIdentityDigest, finalCommit);
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

export async function getGitSyncStatus(storePath: string, options: GitSyncStatusOptions = {}): Promise<GitSyncStatus> {
  validateRequiredString(storePath, "storePath");
  const remoteTimeoutMs =
    typeof options.remote_timeout_ms === "number" && Number.isFinite(options.remote_timeout_ms)
      ? Math.max(1, options.remote_timeout_ms)
      : DEFAULT_REMOTE_OBSERVATION_TIMEOUT_MS;
  let configured = false;
  let branch: string | undefined;
  let remote: string | undefined;
  try {
    configured = await gitOk(storePath, ["rev-parse", "--git-dir"]);
    if (!configured) return withSyncStatusSelectionSources({ configured: false, error: "Not a git repository" });

    branch = await git(storePath, ["branch", "--show-current"]);
    remote = await fallbackUnlessDeadline(git(storePath, ["remote", "get-url", "origin"]), undefined);
    let remoteCommit: string | undefined;
    let remoteReachable = false;
    if (remote) {
      remoteReachable = await fallbackUnlessDeadline(
        gitWithTimeout(storePath, ["fetch", "origin", "main"], remoteTimeoutMs).then(() => true),
        false
      );
      remoteCommit = await fallbackUnlessDeadline(
        git(storePath, ["rev-parse", "--verify", "origin/main^{commit}"]),
        undefined
      );
    }
    const porcelain = await gitRaw(storePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const ignoredEventPaths = (
      await gitRaw(storePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "events"])
    )
      .split("\0")
      .filter(Boolean);
    const pendingEntries = [
      ...porcelainEntries(porcelain),
      ...ignoredEventPaths.map((path): GitPorcelainEntry => ({ index_status: "!", worktree_status: "!", path }))
    ];
    const pendingChanges = await summarizePendingChanges(storePath, pendingEntries);
    const conflict = await gitConflictStatus(storePath);
    const lastCommit = await fallbackUnlessDeadline(git(storePath, ["rev-parse", "--short", "HEAD"]), undefined);
    const lastSync = await readLastSync(storePath);
    let ahead = 0;
    let behind = 0;
    if (remoteCommit) {
      const counts = await git(storePath, ["rev-list", "--left-right", "--count", `HEAD...${remoteCommit}`]);
      const [left, right] = counts.split(/\s+/).map((value) => Number(value));
      ahead = left ?? 0;
      behind = right ?? 0;
    }
    const remoteContainsLocalHead =
      remoteReachable && remoteCommit
        ? await gitOk(storePath, ["merge-base", "--is-ancestor", "HEAD", remoteCommit])
        : false;
    return withSyncStatusSelectionSources({
      configured: true,
      branch,
      remote,
      dirty: pendingEntries.length > 0,
      sync_state: conflict ? "conflict" : pendingEntries.length > 0 ? "dirty" : "clean",
      ...(conflict ? { conflict } : {}),
      ahead,
      behind,
      last_sync: lastSync,
      last_commit: lastCommit,
      pending_changes: pendingChanges,
      ...(remote
        ? {
            remote_observation: {
              checked: true,
              reachable: remoteReachable,
              ...(remoteCommit ? { remote_commit: remoteCommit } : {}),
              ...(remoteReachable && remoteCommit ? { contains_local_head: remoteContainsLocalHead } : {})
            }
          }
        : {})
    });
  } catch (error) {
    rethrowIfOperationDeadlineExceeded(error);
    const message = error instanceof Error ? error.message : String(error);
    return withSyncStatusSelectionSources({
      configured,
      ...(branch ? { branch } : {}),
      ...(remote ? { remote } : {}),
      error: message
    });
  }
}

export async function pullGitSync(storePath: string): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  return withStoreStateLease(storePath, async () => {
    await ensureGitSyncConfigured(storePath);
    await readStoreConfig(storePath);
    await assertEventWorkspaceAppendOnly(storePath);
    if (!(await hasRemoteHead(storePath))) {
      return withSyncResultSelectionSources({
        ok: true,
        pulled: false,
        message: "Remote branch main does not exist yet"
      });
    }
    const localBaselineCommit = (await hasCommits(storePath)) ? await git(storePath, ["rev-parse", "HEAD"]) : undefined;
    if (localBaselineCommit) {
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "local history selected for rebase");
      await assertEventPublicationCandidate(storePath, localBaselineCommit);
      await assertCommitTreeExcludesUnsafeEntryModes(
        storePath,
        localBaselineCommit,
        "local commit selected for rebase"
      );
    }
    const remoteIdentityDigest = await captureSoulGitFetchRemoteIdentityDigest(storePath);
    const remoteCommit = await fetchVerifiedRemoteMainCommit(storePath);
    if (!localBaselineCommit) {
      await removeEventAuditProof(storePath);
      await git(storePath, ["checkout", "-B", "main", remoteCommit]);
      await rebuildLocalStateAfterGitUpdate(storePath);
      const checkedOutCommit = await git(storePath, ["rev-parse", "HEAD"]);
      await assertEventPublicationTree(storePath, checkedOutCommit, [remoteCommit]);
      await recordPulledAndVerifiedSoulSyncReceipts(storePath, "pull", remoteIdentityDigest, remoteCommit);
      await writeLastSync(storePath, "pull");
      return withSyncResultSelectionSources({ ok: true, pulled: true });
    }
    await removeEventAuditProof(storePath);
    await git(storePath, ["rebase", remoteCommit]);
    await rebuildLocalStateAfterGitUpdate(storePath);
    const pulledCommit = await git(storePath, ["rev-parse", "HEAD"]);
    await assertEventPublicationTree(storePath, pulledCommit, [localBaselineCommit, remoteCommit]);
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
    const localBaselineCommit = (await hasCommits(storePath)) ? await git(storePath, ["rev-parse", "HEAD"]) : undefined;
    await assertEventWorkspaceAppendOnly(storePath);
    if (localBaselineCommit) {
      await assertHistoryExcludesLocalOnlyPaths(storePath, ["HEAD"], "local history selected for push");
      await assertEventPublicationCandidate(storePath, localBaselineCommit);
      await assertCommitTreeExcludesUnsafeEntryModes(storePath, localBaselineCommit, "local commit selected for push");
    }

    let pulledRemoteIdentityDigest: string | undefined;
    let remoteCommit: string | undefined;
    if (await hasRemoteHead(storePath)) {
      pulledRemoteIdentityDigest = await captureSoulGitFetchRemoteIdentityDigest(storePath);
      remoteCommit = await fetchVerifiedRemoteMainCommit(storePath);
    }

    await ensureGitIdentity(storePath);
    await ensureMainBranch(storePath);
    await ensureGitIgnore(storePath);
    await untrackLocalOnlyPaths(storePath);
    await git(storePath, ["add", "events", ".gitignore"]);

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
      } catch (error) {
        rethrowIfOperationDeadlineExceeded(error);
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
    const publicationCommit = await git(storePath, ["rev-parse", "HEAD"]);
    await assertEventPublicationTree(storePath, publicationCommit, [
      ...(localBaselineCommit ? [localBaselineCommit] : []),
      ...(remoteCommit ? [remoteCommit] : [])
    ]);
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
    await assertCommitTreeExcludesUnsafeEntryModes(storePath, publicationCommit, "commit selected for push");
    const remoteIdentityDigest = await captureSoulGitPushRemoteIdentityDigest(storePath);
    await git(storePath, ["push", "-u", "origin", "main"]);
    await recordPushedSoulSyncReceipts(storePath, remoteIdentityDigest, publicationCommit);
    await writeLastSync(storePath, "push");
    return withSyncResultSelectionSources({
      ok: true,
      committed,
      pushed: true,
      automatic_event_audit: automaticEventAudit
    });
  });
}
