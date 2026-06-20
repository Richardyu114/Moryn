import { describe, expect, it } from "vitest";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { captureSession, contextPack, getHostAdapter, getHostAdapters, normalizeHostId, planInstall } from "../../src/core/host-adapters.js";
import { createEngine } from "../../src/core/engine.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("host adapters", () => {
  it("lists stable first-version host adapters", () => {
    expect(getHostAdapters().map((adapter) => adapter.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "cursor",
      "shell"
    ]);
  });

  it("normalizes common host aliases to stable client identities", () => {
    expect(normalizeHostId("claude-code")).toBe("claude");
    expect(normalizeHostId("codex-cli")).toBe("codex");
    expect(normalizeHostId("gemini-cli")).toBe("gemini");
    expect(normalizeHostId("cursor-agent")).toBe("cursor");
    expect(normalizeHostId("bash")).toBe("shell");
  });

  it("resolves adapter descriptors from aliases", () => {
    const claude = getHostAdapter("claude-code");
    expect(claude?.id).toBe("claude");
    expect(claude?.normalized_client).toBe("claude");
    expect(claude?.mcp_registration.command).toContain("moryn mcp");
    expect(claude?.capture_strategy.default_command).toContain("moryn capture session");
  });

  it("plans a safe dry-run install for a selected host", () => {
    const plan = planInstall({
      host: "codex",
      projectPath: "/workspace/project",
      syncRemote: "git@github.com:user/moryn-store.git",
      apply: false
    });

    expect(plan.mode).toBe("dry_run");
    expect(plan.adapters.map((adapter) => adapter.id)).toEqual(["codex"]);
    expect(plan.actions.map((action) => action.action)).toContain("register_mcp");
    expect(plan.actions.map((action) => action.action)).toContain("capture_session");
    expect(plan.next.command).toContain("moryn context pack");
    expect(plan.next.command).toContain("--agent codex");
    expect(plan.selection_sources.action).toBe("actions_by_id.<action>");
  });

  it("captures a normalized session summary for cross-agent handoff", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      await initializeProjectConfig(projectPath, { project_id: "moryn" });

      const result = await captureSession({
        storePath,
        projectPath,
        summary: "Finished planner",
        agent: { client: "claude-code", session_id: "s1" },
        currentTask: "design host adapter"
      });

      expect(result.record.kind).toBe("session_summary");
      expect(result.record.type).toBe("summary");
      expect(result.record.scope).toBe("project");
      expect(result.record.project_id).toBe("moryn");
      expect(result.record.state).toBe("candidate");
      expect(result.record.tags).toContain("autocapture");
      expect(result.record.tags).toContain("host:claude");
      expect(result.record.source?.client).toBe("claude");
      expect(result.record.source?.session_id).toBe("s1");
      expect(result.record.content.text).toContain("Finished planner");
      expect(result.record.content).toMatchObject({
        format: "json",
        capture: {
          mode: "autocapture",
          host: "claude",
          adapter: "claude",
          session_id: "s1",
          current_task: "design host adapter"
        }
      });
    });
  });

  it("builds a context pack with handoff context and capture next action", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      await initializeProjectConfig(projectPath, { project_id: "moryn" });
      const engine = createEngine({ storePath });
      await engine.write({
        kind: "memory",
        type: "preference",
        scope: "global",
        content: { text: "Prefer explicit user approval before canonical memory changes.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn v0.2 focuses on auditable handoff packs.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Do not turn Moryn into a hosted agent runner.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await captureSession({
        storePath,
        projectPath,
        summary: "Claude finished adapter research.",
        agent: { client: "claude", session_id: "claude-1" },
        currentTask: "adapter research"
      });

      const pack = await contextPack({
        storePath,
        projectPath,
        currentTask: "continue work",
        agent: { client: "gemini-cli", session_id: "gemini-1" },
        pull: false
      });

      expect(pack.kind).toBe("context_pack");
      expect(pack.agent.client).toBe("gemini");
      expect(pack.project.project_id).toBe("moryn");
      expect(pack.handoff_pack).toMatchObject({
        version: 2,
        purpose: "agent_handoff",
        current_goal: {
          text: "continue work",
          source: "context_pack.current_task"
        },
        recent_decisions: [
          expect.objectContaining({
            text: "Moryn v0.2 focuses on auditable handoff packs.",
            evidence: expect.objectContaining({ source: "sections.boot.project.important_decisions[]" })
          })
        ],
        open_threads: [
          expect.objectContaining({
            text: "Claude finished adapter research.",
            evidence: expect.objectContaining({ source: "sections.handoff.inbox[]" })
          })
        ],
        risks: [
          expect.objectContaining({
            text: "Do not turn Moryn into a hosted agent runner.",
            evidence: expect.objectContaining({ source: "sections.boot.project.warnings[]" })
          })
        ],
        user_preferences: [
          expect.objectContaining({
            text: "Prefer explicit user approval before canonical memory changes.",
            evidence: expect.objectContaining({ source: "sections.boot.profile.user_preferences[]" })
          })
        ],
        next_actions: expect.arrayContaining([
          expect.objectContaining({
            id: "capture_session",
            command: expect.stringContaining("moryn capture session"),
            evidence: expect.objectContaining({ source: "next.actions_by_id.capture_session" })
          })
        ]),
        evidence: {
          boot: "sections.boot",
          refresh: "sections.refresh",
          handoff: "sections.handoff",
          next: "next"
        },
        selection_sources: expect.objectContaining({
          handoff_pack: "handoff_pack",
          current_goal: "handoff_pack.current_goal",
          recent_decision: "handoff_pack.recent_decisions[]",
          open_thread: "handoff_pack.open_threads[]",
          risk: "handoff_pack.risks[]",
          user_preference: "handoff_pack.user_preferences[]",
          next_action: "handoff_pack.next_actions[]"
        })
      });
      expect(pack.sections.handoff.inbox.length).toBeGreaterThan(0);
      expect(pack.sections.handoff.inbox[0]?.text).toContain("Claude finished adapter research.");
      expect(pack.next.required_end_action_id).toBe("capture_session");
      expect(pack.next.actions_by_id.capture_session.command).toContain("moryn capture session");
      expect(pack.selection_sources.context_pack).toBe("context_pack");
    });
  });

  it("honors explicit private reads in context packs", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      await mkdir(projectPath, { recursive: true });
      await initializeProjectConfig(projectPath, { project_id: "moryn" });
      const privateSummary = await captureSession({
        storePath,
        projectPath,
        summary: "Private handoff details.",
        agent: { client: "claude" }
      });
      const engine = createEngine({ storePath });
      await engine.revise({
        record_id: privateSummary.record.id,
        patch: { tags: ["autocapture", "review", "host:claude", "private"] },
        source: { client: "test" }
      });

      const defaultPack = await contextPack({
        storePath,
        projectPath,
        agent: { client: "codex" },
        pull: false
      });
      const privatePack = await contextPack({
        storePath,
        projectPath,
        agent: { client: "codex" },
        includePrivate: true,
        pull: false
      });

      expect(defaultPack.sections.handoff.inbox.map((entry) => entry.text)).not.toContain("Private handoff details.");
      expect(privatePack.sections.handoff.inbox.map((entry) => entry.text)).toContain("Private handoff details.");
    });
  });
});
