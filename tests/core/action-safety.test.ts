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
      required_inputs: [],
      required_inputs_by_field: {},
      requires_user_confirmation: false,
      reason: "Action is safe and all required fields are already filled."
    });
  });

  it("tells agents to collect authored fields before running placeholders", () => {
    expect(actionExecution({
      tool: "agent_finish",
      safe_to_run: false,
      required_fields: ["summary"],
      required_fields_by_name: {
        summary: {
          name: "summary",
          argument_path: "summary",
          placeholder: "<summary>",
          value: "<summary>"
        }
      },
      argument_sources: {
        summary: "user_input.summary"
      }
    })).toEqual({
      ready_to_run: false,
      next_step: "collect_required_fields",
      missing_required_fields: ["summary"],
      required_inputs: [{
        field: "summary",
        argument_path: "summary",
        argument_paths: ["summary"],
        argument_source: "user_input.summary",
        placeholder: "<summary>",
        value: "<summary>"
      }],
      required_inputs_by_field: {
        summary: {
          field: "summary",
          argument_path: "summary",
          argument_paths: ["summary"],
          argument_source: "user_input.summary",
          placeholder: "<summary>",
          value: "<summary>"
        }
      },
      requires_user_confirmation: false,
      reason: "Action requires authored input before it can run."
    });
  });

  it("summarizes required field alternatives and allowed values for execution hosts", () => {
    const execution = actionExecution({
      tool: "write",
      safe_to_run: false,
      required_fields: ["kind", "text_or_content"],
      required_fields_by_name: {
        kind: {
          name: "kind",
          argument_path: "kind",
          placeholder: "<kind>",
          value: "<kind>",
          allowed_values: ["memory", "skill"]
        },
        text_or_content: {
          name: "text_or_content",
          argument_path: "text|content",
          placeholder: "<text_or_content>",
          value: "<text_or_content>",
          alternatives: ["text", "content"]
        }
      },
      argument_sources: {
        kind: "user_input.kind",
        text_or_content: "user_input.text_or_content"
      }
    });
    expect(execution.required_inputs).toEqual([
      {
        field: "kind",
        argument_path: "kind",
        argument_paths: ["kind"],
        argument_source: "user_input.kind",
        placeholder: "<kind>",
        value: "<kind>",
        allowed_values: ["memory", "skill"]
      },
      {
        field: "text_or_content",
        argument_path: "text|content",
        argument_paths: ["text", "content"],
        argument_source: "user_input.text_or_content",
        placeholder: "<text_or_content>",
        value: "<text_or_content>",
        alternatives: ["text", "content"]
      }
    ]);
    expect(execution.required_inputs_by_field.text_or_content).toEqual({
      field: "text_or_content",
      argument_path: "text|content",
      argument_paths: ["text", "content"],
      argument_source: "user_input.text_or_content",
      placeholder: "<text_or_content>",
      value: "<text_or_content>",
      alternatives: ["text", "content"]
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
      required_inputs: [],
      required_inputs_by_field: {},
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
      required_inputs: [],
      required_inputs_by_field: {},
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    });
  });
});
