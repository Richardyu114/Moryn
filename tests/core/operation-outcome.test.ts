import { describe, expect, it } from "vitest";
import { automationOutcome, failedAutomationOutcome } from "../../src/core/operation-outcome.js";

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
      { committed: true, durability: "best_effort" },
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
  });
});
