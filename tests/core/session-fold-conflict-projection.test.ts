import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { createEngine } from "../../src/core/engine.js";
import { buildRecordReadModel, type EventManifest } from "../../src/core/record-read-model.js";
import { buildRetrievalIndex, retrievalProjectShardName } from "../../src/core/retrieval-index.js";
import { appendEvent } from "../../src/core/store.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const projectId = "conflict-projection";
const sessionId = "shared-session";
const manifest: EventManifest = { count: 2, digest: "a".repeat(64) };

function rollup(input: {
  id: string;
  plan_id: string;
  source_digest: string;
  source_record_ids: string[];
  created_at: string;
  private?: boolean;
}): MorynRecord {
  return {
    id: input.id,
    kind: "session_summary",
    type: "session_rollup",
    scope: "project",
    project_id: projectId,
    tags: ["session-fold", `session:${sessionId}`],
    content: {
      text: `Competing rollup ${input.id}`,
      format: "json",
      session_fold_version: 1,
      session_fold_plan_id: input.plan_id,
      session_id: sessionId,
      source_digest: input.source_digest,
      source_record_ids: input.source_record_ids,
      ...(input.private ? { privacy: "private" } : {})
    },
    state: "candidate",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: input.created_at,
    updated_at: input.created_at,
    source: { client: "moryn", session_id: sessionId, device_id: "moryn-derived-v1" }
  };
}

function competingRollups(): [MorynRecord, MorynRecord] {
  return [
    rollup({
      id: "rec_session_fold_a",
      plan_id: "session_fold_a",
      source_digest: "source-digest-a",
      source_record_ids: ["shared-source", "source-a"],
      created_at: "2026-07-21T02:00:00.000Z"
    }),
    rollup({
      id: "rec_session_fold_b",
      plan_id: "session_fold_b",
      source_digest: "source-digest-b",
      source_record_ids: ["shared-source", "source-b"],
      created_at: "2026-07-21T02:00:01.000Z"
    })
  ];
}

function expectedConflict(otherRecordId: string) {
  return { kind: "semantic", with: [otherRecordId], resolution: "needs_review" } as const;
}

function expectSymmetricConflict(records: readonly MorynRecord[], firstId: string, secondId: string): void {
  expect(records.find((record) => record.id === firstId)?.conflict).toEqual(expectedConflict(secondId));
  expect(records.find((record) => record.id === secondId)?.conflict).toEqual(expectedConflict(firstId));
}

function upsertEvent(record: MorynRecord, index: number): MorynEvent {
  return {
    event_id: `evt_conflicting_rollup_${index}`,
    op: "upsert_record",
    record,
    created_at: record.created_at,
    source: record.source
  };
}

async function seedCompetingStore(storePath: string): Promise<[MorynRecord, MorynRecord]> {
  const records = competingRollups();
  await appendEvent(storePath, upsertEvent(records[0], 0));
  await appendEvent(storePath, upsertEvent(records[1], 1));
  await rebuildDerivedViews(storePath);
  return records;
}

describe("Session Fold conflict projection", () => {
  it("does not project private rollup ids across the shared privacy boundary", async () => {
    await withInitializedTempStore(async (storePath) => {
      const [publicRollup, privateBase] = competingRollups();
      const privateRollup = rollup({
        id: privateBase.id,
        plan_id: privateBase.content.session_fold_plan_id as string,
        source_digest: privateBase.content.source_digest as string,
        source_record_ids: privateBase.content.source_record_ids as string[],
        created_at: privateBase.created_at,
        private: true
      });
      await appendEvent(storePath, upsertEvent(publicRollup, 0));
      await appendEvent(storePath, upsertEvent(privateRollup, 1));
      await rebuildDerivedViews(storePath);

      const safeRecall = await createEngine({ storePath }).recall({
        project_id: projectId,
        types: ["session_rollup"],
        limit: 10
      });
      expect(safeRecall.results.map((result) => result.record.id)).toEqual([publicRollup.id]);
      expect(safeRecall.results[0]?.record.conflict).toBeUndefined();
      expect(JSON.stringify(safeRecall)).not.toContain(privateRollup.id);

      const privateRecall = await createEngine({ storePath }).recall({
        project_id: projectId,
        types: ["session_rollup"],
        include_private: true,
        limit: 10
      });
      expect(privateRecall.results.map((result) => result.record.id).sort()).toEqual(
        [publicRollup.id, privateRollup.id].sort()
      );
      expect(privateRecall.results.every((result) => result.record.conflict === undefined)).toBe(true);
    });
  });

  it("projects conflicts in pure record and retrieval builders and clears stale derived edges", () => {
    const [first, second] = competingRollups();
    const model = buildRecordReadModel([], [second, first], manifest);
    const retrieval = buildRetrievalIndex([second, first], manifest);

    expectSymmetricConflict(model.records, first.id, second.id);
    expectSymmetricConflict(retrieval.projects[projectId]!.records, first.id, second.id);

    const staleFirst = { ...first, conflict: expectedConflict(second.id) };
    const archivedSecond: MorynRecord = {
      ...second,
      state: "archived",
      visibility: "archived",
      conflict: expectedConflict(first.id)
    };
    const rebuiltModel = buildRecordReadModel([], [staleFirst, archivedSecond], manifest);
    const rebuiltRetrieval = buildRetrievalIndex([staleFirst, archivedSecond], manifest, {
      include_archived: true
    });

    expect(rebuiltModel.records.every((record) => record.conflict === undefined)).toBe(true);
    expect(rebuiltRetrieval.projects[projectId]?.records.every((record) => record.conflict === undefined)).toBe(true);
  });

  it("persists the same projection in derived records, retrieval, and legacy recall views", async () => {
    await withInitializedTempStore(async (storePath) => {
      const [first, second] = await seedCompetingStore(storePath);
      const recordsSnapshot = JSON.parse(await readFile(join(storePath, "snapshots", "records.json"), "utf8")) as {
        records: MorynRecord[];
      };
      const retrievalShard = JSON.parse(
        await readFile(
          join(storePath, "snapshots", "retrieval", "projects", retrievalProjectShardName(projectId)),
          "utf8"
        )
      ) as { records: MorynRecord[] };
      const legacyRecall = JSON.parse(await readFile(join(storePath, "indexes", "recall.json"), "utf8")) as {
        records: MorynRecord[];
      };

      expectSymmetricConflict(recordsSnapshot.records, first.id, second.id);
      expectSymmetricConflict(retrievalShard.records, first.id, second.id);
      expectSymmetricConflict(legacyRecall.records, first.id, second.id);

      await appendEvent(storePath, {
        event_id: "evt_archive_prior_rollup",
        op: "archive_record",
        record_id: second.id,
        created_at: "2026-07-21T02:00:02.000Z",
        source: { client: "moryn", device_id: "moryn-derived-v1" }
      });
      await rebuildDerivedViews(storePath);
      const rebuiltRecords = JSON.parse(await readFile(join(storePath, "snapshots", "records.json"), "utf8")) as {
        records: MorynRecord[];
      };
      const rebuiltRetrieval = JSON.parse(
        await readFile(
          join(storePath, "snapshots", "retrieval", "projects", retrievalProjectShardName(projectId)),
          "utf8"
        )
      ) as { records: MorynRecord[] };

      expect(rebuiltRecords.records.every((record) => record.conflict === undefined)).toBe(true);
      expect(rebuiltRetrieval.records).toHaveLength(1);
      expect(rebuiltRetrieval.records[0]?.id).toBe(first.id);
      expect(rebuiltRetrieval.records[0]?.conflict).toBeUndefined();
    });
  });

  it("returns competing rollups from indexed Engine recall with explicit conflict state", async () => {
    await withInitializedTempStore(async (storePath) => {
      const [first, second] = await seedCompetingStore(storePath);
      const recall = await createEngine({ storePath }).recall({
        project_id: projectId,
        types: ["session_rollup"],
        limit: 10
      });

      expect(recall.retrieval).toMatchObject({ source: "retrieval_index", candidate_count: 2 });
      expect(recall.results.map((result) => result.record.id).sort()).toEqual([first.id, second.id]);
      expectSymmetricConflict(
        recall.results.map((result) => result.record),
        first.id,
        second.id
      );
    });
  });
});
