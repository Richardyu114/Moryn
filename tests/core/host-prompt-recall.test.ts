import { describe, expect, it } from "vitest";
import { buildPromptRecallContext } from "../../src/core/host-prompt-recall.js";
import type { RecallOutcome } from "../../src/core/recall-outcome.js";

function outcome(status: RecallOutcome["status"], bestRecordId?: string): RecallOutcome {
  return {
    status,
    reason: "test",
    recommended_action:
      status === "trusted_match"
        ? "use_trusted_match"
        : status === "verification_required"
          ? "verify_candidate"
          : "explore_then_capture_learning",
    ...(bestRecordId ? { best_record_id: bestRecordId } : {})
  };
}

describe("host prompt recall context", () => {
  it("returns a machine-readable learning bridge for a knowledge gap", () => {
    const question = "What protects production rollback?";
    const context = buildPromptRecallContext({
      outcome: outcome("knowledge_gap"),
      results: [],
      question,
      capture_context: {
        project_id: "moryn",
        current_task: "verify rollback",
        agent: { client: "codex", session_id: "session-a", device_id: "device-a" }
      }
    });
    const payload = JSON.parse(context.additional_context);

    expect(payload).toMatchObject({
      source: "moryn",
      status: "knowledge_gap",
      learning_bridge: {
        version: 1,
        question_source: "current_user_prompt",
        write_policy: "write_only_after_supported_reusable_conclusion",
        unresolved_policy: "preserve_investigation_at_checkpoint_before_compaction",
        learning_delta_template: {
          question: "<current user question or situation>",
          conclusion: "<supported reusable conclusion>",
          evidence_type: "<user_confirmed|source_code|documentation|web|inference>",
          scope: "project",
          confidence: "<0..1>",
          recommended_kind: "memory",
          recommended_type: "fact",
          related_record_ids: []
        },
        queue_learning: {
          mcp_tool: "learn",
          mcp_arguments: {
            project_id: "moryn",
            question: "<current user question or situation>",
            conclusion: "<supported reusable conclusion>",
            evidence_type: "<user_confirmed|source_code|documentation|web|inference>",
            current_task: "verify rollback",
            source: { client: "codex", session_id: "session-a", device_id: "device-a" }
          },
          lifecycle_consumption: "automatic_on_checkpoint_or_finish"
        }
      }
    });
    expect(context.additional_context).not.toContain(question);
  });

  it("carries the candidate id into a verification bridge", () => {
    const context = buildPromptRecallContext({
      outcome: outcome("verification_required", "rec_candidate"),
      results: [],
      question: "Is the rollback record still current?",
      capture_context: {
        project_id: "moryn",
        agent: { client: "claude", session_id: "session-b", device_id: "device-b" }
      }
    });
    const payload = JSON.parse(context.additional_context);

    expect(payload).toMatchObject({
      status: "verification_required",
      candidate_record_id: "rec_candidate",
      learning_bridge: {
        candidate_record_id: "rec_candidate",
        question_source: "current_user_prompt",
        learning_delta_template: {
          question: "<verified question or situation>",
          related_record_ids: ["rec_candidate"]
        },
        queue_learning: expect.objectContaining({ mcp_tool: "learn" })
      }
    });
  });
});
