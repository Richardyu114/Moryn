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

describe("cross-agent workflow", () => {
  it("shares promoted project memory between two agent stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-e2e-"));
    try {
      const remote = join(root, "remote.git");
      const storeA = join(root, "agent-a");
      const storeB = join(root, "agent-b");
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_a" });
      await initializeStore(storeB, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_b" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
