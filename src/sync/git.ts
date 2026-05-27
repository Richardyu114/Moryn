import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { rebuildDerivedViews } from "../core/derived.js";

const exec = promisify(execFile);

export interface GitSyncStatus {
  configured: boolean;
  branch?: string;
  remote?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  last_sync?: GitLastSync;
  last_commit?: string;
  error?: string;
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
}

function validateRequiredString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateOptionalString(value: unknown, name: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateSyncOptions(options: unknown): asserts options is { message?: string } {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Invalid argument: Invalid sync options");
  }
  validateOptionalString((options as { message?: unknown }).message, "message");
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

async function ensureGitIdentity(storePath: string): Promise<void> {
  const hasName = await gitOk(storePath, ["config", "user.name"]);
  const hasEmail = await gitOk(storePath, ["config", "user.email"]);
  if (!hasName) await git(storePath, ["config", "user.name", "Memora"]);
  if (!hasEmail) await git(storePath, ["config", "user.email", "memora@example.local"]);
}

async function ensureGitIgnore(storePath: string): Promise<void> {
  await writeFile(join(storePath, ".gitignore"), "config.json\nsnapshots/\nindexes/\nstate/\n", "utf8");
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

export async function initializeGitSync(storePath: string, remoteUrl: string): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  validateRequiredString(remoteUrl, "remoteUrl");
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
  }

  await git(storePath, ["add", "events", ".gitignore"]);
  if (!await hasCommits(storePath)) {
    await git(storePath, ["commit", "-m", "Initialize Memora store"]);
    if (!await hasRemoteHead(storePath)) {
      await git(storePath, ["push", "-u", "origin", "main"]);
    }
  }
  await writeLastSync(storePath, "init");
  return { ok: true, message: "Git sync initialized" };
}

export async function getGitSyncStatus(storePath: string): Promise<GitSyncStatus> {
  validateRequiredString(storePath, "storePath");
  try {
    const configured = await gitOk(storePath, ["rev-parse", "--git-dir"]);
    if (!configured) return { configured: false, error: "Not a git repository" };

    const branch = await git(storePath, ["branch", "--show-current"]);
    const remote = await git(storePath, ["remote", "get-url", "origin"]).catch(() => undefined);
    if (remote) {
      await git(storePath, ["fetch", "origin", "main"]).catch(() => undefined);
    }
    const porcelain = await git(storePath, ["status", "--porcelain"]);
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
    return {
      configured: true,
      branch,
      remote,
      dirty: porcelain.length > 0,
      ahead,
      behind,
      last_sync: lastSync,
      last_commit: lastCommit
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: false, error: message };
  }
}

export async function pullGitSync(storePath: string): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  if (!await hasRemoteHead(storePath)) {
    return { ok: true, pulled: false, message: "Remote branch main does not exist yet" };
  }
  await git(storePath, ["fetch", "origin", "main"]);
  const hasLocal = await hasCommits(storePath);
  if (!hasLocal) {
    await git(storePath, ["checkout", "-B", "main", "origin/main"]);
    await rebuildDerivedViews(storePath);
    await writeLastSync(storePath, "pull");
    return { ok: true, pulled: true };
  }
  await git(storePath, ["pull", "--rebase", "origin", "main"]);
  await rebuildDerivedViews(storePath);
  await writeLastSync(storePath, "pull");
  return { ok: true, pulled: true };
}

export async function pushGitSync(storePath: string, options: { message?: string } = {}): Promise<GitSyncResult> {
  validateRequiredString(storePath, "storePath");
  validateSyncOptions(options);
  await ensureGitIgnore(storePath);
  await ensureGitIdentity(storePath);
  await ensureMainBranch(storePath);
  await git(storePath, ["add", "events", ".gitignore"]);

  const porcelain = await git(storePath, ["status", "--porcelain"]);
  let committed = false;
  if (porcelain.length > 0) {
    await git(storePath, ["commit", "-m", options.message ?? "Sync Memora events"]);
    committed = true;
  }

  if (await hasRemoteHead(storePath)) {
    await git(storePath, ["pull", "--rebase", "origin", "main"]);
  }
  await git(storePath, ["push", "-u", "origin", "main"]);
  await writeLastSync(storePath, "push");
  return { ok: true, committed, pushed: true };
}
