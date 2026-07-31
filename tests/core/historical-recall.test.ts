import { describe, expect, it } from "vitest";
import { HISTORICAL_RECALL_SELECTION_SOURCES, recoverHistoricalRecall } from "../../src/core/historical-recall.js";
import { memoryRecordDigest } from "../../src/core/memory-expansion.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(id: string, overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: id },
    state: "candidate",
    confidence: 0.7,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    source: { client: "codex", session_id: "session-a" },
    ...overrides
  };
}

describe("historical recall recovery", () => {
  it("recovers a bounded archived source and reports its covering rollup", () => {
    const source = record("rec-source", {
      kind: "session_summary",
      type: "status",
      state: "archived",
      visibility: "archived",
      content: {
        text: "The emergency rollback code is phoenix-42.",
        memory_retention: {
          version: 2,
          layer: "L0",
          retention: { tier: "cold" },
          lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
        }
      }
    });
    const rollup = record("rec-rollup", {
      kind: "session_summary",
      type: "session_rollup",
      content: { text: "Release operations were completed." }
    });

    const result = recoverHistoricalRecall({
      records: [source, rollup],
      active_working_set_record_ids: [rollup.id],
      query: "rollback code phoenix-42",
      project_id: "moryn"
    });

    expect(result).toMatchObject({
      status: "recovered",
      trigger: "active_working_set_knowledge_gap",
      read_scope: "current_replay_history",
      upgrade: {
        mode: "capture_learning_delta_after_verification",
        automatic_source_reactivation: false,
        evidence_record_ids: [source.id]
      },
      selection_sources: HISTORICAL_RECALL_SELECTION_SOURCES
    });
    expect(result.matches_by_record_id[source.id]).toMatchObject({
      record_id: source.id,
      state: "archived",
      tier: "cold",
      reasons: ["archived", "cold"],
      covered_by_record_ids: [rollup.id],
      coverage: 1,
      content_mode: "full",
      record: source
    });
    expect(result.matches[0]).not.toHaveProperty("record");
    expect(JSON.stringify(result).split("The emergency rollback code is phoenix-42.")).toHaveLength(2);
  });

  it("returns an excerpt when the historical record exceeds the fallback budget", () => {
    const source = record("rec-large", {
      state: "archived",
      visibility: "archived",
      content: { text: `${"unrelated context ".repeat(160)}rare-rollback-token ${"more context ".repeat(160)}` }
    });

    const result = recoverHistoricalRecall({
      records: [source],
      active_working_set_record_ids: [],
      query: "rare-rollback-token",
      token_budget: 128
    });
    const match = result.matches_by_record_id[source.id];

    expect(match).toMatchObject({ record_id: source.id, content_mode: "excerpt" });
    expect(match?.record).toBeUndefined();
    expect(match?.excerpt).toContain("rare-rollback-token");
    expect(match?.returned_estimated_tokens).toBeLessThanOrEqual(128);
    expect(result.stats.returned_estimated_tokens).toBeLessThanOrEqual(128);
  });

  it("uses a digest-verified Session Fold as the covering rollup", () => {
    const activeSource = record("rec-session-source", {
      kind: "session_summary",
      type: "checkpoint",
      content: { text: "The old deployment checksum was glacier-17." }
    });
    const sourceDigest = memoryRecordDigest(activeSource);
    const archivedSource = {
      ...activeSource,
      state: "archived" as const,
      visibility: "archived" as const,
      updated_at: "2026-07-01T00:00:02.000Z"
    };
    const rollup = record("rec-session-rollup", {
      kind: "session_summary",
      type: "session_rollup",
      content: {
        text: "The deployment session was folded.",
        session_fold_version: 1,
        source_record_ids: [activeSource.id],
        source_digests: [
          {
            record_id: activeSource.id,
            digest: sourceDigest,
            updated_at: activeSource.updated_at
          }
        ]
      }
    });

    const result = recoverHistoricalRecall({
      records: [archivedSource, rollup],
      active_working_set_record_ids: [rollup.id],
      query: "deployment checksum glacier-17",
      project_id: "moryn"
    });

    expect(result.matches_by_record_id[archivedSource.id]?.covered_by_record_ids).toEqual([rollup.id]);
  });

  it("recovers two distinctive terms from a longer natural-language question", () => {
    const source = record("rec-natural-question", {
      state: "archived",
      visibility: "archived",
      content: { text: "The old deployment checksum was cobalt." }
    });

    const result = recoverHistoricalRecall({
      records: [source],
      active_working_set_record_ids: [],
      query: "Please remind me what unusual deployment checksum we used before"
    });

    expect(result.matches[0]).toMatchObject({
      record_id: source.id,
      matched_tokens: expect.arrayContaining(["deployment", "checksum"])
    });
    expect(result.matches[0]!.coverage).toBeLessThan(0.5);
  });

  it("does not recover history from generic question words alone", () => {
    const source = record("rec-generic-question", {
      state: "archived",
      visibility: "archived",
      content: { text: "This record does have what was requested." }
    });

    expect(
      recoverHistoricalRecall({
        records: [source],
        active_working_set_record_ids: [],
        query: "What does this have?"
      })
    ).toMatchObject({ status: "not_found", matches: [] });
  });

  it("recovers an unspaced Chinese historical query but rejects scattered character overlap", () => {
    const relevant = record("rec-chinese-history", {
      state: "archived",
      visibility: "archived",
      content: { text: "数据库迁移需要先创建备份，再执行兼容性检查。" }
    });
    const scattered = record("rec-scattered-chinese", {
      state: "archived",
      visibility: "archived",
      content: { text: "参数已记录，依据明确，仓库稳定，迁徙完成，移动端可用。" }
    });

    const result = recoverHistoricalRecall({
      records: [scattered, relevant],
      active_working_set_record_ids: [],
      query: "数据库迁移"
    });

    expect(result.matches.map((match) => match.record_id)).toEqual([relevant.id]);
  });

  it("finds active records omitted by the working-set budget without duplicating selected records", () => {
    const selected = record("rec-selected", { content: { text: "selected retention policy" } });
    const omitted = record("rec-omitted", { content: { text: "rare deployment checksum gamma-7" } });

    const result = recoverHistoricalRecall({
      records: [selected, omitted],
      active_working_set_record_ids: [selected.id],
      query: "deployment checksum gamma-7"
    });
    const selectedAgain = recoverHistoricalRecall({
      records: [selected],
      active_working_set_record_ids: [selected.id],
      query: "selected retention policy"
    });

    expect(result.matches[0]).toMatchObject({
      record_id: omitted.id,
      reasons: ["working_set_omitted"]
    });
    expect(selectedAgain).toMatchObject({ status: "not_found", matches: [] });
  });

  it("recovers a logically superseded predecessor and identifies its current successor", () => {
    const predecessor = record("rec-predecessor", {
      content: { text: "The retired deployment color is amber." }
    });
    const successor = record("rec-successor", {
      content: { text: "The current deployment process uses signed releases." },
      links: [
        {
          record_id: predecessor.id,
          link_type: "supersedes",
          reason: "Replaced by the signed release process.",
          created_at: "2026-07-01T00:00:01.000Z"
        }
      ]
    });

    const result = recoverHistoricalRecall({
      records: [predecessor, successor],
      active_working_set_record_ids: [successor.id],
      query: "retired deployment color amber"
    });

    expect(result.matches[0]).toMatchObject({
      record_id: predecessor.id,
      reasons: ["logical_history", "working_set_omitted"],
      logical_successor_record_id: successor.id
    });
  });

  it("does not expose private, quarantined, purged, or cross-project history", () => {
    const privateRecord = record("rec-private", {
      tags: ["private"],
      state: "archived",
      visibility: "archived",
      content: { text: "obsolete build detail violet" }
    });
    const quarantined = record("rec-quarantined", {
      state: "quarantined",
      visibility: "quarantined",
      content: { text: "obsolete build detail violet" }
    });
    const purged = record("rec-purged", {
      kind: "agent_note",
      type: "observation",
      state: "raw",
      content: {
        text: "obsolete build detail violet",
        memory_retention: {
          version: 2,
          retention: { tier: "purged" },
          lineage: { covered_by_record_ids: ["rec-rollup"], coverage_verified: true }
        }
      }
    });
    const otherProject = record("rec-other", {
      project_id: "other",
      state: "archived",
      visibility: "archived",
      content: { text: "obsolete build detail violet" }
    });
    const rawNote = record("rec-raw", {
      kind: "agent_note",
      type: "observation",
      state: "raw",
      content: {
        text: "obsolete build detail violet",
        memory_retention: { version: 2, retention: { tier: "cold" } }
      }
    });

    const result = recoverHistoricalRecall({
      records: [privateRecord, quarantined, purged, otherProject, rawNote],
      active_working_set_record_ids: [],
      query: "obsolete build detail violet",
      project_id: "moryn"
    });

    expect(result).toMatchObject({
      status: "not_found",
      matches: [],
      stats: {
        private_records_omitted: 1,
        quarantined_records_omitted: 1,
        purged_records_omitted: 1
      }
    });
    expect(JSON.stringify(result)).not.toContain("obsolete build detail");
    expect(JSON.stringify(result)).not.toContain(privateRecord.id);
    expect(JSON.stringify(result)).not.toContain(rawNote.id);
  });

  it("rechecks privacy before exposing successor and covering record ids", () => {
    const privateSuccessor = record("rec-private-successor", {
      tags: ["private"],
      content: { text: "Private replacement detail." },
      links: [
        {
          record_id: "rec-public-predecessor",
          link_type: "supersedes",
          created_at: "2026-07-01T00:00:01.000Z"
        }
      ]
    });
    const predecessor = record("rec-public-predecessor", {
      state: "archived",
      visibility: "archived",
      content: {
        text: "The retired deployment color is vermilion.",
        memory_retention: {
          version: 2,
          retention: { tier: "cold" },
          lineage: {
            covered_by_record_ids: [privateSuccessor.id],
            coverage_verified: true
          }
        }
      }
    });

    const result = recoverHistoricalRecall({
      records: [predecessor, privateSuccessor],
      active_working_set_record_ids: [],
      query: "retired deployment color vermilion",
      project_id: "moryn"
    });

    expect(result.matches[0]).toMatchObject({
      record_id: predecessor.id,
      covered_by_record_ids: []
    });
    expect(result.matches[0]).not.toHaveProperty("logical_successor_record_id");
    expect(JSON.stringify(result)).not.toContain(privateSuccessor.id);
  });

  it("redacts unsafe record ids from the complete historical projection", () => {
    const privateRecord = record("rec-private-reference", {
      tags: ["private"],
      state: "archived",
      visibility: "archived"
    });
    const rawRecord = record("rec-raw-reference", {
      kind: "agent_note",
      type: "observation",
      state: "raw"
    });
    const safeRelated = record("rec-safe-related");
    const historical = record("rec-public-history", {
      state: "archived",
      visibility: "archived",
      tags: ["audit", `mentions:${privateRecord.id}`, rawRecord.id],
      content: {
        text: "The retired deployment color is indigo.",
        references: [privateRecord.id, rawRecord.id]
      },
      source: { client: "codex", session_id: privateRecord.id, device_id: rawRecord.id },
      provenance: {
        derived_from: [privateRecord.id, rawRecord.id, safeRelated.id],
        reason: `Compared ${privateRecord.id} with ${rawRecord.id}.`
      },
      conflict: {
        kind: "semantic",
        with: [privateRecord.id, rawRecord.id, safeRelated.id],
        resolution: "needs_review"
      },
      links: [
        {
          record_id: privateRecord.id,
          link_type: "supports",
          reason: `Private ${privateRecord.id}`,
          created_at: "2026-07-01T00:00:01.000Z"
        },
        {
          record_id: rawRecord.id,
          link_type: "supports",
          reason: `Raw ${rawRecord.id}`,
          created_at: "2026-07-01T00:00:02.000Z"
        },
        {
          record_id: safeRelated.id,
          link_type: "supports",
          reason: `Safe relation excludes ${privateRecord.id} and ${rawRecord.id}`,
          created_at: "2026-07-01T00:00:03.000Z"
        }
      ]
    });

    const result = recoverHistoricalRecall({
      records: [historical, privateRecord, rawRecord, safeRelated],
      active_working_set_record_ids: [safeRelated.id],
      query: "retired deployment color indigo",
      project_id: "moryn"
    });
    const projected = result.matches_by_record_id[historical.id]?.record;

    expect(projected?.provenance?.derived_from).toEqual([safeRelated.id]);
    expect(projected?.conflict?.with).toEqual([safeRelated.id]);
    expect(projected?.links?.map((link) => link.record_id)).toEqual([safeRelated.id]);
    expect(JSON.stringify(result)).not.toContain(privateRecord.id);
    expect(JSON.stringify(result)).not.toContain(rawRecord.id);
    expect(JSON.stringify(projected)).toContain("[redacted-record-id]");
  });

  it("projects historical validity at the requested evaluation time", () => {
    const historical = record("rec-expired-history", {
      state: "archived",
      visibility: "archived",
      content: {
        text: "The expired release channel is amber.",
        memory_retention: {
          version: 2,
          validity: { valid_until: "2026-07-20T00:00:00.000Z" }
        }
      }
    });

    const result = recoverHistoricalRecall({
      records: [historical],
      active_working_set_record_ids: [],
      query: "expired release channel amber",
      project_id: "moryn",
      now: "2026-07-30T00:00:00.000Z"
    });

    expect(result.matches[0]).toMatchObject({ validity_status: "expired", stale: true });
  });

  it("keeps all matches inspectable but prefills only the best candidate for upgrade", () => {
    const older = record("rec-history-older", {
      state: "archived",
      visibility: "archived",
      content: { text: "The historical release channel is cedar." }
    });
    const newer = record("rec-history-newer", {
      state: "archived",
      visibility: "archived",
      updated_at: "2026-07-02T00:00:00.000Z",
      content: { text: "The historical release channel is cedar." }
    });

    const result = recoverHistoricalRecall({
      records: [older, newer],
      active_working_set_record_ids: [],
      query: "historical release channel cedar"
    });

    expect(result.upgrade).toEqual({
      mode: "capture_learning_delta_after_verification",
      automatic_source_reactivation: false,
      evidence_record_ids: [newer.id],
      candidate_record_ids: [newer.id, older.id]
    });
    expect(Object.keys(result.matches_by_record_id)).toEqual([newer.id, older.id]);
  });
});
