import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/store.js";

const exec = promisify(execFile);
const repoRoot = process.cwd();
const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs");
const cliPath = join(repoRoot, "src/cli.ts");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "moryn-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("moryn CLI", () => {
  it("initializes a store and writes a record", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as { store_version: number; device_id: string };
      expect(config.store_version).toBe(1);
      expect(config.device_id).toMatch(/^device_/);

      const write = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", "Use events"]);
      expect(write.stdout).toContain("rec_");
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "recall", "events", "--project-id", "moryn"]);
      expect(recall.stdout).toContain("Use events");
    });
  });

  it("handles concurrent CLI rebuilds without derived-view races", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      const texts = Array.from({ length: 8 }, (_, index) => `Concurrent rebuild seed ${index}`);
      for (const text of texts) {
        await exec("node", [
          "--import", tsxLoader, cliPath, "--store", store,
          "write",
          "--kind", "memory",
          "--type", "decision",
          "--scope", "project",
          "--project-id", "moryn",
          "--tag", "stress",
          "--state", "canonical",
          "--text", text
        ]);
      }

      const rebuilds = await Promise.allSettled(Array.from({ length: 12 }, () => exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "rebuild"
      ])));

      const failures = rebuilds
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      expect(failures).toEqual([]);

      const recall = JSON.parse(await readFile(join(store, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      const indexedTexts = new Set(recall.records.map((record) => record.text));

      for (const text of texts) {
        expect(indexedTexts).toContain(text);
      }
    });
  }, 30000);

  it("initializes project config and resolves --project for writes", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn", "--tag", "typescript", "--tag", "mcp", "--sync-mode", "interval"]);

      const projectConfig = JSON.parse(await readFile(join(project, ".moryn.json"), "utf8")) as { project_id: string; tags: string[]; sync: { mode: string } };
      expect(projectConfig).toMatchObject({ project_id: "moryn", tags: ["typescript", "mcp"], sync: { mode: "interval" } });

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project", project, "--text", "Use project config"]);
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "project config", "--project", project]);

      expect(recall.stdout).toContain("\"project_id\": \"moryn\"");
      expect(recall.stdout).toContain("Use project config");
    });
  });

  it("preserves existing project sync mode when the CLI updates config without --sync-mode", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn", "--sync-mode", "interval"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--tag", "typescript"]);

      const projectConfig = JSON.parse(await readFile(join(project, ".moryn.json"), "utf8")) as { tags: string[]; sync: { mode: string } };
      expect(projectConfig.tags).toEqual(["typescript"]);
      expect(projectConfig.sync.mode).toBe("interval");
    });
  });

  it("recalls an explicit record id through the CLI even when --project differs", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const other = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "other",
        "--state", "canonical",
        "--text", "CLI retrieves this exact record across project context."
      ]);
      const recordId = (JSON.parse(other.stdout) as { record: { id: string } }).record.id;

      const recall = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id", recordId,
        "--project", project
      ]);

      expect(recall.stdout).toContain(recordId);
      expect(recall.stdout).toContain("CLI retrieves this exact record across project context.");
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
        "--project-id", "moryn",
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
        "--project-id", "moryn",
        "--kind", "memory",
        "--scope", "project",
        "--type", "blocker",
        "--state", "canonical",
        "--tag", "sync",
        "--file", "src/sync/git.ts"
      ]);
      expect(recall.stdout).toContain("file_match:src/sync/git.ts");
      expect(recall.stdout).toContain("Sync must not overwrite local events.");

      const refresh = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "refresh", "--project-id", "moryn", "--cursor", "2000-01-01T00:00:00.000Z"]);
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
        "--project-id", "moryn",
        "--state", "candidate",
        "--confidence", "0.9",
        "--text", "Candidate release decision is ready for review."
      ]);
      const parsedWrite = JSON.parse(write.stdout) as { record: { id: string; confidence: number } };

      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "boot", "--project-id", "moryn"]);
      const parsedBoot = JSON.parse(boot.stdout) as { recent_changes: Array<{ id: string }> };

      expect(parsedWrite.record.confidence).toBe(0.9);
      expect(parsedBoot.recent_changes.map((record) => record.id)).toContain(parsedWrite.record.id);
    });
  });

  it("does not apply ambient project config when only --project-id is provided", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), JSON.stringify({
        project_id: "ambient",
        tags: ["ambient-tag"],
        default_skills: ["ambient-skill"]
      }), "utf8");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "skill",
        "--type", "procedure",
        "--scope", "global",
        "--tag", "ambient-skill",
        "--state", "canonical",
        "--text", "Ambient default skill must not attach to explicit project id.",
        "--confirm"
      ]);

      const write = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "explicit",
        "--text", "Explicit CLI project id should stand alone."
      ], { cwd: project });
      const parsed = JSON.parse(write.stdout) as { record: { project_id?: string; tags: string[] } };

      expect(parsed.record.project_id).toBe("explicit");
      expect(parsed.record.tags).toEqual([]);

      const boot = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "boot",
        "--project-id", "explicit"
      ], { cwd: project });
      const parsedBoot = JSON.parse(boot.stdout) as { skills: Array<{ id: string }> };

      expect(parsedBoot.skills).toEqual([]);
    });
  });

  it("does not leak project records into boot without project context", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer concise engineering updates.",
        "--confirm"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "alpha",
        "--state", "canonical",
        "--priority", "high",
        "--tag", "auth",
        "--text", "Alpha auth token refresh is blocked by stale credentials."
      ]);

      const boot = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "boot",
        "--current-task", "fix auth token refresh"
      ]);
      const parsed = JSON.parse(boot.stdout) as {
        profile: { user_preferences: Array<{ content: { text?: string } }> };
        project: { warnings: unknown[]; important_decisions: unknown[] };
        task_relevant: unknown[];
        recent_changes: Array<{ scope: string; content: { text?: string } }>;
      };

      expect(parsed.profile.user_preferences.map((record) => record.content.text)).toEqual(["Prefer concise engineering updates."]);
      expect(parsed.project.warnings).toEqual([]);
      expect(parsed.project.important_decisions).toEqual([]);
      expect(parsed.task_relevant).toEqual([]);
      expect(parsed.recent_changes.every((record) => record.scope === "global")).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain("Alpha auth token refresh is blocked");
    });
  });

  it("rejects invalid confidence options", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const confidence of ["abc", "1.1"]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "write",
            "--kind", "memory",
            "--type", "decision",
            "--scope", "project",
            "--project-id", "moryn",
            "--confidence", confidence,
            "--text", "Invalid confidence should be rejected."
          ]);
          throw new Error(`Expected moryn write to reject --confidence ${confidence}`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --confidence");
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
      }
    });
  });

  it("rejects project-scoped CLI writes without project context", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "write",
          "--kind", "memory",
          "--type", "decision",
          "--scope", "project",
          "--text", "Project records need an explicit project context."
        ]);
        throw new Error("Expected moryn write to reject a project-scoped record without project context");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("project_id is required for project scope");
        expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
      }

      expect(await readEvents(dir)).toHaveLength(0);
    });
  });

  it("rejects empty global store paths at the CLI boundary", async () => {
    try {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", "", "init"]);
      throw new Error("Expected moryn init to reject an empty --store path");
    } catch (error) {
      if (!("stderr" in (error as object))) throw error;
      const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INVALID_ARGUMENT");
      expect(parsed.error.message).toContain("Invalid --store");
      expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
    }
  });

  it("writes provenance from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--derived-from", "rec_source",
        "--reason", "Derived from handoff summary.",
        "--text", "Use provenance metadata."
      ]);
      const parsed = JSON.parse(write.stdout) as {
        record: {
          provenance?: {
            derived_from?: string[];
            reason?: string;
            method?: string;
          };
        };
      };

      expect(parsed.record.provenance).toEqual({
        derived_from: ["rec_source"],
        reason: "Derived from handoff summary.",
        method: "agent-proposed"
      });
    });
  });

  it("writes structured JSON content from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--content-json", JSON.stringify({
          text: "Use structured CLI content.",
          format: "json",
          evidence: ["cli", "mcp-parity"]
        })
      ]);
      const parsed = JSON.parse(write.stdout) as {
        record: {
          content: {
            text?: string;
            format?: string;
            evidence?: string[];
          };
        };
      };

      expect(parsed.record.content).toEqual({
        text: "Use structured CLI content.",
        format: "json",
        evidence: ["cli", "mcp-parity"]
      });
    });
  });

  it("surfaces structured JSON content without text through CLI boot refresh and recall", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const summary = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "summary",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "canonical",
        "--content-json", JSON.stringify({
          format: "json",
          summary: "CLI structured boot summary."
        })
      ]);
      const warning = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "canonical",
        "--content-json", JSON.stringify({
          format: "json",
          summary: "CLI structured warning.",
          files: ["src/cli.ts"],
          evidence: ["cli-structured"]
        })
      ]);
      const summaryId = (JSON.parse(summary.stdout) as { record: { id: string } }).record.id;
      const warningId = (JSON.parse(warning.stdout) as { record: { id: string } }).record.id;

      const boot = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "boot",
        "--project-id", "moryn"
      ])).stdout) as { project: { summary: string; warnings: Array<{ id: string }> } };
      const refresh = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--project-id", "moryn",
        "--cursor", "2000-01-01T00:00:00.000Z"
      ])).stdout) as { changes: Array<{ record_id: string; summary: string }> };
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "recall",
        "cli-structured",
        "--project-id", "moryn"
      ])).stdout) as { results: Array<{ record: { id: string }; reason: string[] }> };

      expect(boot.project.summary).toBe("CLI structured boot summary.");
      expect(boot.project.warnings.map((record) => record.id)).toContain(warningId);
      expect(refresh.changes).toContainEqual(expect.objectContaining({
        record_id: summaryId,
        summary: "CLI structured boot summary."
      }));
      expect(refresh.changes).toContainEqual(expect.objectContaining({
        record_id: warningId,
        summary: "CLI structured warning. src/cli.ts cli-structured"
      }));
      expect(recall.results[0]?.record.id).toBe(warningId);
      expect(recall.results[0]?.reason).toContain("text_match:cli-structured");
    });
  });

  it("rejects invalid CLI structured content options", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const args of [
        ["--content-json", "["],
        ["--content-json", "{}"],
        ["--content-json", "{\"text\":\"\",\"format\":\"json\"}"],
        ["--text", "Plain text", "--content-json", "{\"text\":\"Structured\"}"]
      ]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "write",
            "--kind", "memory",
            "--type", "decision",
            "--scope", "project",
            "--project-id", "moryn",
            ...args
          ]);
          throw new Error(`Expected moryn write ${args.join(" ")} to reject invalid content options`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        }
      }
    });
  });

  it("rejects empty CLI string options before writing events", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, message } of [
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", ""],
          message: "Invalid --text"
        },
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", "Valid text", "--tag", ""],
          message: "Invalid --tag"
        },
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", "Valid text", "--derived-from", ""],
          message: "Invalid --derived-from"
        },
        {
          args: ["refresh", "--project-id", "moryn", "--cursor", ""],
          message: "Invalid --cursor"
        },
        {
          args: ["sync", "--push", "--message", ""],
          message: "Invalid --message"
        }
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject an empty string option`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain(message);
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
      }

      await expect(readEvents(dir)).resolves.toHaveLength(0);
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
        "--project-id", "moryn",
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
        project_id: "moryn",
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
        "--project-id", "moryn",
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

  it("rejects CLI revisions that attempt to change managed fields", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--text", "Use promote for state transitions."
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "revise",
          recordId,
          "--set", "state=\"canonical\"",
          "--reason", "Bypass promotion"
        ]);
        throw new Error("Expected moryn revise to reject managed state patch");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("managed field state");
        expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
      }
    });
  });

  it("rejects CLI revisions that would create invalid records", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--text", "Keep revision patches valid."
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "revise",
          recordId,
          "--set", "content.text=",
          "--reason", "Invalid blank revision"
        ]);
        throw new Error("Expected moryn revise to reject blank content.text patch");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("Invalid patch");
        expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
      }
    });
  });

  it("rejects malformed CLI revision assignments as invalid arguments", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const assignment of ["content.text", ".content.text=value", "content..text=value", "content.text.=value"]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "revise",
            "rec_missing",
            "--set",
            assignment
          ]);
          throw new Error("Expected moryn revise to reject malformed --set assignment");
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recoverable: boolean; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --set assignment");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
      }
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
        "--project-id", "moryn",
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
        "--project-id", "moryn",
        "--tag", "release",
        "--state", "canonical",
        "--text", "Release requires npm credentials"
      ]);
      const recordId = (JSON.parse(authWarning.stdout) as { record: { id: string } }).record.id;

      const refresh = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--project-id", "moryn",
        "--cursor", "2000-01-01T00:00:00.000Z",
        "--current-task", "fix auth token refresh"
      ]);

      expect(refresh.stdout).toContain(recordId);
      expect(refresh.stdout).toContain("current_task_match");
      expect(refresh.stdout).not.toContain("Release requires npm credentials");
    });
  });

  it("does not leak project refresh changes without project context", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer concise engineering updates.",
        "--confirm"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "blocker",
        "--scope", "project",
        "--project-id", "alpha",
        "--state", "canonical",
        "--priority", "high",
        "--tag", "auth",
        "--text", "Alpha auth token refresh is blocked by stale credentials."
      ]);

      const refresh = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--cursor", "2000-01-01T00:00:00.000Z",
        "--current-task", "fix auth token refresh"
      ]);
      const parsed = JSON.parse(refresh.stdout) as {
        should_interrupt: boolean;
        changes: Array<{ summary: string; importance: string }>;
      };

      expect(parsed.should_interrupt).toBe(false);
      expect(parsed.changes).toEqual([
        expect.objectContaining({
          summary: "Prefer concise engineering updates.",
          importance: "notice"
        })
      ]);
      expect(JSON.stringify(parsed)).not.toContain("Alpha auth token refresh is blocked");
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
        "--project-id", "moryn",
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
        "--text", "safe-release: run tests before publishing",
        "--confirm"
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
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--state", "canonical", "--text", "CLI sync uses Git"]);

      const push = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "--push", "--message", "custom cli sync"]);
      expect(push.stdout).toContain("\"pushed\": true");
      const commitMessage = await exec("git", ["log", "-1", "--pretty=%s"], { cwd: storeA });
      expect(commitMessage.stdout.trim()).toBe("custom cli sync");

      const pull = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--pull"]);
      expect(pull.stdout).toContain("\"pulled\": true");

      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "recall", "Git", "--project-id", "moryn"]);
      expect(recall.stdout).toContain("CLI sync uses Git");

      const status = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--status"]);
      expect(status.stdout).toContain("\"configured\": true");
      expect(status.stdout).toContain("\"dirty\": false");
    });
  }, 30000);

  it("runs the documented MVP success flow through the CLI", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const project = join(dir, "project");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      await mkdir(project, { recursive: true });
      await exec("git", ["init", "--bare", remote]);

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "init", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "init", remote]);

      const initialBoot = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "boot",
        "--project", project,
        "--current-task", "fix auth token refresh"
      ])).stdout) as { project: { important_decisions: Array<{ id: string }> }; sync: { cursor: string } };
      expect(initialBoot.project.important_decisions).toEqual([]);

      const summary = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "write",
        "--kind", "session_summary",
        "--project", project,
        "--text", "Agent A finished auth token refresh investigation."
      ])).stdout) as { record: { id: string; state: string } };
      const candidate = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "candidate",
        "--text", "Use rotating credentials for auth token refresh."
      ])).stdout) as { record: { id: string; state: string } };
      expect(summary.record.state).toBe("candidate");
      expect(candidate.record.state).toBe("candidate");

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "promote",
        candidate.record.id,
        "--state", "canonical",
        "--reason", "User confirmed the project decision"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "write",
        "--kind", "memory",
        "--type", "blocker",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--priority", "high",
        "--text", "Auth token refresh is blocked by stale credentials."
      ]);
      const push = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "sync",
        "--push",
        "--message", "mvp success flow"
      ])).stdout) as { pushed?: boolean };
      expect(push.pushed).toBe(true);

      const pull = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeB,
        "sync",
        "--pull"
      ])).stdout) as { pulled?: boolean };
      expect(pull.pulled).toBe(true);

      const bootB = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeB,
        "boot",
        "--project", project
      ])).stdout) as { project: { important_decisions: Array<{ id: string; content: { text: string } }> } };
      expect(bootB.project.important_decisions).toContainEqual(expect.objectContaining({
        id: candidate.record.id,
        content: expect.objectContaining({ text: "Use rotating credentials for auth token refresh." })
      }));

      const refreshB = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeB,
        "refresh",
        "--project", project,
        "--cursor", initialBoot.sync.cursor,
        "--current-task", "fix auth token refresh"
      ])).stdout) as { should_interrupt: boolean; changes: Array<{ importance: string; reason?: string; summary: string }> };
      expect(refreshB.should_interrupt).toBe(true);
      expect(refreshB.changes).toContainEqual(expect.objectContaining({
        importance: "notice",
        summary: "Agent A finished auth token refresh investigation."
      }));
      expect(refreshB.changes).toContainEqual(expect.objectContaining({
        importance: "interrupt",
        reason: "current_task_match",
        summary: "Auth token refresh is blocked by stale credentials."
      }));
    });
  }, 30000);

  it("rejects conflicting CLI sync operation flags", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      try {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "sync", "--push", "--pull"]);
        throw new Error("Expected moryn sync to reject conflicting operation flags");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("choose only one sync operation");
        expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
      }
    });
  });

  it("rejects CLI sync messages without push", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const args of [
        ["sync", "--message", "ignored message"],
        ["sync", "--pull", "--message", "ignored message"]
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject message without push`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("--message requires --push");
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
      }
    });
  });

  it("rebuilds derived snapshots and indexes from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--state", "canonical", "--text", "CLI rebuild creates indexes"]);

      const rebuild = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "rebuild"]);
      expect(rebuild.stdout).toContain("\"records\": 1");

      const recallIndex = JSON.parse(await readFile(join(dir, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records[0]?.text).toBe("CLI rebuild creates indexes");
    });
  });

  it("runs agent lifecycle start and finish from the CLI", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn", "--tag", "typescript"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "init", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "init", remote]);

      const finish = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeA,
        "agent", "finish",
        "--project", project,
        "--agent", "codex",
        "--session-id", "codex-cli",
        "--summary", "CLI Codex finished the lifecycle protocol."
      ]);
      const parsedFinish = JSON.parse(finish.stdout) as { record: { content: { text: string } }; sync: { push?: { pushed?: boolean } } };
      expect(parsedFinish.record.content.text).toBe("CLI Codex finished the lifecycle protocol.");
      expect(parsedFinish.sync.push?.pushed).toBe(true);

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "start",
        "--project", project,
        "--agent", "gemini",
        "--session-id", "gemini-cli",
        "--current-task", "continue lifecycle protocol",
        "--refresh-since", "2000-01-01T00:00:00.000Z"
      ]);
      const parsedStart = JSON.parse(start.stdout) as {
        project: { project_id: string };
        sync: { pull?: { pulled?: boolean } };
        refresh: { changes: Array<{ summary: string; importance: string }> };
      };
      expect(parsedStart.project.project_id).toBe("moryn");
      expect(parsedStart.sync.pull?.pulled).toBe(true);
      expect(parsedStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "CLI Codex finished the lifecycle protocol.",
        importance: "notice"
      }));
    });
  }, 30000);

  it("bootstraps store and sync from agent lifecycle CLI commands", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "fresh-store-a");
      const storeB = join(dir, "fresh-store-b");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const finish = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeA,
        "agent", "finish",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--summary", "CLI fresh store wrote the first handoff."
      ]);
      const parsedFinish = JSON.parse(finish.stdout) as { bootstrap: { initialized_store: boolean; sync_init?: { ok?: boolean } }; sync: { push?: { pushed?: boolean } } };
      expect(parsedFinish.bootstrap.initialized_store).toBe(true);
      expect(parsedFinish.bootstrap.sync_init?.ok).toBe(true);
      expect(parsedFinish.sync.push?.pushed).toBe(true);

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "start",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "gemini",
        "--current-task", "read fresh handoff",
        "--refresh-since", "2000-01-01T00:00:00.000Z"
      ]);
      const parsedStart = JSON.parse(start.stdout) as {
        bootstrap: { initialized_store: boolean; sync_init?: { ok?: boolean } };
        sync: { pull?: { pulled?: boolean } };
        refresh: { changes: Array<{ summary: string }> };
      };
      expect(parsedStart.bootstrap.initialized_store).toBe(true);
      expect(parsedStart.bootstrap.sync_init?.ok).toBe(true);
      expect(parsedStart.sync.pull?.pulled).toBe(true);
      expect(parsedStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "CLI fresh store wrote the first handoff."
      }));
    });
  }, 30000);

  it("returns read-only agent doctor guidance for a fresh CLI device", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const store = join(dir, "fresh-store");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "doctor",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--session-id", "codex-doctor",
        "--current-task", "start safely"
      ]);
      const parsed = JSON.parse(doctor.stdout) as {
        store: { initialized: boolean };
        project: { ok: boolean; project_id?: string };
        sync: { configured: boolean; expected_remote?: string };
        next: { command: string; tool: string; arguments: { project_path?: string; sync_remote?: string; agent?: { client?: string } } };
      };
      expect(parsed.store.initialized).toBe(false);
      expect(parsed.project).toMatchObject({ ok: true, project_id: "moryn" });
      expect(parsed.sync).toMatchObject({ configured: false, expected_remote: remote });
      expect(parsed.next.tool).toBe("agent_start");
      expect(parsed.next.command).toContain("moryn agent start");
      expect(parsed.next.command).toContain("--sync-remote");
      expect(parsed.next.arguments).toMatchObject({
        project_path: project,
        sync_remote: remote,
        agent: { client: "codex" }
      });
      await expect(readFile(join(store, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns structured JSON errors from runtime failures", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "init"]);
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8");

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

  it("rejects invalid numeric limit options", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const args of [
        ["recall", "anything", "--limit", "abc"],
        ["refresh", "--limit", "0"],
        ["list-recent", "--limit", "101"]
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject an invalid limit`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const stderr = (error as { stderr: string }).stderr;
          const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; message: string; recoverable: boolean; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --limit");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
      }
    });
  });

  it("rejects invalid refresh cursors at the CLI boundary", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "refresh",
          "--cursor", "not-a-date"
        ]);
        throw new Error("Expected moryn refresh to reject an invalid cursor");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("Invalid cursor");
        expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
      }
    });
  });

  it("rejects invalid enum options at the CLI boundary", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const args of [
        ["write", "--kind", "nonsense", "--type", "decision", "--scope", "project", "--text", "Invalid kind."],
        ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--priority", "urgent", "--text", "Invalid priority."],
        ["recall", "--kind", "nonsense"],
        ["promote", "rec_missing", "--state", "nonsense"],
        ["project", "init", "--path", dir, "--sync-mode", "sometimes"]
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject an invalid enum option`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --");
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
      }
    });
  });

  it("returns structured JSON errors for CLI parser failures", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, message } of [
        {
          args: ["write", "--scope", "project", "--type", "decision", "--text", "Parser errors should still be structured."],
          message: "required option '--kind <kind>'"
        },
        {
          args: ["write", "--kind", "memory", "--scope", "project", "--text", "Parser errors should still be structured."],
          message: "required option '--type <type>'"
        }
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject missing input`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as { ok: boolean; error: { code: string; message: string; recoverable: boolean; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain(message);
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("fix the command arguments and retry");
        }
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
        throw new Error("Expected moryn init to fail for malformed store config");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_STORE_CONFIG");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("fix or remove config.json, then run moryn init");
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
        throw new Error("Expected moryn promote to fail for a missing record");
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

  it("requires explicit CLI confirmation for high-risk canonical changes", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "soul",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer terse answers."
      ]);
      const parsedWrite = JSON.parse(write.stdout) as { record: { id: string; state: string }; warning?: { code: string } };
      expect(parsedWrite.record.state).toBe("candidate");
      expect(parsedWrite.warning?.code).toBe("CONFIRMATION_REQUIRED");

      const memoryPreference = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer concise engineering updates."
      ]);
      const parsedMemoryPreference = JSON.parse(memoryPreference.stdout) as { record: { state: string }; warning?: { code: string } };
      expect(parsedMemoryPreference.record.state).toBe("candidate");
      expect(parsedMemoryPreference.warning?.code).toBe("CONFIRMATION_REQUIRED");

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "promote",
          parsedWrite.record.id,
          "--state",
          "canonical",
          "--reason",
          "User confirmed"
        ]);
        throw new Error("Expected moryn promote to require confirmation");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "promote",
        parsedWrite.record.id,
        "--state",
        "canonical",
        "--reason",
        "User confirmed",
        "--confirm"
      ]);
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id",
        parsedWrite.record.id
      ])).stdout) as { results: Array<{ record: { state: string } }> };
      expect(recall.results[0]?.record.state).toBe("canonical");

      const confirmedWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "skill",
        "--type", "procedure",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Global release checklist.",
        "--confirm"
      ]);
      const parsedConfirmedWrite = JSON.parse(confirmedWrite.stdout) as { record: { state: string }; warning?: unknown };
      expect(parsedConfirmedWrite.record.state).toBe("canonical");
      expect(parsedConfirmedWrite.warning).toBeUndefined();
    });
  });

  it("marks conflicting CLI canonical writes as candidates", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const existing = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use append-only JSON events.",
        "--confirm"
      ]);
      const existingId = (JSON.parse(existing.stdout) as { record: { id: string } }).record.id;

      const conflicting = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use SQLite as the source of truth."
      ]);
      const parsed = JSON.parse(conflicting.stdout) as {
        record: { state: string; conflict?: { with: string[]; resolution: string } };
        warning?: { code: string };
      };

      expect(parsed.record.state).toBe("candidate");
      expect(parsed.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(parsed.record.conflict?.with).toEqual([existingId]);
      expect(parsed.record.conflict?.resolution).toBe("needs_review");
    });
  });

  it("requires explicit CLI confirmation for conflicting canonical promotion", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const candidate = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "candidate",
        "--text", "Use SQLite as the source of truth."
      ]);
      const candidateId = (JSON.parse(candidate.stdout) as { record: { id: string } }).record.id;
      const existing = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use append-only JSON events.",
        "--confirm"
      ]);
      const existingId = (JSON.parse(existing.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "promote",
          candidateId,
          "--state",
          "canonical",
          "--reason",
          "Agent inferred this replacement"
        ]);
        throw new Error("Expected moryn promote to require conflict confirmation");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(parsed.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "promote",
        candidateId,
        "--state",
        "canonical",
        "--reason",
        "User confirmed",
        "--confirm"
      ]);
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id",
        candidateId
      ])).stdout) as { results: Array<{ record: { state: string; conflict?: { with: string[]; resolution: string } } }> };
      expect(recall.results[0]?.record.state).toBe("canonical");
      expect(recall.results[0]?.record.conflict?.with).toEqual([existingId]);
      expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
    });
  });

  it("requires explicit CLI confirmation for conflicting canonical revisions", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const existing = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use append-only JSON events.",
        "--confirm"
      ]);
      const existingId = (JSON.parse(existing.stdout) as { record: { id: string } }).record.id;
      const target = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use private Git remotes.",
        "--confirm"
      ]);
      const targetId = (JSON.parse(target.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "revise",
          targetId,
          "--set", "type=decision",
          "--set", "content.text=Use SQLite as the source of truth.",
          "--reason", "Agent inferred this replacement"
        ]);
        throw new Error("Expected moryn revise to require conflict confirmation");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recommended_action: string } };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(parsed.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "revise",
        targetId,
        "--set", "type=decision",
        "--set", "content.text=Use SQLite as the source of truth.",
        "--reason", "User confirmed",
        "--confirm"
      ]);
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id",
        targetId
      ])).stdout) as { results: Array<{ record: { type: string; content: { text: string }; conflict?: { with: string[]; resolution: string } } }> };
      expect(recall.results[0]?.record.type).toBe("decision");
      expect(recall.results[0]?.record.content.text).toBe("Use SQLite as the source of truth.");
      expect(recall.results[0]?.record.conflict?.with).toEqual([existingId]);
      expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
    });
  });

  it("returns structured JSON errors before using an uninitialized store", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "missing-store");
      async function expectStoreNotInitialized(args: string[]): Promise<void> {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to fail before moryn init`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const stderr = (error as { stderr: string }).stderr;
          const parsed = JSON.parse(stderr) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("STORE_NOT_INITIALIZED");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("run moryn init");
        }
      }

      await expectStoreNotInitialized([
        "boot",
        "--project-id",
        "moryn"
      ]);

      await expectStoreNotInitialized([
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--text", "This should not create a store implicitly."
      ]);
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
        throw new Error("Expected moryn sync init to fail for an unavailable remote");
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
        "--project-id", "moryn",
        "--state", "canonical",
        "--text", "Local memory survives remote sync failure."
      ]);
      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "boot", "--project-id", "moryn"]);

      expect(boot.stdout).toContain("Local memory survives remote sync failure.");
    });
  });
});
