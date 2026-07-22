import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activationId,
  buildHostIntegrationArtifact,
  writeHostIntegrationArtifact
} from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("host integration artifacts", () => {
  it("builds deterministic activation identities from project and host", () => {
    expect(activationId("Moryn Project", "claude-code")).toBe("moryn-v03-moryn-project-claude");
    expect(activationId("Moryn Project", "codex-cli")).toBe("moryn-v03-moryn-project-codex");
  });

  it("builds a Codex lifecycle hooks JSON fragment", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: { exec_file: "/runtime/node", cli_entry: "/runtime/moryn/dist/cli.js", package_version: "0.3.0" }
    });
    expect(artifact.path).toBe(".codex/moryn-hooks.json");
    expect(artifact.format).toBe("json");
    expect(artifact.merge_target).toBe(".codex/hooks.json");
    expect(JSON.parse(artifact.content).hooks).toMatchObject({
      SessionStart: expect.any(Array),
      UserPromptSubmit: expect.any(Array),
      PreCompact: expect.any(Array),
      PostCompact: expect.any(Array),
      Stop: expect.any(Array)
    });
    expect(artifact.content).toContain("SessionStart");
    expect(artifact.content).toContain("PreCompact");
    expect(artifact.content).toContain("PostCompact");
    expect(artifact.content).toContain("host hook --host codex");
    expect(artifact.command).toMatch(/^'\/runtime\/node' '\/runtime\/moryn\/dist\/cli\.js' --store/);
    expect(artifact.command).not.toMatch(/(^|\s)moryn --store/);
    expect(artifact.content).toContain("--store '/store'");
    expect(artifact.content).toContain("--activation-id moryn-v03-moryn-codex");
    expect(artifact.content).toContain("--host-output");
    expect(artifact.command).toContain(`--command-digest ${artifact.command_digest}`);
    expect(artifact.content).not.toContain("MORYN_DEVICE_ID");
    expect(artifact.content).not.toContain("--device-id");
    expect(artifact.content).not.toContain("dangerously-bypass-hook-trust");
    expect(artifact.activation_id).toBe("moryn-v03-moryn-codex");
    expect(artifact.expected_events).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact", "Stop"]);
    expect(artifact.command_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds Claude Code project-local settings with lifecycle hooks", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "claude-code",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: { exec_file: "/runtime/node", cli_entry: "/runtime/moryn/dist/cli.js", package_version: "0.3.0" }
    });
    expect(artifact.path).toBe(".claude/moryn-settings.json");
    const parsed = JSON.parse(artifact.content);
    expect(Object.keys(parsed.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreCompact",
      "PostCompact",
      "Stop",
      "SessionEnd"
    ]);
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("host hook --host claude");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("--activation-id moryn-v03-moryn-claude");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("--host-output");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).not.toContain("MORYN_DEVICE_ID");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).not.toContain("--device-id");
    expect(artifact.expected_events).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreCompact",
      "PostCompact",
      "Stop",
      "SessionEnd"
    ]);
  });

  it("changes command identity when the activating CLI runtime changes", () => {
    const first = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: { exec_file: "/runtime/node", cli_entry: "/runtime/one/cli.js", package_version: "0.3.0" }
    });
    const second = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: { exec_file: "/runtime/node", cli_entry: "/runtime/two/cli.js", package_version: "0.3.0" }
    });
    expect(first.activation_id).toBe(second.activation_id);
    expect(first.command_digest).not.toBe(second.command_digest);
    expect(first.command).not.toBe(second.command);
  });

  it("preserves Node loader arguments for source-tree runtimes", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "claude",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: { exec_file: "/runtime/node", exec_args: ["--import", "tsx"], cli_entry: "/repo/src/cli.ts" }
    });
    expect(artifact.command).toMatch(/^'\/runtime\/node' '--import' 'tsx' '\/repo\/src\/cli\.ts' --store/);
  });

  it("writes artifacts idempotently and preserves unrelated project files", async () => {
    await withTempStore(async (projectPath) => {
      const first = await writeHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: "/store"
      });
      const second = await writeHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: "/store"
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(await readFile(join(projectPath, ".claude", "moryn-settings.json"), "utf8")).toBe(first.artifact.content);
    });
  });

  it("rejects symlinked fragment targets and parent directories", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const outside = join(projectPath, "outside.json");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(outside, '{"safe":true}\n', "utf8");
      await symlink(outside, join(claudeDir, "moryn-settings.json"));

      await expect(
        writeHostIntegrationArtifact({
          host: "claude",
          project_id: "moryn",
          project_path: projectPath,
          store_path: "/store"
        })
      ).rejects.toThrow(/symbolic link/);
      await expect(readFile(outside, "utf8")).resolves.toBe('{"safe":true}\n');
    });

    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const outside = join(root, "outside-claude");
      await mkdir(projectPath, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(projectPath, ".claude"), "dir");

      await expect(
        writeHostIntegrationArtifact({
          host: "claude",
          project_id: "moryn",
          project_path: projectPath,
          store_path: "/store"
        })
      ).rejects.toThrow(/symbolic link/);
      await expect(readFile(join(outside, "moryn-settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("replaces a hard-linked fragment without modifying the other link", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const outside = join(projectPath, "outside.json");
      const fragment = join(claudeDir, "moryn-settings.json");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(outside, '{"safe":true}\n', "utf8");
      await link(outside, fragment);

      const result = await writeHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: "/store"
      });

      await expect(readFile(outside, "utf8")).resolves.toBe('{"safe":true}\n');
      await expect(readFile(fragment, "utf8")).resolves.toBe(result.artifact.content);
    });
  });
});
