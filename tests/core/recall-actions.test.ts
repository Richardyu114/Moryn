import { describe, expect, it } from "vitest";
import { buildRecallNextActions } from "../../src/core/recall-actions.js";
import type { RecallOutcome } from "../../src/core/recall-outcome.js";

function outcome(status: RecallOutcome["status"], bestRecordId?: string): RecallOutcome {
  return {
    status,
    best_record_id: bestRecordId,
    best_score: bestRecordId ? 20 : 0,
    coverage: bestRecordId ? 1 : 0,
    trust: status === "trusted_match" ? "trusted" : bestRecordId ? "limited" : "none",
    stale: false,
    recommended_action: status === "trusted_match"
      ? "use_recalled_knowledge"
      : status === "verification_required"
        ? "verify_then_use_or_learn"
        : "explore_then_capture_learning"
  };
}

describe("recall next actions", () => {
  it("uses trusted memory with record evidence and an optional timeline inspection", () => {
    const result = buildRecallNextActions({
      query: "release rollback policy",
      outcome: outcome("trusted_match", "rec-trusted"),
      include_private: false
    });

    expect(result.next_actions.map((action) => action.id)).toEqual([
      "use_recalled_knowledge",
      "inspect_record_timeline"
    ]);
    expect(result.next_actions_by_id.use_recalled_knowledge).toMatchObject({
      executor: "host_agent",
      safe_to_run: true,
      evidence: { record_ids: ["rec-trusted"] }
    });
    expect(result.next_actions_by_id.inspect_record_timeline).toMatchObject({
      executor: "moryn",
      arguments_by_name: { record_id: "rec-trusted", include_private: false },
      interfaces: {
        cli: { executable: "moryn", argv: ["timeline", "--record-id", "rec-trusted"] },
        mcp: { tool: "timeline", arguments: { record_id: "rec-trusted", include_private: false } }
      }
    });
  });

  it("requires external verification before capturing a weak or stale match", () => {
    const result = buildRecallNextActions({
      query: "release rollback policy",
      outcome: outcome("verification_required", "rec-candidate"),
      include_private: true
    });

    expect(result.next_actions.map((action) => action.id)).toEqual([
      "inspect_recalled_candidate",
      "verify_with_external_evidence",
      "capture_confirmed_learning"
    ]);
    expect(result.next_actions_by_id.inspect_recalled_candidate.interfaces.cli.argv).toContain("--include-private");
    expect(result.next_actions_by_id.verify_with_external_evidence).toMatchObject({
      executor: "host_agent",
      safe_to_run: true,
      execution: { external_side_effects: false }
    });
    expect(result.next_actions_by_id.verify_with_external_evidence.interfaces).toBeUndefined();
    expect(result.next_actions_by_id.capture_confirmed_learning).toMatchObject({
      executor: "host_agent",
      destinations: ["checkpoint.delta.learnings[]", "finish.learnings[]"],
      required_fields_by_name: {
        question: "question",
        conclusion: "conclusion",
        evidence_type: "evidence_type",
        scope: "scope",
        confidence: "confidence",
        recommended_kind: "recommended_kind",
        recommended_type: "recommended_type"
      }
    });
  });

  it("explores a knowledge gap and preserves it when still unresolved", () => {
    const result = buildRecallNextActions({
      query: "release rollback policy",
      outcome: outcome("knowledge_gap"),
      include_private: false
    });

    expect(result.next_actions.map((action) => action.id)).toEqual([
      "explore_external_sources",
      "capture_confirmed_learning",
      "preserve_unresolved_investigation"
    ]);
    expect(result.next_actions_by_id.explore_external_sources).toMatchObject({
      executor: "host_agent",
      source_order: ["project_files", "local_tools", "web_when_needed", "user_when_needed"]
    });
    expect(result.next_actions_by_id.preserve_unresolved_investigation).toMatchObject({
      executor: "host_agent",
      destinations: ["checkpoint.delta.blockers[]", "checkpoint.delta.next_steps[]", "checkpoint.delta.files[]"]
    });
    expect(Object.keys(result.next_actions_by_id)).toEqual(result.next_actions.map((action) => action.id));
  });
});
