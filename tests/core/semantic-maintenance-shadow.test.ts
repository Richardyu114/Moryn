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
      safety: { writes: "none", semantic_auto_apply: false, physical_purge: false }
    });
    expect(report.projection.guaranteed_after.estimated_tokens).toBe(
      report.projection.before.estimated_tokens - removedTokens
    );
    expect(JSON.stringify(records)).toBe(before);
  });

  it("does not claim a guaranteed reduction for semantic overlap without an authored merge", () => {
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
    expect(report.candidates[0]?.blocker_codes).toEqual(
      expect.arrayContaining(["authored_semantic_merge_required", "token_reduction_not_proven"])
    );
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
