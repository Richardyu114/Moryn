import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memora-package-smoke-"));
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

        const mem = join(dir, "node_modules", ".bin", "mem");
        await exec(mem, ["--store", store, "init"], { cwd: dir });
        await exec(mem, ["project", "init", "--path", project, "--project-id", "memora", "--default-skill", "release"], { cwd: dir });
        await exec(mem, [
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
        const decision = await exec(mem, [
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
        const boot = await exec(mem, ["--store", store, "boot", "--project", project], { cwd: dir });
        const recall = await exec(mem, ["--store", store, "recall", "--record-id", recordId, "--project", project], { cwd: dir });

        expect(boot.stdout).toContain("Release from packed CLI");
        expect(recall.stdout).toContain("Packed CLI can write memory");
        expect(JSON.parse(await readFile(join(store, "config.json"), "utf8"))).toMatchObject({ store_version: 1 });
      } finally {
        if (tarball) {
          await rm(tarball, { force: true });
        }
      }
    });
  }, 30000);
});
