import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordActivationReceipt } from "../../src/core/activation-receipts.js";
import { activateClaudeSettings } from "../../src/core/claude-activation.js";
import { activateCodexHooks } from "../../src/core/codex-activation.js";
import { diagnoseHealthCheck } from "../../src/core/health-check.js";
import { inspectHostActivation } from "../../src/core/host-activation.js";
import {
  buildHostIntegrationArtifact,
  writeHostIntegrationArtifact
} from "../../src/core/host-integration-artifacts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("host activation inspector", () => {
  it("reports legacy PATH-bound Codex hooks as stale for the current runtime", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      const runtime = {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: join(storePath, "test-runtime-bindings")
      };
      const legacy = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath
      });
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      await writeFile(join(projectPath, ".codex", "hooks.json"), legacy.content, "utf8");

      const result = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "codex",
        runtime
      });

      expect(result).toMatchObject({
        status: "stale_moryn_config",
        healthy: false,
        repairable_automatically: true,
        stale_entries: 5,
        runtime_binding_status: "missing"
      });
    });
  });

  it("does not treat a receipt from an older runtime command as active", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      const runtime = {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: join(storePath, "test-runtime-bindings")
      };
      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime
      });
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime
      });
      await writeFile(join(projectPath, ".codex", "hooks.json"), artifact.content, "utf8");
      await recordActivationReceipt(storePath, {
        activation_id: artifact.activation_id,
        host: "codex",
        project_id: "moryn",
        event: "session_start",
        session_id: "legacy-runtime",
        device_id: "device-1",
        occurred_at: "2026-07-12T00:09:00.000Z",
        command_digest: "0".repeat(64)
      });

      const result = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "codex",
        runtime,
        now: "2026-07-12T00:10:00.000Z"
      });

      expect(result).toMatchObject({
        status: "configured_unverified",
        healthy: true,
        observed_events: [],
        runtime_binding_status: "current"
      });
      expect(result.last_receipt).toBeUndefined();
    });
  });

  it("diagnoses and repairs a moved runtime without changing trusted hook commands", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      const firstRuntime = {
        exec_file: "/runtime/old/node",
        cli_entry: "/runtime/old/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: join(storePath, "test-runtime-bindings")
      };
      const nextRuntime = {
        exec_file: "/runtime/next/node",
        cli_entry: "/runtime/next/moryn/dist/cli.js",
        package_version: "0.4.0",
        runtime_binding_root: join(storePath, "test-runtime-bindings")
      };
      const first = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime: firstRuntime
      });
      await activateCodexHooks({ project_path: projectPath, artifact: first.artifact });

      const stale = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "codex",
        runtime: nextRuntime
      });
      expect(stale).toMatchObject({
        status: "stale_moryn_config",
        healthy: false,
        configured_events: first.artifact.expected_events,
        stale_entries: 0,
        runtime_binding_status: "stale",
        repairable_automatically: true
      });

      const repaired = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime: nextRuntime
      });
      expect(repaired.artifact.command).toBe(first.artifact.command);
      expect(repaired).toMatchObject({ updated: false, runtime_binding: { updated: true } });
      await expect(
        inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          runtime: nextRuntime
        })
      ).resolves.toMatchObject({ status: "configured_unverified", runtime_binding_status: "current" });

      await chmod(repaired.artifact.runtime_binding!.path, 0o000);
      await expect(
        inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          runtime: nextRuntime
        })
      ).resolves.toMatchObject({
        status: "stale_moryn_config",
        healthy: false,
        runtime_binding_status: "stale"
      });
      await expect(
        writeHostIntegrationArtifact({
          host: "codex",
          project_id: "moryn",
          project_path: projectPath,
          store_path: storePath,
          runtime: nextRuntime
        })
      ).resolves.toMatchObject({ runtime_binding: { updated: true } });
      await writeFile(repaired.artifact.runtime_binding!.path, "corrupt launcher\n", "utf8");
      await expect(
        inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          runtime: nextRuntime
        })
      ).resolves.toMatchObject({
        status: "stale_moryn_config",
        healthy: false,
        runtime_binding_status: "stale"
      });
      await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime: nextRuntime
      });

      await writeFile(repaired.artifact.runtime_binding!.unavailable_marker_path, "corrupt marker\n", "utf8");
      await chmod(repaired.artifact.runtime_binding!.unavailable_marker_path, 0o000);
      await expect(
        inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          runtime: nextRuntime
        })
      ).resolves.toMatchObject({
        status: "stale_moryn_config",
        stale_entries: 0,
        runtime_binding_status: "unavailable",
        runtime_binding_unavailable_marker: repaired.artifact.runtime_binding!.unavailable_marker_path,
        repairable_automatically: true
      });
      await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime: nextRuntime
      });

      const unsafeTarget = join(storePath, "unsafe-runtime-target.sh");
      await rm(repaired.artifact.runtime_binding!.path);
      await writeFile(unsafeTarget, "unsafe\n", "utf8");
      await symlink(unsafeTarget, repaired.artifact.runtime_binding!.path);
      const unsafe = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "codex",
        runtime: nextRuntime
      });
      expect(unsafe).toMatchObject({
        status: "stale_moryn_config",
        healthy: false,
        runtime_binding_status: "unavailable",
        runtime_binding_error: expect.stringMatching(/symbolic link/)
      });
      const unsafeHealth = diagnoseHealthCheck({
        records: [],
        events: [],
        project_id: "moryn",
        activation_status: unsafe
      });
      expect(unsafeHealth).toMatchObject({
        status: "needs_attention",
        checks_by_id: { host_activation: { status: "warning" } }
      });

      await rm(repaired.artifact.runtime_binding!.path);
      await expect(
        inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          runtime: nextRuntime
        })
      ).resolves.toMatchObject({
        status: "stale_moryn_config",
        stale_entries: 0,
        runtime_binding_status: "missing",
        repairable_automatically: true
      });
    });
  });

  it("reports an unsafe runtime-binding parent as unhealthy activation evidence", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      const outside = join(storePath, "outside-runtime-bindings");
      const runtime = {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: join(storePath, "test-runtime-bindings")
      };
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      await mkdir(outside);
      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime
      });
      await writeFile(join(projectPath, ".codex", "hooks.json"), artifact.content, "utf8");
      await mkdir(runtime.runtime_binding_root);
      await symlink(
        outside,
        join(runtime.runtime_binding_root, basename(dirname(artifact.runtime_binding!.path))),
        "dir"
      );

      const result = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "codex",
        runtime
      });
      expect(result).toMatchObject({
        status: "stale_moryn_config",
        healthy: false,
        runtime_binding_status: "unavailable",
        runtime_binding_error: expect.stringMatching(/directory is a symbolic link/)
      });
      expect(
        diagnoseHealthCheck({ records: [], events: [], project_id: "moryn", activation_status: result })
      ).toMatchObject({ status: "needs_attention", checks_by_id: { host_activation: { status: "warning" } } });
    });
  });

  it("reports not installed for Claude without fragment, config, or receipt", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      const result = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "claude",
        now: "2026-07-12T00:10:00.000Z"
      });
      expect(result).toMatchObject({
        status: "not_installed",
        healthy: false,
        repairable_automatically: true,
        observed_events: []
      });
      expect(result.suggested_actions.map((action) => action.id)).toEqual(["activate_claude_hooks"]);
    });
  });

  it.each(["codex", "claude"] as const)(
    "detects and repairs an official %s hook under an obsolete event",
    async (host) => {
      await withInitializedTempStore(async (storePath) => {
        const projectPath = join(storePath, "project");
        const artifact = buildHostIntegrationArtifact({
          host,
          project_id: "moryn",
          project_path: projectPath,
          store_path: storePath
        });
        const settings = JSON.parse(artifact.content);
        settings.hooks.LegacyLifecycleEvent = [structuredClone(settings.hooks.SessionStart[0])];
        await mkdir(join(projectPath, host === "codex" ? ".codex" : ".claude"), { recursive: true });
        await writeFile(join(projectPath, artifact.merge_target), `${JSON.stringify(settings, null, 2)}\n`, "utf8");

        await expect(
          inspectHostActivation({
            store_path: storePath,
            project_path: projectPath,
            project_id: "moryn",
            host
          })
        ).resolves.toMatchObject({
          status: "stale_moryn_config",
          healthy: false,
          owned_entries: artifact.expected_events.length + 1,
          stale_entries: 1,
          repairable_automatically: true
        });

        const backupRoot = join(storePath, `${host}-test-config-backups`);
        if (host === "codex") {
          await activateCodexHooks({ project_path: projectPath, artifact, backup_root: backupRoot });
        } else {
          await activateClaudeSettings({ project_path: projectPath, artifact, backup_root: backupRoot });
        }

        await expect(
          inspectHostActivation({
            store_path: storePath,
            project_path: projectPath,
            project_id: "moryn",
            host
          })
        ).resolves.toMatchObject({
          status: "configured_unverified",
          healthy: true,
          owned_entries: artifact.expected_events.length,
          stale_entries: 0
        });
      });
    }
  );

  it("distinguishes generated, configured, stale, invalid, and active Claude states", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      const artifact = buildHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath
      });
      await writeHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath
      });
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "claude",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({ status: "generated_not_activated", repairable_automatically: true });

      await activateClaudeSettings({ project_path: projectPath, artifact });
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "claude",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({ status: "configured_unverified", healthy: true, configured_events: artifact.expected_events });

      const settingsPath = join(projectPath, ".claude", "settings.local.json");
      const stale = JSON.parse(artifact.content);
      stale.hooks.PreCompact[0].hooks[0].timeout = 29;
      await writeFile(settingsPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "claude",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({ status: "stale_moryn_config", repairable_automatically: true, stale_entries: 1 });

      await writeFile(settingsPath, '{"hooks":', "utf8");
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "claude",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({ status: "invalid_config", repairable_automatically: false });

      await activateClaudeSettings({ project_path: projectPath, artifact }).catch(async () => {
        await writeFile(settingsPath, artifact.content, "utf8");
      });
      await recordActivationReceipt(storePath, {
        activation_id: artifact.activation_id,
        host: "claude",
        project_id: "moryn",
        event: "session_start",
        session_id: "session-1",
        device_id: "device-1",
        occurred_at: "2026-07-12T00:09:00.000Z",
        command_digest: artifact.command_digest
      });
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "claude",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({
        status: "active",
        healthy: true,
        observed_events: ["session_start"],
        last_receipt: { event: "session_start" }
      });
    });
  });

  it("distinguishes generated, configured, and active Codex states", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath
      });
      await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath
      });
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({ status: "generated_not_activated", repairable_automatically: true });
      await activateCodexHooks({ project_path: projectPath, artifact });
      const configured = await inspectHostActivation({
        store_path: storePath,
        project_path: projectPath,
        project_id: "moryn",
        host: "codex",
        now: "2026-07-12T00:10:00.000Z"
      });
      expect(configured).toMatchObject({
        status: "configured_unverified",
        healthy: true,
        configured_events: artifact.expected_events
      });
      expect(configured.suggested_actions[0]).toMatchObject({
        id: "trust_codex_hooks",
        safe_to_run: false,
        command: "/hooks"
      });

      await recordActivationReceipt(storePath, {
        activation_id: artifact.activation_id,
        host: "codex",
        project_id: "moryn",
        event: "session_start",
        session_id: "session-1",
        device_id: "device-1",
        occurred_at: "2026-07-12T00:09:00.000Z",
        command_digest: artifact.command_digest
      });
      expect(
        await inspectHostActivation({
          store_path: storePath,
          project_path: projectPath,
          project_id: "moryn",
          host: "codex",
          now: "2026-07-12T00:10:00.000Z"
        })
      ).toMatchObject({ status: "active", healthy: true });
    });
  });
});
