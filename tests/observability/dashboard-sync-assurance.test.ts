import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { buildDashboardData, renderDashboardHtml } from "../../src/observability/dashboard.js";
import {
  buildDashboardSyncAssurance,
  PENDING_SYNC_ATTENTION_AGE_MS,
  PENDING_SYNC_ATTENTION_EVENT_FILES
} from "../../src/observability/dashboard-sync-assurance.js";
import { type GitSyncStatus, initializeGitSync, SYNC_STATUS_SELECTION_SOURCES } from "../../src/sync/git.js";

const exec = promisify(execFile);

function syncStatus(overrides: Partial<GitSyncStatus> = {}): GitSyncStatus {
  return {
    configured: true,
    branch: "main",
    remote: "git@example.invalid:memory.git",
    dirty: false,
    sync_state: "clean",
    ahead: 0,
    behind: 0,
    pending_changes: {
      total_files: 0,
      managed_files: 0,
      unmanaged_files: 0,
      event_files: 0,
      untracked_event_files: 0,
      added_event_files: 0,
      modified_event_files: 0,
      ignored_event_files: 0,
      pending_time_complete: false
    },
    remote_observation: {
      checked: true,
      reachable: true,
      remote_commit: "abc123",
      contains_local_head: true
    },
    selection_sources: SYNC_STATUS_SELECTION_SOURCES,
    ...overrides
  };
}

describe("dashboard sync assurance", () => {
  it("separates a verified committed remote copy from newer device-only memory changes", () => {
    const assurance = buildDashboardSyncAssurance(
      syncStatus({
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          total_files: 2,
          managed_files: 2,
          unmanaged_files: 0,
          event_files: 2,
          untracked_event_files: 1,
          added_event_files: 0,
          modified_event_files: 1,
          ignored_event_files: 0,
          oldest_pending_file_mtime: "2026-07-25T08:00:00.000Z",
          pending_time_complete: true
        }
      }),
      "2026-07-27T12:00:00.000Z"
    );

    expect(assurance).toMatchObject({
      state: "local_pending",
      remote_copy: {
        proof: "verified_committed_version",
        durable: true,
        covers_all_local_content: false
      },
      local_pending: {
        present: true,
        event_files: 2,
        untracked_event_files: 1,
        modified_event_files: 1,
        oldest_pending_file_mtime: "2026-07-25T08:00:00.000Z",
        age_basis: "filesystem_mtime",
        overdue: true
      },
      attention_required: true,
      attention_reasons: ["oldest_pending_file_modified_over_24_hours"]
    });
    expect(assurance.headline).toContain("saved changes are waiting for the shared copy");
    expect(assurance.detail).toContain("previous committed version");
    expect(assurance.detail).toContain("do not have remote proof yet");
  });

  it("escalates a significant pending event batch even when no reliable age is available", () => {
    const assurance = buildDashboardSyncAssurance(
      syncStatus({
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          total_files: PENDING_SYNC_ATTENTION_EVENT_FILES,
          managed_files: PENDING_SYNC_ATTENTION_EVENT_FILES,
          unmanaged_files: 0,
          event_files: PENDING_SYNC_ATTENTION_EVENT_FILES,
          untracked_event_files: PENDING_SYNC_ATTENTION_EVENT_FILES,
          added_event_files: 0,
          modified_event_files: 0,
          ignored_event_files: 0,
          pending_time_complete: false
        }
      }),
      "2026-07-27T12:00:00.000Z"
    );

    expect(assurance.local_pending).toMatchObject({ significant: true, overdue: false });
    expect(assurance.local_pending).not.toHaveProperty("age_ms");
    expect(assurance.attention_reasons).toEqual(["many_pending_event_files"]);
    expect(assurance.attention_required).toBe(true);
  });

  it("keeps a recent small local batch visible without turning it into a user exception", () => {
    const now = "2026-07-27T12:00:00.000Z";
    const recent = new Date(Date.parse(now) - PENDING_SYNC_ATTENTION_AGE_MS + 1).toISOString();
    const assurance = buildDashboardSyncAssurance(
      syncStatus({
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
          oldest_pending_file_mtime: recent,
          pending_time_complete: true
        }
      }),
      now
    );

    expect(assurance.state).toBe("local_pending");
    expect(assurance.local_pending.overdue).toBe(false);
    expect(assurance.attention_required).toBe(false);
  });

  it("treats ignored event files as device-only even when the committed version is remotely verified", () => {
    const assurance = buildDashboardSyncAssurance(
      syncStatus({
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          total_files: 1,
          managed_files: 1,
          unmanaged_files: 0,
          event_files: 1,
          untracked_event_files: 0,
          added_event_files: 0,
          modified_event_files: 0,
          ignored_event_files: 1,
          pending_time_complete: false
        }
      }),
      "2026-07-27T12:00:00.000Z"
    );

    expect(assurance).toMatchObject({
      state: "local_pending",
      remote_copy: { durable: true, covers_all_local_content: false },
      local_pending: { event_files: 1, ignored_event_files: 1 }
    });
  });

  it("reports remote durability only when the checked remote contains the local commit", () => {
    const verified = buildDashboardSyncAssurance(syncStatus(), "2026-07-27T12:00:00.000Z");
    const unavailable = buildDashboardSyncAssurance(
      syncStatus({
        remote_observation: { checked: true, reachable: false }
      }),
      "2026-07-27T12:00:00.000Z"
    );

    expect(verified).toMatchObject({
      state: "remote_current",
      remote_copy: { durable: true, covers_all_local_content: true }
    });
    expect(unavailable).toMatchObject({
      state: "remote_unverified",
      remote_copy: { durable: false, covers_all_local_content: false, reachable: false }
    });
  });

  it("does not call unrelated worktree files pending memory changes", () => {
    const assurance = buildDashboardSyncAssurance(
      syncStatus({
        dirty: true,
        sync_state: "dirty",
        pending_changes: {
          total_files: 1,
          managed_files: 0,
          unmanaged_files: 1,
          event_files: 0,
          untracked_event_files: 0,
          added_event_files: 0,
          modified_event_files: 0,
          ignored_event_files: 0,
          pending_time_complete: false
        }
      }),
      "2026-07-27T12:00:00.000Z"
    );

    expect(assurance).toMatchObject({
      state: "remote_current",
      remote_copy: { durable: true, covers_all_local_content: true },
      local_pending: { present: false, dirty_files: 0, unmanaged_files: 1 },
      attention_required: false
    });
  });

  it("keeps a scratch-only Git worktree out of user-facing sync warnings", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-unmanaged-worktree-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-27T00:00:00.000Z",
        id: () => "device_unmanaged_worktree"
      });
      await initializeGitSync(store, remote);
      await writeFile(join(store, "scratch.txt"), "not managed by Moryn\n", "utf8");

      const data = await buildDashboardData(store, { now: "2026-07-27T12:00:00.000Z" });
      expect(data.sync).toMatchObject({
        dirty: true,
        sync_state: "dirty",
        pending_changes: { total_files: 1, managed_files: 0, unmanaged_files: 1 }
      });
      expect(data.sync_assurance).toMatchObject({
        state: "remote_current",
        local_pending: { present: false, dirty_files: 0, unmanaged_files: 1 }
      });
      expect(data.health.status).toBe("healthy");
      expect(data.attention_items).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: "sync",
            title: "Local changes are waiting to sync"
          })
        ])
      );
      expect(renderDashboardHtml(data)).not.toContain("1 local saved change is waiting for the shared copy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("puts a significant device-only batch at the top and in exceptional attention", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-sync-assurance-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-27T00:00:00.000Z",
        id: () => "device_sync_assurance"
      });
      await initializeGitSync(store, remote);
      let record = 0;
      let event = 0;
      const engine = createEngine({
        storePath: store,
        now: () => "2026-07-27T00:01:00.000Z",
        id: (prefix) => (prefix === "rec" ? `rec_sync_${++record}` : `evt_sync_${++event}`)
      });
      for (let index = 0; index < PENDING_SYNC_ATTENTION_EVENT_FILES; index += 1) {
        await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          content: { text: `Concrete pending memory ${index + 1}.`, format: "text" },
          state: "canonical",
          confirmed: true,
          source: { client: "codex", device_id: "device_sync_assurance" }
        });
      }

      const data = await buildDashboardData(store, {
        project_id: "moryn",
        now: "2026-07-27T12:00:00.000Z"
      });
      const html = renderDashboardHtml(data);
      expect(data.sync_assurance).toMatchObject({
        state: "local_pending",
        local_pending: { event_files: PENDING_SYNC_ATTENTION_EVENT_FILES, significant: true },
        attention_required: true,
        attention_reasons: ["many_pending_event_files"]
      });
      expect(data.action_board.items_by_id.sync).toMatchObject({ value: 1, severity: "warning" });
      expect(data.dashboard_overview).toMatchObject({
        headline: "Inspect sync",
        primary_action: { source: "action_board.items_by_id.sync" }
      });
      expect(data.quiet_dashboard.attention_needed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: "warning",
            category: "sync",
            title: "Saved changes are still only confirmed on this device"
          })
        ])
      );
      expect(html).toContain('class="editorial-sync-assurance attention"');
      expect(html).not.toContain('data-i18n-en="Needs attention" data-i18n-zh="需要关注"');
      const assuranceStart = html.indexOf('data-sync-assurance="local_pending"');
      const assuranceEnd = html.indexOf("</section>", assuranceStart);
      const assuranceHtml = html.slice(assuranceStart, assuranceEnd);
      expect(assuranceHtml.indexOf("Technical details")).toBeGreaterThan(0);
      expect(assuranceHtml.indexOf("moryn sync --push")).toBeGreaterThan(assuranceHtml.indexOf("Technical details"));
      expect(html.match(/data-i18n-en="25 saved changes are waiting for the shared copy"/g)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a clean local store visibly unverified when the shared copy cannot be reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-remote-unverified-"));
    const store = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, {
        now: () => "2026-07-27T00:00:00.000Z",
        id: () => "device_remote_unverified"
      });
      await initializeGitSync(store, remote);
      await rm(remote, { recursive: true, force: true });

      const data = await buildDashboardData(store, { now: "2026-07-27T12:00:00.000Z" });
      const html = renderDashboardHtml(data);
      expect(data.sync).toMatchObject({
        configured: true,
        dirty: false,
        sync_state: "clean",
        remote_observation: { checked: true, reachable: false }
      });
      expect(data.sync_assurance).toMatchObject({
        state: "remote_unverified",
        remote_copy: { durable: false, covers_all_local_content: false, reachable: false },
        local_pending: { present: false }
      });
      expect(data.health).toMatchObject({
        status: "sync_pending",
        label: "Shared Copy Unverified"
      });
      expect(data.action_board.items_by_id.sync).toMatchObject({
        value: 0,
        severity: "info",
        hint: "Local memory is ready; the shared copy is not verified"
      });
      expect(data.dashboard_overview.primary_action.source).not.toBe("action_board.items_by_id.sync");
      expect(html).toContain('data-sync-assurance="remote_unverified"');
      expect(html).toContain("Local memory is ready; the shared copy is not verified");
      expect(html).not.toContain('data-i18n-en="Shared copy is current"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
