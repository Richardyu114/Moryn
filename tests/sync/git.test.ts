import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { createEngine } from "../../src/core/engine.js";
import { toErrorEnvelope } from "../../src/core/errors.js";
import {
  SYNC_RESULT_SELECTION_SOURCES as EXPORTED_SYNC_RESULT_SELECTION_SOURCES,
  getGitSyncStatus,
  getPendingSyncEvidence,
  initializeGitSync,
  isGitSyncConfigured,
  pullGitSync,
  pushGitSync
} from "../../src/sync/git.js";

const exec = promisify(execFile);
const SYNC_STATUS_SELECTION_SOURCES = {
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
};
const SYNC_RESULT_SELECTION_SOURCES = {
  ok: "ok",
  committed: "committed",
  pushed: "pushed",
  pulled: "pulled",
  message: "message"
};
const LOCAL_ONLY_HISTORY_ERROR = /local-only Moryn paths/i;
const MORYN_GITIGNORE = "config.json\nsnapshots/\nindexes/\nstate/\n.moryn/\n";

type FileSnapshot = Record<string, string>;

async function configureGitIdentity(repository: string, name: string): Promise<void> {
  await exec("git", ["config", "user.name", name], { cwd: repository });
  await exec("git", ["config", "user.email", `${name.toLowerCase()}@example.local`], { cwd: repository });
}

async function initializeGitRepository(repository: string, remote: string, name: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await exec("git", ["init"], { cwd: repository });
  await configureGitIdentity(repository, name);
  await exec("git", ["branch", "-M", "main"], { cwd: repository });
  await exec("git", ["remote", "add", "origin", remote], { cwd: repository });
}

async function commitAndPushAll(repository: string, message: string): Promise<string> {
  await exec("git", ["add", "-f", "-A", "--", "."], { cwd: repository });
  await exec("git", ["commit", "-m", message], { cwd: repository });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: repository });
  return (await exec("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
}

async function stageSyntheticSymlink(repository: string, path: string, target: string): Promise<void> {
  const targetFile = join(repository, ".synthetic-symlink-target");
  await writeFile(targetFile, target, "utf8");
  const blobOid = (await exec("git", ["hash-object", "-w", targetFile], { cwd: repository })).stdout.trim();
  await rm(targetFile, { force: true });
  await exec("git", ["update-index", "--add", "--cacheinfo", `120000,${blobOid},${path}`], { cwd: repository });
}

async function stageSyntheticGitlink(repository: string, path: string, commit: string): Promise<void> {
  await exec("git", ["update-index", "--add", "--cacheinfo", `160000,${commit},${path}`], { cwd: repository });
}

async function remoteMainOid(remote: string): Promise<string | undefined> {
  const output = (await exec("git", ["ls-remote", "--heads", remote, "refs/heads/main"])).stdout.trim();
  return output ? output.split(/\s+/)[0] : undefined;
}

async function writeLocalOnlySentinels(
  store: string,
  label: string,
  additionalFiles: Record<string, string> = {}
): Promise<FileSnapshot> {
  const sentinelFiles = {
    "state/soul-profiles/local-overlay.json": `local soul overlay: ${label}\n`,
    "state/soul-sync/local-receipt.json": `local sync receipt: ${label}\n`,
    "state/local-lease-evidence.json": `local lease evidence: ${label}\n`,
    ...additionalFiles
  };
  for (const [path, contents] of Object.entries(sentinelFiles)) {
    await mkdir(dirname(join(store, path)), { recursive: true });
    await writeFile(join(store, path), contents, "utf8");
  }

  const snapshot: FileSnapshot = {};
  for (const path of ["config.json", "state/sync-status.json", ...Object.keys(sentinelFiles)]) {
    try {
      snapshot[path] = await readFile(join(store, path), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return snapshot;
}

async function expectFilesUnchanged(store: string, snapshot: FileSnapshot): Promise<void> {
  for (const [path, contents] of Object.entries(snapshot)) {
    await expect(readFile(join(store, path), "utf8"), path).resolves.toBe(contents);
  }
}

async function expectLocalOnlyHistoryRejection(action: () => Promise<unknown>): Promise<void> {
  await expect(action()).rejects.toThrow(LOCAL_ONLY_HISTORY_ERROR);
}

async function _expectInvalidArgument(action: () => Promise<unknown>, expectedMessage: RegExp): Promise<void> {
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

async function expectInvalidSyncArgument(
  action: () => Promise<unknown>,
  expectedMessage: RegExp,
  recommendedAction: string,
  recoveryHint: unknown
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  if (!caught) {
    throw new Error("Expected invalid sync argument");
  }

  const envelope = toErrorEnvelope(caught);
  expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  expect(envelope.error.message).toMatch(expectedMessage);
  expect(envelope.error.recommended_action).toBe(recommendedAction);
  expect(envelope.error.recovery_hint).toEqual(recoveryHint);
}

describe("git sync adapter", () => {
  it("checks local sync configuration without requiring remote reachability", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-configured-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, { id: () => "device-a" });
      expect(await isGitSyncConfigured(store)).toBe(false);
      await exec("git", ["init"], { cwd: store });
      expect(await isGitSyncConfigured(store)).toBe(false);
      await exec("git", ["remote", "add", "origin", "ssh://unreachable.invalid/moryn.git"], { cwd: store });
      expect(await isGitSyncConfigured(store)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("exports stable sync result selection source paths", () => {
    expect(EXPORTED_SYNC_RESULT_SELECTION_SOURCES).toEqual(SYNC_RESULT_SELECTION_SOURCES);
  });

  it("reports unconfigured status outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moryn-sync-"));
    try {
      const status = await getGitSyncStatus(dir);
      expect(status.configured).toBe(false);
      expect(status.selection_sources).toEqual(SYNC_STATUS_SELECTION_SOURCES);
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

      await expectInvalidSyncArgument(
        () => initializeGitSync(store, ""),
        /Invalid remoteUrl/,
        "retry sync with a non-empty remoteUrl",
        {
          operation_contract: "operations_by_id.sync_init",
          rejected_argument: { argument: "remote", value: "" },
          expected: { kind: "non_empty_string", min_length: 1 },
          argument_sources: {
            remote: "operations_by_id.sync_init.arguments_by_name.remote"
          },
          retry_with: { argument: "remote", value_placeholder: "<remote>" }
        }
      );
      await expectInvalidSyncArgument(
        () => initializeGitSync("", remote),
        /Invalid storePath/,
        "retry sync with a non-empty storePath",
        {
          rejected_argument: { argument: "storePath", value: "" },
          expected: { kind: "non_empty_string", min_length: 1 },
          retry_with: { argument: "storePath", value_placeholder: "<storePath>" }
        }
      );
      await expectInvalidSyncArgument(
        () => getGitSyncStatus(""),
        /Invalid storePath/,
        "retry sync with a non-empty storePath",
        {
          rejected_argument: { argument: "storePath", value: "" },
          expected: { kind: "non_empty_string", min_length: 1 },
          retry_with: { argument: "storePath", value_placeholder: "<storePath>" }
        }
      );
      await expectInvalidSyncArgument(
        () => pullGitSync(123 as never),
        /Invalid storePath/,
        "retry sync with a non-empty storePath",
        {
          rejected_argument: { argument: "storePath", value: 123 },
          expected: { kind: "non_empty_string", min_length: 1 },
          retry_with: { argument: "storePath", value_placeholder: "<storePath>" }
        }
      );
      await expectInvalidSyncArgument(
        () => pushGitSync(store, null as never),
        /Invalid sync options/,
        "retry sync with a valid options object",
        {
          rejected_argument: { argument: "options", value: null },
          expected: { kind: "object", required: false },
          retry_with: { argument: "options", value_placeholder: { message: "<message>" } }
        }
      );
      await expectInvalidSyncArgument(
        () => pushGitSync(store, { message: "" }),
        /Invalid message/,
        "retry sync with a non-empty message",
        {
          operation_contract: "operations_by_id.sync_push",
          rejected_argument: { argument: "message", value: "" },
          expected: { kind: "non_empty_string", min_length: 1 },
          argument_sources: {
            message: "operations_by_id.sync_push.arguments_by_name.message"
          },
          retry_with: { argument: "message", value_placeholder: "<message>" }
        }
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

      const initA = await initializeGitSync(storeA, remote);
      const initB = await initializeGitSync(storeB, remote);
      expect(initA.selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);
      expect(initB.selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);

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
      expect(push.selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);

      const pull = await pullGitSync(storeB);
      expect(pull.pulled).toBe(true);
      expect(pull.selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);
      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as {
        records: Array<{ text: string }>;
      };
      expect(recallIndex.records.map((record) => record.text)).toContain("Sync events through Git.");

      const engineB = createEngine({ storePath: storeB });
      const recall = await engineB.recall({ query: "Git", project_id: "moryn" });
      expect(recall.results[0]?.record.content.text).toBe("Sync events through Git.");
      expect(recall.retrieval).toMatchObject({ source: "retrieval_index", repaired: false, candidate_count: 1 });
      const retrievalMetadata = JSON.parse(
        await readFile(join(storeB, "snapshots", "retrieval", "metadata.json"), "utf8")
      ) as { event_manifest: { count: number }; active_records: number };
      expect(retrievalMetadata).toMatchObject({ event_manifest: { count: 1 }, active_records: 1 });

      const status = await getGitSyncStatus(storeB);
      expect(status.configured).toBe(true);
      expect(status.selection_sources).toEqual(SYNC_STATUS_SELECTION_SOURCES);
      expect(status.remote).toBe(remote);
      expect(status.branch).toBe("main");
      expect(status.dirty).toBe(false);
      expect(status.ahead).toBe(0);
      expect(status.behind).toBe(0);
      expect(status.last_sync).toEqual(
        expect.objectContaining({
          operation: "pull",
          commit: expect.any(String),
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
        })
      );

      await rebuildDerivedViews(storeB);
      await expect(getGitSyncStatus(storeB)).resolves.toEqual(
        expect.objectContaining({
          last_sync: expect.objectContaining({ operation: "pull" })
        })
      );
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

  it("reports structured conflict diagnostics after a failed pull", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-conflict-status-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const conflictFile = join("events", "shared-device", "2026-05", "evt_conflict.json");
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

      await mkdir(join(storeA, "events", "shared-device", "2026-05"), { recursive: true });
      await mkdir(join(storeB, "events", "shared-device", "2026-05"), { recursive: true });
      await writeFile(join(storeA, conflictFile), '{"from":"a"}\n', "utf8");
      await writeFile(join(storeB, conflictFile), '{"from":"b"}\n', "utf8");
      await exec("git", ["add", conflictFile], { cwd: storeA });
      await exec("git", ["commit", "-m", "device a conflicting event"], { cwd: storeA });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: storeA });
      await exec("git", ["add", conflictFile], { cwd: storeB });
      await exec("git", ["commit", "-m", "device b conflicting event"], { cwd: storeB });

      await expect(pullGitSync(storeB)).rejects.toThrow(/conflict/i);

      await expect(getGitSyncStatus(storeB)).resolves.toEqual(
        expect.objectContaining({
          configured: true,
          selection_sources: SYNC_STATUS_SELECTION_SOURCES,
          dirty: true,
          sync_state: "conflict",
          conflict: {
            operation: "rebase",
            files: [conflictFile],
            files_by_path: {
              [conflictFile]: {
                path: conflictFile,
                status: "unmerged",
                safe_to_auto_resolve: false,
                recommended_action: "resolve Git conflicts before retrying sync"
              }
            },
            safe_to_auto_resolve: false,
            safe_to_retry_sync: false,
            recommended_action: "resolve Git conflicts before retrying sync"
          }
        })
      );
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
      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as {
        records: Array<{ text: string }>;
      };
      expect(recallIndex.records.map((record) => record.text)).toContain(
        "Existing remote history is indexed on sync init."
      );
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
      await writeFile(
        join(seed, "events", "device_seed", "2026-05", "evt_seed.json"),
        `${JSON.stringify(
          {
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
          },
          null,
          2
        )}\n`,
        "utf8"
      );
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

      await expect(readFile(join(store, ".gitignore"), "utf8")).resolves.toBe(
        "config.json\nsnapshots/\nindexes/\nstate/\n.moryn/\n"
      );
      const status = await getGitSyncStatus(store);
      expect(status.dirty).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sync init before checkout when remote history tracks .moryn", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-local-only-history-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeGitRepository(seed, remote, "Seed");
      await mkdir(join(seed, ".moryn"), { recursive: true });
      await writeFile(join(seed, ".moryn", "private.json"), '{"private":true}\n', "utf8");
      const rejectedRemoteOid = await commitAndPushAll(seed, "Track nested Moryn state");

      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_importer"
      });
      const localState = await writeLocalOnlySentinels(store, "init remote config");

      await expectLocalOnlyHistoryRejection(() => initializeGitSync(store, remote));

      await expectFilesUnchanged(store, localState);
      await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(store, "state", "sync-status.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["State/soul-profiles/remote-overlay.json", "remote state overlay\n"],
    ["CONFIG.JSON", '{"device_id":"remote-device"}\n']
  ])(
    "rejects sync init before checkout when remote history tracks case-folded local-only path %s",
    async (path, contents) => {
      const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-case-folded-local-only-"));
      const remote = join(root, "remote.git");
      const seed = join(root, "seed");
      const store = join(root, "store");
      try {
        await exec("git", ["init", "--bare", remote]);
        await initializeGitRepository(seed, remote, "Seed");
        await mkdir(dirname(join(seed, path)), { recursive: true });
        await writeFile(join(seed, path), contents, "utf8");
        const rejectedRemoteOid = await commitAndPushAll(seed, "Track case-folded local-only state");

        await initializeStore(store, {
          now: () => "2026-05-27T00:00:00.000Z",
          id: () => "device_case_folded_importer"
        });
        const localState = await writeLocalOnlySentinels(store, "case-folded remote state");

        await expectLocalOnlyHistoryRejection(() => initializeGitSync(store, remote));

        await expectFilesUnchanged(store, localState);
        await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
        expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
        await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("rejects a remote .gitignore symlink before sync init can overwrite local config", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-symlink-tree-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeGitRepository(seed, remote, "Seed");
      await stageSyntheticSymlink(seed, ".gitignore", "config.json");
      await exec("git", ["commit", "-m", "Add unsafe gitignore symlink"], { cwd: seed });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: seed });
      const rejectedRemoteOid = (await exec("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();

      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_symlink_importer"
      });
      const configPath = join(store, "config.json");
      const parsedConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
      const localConfig = `  ${JSON.stringify(parsedConfig)}\n`;
      await writeFile(configPath, localConfig, "utf8");
      await chmod(configPath, 0o640);
      const localState = await writeLocalOnlySentinels(store, "remote symlink tree");

      await expect(initializeGitSync(store, remote)).rejects.toThrow(/symlink.*mode 120000/i);

      await expectFilesUnchanged(store, localState);
      await expect(readFile(configPath, "utf8")).resolves.toBe(localConfig);
      expect((await stat(configPath)).mode & 0o777).toBe(0o640);
      await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a remote event-directory symlink before pull can checkout an unborn branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-pull-event-symlink-tree-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeGitRepository(seed, remote, "Seed");
      await stageSyntheticSymlink(seed, "events/idempotent", "../../state");
      await exec("git", ["commit", "-m", "Add unsafe event symlink"], { cwd: seed });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: seed });
      const rejectedRemoteOid = (await exec("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();

      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_symlink_puller"
      });
      await initializeGitRepository(store, remote, "Puller");
      const localState = await writeLocalOnlySentinels(store, "remote event symlink tree");

      await expect(pullGitSync(store)).rejects.toThrow(/symlink.*mode 120000/i);

      await expectFilesUnchanged(store, localState);
      await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
      await expect(access(join(store, "events", "idempotent"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a remote gitlink tree entry before pull rebases local history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-pull-gitlink-tree-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const legacy = join(root, "legacy");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_gitlink_pull"
      });
      await initializeGitSync(store, remote);

      await exec("git", ["clone", remote, legacy]);
      await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
      await configureGitIdentity(legacy, "Legacy");
      const linkedCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: legacy })).stdout.trim();
      await stageSyntheticGitlink(legacy, "events/linked-store", linkedCommit);
      await exec("git", ["commit", "-m", "Add unsafe event gitlink"], { cwd: legacy });
      await exec("git", ["push", "origin", "main"], { cwd: legacy });
      const rejectedRemoteOid = (await exec("git", ["rev-parse", "HEAD"], { cwd: legacy })).stdout.trim();

      const localState = await writeLocalOnlySentinels(store, "remote gitlink tree");
      const localHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();

      await expect(pullGitSync(store)).rejects.toThrow(/gitlink.*mode 160000/i);

      await expectFilesUnchanged(store, localState);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHead);
      await expect(access(join(store, "events", "linked-store"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects push before changing the index when local history tracks snapshots", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-push-local-only-history-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_push_rejected"
      });
      await initializeGitRepository(store, remote, "Local");
      await writeFile(join(store, ".gitignore"), MORYN_GITIGNORE, "utf8");
      await mkdir(join(store, "snapshots"), { recursive: true });
      await writeFile(join(store, "snapshots", "private.json"), "local private snapshot\n", "utf8");
      await exec("git", ["add", "-f", ".gitignore", "snapshots/private.json"], { cwd: store });
      await exec("git", ["commit", "-m", "Track a local snapshot"], { cwd: store });
      const localHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();
      const localState = await writeLocalOnlySentinels(store, "push local snapshot");

      await expectLocalOnlyHistoryRejection(() => pushGitSync(store, { message: "must not push" }));

      await expectFilesUnchanged(store, localState);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHead);
      expect((await exec("git", ["ls-files", "snapshots/private.json"], { cwd: store })).stdout.trim()).toBe(
        "snapshots/private.json"
      );
      expect((await exec("git", ["diff", "--cached", "--name-only"], { cwd: store })).stdout.trim()).toBe("");
      expect(await remoteMainOid(remote)).toBeUndefined();
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects pull before rebase when remote history tracks indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-pull-local-only-history-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const legacy = join(root, "legacy");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_pull_rejected"
      });
      await initializeGitSync(store, remote);

      await exec("git", ["clone", remote, legacy]);
      await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
      await configureGitIdentity(legacy, "Legacy");
      await mkdir(join(legacy, "indexes"), { recursive: true });
      await writeFile(join(legacy, "indexes", "recall.json"), "remote generated index\n", "utf8");
      const rejectedRemoteOid = await commitAndPushAll(legacy, "Track a remote index");

      const localState = await writeLocalOnlySentinels(store, "pull remote index", {
        "indexes/recall.json": "local generated index\n"
      });
      const localHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();

      await expectLocalOnlyHistoryRejection(() => pullGitSync(store));

      await expectFilesUnchanged(store, localState);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHead);
      expect((await exec("git", ["ls-files", "indexes/recall.json"], { cwd: store })).stdout.trim()).toBe("");
      expect((await exec("git", ["diff", "--cached", "--name-only"], { cwd: store })).stdout.trim()).toBe("");
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects push before rebase when remote history tracks local state", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-push-rebase-local-only-history-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const legacy = join(root, "legacy");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_push_rebase_rejected"
      });
      await initializeGitSync(store, remote);

      await exec("git", ["clone", remote, legacy]);
      await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
      await configureGitIdentity(legacy, "Legacy");
      const remoteState = {
        "state/soul-profiles/local-overlay.json": "remote soul overlay\n",
        "state/soul-sync/local-receipt.json": "remote sync receipt\n",
        "state/local-lease-evidence.json": "remote lease evidence\n",
        "state/store-state.lease/owner.json": "remote lease owner\n"
      };
      for (const [path, contents] of Object.entries(remoteState)) {
        await mkdir(dirname(join(legacy, path)), { recursive: true });
        await writeFile(join(legacy, path), contents, "utf8");
      }
      const rejectedRemoteOid = await commitAndPushAll(legacy, "Track remote local state");

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
        content: { text: "Uncommitted local event remains local after rejected push.", format: "text" },
        state: "canonical",
        source: { client: "test", device_id: "device_push_rebase_rejected" }
      });
      const localState = await writeLocalOnlySentinels(store, "push remote state");
      const localHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();
      const localEventPath = (
        await exec("git", ["ls-files", "--others", "--exclude-standard", "--", "events"], { cwd: store })
      ).stdout.trim();
      const localEvent = await readFile(join(store, localEventPath), "utf8");

      await expectLocalOnlyHistoryRejection(() => pushGitSync(store, { message: "must not rebase or push" }));

      await expectFilesUnchanged(store, localState);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHead);
      await expect(readFile(join(store, localEventPath), "utf8")).resolves.toBe(localEvent);
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sync init when a cleaned remote tip still has local-only history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-cleaned-remote-history-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeGitRepository(seed, remote, "Seed");
      await writeFile(join(seed, "config.json"), '{"device_id":"leaked-remote-device"}\n', "utf8");
      await commitAndPushAll(seed, "Leak remote config");
      await rm(join(seed, "config.json"));
      await writeFile(join(seed, "README.md"), "The remote tip is clean.\n", "utf8");
      const cleanRemoteOid = await commitAndPushAll(seed, "Remove remote config from tip");
      const tipPaths = (await exec("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: seed })).stdout;
      expect(tipPaths).not.toMatch(/(^|\n)config\.json(\n|$)/);
      expect((await exec("git", ["log", "--format=%H", "--", "config.json"], { cwd: seed })).stdout.trim()).not.toBe(
        ""
      );

      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_cleaned_remote_importer"
      });
      const localState = await writeLocalOnlySentinels(store, "cleaned remote history");

      await expectLocalOnlyHistoryRejection(() => initializeGitSync(store, remote));

      await expectFilesUnchanged(store, localState);
      await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
      expect(await remoteMainOid(remote)).toBe(cleanRemoteOid);
      await expect(access(join(store, "README.md"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects sync init when local-only paths were deleted from the local tip and leaves an empty remote empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-cleaned-local-history-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_cleaned_local_history"
      });
      await initializeGitRepository(store, remote, "Local");
      await writeFile(join(store, ".gitignore"), MORYN_GITIGNORE, "utf8");
      const leakedState = {
        "state/soul-profiles/leaked-overlay.json": "leaked local soul overlay\n",
        "state/soul-sync/leaked-receipt.json": "leaked local sync receipt\n",
        "state/store-state.lease/owner.json": "leaked local lease owner\n"
      };
      for (const [path, contents] of Object.entries(leakedState)) {
        await mkdir(dirname(join(store, path)), { recursive: true });
        await writeFile(join(store, path), contents, "utf8");
      }
      await exec("git", ["add", "-f", ".gitignore", "state"], { cwd: store });
      await exec("git", ["commit", "-m", "Leak local state"], { cwd: store });
      await exec("git", ["rm", "-r", "state"], { cwd: store });
      await exec("git", ["commit", "-m", "Delete local state from tip"], { cwd: store });
      const tipPaths = (await exec("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: store })).stdout;
      expect(tipPaths).not.toMatch(/(^|\n)state\//);
      expect((await exec("git", ["log", "--format=%H", "--", "state"], { cwd: store })).stdout.trim()).not.toBe("");
      const localHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();
      const localState = await writeLocalOnlySentinels(store, "cleaned local history");

      await expectLocalOnlyHistoryRejection(() => initializeGitSync(store, remote));

      await expectFilesUnchanged(store, localState);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHead);
      expect((await exec("git", ["ls-files", "state"], { cwd: store })).stdout.trim()).toBe("");
      expect((await exec("git", ["diff", "--cached", "--name-only"], { cwd: store })).stdout.trim()).toBe("");
      expect(await remoteMainOid(remote)).toBeUndefined();
      await expect(access(join(store, "state", "store-state.lease"))).rejects.toMatchObject({ code: "ENOENT" });
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
      const storeBConfigPath = join(storeB, "config.json");
      const storeBConfig = JSON.parse(await readFile(storeBConfigPath, "utf8")) as Record<string, unknown>;
      const customStoreBConfig = `  ${JSON.stringify(storeBConfig)}\n`;
      await writeFile(storeBConfigPath, customStoreBConfig, "utf8");
      await chmod(storeBConfigPath, 0o640);

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
      await expect(readFile(storeBConfigPath, "utf8")).resolves.toBe(customStoreBConfig);
      expect((await stat(storeBConfigPath)).mode & 0o777).toBe(0o640);

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

      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as {
        records: Array<{ text: string }>;
      };
      expect(recallIndex.records.map((record) => record.text)).toEqual(
        expect.arrayContaining(["Remote uncommitted pull event survives.", "Local uncommitted event survives pull."])
      );

      const engineBAfterPull = createEngine({ storePath: storeB });
      expect(
        (await engineBAfterPull.recall({ query: "Remote uncommitted", project_id: "moryn" })).results[0]?.record.content
          .text
      ).toBe("Remote uncommitted pull event survives.");
      expect(
        (await engineBAfterPull.recall({ query: "Local uncommitted", project_id: "moryn" })).results[0]?.record.content
          .text
      ).toBe("Local uncommitted event survives pull.");
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
      const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as {
        records: Array<{ text: string }>;
      };
      expect(recallIndex.records.map((record) => record.text)).toEqual(
        expect.arrayContaining([
          "Remote event should appear in rebuilt index.",
          "Local event should survive push rebase."
        ])
      );
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

      expect(push).toEqual(
        expect.objectContaining({
          ok: true,
          committed: false,
          pushed: true
        })
      );
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

      await expect(readFile(join(store, "indexes", "sync-status.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(store, "state", "sync-status.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(legacyStatus, null, 2)}\n`
      );
      await expect(getGitSyncStatus(store)).resolves.toEqual(
        expect.objectContaining({
          last_sync: legacyStatus
        })
      );
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

      await expect(readFile(join(store, "indexes", "sync-status.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(store, "state", "sync-status.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(currentStatus, null, 2)}\n`
      );
      await expect(getGitSyncStatus(store)).resolves.toEqual(
        expect.objectContaining({
          last_sync: currentStatus
        })
      );
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

      await expect(readFile(join(store, "indexes", "sync-status.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
      await expect(readFile(join(store, "state", "sync-status.json"), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("pending sync evidence", () => {
  it("reports uncommitted and ahead event paths with parsed events", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-pending-sync-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device-a" });
      await initializeGitSync(store, remote);
      const engine = createEngine({
        storePath: store,
        id: (prefix) => `${prefix}_pending`,
        now: () => "2026-07-12T00:00:00.000Z"
      });
      await engine.write({
        kind: "session_summary",
        type: "checkpoint",
        scope: "project",
        project_id: "moryn",
        content: { text: "Pending checkpoint" },
        source: { client: "codex", session_id: "session" }
      });

      const evidence = await getPendingSyncEvidence(store);
      expect(evidence.paths.some((path) => path.startsWith("events/") && path.endsWith(".json"))).toBe(true);
      expect(evidence.events).toEqual([
        expect.objectContaining({
          op: "upsert_record",
          record: expect.objectContaining({ type: "checkpoint", project_id: "moryn" })
        })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps deleted event paths as evidence without trying to parse missing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-pending-deleted-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device-a" });
      await initializeGitSync(store, remote);
      const engine = createEngine({
        storePath: store,
        id: (prefix) => `${prefix}_deleted`,
        now: () => "2026-07-12T00:00:00.000Z"
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Delete me" },
        source: { client: "test" }
      });
      await pushGitSync(store);
      const trackedEventPath = (
        await exec("git", ["ls-files", "events/*.json", "events/**/*.json"], { cwd: store })
      ).stdout
        .trim()
        .split(/\r?\n/)
        .find((path) => path.endsWith(".json"));
      expect(trackedEventPath).toBeDefined();
      await rm(join(store, trackedEventPath!));

      const evidence = await getPendingSyncEvidence(store);
      expect(evidence.paths).toEqual([trackedEventPath]);
      expect(evidence.events).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
