import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAutomaticEpisodeRollups } from "../../src/core/automatic-episode-rollup.js";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
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
});
