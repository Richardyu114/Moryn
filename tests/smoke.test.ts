import { describe, expect, it } from "vitest";
import {
  BOOT_SELECTION_SOURCES,
  DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
  DISCOVER_PROJECT_SELECTION_SOURCES,
  DOCTOR_SELECTION_SOURCES,
  GUIDE_ENTRYPOINT_SELECTION_SOURCES,
  GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
  GUIDE_SELECTION_SOURCES,
  HANDOFF_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIFECYCLE_ACTION_SELECTION_SOURCES,
  LIFECYCLE_NEXT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_INIT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  REBUILD_SELECTION_SOURCES,
  RECALL_SELECTION_SOURCES,
  REFRESH_SELECTION_SOURCES,
  REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
  SENSITIVE_REVISE_SELECTION_SOURCES,
  OPERATION_CONTRACTS_SELECTION_SOURCES,
  SELECTION_SOURCE_CONTRACTS,
  SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES,
  STORE_INIT_SELECTION_SOURCES,
  SYNC_RESULT_SELECTION_SOURCES,
  SYNC_STATUS_SELECTION_SOURCES,
  WRITE_SELECTION_SOURCES,
  getOperationContracts,
  getSelectionSourceContracts,
  version
} from "../src/index.js";

describe("package smoke test", () => {
  it("exports a version string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports sync selection source contracts from the package entrypoint", () => {
    expect(SYNC_STATUS_SELECTION_SOURCES.configured).toBe("configured");
    expect(SYNC_RESULT_SELECTION_SOURCES.pushed).toBe("pushed");
  });

  it("exports core response selection source contracts from the package entrypoint", () => {
    expect(STORE_INIT_SELECTION_SOURCES.config_file).toBe("artifacts.config");
    expect(PROJECT_INIT_SELECTION_SOURCES.project_id).toBe("config.project_id");
    expect(REBUILD_SELECTION_SOURCES.recall_index).toBe("artifacts.indexes.recall");
    expect(WRITE_SELECTION_SOURCES.record_id).toBe("record.id");
    expect(RECALL_SELECTION_SOURCES.result).toBe("results_by_id.<record_id>");
    expect(BOOT_SELECTION_SOURCES.skill).toBe("skills_by_id.<record_id>");
    expect(REFRESH_SELECTION_SOURCES.next_action).toBe("changes_by_record_id.<record_id>.next_action");
    expect(LIST_RECENT_SELECTION_SOURCES.record).toBe("records_by_id.<record_id>");
    expect(PROJECT_LIST_SELECTION_SOURCES.project).toBe("projects_by_id.<project_id>");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.next_action).toBe("project_list.projects_by_id.<project_id>.next");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.cli_executable).toBe("project_list.projects_by_id.<project_id>.next.interfaces.cli.executable");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.cli_argv).toBe("project_list.projects_by_id.<project_id>.next.interfaces.cli.argv[]");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.cli_args).toBe("project_list.projects_by_id.<project_id>.next.interfaces.cli.args[]");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.argument).toBe("project_list.projects_by_id.<project_id>.next.arguments_by_name.<argument>");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.required_field).toBe("project_list.projects_by_id.<project_id>.next.required_fields_by_name.<field>");
    expect(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES.argument_source).toBe("project_list.projects_by_id.<project_id>.next.argument_sources.<field>");
    expect(MUTATION_EVENT_SELECTION_SOURCES.event_id).toBe("event.event_id");
    expect(LINK_EVENT_SELECTION_SOURCES.linked_record_id).toBe("event.linked_record_id");
    expect(SENSITIVE_REVISE_SELECTION_SOURCES.quarantine_event_id).toBe("quarantine_event.event_id");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.ordered_next_action).toBe("refresh.changes[].next_action");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.cli_executable).toBe("refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.executable");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.cli_argv).toBe("refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.argv[]");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.cli_args).toBe("refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.args[]");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.argument).toBe("refresh.changes_by_record_id.<record_id>.next_action.arguments_by_name.<argument>");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.required_field).toBe("refresh.changes_by_record_id.<record_id>.next_action.required_fields_by_name.<field>");
    expect(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES.argument_source).toBe("refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>");
  });

  it("exports lifecycle and recovery selection source contracts from the package entrypoint", () => {
    expect(NEXT_ACTION_SELECTION_SOURCES.error_next_action).toBe("error.next_action");
    expect(NEXT_ACTION_SELECTION_SOURCES.error_cli_executable).toBe("error.next_action.interfaces.cli.executable");
    expect(NEXT_ACTION_SELECTION_SOURCES.error_cli_argv).toBe("error.next_action.interfaces.cli.argv[]");
    expect(NEXT_ACTION_SELECTION_SOURCES.error_cli_args).toBe("error.next_action.interfaces.cli.args[]");
    expect(NEXT_ACTION_SELECTION_SOURCES.error_argument).toBe("error.next_action.arguments_by_name.<argument>");
    expect(NEXT_ACTION_SELECTION_SOURCES.warning_argument).toBe("warning.next_action.arguments_by_name.<argument>");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action).toBe("next.actions_by_id.<action>");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action_cli_executable).toBe("next.actions_by_id.<action>.interfaces.cli.executable");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action_cli_argv).toBe("next.actions_by_id.<action>.interfaces.cli.argv[]");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action_cli_args).toBe("next.actions_by_id.<action>.interfaces.cli.args[]");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action_argument).toBe("next.actions_by_id.<action>.arguments_by_name.<argument>");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action_required_field).toBe("next.actions_by_id.<action>.required_fields_by_name.<field>");
    expect(LIFECYCLE_NEXT_SELECTION_SOURCES.action_argument_source).toBe("next.actions_by_id.<action>.argument_sources.<field>");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.ordered_action).toBe("next.actions[]");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.cli_executable).toBe("next.actions_by_id.<action>.interfaces.cli.executable");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.cli_argv).toBe("next.actions_by_id.<action>.interfaces.cli.argv[]");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.cli_args).toBe("next.actions_by_id.<action>.interfaces.cli.args[]");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.argument).toBe("next.actions_by_id.<action>.arguments_by_name.<argument>");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.required_field).toBe("next.actions_by_id.<action>.required_fields_by_name.<field>");
    expect(LIFECYCLE_ACTION_SELECTION_SOURCES.argument_source).toBe("next.actions_by_id.<action>.argument_sources.<field>");
    expect(GUIDE_SELECTION_SOURCES.guardrail).toBe("guardrails_by_id.<guardrail_id>");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.step).toBe("lifecycle_by_step.<step>.step");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.cli_executable).toBe("lifecycle_by_step.<step>.interfaces.cli.executable");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.cli_args).toBe("lifecycle_by_step.<step>.interfaces.cli.args[]");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.argument).toBe("lifecycle_by_step.<step>.arguments_by_name.<argument>");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.required_field).toBe("lifecycle_by_step.<step>.required_fields_by_name.<field>");
    expect(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES.argument_source).toBe("lifecycle_by_step.<step>.argument_sources.<field>");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.workflow_phase).toBe("workflow.phases_by_name.start_or_resume");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.startup_cli_executable).toBe("startup.interfaces.cli.executable");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.startup_cli_argv).toBe("startup.interfaces.cli.argv[]");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.startup_cli_args).toBe("startup.interfaces.cli.args[]");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.startup_argument).toBe("startup.arguments_by_name.<argument>");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.startup_required_field).toBe("startup.required_fields_by_name.<field>");
    expect(GUIDE_ENTRYPOINT_SELECTION_SOURCES.next_argument_source).toBe("next.argument_sources.<field>");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.next_cli_executable).toBe("next.interfaces.cli.executable");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.next_cli_argv).toBe("next.interfaces.cli.argv[]");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.next_cli_args).toBe("next.interfaces.cli.args[]");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action).toBe("next.actions_by_project_id.<project_id>");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action_cli_executable).toBe("next.actions_by_project_id.<project_id>.interfaces.cli.executable");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action_cli_argv).toBe("next.actions_by_project_id.<project_id>.interfaces.cli.argv[]");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action_cli_args).toBe("next.actions_by_project_id.<project_id>.interfaces.cli.args[]");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action_argument).toBe("next.actions_by_project_id.<project_id>.arguments_by_name.<argument>");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action_required_field).toBe("next.actions_by_project_id.<project_id>.required_fields_by_name.<field>");
    expect(DISCOVER_PROJECT_SELECTION_SOURCES.start_action_argument_source).toBe("next.actions_by_project_id.<project_id>.argument_sources.<field>");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.lifecycle_action).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.cli_executable).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.executable");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.cli_args).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.args[]");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.argument).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.arguments_by_name.<argument>");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.required_field).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.required_fields_by_name.<field>");
    expect(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES.argument_source).toBe("next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.argument_sources.<field>");
    expect(HANDOFF_SELECTION_SOURCES.active_session_next_action).toBe("handoff.active_sessions_by_record_id.<record_id>.next_action");
    expect(HANDOFF_SELECTION_SOURCES.active_session_next_action_cli_executable).toBe("handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.executable");
    expect(HANDOFF_SELECTION_SOURCES.active_session_next_action_cli_args).toBe("handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.args[]");
    expect(HANDOFF_SELECTION_SOURCES.active_session_next_action_argument).toBe("handoff.active_sessions_by_record_id.<record_id>.next_action.arguments_by_name.<argument>");
    expect(HANDOFF_SELECTION_SOURCES.active_session_next_action_argument_source).toBe("handoff.active_sessions_by_record_id.<record_id>.next_action.argument_sources.<field>");
    expect(DOCTOR_SELECTION_SOURCES.blocking_check).toBe("readiness.blocking_checks_by_name.<check_name>");
    expect(DOCTOR_SELECTION_SOURCES.next_cli_executable).toBe("next.interfaces.cli.executable");
    expect(DOCTOR_SELECTION_SOURCES.next_cli_argv).toBe("next.interfaces.cli.argv[]");
    expect(DOCTOR_SELECTION_SOURCES.next_cli_args).toBe("next.interfaces.cli.args[]");
    expect(DOCTOR_SELECTION_SOURCES.next_argument).toBe("next.arguments_by_name.<argument>");
    expect(DOCTOR_SELECTION_SOURCES.next_required_field).toBe("next.required_fields_by_name.<field>");
    expect(DOCTOR_SELECTION_SOURCES.next_argument_source).toBe("next.argument_sources.<field>");
  });

  it("exports grouped selection source contracts from the package entrypoint", () => {
    expect(SELECTION_SOURCE_CONTRACTS.setup.store_init).toBe(STORE_INIT_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.core.boot).toBe(BOOT_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.core.project_list_next_action).toBe(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.sync.result).toBe(SYNC_RESULT_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.lifecycle.guide).toBe(GUIDE_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.lifecycle.handoff).toBe(HANDOFF_SELECTION_SOURCES);
    expect(SELECTION_SOURCE_CONTRACTS.recovery.next_action).toBe(NEXT_ACTION_SELECTION_SOURCES);
  });

  it("exports a self-describing selection source contract response", () => {
    const response = getSelectionSourceContracts();

    expect(SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES).toEqual({
      contracts: "contracts",
      group: "contracts.<group>",
      contract: "contracts.<group>.<contract>",
      field: "contracts.<group>.<contract>.<field>"
    });
    expect(response.contracts).toBe(SELECTION_SOURCE_CONTRACTS);
    expect(response.selection_sources).toBe(SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES);
  });

  it("exports self-describing operation contracts from the package entrypoint", () => {
    const response = getOperationContracts();
    const operationRequiredInputSources = {
      required_input: OPERATION_CONTRACTS_SELECTION_SOURCES.required_input,
      required_input_argument_path: OPERATION_CONTRACTS_SELECTION_SOURCES.required_input_argument_path
    };

    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.operation).toBe("operations_by_id.<operation>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.mcp_tool_operation).toBe("operations_by_mcp_tool.<tool>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_command_operation).toBe("operations_by_cli_command.<command>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.argument).toBe("operations_by_id.<operation>.arguments_by_name.<argument>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.required_input).toBe("operations_by_id.<operation>.execution.required_inputs_by_field.<field>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.required_input_argument_path).toBe("operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_argv).toBe("operations_by_id.<operation>.interfaces.cli.argv[]");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_executable).toBe("operations_by_id.<operation>.interfaces.cli.executable");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_args).toBe("operations_by_id.<operation>.interfaces.cli.args[]");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_exec_file).toBe("operations_by_id.<operation>.interfaces.cli.exec_file");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_placeholder).toBe("operations_by_id.<operation>.interfaces.cli.placeholders[]");
    expect(OPERATION_CONTRACTS_SELECTION_SOURCES.cli_command_line).toBe("operations_by_id.<operation>.interfaces.cli.command_line");
    expect(response.recommended_entrypoint).toBe("agent_enter");
    expect(response.selection_sources).toBe(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(response.operations_by_mcp_tool.agent_enter).toBe(response.operations_by_id.agent_enter);
    expect(response.operations_by_mcp_tool.operation_contracts).toBe(response.operations_by_id.operation_contracts);
    expect(response.operations_by_mcp_tool.write).toBe(response.operations_by_id.write);
    expect(response.operations_by_cli_command["moryn agent enter"]).toBe(response.operations_by_id.agent_enter);
    expect(response.operations_by_cli_command["moryn contracts operations"]).toBe(response.operations_by_id.operation_contracts);
    expect(response.operations_by_cli_command["moryn write --kind <kind> --type <type> --scope <scope> --text <text>"]).toBe(response.operations_by_id.write);
    expect(response.operations_by_id.agent_enter.selection_sources).toBe(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(response.operations_by_id.write.selection_sources).toBe(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(response.operations_by_mcp_tool.write.selection_sources).toBe(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(response.operations_by_cli_command["moryn write --kind <kind> --type <type> --scope <scope> --text <text>"].selection_sources).toBe(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(response.operations_by_id.agent_enter.interfaces.cli.executable).toBe("moryn");
    expect(response.operations_by_id.agent_enter.interfaces.cli.argv).toEqual(["agent", "enter"]);
    expect(response.operations_by_id.agent_enter.interfaces.cli.args).toEqual(["agent", "enter"]);
    expect(response.operations_by_id.agent_enter.interfaces.cli.placeholders).toEqual([]);
    expect(response.operations_by_id.agent_enter.interfaces.cli.has_placeholders).toBe(false);
    expect(response.operations_by_id.agent_enter.interfaces.cli.command_line).toBe("moryn agent enter");
    expect(response.operations_by_id.operation_contracts.interfaces.cli.executable).toBe("moryn");
    expect(response.operations_by_id.operation_contracts.interfaces.cli.argv).toEqual(["contracts", "operations"]);
    expect(response.operations_by_id.operation_contracts.interfaces.cli.args).toEqual(["contracts", "operations"]);
    expect(response.operations_by_id.operation_contracts.interfaces.cli.placeholders).toEqual([]);
    expect(response.operations_by_id.operation_contracts.interfaces.cli.has_placeholders).toBe(false);
    expect(response.operations_by_id.operation_contracts.interfaces.cli.command_line).toBe("moryn contracts operations");
    expect(response.operations_by_id.project_init.interfaces.cli.argv).toEqual(["project", "init", "--path", "<path>"]);
    expect(response.operations_by_id.project_init.interfaces.cli.placeholders).toEqual(["path"]);
    expect(response.operations_by_id.project_init.interfaces.cli.has_placeholders).toBe(true);
    expect(response.operations_by_id.project_init.interfaces.cli.command_line).toBe("moryn project init --path '<path>'");
    expect(response.operations_by_id.write.interfaces.cli.argv).toEqual([
      "write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"
    ]);
    expect(response.operations_by_id.write.interfaces.cli.args).toEqual([
      "write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"
    ]);
    expect(response.operations_by_id.write.interfaces.cli.placeholders).toEqual(["kind", "type", "scope", "text"]);
    expect(response.operations_by_id.write.interfaces.cli.has_placeholders).toBe(true);
    expect(response.operations_by_id.write.interfaces.cli.command_line).toBe("moryn write --kind '<kind>' --type '<type>' --scope '<scope>' --text '<text>'");
    expect(response.operations_by_id.recall.execution).toEqual({
      ready_to_run: true,
      next_step: "run",
      blocked_by: [],
      missing_required_fields: [],
      required_inputs: [],
      required_inputs_by_field: {},
      required_inputs_by_argument_path: {},
      runbook: {
        next: "call_mcp",
        steps: [{
          step: "call_mcp",
          transport: "mcp",
          guard: "execution.ready_to_run",
          mcp: "interfaces.mcp",
          mcp_tool: "interfaces.mcp.tool",
          mcp_arguments: "interfaces.mcp.arguments",
          cli_exec_file: "interfaces.cli.exec_file",
          cli_command_line: "interfaces.cli.command_line",
          cli_placeholders: "interfaces.cli.placeholders"
        }]
      },
      requires_user_confirmation: false,
      reason: "Action is safe and all required fields are already filled."
    });
    for (const operation of ["agent_finish", "write", "promote", "project_init"] as const) {
      for (const input of response.operations_by_id[operation].execution.required_inputs) {
        expect(input.selection_sources).toEqual(operationRequiredInputSources);
        expect(response.operations_by_id[operation].execution.required_inputs_by_field[input.field]?.selection_sources).toEqual(
          operationRequiredInputSources
        );
      }
    }
    expect(response.operations_by_id.agent_finish.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: ["required_fields"],
      runbook: {
        next: "collect_required_inputs",
        steps: [
          expect.objectContaining({
            step: "collect_required_inputs",
            required_input_apply_to: "execution.required_inputs[].collect.apply_to",
            required_input_assignment_mode: "execution.required_inputs[].collect.apply_to.assignment_mode",
            required_input_expected_value: "execution.required_inputs[].collect.expected_value",
            required_input_choice_options: "execution.required_inputs[].collect.choice_options[]",
            required_input_preferred_choice: "execution.required_inputs[].collect.preferred_choice",
            required_input_choices: "execution.required_inputs[].collect.choices[]",
            required_input_choices_by_option: "execution.required_inputs[].collect.choices_by_option",
            required_input_choice_apply_to: "execution.required_inputs[].collect.choices[].apply_to",
            required_input_choice_expected_value: "execution.required_inputs[].collect.choices[].expected_value",
            required_input_choice_by_option_apply_to: "execution.required_inputs[].collect.choices_by_option.<option>.apply_to",
            required_input_choice_by_option_expected_value: "execution.required_inputs[].collect.choices_by_option.<option>.expected_value"
          }),
          expect.objectContaining({ step: "call_mcp" })
        ]
      },
      missing_required_fields: ["summary"],
      required_inputs: [{
        field: "summary",
        argument_path: "summary",
        argument_paths: ["summary"],
        collect: {
          source: "user",
          input_key: "summary",
          prompt: "Provide summary.",
          apply_to: {
            mcp_argument_paths: ["summary"],
            mcp_targets: [{
              argument: "summary",
              type: "string",
              required: true,
              preferred: true
            }],
            cli_targets: [{
              flag: "--summary",
              type: "string",
              required: true,
              preferred: true
            }]
          },
          value_path: "user_input.summary",
          placeholder: "<summary>"
        },
        argument_source: "user_input.summary",
        selection_sources: {
          required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
          required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>"
        },
        placeholder: "<summary>",
        value: "<summary>",
        mcp_targets: [{
          argument: "summary",
          type: "string",
          required: true,
          preferred: true
        }],
        cli_targets: [{
          flag: "--summary",
          type: "string",
          required: true,
          preferred: true
        }]
      }],
      required_inputs_by_field: {
        summary: {
          field: "summary",
          argument_path: "summary",
          argument_paths: ["summary"],
          collect: {
            source: "user",
            input_key: "summary",
            prompt: "Provide summary.",
            apply_to: {
              mcp_argument_paths: ["summary"],
              mcp_targets: [{
                argument: "summary",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--summary",
                type: "string",
                required: true,
                preferred: true
              }]
            },
            value_path: "user_input.summary",
            placeholder: "<summary>"
          },
          argument_source: "user_input.summary",
          selection_sources: {
            required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
            required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>"
          },
          placeholder: "<summary>",
          value: "<summary>",
          mcp_targets: [{
            argument: "summary",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{
            flag: "--summary",
            type: "string",
            required: true,
            preferred: true
          }]
        }
      },
      requires_user_confirmation: false
    });
    expect(response.operations_by_id.promote.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: ["required_fields"],
      missing_required_fields: ["record_id", "target_state"],
      required_inputs: [
        {
          field: "record_id",
          argument_path: "record_id",
          argument_paths: ["record_id"],
          collect: {
            source: "user",
            input_key: "record_id",
            prompt: "Provide record id.",
            apply_to: {
              mcp_argument_paths: ["record_id"],
              mcp_targets: [{
                argument: "record_id",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                positional: "record-id",
                type: "string",
                required: true,
                preferred: true
              }]
            },
            value_path: "user_input.record_id",
            placeholder: "<record_id>"
          },
          argument_source: "user_input.record_id",
          placeholder: "<record_id>",
          value: "<record_id>",
          mcp_targets: [{
            argument: "record_id",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{
            positional: "record-id",
            type: "string",
            required: true,
            preferred: true
          }]
        },
        {
          field: "target_state",
          argument_path: "target_state",
          argument_paths: ["target_state"],
          collect: {
            source: "user",
            input_key: "target_state",
            prompt: "Provide target state.",
            apply_to: {
              mcp_argument_paths: ["target_state"],
              mcp_targets: [{
                argument: "target_state",
                type: "string",
                required: true,
                preferred: true
              }],
              cli_targets: [{
                flag: "--state",
                type: "string",
                required: true,
                preferred: true
              }]
            },
            value_path: "user_input.target_state",
            placeholder: "<state>",
            allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"]
          },
          argument_source: "user_input.target_state",
          placeholder: "<state>",
          value: "<state>",
          allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"],
          mcp_targets: [{
            argument: "target_state",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{
            flag: "--state",
            type: "string",
            required: true,
            preferred: true
          }]
        }
      ],
      required_inputs_by_field: {
        record_id: {
          field: "record_id",
          argument_path: "record_id",
          argument_paths: ["record_id"],
          argument_source: "user_input.record_id",
          placeholder: "<record_id>",
          value: "<record_id>",
          mcp_targets: [{
            argument: "record_id",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{
            positional: "record-id",
            type: "string",
            required: true,
            preferred: true
          }]
        },
        target_state: {
          field: "target_state",
          argument_path: "target_state",
          argument_paths: ["target_state"],
          argument_source: "user_input.target_state",
          placeholder: "<state>",
          value: "<state>",
          allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"],
          mcp_targets: [{
            argument: "target_state",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{
            flag: "--state",
            type: "string",
            required: true,
            preferred: true
          }]
        }
      },
      requires_user_confirmation: false
    });
    expect(response.operations_by_id.project_init.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: ["required_fields", "user_confirmation"],
      missing_required_fields: ["path"],
      required_inputs: [{
        field: "path",
        argument_path: "path",
        argument_paths: ["path"],
        collect: {
          source: "user",
          input_key: "path",
          prompt: "Provide path.",
          apply_to: {
            mcp_argument_paths: ["path"],
            mcp_targets: [{
              argument: "path",
              type: "string",
              required: true,
              preferred: true
            }],
            cli_targets: [{
              flag: "--path",
              type: "string",
              required: true,
              default: ".",
              preferred: true
            }]
          },
          value_path: "user_input.path",
          placeholder: "<path>"
        },
        argument_source: "user_input.path",
        placeholder: "<path>",
        value: "<path>",
        mcp_targets: [{
          argument: "path",
          type: "string",
          required: true,
          preferred: true
        }],
        cli_targets: [{
          flag: "--path",
          type: "string",
          required: true,
          default: ".",
          preferred: true
        }]
      }],
      required_inputs_by_field: {
        path: {
          field: "path",
          argument_path: "path",
          argument_paths: ["path"],
          argument_source: "user_input.path",
          placeholder: "<path>",
          value: "<path>",
          mcp_targets: [{
            argument: "path",
            type: "string",
            required: true,
            preferred: true
          }],
          cli_targets: [{
            flag: "--path",
            type: "string",
            required: true,
            default: ".",
            preferred: true
          }]
        }
      },
      requires_user_confirmation: true
    });
    expect(response.operations_by_id.agent_enter.interfaces.cli.command).toBe("moryn agent enter");
    expect(response.operations_by_id.agent_enter.interfaces.mcp.tool).toBe("agent_enter");
    expect(response.operations_by_id.agent_enter.arguments_by_name.pull).toMatchObject({
      type: "boolean",
      required: false,
      default: true,
      cli: { negative_flag: "--no-pull" },
      mcp: { argument: "pull" }
    });
    expect(response.operations_by_id.agent_finish.required_fields).toEqual(["summary"]);
    expect(response.operations_by_id.agent_finish.required_fields_by_name.summary).toMatchObject({
      argument_path: "summary",
      placeholder: "<summary>"
    });
    expect(response.operations_by_id.agent_finish.argument_sources).toEqual({
      summary: "user_input.summary"
    });
    expect(response.operations_by_id.write.required_fields).toEqual(["kind", "type", "scope", "text_or_content"]);
    expect(response.operations_by_id.write.arguments_by_name.kind).toMatchObject({
      type: "string",
      required: true,
      cli: { flag: "--kind" },
      mcp: { argument: "kind" },
      allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
    });
    expect(response.operations_by_id.write.arguments_by_name.content).toMatchObject({
      type: "object",
      required: false,
      cli: { flag: "--content-json" },
      mcp: { argument: "content" },
      alternatives: ["text"]
    });
    expect(response.operations_by_id.write.arguments_by_name.derived_from).toMatchObject({
      type: "string[]",
      required: false,
      cli: { flag: "--derived-from", repeatable: true },
      mcp: { argument: "provenance", path: "provenance.derived_from" }
    });
    expect(response.operations_by_id.write.required_fields_by_name.kind.allowed_values).toEqual([
      "memory", "skill", "soul", "session_summary", "agent_note"
    ]);
    expect(response.operations_by_id.write.required_fields_by_name.scope.allowed_values).toEqual([
      "global", "project", "topic", "session", "artifact"
    ]);
    expect(response.operations_by_id.write.required_fields_by_name.text_or_content).toMatchObject({
      argument_path: "text|content",
      alternatives: ["text", "content"]
    });
    expect(response.operations_by_id.write.execution.required_inputs.find((input) => input.field === "text_or_content")).toMatchObject({
      argument_path: "text|content",
      argument_paths: ["text", "content"],
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
        },
        value_path: "user_input.text_or_content",
        input_mode: "choose_one",
        choices: [
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
              cli_assignments: [{
                flag: "--text",
                value_path: "user_input.text_or_content",
                argv_template: ["--text", "<user_input.text_or_content>"],
                value_encoding: "string",
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
              cli_assignments: [{
                flag: "--content-json",
                value_path: "user_input.text_or_content",
                argv_template: ["--content-json", "<json:user_input.text_or_content>"],
                value_encoding: "json",
                type: "object",
                required: false,
                preferred: false
              }]
            }
          }
        ],
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
    expect(response.operations_by_id.write.execution.required_inputs_by_field.text_or_content).toMatchObject({
      argument_path: "text|content",
      argument_paths: ["text", "content"],
      alternatives: ["text", "content"],
      collect: {
        input_mode: "choose_one",
        choice_options: ["text", "content"],
        preferred_choice: "text",
        choices: [
          {
            option: "text",
            argument_path: "text",
            value_path: "user_input.text_or_content",
            preferred: true,
            expected_value: {
              value_path: "user_input.text_or_content",
              kind: "string",
              value_encoding: "string"
            },
            apply_to: {
              mcp_argument_paths: ["text"],
              cli_assignments: [{
                flag: "--text",
                value_path: "user_input.text_or_content",
                argv_template: ["--text", "<user_input.text_or_content>"],
                value_encoding: "string",
                preferred: true
              }]
            }
          },
          {
            option: "content",
            argument_path: "content",
            value_path: "user_input.text_or_content",
            preferred: false,
            expected_value: {
              value_path: "user_input.text_or_content",
              kind: "json_object",
              value_encoding: "json"
            },
            apply_to: {
              mcp_argument_paths: ["content"],
              cli_assignments: [{
                flag: "--content-json",
                value_path: "user_input.text_or_content",
                argv_template: ["--content-json", "<json:user_input.text_or_content>"],
                value_encoding: "json",
                preferred: false
              }]
            }
          }
        ],
        choices_by_option: {
          text: {
            option: "text",
            argument_path: "text",
            value_path: "user_input.text_or_content",
            preferred: true,
            expected_value: {
              value_path: "user_input.text_or_content",
              kind: "string",
              value_encoding: "string"
            },
            apply_to: {
              mcp_argument_paths: ["text"],
              cli_assignments: [{
                flag: "--text",
                value_path: "user_input.text_or_content",
                argv_template: ["--text", "<user_input.text_or_content>"],
                value_encoding: "string",
                preferred: true
              }]
            }
          },
          content: {
            option: "content",
            argument_path: "content",
            value_path: "user_input.text_or_content",
            preferred: false,
            expected_value: {
              value_path: "user_input.text_or_content",
              kind: "json_object",
              value_encoding: "json"
            },
            apply_to: {
              mcp_argument_paths: ["content"],
              cli_assignments: [{
                flag: "--content-json",
                value_path: "user_input.text_or_content",
                argv_template: ["--content-json", "<json:user_input.text_or_content>"],
                value_encoding: "json",
                preferred: false
              }]
            }
          }
        },
        apply_to: {
          assignment_mode: "choose_one",
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
          ]
        }
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
    expect(response.operations_by_id.write.execution.required_inputs_by_argument_path.text).toMatchObject({
      field: "text_or_content",
      argument_path: "text|content",
      argument_paths: ["text", "content"]
    });
    expect(response.operations_by_id.write.execution.required_inputs_by_argument_path.content).toBe(
      response.operations_by_id.write.execution.required_inputs_by_argument_path.text
    );
    expect(response.operations_by_id.write.execution.required_inputs_by_argument_path.kind).toMatchObject({
      field: "kind",
      argument_path: "kind",
      argument_paths: ["kind"]
    });
    expect(response.operations_by_id.write.execution.required_inputs_by_field.kind.collect.apply_to.mcp_assignments).toEqual([{
      argument: "kind",
      value_path: "user_input.kind",
      preferred: true
    }]);
    expect(response.operations_by_id.write.execution.required_inputs_by_field.kind.collect.apply_to.cli_assignments).toEqual([{
      flag: "--kind",
      value_path: "user_input.kind",
      argv_template: ["--kind", "<user_input.kind>"],
      value_encoding: "string",
      type: "string",
      required: true,
      preferred: true
    }]);
    expect(response.operations_by_id.promote.required_fields_by_name.target_state.allowed_values).toEqual([
      "raw", "candidate", "canonical", "archived", "quarantined"
    ]);
    expect(response.operations_by_id.project_init.required_fields_by_name.sync_mode.allowed_values).toEqual([
      "manual", "session", "interval"
    ]);
    expect(response.operations_by_id.recall.arguments_by_name.kinds).toMatchObject({
      type: "string[]",
      required: false,
      cli: { flag: "--kind", repeatable: true },
      mcp: { argument: "kinds" },
      allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
    });
    expect(response.operations_by_id.recall.arguments_by_name.limit).toMatchObject({
      type: "number",
      required: false,
      default: 10,
      cli: { flag: "--limit", default: 10 },
      mcp: { argument: "limit" }
    });
    expect(response.operations_by_id.selection_source_contracts.interfaces.cli.command).toBe("moryn contracts selection-sources");
    expect(response.operations_by_id.operation_contracts.interfaces.mcp.tool).toBe("operation_contracts");
    expect(response.operations_by_category.lifecycle.agent_enter).toBe(response.operations_by_id.agent_enter);
  });
});
