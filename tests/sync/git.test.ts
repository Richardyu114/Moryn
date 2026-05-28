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
    const dir = await mkdtemp(join(tmpdir(), "moryn-sync-"));
    try {
      const status = await getGitSyncStatus(dir);
      expect(status.configured).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid sync arguments before mutating git state", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-invalid-"));
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

  it("rejects sync initialization before the Moryn store is initialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-missing-store-"));
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
        throw new Error("Expected sync init to reject before moryn init");
      }

      const envelope = toErrorEnvelope(caught);
      expect(envelope.error.code).toBe("STORE_NOT_INITIALIZED");
      expect(envelope.error.recommended_action).toBe("run moryn init");
      await expect(access(join(store, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(store, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects pull and push before Git sync is initialized", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-unconfigured-"));
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
        expect(envelope.error.recommended_action).toBe("run moryn sync init <remote>");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes a store repo, pushes events, and pulls them on another device", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-"));
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
        project_id: "moryn",
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
      const recall = await engineB.recall({ query: "Git", project_id: "moryn" });
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
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-boot-"));
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
        project_id: "moryn",
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
      const boot = await engineB.boot({ project_id: "moryn" });

      expect(boot.sync.remote_has_updates).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds derived views after sync init imports an existing remote history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-derived-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_a"
      });

      await initializeGitSync(storeA, remote);
      const engineA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_a`
      });
      await engineA.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Existing remote history is indexed on sync init.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "seed remote history" });

      await initializeStore(storeB, {
        now: () => "2026-05-27T00:02:00.000Z",
        id: () => "device_b"
      });
      const init = await initializeGitSync(storeB, remote);

      expect(init.ok).toBe(true);
      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records.map((record) => record.text)).toContain("Existing remote history is indexed on sync init.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generated views ignored when sync init imports older remote history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-ignore-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await mkdir(join(seed, "events", "device_seed", "2026-05"), { recursive: true });
      await exec("git", ["init"], { cwd: seed });
      await exec("git", ["config", "user.name", "Seed"], { cwd: seed });
      await exec("git", ["config", "user.email", "seed@example.local"], { cwd: seed });
      await writeFile(join(seed, "events", "device_seed", "2026-05", "evt_seed.json"), `${JSON.stringify({
        event_id: "evt_seed",
        op: "upsert_record",
        record: {
          id: "rec_seed",
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          tags: [],
          content: { text: "Imported older remote event.", format: "text" },
          state: "canonical",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:01:00.000Z",
          updated_at: "2026-05-27T00:01:00.000Z",
          source: { client: "seed", device_id: "device_seed" }
        },
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "seed", device_id: "device_seed" }
      }, null, 2)}\n`, "utf8");
      await exec("git", ["add", "events"], { cwd: seed });
      await exec("git", ["commit", "-m", "Seed legacy Moryn events"], { cwd: seed });
      await exec("git", ["branch", "-M", "main"], { cwd: seed });
      await exec("git", ["remote", "add", "origin", remote], { cwd: seed });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: seed });

      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_importer"
      });
      await initializeGitSync(store, remote);

      await expect(readFile(join(store, ".gitignore"), "utf8")).resolves.toBe("config.json\nsnapshots/\nindexes/\nstate/\n");
      const status = await getGitSyncStatus(store);
      expect(status.dirty).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("untracks legacy synced config and generated views during sync init import", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-untrack-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await mkdir(join(seed, "events", "device_seed", "2026-05"), { recursive: true });
      await mkdir(join(seed, "snapshots"), { recursive: true });
      await mkdir(join(seed, "indexes"), { recursive: true });
      await exec("git", ["init"], { cwd: seed });
      await exec("git", ["config", "user.name", "Seed"], { cwd: seed });
      await exec("git", ["config", "user.email", "seed@example.local"], { cwd: seed });
      await writeFile(join(seed, "config.json"), `${JSON.stringify({
        store_version: 1,
        device_id: "device_seed",
        created_at: "2026-05-27T00:00:00.000Z"
      }, null, 2)}\n`, "utf8");
      await writeFile(join(seed, "events", "device_seed", "2026-05", "evt_seed.json"), `${JSON.stringify({
        event_id: "evt_seed",
        op: "upsert_record",
        record: {
          id: "rec_seed",
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          tags: [],
          content: { text: "Imported remote event with legacy generated files.", format: "text" },
          state: "canonical",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:01:00.000Z",
          updated_at: "2026-05-27T00:01:00.000Z",
          source: { client: "seed", device_id: "device_seed" }
        },
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "seed", device_id: "device_seed" }
      }, null, 2)}\n`, "utf8");
      await writeFile(join(seed, "snapshots", "user.json"), "{\"legacy\":true}\n", "utf8");
      await writeFile(join(seed, "indexes", "recall.json"), "{\"legacy\":true}\n", "utf8");
      await exec("git", ["add", "."], { cwd: seed });
      await exec("git", ["commit", "-m", "Seed legacy synced generated files"], { cwd: seed });
      await exec("git", ["branch", "-M", "main"], { cwd: seed });
      await exec("git", ["remote", "add", "origin", remote], { cwd: seed });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: seed });

      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_importer"
      });
      await initializeGitSync(store, remote);

      const localConfig = JSON.parse(await readFile(join(store, "config.json"), "utf8")) as { device_id: string };
      expect(localConfig.device_id).toBe("device_importer");
      const tracked = (await exec("git", ["ls-files"], { cwd: store })).stdout.trim().split(/\r?\n/).filter(Boolean);
      expect(tracked).toContain(".gitignore");
      expect(tracked).toContain("events/device_seed/2026-05/evt_seed.json");
      expect(tracked).not.toContain("config.json");
      expect(tracked).not.toContain("snapshots/user.json");
      expect(tracked).not.toContain("indexes/recall.json");
      await expect(getGitSyncStatus(store)).resolves.toEqual(expect.objectContaining({
        dirty: false
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("untracks legacy synced config and generated views during push from configured stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-push-untrack-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_push_untrack"
      });
      await initializeGitSync(store, remote);
      await mkdir(join(store, "snapshots"), { recursive: true });
      await mkdir(join(store, "indexes"), { recursive: true });
      await writeFile(join(store, "snapshots", "user.json"), "{\"legacy\":true}\n", "utf8");
      await writeFile(join(store, "indexes", "recall.json"), "{\"legacy\":true}\n", "utf8");
      await exec("git", ["add", "-f", "config.json", "snapshots", "indexes"], { cwd: store });
      await exec("git", ["commit", "-m", "Simulate legacy tracked local files"], { cwd: store });

      const push = await pushGitSync(store, { message: "drop legacy tracked local files" });

      expect(push).toEqual(expect.objectContaining({
        ok: true,
        committed: true,
        pushed: true
      }));
      const tracked = (await exec("git", ["ls-files"], { cwd: store })).stdout.trim().split(/\r?\n/).filter(Boolean);
      expect(tracked).toContain(".gitignore");
      expect(tracked).not.toContain("config.json");
      expect(tracked).not.toContain("snapshots/user.json");
      expect(tracked).not.toContain("indexes/recall.json");
      await expect(getGitSyncStatus(store)).resolves.toEqual(expect.objectContaining({
        dirty: false
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves local config and untracks legacy synced local-only files during pull", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-pull-untrack-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const legacy = join(root, "legacy");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_pull_untrack"
      });
      await initializeGitSync(store, remote);

      await exec("git", ["clone", remote, legacy]);
      await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
      await exec("git", ["config", "user.name", "Legacy"], { cwd: legacy });
      await exec("git", ["config", "user.email", "legacy@example.local"], { cwd: legacy });
      await mkdir(join(legacy, "snapshots"), { recursive: true });
      await mkdir(join(legacy, "indexes"), { recursive: true });
      await mkdir(join(legacy, "state"), { recursive: true });
      await writeFile(join(legacy, "config.json"), `${JSON.stringify({
        store_version: 1,
        device_id: "device_legacy",
        created_at: "2026-05-27T00:00:00.000Z"
      }, null, 2)}\n`, "utf8");
      await writeFile(join(legacy, "snapshots", "user.json"), "{\"legacy\":true}\n", "utf8");
      await writeFile(join(legacy, "indexes", "recall.json"), "{\"legacy\":true}\n", "utf8");
      await writeFile(join(legacy, "state", "sync-status.json"), "{\"legacy\":true}\n", "utf8");
      await exec("git", ["add", "-f", "config.json", "snapshots", "indexes", "state"], { cwd: legacy });
      await exec("git", ["commit", "-m", "Legacy tracks local-only files"], { cwd: legacy });
      await exec("git", ["push", "origin", "main"], { cwd: legacy });

      const pull = await pullGitSync(store);

      expect(pull).toEqual(expect.objectContaining({
        ok: true,
        pulled: true
      }));
      const localConfig = JSON.parse(await readFile(join(store, "config.json"), "utf8")) as { device_id: string };
      expect(localConfig.device_id).toBe("device_pull_untrack");
      const tracked = (await exec("git", ["ls-files"], { cwd: store })).stdout.trim().split(/\r?\n/).filter(Boolean);
      expect(tracked).toContain(".gitignore");
      expect(tracked).not.toContain("config.json");
      expect(tracked).not.toContain("snapshots/user.json");
      expect(tracked).not.toContain("indexes/recall.json");
      expect(tracked).not.toContain("state/sync-status.json");
      await expect(getGitSyncStatus(store)).resolves.toEqual(expect.objectContaining({
        dirty: false
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves local config and untracks legacy synced local-only files during push rebase", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-push-rebase-untrack-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const legacy = join(root, "legacy");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_push_rebase_untrack"
      });
      await initializeGitSync(store, remote);

      await exec("git", ["clone", remote, legacy]);
      await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
      await exec("git", ["config", "user.name", "Legacy"], { cwd: legacy });
      await exec("git", ["config", "user.email", "legacy@example.local"], { cwd: legacy });
      await mkdir(join(legacy, "events", "device_legacy", "2026-05"), { recursive: true });
      await mkdir(join(legacy, "snapshots"), { recursive: true });
      await mkdir(join(legacy, "indexes"), { recursive: true });
      await writeFile(join(legacy, "config.json"), `${JSON.stringify({
        store_version: 1,
        device_id: "device_legacy",
        created_at: "2026-05-27T00:00:00.000Z"
      }, null, 2)}\n`, "utf8");
      await writeFile(join(legacy, "events", "device_legacy", "2026-05", "evt_legacy.json"), `${JSON.stringify({
        event_id: "evt_legacy",
        op: "upsert_record",
        record: {
          id: "rec_legacy",
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          tags: [],
          content: { text: "Legacy remote event survives push rebase.", format: "text" },
          state: "canonical",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:01:00.000Z",
          updated_at: "2026-05-27T00:01:00.000Z",
          source: { client: "legacy", device_id: "device_legacy" }
        },
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "legacy", device_id: "device_legacy" }
      }, null, 2)}\n`, "utf8");
      await writeFile(join(legacy, "snapshots", "user.json"), "{\"legacy\":true}\n", "utf8");
      await writeFile(join(legacy, "indexes", "recall.json"), "{\"legacy\":true}\n", "utf8");
      await exec("git", ["add", "-f", "config.json", "events", "snapshots", "indexes"], { cwd: legacy });
      await exec("git", ["commit", "-m", "Legacy remote tracks local-only files"], { cwd: legacy });
      await exec("git", ["push", "origin", "main"], { cwd: legacy });

      const engine = createEngine({
        storePath: store,
        now: () => "2026-05-27T00:02:00.000Z",
        id: (prefix) => `${prefix}_local`
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Local event survives legacy push rebase.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_push_rebase_untrack" }
      });

      const push = await pushGitSync(store, { message: "push after legacy remote" });

      expect(push).toEqual(expect.objectContaining({
        ok: true,
        committed: true,
        pushed: true
      }));
      const localConfig = JSON.parse(await readFile(join(store, "config.json"), "utf8")) as { device_id: string };
      expect(localConfig.device_id).toBe("device_push_rebase_untrack");
      const tracked = (await exec("git", ["ls-files"], { cwd: store })).stdout.trim().split(/\r?\n/).filter(Boolean);
      expect(tracked).toContain(".gitignore");
      expect(tracked).toContain("events/device_legacy/2026-05/evt_legacy.json");
      expect(tracked).not.toContain("config.json");
      expect(tracked).not.toContain("snapshots/user.json");
      expect(tracked).not.toContain("indexes/recall.json");
      const recallIndex = JSON.parse(await readFile(join(store, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records.map((record) => record.text)).toEqual(expect.arrayContaining([
        "Legacy remote event survives push rebase.",
        "Local event survives legacy push rebase."
      ]));
      await expect(getGitSyncStatus(store)).resolves.toEqual(expect.objectContaining({
        dirty: false,
        ahead: 0,
        behind: 0
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebases local event commits when pulling remote device history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-rebase-"));
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
        project_id: "moryn",
        content: { text: "Device A event survives sync.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "device a writes first" });

      await engineB.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Device B event survives sync.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_b" }
      });
      await exec("git", ["add", "events", ".gitignore"], { cwd: storeB });
      await exec("git", ["commit", "-m", "device b local commit before pull"], { cwd: storeB });

      const pull = await pullGitSync(storeB);
      expect(pull.pulled).toBe(true);

      const engineBAfterPull = createEngine({ storePath: storeB });
      const recallA = await engineBAfterPull.recall({ query: "Device A", project_id: "moryn" });
      const recallB = await engineBAfterPull.recall({ query: "Device B", project_id: "moryn" });

      expect(recallA.results[0]?.record.content.text).toBe("Device A event survives sync.");
      expect(recallB.results[0]?.record.content.text).toBe("Device B event survives sync.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pulls remote event history without dropping uncommitted local events", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-uncommitted-pull-"));
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
        project_id: "moryn",
        content: { text: "Remote uncommitted pull event survives.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "device a writes remote event" });

      await engineB.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Local uncommitted event survives pull.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_b" }
      });

      const pull = await pullGitSync(storeB);
      expect(pull.pulled).toBe(true);

      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records.map((record) => record.text)).toEqual(expect.arrayContaining([
        "Remote uncommitted pull event survives.",
        "Local uncommitted event survives pull."
      ]));

      const engineBAfterPull = createEngine({ storePath: storeB });
      expect((await engineBAfterPull.recall({ query: "Remote uncommitted", project_id: "moryn" })).results[0]?.record.content.text).toBe("Remote uncommitted pull event survives.");
      expect((await engineBAfterPull.recall({ query: "Local uncommitted", project_id: "moryn" })).results[0]?.record.content.text).toBe("Local uncommitted event survives pull.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rebuilds derived views after push rebases remote event history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-push-rebase-derived-"));
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
        project_id: "moryn",
        content: { text: "Remote event should appear in rebuilt index.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "device a writes remote event" });

      await engineB.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
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

  it("pushes cleanly when non-Moryn files leave the store worktree dirty", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-untracked-file-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_dirty_push"
      });
      await initializeGitSync(store, remote);
      await writeFile(join(store, "scratch.txt"), "not managed by Moryn\n", "utf8");

      const push = await pushGitSync(store);

      expect(push).toEqual(expect.objectContaining({
        ok: true,
        committed: false,
        pushed: true
      }));
      await expect(readFile(join(store, "scratch.txt"), "utf8")).resolves.toBe("not managed by Moryn\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves legacy sync status when rebuilding derived indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-status-migration-"));
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
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-status-current-"));
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
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-status-corrupt-"));
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
