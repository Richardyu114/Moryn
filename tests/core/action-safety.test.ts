import { describe, expect, it } from "vitest";
import { actionExecution } from "../../src/core/action-safety.js";

const callMcpStep = {
  step: "call_mcp",
  transport: "mcp",
  guard: "execution.ready_to_run",
  mcp: "interfaces.mcp",
  mcp_tool: "interfaces.mcp.tool",
  mcp_arguments: "interfaces.mcp.arguments",
  cli_exec_file: "interfaces.cli.exec_file",
  cli_command_line: "interfaces.cli.command_line",
  cli_placeholders: "interfaces.cli.placeholders"
};

const collectRequiredInputsStep = {
  step: "collect_required_inputs",
  reason: "required_fields",
  missing_required_fields: "execution.missing_required_fields",
  required_inputs: "execution.required_inputs",
  required_input_collect: "execution.required_inputs[].collect",
  required_input_expected_value: "execution.required_inputs[].collect.expected_value",
  required_input_choices: "execution.required_inputs[].collect.choices[]",
  required_input_choice_apply_to: "execution.required_inputs[].collect.choices[].apply_to",
  required_input_choice_expected_value: "execution.required_inputs[].collect.choices[].expected_value",
  required_inputs_by_field: "execution.required_inputs_by_field",
  required_inputs_by_argument_path: "execution.required_inputs_by_argument_path"
};

const askUserConfirmationStep = {
  step: "ask_user_confirmation",
  reason: "user_confirmation",
  confirmation_required: "execution.requires_user_confirmation"
};

const summaryCollect = {
  source: "user",
  input_key: "summary",
  prompt: "Provide summary.",
  apply_to: {
    mcp_argument_paths: ["summary"]
  },
  value_path: "user_input.summary",
  expected_value: {
    value_path: "user_input.summary",
    kind: "string"
  },
  placeholder: "<summary>"
};

const textOrContentChoices = [
  {
    option: "text",
    argument_path: "text",
    value_path: "user_input.text_or_content",
    preferred: true,
    type: "string",
    expected_value: {
      value_path: "user_input.text_or_content",
      kind: "string",
      value_encoding: "string",
      type: "string"
    },
    apply_to: {
      mcp_argument_paths: ["text"],
      mcp_assignments: [{
        argument: "text",
        value_path: "user_input.text_or_content",
        preferred: true
      }],
      mcp_targets: [{
        argument: "text",
        type: "string",
        required: false,
        preferred: true
      }],
      cli_assignments: [{
        flag: "--text",
        value_path: "user_input.text_or_content",
        argv_template: ["--text", "<user_input.text_or_content>"],
        value_encoding: "string",
        type: "string",
        required: false,
        preferred: true
      }],
      cli_targets: [{
        flag: "--text",
        type: "string",
        required: false,
        preferred: true
      }]
    }
  },
  {
    option: "content",
    argument_path: "content",
    value_path: "user_input.text_or_content",
    preferred: false,
    type: "object",
    expected_value: {
      value_path: "user_input.text_or_content",
      kind: "json_object",
      value_encoding: "json",
      type: "object"
    },
    apply_to: {
      mcp_argument_paths: ["content"],
      mcp_assignments: [{
        argument: "content",
        value_path: "user_input.text_or_content",
        preferred: false
      }],
      mcp_targets: [{
        argument: "content",
        type: "object",
        required: false,
        preferred: false
      }],
      cli_assignments: [{
        flag: "--content-json",
        value_path: "user_input.text_or_content",
        argv_template: ["--content-json", "<json:user_input.text_or_content>"],
        value_encoding: "json",
        type: "object",
        required: false,
        preferred: false
      }],
      cli_targets: [{
        flag: "--content-json",
        type: "object",
        required: false,
        preferred: false
      }]
    }
  }
];

describe("action execution readiness", () => {
  it("exposes a runbook that tells hosts exactly how to run ready actions", () => {
    const execution = actionExecution({
      tool: "recall",
      safe_to_run: true,
      required_fields: []
    });

    expect(execution.runbook).toEqual({
      next: "call_mcp",
      steps: [callMcpStep]
    });
  });

  it("returns fresh runbook steps so caller mutation cannot affect later executions", () => {
    const first = actionExecution({
      tool: "recall",
      safe_to_run: true,
      required_fields: []
    });

    (first.runbook.steps[0] as { step: string }).step = "mutated_by_host";

    const second = actionExecution({
      tool: "recall",
      safe_to_run: true,
      required_fields: []
    });

    expect(second.runbook).toEqual({
      next: "call_mcp",
      steps: [callMcpStep]
    });
  });

  it("exposes a runbook that blocks placeholder execution until required inputs are collected", () => {
    const execution = actionExecution({
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
      }
    });

    expect(execution.runbook).toEqual({
      next: "collect_required_inputs",
      steps: [
        collectRequiredInputsStep,
        callMcpStep
      ]
    });
  });

  it("describes how hosts should collect and apply required inputs", () => {
    const execution = actionExecution({
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
      arguments_by_name: {
        summary: {
          type: "string",
          required: true,
          cli: { flag: "--summary" },
          mcp: { argument: "summary" }
        }
      },
      argument_sources: {
        summary: "user_input.summary"
      }
    });

    expect(execution.required_inputs_by_field.summary).toMatchObject({
      field: "summary",
      collect: {
        source: "user",
        input_key: "summary",
        prompt: "Provide summary.",
        apply_to: {
          mcp_argument_paths: ["summary"],
          mcp_assignments: [{
            argument: "summary",
            value_path: "user_input.summary",
            preferred: true
          }],
          cli_assignments: [{
            flag: "--summary",
            value_path: "user_input.summary",
            argv_template: ["--summary", "<user_input.summary>"],
            value_encoding: "string",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{ flag: "--summary", type: "string", required: true, preferred: true }]
        },
        value_path: "user_input.summary",
        expected_value: {
          value_path: "user_input.summary",
          kind: "string",
          value_encoding: "string"
        },
        placeholder: "<summary>"
      }
    });
  });

  it("orders collection before confirmation for local config writes", () => {
    const execution = actionExecution({
      tool: "project_init",
      safe_to_run: false,
      required_fields: ["path"],
      required_fields_by_name: {
        path: {
          name: "path",
          argument_path: "path",
          placeholder: "<path>",
          value: "<path>"
        }
      }
    });

    expect(execution.runbook).toEqual({
      next: "collect_required_inputs",
      steps: [
        collectRequiredInputsStep,
        askUserConfirmationStep,
        callMcpStep
      ]
    });
  });

  it("marks safe actions without authored fields as ready to run", () => {
    expect(actionExecution({
      tool: "recall",
      safe_to_run: true,
      required_fields: []
    })).toEqual({
      ready_to_run: true,
      next_step: "run",
      blocked_by: [],
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      required_inputs_by_argument_path: {},
      runbook: {
        next: "call_mcp",
        steps: [callMcpStep]
      },
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
      },
      required_input_selection_sources: {
        required_input: "next.execution.required_inputs_by_field.<field>",
        required_input_argument_path: "next.execution.required_inputs_by_argument_path.<argument_path>"
      }
    })).toEqual({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: ["required_fields"],
      missing_required_fields: ["summary"],
      required_inputs: [{
        field: "summary",
        argument_path: "summary",
        argument_paths: ["summary"],
        collect: summaryCollect,
        argument_source: "user_input.summary",
        selection_sources: {
          required_input: "next.execution.required_inputs_by_field.<field>",
          required_input_argument_path: "next.execution.required_inputs_by_argument_path.<argument_path>"
        },
        placeholder: "<summary>",
        value: "<summary>"
      }],
      required_inputs_by_field: {
        summary: {
          field: "summary",
          argument_path: "summary",
          argument_paths: ["summary"],
          collect: summaryCollect,
          argument_source: "user_input.summary",
          selection_sources: {
            required_input: "next.execution.required_inputs_by_field.<field>",
            required_input_argument_path: "next.execution.required_inputs_by_argument_path.<argument_path>"
          },
          placeholder: "<summary>",
          value: "<summary>"
        }
      },
      required_inputs_by_argument_path: {
        summary: {
          field: "summary",
          argument_path: "summary",
          argument_paths: ["summary"],
          collect: summaryCollect,
          argument_source: "user_input.summary",
          selection_sources: {
            required_input: "next.execution.required_inputs_by_field.<field>",
            required_input_argument_path: "next.execution.required_inputs_by_argument_path.<argument_path>"
          },
          placeholder: "<summary>",
          value: "<summary>"
        }
      },
      runbook: {
        next: "collect_required_inputs",
        steps: [
          collectRequiredInputsStep,
          callMcpStep
        ]
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
        collect: {
          source: "user",
          input_key: "kind",
          prompt: "Provide kind.",
          apply_to: {
            mcp_argument_paths: ["kind"],
            mcp_assignments: [{
              argument: "kind",
              value_path: "user_input.kind",
              preferred: true
            }],
            mcp_targets: [{
              argument: "kind",
              type: "string",
              required: true,
              preferred: true
            }],
            cli_assignments: [{
              flag: "--kind",
              value_path: "user_input.kind",
              argv_template: ["--kind", "<user_input.kind>"],
              value_encoding: "string",
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
          value_path: "user_input.kind",
          expected_value: {
            value_path: "user_input.kind",
            kind: "enum",
            value_encoding: "string",
            type: "string",
            allowed_values: ["memory", "skill"]
          },
          placeholder: "<kind>",
          allowed_values: ["memory", "skill"]
        },
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
        collect: {
          source: "user",
          input_key: "text_or_content",
          prompt: "Provide text or content.",
          apply_to: {
            assignment_mode: "choose_one",
            mcp_argument_paths: ["text", "content"],
            mcp_assignments: [
              {
                argument: "text",
                value_path: "user_input.text_or_content",
                preferred: true
              },
              {
                argument: "content",
                value_path: "user_input.text_or_content",
                preferred: false
              }
            ],
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
            cli_assignments: [
              {
                flag: "--text",
                value_path: "user_input.text_or_content",
                argv_template: ["--text", "<user_input.text_or_content>"],
                value_encoding: "string",
                type: "string",
                required: false,
                preferred: true
              },
              {
                flag: "--content-json",
                value_path: "user_input.text_or_content",
                argv_template: ["--content-json", "<json:user_input.text_or_content>"],
                value_encoding: "json",
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
          },
          value_path: "user_input.text_or_content",
          input_mode: "choose_one",
          choices: textOrContentChoices,
          placeholder: "<text_or_content>",
          alternatives: ["text", "content"]
        },
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
      collect: {
        source: "user",
        input_key: "text_or_content",
        prompt: "Provide text or content.",
        apply_to: {
          assignment_mode: "choose_one",
          mcp_argument_paths: ["text", "content"],
          mcp_assignments: [
            {
              argument: "text",
              value_path: "user_input.text_or_content",
              preferred: true
            },
            {
              argument: "content",
              value_path: "user_input.text_or_content",
              preferred: false
            }
          ],
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
          cli_assignments: [
            {
              flag: "--text",
              value_path: "user_input.text_or_content",
              argv_template: ["--text", "<user_input.text_or_content>"],
              value_encoding: "string",
              type: "string",
              required: false,
              preferred: true
            },
            {
              flag: "--content-json",
              value_path: "user_input.text_or_content",
              argv_template: ["--content-json", "<json:user_input.text_or_content>"],
              value_encoding: "json",
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
        },
        value_path: "user_input.text_or_content",
        input_mode: "choose_one",
        choices: textOrContentChoices,
        placeholder: "<text_or_content>",
        alternatives: ["text", "content"]
      },
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
    expect(execution.required_inputs_by_argument_path.text).toBe(execution.required_inputs_by_field.text_or_content);
    expect(execution.required_inputs_by_argument_path.content).toBe(execution.required_inputs_by_field.text_or_content);
    expect(execution.required_inputs_by_argument_path.kind).toBe(execution.required_inputs_by_field.kind);
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
    expect(execution.required_inputs_by_field.derived_from.collect.apply_to.mcp_assignments).toEqual([{
      argument: "provenance",
      path: "provenance.derived_from",
      value_path: "user_input.derived_from",
      preferred: true
    }]);
    expect(execution.required_inputs_by_field.derived_from.cli_targets).toEqual([{
      flag: "--derived-from",
      type: "string[]",
      required: false,
      repeatable: true,
      preferred: true
    }]);
    expect(execution.required_inputs_by_field.derived_from.collect.apply_to.cli_assignments).toEqual([{
      flag: "--derived-from",
      value_path: "user_input.derived_from",
      argv_template: ["--derived-from", "<user_input.derived_from[]>"],
      value_encoding: "repeat_values",
      type: "string[]",
      required: false,
      repeatable: true,
      preferred: true
    }]);
  });

  it("maps positional CLI assignments for collected required inputs", () => {
    const execution = actionExecution({
      tool: "promote",
      safe_to_run: false,
      required_fields: ["record_id"],
      required_fields_by_name: {
        record_id: {
          name: "record_id",
          argument_path: "record_id",
          placeholder: "<record_id>",
          value: "<record_id>"
        }
      },
      arguments_by_name: {
        record_id: {
          type: "string",
          required: true,
          cli: { positional: "record-id" },
          mcp: { argument: "record_id" }
        }
      },
      argument_sources: {
        record_id: "user_input.record_id"
      }
    });

    expect(execution.required_inputs_by_field.record_id.collect.apply_to.cli_assignments).toEqual([{
      positional: "record-id",
      value_path: "user_input.record_id",
      argv_template: ["<user_input.record_id>"],
      value_encoding: "string",
      type: "string",
      required: true,
      preferred: true
    }]);
  });

  it("preserves CLI defaults in assignments for collected required inputs", () => {
    const execution = actionExecution({
      tool: "project_init",
      safe_to_run: false,
      required_fields: ["path"],
      required_fields_by_name: {
        path: {
          name: "path",
          argument_path: "path",
          placeholder: "<path>",
          value: "<path>"
        }
      },
      arguments_by_name: {
        path: {
          type: "string",
          required: true,
          cli: { flag: "--path", default: "." },
          mcp: { argument: "path" }
        }
      },
      argument_sources: {
        path: "user_input.path"
      }
    });

    expect(execution.required_inputs_by_field.path.collect.apply_to.cli_assignments).toEqual([{
      flag: "--path",
      value_path: "user_input.path",
      argv_template: ["--path", "<user_input.path>"],
      value_encoding: "string",
      type: "string",
      required: true,
      default: ".",
      preferred: true
    }]);
  });

  it("describes path=value CLI assignments for collected patch objects", () => {
    const execution = actionExecution({
      tool: "revise",
      safe_to_run: false,
      required_fields: ["patch"],
      required_fields_by_name: {
        patch: {
          name: "patch",
          argument_path: "patch",
          placeholder: "<path=value>",
          value: "<path=value>"
        }
      },
      arguments_by_name: {
        patch: {
          type: "object",
          required: true,
          cli: { flag: "--set", repeatable: true },
          mcp: { argument: "patch" }
        }
      },
      argument_sources: {
        patch: "user_input.patch"
      }
    });

    expect(execution.required_inputs_by_field.patch.collect.apply_to.cli_assignments).toEqual([{
      flag: "--set",
      value_path: "user_input.patch",
      argv_template: ["--set", "<user_input.patch{path=value}[]>"],
      value_encoding: "path_value_entries",
      type: "object",
      required: true,
      repeatable: true,
      preferred: true
    }]);
  });

  it("describes multi-flag object CLI assignments with per-flag value paths", () => {
    const execution = actionExecution({
      tool: "agent_start",
      safe_to_run: false,
      required_fields: ["agent"],
      required_fields_by_name: {
        agent: {
          name: "agent",
          argument_path: "agent",
          placeholder: "<agent>"
        }
      },
      arguments_by_name: {
        agent: {
          type: "object",
          required: false,
          cli: { flags: ["--agent", "--session-id", "--model", "--device-id"] },
          mcp: { argument: "agent" }
        }
      },
      argument_sources: {
        agent: "user_input.agent"
      }
    });

    expect(execution.required_inputs_by_field.agent.collect.apply_to.cli_assignments).toEqual([{
      flags: ["--agent", "--session-id", "--model", "--device-id"],
      value_path: "user_input.agent",
      argv_template: [
        "--agent", "<user_input.agent.client>",
        "--session-id", "<user_input.agent.session_id>",
        "--model", "<user_input.agent.model>",
        "--device-id", "<user_input.agent.device_id>"
      ],
      value_encoding: "object_fields",
      flag_value_paths: [
        { flag: "--agent", value_path: "user_input.agent.client" },
        { flag: "--session-id", value_path: "user_input.agent.session_id" },
        { flag: "--model", value_path: "user_input.agent.model" },
        { flag: "--device-id", value_path: "user_input.agent.device_id" }
      ],
      type: "object",
      required: false,
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
      blocked_by: ["user_confirmation"],
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      required_inputs_by_argument_path: {},
      runbook: {
        next: "ask_user_confirmation",
        steps: [
          askUserConfirmationStep,
          callMcpStep
        ]
      },
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    });
  });

  it("keeps a call step after authored inputs are collected for agent-authored writes", () => {
    expect(actionExecution({
      tool: "revise",
      safe_to_run: false,
      required_fields: ["record_id"],
      required_fields_by_name: {
        record_id: {
          name: "record_id",
          argument_path: "record_id",
          placeholder: "<record_id>",
          value: "<record_id>"
        }
      }
    }).runbook).toEqual({
      next: "collect_required_inputs",
      steps: [
        collectRequiredInputsStep,
        callMcpStep
      ]
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
      blocked_by: ["user_confirmation"],
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      required_inputs_by_argument_path: {},
      runbook: {
        next: "ask_user_confirmation",
        steps: [
          askUserConfirmationStep,
          callMcpStep
        ]
      },
      requires_user_confirmation: true,
      reason: "Action requires explicit user confirmation before it can run."
    });
  });
});
