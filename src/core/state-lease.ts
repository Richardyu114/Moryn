import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  currentOperationDeadlineSignal,
  isOperationDeadlineExceeded,
  OperationDeadlineExceededError,
  throwIfOperationDeadlineExceeded,
  withoutOperationDeadline
} from "./operation-deadline.js";

const LEASE_TIMEOUT_MS = 60_000;
// Keep this below the acquisition timeout so a crashed owner can be recovered
// in the same attempt; live cross-namespace owners refresh the inode mtime.
const LEASE_STALE_MS = 30_000;
const OWNERLESS_STATE_STALE_MS = 5_000;
const LEASE_POLL_MS = 25;
const LEASE_RELEASE_GATE_TIMEOUT_MS = 500;
const RECOVERY_OWNER_NAME = "owner.json";
const RECOVERY_CLAIM_PREFIX = "owner.recover-";
const RECOVERY_PENDING_SUFFIX = ".pending-";

interface HeldStateLease {
  active: boolean;
  nestedOperations: number;
  resolveDrained?: () => void;
}

interface StateLeaseOwner {
  token: string;
  pid: number;
  process_instance_id?: string;
  process_start_identity?: string;
}

interface RecoveryGate {
  release: () => Promise<void>;
}

class RecoveryGateTimeoutError extends Error {
  constructor() {
    super("Store state recovery gate timed out");
    this.name = "RecoveryGateTimeoutError";
  }
}

const heldStateLeases = new AsyncLocalStorage<ReadonlyMap<string, HeldStateLease>>();
const PROCESS_INSTANCE_ID = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function newOwnerToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function canonicalStorePath(storePath: string): Promise<string> {
  const absolutePath = resolve(storePath);
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return absolutePath;
    throw error;
  }
}

function ownerPayload(token: string, acquiredAt: string, processStartIdentity: string | undefined): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        token,
        pid: process.pid,
        acquired_at: acquiredAt,
        process_instance_id: PROCESS_INSTANCE_ID,
        ...(processStartIdentity ? { process_start_identity: processStartIdentity } : {})
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeOwner(handle: FileHandle, token: string, acquiredAt: string): Promise<void> {
  const payload = ownerPayload(token, acquiredAt, (await linuxProcessIdentity(process.pid))?.identity);
  let offset = 0;
  while (offset < payload.length) {
    const { bytesWritten } = await handle.write(payload, offset, payload.length - offset, offset);
    if (bytesWritten === 0) throw new Error("Store state lease owner write made no progress");
    offset += bytesWritten;
  }
  await handle.truncate(payload.length);
  await handle.sync();
}

async function readOwner(ownerPath: string): Promise<StateLeaseOwner | undefined> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as {
      token?: unknown;
      pid?: unknown;
      process_instance_id?: unknown;
      process_start_identity?: unknown;
    };
    if (typeof owner.token !== "string" || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) {
      return undefined;
    }
    return {
      token: owner.token,
      pid: Number(owner.pid),
      ...(typeof owner.process_instance_id === "string" ? { process_instance_id: owner.process_instance_id } : {}),
      ...(typeof owner.process_start_identity === "string"
        ? { process_start_identity: owner.process_start_identity }
        : {})
    };
  } catch {
    return undefined;
  }
}

async function readOwnerToken(ownerPath: string): Promise<string | undefined> {
  return (await readOwner(ownerPath))?.token;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasErrorCode(error, "ESRCH");
  }
}

async function linuxProcessIdentity(pid: number): Promise<{ identity: string; state: string } | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const [statText, bootId, pidNamespace] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readlink(`/proc/${pid}/ns/pid`)
    ]);
    const commandEnd = statText.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    // /proc/<pid>/stat field 3 begins after the parenthesized command. The
    // process start time is field 22, hence index 19 in this remainder.
    const fields = statText
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const state = fields[0];
    const startTicks = fields[19];
    const normalizedBootId = bootId.trim();
    if (!state || !startTicks || !/^\d+$/u.test(startTicks) || !normalizedBootId || !pidNamespace) return undefined;
    return { identity: `${normalizedBootId}:${pidNamespace}:${startTicks}`, state };
  } catch {
    return undefined;
  }
}

async function ownerIsDefinitelyLive(owner: StateLeaseOwner): Promise<boolean> {
  if (!processIsAlive(owner.pid)) return false;
  if (owner.pid === process.pid && owner.process_instance_id === PROCESS_INSTANCE_ID) return true;
  // Native Windows/macOS do not expose Linux PID namespace/start-tick
  // identity. Preserve the conservative live-PID behavior there rather than
  // stealing a genuinely live cross-process lease after a delayed heartbeat.
  if (process.platform !== "linux") return true;
  const currentProcess = await linuxProcessIdentity(owner.pid);
  if (currentProcess === undefined) return true;
  if (currentProcess.state === "Z" || currentProcess.state === "X") return false;
  // Missing identity is ambiguous, including during a rolling upgrade while
  // an older Moryn process still owns the lease. Preserve mutual exclusion;
  // new owners carry namespace-aware identity so a stale cross-container PID
  // collision is recoverable without making this unsafe guess.
  if (!owner.process_start_identity) return true;
  return owner.process_start_identity === currentProcess.identity;
}

async function pathUpdatedAt(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function leaseUpdatedAt(leasePath: string, ownerPath: string): Promise<number | undefined> {
  return (await pathUpdatedAt(ownerPath)) ?? pathUpdatedAt(leasePath);
}

async function restoreRecoveryOwner(claimPath: string, ownerPath: string): Promise<void> {
  try {
    await rename(claimPath, ownerPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "EEXIST")) throw error;
  }
}

function recoveryClaimIdentity(name: string): { pid: number; claimed_at_ms: number } | undefined {
  const match = /^owner\.recover-(\d+)-(\d+)-[a-f0-9]+\.json$/u.exec(name);
  if (!match?.[1] || !match[2]) return undefined;
  const pid = Number(match[1]);
  const claimedAtMs = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(claimedAtMs) || claimedAtMs <= 0) {
    return undefined;
  }
  return { pid, claimed_at_ms: claimedAtMs };
}

async function removeEmptyRecoveryGate(recoveryPath: string): Promise<boolean> {
  try {
    await rmdir(recoveryPath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    if (hasErrorCode(error, "ENOTEMPTY") || hasErrorCode(error, "EEXIST")) return false;
    throw error;
  }
}

async function recoverAbandonedGateClaim(recoveryPath: string, ownerPath: string, claimName: string): Promise<boolean> {
  const claim = recoveryClaimIdentity(claimName);
  const claimPath = join(recoveryPath, claimName);
  if (claim === undefined) return false;
  const claimUpdatedAt = await pathUpdatedAt(claimPath);
  // rename preserves the stale owner's mtime, so the timestamp embedded in
  // the unique claim name protects the new recoverer during the handoff race.
  // A resumed original owner can also refresh the renamed inode's mtime.
  const latestActivityAt = Math.max(claim.claimed_at_ms, claimUpdatedAt ?? 0);
  if (Date.now() - latestActivityAt <= OWNERLESS_STATE_STALE_MS) return false;

  const movedOwner = await readOwner(claimPath);
  if (movedOwner && (await ownerIsDefinitelyLive(movedOwner))) {
    await restoreRecoveryOwner(claimPath, ownerPath);
    return false;
  }
  await rm(claimPath, { force: true });
  return true;
}

async function recoverRecoveryGate(recoveryPath: string, recoveryToken: string): Promise<boolean> {
  const ownerPath = join(recoveryPath, RECOVERY_OWNER_NAME);
  const observedOwner = await readOwner(ownerPath);
  const observedOwnerUpdatedAt = await pathUpdatedAt(ownerPath);

  if (observedOwnerUpdatedAt !== undefined && Date.now() - observedOwnerUpdatedAt <= OWNERLESS_STATE_STALE_MS) {
    return false;
  }
  if (observedOwner && (await ownerIsDefinitelyLive(observedOwner))) return false;

  if (observedOwnerUpdatedAt !== undefined) {
    const claimPath = join(recoveryPath, `${RECOVERY_CLAIM_PREFIX}${recoveryToken}.json`);
    try {
      await rename(ownerPath, claimPath);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return false;
      throw error;
    }

    try {
      const movedOwner = await readOwner(claimPath);
      if (
        (observedOwner && movedOwner?.token !== observedOwner.token) ||
        (movedOwner && (await ownerIsDefinitelyLive(movedOwner)))
      ) {
        await restoreRecoveryOwner(claimPath, ownerPath);
        return false;
      }
      await unlink(claimPath);
    } catch (error) {
      await restoreRecoveryOwner(claimPath, ownerPath).catch(() => undefined);
      throw error;
    }
    return removeEmptyRecoveryGate(recoveryPath);
  }

  let entries: string[];
  try {
    entries = await readdir(recoveryPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.startsWith(RECOVERY_CLAIM_PREFIX)) continue;
    if (!(await recoverAbandonedGateClaim(recoveryPath, ownerPath, entry))) return false;
  }

  const remainingEntries = await readdir(recoveryPath).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  });
  if (remainingEntries.length > 0) return false;

  const gateUpdatedAt = await pathUpdatedAt(recoveryPath);
  if (gateUpdatedAt !== undefined && Date.now() - gateUpdatedAt <= OWNERLESS_STATE_STALE_MS) {
    return false;
  }
  return removeEmptyRecoveryGate(recoveryPath);
}

async function tryAcquireRecoveryGate(recoveryPath: string): Promise<RecoveryGate | undefined> {
  const token = newOwnerToken();
  const ownerPath = join(recoveryPath, RECOVERY_OWNER_NAME);
  const pendingRecoveryPath = `${recoveryPath}${RECOVERY_PENDING_SUFFIX}${token}`;
  const pendingOwnerPath = join(pendingRecoveryPath, RECOVERY_OWNER_NAME);
  let pendingOwnerHandle: FileHandle | undefined;
  let published = false;
  try {
    await mkdir(pendingRecoveryPath, { mode: 0o700 });
    pendingOwnerHandle = await open(pendingOwnerPath, "wx", 0o600);
    await writeOwner(pendingOwnerHandle, token, new Date().toISOString());
    await pendingOwnerHandle.close();
    pendingOwnerHandle = undefined;

    try {
      await rename(pendingRecoveryPath, recoveryPath);
      published = true;
    } catch (error) {
      const recoveryPathExists = await pathUpdatedAt(recoveryPath);
      const destinationExists =
        hasErrorCode(error, "EEXIST") ||
        hasErrorCode(error, "ENOTEMPTY") ||
        (hasErrorCode(error, "EPERM") && recoveryPathExists !== undefined);
      if (!destinationExists) throw error;
      await rm(pendingRecoveryPath, { recursive: true, force: true });
      await recoverRecoveryGate(recoveryPath, token);
      return undefined;
    }

    if ((await readOwnerToken(ownerPath)) !== token) {
      throw new Error("Store state recovery gate ownership changed during acquisition");
    }
  } catch (error) {
    await pendingOwnerHandle?.close().catch(() => undefined);
    await rm(pendingRecoveryPath, { recursive: true, force: true }).catch(() => undefined);
    if (published && (await readOwnerToken(ownerPath)) === token) {
      await unlink(ownerPath).catch(() => undefined);
      await removeEmptyRecoveryGate(recoveryPath).catch(() => undefined);
    }
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      if ((await readOwnerToken(ownerPath)) !== token) return;
      await unlink(ownerPath);
      await removeEmptyRecoveryGate(recoveryPath);
    }
  };
}

async function withRecoveryGate<T>(
  recoveryPath: string,
  work: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const gate = await tryAcquireRecoveryGate(recoveryPath);
  if (!gate) return { acquired: false };
  try {
    return { acquired: true, value: await work() };
  } finally {
    await gate.release();
  }
}

async function runWithRecoveryGate<T>(recoveryPath: string, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    const gated = await withRecoveryGate(recoveryPath, work);
    if (gated.acquired) return gated.value;
    if (Date.now() - startedAt >= LEASE_RELEASE_GATE_TIMEOUT_MS) {
      throw new RecoveryGateTimeoutError();
    }
    await delay(LEASE_POLL_MS);
  }
}

async function operationAwarePollDelay(): Promise<void> {
  const signal = currentOperationDeadlineSignal();
  try {
    await delay(LEASE_POLL_MS, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) {
      throw isOperationDeadlineExceeded(signal.reason) ? signal.reason : new OperationDeadlineExceededError();
    }
    throw error;
  }
}

function assertLeaseAcquisitionBudget(startedAt: number): void {
  throwIfOperationDeadlineExceeded();
  if (Date.now() - startedAt >= LEASE_TIMEOUT_MS) throw new Error("Store state lease timed out");
}

async function releaseOwnedLeaseWithoutRecoveryGate(
  leasePath: string,
  ownerPath: string,
  token: string
): Promise<void> {
  if ((await readOwnerToken(ownerPath)) !== token) return;
  const releasedPath = `${leasePath}.released-${token}`;
  try {
    await rename(leasePath, releasedPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }

  const movedOwnerPath = join(releasedPath, "owner.json");
  if ((await readOwnerToken(movedOwnerPath)) !== token) {
    try {
      await rename(releasedPath, leasePath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    throw new Error("Store state lease ownership changed during release");
  }
  await rm(releasedPath, { recursive: true, force: true });
}

async function recoverStaleLease(leasePath: string, ownerPath: string, token: string): Promise<boolean> {
  const observedOwnerUpdatedAt = await pathUpdatedAt(ownerPath);
  const observedUpdatedAt = observedOwnerUpdatedAt ?? (await pathUpdatedAt(leasePath));
  if (observedUpdatedAt === undefined) return false;
  const observedOwner = await readOwner(ownerPath);
  const staleAfter = observedOwnerUpdatedAt === undefined ? OWNERLESS_STATE_STALE_MS : LEASE_STALE_MS;
  if (Date.now() - observedUpdatedAt <= staleAfter) {
    return false;
  }
  if (observedOwner && (await ownerIsDefinitelyLive(observedOwner))) return false;

  const stalePath = `${leasePath}.stale-${token}`;
  try {
    await rename(leasePath, stalePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  const movedOwnerPath = join(stalePath, "owner.json");
  const movedUpdatedAt = await leaseUpdatedAt(stalePath, movedOwnerPath);
  const movedOwner = await readOwner(movedOwnerPath);
  if (
    movedUpdatedAt !== observedUpdatedAt ||
    movedOwner?.token !== observedOwner?.token ||
    (movedOwner !== undefined && (await ownerIsDefinitelyLive(movedOwner)))
  ) {
    await rename(stalePath, leasePath);
    return false;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function acquireStateLease(storePath: string): Promise<() => Promise<void>> {
  const statePath = join(storePath, "state");
  const leasePath = join(statePath, "store-state.lease");
  const ownerPath = join(leasePath, "owner.json");
  const recoveryPath = join(statePath, "store-state.recovery");
  const token = newOwnerToken();
  const startedAt = Date.now();
  const acquiredAt = new Date().toISOString();
  let ownerHandle: FileHandle | undefined;

  await mkdir(statePath, { recursive: true, mode: 0o700 });
  await chmod(statePath, 0o700);
  while (!ownerHandle) {
    assertLeaseAcquisitionBudget(startedAt);
    const gated = await withRecoveryGate(recoveryPath, async () => {
      try {
        await mkdir(leasePath, { mode: 0o700 });
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        await recoverStaleLease(leasePath, ownerPath, token);
        return undefined;
      }

      const pendingOwnerPath = join(leasePath, `owner.pending-${token}.json`);
      let pendingOwner: FileHandle | undefined;
      let createdOwner: FileHandle | undefined;
      try {
        pendingOwner = await open(pendingOwnerPath, "wx", 0o600);
        await writeOwner(pendingOwner, token, acquiredAt);
        await pendingOwner.close();
        pendingOwner = undefined;
        await rename(pendingOwnerPath, ownerPath);
        createdOwner = await open(ownerPath, "r+");
        if ((await readOwnerToken(ownerPath)) !== token) {
          throw new Error("Store state lease ownership changed during acquisition");
        }
        return createdOwner;
      } catch (error) {
        await pendingOwner?.close().catch(() => undefined);
        await createdOwner?.close().catch(() => undefined);
        await rm(leasePath, { recursive: true, force: true });
        throw error;
      }
    });
    if (gated.acquired && gated.value) {
      ownerHandle = gated.value;
      break;
    }
    assertLeaseAcquisitionBudget(startedAt);
    await operationAwarePollDelay();
  }

  let pendingHeartbeat: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (pendingHeartbeat) return;
    const now = new Date();
    pendingHeartbeat = ownerHandle
      ?.utimes(now, now)
      .catch(() => undefined)
      .finally(() => {
        pendingHeartbeat = undefined;
      });
  }, LEASE_STALE_MS / 4);
  heartbeat.unref();

  let released = false;
  let releaseInFlight: Promise<void> | undefined;
  const performRelease = async () => {
    clearInterval(heartbeat);
    await pendingHeartbeat;
    let closeError: unknown;
    try {
      await ownerHandle.close();
    } catch (error) {
      closeError = error;
    }
    try {
      await runWithRecoveryGate(recoveryPath, async () => {
        if ((await readOwnerToken(ownerPath)) === token) {
          await rm(leasePath, { recursive: true, force: true });
        }
      });
    } catch {
      // A wedged recovery-gate owner must not make us abandon our own lease.
      // The token-checked rename is atomic and leaves the canonical lease path
      // immediately available to the next owner.
      await releaseOwnedLeaseWithoutRecoveryGate(leasePath, ownerPath, token);
    }
    released = true;
    if (closeError) throw closeError;
  };
  const release = async () => {
    if (released) return;
    releaseInFlight ??= performRelease().finally(() => {
      releaseInFlight = undefined;
    });
    await releaseInFlight;
  };

  try {
    // Acquisition can complete in the same millisecond that the inherited
    // operation expires. Never enter protected work without rechecking it.
    throwIfOperationDeadlineExceeded();
    return release;
  } catch (error) {
    await withoutOperationDeadline(release);
    throw error;
  }
}

async function runNestedWithLease<T>(lease: HeldStateLease, work: () => Promise<T>): Promise<T> {
  lease.nestedOperations += 1;
  try {
    return await work();
  } finally {
    lease.nestedOperations -= 1;
    if (lease.nestedOperations === 0) {
      lease.resolveDrained?.();
      lease.resolveDrained = undefined;
    }
  }
}

async function drainNestedOperationsAndDeactivate(lease: HeldStateLease): Promise<void> {
  while (lease.nestedOperations > 0) {
    await new Promise<void>((resolveDrain) => {
      lease.resolveDrained = resolveDrain;
    });
  }
  // No async work can interleave between the zero check and this assignment.
  // Closing reentrancy here lets already-started nested work enter recursively
  // while ensuring later work inherited from this context acquires a new lease.
  lease.active = false;
}

/**
 * Serializes state-changing work for one store across async callers and processes.
 * Nested work on the same async call chain reuses the active lease. The outer
 * owner drains already-started nested work before publishing the release.
 */
export async function withStoreStateLease<T>(storePath: string, work: () => Promise<T>): Promise<T> {
  const canonicalPath = await canonicalStorePath(storePath);
  const currentLeases = heldStateLeases.getStore();
  const currentLease = currentLeases?.get(canonicalPath);
  if (currentLease?.active) {
    throwIfOperationDeadlineExceeded();
    return runNestedWithLease(currentLease, work);
  }

  const release = await acquireStateLease(canonicalPath);
  const lease: HeldStateLease = { active: true, nestedOperations: 0 };
  const nextLeases = new Map(currentLeases);
  nextLeases.set(canonicalPath, lease);
  let workOutcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    throwIfOperationDeadlineExceeded();
    workOutcome = { ok: true, value: await heldStateLeases.run(nextLeases, work) };
  } catch (error) {
    workOutcome = { ok: false, error };
  }

  const cleanupErrors: unknown[] = [];
  try {
    await drainNestedOperationsAndDeactivate(lease);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await withoutOperationDeadline(release);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (!workOutcome.ok) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [workOutcome.error, ...cleanupErrors],
        "Store state lease work and cleanup both failed",
        { cause: workOutcome.error }
      );
    }
    throw workOutcome.error;
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Store state lease cleanup failed");
  return workOutcome.value;
}
