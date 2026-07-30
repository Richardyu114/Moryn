import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { win32 } from "node:path";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHILD_TERMINATION_GRACE_MS = 250;
const CHILD_GROUP_EXIT_WAIT_MS = 1_000;
const CHILD_GROUP_EXIT_POLL_MS = 10;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;
const WINDOWS_PROCESS_CREATION_TOLERANCE_MS = 2_000;
const DEFAULT_CHILD_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;

interface OperationDeadlineContext {
  deadlineAtMs: number;
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
}

const operationDeadlines = new AsyncLocalStorage<OperationDeadlineContext | undefined>();

export class OperationDeadlineExceededError extends Error {
  readonly code = "OPERATION_DEADLINE_EXCEEDED";
  readonly committed?: true;
  readonly recommended_action?: string;
  readonly recovery_hint?: { deadline_observed_after_commit: true; committed_result: unknown };

  constructor(committedResult?: unknown) {
    super("Operation deadline exceeded");
    this.name = "OperationDeadlineExceededError";
    if (committedResult !== undefined) {
      this.committed = true;
      this.recommended_action = "inspect the committed result before deciding whether to retry";
      this.recovery_hint = { deadline_observed_after_commit: true, committed_result: committedResult };
    }
  }
}

export class OperationCancelledError extends Error {
  readonly code = "OPERATION_CANCELLED";
  readonly committed?: true;
  readonly recommended_action?: string;
  readonly recovery_hint?: { cancellation_observed_after_commit: true; committed_result: unknown };

  constructor(committedResult?: unknown) {
    super("Operation cancelled");
    this.name = "OperationCancelledError";
    if (committedResult !== undefined) {
      this.committed = true;
      this.recommended_action = "inspect the committed result before deciding whether to retry";
      this.recovery_hint = { cancellation_observed_after_commit: true, committed_result: committedResult };
    }
  }
}

export class OperationChildProcessTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = "OperationChildProcessTimeoutError";
  }
}

export interface OperationChildProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawn_error?: Error;
  termination_error?: Error;
}

export interface OperationChildProcessHandle {
  child: ChildProcessWithoutNullStreams;
  completed: Promise<OperationChildProcessResult>;
  terminate: () => void;
}

export interface SpawnOperationChildProcessOptions {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExecOperationChildProcessOptions extends SpawnOperationChildProcessOptions {
  input?: string | Buffer;
  maxOutputBytes?: number;
}

function validateTimeoutMs(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid argument: timeout_ms must be a positive finite number");
  }
}

function cancellationError(signal?: AbortSignal): Error {
  if (isOperationDeadlineExceeded(signal?.reason) || isOperationCancelled(signal?.reason)) return signal.reason;
  return new OperationCancelledError();
}

function operationTerminationError(signal: AbortSignal | undefined, deadlineAtMs: number | undefined): Error {
  if (signal?.aborted) return cancellationError(signal);
  if (deadlineAtMs !== undefined && deadlineAtMs <= Date.now()) return new OperationDeadlineExceededError();
  return new OperationCancelledError();
}

function committedOperationValue(value: unknown): boolean {
  return typeof value === "object" && value !== null && "committed" in value && value.committed === true;
}

function cancellationAfterCommitError(signal: AbortSignal, result: unknown): Error {
  return isOperationDeadlineExceeded(signal.reason)
    ? new OperationDeadlineExceededError(result)
    : new OperationCancelledError(result);
}

function scheduleAbsoluteDeadline(deadlineAtMs: number, expire: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const remaining = deadlineAtMs - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  arm();
  return () => {
    if (timer) clearTimeout(timer);
  };
}

async function runDeadlineScopedWork<T>(context: OperationDeadlineContext, work: () => Promise<T>): Promise<T> {
  throwIfOperationDeadlineExceeded();
  try {
    const result = await work();
    if (!context.signal.aborted && context.deadlineAtMs <= Date.now()) context.abort();
    if (context.signal.aborted) {
      if (committedOperationValue(result)) throw cancellationAfterCommitError(context.signal, result);
      throw cancellationError(context.signal);
    }
    return result;
  } catch (error) {
    if (context.signal.aborted && !committedOperationValue(error)) throw cancellationError(context.signal);
    throw error;
  }
}

/**
 * Runs work under one absolute deadline. Nested callers may tighten, but never
 * extend, the budget inherited from their parent operation.
 *
 * The timer only requests cooperative cancellation through the inherited
 * AbortSignal. This function still awaits the started work before rejecting so
 * callers never observe a deadline while writes continue in the background.
 */
export async function withOperationDeadline<T>(
  timeoutMs: number,
  work: () => Promise<T>,
  externalSignal?: AbortSignal
): Promise<T> {
  validateTimeoutMs(timeoutMs);
  const requestedDeadline = Date.now() + timeoutMs;
  const inherited = operationDeadlines.getStore();
  if (inherited && inherited.deadlineAtMs <= requestedDeadline && !externalSignal) {
    return runDeadlineScopedWork(inherited, work);
  }

  const controller = new AbortController();
  const deadlineAtMs = inherited ? Math.min(inherited.deadlineAtMs, requestedDeadline) : requestedDeadline;
  const context: OperationDeadlineContext = {
    deadlineAtMs,
    signal: controller.signal,
    abort: (reason = new OperationDeadlineExceededError()) => controller.abort(reason)
  };
  const abortFromParent = () => controller.abort(cancellationError(inherited?.signal));
  const abortFromExternal = () => controller.abort(cancellationError(externalSignal));
  if (inherited?.signal.aborted) abortFromParent();
  else inherited?.signal.addEventListener("abort", abortFromParent, { once: true });
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  const cancelTimer = scheduleAbsoluteDeadline(deadlineAtMs, context.abort);

  try {
    return await operationDeadlines.run(context, () => runDeadlineScopedWork(context, work));
  } finally {
    cancelTimer();
    inherited?.signal.removeEventListener("abort", abortFromParent);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

/** Runs cleanup outside an expired inherited operation budget. */
export function withoutOperationDeadline<T>(work: () => Promise<T>): Promise<T> {
  return operationDeadlines.run(undefined, work);
}

export function currentOperationDeadlineSignal(): AbortSignal | undefined {
  return operationDeadlines.getStore()?.signal;
}

export function currentOperationDeadlineAtMs(): number | undefined {
  return operationDeadlines.getStore()?.deadlineAtMs;
}

export function throwIfOperationDeadlineExceeded(): void {
  const context = operationDeadlines.getStore();
  if (!context) return;
  if (!context.signal.aborted && context.deadlineAtMs <= Date.now()) context.abort();
  if (context.signal.aborted) throw cancellationError(context.signal);
}

/**
 * Returns the remaining inherited budget, optionally capped for a narrower
 * sub-operation. Callers without an inherited deadline retain their normal
 * timeout behavior.
 */
export function remainingOperationTimeMs(capMs?: number): number | undefined {
  if (capMs !== undefined) validateTimeoutMs(capMs);
  const context = operationDeadlines.getStore();
  if (!context) return capMs;
  throwIfOperationDeadlineExceeded();
  const remaining = Math.max(1, context.deadlineAtMs - Date.now());
  return capMs === undefined ? remaining : Math.min(remaining, capMs);
}

export function isOperationDeadlineExceeded(error: unknown): error is OperationDeadlineExceededError {
  return (
    error instanceof OperationDeadlineExceededError ||
    (error instanceof Error && "code" in error && error.code === "OPERATION_DEADLINE_EXCEEDED")
  );
}

export function isOperationCancelled(error: unknown): error is OperationCancelledError {
  return (
    error instanceof OperationCancelledError ||
    (error instanceof Error && "code" in error && error.code === "OPERATION_CANCELLED")
  );
}

export function rethrowIfOperationDeadlineExceeded(error: unknown): void {
  if (isOperationDeadlineExceeded(error) || isOperationCancelled(error)) throw error;
}

function signalProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function processGroupExists(processGroupId: number | undefined): boolean {
  if (!processGroupId || process.platform === "win32") return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function waitForProcessGroupExit(processGroupId: number | undefined): Promise<void> {
  const deadlineAtMs = Date.now() + CHILD_GROUP_EXIT_WAIT_MS;
  return new Promise((resolve) => {
    const inspect = () => {
      if (!processGroupExists(processGroupId) || Date.now() >= deadlineAtMs) {
        resolve();
        return;
      }
      setTimeout(inspect, CHILD_GROUP_EXIT_POLL_MS);
    };
    inspect();
  });
}

function windowsSystemExecutables(): { system_directory: string; taskkill: string; powershell: string } | undefined {
  const rawRoot = process.env.SystemRoot ?? process.env.WINDIR ?? process.env.windir;
  if (!rawRoot || rawRoot.includes("\0") || !win32.isAbsolute(rawRoot)) return undefined;
  const normalizedRoot = win32.normalize(rawRoot);
  const parsedRoot = win32.parse(normalizedRoot).root;
  if (!/^[a-z]:\\$/iu.test(parsedRoot)) return undefined;
  const systemDirectory = win32.join(normalizedRoot, "System32");
  return {
    system_directory: systemDirectory,
    taskkill: win32.join(systemDirectory, "taskkill.exe"),
    powershell: win32.join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")
  };
}

function runWindowsCleanupCommand(command: string, args: string[], cwd: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    const cleanup = spawn(command, args, { cwd, stdio: "ignore", windowsHide: true });
    let settled = false;
    const finish = (code: number | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };
    const timer = setTimeout(() => {
      try {
        cleanup.kill("SIGKILL");
      } catch {
        // The bounded cleanup helper may already have exited.
      }
      finish(undefined);
    }, WINDOWS_TREE_KILL_TIMEOUT_MS);
    cleanup.once("error", () => finish(undefined));
    cleanup.once("close", (code) => finish(code ?? undefined));
  });
}

function windowsDescendantCleanupScript(
  rootPid: number,
  earliestCreationAtMs: number,
  latestCreationAtMs: number
): string {
  return [
    `$rootId = [uint32]${rootPid};`,
    `$earliest = [DateTimeOffset]::FromUnixTimeMilliseconds(${earliestCreationAtMs}).UtcDateTime;`,
    `$latest = [DateTimeOffset]::FromUnixTimeMilliseconds(${latestCreationAtMs}).UtcDateTime;`,
    "$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue);",
    "$ids = [System.Collections.Generic.HashSet[uint32]]::new();",
    "[void]$ids.Add($rootId);",
    "do { $added = $false; foreach ($item in $all) { $parentId = [uint32]$item.ParentProcessId; $processId = [uint32]$item.ProcessId; $created = $item.CreationDate; if ($ids.Contains($parentId) -and $null -ne $created -and $created.ToUniversalTime() -ge $earliest -and $created.ToUniversalTime() -le $latest -and $ids.Add($processId)) { $added = $true } } } while ($added);",
    "foreach ($processId in @($ids)) { if ($processId -ne $rootId) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue } }"
  ].join(" ");
}

async function forceKillWindowsProcessTree(
  child: ChildProcessWithoutNullStreams,
  childSpawnedAtMs: number,
  directChildExitTime: () => number | undefined
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // The child may have failed to spawn or already exited.
    }
    return;
  }

  const systemExecutables = windowsSystemExecutables();
  const taskkillCode = systemExecutables
    ? await runWindowsCleanupCommand(
        systemExecutables.taskkill,
        ["/pid", String(pid), "/T", "/F"],
        systemExecutables.system_directory
      )
    : undefined;
  if (taskkillCode !== 0 && systemExecutables) {
    // Windows can publish the direct child's exit while a descendant still
    // owns inherited pipes. taskkill cannot traverse from an already-exited
    // root, so fall back to a bounded Win32_Process ancestry snapshot whose
    // ParentProcessId values survive the root exit.
    await runWindowsCleanupCommand(
      systemExecutables.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        windowsDescendantCleanupScript(
          pid,
          childSpawnedAtMs - WINDOWS_PROCESS_CREATION_TOLERANCE_MS,
          directChildExitTime() ?? Date.now()
        )
      ],
      systemExecutables.system_directory
    );
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The direct child may already have exited.
  }
  // Never let an uncooperative descendant retain our local pipe handles after
  // both bounded process-tree cleanup strategies have completed.
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

/**
 * Spawns a child in its own POSIX process group. An inherited operation abort
 * sends TERM, escalates to KILL after a short grace period, and `completed`
 * settles only after Node observes the child's close event.
 */
export function spawnOperationChildProcess(
  command: string,
  args: readonly string[],
  options: SpawnOperationChildProcessOptions
): OperationChildProcessHandle {
  if (options.timeoutMs !== undefined) validateTimeoutMs(options.timeoutMs);
  throwIfOperationDeadlineExceeded();

  const operationSignal = currentOperationDeadlineSignal();
  const operationDeadlineAtMs = currentOperationDeadlineAtMs();
  const childSpawnedAtMs = Date.now();
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  let spawnError: Error | undefined;
  let terminationError: Error | undefined;
  let localTimeout: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let directChildExitedAtMs: number | undefined;
  let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let terminationStarted = false;
  let terminationCleanupComplete = true;
  let posixKillInFlight: Promise<void> | undefined;
  let completedResolved = false;
  let resolveCompleted: (result: OperationChildProcessResult) => void;

  child.once("exit", () => {
    directChildExitedAtMs = Date.now();
  });

  const maybeResolveCompleted = () => {
    if (!closeResult || (terminationStarted && !terminationCleanupComplete) || completedResolved) return;
    completedResolved = true;
    if (localTimeout) clearTimeout(localTimeout);
    operationSignal?.removeEventListener("abort", abortForOperation);
    resolveCompleted({
      ...closeResult,
      ...(spawnError ? { spawn_error: spawnError } : {}),
      ...(terminationError ? { termination_error: terminationError } : {})
    });
  };

  const forceKillPosixGroup = () => {
    if (terminationCleanupComplete || posixKillInFlight) return;
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    try {
      signalProcessGroup(child, "SIGKILL");
    } catch (error) {
      spawnError ??= error instanceof Error ? error : new Error(String(error));
    }
    posixKillInFlight = waitForProcessGroupExit(child.pid).finally(() => {
      terminationCleanupComplete = true;
      maybeResolveCompleted();
    });
  };

  const terminate = (reason?: Error) => {
    terminationError ??= reason;
    if (closed || terminationStarted) return;
    terminationStarted = true;
    terminationCleanupComplete = false;
    if (process.platform === "win32") {
      void forceKillWindowsProcessTree(child, childSpawnedAtMs, () => directChildExitedAtMs)
        .catch((error: unknown) => {
          spawnError ??= error instanceof Error ? error : new Error(String(error));
        })
        .finally(() => {
          terminationCleanupComplete = true;
          maybeResolveCompleted();
        });
      return;
    }
    try {
      signalProcessGroup(child, "SIGTERM");
    } catch (error) {
      spawnError ??= error instanceof Error ? error : new Error(String(error));
    }
    killTimer = setTimeout(forceKillPosixGroup, CHILD_TERMINATION_GRACE_MS);
  };

  const abortForOperation = () => terminate(operationTerminationError(operationSignal, operationDeadlineAtMs));
  if (operationSignal?.aborted) abortForOperation();
  else operationSignal?.addEventListener("abort", abortForOperation, { once: true });

  if (options.timeoutMs !== undefined) {
    localTimeout = setTimeout(() => {
      if (operationSignal?.aborted || (operationDeadlineAtMs !== undefined && operationDeadlineAtMs <= Date.now())) {
        abortForOperation();
      } else {
        terminate(new OperationChildProcessTimeoutError(command, options.timeoutMs!));
      }
    }, options.timeoutMs);
    localTimeout.unref();
  }

  const completed = new Promise<OperationChildProcessResult>((resolve) => {
    resolveCompleted = resolve;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      closed = true;
      closeResult = { code, signal };
      // A direct child can close while a descendant has detached from stdio
      // but remains in its POSIX process group. Preserve the TERM grace while
      // withholding completion; only finish early when the whole group is
      // already gone.
      if (terminationStarted && process.platform !== "win32" && !processGroupExists(child.pid)) {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
        terminationCleanupComplete = true;
      }
      maybeResolveCompleted();
    });
  });

  return { child, completed, terminate: () => terminate() };
}

export async function execOperationChildProcess(
  command: string,
  args: readonly string[],
  options: ExecOperationChildProcessOptions
): Promise<{ stdout: string; stderr: string }> {
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CHILD_OUTPUT_LIMIT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("Invalid argument: max_output_bytes must be a positive safe integer");
  }
  const handle = spawnOperationChildProcess(command, args, options);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputError: Error | undefined;
  const collect = (chunks: Buffer[], stream: "stdout" | "stderr") => (chunk: Buffer) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (outputError) return;
    if (stream === "stdout") stdoutBytes += buffer.length;
    else stderrBytes += buffer.length;
    if (stdoutBytes + stderrBytes > maxOutputBytes) {
      outputError = new Error(`${command} output exceeded ${maxOutputBytes} bytes`);
      handle.terminate();
      return;
    }
    chunks.push(buffer);
  };
  handle.child.stdout.on("data", collect(stdout, "stdout"));
  handle.child.stderr.on("data", collect(stderr, "stderr"));
  handle.child.stdin.on("error", () => {
    // Child completion owns the stable error outcome.
  });
  handle.child.stdin.end(options.input);

  const result = await handle.completed;
  const stdoutText = Buffer.concat(stdout).toString("utf8");
  const stderrText = Buffer.concat(stderr).toString("utf8");
  if (result.termination_error) throw result.termination_error;
  if (outputError) throw outputError;
  if (result.spawn_error) throw result.spawn_error;
  if (result.code !== 0) {
    const detail = stderrText.trim();
    const error = new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.code ?? "unknown"}${detail ? `: ${detail}` : ""}`
    ) as Error & { code?: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string };
    error.code = result.code;
    error.signal = result.signal;
    error.stdout = stdoutText;
    error.stderr = stderrText;
    throw error;
  }
  return { stdout: stdoutText, stderr: stderrText };
}
