import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { initializeProjectConfig, readProjectConfig, resolveProjectContext } from "../../src/core/project.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

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
  it("initializes .memora.json with project defaults", async () => {
    await withTempStore(async (projectPath) => {
      const result = await initializeProjectConfig(projectPath, {
        project_id: "memora",
        tags: ["typescript", "mcp"],
        sync: { mode: "session" }
      });

      expect(result.config).toEqual({
        project_id: "memora",
        tags: ["typescript", "mcp"],
        default_skills: [],
        sync: { mode: "session" }
      });
    });
  });

  it("supports interval sync mode and normalizes legacy auto mode", async () => {
    await withTempStore(async (projectPath) => {
      const interval = await initializeProjectConfig(projectPath, {
        project_id: "memora",
        sync: { mode: "interval" }
      });
      expect(interval.config.sync.mode).toBe("interval");

      await writeFile(join(projectPath, ".memora.json"), JSON.stringify({
        project_id: "memora",
        sync: { mode: "auto" }
      }), "utf8");

      const context = await resolveProjectContext({ projectPath });
      expect(context.config?.sync.mode).toBe("interval");
    });
  });

  it("rejects invalid project config initialization input before writing", async () => {
    await withTempStore(async (projectPath) => {
      await expectInvalidArgument(
        () => initializeProjectConfig(projectPath, { project_id: "" }),
        /Invalid project_id/
      );
      await expectInvalidArgument(
        () => initializeProjectConfig(projectPath, { tags: ["typescript", ""] }),
        /Invalid tags/
      );
      await expectInvalidArgument(
        () => initializeProjectConfig(projectPath, { default_skills: ["release", 123 as unknown as string] }),
        /Invalid default_skills/
      );
      await expectInvalidArgument(
        () => initializeProjectConfig(projectPath, { sync: { mode: "always" as never } }),
        /Invalid sync\.mode/
      );

      await expect(access(join(projectPath, ".memora.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects invalid project path arguments before writing config", async () => {
    await withTempStore(async (projectPath) => {
      await withCwd(projectPath, async () => {
        await expectInvalidArgument(
          () => initializeProjectConfig("", { project_id: "memora" }),
          /Invalid projectPath/
        );
        await expectInvalidArgument(
          () => initializeProjectConfig(null as never, { project_id: "memora" }),
          /Invalid projectPath/
        );
        await expectInvalidArgument(
          () => readProjectConfig(""),
          /Invalid projectPath/
        );
        await expectInvalidArgument(
          () => readProjectConfig(123 as never),
          /Invalid projectPath/
        );

        await expect(access(join(projectPath, ".memora.json"))).rejects.toMatchObject({ code: "ENOENT" });
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
      await writeFile(join(projectPath, ".memora.json"), "{\"project_id\":", "utf8");

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
      await writeFile(join(projectPath, ".memora.json"), "{\"project_id\":", "utf8");

      await expect(resolveProjectContext({ projectPath })).rejects.toThrow(/Invalid project config/);
    });
  });

  it("uses git remote identity across local paths when config is absent", async () => {
    await withTempStore(async (projectPath) => {
      await exec("git", ["init"], { cwd: projectPath });
      await exec("git", ["remote", "add", "origin", "git@github.com:Richardyu114/Memora.git"], { cwd: projectPath });

      const context = await resolveProjectContext({ projectPath });

      expect(context.source).toBe("git_remote");
      expect(context.project_id).toMatch(/^repo-[a-f0-9]{12}$/);
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
