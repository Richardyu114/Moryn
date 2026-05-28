import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { agentFinish, agentStart } from "../../src/core/agent-lifecycle.js";
import { initializeGitSync, pullGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);

describe("agent lifecycle", () => {
  it("pulls, boots, refreshes, writes a handoff, and pushes across two device stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, {
        project_id: "moryn",
        tags: ["typescript"],
        default_skills: ["release"]
      });
      await initializeStore(storeA, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_codex" });
      await initializeStore(storeB, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_gemini" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const codexFinish = await agentFinish({
        storePath: storeA,
        projectPath: project,
        agent: { client: "codex", device_id: "device_codex", session_id: "codex-1" },
        summary: "Codex finished lifecycle wiring and left a Gemini handoff.",
        push: true
      });

      expect(codexFinish.project.project_id).toBe("moryn");
      expect(codexFinish.record.content.text).toBe("Codex finished lifecycle wiring and left a Gemini handoff.");
      expect(codexFinish.sync.push?.pushed).toBe(true);
      expect(codexFinish.next.recommended_start_command).toBe("moryn agent start --project <path> --current-task <task>");

      const geminiStart = await agentStart({
        storePath: storeB,
        projectPath: project,
        currentTask: "continue lifecycle wiring",
        agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" },
        pull: true,
        refreshSince: "2026-05-27T00:00:00.000Z"
      });

      expect(geminiStart.project).toMatchObject({
        project_id: "moryn",
        source: "config",
        sync_mode: "session"
      });
      expect(geminiStart.sync.pull?.pulled).toBe(true);
      expect(geminiStart.refresh.changes).toEqual([
        expect.objectContaining({
          importance: "notice",
          summary: "Codex finished lifecycle wiring and left a Gemini handoff.",
          recommended_action: "call recall with record_id"
        })
      ]);
      expect(geminiStart.boot.recent_changes.map((record) => record.content.text)).toContain("Codex finished lifecycle wiring and left a Gemini handoff.");
      expect(geminiStart.next.required_end_action).toBe("call agent_finish with a session_summary");

      const geminiFinish = await agentFinish({
        storePath: storeB,
        projectPath: project,
        agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" },
        summary: "Gemini picked up the Codex handoff and continued lifecycle wiring.",
        push: true
      });
      expect(geminiFinish.sync.push?.pushed).toBe(true);

      await pullGitSync(storeA);
      const codexEngine = createEngine({ storePath: storeA });
      const recall = await codexEngine.recall({
        query: "Gemini picked up",
        project_id: "moryn",
        kinds: ["session_summary"]
      });
      expect(recall.results[0]?.record.content.text).toBe("Gemini picked up the Codex handoff and continued lifecycle wiring.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("keeps lifecycle usable locally when Git sync is not configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-local-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_local" });

      const start = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "work locally",
        agent: { client: "codex", device_id: "device_local" }
      });
      expect(start.ok).toBe(true);
      expect(start.sync.before?.configured).toBe(false);
      expect(start.sync.pull_error).toContain("Sync not configured");
      expect(start.boot.project.important_decisions).toEqual([]);

      const finish = await agentFinish({
        storePath: store,
        projectPath: project,
        agent: { client: "codex", device_id: "device_local" },
        summary: "Local-only lifecycle handoff was recorded."
      });
      expect(finish.ok).toBe(true);
      expect(finish.sync.push_error).toContain("Sync not configured");

      const engine = createEngine({ storePath: store });
      const recall = await engine.recall({
        query: "Local-only lifecycle",
        project_id: "moryn",
        kinds: ["session_summary"]
      });
      expect(recall.results[0]?.record.id).toBe(finish.record.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
