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
