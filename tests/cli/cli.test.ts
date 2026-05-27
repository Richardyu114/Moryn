import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("writes confidence from the CLI for high-confidence candidate boot changes", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "memora",
        "--state", "candidate",
        "--confidence", "0.9",
        "--text", "Candidate release decision is ready for review."
      ]);
      const parsedWrite = JSON.parse(write.stdout) as { record: { id: string; confidence: number } };

      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "boot", "--project-id", "memora"]);
      const parsedBoot = JSON.parse(boot.stdout) as { recent_changes: Array<{ id: string }> };

      expect(parsedWrite.record.confidence).toBe(0.9);
      expect(parsedBoot.recent_changes.map((record) => record.id)).toContain(parsedWrite.record.id);
    });
  });

  it("writes project session summaries with handoff defaults from the CLI", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts",
        "project", "init",
        "--path", project,
        "--project-id", "memora",
        "--tag", "handoff"
      ]);

      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "session_summary",
        "--project", project,
        "--text", "Finished the task summary."
      ]);
      const parsed = JSON.parse(write.stdout) as {
        record: {
          kind: string;
          type: string;
          scope: string;
          project_id?: string;
          tags: string[];
          state: string;
          content: { text?: string };
        };
      };

      expect(parsed.record).toMatchObject({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "memora",
        tags: ["handoff"],
        state: "candidate",
        content: { text: "Finished the task summary." }
      });
    });
  });

  it("revises records with repeated CLI assignments and JSON scalar values", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "memora",
        "--state", "candidate",
        "--text", "Use old sync wording"
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "revise",
        recordId,
        "--set", "content.text=\"Use private Git sync\"",
        "--set", "confidence=0.92",
        "--reason", "Clarified wording"
      ]);
      const recall = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "recall",
        "--record-id", recordId
      ]);
      const parsed = JSON.parse(recall.stdout) as { results: Array<{ record: { content: { text: string }; confidence: number } }> };

      expect(parsed.results[0]?.record.content.text).toBe("Use private Git sync");
      expect(parsed.results[0]?.record.confidence).toBe(0.92);
    });
  });

  it("filters refresh interrupts by current task from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const authWarning = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "memora",
        "--tag", "auth",
        "--state", "canonical",
        "--text", "Auth token refresh has a blocker"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "memora",
        "--tag", "release",
        "--state", "canonical",
        "--text", "Release requires npm credentials"
      ]);
      const recordId = (JSON.parse(authWarning.stdout) as { record: { id: string } }).record.id;

      const refresh = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--project-id", "memora",
        "--cursor", "2000-01-01T00:00:00.000Z",
        "--current-task", "fix auth token refresh"
      ]);

      expect(refresh.stdout).toContain(recordId);
      expect(refresh.stdout).toContain("current_task_match");
      expect(refresh.stdout).not.toContain("Release requires npm credentials");
    });
  });

  it("archives, quarantines, links, and boots project default skills from the CLI", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts",
        "project", "init",
        "--path", project,
        "--project-id", "memora",
        "--default-skill", "safe-release"
      ]);

      const skillWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "skill",
        "--type", "procedure",
        "--scope", "global",
        "--tag", "release",
        "--state", "canonical",
        "--text", "safe-release: run tests before publishing"
      ]);
      const decisionWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--text", "Use linked memories"
      ]);
      const oldWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--text", "Old linked memory"
      ]);
      const secretWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--text", "Review this warning"
      ]);
      const skillId = (JSON.parse(skillWrite.stdout) as { record: { id: string } }).record.id;
      const decisionId = (JSON.parse(decisionWrite.stdout) as { record: { id: string } }).record.id;
      const oldId = (JSON.parse(oldWrite.stdout) as { record: { id: string } }).record.id;
      const secretId = (JSON.parse(secretWrite.stdout) as { record: { id: string } }).record.id;

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "link", decisionId, oldId, "--type", "supersedes"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "archive", oldId, "--reason", "Superseded"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "quarantine", secretId, "--reason", "Needs review"]);

      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "boot", "--project", project]);
      expect(boot.stdout).toContain(skillId);
      expect(boot.stdout).toContain("safe-release: run tests before publishing");

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--tag", "auth",
        "--text", "Auth token refresh uses rotating credentials"
      ]);
      const taskBoot = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "boot",
        "--project", project,
        "--current-task", "fix auth token refresh"
      ]);
      const parsedTaskBoot = JSON.parse(taskBoot.stdout) as { task_relevant: Array<{ content: { text: string } }> };
      expect(parsedTaskBoot.task_relevant.map((record) => record.content.text)).toContain("Auth token refresh uses rotating credentials");
      expect(parsedTaskBoot.task_relevant.map((record) => record.content.text)).not.toContain("Review this warning");

      const hiddenRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "Old linked memory", "--project", project]);
      expect(hiddenRecall.stdout).not.toContain("Old linked memory");

      const archivedRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "--record-id", oldId, "--state", "archived", "--project", project]);
      expect(archivedRecall.stdout).toContain("\"state\": \"archived\"");

      const quarantinedRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "--record-id", secretId, "--state", "quarantined", "--project", project]);
      expect(quarantinedRecall.stdout).toContain("\"state\": \"quarantined\"");

      const linkedRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "--record-id", decisionId, "--project", project]);
      expect(linkedRecall.stdout).toContain("\"link_type\": \"supersedes\"");
    });
  }, 30000);

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

  it("returns structured JSON errors from runtime failures", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "init"]);
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".memora.json"), "{\"project_id\":\"\"}\n", "utf8");

      await expect(exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "boot", "--project", project]))
        .rejects.toMatchObject({
          stderr: expect.stringContaining("\"ok\": false")
        });
      try {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "boot", "--project", project]);
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; message: string; recoverable: boolean } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_PROJECT_CONFIG");
        expect(parsed.error.recoverable).toBe(true);
      }
    });
  });

  it("returns structured JSON errors for malformed store config during init", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await mkdir(store, { recursive: true });
      await writeFile(join(store, "config.json"), "{\"store_version\":", "utf8");

      try {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
        throw new Error("Expected mem init to fail for malformed store config");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_STORE_CONFIG");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("fix or remove config.json, then run mem init");
      }
    });
  });

  it("returns structured JSON errors for missing record mutations", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "promote",
          "rec_missing",
          "--state",
          "canonical"
        ]);
        throw new Error("Expected mem promote to fail for a missing record");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("RECORD_NOT_FOUND");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("check the record id or call recall/list-recent to find it");
      }
    });
  });

  it("returns sync remote errors while preserving local write and boot", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const missingRemote = join(dir, "missing-remote.git");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "sync",
          "init",
          missingRemote
        ]);
        throw new Error("Expected mem sync init to fail for an unavailable remote");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("SYNC_REMOTE_UNAVAILABLE");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("continue locally and retry sync later");
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "memora",
        "--state", "canonical",
        "--text", "Local memory survives remote sync failure."
      ]);
      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "boot", "--project-id", "memora"]);

      expect(boot.stdout).toContain("Local memory survives remote sync failure.");
    });
  });
});
