import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { buildMemoryRetentionView } from "../../src/core/memory-retention.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { replayEvents } from "../../src/core/replay.js";
import { planSessionFold } from "../../src/core/session-fold.js";
import { detectSessionFoldConflicts } from "../../src/core/session-fold-conflicts.js";
import { applySessionFoldPlan, buildSessionFoldEvents } from "../../src/core/session-fold-transaction.js";
import { readEvents } from "../../src/core/store.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";
import { getPendingSyncEvidence, initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);
const projectId = "compaction-git-concurrency";
const sessionId = "shared-closed-session";

interface GitFixture {
  root: string;
  remote: string;
  storeA: string;
  storeB: string;
}

async function createGitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "moryn-compaction-git-"));
  const remote = join(root, "remote.git");
  const storeA = join(root, "device-a");
  const storeB = join(root, "device-b");
  try {
    await exec("git", ["init", "--bare", remote]);
    await initializeStore(storeA, {
      now: () => "2026-07-21T00:00:00.000Z",
      id: () => "device-a"
    });
    await initializeStore(storeB, {
      now: () => "2026-07-21T00:00:00.000Z",
      id: () => "device-b"
    });
    await initializeGitSync(storeA, remote);
    await initializeGitSync(storeB, remote);
    return { root, remote, storeA, storeB };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function writeCheckpoint(
  storePath: string,
  input: { device_id: string; checkpoint_id: string; occurred_at: string; changed_fact: string }
): Promise<MorynRecord> {
  const result = await createEngine({ storePath }).checkpoint({
    project_id: projectId,
    source: { client: "codex", session_id: sessionId, device_id: input.device_id },
    occurred_at: input.occurred_at,
    delta: {
      session_id: sessionId,
      checkpoint_id: input.checkpoint_id,
      current_task: "Verify Git-concurrent Session Fold",
      blockers: [],
      decisions: ["Use deterministic compaction identities"],
      changed_facts: [input.changed_fact],
      next_steps: ["Fold the closed session"],
      files: ["tests/e2e/compaction-git-concurrency.test.ts"]
    }
  });
  return result.record;
}

async function writeFinalSummary(
  storePath: string,
  input: { device_id: string; occurred_at: string; text: string }
): Promise<MorynRecord> {
  const engine = createEngine({ storePath, now: () => input.occurred_at });
  const preview = await engine.previewSessionFold({
    project_id: projectId,
    session_id: sessionId,
    proposed_final_text: input.text
  });
  const result = await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: projectId,
    content: { text: input.text, session_fold_coverage: preview.coverage },
    source: { client: "codex", session_id: sessionId, device_id: input.device_id }
  });
  return result.record;
}

function eventOrder(left: MorynEvent, right: MorynEvent): number {
  return left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id);
}

async function remoteEvents(remote: string): Promise<MorynEvent[]> {
  const { stdout } = await exec("git", [
    "--git-dir",
    remote,
    "ls-tree",
    "-r",
    "--name-only",
    "refs/heads/main",
    "--",
    "events"
  ]);
  const paths = stdout
    .split(/\r?\n/u)
    .map((path) => path.trim())
    .filter((path) => path.endsWith(".json"));
  return (
    await Promise.all(
      paths.map(async (path) => {
        const content = await exec("git", ["--git-dir", remote, "show", `refs/heads/main:${path}`]);
        const event = JSON.parse(content.stdout) as MorynEvent;
        expect(basename(path, ".json")).toBe(event.event_id);
        return event;
      })
    )
  ).sort(eventOrder);
}

function activeSessionRollups(records: readonly MorynRecord[]): MorynRecord[] {
  return records.filter(
    (record) =>
      record.project_id === projectId &&
      record.type === "session_rollup" &&
      record.content.session_id === sessionId &&
      record.state !== "archived" &&
      record.visibility === "active"
  );
}

function expectOneColdFold(records: readonly MorynRecord[], sourceRecordIds: readonly string[]): void {
  const rollups = activeSessionRollups(records);
  expect(rollups).toHaveLength(1);
  expect(rollups[0]?.conflict).toBeUndefined();
  for (const recordId of sourceRecordIds) {
    const source = records.find((record) => record.id === recordId);
    expect(source).toMatchObject({ state: "archived", visibility: "archived" });
    expect(buildMemoryRetentionView(source!).retention.tier).toBe("cold");
  }
}

describe("Session Fold through concurrent Git devices", () => {
  it("converges identical offline plans to one logical rollup without event collisions", async () => {
    const fixture = await createGitFixture();
    try {
      await writeCheckpoint(fixture.storeA, {
        device_id: "device-a",
        checkpoint_id: "shared-checkpoint",
        occurred_at: "2026-07-21T00:01:00.000Z",
        changed_fact: "Both devices received the same checkpoint evidence"
      });
      await writeFinalSummary(fixture.storeA, {
        device_id: "device-a",
        occurred_at: "2026-07-21T00:02:00.000Z",
        text: "The shared closed session is complete."
      });
      await pushGitSync(fixture.storeA, { message: "share closed-session evidence" });
      await pullGitSync(fixture.storeB);

      const identity = { project_id: projectId, session_id: sessionId };
      const planA = planSessionFold((await readCurrentRecords(fixture.storeA)).records, identity)!;
      const planB = planSessionFold((await readCurrentRecords(fixture.storeB)).records, identity)!;
      expect(planA).toEqual(planB);
      expect(planA).toMatchObject({ status: "ready", auto_fold: true, closed: true });
      expect(buildSessionFoldEvents(planA)).toEqual(buildSessionFoldEvents(planB));

      const [appliedA, appliedB] = await Promise.all([
        applySessionFoldPlan(fixture.storeA, planA),
        applySessionFoldPlan(fixture.storeB, planB)
      ]);
      expect(appliedA.created_event_ids).toEqual(appliedB.created_event_ids);
      expect(appliedA.receipt.event_ids).toEqual(appliedB.receipt.event_ids);

      await expect(pushGitSync(fixture.storeA, { message: "fold shared session on device A" })).resolves.toMatchObject({
        committed: true,
        pushed: true
      });
      await expect(pushGitSync(fixture.storeB, { message: "fold shared session on device B" })).resolves.toMatchObject({
        committed: true,
        pushed: true
      });
      await expect(pullGitSync(fixture.storeA)).resolves.toMatchObject({ pulled: true });

      const eventsA = await readEvents(fixture.storeA);
      const eventsB = await readEvents(fixture.storeB);
      const eventsRemote = await remoteEvents(fixture.remote);
      expect(eventsA).toEqual(eventsRemote);
      expect(eventsB).toEqual(eventsRemote);
      expect(new Set(eventsRemote.map((event) => event.event_id)).size).toBe(eventsRemote.length);
      for (const eventId of appliedA.receipt.event_ids) {
        expect(eventsRemote.filter((event) => event.event_id === eventId)).toHaveLength(1);
      }
      expect(
        eventsRemote.filter((event) => event.op === "upsert_record" && event.record.type === "session_rollup")
      ).toHaveLength(1);

      const recordsA = (await readCurrentRecords(fixture.storeA)).records;
      const recordsB = (await readCurrentRecords(fixture.storeB)).records;
      const recordsRemote = [...replayEvents(eventsRemote).values()];
      for (const records of [recordsA, recordsB, recordsRemote]) {
        expectOneColdFold(records, planA.source_record_ids);
      }

      for (const [storePath, plan] of [
        [fixture.storeA, planA],
        [fixture.storeB, planB]
      ] as const) {
        const before = await readEvents(storePath);
        const retry = await applySessionFoldPlan(storePath, plan);
        expect(retry.created_event_ids).toEqual([]);
        expect(retry.existing_event_ids).toEqual(appliedA.receipt.event_ids);
        expect(await readEvents(storePath)).toEqual(before);
        expect(await getPendingSyncEvidence(storePath)).toEqual({ paths: [], events: [] });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a review-required conflict when divergent offline plans merge", async () => {
    const fixture = await createGitFixture();
    try {
      const sharedBase = await writeCheckpoint(fixture.storeA, {
        device_id: "device-a",
        checkpoint_id: "shared-base",
        occurred_at: "2026-07-21T01:00:00.000Z",
        changed_fact: "Both devices share the same base evidence"
      });
      await pushGitSync(fixture.storeA, { message: "share open-session evidence" });
      await pullGitSync(fixture.storeB);

      await writeCheckpoint(fixture.storeA, {
        device_id: "device-a",
        checkpoint_id: "branch-a",
        occurred_at: "2026-07-21T01:01:00.000Z",
        changed_fact: "Device A added independent evidence"
      });
      await writeCheckpoint(fixture.storeB, {
        device_id: "device-b",
        checkpoint_id: "branch-b",
        occurred_at: "2026-07-21T01:01:30.000Z",
        changed_fact: "Device B added independent evidence"
      });
      await writeFinalSummary(fixture.storeA, {
        device_id: "device-a",
        occurred_at: "2026-07-21T01:02:00.000Z",
        text: "Device A completed its offline view of the session."
      });
      await writeFinalSummary(fixture.storeB, {
        device_id: "device-b",
        occurred_at: "2026-07-21T01:02:30.000Z",
        text: "Device B completed its offline view of the session."
      });

      const identity = { project_id: projectId, session_id: sessionId };
      const planA = planSessionFold((await readCurrentRecords(fixture.storeA)).records, identity)!;
      const planB = planSessionFold((await readCurrentRecords(fixture.storeB)).records, identity)!;
      expect(planA).toMatchObject({ status: "ready", auto_fold: true });
      expect(planB).toMatchObject({ status: "ready", auto_fold: true });
      expect(planA.plan_id).not.toBe(planB.plan_id);
      expect(planA.rollup_record?.id).not.toBe(planB.rollup_record?.id);
      await applySessionFoldPlan(fixture.storeA, planA);
      await applySessionFoldPlan(fixture.storeB, planB);

      await expect(
        pushGitSync(fixture.storeA, { message: "fold divergent session on device A" })
      ).resolves.toMatchObject({ committed: true, pushed: true });
      await expect(
        pushGitSync(fixture.storeB, { message: "fold divergent session on device B" })
      ).resolves.toMatchObject({ committed: true, pushed: true });
      await expect(pullGitSync(fixture.storeA)).resolves.toMatchObject({ pulled: true });

      const eventsRemote = await remoteEvents(fixture.remote);
      expect(new Set(eventsRemote.map((event) => event.event_id)).size).toBe(eventsRemote.length);
      const remoteRecords = [...replayEvents(eventsRemote).values()];
      expect(activeSessionRollups(remoteRecords)).toHaveLength(2);

      const expectedRollupIds = [planA.rollup_record!.id, planB.rollup_record!.id].sort();
      const expectedPlanIds = [planA.plan_id, planB.plan_id].sort();
      const expectedSourceDigests = [planA.source_digest, planB.source_digest].sort();
      const conflictPlans = [];
      for (const storePath of [fixture.storeA, fixture.storeB]) {
        const read = await readCurrentRecords(storePath);
        const rollups = activeSessionRollups(read.records);
        expect(rollups.map((record) => record.id).sort()).toEqual(expectedRollupIds);
        for (const rollup of rollups) {
          expect(rollup.conflict).toEqual({
            kind: "semantic",
            with: expectedRollupIds.filter((recordId) => recordId !== rollup.id),
            resolution: "needs_review"
          });
        }
        expect(read.session_fold_conflicts).toEqual([
          {
            version: 1,
            kind: "competing_session_rollups",
            identity,
            resolution: "needs_review",
            rollup_record_ids: expectedRollupIds,
            plan_ids: expectedPlanIds,
            source_digests: expectedSourceDigests,
            overlapping_source_record_ids: [sharedBase.id]
          }
        ]);
        const conflictPlan = planSessionFold(read.records, identity)!;
        conflictPlans.push(conflictPlan);
        expect(conflictPlan).toMatchObject({
          identity,
          status: "review_required",
          auto_fold: false,
          proposed_active_target_record_ids: [],
          review_reasons: expect.arrayContaining([
            {
              code: "unresolved_conflict",
              message: expect.any(String),
              record_ids: expectedRollupIds
            }
          ])
        });
        expect([...conflictPlan.source_record_ids].sort()).toEqual(expectedRollupIds);
        expect(conflictPlan.rollup_record).toBeUndefined();
        expect(await createEngine({ storePath }).planSessionFold(identity)).toEqual(conflictPlan);
      }
      expect(conflictPlans[0]).toEqual(conflictPlans[1]);
      expect(planSessionFold(remoteRecords, identity)).toEqual(conflictPlans[0]);

      const mismatchedIdentity = remoteRecords.map((record) =>
        record.id === expectedRollupIds[0]
          ? { ...record, source: { ...record.source, session_id: "mismatched-session" } }
          : record
      );
      expect(detectSessionFoldConflicts(mismatchedIdentity)).toEqual([]);
      expect(planSessionFold(mismatchedIdentity, identity)).toBeUndefined();

      const archivedPriorRollup = remoteRecords.map((record) =>
        record.id === expectedRollupIds[0]
          ? { ...record, state: "archived" as const, visibility: "archived" as const }
          : record
      );
      expect(detectSessionFoldConflicts(archivedPriorRollup)).toEqual([]);
      expect(planSessionFold(archivedPriorRollup, identity)).toBeUndefined();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
