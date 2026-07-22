import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activateClaudeSettings, mergeClaudeSettings } from "../../src/core/claude-activation.js";
import { buildHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

const artifact = buildHostIntegrationArtifact({
  host: "claude",
  project_id: "moryn",
  project_path: "/repo",
  store_path: "/store"
});

function morynEntry(command: string) {
  return { matcher: "", hooks: [{ type: "command", command }] };
}

describe("Claude activation merge", () => {
  it("creates hooks in an absent settings document", () => {
    const result = mergeClaudeSettings(undefined, artifact);

    expect(result.changed).toBe(true);
    expect(result.changed_events).toEqual(artifact.expected_events);
    expect(result.settings).toEqual(JSON.parse(artifact.content));
    expect(result.owned_entries_removed).toBe(0);
  });

  it("preserves unrelated settings and hook order while replacing owned entries", () => {
    const staleCommand = artifact.command.replace("/store", "/old-store");
    const userEntry = { matcher: "*.ts", hooks: [{ type: "command", command: "echo user-hook" }] };
    const current = {
      permissions: { allow: ["Read"] },
      env: { USER_SETTING: "yes" },
      hooks: {
        SessionStart: [userEntry, morynEntry(staleCommand), morynEntry(artifact.command)],
        CustomEvent: [userEntry]
      }
    };

    const result = mergeClaudeSettings(current, artifact);

    expect(result.changed).toBe(true);
    expect(result.settings.permissions).toEqual({ allow: ["Read"] });
    expect(result.settings.env).toEqual({ USER_SETTING: "yes" });
    expect(result.settings.hooks.CustomEvent).toEqual([userEntry]);
    expect(result.settings.hooks.SessionStart).toEqual([userEntry, morynEntry(artifact.command)]);
    expect(result.owned_entries_removed).toBe(2);
    for (const event of artifact.expected_events) {
      expect(
        result.settings.hooks[event].filter((entry: unknown) => JSON.stringify(entry).includes(artifact.activation_id))
      ).toHaveLength(1);
    }
  });

  it("is idempotent for the current semantic settings", () => {
    const current = JSON.parse(artifact.content);
    const result = mergeClaudeSettings(current, artifact);

    expect(result.changed).toBe(false);
    expect(result.changed_events).toEqual([]);
    expect(result.settings).toEqual(current);
  });

  it.each([
    ["non-object root", []],
    ["non-object hooks", { hooks: [] }],
    ["non-array event", { hooks: { SessionStart: {} } }],
    ["non-object hook entry", { hooks: { SessionStart: ["bad"] } }]
  ])("rejects %s without a write plan", (_label, current) => {
    expect(() => mergeClaudeSettings(current, artifact)).toThrow(/Invalid Claude settings/);
  });
});

describe("Claude activation files", () => {
  it("atomically activates settings with one content-addressed backup", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const target = join(claudeDir, "settings.local.json");
      await mkdir(claudeDir, { recursive: true });
      const existing = `${JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2)}\n`;
      await writeFile(target, existing, "utf8");

      const first = await activateClaudeSettings({ project_path: projectPath, artifact });
      const second = await activateClaudeSettings({ project_path: projectPath, artifact });

      expect(first).toMatchObject({ changed: true, created: false, backup_created: true, target_path: target });
      expect(first.backup_path).toMatch(/\.claude\/\.moryn-backups\/settings\.local\.[a-f0-9]{16}\.json$/);
      expect(await readFile(first.backup_path!, "utf8")).toBe(existing);
      expect(JSON.parse(await readFile(target, "utf8")).permissions).toEqual({ allow: ["Read"] });
      expect(second).toMatchObject({ changed: false, backup_created: false, target_path: target });
      expect(second.backup_path).toBeUndefined();
    });
  });

  it("creates an absent settings file without a backup", async () => {
    await withTempStore(async (projectPath) => {
      const result = await activateClaudeSettings({ project_path: projectPath, artifact });
      expect(result).toMatchObject({ changed: true, created: true, backup_created: false });
      expect(JSON.parse(await readFile(result.target_path, "utf8"))).toEqual(JSON.parse(artifact.content));
    });
  });

  it("rejects symlink targets without modifying their destination", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const destination = join(projectPath, "outside.json");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(destination, '{"safe":true}\n', "utf8");
      await symlink(destination, join(claudeDir, "settings.local.json"));

      await expect(activateClaudeSettings({ project_path: projectPath, artifact })).rejects.toThrow(/symbolic link/);
      expect(await readFile(destination, "utf8")).toBe('{"safe":true}\n');
    });
  });

  it("rejects an artifact merge target that escapes the project", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const outside = join(root, "outside.json");
      await mkdir(projectPath, { recursive: true });
      await writeFile(outside, '{"safe":true}\n', "utf8");

      await expect(
        activateClaudeSettings({
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
      const outside = join(root, "outside-claude");
      await mkdir(projectPath, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "settings.local.json"), '{"safe":true}\n', "utf8");
      await symlink(outside, join(projectPath, ".claude"), "dir");

      await expect(activateClaudeSettings({ project_path: projectPath, artifact })).rejects.toThrow(/symbolic link/);
      await expect(readFile(join(outside, "settings.local.json"), "utf8")).resolves.toBe('{"safe":true}\n');
    });

    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const outside = join(projectPath, "outside-backups");
      const target = join(claudeDir, "settings.local.json");
      const original = '{"hooks":{}}\n';
      await mkdir(claudeDir, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(target, original, "utf8");
      await symlink(outside, join(claudeDir, ".moryn-backups"), "dir");

      await expect(activateClaudeSettings({ project_path: projectPath, artifact })).rejects.toThrow(/symbolic link/);
      await expect(readFile(target, "utf8")).resolves.toBe(original);
      await expect(readdir(outside)).resolves.toEqual([]);
    });
  });

  it("preserves invalid JSON without creating a backup", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const target = join(claudeDir, "settings.local.json");
      await mkdir(claudeDir, { recursive: true });
      await writeFile(target, '{"hooks":', "utf8");

      await expect(activateClaudeSettings({ project_path: projectPath, artifact })).rejects.toThrow(
        /Invalid Claude settings JSON/
      );
      expect(await readFile(target, "utf8")).toBe('{"hooks":');
    });
  });

  it("aborts before modification when an existing backup is incompatible", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const target = join(claudeDir, "settings.local.json");
      const existing = '{"permissions":{"allow":["Read"]}}\n';
      const previousDigest = createHash("sha256").update(existing).digest("hex");
      const backupPath = join(claudeDir, ".moryn-backups", `settings.local.${previousDigest.slice(0, 16)}.json`);
      await mkdir(backupPath, { recursive: true });
      await writeFile(target, existing, "utf8");

      await expect(activateClaudeSettings({ project_path: projectPath, artifact })).rejects.toThrow(/backup/);
      expect(await readFile(target, "utf8")).toBe(existing);
    });
  });

  it("preserves the original when temporary creation fails", async () => {
    await withTempStore(async (projectPath) => {
      const claudeDir = join(projectPath, ".claude");
      const target = join(claudeDir, "settings.local.json");
      const existing = '{"permissions":{"allow":["Read"]}}\n';
      await mkdir(claudeDir, { recursive: true });
      await writeFile(target, existing, "utf8");
      const merged = mergeClaudeSettings(JSON.parse(existing), artifact);
      const newText = `${JSON.stringify(merged.settings, null, 2)}\n`;
      const newDigest = createHash("sha256").update(newText).digest("hex");
      const temporaryPath = join(claudeDir, `.settings.local.moryn-${process.pid}-${newDigest.slice(0, 12)}.tmp`);
      await writeFile(temporaryPath, "occupied", "utf8");

      await expect(activateClaudeSettings({ project_path: projectPath, artifact })).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe(existing);
    });
  });
});
