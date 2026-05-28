import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { agentDoctor, agentFinish, agentStart, agentStatus } from "../../src/core/agent-lifecycle.js";
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
      expect(geminiStart.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        tool: "agent_status",
        command: expect.stringContaining("moryn agent status"),
        required_fields: ["status"],
        arguments: expect.objectContaining({
          project_path: project,
          current_task: "continue lifecycle wiring",
          agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
        })
      }));
      expect(geminiStart.next.actions).toContainEqual(expect.objectContaining({
        action: "finish_session",
        tool: "agent_finish",
        command: expect.stringContaining("moryn agent finish"),
        required_fields: ["summary"],
        arguments: expect.objectContaining({
          project_path: project,
          current_task: "continue lifecycle wiring",
          agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
        })
      }));
      expect(geminiStart.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        tool: "agent_start",
        command: expect.stringContaining("--refresh-since"),
        required_fields: [],
        arguments: expect.objectContaining({
          project_path: project,
          refresh_since: geminiStart.refresh.cursor,
          current_task: "continue lifecycle wiring",
          agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
        })
      }));

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

  it("bootstraps a fresh device store and sync remote from agent lifecycle input", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-bootstrap-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });

      const firstFinish = await agentFinish({
        storePath: storeA,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "codex", device_id: "device_codex" },
        summary: "Fresh Codex device bootstrapped Moryn and pushed a handoff."
      });

      expect(firstFinish.bootstrap.initialized_store).toBe(true);
      expect(firstFinish.bootstrap.sync_init?.ok).toBe(true);
      expect(firstFinish.sync.push?.pushed).toBe(true);

      const firstStart = await agentStart({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "gemini", device_id: "device_gemini" },
        currentTask: "continue after fresh device bootstrap",
        refreshSince: "2000-01-01T00:00:00.000Z"
      });

      expect(firstStart.bootstrap.initialized_store).toBe(true);
      expect(firstStart.bootstrap.sync_init?.ok).toBe(true);
      expect(firstStart.sync.pull?.pulled).toBe(true);
      expect(firstStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "Fresh Codex device bootstrapped Moryn and pushed a handoff.",
        importance: "notice"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("shares in-progress agent status across fresh device stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-status-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-codex");
    const storeB = join(root, "store-gemini");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });

      const status = await agentStatus({
        storePath: storeA,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "codex", session_id: "codex-status" },
        status: "Codex is refactoring lifecycle status propagation.",
        currentTask: "lifecycle status propagation"
      });

      expect(status.bootstrap.initialized_store).toBe(true);
      expect(status.record).toMatchObject({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: expect.objectContaining({
          text: "Codex is refactoring lifecycle status propagation.",
          current_task: "lifecycle status propagation"
        })
      });
      expect(status.sync.push?.pushed).toBe(true);

      const start = await agentStart({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "gemini", session_id: "gemini-status" },
        currentTask: "coordinate lifecycle status propagation",
        refreshSince: "2000-01-01T00:00:00.000Z"
      });

      expect(start.refresh.changes).toContainEqual(expect.objectContaining({
        importance: "notice",
        summary: "Codex is refactoring lifecycle status propagation.",
        recommended_action: "call recall with record_id"
      }));
      expect(start.boot.recent_changes).toContainEqual(expect.objectContaining({
        type: "status",
        content: expect.objectContaining({ text: "Codex is refactoring lifecycle status propagation." })
      }));
      expect(start.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        tool: "agent_status",
        required_fields: ["status"],
        arguments: expect.objectContaining({
          project_path: project,
          sync_remote: remote,
          current_task: "coordinate lifecycle status propagation"
        })
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("diagnoses a fresh agent device without mutating the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-"));
    const remote = join(root, "remote.git");
    const store = join(root, "fresh-store");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: project,
        syncRemote: remote,
        currentTask: "continue safely on a new machine",
        agent: { client: "gemini", session_id: "gemini-doctor" }
      });

      expect(doctor.ok).toBe(true);
      expect(doctor.store).toMatchObject({ path: store, initialized: false });
      expect(doctor.project).toMatchObject({ ok: true, project_id: "moryn", source: "config" });
      expect(doctor.sync).toMatchObject({ configured: false, expected_remote: remote });
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "store",
        ok: false,
        severity: "notice"
      }));
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "sync",
        ok: false,
        severity: "notice"
      }));
      expect(doctor.next).toMatchObject({
        recommended_action: "call_agent_start",
        tool: "agent_start",
        safe_to_run: true
      });
      expect(doctor.next.command).toContain("moryn agent start");
      expect(doctor.next.command).toContain("--sync-remote");
      expect(doctor.next.arguments).toMatchObject({
        project_path: project,
        sync_remote: remote,
        current_task: "continue safely on a new machine",
        agent: { client: "gemini", session_id: "gemini-doctor" }
      });
      await expect(access(join(store, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start when project config is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-invalid-project-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeStore(store);
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8").catch(async (error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          await mkdir(project, { recursive: true });
          await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8");
          return;
        }
        throw error;
      });

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: project,
        agent: { client: "codex" }
      });

      expect(doctor.project).toMatchObject({ ok: false });
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "project",
        ok: false,
        severity: "warning"
      }));
      expect(doctor.next).toMatchObject({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false
      });
      expect(doctor.next.command).toContain("moryn project init");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
