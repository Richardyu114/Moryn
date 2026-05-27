import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);

interface TwoAgentStores {
  root: string;
  remote: string;
  storeA: string;
  storeB: string;
}

async function withTwoAgentStores(fn: (stores: TwoAgentStores) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "memora-e2e-"));
  try {
    const stores = {
      root,
      remote: join(root, "remote.git"),
      storeA: join(root, "agent-a"),
      storeB: join(root, "agent-b")
    };
    await exec("git", ["init", "--bare", stores.remote]);
    await initializeStore(stores.storeA, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_a" });
    await initializeStore(stores.storeB, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_b" });
    await initializeGitSync(stores.storeA, stores.remote);
    await initializeGitSync(stores.storeB, stores.remote);
    await fn(stores);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("cross-agent workflow", () => {
  it("shares promoted project memory between two agent stores", async () => {
    await withTwoAgentStores(async ({ storeA, storeB }) => {
      let nextId = 0;
      const agentA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });
      const note = await agentA.write({
        kind: "agent_note",
        type: "decision",
        scope: "project",
        project_id: "memora",
        content: { text: "Use promoted memories for boot context.", format: "text" },
        source: { client: "agent-a", device_id: "device_a" }
      });

      expect((await agentA.boot({ project_id: "memora" })).project.important_decisions).toHaveLength(0);

      await agentA.promote({
        record_id: note.record.id,
        target_state: "canonical",
        reason: "User confirmed",
        source: { client: "user", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "agent a promoted memory" });
      await pullGitSync(storeB);

      const agentB = createEngine({ storePath: storeB });
      const boot = await agentB.boot({ project_id: "memora" });
      const recall = await agentB.recall({ query: "boot context", project_id: "memora", scopes: ["project"] });

      expect(boot.project.important_decisions.map((record) => record.content.text)).toEqual([
        "Use promoted memories for boot context."
      ]);
      expect(recall.results[0]?.record.id).toBe(note.record.id);
    });
  });

  it("notices synced session summaries without interrupting", async () => {
    await withTwoAgentStores(async ({ storeA, storeB }) => {
      let nextId = 0;
      const agentA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:01:00.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const summary = await agentA.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Agent A finished initial sync wiring.", format: "text" },
        source: { client: "agent-a", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "agent a session summary" });
      await pullGitSync(storeB);

      const agentB = createEngine({ storePath: storeB });
      const refresh = await agentB.refresh({
        project_id: "memora",
        cursor: "2026-05-27T00:00:00.000Z"
      });

      expect(refresh.should_interrupt).toBe(false);
      expect(refresh.cursor).toBe(summary.record.updated_at);
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: summary.record.id,
          importance: "notice",
          summary: "Agent A finished initial sync wiring.",
          recommended_action: "call recall with record_id"
        })
      ]);
    });
  });

  it("interrupts another agent for a synced related blocker", async () => {
    await withTwoAgentStores(async ({ storeA, storeB }) => {
      let nextId = 0;
      const agentA = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:02:00.000Z",
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const blocker = await agentA.write({
        kind: "memory",
        type: "blocker",
        scope: "project",
        project_id: "memora",
        tags: ["auth"],
        content: { text: "Auth token refresh is blocked by stale credentials.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "agent-a", device_id: "device_a" }
      });
      await pushGitSync(storeA, { message: "agent a blocker" });
      await pullGitSync(storeB);

      const agentB = createEngine({ storePath: storeB });
      const refresh = await agentB.refresh({
        project_id: "memora",
        cursor: "2026-05-27T00:00:00.000Z",
        current_task: "fix auth token refresh"
      });

      expect(refresh.should_interrupt).toBe(true);
      expect(refresh.changes).toEqual([
        expect.objectContaining({
          record_id: blocker.record.id,
          importance: "interrupt",
          reason: "current_task_match",
          summary: "Auth token refresh is blocked by stale credentials."
        })
      ]);
    });
  });
});
