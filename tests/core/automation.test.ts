import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { automationReconcile, automationStatus } from "../../src/core/automation.js";

async function withTempDir<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "moryn-automation-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("automation readiness", () => {
  it("reports compact status and keeps reconcile dry-run read-only", async () => {
    await withTempDir(async (root) => {
      const store = join(root, "store");
      const project = join(root, "project");
      await mkdir(project, { recursive: true });

      const status = await automationStatus({ storePath: store, projectPath: project });
      expect(status).toMatchObject({
        operation: "automation_status",
        status: "needs_reconcile",
        ready: false,
        checks: {
          store: { status: "missing" },
          project: { status: "missing" },
          host_activation: { status: "skipped" }
        },
        next: {
          recommended_action: "reconcile",
          command: expect.stringContaining("moryn automation reconcile"),
          safe_to_run: true
        }
      });

      const dryRun = await automationReconcile({ storePath: store, projectPath: project });
      expect(dryRun).toMatchObject({
        operation: "automation_reconcile",
        mode: "dry_run",
        status: "changes_planned",
        changed: false,
        committed: false,
        host_activation_requested: false,
        host_config_writes: "none",
        changes: {
          store_config: { status: "planned", writes: "moryn_store" },
          project_config: { status: "planned", writes: "project_config" }
        },
        next: { recommended_action: "apply_changes", safe_to_run: false }
      });
      expect(dryRun.changes).not.toHaveProperty("host_activation");
      await expect(readFile(join(store, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(project, ".moryn.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("applies only missing local configuration and is idempotent", async () => {
    await withTempDir(async (root) => {
      const store = join(root, "store");
      const project = join(root, "project");
      await mkdir(project, { recursive: true });

      const applied = await automationReconcile({ storePath: store, projectPath: project, apply: true });
      expect(applied).toMatchObject({
        mode: "apply",
        status: "reconciled",
        changed: true,
        committed: true,
        host_activation_requested: false,
        host_config_writes: "none",
        changes: {
          store_config: { status: "applied" },
          project_config: { status: "applied" }
        },
        checks: {
          store: { status: "ready" },
          project: { status: "ready" },
          host_activation: { status: "skipped" }
        }
      });
      await expect(readFile(join(store, "config.json"), "utf8")).resolves.toContain("store_version");
      await expect(readFile(join(project, ".moryn.json"), "utf8")).resolves.toContain("project_id");
      await expect(readFile(join(project, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const replay = await automationReconcile({ storePath: store, projectPath: project, apply: true });
      expect(replay).toMatchObject({ status: "ready", changed: false, changes: {} });
    });
  });

  it("reports a committed partial result when a later local reconciliation step fails", async () => {
    await withTempDir(async (root) => {
      const store = join(root, "store");
      const project = join(root, "project");
      await mkdir(project, { recursive: true });

      await expect(
        automationReconcile(
          { storePath: store, projectPath: project, apply: true },
          {
            initializeProjectConfig: async () => {
              throw new Error("injected project config failure");
            }
          }
        )
      ).rejects.toMatchObject({
        code: "AUTOMATION_RECONCILE_PARTIALLY_COMMITTED",
        committed: true,
        recovery_hint: { applied_changes: ["store_config"] }
      });
      await expect(readFile(join(store, "config.json"), "utf8")).resolves.toContain("store_version");
      await expect(readFile(join(project, ".moryn.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("writes host configuration only after explicit activation approval", async () => {
    await withTempDir(async (root) => {
      const store = join(root, "store");
      const project = join(root, "project");
      await mkdir(project, { recursive: true });
      await automationReconcile({ storePath: store, projectPath: project, apply: true });

      const localOnly = await automationReconcile({
        storePath: store,
        projectPath: project,
        host: "codex",
        apply: true
      });
      expect(localOnly).toMatchObject({
        status: "needs_attention",
        changed: false,
        host_activation_requested: false,
        host_config_writes: "none",
        checks: { host_activation: { status: "drift" } },
        next: {
          recommended_action: "review_status",
          command: expect.stringContaining("moryn automation status")
        }
      });
      await expect(readFile(join(project, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const driftStatus = await automationStatus({ storePath: store, projectPath: project, host: "codex" });
      expect(driftStatus).toMatchObject({
        status: "needs_reconcile",
        next: {
          recommended_action: "reconcile",
          command: expect.stringContaining("--activate-host"),
          safe_to_run: true
        }
      });

      const dryRun = await automationReconcile({
        storePath: store,
        projectPath: project,
        host: "codex",
        activateHost: true
      });
      expect(dryRun).toMatchObject({
        mode: "dry_run",
        status: "changes_planned",
        changed: false,
        host_activation_requested: true,
        host_config_writes: "planned",
        changes: { host_activation: { status: "planned", writes: "host_config" } }
      });
      await expect(readFile(join(project, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const activated = await automationReconcile({
        storePath: store,
        projectPath: project,
        host: "codex",
        apply: true,
        activateHost: true
      });
      expect(activated).toMatchObject({
        status: "reconciled",
        changed: true,
        host_activation_requested: true,
        host_config_writes: "applied",
        changes: { host_activation: { status: "applied", writes: "host_config" } },
        checks: { host_activation: { status: "ready" } },
        host_activation: { host: "codex", status: "configured_unverified", healthy: true }
      });
      await expect(readFile(join(project, ".codex", "hooks.json"), "utf8")).resolves.toContain(" host hook ");

      const replay = await automationReconcile({
        storePath: store,
        projectPath: project,
        host: "codex",
        apply: true,
        activateHost: true
      });
      expect(replay).toMatchObject({ status: "ready", changed: false, host_config_writes: "none", changes: {} });
    });
  });

  it("reports host artifacts committed when the final activation step fails", async () => {
    await withTempDir(async (root) => {
      const store = join(root, "store");
      const project = join(root, "project");
      await mkdir(project, { recursive: true });
      await automationReconcile({ storePath: store, projectPath: project, apply: true });

      await expect(
        automationReconcile(
          {
            storePath: store,
            projectPath: project,
            host: "codex",
            apply: true,
            activateHost: true
          },
          {
            activateCodexHooks: async () => {
              throw new Error("injected host config failure");
            }
          }
        )
      ).rejects.toMatchObject({
        code: "AUTOMATION_RECONCILE_PARTIALLY_COMMITTED",
        committed: true,
        recovery_hint: {
          applied_changes: [],
          partially_applied_changes: ["host_activation"],
          cause_recovery_hint: {
            applied_steps: expect.arrayContaining(["integration_artifact"]),
            applied_paths: expect.any(Array)
          }
        }
      });
      await expect(readFile(join(project, ".codex", "moryn-hooks.json"), "utf8")).resolves.toContain('"hooks"');
      await expect(readFile(join(project, ".codex", "hooks.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects host activation without an explicit supported host", async () => {
    await withTempDir(async (root) => {
      const project = join(root, "project");
      await mkdir(project, { recursive: true });
      await expect(
        automationReconcile({ storePath: join(root, "store"), projectPath: project, activateHost: true })
      ).rejects.toThrow("activate_host requires host and project_path");
      await expect(
        automationReconcile({
          storePath: join(root, "store"),
          projectPath: project,
          host: "gemini",
          activateHost: true
        })
      ).rejects.toThrow("activate_host supports only claude or codex");
    });
  });
});
