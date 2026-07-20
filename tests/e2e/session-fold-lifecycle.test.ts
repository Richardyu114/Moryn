import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFinish } from "../../src/core/agent-lifecycle.js";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
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

async function writeVerifiedCheckpoint(storePath: string) {
  await createEngine({ storePath }).checkpoint({
    project_id: "moryn",
    source,
    occurred_at: "2026-07-20T02:00:01.000Z",
    delta: {
      session_id: source.session_id,
      checkpoint_id: "verified-finish",
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
      let attempts = 0;
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
                attempts += 1;
                if (attempts === 3) throw new Error("injected fold append failure");
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
