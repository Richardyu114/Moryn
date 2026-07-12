import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { recordActivationReceipt } from "../../src/core/activation-receipts.js";
import { activateClaudeSettings } from "../../src/core/claude-activation.js";
import { activateCodexHooks } from "../../src/core/codex-activation.js";
import { inspectHostActivation } from "../../src/core/host-activation.js";
import { buildHostIntegrationArtifact, writeHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("host activation inspector", () => {
  it("reports not installed for Claude without fragment, config, or receipt", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      const result = await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "claude", now: "2026-07-12T00:10:00.000Z" });
      expect(result).toMatchObject({ status: "not_installed", healthy: false, repairable_automatically: true, observed_events: [] });
      expect(result.suggested_actions.map((action) => action.id)).toEqual(["activate_claude_hooks"]);
    });
  });

  it("distinguishes generated, configured, stale, invalid, and active Claude states", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      const artifact = buildHostIntegrationArtifact({ host: "claude", project_id: "moryn", project_path: projectPath, store_path: storePath });
      await writeHostIntegrationArtifact({ host: "claude", project_id: "moryn", project_path: projectPath, store_path: storePath });
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "claude", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "generated_not_activated", repairable_automatically: true });

      await activateClaudeSettings({ project_path: projectPath, artifact });
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "claude", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "configured_unverified", healthy: true, configured_events: artifact.expected_events });

      const settingsPath = join(projectPath, ".claude", "settings.local.json");
      const stale = JSON.parse(artifact.content);
      stale.hooks.PreCompact[0].hooks[0].command = stale.hooks.PreCompact[0].hooks[0].command.replace(storePath, `${storePath}-old`);
      await writeFile(settingsPath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "claude", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "stale_moryn_config", repairable_automatically: true, stale_entries: 1 });

      await writeFile(settingsPath, '{"hooks":', "utf8");
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "claude", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "invalid_config", repairable_automatically: false });

      await activateClaudeSettings({ project_path: projectPath, artifact }).catch(async () => {
        await writeFile(settingsPath, artifact.content, "utf8");
      });
      await recordActivationReceipt(storePath, { activation_id: artifact.activation_id, host: "claude", project_id: "moryn", event: "session_start", session_id: "session-1", device_id: "device-1", occurred_at: "2026-07-12T00:09:00.000Z", command_digest: artifact.command_digest });
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "claude", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "active", healthy: true, observed_events: ["session_start"], last_receipt: { event: "session_start" } });
    });
  });

  it("distinguishes generated, configured, and active Codex states", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      const artifact = buildHostIntegrationArtifact({ host: "codex", project_id: "moryn", project_path: projectPath, store_path: storePath });
      await writeHostIntegrationArtifact({ host: "codex", project_id: "moryn", project_path: projectPath, store_path: storePath });
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "codex", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "generated_not_activated", repairable_automatically: true });
      await activateCodexHooks({ project_path: projectPath, artifact });
      const configured = await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "codex", now: "2026-07-12T00:10:00.000Z" });
      expect(configured).toMatchObject({ status: "configured_unverified", healthy: true, configured_events: artifact.expected_events });
      expect(configured.suggested_actions[0]).toMatchObject({ id: "trust_codex_hooks", safe_to_run: false, command: "/hooks" });

      await recordActivationReceipt(storePath, { activation_id: artifact.activation_id, host: "codex", project_id: "moryn", event: "session_start", session_id: "session-1", device_id: "device-1", occurred_at: "2026-07-12T00:09:00.000Z", command_digest: artifact.command_digest });
      expect(await inspectHostActivation({ store_path: storePath, project_path: projectPath, project_id: "moryn", host: "codex", now: "2026-07-12T00:10:00.000Z" })).toMatchObject({ status: "active", healthy: true });
    });
  });
});
