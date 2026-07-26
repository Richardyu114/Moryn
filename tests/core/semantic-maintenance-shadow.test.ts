import { describe, expect, it } from "vitest";
import { estimateMemoryRecordTokens } from "../../src/core/record-read-model.js";
import { buildSemanticMaintenanceShadowReport } from "../../src/core/semantic-maintenance-shadow.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "record-a",
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    tags: ["lifecycle"],
    content: { text: "Pull project memory before agent work starts" },
    state: "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    source: { client: "codex" },
    ...overrides
  };
}

describe("buildSemanticMaintenanceShadowReport", () => {
  it("proves an exact project duplicate pass strictly decreases current records and tokens", () => {
    const records = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })];
    const before = JSON.stringify(records);
    const report = buildSemanticMaintenanceShadowReport(records, { project_id: "moryn" });
    const removedTokens = estimateMemoryRecordTokens(records[1]) + estimateMemoryRecordTokens(records[2]);

    expect(report).toMatchObject({
      mode: "shadow",
      read_only: true,
      summary: { exact_duplicate_groups: 1, exact_duplicate_records: 2, auto_safe_candidates: 2 },
      projection: {
        strict_decrease_required: true,
        before: { current_records: 3 },
        guaranteed_after: { current_records: 1 },
        guaranteed_reduction: { current_records: 2, estimated_tokens: removedTokens, strict_decrease: true }
      },
      safety: { writes: "none", semantic_auto_apply: true, physical_purge: false }
    });
    expect(report.projection.guaranteed_after.estimated_tokens).toBe(
      report.projection.before.estimated_tokens - removedTokens
    );
    expect(JSON.stringify(records)).toBe(before);
  });

  it("does not claim a guaranteed reduction when an authored merge cannot prove token reduction", () => {
    const records = [
      record({ id: "new", content: { text: "Pull project memory before agent work starts" } }),
      record({ id: "old", content: { text: "Pull project memory when agent work begins" } })
    ];
    const report = buildSemanticMaintenanceShadowReport(records, {
      project_id: "moryn",
      minimum_token_overlap: 0.2
    });

    expect(report.summary).toMatchObject({ auto_safe_candidates: 0, review_candidates: 1 });
    expect(report.projection).toMatchObject({
      before: { current_records: 2 },
      guaranteed_after: { current_records: 2 },
      guaranteed_reduction: { current_records: 0, estimated_tokens: 0, strict_decrease: false },
      potential_after: {
        current_records: 1,
        estimated_tokens: null,
        token_projection: "not_proven_until_authored_merge"
      }
    });
    expect(report.candidates[0]?.blocker_codes).toEqual(["token_reduction_not_proven"]);
    expect(report.authored_merge_drafts[0]).toMatchObject({
      status: "blocked",
      blocker_codes: ["token_reduction_not_proven"]
    });
  });

  it("promotes a lossless authored draft to a guaranteed reduction only after both strict proofs pass", () => {
    const shared = `Moryn keeps this complete source-backed sentence ${"shared ".repeat(600)}.`;
    const records = [
      record({ id: "old", content: { text: `${shared} Old endpoint remains available.` } }),
      record({ id: "new", content: { text: `${shared} New endpoint is canonical.` } })
    ];
    const report = buildSemanticMaintenanceShadowReport(records, {
      project_id: "moryn",
      minimum_token_overlap: 0.2
    });

    expect(report.summary).toMatchObject({ authored_drafts_ready: 1, auto_safe_candidates: 1 });
    expect(report.candidates[0]).toMatchObject({ action: "auto_merge_lossless", auto_apply_safe: true });
    expect(report.authored_merge_drafts[0]).toMatchObject({
      status: "ready",
      proof: {
        coverage: { all_source_text_units_covered: true, dropped_fields: 0 },
        projection: { strict_record_decrease: true, strict_token_decrease: true }
      }
    });
    expect(report.projection).toMatchObject({
      before: { current_records: 2 },
      guaranteed_after: { current_records: 1 },
      guaranteed_reduction: { current_records: 1, strict_decrease: true }
    });
    expect(report.projection.guaranteed_after.estimated_tokens).toBeLessThan(report.projection.before.estimated_tokens);
    expect(JSON.stringify(report.authored_merge_drafts)).not.toContain(shared);
  });

  it("does not count blocked global or private exact records as a possible reduction", () => {
    const global = [
      record({ id: "global-a", scope: "global", project_id: undefined }),
      record({ id: "global-b", scope: "global", project_id: undefined })
    ];
    const privateRecords = [
      record({ id: "private-a", content: { text: "private duplicate", privacy: "private" } }),
      record({ id: "private-b", content: { text: "private duplicate", privacy: "private" } })
    ];
    const report = buildSemanticMaintenanceShadowReport([...global, ...privateRecords], {
      project_id: "moryn"
    });

    expect(report.inspected.omitted_private_records).toBe(2);
    expect(report.summary).toMatchObject({ blocked_candidates: 1, auto_safe_candidates: 0 });
    expect(report.projection.potential_reduction).toEqual({ current_records: 0, strict_decrease: false });
    expect(report.candidates[0]?.blocker_codes).toContain("global_scope_requires_review");
  });

  it("validates shadow bounds", () => {
    expect(() => buildSemanticMaintenanceShadowReport([], { candidate_limit: 0 })).toThrow("candidate_limit");
    expect(() => buildSemanticMaintenanceShadowReport([], { minimum_token_overlap: -1 })).toThrow(
      "minimum_token_overlap"
    );
  });
});
