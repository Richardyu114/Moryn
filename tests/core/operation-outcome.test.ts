import { describe, expect, it } from "vitest";
import { automationOutcome, failedAutomationOutcome } from "../../src/core/operation-outcome.js";

const validIdempotency = {
  version: 1,
  operation: "write",
  key_digest: "a".repeat(64),
  request_digest: "b".repeat(64)
};

describe("automation outcome", () => {
  it("classifies clean reads and durable mutations", () => {
    expect(automationOutcome({ results: [] })).toEqual({
      status: "completed",
      committed: false,
      retryable: false
    });
    expect(automationOutcome({ committed: true, durability: "confirmed" })).toEqual({
      status: "completed",
      committed: true,
      retryable: false
    });
  });

  it("surfaces partial durability, deferred work, and rebuild failures as retryable warnings", () => {
    for (const result of [
      {
        committed: true,
        durability: "best_effort",
        events: [{ event_id: "evt-idempotent", op: "upsert_record", idempotency: validIdempotency }]
      },
      { committed: true, derived_views_refreshed: false },
      { committed: true, deferred_work: [{ work: "push" }] },
      { committed: true, warnings: [{ code: "PARTIAL" }] }
    ]) {
      expect(automationOutcome(result)).toMatchObject({
        status: "completed_with_warnings",
        committed: true,
        retryable: true
      });
    }
  });

  it("does not instruct automation to retry a committed mutation without idempotency protection", () => {
    expect(
      automationOutcome({
        committed: true,
        idempotent_replay: false,
        durability: "best_effort",
        events: [{ event_id: "evt-non-idempotent", op: "upsert_record" }]
      })
    ).toEqual({
      status: "completed_with_warnings",
      committed: true,
      retryable: false,
      next_action: {
        recommended_action: "inspect_returned_committed_result_before_new_mutation",
        reason: "mutation_committed_without_idempotency_key",
        inspection_source: "returned_committed_result",
        committed_event_ids: ["evt-non-idempotent"],
        safe_to_run: true,
        retry_original_mutation: false
      }
    });
  });

  it("does not trust malformed event idempotency metadata", () => {
    expect(
      automationOutcome({
        committed: true,
        durability: "best_effort",
        events: [{ event_id: "evt-malformed-idempotency", op: "upsert_record", idempotency: { version: 1 } }]
      })
    ).toMatchObject({
      status: "completed_with_warnings",
      committed: true,
      retryable: false,
      next_action: {
        reason: "mutation_committed_without_idempotency_key",
        committed_event_ids: ["evt-malformed-idempotency"],
        retry_original_mutation: false
      }
    });
  });

  it("uses explicit idempotency protection when wrapper results omit mutation events", () => {
    expect(
      automationOutcome({
        committed: true,
        durability: "best_effort",
        idempotency_protected: false
      })
    ).toEqual({
      status: "completed_with_warnings",
      committed: true,
      retryable: false,
      next_action: {
        recommended_action: "inspect_returned_committed_result_before_new_mutation",
        reason: "mutation_committed_without_idempotency_key",
        inspection_source: "returned_committed_result",
        safe_to_run: true,
        retry_original_mutation: false
      }
    });

    expect(
      automationOutcome({
        committed: true,
        durability: "best_effort",
        idempotency_protected: true
      })
    ).toEqual({
      status: "completed_with_warnings",
      committed: true,
      retryable: true
    });
  });

  it("does not recommend an identical replay when directory sync is unsupported", () => {
    expect(
      automationOutcome({
        committed: true,
        idempotent_replay: true,
        durability: "best_effort",
        warnings: [
          {
            code: "IDEMPOTENT_EVENT_DIRECTORY_SYNC_UNSUPPORTED",
            reason: "directory sync unsupported: ENOTSUP"
          }
        ]
      })
    ).toEqual({
      status: "completed_with_warnings",
      committed: true,
      retryable: false
    });
  });

  it("treats non-ready automation states as actionable warnings", () => {
    for (const status of ["changes_planned", "needs_attention", "needs_reconcile"]) {
      expect(automationOutcome({ status, ready: false, committed: false })).toMatchObject({
        status: "completed_with_warnings",
        committed: false,
        retryable: true
      });
    }
  });

  it("preserves failure actions for machine clients", () => {
    const action = { command: "moryn rebuild" };
    expect(automationOutcome({ status: "failed", committed: false, next_action: action })).toEqual({
      status: "failed",
      committed: false,
      retryable: true,
      next_action: action
    });
    expect(failedAutomationOutcome(action)).toEqual({
      status: "failed",
      committed: false,
      retryable: true,
      next_action: action
    });
    expect(failedAutomationOutcome(action, { committed: true })).toEqual({
      status: "failed",
      committed: true,
      retryable: true,
      next_action: action
    });
    expect(failedAutomationOutcome(null)).toEqual({
      status: "failed",
      committed: false,
      retryable: true,
      next_action: null
    });
  });

  it("derives committed deadline retry safety and fallback guidance from the committed result", () => {
    expect(
      failedAutomationOutcome(undefined, {
        committed: true,
        recovery_hint: {
          committed_result: {
            committed: true,
            durability: "best_effort",
            events: [{ event_id: "evt-deadline-committed", op: "upsert_record" }]
          }
        }
      })
    ).toEqual({
      status: "failed",
      committed: true,
      retryable: false,
      next_action: {
        recommended_action: "inspect_returned_committed_result_before_new_mutation",
        reason: "mutation_committed_without_idempotency_key",
        inspection_source: "returned_committed_result",
        committed_event_ids: ["evt-deadline-committed"],
        safe_to_run: true,
        retry_original_mutation: false
      }
    });

    expect(
      failedAutomationOutcome(undefined, {
        committed: true,
        recovery_hint: {
          committed_result: {
            committed: true,
            durability: "best_effort",
            events: [{ event_id: "evt-deadline-idempotent", op: "upsert_record", idempotency: validIdempotency }]
          }
        }
      })
    ).toMatchObject({ status: "failed", committed: true, retryable: true });

    expect(
      failedAutomationOutcome(undefined, {
        committed: true,
        recovery_hint: {
          committed_result: {
            committed: true,
            durability: "best_effort",
            idempotency_protected: false
          }
        }
      })
    ).toEqual({
      status: "failed",
      committed: true,
      retryable: false,
      next_action: {
        recommended_action: "inspect_returned_committed_result_before_new_mutation",
        reason: "mutation_committed_without_idempotency_key",
        inspection_source: "returned_committed_result",
        safe_to_run: true,
        retry_original_mutation: false
      }
    });

    expect(
      failedAutomationOutcome(undefined, {
        committed: true,
        recovery_hint: {
          committed_result: {
            committed: true,
            durability: "best_effort",
            idempotency_protected: true
          }
        }
      })
    ).toEqual({
      status: "failed",
      committed: true,
      retryable: true
    });
  });
});
