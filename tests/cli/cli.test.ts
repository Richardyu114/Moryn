import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/store.js";

const exec = promisify(execFile);
const repoRoot = process.cwd();
const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs");
const cliPath = join(repoRoot, "src/cli.ts");
const LIST_PROJECTS_WHEN = "When the shared store has projects but this agent has no explicit project context.";
const FIX_PROJECT_CONFIG_WHEN = "Before starting lifecycle work when project context is invalid or missing.";
const INSPECT_SYNC_CONFLICT_WHEN = "Before retrying lifecycle writes or sync operations after a Git conflict.";
const NEXT_ACTION_SELECTION_SOURCES = {
  error_next_action: "error.next_action",
  warning_next_action: "warning.next_action",
  error_cli_executable: "error.next_action.interfaces.cli.executable",
  error_cli_argv: "error.next_action.interfaces.cli.argv[]",
  error_cli_args: "error.next_action.interfaces.cli.args[]",
  error_cli_exec_file: "error.next_action.interfaces.cli.exec_file",
  error_cli_placeholder: "error.next_action.interfaces.cli.placeholders[]",
  error_cli_command_line: "error.next_action.interfaces.cli.command_line",
  warning_cli_executable: "warning.next_action.interfaces.cli.executable",
  warning_cli_argv: "warning.next_action.interfaces.cli.argv[]",
  warning_cli_args: "warning.next_action.interfaces.cli.args[]",
  warning_cli_exec_file: "warning.next_action.interfaces.cli.exec_file",
  warning_cli_placeholder: "warning.next_action.interfaces.cli.placeholders[]",
  warning_cli_command_line: "warning.next_action.interfaces.cli.command_line",
  error_required_field: "error.next_action.required_fields_by_name.<field>",
  warning_required_field: "warning.next_action.required_fields_by_name.<field>",
  error_required_input: "error.next_action.execution.required_inputs_by_field.<field>",
  warning_required_input: "warning.next_action.execution.required_inputs_by_field.<field>",
  error_required_input_argument_path: "error.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  warning_required_input_argument_path: "warning.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  error_argument: "error.next_action.arguments_by_name.<argument>",
  warning_argument: "warning.next_action.arguments_by_name.<argument>",
  error_argument_source: "error.next_action.argument_sources.<field>",
  warning_argument_source: "warning.next_action.argument_sources.<field>",
  error_workflow_phase: "error.next_action.workflow.phases_by_name.<phase>",
  warning_workflow_phase: "warning.next_action.workflow.phases_by_name.<phase>"
};
const LIFECYCLE_ACTION_SELECTION_SOURCES = {
  action: "next.actions_by_id.<action>",
  action_id: "next.actions_by_id.<action>.action",
  ordered_action: "next.actions[]",
  cli_executable: "next.actions_by_id.<action>.interfaces.cli.executable",
  cli_argv: "next.actions_by_id.<action>.interfaces.cli.argv[]",
  cli_args: "next.actions_by_id.<action>.interfaces.cli.args[]",
  cli_exec_file: "next.actions_by_id.<action>.interfaces.cli.exec_file",
  cli_placeholder: "next.actions_by_id.<action>.interfaces.cli.placeholders[]",
  cli_command_line: "next.actions_by_id.<action>.interfaces.cli.command_line",
  ordered_cli_executable: "next.actions[].interfaces.cli.executable",
  ordered_cli_argv: "next.actions[].interfaces.cli.argv[]",
  ordered_cli_args: "next.actions[].interfaces.cli.args[]",
  ordered_cli_exec_file: "next.actions[].interfaces.cli.exec_file",
  ordered_cli_placeholder: "next.actions[].interfaces.cli.placeholders[]",
  ordered_cli_command_line: "next.actions[].interfaces.cli.command_line",
  argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
  ordered_argument: "next.actions[].arguments_by_name.<argument>",
  required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
  ordered_required_field: "next.actions[].required_fields_by_name.<field>",
  required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
  ordered_required_input: "next.actions[].execution.required_inputs_by_field.<field>",
  required_input_argument_path: "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path: "next.actions[].execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "next.actions_by_id.<action>.argument_sources.<field>",
  ordered_argument_source: "next.actions[].argument_sources.<field>"
};
const GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES = {
  lifecycle_action: "lifecycle_by_step.<step>",
  step: "lifecycle_by_step.<step>.step",
  ordered_lifecycle_action: "lifecycle[]",
  cli_executable: "lifecycle_by_step.<step>.interfaces.cli.executable",
  cli_argv: "lifecycle_by_step.<step>.interfaces.cli.argv[]",
  cli_args: "lifecycle_by_step.<step>.interfaces.cli.args[]",
  cli_exec_file: "lifecycle_by_step.<step>.interfaces.cli.exec_file",
  cli_placeholder: "lifecycle_by_step.<step>.interfaces.cli.placeholders[]",
  cli_command_line: "lifecycle_by_step.<step>.interfaces.cli.command_line",
  ordered_cli_executable: "lifecycle[].interfaces.cli.executable",
  ordered_cli_argv: "lifecycle[].interfaces.cli.argv[]",
  ordered_cli_args: "lifecycle[].interfaces.cli.args[]",
  ordered_cli_exec_file: "lifecycle[].interfaces.cli.exec_file",
  ordered_cli_placeholder: "lifecycle[].interfaces.cli.placeholders[]",
  ordered_cli_command_line: "lifecycle[].interfaces.cli.command_line",
  argument: "lifecycle_by_step.<step>.arguments_by_name.<argument>",
  ordered_argument: "lifecycle[].arguments_by_name.<argument>",
  required_field: "lifecycle_by_step.<step>.required_fields_by_name.<field>",
  ordered_required_field: "lifecycle[].required_fields_by_name.<field>",
  required_input: "lifecycle_by_step.<step>.execution.required_inputs_by_field.<field>",
  ordered_required_input: "lifecycle[].execution.required_inputs_by_field.<field>",
  required_input_argument_path: "lifecycle_by_step.<step>.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path: "lifecycle[].execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "lifecycle_by_step.<step>.argument_sources.<field>",
  ordered_argument_source: "lifecycle[].argument_sources.<field>"
};
const GUIDE_ENTRYPOINT_SELECTION_SOURCES = {
  startup_action: "startup",
  next_action: "next",
  startup_cli_executable: "startup.interfaces.cli.executable",
  startup_cli_argv: "startup.interfaces.cli.argv[]",
  startup_cli_args: "startup.interfaces.cli.args[]",
  startup_cli_exec_file: "startup.interfaces.cli.exec_file",
  startup_cli_placeholder: "startup.interfaces.cli.placeholders[]",
  startup_cli_command_line: "startup.interfaces.cli.command_line",
  next_cli_executable: "next.interfaces.cli.executable",
  next_cli_argv: "next.interfaces.cli.argv[]",
  next_cli_args: "next.interfaces.cli.args[]",
  next_cli_exec_file: "next.interfaces.cli.exec_file",
  next_cli_placeholder: "next.interfaces.cli.placeholders[]",
  next_cli_command_line: "next.interfaces.cli.command_line",
  startup_argument: "startup.arguments_by_name.<argument>",
  next_argument: "next.arguments_by_name.<argument>",
  startup_required_field: "startup.required_fields_by_name.<field>",
  next_required_field: "next.required_fields_by_name.<field>",
  startup_required_input: "startup.execution.required_inputs_by_field.<field>",
  next_required_input: "next.execution.required_inputs_by_field.<field>",
  startup_required_input_argument_path: "startup.execution.required_inputs_by_argument_path.<argument_path>",
  next_required_input_argument_path: "next.execution.required_inputs_by_argument_path.<argument_path>",
  startup_argument_source: "startup.argument_sources.<field>",
  next_argument_source: "next.argument_sources.<field>",
  workflow_phase: "workflow.phases_by_name.start_or_resume"
};
const WRITE_SELECTION_SOURCES = {
  record: "record",
  record_id: "record.id",
  warning_next_action: "warning.next_action"
};
const MUTATION_EVENT_SELECTION_SOURCES = {
  event: "event",
  event_id: "event.event_id",
  record_id: "event.record_id"
};
const LINK_EVENT_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  linked_record_id: "event.linked_record_id"
};
const REBUILD_SELECTION_SOURCES = {
  record_count: "records",
  project_ids: "projects",
  skill_count: "skills",
  artifacts: "artifacts",
  user_snapshot: "artifacts.snapshots.user",
  project_snapshots: "artifacts.snapshots.projects_by_id",
  skills_snapshot: "artifacts.snapshots.skills",
  recall_index: "artifacts.indexes.recall",
  sync_cursors_index: "artifacts.indexes.sync_cursors"
};
const SYNC_STATUS_SELECTION_SOURCES = {
  configured: "configured",
  branch: "branch",
  remote: "remote",
  dirty: "dirty",
  sync_state: "sync_state",
  conflict: "conflict",
  conflict_file: "conflict.files_by_path.<path>",
  conflict_file_path: "conflict.files_by_path.<path>.path",
  ordered_conflict_file: "conflict.files[]",
  ahead: "ahead",
  behind: "behind",
  last_sync: "last_sync",
  last_commit: "last_commit",
  error: "error"
};
const SYNC_RESULT_SELECTION_SOURCES = {
  ok: "ok",
  committed: "committed",
  pushed: "pushed",
  pulled: "pulled",
  message: "message"
};
const STORE_INIT_SELECTION_SOURCES = {
  store: "store",
  config: "config",
  config_file: "artifacts.config",
  store_version: "config.store_version",
  device_id: "config.device_id"
};
const PROJECT_INIT_SELECTION_SOURCES = {
  path: "path",
  config: "config",
  config_file: "artifacts.config",
  project_id: "config.project_id",
  tags: "config.tags",
  default_skills: "config.default_skills",
  sync_mode: "config.sync.mode"
};
const SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES = {
  contracts: "contracts",
  group: "contracts.<group>",
  contract: "contracts.<group>.<contract>",
  field: "contracts.<group>.<contract>.<field>"
};
const OPERATION_CONTRACTS_SELECTION_SOURCES = {
  operation: "operations_by_id.<operation>",
  operation_id: "operations_by_id.<operation>.operation",
  category: "operations_by_category.<category>",
  category_operation: "operations_by_category.<category>.<operation>",
  mcp_tool_operation: "operations_by_mcp_tool.<tool>",
  cli_command_operation: "operations_by_cli_command.<command>",
  required_field: "operations_by_id.<operation>.required_fields_by_name.<field>",
  allowed_value: "operations_by_id.<operation>.required_fields_by_name.<field>.allowed_values[]",
  required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
  required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>",
  required_input_path_by_value_path: "operations_by_id.<operation>.execution.required_input_paths_by_value_path.<value_path>",
  argument: "operations_by_id.<operation>.arguments_by_name.<argument>",
  argument_allowed_value: "operations_by_id.<operation>.arguments_by_name.<argument>.allowed_values[]",
  argument_source: "operations_by_id.<operation>.argument_sources.<field>",
  cli_command: "operations_by_id.<operation>.interfaces.cli.command",
  cli_argv: "operations_by_id.<operation>.interfaces.cli.argv[]",
  cli_executable: "operations_by_id.<operation>.interfaces.cli.executable",
  cli_args: "operations_by_id.<operation>.interfaces.cli.args[]",
  cli_exec_file: "operations_by_id.<operation>.interfaces.cli.exec_file",
  cli_placeholder: "operations_by_id.<operation>.interfaces.cli.placeholders[]",
  cli_command_line: "operations_by_id.<operation>.interfaces.cli.command_line",
  mcp_tool: "operations_by_id.<operation>.interfaces.mcp.tool",
  ordered_operation: "operations[]"
};

function withPhasesByName<TWorkflow extends { phases: Array<{ phase: string }> }>(workflow: TWorkflow) {
  return {
    ...workflow,
    phases_by_name: Object.fromEntries(workflow.phases.map((phase) => [phase.phase, phase]))
  };
}

function singleNextWorkflow(input: {
  recommendedAction: string;
  tool: string;
  requiredWhen: string;
  requiredFields?: string[];
}) {
  return {
    version: 1,
    start: "next",
    continue_from: ["next"],
    phases: [
      {
        phase: input.recommendedAction,
        order: 1,
        action_source: "next",
        tool: input.tool,
        required_when: input.requiredWhen,
        required_fields: input.requiredFields ?? []
      }
    ]
  };
}

function expectActionInterfaces(action: {
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  interfaces?: {
    cli?: { command?: string; command_line?: string; argv?: string[]; executable?: string; args?: string[]; exec_file?: { executable?: string; args?: string[] } };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
}) {
  expect(action.interfaces?.cli).toEqual({
    command: action.command,
    command_line: expect.any(String),
    argv: expect.any(Array),
    executable: expect.any(String),
    args: expect.any(Array),
    exec_file: {
      executable: expect.any(String),
      args: expect.any(Array)
    },
    placeholders: expect.any(Array),
    has_placeholders: expect.any(Boolean)
  });
  expect(action.interfaces?.mcp).toEqual({
    tool: action.tool,
    arguments: action.arguments
  });
}

function expectNextActionSelectionSources(action: {
  action_source?: string;
  selection_sources?: Record<string, string>;
}) {
  expect(action.action_source).toBe("next_action");
  expect(action.selection_sources).toEqual(NEXT_ACTION_SELECTION_SOURCES);
}

function expectLifecycleActionSelectionSources(action: {
  action?: string;
  action_source?: string;
  selection_sources?: Record<string, string>;
  safe_to_run?: boolean;
  required_fields?: string[];
  required_fields_by_name?: Record<string, { argument_path?: string }>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    blocked_by?: string[];
    missing_required_fields?: string[];
    required_inputs?: Array<{ field?: string; argument_path?: string; argument_paths?: string[]; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    required_inputs_by_field?: Record<string, { field?: string; argument_path?: string; argument_paths?: string[]; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  if (typeof action.action === "string") {
    expect(action.action_source).toBe(`next.actions_by_id.${action.action}`);
  }
  expect(action.selection_sources).toEqual(LIFECYCLE_ACTION_SELECTION_SOURCES);
  if (typeof action.safe_to_run === "boolean" && Array.isArray(action.required_fields)) {
    expectActionExecution({
      safe_to_run: action.safe_to_run,
      required_fields: action.required_fields,
      required_fields_by_name: action.required_fields_by_name ?? {},
      execution: action.execution,
      safety: action.safety
    });
  }
}

function expectGuideLifecycleStepSelectionSources(action: {
  step?: string;
  action_source?: string;
  selection_sources?: Record<string, string>;
  safe_to_run?: boolean;
  required_fields?: string[];
  required_fields_by_name?: Record<string, { argument_path?: string }>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    blocked_by?: string[];
    missing_required_fields?: string[];
    required_inputs?: Array<{ field?: string; argument_path?: string; argument_paths?: string[]; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    required_inputs_by_field?: Record<string, { field?: string; argument_path?: string; argument_paths?: string[]; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  if (typeof action.step === "string") {
    expect(action.action_source).toBe(`lifecycle_by_step.${action.step}`);
  }
  expect(action.selection_sources).toEqual(GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES);
  if (typeof action.safe_to_run === "boolean" && Array.isArray(action.required_fields)) {
    expectActionExecution({
      safe_to_run: action.safe_to_run,
      required_fields: action.required_fields,
      required_fields_by_name: action.required_fields_by_name ?? {},
      execution: action.execution,
      safety: action.safety
    });
  }
}

function expectGuideEntrypointSelectionSources(action: {
  action_source?: string;
  selection_sources?: Record<string, string>;
  safe_to_run?: boolean;
  required_fields?: string[];
  required_fields_by_name?: Record<string, { argument_path?: string }>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    blocked_by?: string[];
    missing_required_fields?: string[];
    required_inputs?: Array<{ field?: string; argument_path?: string; argument_paths?: string[]; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    required_inputs_by_field?: Record<string, { field?: string; argument_path?: string; argument_paths?: string[]; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}, expectedActionSource: "startup" | "next") {
  expect(action.action_source).toBe(expectedActionSource);
  expect(action.selection_sources).toEqual(GUIDE_ENTRYPOINT_SELECTION_SOURCES);
  if (typeof action.safe_to_run === "boolean" && Array.isArray(action.required_fields)) {
    expectActionExecution({
      safe_to_run: action.safe_to_run,
      required_fields: action.required_fields,
      required_fields_by_name: action.required_fields_by_name ?? {},
      execution: action.execution,
      safety: action.safety
    });
  }
}

function expectRecoveryWorkflow(action: {
  recommended_action: string;
  tool: string;
  required_when?: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}) {
  expect(action.required_when).toEqual(expect.any(String));
  expect(action.required_when).not.toHaveLength(0);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["error.next_action", "warning.next_action"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "next_action",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectCandidatePromoteWorkflow(action: {
  required_when?: string;
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
      replace_arguments?: Record<string, string>;
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["error.next_action", "warning.next_action", "write.record.id"],
    phases: [
      {
        phase: "ask_user_then_promote_candidate",
        order: 1,
        action_source: "write.record.id",
        tool: "promote",
        required_when: action.required_when,
        required_fields: ["record_id"],
        replace_arguments: { record_id: "write.record.id" }
      }
    ]
  }));
}

function expectLifecycleWorkflow(action: {
  step: string;
  tool: string;
  required_when: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "lifecycle_by_step",
    continue_from: ["lifecycle_by_step", "lifecycle"],
    phases: [
      {
        phase: action.step,
        order: 1,
        action_source: `lifecycle_by_step.${action.step}`,
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectGuideEntrypointWorkflow(action: {
  tool: string;
  required_when: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "startup",
    continue_from: ["startup"],
    phases: [
      {
        phase: "call_agent_enter",
        order: 1,
        action_source: "startup",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectGuideNextWorkflow(action: {
  tool: string;
  required_when: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next",
    continue_from: ["next"],
    phases: [
      {
        phase: "call_agent_enter",
        order: 1,
        action_source: "next",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectProjectListNextWorkflow(action: {
  recommended_action: string;
  tool: string;
  required_when: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}) {
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next",
    continue_from: ["project_list.projects_by_id.<project_id>.next", "project_list.projects[].next"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "project_list.projects_by_id.<project_id>.next",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectActionSafety(action: {
  safe_to_run: boolean;
  required_fields: string[];
  safety?: {
    safe_to_auto_run?: boolean;
    requires_user_confirmation?: boolean;
    requires_authored_input?: boolean;
    writes_local_config?: boolean;
    reasons?: string[];
  };
}) {
  expect(action.safety).toMatchObject({
    safe_to_auto_run: action.safe_to_run,
    requires_authored_input: action.required_fields.length > 0
  });
  expect(action.safety?.reasons).toEqual(expect.any(Array));
  expect(action.safety?.reasons?.length).toBeGreaterThan(0);
}

function expectActionExecution(action: {
  safe_to_run: boolean;
  required_fields: string[];
  required_fields_by_name: Record<string, { argument_path?: string }>;
  selection_sources?: Record<string, string>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    blocked_by?: string[];
    missing_required_fields?: string[];
    required_inputs?: Array<{ field?: string; argument_path?: string; argument_paths?: string[]; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    required_inputs_by_field?: Record<string, { field?: string; argument_path?: string; argument_paths?: string[]; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  const expectedArgumentPaths = action.required_fields.map((field) => action.required_fields_by_name[field]?.argument_path ?? field);
  const expectedSplitArgumentPaths = expectedArgumentPaths.map((argumentPath) =>
    argumentPath.split("|").map((path) => path.trim()).filter(Boolean)
  );
  expect(action.execution?.missing_required_fields).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.field)).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.execution?.required_inputs?.map((input) => input.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(Object.keys(action.execution?.required_inputs_by_field ?? {})).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.field)).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.mcp_targets)).toEqual(
    action.execution?.required_inputs?.map((input) => input.mcp_targets)
  );
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.cli_targets)).toEqual(
    action.execution?.required_inputs?.map((input) => input.cli_targets)
  );
  const expectedRequiredInputSelectionSources = Object.fromEntries(
    Object.entries(action.selection_sources ?? {}).filter(([key]) => key.includes("required_input"))
  );
  if (action.required_fields.length > 0 && Object.keys(expectedRequiredInputSelectionSources).length > 0) {
    expect(action.execution?.required_inputs?.map((input) => input.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
    expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
  }
  expect(action.execution?.requires_user_confirmation).toBe(Boolean(action.safety?.requires_user_confirmation));
  if (action.required_fields.length > 0) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: [
        "required_fields",
        ...(action.safety?.requires_user_confirmation ? ["user_confirmation"] : [])
      ]
    });
  } else if (action.safety?.requires_user_confirmation) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "confirm_with_user",
      blocked_by: ["user_confirmation"]
    });
  } else {
    expect(action.execution).toMatchObject({
      ready_to_run: action.safe_to_run,
      next_step: action.safe_to_run ? "run" : "do_not_auto_run",
      blocked_by: action.safe_to_run ? [] : ["unsafe_action"]
    });
  }
  expect(action.execution?.reason).toEqual(expect.any(String));
}

function expectRefreshChangeNextAction(action: {
  action_source?: string;
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  argument_sources?: Record<string, string>;
  selection_sources?: Record<string, string>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  interfaces?: {
    cli?: { command?: string };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
  safety?: {
    safe_to_auto_run?: boolean;
    requires_user_confirmation?: boolean;
    requires_authored_input?: boolean;
    writes_local_config?: boolean;
    reasons?: string[];
  };
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}, recordId: string, projectId?: string) {
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
    action_source: `refresh.changes_by_record_id.${recordId}.next_action`,
    tool: "recall",
    safe_to_run: true,
    required_when: "After refresh reports this change and the agent needs the full record content.",
    required_fields: [],
    command: projectId
      ? `moryn recall --record-id ${recordId} --project-id ${projectId}`
      : `moryn recall --record-id ${recordId}`,
    arguments: {
      record_ids: [recordId],
      ...(projectId ? { project_id: projectId } : {})
    },
    argument_sources: {
      record_ids: "refresh.changes_by_record_id.<record_id>.record_id"
    },
    selection_sources: {
      change: "refresh.changes_by_record_id.<record_id>",
      record_id: "refresh.changes_by_record_id.<record_id>.record_id",
      next_action: "refresh.changes_by_record_id.<record_id>.next_action",
      ordered_next_action: "refresh.changes[].next_action",
      cli_executable: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.executable",
      cli_argv: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
      cli_args: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
      cli_exec_file: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
      cli_placeholder: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
      cli_command_line: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
      ordered_cli_executable: "refresh.changes[].next_action.interfaces.cli.executable",
      ordered_cli_argv: "refresh.changes[].next_action.interfaces.cli.argv[]",
      ordered_cli_args: "refresh.changes[].next_action.interfaces.cli.args[]",
      ordered_cli_exec_file: "refresh.changes[].next_action.interfaces.cli.exec_file",
      ordered_cli_placeholder: "refresh.changes[].next_action.interfaces.cli.placeholders[]",
      ordered_cli_command_line: "refresh.changes[].next_action.interfaces.cli.command_line",
      argument: "refresh.changes_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
      ordered_argument: "refresh.changes[].next_action.arguments_by_name.<argument>",
      required_field: "refresh.changes_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
      ordered_required_field: "refresh.changes[].next_action.required_fields_by_name.<field>",
      required_input: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
      ordered_required_input: "refresh.changes[].next_action.execution.required_inputs_by_field.<field>",
      required_input_argument_path: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
      ordered_required_input_argument_path: "refresh.changes[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
      argument_source: "refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>",
      ordered_argument_source: "refresh.changes[].next_action.argument_sources.<field>"
    }
  });
  expectActionInterfaces(action);
  expectActionSafety(action);
  expectActionExecution(action);
  expect(action.safety?.reasons).toEqual(["safe_read_or_status_check"]);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["refresh.changes_by_record_id.<record_id>.next_action", "refresh.changes[].next_action"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "refresh.changes_by_record_id.<record_id>.next_action",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectHandoffEntryNextAction(action: {
  action_source?: string;
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  argument_sources?: Record<string, string>;
  selection_sources?: Record<string, string>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  interfaces?: {
    cli?: { command?: string };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
  safety?: {
    safe_to_auto_run?: boolean;
    requires_user_confirmation?: boolean;
    requires_authored_input?: boolean;
    writes_local_config?: boolean;
    reasons?: string[];
  };
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}, recordId: string, projectId: string, source: "inbox" | "active_sessions" = "inbox") {
  const actionSource = source === "inbox"
    ? "handoff.inbox_by_record_id.<record_id>.next_action"
    : "handoff.active_sessions_by_record_id.<record_id>.next_action";
  const resolvedActionSource = source === "inbox"
    ? `handoff.inbox_by_record_id.${recordId}.next_action`
    : `handoff.active_sessions_by_record_id.${recordId}.next_action`;
  const recordIdSource = source === "inbox"
    ? "handoff.inbox_by_record_id.<record_id>.record_id"
    : "handoff.active_sessions_by_record_id.<record_id>.record_id";
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
    action_source: resolvedActionSource,
    tool: "recall",
    safe_to_run: true,
    required_when: "After reading this handoff entry and needing the full session record.",
    required_fields: [],
    command: `moryn recall --record-id ${recordId} --project-id ${projectId}`,
    arguments: {
      record_ids: [recordId],
      project_id: projectId
    },
    argument_sources: {
      record_ids: recordIdSource
    },
    selection_sources: {
      entry: source === "inbox"
        ? "handoff.inbox_by_record_id.<record_id>"
        : "handoff.active_sessions_by_record_id.<record_id>",
      record_id: recordIdSource,
      next_action: actionSource,
      ordered_next_action: source === "inbox"
        ? "handoff.inbox[].next_action"
        : "handoff.active_sessions[].next_action",
      argument: `${actionSource}.arguments_by_name.<argument>`,
      ordered_argument: source === "inbox"
        ? "handoff.inbox[].next_action.arguments_by_name.<argument>"
        : "handoff.active_sessions[].next_action.arguments_by_name.<argument>",
      required_field: `${actionSource}.required_fields_by_name.<field>`,
      ordered_required_field: source === "inbox"
        ? "handoff.inbox[].next_action.required_fields_by_name.<field>"
        : "handoff.active_sessions[].next_action.required_fields_by_name.<field>",
      required_input: `${actionSource}.execution.required_inputs_by_field.<field>`,
      ordered_required_input: source === "inbox"
        ? "handoff.inbox[].next_action.execution.required_inputs_by_field.<field>"
        : "handoff.active_sessions[].next_action.execution.required_inputs_by_field.<field>",
      required_input_argument_path: `${actionSource}.execution.required_inputs_by_argument_path.<argument_path>`,
      ordered_required_input_argument_path: source === "inbox"
        ? "handoff.inbox[].next_action.execution.required_inputs_by_argument_path.<argument_path>"
        : "handoff.active_sessions[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
      argument_source: `${actionSource}.argument_sources.<field>`,
      ordered_argument_source: source === "inbox"
        ? "handoff.inbox[].next_action.argument_sources.<field>"
        : "handoff.active_sessions[].next_action.argument_sources.<field>"
    }
  });
  expectActionInterfaces(action);
  expectActionSafety(action);
  expectActionExecution(action);
  expect(action.safety?.reasons).toEqual(["safe_read_or_status_check"]);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: [
      "handoff.inbox_by_record_id.<record_id>.next_action",
      "handoff.active_sessions_by_record_id.<record_id>.next_action",
      "handoff.inbox[].next_action",
      "handoff.active_sessions[].next_action"
    ],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: actionSource,
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "moryn-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createCliSyncConflict(input: {
  remote: string;
  storeA: string;
  storeB: string;
  conflictFile: string;
}): Promise<void> {
  await exec("node", ["--import", tsxLoader, cliPath, "--store", input.storeA, "init"]);
  await exec("node", ["--import", tsxLoader, cliPath, "--store", input.storeB, "init"]);
  await exec("node", ["--import", tsxLoader, cliPath, "--store", input.storeA, "sync", "init", input.remote]);
  await exec("node", ["--import", tsxLoader, cliPath, "--store", input.storeB, "sync", "init", input.remote]);
  await mkdir(join(input.storeA, "events", "shared-device", "2026-05"), { recursive: true });
  await mkdir(join(input.storeB, "events", "shared-device", "2026-05"), { recursive: true });
  await writeFile(join(input.storeA, input.conflictFile), "{\"from\":\"a\"}\n", "utf8");
  await writeFile(join(input.storeB, input.conflictFile), "{\"from\":\"b\"}\n", "utf8");
  await exec("git", ["add", input.conflictFile], { cwd: input.storeA });
  await exec("git", ["commit", "-m", "device a conflicting event"], { cwd: input.storeA });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: input.storeA });
  await exec("git", ["add", input.conflictFile], { cwd: input.storeB });
  await exec("git", ["commit", "-m", "device b conflicting event"], { cwd: input.storeB });
  try {
    await exec("node", ["--import", tsxLoader, cliPath, "--store", input.storeB, "sync", "--pull"]);
    throw new Error("Expected CLI sync pull to fail with a conflict");
  } catch (error) {
    const stderr = (error as { stderr: string }).stderr;
    expect(JSON.parse(stderr).error.code).toBe("SYNC_CONFLICT");
  }
}

describe("moryn CLI", () => {
  it("returns selection source contracts from the CLI", async () => {
    const result = await exec("node", [
      "--import", tsxLoader, cliPath,
      "contracts", "selection-sources"
    ]);
    const parsed = JSON.parse(result.stdout) as {
      contracts: {
        setup: { store_init: { config_file: string } };
        core: { boot: { skill: string } };
        sync: { result: { pushed: string } };
        lifecycle: { guide: { guardrail: string } };
        recovery: { next_action: { error_next_action: string } };
      };
      selection_sources: Record<string, string>;
    };

    expect(parsed.selection_sources).toEqual(SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES);
    expect(parsed.contracts.setup.store_init.config_file).toBe("artifacts.config");
    expect(parsed.contracts.core.boot.skill).toBe("skills_by_id.<record_id>");
    expect(parsed.contracts.sync.result.pushed).toBe("pushed");
    expect(parsed.contracts.lifecycle.guide.guardrail).toBe("guardrails_by_id.<guardrail_id>");
    expect(parsed.contracts.recovery.next_action.error_next_action).toBe("error.next_action");
  });

  it("returns operation contracts from the CLI", async () => {
    const result = await exec("node", [
      "--import", tsxLoader, cliPath,
      "contracts", "operations"
    ]);
    const parsed = JSON.parse(result.stdout) as {
      recommended_entrypoint: string;
      operations: Array<{ operation: string }>;
      operations_by_id: Record<string, {
        operation: string;
        category: string;
        safe_to_run: boolean;
        required_fields: string[];
        selection_sources?: Record<string, string>;
        execution: {
          ready_to_run: boolean;
          next_step: string;
          blocked_by: string[];
          missing_required_fields: string[];
          requires_user_confirmation: boolean;
          reason: string;
        };
        required_fields_by_name: Record<string, { name: string; argument_path: string; placeholder?: string; value?: unknown; alternatives?: string[]; allowed_values?: string[] }>;
        arguments_by_name: Record<string, {
          name: string;
          type: string;
          required: boolean;
          cli?: { flag?: string; flags?: string[]; positional?: string; repeatable?: boolean; default?: unknown; negative_flag?: string };
          mcp?: { argument: string };
          default?: unknown;
          allowed_values?: string[];
          alternatives?: string[];
        }>;
        argument_sources?: Record<string, string>;
        interfaces: {
          cli: { command: string; argv: string[]; executable: string; args: string[]; exec_file: { executable: string; args: string[] }; command_line: string };
          mcp: { tool: string; arguments: Record<string, unknown> };
        };
      }>;
      operations_by_category: Record<string, Record<string, { operation: string }>>;
      operations_by_mcp_tool: Record<string, { operation: string; selection_sources?: Record<string, string> }>;
      operations_by_cli_command: Record<string, { operation: string; selection_sources?: Record<string, string> }>;
      selection_sources: Record<string, string>;
    };

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(1024 * 1024);
    expect(parsed.recommended_entrypoint).toBe("agent_enter");
    expect(parsed.selection_sources).toEqual(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(parsed.operations_by_id.agent_enter).toMatchObject({
      operation: "agent_enter",
      category: "lifecycle",
      safe_to_run: true,
      required_fields: [],
      execution: {
        ready_to_run: true,
        next_step: "run",
        blocked_by: [],
        missing_required_fields: [],
        runbook: {
          next: "call_mcp",
          current_step: {
            step: "call_mcp",
            step_path: "execution.runbook.steps[0]"
          },
          step_paths_by_step: {
            call_mcp: "execution.runbook.steps[0]"
          },
          steps: [expect.objectContaining({ step: "call_mcp" })]
        },
        requires_user_confirmation: false,
        reason: "Action is safe and all required fields are already filled."
      },
      interfaces: {
        cli: {
          command: "moryn agent enter",
          argv: ["agent", "enter"],
          placeholders: [],
          has_placeholders: false,
          command_line: "moryn agent enter"
        },
        mcp: { tool: "agent_enter", arguments: {} }
      }
    });
    expect(parsed.operations_by_id.agent_enter.arguments_by_name.pull).toMatchObject({
      name: "pull",
      type: "boolean",
      required: false,
      default: true,
      cli: { negative_flag: "--no-pull" },
      mcp: { argument: "pull" }
    });
    expect(parsed.operations_by_id.agent_finish).toMatchObject({
      safe_to_run: false,
      required_fields: ["summary"],
      execution: {
        ready_to_run: false,
        next_step: "collect_required_fields",
        blocked_by: ["required_fields"],
        missing_required_fields: ["summary"],
        runbook: {
          next: "collect_required_inputs",
          current_step: {
            step: "collect_required_inputs",
            step_path: "execution.runbook.steps[0]"
          },
          step_paths_by_step: {
            collect_required_inputs: "execution.runbook.steps[0]",
            call_mcp: "execution.runbook.steps[1]"
          },
          steps: [
            expect.objectContaining({
              step: "collect_required_inputs",
              required_input_collect: "execution.required_inputs[].collect",
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
        required_inputs_by_field: {
          summary: {
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
            }
          }
        },
        required_input_paths_by_value_path: {
          "user_input.summary": "execution.required_inputs_by_field.summary"
        },
        requires_user_confirmation: false,
        reason: "Action requires authored input before it can run."
      },
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
      interfaces: {
        cli: {
          command: "moryn agent finish --summary <summary>",
          argv: ["agent", "finish", "--summary", "<summary>"],
          placeholders: ["summary"],
          has_placeholders: true,
          command_line: "moryn agent finish --summary '<summary>'"
        },
        mcp: { tool: "agent_finish", arguments: { summary: "<summary>" } }
      }
    });
    expect(parsed.operations_by_id.write).toMatchObject({
      safe_to_run: false,
      required_fields: ["kind", "type", "scope", "text_or_content"],
      arguments_by_name: {
        kind: {
          name: "kind",
          type: "string",
          required: true,
          cli: { flag: "--kind" },
          mcp: { argument: "kind" },
          allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
        },
        content: {
          name: "content",
          type: "object",
          required: false,
          cli: { flag: "--content-json" },
          mcp: { argument: "content" },
          alternatives: ["text"]
        }
      },
      required_fields_by_name: {
        kind: {
          allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
        },
        scope: {
          allowed_values: ["global", "project", "topic", "session", "artifact"]
        },
        text_or_content: {
          name: "text_or_content",
          argument_path: "text|content",
          placeholder: "<text_or_content>",
          alternatives: ["text", "content"]
        }
      },
      argument_sources: {
        kind: "user_input.kind",
        type: "user_input.type",
        scope: "user_input.scope",
        text_or_content: "user_input.text_or_content"
      },
      interfaces: {
        cli: {
          command: "moryn write --kind <kind> --type <type> --scope <scope> --text <text>",
          argv: ["write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"],
          placeholders: ["kind", "type", "scope", "text"],
          has_placeholders: true,
          command_line: "moryn write --kind '<kind>' --type '<type>' --scope '<scope>' --text '<text>'"
        }
      }
    });
    expect(parsed.operations_by_id.write.execution.required_inputs_by_field.text_or_content.collect).toMatchObject({
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
      placeholder: "<text_or_content>",
      alternatives: ["text", "content"]
    });
    expect(parsed.operations_by_id.write.execution.required_input_paths_by_value_path).toMatchObject({
      "user_input.kind": "execution.required_inputs_by_field.kind",
      "user_input.type": "execution.required_inputs_by_field.type",
      "user_input.scope": "execution.required_inputs_by_field.scope",
      "user_input.text_or_content": "execution.required_inputs_by_field.text_or_content"
    });
    expect(parsed.operations_by_id.promote).toMatchObject({
      execution: {
        ready_to_run: false,
        next_step: "collect_required_fields",
        blocked_by: ["required_fields"],
        missing_required_fields: ["record_id", "target_state"],
        required_inputs_by_field: {
          target_state: {
            collect: {
              source: "user",
              input_key: "target_state",
              prompt: "Provide target state.",
              allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"]
            }
          }
        },
        requires_user_confirmation: false
      },
      required_fields_by_name: {
        target_state: {
          allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"]
        }
      }
    });
    expect(parsed.operations_by_id.project_init).toMatchObject({
      execution: {
        ready_to_run: false,
        next_step: "collect_required_fields",
        blocked_by: ["required_fields", "user_confirmation"],
        missing_required_fields: ["path"],
        requires_user_confirmation: true
      },
      required_fields_by_name: {
        path: {
          name: "path",
          argument_path: "path",
          placeholder: "<path>",
          value: "<path>"
        },
        sync_mode: {
          allowed_values: ["manual", "session", "interval"]
        }
      },
      argument_sources: {
        path: "user_input.path"
      },
      interfaces: {
        cli: {
          command: "moryn project init --path <path>",
          argv: ["project", "init", "--path", "<path>"],
          placeholders: ["path"],
          has_placeholders: true,
          command_line: "moryn project init --path '<path>'"
        }
      }
    });
    expect(parsed.operations_by_id.recall.arguments_by_name).toMatchObject({
      kinds: {
        name: "kinds",
        type: "string[]",
        required: false,
        cli: { flag: "--kind", repeatable: true },
        mcp: { argument: "kinds" },
        allowed_values: ["memory", "skill", "soul", "session_summary", "agent_note"]
      },
      limit: {
        name: "limit",
        type: "number",
        required: false,
        default: 10,
        cli: { flag: "--limit", default: 10 },
        mcp: { argument: "limit" }
      }
    });
    expect(parsed.operations_by_id.selection_source_contracts.interfaces.cli.command).toBe("moryn contracts selection-sources");
    expect(parsed.operations_by_id.selection_source_contracts.interfaces.cli.argv).toEqual(["contracts", "selection-sources"]);
    expect(parsed.operations_by_id.selection_source_contracts.interfaces.cli.command_line).toBe("moryn contracts selection-sources");
    expect(parsed.operations_by_id.operation_contracts.interfaces.cli.argv).toEqual(["contracts", "operations"]);
    expect(parsed.operations_by_id.operation_contracts.interfaces.cli.placeholders).toEqual([]);
    expect(parsed.operations_by_id.operation_contracts.interfaces.cli.has_placeholders).toBe(false);
    expect(parsed.operations_by_id.operation_contracts.interfaces.cli.command_line).toBe("moryn contracts operations");
    expect(parsed.operations_by_id.operation_contracts.interfaces.mcp.tool).toBe("operation_contracts");
    expect(parsed.operations_by_id.operation_contracts.arguments_by_name).toMatchObject({
      index: {
        name: "index",
        type: "boolean",
        required: false,
        cli: { flag: "--index" },
        mcp: { argument: "index" }
      },
      operation: {
        name: "operation",
        type: "string",
        required: false,
        cli: { flag: "--operation" },
        mcp: { argument: "operation" }
      },
      mcp_tool: {
        name: "mcp_tool",
        type: "string",
        required: false,
        cli: { flag: "--mcp-tool" },
        mcp: { argument: "mcp_tool" }
      },
      cli_command: {
        name: "cli_command",
        type: "string",
        required: false,
        cli: { flag: "--cli-command" },
        mcp: { argument: "cli_command" }
      }
    });
    expect(parsed.operations_by_id.operation_contracts.interfaces.mcp.arguments).toEqual({
      index: true,
      operation: "<operation>",
      mcp_tool: "<tool>",
      cli_command: "<command>"
    });
    expect(parsed.operations_by_category.lifecycle.agent_enter).toEqual(parsed.operations_by_id.agent_enter);
    expect(parsed.operations_by_mcp_tool.agent_enter).toEqual(parsed.operations_by_id.agent_enter);
    expect(parsed.operations_by_mcp_tool.operation_contracts).toEqual(parsed.operations_by_id.operation_contracts);
    expect(parsed.operations_by_cli_command["moryn agent enter"]).toEqual(parsed.operations_by_id.agent_enter);
    expect(parsed.operations_by_cli_command["moryn contracts operations"]).toEqual(parsed.operations_by_id.operation_contracts);
    expect(parsed.operations_by_id.agent_enter.selection_sources.required_input_path_by_value_path).toBeUndefined();
    expect(parsed.operations_by_id.agent_enter.selection_sources.category).toBeUndefined();
    expect(parsed.operations_by_id.agent_enter.selection_sources.category_operation).toBeUndefined();
    expect(parsed.operations_by_id.agent_enter.selection_sources.mcp_tool_operation).toBeUndefined();
    expect(parsed.operations_by_id.agent_enter.selection_sources.cli_command_operation).toBeUndefined();
    expect(parsed.operations_by_id.agent_enter.selection_sources.ordered_operation).toBeUndefined();
    expect(parsed.operations_by_id.write.selection_sources.required_input_path_by_value_path).toBeUndefined();
    expect(parsed.operations_by_mcp_tool.agent_enter.selection_sources.required_input_path_by_value_path).toBeUndefined();
    expect(parsed.operations_by_cli_command["moryn agent enter"].selection_sources.required_input_path_by_value_path).toBeUndefined();
    expect(parsed.operations.map((operation) => operation.operation)).toContain("operation_contracts");
  });

  it("returns a compact operation contract index from the CLI", async () => {
    const result = await exec("node", [
      "--import", tsxLoader, cliPath,
      "contracts", "operations",
      "--index"
    ]);
    const parsed = JSON.parse(result.stdout) as {
      recommended_entrypoint: string;
      index_use: string;
      next_lookup: {
        cli: { by_operation: string; by_mcp_tool: string; by_cli_command: string };
        mcp: {
          tool: string;
          by_operation_arguments: { operation: string };
          by_mcp_tool_arguments: { mcp_tool: string };
          by_cli_command_arguments: { cli_command: string };
        };
      };
      operations: Array<{ operation: string; mcp_tool: string; cli_command: string; next_step: string }>;
      operations_by_id: Record<string, { operation: string; mcp_tool: string; cli_command: string; required_fields: string[]; missing_required_fields: string[]; execution_hint: Record<string, unknown>; full_contract_lookup: Record<string, unknown> }>;
      operations_by_mcp_tool: Record<string, string>;
      operations_by_cli_command: Record<string, string>;
      selection_sources: Record<string, string>;
    };

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(64 * 1024);
    expect(parsed.recommended_entrypoint).toBe("agent_enter");
    expect(parsed.index_use).toBe("Use an operation id, MCP tool, or CLI command from this compact index to fetch one operation contract.");
    expect(parsed.selection_sources).toEqual({
      operation: "operations_by_id.<operation>",
      mcp_tool_operation: "operations_by_mcp_tool.<tool>",
      cli_command_operation: "operations_by_cli_command.<command>",
      ordered_operation: "operations[]",
      execution_hint: "operations_by_id.<operation>.execution_hint",
      full_contract_lookup: "operations_by_id.<operation>.full_contract_lookup",
      full_contract_lookup_cli: "operations_by_id.<operation>.full_contract_lookup.cli",
      full_contract_lookup_mcp: "operations_by_id.<operation>.full_contract_lookup.mcp"
    });
    expect(parsed.next_lookup.cli.by_operation).toBe("moryn contracts operations --operation <operation>");
    expect(parsed.next_lookup.mcp).toEqual({
      tool: "operation_contracts",
      by_operation_arguments: { operation: "<operation>" },
      by_mcp_tool_arguments: { mcp_tool: "<tool>" },
      by_cli_command_arguments: { cli_command: "<command>" }
    });
    expect(parsed.operations_by_id.agent_finish).toEqual({
      operation: "agent_finish",
      category: "lifecycle",
      summary: "Write a final session summary and push sync when appropriate.",
      safe_to_run: false,
      ready_to_run: false,
      next_step: "collect_required_fields",
      mcp_tool: "agent_finish",
      cli_command: "moryn agent finish --summary <summary>",
      required_fields: ["summary"],
      missing_required_fields: ["summary"],
      execution_hint: {
        guard: "execution.ready_to_run",
        ready_to_run: false,
        next_step: "collect_required_fields",
        required_fields: ["summary"],
        missing_required_fields: ["summary"],
        required_input_sources: {
          by_field: "execution.required_inputs_by_field.<field>",
          by_argument_path: "execution.required_inputs_by_argument_path.<argument_path>"
        }
      },
      full_contract_lookup: {
        package_helper: "getOperationContract('agent_finish')",
        cli: {
          command: "moryn contracts operations --operation agent_finish",
          executable: "moryn",
          args: ["contracts", "operations", "--operation", "agent_finish"],
          exec_file: {
            executable: "moryn",
            args: ["contracts", "operations", "--operation", "agent_finish"]
          }
        },
        mcp: {
          tool: "operation_contracts",
          arguments: { operation: "agent_finish" }
        }
      }
    });
    expect(parsed.operations_by_mcp_tool.agent_finish).toBe("agent_finish");
    expect(parsed.operations_by_cli_command["moryn agent finish --summary <summary>"]).toBe("agent_finish");
    expect(parsed.operations.find((operation) => operation.operation === "agent_finish")).toEqual(parsed.operations_by_id.agent_finish);
    expect(parsed.operations_by_id.agent_finish).not.toHaveProperty("arguments_by_name");
    expect(parsed.operations_by_id.agent_finish).not.toHaveProperty("execution");
  });

  it("returns one operation contract from the CLI", async () => {
    const result = await exec("node", [
      "--import", tsxLoader, cliPath,
      "contracts", "operations",
      "--operation", "agent_finish"
    ]);
    const parsed = JSON.parse(result.stdout) as {
      operation_source: string;
      matched_source: string;
      operation: {
        operation: string;
        execution: {
          next_step: string;
          required_input_paths_by_value_path: Record<string, string>;
        };
      };
      selection_sources: Record<string, string>;
    };

    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(128 * 1024);
    expect(parsed.operation_source).toBe("operations_by_id.agent_finish");
    expect(parsed.matched_source).toBe("operations_by_id.agent_finish");
    expect(parsed.operation.operation).toBe("agent_finish");
    expect(parsed.operation.execution.next_step).toBe("collect_required_fields");
    expect(parsed.operation.execution.required_input_paths_by_value_path["user_input.summary"]).toBe("execution.required_inputs_by_field.summary");
    expect(parsed.selection_sources).toEqual(OPERATION_CONTRACTS_SELECTION_SOURCES);
  });

  it("returns one operation contract from the CLI by MCP tool or CLI command", async () => {
    const byMcpTool = await exec("node", [
      "--import", tsxLoader, cliPath,
      "contracts", "operations",
      "--mcp-tool", "agent_finish"
    ]);
    const byCliCommand = await exec("node", [
      "--import", tsxLoader, cliPath,
      "contracts", "operations",
      "--cli-command", "moryn agent finish --summary <summary>"
    ]);
    const parsedByMcpTool = JSON.parse(byMcpTool.stdout) as {
      operation_source: string;
      matched_source: string;
      operation: { operation: string };
      selection_sources: Record<string, string>;
    };
    const parsedByCliCommand = JSON.parse(byCliCommand.stdout) as {
      operation_source: string;
      matched_source: string;
      operation: { operation: string };
      selection_sources: Record<string, string>;
    };

    expect(Buffer.byteLength(byMcpTool.stdout, "utf8")).toBeLessThan(128 * 1024);
    expect(parsedByMcpTool.operation.operation).toBe("agent_finish");
    expect(parsedByMcpTool.operation_source).toBe("operations_by_id.agent_finish");
    expect(parsedByMcpTool.matched_source).toBe("operations_by_mcp_tool.agent_finish");
    expect(parsedByMcpTool.selection_sources).toEqual(OPERATION_CONTRACTS_SELECTION_SOURCES);
    expect(Buffer.byteLength(byCliCommand.stdout, "utf8")).toBeLessThan(128 * 1024);
    expect(parsedByCliCommand.operation.operation).toBe("agent_finish");
    expect(parsedByCliCommand.operation_source).toBe("operations_by_id.agent_finish");
    expect(parsedByCliCommand.matched_source).toBe("operations_by_cli_command.moryn agent finish --summary <summary>");
    expect(parsedByCliCommand.selection_sources).toEqual(OPERATION_CONTRACTS_SELECTION_SOURCES);
  });

  it("rejects ambiguous operation contract CLI lookup flags", async () => {
    try {
      await exec("node", [
        "--import", tsxLoader, cliPath,
        "contracts", "operations",
        "--operation", "agent_finish",
        "--mcp-tool", "agent_finish"
      ]);
      throw new Error("Expected ambiguous operation lookup to fail");
    } catch (error) {
      const parsed = JSON.parse((error as { stderr: string }).stderr) as {
        ok: boolean;
        error: {
          code: string;
          message: string;
          recoverable: boolean;
          recommended_action: string;
          recovery_hint: {
            rejected_lookup: {
              kind: string;
              provided: Array<{ mode: string; option: string }>;
            };
            accepted_lookup_modes: {
              index: { cli: { command: string; args: string[] }; mcp: { tool: string; arguments: { index: boolean } } };
              operation: { cli: string; mcp: { tool: string; arguments: { operation: string } } };
              mcp_tool: { cli: string; mcp: { tool: string; arguments: { mcp_tool: string } } };
              cli_command: { cli: string; mcp: { tool: string; arguments: { cli_command: string } } };
            };
            selection_sources: Record<string, string>;
          };
        };
      };

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INVALID_ARGUMENT");
      expect(parsed.error.message).toBe("Invalid argument: Use only one operation contract lookup option: --index, --operation, --mcp-tool, or --cli-command");
      expect(parsed.error.recoverable).toBe(true);
      expect(parsed.error.recommended_action).toBe("choose exactly one operation contract lookup mode and retry");
      expect(parsed.error.recovery_hint.rejected_lookup).toEqual({
        kind: "multiple_lookup_options",
        provided: [
          { mode: "operation", option: "--operation" },
          { mode: "mcp_tool", option: "--mcp-tool" }
        ]
      });
      expect(parsed.error.recovery_hint.accepted_lookup_modes.index).toEqual({
        cli: {
          command: "moryn contracts operations --index",
          args: ["contracts", "operations", "--index"]
        },
        mcp: {
          tool: "operation_contracts",
          arguments: { index: true }
        }
      });
      expect(parsed.error.recovery_hint.accepted_lookup_modes.operation.cli).toBe("moryn contracts operations --operation <operation>");
      expect(parsed.error.recovery_hint.accepted_lookup_modes.mcp_tool.mcp.arguments).toEqual({ mcp_tool: "<mcp_tool>" });
      expect(parsed.error.recovery_hint.accepted_lookup_modes.cli_command.mcp.arguments).toEqual({ cli_command: "<cli_command>" });
      expect(parsed.error.recovery_hint.selection_sources.operation).toBe("operations_by_id.<operation>");
    }
  });

  it("returns recovery hints for unknown operation contract CLI lookups", async () => {
    try {
      await exec("node", [
        "--import", tsxLoader, cliPath,
        "contracts", "operations",
        "--operation", "missing_operation"
      ]);
      throw new Error("Expected unknown operation lookup to fail");
    } catch (error) {
      const parsed = JSON.parse((error as { stderr: string }).stderr) as {
        ok: boolean;
        error: {
          code: string;
          message: string;
          recoverable: boolean;
          recommended_action: string;
          recovery_hint: {
            rejected_lookup: { kind: string; value: string };
            available_operations: string[];
            index_lookup: {
              package_helper: string;
              cli: { command: string; args: string[] };
              mcp: { tool: string; arguments: { index: boolean } };
            };
            retry_with_operation: {
              cli: string;
              mcp: { tool: string; arguments: { operation: string } };
            };
            selection_sources: Record<string, string>;
          };
        };
      };

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INVALID_ARGUMENT");
      expect(parsed.error.message).toBe("Invalid argument: Unknown operation: missing_operation");
      expect(parsed.error.recoverable).toBe(true);
      expect(parsed.error.recommended_action).toBe("fetch the compact operation index and retry with a known operation id, MCP tool, or CLI command");
      expect(parsed.error.recovery_hint.rejected_lookup).toEqual({ kind: "operation", value: "missing_operation" });
      expect(parsed.error.recovery_hint.available_operations).toContain("agent_finish");
      expect(parsed.error.recovery_hint.index_lookup).toEqual({
        package_helper: "getOperationContractIndex()",
        cli: {
          command: "moryn contracts operations --index",
          args: ["contracts", "operations", "--index"]
        },
        mcp: {
          tool: "operation_contracts",
          arguments: { index: true }
        }
      });
      expect(parsed.error.recovery_hint.retry_with_operation).toEqual({
        cli: "moryn contracts operations --operation <operation>",
        mcp: {
          tool: "operation_contracts",
          arguments: { operation: "<operation>" }
        }
      });
      expect(parsed.error.recovery_hint.selection_sources.operation).toBe("operations_by_id.<operation>");
    }
  });

  it("returns machine-readable agent guide from the CLI", async () => {
    await withTempDir(async (dir) => {
      const guide = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", join(dir, "store"),
        "agent", "guide",
        "--project", "/workspace/moryn",
        "--sync-remote", "git@github.com:user/moryn-store.git",
        "--current-task", "continue handoff",
        "--agent", "gemini",
        "--session-id", "gemini-guide"
      ]);
      const parsed = JSON.parse(guide.stdout) as {
        ok: boolean;
        recommended_entrypoint: string;
        selection_sources: Record<string, string>;
        startup: {
          tool: string;
          command: string;
          safe_to_run: boolean;
          required_when: string;
          required_fields: string[];
          required_fields_by_name?: Record<string, {
            name: string;
            argument_path: string;
            placeholder?: string;
            value?: unknown;
          }>;
          arguments: {
            project_path?: string;
            sync_remote?: string;
            current_task?: string;
            agent?: { client: string; session_id?: string };
          };
          interfaces?: {
            cli?: { command?: string };
            mcp?: { tool?: string; arguments?: Record<string, unknown> };
          };
          selection_sources?: Record<string, string>;
          workflow?: Record<string, unknown>;
        };
        lifecycle: Array<{
          step: string;
          tool: string;
          safe_to_run: boolean;
          command: string;
          required_when: string;
          required_fields: string[];
          required_fields_by_name?: Record<string, {
            name: string;
            argument_path: string;
            placeholder?: string;
            value?: unknown;
          }>;
          arguments: Record<string, unknown>;
          selection_sources?: Record<string, string>;
          safety?: {
            safe_to_auto_run?: boolean;
            requires_user_confirmation?: boolean;
            requires_authored_input?: boolean;
            writes_local_config?: boolean;
            reasons?: string[];
          };
          interfaces?: {
            cli?: { command?: string };
            mcp?: { tool?: string; arguments?: Record<string, unknown> };
          };
        }>;
        lifecycle_by_step: Record<string, {
          step: string;
          tool: string;
          safe_to_run: boolean;
          command: string;
          required_when: string;
          required_fields: string[];
          required_fields_by_name?: Record<string, {
            name: string;
            argument_path: string;
            placeholder?: string;
            value?: unknown;
          }>;
          arguments: Record<string, unknown>;
          selection_sources?: Record<string, string>;
        }>;
        rules: string[];
        rules_by_id: Record<string, {
          id: string;
          text: string;
        }>;
        guardrails: Array<{
          id: string;
          when: string;
          risk: string;
          avoid: string[];
          required_behavior: string;
          use_instead?: {
            recommended_action: string;
            tool: string;
            command: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            arguments: Record<string, unknown>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
          };
          allowed_action_sources?: string[];
        }>;
        guardrails_by_id: Record<string, {
          id: string;
          when: string;
          risk: string;
          avoid: string[];
          required_behavior: string;
          use_instead?: {
            recommended_action: string;
            tool: string;
            command: string;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
            arguments: Record<string, unknown>;
          };
          allowed_action_sources?: string[];
        }>;
        workflow: {
          version: number;
          start: string;
          continue_from: string[];
          phases: Array<{
            phase: string;
            order: number;
            action_source: string;
            tool?: string;
            required_when: string;
            required_fields: string[];
          }>;
          phases_by_name: Record<string, {
            phase: string;
            order: number;
            action_source: string;
            tool?: string;
            required_when: string;
            required_fields: string[];
          }>;
        };
        next: {
          recommended_action: string;
          tool: string;
          command: string;
          safe_to_run: boolean;
          required_when: string;
          required_fields: string[];
          arguments: Record<string, unknown>;
          interfaces?: {
            cli?: { command?: string };
            mcp?: { tool?: string; arguments?: Record<string, unknown> };
          };
          selection_sources?: Record<string, string>;
          workflow?: Record<string, unknown>;
        };
      };

      expect(parsed.ok).toBe(true);
      expect(parsed.recommended_entrypoint).toBe("agent_enter");
      expect(parsed.selection_sources).toEqual({
        startup: "startup",
        lifecycle_action: "lifecycle_by_step.<step>",
        rule: "rules_by_id.<rule_id>",
        guardrail: "guardrails_by_id.<guardrail_id>"
      });
      expect(parsed.startup).toMatchObject({
        tool: "agent_enter",
        command: "moryn agent enter --project /workspace/moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'continue handoff' --agent gemini --session-id gemini-guide",
        interfaces: expect.objectContaining({
          cli: expect.objectContaining({
            executable: "moryn",
            argv: [
              "agent", "enter",
              "--project", "/workspace/moryn",
              "--sync-remote", "git@github.com:user/moryn-store.git",
              "--current-task", "continue handoff",
              "--agent", "gemini",
              "--session-id", "gemini-guide"
            ],
            args: [
              "agent", "enter",
              "--project", "/workspace/moryn",
              "--sync-remote", "git@github.com:user/moryn-store.git",
              "--current-task", "continue handoff",
              "--agent", "gemini",
              "--session-id", "gemini-guide"
            ]
          })
        }),
        safe_to_run: true,
        required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
        required_fields: [],
        arguments: {
          project_path: "/workspace/moryn",
          sync_remote: "git@github.com:user/moryn-store.git",
          current_task: "continue handoff",
          agent: { client: "gemini", session_id: "gemini-guide" }
        }
      });
      expectActionInterfaces(parsed.startup);
      expectGuideEntrypointSelectionSources(parsed.startup, "startup");
      expectGuideEntrypointWorkflow(parsed.startup);
      expect(parsed.lifecycle.map((step) => step.tool)).toEqual([
        "agent_enter",
        "agent_status",
        "agent_finish",
        "agent_start"
      ]);
      expect(parsed.lifecycle_by_step.start_or_resume).toEqual(parsed.lifecycle[0]);
      expect(parsed.lifecycle_by_step.publish_status).toEqual(parsed.lifecycle.find((step) => step.step === "publish_status"));
      expect(parsed.lifecycle_by_step.finish_handoff).toEqual(parsed.lifecycle.find((step) => step.step === "finish_handoff"));
      expect(parsed.lifecycle_by_step.refresh_context).toEqual(parsed.lifecycle.find((step) => step.step === "refresh_context"));
      expect(parsed.startup.required_fields_by_name).toEqual({});
      expect(parsed.lifecycle_by_step.publish_status.required_fields_by_name?.status).toEqual({
        name: "status",
        argument_path: "status",
        placeholder: "<status>",
        value: "<status>"
      });
      expect(parsed.lifecycle_by_step.finish_handoff.required_fields_by_name?.summary).toEqual({
        name: "summary",
        argument_path: "summary",
        placeholder: "<summary>",
        value: "<summary>"
      });
      expect(parsed.lifecycle_by_step.refresh_context.required_fields_by_name?.refresh_since).toEqual({
        name: "refresh_since",
        argument_path: "refresh_since",
        placeholder: "<refresh_since>",
        value: "<refresh_since>"
      });
      expect(parsed.lifecycle).toContainEqual(expect.objectContaining({
        step: "publish_status",
        tool: "agent_status",
        safe_to_run: false,
        required_fields: ["status"],
        argument_sources: {
          status: "user_input.status"
        },
        safety: expect.objectContaining({
          safe_to_auto_run: false,
          requires_user_confirmation: false,
          requires_authored_input: true,
          writes_local_config: false,
          reasons: ["required_fields"]
        }),
        arguments: expect.objectContaining({ status: "<status>" })
      }));
      expect(parsed.lifecycle).toContainEqual(expect.objectContaining({
        step: "finish_handoff",
        tool: "agent_finish",
        safe_to_run: false,
        required_fields: ["summary"],
        argument_sources: {
          summary: "user_input.summary"
        },
        safety: expect.objectContaining({
          safe_to_auto_run: false,
          requires_user_confirmation: false,
          requires_authored_input: true,
          writes_local_config: false,
          reasons: ["required_fields"]
        }),
        arguments: expect.objectContaining({ summary: "<summary>" })
      }));
      expect(parsed.lifecycle).toContainEqual(expect.objectContaining({
        step: "refresh_context",
        tool: "agent_start",
        safe_to_run: true,
        command: "moryn agent start --project /workspace/moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'continue handoff' --agent gemini --session-id gemini-guide --refresh-since <refresh_since>",
        interfaces: expect.objectContaining({
          cli: expect.objectContaining({
            executable: "moryn",
            argv: [
              "agent", "start",
              "--project", "/workspace/moryn",
              "--sync-remote", "git@github.com:user/moryn-store.git",
              "--current-task", "continue handoff",
              "--agent", "gemini",
              "--session-id", "gemini-guide",
              "--refresh-since", "<refresh_since>"
            ],
            args: [
              "agent", "start",
              "--project", "/workspace/moryn",
              "--sync-remote", "git@github.com:user/moryn-store.git",
              "--current-task", "continue handoff",
              "--agent", "gemini",
              "--session-id", "gemini-guide",
              "--refresh-since", "<refresh_since>"
            ]
          })
        }),
        required_fields: ["refresh_since"],
        argument_sources: {
          refresh_since: "user_input.refresh_since"
        },
        safety: expect.objectContaining({
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          requires_authored_input: true,
          writes_local_config: false,
          reasons: expect.arrayContaining(["required_fields"])
        })
      }));
      for (const action of parsed.lifecycle) {
        expectActionInterfaces(action);
        expectActionSafety(action);
        expectLifecycleWorkflow(action);
        expectGuideLifecycleStepSelectionSources(action);
      }
      expectGuideLifecycleStepSelectionSources(parsed.lifecycle_by_step.publish_status);
      expectGuideLifecycleStepSelectionSources(parsed.lifecycle_by_step.finish_handoff);
      expectGuideLifecycleStepSelectionSources(parsed.lifecycle_by_step.refresh_context);
      expect(parsed.rules).toContain("Prefer agent_enter for startup; do not manually compose sync_pull, boot, and refresh.");
      expect(parsed.rules).toContain("When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id.");
      expect(Object.keys(parsed.rules_by_id)).toEqual([
        "prefer_agent_enter_for_startup",
        "discover_project_before_lifecycle_writes",
        "use_returned_actions_verbatim",
        "publish_status_and_finish_handoff",
        "pass_sync_remote_for_cross_device_handoff"
      ]);
      expect(parsed.rules_by_id.prefer_agent_enter_for_startup).toEqual({
        id: "prefer_agent_enter_for_startup",
        text: "Prefer agent_enter for startup; do not manually compose sync_pull, boot, and refresh."
      });
      expect(parsed.rules_by_id.discover_project_before_lifecycle_writes).toEqual({
        id: "discover_project_before_lifecycle_writes",
        text: "When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id."
      });
      expect(parsed.rules_by_id.use_returned_actions_verbatim.text).toBe("Use returned next.actions commands or arguments verbatim when continuing the lifecycle.");
      expect(parsed.rules).toEqual(Object.values(parsed.rules_by_id).map((rule) => rule.text));
      expect(parsed.guardrails.map((guardrail) => guardrail.id)).toEqual([
        "prefer_agent_enter_for_startup",
        "discover_project_before_lifecycle_writes",
        "use_returned_actions_verbatim",
        "publish_status_and_finish_handoff",
        "pass_sync_remote_for_cross_device_handoff"
      ]);
      expect(parsed.guardrails_by_id.prefer_agent_enter_for_startup).toEqual(parsed.guardrails[0]);
      expect(parsed.guardrails_by_id.discover_project_before_lifecycle_writes).toEqual(parsed.guardrails.find((guardrail) => guardrail.id === "discover_project_before_lifecycle_writes"));
      expect(parsed.guardrails_by_id.use_returned_actions_verbatim).toEqual(parsed.guardrails.find((guardrail) => guardrail.id === "use_returned_actions_verbatim"));
      expect(parsed.guardrails_by_id.publish_status_and_finish_handoff).toEqual(parsed.guardrails.find((guardrail) => guardrail.id === "publish_status_and_finish_handoff"));
      expect(parsed.guardrails_by_id.pass_sync_remote_for_cross_device_handoff).toEqual(parsed.guardrails.find((guardrail) => guardrail.id === "pass_sync_remote_for_cross_device_handoff"));
      expect(parsed.guardrails).toContainEqual(expect.objectContaining({
        id: "prefer_agent_enter_for_startup",
        when: parsed.startup.required_when,
        avoid: ["manual_sync_pull_boot_refresh", "manual_lower_level_startup_sequence"],
        required_behavior: "Call the returned agent_enter startup action instead of composing lower-level startup tools.",
        use_instead: {
          recommended_action: "call_agent_enter",
          ...parsed.startup
        }
      }));
      expect(parsed.guardrails).toContainEqual(expect.objectContaining({
        id: "use_returned_actions_verbatim",
        avoid: ["reconstruct_command_from_memory", "rename_argument_fields", "drop_required_fields"],
        allowed_action_sources: ["startup", "next", "lifecycle_by_step", "lifecycle", "response.next.actions"]
      }));
      expect(parsed.workflow).toMatchObject({
        version: 1,
        start: "startup",
        continue_from: ["agent_enter.next.actions", "lifecycle_by_step", "lifecycle"]
      });
      expect(parsed.workflow.phases).toEqual([
        {
          phase: "start_or_resume",
          order: 1,
          action_source: "startup",
          tool: "agent_enter",
          required_when: parsed.startup.required_when,
          required_fields: []
        },
        {
          phase: "follow_returned_next_actions",
          order: 2,
          action_source: "agent_enter.next.actions",
          required_when: "After agent_enter returns, prefer its response.next.actions over static guide templates.",
          required_fields: []
        },
        {
          phase: "publish_status",
          order: 3,
          action_source: "lifecycle_by_step.publish_status",
          tool: "agent_status",
          required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
          required_fields: ["status"]
        },
        {
          phase: "finish_handoff",
          order: 4,
          action_source: "lifecycle_by_step.finish_handoff",
          tool: "agent_finish",
          required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
          required_fields: ["summary"]
        },
        {
          phase: "refresh_context",
          order: 5,
          action_source: "lifecycle_by_step.refresh_context",
          tool: "agent_start",
          required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
          required_fields: ["refresh_since"]
        }
      ]);
      expect(parsed.workflow.phases_by_name.publish_status).toEqual(parsed.workflow.phases.find((phase) => phase.phase === "publish_status"));
      expect(parsed.workflow.phases_by_name.finish_handoff).toEqual(parsed.workflow.phases.find((phase) => phase.phase === "finish_handoff"));
      expect(parsed.next).toMatchObject({
        recommended_action: "call_agent_enter",
        tool: "agent_enter",
        command: parsed.startup.command,
        safe_to_run: true,
        required_when: parsed.startup.required_when,
        required_fields: [],
        arguments: parsed.startup.arguments
      });
      expectActionInterfaces(parsed.next);
      expectGuideEntrypointSelectionSources(parsed.next, "next");
      expectGuideNextWorkflow(parsed.next);
    });
  });

  it("requires explicit project id in agent guide lifecycle templates when project is unknown", async () => {
    await withTempDir(async (dir) => {
      const guide = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", join(dir, "store"),
        "agent", "guide",
        "--sync-remote", "git@github.com:user/moryn-store.git",
        "--current-task", "find project",
        "--agent", "gemini",
        "--session-id", "gemini-guide-discovery"
      ]);
      const parsed = JSON.parse(guide.stdout) as {
        startup: { command: string; safe_to_run: boolean; required_when: string; required_fields: string[]; arguments: { project_id?: string } };
        guardrails: Array<{
          id: string;
          required_behavior: string;
          use_instead?: { command: string; arguments: { project_id?: string } };
        }>;
        guardrails_by_id: Record<string, {
          id: string;
          required_behavior: string;
          use_instead?: { command: string; arguments: { project_id?: string } };
        }>;
        rules_by_id: Record<string, {
          id: string;
          text: string;
        }>;
        workflow: {
          start: string;
          phases: Array<{
            phase: string;
            action_source: string;
            required_fields: string[];
          }>;
        };
        lifecycle: Array<{
          step: string;
          tool: string;
          command: string;
          required_fields: string[];
          arguments: { project_id?: string; status?: string; summary?: string; refresh_since?: string };
        }>;
        lifecycle_by_step: Record<string, {
          step: string;
          tool: string;
          command: string;
          required_fields: string[];
          arguments: { project_id?: string; status?: string; summary?: string; refresh_since?: string };
        }>;
      };

      expect(parsed.startup.command).toBe("moryn agent enter --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-guide-discovery");
      expect(parsed.startup.safe_to_run).toBe(true);
      expect(parsed.startup.required_when).toBe("At the start of an agent turn, or whenever store/project/sync context is uncertain.");
      expect(parsed.startup.required_fields).toEqual([]);
      expect(parsed.startup.arguments.project_id).toBeUndefined();
      expect(parsed.guardrails).toContainEqual(expect.objectContaining({
        id: "discover_project_before_lifecycle_writes",
        required_behavior: "When project context is unclear, call agent_enter discovery and choose a returned project before lifecycle writes.",
        use_instead: expect.objectContaining({
          command: parsed.startup.command,
          arguments: parsed.startup.arguments
        })
      }));
      expect(parsed.guardrails_by_id.discover_project_before_lifecycle_writes).toEqual(parsed.guardrails.find((guardrail) => guardrail.id === "discover_project_before_lifecycle_writes"));
      expect(parsed.rules_by_id.discover_project_before_lifecycle_writes).toEqual({
        id: "discover_project_before_lifecycle_writes",
        text: "When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id."
      });
      expect(parsed.workflow.start).toBe("startup");
      expect(parsed.workflow.phases).toContainEqual(expect.objectContaining({
        phase: "publish_status",
        action_source: "lifecycle_by_step.publish_status",
        required_fields: ["project_id", "status"]
      }));
      expect(parsed.workflow.phases).toContainEqual(expect.objectContaining({
        phase: "finish_handoff",
        action_source: "lifecycle_by_step.finish_handoff",
        required_fields: ["project_id", "summary"]
      }));
      expect(parsed.workflow.phases).toContainEqual(expect.objectContaining({
        phase: "refresh_context",
        action_source: "lifecycle_by_step.refresh_context",
        required_fields: ["project_id", "refresh_since"]
      }));
      expect(parsed.lifecycle).toContainEqual(expect.objectContaining({
        step: "publish_status",
        tool: "agent_status",
        command: "moryn agent status --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-guide-discovery --status <status>",
        required_fields: ["project_id", "status"],
        arguments: expect.objectContaining({ project_id: "<project_id>", status: "<status>" })
      }));
      expect(parsed.lifecycle).toContainEqual(expect.objectContaining({
        step: "finish_handoff",
        tool: "agent_finish",
        command: "moryn agent finish --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-guide-discovery --summary <summary>",
        required_fields: ["project_id", "summary"],
        arguments: expect.objectContaining({ project_id: "<project_id>", summary: "<summary>" })
      }));
      expect(parsed.lifecycle).toContainEqual(expect.objectContaining({
        step: "refresh_context",
        tool: "agent_start",
        command: "moryn agent start --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-guide-discovery --refresh-since <refresh_since>",
        required_fields: ["project_id", "refresh_since"],
        arguments: expect.objectContaining({ project_id: "<project_id>", refresh_since: "<refresh_since>" })
      }));
      expect(parsed.lifecycle_by_step.publish_status).toEqual(parsed.lifecycle.find((step) => step.step === "publish_status"));
      expect(parsed.lifecycle_by_step.finish_handoff).toEqual(parsed.lifecycle.find((step) => step.step === "finish_handoff"));
      expect(parsed.lifecycle_by_step.refresh_context).toEqual(parsed.lifecycle.find((step) => step.step === "refresh_context"));
      for (const action of parsed.lifecycle) {
        expectLifecycleWorkflow(action);
      }
    });
  });

  it("initializes a store and writes a record", async () => {
    await withTempDir(async (dir) => {
      const init = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const parsedInit = JSON.parse(init.stdout) as {
        artifacts: { config: string };
        selection_sources: Record<string, string>;
      };
      expect(parsedInit.artifacts.config).toBe("config.json");
      expect(parsedInit.selection_sources).toEqual(STORE_INIT_SELECTION_SOURCES);
      const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as { store_version: number; device_id: string };
      expect(config.store_version).toBe(1);
      expect(config.device_id).toMatch(/^device_/);

      const write = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", "Use events"]);
      expect(write.stdout).toContain("rec_");
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "recall", "events", "--project-id", "moryn"]);
      expect(recall.stdout).toContain("Use events");
    });
  });

  it("handles concurrent CLI rebuilds without derived-view races", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      const texts = Array.from({ length: 8 }, (_, index) => `Concurrent rebuild seed ${index}`);
      for (const text of texts) {
        await exec("node", [
          "--import", tsxLoader, cliPath, "--store", store,
          "write",
          "--kind", "memory",
          "--type", "decision",
          "--scope", "project",
          "--project-id", "moryn",
          "--tag", "stress",
          "--state", "canonical",
          "--text", text
        ]);
      }

      const rebuilds = await Promise.allSettled(Array.from({ length: 12 }, () => exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "rebuild"
      ])));

      const failures = rebuilds
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
      expect(failures).toEqual([]);

      const recall = JSON.parse(await readFile(join(store, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      const indexedTexts = new Set(recall.records.map((record) => record.text));

      for (const text of texts) {
        expect(indexedTexts).toContain(text);
      }
    });
  }, 30000);

  it("initializes project config and resolves --project for writes", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const initProject = await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn", "--tag", "typescript", "--tag", "mcp", "--sync-mode", "interval"]);
      const parsedProject = JSON.parse(initProject.stdout) as {
        artifacts: { config: string };
        selection_sources: Record<string, string>;
      };
      expect(parsedProject.artifacts.config).toBe(".moryn.json");
      expect(parsedProject.selection_sources).toEqual(PROJECT_INIT_SELECTION_SOURCES);

      const projectConfig = JSON.parse(await readFile(join(project, ".moryn.json"), "utf8")) as { project_id: string; tags: string[]; sync: { mode: string } };
      expect(projectConfig).toMatchObject({ project_id: "moryn", tags: ["typescript", "mcp"], sync: { mode: "interval" } });

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project", project, "--text", "Use project config"]);
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "project config", "--project", project]);

      expect(recall.stdout).toContain("\"project_id\": \"moryn\"");
      expect(recall.stdout).toContain("Use project config");
    });
  });

  it("preserves existing project sync mode when the CLI updates config without --sync-mode", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn", "--sync-mode", "interval"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--tag", "typescript"]);

      const projectConfig = JSON.parse(await readFile(join(project, ".moryn.json"), "utf8")) as { tags: string[]; sync: { mode: string } };
      expect(projectConfig.tags).toEqual(["typescript"]);
      expect(projectConfig.sync.mode).toBe("interval");
    });
  });

  it("recalls an explicit record id through the CLI even when --project differs", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const other = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "other",
        "--state", "canonical",
        "--text", "CLI retrieves this exact record across project context."
      ]);
      const recordId = (JSON.parse(other.stdout) as { record: { id: string } }).record.id;

      const recall = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id", recordId,
        "--project", project
      ]);

      expect(recall.stdout).toContain(recordId);
      expect(recall.stdout).toContain("CLI retrieves this exact record across project context.");
    });
  });

  it("recalls with filters and refreshes changes from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "blocker",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--tag", "src/sync/git.ts",
        "--state", "canonical",
        "--priority", "high",
        "--text", "Sync must not overwrite local events."
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      const recall = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "recall",
        "--record-id", recordId,
        "--project-id", "moryn",
        "--kind", "memory",
        "--scope", "project",
        "--type", "blocker",
        "--state", "canonical",
        "--tag", "sync",
        "--file", "src/sync/git.ts"
      ]);
      const parsedRecall = JSON.parse(recall.stdout) as {
        results: Array<{ record: { id: string; content: { text: string } }; reason: string[] }>;
        results_by_id: Record<string, { record: { id: string; content: { text: string } }; reason: string[] }>;
        selection_sources: Record<string, string>;
      };
      expect(JSON.stringify(parsedRecall)).toContain("file_match:src/sync/git.ts");
      expect(JSON.stringify(parsedRecall)).toContain("Sync must not overwrite local events.");
      expect(parsedRecall.selection_sources).toEqual({
        result: "results_by_id.<record_id>",
        record: "results_by_id.<record_id>.record",
        record_id: "results_by_id.<record_id>.record.id"
      });
      expect(parsedRecall.results_by_id[recordId]).toEqual(parsedRecall.results[0]);

      const refresh = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "refresh", "--project-id", "moryn", "--cursor", "2000-01-01T00:00:00.000Z"]);
      const parsedRefresh = JSON.parse(refresh.stdout) as {
        changes: Array<{
          record_id: string;
          importance: string;
          next_action: {
            recommended_action: string;
            tool: string;
            command: string;
            arguments: Record<string, unknown>;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
          };
        }>;
        changes_by_record_id: Record<string, {
          record_id: string;
          importance: string;
          next_action: {
            workflow?: Record<string, unknown>;
          };
        }>;
        selection_sources: Record<string, string>;
      };
      expect(parsedRefresh.selection_sources).toEqual({
        change: "changes_by_record_id.<record_id>",
        record_id: "changes_by_record_id.<record_id>.record_id",
        next_action: "changes_by_record_id.<record_id>.next_action"
      });
      expect(parsedRefresh.changes).toContainEqual(expect.objectContaining({
        record_id: recordId,
        importance: "interrupt",
        next_action: expect.any(Object)
      }));
      expect(parsedRefresh.changes_by_record_id[recordId]).toEqual(parsedRefresh.changes[0]);
      expectRefreshChangeNextAction(parsedRefresh.changes[0]!.next_action, recordId, "moryn");
      expect(parsedRefresh.changes_by_record_id[recordId]!.next_action.workflow).toEqual(parsedRefresh.changes[0]!.next_action.workflow);

      const recent = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "list-recent", "--limit", "1"]);
      const parsedRecent = JSON.parse(recent.stdout) as {
        records: Array<{ id: string; content: { text: string } }>;
        records_by_id: Record<string, { id: string; content: { text: string } }>;
        selection_sources: Record<string, string>;
      };
      expect(parsedRecent.records[0]?.id).toBe(recordId);
      expect(parsedRecent.selection_sources).toEqual({
        record: "records_by_id.<record_id>",
        record_id: "records_by_id.<record_id>.id"
      });
      expect(parsedRecent.records_by_id[recordId]).toEqual(parsedRecent.records[0]);
    });
  });

  it("writes confidence from the CLI for high-confidence candidate boot changes", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--confidence", "0.9",
        "--text", "Candidate release decision is ready for review."
      ]);
      const parsedWrite = JSON.parse(write.stdout) as { record: { id: string; confidence: number } };

      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "boot", "--project-id", "moryn"]);
      const parsedBoot = JSON.parse(boot.stdout) as {
        recent_changes: Array<{ id: string }>;
        records_by_id: Record<string, { id: string }>;
        recent_changes_by_id: Record<string, { id: string }>;
        selection_sources: Record<string, string>;
      };

      expect(parsedWrite.record.confidence).toBe(0.9);
      expect(parsedBoot.selection_sources).toEqual({
        record: "records_by_id.<record_id>",
        record_id: "records_by_id.<record_id>.id",
        user_preference: "profile.user_preferences_by_id.<record_id>",
        soul: "profile.soul_by_id.<record_id>",
        global_rule: "profile.global_rules_by_id.<record_id>",
        important_decision: "project.important_decisions_by_id.<record_id>",
        warning: "project.warnings_by_id.<record_id>",
        skill: "skills_by_id.<record_id>",
        task_relevant: "task_relevant_by_id.<record_id>",
        recent_change: "recent_changes_by_id.<record_id>"
      });
      expect(parsedBoot.recent_changes.map((record) => record.id)).toContain(parsedWrite.record.id);
      expect(parsedBoot.recent_changes_by_id[parsedWrite.record.id]).toEqual(
        parsedBoot.recent_changes.find((record) => record.id === parsedWrite.record.id)
      );
      expect(parsedBoot.records_by_id[parsedWrite.record.id]).toEqual(
        parsedBoot.recent_changes.find((record) => record.id === parsedWrite.record.id)
      );
    });
  });

  it("does not apply ambient project config when only --project-id is provided", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), JSON.stringify({
        project_id: "ambient",
        tags: ["ambient-tag"],
        default_skills: ["ambient-skill"]
      }), "utf8");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "skill",
        "--type", "procedure",
        "--scope", "global",
        "--tag", "ambient-skill",
        "--state", "canonical",
        "--text", "Ambient default skill must not attach to explicit project id.",
        "--confirm"
      ]);

      const write = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "explicit",
        "--text", "Explicit CLI project id should stand alone."
      ], { cwd: project });
      const parsed = JSON.parse(write.stdout) as { record: { project_id?: string; tags: string[] } };

      expect(parsed.record.project_id).toBe("explicit");
      expect(parsed.record.tags).toEqual([]);

      const boot = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "boot",
        "--project-id", "explicit"
      ], { cwd: project });
      const parsedBoot = JSON.parse(boot.stdout) as { skills: Array<{ id: string }> };

      expect(parsedBoot.skills).toEqual([]);
    });
  });

  it("does not leak project records into boot without project context", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer concise engineering updates.",
        "--confirm"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "alpha",
        "--state", "canonical",
        "--priority", "high",
        "--tag", "auth",
        "--text", "Alpha auth token refresh is blocked by stale credentials."
      ]);

      const boot = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "boot",
        "--current-task", "fix auth token refresh"
      ]);
      const parsed = JSON.parse(boot.stdout) as {
        profile: { user_preferences: Array<{ content: { text?: string } }> };
        project: { warnings: unknown[]; important_decisions: unknown[] };
        task_relevant: unknown[];
        recent_changes: Array<{ scope: string; content: { text?: string } }>;
      };

      expect(parsed.profile.user_preferences.map((record) => record.content.text)).toEqual(["Prefer concise engineering updates."]);
      expect(parsed.project.warnings).toEqual([]);
      expect(parsed.project.important_decisions).toEqual([]);
      expect(parsed.task_relevant).toEqual([]);
      expect(parsed.recent_changes.every((record) => record.scope === "global")).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain("Alpha auth token refresh is blocked");
    });
  });

  it("rejects invalid confidence options", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const confidence of ["abc", "1.1"]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "write",
            "--kind", "memory",
            "--type", "decision",
            "--scope", "project",
            "--project-id", "moryn",
            "--confidence", confidence,
            "--text", "Invalid confidence should be rejected."
          ]);
          throw new Error(`Expected moryn write to reject --confidence ${confidence}`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recoverable: boolean;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; min: number; max: number; inclusive: boolean };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --confidence");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("retry with a valid --confidence value");
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option: "--confidence", value: confidence },
            expected: { kind: "number_range", min: 0, max: 1, inclusive: true },
            retry_with: { option: "--confidence", value_placeholder: "<number 0-1>" }
          });
        }
      }
    });
  });

  it("rejects project-scoped CLI writes without project context", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "write",
          "--kind", "memory",
          "--type", "decision",
          "--scope", "project",
          "--text", "Project records need an explicit project context."
        ]);
        throw new Error("Expected moryn write to reject a project-scoped record without project context");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recommended_action: string;
            recovery_hint: {
              rejected_argument: { option: string; value: string };
              expected: { kind: string; required: boolean };
              discover_with: { tool: string; command: string; arguments: Record<string, unknown> };
              retry_with: { option: string; value_source: string; value_placeholder: string };
            };
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              required_when?: string;
              required_fields: string[];
              workflow?: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("project_id is required for project scope");
        expect(parsed.error.recommended_action).toBe("run moryn project list, then retry with a known project_id");
        expect(parsed.error.recovery_hint).toEqual({
          rejected_argument: { option: "--scope", value: "project" },
          expected: { kind: "project_context", required: true },
          discover_with: {
            tool: "project_list",
            command: "moryn project list",
            arguments: {}
          },
          retry_with: {
            option: "--project-id",
            value_source: "project_list.projects_by_id.<project_id>.project_id",
            value_placeholder: "<project_id>"
          }
        });
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "discover_project_context_before_project_scoped_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          rejected_arguments: { scope: "project" },
          required_fields: [],
          safe_to_run: true
        });
        expectRecoveryWorkflow(parsed.error.next_action!);
      }

      expect(await readEvents(dir)).toHaveLength(0);
    });
  });

  it("rejects empty global store paths at the CLI boundary", async () => {
    try {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", "", "init"]);
      throw new Error("Expected moryn init to reject an empty --store path");
    } catch (error) {
      if (!("stderr" in (error as object))) throw error;
      const parsed = JSON.parse((error as { stderr: string }).stderr) as {
        ok: boolean;
        error: {
          code: string;
          message: string;
          recommended_action: string;
          recovery_hint: {
            rejected_argument: { option: string; value: string };
            expected: { kind: string; min_length: number };
            retry_with: { option: string; value_placeholder: string };
          };
        };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("INVALID_ARGUMENT");
      expect(parsed.error.message).toContain("Invalid --store");
      expect(parsed.error.recommended_action).toBe("retry with a non-empty --store value");
      expect(parsed.error.recovery_hint).toEqual({
        rejected_argument: { option: "--store", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        retry_with: { option: "--store", value_placeholder: "<non-empty store>" }
      });
    }
  });

  it("writes provenance from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--derived-from", "rec_source",
        "--reason", "Derived from handoff summary.",
        "--text", "Use provenance metadata."
      ]);
      const parsed = JSON.parse(write.stdout) as {
        record: {
          provenance?: {
            derived_from?: string[];
            reason?: string;
            method?: string;
          };
        };
      };

      expect(parsed.record.provenance).toEqual({
        derived_from: ["rec_source"],
        reason: "Derived from handoff summary.",
        method: "agent-proposed"
      });
    });
  });

  it("writes structured JSON content from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--content-json", JSON.stringify({
          text: "Use structured CLI content.",
          format: "json",
          evidence: ["cli", "mcp-parity"]
        })
      ]);
      const parsed = JSON.parse(write.stdout) as {
        record: {
          content: {
            text?: string;
            format?: string;
            evidence?: string[];
          };
        };
      };

      expect(parsed.record.content).toEqual({
        text: "Use structured CLI content.",
        format: "json",
        evidence: ["cli", "mcp-parity"]
      });
    });
  });

  it("surfaces structured JSON content without text through CLI boot refresh and recall", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const summary = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "summary",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "canonical",
        "--content-json", JSON.stringify({
          format: "json",
          summary: "CLI structured boot summary."
        })
      ]);
      const warning = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "canonical",
        "--content-json", JSON.stringify({
          format: "json",
          summary: "CLI structured warning.",
          files: ["src/cli.ts"],
          evidence: ["cli-structured"]
        })
      ]);
      const summaryId = (JSON.parse(summary.stdout) as { record: { id: string } }).record.id;
      const warningId = (JSON.parse(warning.stdout) as { record: { id: string } }).record.id;

      const boot = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "boot",
        "--project-id", "moryn"
      ])).stdout) as { project: { summary: string; warnings: Array<{ id: string }>; warnings_by_id: Record<string, { id: string }> } };
      const refresh = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--project-id", "moryn",
        "--cursor", "2000-01-01T00:00:00.000Z"
      ])).stdout) as { changes: Array<{ record_id: string; summary: string }> };
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "recall",
        "cli-structured",
        "--project-id", "moryn"
      ])).stdout) as { results: Array<{ record: { id: string }; reason: string[] }> };

      expect(boot.project.summary).toBe("CLI structured boot summary.");
      expect(boot.project.warnings.map((record) => record.id)).toContain(warningId);
      expect(boot.project.warnings_by_id[warningId]?.id).toBe(warningId);
      expect(refresh.changes).toContainEqual(expect.objectContaining({
        record_id: summaryId,
        summary: "CLI structured boot summary."
      }));
      expect(refresh.changes).toContainEqual(expect.objectContaining({
        record_id: warningId,
        summary: "CLI structured warning. src/cli.ts cli-structured"
      }));
      expect(recall.results[0]?.record.id).toBe(warningId);
      expect(recall.results[0]?.reason).toContain("text_match:cli-structured");
    });
  });

  it("rejects invalid CLI structured content options", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, expectedKind } of [
        { args: ["--content-json", "["], expectedKind: "valid_json_object" },
        { args: ["--content-json", "[]"], expectedKind: "json_object" }
      ]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "write",
            "--kind", "memory",
            "--type", "decision",
            "--scope", "project",
            "--project-id", "moryn",
            ...args
          ]);
          throw new Error(`Expected moryn write ${args.join(" ")} to reject invalid content options`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --content-json");
          expect(parsed.error.recommended_action).toBe("retry with a valid --content-json JSON object");
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option: "--content-json", value: args[1]! },
            expected: { kind: expectedKind },
            retry_with: { option: "--content-json", value_placeholder: "<json object>" }
          });
        }
      }

      for (const { args, recoveryHint } of [
        {
          args: ["--content-json", "{\"text\":\"\",\"format\":\"json\"}"],
          recoveryHint: undefined
        },
        {
          args: ["--text", "Plain text", "--content-json", "{\"text\":\"Structured\"}"],
          recoveryHint: {
            rejected_arguments: [
              { option: "--text", value: "Plain text" },
              { option: "--content-json", value: "{\"text\":\"Structured\"}" }
            ],
            expected: { kind: "choose_one", options: ["--text", "--content-json"] },
            retry_with: [
              { option: "--text", value_placeholder: "<text>" },
              { option: "--content-json", value_placeholder: "<json object>" }
            ]
          }
        },
        {
          args: [],
          recoveryHint: {
            missing_one_of: [
              { option: "--text", value_placeholder: "<text>" },
              { option: "--content-json", value_placeholder: "<json object>" }
            ],
            expected: { kind: "choose_one", options: ["--text", "--content-json"] },
            retry_with: [
              { option: "--text", value_placeholder: "<text>" },
              { option: "--content-json", value_placeholder: "<json object>" }
            ]
          }
        }
      ]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "write",
            "--kind", "memory",
            "--type", "decision",
            "--scope", "project",
            "--project-id", "moryn",
            ...args
          ]);
          throw new Error(`Expected moryn write ${args.join(" ")} to reject invalid content options`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: { code: string; recommended_action?: string; recovery_hint?: unknown };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          if (recoveryHint) {
            expect(parsed.error.recommended_action).toBe("retry with exactly one write content input");
            expect(parsed.error.recovery_hint).toEqual(recoveryHint);
          }
        }
      }
    });
  });

  it("rejects empty CLI string options before writing events", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, message, option } of [
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", ""],
          message: "Invalid --text",
          option: "--text"
        },
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", "Valid text", "--tag", ""],
          message: "Invalid --tag",
          option: "--tag"
        },
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--text", "Valid text", "--derived-from", ""],
          message: "Invalid --derived-from",
          option: "--derived-from"
        },
        {
          args: ["refresh", "--project-id", "moryn", "--cursor", ""],
          message: "Invalid --cursor",
          option: "--cursor"
        },
        {
          args: ["sync", "--push", "--message", ""],
          message: "Invalid --message",
          option: "--message"
        }
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject an empty string option`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; min_length: number };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain(message);
          expect(parsed.error.recommended_action).toBe(`retry with a non-empty ${option} value`);
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option, value: "" },
            expected: { kind: "non_empty_string", min_length: 1 },
            retry_with: { option, value_placeholder: `<non-empty ${option.slice(2)}>` }
          });
        }
      }

      await expect(readEvents(dir)).resolves.toHaveLength(0);
    });
  });

  it("writes project session summaries with handoff defaults from the CLI", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts",
        "project", "init",
        "--path", project,
        "--project-id", "moryn",
        "--tag", "handoff"
      ]);

      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "session_summary",
        "--project", project,
        "--text", "Finished the task summary."
      ]);
      const parsed = JSON.parse(write.stdout) as {
        record: {
          kind: string;
          type: string;
          scope: string;
          project_id?: string;
          tags: string[];
          state: string;
          content: { text?: string };
        };
      };

      expect(parsed.record).toMatchObject({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["handoff"],
        state: "candidate",
        content: { text: "Finished the task summary." }
      });
    });
  });

  it("revises records with repeated CLI assignments and JSON scalar values", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--text", "Use old sync wording"
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "revise",
        recordId,
        "--set", "content.text=\"Use private Git sync\"",
        "--set", "confidence=0.92",
        "--reason", "Clarified wording"
      ]);
      const recall = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "recall",
        "--record-id", recordId
      ]);
      const parsed = JSON.parse(recall.stdout) as { results: Array<{ record: { content: { text: string }; confidence: number } }> };

      expect(parsed.results[0]?.record.content.text).toBe("Use private Git sync");
      expect(parsed.results[0]?.record.confidence).toBe(0.92);
    });
  });

  it("rejects CLI revisions that attempt to change managed fields", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--text", "Use promote for state transitions."
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "revise",
          recordId,
          "--set", "state=\"canonical\"",
          "--reason", "Bypass promotion"
        ]);
        throw new Error("Expected moryn revise to reject managed state patch");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recommended_action: string;
            recovery_hint: {
              rejected_patch: { path: string; value: unknown };
              expected: { kind: string; managed_fields: string[] };
              retry_with: { remove_patch_path: string; use_operation: string; operation_arguments: Record<string, unknown> };
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("managed field state");
        expect(parsed.error.recommended_action).toBe("retry revise without managed fields");
        expect(parsed.error.recovery_hint).toEqual({
          rejected_patch: { path: "state", value: "canonical" },
          expected: {
            kind: "user_editable_patch",
            managed_fields: ["id", "kind", "scope", "state", "visibility", "created_at", "updated_at", "source", "provenance", "conflict", "links"]
          },
          retry_with: {
            remove_patch_path: "state",
            use_operation: "promote",
            operation_arguments: { record_id: recordId, target_state: "canonical", confirmed: true }
          }
        });
      }
    });
  });

  it("rejects CLI revisions that would create invalid records", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "candidate",
        "--text", "Keep revision patches valid."
      ]);
      const recordId = (JSON.parse(write.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "revise",
          recordId,
          "--set", "content.text=",
          "--reason", "Invalid blank revision"
        ]);
        throw new Error("Expected moryn revise to reject blank content.text patch");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: { code: string; message: string; recommended_action: string; recovery_hint: unknown };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("Invalid patch");
        expect(parsed.error.recommended_action).toBe("retry revise with a valid patch");
        expect(parsed.error.recovery_hint).toEqual({
          rejected_patch: { patch: { "content.text": "" } },
          expected: { kind: "valid_record_after_patch" },
          retry_with: { patch_placeholder: { "content.text": "<non-empty text>" } }
        });
      }
    });
  });

  it("rejects malformed CLI revision assignments as invalid arguments", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const assignment of ["content.text", ".content.text=value", "content..text=value", "content.text.=value"]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "revise",
            "rec_missing",
            "--set",
            assignment
          ]);
          throw new Error("Expected moryn revise to reject malformed --set assignment");
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recoverable: boolean;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; key_path: string; separator: string; value: string };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --set assignment");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("retry with a valid --set path assignment");
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option: "--set", value: assignment },
            expected: {
              kind: "path_assignment",
              key_path: "dot-separated patch path",
              separator: "=",
              value: "JSON scalar/object/array or string"
            },
            retry_with: { option: "--set", value_placeholder: "<path>=<json-or-string>" }
          });
        }
      }
    });
  });

  it("filters refresh interrupts by current task from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const authWarning = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "auth",
        "--state", "canonical",
        "--text", "Auth token refresh has a blocker"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "release",
        "--state", "canonical",
        "--text", "Release requires npm credentials"
      ]);
      const recordId = (JSON.parse(authWarning.stdout) as { record: { id: string } }).record.id;

      const refresh = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--project-id", "moryn",
        "--cursor", "2000-01-01T00:00:00.000Z",
        "--current-task", "fix auth token refresh"
      ]);

      expect(refresh.stdout).toContain(recordId);
      expect(refresh.stdout).toContain("current_task_match");
      expect(refresh.stdout).not.toContain("Release requires npm credentials");
    });
  });

  it("does not leak project refresh changes without project context", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer concise engineering updates.",
        "--confirm"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "write",
        "--kind", "memory",
        "--type", "blocker",
        "--scope", "project",
        "--project-id", "alpha",
        "--state", "canonical",
        "--priority", "high",
        "--tag", "auth",
        "--text", "Alpha auth token refresh is blocked by stale credentials."
      ]);

      const refresh = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", dir,
        "refresh",
        "--cursor", "2000-01-01T00:00:00.000Z",
        "--current-task", "fix auth token refresh"
      ]);
      const parsed = JSON.parse(refresh.stdout) as {
        should_interrupt: boolean;
        changes: Array<{ summary: string; importance: string }>;
      };

      expect(parsed.should_interrupt).toBe(false);
      expect(parsed.changes).toEqual([
        expect.objectContaining({
          summary: "Prefer concise engineering updates.",
          importance: "notice"
        })
      ]);
      expect(JSON.stringify(parsed)).not.toContain("Alpha auth token refresh is blocked");
    });
  });

  it("archives, quarantines, links, and boots project default skills from the CLI", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts",
        "project", "init",
        "--path", project,
        "--project-id", "moryn",
        "--default-skill", "safe-release"
      ]);

      const skillWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "skill",
        "--type", "procedure",
        "--scope", "global",
        "--tag", "release",
        "--state", "canonical",
        "--text", "safe-release: run tests before publishing",
        "--confirm"
      ]);
      const decisionWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--text", "Use linked memories"
      ]);
      const oldWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--text", "Old linked memory"
      ]);
      const secretWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--text", "Review this warning"
      ]);
      const parsedSkillWrite = JSON.parse(skillWrite.stdout) as { record: { id: string }; selection_sources: Record<string, string> };
      const parsedDecisionWrite = JSON.parse(decisionWrite.stdout) as { record: { id: string }; selection_sources: Record<string, string> };
      const parsedOldWrite = JSON.parse(oldWrite.stdout) as { record: { id: string }; selection_sources: Record<string, string> };
      const parsedSecretWrite = JSON.parse(secretWrite.stdout) as { record: { id: string }; selection_sources: Record<string, string> };
      const skillId = parsedSkillWrite.record.id;
      const decisionId = parsedDecisionWrite.record.id;
      const oldId = parsedOldWrite.record.id;
      const secretId = parsedSecretWrite.record.id;

      expect(parsedSkillWrite.selection_sources).toEqual(WRITE_SELECTION_SOURCES);
      expect(parsedDecisionWrite.selection_sources).toEqual(WRITE_SELECTION_SOURCES);

      const link = JSON.parse((await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "link", decisionId, oldId, "--type", "supersedes"])).stdout) as {
        event: { record_id: string; linked_record_id: string };
        selection_sources: Record<string, string>;
      };
      const archive = JSON.parse((await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "archive", oldId, "--reason", "Superseded"])).stdout) as {
        event: { record_id: string };
        selection_sources: Record<string, string>;
      };
      const quarantine = JSON.parse((await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "quarantine", secretId, "--reason", "Needs review"])).stdout) as {
        event: { record_id: string };
        selection_sources: Record<string, string>;
      };

      expect(link.selection_sources).toEqual(LINK_EVENT_SELECTION_SOURCES);
      expect(link.event.record_id).toBe(decisionId);
      expect(link.event.linked_record_id).toBe(oldId);
      expect(archive.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);
      expect(quarantine.selection_sources).toEqual(MUTATION_EVENT_SELECTION_SOURCES);

      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "boot", "--project", project]);
      expect(boot.stdout).toContain(skillId);
      expect(boot.stdout).toContain("safe-release: run tests before publishing");

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--tag", "auth",
        "--text", "Auth token refresh uses rotating credentials"
      ]);
      const taskBoot = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "boot",
        "--project", project,
        "--current-task", "fix auth token refresh"
      ]);
      const parsedTaskBoot = JSON.parse(taskBoot.stdout) as { task_relevant: Array<{ content: { text: string } }> };
      expect(parsedTaskBoot.task_relevant.map((record) => record.content.text)).toContain("Auth token refresh uses rotating credentials");
      expect(parsedTaskBoot.task_relevant.map((record) => record.content.text)).not.toContain("Review this warning");

      const hiddenRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "Old linked memory", "--project", project]);
      expect(hiddenRecall.stdout).not.toContain("Old linked memory");

      const archivedRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "--record-id", oldId, "--state", "archived", "--project", project]);
      expect(archivedRecall.stdout).toContain("\"state\": \"archived\"");

      const quarantinedRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "--record-id", secretId, "--state", "quarantined", "--project", project]);
      expect(quarantinedRecall.stdout).toContain("\"state\": \"quarantined\"");

      const linkedRecall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "recall", "--record-id", decisionId, "--project", project]);
      expect(linkedRecall.stdout).toContain("\"link_type\": \"supersedes\"");
    });
  }, 30000);

  it("syncs local store events through a git remote", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      await exec("git", ["init", "--bare", remote]);

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "init"]);
      const initA = JSON.parse((await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "init", remote])).stdout) as { selection_sources: Record<string, string> };
      const initB = JSON.parse((await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "init", remote])).stdout) as { selection_sources: Record<string, string> };
      expect(initA.selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);
      expect(initB.selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--state", "canonical", "--text", "CLI sync uses Git"]);

      const push = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "--push", "--message", "custom cli sync"]);
      expect(push.stdout).toContain("\"pushed\": true");
      expect((JSON.parse(push.stdout) as { selection_sources: Record<string, string> }).selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);
      const commitMessage = await exec("git", ["log", "-1", "--pretty=%s"], { cwd: storeA });
      expect(commitMessage.stdout.trim()).toBe("custom cli sync");

      const pull = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--pull"]);
      expect(pull.stdout).toContain("\"pulled\": true");
      expect((JSON.parse(pull.stdout) as { selection_sources: Record<string, string> }).selection_sources).toEqual(SYNC_RESULT_SELECTION_SOURCES);

      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "recall", "Git", "--project-id", "moryn"]);
      expect(recall.stdout).toContain("CLI sync uses Git");

      const status = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--status"]);
      expect(status.stdout).toContain("\"configured\": true");
      expect(status.stdout).toContain("\"dirty\": false");
    });
  }, 30000);

  it("runs the documented MVP success flow through the CLI", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const project = join(dir, "project");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      await mkdir(project, { recursive: true });
      await exec("git", ["init", "--bare", remote]);

      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "init", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "init", remote]);

      const initialBoot = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "boot",
        "--project", project,
        "--current-task", "fix auth token refresh"
      ])).stdout) as { project: { important_decisions: Array<{ id: string }> }; sync: { cursor: string } };
      expect(initialBoot.project.important_decisions).toEqual([]);

      const summary = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "write",
        "--kind", "session_summary",
        "--project", project,
        "--text", "Agent A finished auth token refresh investigation."
      ])).stdout) as { record: { id: string; state: string } };
      const candidate = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project", project,
        "--state", "candidate",
        "--text", "Use rotating credentials for auth token refresh."
      ])).stdout) as { record: { id: string; state: string } };
      expect(summary.record.state).toBe("candidate");
      expect(candidate.record.state).toBe("candidate");

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "promote",
        candidate.record.id,
        "--state", "canonical",
        "--reason", "User confirmed the project decision"
      ]);
      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "write",
        "--kind", "memory",
        "--type", "blocker",
        "--scope", "project",
        "--project", project,
        "--state", "canonical",
        "--priority", "high",
        "--text", "Auth token refresh is blocked by stale credentials."
      ]);
      const push = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeA,
        "sync",
        "--push",
        "--message", "mvp success flow"
      ])).stdout) as { pushed?: boolean };
      expect(push.pushed).toBe(true);

      const pull = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeB,
        "sync",
        "--pull"
      ])).stdout) as { pulled?: boolean };
      expect(pull.pulled).toBe(true);

      const bootB = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeB,
        "boot",
        "--project", project
      ])).stdout) as { project: { important_decisions: Array<{ id: string; content: { text: string } }> } };
      expect(bootB.project.important_decisions).toContainEqual(expect.objectContaining({
        id: candidate.record.id,
        content: expect.objectContaining({ text: "Use rotating credentials for auth token refresh." })
      }));

      const refreshB = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", storeB,
        "refresh",
        "--project", project,
        "--cursor", initialBoot.sync.cursor,
        "--current-task", "fix auth token refresh"
      ])).stdout) as { should_interrupt: boolean; changes: Array<{ importance: string; reason?: string; summary: string }> };
      expect(refreshB.should_interrupt).toBe(true);
      expect(refreshB.changes).toContainEqual(expect.objectContaining({
        importance: "notice",
        summary: "Agent A finished auth token refresh investigation."
      }));
      expect(refreshB.changes).toContainEqual(expect.objectContaining({
        importance: "interrupt",
        reason: "current_task_match",
        summary: "Auth token refresh is blocked by stale credentials."
      }));
    });
  }, 30000);

  it("rejects conflicting CLI sync operation flags", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, rejectedArguments } of [
        {
          args: ["sync", "--push", "--pull"],
          rejectedArguments: [
            { option: "--push", value: true },
            { option: "--pull", value: true }
          ]
        },
        {
          args: ["sync", "--status", "--push"],
          rejectedArguments: [
            { option: "--status", value: true },
            { option: "--push", value: true }
          ]
        }
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error("Expected moryn sync to reject conflicting operation flags");
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recommended_action: string;
              recovery_hint: {
                rejected_arguments: Array<{ option: string; value: boolean }>;
                expected: { kind: string; options: string[] };
                retry_with: Array<{ option: string }>;
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("choose only one sync operation");
          expect(parsed.error.recommended_action).toBe("retry with exactly one sync operation");
          expect(parsed.error.recovery_hint).toEqual({
            rejected_arguments: rejectedArguments,
            expected: { kind: "choose_one", options: ["--status", "--push", "--pull"] },
            retry_with: [
              { option: "--status" },
              { option: "--push" },
              { option: "--pull" }
            ]
          });
        }
      }
    });
  });

  it("rejects CLI sync messages without push", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const args of [
        ["sync", "--message", "ignored message"],
        ["sync", "--pull", "--message", "ignored message"]
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject message without push`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; option: string; requires: string };
                retry_with: { required_option: string; option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("--message requires --push");
          expect(parsed.error.recommended_action).toBe("retry with --push when using --message");
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option: "--message", value: "ignored message" },
            expected: { kind: "requires_option", option: "--message", requires: "--push" },
            retry_with: { required_option: "--push", option: "--message", value_placeholder: "<message>" }
          });
        }
      }
    });
  });

  it("returns safe sync status recovery actions for sync conflicts", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      const conflictFile = join("events", "shared-device", "2026-05", "evt_conflict.json");
      await exec("git", ["init", "--bare", remote]);

      for (const store of [storeA, storeB]) {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "sync", "init", remote]);
      }

      await mkdir(join(storeA, "events", "shared-device", "2026-05"), { recursive: true });
      await mkdir(join(storeB, "events", "shared-device", "2026-05"), { recursive: true });
      await writeFile(join(storeA, conflictFile), "{\"from\":\"a\"}\n", "utf8");
      await writeFile(join(storeB, conflictFile), "{\"from\":\"b\"}\n", "utf8");
      await exec("git", ["add", conflictFile], { cwd: storeA });
      await exec("git", ["commit", "-m", "device a conflicting event"], { cwd: storeA });
      await exec("git", ["push", "-u", "origin", "main"], { cwd: storeA });
      await exec("git", ["add", conflictFile], { cwd: storeB });
      await exec("git", ["commit", "-m", "device b conflicting event"], { cwd: storeB });

      try {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--pull"]);
        throw new Error("Expected sync pull to fail with a conflict");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recoverable: boolean;
            recommended_action: string;
              next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              required_fields: string[];
              required_fields_by_name?: Record<string, {
                name: string;
                argument_path: string;
                placeholder?: string;
                value?: unknown;
              }>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("SYNC_CONFLICT");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("inspect Git sync state before retrying");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "inspect_sync_conflict_before_retrying",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
          safe_to_run: true
        });
      }

      const status = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "--status"]);
      const parsedStatus = JSON.parse(status.stdout) as {
        sync_state?: string;
        selection_sources?: Record<string, string>;
          conflict?: {
            operation?: string;
            files?: string[];
            files_by_path?: Record<string, {
              path: string;
              status: string;
              safe_to_auto_resolve: boolean;
              recommended_action: string;
            }>;
            safe_to_auto_resolve?: boolean;
            safe_to_retry_sync?: boolean;
            recommended_action?: string;
          };
      };
      expect(parsedStatus.sync_state).toBe("conflict");
      expect(parsedStatus.selection_sources).toEqual(SYNC_STATUS_SELECTION_SOURCES);
      expect(parsedStatus.conflict).toEqual({
        operation: "rebase",
        files: [conflictFile],
        files_by_path: {
          [conflictFile]: {
            path: conflictFile,
            status: "unmerged",
            safe_to_auto_resolve: false,
            recommended_action: "resolve Git conflicts before retrying sync"
          }
        },
        safe_to_auto_resolve: false,
        safe_to_retry_sync: false,
        recommended_action: "resolve Git conflicts before retrying sync"
      });
    });
  });

  it("rebuilds derived snapshots and indexes from the CLI", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn", "--state", "canonical", "--text", "CLI rebuild creates indexes"]);

      const rebuild = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "rebuild"]);
      const parsedRebuild = JSON.parse(rebuild.stdout) as {
        artifacts: {
          snapshots: { projects_by_id: Record<string, string>; user: string; skills: string };
          indexes: { recall: string; sync_cursors: string };
        };
        selection_sources: Record<string, string>;
      };
      expect(rebuild.stdout).toContain("\"records\": 1");
      expect(parsedRebuild.selection_sources).toEqual(REBUILD_SELECTION_SOURCES);
      expect(parsedRebuild.artifacts.snapshots.projects_by_id.moryn).toBe("snapshots/projects/moryn.json");
      expect(parsedRebuild.artifacts.indexes.recall).toBe("indexes/recall.json");

      const recallIndex = JSON.parse(await readFile(join(dir, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
      expect(recallIndex.records[0]?.text).toBe("CLI rebuild creates indexes");
    });
  });

  it("lists known projects from the CLI", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "alpha",
        "--tag", "typescript",
        "--state", "canonical",
        "--text", "Alpha uses TypeScript."
      ]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "session_summary",
        "--project-id", "beta",
        "--text", "Beta handoff is ready."
      ]);

      const listed = await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "project", "list"]);
      const parsed = JSON.parse(listed.stdout) as {
        projects: Array<{
          project_id: string;
          records: number;
          latest_activity: { text: string };
          next: {
            recommended_action: string;
            tool: string;
            safe_to_run: boolean;
            command: string;
            required_when: string;
            required_fields: string[];
            arguments: { project_id: string };
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
            safety?: {
              safe_to_auto_run?: boolean;
              requires_user_confirmation?: boolean;
              requires_authored_input?: boolean;
              writes_local_config?: boolean;
              reasons?: string[];
            };
            workflow?: Record<string, unknown>;
          };
        }>;
        projects_by_id: Record<string, {
          project_id: string;
          latest_activity: { text: string };
          next: {
            workflow?: Record<string, unknown>;
            arguments: { project_id: string };
          };
        }>;
        selection_sources: Record<string, string>;
      };

      expect(parsed.projects.map((project) => project.project_id)).toEqual(["beta", "alpha"]);
      expect(parsed.selection_sources).toEqual({
        project: "projects_by_id.<project_id>",
        project_id: "projects_by_id.<project_id>.project_id",
        next_action: "projects_by_id.<project_id>.next"
      });
      expect(parsed.projects_by_id.beta).toEqual(parsed.projects[0]);
      expect(parsed.projects_by_id.alpha).toEqual(parsed.projects[1]);
      expect(parsed.projects[0]).toMatchObject({
        project_id: "beta",
        records: 1,
        latest_activity: { text: "Beta handoff is ready." },
        next: {
          recommended_action: "call_agent_start",
          tool: "agent_start",
          safe_to_run: true,
          required_when: "After choosing this project from project_list results.",
          required_fields: [],
          arguments: { project_id: "beta" },
          selection_sources: {
            project: "project_list.projects_by_id.<project_id>",
            project_id: "project_list.projects_by_id.<project_id>.project_id",
            next_action: "project_list.projects_by_id.<project_id>.next",
            ordered_next_action: "project_list.projects[].next",
            cli_executable: "project_list.projects_by_id.<project_id>.next.interfaces.cli.executable",
            cli_argv: "project_list.projects_by_id.<project_id>.next.interfaces.cli.argv[]",
            cli_args: "project_list.projects_by_id.<project_id>.next.interfaces.cli.args[]",
            cli_exec_file: "project_list.projects_by_id.<project_id>.next.interfaces.cli.exec_file",
            cli_placeholder: "project_list.projects_by_id.<project_id>.next.interfaces.cli.placeholders[]",
            cli_command_line: "project_list.projects_by_id.<project_id>.next.interfaces.cli.command_line",
            ordered_cli_executable: "project_list.projects[].next.interfaces.cli.executable",
            ordered_cli_argv: "project_list.projects[].next.interfaces.cli.argv[]",
            ordered_cli_args: "project_list.projects[].next.interfaces.cli.args[]",
            ordered_cli_exec_file: "project_list.projects[].next.interfaces.cli.exec_file",
            ordered_cli_placeholder: "project_list.projects[].next.interfaces.cli.placeholders[]",
            ordered_cli_command_line: "project_list.projects[].next.interfaces.cli.command_line",
            argument: "project_list.projects_by_id.<project_id>.next.arguments_by_name.<argument>",
            ordered_argument: "project_list.projects[].next.arguments_by_name.<argument>",
            required_field: "project_list.projects_by_id.<project_id>.next.required_fields_by_name.<field>",
            ordered_required_field: "project_list.projects[].next.required_fields_by_name.<field>",
            required_input: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_field.<field>",
            ordered_required_input: "project_list.projects[].next.execution.required_inputs_by_field.<field>",
            required_input_argument_path: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_argument_path.<argument_path>",
            ordered_required_input_argument_path: "project_list.projects[].next.execution.required_inputs_by_argument_path.<argument_path>",
            argument_source: "project_list.projects_by_id.<project_id>.next.argument_sources.<field>",
            ordered_argument_source: "project_list.projects[].next.argument_sources.<field>"
          }
        }
      });
      expectActionInterfaces(parsed.projects[0]!.next);
      expectActionSafety(parsed.projects[0]!.next);
      expectProjectListNextWorkflow(parsed.projects[0]!.next);
      expect(parsed.projects_by_id.beta.next.workflow).toEqual(parsed.projects[0]!.next.workflow);
    });
  });

  it("runs agent lifecycle start and finish from the CLI", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn", "--tag", "typescript"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeA, "sync", "init", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", storeB, "sync", "init", remote]);

      const finish = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeA,
        "agent", "finish",
        "--project", project,
        "--agent", "codex",
        "--session-id", "codex-cli",
        "--summary", "CLI Codex finished the lifecycle protocol."
      ]);
      const parsedFinish = JSON.parse(finish.stdout) as {
        record: { content: { text: string } };
        sync: { push?: { pushed?: boolean } };
        next: {
          workflow: {
            start: string;
            continue_from: string[];
            phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
          };
          actions: Array<{
            action: string;
            tool: string;
            command: string;
            required_when: string;
            required_fields: string[];
            required_fields_by_name?: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            arguments: Record<string, unknown>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
          }>;
          actions_by_id: Record<string, {
            action: string;
            tool: string;
            command: string;
            required_when: string;
            required_fields: string[];
            required_fields_by_name?: Record<string, {
              name: string;
              argument_path: string;
              placeholder?: string;
              value?: unknown;
            }>;
            arguments: Record<string, unknown>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
          }>;
          selection_sources: Record<string, string>;
        };
      };
      expect(parsedFinish.record.content.text).toBe("CLI Codex finished the lifecycle protocol.");
      expect(parsedFinish.sync.push?.pushed).toBe(true);
      expect(parsedFinish.next.recommended_start_action_id).toBe("start_next_session");
      expect(parsedFinish.next.recommended_start_action_source).toBe("next.actions_by_id.start_next_session");
      expect(parsedFinish.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_cli_executable: "next.actions_by_id.<action>.interfaces.cli.executable",
        action_cli_argv: "next.actions_by_id.<action>.interfaces.cli.argv[]",
        action_cli_args: "next.actions_by_id.<action>.interfaces.cli.args[]",
        action_cli_exec_file: "next.actions_by_id.<action>.interfaces.cli.exec_file",
        action_cli_placeholder: "next.actions_by_id.<action>.interfaces.cli.placeholders[]",
        action_cli_command_line: "next.actions_by_id.<action>.interfaces.cli.command_line",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_required_input_argument_path: "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(parsedFinish.next.actions).toContainEqual(expect.objectContaining({
        action: "start_next_session",
        tool: "agent_start",
        command: expect.stringContaining("moryn agent start"),
        required_when: "When another agent or device should start the next session from this handoff.",
        required_fields: ["current_task"],
        argument_sources: {
          current_task: "user_input.current_task"
        },
        arguments: expect.objectContaining({
          project_path: project,
          current_task: "<current_task>",
          agent: expect.objectContaining({ client: "codex", session_id: "codex-cli" })
        })
      }));
      for (const action of parsedFinish.next.actions) {
        expectActionInterfaces(action);
        expectLifecycleActionSelectionSources(action);
      }
      expect(parsedFinish.next.actions_by_id.start_next_session).toEqual(parsedFinish.next.actions.find((action) => action.action === "start_next_session"));
      expectLifecycleActionSelectionSources(parsedFinish.next.actions_by_id.start_next_session);
      expect(parsedFinish.next.actions_by_id.start_next_session.required_fields_by_name?.current_task).toEqual({
        name: "current_task",
        argument_path: "current_task",
        placeholder: "<current_task>",
        value: "<current_task>"
      });
      expect(parsedFinish.next.actions_by_id[parsedFinish.next.recommended_start_action_id]).toEqual(
        parsedFinish.next.actions_by_id.start_next_session
      );
      expect(parsedFinish.next.workflow).toEqual(withPhasesByName({
        version: 1,
        start: "next.actions_by_id",
        continue_from: ["next.actions_by_id", "next.actions"],
        phases: [
          {
            phase: "start_next_session",
            order: 1,
            action_source: "next.actions_by_id.start_next_session",
            tool: "agent_start",
            required_when: "When another agent or device should start the next session from this handoff.",
            required_fields: ["current_task"]
          }
        ]
      }));

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "start",
        "--project", project,
        "--agent", "gemini",
        "--session-id", "gemini-cli",
        "--current-task", "continue lifecycle protocol",
        "--refresh-since", "2000-01-01T00:00:00.000Z"
      ]);
      const parsedStart = JSON.parse(start.stdout) as {
        project: { project_id: string };
        sync: { pull?: { pulled?: boolean } };
        refresh: { cursor: string; changes: Array<{ summary: string; importance: string }> };
        next: {
          workflow: {
            start: string;
            phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
          };
          actions: Array<{
            action: string;
            tool: string;
            command: string;
            required_when: string;
            required_fields: string[];
            arguments: Record<string, unknown>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
          }>;
          actions_by_id: Record<string, {
            action: string;
            tool: string;
            command: string;
            required_when: string;
            required_fields: string[];
            arguments: Record<string, unknown>;
            interfaces?: {
              cli?: { command?: string };
              mcp?: { tool?: string; arguments?: Record<string, unknown> };
            };
          }>;
          selection_sources: Record<string, string>;
        };
      };
      expect(parsedStart.project.project_id).toBe("moryn");
      expect(parsedStart.sync.pull?.pulled).toBe(true);
      expect(parsedStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "CLI Codex finished the lifecycle protocol.",
        importance: "notice"
      }));
      expect(parsedStart.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        tool: "agent_status",
        command: expect.stringContaining("moryn agent status"),
        required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
        required_fields: ["status"],
        argument_sources: {
          status: "user_input.status"
        },
        arguments: expect.objectContaining({
          project_path: project,
          status: "<status>",
          current_task: "continue lifecycle protocol"
        })
      }));
      expect(parsedStart.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        tool: "agent_start",
        command: expect.stringContaining("--refresh-since"),
        required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
        required_fields: [],
        argument_sources: {
          refresh_since: "refresh.cursor"
        },
        arguments: expect.objectContaining({
          project_path: project,
          refresh_since: parsedStart.refresh.cursor,
          current_task: "continue lifecycle protocol"
        })
      }));
      for (const action of parsedStart.next.actions) {
        expectActionInterfaces(action);
        expectLifecycleActionSelectionSources(action);
      }
      expect(parsedStart.next.required_end_action_id).toBe("finish_session");
      expect(parsedStart.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
      expect(parsedStart.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(parsedStart.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(parsedStart.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_cli_executable: "next.actions_by_id.<action>.interfaces.cli.executable",
        action_cli_argv: "next.actions_by_id.<action>.interfaces.cli.argv[]",
        action_cli_args: "next.actions_by_id.<action>.interfaces.cli.args[]",
        action_cli_exec_file: "next.actions_by_id.<action>.interfaces.cli.exec_file",
        action_cli_placeholder: "next.actions_by_id.<action>.interfaces.cli.placeholders[]",
        action_cli_command_line: "next.actions_by_id.<action>.interfaces.cli.command_line",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_required_input_argument_path: "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(parsedStart.next.actions_by_id.publish_status).toEqual(parsedStart.next.actions.find((action) => action.action === "publish_status"));
      expect(parsedStart.next.actions_by_id.finish_session).toEqual(parsedStart.next.actions.find((action) => action.action === "finish_session"));
      expect(parsedStart.next.actions_by_id.refresh_context).toEqual(parsedStart.next.actions.find((action) => action.action === "refresh_context"));
      expectLifecycleActionSelectionSources(parsedStart.next.actions_by_id.publish_status);
      expectLifecycleActionSelectionSources(parsedStart.next.actions_by_id.finish_session);
      expectLifecycleActionSelectionSources(parsedStart.next.actions_by_id.refresh_context);
      expect(parsedStart.next.actions_by_id[parsedStart.next.required_end_action_id]).toEqual(parsedStart.next.actions_by_id.finish_session);
      expect(parsedStart.next.actions_by_id[parsedStart.next.recommended_refresh_action_id]).toEqual(parsedStart.next.actions_by_id.refresh_context);
      expect(parsedStart.next.workflow).toEqual(withPhasesByName({
        version: 1,
        start: "context",
        continue_from: ["boot", "refresh", "handoff", "next.actions_by_id", "next.actions"],
        phases: [
          {
            phase: "review_context",
            order: 1,
            action_source: "boot+refresh+handoff",
            required_when: "Immediately after agent_start returns, review boot, refresh, and handoff context before taking user-task actions.",
            required_fields: []
          },
          {
            phase: "publish_status",
            order: 2,
            action_source: "next.actions_by_id.publish_status",
            tool: "agent_status",
            required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
            required_fields: ["status"]
          },
          {
            phase: "finish_session",
            order: 3,
            action_source: "next.actions_by_id.finish_session",
            tool: "agent_finish",
            required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
            required_fields: ["summary"]
          },
          {
            phase: "refresh_context",
            order: 4,
            action_source: "next.actions_by_id.refresh_context",
            tool: "agent_start",
            required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
            required_fields: []
          }
        ]
      }));
    });
  }, 30000);

  it("bootstraps store and sync from agent lifecycle CLI commands", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "fresh-store-a");
      const storeB = join(dir, "fresh-store-b");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const finish = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeA,
        "agent", "finish",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--summary", "CLI fresh store wrote the first handoff."
      ]);
      const parsedFinish = JSON.parse(finish.stdout) as { bootstrap: { initialized_store: boolean; sync_init?: { ok?: boolean } }; sync: { push?: { pushed?: boolean } } };
      expect(parsedFinish.bootstrap.initialized_store).toBe(true);
      expect(parsedFinish.bootstrap.sync_init?.ok).toBe(true);
      expect(parsedFinish.sync.push?.pushed).toBe(true);

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "start",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "gemini",
        "--current-task", "read fresh handoff",
        "--refresh-since", "2000-01-01T00:00:00.000Z"
      ]);
      const parsedStart = JSON.parse(start.stdout) as {
        bootstrap: { initialized_store: boolean; sync_init?: { ok?: boolean } };
        sync: { pull?: { pulled?: boolean } };
        refresh: { changes: Array<{ summary: string }> };
      };
      expect(parsedStart.bootstrap.initialized_store).toBe(true);
      expect(parsedStart.bootstrap.sync_init?.ok).toBe(true);
      expect(parsedStart.sync.pull?.pulled).toBe(true);
      expect(parsedStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "CLI fresh store wrote the first handoff."
      }));
    });
  }, 30000);

  it("returns portable lifecycle action commands from CLI when project config resolves from cwd", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", tsxLoader, cliPath, "project", "init", "--path", project, "--project-id", "moryn"]);

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "start",
        "--agent", "codex",
        "--session-id", "codex-cli-portable",
        "--current-task", "continue from portable actions"
      ], { cwd: project });
      const parsedStart = JSON.parse(start.stdout) as {
        next: { actions: Array<{ action: string; command: string; arguments: Record<string, unknown> }> };
      };
      expect(parsedStart.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        safe_to_run: false,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn", status: "<status>" })
      }));
      expect(parsedStart.next.actions).toContainEqual(expect.objectContaining({
        action: "finish_session",
        safe_to_run: false,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn", summary: "<summary>" })
      }));
      expect(parsedStart.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        safe_to_run: true,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn" })
      }));
    });
  });

  it("shares in-progress agent status from the CLI", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "fresh-store-a");
      const storeB = join(dir, "fresh-store-b");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const status = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeA,
        "agent", "status",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--session-id", "codex-cli-status",
        "--current-task", "coordinate status",
        "--status", "CLI Codex is currently wiring status propagation."
      ]);
      const parsedStatus = JSON.parse(status.stdout) as {
        record: { kind: string; type: string; updated_at: string; content: { text: string; current_task?: string } };
        sync: { push?: { pushed?: boolean } };
        next: {
          workflow: {
            start: string;
            phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
          };
          actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
          actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
          selection_sources: Record<string, string>;
        };
      };
      expect(parsedStatus.record).toMatchObject({
        kind: "session_summary",
        type: "status",
        content: {
          text: "CLI Codex is currently wiring status propagation.",
          current_task: "coordinate status"
        }
      });
      expect(parsedStatus.sync.push?.pushed).toBe(true);
      expect(parsedStatus.next.actions).toContainEqual(expect.objectContaining({
        action: "finish_session",
        tool: "agent_finish",
        safe_to_run: false,
        command: expect.stringContaining("moryn agent finish"),
        required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
        required_fields: ["summary"],
        argument_sources: {
          summary: "user_input.summary"
        },
        arguments: expect.objectContaining({
          project_path: project,
          sync_remote: remote,
          summary: "<summary>",
          current_task: "coordinate status"
        })
      }));
      expect(parsedStatus.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        tool: "agent_start",
        safe_to_run: true,
        command: expect.stringContaining("--refresh-since"),
        required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
        required_fields: [],
        argument_sources: {
          refresh_since: "record.updated_at"
        },
        arguments: expect.objectContaining({
          project_path: project,
          sync_remote: remote,
          refresh_since: parsedStatus.record.updated_at,
          current_task: "coordinate status"
        })
      }));
      expect(parsedStatus.next.actions_by_id.finish_session).toEqual(parsedStatus.next.actions.find((action) => action.action === "finish_session"));
      expect(parsedStatus.next.actions_by_id.refresh_context).toEqual(parsedStatus.next.actions.find((action) => action.action === "refresh_context"));
      expect(parsedStatus.next.recommended_finish_action_id).toBe("finish_session");
      expect(parsedStatus.next.recommended_finish_action_source).toBe("next.actions_by_id.finish_session");
      expect(parsedStatus.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(parsedStatus.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(parsedStatus.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_cli_executable: "next.actions_by_id.<action>.interfaces.cli.executable",
        action_cli_argv: "next.actions_by_id.<action>.interfaces.cli.argv[]",
        action_cli_args: "next.actions_by_id.<action>.interfaces.cli.args[]",
        action_cli_exec_file: "next.actions_by_id.<action>.interfaces.cli.exec_file",
        action_cli_placeholder: "next.actions_by_id.<action>.interfaces.cli.placeholders[]",
        action_cli_command_line: "next.actions_by_id.<action>.interfaces.cli.command_line",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_required_input_argument_path: "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(parsedStatus.next.actions_by_id[parsedStatus.next.recommended_finish_action_id]).toEqual(parsedStatus.next.actions_by_id.finish_session);
      expect(parsedStatus.next.actions_by_id[parsedStatus.next.recommended_refresh_action_id]).toEqual(parsedStatus.next.actions_by_id.refresh_context);
      expect(parsedStatus.next.workflow).toEqual(withPhasesByName({
        version: 1,
        start: "next.actions_by_id",
        continue_from: ["record", "next.actions_by_id", "next.actions"],
        phases: [
          {
            phase: "finish_session",
            order: 1,
            action_source: "next.actions_by_id.finish_session",
            tool: "agent_finish",
            required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
            required_fields: ["summary"]
          },
          {
            phase: "refresh_context",
            order: 2,
            action_source: "next.actions_by_id.refresh_context",
            tool: "agent_start",
            required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
            required_fields: []
          }
        ]
      }));

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "start",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "gemini",
        "--current-task", "coordinate status",
        "--refresh-since", "2000-01-01T00:00:00.000Z"
      ]);
      const parsedStart = JSON.parse(start.stdout) as {
        refresh: { changes: Array<{ summary: string; importance: string }> };
        handoff: {
          next_action: {
            recommended_action: string;
            tool: string;
            command: string;
            arguments: Record<string, unknown>;
            safe_to_run: boolean;
            required_when: string;
            required_fields: string[];
          };
          active_sessions: Array<{
            record_id: string;
            text: string;
            current_task?: string;
            agent: { client?: string; session_id?: string };
            recommended_action: string;
            next_action: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
              required_when: string;
              required_fields: string[];
            };
          }>;
          active_sessions_by_record_id: Record<string, {
            record_id: string;
            next_action: {
              workflow?: Record<string, unknown>;
            };
          }>;
          selection_sources: Record<string, string>;
          inbox: Array<{ text: string }>;
          inbox_by_record_id: Record<string, { record_id: string }>;
        };
      };
      expect(parsedStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "CLI Codex is currently wiring status propagation.",
        importance: "notice"
      }));
      expect(parsedStart.handoff.active_sessions).toEqual([
        expect.objectContaining({
          text: "CLI Codex is currently wiring status propagation.",
          current_task: "coordinate status",
          agent: expect.objectContaining({ client: "codex", session_id: "codex-cli-status" }),
          recommended_action: "coordinate_with_active_session",
          next_action: expect.any(Object)
        })
      ]);
      expect(parsedStart.handoff.active_sessions_by_record_id[parsedStart.handoff.active_sessions[0]!.record_id]).toEqual(parsedStart.handoff.active_sessions[0]);
      expect(parsedStart.handoff.selection_sources).toEqual({
        inbox_entry: "handoff.inbox_by_record_id.<record_id>",
        inbox_record_id: "handoff.inbox_by_record_id.<record_id>.record_id",
        inbox_next_action: "handoff.inbox_by_record_id.<record_id>.next_action",
        inbox_next_action_cli_executable: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.executable",
        inbox_next_action_cli_argv: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
        inbox_next_action_cli_args: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
        inbox_next_action_cli_exec_file: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
        inbox_next_action_cli_placeholder: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
        inbox_next_action_cli_command_line: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
        inbox_next_action_argument: "handoff.inbox_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        inbox_next_action_required_field: "handoff.inbox_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        inbox_next_action_required_input: "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        inbox_next_action_required_input_argument_path: "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
        inbox_next_action_argument_source: "handoff.inbox_by_record_id.<record_id>.next_action.argument_sources.<field>",
        active_session_entry: "handoff.active_sessions_by_record_id.<record_id>",
        active_session_record_id: "handoff.active_sessions_by_record_id.<record_id>.record_id",
        active_session_next_action: "handoff.active_sessions_by_record_id.<record_id>.next_action",
        active_session_next_action_cli_executable: "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.executable",
        active_session_next_action_cli_argv: "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
        active_session_next_action_cli_args: "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
        active_session_next_action_cli_exec_file: "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
        active_session_next_action_cli_placeholder: "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
        active_session_next_action_cli_command_line: "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
        active_session_next_action_argument: "handoff.active_sessions_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        active_session_next_action_required_field: "handoff.active_sessions_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        active_session_next_action_required_input: "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        active_session_next_action_required_input_argument_path: "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
        active_session_next_action_argument_source: "handoff.active_sessions_by_record_id.<record_id>.next_action.argument_sources.<field>"
      });
      expectHandoffEntryNextAction(parsedStart.handoff.active_sessions[0]!.next_action, parsedStart.handoff.active_sessions[0]!.record_id, "moryn", "active_sessions");
      expect(parsedStart.handoff.active_sessions_by_record_id[parsedStart.handoff.active_sessions[0]!.record_id]!.next_action.workflow).toEqual(parsedStart.handoff.active_sessions[0]!.next_action.workflow);
      expect(parsedStart.handoff.next_action).toEqual(parsedStart.handoff.active_sessions[0]!.next_action);
      expectHandoffEntryNextAction(parsedStart.handoff.next_action, parsedStart.handoff.active_sessions[0]!.record_id, "moryn", "active_sessions");
      expect(parsedStart.handoff.inbox).toEqual([]);
      expect(parsedStart.handoff.inbox_by_record_id).toEqual({});
    });
  }, 30000);

  it("returns read-only agent doctor guidance for a fresh CLI device", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const store = join(dir, "fresh-store");
      const project = join(dir, "project");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "doctor",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--session-id", "codex-doctor",
        "--current-task", "start safely"
      ]);
      const parsed = JSON.parse(doctor.stdout) as {
        store: { initialized: boolean };
        project: { ok: boolean; project_id?: string };
        sync: { configured: boolean; expected_remote?: string };
        checks: Array<{ name: string; ok: boolean; severity: string; message: string }>;
        checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
        selection_sources: Record<string, string>;
        readiness?: {
          safe_to_start: boolean;
          blocking_checks: string[];
          blocking_checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
          recommended_action: string;
          next_tool: string;
          next_command: string;
          next_safe_to_run: boolean;
          next_required_when: string;
          next_required_fields: string[];
          next_required_fields_by_name: Record<string, {
            name: string;
            argument_path: string;
            placeholder?: string;
            value?: unknown;
          }>;
          next_argument_sources: Record<string, string>;
          next_selection_sources: Record<string, string>;
          next_safety: {
            safe_to_auto_run: boolean;
            requires_user_confirmation: boolean;
            requires_authored_input: boolean;
            writes_local_config: boolean;
            reasons: string[];
          };
          next_interfaces: {
            cli: { command: string };
            mcp: { tool: string; arguments: Record<string, unknown> };
          };
          next_workflow: Record<string, unknown>;
          next_arguments: Record<string, unknown>;
        };
        next: {
          command: string;
          tool: string;
          interfaces: {
            cli: { command: string };
            mcp: { tool: string; arguments: Record<string, unknown> };
          };
          workflow: Record<string, unknown>;
          required_fields_by_name: Record<string, {
            name: string;
            argument_path: string;
            placeholder?: string;
            value?: unknown;
          }>;
          arguments: { project_path?: string; sync_remote?: string; agent?: { client?: string } };
          actions: Array<{ action: string; tool: string; command: string; required_fields: string[]; arguments: Record<string, unknown> }>;
          actions_by_id: Record<string, { action: string; tool: string; command: string; required_fields: string[]; arguments: Record<string, unknown> }>;
          selection_sources: Record<string, string>;
        };
      };
      expect(parsed.store.initialized).toBe(false);
      expect(parsed.project).toMatchObject({ ok: true, project_id: "moryn" });
      expect(parsed.sync).toMatchObject({ configured: false, expected_remote: remote });
      expect(parsed.next.tool).toBe("agent_start");
      expect(parsed.readiness).toEqual({
        safe_to_start: true,
        blocking_checks: [],
        blocking_checks_by_name: {},
        recommended_action: "call_agent_start",
        next_action_source: "next",
        next_tool: "agent_start",
        next_command: parsed.next.command,
        next_safe_to_run: true,
        next_required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
        next_required_fields: [],
        next_required_fields_by_name: {},
        next_argument_sources: {},
        next_selection_sources: parsed.next.selection_sources,
        next_safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          requires_authored_input: false,
          writes_local_config: false,
          reasons: ["safe_read_or_status_check"]
        },
        next_interfaces: parsed.next.interfaces,
        next_workflow: parsed.next.workflow,
        next_arguments: {
          project_path: project,
          sync_remote: remote,
          current_task: "start safely",
          agent: { client: "codex", session_id: "codex-doctor" }
        }
      });
      expect(parsed.readiness?.next_required_when).toEqual(parsed.next.required_when);
      expect(parsed.readiness?.next_required_fields_by_name).toEqual(parsed.next.required_fields_by_name);
      expect(parsed.readiness?.next_selection_sources).toEqual(parsed.next.selection_sources);
      expect(parsed.selection_sources).toEqual({
        check: "checks_by_name.<check_name>",
        blocking_check: "readiness.blocking_checks_by_name.<check_name>",
        next_action: "next",
        next_cli_executable: "next.interfaces.cli.executable",
        next_cli_argv: "next.interfaces.cli.argv[]",
        next_cli_args: "next.interfaces.cli.args[]",
        next_cli_exec_file: "next.interfaces.cli.exec_file",
        next_cli_placeholder: "next.interfaces.cli.placeholders[]",
        next_cli_command_line: "next.interfaces.cli.command_line",
        next_argument: "next.arguments_by_name.<argument>",
        next_required_field: "next.required_fields_by_name.<field>",
        next_required_input: "next.execution.required_inputs_by_field.<field>",
        next_required_input_argument_path: "next.execution.required_inputs_by_argument_path.<argument_path>",
        next_argument_source: "next.argument_sources.<field>"
      });
      expect(parsed.checks_by_name.store).toEqual(parsed.checks.find((check) => check.name === "store"));
      expect(parsed.checks_by_name.project).toEqual(parsed.checks.find((check) => check.name === "project"));
      expect(parsed.checks_by_name.sync).toEqual(parsed.checks.find((check) => check.name === "sync"));
      expect(parsed.next.command).toContain("moryn agent start");
      expect((parsed.next as { action_source?: string }).action_source).toBe("next");
      expect(parsed.next.command).toContain("--sync-remote");
      expect(parsed.next.actions).toContainEqual(expect.objectContaining({
        action: "run_lifecycle_smoke",
        tool: "moryn-agent-smoke",
        safe_to_run: true,
        command: expect.stringContaining("moryn-agent-smoke"),
        interfaces: expect.objectContaining({
          cli: expect.objectContaining({
            argv: ["moryn-agent-smoke", "--remote", remote],
            executable: "moryn-agent-smoke",
            args: ["--remote", remote]
          })
        }),
        required_fields: [],
        arguments: expect.objectContaining({ remote })
      }));
      expect(parsed.next.actions_by_id.start_session).toEqual(parsed.next.actions.find((action) => action.action === "start_session"));
      expect(parsed.next.actions_by_id.run_lifecycle_smoke).toEqual(parsed.next.actions.find((action) => action.action === "run_lifecycle_smoke"));
      expectLifecycleActionSelectionSources(parsed.next.actions_by_id.start_session);
      expectLifecycleActionSelectionSources(parsed.next.actions_by_id.run_lifecycle_smoke);
      expect(parsed.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_cli_executable: "next.actions_by_id.<action>.interfaces.cli.executable",
        action_cli_argv: "next.actions_by_id.<action>.interfaces.cli.argv[]",
        action_cli_args: "next.actions_by_id.<action>.interfaces.cli.args[]",
        action_cli_exec_file: "next.actions_by_id.<action>.interfaces.cli.exec_file",
        action_cli_placeholder: "next.actions_by_id.<action>.interfaces.cli.placeholders[]",
        action_cli_command_line: "next.actions_by_id.<action>.interfaces.cli.command_line",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_required_input_argument_path: "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(parsed.next.arguments).toMatchObject({
        project_path: project,
        sync_remote: remote,
        agent: { client: "codex" }
      });
      await expect(readFile(join(store, "config.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("returns sync conflict guidance from CLI doctor and enter before lifecycle writes", async () => {
    await withTempDir(async (dir) => {
      const remote = join(dir, "remote.git");
      const storeA = join(dir, "store-a");
      const storeB = join(dir, "store-b");
      const project = join(dir, "project");
      const conflictFile = join("events", "shared-device", "2026-05", "evt_conflict.json");
      await exec("git", ["init", "--bare", remote]);
      await exec("node", ["--import", tsxLoader, cliPath, "project", "init", "--path", project, "--project-id", "moryn"]);
      await createCliSyncConflict({ remote, storeA, storeB, conflictFile });

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "doctor",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--current-task", "avoid sync conflict hallucination"
      ]);
      const parsedDoctor = JSON.parse(doctor.stdout) as {
        sync: {
          sync_state?: string;
          conflict?: {
            files?: string[];
            files_by_path?: Record<string, {
              path: string;
              status: string;
              safe_to_auto_resolve: boolean;
              recommended_action: string;
            }>;
            safe_to_retry_sync?: boolean;
          };
        };
        checks: Array<{ name: string; ok: boolean; severity: string; message: string }>;
        checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
        readiness?: {
          safe_to_start: boolean;
          blocking_checks: string[];
          blocking_checks_by_name: Record<string, { name: string; ok: boolean; severity: string; message: string }>;
          recommended_action: string;
          next_tool: string;
          next_command: string;
          next_required_when: string;
          next_safety: Record<string, unknown>;
          next_interfaces: Record<string, unknown>;
          next_workflow: Record<string, unknown>;
          next_argument_sources: Record<string, string>;
          next_selection_sources: Record<string, string>;
        };
        next: {
          recommended_action: string;
          tool: string;
          safe_to_run: boolean;
          command: string;
          required_when: string;
          required_fields: string[];
          workflow: Record<string, unknown>;
          arguments: Record<string, unknown>;
          interfaces: Record<string, unknown>;
          safety?: {
            safe_to_auto_run?: boolean;
            requires_user_confirmation?: boolean;
            requires_authored_input?: boolean;
            writes_local_config?: boolean;
            reasons?: string[];
          };
        };
      };
      expect(parsedDoctor.sync).toMatchObject({
        sync_state: "conflict",
        conflict: {
          files: [conflictFile],
          files_by_path: {
            [conflictFile]: {
              path: conflictFile,
              status: "unmerged",
              safe_to_auto_resolve: false,
              recommended_action: "resolve Git conflicts before retrying sync"
            }
          },
          safe_to_retry_sync: false
        }
      });
      expect(parsedDoctor.next).toMatchObject({
        recommended_action: "resolve_sync_conflict_before_lifecycle",
        action_source: "next",
        tool: "sync_status",
        safe_to_run: true,
        command: "moryn sync --status",
        required_when: INSPECT_SYNC_CONFLICT_WHEN,
        required_fields: [],
        workflow: singleNextWorkflow({
          recommendedAction: "resolve_sync_conflict_before_lifecycle",
          tool: "sync_status",
          requiredWhen: INSPECT_SYNC_CONFLICT_WHEN
        }),
        interfaces: {
          cli: {
            command: "moryn sync --status"
          },
          mcp: {
            tool: "sync_status",
            arguments: {}
          }
        },
        arguments: {}
      });
      expectActionSafety(parsedDoctor.next);
      expect(parsedDoctor.next.safety).toMatchObject({
        safe_to_auto_run: true,
        requires_user_confirmation: false,
        requires_authored_input: false,
        writes_local_config: false,
        reasons: ["safe_read_or_status_check"]
      });
      expect(parsedDoctor.readiness).toEqual({
        safe_to_start: false,
        blocking_checks: ["sync"],
        blocking_checks_by_name: {
          sync: parsedDoctor.checks_by_name.sync
        },
        recommended_action: "resolve_sync_conflict_before_lifecycle",
        next_action_source: "next",
        next_tool: "sync_status",
        next_command: "moryn sync --status",
        next_safe_to_run: true,
        next_required_when: INSPECT_SYNC_CONFLICT_WHEN,
        next_required_fields: [],
        next_required_fields_by_name: {},
        next_argument_sources: {},
        next_selection_sources: {},
        next_safety: parsedDoctor.next.safety,
        next_interfaces: parsedDoctor.next.interfaces,
        next_workflow: parsedDoctor.next.workflow,
        next_arguments: {}
      });
      expect(parsedDoctor.checks_by_name.sync).toEqual(expect.objectContaining({
        name: "sync",
        ok: false,
        severity: "warning",
        message: "Sync has unresolved Git conflicts; inspect sync_status and resolve conflicts before lifecycle writes."
      }));

      const entered = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", storeB,
        "agent", "enter",
        "--project", project,
        "--sync-remote", remote,
        "--agent", "codex",
        "--current-task", "avoid sync conflict hallucination"
      ]);
      const parsedEnter = JSON.parse(entered.stdout) as {
        mode: string;
        next: {
          recommended_action: string;
          tool: string;
          safe_to_run: boolean;
          required_when: string;
          required_fields: string[];
          workflow: Record<string, unknown>;
        };
      };
      expect(parsedEnter).toMatchObject({
        mode: "needs_setup",
        next: {
          recommended_action: "resolve_sync_conflict_before_lifecycle",
          tool: "sync_status",
          safe_to_run: true,
          required_when: INSPECT_SYNC_CONFLICT_WHEN,
          required_fields: [],
          workflow: singleNextWorkflow({
            recommendedAction: "resolve_sync_conflict_before_lifecycle",
            tool: "sync_status",
            requiredWhen: INSPECT_SYNC_CONFLICT_WHEN
          })
        }
      });

      try {
        await exec("node", [
          "--import", tsxLoader, cliPath, "--store", storeB,
          "agent", "start",
          "--project", project,
          "--sync-remote", remote,
          "--agent", "codex",
          "--current-task", "avoid sync conflict hallucination"
        ]);
        throw new Error("Expected CLI agent_start to reject unresolved sync conflicts");
      } catch (error) {
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          error: {
            code: string;
            message: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.error.code).toBe("SYNC_CONFLICT");
        expect(parsed.error.message).toBe("Sync conflict: resolve Git conflicts before lifecycle writes");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "inspect_sync_conflict_before_retrying",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
          safe_to_run: true
        });
      }

      for (const command of [
        [
          "agent", "status",
          "--project", project,
          "--sync-remote", remote,
          "--agent", "codex",
          "--current-task", "avoid sync conflict hallucination",
          "--status", "Do not write status while sync is conflicted."
        ],
        [
          "agent", "finish",
          "--project", project,
          "--sync-remote", remote,
          "--agent", "codex",
          "--summary", "Do not write finish handoff while sync is conflicted."
        ]
      ]) {
        try {
          await exec("node", ["--import", tsxLoader, cliPath, "--store", storeB, ...command]);
          throw new Error(`Expected CLI ${command.slice(0, 2).join(" ")} to reject unresolved sync conflicts`);
        } catch (error) {
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            error: {
              code: string;
              message: string;
              next_action?: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
              };
            };
          };
          expect(parsed.error.code).toBe("SYNC_CONFLICT");
          expect(parsed.error.message).toBe("Sync conflict: resolve Git conflicts before lifecycle writes");
          expect(parsed.error.next_action).toMatchObject({
            recommended_action: "inspect_sync_conflict_before_retrying",
            tool: "sync_status",
            command: "moryn sync --status",
            arguments: {},
            required_fields: [],
            safe_to_run: true
          });
        }
      }
    });
  }, 30000);

  it("recommends project list from CLI doctor when project input is missing", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "session_summary",
        "--project-id", "moryn",
        "--text", "Moryn project handoff is available."
      ]);

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "doctor",
        "--agent", "codex",
        "--session-id", "codex-project-list",
        "--current-task", "find project"
      ], { cwd: dir });
      const parsed = JSON.parse(doctor.stdout) as {
        project: { ok: boolean };
        next: {
          recommended_action: string;
          tool: string;
          command: string;
          safe_to_run: boolean;
          required_when: string;
          required_fields: string[];
          workflow: Record<string, unknown>;
          actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[] }>;
          actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[] }>;
          selection_sources: Record<string, string>;
        };
      };

      expect(parsed.next).toMatchObject({
        recommended_action: "list_projects",
        action_source: "next",
        tool: "project_list",
        safe_to_run: true,
        command: "moryn project list",
        required_when: LIST_PROJECTS_WHEN,
        required_fields: [],
        workflow: singleNextWorkflow({
          recommendedAction: "list_projects",
          tool: "project_list",
          requiredWhen: LIST_PROJECTS_WHEN
        })
      });
      expect(parsed.next.actions).toContainEqual(expect.objectContaining({
        action: "list_projects",
        tool: "project_list",
        command: "moryn project list",
        required_when: LIST_PROJECTS_WHEN,
        required_fields: []
      }));
      expect(parsed.next.actions_by_id.list_projects).toEqual(parsed.next.actions[0]);
      expectLifecycleActionSelectionSources(parsed.next.actions_by_id.list_projects);
      expect(parsed.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_cli_executable: "next.actions_by_id.<action>.interfaces.cli.executable",
        action_cli_argv: "next.actions_by_id.<action>.interfaces.cli.argv[]",
        action_cli_args: "next.actions_by_id.<action>.interfaces.cli.args[]",
        action_cli_exec_file: "next.actions_by_id.<action>.interfaces.cli.exec_file",
        action_cli_placeholder: "next.actions_by_id.<action>.interfaces.cli.placeholders[]",
        action_cli_command_line: "next.actions_by_id.<action>.interfaces.cli.command_line",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_required_input_argument_path: "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
    });
  });

  it("prefills project list startup commands from CLI options", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "session_summary",
        "--project-id", "moryn",
        "--text", "Moryn project handoff is available."
      ]);

      const listed = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "project", "list",
        "--current-task", "continue handoff",
        "--sync-remote", "git@github.com:user/moryn-store.git",
        "--agent", "gemini",
        "--session-id", "gemini-project-list"
      ]);
      const parsed = JSON.parse(listed.stdout) as {
        projects: Array<{
          next: {
            command: string;
            arguments: {
              project_id: string;
              sync_remote?: string;
              current_task?: string;
              agent?: { client: string; session_id?: string };
            };
          };
        }>;
      };

      expect(parsed.projects[0]?.next.command).toBe("moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'continue handoff' --agent gemini --session-id gemini-project-list");
      expect(parsed.projects[0]?.next.arguments).toMatchObject({
        project_id: "moryn",
        sync_remote: "git@github.com:user/moryn-store.git",
        current_task: "continue handoff",
        agent: { client: "gemini", session_id: "gemini-project-list" }
      });
    });
  });

  it("enters project discovery from CLI when project input is missing", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "session_summary",
        "--project-id", "moryn",
        "--text", "Moryn project handoff is available."
      ]);

      const entered = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "enter",
        "--agent", "gemini",
        "--session-id", "gemini-cli-enter",
        "--current-task", "find project",
        "--sync-remote", "git@github.com:user/moryn-store.git"
      ], { cwd: dir });
      const parsed = JSON.parse(entered.stdout) as {
        mode: string;
        projects: { projects: Array<{ project_id: string; next: { command: string } }> };
        next: {
          recommended_action: string;
          tool: string;
          safe_to_run: boolean;
          required_when: string;
          required_fields: string[];
          required_fields_by_name: Record<string, {
            name: string;
            argument_path: string;
            placeholder?: string;
            value?: unknown;
          }>;
          arguments: Record<string, unknown>;
          safety: {
            safe_to_auto_run: boolean;
            requires_user_confirmation: boolean;
            requires_authored_input: boolean;
            writes_local_config: boolean;
            reasons: string[];
          };
          workflow: {
            version: number;
            start: string;
            continue_from: string[];
            phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
          };
          actions: Array<{
            project_id: string;
            required_when?: string;
            command?: string;
            arguments?: Record<string, unknown>;
            lifecycle?: Array<{
              step: string;
              tool: string;
              safe_to_run: boolean;
              command: string;
              required_when: string;
              required_fields: string[];
              workflow?: Record<string, unknown>;
            }>;
            lifecycle_by_step?: Record<string, {
              step: string;
              tool: string;
              safe_to_run: boolean;
              command: string;
              required_when: string;
              required_fields: string[];
              workflow?: Record<string, unknown>;
            }>;
          }>;
          actions_by_project_id: Record<string, {
            project_id: string;
            command: string;
            arguments: Record<string, unknown>;
            lifecycle?: Array<{ step: string; tool: string; command: string; required_when: string; required_fields: string[]; workflow?: Record<string, unknown> }>;
            lifecycle_by_step?: Record<string, { step: string; tool: string; command: string; required_when: string; required_fields: string[]; workflow?: Record<string, unknown> }>;
          }>;
        };
      };

      expect(parsed.mode).toBe("discover_projects");
      expect(parsed.next).toMatchObject({
        recommended_action: "choose_project_and_call_agent_start",
        action_source: "next",
        tool: "agent_start",
        safe_to_run: true,
        required_when: "When agent_enter returns discover_projects mode, choose one returned project_id before calling agent_start.",
        required_fields: ["project_id"],
        required_fields_by_name: {
          project_id: {
            name: "project_id",
            argument_path: "project_id",
            value: "<project_id>",
            placeholder: "<project_id>"
          }
        },
        argument_sources: {
          project_id: "next.actions_by_project_id.<project_id>.project_id"
        },
        selection_sources: {
          project: "projects.projects_by_id.<project_id>",
          project_id: "projects.projects_by_id.<project_id>.project_id",
          next_cli_executable: "next.interfaces.cli.executable",
          next_cli_argv: "next.interfaces.cli.argv[]",
          next_cli_args: "next.interfaces.cli.args[]",
          next_cli_exec_file: "next.interfaces.cli.exec_file",
          next_cli_placeholder: "next.interfaces.cli.placeholders[]",
          next_cli_command_line: "next.interfaces.cli.command_line",
          start_action: "next.actions_by_project_id.<project_id>",
          start_action_cli_executable: "next.actions_by_project_id.<project_id>.interfaces.cli.executable",
          start_action_cli_argv: "next.actions_by_project_id.<project_id>.interfaces.cli.argv[]",
          start_action_cli_args: "next.actions_by_project_id.<project_id>.interfaces.cli.args[]",
          start_action_cli_exec_file: "next.actions_by_project_id.<project_id>.interfaces.cli.exec_file",
          start_action_cli_placeholder: "next.actions_by_project_id.<project_id>.interfaces.cli.placeholders[]",
          start_action_cli_command_line: "next.actions_by_project_id.<project_id>.interfaces.cli.command_line",
          start_action_argument: "next.actions_by_project_id.<project_id>.arguments_by_name.<argument>",
          start_action_required_field: "next.actions_by_project_id.<project_id>.required_fields_by_name.<field>",
          start_action_required_input: "next.actions_by_project_id.<project_id>.execution.required_inputs_by_field.<field>",
          start_action_required_input_argument_path: "next.actions_by_project_id.<project_id>.execution.required_inputs_by_argument_path.<argument_path>",
          start_action_argument_source: "next.actions_by_project_id.<project_id>.argument_sources.<field>",
          lifecycle_actions: "next.actions_by_project_id.<project_id>.lifecycle_by_step"
        },
        arguments: {
          project_id: "<project_id>",
          sync_remote: "git@github.com:user/moryn-store.git",
          current_task: "find project",
          agent: { client: "gemini", session_id: "gemini-cli-enter" }
        },
        safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          requires_authored_input: true,
          writes_local_config: false,
          reasons: ["required_fields"]
        }
      });
      expect(parsed.next.command).toBe("moryn agent start --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-cli-enter");
      expectActionInterfaces(parsed.next);
      expect(parsed.next.workflow).toEqual(withPhasesByName({
        version: 1,
        start: "projects",
        continue_from: [
          "next.actions_by_project_id",
          "next.actions",
          "next.actions_by_project_id.<project_id>.lifecycle_by_step",
          "next.actions_by_project_id.<project_id>.lifecycle",
          "agent_start.next.actions_by_id",
          "agent_start.next.actions"
        ],
        phases: [
          {
            phase: "choose_project",
            order: 1,
            action_source: "projects.projects",
            required_when: "When agent_enter returns discover_projects mode, choose one returned project instead of guessing a project id.",
            required_fields: []
          },
          {
            phase: "start_session",
            order: 2,
            action_source: "next.actions_by_project_id.<project_id>",
            tool: "agent_start",
            required_when: "After choosing this project from discovery results.",
            required_fields: []
          },
          {
            phase: "continue_selected_project_lifecycle",
            order: 3,
            action_source: "next.actions_by_project_id.<project_id>.lifecycle_by_step",
            required_when: "After the selected project starts, use that action's lifecycle templates for status, finish, and refresh.",
            required_fields: []
          }
        ]
      }));
      expect(parsed.next.actions_by_project_id.moryn).toEqual(parsed.next.actions[0]);
      expect(parsed.projects.projects[0]?.project_id).toBe("moryn");
      expect(parsed.projects.projects[0]?.next.command).toBe("moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-cli-enter");
      expect(parsed.next.actions[0]?.required_when).toBe("After choosing this project from discovery results.");
      const discoveredFinish = parsed.next.actions[0]?.lifecycle?.find((action) => action.step === "finish_handoff");
      expect(parsed.next.actions[0]?.lifecycle_by_step?.finish_handoff).toEqual(discoveredFinish);
      expect(parsed.next.actions_by_project_id.moryn.lifecycle_by_step?.finish_handoff).toEqual(discoveredFinish);
      expect(discoveredFinish).toMatchObject({
        step: "finish_handoff",
        tool: "agent_finish",
        safe_to_run: false,
        command: "moryn agent finish --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project' --agent gemini --session-id gemini-cli-enter --summary <summary>",
        required_fields: ["summary"],
        argument_sources: {
          summary: "user_input.summary"
        }
      });
      expectLifecycleWorkflow(discoveredFinish!);
    });
  });

  it("returns runtime workflow from CLI agent enter after starting a known project", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await mkdir(project, { recursive: true });
      await exec("node", [
        "--import", tsxLoader, cliPath,
        "project", "init",
        "--path", project,
        "--project-id", "moryn"
      ]);

      const entered = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "enter",
        "--project", project,
        "--agent", "codex",
        "--session-id", "codex-cli-enter-known",
        "--current-task", "continue known project"
      ]);
      const parsed = JSON.parse(entered.stdout) as {
        mode: string;
        next: {
          recommended_action: string;
          actions: Array<{ action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
          actions_by_id: Record<string, { action: string; tool: string; command: string; required_when: string; required_fields: string[]; arguments: Record<string, unknown> }>;
          workflow: {
            version: number;
            start: string;
            continue_from: string[];
            phases: Array<{ phase: string; order: number; action_source: string; tool?: string; required_when: string; required_fields: string[] }>;
          };
        };
      };

      expect(parsed.mode).toBe("start_session");
      expect(parsed.next.recommended_action).toBe("work_with_handoff_context");
      expect(parsed.next.actions_by_id.publish_status).toEqual(parsed.next.actions.find((action) => action.action === "publish_status"));
      expect(parsed.next.actions_by_id.finish_session).toEqual(parsed.next.actions.find((action) => action.action === "finish_session"));
      expect(parsed.next.actions_by_id.refresh_context).toEqual(parsed.next.actions.find((action) => action.action === "refresh_context"));
      expect(parsed.next.required_end_action_id).toBe("finish_session");
      expect(parsed.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
      expect(parsed.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(parsed.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(parsed.next.workflow).toEqual(withPhasesByName({
        version: 1,
        start: "start",
        continue_from: ["start.boot", "start.refresh", "start.handoff", "next.actions_by_id", "next.actions"],
        phases: [
          {
            phase: "work_with_handoff_context",
            order: 1,
            action_source: "start",
            required_when: "Immediately after agent_enter returns start_session mode, review boot, refresh, and handoff context before taking user-task actions.",
            required_fields: []
          },
          {
            phase: "publish_status",
            order: 2,
            action_source: "next.actions_by_id.publish_status",
            tool: "agent_status",
            required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
            required_fields: ["status"]
          },
          {
            phase: "finish_session",
            order: 3,
            action_source: "next.actions_by_id.finish_session",
            tool: "agent_finish",
            required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
            required_fields: ["summary"]
          },
          {
            phase: "refresh_context",
            order: 4,
            action_source: "next.actions_by_id.refresh_context",
            tool: "agent_start",
            required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
            required_fields: []
          }
        ]
      }));
    });
  });

  it("returns structured JSON errors from runtime failures", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "init"]);
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8");

      await expect(exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "boot", "--project", project]))
        .rejects.toMatchObject({
          stderr: expect.stringContaining("\"ok\": false")
        });
      try {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", join(dir, "store"), "boot", "--project", project]);
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_PROJECT_CONFIG");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("fix .moryn.json or pass an explicit project id");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "repair_project_config_or_retry_with_explicit_project_id",
          tool: "project_init",
          command: `moryn project init --path ${project} --repair`,
          arguments: { path: project, repair: true },
          required_fields: [],
          safe_to_run: false
        });
      }
    });
  });

  it("repairs malformed project config from the CLI when explicitly requested", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":", "utf8");

      const repaired = await exec("node", [
        "--import", "tsx", "src/cli.ts",
        "project", "init",
        "--path", project,
        "--project-id", "moryn",
        "--tag", "typescript",
        "--sync-mode", "manual",
        "--repair"
      ]);
      const parsed = JSON.parse(repaired.stdout) as { ok: boolean; config: { project_id: string; tags: string[]; sync: { mode: string } } };

      expect(parsed.ok).toBe(true);
      expect(parsed.config).toMatchObject({
        project_id: "moryn",
        tags: ["typescript"],
        sync: { mode: "manual" }
      });
    });
  });

  it("does not start from the CLI when an explicit project path is missing", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const missingProject = join(dir, "missing-project");
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "doctor",
        "--project", missingProject,
        "--agent", "codex",
        "--current-task", "avoid typo path"
      ]);
      const parsedDoctor = JSON.parse(doctor.stdout) as {
        project: { ok: boolean; error?: string };
        next: {
          recommended_action: string;
          tool: string;
          safe_to_run: boolean;
          command: string;
          required_when: string;
          required_fields: string[];
          workflow: Record<string, unknown>;
          arguments: { path?: string };
        };
      };
      expect(parsedDoctor.project.ok).toBe(false);
      expect(parsedDoctor.project.error).toContain("Project path does not exist");
      expect(parsedDoctor.next).toMatchObject({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: `moryn project init --path ${missingProject}`,
        required_when: FIX_PROJECT_CONFIG_WHEN,
        required_fields: [],
        workflow: singleNextWorkflow({
          recommendedAction: "fix_project_config",
          tool: "project_init",
          requiredWhen: FIX_PROJECT_CONFIG_WHEN
        }),
        arguments: { path: missingProject }
      });

      const entered = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "enter",
        "--project", missingProject,
        "--agent", "codex",
        "--current-task", "avoid typo path"
      ]);
      const parsedEnter = JSON.parse(entered.stdout) as {
        mode: string;
        next: {
          recommended_action: string;
          tool: string;
          safe_to_run: boolean;
          required_when: string;
          required_fields: string[];
          workflow: Record<string, unknown>;
        };
      };
      expect(parsedEnter).toMatchObject({
        mode: "needs_setup",
        next: {
          recommended_action: "fix_project_config",
          tool: "project_init",
          safe_to_run: false,
          required_when: FIX_PROJECT_CONFIG_WHEN,
          required_fields: [],
          workflow: singleNextWorkflow({
            recommendedAction: "fix_project_config",
            tool: "project_init",
            requiredWhen: FIX_PROJECT_CONFIG_WHEN
          })
        }
      });

      try {
        await exec("node", [
          "--import", tsxLoader, cliPath, "--store", store,
          "agent", "start",
          "--project", missingProject,
          "--agent", "codex",
          "--current-task", "avoid typo path"
        ]);
        throw new Error("Expected direct lifecycle project path typo to reject");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            recovery_hint: unknown;
            next_action: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              candidate_project_ids?: string[];
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("PROJECT_PATH_NOT_FOUND");
        expect(parsed.error.message).toContain("Project path does not exist");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("run moryn project init --path <path> for a new project or retry with the correct --project/--project-id");
        expect(parsed.error.recovery_hint).toEqual({
          rejected_argument: { option: "--project", value: missingProject },
          initialize_with: {
            tool: "project_init",
            command: `moryn project init --path ${missingProject}`,
            arguments: { path: missingProject },
            safe_to_run: false
          },
          retry_alternative: [
            {
              option: "--project",
              value_source: "user_input.path",
              value_placeholder: "<correct_project_path>"
            },
            {
              option: "--project-id",
              value_source: "user_input.project_id",
              value_placeholder: "<project_id>"
            }
          ],
          requires_user_confirmation: true,
          do_not: ["assume_missing_path_is_new_project", "invent_project_id", "auto_initialize_project_config"]
        });
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "initialize_project_or_retry_corrected_context",
          tool: "project_init",
          command: `moryn project init --path ${missingProject}`,
          arguments: { path: missingProject },
          required_fields: [],
          safe_to_run: false
        });
      }
    });
  });

  it("does not start from the CLI when an explicit project id is unknown in a populated store", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "session_summary",
        "--project-id", "moryn",
        "--text", "Known project handoff."
      ]);

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "doctor",
        "--project-id", "morym",
        "--agent", "codex",
        "--current-task", "avoid typo id"
      ]);
      const parsedDoctor = JSON.parse(doctor.stdout) as {
        project: { ok: boolean; error?: string };
        next: {
          recommended_action: string;
          tool: string;
          safe_to_run: boolean;
          command: string;
          required_when: string;
          required_fields: string[];
          workflow: Record<string, unknown>;
        };
      };
      expect(parsedDoctor.project.ok).toBe(false);
      expect(parsedDoctor.project.error).toContain("Project id is not known in this store");
      expect(parsedDoctor.next).toMatchObject({
        recommended_action: "list_projects",
        action_source: "next",
        tool: "project_list",
        safe_to_run: true,
        command: "moryn project list",
        required_when: LIST_PROJECTS_WHEN,
        required_fields: [],
        workflow: singleNextWorkflow({
          recommendedAction: "list_projects",
          tool: "project_list",
          requiredWhen: LIST_PROJECTS_WHEN
        })
      });

      const entered = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "enter",
        "--project-id", "morym",
        "--agent", "codex",
        "--current-task", "avoid typo id"
      ]);
      const parsedEnter = JSON.parse(entered.stdout) as {
        mode: string;
        projects: { projects: Array<{ project_id: string }> };
        next: { recommended_action: string; tool: string };
      };
      expect(parsedEnter).toMatchObject({
        mode: "discover_projects",
        next: {
          recommended_action: "choose_project_and_call_agent_start",
          action_source: "next",
          tool: "agent_start"
        }
      });
      expect(parsedEnter.projects.projects[0]?.project_id).toBe("moryn");

      try {
        await exec("node", [
          "--import", tsxLoader, cliPath, "--store", store,
          "agent", "start",
          "--project-id", "morym",
          "--agent", "codex",
          "--current-task", "avoid typo id"
        ]);
        throw new Error("Expected direct lifecycle project id typo to reject");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            next_action: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
              workflow?: {
                phases?: Array<Record<string, unknown>>;
              };
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("PROJECT_ID_NOT_FOUND");
        expect(parsed.error.message).toContain("Project id is not known in this store");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("run moryn project list or moryn agent enter, then retry with a known --project-id");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "list_projects_and_retry_with_known_project_id",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          argument_sources: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          rejected_arguments: { project_id: "morym" },
          candidate_project_ids: ["moryn"],
          required_fields: [],
          safe_to_run: true
        });
        expect(parsed.error.next_action.workflow?.phases?.[1]).toEqual({
          phase: "retry_original_tool_with_selected_project_id",
          order: 2,
          action_source: "project_list.projects_by_id.<project_id>.project_id",
          tool: "agent_start",
          command: "moryn agent start --project-id <project_id_from_project_list> --current-task 'avoid typo id' --agent codex",
          arguments: { project_id: "<project_id_from_project_list>", current_task: "avoid typo id", agent: { client: "codex" } },
          replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
          required_fields: ["project_id"]
        });
      }
    });
  });

  it("does not start from the CLI when project path config conflicts with explicit project id", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", tsxLoader, cliPath, "project", "init", "--path", project, "--project-id", "moryn"]);

      const doctor = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "doctor",
        "--project", project,
        "--project-id", "other",
        "--agent", "codex",
        "--current-task", "avoid conflicting project id"
      ]);
      const parsedDoctor = JSON.parse(doctor.stdout) as {
        project: { ok: boolean; error?: string };
        next: { tool: string; safe_to_run: boolean; command: string; arguments: { path?: string; project_id?: string } };
      };
      expect(parsedDoctor.project.ok).toBe(false);
      expect(parsedDoctor.project.error).toContain("Project id conflict");
      expect(parsedDoctor.next).toMatchObject({
        tool: "project_init",
        safe_to_run: false,
        command: `moryn project init --path ${project}`,
        arguments: {
          path: project
        }
      });
      expect(parsedDoctor.next.command).not.toContain("--project-id");
      expect(parsedDoctor.next.arguments).not.toHaveProperty("project_id");

      try {
        await exec("node", [
          "--import", tsxLoader, cliPath, "--store", store,
          "agent", "start",
          "--project", project,
          "--project-id", "other",
          "--agent", "codex",
          "--current-task", "avoid conflicting project id"
        ]);
        throw new Error("Expected conflicting lifecycle project identity to reject");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            recovery_hint: unknown;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              candidate_project_ids?: string[];
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("PROJECT_ID_CONFLICT");
        expect(parsed.error.message).toContain("Project id conflict");
        expect(parsed.error.recommended_action).toBe("pass the project id from .moryn.json or update the project config");
        expect(parsed.error.recovery_hint).toEqual({
          rejected_argument: { option: "--project-id", value: "other" },
          config_project_id: "moryn",
          retry_with: {
            tool: "agent_enter",
            command: "moryn agent enter --project-id moryn",
            arguments: { project_id: "moryn" },
            safe_to_run: false
          },
          repair_alternative: {
            tool: "project_init",
            command: "moryn project init --repair",
            arguments: { repair: true },
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: ["retry_with_rejected_project_id", "invent_project_id", "auto_update_project_config"]
        });
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "retry_with_project_config_id_or_update_project_config",
          tool: "agent_enter",
          command: "moryn agent enter --project-id moryn",
          arguments: { project_id: "moryn" },
          rejected_arguments: { project_id: "other" },
          candidate_project_ids: ["moryn"],
          required_fields: [],
          safe_to_run: false
        });
      }
    });
  });

  it("rejects direct lifecycle CLI commands without project input in a populated store", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const unknownCwd = join(dir, "unknown-cwd");
      await mkdir(unknownCwd, { recursive: true });
      await exec("node", ["--import", tsxLoader, cliPath, "--store", store, "init"]);
      await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "write",
        "--kind", "session_summary",
        "--project-id", "moryn",
        "--text", "Known direct CLI project."
      ]);

      for (const { args, retry } of [
        {
          args: ["agent", "start", "--agent", "codex", "--current-task", "avoid ambient project"],
          retry: {
            tool: "agent_start",
            command: "moryn agent start --current-task 'avoid ambient project' --agent codex --project-id <project_id_from_project_list>",
            arguments: { current_task: "avoid ambient project", agent: { client: "codex" }, project_id: "<project_id_from_project_list>" }
          }
        },
        {
          args: ["agent", "status", "--agent", "codex", "--current-task", "avoid ambient project", "--status", "Do not write inferred status."],
          retry: {
            tool: "agent_status",
            command: "moryn agent status --current-task 'avoid ambient project' --agent codex --status 'Do not write inferred status.' --project-id <project_id_from_project_list>",
            arguments: {
              current_task: "avoid ambient project",
              status: "Do not write inferred status.",
              agent: { client: "codex" },
              project_id: "<project_id_from_project_list>"
            }
          }
        },
        {
          args: ["agent", "finish", "--agent", "codex", "--current-task", "avoid ambient project", "--summary", "Do not write inferred summary."],
          retry: {
            tool: "agent_finish",
            command: "moryn agent finish --current-task 'avoid ambient project' --agent codex --summary 'Do not write inferred summary.' --project-id <project_id_from_project_list>",
            arguments: {
              current_task: "avoid ambient project",
              summary: "Do not write inferred summary.",
              agent: { client: "codex" },
              project_id: "<project_id_from_project_list>"
            }
          }
        }
      ]) {
        try {
          await exec("node", ["--import", tsxLoader, cliPath, "--store", store, ...args], { cwd: unknownCwd });
          throw new Error(`Expected moryn ${args.join(" ")} to reject missing project context`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recoverable: boolean;
              recommended_action: string;
              next_action: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
                workflow?: {
                  phases?: Array<Record<string, unknown>>;
                };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("PROJECT_CONTEXT_REQUIRED");
          expect(parsed.error.message).toContain("Project context required");
          expect(parsed.error.recommended_action).toBe("run moryn project list or moryn agent enter, then retry with --project-id or --project");
          expect(parsed.error.next_action).toMatchObject({
            recommended_action: "discover_projects_before_lifecycle_write",
            tool: "project_list",
            command: "moryn project list",
            arguments: {},
            candidate_project_ids: ["moryn"],
            required_fields: [],
            safe_to_run: true
          });
          expect(parsed.error.next_action.workflow?.phases?.[1]).toEqual({
            phase: "retry_original_tool_with_selected_project_id",
            order: 2,
            action_source: "project_list.projects_by_id.<project_id>.project_id",
            tool: retry.tool,
            command: retry.command,
            arguments: retry.arguments,
            replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
            required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
            required_fields: ["project_id"]
          });
        }
      }
    });
  });

  it("rejects invalid numeric limit options", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const args of [
        ["recall", "anything", "--limit", "abc"],
        ["refresh", "--limit", "0"],
        ["list-recent", "--limit", "101"]
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject an invalid limit`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const stderr = (error as { stderr: string }).stderr;
          const parsed = JSON.parse(stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recoverable: boolean;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; min: number; max: number; integer: boolean };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --limit");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("retry with a valid --limit value");
          const rejectedLimit = args[args.length - 1]!;
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option: "--limit", value: rejectedLimit },
            expected: { kind: "integer_range", min: 1, max: 100, integer: true },
            retry_with: { option: "--limit", value_placeholder: "<integer 1-100>" }
          });
        }
      }
    });
  });

  it("rejects invalid refresh cursors at the CLI boundary", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", dir,
          "refresh",
          "--cursor", "not-a-date"
        ]);
        throw new Error("Expected moryn refresh to reject an invalid cursor");
      } catch (error) {
        if (!("stderr" in (error as object))) throw error;
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            message: string;
            recoverable: boolean;
            recommended_action: string;
            recovery_hint: {
              rejected_argument: { option: string; value: string };
              expected: { kind: string; format: string; source: string };
              retry_with: { option: string; value_source: string; value_placeholder: string };
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_ARGUMENT");
        expect(parsed.error.message).toContain("Invalid cursor");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("retry with a refresh cursor returned by Moryn");
        expect(parsed.error.recovery_hint).toEqual({
          rejected_argument: { option: "--cursor", value: "not-a-date" },
          expected: {
            kind: "iso_datetime",
            format: "RFC3339 timestamp with timezone",
            source: "refresh.cursor, boot.sync.cursor, agent_start.refresh.cursor, or agent_enter.start.refresh.cursor"
          },
          retry_with: {
            option: "--cursor",
            value_source: "previous Moryn response cursor field",
            value_placeholder: "<refresh cursor ISO datetime>"
          }
        });
      }
    });
  });

  it("maps invalid agent refresh cursors to refresh-since recovery hints", async () => {
    await withTempDir(async (dir) => {
      const project = join(dir, "project");
      await mkdir(project, { recursive: true });
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      await exec("node", ["--import", "tsx", "src/cli.ts", "project", "init", "--path", project, "--project-id", "moryn"]);

      for (const command of ["start", "enter"]) {
        try {
          await exec("node", [
            "--import", "tsx", "src/cli.ts", "--store", dir,
            "agent", command,
            "--project", project,
            "--current-task", "continue handoff",
            "--refresh-since", "not-a-date"
          ]);
          throw new Error(`Expected moryn agent ${command} to reject an invalid refresh cursor`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; format: string; source: string };
                retry_with: { option: string; value_source: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.recommended_action).toBe("retry with a refresh cursor returned by Moryn");
          expect(parsed.error.recovery_hint).toEqual({
            rejected_argument: { option: "--refresh-since", value: "not-a-date" },
            expected: {
              kind: "iso_datetime",
              format: "RFC3339 timestamp with timezone",
              source: "refresh.cursor, boot.sync.cursor, agent_start.refresh.cursor, or agent_enter.start.refresh.cursor"
            },
            retry_with: {
              option: "--refresh-since",
              value_source: "previous Moryn response cursor field",
              value_placeholder: "<refresh cursor ISO datetime>"
            }
          });
        }
      }
    });
  });

  it("rejects invalid enum options at the CLI boundary", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, option, value, allowedValues } of [
        {
          args: ["write", "--kind", "nonsense", "--type", "decision", "--scope", "project", "--text", "Invalid kind."],
          option: "--kind",
          value: "nonsense",
          allowedValues: ["memory", "skill", "soul", "session_summary", "agent_note"]
        },
        {
          args: ["write", "--kind", "memory", "--type", "decision", "--scope", "project", "--priority", "urgent", "--text", "Invalid priority."],
          option: "--priority",
          value: "urgent",
          allowedValues: ["low", "normal", "high"]
        },
        {
          args: ["recall", "--kind", "nonsense"],
          option: "--kind",
          value: "nonsense",
          allowedValues: ["memory", "skill", "soul", "session_summary", "agent_note"]
        },
        {
          args: ["promote", "rec_missing", "--state", "nonsense"],
          option: "--state",
          value: "nonsense",
          allowedValues: ["raw", "candidate", "canonical", "archived", "quarantined"]
        },
        {
          args: ["project", "init", "--path", dir, "--sync-mode", "sometimes"],
          option: "--sync-mode",
          value: "sometimes",
          allowedValues: ["manual", "session", "interval"]
        }
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject an invalid enum option`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recommended_action: string;
              recovery_hint: {
                rejected_argument: { option: string; value: string };
                expected: { kind: string; allowed_values: string[] };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain("Invalid --");
          expect(parsed.error.recommended_action).toContain("retry with a supported ");
          expect(parsed.error.recovery_hint.rejected_argument).toEqual({ option, value });
          expect(parsed.error.recovery_hint.expected.kind).toBe("allowed_values");
          expect(parsed.error.recovery_hint.expected.allowed_values).toEqual(allowedValues);
          expect(parsed.error.recovery_hint.retry_with.option).toBe(parsed.error.recovery_hint.rejected_argument.option);
          expect(parsed.error.recovery_hint.retry_with.value_placeholder).toBe(`<${parsed.error.recovery_hint.rejected_argument.option.slice(2)} from allowed_values>`);
        }
      }
    });
  });

  it("returns structured JSON errors for CLI parser failures", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);

      for (const { args, message, option, placeholder } of [
        {
          args: ["write", "--scope", "project", "--type", "decision", "--text", "Parser errors should still be structured."],
          message: "required option '--kind <kind>'",
          option: "--kind",
          placeholder: "<kind>"
        },
        {
          args: ["write", "--kind", "memory", "--scope", "project", "--text", "Parser errors should still be structured."],
          message: "required option '--type <type>'",
          option: "--type",
          placeholder: "<type>"
        }
      ]) {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to reject missing input`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const parsed = JSON.parse((error as { stderr: string }).stderr) as {
            ok: boolean;
            error: {
              code: string;
              message: string;
              recoverable: boolean;
              recommended_action: string;
              recovery_hint: {
                missing_argument: { option: string; placeholder: string };
                expected: { kind: string; required: boolean };
                retry_with: { option: string; value_placeholder: string };
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("INVALID_ARGUMENT");
          expect(parsed.error.message).toContain(message);
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe(`retry with required ${option}`);
          expect(parsed.error.recovery_hint).toEqual({
            missing_argument: { option, placeholder },
            expected: { kind: "required_option", required: true },
            retry_with: { option, value_placeholder: placeholder }
          });
        }
      }
    });
  });

  it("returns structured JSON errors for malformed store config during init", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await mkdir(store, { recursive: true });
      await writeFile(join(store, "config.json"), "{\"store_version\":", "utf8");

      try {
        await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
        throw new Error("Expected moryn init to fail for malformed store config");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recoverable: boolean;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("INVALID_STORE_CONFIG");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("fix or repair config.json, then run moryn init");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "repair_local_store_config",
          tool: "init",
          command: "moryn init --repair",
          arguments: { repair: true },
          required_fields: [],
          safe_to_run: false
        });
      }
    });
  });

  it("repairs malformed store config from the CLI when explicitly requested", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await mkdir(store, { recursive: true });
      await writeFile(join(store, "config.json"), "{\"store_version\":", "utf8");

      const repaired = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init", "--repair"]);
      const parsed = JSON.parse(repaired.stdout) as { ok: boolean; config: { store_version: number; device_id: string } };

      expect(parsed.ok).toBe(true);
      expect(parsed.config.store_version).toBe(1);
      expect(parsed.config.device_id).toMatch(/^device_/);
    });
  });

  it("returns structured JSON errors for missing record mutations", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "promote",
          "rec_missing",
          "--state",
          "canonical"
        ]);
        throw new Error("Expected moryn promote to fail for a missing record");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recoverable: boolean;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              rejected_arguments?: Record<string, unknown>;
              workflow?: {
                phases?: Array<Record<string, unknown>>;
              };
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("RECORD_NOT_FOUND");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("check the record id or call recall/list-recent to find it");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "list_recent_records_and_retry_with_known_record_id",
          tool: "list_recent",
          command: "moryn list-recent",
          arguments: {},
          argument_sources: { record_id: "list_recent.records_by_id.<record_id>.id" },
          rejected_arguments: { record_id: "rec_missing" },
          required_fields: [],
          safe_to_run: true
        });
        expect(parsed.error.next_action?.workflow?.phases?.[1]).toEqual({
          phase: "retry_original_tool_with_selected_record_id",
          order: 2,
          action_source: "list_recent.records_by_id.<record_id>.id",
          tool: "promote",
          command: "moryn promote <record_id_from_list_recent> --state canonical",
          arguments: { record_id: "<record_id_from_list_recent>", target_state: "canonical" },
          replace_arguments: { record_id: "list_recent.records_by_id.<record_id>.id" },
          required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
          required_fields: ["record_id"]
        });
      }
    });
  });

  it("returns retry workflow context for missing recall record ids", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "recall",
          "--record-id",
          "rec_missing"
        ]);
        throw new Error("Expected moryn recall to fail for a missing record");
      } catch (error) {
        const parsed = JSON.parse((error as { stderr: string }).stderr) as {
          ok: boolean;
          error: {
            code: string;
            next_action?: {
              workflow?: {
                phases?: Array<Record<string, unknown>>;
              };
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("RECORD_NOT_FOUND");
        expect(parsed.error.next_action?.workflow?.phases?.[1]).toEqual({
          phase: "retry_original_tool_with_selected_record_id",
          order: 2,
          action_source: "list_recent.records_by_id.<record_id>.id",
          tool: "recall",
          command: "moryn recall --record-id <record_id_from_list_recent>",
          arguments: { record_ids: ["<record_id_from_list_recent>"] },
          replace_arguments: { record_ids: "list_recent.records_by_id.<record_id>.id" },
          required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
          required_fields: ["record_ids"]
        });
      }
    });
  });

  it("requires explicit CLI confirmation for high-risk canonical changes", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      const write = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "soul",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer terse answers."
      ]);
      const parsedWrite = JSON.parse(write.stdout) as {
        record: { id: string; state: string };
        warning?: {
          code: string;
          next_action?: {
            recommended_action: string;
            tool: string;
            command: string;
            arguments: Record<string, unknown>;
            argument_sources?: Record<string, string>;
            candidate_record_id?: string;
            selection_sources?: Record<string, string>;
            required_when?: string;
            required_fields: string[];
            workflow?: Record<string, unknown>;
            safe_to_run: boolean;
          };
        };
      };
      expect(parsedWrite.record.state).toBe("candidate");
      expect(parsedWrite.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(parsedWrite.warning?.next_action).toMatchObject({
        recommended_action: "ask_user_then_promote_candidate",
        tool: "promote",
        command: `moryn promote ${parsedWrite.record.id} --state canonical --reason 'User confirmed' --confirm`,
        candidate_record_id: parsedWrite.record.id,
        arguments: {
          record_id: parsedWrite.record.id,
          target_state: "canonical",
          reason: "User confirmed",
          confirmed: true
        },
        argument_sources: {
          record_id: "write.record.id"
        },
        required_fields: [],
        safe_to_run: false
      });
      expectCandidatePromoteWorkflow(parsedWrite.warning!.next_action!);
      expectNextActionSelectionSources(parsedWrite.warning!.next_action!);

      const memoryPreference = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "preference",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Prefer concise engineering updates."
      ]);
      const parsedMemoryPreference = JSON.parse(memoryPreference.stdout) as { record: { state: string }; warning?: { code: string } };
      expect(parsedMemoryPreference.record.state).toBe("candidate");
      expect(parsedMemoryPreference.warning?.code).toBe("CONFIRMATION_REQUIRED");

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "promote",
          parsedWrite.record.id,
          "--state",
          "canonical",
          "--reason",
          "User confirmed"
        ]);
        throw new Error("Expected moryn promote to require confirmation");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recoverable: boolean;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "promote",
          command: `moryn promote ${parsedWrite.record.id} --state canonical --reason 'User confirmed' --confirm`,
          arguments: {
            record_id: parsedWrite.record.id,
            target_state: "canonical",
            reason: "User confirmed",
          confirmed: true
        },
        required_fields: [],
        safe_to_run: false
      });
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "promote",
        parsedWrite.record.id,
        "--state",
        "canonical",
        "--reason",
        "User confirmed",
        "--confirm"
      ]);
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id",
        parsedWrite.record.id
      ])).stdout) as { results: Array<{ record: { state: string } }> };
      expect(recall.results[0]?.record.state).toBe("canonical");

      const confirmedWrite = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "skill",
        "--type", "procedure",
        "--scope", "global",
        "--state", "canonical",
        "--text", "Global release checklist.",
        "--confirm"
      ]);
      const parsedConfirmedWrite = JSON.parse(confirmedWrite.stdout) as { record: { state: string }; warning?: unknown };
      expect(parsedConfirmedWrite.record.state).toBe("canonical");
      expect(parsedConfirmedWrite.warning).toBeUndefined();
    });
  });

  it("marks conflicting CLI canonical writes as candidates", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const existing = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use append-only JSON events.",
        "--confirm"
      ]);
      const existingId = (JSON.parse(existing.stdout) as { record: { id: string } }).record.id;

      const conflicting = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use SQLite as the source of truth."
      ]);
      const parsed = JSON.parse(conflicting.stdout) as {
        record: { state: string; conflict?: { with: string[]; resolution: string } };
        warning?: {
          code: string;
          next_action?: {
            recommended_action: string;
            tool: string;
            command: string;
            arguments: Record<string, unknown>;
            safe_to_run: boolean;
          };
        };
      };

      expect(parsed.record.state).toBe("candidate");
      expect(parsed.warning?.code).toBe("CONFIRMATION_REQUIRED");
      expect(parsed.warning?.next_action).toMatchObject({
        recommended_action: "ask_user_then_promote_candidate",
        tool: "promote",
        command: expect.stringMatching(/^moryn promote rec_[a-f0-9]+ --state canonical --reason 'User confirmed' --confirm$/),
        candidate_record_id: expect.stringMatching(/^rec_[a-f0-9]+$/),
        arguments: expect.objectContaining({
          target_state: "canonical",
          reason: "User confirmed",
          confirmed: true
        }),
        argument_sources: {
          record_id: "write.record.id"
        },
        required_fields: [],
        safe_to_run: false
      });
      expect(parsed.warning!.next_action!.arguments.record_id).toBe(parsed.warning!.next_action!.candidate_record_id);
      expectCandidatePromoteWorkflow(parsed.warning!.next_action!);
      expect(parsed.record.conflict?.with).toEqual([existingId]);
      expect(parsed.record.conflict?.resolution).toBe("needs_review");
    });
  });

  it("requires explicit CLI confirmation for conflicting canonical promotion", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const candidate = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "candidate",
        "--text", "Use SQLite as the source of truth."
      ]);
      const candidateId = (JSON.parse(candidate.stdout) as { record: { id: string } }).record.id;
      const existing = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use append-only JSON events.",
        "--confirm"
      ]);
      const existingId = (JSON.parse(existing.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "promote",
          candidateId,
          "--state",
          "canonical",
          "--reason",
          "Agent inferred this replacement"
        ]);
        throw new Error("Expected moryn promote to require conflict confirmation");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(parsed.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "promote",
          command: `moryn promote ${candidateId} --state canonical --reason 'Agent inferred this replacement' --confirm`,
          arguments: {
            record_id: candidateId,
            target_state: "canonical",
            reason: "Agent inferred this replacement",
            confirmed: true
          },
          required_fields: [],
          safe_to_run: false
        });
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "promote",
        candidateId,
        "--state",
        "canonical",
        "--reason",
        "User confirmed",
        "--confirm"
      ]);
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id",
        candidateId
      ])).stdout) as { results: Array<{ record: { state: string; conflict?: { with: string[]; resolution: string } } }> };
      expect(recall.results[0]?.record.state).toBe("canonical");
      expect(recall.results[0]?.record.conflict?.with).toEqual([existingId]);
      expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
    });
  });

  it("requires explicit CLI confirmation for conflicting canonical revisions", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);
      const existing = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use append-only JSON events.",
        "--confirm"
      ]);
      const existingId = (JSON.parse(existing.stdout) as { record: { id: string } }).record.id;
      const target = await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "warning",
        "--scope", "project",
        "--project-id", "moryn",
        "--tag", "sync",
        "--state", "canonical",
        "--text", "Use private Git remotes.",
        "--confirm"
      ]);
      const targetId = (JSON.parse(target.stdout) as { record: { id: string } }).record.id;

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "revise",
          targetId,
          "--set", "type=decision",
          "--set", "content.text=Use SQLite as the source of truth.",
          "--reason", "Agent inferred this replacement"
        ]);
        throw new Error("Expected moryn revise to require conflict confirmation");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(parsed.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "revise",
          command: `moryn revise ${targetId} --set type=decision --set 'content.text=Use SQLite as the source of truth.' --reason 'Agent inferred this replacement' --confirm`,
          arguments: {
            record_id: targetId,
            patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
            reason: "Agent inferred this replacement",
            confirmed: true
          },
          required_fields: [],
          safe_to_run: false
        });
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "revise",
        targetId,
        "--set", "type=decision",
        "--set", "content.text=Use SQLite as the source of truth.",
        "--reason", "User confirmed",
        "--confirm"
      ]);
      const recall = JSON.parse((await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "recall",
        "--record-id",
        targetId
      ])).stdout) as { results: Array<{ record: { type: string; content: { text: string }; conflict?: { with: string[]; resolution: string } } }> };
      expect(recall.results[0]?.record.type).toBe("decision");
      expect(recall.results[0]?.record.content.text).toBe("Use SQLite as the source of truth.");
      expect(recall.results[0]?.record.conflict?.with).toEqual([existingId]);
      expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
    });
  });

  it("returns structured JSON errors before using an uninitialized store", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "missing-store");
      async function expectStoreNotInitialized(args: string[]): Promise<void> {
        try {
          await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, ...args]);
          throw new Error(`Expected moryn ${args.join(" ")} to fail before moryn init`);
        } catch (error) {
          if (!("stderr" in (error as object))) throw error;
          const stderr = (error as { stderr: string }).stderr;
          const parsed = JSON.parse(stderr) as {
            ok: boolean;
            error: {
              code: string;
              recoverable: boolean;
              recommended_action: string;
              next_action?: {
                recommended_action: string;
                tool: string;
                command: string;
                arguments: Record<string, unknown>;
                safe_to_run: boolean;
              };
            };
          };
          expect(parsed.ok).toBe(false);
          expect(parsed.error.code).toBe("STORE_NOT_INITIALIZED");
          expect(parsed.error.recoverable).toBe(true);
          expect(parsed.error.recommended_action).toBe("run moryn init");
          expect(parsed.error.next_action).toMatchObject({
            recommended_action: "initialize_store",
            tool: "init",
            command: "moryn init",
            arguments: {},
            required_fields: [],
            safe_to_run: false
          });
        }
      }

      await expectStoreNotInitialized([
        "boot",
        "--project-id",
        "moryn"
      ]);

      await expectStoreNotInitialized([
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--text", "This should not create a store implicitly."
      ]);
    });
  });

  it("returns sync remote errors while preserving local write and boot", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const missingRemote = join(dir, "missing-remote.git");
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "init"]);

      try {
        await exec("node", [
          "--import", "tsx", "src/cli.ts", "--store", store,
          "sync",
          "init",
          missingRemote
        ]);
        throw new Error("Expected moryn sync init to fail for an unavailable remote");
      } catch (error) {
        const stderr = (error as { stderr: string }).stderr;
        const parsed = JSON.parse(stderr) as {
          ok: boolean;
          error: {
            code: string;
            recoverable: boolean;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.error.code).toBe("SYNC_REMOTE_UNAVAILABLE");
        expect(parsed.error.recoverable).toBe(true);
        expect(parsed.error.recommended_action).toBe("continue locally and retry sync later");
        expect(parsed.error.next_action).toMatchObject({
          recommended_action: "check_sync_status_before_retrying_remote_operation",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
          safe_to_run: true
        });
      }

      await exec("node", [
        "--import", "tsx", "src/cli.ts", "--store", store,
        "write",
        "--kind", "memory",
        "--type", "decision",
        "--scope", "project",
        "--project-id", "moryn",
        "--state", "canonical",
        "--text", "Local memory survives remote sync failure."
      ]);
      const boot = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", store, "boot", "--project-id", "moryn"]);

      expect(boot.stdout).toContain("Local memory survives remote sync failure.");
    });
  });

  it("returns structured local lifecycle sync recovery details from the CLI", async () => {
    await withTempDir(async (dir) => {
      const store = join(dir, "store");
      const project = join(dir, "project");
      await exec("node", ["--import", tsxLoader, cliPath, "project", "init", "--path", project, "--project-id", "moryn"]);

      const start = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "start",
        "--project", project,
        "--agent", "codex",
        "--current-task", "work locally with recovery details"
      ]);
      const parsedStart = JSON.parse(start.stdout) as {
        sync: {
          pull_error?: string;
          pull_error_details?: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              safe_to_run: boolean;
            };
          };
        };
      };
      expect(parsedStart.sync.pull_error).toContain("Sync not configured");
      expect(parsedStart.sync.pull_error_details).toMatchObject({
        code: "SYNC_NOT_CONFIGURED",
        recommended_action: "run moryn sync init <remote>",
        next_action: {
          recommended_action: "configure_sync_remote",
          tool: "sync_init",
          command: "moryn sync init <remote>",
          arguments: { remote: "<remote>" },
          required_fields: ["remote"],
          argument_sources: {
            remote: "user_input.remote"
          },
          required_fields_by_name: {
            remote: {
              name: "remote",
              argument_path: "remote",
              placeholder: "<remote>",
              value: "<remote>"
            }
          },
          safe_to_run: false
        }
      });

      const finish = await exec("node", [
        "--import", tsxLoader, cliPath, "--store", store,
        "agent", "finish",
        "--project", project,
        "--agent", "codex",
        "--summary", "Local handoff with sync recovery details."
      ]);
      const parsedFinish = JSON.parse(finish.stdout) as {
        sync: {
          push_error?: string;
          push_error_details?: {
            code: string;
            recommended_action: string;
            next_action?: {
              recommended_action: string;
              tool: string;
              command: string;
              arguments: Record<string, unknown>;
              required_fields: string[];
              safe_to_run: boolean;
            };
          };
        };
      };
      expect(parsedFinish.sync.push_error).toContain("Sync not configured");
      expect(parsedFinish.sync.push_error_details).toMatchObject({
        code: "SYNC_NOT_CONFIGURED",
        recommended_action: "run moryn sync init <remote>",
        next_action: {
          recommended_action: "configure_sync_remote",
          tool: "sync_init",
          command: "moryn sync init <remote>",
          arguments: { remote: "<remote>" },
          required_fields: ["remote"],
          argument_sources: {
            remote: "user_input.remote"
          },
          safe_to_run: false
        }
      });
    });
  });
});
