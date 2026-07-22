import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const LEASE_TIMEOUT_MS = 60_000;
// Keep this below the acquisition timeout so a crashed owner can be recovered
// in the same attempt; live cross-namespace owners refresh the inode mtime.
const LEASE_STALE_MS = 30_000;
const OWNERLESS_STATE_STALE_MS = 5_000;
const LEASE_POLL_MS = 25;
const RECOVERY_OWNER_NAME = "owner.json";
const RECOVERY_CLAIM_PREFIX = "owner.recover-";

interface HeldStateLease {
  active: boolean;
  nestedOperations: number;
  resolveDrained?: () => void;
}

interface StateLeaseOwner {
  token: string;
  pid: number;
}

interface RecoveryGate {
  release: () => Promise<void>;
}

const heldStateLeases = new AsyncLocalStorage<ReadonlyMap<string, HeldStateLease>>();

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

function ownerPayload(token: string, acquiredAt: string): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        token,
        pid: process.pid,
        acquired_at: acquiredAt
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeOwner(handle: FileHandle, token: string, acquiredAt: string): Promise<void> {
  const payload = ownerPayload(token, acquiredAt);
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
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown; pid?: unknown };
    if (typeof owner.token !== "string" || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0) {
      return undefined;
    }
    return { token: owner.token, pid: Number(owner.pid) };
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

function recoveryClaimPid(name: string): number | undefined {
  const match = /^owner\.recover-(\d+)-/.exec(name);
  if (!match?.[1]) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
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
  const recovererPid = recoveryClaimPid(claimName);
  if (recovererPid === undefined || processIsAlive(recovererPid)) return false;

  const claimPath = join(recoveryPath, claimName);
  const movedOwner = await readOwner(claimPath);
  if (movedOwner && processIsAlive(movedOwner.pid)) {
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

  if (observedOwner && processIsAlive(observedOwner.pid)) return false;
  if (observedOwnerUpdatedAt !== undefined && Date.now() - observedOwnerUpdatedAt <= OWNERLESS_STATE_STALE_MS) {
    return false;
  }

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
        (movedOwner && processIsAlive(movedOwner.pid))
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
  try {
    await mkdir(recoveryPath, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    await recoverRecoveryGate(recoveryPath, token);
    return undefined;
  }

  let ownerHandle: FileHandle | undefined;
  try {
    ownerHandle = await open(ownerPath, "wx", 0o600);
    await writeOwner(ownerHandle, token, new Date().toISOString());
    if ((await readOwnerToken(ownerPath)) !== token) {
      throw new Error("Store state recovery gate ownership changed during acquisition");
    }
  } catch (error) {
    await ownerHandle?.close().catch(() => undefined);
    if ((await readOwnerToken(ownerPath)) === token) await unlink(ownerPath).catch(() => undefined);
    await removeEmptyRecoveryGate(recoveryPath).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await ownerHandle.close();
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
    if (Date.now() - startedAt > LEASE_TIMEOUT_MS) {
      throw new Error("Store state recovery gate timed out");
    }
    await delay(LEASE_POLL_MS);
  }
}

async function recoverStaleLease(leasePath: string, ownerPath: string, token: string): Promise<boolean> {
  const observedOwnerUpdatedAt = await pathUpdatedAt(ownerPath);
  const observedUpdatedAt = observedOwnerUpdatedAt ?? (await pathUpdatedAt(leasePath));
  if (observedUpdatedAt === undefined) return false;
  const observedOwner = await readOwner(ownerPath);
  if (observedOwner && processIsAlive(observedOwner.pid)) return false;
  const staleAfter = observedOwnerUpdatedAt === undefined ? OWNERLESS_STATE_STALE_MS : LEASE_STALE_MS;
  if (Date.now() - observedUpdatedAt <= staleAfter) {
    return false;
  }

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
    (movedOwner !== undefined && processIsAlive(movedOwner.pid))
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
    if (Date.now() - startedAt > LEASE_TIMEOUT_MS) {
      throw new Error("Store state lease timed out");
    }
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
    await delay(LEASE_POLL_MS);
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

  return async () => {
    clearInterval(heartbeat);
    await pendingHeartbeat;
    await runWithRecoveryGate(recoveryPath, async () => {
      await ownerHandle.close();
      if ((await readOwnerToken(ownerPath)) === token) {
        await rm(leasePath, { recursive: true, force: true });
      }
    });
  };
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
  if (currentLease?.active) return runNestedWithLease(currentLease, work);

  const release = await acquireStateLease(canonicalPath);
  const lease: HeldStateLease = { active: true, nestedOperations: 0 };
  const nextLeases = new Map(currentLeases);
  nextLeases.set(canonicalPath, lease);
  try {
    return await heldStateLeases.run(nextLeases, work);
  } finally {
    await drainNestedOperationsAndDeactivate(lease);
    await release();
  }
}
