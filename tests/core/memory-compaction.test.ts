import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MemoryCompactionPlanEnvelope,
  memoryCompactionRecordDigest,
  planMemoryCompaction,
  previewMemoryCompaction
} from "../../src/core/memory-compaction.js";
import {
  applyMemoryCompactionPlan,
  readMemoryCompactionReceipt,
  writeMemoryCompactionReceipt
} from "../../src/core/memory-compaction-receipts.js";
import {
  buildMemoryCompactionRestoreEvents,
  readMemoryCompactionRestoreReceipt,
  restoreMemoryCompactionPlan
} from "../../src/core/memory-compaction-restore.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { buildSessionFoldCoverageAttestation } from "../../src/core/session-fold.js";
import { applySessionFoldPlan } from "../../src/core/session-fold-transaction.js";
import { appendEvent, appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const NOW = "2026-07-20T12:00:00.000Z";

function sessionRecord(input: {
  id: string;
  type: "status" | "summary";
  at: string;
  text: string;
  session_id?: string;
  tags?: string[];
}): MorynRecord {
  const sessionId = input.session_id ?? "session-current";
  return {
    id: input.id,
    kind: "session_summary",
    type: input.type,
    scope: "project",
    project_id: "moryn",
    tags: input.tags ?? [`session:${sessionId}`],
    content: { text: input.text, format: "text" },
    state: "candidate",
    confidence: 0.8,
    priority: "normal",
    visibility: "active",
    created_at: input.at,
    updated_at: input.at,
    source: { client: "codex", session_id: sessionId, device_id: "device-a" },
    provenance: { method: "agent-proposed" }
  };
}

function closedSessionRecords(input: { private?: boolean; secret?: string } = {}): MorynRecord[] {
  const sessionId = "session-current";
  const tags = input.private ? ["private", `session:${sessionId}`] : [`session:${sessionId}`];
  const statusText = input.secret ?? "Implemented deterministic compaction preview";
  const status = sessionRecord({
    id: "current-status",
    type: "status",
    at: "2026-07-18T10:00:00.000Z",
    text: statusText,
    session_id: sessionId,
    tags
  });
  const finalText = `${statusText}. Session complete.`;
  const final = sessionRecord({
    id: "current-final",
    type: "summary",
    at: "2026-07-18T10:00:01.000Z",
    text: finalText,
    session_id: sessionId,
    tags
  });
  const coverage = buildSessionFoldCoverageAttestation(
    [status],
    { project_id: "moryn", session_id: sessionId },
    finalText
  );
  return [status, { ...final, content: { ...final.content, session_fold_coverage: coverage } }];
}

function leaf(recordId: string, character: string): { record_id: string; digest: string } {
  return { record_id: recordId, digest: character.repeat(64) };
}

function oldSessionRollup(input: { id: string; at: string; character: string; private?: boolean }): MorynRecord {
  const evidence = leaf(`leaf-${input.id}`, input.character);
  return {
    id: input.id,
    kind: "session_summary",
    type: "session_rollup",
    scope: "project",
    project_id: "moryn",
    tags: input.private ? ["private", "session-fold"] : ["session-fold"],
    content: {
      text: `Completed ${input.id} with deterministic lineage and durable verification evidence`,
      format: "json",
      session_fold_version: 1,
      closed_at: input.at,
      decisions: ["Keep leaf evidence authoritative"],
      blockers: [],
      changed_facts: [],
      next_steps: [],
      important_files: [],
      source_record_ids: [evidence.record_id],
      source_digests: [evidence]
    },
    state: "candidate",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: input.at,
    updated_at: input.at,
    source: { client: "moryn", session_id: `source-${input.id}`, device_id: "device-a" },
    provenance: { derived_from: [evidence.record_id], method: "rule-promoted" }
  };
}

function episodeRecords(privateRecords = false): MorynRecord[] {
  return [
    oldSessionRollup({
      id: "old-session-a",
      at: "2026-07-01T08:00:00.000Z",
      character: "a",
      private: privateRecords
    }),
    oldSessionRollup({
      id: "old-session-b",
      at: "2026-07-01T09:00:00.000Z",
      character: "b",
      private: privateRecords
    })
  ];
}

async function seedRecords(storePath: string, records: readonly MorynRecord[]): Promise<void> {
  for (const [index, record] of records.entries()) {
    await appendEvent(storePath, {
      event_id: `evt_seed_compaction_${index}_${record.id.replace(/[^a-z0-9]/giu, "_")}`,
      op: "upsert_record",
      record,
      created_at: record.updated_at,
      source: { client: "test", device_id: "device-a" }
    });
  }
}

async function previewStore(
  storePath: string,
  options: Parameters<typeof previewMemoryCompaction>[1]
): Promise<MemoryCompactionPlanEnvelope> {
  return planMemoryCompaction(
    previewMemoryCompaction((await readCurrentRecords(storePath)).records, { now: NOW, ...options })
  );
}

describe("Memory Compaction coordinator", () => {
  it("builds deterministic filtered previews with exact active/token deltas and explicit safety semantics", () => {
    const records = [...episodeRecords(), ...closedSessionRecords()];
    const firstPreview = previewMemoryCompaction(records, { project_id: "moryn", now: NOW });
    const reorderedPreview = previewMemoryCompaction([...records].reverse(), { project_id: "moryn", now: NOW });
    const first = planMemoryCompaction(firstPreview);
    const reordered = planMemoryCompaction(reorderedPreview);

    expect(reorderedPreview).toEqual(firstPreview);
    expect(reordered).toEqual(first);
    expect(firstPreview).toMatchObject({
      preview_id: expect.stringMatching(/^memory_compaction_preview_[a-f0-9]{32}$/u),
      preview_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      plan_id: first.plan_id,
      proposed_plan_id: first.plan_id
    });
    expect(first).toMatchObject({
      version: 1,
      plan_id: expect.stringMatching(/^memory_compaction_[a-f0-9]{32}$/u),
      envelope_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      status: "ready",
      purge: { included: false },
      sync_impact: { event_model: "append_only", git_history_retained: true, physical_purge: false },
      undo: {
        supported: true,
        mode: "append_only_logical_restore",
        erases_git_history: false
      }
    });
    expect(first.plans.map((plan) => plan.kind).sort()).toEqual(["episode_rollup", "session_fold"]);
    expect(first.metrics.before_active_record_count).toBe(4);
    expect(first.metrics.after_active_record_count).toBe(2);
    expect(first.metrics.reducible_estimated_tokens).toBe(
      Math.max(0, first.metrics.before_estimated_tokens - first.metrics.after_estimated_tokens)
    );
    expect(first.metrics.archived_source_estimated_tokens).toBeGreaterThan(0);
    expect(first.plans.every((plan) => plan.coverage.complete)).toBe(true);

    const sessionOnly = planMemoryCompaction(
      previewMemoryCompaction(records, {
        project_id: "moryn",
        session_id: "session-current",
        now: NOW
      })
    );
    expect(sessionOnly.plans).toHaveLength(1);
    expect(sessionOnly.plans[0]).toMatchObject({ kind: "session_fold", status: "ready" });

    const episodeOnly = planMemoryCompaction(
      previewMemoryCompaction(records, {
        project_id: "moryn",
        bucket_kind: "day",
        bucket_key: "2026-07-01",
        now: NOW
      })
    );
    expect(episodeOnly.plans).toHaveLength(1);
    expect(episodeOnly.plans[0]).toMatchObject({ kind: "episode_rollup", status: "ready" });

    const unfinished = oldSessionRollup({
      id: "unfinished-session",
      at: "2026-07-01T10:00:00.000Z",
      character: "c"
    });
    const { closed_at: _closedAt, ...unfinishedContent } = unfinished.content;
    const warmAware = planMemoryCompaction(
      previewMemoryCompaction([...episodeRecords(), { ...unfinished, content: unfinishedContent }], {
        project_id: "moryn",
        bucket_kind: "day",
        bucket_key: "2026-07-01",
        now: NOW
      })
    );
    expect(warmAware.plans[0]?.metrics).toMatchObject({
      before_active_record_count: 3,
      after_active_record_count: 2,
      preserved_warm_record_count: 1,
      preserved_warm_estimated_tokens: expect.any(Number)
    });
    expect(warmAware.plans[0]!.metrics.after_estimated_tokens).toBe(
      warmAware.plans[0]!.metrics.preserved_warm_estimated_tokens +
        warmAware.plans[0]!.metrics.derived_record_estimated_tokens
    );
  });

  it("rejects review plans, missing confirmation, and any digest-tampered envelope", async () => {
    await withInitializedTempStore(async (storePath) => {
      const unfinished = sessionRecord({
        id: "unfinished-status",
        type: "status",
        at: "2026-07-18T10:00:00.000Z",
        text: "Still working",
        session_id: "unfinished"
      });
      await seedRecords(storePath, [unfinished]);
      const review = await previewStore(storePath, { project_id: "moryn", session_id: "unfinished" });
      expect(review).toMatchObject({ status: "review_required", plans: [{ status: "review_required" }] });
      await expect(applyMemoryCompactionPlan(storePath, { plan: review, confirmed: true })).rejects.toThrow(
        "not ready"
      );
    });

    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const preview = previewMemoryCompaction((await readCurrentRecords(storePath)).records, {
        project_id: "moryn",
        session_id: "session-current",
        now: NOW
      });
      await expect(
        applyMemoryCompactionPlan(storePath, {
          plan: preview as unknown as MemoryCompactionPlanEnvelope,
          confirmed: true
        })
      ).rejects.toThrow("Invalid Memory Compaction plan envelope");
      const plan = planMemoryCompaction(preview);
      await expect(applyMemoryCompactionPlan(storePath, { plan, confirmed: false })).rejects.toThrow("confirmed: true");
      const tampered = structuredClone(plan);
      tampered.plans[0]!.plan.rollup_record!.content.text = "tampered preview";
      await expect(applyMemoryCompactionPlan(storePath, { plan: tampered, confirmed: true })).rejects.toThrow(
        "digest mismatch"
      );
      expect((await readEvents(storePath)).some((event) => event.event_id.includes(plan.plan_id))).toBe(false);
    });
  });

  it("keeps private payloads out of the pure planner unless include_private is explicit", () => {
    const marker = "PRIVATE-PURE-COMPACTION-MARKER-F29C";
    const records = closedSessionRecords({ private: true, secret: marker });
    const preview = previewMemoryCompaction(records, {
      project_id: "moryn",
      session_id: "session-current",
      now: NOW
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("final_handoff_content");
    expect(serialized).not.toContain('"claims"');
    expect(preview).toMatchObject({
      status: "review_required",
      filters: { include_private: false },
      private_access: {
        scope_complete: false,
        omitted_private_source_count: 2,
        omission_reason: "private_sources_require_explicit_include_private"
      },
      plans: [],
      blockers: [{ code: "private_sources_omitted", record_ids: [], omitted_source_count: 2 }]
    });

    const authorized = previewMemoryCompaction(records, {
      project_id: "moryn",
      session_id: "session-current",
      now: NOW,
      include_private: true
    });
    expect(authorized.filters.include_private).toBe(true);
    expect(JSON.stringify(authorized)).toContain(marker);
    expect(authorized.preview_id).not.toBe(preview.preview_id);
  });

  it("treats untagged Episode privacy and local-only markers as private compaction sources", () => {
    const marker = "UNTAGGED-PRIVATE-EPISODE-MARKER-42E7";
    const [privacySource, localOnlySource] = episodeRecords().map((record, index) => ({
      ...record,
      content: {
        ...record.content,
        text: `${marker}-${index}`,
        ...(index === 0 ? { privacy: "private" } : { distribution: "local_only" })
      }
    }));
    const records = [privacySource!, localOnlySource!];
    const privateIds = records.map((record) => record.id);
    const privateDigests = records.map(memoryCompactionRecordDigest);
    const preview = previewMemoryCompaction(records, {
      project_id: "moryn",
      bucket_kind: "day",
      bucket_key: "2026-07-01",
      now: NOW
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain(marker);
    for (const privateId of privateIds) expect(serialized).not.toContain(privateId);
    for (const privateDigest of privateDigests) expect(serialized).not.toContain(privateDigest);
    expect(preview).toMatchObject({
      status: "review_required",
      filters: { include_private: false },
      private_access: {
        scope_complete: false,
        omitted_private_source_count: 2,
        omission_reason: "private_sources_require_explicit_include_private"
      },
      plans: [],
      blockers: [{ code: "private_sources_omitted", record_ids: [], omitted_source_count: 2 }]
    });

    const authorized = previewMemoryCompaction(records, {
      project_id: "moryn",
      bucket_kind: "day",
      bucket_key: "2026-07-01",
      now: NOW,
      include_private: true
    });
    const authorizedJson = JSON.stringify(authorized);
    expect(authorizedJson).toContain(marker);
    for (const privateId of privateIds) expect(authorizedJson).toContain(privateId);
    for (const privateDigest of privateDigests) expect(authorizedJson).toContain(privateDigest);
    expect(authorized).toMatchObject({
      filters: { include_private: true },
      private_access: { scope_complete: true, omitted_private_source_count: 0 },
      plans: [{ privacy: { boundary: "private", private_source_records: 2 } }]
    });
  });

  it("dispatches Episode Rollup before Session Fold and commits only after child durability/readback", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, [...episodeRecords(), ...closedSessionRecords()]);
      const plan = await previewStore(storePath, { project_id: "moryn" });
      const result = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });

      expect(result.child_results.map((child) => child.kind)).toEqual(["episode_rollup", "session_fold"]);
      expect(result.child_results.every((child) => child.durability.failed === 0)).toBe(true);
      expect(result.created_event_ids).toEqual(result.receipt.event_ids);
      expect(result.receipt).toMatchObject({
        status: "committed",
        purge_performed: false,
        git_history_erased: false,
        child_receipts: [
          { kind: "episode_rollup", receipt_id: expect.stringMatching(/^episode_rollup_/u) },
          { kind: "session_fold", receipt_id: expect.stringMatching(/^session_fold_/u) }
        ]
      });
      const current = (await readCurrentRecords(storePath)).records;
      expect(result.receipt.source_transitions).toHaveLength(4);
      expect(
        result.receipt.source_transitions.every(
          (transition) => current.find((record) => record.id === transition.record_id)?.state === "archived"
        )
      ).toBe(true);
      expect(
        result.receipt.derived_records.every(
          (derived) => current.find((record) => record.id === derived.record_id)?.visibility === "active"
        )
      ).toBe(true);
      const sessionChild = result.receipt.child_receipts.find((child) => child.kind === "session_fold")!;
      const sessionReceiptText = await readFile(
        join(storePath, "state", "session-fold", `${sessionChild.receipt_id}.json`),
        "utf8"
      );
      expect(sessionReceiptText).not.toContain("Implemented deterministic compaction preview");
      expect(sessionReceiptText).not.toContain('"content"');

      const second = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      expect(second.created_event_ids).toEqual([]);
      expect(second.existing_event_ids).toEqual(result.receipt.event_ids);
    });
  });

  it("aggregates exact child and restore durability partitions without overstating best-effort writes", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const plan = await previewStore(storePath, { project_id: "moryn", session_id: "session-current" });
      const applied = await applyMemoryCompactionPlan(
        storePath,
        { plan, confirmed: true },
        {
          apply_session_fold: (path, childPlan) =>
            applySessionFoldPlan(path, childPlan, {
              append_event: async (eventStorePath, event) => {
                const appended = await appendEventIfAbsent(eventStorePath, event);
                return event.op === "upsert_record" ? { ...appended, durability: "best_effort" as const } : appended;
              }
            })
        }
      );
      const child = applied.receipt.child_receipts[0]!;
      expect(child.durability).toEqual({
        confirmed_event_ids: applied.receipt.event_ids.slice(1),
        best_effort_event_ids: [applied.receipt.event_ids[0]],
        existing_readback_event_ids: [],
        all_events_read_back: true
      });
      expect(applied.receipt.durability).toEqual(child.durability);

      const restored = await restoreMemoryCompactionPlan(
        storePath,
        { plan_id: plan.plan_id, confirmed: true },
        {
          append_event: async (eventStorePath, event) => {
            const appended = await appendEventIfAbsent(eventStorePath, event);
            return event.op === "promote_record" ? { ...appended, durability: "best_effort" as const } : appended;
          }
        }
      );
      expect(restored.receipt.durability).toEqual({
        confirmed_event_ids: restored.receipt.event_ids.slice(applied.receipt.source_transitions.length),
        best_effort_event_ids: restored.receipt.event_ids.slice(0, applied.receipt.source_transitions.length),
        existing_readback_event_ids: [],
        all_events_read_back: true
      });
    });
  });

  it("retries safely after a partial child failure and after unified receipt failure", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, [...episodeRecords(), ...closedSessionRecords()]);
      const plan = await previewStore(storePath, { project_id: "moryn" });
      await expect(
        applyMemoryCompactionPlan(
          storePath,
          { plan, confirmed: true },
          {
            apply_session_fold: async () => {
              throw new Error("injected Session Fold dispatch failure");
            }
          }
        )
      ).rejects.toThrow("injected Session Fold dispatch failure");
      const partialCount = (await readEvents(storePath)).filter((event) =>
        event.event_id.includes(plan.plans.find((entry) => entry.kind === "episode_rollup")!.plan_id)
      ).length;
      expect(partialCount).toBeGreaterThan(0);
      expect(await readMemoryCompactionReceipt(storePath, plan.plan_id)).toBeUndefined();

      const resumed = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      expect(resumed.child_results[0]).toMatchObject({ kind: "episode_rollup", created_event_ids: [] });
      expect(resumed.child_results[0]!.existing_event_ids.length).toBeGreaterThan(0);
    });

    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const plan = await previewStore(storePath, { project_id: "moryn", session_id: "session-current" });
      await expect(
        applyMemoryCompactionPlan(
          storePath,
          { plan, confirmed: true },
          {
            write_receipt: async () => {
              throw new Error("injected unified receipt failure");
            }
          }
        )
      ).rejects.toThrow("injected unified receipt failure");
      expect(await readMemoryCompactionReceipt(storePath, plan.plan_id)).toBeUndefined();

      const resumed = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      expect(resumed.created_event_ids).toEqual([]);
      expect(resumed.existing_event_ids).toEqual(resumed.receipt.event_ids);
    });
  });

  it("performs an idempotent append-only logical restore before archiving derived rollups", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const plan = await previewStore(storePath, { project_id: "moryn", session_id: "session-current" });
      const applied = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      const beforeRestoreEventCount = (await readEvents(storePath)).length;
      const expected = buildMemoryCompactionRestoreEvents(applied.receipt);
      expect(
        expected.slice(0, applied.receipt.source_transitions.length).every((event) => event.op === "promote_record")
      ).toBe(true);
      expect(
        expected.slice(applied.receipt.source_transitions.length).every((event) => event.op === "archive_record")
      ).toBe(true);

      const restored = await restoreMemoryCompactionPlan(storePath, { plan_id: plan.plan_id, confirmed: true });
      expect((await readEvents(storePath)).length).toBe(beforeRestoreEventCount + restored.receipt.event_ids.length);
      expect(restored.receipt).toMatchObject({
        status: "restored",
        logical_restore: true,
        purge_performed: false,
        git_history_erased: false
      });
      const current = (await readCurrentRecords(storePath)).records;
      for (const transition of applied.receipt.source_transitions) {
        expect(current.find((record) => record.id === transition.record_id)).toMatchObject({
          state: transition.before_state,
          visibility: transition.before_visibility
        });
      }
      for (const derived of applied.receipt.derived_records) {
        expect(current.find((record) => record.id === derived.record_id)).toMatchObject({
          state: "archived",
          visibility: "archived"
        });
      }
      const second = await restoreMemoryCompactionPlan(storePath, { plan_id: plan.plan_id, confirmed: true });
      expect(second.created_event_ids).toEqual([]);
      expect(second.existing_event_ids).toEqual(restored.receipt.event_ids);

      const directory = join(storePath, "state", "memory-compaction-restores");
      const path = join(directory, `${restored.receipt.restore_id}.json`);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readMemoryCompactionRestoreReceipt(storePath, restored.receipt.restore_id)).toEqual(
        restored.receipt
      );
    });
  });

  it("resumes a restore after failed durability without archiving derived memory first", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const plan = await previewStore(storePath, { project_id: "moryn", session_id: "session-current" });
      const applied = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      await expect(
        restoreMemoryCompactionPlan(
          storePath,
          { plan_id: plan.plan_id, confirmed: true },
          {
            append_event: async (path, event) => ({
              ...(await appendEventIfAbsent(path, event)),
              durability: "failed" as const
            })
          }
        )
      ).rejects.toThrow("durability failed");
      const partial = (await readCurrentRecords(storePath)).records;
      expect(
        applied.receipt.derived_records.every(
          (derived) => partial.find((record) => record.id === derived.record_id)?.visibility === "active"
        )
      ).toBe(true);

      const resumed = await restoreMemoryCompactionPlan(storePath, { plan_id: plan.plan_id, confirmed: true });
      expect(resumed.existing_event_ids.length).toBeGreaterThan(0);
      expect(resumed.receipt.status).toBe("restored");
    });
  });

  it("stores metadata-only private receipts with strict permissions and rejects tampering", async () => {
    await withInitializedTempStore(async (storePath) => {
      const secret = "PRIVATE-PAYLOAD-NEVER-IN-RECEIPT";
      const privateRecords = episodeRecords(true).map((record) => ({
        ...record,
        content: { ...record.content, text: `${secret}-${record.id}` }
      }));
      await seedRecords(storePath, privateRecords);
      const directory = join(storePath, "state", "memory-compaction");
      await mkdir(directory, { recursive: true, mode: 0o777 });
      await chmod(directory, 0o777);
      const plan = await previewStore(storePath, {
        project_id: "moryn",
        bucket_kind: "day",
        bucket_key: "2026-07-01",
        include_private: true
      });
      expect(plan.plans[0]?.privacy).toMatchObject({
        boundary: "private",
        private_source_records: 2,
        receipt_payload: "metadata_only"
      });
      const result = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      const path = join(directory, `${plan.plan_id}.json`);
      const storedText = await readFile(path, "utf8");

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(storedText).not.toContain(secret);
      expect(storedText).not.toContain('"content"');
      expect(storedText).not.toContain('"claims"');
      const episodeChild = result.receipt.child_receipts.find((child) => child.kind === "episode_rollup")!;
      const episodeReceiptText = await readFile(
        join(storePath, "state", "episode-rollup", `${episodeChild.receipt_id}.json`),
        "utf8"
      );
      expect(episodeReceiptText).not.toContain(secret);
      expect(episodeReceiptText).not.toContain('"content"');
      expect(episodeReceiptText).not.toContain('"claims"');
      expect(result.receipt.integrity_digest).toMatch(/^[a-f0-9]{64}$/u);

      const stored = JSON.parse(storedText) as Record<string, unknown>;
      await writeFile(path, `${JSON.stringify({ ...stored, git_history_erased: true })}\n`, "utf8");
      expect(await readMemoryCompactionReceipt(storePath, plan.plan_id)).toBeUndefined();
      await expect(applyMemoryCompactionPlan(storePath, { plan, confirmed: true })).rejects.toThrow(
        "corrupt or tampered"
      );
      await expect(writeMemoryCompactionReceipt(storePath, result.receipt)).rejects.toThrow("collision or corruption");
    });
  });

  it("rejects stale child plans and restore event-id collisions without issuing a unified receipt", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const plan = await previewStore(storePath, { project_id: "moryn", session_id: "session-current" });
      const late = sessionRecord({
        id: "late-status",
        type: "status",
        at: "2026-07-18T10:00:02.000Z",
        text: "Late evidence",
        session_id: "session-current"
      });
      await seedRecords(storePath, [late]);
      await expect(applyMemoryCompactionPlan(storePath, { plan, confirmed: true })).rejects.toThrow(
        "Stale Session Fold plan"
      );
      expect(await readMemoryCompactionReceipt(storePath, plan.plan_id)).toBeUndefined();
    });

    await withInitializedTempStore(async (storePath) => {
      await seedRecords(storePath, closedSessionRecords());
      const plan = await previewStore(storePath, { project_id: "moryn", session_id: "session-current" });
      const applied = await applyMemoryCompactionPlan(storePath, { plan, confirmed: true });
      const expected = buildMemoryCompactionRestoreEvents(applied.receipt);
      const collision = expected[0]!;
      const tampered: MorynEvent = { ...collision, source: { client: "tampered", device_id: "other" } };
      await appendEventIfAbsent(storePath, tampered);
      await expect(restoreMemoryCompactionPlan(storePath, { plan_id: plan.plan_id, confirmed: true })).rejects.toThrow(
        "event id collision"
      );
    });
  });
});
