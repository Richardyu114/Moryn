import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { planEpisodeRollup } from "../../src/core/episode-rollup.js";
import {
  applyEpisodeRollupPlan,
  buildEpisodeRollupEvents,
  readEpisodeRollupReceipt
} from "../../src/core/episode-rollup-transaction.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { appendEvent, appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const POLICY = { now: "2026-07-20T12:00:00.000Z", recent_window_days: 7 };
const IDENTITY = { project_id: "moryn", bucket_kind: "day" as const, bucket_key: "2026-07-06" };

function leaf(recordId: string, character: string): { record_id: string; digest: string } {
  return { record_id: recordId, digest: character.repeat(64) };
}

function sessionRollup(input: {
  id: string;
  at: string;
  leaf: { record_id: string; digest: string };
  closed?: boolean;
  text?: string;
}): MorynRecord {
  return {
    id: input.id,
    kind: "session_summary",
    type: "session_rollup",
    scope: "project",
    project_id: "moryn",
    tags: ["session-fold"],
    content: {
      text: input.text ?? `Session ${input.id} completed`,
      format: "json",
      session_fold_version: 1,
      ...(input.closed === false ? {} : { closed_at: input.at }),
      decisions: ["Keep durable leaf lineage"],
      blockers: [],
      changed_facts: [],
      next_steps: [],
      important_files: [],
      source_record_ids: [input.leaf.record_id],
      source_digests: [input.leaf]
    },
    state: "candidate",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: input.at,
    updated_at: input.at,
    source: { client: "codex", session_id: `source-${input.id}`, device_id: "device-a" },
    provenance: { derived_from: [input.leaf.record_id], method: "rule-promoted" }
  };
}

function sourceRecords(): MorynRecord[] {
  return [
    sessionRollup({ id: "session/unsafe/a", at: "2026-07-06T08:00:00.000Z", leaf: leaf("raw-a", "a") }),
    sessionRollup({ id: "session\\unsafe\\b", at: "2026-07-06T09:00:00.000Z", leaf: leaf("raw-b", "b") }),
    sessionRollup({ id: "session-c", at: "2026-07-06T10:00:00.000Z", leaf: leaf("raw-c", "c") }),
    sessionRollup({
      id: "session-unfinished",
      at: "2026-07-06T11:00:00.000Z",
      leaf: leaf("raw-unfinished", "d"),
      closed: false
    })
  ];
}

async function seedRecords(storePath: string, records = sourceRecords()): Promise<void> {
  for (const [index, record] of records.entries()) {
    const event: MorynEvent = {
      event_id: `evt_seed_episode_${index}_${record.id.replace(/[^a-z0-9]/giu, "_")}`,
      op: "upsert_record",
      record,
      created_at: record.updated_at,
      source: { client: "test", device_id: "device-a" }
    };
    await appendEvent(storePath, event);
  }
}

async function readyPlan(storePath: string) {
  const records = (await readCurrentRecords(storePath)).records;
  const plan = planEpisodeRollup(records, IDENTITY, POLICY);
  if (plan?.status !== "ready") throw new Error("Expected a ready Episode Rollup plan");
  return plan;
}

describe("Episode Rollup transaction", () => {
  it("publishes and reads back the rollup before archiving only old covered sources", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      const expectedEvents = buildEpisodeRollupEvents(plan);

      expect(expectedEvents[0]).toMatchObject({ op: "upsert_record", record: { id: plan.rollup_record?.id } });
      expect(expectedEvents.slice(1).every((event) => event.op === "archive_record")).toBe(true);
      const result = await applyEpisodeRollupPlan(storePath, plan);

      expect(result.created_event_ids).toEqual(expectedEvents.map((event) => event.event_id));
      expect(result.existing_event_ids).toEqual([]);
      expect(result.receipt).toMatchObject({
        status: "committed",
        plan_id: plan.plan_id,
        source_record_ids: ["session-c", "session/unsafe/a", "session\\unsafe\\b"],
        archived_source_record_ids: ["session-c", "session/unsafe/a", "session\\unsafe\\b"],
        preserved_warm_record_ids: ["session-unfinished"],
        rollup_record_id: plan.rollup_record?.id,
        integrity_digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
      });

      const current = (await readCurrentRecords(storePath)).records;
      expect(current.find((record) => record.id === plan.rollup_record?.id)).toEqual(plan.rollup_record);
      for (const candidate of plan.cold_candidates) {
        expect(current.find((record) => record.id === candidate.record_id)).toMatchObject({
          state: "archived",
          visibility: "archived"
        });
      }
      expect(current.find((record) => record.id === "session-unfinished")).toMatchObject({
        state: "candidate",
        visibility: "active"
      });
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toEqual(result.receipt);
    });
  });

  it("uses path-safe deterministic event ids and strictly ordered timestamps", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      const events = buildEpisodeRollupEvents(plan);
      const rebuilt = buildEpisodeRollupEvents(
        planEpisodeRollup([...(await readCurrentRecords(storePath)).records].reverse(), IDENTITY, POLICY)!
      );

      expect(rebuilt).toEqual(events);
      for (const event of events.slice(1)) {
        expect(event.event_id).toMatch(/^evt_episode_rollup_[a-f0-9]{32}_archive_[a-f0-9]{64}$/u);
        expect(event.event_id).not.toMatch(/[/\\\0]/u);
      }
      for (let index = 1; index < events.length; index += 1) {
        expect(Date.parse(events[index]!.created_at)).toBeGreaterThan(Date.parse(events[index - 1]!.created_at));
      }
    });
  });

  it("is idempotent after commit", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      const first = await applyEpisodeRollupPlan(storePath, plan);
      const eventCount = (await readEvents(storePath)).length;
      const second = await applyEpisodeRollupPlan(storePath, plan);

      expect(second.created_event_ids).toEqual([]);
      expect(second.existing_event_ids).toEqual(first.receipt.event_ids);
      expect(second.receipt).toEqual(first.receipt);
      expect((await readEvents(storePath)).length).toBe(eventCount);
    });
  });

  it("serializes different plans and rejects the queued stale plan before it can append", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const records = (await readCurrentRecords(storePath)).records;
      const firstPlan = planEpisodeRollup(records, IDENTITY, POLICY)!;
      const stalePlan = planEpisodeRollup(records, IDENTITY, {
        now: "2026-07-21T12:00:00.000Z",
        recent_window_days: 7
      })!;
      expect(firstPlan.status).toBe("ready");
      expect(stalePlan.status).toBe("ready");
      expect(stalePlan.plan_id).not.toBe(firstPlan.plan_id);

      let markFirstAppendStarted!: () => void;
      const firstAppendStarted = new Promise<void>((resolve) => {
        markFirstAppendStarted = resolve;
      });
      let releaseFirstAppend!: () => void;
      const firstAppendRelease = new Promise<void>((resolve) => {
        releaseFirstAppend = resolve;
      });
      let firstAppend = true;
      const firstApply = applyEpisodeRollupPlan(storePath, firstPlan, {
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

      let staleAppendCount = 0;
      const queuedApply = applyEpisodeRollupPlan(storePath, stalePlan, {
        append_event: async (path, event) => {
          staleAppendCount += 1;
          return appendEventIfAbsent(path, event);
        }
      });
      try {
        await delay(50);
        expect(staleAppendCount).toBe(0);
      } finally {
        releaseFirstAppend();
      }

      await expect(firstApply).resolves.toMatchObject({ receipt: { plan_id: firstPlan.plan_id } });
      await expect(queuedApply).rejects.toThrow("Stale Episode Rollup plan");
      expect(staleAppendCount).toBe(0);
      expect((await readEvents(storePath)).some((event) => event.event_id.includes(stalePlan.plan_id))).toBe(false);
    });
  });

  it("attests best-effort publication separately from confirmed and existing readback events", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      const result = await applyEpisodeRollupPlan(storePath, plan, {
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
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toEqual(result.receipt);
    });
  });

  it("resumes after an archive append failure without hiding uncovered sources", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      let attempts = 0;
      await expect(
        applyEpisodeRollupPlan(storePath, plan, {
          append_event: async (path, event) => {
            attempts += 1;
            if (attempts === 3) throw new Error("injected archive failure");
            return appendEventIfAbsent(path, event);
          }
        })
      ).rejects.toThrow("injected archive failure");

      const partialEvents = (await readEvents(storePath)).filter((event) => event.event_id.includes(plan.plan_id));
      expect(partialEvents).toHaveLength(2);
      expect(partialEvents[0]?.op).toBe("upsert_record");
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toBeUndefined();

      const resumed = await applyEpisodeRollupPlan(storePath, plan);
      expect(resumed.created_event_ids).toHaveLength(2);
      expect(resumed.existing_event_ids).toHaveLength(2);
      const current = (await readCurrentRecords(storePath)).records;
      expect(plan.source_record_ids.every((id) => current.some((record) => record.id === id))).toBe(true);
      expect(
        plan.cold_candidates.every(
          (item) => current.find((record) => record.id === item.record_id)?.state === "archived"
        )
      ).toBe(true);
    });
  });

  it("rejects a stale plan before publishing transaction events", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      await seedRecords(storePath, [
        sessionRollup({ id: "late-session", at: "2026-07-06T12:00:00.000Z", leaf: leaf("raw-late", "e") })
      ]);

      await expect(applyEpisodeRollupPlan(storePath, plan)).rejects.toThrow("Stale Episode Rollup plan");
      expect((await readEvents(storePath)).some((event) => event.event_id.includes(plan.plan_id))).toBe(false);
    });
  });

  it("rechecks freshness before resuming a partially published plan", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      let attempts = 0;
      await expect(
        applyEpisodeRollupPlan(storePath, plan, {
          append_event: async (path, event) => {
            attempts += 1;
            if (attempts === 2) throw new Error("stop before the first archive");
            return appendEventIfAbsent(path, event);
          }
        })
      ).rejects.toThrow("stop before the first archive");
      await seedRecords(storePath, [
        sessionRollup({ id: "late-after-rollup", at: "2026-07-06T12:00:00.000Z", leaf: leaf("raw-late", "e") })
      ]);

      await expect(applyEpisodeRollupPlan(storePath, plan)).rejects.toThrow("Stale Episode Rollup plan");
      const transactionEvents = (await readEvents(storePath)).filter((event) => event.event_id.includes(plan.plan_id));
      expect(transactionEvents).toHaveLength(1);
      expect(transactionEvents[0]?.op).toBe("upsert_record");
      expect(
        (await readCurrentRecords(storePath)).records
          .filter((record) => plan.source_record_ids.includes(record.id))
          .every((record) => record.visibility === "active")
      ).toBe(true);
    });
  });

  it("never archives after failed durability or a false publication report", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      await expect(
        applyEpisodeRollupPlan(storePath, plan, {
          append_event: async (path, event) => ({
            ...(await appendEventIfAbsent(path, event)),
            durability: "failed" as const
          })
        })
      ).rejects.toThrow("event durability failed");
      const afterDurabilityFailure = (await readEvents(storePath)).filter((event) =>
        event.event_id.includes(plan.plan_id)
      );
      expect(afterDurabilityFailure).toHaveLength(1);
      expect(afterDurabilityFailure[0]?.op).toBe("upsert_record");
      expect(
        (await readCurrentRecords(storePath)).records
          .filter((record) => plan.source_record_ids.includes(record.id))
          .every((record) => record.visibility === "active")
      ).toBe(true);
    });

    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      await expect(
        applyEpisodeRollupPlan(storePath, plan, {
          append_event: async (_path, event) => ({
            created: true,
            event,
            path: "not-published",
            durability: "confirmed"
          })
        })
      ).rejects.toThrow("publication incomplete");
      expect((await readEvents(storePath)).some((event) => event.event_id.includes(plan.plan_id))).toBe(false);
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toBeUndefined();
    });
  });

  it("does not archive when record readback cannot confirm the published rollup", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      await expect(
        applyEpisodeRollupPlan(storePath, plan, {
          read_records: async (path, options) => {
            const result = await readCurrentRecords(path, options);
            return { ...result, records: result.records.filter((record) => record.id !== plan.rollup_record?.id) };
          }
        })
      ).rejects.toThrow("publication readback failed");

      const transactionEvents = (await readEvents(storePath)).filter((event) => event.event_id.includes(plan.plan_id));
      expect(transactionEvents).toHaveLength(1);
      expect(transactionEvents[0]?.op).toBe("upsert_record");
      expect(
        (await readCurrentRecords(storePath)).records
          .filter((record) => plan.source_record_ids.includes(record.id))
          .every((record) => record.visibility === "active")
      ).toBe(true);
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toBeUndefined();
    });
  });

  it("refuses event-id collisions with different payloads", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const plan = await readyPlan(storePath);
      const expected = buildEpisodeRollupEvents(plan);
      await appendEventIfAbsent(storePath, {
        ...expected[0]!,
        source: { client: "tampered", device_id: "other" }
      });

      await expect(applyEpisodeRollupPlan(storePath, plan)).rejects.toThrow("event id collision");
      expect(
        (await readCurrentRecords(storePath)).records
          .filter((record) => plan.source_record_ids.includes(record.id))
          .every((record) => record.visibility === "active")
      ).toBe(true);
    });
  });

  it("stores private integrity-checked receipts and rejects tampered or incomplete content", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath);
      const directory = join(storePath, "state", "episode-rollup");
      await mkdir(directory, { recursive: true, mode: 0o777 });
      await chmod(directory, 0o777);
      const plan = await readyPlan(storePath);
      const result = await applyEpisodeRollupPlan(storePath, plan);
      const path = join(directory, `${plan.plan_id}.json`);

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      expect(stored).not.toHaveProperty("claims");
      await writeFile(path, `${JSON.stringify({ ...stored, bucket_key: "tampered" })}\n`, "utf8");
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toBeUndefined();

      const { event_ids: _removed, ...incomplete } = stored;
      await writeFile(path, `${JSON.stringify(incomplete)}\n`, "utf8");
      expect(await readEpisodeRollupReceipt(storePath, plan.plan_id)).toBeUndefined();
      expect(result.receipt.event_ids).toHaveLength(plan.cold_candidates.length + 1);
    });
  });
});
