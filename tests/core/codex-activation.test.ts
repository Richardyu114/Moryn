import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { activateCodexHooks, mergeCodexHooks } from "../../src/core/codex-activation.js";
import { buildHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

const artifact = buildHostIntegrationArtifact({
  host: "codex",
  project_id: "moryn",
  project_path: "/repo",
  store_path: "/store"
});

function rewriteMorynCommand(command: string, rewriteBase: (base: string) => string): string {
  const marker = " --command-digest ";
  const markerIndex = command.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("test command is missing its digest");
  const base = rewriteBase(command.slice(0, markerIndex));
  return `${base}${marker}${createHash("sha256").update(base).digest("hex")}`;
}

describe("Codex hook activation", () => {
  it("preserves unrelated hooks and replaces only Moryn-owned entries", () => {
    const current = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo user" }] },
          {
            hooks: [
              {
                type: "command",
                command: rewriteMorynCommand(artifact.command, (base) =>
                  base.replace("--store '/store'", "--store '/old'")
                )
              }
            ]
          }
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

  it("removes official Moryn handlers from obsolete events while preserving user handlers", () => {
    const current = {
      hooks: {
        LegacyLifecycleEvent: [
          {
            matcher: "keep-entry-metadata",
            hooks: [
              { type: "command", command: artifact.command },
              { type: "command", command: "echo user legacy handler" }
            ]
          },
          { hooks: [{ type: "command", command: artifact.command }] }
        ],
        UserEvent: [{ hooks: [{ type: "command", command: "echo user event" }] }]
      }
    };

    const result = mergeCodexHooks(current, artifact);

    expect(result.owned_entries_removed).toBe(2);
    expect(result.changed_events).toContain("LegacyLifecycleEvent");
    expect(result.settings.hooks.LegacyLifecycleEvent).toEqual([
      {
        matcher: "keep-entry-metadata",
        hooks: [{ type: "command", command: "echo user legacy handler" }]
      }
    ]);
    expect(result.settings.hooks.UserEvent).toEqual(current.hooks.UserEvent);
  });

  it("removes stale and mis-scoped official Moryn identities without touching lookalike user hooks", () => {
    const staleSameProject = rewriteMorynCommand(artifact.command, (base) =>
      base
        .replace("--store '/store'", "--store '/old-store'")
        .replace(artifact.activation_id, "moryn-v03-old-project-codex")
    );
    const otherProject = rewriteMorynCommand(staleSameProject, (base) =>
      base.replace("--project '/repo'", "--project '/other-repo'")
    );
    const directRuntime = rewriteMorynCommand(staleSameProject, (base) =>
      base.replace(/^moryn/u, "'/runtime/node' '--import' 'tsx' '/runtime/moryn/src/cli.ts'")
    );
    const lookalikeCurrentId = `echo prefix ${artifact.activation_id} suffix`;
    const lookalikeLegacy = "echo host hook --host codex --project '/repo' --activation-id moryn-v03-old-codex";
    const newlineCompound = rewriteMorynCommand(artifact.command, (base) => base.replace(" host hook", "\nhost hook"));
    const doubleQuotedBase = `"/opt/node" "/runtime/moryn/dist/cli.js" --store "/store" host hook --host codex --project "/repo" --activation-id moryn-v03-old-codex --host-output`;
    const doubleQuoted = `${doubleQuotedBase} --command-digest ${createHash("sha256").update(doubleQuotedBase).digest("hex")}`;
    const current = {
      hooks: {
        SessionStart: [
          {
            matcher: "official-first",
            hooks: [
              { type: "command", command: staleSameProject },
              { type: "command", command: "echo mixed first" }
            ]
          },
          {
            matcher: "official-last",
            hooks: [
              { type: "command", command: "echo mixed last" },
              { type: "command", command: otherProject }
            ]
          },
          { hooks: [{ type: "command", command: directRuntime }] },
          { hooks: [{ type: "command", command: lookalikeCurrentId }] },
          { hooks: [{ type: "command", command: lookalikeLegacy }] },
          { hooks: [{ type: "command", command: newlineCompound }] },
          { hooks: [{ type: "command", command: doubleQuoted }] },
          { hooks: [{ type: "prompt", command: artifact.command, prompt: "Keep this user handler" }] },
          { hooks: [{ type: "command", command: "echo user" }] }
        ]
      }
    };

    const result = mergeCodexHooks(current, artifact);

    expect(result.owned_entries_removed).toBe(3);
    expect(result.settings.hooks.SessionStart.map((entry: any) => entry.hooks[0].command)).toEqual([
      "echo mixed first",
      "echo mixed last",
      lookalikeCurrentId,
      lookalikeLegacy,
      newlineCompound,
      doubleQuoted,
      artifact.command,
      "echo user",
      artifact.command
    ]);
    expect(result.settings.hooks.SessionStart.slice(0, 2).map((entry: any) => entry.matcher)).toEqual([
      "official-first",
      "official-last"
    ]);
    expect(result.settings.hooks.SessionStart.at(-3).hooks[0]).toMatchObject({
      type: "prompt",
      prompt: "Keep this user handler"
    });
  });

  it("recognizes self-consistent official commands across path spellings and operating systems", () => {
    const markerArtifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "marker-project",
      project_path: "/repo --command-digest literal",
      store_path: "/store --command-digest literal"
    });
    expect(mergeCodexHooks(JSON.parse(markerArtifact.content), markerArtifact).changed).toBe(false);

    const windowsBase =
      "'C:\\Program Files\\nodejs\\node.exe' 'C:\\Moryn\\dist\\cli.js' --store 'C:\\store' host hook --host codex --project 'C:\\repo' --activation-id moryn-v03-old-codex --host-output";
    const windowsCommand = `${windowsBase} --command-digest ${createHash("sha256").update(windowsBase).digest("hex")}`;
    const migrated = mergeCodexHooks(
      { hooks: { SessionStart: [{ hooks: [{ type: "command", command: windowsCommand }] }] } },
      artifact
    );
    expect(migrated.owned_entries_removed).toBe(1);
    expect(migrated.settings.hooks.SessionStart).toEqual(JSON.parse(artifact.content).hooks.SessionStart);
  });

  it("migrates a v03 launcher under an arbitrary root to one idempotent custom-root hook", () => {
    const currentArtifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        runtime_binding_root: "/arbitrary/current-launchers"
      }
    });
    const legacyCommand = rewriteMorynCommand(currentArtifact.command, (base) =>
      base
        .replace(
          `'/bin/sh' '${currentArtifact.runtime_binding!.path}'`,
          "'/bin/sh' '/arbitrary/legacy-launchers/moryn-v03-old-project-codex.sh'"
        )
        .replace(currentArtifact.activation_id, "moryn-v03-old-project-codex")
    );

    const migrated = mergeCodexHooks(
      { hooks: { SessionStart: [{ hooks: [{ type: "command", command: legacyCommand }] }] } },
      currentArtifact
    );
    expect(migrated.owned_entries_removed).toBe(1);
    expect(migrated.settings.hooks.SessionStart).toEqual(JSON.parse(currentArtifact.content).hooks.SessionStart);
    const repeated = mergeCodexHooks(migrated.settings, currentArtifact);
    expect(repeated.changed).toBe(false);
    for (const event of currentArtifact.expected_events) {
      expect(repeated.settings.hooks[event]).toHaveLength(1);
    }
  });

  it("atomically activates hooks and is idempotent", async () => {
    await withTempStore(async (projectPath) => {
      const target = join(projectPath, ".codex", "hooks.json");
      await mkdir(join(projectPath, ".codex"), { recursive: true });
      const existing = `${JSON.stringify({ env: { API_TOKEN: "private-codex-token" }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo user" }] }] } }, null, 2)}\n`;
      await writeFile(target, existing, "utf8");
      await chmod(target, 0o600);
      const backupRoot = join(projectPath, "external-backups");
      const first = await activateCodexHooks({ project_path: projectPath, artifact, backup_root: backupRoot });
      const second = await activateCodexHooks({ project_path: projectPath, artifact, backup_root: backupRoot });
      expect(first).toMatchObject({ changed: true, created: false, backup_created: true, target_path: target });
      expect(await readFile(first.backup_path!, "utf8")).toBe(existing);
      expect(first.backup_path?.startsWith(`${backupRoot}/`)).toBe(true);
      expect((await stat(backupRoot)).mode & 0o777).toBe(0o700);
      expect((await stat(first.backup_path!)).mode & 0o777).toBe(0o600);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(target, "utf8")).hooks.SessionStart).toHaveLength(2);
      expect(second).toMatchObject({ changed: false, backup_created: false });
    });
  });

  it("hardens and Git-ignores legacy backups even when activation is a no-op", async () => {
    await withTempStore(async (projectPath) => {
      const codexDir = join(projectPath, ".codex");
      const backupDir = join(codexDir, ".moryn-backups");
      const backupPath = join(backupDir, "hooks.0123456789abcdef.json");
      const target = join(codexDir, "hooks.json");
      await mkdir(backupDir, { recursive: true });
      await writeFile(target, artifact.content, "utf8");
      await writeFile(backupPath, '{"API_TOKEN":"legacy-secret"}\n', "utf8");
      await chmod(backupDir, 0o755);
      await chmod(backupPath, 0o644);

      const result = await activateCodexHooks({
        project_path: projectPath,
        artifact,
        backup_root: join(projectPath, "external-backups")
      });

      expect(result.changed).toBe(false);
      expect((await stat(backupDir)).mode & 0o777).toBe(0o700);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(join(backupDir, ".gitignore"), "utf8")).toBe("*\n");
      expect((await stat(join(backupDir, ".gitignore"))).mode & 0o777).toBe(0o600);
      expect(await readFile(backupPath, "utf8")).toBe('{"API_TOKEN":"legacy-secret"}\n');
    });
  });

  it("keeps migrated and new secret backups out of a Git checkout", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const codexDir = join(projectPath, ".codex");
      const legacyDir = join(codexDir, ".moryn-backups");
      const legacyPath = join(legacyDir, "hooks.0123456789abcdef.json");
      const target = join(codexDir, "hooks.json");
      await mkdir(legacyDir, { recursive: true });
      await exec("git", ["init", "--quiet", projectPath]);
      await writeFile(join(projectPath, ".gitignore"), "/.codex/hooks.json\n", "utf8");
      const existing = '{"env":{"API_TOKEN":"new-secret"},"hooks":{}}\n';
      await writeFile(target, existing, "utf8");
      await writeFile(legacyPath, '{"API_TOKEN":"legacy-secret"}\n', "utf8");
      const localArtifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime: {
          exec_file: "/runtime/node",
          cli_entry: "/runtime/moryn/dist/cli.js",
          runtime_binding_root: join(root, "runtime-bindings")
        }
      });

      const first = await activateCodexHooks({ project_path: projectPath, artifact: localArtifact });
      expect(relative(projectPath, first.backup_path!).startsWith("..")).toBe(true);
      expect(await readFile(first.backup_path!, "utf8")).toBe(existing);
      await expect(exec("git", ["-C", projectPath, "check-ignore", legacyPath])).resolves.toBeDefined();
      const status = await exec("git", ["-C", projectPath, "status", "--porcelain", "--untracked-files=all"]);
      expect(status.stdout).not.toContain(".moryn-backups");
      expect(status.stdout).not.toContain("runtime-bindings");

      const externalBackupDir = dirname(first.backup_path!);
      const externalScopeDir = dirname(externalBackupDir);
      const externalBindingRoot = dirname(externalScopeDir);
      await chmod(externalBindingRoot, 0o755);
      await chmod(externalScopeDir, 0o755);
      await chmod(externalBackupDir, 0o755);
      await chmod(first.backup_path!, 0o644);
      const second = await activateCodexHooks({ project_path: projectPath, artifact: localArtifact });
      expect(second.changed).toBe(false);
      for (const directory of [externalBindingRoot, externalScopeDir, externalBackupDir]) {
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
      }
      expect((await stat(first.backup_path!)).mode & 0o777).toBe(0o600);
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
