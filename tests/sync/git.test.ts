import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { createEngine } from "../../src/core/engine.js";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { OperationDeadlineExceededError, withOperationDeadline } from "../../src/core/operation-deadline.js";
import { retrievalProjectShardName } from "../../src/core/retrieval-index.js";
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
  pending_changes: "pending_changes",
  remote_observation: "remote_observation",
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
const EVENT_HISTORY_MUTATION_MESSAGE =
  "Git sync refused because append-only event history could not be verified safely. Existing events must remain byte-for-byte unchanged, and only new regular .json event files may be added.";
const EVENT_HISTORY_MUTATION_RECOMMENDED_ACTION =
  "restore existing event files, clear event ignore or hidden-index rules, and append a corrective event before retrying sync";

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

async function expectEventHistoryMutation(
  action: () => Promise<unknown>,
  forbiddenDetails: readonly string[] = []
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error("Expected append-only event history rejection");
  const envelope = toErrorEnvelope(caught);
  expect(envelope.error).toMatchObject({
    code: "EVENT_HISTORY_MUTATION",
    message: EVENT_HISTORY_MUTATION_MESSAGE,
    recoverable: true,
    recommended_action: EVENT_HISTORY_MUTATION_RECOMMENDED_ACTION
  });
  for (const detail of forbiddenDetails.filter(Boolean)) {
    expect(JSON.stringify(envelope)).not.toContain(detail);
  }
}

async function firstTrackedEventPath(store: string): Promise<string> {
  const paths = (await exec("git", ["ls-files", "-z", "--", "events"], { cwd: store })).stdout
    .split("\0")
    .filter((path) => path.endsWith(".json"));
  if (!paths[0]) throw new Error("Expected a tracked event file");
  return paths[0];
}

async function rewriteTrackedEventText(store: string, path: string, text: string): Promise<string> {
  const event = JSON.parse(await readFile(join(store, path), "utf8")) as {
    event_id: string;
    op: string;
    record?: { content: Record<string, unknown> };
  };
  if (event.op !== "upsert_record" || !event.record) throw new Error("Expected an upsert event");
  event.record.content = { ...event.record.content, text };
  await writeFile(join(store, path), `${JSON.stringify(event, null, 2)}\n`, "utf8");
  return event.event_id;
}

async function seedTrackedEvent(store: string, remote: string, deviceId: string): Promise<string> {
  await initializeStore(store, {
    now: () => "2026-07-27T00:00:00.000Z",
    id: () => deviceId
  });
  await initializeGitSync(store, remote);
  const engine = createEngine({
    storePath: store,
    now: () => "2026-07-27T00:01:00.000Z",
    id: (prefix) => `${prefix}_${deviceId}`
  });
  await engine.write({
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    content: { text: "Append-only history protects this event.", format: "text" },
    state: "canonical",
    confirmed: true,
    source: { client: "test", device_id: deviceId }
  });
  await pushGitSync(store, { message: "seed append-only event" });
  return firstTrackedEventPath(store);
}

type ReplayInvalidRemoteHistory = "missing_target" | "duplicate_event_id";

const LONG_UNSAFE_REMOTE_PROJECT_ID = `../PRIVATE_REMOTE_PROJECT_${"p".repeat(300)}`;

async function writeLongProjectRemoteEvent(repository: string): Promise<string> {
  const path = join("events", "remote-long-project", "2026-07", "evt_long_project.json");
  const createdAt = "2026-07-28T00:00:00.000Z";
  const source = { client: "remote-test", device_id: "remote-long-project" };
  await mkdir(dirname(join(repository, path)), { recursive: true });
  await writeFile(
    join(repository, path),
    `${JSON.stringify(
      {
        event_id: "evt_long_project",
        op: "upsert_record",
        record: {
          id: "rec_long_project",
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: LONG_UNSAFE_REMOTE_PROJECT_ID,
          tags: [],
          content: { text: "A valid remote record uses an unsafe and oversized project identity.", format: "text" },
          state: "canonical",
          confidence: 0.9,
          priority: "normal",
          visibility: "active",
          created_at: createdAt,
          updated_at: createdAt,
          source
        },
        created_at: createdAt,
        source
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return path;
}

async function writeReplayInvalidRemoteHistory(
  repository: string,
  invalidity: ReplayInvalidRemoteHistory
): Promise<string[]> {
  const directory = join("events", "remote-invalid", "2026-07");
  await mkdir(join(repository, directory), { recursive: true });
  if (invalidity === "missing_target") {
    const path = join(directory, "evt_missing_target.json");
    await writeFile(
      join(repository, path),
      `${JSON.stringify(
        {
          event_id: "evt_missing_target",
          op: "revise_record",
          record_id: "rec_missing_remote_target",
          patch: { "content.text": "REMOTE_REPLAY_INVALID_MARKER" },
          reason: "Remote history must not revise a missing record.",
          created_at: "2026-07-28T00:00:00.000Z",
          source: { client: "remote-test", device_id: "remote-invalid" }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    return [path];
  }

  const duplicateEventId = "evt_duplicate_remote_identity";
  const paths = [join(directory, "first.json"), join(directory, "second.json")];
  for (const [index, path] of paths.entries()) {
    const recordId = `rec_duplicate_remote_${index + 1}`;
    const createdAt = `2026-07-28T00:00:0${index}.000Z`;
    await writeFile(
      join(repository, path),
      `${JSON.stringify(
        {
          event_id: duplicateEventId,
          op: "upsert_record",
          record: {
            id: recordId,
            kind: "memory",
            type: "fact",
            scope: "project",
            project_id: "moryn",
            tags: [],
            content: { text: `REMOTE_DUPLICATE_ID_MARKER_${index + 1}`, format: "text" },
            state: "canonical",
            confidence: 0.9,
            priority: "normal",
            visibility: "active",
            created_at: createdAt,
            updated_at: createdAt,
            source: { client: "remote-test", device_id: "remote-invalid" }
          },
          created_at: createdAt,
          source: { client: "remote-test", device_id: "remote-invalid" }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
  return paths;
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

  it("bounds remote observation time without misreporting the configured local repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-status-timeout-"));
    const store = join(root, "store");
    const server = createServer(() => {
      // Intentionally leave the smart-HTTP request open; the sync status timeout
      // must terminate Git without waiting for the remote indefinitely.
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      await initializeStore(store, { id: () => "device_status_timeout" });
      await exec("git", ["init"], { cwd: store });
      await exec("git", ["branch", "-M", "main"], { cwd: store });
      await exec("git", ["remote", "add", "origin", `http://127.0.0.1:${address.port}/memory.git`], {
        cwd: store
      });

      const startedAt = Date.now();
      const status = await withOperationDeadline(1_000, () => getGitSyncStatus(store, { remote_timeout_ms: 100 }));
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(status).toMatchObject({
        configured: true,
        remote_observation: { checked: true, reachable: false }
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["pull", "push"] as const)(
    "bounds a hanging remote during %s under an inherited hook deadline",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), `moryn-sync-${operation}-deadline-`));
      const store = join(root, "store");
      const server = createServer(() => {
        // Keep the smart-HTTP request open. The inherited host-operation budget
        // must terminate Git before the host's outer hook timeout fires.
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address() as AddressInfo;
        await initializeStore(store, { id: () => `device_${operation}_deadline` });
        await exec("git", ["init"], { cwd: store });
        await exec("git", ["branch", "-M", "main"], { cwd: store });
        await exec("git", ["remote", "add", "origin", `http://127.0.0.1:${address.port}/memory.git`], { cwd: store });

        const startedAt = Date.now();
        const sync = () => (operation === "pull" ? pullGitSync(store) : pushGitSync(store));
        await expect(withOperationDeadline(100, sync)).rejects.toBeInstanceOf(OperationDeadlineExceededError);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("keeps configured true when a later local status projection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-status-error-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, { id: () => "device_status_error" });
      await exec("git", ["init"], { cwd: store });
      await writeFile(join(store, ".git", "index"), "not-a-git-index\n", "utf8");

      await expect(getGitSyncStatus(store)).resolves.toEqual(
        expect.objectContaining({
          configured: true,
          error: expect.any(String)
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads local sync status without contacting the remote when observation is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-local-status-"));
    const store = join(root, "store");
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500);
      response.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as AddressInfo;
      await initializeStore(store, { id: () => "device_local_status" });
      await exec("git", ["init"], { cwd: store });
      await exec("git", ["branch", "-M", "main"], { cwd: store });
      await exec("git", ["remote", "add", "origin", `http://127.0.0.1:${address.port}/memory.git`], {
        cwd: store
      });

      const status = await getGitSyncStatus(store, { observe_remote: false });

      expect(status).toMatchObject({
        configured: true,
        branch: "main",
        remote: `http://127.0.0.1:${address.port}/memory.git`
      });
      expect(status.remote_observation).toBeUndefined();
      expect(requests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects bounded pending event counts, local file time, and checked remote proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-pending-status-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-27T00:00:00.000Z",
        id: () => "device_pending_status"
      });
      await initializeGitSync(store, remote);
      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_pending_status`
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Pending status should distinguish local save from remote proof.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", device_id: "device_pending_status" }
      });

      const pending = await getGitSyncStatus(store);
      expect(pending).toMatchObject({
        configured: true,
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          total_files: 1,
          managed_files: 1,
          unmanaged_files: 0,
          event_files: 1,
          untracked_event_files: 1,
          added_event_files: 0,
          modified_event_files: 0,
          ignored_event_files: 0,
          pending_time_complete: true
        },
        remote_observation: {
          checked: true,
          reachable: true,
          contains_local_head: true
        }
      });
      expect(pending.pending_changes?.oldest_pending_file_mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const pendingEventPath = (await getPendingSyncEvidence(store)).paths.find(
        (path) => path.startsWith("events/") && path.endsWith(".json")
      );
      expect(pendingEventPath).toBeDefined();
      await writeFile(join(store, ".git", "info", "exclude"), `${pendingEventPath}\n`, "utf8");
      const ignored = await getGitSyncStatus(store);
      expect(ignored).toMatchObject({
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          total_files: 1,
          managed_files: 1,
          unmanaged_files: 0,
          event_files: 1,
          untracked_event_files: 0,
          modified_event_files: 0,
          ignored_event_files: 1,
          pending_time_complete: true
        },
        remote_observation: { contains_local_head: true }
      });
      expect(ignored.pending_changes).not.toHaveProperty("paths");

      await symlink(join(store, pendingEventPath ?? "missing-event"), join(store, "events", "pending-event-link.json"));
      const withEventSymlink = await getGitSyncStatus(store);
      expect(withEventSymlink.pending_changes).toMatchObject({
        managed_files: 2,
        unmanaged_files: 0,
        event_files: 2,
        untracked_event_files: 1,
        ignored_event_files: 1,
        pending_time_complete: false
      });
      expect(withEventSymlink.pending_changes).not.toHaveProperty("oldest_pending_file_mtime");

      await Promise.all(
        Array.from({ length: 51 }, (_, index) => writeFile(join(store, `scratch-${index}.txt`), "local\n", "utf8"))
      );
      const bounded = await getGitSyncStatus(store);
      expect(bounded.pending_changes).toMatchObject({
        total_files: 53,
        managed_files: 2,
        unmanaged_files: 51,
        event_files: 2,
        ignored_event_files: 1
      });
      expect(bounded.pending_changes).not.toHaveProperty("paths");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a managed path visible when Git records it as a rename out of the sync tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-managed-rename-status-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_managed_rename_status" });
      await initializeGitSync(store, remote);
      await exec("git", ["mv", ".gitignore", "scratch-ignore"], { cwd: store });

      const status = await getGitSyncStatus(store);
      expect(status).toMatchObject({
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          managed_files: 1,
          event_files: 0
        }
      });
      expect(status.pending_changes?.unmanaged_files).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it("rejects malformed initial event JSON before creating a commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-audit-gate-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-24T00:00:00.000Z",
        id: () => "device_init_audit_gate"
      });
      const eventDirectory = join(store, "events", "device-corrupt", "2026-07");
      await mkdir(eventDirectory, { recursive: true });
      await writeFile(join(eventDirectory, "evt_broken.json"), "{broken", "utf8");

      await expectEventHistoryMutation(() => initializeGitSync(store, remote), [root, "evt_broken.json", "{broken"]);
      expect(await remoteMainOid(remote)).toBeUndefined();
      await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
      await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: store })).resolves.toBeDefined();
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
      expect(push.sync_gate).toMatchObject({
        policy_version: "moryn.sync-gate.v1",
        mode: "shadow",
        enforced: false,
        destination: "personal_sync",
        decision: "allow",
        would_block: false,
        summary: { total_events: 1, allowed_events: 1, review_required_events: 0, denied_events: 0 }
      });
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

  it("reports a local-only pending event in shadow mode without blocking the current push path", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-gate-shadow-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-08-18T00:00:00.000Z",
        id: () => "device_sync_gate"
      });
      await initializeGitSync(store, remote);
      const engine = createEngine({
        storePath: store,
        now: () => "2026-08-18T00:01:00.000Z",
        id: (prefix) => `${prefix}_sync_gate`
      });
      await engine.write({
        kind: "memory",
        type: "local_note",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "This payload needs the future local event journal.",
          distribution: "local_only"
        },
        state: "canonical",
        source: { client: "test", device_id: "device_sync_gate" }
      });

      const result = await pushGitSync(store, { message: "exercise sync gate shadow mode" });

      expect(result).toMatchObject({
        ok: true,
        pushed: true,
        sync_gate: {
          mode: "shadow",
          enforced: false,
          decision: "deny",
          would_block: true,
          summary: { total_events: 1, allowed_events: 0, review_required_events: 0, denied_events: 1 },
          findings: [
            {
              code: "local_only_distribution",
              decision: "deny",
              content_included: false
            }
          ]
        }
      });
      expect(await remoteMainOid(remote)).toBeDefined();
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
      const conflictingEvent = (side: "a" | "b") =>
        `${JSON.stringify(
          {
            event_id: "evt_conflict",
            op: "upsert_record",
            record: {
              id: "rec_conflict",
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "moryn",
              tags: [],
              content: { text: `Device ${side} chose a different valid value.`, format: "text" },
              state: "canonical",
              confidence: 0.9,
              priority: "normal",
              visibility: "active",
              created_at: "2026-05-27T00:01:00.000Z",
              updated_at: "2026-05-27T00:01:00.000Z",
              source: { client: "test", device_id: `device_${side}` }
            },
            created_at: "2026-05-27T00:01:00.000Z",
            source: { client: "test", device_id: `device_${side}` }
          },
          null,
          2
        )}\n`;
      await writeFile(join(storeA, conflictFile), conflictingEvent("a"), "utf8");
      await writeFile(join(storeB, conflictFile), conflictingEvent("b"), "utf8");
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

      await expectEventHistoryMutation(() => pullGitSync(store), [root, "events/idempotent"]);

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

      await expectEventHistoryMutation(() => pullGitSync(store), [root, "events/external"]);

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
      expect(push.automatic_event_audit).toMatchObject({
        status: "completed",
        event_count: 2,
        record_count: 2
      });
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

  it("keeps a committed local event out of the remote when the final event audit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-audit-gate-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-24T00:00:00.000Z",
        id: () => "device_audit_gate"
      });
      await initializeGitSync(store, remote);
      const remoteBefore = await remoteMainOid(remote);
      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-24T00:01:00.000Z",
        id: (prefix) => `${prefix}_audit_gate`
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "This remains local until integrity verification succeeds." },
        source: { client: "test", device_id: "device_audit_gate" }
      });

      const result = await pushGitSync(
        store,
        { message: "must stop at final audit" },
        {
          run_automatic_event_audit: async () => ({
            status: "failed",
            failure_stage: "replay",
            code: "EVENT_REPLAY_INVALID",
            reason: "Stored event history could not be replayed safely.",
            event_count: 1,
            record_count: 0,
            snapshot_status: "not_checked"
          })
        }
      );

      expect(result).toMatchObject({
        ok: false,
        committed: true,
        pushed: false,
        automatic_event_audit: { status: "failed", code: "EVENT_REPLAY_INVALID" }
      });
      expect(await remoteMainOid(remote)).toBe(remoteBefore);
      await expect(
        engine.write({
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          content: { text: "The store lease was released after the guarded skip." },
          source: { client: "test", device_id: "device_audit_gate" }
        })
      ).resolves.toMatchObject({ record: { type: "fact" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed event JSON before push can create a local commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-malformed-event-gate-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-24T00:00:00.000Z",
        id: () => "device_malformed_gate"
      });
      await initializeGitSync(store, remote);
      const remoteBefore = await remoteMainOid(remote);
      const eventDirectory = join(store, "events", "device-corrupt", "2026-07");
      await mkdir(eventDirectory, { recursive: true });
      await writeFile(join(eventDirectory, "evt_broken.json"), "{broken", "utf8");
      const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();

      await expectEventHistoryMutation(
        () => pushGitSync(store, { message: "malformed event must remain local" }),
        [root, "evt_broken.json", "{broken"]
      );
      expect(await remoteMainOid(remote)).toBe(remoteBefore);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(headBefore);
      await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: store })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["modified", "deleted"] as const)(
    "rejects a %s tracked event before changing the index or remote",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), `moryn-sync-event-${mode}-`));
      const remote = join(root, "remote.git");
      const store = join(root, "store");
      try {
        await exec("git", ["init", "--bare", remote]);
        const trackedPath = await seedTrackedEvent(store, remote, `device_${mode}`);
        const original = JSON.parse(await readFile(join(store, trackedPath), "utf8")) as { event_id: string };
        const remoteBefore = await remoteMainOid(remote);
        const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();

        if (mode === "modified") {
          await rewriteTrackedEventText(store, trackedPath, "A valid rewrite must still be rejected.");
        } else {
          await rm(join(store, trackedPath));
        }

        await expectEventHistoryMutation(() => pushGitSync(store), [root, trackedPath, original.event_id]);
        expect(await remoteMainOid(remote)).toBe(remoteBefore);
        expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(headBefore);
        await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: store })).resolves.toBeDefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it("rejects an already committed valid event rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-committed-event-rewrite-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      const trackedPath = await seedTrackedEvent(store, remote, "device_committed_rewrite");
      const eventId = await rewriteTrackedEventText(store, trackedPath, "Committed valid rewrites are forbidden too.");
      await exec("git", ["add", "--", trackedPath], { cwd: store });
      await exec("git", ["commit", "-m", "rewrite old event"], { cwd: store });
      const localHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();
      const remoteBefore = await remoteMainOid(remote);

      await expectEventHistoryMutation(() => pushGitSync(store), [root, trackedPath, eventId]);

      expect(await remoteMainOid(remote)).toBe(remoteBefore);
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHead);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an ignored event that would be omitted from the remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-ignored-event-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_ignored" });
      await initializeGitSync(store, remote);
      await writeFile(join(store, ".git", "info", "exclude"), "events/device_ignored/\n", "utf8");
      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_ignored`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Invisible event must not pass sync." },
        source: { client: "test", device_id: "device_ignored" }
      });
      const remoteBefore = await remoteMainOid(remote);

      await expectEventHistoryMutation(() => pushGitSync(store), [root, "device_ignored", "Invisible event"]);

      expect(await remoteMainOid(remote)).toBe(remoteBefore);
      await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: store })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink or non-JSON file under events", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-unsafe-event-entry-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_unsafe_entry" });
      await initializeGitSync(store, remote);
      const eventDirectory = join(store, "events", "device-unsafe", "2026-07");
      await mkdir(eventDirectory, { recursive: true });
      await writeFile(join(store, "outside.json"), "{}\n", "utf8");
      await symlink(join(store, "outside.json"), join(eventDirectory, "evt_symlink.json"));
      await writeFile(join(eventDirectory, "notes.txt"), "not an event\n", "utf8");

      await expectEventHistoryMutation(() => pushGitSync(store), [root, "evt_symlink.json", "notes.txt"]);
      await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: store })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a new regular schema-valid event and publishes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-valid-new-event-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_valid_new" });
      await initializeGitSync(store, remote);
      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_valid_new`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "A valid append-only event is published." },
        source: { client: "test", device_id: "device_valid_new" }
      });

      await expect(pushGitSync(store)).resolves.toMatchObject({ ok: true, committed: true, pushed: true });
      expect(await remoteMainOid(remote)).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the append-only workspace gate during sync init", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-event-rewrite-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device_init_rewrite" });
      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_init_rewrite`
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Initial tracked event." },
        source: { client: "test", device_id: "device_init_rewrite" }
      });
      await exec("git", ["init"], { cwd: store });
      await configureGitIdentity(store, "InitRewrite");
      await exec("git", ["branch", "-M", "main"], { cwd: store });
      await exec("git", ["add", "events"], { cwd: store });
      await exec("git", ["commit", "-m", "track initial event"], { cwd: store });
      const trackedPath = await firstTrackedEventPath(store);
      const eventId = await rewriteTrackedEventText(store, trackedPath, "Init must reject this valid rewrite.");
      const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();

      await expectEventHistoryMutation(() => initializeGitSync(store, remote), [root, trackedPath, eventId]);

      expect(await remoteMainOid(remote)).toBeUndefined();
      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(headBefore);
      await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: store })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a fetched remote history that rewrites a valid event", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-remote-event-rewrite-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      const trackedPath = await seedTrackedEvent(storeA, remote, "device_remote_rewrite");
      await initializeStore(storeB, { id: () => "device_remote_reader" });
      await initializeGitSync(storeB, remote);
      const localHeadBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: storeB })).stdout.trim();

      const eventId = await rewriteTrackedEventText(storeA, trackedPath, "Remote history contains a valid rewrite.");
      await exec("git", ["add", "--", trackedPath], { cwd: storeA });
      await exec("git", ["commit", "-m", "rewrite remote event"], { cwd: storeA });
      await exec("git", ["push", "origin", "main"], { cwd: storeA });

      await expectEventHistoryMutation(() => pullGitSync(storeB), [root, trackedPath, eventId]);

      expect((await exec("git", ["rev-parse", "HEAD"], { cwd: storeB })).stdout.trim()).toBe(localHeadBefore);
      await expect(exec("git", ["diff", "--cached", "--quiet"], { cwd: storeB })).resolves.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed remote event JSON before sync init checks out remote history", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-sync-init-malformed-remote-event-"));
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const store = join(root, "store");
    const malformedPath = join("events", "remote-device", "2026-07", "evt_malformed.json");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeGitRepository(seed, remote, "MalformedRemote");
      await mkdir(dirname(join(seed, malformedPath)), { recursive: true });
      await writeFile(join(seed, malformedPath), "{malformed remote event", "utf8");
      const rejectedRemoteOid = await commitAndPushAll(seed, "Add malformed remote event");

      await initializeStore(store, {
        now: () => "2026-07-27T00:00:00.000Z",
        id: () => "device_malformed_remote_init"
      });
      const configBefore = await readFile(join(store, "config.json"), "utf8");

      await expectEventHistoryMutation(
        () => initializeGitSync(store, remote),
        [root, malformedPath, "malformed remote event"]
      );

      await expect(readFile(join(store, "config.json"), "utf8")).resolves.toBe(configBefore);
      await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
      await expect(access(join(store, malformedPath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["pull", "push"] as const)(
    "rejects malformed remote event JSON before %s changes local HEAD or event files",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), `moryn-sync-${operation}-malformed-remote-event-`));
      const remote = join(root, "remote.git");
      const store = join(root, "store");
      const legacy = join(root, "legacy");
      const malformedPath = join("events", "remote-device", "2026-07", "evt_malformed.json");
      try {
        await exec("git", ["init", "--bare", remote]);
        await initializeStore(store, {
          now: () => "2026-07-27T00:00:00.000Z",
          id: () => `device_malformed_remote_${operation}`
        });
        await initializeGitSync(store, remote);

        await exec("git", ["clone", remote, legacy]);
        await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
        await configureGitIdentity(legacy, "MalformedRemote");
        await mkdir(dirname(join(legacy, malformedPath)), { recursive: true });
        await writeFile(join(legacy, malformedPath), "{malformed remote event", "utf8");
        const rejectedRemoteOid = await commitAndPushAll(legacy, "Add malformed remote event");

        let localEventPath: string | undefined;
        let localEventContents: string | undefined;
        if (operation === "push") {
          const engine = createEngine({
            storePath: store,
            now: () => "2026-07-27T00:01:00.000Z",
            id: (prefix) => `${prefix}_local_before_malformed_remote`
          });
          await engine.write({
            kind: "memory",
            type: "fact",
            scope: "project",
            project_id: "moryn",
            content: { text: "This valid local event must remain untouched when the remote is malformed." },
            source: { client: "test", device_id: `device_malformed_remote_${operation}` }
          });
          localEventPath = (
            await exec("git", ["ls-files", "--others", "--exclude-standard", "--", "events"], { cwd: store })
          ).stdout.trim();
          if (!localEventPath) throw new Error("Expected a local event before guarded push");
          localEventContents = await readFile(join(store, localEventPath), "utf8");
        }
        const localHeadBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();
        const worktreeBefore = (await exec("git", ["status", "--porcelain=v1", "-z"], { cwd: store })).stdout;

        await expectEventHistoryMutation(
          () => (operation === "pull" ? pullGitSync(store) : pushGitSync(store, { message: "must not rebase" })),
          [root, malformedPath, "malformed remote event"]
        );

        expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHeadBefore);
        expect((await exec("git", ["status", "--porcelain=v1", "-z"], { cwd: store })).stdout).toBe(worktreeBefore);
        await expect(access(join(store, malformedPath))).rejects.toMatchObject({ code: "ENOENT" });
        if (localEventPath && localEventContents) {
          await expect(readFile(join(store, localEventPath), "utf8")).resolves.toBe(localEventContents);
        }
        expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(["missing_target", "duplicate_event_id"] as const)(
    "rejects replay-invalid remote history (%s) before sync init checks it out",
    async (invalidity) => {
      const root = await mkdtemp(join(tmpdir(), `moryn-sync-init-${invalidity}-remote-event-`));
      const remote = join(root, "remote.git");
      const seed = join(root, "seed");
      const store = join(root, "store");
      try {
        await exec("git", ["init", "--bare", remote]);
        await initializeGitRepository(seed, remote, "ReplayInvalidRemote");
        const invalidPaths = await writeReplayInvalidRemoteHistory(seed, invalidity);
        const rejectedRemoteOid = await commitAndPushAll(seed, `Add ${invalidity} remote event history`);

        await initializeStore(store, {
          now: () => "2026-07-27T00:00:00.000Z",
          id: () => `device_replay_invalid_init_${invalidity}`
        });
        const configBefore = await readFile(join(store, "config.json"), "utf8");

        await expectEventHistoryMutation(
          () => initializeGitSync(store, remote),
          [root, ...invalidPaths, "REMOTE_REPLAY_INVALID_MARKER", "REMOTE_DUPLICATE_ID_MARKER"]
        );

        await expect(readFile(join(store, "config.json"), "utf8")).resolves.toBe(configBefore);
        await expect(exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: store })).rejects.toBeDefined();
        for (const path of invalidPaths) {
          await expect(access(join(store, path))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["pull", "missing_target"],
    ["pull", "duplicate_event_id"],
    ["push", "missing_target"],
    ["push", "duplicate_event_id"]
  ] as const)(
    "rejects replay-invalid remote history before %s changes local state (%s)",
    async (operation, invalidity) => {
      const root = await mkdtemp(join(tmpdir(), `moryn-sync-${operation}-${invalidity}-remote-event-`));
      const remote = join(root, "remote.git");
      const store = join(root, "store");
      const legacy = join(root, "legacy");
      try {
        await exec("git", ["init", "--bare", remote]);
        await initializeStore(store, {
          now: () => "2026-07-27T00:00:00.000Z",
          id: () => `device_replay_invalid_${operation}_${invalidity}`
        });
        await initializeGitSync(store, remote);

        await exec("git", ["clone", remote, legacy]);
        await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: legacy });
        await configureGitIdentity(legacy, "ReplayInvalidRemote");
        const invalidPaths = await writeReplayInvalidRemoteHistory(legacy, invalidity);
        const rejectedRemoteOid = await commitAndPushAll(legacy, `Add ${invalidity} remote event history`);

        let localEventPath: string | undefined;
        let localEventContents: string | undefined;
        if (operation === "push") {
          const engine = createEngine({
            storePath: store,
            now: () => "2026-07-27T00:01:00.000Z",
            id: (prefix) => `${prefix}_local_before_replay_invalid_remote_${invalidity}`
          });
          await engine.write({
            kind: "memory",
            type: "fact",
            scope: "project",
            project_id: "moryn",
            content: { text: "A valid local event remains untouched by invalid remote history." },
            source: { client: "test", device_id: `device_replay_invalid_${operation}_${invalidity}` }
          });
          localEventPath = (
            await exec("git", ["ls-files", "--others", "--exclude-standard", "--", "events"], { cwd: store })
          ).stdout.trim();
          if (!localEventPath) throw new Error("Expected a local event before guarded push");
          localEventContents = await readFile(join(store, localEventPath), "utf8");
        }
        const localHeadBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim();
        const worktreeBefore = (await exec("git", ["status", "--porcelain=v1", "-z"], { cwd: store })).stdout;

        await expectEventHistoryMutation(
          () => (operation === "pull" ? pullGitSync(store) : pushGitSync(store, { message: "must not rebase" })),
          [root, ...invalidPaths, "REMOTE_REPLAY_INVALID_MARKER", "REMOTE_DUPLICATE_ID_MARKER"]
        );

        expect((await exec("git", ["rev-parse", "HEAD"], { cwd: store })).stdout.trim()).toBe(localHeadBefore);
        expect((await exec("git", ["status", "--porcelain=v1", "-z"], { cwd: store })).stdout).toBe(worktreeBefore);
        for (const path of invalidPaths) {
          await expect(access(join(store, path))).rejects.toMatchObject({ code: "ENOENT" });
        }
        if (localEventPath && localEventContents) {
          await expect(readFile(join(store, localEventPath), "utf8")).resolves.toBe(localEventContents);
        }
        expect(await remoteMainOid(remote)).toBe(rejectedRemoteOid);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(["init", "pull", "push"] as const)(
    "syncs an unsafe oversized project identity through %s with bounded artifact names",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), `moryn-sync-${operation}-long-project-`));
      const remote = join(root, "remote.git");
      const store = join(root, "store");
      const remoteWriter = join(root, "remote-writer");
      try {
        await exec("git", ["init", "--bare", remote]);
        let remoteEventPath: string;
        let result: Awaited<ReturnType<typeof initializeGitSync | typeof pullGitSync | typeof pushGitSync>>;

        if (operation === "init") {
          await initializeGitRepository(remoteWriter, remote, "LongProjectRemote");
          remoteEventPath = await writeLongProjectRemoteEvent(remoteWriter);
          await commitAndPushAll(remoteWriter, "Add long project identity");
          await initializeStore(store, { id: () => "device_long_project_init" });
          result = await initializeGitSync(store, remote);
        } else {
          await initializeStore(store, { id: () => `device_long_project_${operation}` });
          await initializeGitSync(store, remote);
          await exec("git", ["clone", remote, remoteWriter]);
          await exec("git", ["checkout", "-B", "main", "origin/main"], { cwd: remoteWriter });
          await configureGitIdentity(remoteWriter, "LongProjectRemote");
          remoteEventPath = await writeLongProjectRemoteEvent(remoteWriter);
          await commitAndPushAll(remoteWriter, "Add long project identity");

          if (operation === "push") {
            const engine = createEngine({
              storePath: store,
              now: () => "2026-07-28T00:01:00.000Z",
              id: (prefix) => `${prefix}_local_alongside_long_project`
            });
            await engine.write({
              kind: "memory",
              type: "fact",
              scope: "project",
              project_id: "moryn",
              content: { text: "A local append rebases safely over the long remote project identity." },
              source: { client: "test", device_id: "device_long_project_push" }
            });
            result = await pushGitSync(store, { message: "Sync alongside long project identity" });
          } else {
            result = await pullGitSync(store);
          }
        }

        expect(result).toMatchObject({ ok: true });
        await expect(access(join(store, remoteEventPath))).resolves.toBeUndefined();
        const shardName = retrievalProjectShardName(LONG_UNSAFE_REMOTE_PROJECT_ID);
        expect(shardName).toMatch(/^~[a-f0-9]{64}\.json$/);
        expect(shardName.length).toBeLessThan(80);
        expect(shardName).not.toContain("PRIVATE_REMOTE_PROJECT");
        await expect(access(join(store, "snapshots", "retrieval", "projects", shardName))).resolves.toBeUndefined();
        expect(await readdir(join(store, "snapshots", "retrieval", "projects"))).toContain(shardName);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

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
