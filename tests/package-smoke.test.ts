import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "moryn-package-smoke-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("published package smoke", () => {
  it("installs the packed CLI and runs memory operations from dist", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      const pack = await exec("npm", ["pack", "--silent"], { cwd: process.cwd() });
      const tarball = join(process.cwd(), pack.stdout.trim().split(/\s+/).at(-1) ?? "");

      try {
        await exec("npm", ["init", "-y"], { cwd: dir });
        await exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tarball], { cwd: dir });

        const moryn = join(dir, "node_modules", ".bin", "moryn");
        await exec(moryn, ["--store", store, "init"], { cwd: dir });
        await exec(moryn, ["project", "init", "--path", project, "--project-id", "moryn", "--default-skill", "release"], { cwd: dir });
        await exec(moryn, [
          "--store", store,
          "write",
          "--kind", "skill",
          "--type", "procedure",
          "--scope", "global",
          "--tag", "release",
          "--state", "canonical",
          "--text", "Release from packed CLI",
          "--confirm"
        ], { cwd: dir });
        const decision = await exec(moryn, [
          "--store", store,
          "write",
          "--kind", "memory",
          "--type", "decision",
          "--scope", "project",
          "--project", project,
          "--state", "canonical",
          "--text", "Packed CLI can write memory"
        ], { cwd: dir });

        const recordId = (JSON.parse(decision.stdout) as { record: { id: string } }).record.id;
        const boot = await exec(moryn, ["--store", store, "boot", "--project", project], { cwd: dir });
        const recall = await exec(moryn, ["--store", store, "recall", "--record-id", recordId, "--project", project], { cwd: dir });

        expect(boot.stdout).toContain("Release from packed CLI");
        expect(recall.stdout).toContain("Packed CLI can write memory");
        expect(JSON.parse(await readFile(join(store, "config.json"), "utf8"))).toMatchObject({ store_version: 1 });
      } finally {
        if (tarball) {
          await rm(tarball, { force: true });
        }
      }
    });
  }, 120000);

  it("installs the packed package and runs the lifecycle smoke without dev dependencies", async () => {
    await withTempDir(async (dir) => {
      const pack = await exec("npm", ["pack", "--silent"], { cwd: process.cwd() });
      const tarball = join(process.cwd(), pack.stdout.trim().split(/\s+/).at(-1) ?? "");

      try {
        await exec("npm", ["init", "-y"], { cwd: dir });
        await exec("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tarball], { cwd: dir });

        const smoke = join(dir, "node_modules", ".bin", "moryn-agent-smoke");
        const result = await exec(smoke, [], { cwd: dir });

        expect(result.stdout).toContain("agent lifecycle smoke passed");
        expect(result.stdout).toContain("Codex smoke status reached Gemini");
        expect(result.stdout).toContain("Gemini smoke finish reached Codex");
      } finally {
        if (tarball) {
          await rm(tarball, { force: true });
        }
      }
    });
  }, 120000);
});
