import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activationId, buildHostIntegrationArtifact, writeHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("host integration artifacts", () => {
  it("builds deterministic activation identities from project and host", () => {
    expect(activationId("Moryn Project", "claude-code")).toBe("moryn-v03-moryn-project-claude");
    expect(activationId("Moryn Project", "codex-cli")).toBe("moryn-v03-moryn-project-codex");
  });

  it("builds a Codex lifecycle hooks JSON fragment", () => {
    const artifact = buildHostIntegrationArtifact({ host: "codex", project_id: "moryn", project_path: "/repo", store_path: "/store" });
    expect(artifact.path).toBe(".codex/moryn-hooks.json");
    expect(artifact.format).toBe("json");
    expect(artifact.merge_target).toBe(".codex/hooks.json");
    expect(JSON.parse(artifact.content).hooks).toMatchObject({
      SessionStart: expect.any(Array),
      PreCompact: expect.any(Array),
      PostCompact: expect.any(Array),
      Stop: expect.any(Array)
    });
    expect(artifact.content).toContain("SessionStart");
    expect(artifact.content).toContain("PreCompact");
    expect(artifact.content).toContain("PostCompact");
    expect(artifact.content).toContain("host hook --host codex");
    expect(artifact.content).toContain("--store '/store'");
    expect(artifact.content).toContain("--activation-id moryn-v03-moryn-codex");
    expect(artifact.content).not.toContain("MORYN_DEVICE_ID");
    expect(artifact.content).not.toContain("--device-id");
    expect(artifact.content).not.toContain("dangerously-bypass-hook-trust");
    expect(artifact.activation_id).toBe("moryn-v03-moryn-codex");
    expect(artifact.expected_events).toEqual(["SessionStart", "PreCompact", "PostCompact", "Stop"]);
    expect(artifact.command_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds Claude Code project-local settings with lifecycle hooks", () => {
    const artifact = buildHostIntegrationArtifact({ host: "claude-code", project_id: "moryn", project_path: "/repo", store_path: "/store" });
    expect(artifact.path).toBe(".claude/moryn-settings.json");
    const parsed = JSON.parse(artifact.content);
    expect(Object.keys(parsed.hooks)).toEqual(["SessionStart", "PreCompact", "PostCompact", "Stop", "SessionEnd"]);
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("host hook --host claude");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("--activation-id moryn-v03-moryn-claude");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).not.toContain("MORYN_DEVICE_ID");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).not.toContain("--device-id");
    expect(artifact.expected_events).toEqual(["SessionStart", "PreCompact", "PostCompact", "Stop", "SessionEnd"]);
  });

  it("writes artifacts idempotently and preserves unrelated project files", async () => {
    await withTempStore(async (projectPath) => {
      const first = await writeHostIntegrationArtifact({ host: "claude", project_id: "moryn", project_path: projectPath, store_path: "/store" });
      const second = await writeHostIntegrationArtifact({ host: "claude", project_id: "moryn", project_path: projectPath, store_path: "/store" });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await readFile(join(projectPath, ".claude", "moryn-settings.json"), "utf8")).toBe(first.artifact.content);
    });
  });
});
