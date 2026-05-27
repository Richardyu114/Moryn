import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memora-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mem CLI", () => {
  it("initializes a store and writes a record", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as { store_version: number; device_id: string };
      expect(config.store_version).toBe(1);
      expect(config.device_id).toMatch(/^device_/);

      const write = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "memora", "--text", "Use events"]);
      expect(write.stdout).toContain("rec_");
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "recall", "events", "--project-id", "memora"]);
      expect(recall.stdout).toContain("Use events");
    });
  });

  it("initializes project config and resolves --project for writes", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "memora", "--tag", "typescript", "--tag", "mcp"]);

      const projectConfig = JSON.parse(await readFile(join(project, ".memora.json"), "utf8")) as { project_id: string; tags: string[] };
      expect(projectConfig).toMatchObject({ project_id: "memora", tags: ["typescript", "mcp"] });

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project", project, "--text", "Use project config"]);
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "project config", "--project", project]);

      expect(recall.stdout).toContain("\"project_id\": \"memora\"");
      expect(recall.stdout).toContain("Use project config");
    });
  });

  it("recalls with filters and refreshes changes from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "blocker",
        "--scope", "project",
        "--project-id", "memora",
        "--tag", "sync",
        "--tag", "src/sync/git.ts",
        "--state", "canonical",
        "--priority", "high",
        "--text", "Sync must not overwrite local events."
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      const recall = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "recall",
        "--record-id", recordId,
        "--project-id", "memora",
        "--kind", "memory",
        "--scope", "project",
        "--type", "blocker",
        "--state", "canonical",
        "--tag", "sync",
        "--file", "src/sync/git.ts"
      ]);
      expect(recall.stdout).toContain("file_match:src/sync/git.ts");
      expect(recall.stdout).toContain("Sync must not overwrite local events.");

      const refresh = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "refresh", "--project-id", "memora", "--cursor", "2000-01-01T00:00:00.000Z"]);
      expect(refresh.stdout).toContain("\"importance\": \"interrupt\"");
      expect(refresh.stdout).toContain(recordId);
    });
  });

  it("syncs local store events through a git remote", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      await exec("git", ["init", "--bare", remote]);

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "init", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "init", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "memora", "--state", "canonical", "--text", "CLI sync uses Git"]);

      const push = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "--push"]);
      expect(push.stdout).toContain("\"pushed\": true");

      const pull = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--pull"]);
      expect(pull.stdout).toContain("\"pulled\": true");

      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "recall", "Git", "--project-id", "memora"]);
      expect(recall.stdout).toContain("CLI sync uses Git");

      const status = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--status"]);
      expect(status.stdout).toContain("\"configured\": true");
      expect(status.stdout).toContain("\"dirty\": false");
    });
  });

  it("rebuilds derived snapshots and indexes from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "memora", "--state", "canonical", "--text", "CLI rebuild creates indexes"]);

      const rebuild = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "rebuild"]);
      expect(rebuild.stdout).toContain("\"records\": 1");

      const recallIndex = JSON.parse(await readFile(join(dir, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records[0]?.text).toBe("CLI rebuild creates indexes");
    });
  });
});
