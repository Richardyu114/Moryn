import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeProjectConfig, resolveProjectContext } from "../../src/core/project.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

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

  it("resolves explicit id before project config", async () => {
    await withTempStore(async (projectPath) => {
      await initializeProjectConfig(projectPath, { project_id: "from-file" });

      const context = await resolveProjectContext({ projectPath, projectId: "explicit" });

      expect(context.project_id).toBe("explicit");
      expect(context.source).toBe("explicit");
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
