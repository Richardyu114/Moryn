import { execFile } from "node:child_process";
import { chmod, link, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  activationId,
  buildHostIntegrationArtifact,
  writeHostIntegrationArtifact
} from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

describe("host integration artifacts", () => {
  it("builds deterministic activation identities from project and host", () => {
    const claude = activationId("Moryn Project", "claude-code");
    const codex = activationId("Moryn Project", "codex-cli");
    expect(claude).toMatch(/^moryn-v04-moryn-project-[a-f0-9]{32}-claude$/);
    expect(codex).toBe(claude.replace(/-claude$/, "-codex"));
    expect(activationId("Moryn Project", "claude-code")).toBe(claude);
  });

  it("keeps lossy, case-only, and long-prefix project identities distinct", () => {
    const ids = [
      activationId("github.com/a/b-c", "codex"),
      activationId("github.com/a-b/c", "codex"),
      activationId("github.com/Owner/Repo", "codex"),
      activationId("github.com/owner/repo", "codex"),
      activationId(`${"same-prefix-".repeat(8)}left`, "codex"),
      activationId(`${"same-prefix-".repeat(8)}right`, "codex")
    ];
    expect(new Set(ids)).toHaveLength(ids.length);
  });

  it("embeds absolute persistent project and Store arguments", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "relative-paths",
      project_path: "relative-project",
      store_path: "relative-store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        runtime_binding_root: "/var/tmp/moryn-test-relative-bindings"
      }
    });

    expect(artifact.command).toContain(`--store '${join(process.cwd(), "relative-store")}'`);
    expect(artifact.command).toContain(`--project '${join(process.cwd(), "relative-project")}'`);
    expect(artifact.runtime_binding?.path.startsWith("/var/tmp/moryn-test-relative-bindings")).toBe(true);
    expect(basename(artifact.runtime_binding!.path)).toBe(`${artifact.activation_id}.sh`);
  });

  it("builds a Codex lifecycle hooks JSON fragment", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: "/runtime-bindings"
      }
    });
    expect(artifact.path).toBe(".codex/moryn-hooks.json");
    expect(artifact.format).toBe("json");
    expect(artifact.merge_target).toBe(".codex/hooks.json");
    expect(JSON.parse(artifact.content).hooks).toMatchObject({
      SessionStart: expect.any(Array),
      UserPromptSubmit: expect.any(Array),
      PreCompact: expect.any(Array),
      Stop: expect.any(Array)
    });
    expect(artifact.content).toContain("SessionStart");
    expect(artifact.content).toContain("PreCompact");
    expect(artifact.content).not.toContain("PostCompact");
    expect(artifact.content).toContain("host hook --host codex");
    expect(artifact.command).toContain(`'/bin/sh' '${artifact.runtime_binding!.path}' --store`);
    expect(artifact.command).not.toContain("/runtime/node");
    expect(artifact.command).not.toContain("/runtime/moryn/dist/cli.js");
    expect(artifact.command).not.toMatch(/(^|\s)moryn --store/);
    expect(artifact.content).toContain("--store '/store'");
    expect(artifact.content).toContain(`--activation-id ${artifact.activation_id}`);
    expect(artifact.content).toContain("--host-output");
    expect(artifact.command).toContain(`--command-digest ${artifact.command_digest}`);
    expect(artifact.content).not.toContain("MORYN_DEVICE_ID");
    expect(artifact.content).not.toContain("--device-id");
    expect(artifact.content).not.toContain("dangerously-bypass-hook-trust");
    expect(JSON.parse(artifact.content).hooks.Stop[0].hooks[0].timeout).toBe(30);
    expect(artifact.activation_id).toBe(activationId("moryn", "codex"));
    expect(artifact.expected_events).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"]);
    expect(artifact.command_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.runtime_binding).toMatchObject({ root_path: "/" });
    expect(artifact.runtime_binding?.path.startsWith("/runtime-bindings/")).toBe(true);
    expect(artifact.runtime_binding?.relative_path).toBe(relative("/", artifact.runtime_binding!.path));
    expect(basename(artifact.runtime_binding!.path)).toBe(`${artifact.activation_id}.sh`);
    expect(artifact.runtime_binding?.content).toContain("exec '/runtime/node' '/runtime/moryn/dist/cli.js' \"$@\"");
    expect(artifact.runtime_binding?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds Claude Code project-local settings with lifecycle hooks", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "claude-code",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: "/runtime-bindings"
      }
    });
    expect(artifact.path).toBe(".claude/moryn-settings.json");
    const parsed = JSON.parse(artifact.content);
    expect(Object.keys(parsed.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact", "Stop", "SessionEnd"]);
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("host hook --host claude");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain(`--activation-id ${artifact.activation_id}`);
    expect(parsed.hooks.PreCompact[0].hooks[0].command).toContain("--host-output");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).not.toContain("MORYN_DEVICE_ID");
    expect(parsed.hooks.PreCompact[0].hooks[0].command).not.toContain("--device-id");
    expect(parsed.hooks.PreCompact[0].hooks[0].timeout).toBe(30);
    expect(artifact.runtime_binding?.path.startsWith("/runtime-bindings/")).toBe(true);
    expect(basename(artifact.runtime_binding!.path)).toBe(`${artifact.activation_id}.sh`);
    expect(artifact.expected_events).toEqual(["SessionStart", "UserPromptSubmit", "PreCompact", "Stop", "SessionEnd"]);
  });

  it("keeps the trusted command stable while changing the runtime binding", () => {
    const first = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/one/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: "/runtime-bindings"
      }
    });
    const second = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/two/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: "/runtime-bindings"
      }
    });
    expect(first.activation_id).toBe(second.activation_id);
    expect(first.command_digest).toBe(second.command_digest);
    expect(first.command).toBe(second.command);
    expect(first.runtime_binding?.digest).not.toBe(second.runtime_binding?.digest);
    expect(first.runtime_binding?.content).not.toBe(second.runtime_binding?.content);
  });

  it("scopes runtime bindings by the full project and Store identity", () => {
    const build = (projectPath: string, storePath: string) =>
      buildHostIntegrationArtifact({
        host: "codex",
        project_id: "same-project-id",
        project_path: projectPath,
        store_path: storePath,
        runtime: {
          exec_file: "/runtime/node",
          cli_entry: "/runtime/moryn/dist/cli.js",
          runtime_binding_root: "/runtime-bindings"
        }
      }).runtime_binding!.path;

    const paths = [
      build("/projects/one", "/stores/one"),
      build("/projects/two", "/stores/one"),
      build("/projects/one", "/stores/two")
    ];
    expect(new Set(paths)).toHaveLength(paths.length);
  });

  it("keeps direct runtime invocation on Windows where the POSIX launcher is unavailable", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.4.0",
        platform: "win32"
      }
    });

    expect(artifact.runtime_binding).toBeUndefined();
    expect(artifact.command).toContain("'/runtime/node' '/runtime/moryn/dist/cli.js' --store '/store'");
    expect(artifact.command).not.toContain("'/bin/sh'");
  });

  it("preserves Node loader arguments for source-tree runtimes", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "claude",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        exec_args: ["--import", "tsx"],
        cli_entry: "/repo/src/cli.ts",
        runtime_binding_root: "/runtime-bindings"
      }
    });
    expect(artifact.command).not.toContain("--import");
    expect(artifact.runtime_binding?.content).toContain(
      "exec '/runtime/node' '--import' 'tsx' '/repo/src/cli.ts' \"$@\""
    );
  });

  it("rejects PATH-relative runtime executables and CLI entries", () => {
    expect(() =>
      buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: "/repo",
        store_path: "/store",
        runtime: {
          exec_file: "node",
          cli_entry: "/runtime/moryn/dist/cli.js",
          runtime_binding_root: "/runtime-bindings"
        }
      })
    ).toThrow(/exec_file must be an absolute path/);
    expect(() =>
      buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: "/repo",
        store_path: "/store",
        runtime: { exec_file: "/runtime/node", cli_entry: "moryn", runtime_binding_root: "/runtime-bindings" }
      })
    ).toThrow(/cli_entry must be an absolute path/);
  });

  it("hashes package version metadata instead of interpolating it into the launcher", () => {
    const artifact = buildHostIntegrationArtifact({
      host: "codex",
      project_id: "moryn",
      project_path: "/repo",
      store_path: "/store",
      runtime: {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.4.0\nprintf injected",
        runtime_binding_root: "/runtime-bindings"
      }
    });
    expect(artifact.runtime_binding?.content).toMatch(/# moryn-package-version-sha256: [a-f0-9]{16}\n/);
    expect(artifact.runtime_binding?.content).not.toContain("printf injected");
  });

  it("preserves the per-user binding root name when a Store is inside a Git worktree", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const storePath = join(projectPath, "store");
      await mkdir(storePath, { recursive: true });
      await exec("git", ["init", "--quiet", projectPath]);

      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: storePath,
        runtime: { exec_file: "/runtime/node", cli_entry: "/runtime/moryn/dist/cli.js" }
      });

      const bindingPath = artifact.runtime_binding!.path;
      expect(relative(projectPath, bindingPath).startsWith("..")).toBe(true);
      expect(basename(dirname(dirname(bindingPath)))).toMatch(/^\.moryn-host-runtime-bindings-(?:\d+|[a-f0-9]{16})$/);
    });
  });

  it("uses an existing default binding root only when it is private and usable", async () => {
    await withTempStore(async (root) => {
      const storePath = join(root, "store");
      await mkdir(storePath);
      if (typeof process.getuid !== "function") return;
      const userKey = String(process.getuid());
      const candidate = join(root, `.moryn-host-runtime-bindings-${userKey}`);
      await mkdir(candidate);
      await chmod(candidate, 0o777);

      const build = () =>
        buildHostIntegrationArtifact({
          host: "codex",
          project_id: "moryn",
          project_path: storePath,
          store_path: storePath,
          runtime: { exec_file: "/runtime/node", cli_entry: "/runtime/moryn/dist/cli.js" }
        }).runtime_binding!.path;

      expect(build().startsWith(`${candidate}/`)).toBe(false);
      await chmod(candidate, 0o700);
      expect(build().startsWith(`${candidate}/`)).toBe(true);
    });
  });

  it("rejects a custom binding root that resolves into a Git worktree subdirectory", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const worktreeSubdirectory = join(projectPath, "generated");
      const bindingLink = join(root, "binding-link");
      await mkdir(worktreeSubdirectory, { recursive: true });
      await exec("git", ["init", "--quiet", projectPath]);
      await symlink(worktreeSubdirectory, bindingLink, "dir");

      expect(() =>
        buildHostIntegrationArtifact({
          host: "codex",
          project_id: "moryn",
          project_path: projectPath,
          store_path: projectPath,
          runtime: {
            exec_file: "/runtime/node",
            cli_entry: "/runtime/moryn/dist/cli.js",
            runtime_binding_root: join(bindingLink, "new-bindings")
          }
        })
      ).toThrow(/outside Git worktrees/);
    });
  });

  it("keeps the trusted launcher outside a checkout that tracks the legacy path", async () => {
    await withTempStore(async (root) => {
      const projectPath = join(root, "project");
      const bindingRoot = join(root, "arbitrary-device-launchers");
      await mkdir(projectPath);
      await exec("git", ["init", "--quiet", "--initial-branch=main", projectPath]);
      await writeFile(join(projectPath, "README.md"), "base\n", "utf8");
      await exec("git", ["-C", projectPath, "add", "README.md"]);
      await exec("git", [
        "-C",
        projectPath,
        "-c",
        "user.name=Moryn Test",
        "-c",
        "user.email=moryn@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "base"
      ]);

      const written = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime: {
          exec_file: "/runtime/node",
          cli_entry: "/runtime/moryn/dist/cli.js",
          runtime_binding_root: bindingRoot
        }
      });
      const trustedPath = written.artifact.runtime_binding!.path;
      const trustedContent = await readFile(trustedPath, "utf8");
      expect(relative(projectPath, trustedPath).startsWith("..")).toBe(true);

      await exec("git", ["-C", projectPath, "checkout", "--quiet", "-b", "attack"]);
      const legacyPath = join(projectPath, ".moryn", "host-runtime-bindings", "moryn-v03-moryn-codex.sh");
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, "#!/bin/sh\nprintf compromised\n", "utf8");
      await exec("git", ["-C", projectPath, "add", "--force", relative(projectPath, legacyPath)]);
      await exec("git", [
        "-C",
        projectPath,
        "-c",
        "user.name=Moryn Test",
        "-c",
        "user.email=moryn@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "track legacy launcher"
      ]);
      await exec("git", ["-C", projectPath, "checkout", "--quiet", "main"]);
      await exec("git", ["-C", projectPath, "checkout", "--quiet", "attack"]);

      expect(await readFile(trustedPath, "utf8")).toBe(trustedContent);
      expect(await readFile(legacyPath, "utf8")).toContain("compromised");
    });
  });

  it("writes artifacts and runtime bindings idempotently while preserving unrelated project files", async () => {
    await withTempStore(async (projectPath) => {
      const runtime = {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0",
        runtime_binding_root: join(projectPath, "arbitrary-device-launchers")
      };
      const first = await writeHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime
      });
      const second = await writeHostIntegrationArtifact({
        host: "claude",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(first.runtime_binding).toMatchObject({ created: true, updated: false });
      expect(second.runtime_binding).toMatchObject({ created: false, updated: false });
      expect((await stat(first.artifact.runtime_binding!.path)).mode & 0o777).toBe(0o700);
      expect(await readFile(join(projectPath, ".claude", "moryn-settings.json"), "utf8")).toBe(first.artifact.content);
      expect(await readFile(first.artifact.runtime_binding!.path, "utf8")).toBe(
        first.artifact.runtime_binding?.content
      );
    });
  });

  it("runs the first hook through a restricted Node fallback before any runtime repair", async () => {
    await withTempStore(async (projectPath) => {
      const oldRuntime = join(projectPath, "runtime-old");
      const nextRuntime = join(projectPath, "runtime-next");
      const marker = join(projectPath, "hook-runtime-marker.txt");
      await mkdir(oldRuntime);
      await mkdir(nextRuntime);
      const oldNode = join(oldRuntime, "node");
      const nextNode = join(nextRuntime, "node");
      const oldCli = join(oldRuntime, "cli.cjs");
      const nextCli = join(nextRuntime, "cli.cjs");
      await symlink(process.execPath, oldNode);
      await symlink(process.execPath, nextNode);
      await writeFile(oldCli, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "old")\n`, "utf8");
      await writeFile(nextCli, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "next")\n`, "utf8");

      const first = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime: {
          exec_file: oldNode,
          cli_entry: oldCli,
          package_version: "0.3.0",
          fallback_exec_files: [process.execPath],
          runtime_binding_root: join(projectPath, "runtime-bindings")
        }
      });
      const trustedCommand = first.artifact.command;
      await rm(oldNode);
      await exec("/bin/sh", ["-c", trustedCommand], {
        cwd: projectPath,
        env: { ...process.env, PATH: join(projectPath, "empty-path") }
      });
      expect(await readFile(marker, "utf8")).toBe("old");
      await expect(readFile(first.artifact.runtime_binding!.unavailable_marker_path, "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });

      const upgraded = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime: {
          exec_file: nextNode,
          cli_entry: nextCli,
          package_version: "0.4.0",
          fallback_exec_files: [process.execPath],
          runtime_binding_root: join(projectPath, "runtime-bindings")
        }
      });

      expect(upgraded.artifact.command).toBe(trustedCommand);
      expect(upgraded).toMatchObject({ updated: false, runtime_binding: { created: false, updated: true } });
      await rm(oldCli);
      await exec("/bin/sh", ["-c", upgraded.artifact.command], {
        cwd: projectPath,
        env: { ...process.env, PATH: join(projectPath, "empty-path") }
      });

      expect(await readFile(marker, "utf8")).toBe("next");
      expect(await readFile(upgraded.artifact.runtime_binding!.path, "utf8")).toContain(nextCli);
    });
  });

  it("records a local marker and exits successfully when the bound CLI is unavailable", async () => {
    await withTempStore(async (projectPath) => {
      const runtimeDir = join(projectPath, "runtime-missing-cli");
      await mkdir(runtimeDir);
      const cliEntry = join(runtimeDir, "cli.cjs");
      await writeFile(cliEntry, "process.exitCode = 0\n", "utf8");
      const written = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime: {
          exec_file: process.execPath,
          cli_entry: cliEntry,
          package_version: "0.4.0",
          runtime_binding_root: join(projectPath, "runtime-bindings")
        }
      });
      await rm(cliEntry);

      await expect(
        exec("/bin/sh", ["-c", written.artifact.command], {
          cwd: projectPath,
          env: { ...process.env, PATH: join(projectPath, "empty-path") }
        })
      ).resolves.toMatchObject({ stdout: "", stderr: "" });
      await expect(readFile(written.artifact.runtime_binding!.unavailable_marker_path, "utf8")).resolves.toBe(
        "reason=cli_unavailable\n"
      );
    });
  });

  it("does not follow a symlink when recording an unavailable runtime marker", async () => {
    await withTempStore(async (projectPath) => {
      const cliEntry = join(projectPath, "runtime-cli.cjs");
      const outside = join(projectPath, "outside-marker-target.txt");
      await writeFile(cliEntry, "process.exitCode = 0\n", "utf8");
      await writeFile(outside, "safe\n", "utf8");
      const written = await writeHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime: {
          exec_file: process.execPath,
          cli_entry: cliEntry,
          runtime_binding_root: join(projectPath, "runtime-bindings")
        }
      });
      await symlink(outside, written.artifact.runtime_binding!.unavailable_marker_path);
      await rm(cliEntry);

      await exec("/bin/sh", ["-c", written.artifact.command], { cwd: projectPath });
      await expect(readFile(outside, "utf8")).resolves.toBe("safe\n");
      await expect(
        writeHostIntegrationArtifact({
          host: "codex",
          project_id: "moryn",
          project_path: projectPath,
          store_path: projectPath,
          runtime: {
            exec_file: process.execPath,
            cli_entry: cliEntry,
            runtime_binding_root: join(projectPath, "runtime-bindings")
          }
        })
      ).rejects.toThrow(/symbolic link/);
    });
  });

  it("rejects a symlinked device-local runtime binding", async () => {
    await withTempStore(async (projectPath) => {
      const runtime = {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        runtime_binding_root: join(projectPath, "runtime-bindings")
      };
      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: projectPath,
        runtime
      });
      const bindingPath = artifact.runtime_binding!.path;
      const outside = join(projectPath, "outside-runtime-binding.sh");
      await mkdir(dirname(bindingPath), { recursive: true });
      await writeFile(outside, "safe\n", "utf8");
      await symlink(outside, bindingPath);

      await expect(
        writeHostIntegrationArtifact({
          host: "codex",
          project_id: "moryn",
          project_path: projectPath,
          store_path: projectPath,
          runtime
        })
      ).rejects.toThrow(/symbolic link/);
      await expect(readFile(outside, "utf8")).resolves.toBe("safe\n");
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
