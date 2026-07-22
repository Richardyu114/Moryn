import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { buildSessionFoldCoverageAttestation, planSessionFold } from "../../src/core/session-fold.js";
import {
  applySessionFoldPlan,
  buildSessionFoldEvents,
  readSessionFoldReceipt
} from "../../src/core/session-fold-transaction.js";
import { appendEvent, appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

function clock(values: string[]): () => string {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

async function sessionRecords(storePath: string) {
  const now = clock(["2026-07-20T00:00:01.000Z", "2026-07-20T00:00:03.000Z"]);
  const engine = createEngine({ storePath, now });
  const source = { client: "codex", session_id: "session-a", device_id: "device-a" };
  await engine.write({
    kind: "session_summary",
    type: "status",
    scope: "project",
    project_id: "moryn",
    content: { text: "Working", decisions: ["Use deterministic transactions"] },
    source
  });
  await engine.checkpoint({
    project_id: "moryn",
    source,
    occurred_at: "2026-07-20T00:00:02.000Z",
    delta: {
      session_id: "session-a",
      checkpoint_id: "checkpoint-a",
      current_task: "Apply the Session Fold",
      blockers: [],
      decisions: ["Use deterministic transactions"],
      changed_facts: ["The plan is resumable"],
      next_steps: ["Apply the fold"],
      files: ["src/core/session-fold-transaction.ts"]
    },
    tags: []
  });
  const finalText = "Working. Session complete";
  const preview = await engine.previewSessionFold({
    project_id: "moryn",
    session_id: "session-a",
    proposed_final_text: finalText
  });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: "moryn",
    content: {
      text: finalText,
      synthesis_blockers: [],
      synthesis_next_steps: ["Monitor rollout"],
      session_fold_coverage: preview.coverage
    },
    source
  });
  return (await readCurrentRecords(storePath)).records;
}

function attestRecords(records: Awaited<ReturnType<typeof sessionRecords>>) {
  const final = records.find((record) => record.type === "summary")!;
  const coverage = buildSessionFoldCoverageAttestation(
    records.filter((record) => record.id !== final.id),
    { project_id: "moryn", session_id: "session-a" },
    String(final.content.text)
  );
  return records.map((record) =>
    record.id === final.id ? { ...record, content: { ...record.content, session_fold_coverage: coverage } } : record
  );
}

describe("Session Fold transaction", () => {
  it("commits one rollup before archiving all covered sources", async () => {
    await withInitializedTempStore(async (storePath) => {
      const records = await sessionRecords(storePath);
      const plan = planSessionFold(records, { project_id: "moryn", session_id: "session-a" })!;
      const expected = buildSessionFoldEvents(plan);
      expect(expected[0]).toMatchObject({ op: "upsert_record", record: { id: plan.rollup_record?.id } });
      expect(expected.slice(1).every((event) => event.op === "archive_record")).toBe(true);

      const result = await applySessionFoldPlan(storePath, plan);
      expect(result.created_event_ids).toHaveLength(4);
      expect(result.existing_event_ids).toEqual([]);
      expect(result.receipt).toMatchObject({
        status: "committed",
        plan_id: plan.plan_id,
        rollup_record_id: plan.rollup_record?.id,
        source_record_ids: expect.arrayContaining(plan.source_record_ids),
        integrity_digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });

      const current = (await readCurrentRecords(storePath)).records;
      const rollup = current.find((record) => record.id === plan.rollup_record?.id);
      expect(rollup).toMatchObject({ type: "session_rollup", state: "candidate", visibility: "active" });
      for (const sourceId of plan.source_record_ids) {
        expect(current.find((record) => record.id === sourceId)).toMatchObject({
          state: "archived",
          visibility: "archived"
        });
      }
      expect(await readSessionFoldReceipt(storePath, plan.plan_id)).toEqual(result.receipt);
    });
  });

  it("uses deterministic path-safe archive identities and strictly ordered timestamps", async () => {
    await withInitializedTempStore(async (storePath) => {
      const records = attestRecords(
        (await sessionRecords(storePath)).map((record) => ({
          ...record,
          id:
            record.type === "status"
              ? "rec/status/unsafe"
              : record.type === "checkpoint"
                ? "rec\\checkpoint\\unsafe"
                : "rec-summary-unsafe"
        }))
      );
      const plan = planSessionFold(records, { project_id: "moryn", session_id: "session-a" })!;
      const events = buildSessionFoldEvents(plan);
      const rebuilt = buildSessionFoldEvents(
        planSessionFold([...records].reverse(), { project_id: "moryn", session_id: "session-a" })!
      );

      expect(rebuilt).toEqual(events);
      for (const event of events.slice(1)) {
        expect(event.event_id).toMatch(/^evt_session_fold_[a-f0-9]{32}_archive_[a-f0-9]{64}$/u);
      }
      expect(events.slice(1).every((event) => !/[/\\\0]/u.test(event.event_id))).toBe(true);
      expect(new Set(events.map((event) => event.event_id)).size).toBe(events.length);
      for (let index = 1; index < events.length; index += 1) {
        expect(Date.parse(events[index]!.created_at)).toBeGreaterThan(Date.parse(events[index - 1]!.created_at));
      }
    });
  });

  it("is idempotent when the same committed plan is applied again", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const first = await applySessionFoldPlan(storePath, plan);
      const eventCount = (await readEvents(storePath)).length;
      const second = await applySessionFoldPlan(storePath, plan);

      expect(second.created_event_ids).toEqual([]);
      expect(second.existing_event_ids).toEqual(first.receipt.event_ids);
      expect((await readEvents(storePath)).length).toBe(eventCount);
      expect(second.receipt).toEqual(first.receipt);
    });
  });

  it("serializes concurrent retries of the same plan into one committed transaction", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      let markFirstAppendStarted!: () => void;
      const firstAppendStarted = new Promise<void>((resolve) => {
        markFirstAppendStarted = resolve;
      });
      let releaseFirstAppend!: () => void;
      const firstAppendRelease = new Promise<void>((resolve) => {
        releaseFirstAppend = resolve;
      });
      let firstAppend = true;
      const firstApply = applySessionFoldPlan(storePath, plan, {
        append_event: async (path, event) => {
          if (firstAppend) {
            firstAppend = false;
            markFirstAppendStarted();
            await firstAppendRelease;
          }
          return appendEventIfAbsent(path, event);
        }
      });
      await firstAppendStarted;

      let competingAppendCount = 0;
      const concurrentRetry = applySessionFoldPlan(storePath, plan, {
        append_event: async (path, event) => {
          competingAppendCount += 1;
          return appendEventIfAbsent(path, event);
        }
      });
      try {
        await delay(50);
        expect(competingAppendCount).toBe(0);
      } finally {
        releaseFirstAppend();
      }

      const [committed, retried] = await Promise.all([firstApply, concurrentRetry]);
      expect(committed.created_event_ids).toEqual(committed.receipt.event_ids);
      expect(retried.created_event_ids).toEqual([]);
      expect(retried.existing_event_ids).toEqual(committed.receipt.event_ids);
      expect(retried.receipt).toEqual(committed.receipt);
      expect(competingAppendCount).toBe(0);
      expect((await readEvents(storePath)).filter((event) => event.event_id.includes(plan.plan_id))).toHaveLength(
        committed.receipt.event_ids.length
      );
    });
  });

  it("attests best-effort publication separately from confirmed and existing readback events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const result = await applySessionFoldPlan(storePath, plan, {
        append_event: async (path, event) => {
          const appended = await appendEventIfAbsent(path, event);
          return event.op === "upsert_record" ? { ...appended, durability: "best_effort" as const } : appended;
        }
      });

      expect(result.receipt.durability).toEqual({
        confirmed_event_ids: result.receipt.event_ids.slice(1),
        best_effort_event_ids: [result.receipt.event_ids[0]],
        existing_readback_event_ids: [],
        all_events_read_back: true
      });
      expect(await readSessionFoldReceipt(storePath, plan.plan_id)).toEqual(result.receipt);
    });
  });

  it("rejects a stale plan before publishing any fold event", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const engine = createEngine({ storePath, now: () => "2026-07-20T00:00:04.000Z" });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Late update" },
        source: { client: "codex", session_id: "session-a", device_id: "device-a" }
      });

      await expect(applySessionFoldPlan(storePath, plan)).rejects.toThrow("Stale Session Fold plan");
      expect((await readEvents(storePath)).some((event) => event.event_id.includes(plan.plan_id))).toBe(false);
    });
  });

  it("resumes after a mid-transaction append failure without losing source meaning", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      let attempts = 0;
      await expect(
        applySessionFoldPlan(storePath, plan, {
          append_event: async (path, event) => {
            attempts += 1;
            if (attempts === 3) throw new Error("injected append failure");
            return appendEventIfAbsent(path, event);
          }
        })
      ).rejects.toThrow("injected append failure");

      const partial = await readEvents(storePath);
      expect(partial.filter((event) => event.event_id.includes(plan.plan_id))).toHaveLength(2);
      const resumed = await applySessionFoldPlan(storePath, plan);
      expect(resumed.created_event_ids).toHaveLength(2);
      expect(resumed.existing_event_ids).toHaveLength(2);
      const current = (await readCurrentRecords(storePath)).records;
      expect(current.find((record) => record.id === plan.rollup_record?.id)?.content).toMatchObject({
        text: "Working. Session complete",
        decisions: ["Use deterministic transactions"],
        changed_facts: ["The plan is resumable"]
      });
    });
  });

  it("rechecks source freshness while resuming a partial transaction", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      let attempts = 0;
      await expect(
        applySessionFoldPlan(storePath, plan, {
          append_event: async (path, event) => {
            attempts += 1;
            if (attempts === 3) throw new Error("injected append failure");
            return appendEventIfAbsent(path, event);
          }
        })
      ).rejects.toThrow("injected append failure");

      const engine = createEngine({ storePath, now: () => "2026-07-20T00:00:06.000Z" });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Evidence added after the interrupted fold" },
        source: { client: "codex", session_id: "session-a", device_id: "device-a" }
      });

      await expect(applySessionFoldPlan(storePath, plan)).rejects.toThrow("Stale Session Fold plan");
      expect((await readEvents(storePath)).filter((event) => event.event_id.includes(plan.plan_id))).toHaveLength(2);
    });
  });

  it("resumes from a matching event stored through the legacy event layout without duplicating it", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const expected = buildSessionFoldEvents(plan);
      await appendEvent(storePath, expected[0]!);

      const result = await applySessionFoldPlan(storePath, plan);
      expect(result.existing_event_ids).toEqual([expected[0]!.event_id]);
      expect(result.created_event_ids).toEqual(expected.slice(1).map((event) => event.event_id));
      expect((await readEvents(storePath)).filter((event) => event.event_id === expected[0]!.event_id)).toHaveLength(1);
    });
  });

  it("does not archive sources after a newly published rollup reports failed durability", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      await expect(
        applySessionFoldPlan(storePath, plan, {
          append_event: async (path, event) => ({
            ...(await appendEventIfAbsent(path, event)),
            durability: "failed" as const
          })
        })
      ).rejects.toThrow("event durability failed");

      const foldEvents = (await readEvents(storePath)).filter((event) => event.event_id.includes(plan.plan_id));
      expect(foldEvents).toHaveLength(1);
      expect(foldEvents[0]?.op).toBe("upsert_record");

      const resumed = await applySessionFoldPlan(storePath, plan);
      expect(resumed.existing_event_ids).toEqual([foldEvents[0]!.event_id]);
      expect(resumed.created_event_ids).toHaveLength(plan.source_record_ids.length);
    });
  });

  it("does not write a receipt when an append adapter reports success without publishing events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const attemptedOps: string[] = [];
      await expect(
        applySessionFoldPlan(storePath, plan, {
          append_event: async (_path, event) => {
            attemptedOps.push(event.op);
            return {
              created: true,
              event,
              path: "not-published",
              durability: "confirmed"
            };
          }
        })
      ).rejects.toThrow("event publication incomplete");

      expect(attemptedOps).toEqual(["upsert_record"]);
      expect(await readSessionFoldReceipt(storePath, plan.plan_id)).toBeUndefined();
      expect((await readEvents(storePath)).some((event) => event.event_id.includes(plan.plan_id))).toBe(false);
    });
  });

  it("stores private, integrity-checked receipts and rejects incomplete or tampered content", async () => {
    await withInitializedTempStore(async (storePath) => {
      const directory = join(storePath, "state", "session-fold");
      await mkdir(directory, { recursive: true, mode: 0o777 });
      await chmod(directory, 0o777);
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const result = await applySessionFoldPlan(storePath, plan);
      const path = join(directory, `${plan.plan_id}.json`);

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, `${JSON.stringify({ ...stored, project_id: "tampered" })}\n`, "utf8");
      expect(await readSessionFoldReceipt(storePath, plan.plan_id)).toBeUndefined();

      const { event_ids: _removed, ...incomplete } = stored;
      await writeFile(path, `${JSON.stringify(incomplete)}\n`, "utf8");
      expect(await readSessionFoldReceipt(storePath, plan.plan_id)).toBeUndefined();
      expect(result.receipt.event_ids).toHaveLength(plan.source_record_ids.length + 1);
    });
  });

  it("refuses event-id collisions with different payloads", async () => {
    await withInitializedTempStore(async (storePath) => {
      const plan = planSessionFold(await sessionRecords(storePath), {
        project_id: "moryn",
        session_id: "session-a"
      })!;
      const expected = buildSessionFoldEvents(plan);
      await appendEventIfAbsent(storePath, { ...expected[0]!, source: { client: "tampered", device_id: "other" } });
      await expect(applySessionFoldPlan(storePath, plan)).rejects.toThrow("event id collision");
    });
  });
});
