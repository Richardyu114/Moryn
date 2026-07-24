import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAutomaticEpisodeRollups } from "../../src/core/automatic-episode-rollup.js";
import { readAutomaticEpisodeRollupRecoveryPlans } from "../../src/core/automatic-episode-rollup-recovery.js";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { applyEpisodeRollupPlan } from "../../src/core/episode-rollup-transaction.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import type { MorynRecord } from "../../src/core/types.js";

async function withStore(run: (storePath: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "moryn-automatic-episode-rollup-"));
  const storePath = join(root, "store");
  try {
    await initializeStore(storePath, { id: () => "device-a" });
    await run(storePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sessionRollup(id: string, tags: string[]): MorynRecord {
  const leafId = `leaf-${id}`;
  const leafDigest = (id === "private" ? "b" : "a").repeat(64);
  return {
    id,
    kind: "session_summary",
    type: "session_rollup",
    scope: "project",
    project_id: "moryn",
    tags,
    content: {
      text: `Verified ${id} session`,
      format: "json",
      session_fold_version: 1,
      closed_at: "2026-07-01T12:00:00.000Z",
      source_record_ids: [leafId],
      source_digests: [{ record_id: leafId, digest: leafDigest }]
    },
    state: "candidate",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-01T12:00:00.000Z",
    updated_at: "2026-07-01T12:00:00.000Z",
    source: { client: "moryn", session_id: `session-${id}`, device_id: "device-a" },
    provenance: { derived_from: [leafId], method: "rule-promoted" }
  };
}

describe("automatic Episode Rollup", () => {
  it.each(["", "   "])("fails closed on an empty project id %#", async (projectId) => {
    await withStore(async (storePath) => {
      const before = await readEvents(storePath);
      const result = await runAutomaticEpisodeRollups({
        store_path: storePath,
        project_id: projectId,
        now: "2026-07-20T00:00:00.000Z"
      });

      expect(result).toMatchObject({
        status: "failed",
        inspected_plan_count: 0,
        eligible_plan_count: 0,
        committed: [],
        failures: [{ stage: "plan", reason: "Automatic Episode Rollup requires project_id as a non-empty string" }]
      });
      expect(await readEvents(storePath)).toEqual(before);
    });
  });

  it("normalizes the project id before filtering, planning, and applying", async () => {
    await withStore(async (storePath) => {
      let appliedProjectId: string | undefined;
      const otherProject = { ...sessionRollup("other", []), project_id: "other" };
      const result = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "  moryn  ",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          read_records: async () => ({
            records: [sessionRollup("public", []), otherProject],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          apply_plan: async (_path, plan) => {
            appliedProjectId = plan.identity.project_id;
            throw new Error("stop after normalized planning");
          }
        }
      );

      expect(appliedProjectId).toBe("moryn");
      expect(result).toMatchObject({
        status: "failed",
        inspected_plan_count: 1,
        eligible_plan_count: 1,
        committed: [],
        failures: [{ stage: "apply", reason: "stop after normalized planning" }]
      });
    });
  });

  it("returns an explicit planning failure instead of mutating on invalid policy input", async () => {
    await withStore(async (storePath) => {
      const result = await runAutomaticEpisodeRollups({
        store_path: storePath,
        project_id: "moryn",
        now: "not-a-canonical-time"
      });

      expect(result).toMatchObject({
        status: "failed",
        eligible_plan_count: 0,
        committed: [],
        failures: [{ stage: "plan", reason: "Episode Rollup requires now as a canonical ISO timestamp" }]
      });
      expect(await readEvents(storePath)).toEqual([]);
    });
  });

  it("does not apply when durable recovery-plan publication fails", async () => {
    await withStore(async (storePath) => {
      let applyCalled = false;
      const result = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          read_records: async () => ({
            records: [sessionRollup("durability-gated", [])],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          persist_recovery_plan: async () => {
            throw new Error("injected recovery directory sync failure");
          },
          apply_plan: async () => {
            applyCalled = true;
            throw new Error("apply must remain gated by durable plan publication");
          }
        }
      );

      expect(result).toMatchObject({
        status: "failed",
        pending_recovery_plan_count: 0,
        committed: [],
        failures: [{ stage: "persist", reason: "injected recovery directory sync failure" }]
      });
      expect(applyCalled).toBe(false);
      expect(await readEvents(storePath)).toEqual([]);
    });
  });

  it("does not inspect or mutate private rollup payloads without explicit authorization", async () => {
    await withStore(async (storePath) => {
      await createEngine({ storePath, now: () => "2026-07-01T00:00:00.000Z" }).write({
        kind: "session_summary",
        type: "session_rollup",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private closed-session payload." },
        source: { client: "moryn", session_id: "private-session", device_id: "device-a" }
      });
      const before = await readEvents(storePath);

      const result = await runAutomaticEpisodeRollups({
        store_path: storePath,
        project_id: "moryn",
        now: "2026-07-20T00:00:00.000Z"
      });

      expect(result).toMatchObject({
        status: "skipped",
        inspected_plan_count: 0,
        eligible_plan_count: 0,
        omitted_private_record_count: 1,
        committed: [],
        failures: []
      });
      expect(await readEvents(storePath)).toEqual(before);
    });
  });

  it("does not create a partial public day rollup when the same bucket contains omitted private evidence", async () => {
    await withStore(async (storePath) => {
      let applyCalled = false;
      const result = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          read_records: async () => ({
            records: [sessionRollup("public", []), sessionRollup("private", ["private"])],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          apply_plan: async () => {
            applyCalled = true;
            throw new Error("privacy-blocked plan must not be applied");
          }
        }
      );

      expect(result).toMatchObject({
        status: "skipped",
        inspected_plan_count: 1,
        eligible_plan_count: 0,
        review_required_plan_count: 1,
        privacy_blocked_plan_count: 1,
        omitted_private_record_count: 1,
        committed: [],
        failures: []
      });
      expect(applyCalled).toBe(false);
    });
  });

  it("persists a complete plan before apply and resumes a partial transaction on the next lifecycle run", async () => {
    await withStore(async (storePath) => {
      const source = sessionRollup("recoverable", []);
      await appendEventIfAbsent(storePath, {
        event_id: "evt_seed_recoverable_session_rollup",
        op: "upsert_record",
        record: source,
        created_at: source.created_at,
        source: source.source
      });

      let appendAttempts = 0;
      let persistedPlanId: string | undefined;
      const failed = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          apply_plan: async (path, plan) => {
            persistedPlanId = (await readAutomaticEpisodeRollupRecoveryPlans(path, "moryn"))[0]?.plan.plan_id;
            return applyEpisodeRollupPlan(path, plan, {
              append_event: async (eventStorePath, event) => {
                appendAttempts += 1;
                if (appendAttempts === 2) throw new Error("injected automatic archive failure");
                return appendEventIfAbsent(eventStorePath, event);
              }
            });
          }
        }
      );

      expect(failed).toMatchObject({
        status: "failed",
        recovery_attempted_plan_count: 0,
        recovered_plan_count: 0,
        pending_recovery_plan_count: 1,
        failures: [
          {
            stage: "apply",
            reason: "injected automatic archive failure",
            plan_id: expect.stringMatching(/^episode_rollup_/u)
          }
        ]
      });
      expect(persistedPlanId).toBe(failed.failures[0]?.plan_id);
      const pending = await readAutomaticEpisodeRollupRecoveryPlans(storePath, "moryn");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.plan).toEqual(
        expect.objectContaining({
          plan_id: failed.failures[0]?.plan_id,
          status: "ready",
          auto_rollup: true,
          privacy_boundary: "public",
          rollup_record: expect.any(Object)
        })
      );
      const recoveryFile = await recoveryPlanFile(storePath, "public");
      expect((await stat(recoveryFile.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(recoveryFile.path)).mode & 0o777).toBe(0o600);
      expect((await readCurrentRecords(storePath)).records.find((record) => record.id === source.id)).toMatchObject({
        state: "candidate",
        visibility: "active"
      });

      const resumed = await runAutomaticEpisodeRollups({
        store_path: storePath,
        project_id: "moryn",
        now: "2026-07-20T00:00:00.000Z"
      });

      expect(resumed).toMatchObject({
        status: "committed",
        recovery_attempted_plan_count: 1,
        recovered_plan_count: 1,
        pending_recovery_plan_count: 0,
        committed: [{ recovered: true, plan: { plan_id: failed.failures[0]?.plan_id } }],
        failures: []
      });
      expect(await readAutomaticEpisodeRollupRecoveryPlans(storePath, "moryn")).toEqual([]);
      expect((await readCurrentRecords(storePath)).records.find((record) => record.id === source.id)).toMatchObject({
        state: "archived",
        visibility: "archived"
      });
      expect(
        (await readEvents(storePath)).filter((event) => event.event_id === `evt_${failed.failures[0]?.plan_id}_rollup`)
      ).toHaveLength(1);
    });
  });

  it("keeps a stale recovery plan pending and blocks a replacement plan for the same bucket", async () => {
    await withStore(async (storePath) => {
      const firstSource = sessionRollup("stale-recovery-a", []);
      await appendEventIfAbsent(storePath, {
        event_id: "evt_seed_stale_recovery_a",
        op: "upsert_record",
        record: firstSource,
        created_at: firstSource.created_at,
        source: firstSource.source
      });
      await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          apply_plan: async () => {
            throw new Error("leave original plan pending");
          }
        }
      );

      const secondSource = sessionRollup("stale-recovery-b", []);
      await appendEventIfAbsent(storePath, {
        event_id: "evt_seed_stale_recovery_b",
        op: "upsert_record",
        record: secondSource,
        created_at: sourceTimestampAfter(firstSource.created_at),
        source: secondSource.source
      });

      const result = await runAutomaticEpisodeRollups({
        store_path: storePath,
        project_id: "moryn",
        now: "2026-07-20T00:00:00.000Z"
      });

      expect(result).toMatchObject({
        status: "failed",
        eligible_plan_count: 1,
        review_required_plan_count: 1,
        recovery_attempted_plan_count: 1,
        recovered_plan_count: 0,
        pending_recovery_plan_count: 1,
        committed: [],
        failures: [
          {
            stage: "apply",
            reason: expect.stringContaining("Stale Episode Rollup plan"),
            recovery: true
          }
        ]
      });
      expect((await readEvents(storePath)).filter((event) => event.event_id.startsWith("evt_episode_rollup_"))).toEqual(
        []
      );
      expect(
        (await readCurrentRecords(storePath)).records
          .filter((record) => [firstSource.id, secondSource.id].includes(record.id))
          .every((record) => record.visibility === "active")
      ).toBe(true);
    });
  });

  it("fails closed when a persisted recovery artifact cannot be read", async () => {
    await withStore(async (storePath) => {
      await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          read_records: async () => ({
            records: [sessionRollup("corrupt-recovery", [])],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          apply_plan: async () => {
            throw new Error("leave recovery plan pending");
          }
        }
      );
      const recoveryFile = await recoveryPlanFile(storePath, "public");
      await writeFile(recoveryFile.path, "{", "utf8");
      let applyCalled = false;

      const result = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          apply_plan: async () => {
            applyCalled = true;
            throw new Error("corrupt recovery must not apply");
          }
        }
      );

      expect(result).toMatchObject({
        status: "failed",
        inspected_plan_count: 0,
        eligible_plan_count: 0,
        recovery_attempted_plan_count: 0,
        committed: [],
        failures: [{ stage: "plan", reason: expect.stringContaining("JSON") }]
      });
      expect(applyCalled).toBe(false);
    });
  });

  it("does not read or resume a private recovery plan without renewed explicit authorization", async () => {
    await withStore(async (storePath) => {
      const privateSource = sessionRollup("private", ["private"]);
      const failed = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z",
          include_private: true
        },
        {
          read_records: async () => ({
            records: [privateSource],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          apply_plan: async () => {
            throw new Error("leave private recovery plan pending");
          }
        }
      );
      expect(failed).toMatchObject({ status: "failed", pending_recovery_plan_count: 1 });
      expect(await readAutomaticEpisodeRollupRecoveryPlans(storePath, "moryn")).toEqual([]);
      expect(await readAutomaticEpisodeRollupRecoveryPlans(storePath, "moryn", { include_private: true })).toHaveLength(
        1
      );

      let defaultApplyCalled = false;
      const withoutAuthorization = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z"
        },
        {
          read_records: async () => ({
            records: [],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          apply_plan: async () => {
            defaultApplyCalled = true;
            throw new Error("private recovery must remain hidden");
          }
        }
      );
      expect(withoutAuthorization).toMatchObject({
        status: "skipped",
        recovery_attempted_plan_count: 0,
        pending_recovery_plan_count: 0,
        omitted_private_recovery_plan_count: 1,
        failures: []
      });
      expect(defaultApplyCalled).toBe(false);

      const withAuthorization = await runAutomaticEpisodeRollups(
        {
          store_path: storePath,
          project_id: "moryn",
          now: "2026-07-20T00:00:00.000Z",
          include_private: true
        },
        {
          read_records: async () => ({
            records: [],
            source: "event_replay",
            repaired: false,
            event_manifest: { count: 0, digest: "fixture" }
          }),
          apply_plan: async () => {
            throw new Error("authorized private recovery attempted");
          }
        }
      );
      expect(withAuthorization).toMatchObject({
        status: "failed",
        recovery_attempted_plan_count: 1,
        pending_recovery_plan_count: 1,
        failures: [{ stage: "apply", reason: "authorized private recovery attempted", recovery: true }]
      });
    });
  });
});

function sourceTimestampAfter(value: string): string {
  return new Date(Date.parse(value) + 1).toISOString();
}

async function recoveryPlanFile(storePath: string, privacy: "public" | "private") {
  const recoveryRoot = join(storePath, "state", "automatic-episode-rollup");
  const [projectDirectory] = await readdir(recoveryRoot);
  const directory = join(recoveryRoot, projectDirectory!, privacy);
  const [planFile] = await readdir(directory);
  return { directory, path: join(directory, planFile!) };
}
