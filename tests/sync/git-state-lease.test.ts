import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { withStoreStateLease } from "../../src/core/state-lease.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function holdStoreLease(storePath: string): Promise<() => Promise<void>> {
  const entered = deferred();
  const release = deferred();
  const owner = withStoreStateLease(storePath, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return async () => {
    release.resolve();
    await owner;
  };
}

async function isStillPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false
    ),
    delay(100).then(() => true)
  ]);
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await delay(20);
  }
}

describe("git sync store-state lease", () => {
  it("serializes every mutating sync entry point while status remains a non-locking read", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-lease-entrypoints-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    let releaseHeldLease: (() => Promise<void>) | undefined;
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_sync_lease" });

      releaseHeldLease = await holdStoreLease(store);
      const initialize = initializeGitSync(store, remote);
      expect(await isStillPending(initialize)).toBe(true);
      await releaseHeldLease();
      releaseHeldLease = undefined;
      await expect(initialize).resolves.toMatchObject({ ok: true });

      releaseHeldLease = await holdStoreLease(store);
      const status = getGitSyncStatus(store);
      await expect(
        Promise.race([status, delay(5_000).then(() => Promise.reject(new Error("status waited for state lease")))])
      ).resolves.toMatchObject({ configured: true });

      const pull = pullGitSync(store);
      expect(await isStillPending(pull)).toBe(true);
      await releaseHeldLease();
      releaseHeldLease = undefined;
      await expect(pull).resolves.toMatchObject({ ok: true });

      releaseHeldLease = await holdStoreLease(store);
      const push = pushGitSync(store);
      expect(await isStillPending(push)).toBe(true);
      await releaseHeldLease();
      releaseHeldLease = undefined;
      await expect(push).resolves.toMatchObject({ ok: true, pushed: true });

      await expect(
        Promise.race([
          withStoreStateLease(store, () => pullGitSync(store)),
          delay(5_000).then(() => Promise.reject(new Error("nested sync lease deadlocked")))
        ])
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await releaseHeldLease?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an append outside a blocked push transaction and preserves it for the next push", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-lease-push-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const hookEntered = join(root, "pre-push-entered");
    const hookRelease = join(root, "pre-push-release");
    const hookPath = join(store, ".git", "hooks", "pre-push");
    let blockedPush: Promise<unknown> | undefined;
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_push_lease" });
      await initializeGitSync(store, remote);

      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-21T00:00:00.000Z",
        id: (prefix) => `${prefix}_before_push`
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "lease-test",
        content: { text: "Commit this event before blocking the push.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_push_lease" }
      });

      await writeFile(
        hookPath,
        `#!/bin/sh\nset -eu\n: > "${hookEntered}"\nwhile [ ! -e "${hookRelease}" ]; do sleep 0.02; done\n`,
        "utf8"
      );
      await chmod(hookPath, 0o755);

      blockedPush = pushGitSync(store, { message: "push while append competes" });
      await waitForPath(hookEntered);

      const competingEngine = createEngine({
        storePath: store,
        now: () => "2026-07-21T00:01:00.000Z",
        id: (prefix) => `${prefix}_during_push`
      });
      const append = competingEngine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "lease-test",
        content: { text: "This event must wait until the push transaction ends.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_push_lease" }
      });
      expect(await isStillPending(append)).toBe(true);

      await writeFile(hookRelease, "release\n", "utf8");
      await expect(blockedPush).resolves.toMatchObject({
        ok: true,
        pushed: true,
        automatic_event_audit: { status: "completed", event_count: 1, record_count: 1 }
      });
      blockedPush = undefined;
      await append;
      const competingEventId = "evt_during_push";

      const remoteBeforeNextPush = (await exec("git", ["ls-tree", "-r", "origin/main", "--", "events"], { cwd: store }))
        .stdout;
      expect(remoteBeforeNextPush).not.toContain(competingEventId);
      expect((await exec("git", ["status", "--porcelain"], { cwd: store })).stdout).toContain(competingEventId);

      await rm(hookPath, { force: true });
      await pushGitSync(store, { message: "push append that waited for prior transaction" });
      expect((await exec("git", ["ls-tree", "-r", "origin/main", "--", "events"], { cwd: store })).stdout).toContain(
        competingEventId
      );
    } finally {
      await writeFile(hookRelease, "release\n", "utf8").catch(() => undefined);
      await blockedPush?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});
