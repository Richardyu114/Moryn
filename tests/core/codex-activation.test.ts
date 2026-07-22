import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateCodexHooks, mergeCodexHooks } from "../../src/core/codex-activation.js";
import { buildHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

const artifact = buildHostIntegrationArtifact({
  host: "codex",
  project_id: "moryn",
  project_path: "/repo",
  store_path: "/store"
});

describe("Codex hook activation", () => {
  it("preserves unrelated hooks and replaces only Moryn-owned entries", () => {
    const current = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo user" }] },
          { hooks: [{ type: "command", command: "moryn old --activation-id moryn-v03-moryn-codex" }] }
        ],
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo prompt" }] }]
      }
    };
    const result = mergeCodexHooks(current, artifact);
    expect(result.owned_entries_removed).toBe(1);
    expect(result.settings.hooks.SessionStart).toHaveLength(2);
    expect(result.settings.hooks.SessionStart[0].hooks[0].command).toBe("echo user");
    expect(result.settings.hooks.UserPromptSubmit).toHaveLength(2);
    expect(result.settings.hooks.UserPromptSubmit[0]).toEqual(current.hooks.UserPromptSubmit[0]);
    expect(result.settings.hooks.UserPromptSubmit[1].hooks[0].command).toContain("host hook --host codex");
  });

  it("atomically activates hooks and is idempotent", async () => {
    await withTempStore(async (projectPath) => {
      const target = join(projectPath, ".codex", "hooks.json");
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      const existing = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2)}\n`;
      await writeFile(target, existing, "utf8");
      const first = await activateCodexHooks({ project_path: projectPath, artifact });
      const second = await activateCodexHooks({ project_path: projectPath, artifact });
      expect(first).toMatchObject({ changed: true, created: false, backup_created: true, target_path: target });
      expect(await readFile(first.backup_path!, "utf8")).toBe(existing);
      expect(JSON.parse(await readFile(target, "utf8")).hooks.SessionStart).toHaveLength(2);
      expect(second).toMatchObject({ changed: false, backup_created: false });
    });
  });

  it("rejects unsafe targets without modifying them", async () => {
    await withTempStore(async (projectPath) => {
      const codexDir = join(projectPath, ".codex");
      const destination = join(projectPath, "outside.json");
      await mkdir(codexDir, { recursive: true });
      await writeFile(destination, '{"safe":true}\n', "utf8");
      await symlink(destination, join(codexDir, "hooks.json"));
      await expect(activateCodexHooks({ project_path: projectPath, artifact })).rejects.toThrow(/symbolic link/);
      expect(await readFile(destination, "utf8")).toBe('{"safe":true}\n');
    });
    await withTempStore(async (projectPath) => {
      const target = join(projectPath, ".codex", "hooks.json");
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      await writeFile(target, '{"hooks":', "utf8");
      await expect(activateCodexHooks({ project_path: projectPath, artifact })).rejects.toThrow(
        /Invalid Codex hooks JSON/
      );
      expect(await readFile(target, "utf8")).toBe('{"hooks":');
    });
  });

  it("rejects an artifact merge target that escapes the project", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const outside = join(root, "outside.json");
      await mkdir(projectPath, { recursive: true });
      await writeFile(outside, '{"safe":true}\n', "utf8");

      await expect(
        activateCodexHooks({
          project_path: projectPath,
          artifact: { ...artifact, merge_target: "../outside.json" }
        })
      ).rejects.toThrow(/merge target/);
      await expect(readFile(outside, "utf8")).resolves.toBe('{"safe":true}\n');
    });
  });

  it("rejects symlinked project and backup directories without modifying outside files", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const outside = join(root, "outside-codex");
      await mkdir(projectPath, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "hooks.json"), '{"safe":true}\n', "utf8");
      await symlink(outside, join(projectPath, ".codex"), "dir");

      await expect(activateCodexHooks({ project_path: projectPath, artifact })).rejects.toThrow(/symbolic link/);
      await expect(readFile(join(outside, "hooks.json"), "utf8")).resolves.toBe('{"safe":true}\n');
    });

    await withTempStore(async (projectPath) => {
      const codexDir = join(projectPath, ".codex");
      const outside = join(projectPath, "outside-backups");
      const target = join(codexDir, "hooks.json");
      const original = '{"hooks":{}}\n';
      await mkdir(codexDir, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(target, original, "utf8");
      await symlink(outside, join(codexDir, ".moryn-backups"), "dir");

      await expect(activateCodexHooks({ project_path: projectPath, artifact })).rejects.toThrow(/symbolic link/);
      await expect(readFile(target, "utf8")).resolves.toBe(original);
      await expect(readdir(outside)).resolves.toEqual([]);
    });
  });

  it("allows the project path itself to be a symlink", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "real-project");
      const alias = join(root, "project-alias");
      await mkdir(projectPath, { recursive: true });
      await symlink(projectPath, alias, "dir");

      const result = await activateCodexHooks({ project_path: alias, artifact });

      expect(result.target_path).toBe(join(projectPath, ".codex", "hooks.json"));
      await expect(readFile(result.target_path, "utf8")).resolves.toContain("host hook --host codex");
    });
  });
});
