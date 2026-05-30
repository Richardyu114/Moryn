import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { initializeProjectConfig, readProjectConfig, resolveProjectContext } from "../../src/core/project.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const PROJECT_INIT_SELECTION_SOURCES = {
  path: "path",
  config: "config",
  config_file: "artifacts.config",
  project_id: "config.project_id",
  tags: "config.tags",
  default_skills: "config.default_skills",
  sync_mode: "config.sync.mode"
};

async function expectInvalidArgument(action: () => Promise<unknown>, expectedMessage: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  if (!caught) {
    throw new Error("Expected invalid argument");
  }

  const envelope = toErrorEnvelope(caught);
  expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  expect(envelope.error.message).toMatch(expectedMessage);
}

async function expectInvalidProjectArgument(
  action: () => Promise<unknown>,
  expectedMessage: RegExp,
  recommendedAction: string,
  recoveryHint: unknown
): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }

  if (!caught) {
    throw new Error("Expected invalid project argument");
  }

  const envelope = toErrorEnvelope(caught);
  expect(envelope.error.code).toBe("INVALID_ARGUMENT");
  expect(envelope.error.message).toMatch(expectedMessage);
  expect(envelope.error.recommended_action).toBe(recommendedAction);
  expect(envelope.error.recovery_hint).toEqual(recoveryHint);
}

async function withCwd<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await action();
  } finally {
    process.chdir(previous);
  }
}

describe("project config", () => {
  it("initializes .moryn.json with project defaults", async () => {
    await withTempStore(async (projectPath) => {
      const result = await initializeProjectConfig(projectPath, {
        project_id: "moryn",
        tags: ["typescript", "mcp"],
        sync: { mode: "session" }
      });

      expect(result.config).toEqual({
        project_id: "moryn",
        tags: ["typescript", "mcp"],
        default_skills: [],
        sync: { mode: "session" }
      });
      expect(result.path).toBe(join(projectPath, ".moryn.json"));
      expect(result.artifacts.config).toBe(".moryn.json");
      expect(result.selection_sources).toEqual(PROJECT_INIT_SELECTION_SOURCES);
    });
  });

  it("supports interval sync mode and normalizes legacy auto mode", async () => {
    await withTempStore(async (projectPath) => {
      const interval = await initializeProjectConfig(projectPath, {
        project_id: "moryn",
        sync: { mode: "interval" }
      });
      expect(interval.config.sync.mode).toBe("interval");

      await writeFile(join(projectPath, ".moryn.json"), JSON.stringify({
        project_id: "moryn",
        sync: { mode: "auto" }
      }), "utf8");

      const context = await resolveProjectContext({ projectPath });
      expect(context.config?.sync.mode).toBe("interval");
    });
  });

  it("rejects invalid project config initialization input before writing", async () => {
    await withTempStore(async (projectPath) => {
      await expectInvalidProjectArgument(
        () => initializeProjectConfig(projectPath, { project_id: "" }),
        /Invalid project_id/,
        "retry project init with a non-empty project_id",
        {
          rejected_argument: { argument: "project_id", value: "" },
          expected: { kind: "non_empty_string", min_length: 1 },
          retry_with: { argument: "project_id", value_placeholder: "<project_id>" }
        }
      );
      await expectInvalidProjectArgument(
        () => initializeProjectConfig(projectPath, { tags: ["typescript", ""] }),
        /Invalid tags/,
        "retry project init with tags as non-empty strings",
        {
          rejected_argument: { argument: "tags", value: ["typescript", ""] },
          expected: { kind: "array_of_non_empty_strings" },
          retry_with: { argument: "tags", value_placeholder: ["<tag>"] }
        }
      );
      await expectInvalidProjectArgument(
        () => initializeProjectConfig(projectPath, { default_skills: ["release", 123 as unknown as string] }),
        /Invalid default_skills/,
        "retry project init with default_skills as non-empty strings",
        {
          rejected_argument: { argument: "default_skills", value: ["release", 123] },
          expected: { kind: "array_of_non_empty_strings" },
          retry_with: { argument: "default_skills", value_placeholder: ["<default_skill>"] }
        }
      );
      await expectInvalidProjectArgument(
        () => initializeProjectConfig(projectPath, { sync: { mode: "always" as never } }),
        /Invalid sync\.mode/,
        "retry project init with a supported sync.mode",
        {
          rejected_argument: { argument: "sync.mode", value: "always" },
          expected: { kind: "allowed_values", allowed_values: ["manual", "session", "interval", "auto"] },
          retry_with: { argument: "sync.mode", value_placeholder: "session" }
        }
      );
      await expectInvalidProjectArgument(
        () => initializeProjectConfig(projectPath, { repair: "yes" as never }),
        /Invalid repair/,
        "retry project init with a boolean repair value",
        {
          rejected_argument: { argument: "repair", value: "yes" },
          expected: { kind: "boolean" },
          retry_with: { argument: "repair", value_placeholder: true }
        }
      );

      await expect(access(join(projectPath, ".moryn.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("repairs malformed project config when explicitly requested", async () => {
    await withTempStore(async (projectPath) => {
      await writeFile(join(projectPath, ".moryn.json"), "{\"project_id\":", "utf8");

      const result = await initializeProjectConfig(projectPath, {
        project_id: "moryn",
        tags: ["typescript"],
        sync: { mode: "manual" },
        repair: true
      });

      expect(result.config).toEqual({
        project_id: "moryn",
        tags: ["typescript"],
        default_skills: [],
        sync: { mode: "manual" }
      });
      await expect(readProjectConfig(projectPath)).resolves.toEqual(result.config);
    });
  });

  it("rejects invalid project path arguments before writing config", async () => {
    await withTempStore(async (projectPath) => {
      await withCwd(projectPath, async () => {
        await expectInvalidProjectArgument(
          () => initializeProjectConfig("", { project_id: "moryn" }),
          /Invalid projectPath/,
          "retry project operation with a non-empty projectPath",
          {
            rejected_argument: { argument: "projectPath", value: "" },
            expected: { kind: "non_empty_string", min_length: 1 },
            retry_with: { argument: "projectPath", value_placeholder: "<projectPath>" }
          }
        );
        await expectInvalidProjectArgument(
          () => initializeProjectConfig(null as never, { project_id: "moryn" }),
          /Invalid projectPath/,
          "retry project operation with a non-empty projectPath",
          {
            rejected_argument: { argument: "projectPath", value: null },
            expected: { kind: "non_empty_string", min_length: 1 },
            retry_with: { argument: "projectPath", value_placeholder: "<projectPath>" }
          }
        );
        await expectInvalidProjectArgument(
          () => readProjectConfig(""),
          /Invalid projectPath/,
          "retry project operation with a non-empty projectPath",
          {
            rejected_argument: { argument: "projectPath", value: "" },
            expected: { kind: "non_empty_string", min_length: 1 },
            retry_with: { argument: "projectPath", value_placeholder: "<projectPath>" }
          }
        );
        await expectInvalidProjectArgument(
          () => readProjectConfig(123 as never),
          /Invalid projectPath/,
          "retry project operation with a non-empty projectPath",
          {
            rejected_argument: { argument: "projectPath", value: 123 },
            expected: { kind: "non_empty_string", min_length: 1 },
            retry_with: { argument: "projectPath", value_placeholder: "<projectPath>" }
          }
        );

        await expect(access(join(projectPath, ".moryn.json"))).rejects.toMatchObject({ code: "ENOENT" });
      });
    });
  });

  it("resolves explicit id before project config", async () => {
    await withTempStore(async (projectPath) => {
      await initializeProjectConfig(projectPath, { project_id: "from-file" });

      const context = await resolveProjectContext({ projectPath, projectId: "explicit" });

      expect(context.project_id).toBe("explicit");
      expect(context.source).toBe("explicit");
    });
  });

  it("resolves explicit id without reading ambient project config", async () => {
    await withTempStore(async (projectPath) => {
      await writeFile(join(projectPath, ".moryn.json"), "{\"project_id\":", "utf8");

      await withCwd(projectPath, async () => {
        const context = await resolveProjectContext({ projectId: "explicit" });

        expect(context.project_id).toBe("explicit");
        expect(context.project_path).toBe(projectPath);
        expect(context.source).toBe("explicit");
        expect(context.config).toBeUndefined();
      });
    });
  });

  it("rejects invalid explicit project context input", async () => {
    await withTempStore(async (projectPath) => {
      await initializeProjectConfig(projectPath, { project_id: "from-file" });

      await expectInvalidArgument(
        () => resolveProjectContext({ projectPath, projectId: "" }),
        /Invalid projectId/
      );
      await expectInvalidArgument(
        () => resolveProjectContext({ projectPath: "" }),
        /Invalid projectPath/
      );
      await expectInvalidArgument(
        () => resolveProjectContext(null as never),
        /Invalid project context input/
      );
    });
  });

  it("resolves project config before git identity", async () => {
    await withTempStore(async (projectPath) => {
      await initializeProjectConfig(projectPath, { project_id: "from-file" });

      const context = await resolveProjectContext({ projectPath });

      expect(context.project_id).toBe("from-file");
      expect(context.source).toBe("config");
      expect(context.config?.project_id).toBe("from-file");
    });
  });

  it("resolves project config from an ancestor directory", async () => {
    await withTempStore(async (projectPath) => {
      await initializeProjectConfig(projectPath, { project_id: "from-root", tags: ["typescript"] });
      const nested = join(projectPath, "packages", "app");
      await mkdir(nested, { recursive: true });

      const context = await resolveProjectContext({ projectPath: nested });

      expect(context.project_id).toBe("from-root");
      expect(context.project_path).toBe(projectPath);
      expect(context.source).toBe("config");
      expect(context.config?.tags).toEqual(["typescript"]);
    });
  });

  it("rejects malformed project config JSON", async () => {
    await withTempStore(async (projectPath) => {
      await writeFile(join(projectPath, ".moryn.json"), "{\"project_id\":", "utf8");

      await expect(resolveProjectContext({ projectPath })).rejects.toThrow(/Invalid project config/);
    });
  });

  it("uses git remote identity across local paths when config is absent", async () => {
    await withTempStore(async (projectPath) => {
      await exec("git", ["init"], { cwd: projectPath });
      await exec("git", ["remote", "add", "origin", "git@github.com:Richardyu114/Moryn.git"], { cwd: projectPath });

      const context = await resolveProjectContext({ projectPath });

      expect(context.source).toBe("git_remote");
      expect(context.project_id).toMatch(/^repo-[a-f0-9]{12}$/);
    });
  });

  it("normalizes equivalent GitHub remote URLs for project identity", async () => {
    await withTempStore(async (root) => {
      const sshProject = join(root, "ssh");
      const httpsProject = join(root, "https");
      const sshUrlProject = join(root, "ssh-url");
      await mkdir(sshProject, { recursive: true });
      await mkdir(httpsProject, { recursive: true });
      await mkdir(sshUrlProject, { recursive: true });
      await exec("git", ["init"], { cwd: sshProject });
      await exec("git", ["init"], { cwd: httpsProject });
      await exec("git", ["init"], { cwd: sshUrlProject });
      await exec("git", ["remote", "add", "origin", "git@github.com:Richardyu114/Moryn.git"], { cwd: sshProject });
      await exec("git", ["remote", "add", "origin", "https://github.com/Richardyu114/Moryn.git"], { cwd: httpsProject });
      await exec("git", ["remote", "add", "origin", "ssh://git@github.com/Richardyu114/Moryn.git/"], { cwd: sshUrlProject });

      const sshContext = await resolveProjectContext({ projectPath: sshProject });
      const httpsContext = await resolveProjectContext({ projectPath: httpsProject });
      const sshUrlContext = await resolveProjectContext({ projectPath: sshUrlProject });

      expect(sshContext.source).toBe("git_remote");
      expect(httpsContext.source).toBe("git_remote");
      expect(sshUrlContext.source).toBe("git_remote");
      expect(httpsContext.project_id).toBe(sshContext.project_id);
      expect(sshUrlContext.project_id).toBe(sshContext.project_id);
    });
  });

  it("falls back to git root path before directory name", async () => {
    await withTempStore(async (projectPath) => {
      await exec("git", ["init"], { cwd: projectPath });
      const nested = join(projectPath, "packages", "app");
      await mkdir(nested, { recursive: true });
      await writeFile(join(projectPath, "README.md"), "# test\n", "utf8");

      const context = await resolveProjectContext({ projectPath: nested });

      expect(context.source).toBe("git_root");
      expect(context.project_id).toMatch(/^repo-[a-f0-9]{12}$/);
    });
  });
});
