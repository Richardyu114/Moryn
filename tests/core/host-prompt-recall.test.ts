import { describe, expect, it } from "vitest";
import { buildExecutionOriginContext } from "../../src/core/execution-origin.js";
import { recoverHistoricalRecall } from "../../src/core/historical-recall.js";
import { buildPromptRecallContext } from "../../src/core/host-prompt-recall.js";
import type { RecallOutcome } from "../../src/core/recall-outcome.js";
import type { MorynRecord } from "../../src/core/types.js";

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

  it("injects bounded historical metadata without injecting unverified content", () => {
    const historicalRecord: MorynRecord = {
      id: "rec_historical",
      kind: "session_summary",
      type: "status",
      scope: "project",
      project_id: "moryn",
      tags: [],
      content: { text: "The historical release channel is cedar." },
      state: "archived",
      confidence: 0.8,
      priority: "normal",
      visibility: "archived",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:01.000Z",
      source: { client: "codex", session_id: "session-old" }
    };
    const historicalRecovery = recoverHistoricalRecall({
      records: [historicalRecord],
      active_working_set_record_ids: [],
      query: "release channel cedar"
    });
    const context = buildPromptRecallContext({
      outcome: outcome("verification_required", historicalRecord.id),
      results: [],
      question: "Which release channel should be used?",
      historical_recovery: historicalRecovery,
      capture_context: {
        project_id: "moryn",
        agent: { client: "codex", session_id: "session-current", device_id: "device-a" }
      }
    });
    const payload = JSON.parse(context.additional_context);

    expect(context).toMatchObject({ injected: true, record_count: 0 });
    expect(payload).toMatchObject({
      status: "historical_recovery",
      recovery: {
        trigger: "active_working_set_knowledge_gap",
        candidates: [
          {
            id: historicalRecord.id,
            state: "archived",
            content_mode: "full"
          }
        ],
        verification_action: {
          mcp_tool: "recall",
          mcp_arguments: {
            record_ids: [historicalRecord.id],
            states: ["archived"],
            include_private: false,
            project_id: "moryn"
          },
          external_side_effects: false
        }
      },
      learning_bridge: {
        candidate_record_id: historicalRecord.id,
        learning_delta_template: { related_record_ids: [historicalRecord.id] },
        queue_learning: {
          mcp_arguments: { related_record_ids: [historicalRecord.id] },
          lifecycle_consumption: "automatic_on_checkpoint_or_finish"
        }
      },
      feedback_bridge: {
        version: 1,
        record_id: historicalRecord.id,
        submission_policy: "exactly_one_final_outcome_per_recall_interaction",
        submit_after: "use_or_verification_is_complete",
        mcp_tool: "memory_feedback",
        mcp_arguments: {
          record_id: historicalRecord.id,
          outcome: "<recalled|used|verified|rejected>",
          idempotency_key: "<unique-recall-interaction-id>",
          source: { client: "codex", session_id: "session-current", device_id: "device-a" }
        }
      }
    });
    expect(payload.instruction).toContain("Do not reactivate archived source records directly");
    expect(context.additional_context).not.toContain("historical release channel is cedar");
  });

  it("prevents a trusted remote path from being presented as local knowledge", () => {
    const remoteRecord: MorynRecord = {
      id: "rec_remote_path",
      kind: "memory",
      type: "workspace_path",
      scope: "project",
      project_id: "moryn",
      tags: [],
      content: { text: "The checkout is /home/machine-a/moryn." },
      state: "canonical",
      confidence: 1,
      priority: "normal",
      visibility: "active",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
      source: { client: "codex", device_id: "device-a" }
    };
    const origin = buildExecutionOriginContext({
      current_device_id: "device-b",
      records: [remoteRecord]
    }).records_by_id[remoteRecord.id];
    const context = buildPromptRecallContext({
      outcome: outcome("trusted_match", remoteRecord.id),
      results: [{ record: remoteRecord, score: 1, origin }],
      question: "Where is the checkout?",
      capture_context: {
        project_id: "moryn",
        agent: { client: "codex", session_id: "session-b", device_id: "device-b" }
      }
    });
    const payload = JSON.parse(context.additional_context);

    expect(payload.instruction).not.toContain("trusted local knowledge");
    expect(payload.origin_boundary).toMatchObject({
      current_device: { device_id: "device-b" },
      records_by_id: {
        [remoteRecord.id]: {
          lineage: "remote_device_only",
          path_resolution: "require_explicit_device_or_workspace_mapping"
        }
      }
    });
    expect(payload.origin_boundary.instruction).toContain("do not access the same absolute path locally");
    expect(payload.records[0].origin).toMatchObject({
      creation: { relation_to_current_device: "other_device" }
    });
  });
});
