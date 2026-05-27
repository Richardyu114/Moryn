import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { initializeStore } from "../../src/core/config.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);

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
});
