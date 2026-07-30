import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("Engine historical recall", () => {
  it("falls back to archived history without writing and exposes an evidence-backed upgrade action", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        id: (prefix) => `${prefix}_history`
      });
      const historical = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "The rare rollback phrase is silver-pine." },
        state: "archived",
        confidence: 0.8,
        source: { client: "codex", session_id: "session-old" }
      });
      const before = await readEvents(storePath);

      const recovered = await engine.recall({
        query: "rollback phrase silver-pine",
        project_id: "moryn"
      });
      const after = await readEvents(storePath);

      expect(after).toHaveLength(before.length);
      expect(recovered.results).toEqual([]);
      expect(recovered.outcome).toMatchObject({
        status: "verification_required",
        best_record_id: historical.record.id,
        trust: "limited",
        best_result_source: "historical_recovery",
        best_result_path: `historical_recovery.matches_by_record_id.${historical.record.id}`
      });
      expect(recovered.historical_recovery).toMatchObject({
        status: "recovered",
        matches: [
          {
            record_id: historical.record.id,
            state: "archived",
            reasons: ["archived", "cold"],
            content_mode: "full"
          }
        ],
        upgrade: {
          mode: "capture_learning_delta_after_verification",
          automatic_source_reactivation: false,
          evidence_record_ids: [historical.record.id]
        }
      });
      expect(recovered.next_actions_by_id.capture_confirmed_learning).toMatchObject({
        evidence: { record_ids: [historical.record.id] },
        arguments_by_name: { related_record_ids: [historical.record.id] }
      });
      expect(recovered.selection_sources.historical_record_id).toBe(
        "historical_recovery.matches_by_record_id.<record_id>.record_id"
      );
    });
  });

  it("recovers an oversized active record omitted by the normal working set", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        id: (prefix) => `${prefix}_oversized`
      });
      const oversized = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: `oversized recall marker cobalt ${"background ".repeat(9_000)}` },
        state: "candidate",
        confidence: 0.7,
        source: { client: "codex" }
      });

      const recovered = await engine.recall({
        query: "oversized recall marker cobalt",
        project_id: "moryn"
      });

      expect(recovered.results).toEqual([]);
      expect(recovered.memory_working_set.counts.excluded_records).toBeGreaterThan(0);
      expect(recovered.historical_recovery?.matches[0]).toMatchObject({
        record_id: oversized.record.id,
        reasons: ["working_set_omitted"],
        content_mode: "excerpt"
      });
      expect(recovered.historical_recovery?.stats.returned_estimated_tokens).toBeLessThanOrEqual(2_000);
    });
  });

  it("searches history when an active summary matches the topic but omits the requested detail", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        id: (prefix) => `${prefix}_partial_summary_${++nextId}`
      });
      const historical = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "The release channel was cedar." },
        state: "archived",
        confidence: 0.8,
        source: { client: "codex", session_id: "session-old" }
      });
      const summary = await engine.write({
        kind: "session_summary",
        type: "session_rollup",
        scope: "project",
        project_id: "moryn",
        content: { text: "The release channel was discussed." },
        state: "candidate",
        confidence: 0.7,
        source: { client: "codex", session_id: "session-current" }
      });

      const recovered = await engine.recall({
        query: "release channel cedar",
        project_id: "moryn",
        kinds: ["session_summary"]
      });

      expect(recovered.results[0]?.record.id).toBe(summary.record.id);
      expect(recovered.outcome).toMatchObject({
        status: "verification_required",
        best_record_id: historical.record.id,
        coverage: 1,
        best_result_source: "historical_recovery"
      });
      expect(recovered.historical_recovery).toMatchObject({
        status: "recovered",
        trigger: "active_working_set_verification_required",
        matches: [{ record_id: historical.record.id }],
        upgrade: {
          evidence_record_ids: [historical.record.id],
          candidate_record_ids: [historical.record.id]
        }
      });
    });
  });

  it("refreshes a changed retrieval snapshot before classifying retained history", async () => {
    await withInitializedTempStore(async (storePath) => {
      const currentRecord = {
        id: "rec-current-race",
        kind: "memory" as const,
        type: "fact",
        scope: "project" as const,
        project_id: "moryn",
        tags: [],
        content: { text: "The current deployment marker is cobalt." },
        state: "canonical" as const,
        confidence: 0.95,
        priority: "normal" as const,
        visibility: "active" as const,
        created_at: "2026-07-30T00:00:00.000Z",
        updated_at: "2026-07-30T00:00:00.000Z",
        source: { client: "codex" },
        provenance: { method: "rule-promoted" as const }
      };
      const oldManifest = { count: 0, digest: "a".repeat(64) };
      const currentManifest = { count: 1, digest: "b".repeat(64) };
      let retrievalReads = 0;
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        readRetrievalCandidates: async () => {
          retrievalReads += 1;
          const refreshed = retrievalReads > 1;
          return {
            records: refreshed ? [currentRecord] : [],
            source: "retrieval_index" as const,
            repaired: refreshed,
            event_manifest: refreshed ? currentManifest : oldManifest,
            total_active_records: refreshed ? 1 : 0,
            global_records: 0,
            project_buckets: 1,
            candidate_count: refreshed ? 1 : 0
          };
        },
        readCurrentRecords: async () => ({
          records: [currentRecord],
          source: "event_replay" as const,
          repaired: false,
          event_manifest: currentManifest
        })
      });

      const result = await engine.recall({ query: "current deployment marker cobalt", project_id: "moryn" });

      expect(retrievalReads).toBe(2);
      expect(result.results[0]?.record.id).toBe(currentRecord.id);
      expect(result.outcome).toMatchObject({
        status: "trusted_match",
        best_record_id: currentRecord.id,
        best_result_source: "results",
        best_result_path: `results_by_id.${currentRecord.id}`
      });
      expect(result.historical_recovery).toBeUndefined();
    });
  });

  it("keeps the active result when historical coverage only ties", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_tie_${++nextId}` });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Release channel history was archived." },
        state: "archived",
        source: { client: "codex" }
      });
      const active = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Release channel planning is active." },
        state: "candidate",
        source: { client: "codex" }
      });

      const result = await engine.recall({ query: "release channel cedar", project_id: "moryn" });

      expect(result.historical_recovery?.status).toBe("recovered");
      expect(result.outcome).toMatchObject({
        best_record_id: active.record.id,
        coverage: 2 / 3,
        best_result_source: "results",
        best_result_path: `results_by_id.${active.record.id}`
      });
    });
  });

  it("does not let expired history replace a non-stale active partial match", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        id: (prefix) => `${prefix}_stale_${++nextId}`
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "The release channel was cedar.",
          memory_retention: {
            version: 2,
            validity: { valid_until: "2026-07-20T00:00:00.000Z" }
          }
        },
        state: "archived",
        source: { client: "codex" }
      });
      const active = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "The release channel is under review." },
        state: "candidate",
        source: { client: "codex" }
      });

      const result = await engine.recall({ query: "release channel cedar", project_id: "moryn" });

      expect(result.historical_recovery?.matches[0]).toMatchObject({ validity_status: "expired", stale: true });
      expect(result.outcome).toMatchObject({
        best_record_id: active.record.id,
        stale: false,
        best_result_source: "results"
      });
    });
  });

  it("does not scan retained history for a complete current verification result", async () => {
    await withInitializedTempStore(async (storePath) => {
      const candidate = {
        id: "rec-current-candidate",
        kind: "memory" as const,
        type: "fact",
        scope: "project" as const,
        project_id: "moryn",
        tags: [],
        content: { text: "The complete current marker is violet." },
        state: "candidate" as const,
        confidence: 0.7,
        priority: "normal" as const,
        visibility: "active" as const,
        created_at: "2026-07-30T00:00:00.000Z",
        updated_at: "2026-07-30T00:00:00.000Z",
        source: { client: "codex" }
      };
      let fullReads = 0;
      const engine = createEngine({
        storePath,
        readRetrievalCandidates: async () => ({
          records: [candidate],
          source: "retrieval_index" as const,
          repaired: false,
          event_manifest: { count: 1, digest: "c".repeat(64) },
          total_active_records: 1,
          global_records: 0,
          project_buckets: 1,
          candidate_count: 1
        }),
        readCurrentRecords: async () => {
          fullReads += 1;
          throw new Error("full retained-history read should not run");
        }
      });

      const result = await engine.recall({ query: "complete current marker violet", project_id: "moryn" });

      expect(fullReads).toBe(0);
      expect(result.outcome).toMatchObject({
        status: "verification_required",
        best_record_id: candidate.id,
        coverage: 1,
        best_result_source: "results"
      });
      expect(result.historical_recovery).toBeUndefined();
    });
  });

  it("turns verified recovered evidence into a compact current memory with retained provenance", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        id: (prefix) => `${prefix}_upgrade`
      });
      const historical = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "The recovered release channel is cedar." },
        state: "archived",
        confidence: 0.8,
        source: { client: "codex", session_id: "session-old" }
      });
      const first = await engine.recall({ query: "release channel cedar", project_id: "moryn" });
      expect(first.historical_recovery?.status).toBe("recovered");

      const ingestion = await engine.ingestLearnings({
        project_id: "moryn",
        learnings: [
          {
            question: "Which release channel should be used?",
            conclusion: "The release channel is cedar.",
            evidence_type: "user_confirmed",
            scope: "project",
            confidence: 0.95,
            recommended_kind: "memory",
            recommended_type: "fact",
            related_record_ids: first.historical_recovery!.upgrade.evidence_record_ids
          }
        ],
        occurred_at: "2026-07-30T10:00:01.000Z",
        source: { client: "codex", session_id: "session-current" }
      });
      const upgradedId = ingestion.dispositions[0]?.record_id;
      const second = await engine.recall({ query: "release channel cedar", project_id: "moryn" });

      expect(upgradedId).toBeTruthy();
      expect(second.outcome).toMatchObject({ status: "trusted_match", best_record_id: upgradedId });
      expect(second.results[0]?.record).toMatchObject({
        id: upgradedId,
        state: "canonical",
        content: { text: "The release channel is cedar." },
        provenance: { derived_from: [historical.record.id] }
      });
      expect(second.historical_recovery).toBeUndefined();
    });
  });

  it("fails the historical pass closed without breaking the normal knowledge-gap response", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        readRetrievalCandidates: async () => ({
          records: [],
          source: "retrieval_index",
          repaired: false,
          event_manifest: { count: 0, digest: "a".repeat(64) },
          total_active_records: 0,
          global_records: 0,
          project_buckets: 1,
          candidate_count: 0
        }),
        readCurrentRecords: async () => {
          throw new Error("simulated retained-history read failure with internal detail");
        }
      });

      const result = await engine.recall({ query: "missing historical detail", project_id: "moryn", limit: 1 });

      expect(result).toMatchObject({
        results: [],
        outcome: { status: "knowledge_gap" },
        historical_recovery: {
          status: "unavailable",
          matches: [],
          limits: { max_records: 1, token_budget: 2_000 },
          failure: { code: "HISTORICAL_RECALL_UNAVAILABLE", reason: "fallback_failed_closed" }
        }
      });
      expect(JSON.stringify(result)).not.toContain("simulated retained-history read failure");
    });
  });
});
