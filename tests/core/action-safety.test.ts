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
      },
      arguments_by_name: {
        kind: {
          type: "string",
          required: true,
          cli: { flag: "--kind" },
          mcp: { argument: "kind" }
        },
        text: {
          type: "string",
          required: false,
          cli: { flag: "--text" },
          mcp: { argument: "text" },
          alternatives: ["content"]
        },
        content: {
          type: "object",
          required: false,
          cli: { flag: "--content-json" },
          mcp: { argument: "content" },
          alternatives: ["text"]
        }
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
        allowed_values: ["memory", "skill"],
        mcp_targets: [{
          argument: "kind",
          type: "string",
          required: true,
          preferred: true
        }],
        cli_targets: [{
          flag: "--kind",
          type: "string",
          required: true,
          preferred: true
        }]
      },
      {
        field: "text_or_content",
        argument_path: "text|content",
        argument_paths: ["text", "content"],
        argument_source: "user_input.text_or_content",
        placeholder: "<text_or_content>",
        value: "<text_or_content>",
        alternatives: ["text", "content"],
        mcp_targets: [
          {
            argument: "text",
            type: "string",
            required: false,
            preferred: true
          },
          {
            argument: "content",
            type: "object",
            required: false,
            preferred: false
          }
        ],
        cli_targets: [
          {
            flag: "--text",
            type: "string",
            required: false,
            preferred: true
          },
          {
            flag: "--content-json",
            type: "object",
            required: false,
            preferred: false
          }
        ]
      }
    ]);
    expect(execution.required_inputs_by_field.text_or_content).toEqual({
      field: "text_or_content",
      argument_path: "text|content",
      argument_paths: ["text", "content"],
      argument_source: "user_input.text_or_content",
      placeholder: "<text_or_content>",
      value: "<text_or_content>",
      alternatives: ["text", "content"],
      mcp_targets: [
        {
          argument: "text",
          type: "string",
          required: false,
          preferred: true
        },
        {
          argument: "content",
          type: "object",
          required: false,
          preferred: false
        }
      ],
      cli_targets: [
        {
          flag: "--text",
          type: "string",
          required: false,
          preferred: true
        },
        {
          flag: "--content-json",
          type: "object",
          required: false,
          preferred: false
        }
      ]
    });
  });

  it("maps nested MCP and repeatable CLI argument paths for required inputs", () => {
    const execution = actionExecution({
      tool: "write",
      safe_to_run: false,
      required_fields: ["derived_from"],
      required_fields_by_name: {
        derived_from: {
          name: "derived_from",
          argument_path: "provenance.derived_from",
          placeholder: "<record_id>",
          value: "<record_id>"
        }
      },
      arguments_by_name: {
        derived_from: {
          type: "string[]",
          required: false,
          cli: { flag: "--derived-from", repeatable: true },
          mcp: { argument: "provenance", path: "provenance.derived_from" }
        }
      }
    });

    expect(execution.required_inputs_by_field.derived_from.mcp_targets).toEqual([{
      argument: "provenance",
      path: "provenance.derived_from",
      type: "string[]",
      required: false,
      preferred: true
    }]);
    expect(execution.required_inputs_by_field.derived_from.cli_targets).toEqual([{
      flag: "--derived-from",
      type: "string[]",
      required: false,
      repeatable: true,
      preferred: true
    }]);
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
