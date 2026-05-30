import { describe, expect, it } from "vitest";
import { actionExecution } from "../../src/core/action-safety.js";

describe("action execution readiness", () => {
  it("marks safe actions without authored fields as ready to run", () => {
    expect(actionExecution({
      tool: "recall",
      safe_to_run: true,
      required_fields: []
    })).toEqual({
      ready_to_run: true,
      next_step: "run",
      missing_required_fields: [],
      requires_user_confirmation: false,
      reason: "Action is safe and all required fields are already filled."
    });
  });

  it("tells agents to collect authored fields before running placeholders", () => {
    expect(actionExecution({
      tool: "agent_finish",
      safe_to_run: false,
      required_fields: ["summary"]
    })).toEqual({
      ready_to_run: false,
      next_step: "collect_required_fields",
      missing_required_fields: ["summary"],
      requires_user_confirmation: false,
      reason: "Action requires authored input before it can run."
    });
  });

  it("distinguishes confirmation-only actions from authored-input actions", () => {
    expect(actionExecution({
      tool: "promote",
      safe_to_run: false,
      required_fields: []
    })).toEqual({
      ready_to_run: false,
      next_step: "confirm_with_user",
      missing_required_fields: [],
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    });
  });

  it("blocks local config writes until a user confirms even after fields are known", () => {
    expect(actionExecution({
      tool: "project_init",
      safe_to_run: false,
      required_fields: []
    })).toEqual({
      ready_to_run: false,
      next_step: "confirm_with_user",
      missing_required_fields: [],
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    });
  });
});
