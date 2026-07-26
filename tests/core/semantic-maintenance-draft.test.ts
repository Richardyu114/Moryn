import { describe, expect, it } from "vitest";
import {
  authorSemanticMaintenanceMergeDraft,
  publicSemanticMaintenanceMergeDraft
} from "../../src/core/semantic-maintenance-draft.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(id: string, text: string, overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    tags: ["deployment"],
    content: { format: "text", text },
    state: "canonical",
    confidence: 0.99,
    priority: "normal",
    visibility: "active",
    created_at: id === "old" ? "2026-07-20T00:00:00.000Z" : "2026-07-20T00:00:01.000Z",
    updated_at: id === "old" ? "2026-07-20T00:00:00.000Z" : "2026-07-20T00:00:01.000Z",
    source: { client: "codex" },
    ...overrides
  };
}

const candidate = {
  candidate_id: "candidate-1",
  source_record_id: "new",
  target_record_id: "old",
  token_overlap: 0.9,
  signals: ["token_overlap" as const, "shared_tag" as const]
};

describe("automatic semantic maintenance drafting", () => {
  it("proves complete segment coverage and strict record/token reduction before exposing an apply proposal", () => {
    const shared = `The verified deployment procedure preserves every source-backed detail ${"repeat ".repeat(600)}.`;
    const old = record("old", `${shared} The old endpoint remains available.`);
    const next = record("new", `${shared} The new endpoint is canonical.`);
    const draft = authorSemanticMaintenanceMergeDraft([old, next], candidate, { project_id: "moryn" });

    expect(draft).toMatchObject({
      status: "ready",
      blocker_codes: [],
      proof: {
        topic: { verified: true },
        coverage: {
          source_text_units: 4,
          covered_source_text_units: 4,
          all_source_text_units_covered: true,
          dropped_fields: 0
        },
        projection: {
          before_current_records: 2,
          after_current_records: 1,
          current_record_reduction: 1,
          strict_record_decrease: true,
          strict_token_decrease: true
        },
        recovery: { source_history_retained: true, physical_delete: false, source_digests_verified: true }
      }
    });
    expect(draft.proof.projection.after_estimated_tokens).toBeLessThan(draft.proof.projection.before_estimated_tokens);
    expect(draft.projected_record?.content.text).toBe(
      `${shared}\nThe old endpoint remains available.\nThe new endpoint is canonical.`
    );
    expect(publicSemanticMaintenanceMergeDraft(draft)).not.toHaveProperty("proposal");
    expect(JSON.stringify(publicSemanticMaintenanceMergeDraft(draft))).not.toContain(shared);
  });

  it("blocks weak-topic pairs and any scalar field conflict", () => {
    const old = record("old", "A short deployment note.", {
      content: { text: "A short deployment note.", owner: "old" }
    });
    const next = record("new", "Another unrelated note.", {
      content: { text: "Another unrelated note.", owner: "new" }
    });
    const weak = authorSemanticMaintenanceMergeDraft(
      [old, next],
      { ...candidate, token_overlap: 0.1, signals: ["shared_tag"] },
      { project_id: "moryn" }
    );
    expect(weak.blocker_codes).toContain("weak_topic_evidence");

    const conflict = authorSemanticMaintenanceMergeDraft([old, next], candidate, { project_id: "moryn" });
    expect(conflict.blocker_codes).toContain("conflicting_field_values");
    expect(conflict).not.toHaveProperty("proposal");
  });

  it("keeps protected memory types and third-record conflicts out of unattended apply", () => {
    const shared = `A complete preference statement ${"shared ".repeat(600)}.`;
    const old = record("old", `${shared} Old detail.`, { type: "user_preference" });
    const next = record("new", `${shared} New detail.`, { type: "user_preference" });
    const protectedDraft = authorSemanticMaintenanceMergeDraft([old, next], candidate, { project_id: "moryn" });
    expect(protectedDraft.blocker_codes).toContain("automatic_scope_not_allowed");

    const conflicted = record("new", `${shared} New detail.`, {
      conflict: { kind: "semantic", with: ["third"], resolution: "needs_review" }
    });
    const conflictDraft = authorSemanticMaintenanceMergeDraft(
      [record("old", `${shared} Old detail.`), conflicted],
      candidate,
      { project_id: "moryn" }
    );
    expect(conflictDraft.blocker_codes).toContain("automatic_scope_not_allowed");
  });
});
