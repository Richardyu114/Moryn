import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { createEngine } from "../../src/core/engine.js";
import { initializeStore } from "../../src/core/config.js";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);

async function expectInvalidArgument(action: () => Promise<unknown>, expectedMessage: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  if (!caught) {
    throw new Error("Expected invalid argument");
  }

  const envelope = toErrorEnvelope(caught);
  expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  expect(envelope.error.message).toMatch(expectedMessage);
}

describe("git sync adapter", () => {
  it("reports unconfigured status outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memora-sync-"));
    try {
      const status = await getGitSyncStatus(dir);
      expect(status.configured).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid sync arguments before mutating git state", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-invalid-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_invalid"
      });

      await expectInvalidArgument(
        () => initializeGitSync(store, ""),
        /Invalid remoteUrl/
      );
      await expectInvalidArgument(
        () => initializeGitSync("", remote),
        /Invalid storePath/
      );
      await expectInvalidArgument(
        () => getGitSyncStatus(""),
        /Invalid storePath/
      );
      await expectInvalidArgument(
        () => pullGitSync(123 as never),
        /Invalid storePath/
      );
      await expectInvalidArgument(
        () => pushGitSync(store, null as never),
        /Invalid sync options/
      );
      await expectInvalidArgument(
        () => pushGitSync(store, { message: "" }),
        /Invalid message/
      );

      await expect(access(join(store, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(store, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sync initialization before the Memora store is initialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-missing-store-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await mkdir(store, { recursive: true });
      await exec("git", ["init", "--bare", remote]);

      let caught: unknown;
      try {
        await initializeGitSync(store, remote);
      } catch (error) {
        caught = error;
      }

      if (!caught) {
        throw new Error("Expected sync init to reject before mem init");
      }

      const envelope = toErrorEnvelope(caught);
      expect(envelope.error.code).toBe("STORE_NOT_INITIALIZED");
      expect(envelope.error.recommended_action).toBe("run mem init");
      await expect(access(join(store, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(store, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects pull and push before Git sync is initialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-unconfigured-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_unconfigured"
      });

      for (const action of [() => pullGitSync(store), () => pushGitSync(store)]) {
        let caught: unknown;
        try {
          await action();
        } catch (error) {
          caught = error;
        }

        if (!caught) {
          throw new Error("Expected unconfigured sync operation to fail");
        }

        const envelope = toErrorEnvelope(caught);
        expect(envelope.error.code).toBe("SYNC_NOT_CONFIGURED");
        expect(envelope.error.recommended_action).toBe("run mem sync init <remote>");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes a store repo, pushes events, and pulls them on another device", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_a"
      });
      await initializeStore(storeB, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_b"
      });

      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const engineA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_a`
      });
      await engineA.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Sync events through Git.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });

      const push = await pushGitSync(storeA, { message: "sync from device a" });
      expect(push.committed).toBe(true);
      expect(push.pushed).toBe(true);

      const pull = await pullGitSync(storeB);
      expect(pull.pulled).toBe(true);
      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records.map((record) => record.text)).toContain("Sync events through Git.");

      const engineB = createEngine({ storePath: storeB });
      const recall = await engineB.recall({ query: "Git", project_id: "memora" });
      expect(recall.results[0]?.record.content.text).toBe("Sync events through Git.");

      const status = await getGitSyncStatus(storeB);
      expect(status.configured).toBe(true);
      expect(status.remote).toBe(remote);
      expect(status.branch).toBe("main");
      expect(status.dirty).toBe(false);
      expect(status.ahead).toBe(0);
      expect(status.behind).toBe(0);
      expect(status.last_sync).toEqual(expect.objectContaining({
        operation: "pull",
        commit: expect.any(String),
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
      }));

      await rebuildDerivedViews(storeB);
      await expect(getGitSyncStatus(storeB)).resolves.toEqual(expect.objectContaining({
        last_sync: expect.objectContaining({ operation: "pull" })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes remote tracking status so boot can report pending remote updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-boot-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_a"
      });
      await initializeStore(storeB, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_b"
      });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const engineA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_a`
      });
      await engineA.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Remote boot update is waiting.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "device a writes boot update" });

      const status = await getGitSyncStatus(storeB);
      expect(status.configured).toBe(true);
      expect(status.behind).toBeGreaterThan(0);

      const engineB = createEngine({
        storePath: storeB,
        syncStatus: () => getGitSyncStatus(storeB)
      });
      const boot = await engineB.boot({ project_id: "memora" });

      expect(boot.sync.remote_has_updates).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebases local event commits when pulling remote device history", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-rebase-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_a"
      });
      await initializeStore(storeB, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_b"
      });

      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const engineA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_a`
      });
      const engineB = createEngine({
        storePath: storeB,
        now: () => "2026-05-27T00:02:00.000Z",
        id: (prefix) => `${prefix}_b`
      });

      await engineA.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Device A event survives sync.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "device a writes first" });

      await engineB.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Device B event survives sync.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_b" }
      });
      await exec("git", ["add", "events", ".gitignore"], { cwd: storeB });
      await exec("git", ["commit", "-m", "device b local commit before pull"], { cwd: storeB });

      const pull = await pullGitSync(storeB);
      expect(pull.pulled).toBe(true);

      const engineBAfterPull = createEngine({ storePath: storeB });
      const recallA = await engineBAfterPull.recall({ query: "Device A", project_id: "memora" });
      const recallB = await engineBAfterPull.recall({ query: "Device B", project_id: "memora" });

      expect(recallA.results[0]?.record.content.text).toBe("Device A event survives sync.");
      expect(recallB.results[0]?.record.content.text).toBe("Device B event survives sync.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds derived views after push rebases remote event history", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-push-rebase-derived-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_a"
      });
      await initializeStore(storeB, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_b"
      });

      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const engineA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_a`
      });
      const engineB = createEngine({
        storePath: storeB,
        now: () => "2026-05-27T00:02:00.000Z",
        id: (prefix) => `${prefix}_b`
      });

      await engineA.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Remote event should appear in rebuilt index.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "device a writes remote event" });

      await engineB.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Local event should survive push rebase.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_b" }
      });
      const push = await pushGitSync(storeB, { message: "device b pushes after remote moved" });

      expect(push.pushed).toBe(true);
      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records.map((record) => record.text)).toEqual(expect.arrayContaining([
        "Remote event should appear in rebuilt index.",
        "Local event should survive push rebase."
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves legacy sync status when rebuilding derived indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-status-migration-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_legacy_sync"
      });
      await exec("git", ["init"], { cwd: store });
      const legacyStatus = {
        operation: "pull",
        at: "2026-05-27T00:01:00.000Z",
        commit: "abc123"
      };
      await mkdir(join(store, "indexes"), { recursive: true });
      await writeFile(join(store, "indexes", "sync-status.json"), `${JSON.stringify(legacyStatus, null, 2)}\n`, "utf8");

      await rebuildDerivedViews(store);

      await expect(readFile(join(store, "indexes", "sync-status.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(store, "state", "sync-status.json"), "utf8")).resolves.toBe(`${JSON.stringify(legacyStatus, null, 2)}\n`);
      await expect(getGitSyncStatus(store)).resolves.toEqual(expect.objectContaining({
        last_sync: legacyStatus
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite current sync status with legacy index status during rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-status-current-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_current_sync"
      });
      await exec("git", ["init"], { cwd: store });
      const legacyStatus = {
        operation: "pull",
        at: "2026-05-27T00:01:00.000Z",
        commit: "legacy"
      };
      const currentStatus = {
        operation: "push",
        at: "2026-05-27T00:02:00.000Z",
        commit: "current"
      };
      await mkdir(join(store, "indexes"), { recursive: true });
      await mkdir(join(store, "state"), { recursive: true });
      await writeFile(join(store, "indexes", "sync-status.json"), `${JSON.stringify(legacyStatus, null, 2)}\n`, "utf8");
      await writeFile(join(store, "state", "sync-status.json"), `${JSON.stringify(currentStatus, null, 2)}\n`, "utf8");

      await rebuildDerivedViews(store);

      await expect(readFile(join(store, "indexes", "sync-status.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(store, "state", "sync-status.json"), "utf8")).resolves.toBe(`${JSON.stringify(currentStatus, null, 2)}\n`);
      await expect(getGitSyncStatus(store)).resolves.toEqual(expect.objectContaining({
        last_sync: currentStatus
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores corrupt legacy sync status when rebuilding derived indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-sync-status-corrupt-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_corrupt_sync"
      });
      await exec("git", ["init"], { cwd: store });
      await mkdir(join(store, "indexes"), { recursive: true });
      await writeFile(join(store, "indexes", "sync-status.json"), "{not-json\n", "utf8");

      await expect(rebuildDerivedViews(store)).resolves.toEqual(expect.objectContaining({ ok: true }));

      await expect(readFile(join(store, "indexes", "sync-status.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(store, "state", "sync-status.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
