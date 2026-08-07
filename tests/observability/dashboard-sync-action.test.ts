import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { replayEvents } from "../../src/core/replay.js";
import { readEvents } from "../../src/core/store.js";
import {
  buildDashboardData,
  type DashboardServerHandle,
  renderDashboardHtml,
  startDashboardServer
} from "../../src/observability/dashboard.js";
import { initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);
const roots: string[] = [];
const servers: DashboardServerHandle[] = [];

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `moryn-dashboard-${label}-`));
  roots.push(root);
  return root;
}

async function twoDeviceStores(
  label: string
): Promise<{ root: string; remote: string; storeA: string; storeB: string }> {
  const root = await tempRoot(label);
  const remote = join(root, "remote.git");
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  await exec("git", ["init", "--bare", remote]);
  await initializeStore(storeA, {
    now: () => "2026-08-06T00:00:00.000Z",
    id: () => `device_${label}_a`
  });
  await initializeGitSync(storeA, remote);
  await initializeStore(storeB, {
    now: () => "2026-08-06T00:00:01.000Z",
    id: () => `device_${label}_b`
  });
  await initializeGitSync(storeB, remote);
  return { root, remote, storeA, storeB };
}

function testEngine(storePath: string, label: string) {
  let sequence = 0;
  return createEngine({
    storePath,
    now: () => "2026-08-06T00:01:00.000Z",
    id: (prefix) => `${prefix}_${label}_${++sequence}`
  });
}

async function writeMemory(
  storePath: string,
  label: string,
  deviceId: string,
  text: string,
  fixedIds = false,
  options: {
    scope?: "global" | "project";
    project_id?: string;
    tags?: string[];
    now?: string;
  } = {}
): Promise<string> {
  const scope = options.scope ?? "project";
  const engine = fixedIds
    ? createEngine({
        storePath,
        now: () => options.now ?? "2026-08-06T00:01:00.000Z",
        id: (prefix) => `${prefix}_${label}`
      })
    : options.now
      ? createEngine({
          storePath,
          now: () => options.now!,
          id: (prefix) => `${prefix}_${label}`
        })
      : testEngine(storePath, label);
  const result = await engine.write({
    kind: "memory",
    type: "fact",
    scope,
    ...(scope === "project" ? { project_id: options.project_id ?? "moryn" } : {}),
    ...(options.tags ? { tags: options.tags } : {}),
    content: { text, format: "text" },
    state: "canonical",
    confirmed: true,
    source: { client: "test", device_id: deviceId }
  });
  return result.record.id;
}

async function startServer(
  storePath: string,
  options: { include_private?: boolean } = {}
): Promise<DashboardServerHandle> {
  const server = await startDashboardServer(storePath, {
    host: "127.0.0.1",
    port: 0,
    project_id: "moryn",
    include_private: options.include_private,
    refreshIntervalMs: 250
  });
  servers.push(server);
  return server;
}

async function postSync(server: DashboardServerHandle, body: unknown = { confirmed: true }): Promise<Response> {
  return fetch(new URL("/api/sync", server.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-moryn-dashboard-action": "sync"
    },
    body: JSON.stringify(body)
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dashboard shared-copy sync action", { timeout: 30_000 }, () => {
  it("merges remote updates and publishes local memory with one confirmed action", async () => {
    const { storeA, storeB } = await twoDeviceStores("sync-action");
    const currentRemoteId = await writeMemory(
      storeA,
      "remote_memory",
      "device-sync-a",
      "Memory written on device A.",
      false,
      { now: "2025-01-01T00:00:00.000Z" }
    );
    const globalRemoteId = await writeMemory(
      storeA,
      "global_remote_memory",
      "device-sync-a",
      "Global memory received from device A.",
      false,
      { scope: "global" }
    );
    const otherRemoteId = await writeMemory(
      storeA,
      "other_remote_memory",
      "device-sync-a",
      "OTHER_PROJECT_BODY_MUST_NOT_LEAK",
      false,
      { project_id: "other-project" }
    );
    const privateRemoteId = await writeMemory(
      storeA,
      "private_remote_memory",
      "device-sync-a",
      "PRIVATE_REMOTE_BODY_MUST_NOT_LEAK",
      false,
      { tags: ["private"] }
    );
    await pushGitSync(storeA, { message: "Device A update" });
    await writeMemory(storeB, "local_memory", "device-sync-b", "Memory written on device B.");

    const pendingData = await buildDashboardData(storeB, { project_id: "moryn" });
    expect(pendingData.sync_assurance.state).toBe("local_pending");
    expect(renderDashboardHtml(pendingData)).not.toContain("data-sync-action data-sync-endpoint");

    const server = await startServer(storeB, { include_private: true });
    const page = await (await fetch(server.url)).text();
    expect(page).toContain('data-sync-action data-sync-endpoint="api/sync"');
    expect(page).toContain('data-i18n-zh="同步并合并"');
    expect(page).toContain('"x-moryn-dashboard-action": "sync"');
    expect(page).toContain('store_status: "Shared copy updated"');
    expect(page).toContain('write_boundary: "Verified Git rebase and push"');
    expect(page).toContain("data-sync-action-receipt");
    expect(page).toContain("data-sync-memory-summary");
    expect(page).toContain("data-sync-memory-item");
    expect(page).toContain("没有收到新的远端记忆；共享副本已是最新。");

    const missingHeader = await fetch(new URL("/api/sync", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true })
    });
    expect(missingHeader.status).toBe(403);
    const wrongContentType = await fetch(new URL("/api/sync", server.url), {
      method: "POST",
      headers: { "content-type": "text/plain", "x-moryn-dashboard-action": "sync" },
      body: JSON.stringify({ confirmed: true })
    });
    expect(wrongContentType.status).toBe(415);
    const unconfirmed = await postSync(server, {});
    expect(unconfirmed.status).toBe(400);
    const injectedRemote = await postSync(server, { confirmed: true, remote: "https://example.invalid/other.git" });
    expect(injectedRemote.status).toBe(400);

    const response = await postSync(server);
    const result = (await response.json()) as {
      ok: boolean;
      status: string;
      pushed: boolean;
      remote_updates_merged: number;
      remote_commits_merged: number;
      remote_changes: {
        event_count: number;
        record_count: number;
        current_project_count: number;
        global_count: number;
        other_project_count: number;
        hidden_count: number;
        unattributed_event_count: number;
        items_omitted: number;
        items: Array<{
          event_id: string;
          record_id: string;
          operation: string;
          scope: string;
          summary: string;
        }>;
      };
      local_updates_published: boolean;
      remote_verified: boolean;
      position: { ahead: number; behind: number; sync_state: string };
    };
    expect(response.status).toBe(200);
    expect(result).toMatchObject({
      ok: true,
      status: "synced",
      pushed: true,
      remote_updates_merged: 1,
      remote_commits_merged: 1,
      remote_changes: {
        event_count: 4,
        record_count: 4,
        current_project_count: 1,
        global_count: 1,
        other_project_count: 1,
        hidden_count: 1,
        unattributed_event_count: 0,
        items_omitted: 0
      },
      local_updates_published: true,
      remote_verified: true,
      position: { ahead: 0, behind: 0, sync_state: "clean" }
    });
    expect(result.remote_changes.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record_id: currentRemoteId,
          scope: "project",
          summary: "Memory written on device A."
        }),
        expect.objectContaining({
          record_id: globalRemoteId,
          scope: "global",
          summary: "Global memory received from device A."
        })
      ])
    );
    expect(result.remote_changes.items).toHaveLength(2);
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(otherRemoteId);
    expect(serializedResult).not.toContain("OTHER_PROJECT_BODY_MUST_NOT_LEAK");
    expect(serializedResult).not.toContain(privateRemoteId);
    expect(serializedResult).not.toContain("PRIVATE_REMOTE_BODY_MUST_NOT_LEAK");

    const noNewResponse = await postSync(server);
    const noNewResult = (await noNewResponse.json()) as typeof result;
    expect(noNewResponse.status).toBe(200);
    expect(noNewResult).toMatchObject({
      ok: true,
      remote_commits_merged: 0,
      remote_changes: {
        event_count: 0,
        record_count: 0,
        current_project_count: 0,
        global_count: 0,
        other_project_count: 0,
        hidden_count: 0,
        items_omitted: 0,
        items: []
      }
    });

    const localTexts = [...replayEvents(await readEvents(storeB)).values()].map((record) => record.content.text);
    expect(localTexts).toEqual(
      expect.arrayContaining([
        "Memory written on device A.",
        "Global memory received from device A.",
        "Memory written on device B."
      ])
    );
    await pullGitSync(storeA);
    const remoteTexts = [...replayEvents(await readEvents(storeA)).values()].map((record) => record.content.text);
    expect(remoteTexts).toEqual(expect.arrayContaining(["Memory written on device A.", "Memory written on device B."]));

    const refreshed = (await (await fetch(new URL("/api/dashboard", server.url))).json()) as {
      sync_assurance: { state: string };
      sync: { ahead: number; behind: number };
      all_records: Array<{ text: string }>;
    };
    expect(refreshed.sync_assurance.state).toBe("remote_current");
    expect(refreshed.sync).toMatchObject({ ahead: 0, behind: 0 });
    expect(refreshed.all_records.map((record) => record.text)).toEqual(
      expect.arrayContaining(["Memory written on device A.", "Memory written on device B."])
    );
    const refreshedPage = await (await fetch(server.url)).text();
    expect(refreshedPage).toContain("Memory written on device A.");
    expect(refreshedPage).toContain("Memory written on device B.");
  });

  it("refuses an unconfigured store without rendering a dead action button", async () => {
    const root = await tempRoot("sync-local-only");
    await initializeStore(root, {
      now: () => "2026-08-06T00:00:00.000Z",
      id: () => "device_local_only"
    });
    const server = await startServer(root);
    const page = await (await fetch(server.url)).text();
    expect(page).not.toContain("data-sync-action data-sync-endpoint");

    const response = await postSync(server);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "not_configured",
      error_code: "SYNC_NOT_CONFIGURED"
    });
  });

  it("stops on a real rebase conflict and returns a bounded safe response", async () => {
    const { root, storeA, storeB } = await twoDeviceStores("sync-conflict");
    await writeMemory(storeA, "dashboard_conflict", "shared-device", "Device A conflict value.", true);
    const conflictedRecordId = await writeMemory(
      storeB,
      "dashboard_conflict",
      "shared-device",
      "Device B conflict value.",
      true
    );
    await testEngine(storeB, "conflict-dependent").revise({
      record_id: conflictedRecordId,
      patch: { "content.text": "A healthy revision that depends on the conflicted upsert." },
      reason: "Exercise conflict diagnostic replay dependencies.",
      source: { client: "test", device_id: "device-sync-b" }
    });
    const healthyRecordId = await writeMemory(
      storeB,
      "healthy_conflict_context",
      "device-sync-b",
      "Independent healthy memory remains visible during conflict."
    );
    await pushGitSync(storeA, { message: "Device A conflict update" });

    const server = await startServer(storeB);
    const response = await postSync(server);
    const result = (await response.json()) as { ok: boolean; status: string; error_code: string; message: string };
    expect(response.status).toBe(409);
    expect(result).toMatchObject({ ok: false, status: "conflict", error_code: "SYNC_CONFLICT" });
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.message).not.toContain("events/");

    const dashboardResponse = await fetch(new URL("/api/dashboard", server.url));
    const dashboardText = await dashboardResponse.text();
    expect(dashboardResponse.status, dashboardText).toBe(200);
    const dashboard = JSON.parse(dashboardText) as {
      sync: { sync_state: string };
      sync_assurance: { state: string };
      recent_records: Array<{ id: string }>;
    };
    expect(dashboard.sync.sync_state).toBe("conflict");
    expect(dashboard.sync_assurance.state).toBe("conflict");
    expect(dashboard.recent_records.map((record) => record.id)).toContain(healthyRecordId);
    const fragment = await (await fetch(new URL("/fragment", server.url))).text();
    expect(fragment).not.toContain("data-sync-action data-sync-endpoint");
  });
});
