import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHostIntegrationArtifact, writeHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("host integration artifacts", () => {
  it("builds a Codex lifecycle hooks TOML fragment", () => {
    const artifact = buildHostIntegrationArtifact({ host: "codex", project_path: "/repo", store_path: "/store" });
    expect(artifact.path).toBe(".codex/moryn-hooks.toml");
    expect(artifact.content).toContain("SessionStart");
    expect(artifact.content).toContain("PreCompact");
    expect(artifact.content).toContain("PostCompact");
    expect(artifact.content).toContain("host hook --host codex");
    expect(artifact.content).toContain("--store '/store'");
  });

  it("builds Claude Code project-local settings with lifecycle hooks", () => {
    const artifact = buildHostIntegrationArtifact({ host: "claude-code", project_path: "/repo", store_path: "/store" });
    expect(artifact.path).toBe(".claude/moryn-settings.json");
    const parsed = JSON.parse(artifact.content);
    expect(Object.keys(parsed.hooks)).toEqual(["SessionStart", "PreCompact", "PostCompact", "Stop", "SessionEnd"]);
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("host hook --host claude");
  });

  it("writes artifacts idempotently and preserves unrelated project files", async () => {
    await withTempStore(async (projectPath) => {
      const first = await writeHostIntegrationArtifact({ host: "claude", project_path: projectPath, store_path: "/store" });
      const second = await writeHostIntegrationArtifact({ host: "claude", project_path: projectPath, store_path: "/store" });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await readFile(join(projectPath, ".claude", "moryn-settings.json"), "utf8")).toBe(first.artifact.content);
    });
  });
});
