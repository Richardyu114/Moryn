import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFinish } from "../../src/core/agent-lifecycle.js";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { buildActiveLogicalMemoryView } from "../../src/core/logical-memory.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { SYNC_RESULT_SELECTION_SOURCES } from "../../src/sync/git.js";

async function withLifecycleStore(run: (input: { storePath: string; projectPath: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "moryn-session-fold-lifecycle-"));
  const storePath = join(root, "store");
  const projectPath = join(root, "project");
  try {
    await initializeStore(storePath, { id: () => "device-a" });
    await initializeProjectConfig(projectPath, { project_id: "moryn", sync: { mode: "manual" } });
    await run({ storePath, projectPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const source = { client: "codex", session_id: "session-a", device_id: "device-a" };

async function writeVerifiedCheckpoint(
  storePath: string,
  input: {
    source?: typeof source;
    occurred_at?: string;
    checkpoint_id?: string;
  } = {}
) {
  const checkpointSource = input.source ?? source;
  await createEngine({ storePath }).checkpoint({
    project_id: "moryn",
    source: checkpointSource,
    occurred_at: input.occurred_at ?? "2026-07-20T02:00:01.000Z",
    delta: {
      session_id: checkpointSource.session_id,
      checkpoint_id: input.checkpoint_id ?? "verified-finish",
      current_task: "Finish a verified structured session",
      decisions: ["Fold only after learning ingestion"],
      changed_facts: ["The final handoff is durable"],
      blockers: [],
      next_steps: ["Start the next session"],
      files: ["src/core/agent-lifecycle.ts"]
    }
  });
}

describe("agentFinish Session Fold", () => {
  it("applies one proof-gated semantic merge before finish sync without user confirmation", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.parse("2026-07-19T00:00:00.000Z") + tick++).toISOString()
      });
      const shared = `The verified lifecycle procedure retains this complete evidence ${"shared ".repeat(600)}.`;
      const base = {
        kind: "skill" as const,
        type: "procedure",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["maintenance"],
        state: "canonical" as const,
        confirmed: true,
        confidence: 0.99,
        source: { client: "codex" }
      };
      await engine.write({ ...base, content: { text: `${shared} Old endpoint remains available.` } });
      await engine.write({ ...base, content: { text: `${shared} New endpoint is canonical.` } });
      let activeAtPush = 0;

      const result = await agentFinish(
        {
          storePath,
          projectPath,
          agent: { client: "codex" },
          summary: "Finished proof-gated maintenance integration.",
          push: true
        },
        {
          now: () => "2026-07-20T02:00:02.000Z",
          pushGitSync: async () => {
            activeAtPush = buildActiveLogicalMemoryView(
              (await readCurrentRecords(storePath)).records
            ).active_records.filter((record) => record.visibility === "active").length;
            return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
          }
        }
      );

      expect(result.automatic_semantic_maintenance).toMatchObject({
        status: "committed",
        maximum_merges: 1,
        merges_committed: 1,
        proof: {
          strict_record_decrease_observed: true,
          strict_token_decrease_observed: true,
          source_history_retained: true
        }
      });
      expect(result.automatic_semantic_maintenance.after.current_records).toBe(
        result.automatic_semantic_maintenance.before.current_records - 1
      );
      expect(activeAtPush).toBe(2);
      expect(result.sync.push?.pushed).toBe(true);
    });
  });

  it("folds a verified structured session before push and leaves one active episodic target", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      await writeVerifiedCheckpoint(storePath);
      let activeAtPush: string[] = [];
      const result = await agentFinish(
        {
          storePath,
          projectPath,
          agent: source,
          summary: "Verified structured work is complete.",
          push: true
        },
        {
          now: () => "2026-07-20T02:00:02.000Z",
          pushGitSync: async () => {
            activeAtPush = (await readCurrentRecords(storePath)).records
              .filter((record) => record.kind === "session_summary" && record.visibility === "active")
              .map((record) => record.type);
            return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
          }
        }
      );

      expect(result.session_fold).toMatchObject({
        status: "committed",
        plan: { coverage: { coverage_attestation: "verified", coverage_ratio: 1 } }
      });
      expect(result.record.content.session_fold_coverage).toBeDefined();
      expect(activeAtPush).toEqual(["session_rollup"]);
      expect(result.sync.push?.pushed).toBe(true);
    });
  });

  it("replays the same finish after folding without changing its idempotent request", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      await writeVerifiedCheckpoint(storePath);
      const input = {
        storePath,
        projectPath,
        agent: source,
        summary: "Verified structured work is complete.",
        push: false
      };
      const deps = { now: () => "2026-07-20T02:00:02.000Z" };

      const first = await agentFinish(input, deps);
      const replay = await agentFinish(input, deps);

      expect(first).toMatchObject({ idempotent_replay: false, session_fold: { status: "committed" } });
      expect(replay).toMatchObject({
        idempotent_replay: true,
        record: { id: first.record.id },
        durability: "confirmed"
      });
      expect(
        (await readEvents(storePath)).filter(
          (event) => event.op === "upsert_record" && event.record.id === first.record.id
        )
      ).toHaveLength(1);
    });
  });

  it("automatically rolls up eligible closed days after folding and before push", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      const oldSource = { ...source, session_id: "session-old" };
      await writeVerifiedCheckpoint(storePath, {
        source: oldSource,
        occurred_at: "2026-07-01T02:00:01.000Z",
        checkpoint_id: "old-day"
      });
      const oldFinish = await agentFinish(
        {
          storePath,
          projectPath,
          agent: oldSource,
          summary: "The old verified session is complete.",
          push: false
        },
        { now: () => "2026-07-01T02:00:02.000Z" }
      );
      expect(oldFinish).toMatchObject({
        session_fold: { status: "committed" },
        episode_rollup: { status: "skipped", eligible_plan_count: 0 }
      });

      const currentSource = { ...source, session_id: "session-current" };
      await writeVerifiedCheckpoint(storePath, {
        source: currentSource,
        occurred_at: "2026-07-20T02:00:01.000Z",
        checkpoint_id: "current-day"
      });
      let activeTypesAtPush: string[] = [];
      const currentFinish = await agentFinish(
        {
          storePath,
          projectPath,
          agent: currentSource,
          summary: "The current verified session is complete.",
          push: true
        },
        {
          now: () => "2026-07-20T02:00:02.000Z",
          pushGitSync: async () => {
            activeTypesAtPush = (await readCurrentRecords(storePath)).records
              .filter((record) => record.kind === "session_summary" && record.visibility === "active")
              .map((record) => record.type)
              .sort();
            return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
          }
        }
      );

      expect(currentFinish).toMatchObject({
        session_fold: { status: "committed" },
        episode_rollup: {
          status: "committed",
          inspected_plan_count: 2,
          eligible_plan_count: 1,
          deferred_plan_count: 1,
          failures: []
        }
      });
      expect(currentFinish.episode_rollup.committed[0]?.plan.identity).toEqual({
        project_id: "moryn",
        bucket_kind: "day",
        bucket_key: "2026-07-01"
      });
      expect(activeTypesAtPush).toEqual(["episode_rollup", "session_rollup"]);
    });
  });

  it("keeps ordinary unverified text active for review", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      await createEngine({ storePath, now: () => "2026-07-20T02:00:01.000Z" }).write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "An unsafe detail absent from the final summary" },
        source
      });
      const result = await agentFinish(
        {
          storePath,
          projectPath,
          agent: source,
          summary: "A final summary with different content.",
          push: false
        },
        { now: () => "2026-07-20T02:00:02.000Z" }
      );

      expect(result.session_fold).toMatchObject({ status: "review_required" });
      if (result.session_fold.status !== "review_required") throw new Error("Expected review_required");
      expect(result.session_fold.plan.review_reasons.map((reason) => reason.code)).toContain(
        "unverified_source_coverage"
      );
      expect(
        (await readCurrentRecords(storePath)).records.filter(
          (record) => record.kind === "session_summary" && record.visibility === "active"
        )
      ).toHaveLength(2);
      expect((await readEvents(storePath)).some((event) => event.op === "archive_record")).toBe(false);
    });
  });

  it("returns a warning, still pushes, and can resume after a partial fold failure", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      await writeVerifiedCheckpoint(storePath);
      let foldAttempts = 0;
      let pushed = false;
      const result = await agentFinish(
        {
          storePath,
          projectPath,
          agent: source,
          summary: "Verified work remains recoverable.",
          push: true
        },
        {
          now: () => "2026-07-20T02:00:02.000Z",
          createEngine: (deps) =>
            createEngine({
              ...deps,
              appendEventIfAbsent: async (path, event) => {
                if (event.event_id.includes("session_fold_")) foldAttempts += 1;
                if (foldAttempts === 3 && event.event_id.includes("session_fold_")) {
                  throw new Error("injected fold append failure");
                }
                return appendEventIfAbsent(path, event);
              }
            }),
          pushGitSync: async () => {
            pushed = true;
            return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
          }
        }
      );

      expect(result).toMatchObject({
        ok: true,
        committed: true,
        durability: "confirmed",
        record: { content: { text: "Verified work remains recoverable." } },
        session_fold: {
          status: "failed",
          warning: {
            code: "SESSION_FOLD_APPLY_FAILED",
            stage: "apply",
            reason: "injected fold append failure"
          }
        },
        sync: { push: { pushed: true } }
      });
      expect(Object.values(result.durability_by_event_id)).toEqual(["confirmed"]);
      expect(pushed).toBe(true);
      if (result.session_fold.status !== "failed" || !result.session_fold.plan) {
        throw new Error("Expected a resumable failed Session Fold plan");
      }
      expect(
        (await readEvents(storePath)).filter((event) => event.event_id.includes(result.session_fold.plan!.plan_id))
      ).toHaveLength(2);

      const resumed = await createEngine({ storePath }).applySessionFold({ plan: result.session_fold.plan });
      expect(resumed.existing_event_ids).toHaveLength(2);
      expect(resumed.created_event_ids).toHaveLength(1);
      expect(
        (await readCurrentRecords(storePath)).records.filter(
          (record) => record.kind === "session_summary" && record.visibility === "active"
        )
      ).toHaveLength(1);
    });
  });

  it("skips folding when the source has no session id", async () => {
    await withLifecycleStore(async ({ storePath, projectPath }) => {
      const result = await agentFinish(
        {
          storePath,
          projectPath,
          agent: { client: "codex", device_id: "device-a" },
          summary: "Session identity was unavailable.",
          push: false
        },
        { now: () => "2026-07-20T02:00:02.000Z" }
      );
      expect(result.session_fold).toEqual({ status: "skipped", reason: "missing_session_id" });
      expect(result.record.visibility).toBe("active");
    });
  });
});
