import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  agentDoctor,
  agentEnter,
  agentFinish,
  agentGuide,
  agentStart,
  agentStatus
} from "../../src/core/agent-lifecycle.js";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { toErrorEnvelope } from "../../src/core/errors.js";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { buildHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { pendingLearningInbox, queueLearning } from "../../src/core/learning-inbox.js";
import { learningRecordIdentity } from "../../src/core/learning-ingestion.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { buildDashboardData } from "../../src/observability/dashboard.js";
import { initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);
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
  required_input_argument_path:
    "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path: "next.actions[].execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "next.actions_by_id.<action>.argument_sources.<field>",
  ordered_argument_source: "next.actions[].argument_sources.<field>"
};
const DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES = {
  lifecycle_action: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>",
  step: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.step",
  ordered_lifecycle_action: "next.actions_by_project_id.<project_id>.lifecycle[]",
  cli_executable: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.executable",
  cli_argv: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.argv[]",
  cli_args: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.args[]",
  cli_exec_file: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.exec_file",
  cli_placeholder: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.placeholders[]",
  cli_command_line: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.interfaces.cli.command_line",
  ordered_cli_executable: "next.actions_by_project_id.<project_id>.lifecycle[].interfaces.cli.executable",
  ordered_cli_argv: "next.actions_by_project_id.<project_id>.lifecycle[].interfaces.cli.argv[]",
  ordered_cli_args: "next.actions_by_project_id.<project_id>.lifecycle[].interfaces.cli.args[]",
  ordered_cli_exec_file: "next.actions_by_project_id.<project_id>.lifecycle[].interfaces.cli.exec_file",
  ordered_cli_placeholder: "next.actions_by_project_id.<project_id>.lifecycle[].interfaces.cli.placeholders[]",
  ordered_cli_command_line: "next.actions_by_project_id.<project_id>.lifecycle[].interfaces.cli.command_line",
  argument: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.arguments_by_name.<argument>",
  ordered_argument: "next.actions_by_project_id.<project_id>.lifecycle[].arguments_by_name.<argument>",
  required_field: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.required_fields_by_name.<field>",
  ordered_required_field: "next.actions_by_project_id.<project_id>.lifecycle[].required_fields_by_name.<field>",
  required_input:
    "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.execution.required_inputs_by_field.<field>",
  ordered_required_input:
    "next.actions_by_project_id.<project_id>.lifecycle[].execution.required_inputs_by_field.<field>",
  required_input_argument_path:
    "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path:
    "next.actions_by_project_id.<project_id>.lifecycle[].execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.argument_sources.<field>",
  ordered_argument_source: "next.actions_by_project_id.<project_id>.lifecycle[].argument_sources.<field>"
};
const BOOT_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  user_preference: "profile.user_preferences_by_id.<record_id>",
  soul: "profile.soul_by_id.<record_id>",
  global_rule: "profile.global_rules_by_id.<record_id>",
  important_decision: "project.important_decisions_by_id.<record_id>",
  warning: "project.warnings_by_id.<record_id>",
  skill: "skills_by_id.<record_id>",
  task_relevant: "task_relevant_by_id.<record_id>",
  recent_change: "recent_changes_by_id.<record_id>",
  active_checkpoint: "active_checkpoint",
  checkpoint_recovery_pack: "checkpoint_recovery_pack"
};

function withPhasesByName<TWorkflow extends { phases: Array<{ phase: string }> }>(workflow: TWorkflow) {
  return {
    ...workflow,
    phases_by_name: Object.fromEntries(workflow.phases.map((phase) => [phase.phase, phase]))
  };
}

async function eventFiles(storePath: string): Promise<string[]> {
  async function walk(dir: string, prefix = ""): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const files: string[] = [];
    for (const entry of entries) {
      const relative = prefix ? join(prefix, entry.name) : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walk(fullPath, relative)));
      } else {
        files.push(relative);
      }
    }
    return files;
  }
  return (await walk(join(storePath, "events"))).sort();
}

async function createSyncConflict(input: {
  remote: string;
  storeA: string;
  storeB: string;
  conflictFile: string;
}): Promise<void> {
  await initializeGitSync(input.storeA, input.remote);
  await initializeGitSync(input.storeB, input.remote);
  await mkdir(join(input.storeA, "events", "shared-device", "2026-05"), { recursive: true });
  await mkdir(join(input.storeB, "events", "shared-device", "2026-05"), { recursive: true });
  await writeFile(join(input.storeA, input.conflictFile), '{"from":"a"}\n', "utf8");
  await writeFile(join(input.storeB, input.conflictFile), '{"from":"b"}\n', "utf8");
  await exec("git", ["add", input.conflictFile], { cwd: input.storeA });
  await exec("git", ["commit", "-m", "device a conflicting event"], { cwd: input.storeA });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: input.storeA });
  await exec("git", ["add", input.conflictFile], { cwd: input.storeB });
  await exec("git", ["commit", "-m", "device b conflicting event"], { cwd: input.storeB });
  await expect(pullGitSync(input.storeB)).rejects.toThrow(/conflict/i);
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
  expect(action.workflow).toEqual(
    withPhasesByName({
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
    })
  );
}

function expectRefreshChangeNextAction(
  action: {
    action_source?: string;
    recommended_action: string;
    tool: string;
    command: string;
    arguments: Record<string, unknown>;
    arguments_by_name?: Record<string, unknown>;
    selection_sources?: Record<string, string>;
    safe_to_run: boolean;
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
  },
  recordId: string,
  projectId: string
) {
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
    action_source: `refresh.changes_by_record_id.${recordId}.next_action`,
    tool: "recall",
    safe_to_run: true,
    required_when: "After refresh reports this change and the agent needs the full record content.",
    required_fields: [],
    command: `moryn recall --record-id ${recordId} --project-id ${projectId}`,
    arguments: {
      record_ids: [recordId],
      project_id: projectId
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
      required_input_argument_path:
        "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
      ordered_required_input_argument_path:
        "refresh.changes[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
      argument_source: "refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>",
      ordered_argument_source: "refresh.changes[].next_action.argument_sources.<field>"
    }
  });
  expect(action.workflow).toEqual(
    withPhasesByName({
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
    })
  );
  expect(action.arguments_by_name?.record_ids).toMatchObject({
    name: "record_ids",
    type: "string[]",
    required: false,
    cli: { flag: "--record-id", repeatable: true },
    mcp: { argument: "record_ids" }
  });
  expectActionExecution(action);
}

function expectHandoffEntryNextAction(
  action: {
    action_source?: string;
    recommended_action: string;
    tool: string;
    command: string;
    arguments: Record<string, unknown>;
    arguments_by_name?: Record<string, unknown>;
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
  },
  recordId: string,
  projectId: string,
  source: "inbox" | "active_sessions" = "inbox"
) {
  const actionSource =
    source === "inbox"
      ? "handoff.inbox_by_record_id.<record_id>.next_action"
      : "handoff.active_sessions_by_record_id.<record_id>.next_action";
  const resolvedActionSource =
    source === "inbox"
      ? `handoff.inbox_by_record_id.${recordId}.next_action`
      : `handoff.active_sessions_by_record_id.${recordId}.next_action`;
  const recordIdSource =
    source === "inbox"
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
      entry:
        source === "inbox"
          ? "handoff.inbox_by_record_id.<record_id>"
          : "handoff.active_sessions_by_record_id.<record_id>",
      record_id: recordIdSource,
      next_action: actionSource,
      ordered_next_action: source === "inbox" ? "handoff.inbox[].next_action" : "handoff.active_sessions[].next_action",
      argument: `${actionSource}.arguments_by_name.<argument>`,
      ordered_argument:
        source === "inbox"
          ? "handoff.inbox[].next_action.arguments_by_name.<argument>"
          : "handoff.active_sessions[].next_action.arguments_by_name.<argument>",
      required_field: `${actionSource}.required_fields_by_name.<field>`,
      ordered_required_field:
        source === "inbox"
          ? "handoff.inbox[].next_action.required_fields_by_name.<field>"
          : "handoff.active_sessions[].next_action.required_fields_by_name.<field>",
      required_input: `${actionSource}.execution.required_inputs_by_field.<field>`,
      ordered_required_input:
        source === "inbox"
          ? "handoff.inbox[].next_action.execution.required_inputs_by_field.<field>"
          : "handoff.active_sessions[].next_action.execution.required_inputs_by_field.<field>",
      required_input_argument_path: `${actionSource}.execution.required_inputs_by_argument_path.<argument_path>`,
      ordered_required_input_argument_path:
        source === "inbox"
          ? "handoff.inbox[].next_action.execution.required_inputs_by_argument_path.<argument_path>"
          : "handoff.active_sessions[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
      argument_source: `${actionSource}.argument_sources.<field>`,
      ordered_argument_source:
        source === "inbox"
          ? "handoff.inbox[].next_action.argument_sources.<field>"
          : "handoff.active_sessions[].next_action.argument_sources.<field>"
    },
    interfaces: {
      cli: {
        command: `moryn recall --record-id ${recordId} --project-id ${projectId}`,
        argv: ["recall", "--record-id", recordId, "--project-id", projectId],
        executable: "moryn",
        args: ["recall", "--record-id", recordId, "--project-id", projectId]
      },
      mcp: {
        tool: "recall",
        arguments: {
          record_ids: [recordId],
          project_id: projectId
        }
      }
    },
    safety: {
      safe_to_auto_run: true,
      requires_user_confirmation: false,
      requires_authored_input: false,
      writes_local_config: false,
      reasons: ["safe_read_or_status_check"]
    }
  });
  expect(action.workflow).toEqual(
    withPhasesByName({
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
    })
  );
  expect(action.arguments_by_name?.record_ids).toMatchObject({
    name: "record_ids",
    type: "string[]",
    required: false,
    cli: { flag: "--record-id", repeatable: true },
    mcp: { argument: "record_ids" }
  });
  expectActionExecution(action);
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
    required_inputs?: Array<{
      field?: string;
      argument_path?: string;
      argument_paths?: string[];
      mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>;
      cli_targets?: Array<{
        flag?: string;
        flags?: string[];
        positional?: string;
        type?: string;
        required?: boolean;
        repeatable?: boolean;
        preferred?: boolean;
      }>;
    }>;
    required_inputs_by_field?: Record<
      string,
      {
        field?: string;
        argument_path?: string;
        argument_paths?: string[];
        mcp_targets?: Array<{
          argument?: string;
          path?: string;
          type?: string;
          required?: boolean;
          preferred?: boolean;
        }>;
        cli_targets?: Array<{
          flag?: string;
          flags?: string[];
          positional?: string;
          type?: string;
          required?: boolean;
          repeatable?: boolean;
          preferred?: boolean;
        }>;
      }
    >;
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
    required_inputs?: Array<{
      field?: string;
      argument_path?: string;
      argument_paths?: string[];
      selection_sources?: Record<string, string>;
      mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>;
      cli_targets?: Array<{
        flag?: string;
        flags?: string[];
        positional?: string;
        type?: string;
        required?: boolean;
        repeatable?: boolean;
        preferred?: boolean;
      }>;
    }>;
    required_inputs_by_field?: Record<
      string,
      {
        field?: string;
        argument_path?: string;
        argument_paths?: string[];
        selection_sources?: Record<string, string>;
        mcp_targets?: Array<{
          argument?: string;
          path?: string;
          type?: string;
          required?: boolean;
          preferred?: boolean;
        }>;
        cli_targets?: Array<{
          flag?: string;
          flags?: string[];
          positional?: string;
          type?: string;
          required?: boolean;
          repeatable?: boolean;
          preferred?: boolean;
        }>;
      }
    >;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  const expectedArgumentPaths = action.required_fields.map(
    (field) => action.required_fields_by_name[field]?.argument_path ?? field
  );
  const expectedSplitArgumentPaths = expectedArgumentPaths.map((argumentPath) =>
    argumentPath
      .split("|")
      .map((path) => path.trim())
      .filter(Boolean)
  );
  expect(action.execution?.missing_required_fields).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.field)).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.execution?.required_inputs?.map((input) => input.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(Object.keys(action.execution?.required_inputs_by_field ?? {})).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.field)).toEqual(
    action.required_fields
  );
  expect(
    action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_path)
  ).toEqual(expectedArgumentPaths);
  expect(
    action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_paths)
  ).toEqual(expectedSplitArgumentPaths);
  expect(
    action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.mcp_targets)
  ).toEqual(action.execution?.required_inputs?.map((input) => input.mcp_targets));
  expect(
    action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.cli_targets)
  ).toEqual(action.execution?.required_inputs?.map((input) => input.cli_targets));
  const expectedRequiredInputSelectionSources = Object.fromEntries(
    Object.entries(action.selection_sources ?? {}).filter(([key]) => key.includes("required_input"))
  );
  if (action.required_fields.length > 0 && Object.keys(expectedRequiredInputSelectionSources).length > 0) {
    expect(action.execution?.required_inputs?.map((input) => input.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
    expect(
      action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.selection_sources)
    ).toEqual(action.required_fields.map(() => expectedRequiredInputSelectionSources));
  }
  expect(action.execution?.requires_user_confirmation).toBe(Boolean(action.safety?.requires_user_confirmation));
  if (action.required_fields.length > 0) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields",
      blocked_by: ["required_fields", ...(action.safety?.requires_user_confirmation ? ["user_confirmation"] : [])]
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

function expectDiscoveredLifecycleStepSelectionSources(action: {
  step?: string;
  action_source?: string;
  project_id?: string;
  arguments?: { project_id?: unknown };
  selection_sources?: Record<string, string>;
  safe_to_run?: boolean;
  required_fields?: string[];
  required_fields_by_name?: Record<string, { argument_path?: string }>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    blocked_by?: string[];
    missing_required_fields?: string[];
    required_inputs?: Array<{
      field?: string;
      argument_path?: string;
      argument_paths?: string[];
      mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>;
      cli_targets?: Array<{
        flag?: string;
        flags?: string[];
        positional?: string;
        type?: string;
        required?: boolean;
        repeatable?: boolean;
        preferred?: boolean;
      }>;
    }>;
    required_inputs_by_field?: Record<
      string,
      {
        field?: string;
        argument_path?: string;
        argument_paths?: string[];
        mcp_targets?: Array<{
          argument?: string;
          path?: string;
          type?: string;
          required?: boolean;
          preferred?: boolean;
        }>;
        cli_targets?: Array<{
          flag?: string;
          flags?: string[];
          positional?: string;
          type?: string;
          required?: boolean;
          repeatable?: boolean;
          preferred?: boolean;
        }>;
      }
    >;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  const projectId =
    typeof action.project_id === "string"
      ? action.project_id
      : typeof action.arguments?.project_id === "string"
        ? action.arguments.project_id
        : "<project_id>";
  if (typeof action.step === "string") {
    expect(action.action_source).toBe(`next.actions_by_project_id.${projectId}.lifecycle_by_step.${action.step}`);
  }
  expect(action.selection_sources).toEqual(DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES);
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

describe("agent lifecycle", () => {
  it("agent finish automatically consumes pending Learning Inbox items", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-learning-inbox-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_codex" });
      const source = { client: "codex", session_id: "learn-session", device_id: "device_codex" };
      const queued = await queueLearning(store, {
        project_id: "moryn",
        question: "How is learned context preserved?",
        conclusion: "Agent finish consumes durable Learning Inbox items.",
        evidence_type: "source_code",
        source,
        occurred_at: "2026-07-11T00:00:00.000Z"
      });

      const result = await agentFinish(
        {
          storePath: store,
          projectPath: project,
          agent: source,
          summary: "Finished Learning Inbox verification.",
          push: false
        },
        { now: () => "2026-07-11T00:01:00.000Z" }
      );

      expect(result).toMatchObject({
        learning_ingestion: { learnings_received: 1, records_created: 1 },
        learning_inbox: { selected: 1, consumed: 1, already_consumed: 0, inbox_record_ids: [queued.record.id] }
      });
      expect(await pendingLearningInbox(store, { project_id: "moryn" })).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid required lifecycle text with operation contract recovery hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-invalid-text-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_codex" });

      for (const { action, operation, argument } of [
        {
          action: () =>
            agentStatus({
              storePath: store,
              projectPath: project,
              agent: { client: "codex" },
              status: 123 as never
            }),
          operation: "agent_status",
          argument: "status"
        },
        {
          action: () =>
            agentFinish({
              storePath: store,
              projectPath: project,
              agent: { client: "codex" },
              summary: 123 as never
            }),
          operation: "agent_finish",
          argument: "summary"
        }
      ] as const) {
        try {
          await action();
          throw new Error(`Expected ${operation} to reject invalid ${argument}`);
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain(`Invalid ${argument}`);
          expect(envelope.error.recommended_action).toBe(`retry agent lifecycle with a non-empty ${argument}`);
          expect(envelope.error.recovery_hint).toEqual({
            operation_contract: `operations_by_id.${operation}`,
            rejected_argument: { argument, value: 123 },
            expected: { kind: "non_empty_string", min_length: 1 },
            argument_sources: {
              [argument]: `operations_by_id.${operation}.arguments_by_name.${argument}`
            },
            retry_with: { argument, value_placeholder: `<${argument}>` }
          });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid lifecycle current task with operation contract recovery hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-invalid-task-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_codex" });

      for (const { action, operation } of [
        {
          action: () =>
            agentDoctor({
              storePath: store,
              projectPath: project,
              currentTask: 123 as never
            }),
          operation: "agent_doctor"
        },
        {
          action: () =>
            agentGuide({
              storePath: store,
              projectPath: project,
              currentTask: 123 as never
            }),
          operation: "agent_guide"
        },
        {
          action: () =>
            agentEnter({
              storePath: store,
              projectPath: project,
              currentTask: 123 as never
            }),
          operation: "agent_enter"
        },
        {
          action: () =>
            agentStart({
              storePath: store,
              projectPath: project,
              currentTask: 123 as never
            }),
          operation: "agent_start"
        },
        {
          action: () =>
            agentStatus({
              storePath: store,
              projectPath: project,
              currentTask: 123 as never,
              status: "working"
            }),
          operation: "agent_status"
        },
        {
          action: () =>
            agentFinish({
              storePath: store,
              projectPath: project,
              currentTask: 123 as never,
              summary: "done"
            }),
          operation: "agent_finish"
        }
      ] as const) {
        try {
          await action();
          throw new Error(`Expected ${operation} to reject invalid current_task`);
        } catch (error) {
          const envelope = toErrorEnvelope(error);
          expect(envelope.error.code).toBe("INVALID_ARGUMENT");
          expect(envelope.error.message).toContain("Invalid current_task");
          expect(envelope.error.recommended_action).toBe("retry agent lifecycle with a non-empty current_task");
          expect(envelope.error.recovery_hint).toEqual({
            operation_contract: `operations_by_id.${operation}`,
            rejected_argument: { argument: "current_task", value: 123 },
            expected: { kind: "non_empty_string", min_length: 1 },
            argument_sources: {
              current_task: `operations_by_id.${operation}.arguments_by_name.current_task`
            },
            retry_with: { argument: "current_task", value_placeholder: "<current_task>" }
          });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pulls, boots, refreshes, writes a handoff, and pushes across two device stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, {
        project_id: "moryn",
        tags: ["typescript"],
        default_skills: ["release"]
      });
      await initializeStore(storeA, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_codex" });
      await initializeStore(storeB, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_gemini" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const codexFinish = await agentFinish(
        {
          storePath: storeA,
          projectPath: project,
          agent: { client: "codex", device_id: "device_codex", session_id: "codex-1" },
          summary: "Codex finished lifecycle wiring and left a Gemini handoff.",
          learnings: [
            {
              question: "When does Moryn pull?",
              conclusion: "Moryn pulls on agent enter.",
              evidence_type: "source_code",
              scope: "project",
              confidence: 0.9,
              recommended_kind: "memory",
              recommended_type: "fact",
              related_record_ids: []
            }
          ],
          push: true
        },
        { now: () => "2026-07-11T00:00:00.000Z" }
      );

      expect(codexFinish.project.project_id).toBe("moryn");
      expect(codexFinish.record.content.text).toBe("Codex finished lifecycle wiring and left a Gemini handoff.");
      expect(codexFinish.learning_ingestion).toMatchObject({
        records_created: 1,
        dispositions: [{ state: "canonical" }]
      });
      expect(codexFinish.sync.push?.pushed).toBe(true);
      expect(codexFinish.next.recommended_start_command).toBe(
        "moryn agent start --project <path> --current-task <task>"
      );
      expect(codexFinish.next.recommended_start_action_id).toBe("start_next_session");
      expect(codexFinish.next.recommended_start_action_source).toBe("next.actions_by_id.start_next_session");
      expect(codexFinish.next.selection_sources).toEqual({
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
        action_required_input_argument_path:
          "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(codexFinish.next.actions).toContainEqual(
        expect.objectContaining({
          action: "start_next_session",
          tool: "agent_start",
          safe_to_run: true,
          command: expect.stringMatching(/moryn agent start.*--current-task <current_task>/),
          required_when: "When another agent or device should start the next session from this handoff.",
          required_fields: ["current_task"],
          argument_sources: {
            current_task: "user_input.current_task"
          },
          arguments: expect.objectContaining({
            project_path: project,
            current_task: "<current_task>",
            agent: { client: "codex", device_id: "device_codex", session_id: "codex-1" }
          })
        })
      );
      expect(codexFinish.next.actions_by_id.start_next_session).toEqual(
        codexFinish.next.actions.find((action) => action.action === "start_next_session")
      );
      for (const action of codexFinish.next.actions) {
        expectLifecycleActionSelectionSources(action);
      }
      expectLifecycleActionSelectionSources(codexFinish.next.actions_by_id.start_next_session);
      expect(codexFinish.next.actions_by_id[codexFinish.next.recommended_start_action_id]).toEqual(
        codexFinish.next.actions_by_id.start_next_session
      );

      const geminiStart = await agentStart({
        storePath: storeB,
        projectPath: project,
        currentTask: "continue lifecycle wiring",
        agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" },
        pull: true,
        refreshSince: "2026-05-27T00:00:00.000Z"
      });

      expect(geminiStart.project).toMatchObject({
        project_id: "moryn",
        source: "config",
        sync_mode: "session"
      });
      expect(geminiStart.sync.pull?.pulled).toBe(true);
      expect(geminiStart.boot.selection_sources).toEqual(BOOT_SELECTION_SOURCES);
      expect(geminiStart.boot.recent_changes_by_id[codexFinish.record.id]).toEqual(
        geminiStart.boot.recent_changes.find((record) => record.id === codexFinish.record.id)
      );
      expect(geminiStart.refresh.changes).toContainEqual(
        expect.objectContaining({
          importance: "notice",
          summary: "Codex finished lifecycle wiring and left a Gemini handoff.",
          recommended_action: "call recall with record_id",
          next_action: expect.any(Object)
        })
      );
      expect(geminiStart.refresh.changes).toContainEqual(
        expect.objectContaining({
          importance: "notice",
          summary: "Moryn pulls on agent enter.",
          recommended_action: "call recall with record_id",
          next_action: expect.any(Object)
        })
      );
      const handoffChange = geminiStart.refresh.changes_by_record_id[codexFinish.record.id]!;
      expect(handoffChange).toEqual(
        geminiStart.refresh.changes.find((change) => change.record_id === codexFinish.record.id)
      );
      expect(geminiStart.refresh.selection_sources).toEqual({
        change: "changes_by_record_id.<record_id>",
        record_id: "changes_by_record_id.<record_id>.record_id",
        next_action: "changes_by_record_id.<record_id>.next_action"
      });
      expectRefreshChangeNextAction(handoffChange.next_action, codexFinish.record.id, "moryn");
      expect(geminiStart.refresh.changes_by_record_id[codexFinish.record.id]!.next_action).toEqual(
        handoffChange.next_action
      );
      expect(geminiStart.handoff).toMatchObject({
        inbox: [
          {
            record_id: codexFinish.record.id,
            type: "summary",
            text: "Codex finished lifecycle wiring and left a Gemini handoff.",
            agent: { client: "codex", device_id: "device_codex", session_id: "codex-1" },
            recommended_action: "review_handoff_summary",
            next_action: expect.any(Object)
          }
        ],
        active_sessions: []
      });
      expect(geminiStart.handoff.inbox_by_record_id[codexFinish.record.id]).toEqual(geminiStart.handoff.inbox[0]);
      expect(geminiStart.handoff.selection_sources).toEqual({
        inbox_entry: "handoff.inbox_by_record_id.<record_id>",
        inbox_record_id: "handoff.inbox_by_record_id.<record_id>.record_id",
        inbox_next_action: "handoff.inbox_by_record_id.<record_id>.next_action",
        inbox_next_action_cli_executable:
          "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.executable",
        inbox_next_action_cli_argv: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
        inbox_next_action_cli_args: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
        inbox_next_action_cli_exec_file: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
        inbox_next_action_cli_placeholder:
          "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
        inbox_next_action_cli_command_line:
          "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
        inbox_next_action_argument: "handoff.inbox_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        inbox_next_action_required_field:
          "handoff.inbox_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        inbox_next_action_required_input:
          "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        inbox_next_action_required_input_argument_path:
          "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
        inbox_next_action_argument_source:
          "handoff.inbox_by_record_id.<record_id>.next_action.argument_sources.<field>",
        recovered_status_entry: "handoff.recovered_statuses_by_record_id.<record_id>",
        recovered_status_record_id: "handoff.recovered_statuses_by_record_id.<record_id>.record_id",
        active_session_entry: "handoff.active_sessions_by_record_id.<record_id>",
        active_session_record_id: "handoff.active_sessions_by_record_id.<record_id>.record_id",
        active_session_next_action: "handoff.active_sessions_by_record_id.<record_id>.next_action",
        active_session_next_action_cli_executable:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.executable",
        active_session_next_action_cli_argv:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
        active_session_next_action_cli_args:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
        active_session_next_action_cli_exec_file:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
        active_session_next_action_cli_placeholder:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
        active_session_next_action_cli_command_line:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
        active_session_next_action_argument:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        active_session_next_action_required_field:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        active_session_next_action_required_input:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        active_session_next_action_required_input_argument_path:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
        active_session_next_action_argument_source:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.argument_sources.<field>"
      });
      expect(geminiStart.handoff.active_sessions_by_record_id).toEqual({});
      expectHandoffEntryNextAction(geminiStart.handoff.inbox[0]!.next_action, codexFinish.record.id, "moryn");
      expect(geminiStart.handoff.inbox_by_record_id[codexFinish.record.id]!.next_action).toEqual(
        geminiStart.handoff.inbox[0]!.next_action
      );
      expect(geminiStart.handoff.next_action).toEqual(geminiStart.handoff.inbox[0]!.next_action);
      expectHandoffEntryNextAction(geminiStart.handoff.next_action!, codexFinish.record.id, "moryn");
      expect(geminiStart.boot.recent_changes.map((record) => record.content.text)).toContain(
        "Codex finished lifecycle wiring and left a Gemini handoff."
      );
      expect(geminiStart.next.required_end_action).toBe("call agent_finish with a session_summary");
      expect(geminiStart.next.required_end_action_id).toBe("finish_session");
      expect(geminiStart.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
      expect(geminiStart.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(geminiStart.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(geminiStart.next.selection_sources).toEqual({
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
        action_required_input_argument_path:
          "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(geminiStart.next.actions).toContainEqual(
        expect.objectContaining({
          action: "publish_status",
          tool: "agent_status",
          safe_to_run: true,
          command: expect.stringContaining("moryn agent status"),
          required_when:
            "During meaningful long-running work, before interruption, or when another agent may need coordination.",
          required_fields: ["status"],
          argument_sources: {
            status: "agent_authored.status"
          },
          execution: expect.objectContaining({
            ready_to_run: false,
            next_step: "collect_required_fields",
            blocked_by: ["required_fields"],
            requires_user_confirmation: false
          }),
          arguments: expect.objectContaining({
            project_path: project,
            status: "<status>",
            current_task: "continue lifecycle wiring",
            agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
          })
        })
      );
      expect(geminiStart.next.actions).toContainEqual(
        expect.objectContaining({
          action: "finish_session",
          tool: "agent_finish",
          safe_to_run: true,
          command: expect.stringContaining("moryn agent finish"),
          required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
          required_fields: ["summary"],
          argument_sources: {
            summary: "agent_authored.summary"
          },
          execution: expect.objectContaining({
            ready_to_run: false,
            next_step: "collect_required_fields",
            blocked_by: ["required_fields"],
            requires_user_confirmation: false
          }),
          arguments: expect.objectContaining({
            project_path: project,
            summary: "<summary>",
            current_task: "continue lifecycle wiring",
            agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
          })
        })
      );
      expect(geminiStart.next.actions).toContainEqual(
        expect.objectContaining({
          action: "refresh_context",
          tool: "agent_start",
          safe_to_run: true,
          command: expect.stringContaining("--refresh-since"),
          required_when:
            "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
          required_fields: [],
          argument_sources: {
            refresh_since: "refresh.cursor"
          },
          arguments: expect.objectContaining({
            project_path: project,
            refresh_since: geminiStart.refresh.cursor,
            current_task: "continue lifecycle wiring",
            agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
          })
        })
      );
      expect(geminiStart.next.actions_by_id.publish_status).toEqual(
        geminiStart.next.actions.find((action) => action.action === "publish_status")
      );
      expect(geminiStart.next.actions_by_id.finish_session).toEqual(
        geminiStart.next.actions.find((action) => action.action === "finish_session")
      );
      expect(geminiStart.next.actions_by_id.refresh_context).toEqual(
        geminiStart.next.actions.find((action) => action.action === "refresh_context")
      );
      for (const action of geminiStart.next.actions) {
        expectLifecycleActionSelectionSources(action);
      }
      expectLifecycleActionSelectionSources(geminiStart.next.actions_by_id.publish_status);
      expectLifecycleActionSelectionSources(geminiStart.next.actions_by_id.finish_session);
      expectLifecycleActionSelectionSources(geminiStart.next.actions_by_id.refresh_context);
      expect(geminiStart.next.actions_by_id[geminiStart.next.required_end_action_id]).toEqual(
        geminiStart.next.actions_by_id.finish_session
      );
      expect(geminiStart.next.actions_by_id[geminiStart.next.recommended_refresh_action_id]).toEqual(
        geminiStart.next.actions_by_id.refresh_context
      );
      expect(geminiStart.next.workflow.phases.map((phase) => phase.action_source)).toEqual([
        "boot+refresh+handoff",
        "next.actions_by_id.publish_status",
        "next.actions_by_id.finish_session",
        "next.actions_by_id.refresh_context"
      ]);

      const geminiFinish = await agentFinish({
        storePath: storeB,
        projectPath: project,
        agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" },
        summary: "Gemini picked up the Codex handoff and continued lifecycle wiring.",
        push: true
      });
      expect(geminiFinish.sync.push?.pushed).toBe(true);

      await pullGitSync(storeA);
      const codexEngine = createEngine({ storePath: storeA });
      const recall = await codexEngine.recall({
        query: "Gemini picked up",
        project_id: "moryn",
        kinds: ["session_summary"]
      });
      expect(recall.results[0]?.record.content.text).toBe(
        "Gemini picked up the Codex handoff and continued lifecycle wiring."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("keeps lifecycle usable locally when Git sync is not configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-local-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_local" });

      const start = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "work locally",
        agent: { client: "codex", device_id: "device_local" }
      });
      expect(start.ok).toBe(true);
      expect(start.sync.before?.configured).toBe(false);
      expect(start.sync.pull_error).toContain("Sync not configured");
      expect(start.sync.pull_error_details).toMatchObject({
        code: "SYNC_NOT_CONFIGURED",
        recommended_action: "run moryn sync init <remote>",
        recovery_hint: {
          missing_argument: { argument: "remote", placeholder: "<remote>" },
          expected: {
            kind: "git_remote",
            source: "user_input.remote"
          },
          retry_with: {
            tool: "sync_init",
            command: "moryn sync init <remote>",
            arguments: { remote: "<remote>" },
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: [
            "invent_git_remote",
            "write_sync_config_without_user_confirmation",
            "retry_sync_until_remote_is_configured"
          ]
        },
        next_action: {
          recommended_action: "configure_sync_remote",
          tool: "sync_init",
          command: "moryn sync init <remote>",
          arguments: { remote: "<remote>" },
          safe_to_run: false
        }
      });
      expect(start.boot.project.important_decisions).toEqual([]);

      const finish = await agentFinish({
        storePath: store,
        projectPath: project,
        agent: { client: "codex", device_id: "device_local" },
        summary: "Local-only lifecycle handoff was recorded."
      });
      expect(finish.ok).toBe(true);
      expect(finish.sync.push_error).toContain("Sync not configured");
      expect(finish.sync.push_error_details).toMatchObject({
        code: "SYNC_NOT_CONFIGURED",
        recommended_action: "run moryn sync init <remote>",
        recovery_hint: {
          missing_argument: { argument: "remote", placeholder: "<remote>" },
          expected: {
            kind: "git_remote",
            source: "user_input.remote"
          },
          retry_with: {
            tool: "sync_init",
            command: "moryn sync init <remote>",
            arguments: { remote: "<remote>" },
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: [
            "invent_git_remote",
            "write_sync_config_without_user_confirmation",
            "retry_sync_until_remote_is_configured"
          ]
        },
        next_action: {
          recommended_action: "configure_sync_remote",
          tool: "sync_init",
          command: "moryn sync init <remote>",
          arguments: { remote: "<remote>" },
          safe_to_run: false
        }
      });

      const engine = createEngine({ storePath: store });
      const recall = await engine.recall({
        query: "Local-only lifecycle",
        project_id: "moryn",
        kinds: ["session_summary"]
      });
      expect(recall.results[0]?.record.id).toBe(finish.record.id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("consolidates finish learnings before pushing the handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-finish-consolidation-"));
    const storePath = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storePath, { id: () => "device-codex" });
      const engine = createEngine({ storePath });
      const target = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn pulls on agent enter." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "When does Moryn pull?",
        conclusion: "Moryn pulls when an agent enters.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 0.9,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const sourceRecordId = learningRecordIdentity({ project_id: "moryn", learning }).record_id;

      const result = await agentFinish(
        {
          storePath,
          projectPath: project,
          agent: { client: "codex", device_id: "device-codex", session_id: "codex-finish" },
          summary: "Lifecycle consolidation complete.",
          learnings: [learning],
          semanticConsolidationProposals: [
            {
              proposal_id: "finish-proposal",
              source_record_id: sourceRecordId,
              target_record_id: target.record.id,
              relationship: "duplicate_of",
              confidence: 0.99,
              rationale: "Equivalent lifecycle fact.",
              semantic_equivalence: "equivalent",
              material_differences: [],
              evidence_record_ids: []
            }
          ],
          push: false
        },
        { now: () => "2026-07-12T00:00:00.000Z" }
      );

      expect(result.semantic_consolidation.proposal_results).toEqual([expect.objectContaining({ status: "accepted" })]);
      expect(result).toMatchObject({
        learning_ingestion: { records_created: 1 },
        semantic_consolidation: { proposals_received: 1, proposals_accepted: 1, links_created: 1 }
      });
      expect(result.next.actions_by_id.review_learning_candidates).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects unresolved learning candidates as an agent-owned recall workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-finish-candidate-review-"));
    const storePath = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storePath, { id: () => "device-codex" });
      const engine = createEngine({ storePath });
      const target = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn pulls project context when an agent enters the repository." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const result = await agentFinish(
        {
          storePath,
          projectPath: project,
          currentTask: "Document lifecycle context loading",
          agent: { client: "codex", device_id: "device-codex", session_id: "codex-candidate-review" },
          summary: "Documented the lifecycle context loading behavior.",
          learnings: [
            {
              question: "When is project context loaded?",
              conclusion: "Moryn loads project context during agent enter before work begins.",
              evidence_type: "source_code",
              scope: "project",
              confidence: 0.9,
              recommended_kind: "memory",
              recommended_type: "fact",
              related_record_ids: []
            }
          ],
          push: false
        },
        { now: () => "2026-07-13T00:00:00.000Z" }
      );

      expect(result.next.actions_by_id.review_learning_candidates).toMatchObject({
        action: "review_learning_candidates",
        tool: "recall",
        owner: "agent",
        safe_to_run: true,
        required_fields: [],
        safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          requires_authored_input: false
        },
        candidate_pairs: [
          {
            source_record_id: result.learning_ingestion.dispositions[0]?.record_id,
            candidate_record_id: target.record.id,
            source_recall: {
              tool: "recall",
              arguments: { project_id: "moryn", record_ids: [result.learning_ingestion.dispositions[0]?.record_id] }
            },
            candidate_recall: {
              tool: "recall",
              arguments: { project_id: "moryn", record_ids: [target.record.id] }
            }
          }
        ],
        after_recall: {
          tool: "consolidate_semantic",
          allowed_relationships: ["duplicate_of", "revises", "supersedes", "conflicts_with"],
          no_relationship_is_valid: true
        }
      });
      expect(result.next.actions).toContainEqual(result.next.actions_by_id.review_learning_candidates);
      expect(JSON.stringify(result.next.actions_by_id.review_learning_candidates)).not.toContain(
        target.record.content.text
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stays quiet when finish learning is automatically folded as a duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-finish-auto-duplicate-"));
    const storePath = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storePath, { id: () => "device-codex" });
      const engine = createEngine({ storePath });
      await engine.ingestLearnings({
        project_id: "moryn",
        occurred_at: "2026-07-13T00:04:00.000Z",
        source: { client: "codex" },
        learnings: [
          {
            question: "When does Moryn pull project memory?",
            conclusion: "When an agent enters a project, Moryn automatically pulls the project memory.",
            evidence_type: "source_code",
            scope: "project",
            confidence: 0.95,
            recommended_kind: "memory",
            recommended_type: "fact",
            related_record_ids: []
          }
        ]
      });

      const result = await agentFinish(
        {
          storePath,
          projectPath: project,
          currentTask: "Verify checkpoint restore",
          agent: { client: "claude-code", device_id: "device-claude", session_id: "claude-auto-duplicate" },
          summary: "Verified checkpoint restore.",
          learnings: [
            {
              question: "How does project entry load memory?",
              conclusion: "Moryn automatically pulls project memory when an agent enters the project.",
              evidence_type: "source_code",
              scope: "project",
              confidence: 0.99,
              recommended_kind: "memory",
              recommended_type: "fact",
              related_record_ids: []
            }
          ],
          push: false
        },
        { now: () => "2026-07-13T00:05:00.000Z" }
      );

      expect(result.learning_ingestion).toMatchObject({
        records_created: 1,
        automatic_consolidation: { links_created: 1, accepted_by_relationship: { duplicate_of: 1 } },
        semantic_candidates: { candidates: [] }
      });
      expect(result.next.actions_by_id.review_learning_candidates).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps finish handoff durable when semantic consolidation persistence fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-finish-consolidation-failure-"));
    const storePath = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storePath, { id: () => "device-codex" });
      const target = await createEngine({ storePath }).write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn pulls on agent enter." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "When does Moryn pull?",
        conclusion: "Moryn pulls when an agent enters.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 0.9,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const sourceRecordId = learningRecordIdentity({ project_id: "moryn", learning }).record_id;
      const result = await agentFinish(
        {
          storePath,
          projectPath: project,
          agent: { client: "codex", session_id: "codex-failure" },
          summary: "Handoff remains durable.",
          learnings: [learning],
          semanticConsolidationProposals: [
            {
              proposal_id: "finish-failure",
              source_record_id: sourceRecordId,
              target_record_id: target.record.id,
              relationship: "duplicate_of",
              confidence: 0.99,
              rationale: "Equivalent lifecycle fact.",
              semantic_equivalence: "equivalent",
              material_differences: [],
              evidence_record_ids: []
            }
          ],
          push: false
        },
        {
          now: () => "2026-07-12T00:00:00.000Z",
          createEngine: (deps) =>
            createEngine({
              ...deps,
              appendEventIfAbsent: async (path, event) => {
                if (event.event_id.startsWith("evt_semantic_consolidation_")) throw new Error("semantic disk failure");
                return appendEventIfAbsent(path, event);
              }
            })
        }
      );

      expect(result).toMatchObject({
        ok: true,
        record: { content: { text: "Handoff remains durable." } },
        learning_ingestion: { records_created: 1 },
        semantic_consolidation: {
          proposals_received: 1,
          proposals_rejected: 1,
          rejected_by_reason: { persistence_failed: 1 }
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps a fresh device store and sync remote from agent lifecycle input", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-bootstrap-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });

      const firstFinish = await agentFinish({
        storePath: storeA,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "codex", device_id: "device_codex" },
        summary: "Fresh Codex device bootstrapped Moryn and pushed a handoff."
      });

      expect(firstFinish.bootstrap.initialized_store).toBe(true);
      expect(firstFinish.bootstrap.sync_init?.ok).toBe(true);
      expect(firstFinish.sync.push?.pushed).toBe(true);

      const firstStart = await agentStart({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "gemini", device_id: "device_gemini" },
        currentTask: "continue after fresh device bootstrap",
        refreshSince: "2000-01-01T00:00:00.000Z"
      });

      expect(firstStart.bootstrap.initialized_store).toBe(true);
      expect(firstStart.bootstrap.sync_init?.ok).toBe(true);
      expect(firstStart.sync.pull?.pulled).toBe(true);
      expect(firstStart.refresh.changes).toContainEqual(
        expect.objectContaining({
          summary: "Fresh Codex device bootstrapped Moryn and pushed a handoff.",
          importance: "notice"
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("shares in-progress agent status across fresh device stores", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-status-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-codex");
    const storeB = join(root, "store-gemini");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });

      const status = await agentStatus({
        storePath: storeA,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "codex", session_id: "codex-status" },
        status: "Codex is refactoring lifecycle status propagation.",
        currentTask: "lifecycle status propagation"
      });

      expect(status.bootstrap.initialized_store).toBe(true);
      expect(status.record).toMatchObject({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: expect.objectContaining({
          text: "Codex is refactoring lifecycle status propagation.",
          current_task: "lifecycle status propagation"
        })
      });
      expect(status.sync.push?.pushed).toBe(true);
      expect(status.next.recommended_finish_action_id).toBe("finish_session");
      expect(status.next.recommended_finish_action_source).toBe("next.actions_by_id.finish_session");
      expect(status.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(status.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(status.next.actions).toContainEqual(
        expect.objectContaining({
          action: "finish_session",
          tool: "agent_finish",
          safe_to_run: true,
          command: expect.stringContaining("moryn agent finish"),
          required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
          required_fields: ["summary"],
          argument_sources: {
            summary: "agent_authored.summary"
          },
          arguments: expect.objectContaining({
            project_path: project,
            sync_remote: remote,
            current_task: "lifecycle status propagation"
          })
        })
      );
      expect(status.next.actions).toContainEqual(
        expect.objectContaining({
          action: "refresh_context",
          tool: "agent_start",
          safe_to_run: true,
          command: expect.stringContaining("moryn agent start"),
          required_when:
            "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
          required_fields: [],
          argument_sources: {
            refresh_since: "record.updated_at"
          },
          arguments: expect.objectContaining({
            project_path: project,
            sync_remote: remote,
            refresh_since: status.record.updated_at,
            current_task: "lifecycle status propagation"
          })
        })
      );
      expect(status.next.actions_by_id[status.next.recommended_finish_action_id]).toEqual(
        status.next.actions.find((action) => action.action === "finish_session")
      );
      expect(status.next.actions_by_id[status.next.recommended_refresh_action_id]).toEqual(
        status.next.actions.find((action) => action.action === "refresh_context")
      );

      const start = await agentStart({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "gemini", session_id: "gemini-status" },
        currentTask: "coordinate lifecycle status propagation",
        refreshSince: "2000-01-01T00:00:00.000Z"
      });

      expect(start.refresh.changes).toContainEqual(
        expect.objectContaining({
          importance: "notice",
          summary: "Codex is refactoring lifecycle status propagation.",
          recommended_action: "call recall with record_id"
        })
      );
      expect(start.boot.recent_changes).toContainEqual(
        expect.objectContaining({
          type: "status",
          content: expect.objectContaining({ text: "Codex is refactoring lifecycle status propagation." })
        })
      );
      expect(start.handoff.active_sessions).toEqual([
        expect.objectContaining({
          record_id: status.record.id,
          type: "status",
          text: "Codex is refactoring lifecycle status propagation.",
          current_task: "lifecycle status propagation",
          agent: expect.objectContaining({ client: "codex", session_id: "codex-status" }),
          recommended_action: "coordinate_with_active_session",
          next_action: expect.any(Object)
        })
      ]);
      expect(start.handoff.active_sessions_by_record_id[status.record.id]).toEqual(start.handoff.active_sessions[0]);
      expect(start.handoff.selection_sources).toEqual({
        inbox_entry: "handoff.inbox_by_record_id.<record_id>",
        inbox_record_id: "handoff.inbox_by_record_id.<record_id>.record_id",
        inbox_next_action: "handoff.inbox_by_record_id.<record_id>.next_action",
        inbox_next_action_cli_executable:
          "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.executable",
        inbox_next_action_cli_argv: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
        inbox_next_action_cli_args: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
        inbox_next_action_cli_exec_file: "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
        inbox_next_action_cli_placeholder:
          "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
        inbox_next_action_cli_command_line:
          "handoff.inbox_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
        inbox_next_action_argument: "handoff.inbox_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        inbox_next_action_required_field:
          "handoff.inbox_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        inbox_next_action_required_input:
          "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        inbox_next_action_required_input_argument_path:
          "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
        inbox_next_action_argument_source:
          "handoff.inbox_by_record_id.<record_id>.next_action.argument_sources.<field>",
        recovered_status_entry: "handoff.recovered_statuses_by_record_id.<record_id>",
        recovered_status_record_id: "handoff.recovered_statuses_by_record_id.<record_id>.record_id",
        active_session_entry: "handoff.active_sessions_by_record_id.<record_id>",
        active_session_record_id: "handoff.active_sessions_by_record_id.<record_id>.record_id",
        active_session_next_action: "handoff.active_sessions_by_record_id.<record_id>.next_action",
        active_session_next_action_cli_executable:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.executable",
        active_session_next_action_cli_argv:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
        active_session_next_action_cli_args:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
        active_session_next_action_cli_exec_file:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
        active_session_next_action_cli_placeholder:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
        active_session_next_action_cli_command_line:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
        active_session_next_action_argument:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        active_session_next_action_required_field:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        active_session_next_action_required_input:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        active_session_next_action_required_input_argument_path:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
        active_session_next_action_argument_source:
          "handoff.active_sessions_by_record_id.<record_id>.next_action.argument_sources.<field>"
      });
      expectHandoffEntryNextAction(
        start.handoff.active_sessions[0]!.next_action,
        status.record.id,
        "moryn",
        "active_sessions"
      );
      expect(start.handoff.active_sessions_by_record_id[status.record.id]!.next_action).toEqual(
        start.handoff.active_sessions[0]!.next_action
      );
      expect(start.handoff.next_action).toEqual(start.handoff.active_sessions[0]!.next_action);
      expectHandoffEntryNextAction(start.handoff.next_action!, status.record.id, "moryn", "active_sessions");
      expect(start.handoff.inbox).toEqual([]);
      expect(start.handoff.inbox_by_record_id).toEqual({});
      expect(start.next.actions).toContainEqual(
        expect.objectContaining({
          action: "publish_status",
          tool: "agent_status",
          required_fields: ["status"],
          arguments: expect.objectContaining({
            project_path: project,
            sync_remote: remote,
            current_task: "coordinate lifecycle status propagation"
          })
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("does not treat expired status checkpoints as active sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-status-expiry-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-codex");
    const storeB = join(root, "store-gemini");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storeA, { now: () => "2026-05-27T00:00:00.000Z", id: () => "device_codex" });
      await initializeGitSync(storeA, remote);

      const engine = createEngine({
        storePath: storeA,
        now: () => "2026-05-27T00:00:00.000Z",
        id: (prefix) => `${prefix}_old_status`
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        tags: ["typescript"],
        content: {
          text: "Codex left an old status that should not look active forever.",
          format: "json",
          current_task: "old lifecycle work",
          status: "Codex left an old status that should not look active forever."
        },
        source: { client: "codex", session_id: "codex-old-status", device_id: "device_codex" }
      });
      await pushGitSync(storeA, { message: "old status checkpoint" });

      const pushed = await agentStatus({
        storePath: storeA,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "codex", session_id: "codex-current-status" },
        status: "Codex is actively coordinating current lifecycle work.",
        currentTask: "current lifecycle work"
      });
      expect(pushed.sync.push?.pushed).toBe(true);

      const start = await agentStart({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        agent: { client: "gemini", session_id: "gemini-status-expiry" },
        currentTask: "coordinate lifecycle work",
        refreshSince: "2000-01-01T00:00:00.000Z"
      });

      expect(start.handoff.active_sessions.map((entry) => entry.text)).toEqual([
        "Codex is actively coordinating current lifecycle work."
      ]);
      expect(start.handoff.active_sessions).not.toContainEqual(
        expect.objectContaining({
          text: "Codex left an old status that should not look active forever."
        })
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("diagnoses a fresh agent device without mutating the store", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-"));
    const remote = join(root, "remote.git");
    const store = join(root, "fresh-store");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: project,
        syncRemote: remote,
        currentTask: "continue safely on a new machine",
        agent: { client: "gemini", session_id: "gemini-doctor" }
      });

      expect(doctor.ok).toBe(true);
      expect(doctor.store).toMatchObject({ path: store, initialized: false });
      expect(doctor.project).toMatchObject({ ok: true, project_id: "moryn", source: "config" });
      expect(doctor.sync).toMatchObject({ configured: false, expected_remote: remote });
      expect(doctor.readiness).toEqual({
        safe_to_start: true,
        blocking_checks: [],
        blocking_checks_by_name: {},
        recommended_action: "call_agent_start",
        next_action_source: "next",
        next_tool: "agent_start",
        next_command: doctor.next.command,
        next_safe_to_run: true,
        next_required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
        next_required_fields: [],
        next_required_fields_by_name: {},
        next_argument_sources: {},
        next_safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          requires_authored_input: false,
          writes_local_config: false,
          reasons: ["safe_read_or_status_check"]
        },
        next_interfaces: doctor.next.interfaces,
        next_workflow: doctor.next.workflow,
        next_selection_sources: doctor.next.selection_sources,
        next_arguments: {
          project_id: undefined,
          project_path: project,
          sync_remote: remote,
          current_task: "continue safely on a new machine",
          agent: { client: "gemini", session_id: "gemini-doctor" }
        }
      });
      expect((doctor.next as { action_source?: string }).action_source).toBe("next");
      expect(doctor.checks).toContainEqual(
        expect.objectContaining({
          name: "store",
          ok: false,
          severity: "notice"
        })
      );
      expect(doctor.checks).toContainEqual(
        expect.objectContaining({
          name: "sync",
          ok: false,
          severity: "notice"
        })
      );
      expect(doctor.checks_by_name.store).toEqual(doctor.checks.find((check) => check.name === "store"));
      expect(doctor.checks_by_name.project).toEqual(doctor.checks.find((check) => check.name === "project"));
      expect(doctor.checks_by_name.sync).toEqual(doctor.checks.find((check) => check.name === "sync"));
      expect(doctor.selection_sources).toEqual({
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
      expect(doctor.next).toMatchObject({
        recommended_action: "call_agent_start",
        tool: "agent_start",
        safe_to_run: true
      });
      expect(doctor.next.actions).toContainEqual(
        expect.objectContaining({
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
          required_when: "Before trusting lifecycle sync on a new machine or remote.",
          required_fields: [],
          arguments: expect.objectContaining({
            remote
          })
        })
      );
      expect(doctor.next.selection_sources).toEqual({
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
        action_required_input_argument_path:
          "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(doctor.next.actions_by_id.start_session).toEqual(
        doctor.next.actions.find((action) => action.action === "start_session")
      );
      expect(doctor.next.actions_by_id.run_lifecycle_smoke).toEqual(
        doctor.next.actions.find((action) => action.action === "run_lifecycle_smoke")
      );
      expectLifecycleActionSelectionSources(doctor.next.actions_by_id.start_session);
      expectLifecycleActionSelectionSources(doctor.next.actions_by_id.run_lifecycle_smoke);
      expect(doctor.next.command).toContain("moryn agent start");
      expect(doctor.next.command).toContain("--sync-remote");
      expect(doctor.next.arguments).toMatchObject({
        project_path: project,
        sync_remote: remote,
        current_task: "continue safely on a new machine",
        agent: { client: "gemini", session_id: "gemini-doctor" }
      });
      await expect(access(join(store, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers the latest expired Codex Stop status as handoff context", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-expired-stop-handoff-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const status = await agentStatus({
        storePath: store,
        projectPath: project,
        agent: { client: "codex", session_id: "codex-stop", device_id: "device-a" },
        status: "Implemented parser recovery; next run integration tests.",
        currentTask: "parser recovery",
        push: false
      });
      const future = new Date(Date.parse(status.record.updated_at) + 3 * 60 * 60 * 1000).toISOString();

      const start = await agentStart(
        {
          storePath: store,
          projectPath: project,
          agent: { client: "claude", session_id: "claude-next", device_id: "device-b" },
          currentTask: "continue parser recovery",
          pull: false
        },
        { now: () => future }
      );

      expect(start.handoff.active_sessions).toEqual([]);
      expect(start.handoff.inbox).toContainEqual(
        expect.objectContaining({
          record_id: status.record.id,
          type: "status",
          text: "Implemented parser recovery; next run integration tests.",
          recommended_action: "review_recovered_status"
        })
      );
      expect(start.handoff.recovered_statuses).toEqual([expect.objectContaining({ record_id: status.record.id })]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses expired status recovery after a later final handoff", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-expired-stop-final-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const identity = { client: "codex", session_id: "codex-stop", device_id: "device-a" };
      const status = await agentStatus({
        storePath: store,
        projectPath: project,
        agent: identity,
        status: "Work still in progress.",
        currentTask: "finish parser",
        push: false
      });
      const finished = await agentFinish({
        storePath: store,
        projectPath: project,
        agent: identity,
        summary: "Parser work finished and verified.",
        currentTask: "finish parser",
        push: false
      });
      const future = new Date(Date.parse(finished.record.updated_at) + 3 * 60 * 60 * 1000).toISOString();

      const start = await agentStart(
        {
          storePath: store,
          projectPath: project,
          agent: { client: "claude", session_id: "claude-next", device_id: "device-b" },
          currentTask: "consume final handoff",
          pull: false
        },
        { now: () => future }
      );

      expect(start.handoff.inbox.map((entry) => entry.record_id)).toContain(finished.record.id);
      expect(start.handoff.inbox.map((entry) => entry.record_id)).not.toContain(status.record.id);
      expect(start.handoff.recovered_statuses).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns placeholder arguments for doctor smoke when remote is omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-smoke-placeholder-"));
    const store = join(root, "fresh-store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: project,
        currentTask: "check lifecycle smoke template",
        agent: { client: "codex", session_id: "codex-doctor-placeholder" }
      });

      expect(doctor.next.actions).toContainEqual(
        expect.objectContaining({
          action: "run_lifecycle_smoke",
          tool: "moryn-agent-smoke",
          safe_to_run: true,
          command: "moryn-agent-smoke --remote <remote>",
          interfaces: expect.objectContaining({
            cli: expect.objectContaining({ argv: ["moryn-agent-smoke", "--remote", "<remote>"] })
          }),
          required_when: "Before trusting lifecycle sync on a new machine or remote.",
          required_fields: ["remote"],
          argument_sources: {
            remote: "user_input.remote"
          },
          arguments: { remote: "<remote>" }
        })
      );
      expect(doctor.next.actions_by_id.run_lifecycle_smoke).toEqual(
        doctor.next.actions.find((action) => action.action === "run_lifecycle_smoke")
      );
      expectLifecycleActionSelectionSources(doctor.next.actions_by_id.run_lifecycle_smoke);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend lifecycle writes while sync has unresolved conflicts", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-sync-conflict-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    const conflictFile = join("events", "shared-device", "2026-05", "evt_conflict.json");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storeA, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_a"
      });
      await initializeStore(storeB, {
        now: () => "2026-05-27T00:00:00.000Z",
        id: () => "device_b"
      });
      await createSyncConflict({ remote, storeA, storeB, conflictFile });

      const doctor = await agentDoctor({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        currentTask: "avoid sync conflict hallucination",
        agent: { client: "codex", session_id: "codex-conflict" }
      });

      expect(doctor.sync).toMatchObject({
        configured: true,
        sync_state: "conflict",
        conflict: {
          operation: "rebase",
          files: [conflictFile],
          safe_to_retry_sync: false
        }
      });
      expect(doctor.checks).toContainEqual(
        expect.objectContaining({
          name: "sync",
          ok: false,
          severity: "warning",
          message: expect.stringContaining("conflict")
        })
      );
      expect(doctor.next).toMatchObject({
        recommended_action: "resolve_sync_conflict_before_lifecycle",
        action_source: "next",
        tool: "sync_status",
        safe_to_run: true,
        command: "moryn sync --status",
        arguments: {}
      });
      expect(doctor.readiness).toEqual({
        safe_to_start: false,
        blocking_checks: ["sync"],
        blocking_checks_by_name: {
          sync: doctor.checks_by_name.sync
        },
        recommended_action: "resolve_sync_conflict_before_lifecycle",
        next_action_source: "next",
        next_tool: "sync_status",
        next_command: "moryn sync --status",
        next_safe_to_run: true,
        next_required_when: "Before retrying lifecycle writes or sync operations after a Git conflict.",
        next_required_fields: [],
        next_required_fields_by_name: {},
        next_argument_sources: {},
        next_safety: doctor.next.safety,
        next_interfaces: doctor.next.interfaces,
        next_workflow: doctor.next.workflow,
        next_selection_sources: {},
        next_arguments: {}
      });
      expect(doctor.checks_by_name.sync).toEqual(
        expect.objectContaining({
          name: "sync",
          ok: false,
          severity: "warning",
          message:
            "Sync has unresolved Git conflicts; inspect sync_status and resolve conflicts before lifecycle writes."
        })
      );

      const entered = await agentEnter({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        currentTask: "avoid sync conflict hallucination",
        agent: { client: "codex", session_id: "codex-conflict" }
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "needs_setup",
        next: {
          recommended_action: "resolve_sync_conflict_before_lifecycle",
          tool: "sync_status",
          safe_to_run: true
        }
      });

      await expect(
        agentStart({
          storePath: storeB,
          projectPath: project,
          syncRemote: remote,
          currentTask: "avoid sync conflict hallucination",
          agent: { client: "codex", session_id: "codex-conflict" }
        })
      ).rejects.toThrow("Sync conflict: resolve Git conflicts before lifecycle writes");

      const filesBeforeWrites = await eventFiles(storeB);
      await expect(
        agentStatus({
          storePath: storeB,
          projectPath: project,
          syncRemote: remote,
          currentTask: "avoid sync conflict hallucination",
          status: "Do not write status while sync is conflicted.",
          agent: { client: "codex", session_id: "codex-conflict" }
        })
      ).rejects.toThrow("Sync conflict: resolve Git conflicts before lifecycle writes");
      await expect(
        agentFinish({
          storePath: storeB,
          projectPath: project,
          syncRemote: remote,
          summary: "Do not write finish handoff while sync is conflicted.",
          agent: { client: "codex", session_id: "codex-conflict" }
        })
      ).rejects.toThrow("Sync conflict: resolve Git conflicts before lifecycle writes");
      await expect(eventFiles(storeB)).resolves.toEqual(filesBeforeWrites);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("recommends project discovery when doctor has a store but no project input", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-project-list-"));
    const store = join(root, "store");
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      await initializeStore(store);
      const engine = createEngine({ storePath: store });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn project handoff is available.", format: "text" },
        source: { client: "codex", session_id: "codex-project-list" }
      });

      const doctor = await agentDoctor({
        storePath: store,
        agent: { client: "gemini", session_id: "gemini-project-list" },
        currentTask: "find project to continue"
      });

      expect(doctor.next).toMatchObject({
        recommended_action: "list_projects",
        action_source: "next",
        tool: "project_list",
        safe_to_run: true,
        command: "moryn project list"
      });
      expect(doctor.readiness).toEqual({
        safe_to_start: false,
        blocking_checks: [],
        blocking_checks_by_name: {},
        recommended_action: "list_projects",
        next_action_source: "next",
        next_tool: "project_list",
        next_command: "moryn project list",
        next_safe_to_run: true,
        next_required_when: "When the shared store has projects but this agent has no explicit project context.",
        next_required_fields: [],
        next_required_fields_by_name: {},
        next_argument_sources: {},
        next_safety: doctor.next.safety,
        next_interfaces: doctor.next.interfaces,
        next_workflow: doctor.next.workflow,
        next_selection_sources: doctor.next.selection_sources,
        next_arguments: {}
      });
      expect(doctor.next.actions).toContainEqual(
        expect.objectContaining({
          action: "list_projects",
          tool: "project_list",
          command: "moryn project list",
          required_when: "When the shared store has projects but this agent has no explicit project context.",
          required_fields: [],
          arguments: {}
        })
      );
      expect(doctor.next.actions_by_id.list_projects).toEqual(doctor.next.actions[0]);
      expectLifecycleActionSelectionSources(doctor.next.actions_by_id.list_projects);
      expect(doctor.next.selection_sources).toEqual({
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
        action_required_input_argument_path:
          "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enters project discovery instead of guessing a project on an unknown device", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-enter-project-list-"));
    const store = join(root, "store");
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      await initializeStore(store);
      const engine = createEngine({ storePath: store });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn project handoff is available.", format: "text" },
        source: { client: "codex", session_id: "codex-enter-project-list" }
      });

      const entered = await agentEnter({
        storePath: store,
        agent: { client: "gemini", session_id: "gemini-enter-project-list" },
        currentTask: "find project to continue",
        syncRemote: "git@github.com:user/moryn-store.git"
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "discover_projects",
        next: {
          recommended_action: "choose_project_and_call_agent_start",
          action_source: "next",
          tool: "agent_start",
          safe_to_run: true,
          required_when:
            "When agent_enter returns discover_projects mode, choose one returned project_id before calling agent_start.",
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
            start_action_required_input:
              "next.actions_by_project_id.<project_id>.execution.required_inputs_by_field.<field>",
            start_action_required_input_argument_path:
              "next.actions_by_project_id.<project_id>.execution.required_inputs_by_argument_path.<argument_path>",
            start_action_argument_source: "next.actions_by_project_id.<project_id>.argument_sources.<field>",
            lifecycle_actions: "next.actions_by_project_id.<project_id>.lifecycle_by_step"
          },
          arguments: {
            project_id: "<project_id>",
            sync_remote: "git@github.com:user/moryn-store.git",
            current_task: "find project to continue",
            agent: { client: "gemini", session_id: "gemini-enter-project-list" }
          },
          safety: {
            safe_to_auto_run: true,
            requires_user_confirmation: false,
            requires_authored_input: true,
            writes_local_config: false,
            reasons: ["required_fields"]
          }
        }
      });
      expect(entered.next.command).toBe(
        "moryn agent start --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list"
      );
      expect(entered.next.interfaces).toEqual({
        cli: {
          command: entered.next.command,
          command_line:
            "moryn agent start --project-id '<project_id>' --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list",
          executable: "moryn",
          argv: [
            "agent",
            "start",
            "--project-id",
            "<project_id>",
            "--sync-remote",
            "git@github.com:user/moryn-store.git",
            "--current-task",
            "find project to continue",
            "--agent",
            "gemini",
            "--session-id",
            "gemini-enter-project-list"
          ],
          args: [
            "agent",
            "start",
            "--project-id",
            "<project_id>",
            "--sync-remote",
            "git@github.com:user/moryn-store.git",
            "--current-task",
            "find project to continue",
            "--agent",
            "gemini",
            "--session-id",
            "gemini-enter-project-list"
          ],
          exec_file: {
            executable: "moryn",
            args: [
              "agent",
              "start",
              "--project-id",
              "<project_id>",
              "--sync-remote",
              "git@github.com:user/moryn-store.git",
              "--current-task",
              "find project to continue",
              "--agent",
              "gemini",
              "--session-id",
              "gemini-enter-project-list"
            ]
          },
          placeholders: ["project_id"],
          has_placeholders: true
        },
        mcp: {
          tool: "agent_start",
          arguments: {
            project_id: "<project_id>",
            project_path: undefined,
            sync_remote: "git@github.com:user/moryn-store.git",
            current_task: "find project to continue",
            agent: { client: "gemini", session_id: "gemini-enter-project-list" }
          }
        }
      });
      expect(entered.doctor.next).toMatchObject({ tool: "project_list" });
      const discoveredLifecycle = entered.next.actions[0]?.lifecycle ?? [];
      expect(entered.next.actions[0]).toMatchObject({
        action: "start_session",
        project_id: "moryn",
        required_when: "After choosing this project from discovery results.",
        lifecycle: [
          expect.objectContaining({
            step: "start_or_resume",
            tool: "agent_start",
            safe_to_run: true,
            command:
              "moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list"
          }),
          expect.objectContaining({
            step: "publish_status",
            tool: "agent_status",
            safe_to_run: true,
            command:
              "moryn agent status --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list --status <status>",
            required_fields: ["status"],
            argument_sources: {
              status: "agent_authored.status"
            },
            arguments: expect.objectContaining({ project_id: "moryn", status: "<status>" })
          }),
          expect.objectContaining({
            step: "finish_handoff",
            tool: "agent_finish",
            safe_to_run: true,
            command:
              "moryn agent finish --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list --summary <summary>",
            required_fields: ["summary"],
            argument_sources: {
              summary: "agent_authored.summary"
            },
            arguments: expect.objectContaining({ project_id: "moryn", summary: "<summary>" })
          }),
          expect.objectContaining({
            step: "refresh_context",
            tool: "agent_start",
            safe_to_run: true,
            command:
              "moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list --refresh-since <refresh_since>",
            required_fields: ["refresh_since"],
            argument_sources: {
              refresh_since: "user_input.refresh_since"
            }
          })
        ]
      });
      expect(entered.next.actions_by_project_id.moryn).toEqual(entered.next.actions[0]);
      expect(entered.projects.projects_by_id.moryn).toEqual(entered.projects.projects[0]);
      expect(entered.next.actions[0]?.lifecycle_by_step.start_or_resume).toEqual(discoveredLifecycle[0]);
      expect(entered.next.actions[0]?.lifecycle_by_step.publish_status).toEqual(
        discoveredLifecycle.find((action) => action.step === "publish_status")
      );
      expect(entered.next.actions[0]?.lifecycle_by_step.finish_handoff).toEqual(
        discoveredLifecycle.find((action) => action.step === "finish_handoff")
      );
      expect(entered.next.actions[0]?.lifecycle_by_step.refresh_context).toEqual(
        discoveredLifecycle.find((action) => action.step === "refresh_context")
      );
      for (const action of discoveredLifecycle) {
        expectDiscoveredLifecycleStepSelectionSources(action);
      }
      expectDiscoveredLifecycleStepSelectionSources(entered.next.actions[0]!.lifecycle_by_step.start_or_resume);
      expectDiscoveredLifecycleStepSelectionSources(entered.next.actions[0]!.lifecycle_by_step.publish_status);
      expectDiscoveredLifecycleStepSelectionSources(entered.next.actions[0]!.lifecycle_by_step.finish_handoff);
      expectDiscoveredLifecycleStepSelectionSources(entered.next.actions[0]!.lifecycle_by_step.refresh_context);
      expect(entered.next.workflow.continue_from).toEqual([
        "next.actions_by_project_id",
        "next.actions",
        "next.actions_by_project_id.<project_id>.lifecycle_by_step",
        "next.actions_by_project_id.<project_id>.lifecycle",
        "agent_start.next.actions_by_id",
        "agent_start.next.actions"
      ]);
      expect(entered.next.workflow.phases.map((phase) => phase.action_source)).toEqual([
        "projects.projects",
        "next.actions_by_project_id.<project_id>",
        "next.actions_by_project_id.<project_id>.lifecycle_by_step"
      ]);
      for (const action of discoveredLifecycle) {
        expectLifecycleWorkflow(action);
      }
      expect(entered.projects.projects[0]).toMatchObject({
        project_id: "moryn",
        next: {
          command:
            "moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list",
          arguments: {
            project_id: "moryn",
            sync_remote: "git@github.com:user/moryn-store.git",
            current_task: "find project to continue",
            agent: { client: "gemini", session_id: "gemini-enter-project-list" }
          }
        }
      });
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enters project discovery after syncing a fresh store from a shared remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-enter-sync-project-list-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    const unknownCwd = join(root, "unknown-device");
    const previousCwd = process.cwd();
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storeA);
      await initializeGitSync(storeA, remote);
      await agentFinish({
        storePath: storeA,
        projectPath: project,
        agent: { client: "codex", session_id: "codex-enter-sync" },
        summary: "Codex left a synced project handoff.",
        push: true
      });

      await mkdir(unknownCwd, { recursive: true });
      process.chdir(unknownCwd);
      const entered = await agentEnter({
        storePath: storeB,
        syncRemote: remote,
        agent: { client: "gemini", session_id: "gemini-enter-sync" },
        currentTask: "find synced project"
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "discover_projects",
        bootstrap: {
          initialized_store: true,
          sync_init: { ok: true },
          sync_pull: { ok: true, pulled: true }
        },
        next: {
          recommended_action: "choose_project_and_call_agent_start",
          action_source: "next",
          tool: "agent_start",
          safe_to_run: true,
          required_when:
            "When agent_enter returns discover_projects mode, choose one returned project_id before calling agent_start.",
          required_fields: ["project_id"],
          required_fields_by_name: {
            project_id: {
              name: "project_id",
              argument_path: "project_id",
              value: "<project_id>",
              placeholder: "<project_id>"
            }
          },
          arguments: {
            project_id: "<project_id>",
            sync_remote: remote,
            current_task: "find synced project",
            agent: { client: "gemini", session_id: "gemini-enter-sync" }
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
            start_action_required_input:
              "next.actions_by_project_id.<project_id>.execution.required_inputs_by_field.<field>",
            start_action_required_input_argument_path:
              "next.actions_by_project_id.<project_id>.execution.required_inputs_by_argument_path.<argument_path>",
            start_action_argument_source: "next.actions_by_project_id.<project_id>.argument_sources.<field>",
            lifecycle_actions: "next.actions_by_project_id.<project_id>.lifecycle_by_step"
          },
          safety: {
            safe_to_auto_run: true,
            requires_user_confirmation: false,
            requires_authored_input: true,
            writes_local_config: false,
            reasons: ["required_fields"]
          }
        }
      });
      expect(entered.doctor.next).toMatchObject({ tool: "project_list" });
      expect(entered.next.actions_by_project_id.moryn).toEqual(entered.next.actions[0]);
      expect(entered.projects.projects_by_id.moryn).toEqual(entered.projects.projects[0]);
      expect(entered.projects.projects[0]).toMatchObject({
        project_id: "moryn",
        latest_activity: {
          text: "Codex left a synced project handoff."
        },
        next: {
          command: expect.stringContaining("moryn agent start --project-id moryn"),
          arguments: {
            project_id: "moryn",
            sync_remote: remote,
            current_task: "find synced project",
            agent: { client: "gemini", session_id: "gemini-enter-sync" }
          }
        }
      });
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("enters a known project by running agent_start when doctor can start safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-enter-start-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, {
        project_id: "moryn",
        tags: ["typescript"],
        default_skills: ["release"]
      });

      const entered = await agentEnter({
        storePath: store,
        projectPath: project,
        agent: { client: "codex", session_id: "codex-enter-start" },
        currentTask: "continue project"
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "start_session",
        project: { project_id: "moryn" },
        startup_overview: {
          status: "ready",
          project_id: "moryn",
          headline: "Ready to work in moryn.",
          primary_next_step: {
            action_id: "finish_session",
            action_source: "next.actions_by_id.finish_session",
            label: "Finish with handoff summary",
            safe_to_run: true,
            owner: "agent",
            requires_authored_input: true,
            requires_user_input: false
          },
          safety: {
            read_first: true,
            writes_require_explicit_action: true,
            mutation_surfaces: ["agent_status", "agent_finish"]
          },
          signals: expect.arrayContaining([
            expect.objectContaining({
              id: "boot_context",
              status: "ok",
              source: "start.boot"
            }),
            expect.objectContaining({
              id: "refresh_context",
              status: "ok",
              source: "start.refresh"
            }),
            expect.objectContaining({
              id: "handoff_context",
              status: "ok",
              source: "start.handoff"
            })
          ]),
          evidence_sources: {
            boot: "start.boot",
            refresh: "start.refresh",
            handoff: "start.handoff",
            next_actions: "next.actions_by_id"
          }
        },
        start: {
          ok: true,
          project: { project_id: "moryn" },
          startup_overview: {
            status: "ready",
            project_id: "moryn",
            headline: "Ready to work in moryn."
          }
        },
        next: {
          recommended_action: "work_with_handoff_context",
          tool: "agent_start"
        }
      });
      expect(entered.next.actions_by_id.publish_status).toEqual(
        entered.next.actions.find((action) => action.action === "publish_status")
      );
      expect(entered.next.required_end_action_id).toBe("finish_session");
      expect(entered.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
      expect(entered.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(entered.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(entered.next.selection_sources).toEqual({
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
        action_required_input_argument_path:
          "next.actions_by_id.<action>.execution.required_inputs_by_argument_path.<argument_path>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(entered.next.workflow.phases.map((phase) => phase.action_source)).toContain(
        "next.actions_by_id.publish_status"
      );
      expect(entered.start.project.default_skills).toEqual(["release"]);
      expect(entered.start.handoff).toMatchObject({
        active_sessions: [],
        inbox: []
      });
      expect(entered.start.handoff.next_action).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps genuine project warnings visible as startup attention", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-start-warning-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const engine = createEngine({ storePath: store });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Do not include secrets in memory.", format: "text" },
        state: "canonical",
        priority: "high",
        source: { client: "test" }
      });

      const started = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "continue project",
        agent: { client: "codex", session_id: "codex-warning" }
      });

      expect(started.startup_overview).toMatchObject({
        status: "needs_attention",
        headline: "Review startup context before working in moryn.",
        primary_next_step: {
          owner: "agent",
          safe_to_run: true,
          requires_authored_input: true,
          requires_user_input: false
        },
        signals: expect.arrayContaining([
          expect.objectContaining({
            id: "boot_context",
            status: "review",
            source: "start.boot"
          })
        ])
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns portable lifecycle actions after resolving project config from cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-portable-actions-"));
    const store = join(root, "store");
    const project = join(root, "project");
    const previousCwd = process.cwd();
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      process.chdir(project);

      const started = await agentStart({
        storePath: store,
        agent: { client: "codex", session_id: "codex-portable-actions" },
        currentTask: "continue from portable actions"
      });

      expect(started.next.actions).toContainEqual(
        expect.objectContaining({
          action: "publish_status",
          safe_to_run: true,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn" })
        })
      );
      expect(started.next.actions).toContainEqual(
        expect.objectContaining({
          action: "finish_session",
          safe_to_run: true,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn" })
        })
      );
      expect(started.next.actions).toContainEqual(
        expect.objectContaining({
          action: "refresh_context",
          safe_to_run: true,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn" })
        })
      );

      const status = await agentStatus({
        storePath: store,
        agent: { client: "codex", session_id: "codex-portable-actions" },
        currentTask: "continue from portable actions",
        status: "Publishing portable action templates."
      });
      expect(status.next.actions).toContainEqual(
        expect.objectContaining({
          action: "finish_session",
          safe_to_run: true,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn" })
        })
      );

      const finish = await agentFinish({
        storePath: store,
        agent: { client: "codex", session_id: "codex-portable-actions" },
        currentTask: "continue from portable actions",
        summary: "Finished portable action template checks."
      });
      expect(finish.next.actions).toContainEqual(
        expect.objectContaining({
          action: "start_next_session",
          safe_to_run: true,
          command: expect.stringContaining("--project-id moryn"),
          arguments: expect.objectContaining({ project_id: "moryn" })
        })
      );
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recommends project discovery from an unconfigured git checkout with known projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-git-project-list-"));
    const store = join(root, "store");
    const project = join(root, "project");
    const previousCwd = process.cwd();
    try {
      await mkdir(project, { recursive: true });
      await exec("git", ["init"], { cwd: project });
      await initializeStore(store);
      const engine = createEngine({ storePath: store });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn git checkout handoff is available.", format: "text" },
        source: { client: "codex", session_id: "codex-git-project-list" }
      });

      process.chdir(project);
      const doctor = await agentDoctor({
        storePath: store,
        agent: { client: "gemini", session_id: "gemini-git-project-list" },
        currentTask: "find git checkout project"
      });

      expect(doctor.project).toMatchObject({ ok: true, source: "git_root" });
      expect(doctor.next).toMatchObject({
        recommended_action: "list_projects",
        action_source: "next",
        tool: "project_list",
        safe_to_run: true,
        command: "moryn project list"
      });
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start when project config is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-invalid-project-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeStore(store);
      await writeFile(join(project, ".moryn.json"), '{"project_id":""}\n', "utf8").catch(async (error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          await mkdir(project, { recursive: true });
          await writeFile(join(project, ".moryn.json"), '{"project_id":""}\n', "utf8");
          return;
        }
        throw error;
      });

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: project,
        agent: { client: "codex" }
      });

      expect(doctor.project).toMatchObject({ ok: false });
      expect(doctor.checks).toContainEqual(
        expect.objectContaining({
          name: "project",
          ok: false,
          severity: "warning"
        })
      );
      expect(doctor.next).toMatchObject({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: `moryn project init --path ${project}`,
        arguments: {
          path: project
        }
      });
      expect(doctor.next.command).not.toContain("--project-id");
      expect(doctor.next.arguments).not.toHaveProperty("project_id");
      expect(doctor.next.command).toContain("moryn project init");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mirrors project setup argument sources in doctor readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-setup-sources-"));
    const store = join(root, "store");
    const previousCwd = process.cwd();
    try {
      await initializeStore(store);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, ".moryn.json"), '{"project_id":""}\n', "utf8");
      process.chdir(root);

      const doctor = await agentDoctor({
        storePath: store,
        agent: { client: "codex" }
      });

      expect(doctor.next).toMatchObject({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: "moryn project init --path <path>",
        required_when: "Before starting lifecycle work when project context is invalid or missing.",
        required_fields: ["path"],
        required_fields_by_name: {
          path: {
            name: "path",
            argument_path: "path",
            placeholder: "<path>",
            value: "<path>"
          }
        },
        argument_sources: {
          path: "user_input.path"
        },
        arguments: {
          path: "<path>"
        }
      });
      expect(doctor.readiness).toMatchObject({
        next_required_fields: ["path"],
        next_required_fields_by_name: doctor.next.required_fields_by_name,
        next_argument_sources: {
          path: "user_input.path"
        },
        next_selection_sources: {},
        next_arguments: {
          path: "<path>"
        }
      });
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start when an explicit project path is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-missing-project-"));
    const store = join(root, "store");
    const missingProject = join(root, "missing-project");
    try {
      await initializeStore(store);

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: missingProject,
        agent: { client: "codex" },
        currentTask: "avoid typo path"
      });

      expect(doctor.project).toMatchObject({
        ok: false,
        error: expect.stringContaining("Project path does not exist")
      });
      expect(doctor.checks).toContainEqual(
        expect.objectContaining({
          name: "project",
          ok: false,
          severity: "warning"
        })
      );
      expect(doctor.next).toMatchObject({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: `moryn project init --path ${missingProject}`,
        arguments: {
          path: missingProject
        }
      });

      const entered = await agentEnter({
        storePath: store,
        projectPath: missingProject,
        agent: { client: "codex" },
        currentTask: "avoid typo path"
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "needs_setup",
        next: {
          tool: "project_init",
          safe_to_run: false
        }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start when an explicit project id is unknown in a populated store", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-doctor-unknown-project-id-"));
    const store = join(root, "store");
    try {
      await initializeStore(store);
      const engine = createEngine({ storePath: store });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Known project handoff.", format: "text" },
        source: { client: "codex", session_id: "codex-known-project" }
      });

      const doctor = await agentDoctor({
        storePath: store,
        projectId: "morym",
        agent: { client: "codex" },
        currentTask: "avoid typo id"
      });

      expect(doctor.project).toMatchObject({
        ok: false,
        error: expect.stringContaining("Project id is not known in this store")
      });
      expect(doctor.next).toMatchObject({
        recommended_action: "list_projects",
        action_source: "next",
        tool: "project_list",
        safe_to_run: true,
        command: "moryn project list"
      });

      const entered = await agentEnter({
        storePath: store,
        projectId: "morym",
        agent: { client: "codex" },
        currentTask: "avoid typo id"
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "discover_projects",
        next: {
          recommended_action: "choose_project_and_call_agent_start",
          action_source: "next",
          tool: "agent_start",
          safe_to_run: true,
          required_when:
            "When agent_enter returns discover_projects mode, choose one returned project_id before calling agent_start.",
          required_fields: ["project_id"],
          arguments: {
            project_id: "<project_id>",
            current_task: "avoid typo id",
            agent: { client: "codex" }
          }
        }
      });
      expect(entered.projects.projects[0]).toMatchObject({
        project_id: "moryn"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not recommend agent_start when project path config conflicts with explicit project id", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-conflicting-project-id-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });

      const doctor = await agentDoctor({
        storePath: store,
        projectPath: project,
        projectId: "other",
        agent: { client: "codex" },
        currentTask: "avoid conflicting project id"
      });

      expect(doctor.project).toMatchObject({
        ok: false,
        error: expect.stringContaining("Project id conflict")
      });
      expect(doctor.next).toMatchObject({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: `moryn project init --path ${project}`,
        arguments: {
          path: project
        }
      });
      expect(doctor.next.command).not.toContain("--project-id");
      expect(doctor.next.arguments).not.toHaveProperty("project_id");

      const entered = await agentEnter({
        storePath: store,
        projectPath: project,
        projectId: "other",
        agent: { client: "codex" },
        currentTask: "avoid conflicting project id"
      });

      expect(entered).toMatchObject({
        ok: true,
        mode: "needs_setup",
        next: {
          tool: "project_init",
          safe_to_run: false,
          command: `moryn project init --path ${project}`,
          arguments: {
            path: project
          }
        }
      });
      expect(entered.next.command).not.toContain("--project-id");
      expect(entered.next.arguments).not.toHaveProperty("project_id");

      await expect(
        agentStart({
          storePath: store,
          projectPath: project,
          projectId: "other",
          agent: { client: "codex" },
          currentTask: "avoid conflicting project id"
        })
      ).rejects.toThrow("Project id conflict");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects direct lifecycle commands without project input in a populated store", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-direct-ambiguous-project-"));
    const store = join(root, "store");
    const unknownCwd = join(root, "unknown-cwd");
    const previousCwd = process.cwd();
    try {
      await mkdir(unknownCwd, { recursive: true });
      await initializeStore(store);
      const engine = createEngine({ storePath: store });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Known direct lifecycle project.", format: "text" },
        source: { client: "codex", session_id: "codex-direct-project" }
      });

      process.chdir(unknownCwd);

      await expect(
        agentStart({
          storePath: store,
          agent: { client: "codex" },
          currentTask: "avoid ambient project"
        })
      ).rejects.toThrow("Project context required");

      await expect(
        agentStatus({
          storePath: store,
          agent: { client: "codex" },
          currentTask: "avoid ambient project",
          status: "Do not write status to an inferred project."
        })
      ).rejects.toThrow("Project context required");

      await expect(
        agentFinish({
          storePath: store,
          agent: { client: "codex" },
          currentTask: "avoid ambient project",
          summary: "Do not write summary to an inferred project."
        })
      ).rejects.toThrow("Project context required");
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns stable checkpoint actions for identified active sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-checkpoint-actions-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await initializeStore(store);
      await initializeProjectConfig(project, { project_id: "checkpoint-project" });
      const start = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "Implement lifecycle checkpoints",
        agent: { client: "codex", session_id: "session-1", device_id: "device-1" },
        pull: false
      });

      expect(start.next.actions.map((action) => action.action)).toEqual([
        "publish_status",
        "finish_session",
        "refresh_context",
        "checkpoint_before_compaction",
        "checkpoint_long_task"
      ]);
      const precompact = start.next.actions_by_id.checkpoint_before_compaction;
      expect(precompact).toMatchObject({
        tool: "checkpoint",
        safe_to_run: true,
        required_when: expect.stringContaining("host is about to compact"),
        required_fields: ["occurred_at", "delta"],
        arguments: {
          project_id: "checkpoint-project",
          source: { client: "codex", session_id: "session-1", device_id: "device-1" },
          current_task: "Implement lifecycle checkpoints",
          occurred_at: "<occurred_at>",
          delta: expect.objectContaining({ session_id: "session-1", checkpoint_id: "<checkpoint_id>" })
        },
        interfaces: { mcp: { tool: "checkpoint" } },
        safety: { safe_to_auto_run: true, requires_authored_input: true, requires_user_confirmation: false },
        execution: { ready_to_run: false, next_step: "collect_required_fields" }
      });
      expect(precompact.interfaces.cli.command_line).toContain("moryn agent checkpoint");
      expect(precompact.workflow).toBeDefined();
      expectLifecycleActionSelectionSources(precompact);

      const entered = await agentEnter({
        storePath: store,
        projectPath: project,
        currentTask: "Implement lifecycle checkpoints",
        agent: { client: "codex", session_id: "session-1", device_id: "device-1" },
        pull: false
      });
      expect(entered.mode).toBe("start_session");
      expect(entered.next.actions_by_id.checkpoint_before_compaction).toEqual(
        entered.start.next.actions_by_id.checkpoint_before_compaction
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("only returns resume and long-task actions when recovery and checkpoint age require them", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-checkpoint-recovery-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await initializeStore(store);
      await initializeProjectConfig(project, { project_id: "checkpoint-project" });
      const engine = createEngine({ storePath: store });
      await engine.checkpoint({
        project_id: "checkpoint-project",
        source: { client: "codex", session_id: "session-1", device_id: "device-1" },
        occurred_at: "2999-07-11T00:00:00.000Z",
        delta: {
          session_id: "session-1",
          checkpoint_id: "recent",
          current_task: "Continue",
          progress: ["saved"],
          decisions: [],
          changed_facts: [],
          blockers: [],
          next_steps: [],
          files: [],
          candidate_memories: [],
          candidate_skills: [],
          learnings: []
        }
      });
      const recovered = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "Continue",
        agent: { client: "codex", session_id: "session-1", device_id: "device-1" },
        pull: false
      });
      expect(recovered.boot.checkpoint_recovery_pack.available).toBe(true);
      expect(recovered.next.actions.map((action) => action.action)).toContain("resume_from_checkpoint");
      expect(recovered.next.actions.map((action) => action.action)).not.toContain("checkpoint_long_task");
      expect(recovered.next.actions_by_id.resume_from_checkpoint).toMatchObject({
        safe_to_run: true,
        required_fields: [],
        execution: { ready_to_run: true }
      });

      const fresh = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "Other",
        agent: { client: "codex", session_id: "session-2", device_id: "device-1" },
        pull: false
      });
      expect(fresh.next.actions.map((action) => action.action)).not.toContain("resume_from_checkpoint");
      expect(fresh.next.actions.map((action) => action.action)).toContain("checkpoint_long_task");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("compensates an abnormal exit by pushing pending continuity events before pull", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-abnormal-exit-compensation-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(storeA, { id: () => "device-a" });
      await initializeStore(storeB, { id: () => "device-b" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);
      const engineA = createEngine({ storePath: storeA });
      await engineA.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "crashed-session", device_id: "device-a" },
        occurred_at: "2026-07-12T03:00:00.000Z",
        delta: {
          session_id: "crashed-session",
          checkpoint_id: "before-crash",
          current_task: "Recover abnormal exit",
          progress: ["Durable locally before crash"]
        }
      });

      const recoveredStart = await agentStart({
        storePath: storeA,
        projectPath: project,
        currentTask: "Recover abnormal exit",
        agent: { client: "codex", session_id: "crashed-session", device_id: "device-a" },
        pull: true
      });
      expect(recoveredStart.sync.compensation).toMatchObject({
        decision: "pushed",
        reason: "pending_continuity_events",
        push: { pushed: true },
        continuity_record_ids: [expect.stringMatching(/^rec_checkpoint_/)]
      });
      expect(recoveredStart.sync.pull).toMatchObject({ ok: true });

      expect((await pullGitSync(storeB)).pulled).toBe(true);
      const secondDevice = await agentStart({
        storePath: storeB,
        projectPath: project,
        currentTask: "Recover abnormal exit",
        agent: { client: "claude-code", session_id: "crashed-session", device_id: "device-b" },
        pull: false
      });
      expect(secondDevice.boot.checkpoint_recovery_pack).toMatchObject({
        available: true,
        progress: ["Durable locally before crash"]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not auto-push abnormal-exit events alongside unrelated working-tree files", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-abnormal-exit-blocked-"));
    const remote = join(root, "remote.git");
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { id: () => "device-a" });
      await initializeGitSync(store, remote);
      const engine = createEngine({ storePath: store });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "crashed-session", device_id: "device-a" },
        occurred_at: "2026-07-12T04:00:00.000Z",
        delta: {
          session_id: "crashed-session",
          checkpoint_id: "blocked",
          current_task: "Preserve unrelated files",
          progress: ["Checkpoint remains local"]
        }
      });
      await writeFile(join(store, "notes.txt"), "unrelated local work\n");

      const start = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "Preserve unrelated files",
        agent: { client: "codex", session_id: "crashed-session", device_id: "device-a" },
        pull: true
      });
      expect(start.sync.compensation).toMatchObject({
        decision: "blocked",
        reason: "unowned_pending_paths",
        pending_paths: expect.arrayContaining(["notes.txt"])
      });
      expect(start.sync.compensation).not.toHaveProperty("push");
      expect(
        (await readEvents(store)).some((event) => event.op === "upsert_record" && event.record.type === "checkpoint")
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers unresolved knowledge investigation after precompact without creating memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-knowledge-compact-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await initializeStore(store);
      await initializeProjectConfig(project, { project_id: "knowledge-project" });
      const engine = createEngine({ storePath: store });
      await engine.checkpoint({
        project_id: "knowledge-project",
        source: { client: "codex", session_id: "knowledge-session", device_id: "device-1" },
        occurred_at: "2026-07-12T00:00:00.000Z",
        delta: {
          session_id: "knowledge-session",
          checkpoint_id: "precompact-knowledge",
          current_task: "Resolve rollback policy",
          progress: ["Inspected signed-tag validation"],
          blockers: ["Rollback integration behavior remains unverified"],
          next_steps: ["Run rollback integration test"],
          files: ["src/release.ts"],
          knowledge_investigations: [
            {
              resolution_id: "rollback-policy",
              question: "What is the rollback policy?",
              recall_status: "knowledge_gap",
              recalled_record_ids: [],
              evidence: [{ type: "source_code", reference: "src/release.ts", summary: "Signed tags are validated" }],
              status: "unresolved",
              next_step: "Run rollback integration test"
            }
          ]
        }
      });

      const resumed = await agentStart({
        storePath: store,
        projectPath: project,
        currentTask: "Resolve rollback policy",
        agent: { client: "claude-code", session_id: "knowledge-session", device_id: "device-2" },
        pull: false
      });
      expect(resumed.boot.checkpoint_recovery_pack).toMatchObject({
        latest_checkpoint_id: "precompact-knowledge",
        knowledge_investigations: [
          {
            resolution_id: "rollback-policy",
            status: "unresolved",
            next_step: "Run rollback integration test",
            evidence: [{ reference: "src/release.ts" }]
          }
        ]
      });
      expect(resumed.next.actions_by_id.resume_from_checkpoint).toBeDefined();
      expect(
        (await engine.recall({ project_id: "knowledge-project", query: "rollback policy" })).outcome
      ).toMatchObject({ status: "verification_required" });
      const learned = await engine.recall({
        project_id: "knowledge-project",
        query: "rollback policy",
        kinds: ["memory", "skill"]
      });
      expect(learned.results).toEqual([]);
      expect(learned.outcome).toMatchObject({ status: "knowledge_gap" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one injected lifecycle clock for checkpoint fallback boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-checkpoint-clock-"));
    const store = join(root, "store");
    const project = join(root, "project");
    const now = "2030-01-01T01:00:00.000Z";
    try {
      await mkdir(project, { recursive: true });
      await initializeStore(store);
      await initializeProjectConfig(project, { project_id: "checkpoint-project" });
      const engine = createEngine({ storePath: store });
      for (const [sessionId, checkpointId, occurredAt] of [
        ["session-2959", "checkpoint-2959", "2030-01-01T00:30:01.000Z"],
        ["session-3000", "checkpoint-3000", "2030-01-01T00:30:00.000Z"],
        ["session-future", "checkpoint-future", "2030-01-01T01:00:01.000Z"]
      ] as const) {
        await engine.checkpoint({
          project_id: "checkpoint-project",
          source: { client: "codex", session_id: sessionId, device_id: "device-1" },
          occurred_at: occurredAt,
          delta: {
            session_id: sessionId,
            checkpoint_id: checkpointId,
            current_task: "Continue",
            progress: ["saved"],
            decisions: [],
            changed_facts: [],
            blockers: [],
            next_steps: [],
            files: [],
            candidate_memories: [],
            candidate_skills: [],
            learnings: []
          }
        });
      }

      const startFor = (sessionId: string) =>
        agentStart(
          {
            storePath: store,
            projectPath: project,
            currentTask: "Continue",
            agent: { client: "codex", session_id: sessionId, device_id: "device-1" },
            pull: false
          },
          { now: () => now }
        );
      expect((await startFor("session-2959")).next.actions_by_id).not.toHaveProperty("checkpoint_long_task");
      expect((await startFor("session-3000")).next.actions_by_id).toHaveProperty("checkpoint_long_task");
      expect((await startFor("session-future")).next.actions_by_id).not.toHaveProperty("checkpoint_long_task");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits checkpoint action noise without stable session and device identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-checkpoint-identity-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await initializeStore(store);
      await initializeProjectConfig(project, { project_id: "checkpoint-project" });
      for (const agent of [{ client: "codex" }, { client: "codex", session_id: "session-1" }]) {
        const start = await agentStart({
          storePath: store,
          projectPath: project,
          currentTask: "Continue",
          agent,
          pull: false
        });
        expect(
          start.next.actions.map((action) => action.action).filter((action) => action.includes("checkpoint"))
        ).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("learns after a Codex knowledge gap and reuses it in Claude Code without duplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-cross-agent-learning-"));
    const remote = join(root, "remote.git");
    const codexStore = join(root, "codex-store");
    const claudeStore = join(root, "claude-store");
    const project = join(root, "project");
    const learning = {
      question: "What is the project rollback policy?",
      conclusion: "Rollback requires restoring the previous signed release tag.",
      evidence_type: "user_confirmed" as const,
      scope: "project" as const,
      confidence: 1,
      recommended_kind: "memory" as const,
      recommended_type: "fact",
      related_record_ids: []
    };
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(codexStore, { id: () => "device-codex" });
      await initializeStore(claudeStore, { id: () => "device-claude" });
      await initializeGitSync(codexStore, remote);
      await initializeGitSync(claudeStore, remote);
      const codexEngine = createEngine({ storePath: codexStore });
      const gap = await codexEngine.recall({ project_id: "moryn", query: "project rollback signed release tag" });
      expect(gap.outcome).toMatchObject({ status: "knowledge_gap" });
      expect(gap.next_actions.map((action) => action.id)).toEqual([
        "explore_external_sources",
        "capture_confirmed_learning",
        "preserve_unresolved_investigation"
      ]);

      const checkpoint = await codexEngine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "codex-1", device_id: "device-codex" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: {
          session_id: "codex-1",
          checkpoint_id: "rollback-precompact",
          current_task: "Resolve rollback policy",
          progress: ["User confirmed rollback behavior"],
          learnings: [learning],
          knowledge_investigations: [
            {
              resolution_id: "rollback-policy",
              question: learning.question,
              recall_status: "knowledge_gap",
              recalled_record_ids: [],
              evidence: [
                { type: "user_confirmation", reference: "conversation", summary: "User confirmed signed-tag rollback" }
              ],
              status: "resolved",
              conclusion: learning.conclusion
            }
          ]
        }
      });
      expect(checkpoint.learning_ingestion).toMatchObject({ records_created: 1 });

      const codexFinish = await agentFinish(
        {
          storePath: codexStore,
          projectPath: project,
          agent: { client: "codex", session_id: "codex-1", device_id: "device-codex" },
          summary: "Codex learned the rollback policy.",
          learnings: [learning],
          push: true
        },
        { now: () => "2026-07-11T00:00:00.000Z" }
      );
      expect(codexFinish.learning_ingestion).toMatchObject({ records_created: 0 });

      const claudeStart = await agentStart({
        storePath: claudeStore,
        projectPath: project,
        currentTask: "Prepare rollback",
        agent: { client: "claude-code", session_id: "claude-1", device_id: "device-claude" },
        pull: true
      });
      expect(claudeStart.sync.pull?.pulled).toBe(true);
      expect(claudeStart.knowledge_protocol?.phases.map((phase) => phase.id)).toContain(
        "recall_before_external_exploration"
      );
      const claudeEngine = createEngine({ storePath: claudeStore });
      const broadRecall = await claudeEngine.recall({
        project_id: "moryn",
        query: "project rollback signed release tag"
      });
      expect(broadRecall.outcome).toMatchObject({ status: "verification_required" });
      expect(broadRecall.next_actions.map((action) => action.id)).toEqual([
        "inspect_recalled_candidate",
        "verify_with_external_evidence",
        "capture_confirmed_learning"
      ]);
      const recalled = await claudeEngine.recall({
        project_id: "moryn",
        query: "project rollback signed release tag",
        kinds: ["memory"]
      });
      expect(recalled.outcome).toMatchObject({ status: "trusted_match", trust: "trusted" });
      expect(recalled.next_actions.map((action) => action.id)).toEqual([
        "use_recalled_knowledge",
        "inspect_record_timeline"
      ]);
      expect(recalled.results[0]?.record.content.text).toBe(learning.conclusion);

      const repeated = await claudeEngine.ingestLearnings({
        project_id: "moryn",
        learnings: [{ ...learning, question: "How should Claude Code roll back?" }],
        occurred_at: "2026-07-11T00:10:00.000Z",
        source: { client: "claude-code", session_id: "claude-1", device_id: "device-claude" }
      });
      expect(repeated).toMatchObject({
        records_created: 0,
        dispositions: [{ created: false, record_id: codexFinish.learning_ingestion.dispositions[0]?.record_id }]
      });
      const dashboard = await buildDashboardData(claudeStore, { project_id: "moryn" });
      expect(dashboard.quiet_dashboard.knowledge_loop).toMatchObject({
        learned_records: 1,
        resolved_investigations: 1,
        unresolved_investigations: 0
      });
      expect(dashboard.quiet_dashboard.attention_needed).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("turns prompt-hook learning guidance into trusted recall after checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-prompt-learning-loop-"));
    const store = join(root, "store");
    const project = join(root, "project");
    const question = "Does rollback require restoring the previous signed release tag?";
    const conclusion = "Rollback requires restoring the previous signed release tag.";
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { id: () => "device-loop" });
      const hookBase = {
        host: "codex" as const,
        session_id: "loop-session",
        device_id: "device-loop",
        cwd: project,
        occurred_at: "2026-07-12T00:00:00.000Z"
      };

      const gap = await runHostHook({
        storePath: store,
        project_path: project,
        hook: { ...hookBase, event: "user_prompt_submit", prompt: question }
      });
      expect(gap).toMatchObject({ prompt_recall: { outcome: { status: "knowledge_gap" }, injected: true } });
      expect(gap.hook_output.additional_context).toContain("queue_learning");

      const checkpoint = await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Resolve rollback policy",
        hook: {
          ...hookBase,
          event: "pre_compact",
          trigger: "auto",
          compact_summary: "User confirmed the rollback policy."
        },
        learnings: [
          {
            question,
            conclusion,
            evidence_type: "user_confirmed",
            scope: "project",
            confidence: 1,
            recommended_kind: "memory",
            recommended_type: "fact",
            related_record_ids: []
          }
        ],
        knowledge_investigations: [
          {
            resolution_id: "prompt-loop",
            question,
            recall_status: "knowledge_gap",
            recalled_record_ids: [],
            evidence: [
              { type: "user_confirmation", reference: "conversation", summary: "User confirmed signed-tag rollback." }
            ],
            status: "resolved",
            conclusion
          }
        ]
      });
      expect(checkpoint).toMatchObject({ checkpoint: { learning_ingestion: { records_created: 1 } } });

      const recalled = await runHostHook({
        storePath: store,
        project_path: project,
        hook: { ...hookBase, occurred_at: "2026-07-12T00:01:00.000Z", event: "user_prompt_submit", prompt: question }
      });
      expect(recalled).toMatchObject({
        prompt_recall: { outcome: { status: "trusted_match" }, injected: true, record_count: 1 }
      });
      expect(recalled.hook_output.additional_context).toContain(conclusion);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("makes throttled turn statuses eventually visible on another device", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-turn-sync-cadence-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn", sync: { mode: "session" } });
      await initializeStore(storeA, { id: () => "device-a" });
      await initializeStore(storeB, { id: () => "device-b" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);
      const engineA = createEngine({ storePath: storeA });
      await engineA.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "cadence-session", device_id: "device-a" },
        occurred_at: "2026-07-12T00:00:00.000Z",
        delta: {
          session_id: "cadence-session",
          checkpoint_id: "cadence-evidence",
          progress: ["Implement bounded turn sync"]
        }
      });
      const hook = {
        host: "codex" as const,
        event: "stop" as const,
        session_id: "cadence-session",
        device_id: "device-a",
        cwd: project,
        occurred_at: "2026-07-12T00:01:00.000Z"
      };

      const first = await runHostHook({
        storePath: storeA,
        project_path: project,
        current_task: "Implement bounded turn sync",
        hook
      });
      expect(first).toMatchObject({ sync_cadence: { reason: "first_turn_sync", push_succeeded: true } });
      await pullGitSync(storeB);
      expect((await readEvents(storeB)).filter((event) => event.record?.type === "status")).toHaveLength(1);

      const second = await runHostHook({
        storePath: storeA,
        project_path: project,
        current_task: "Implement bounded turn sync",
        hook: { ...hook, occurred_at: "2026-07-12T00:05:00.000Z" }
      });
      expect(second).toMatchObject({
        action: "skip_duplicate_status",
        sync_cadence: { reason: "within_interval", push_requested: false }
      });
      await pullGitSync(storeB);
      expect((await readEvents(storeB)).filter((event) => event.record?.type === "status")).toHaveLength(1);

      const third = await runHostHook({
        storePath: storeA,
        project_path: project,
        current_task: "Implement bounded turn sync",
        hook: { ...hook, occurred_at: "2026-07-12T00:16:00.000Z" }
      });
      expect(third).toMatchObject({
        action: "skip_duplicate_status",
        sync_cadence: { reason: "interval_elapsed", push_succeeded: true }
      });
      await pullGitSync(storeB);
      expect((await readEvents(storeB)).filter((event) => event.record?.type === "status")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves checkpoint and handoff across Codex and Claude Code compaction hooks", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-cross-host-hooks-"));
    const remote = join(root, "remote.git");
    const codexStore = join(root, "codex-store");
    const claudeStore = join(root, "claude-store");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(codexStore, { id: () => "device-codex" });
      await initializeStore(claudeStore, { id: () => "device-claude" });
      await initializeGitSync(codexStore, remote);
      await initializeGitSync(claudeStore, remote);
      const codexBase = {
        host: "codex" as const,
        session_id: "codex-compact",
        device_id: "device-codex",
        cwd: project,
        occurred_at: "2026-07-11T00:00:00.000Z"
      };
      await runHostHook({
        storePath: codexStore,
        project_path: project,
        current_task: "Implement host hooks",
        pull: true,
        hook: { ...codexBase, event: "session_start", trigger: "startup" }
      });
      const checkpoint = await runHostHook({
        storePath: codexStore,
        project_path: project,
        current_task: "Implement host hooks",
        knowledge_investigations: [
          {
            resolution_id: "hook-rollback",
            question: "What is rollback policy?",
            recall_status: "knowledge_gap",
            recalled_record_ids: [],
            evidence: [],
            status: "unresolved",
            next_step: "Run rollback integration test"
          }
        ],
        hook: {
          ...codexBase,
          event: "pre_compact",
          trigger: "auto",
          compact_summary: "Hook runner implemented; next verify Claude restore."
        }
      });
      expect(checkpoint).toMatchObject({
        action: "checkpoint_before_compaction",
        checkpoint: { idempotent_replay: false },
        checkpoint_sync: { requested: true, reason: "new_checkpoint", succeeded: true, push: { pushed: true } }
      });

      const replay = await runHostHook({
        storePath: codexStore,
        project_path: project,
        current_task: "Implement host hooks",
        knowledge_investigations: [
          {
            resolution_id: "hook-rollback",
            question: "What is rollback policy?",
            recall_status: "knowledge_gap",
            recalled_record_ids: [],
            evidence: [],
            status: "unresolved",
            next_step: "Run rollback integration test"
          }
        ],
        hook: {
          ...codexBase,
          event: "pre_compact",
          trigger: "auto",
          compact_summary: "Hook runner implemented; next verify Claude restore."
        }
      });
      expect(replay).toMatchObject({
        checkpoint: { idempotent_replay: true },
        checkpoint_sync: { requested: false, reason: "idempotent_replay" }
      });

      const claudeRestore = await runHostHook({
        storePath: claudeStore,
        project_path: project,
        current_task: "Verify Claude restore",
        hook: {
          host: "claude",
          event: "post_compact",
          session_id: "codex-compact",
          device_id: "device-claude",
          cwd: project,
          occurred_at: "2026-07-11T00:05:00.000Z"
        }
      });
      expect(claudeRestore).toMatchObject({
        action: "resume_from_checkpoint",
        degradation: { mode: "native" },
        details: { sync: { pull: { pulled: true } } }
      });
      expect(claudeRestore.hook_output.additional_context).toContain(
        "Hook runner implemented; next verify Claude restore."
      );
      expect(claudeRestore.hook_output.additional_context).toContain("Run rollback integration test");
      const claudeEnd = await runHostHook({
        storePath: claudeStore,
        project_path: project,
        current_task: "Verify Claude restore",
        push: true,
        hook: {
          host: "claude",
          event: "session_end",
          session_id: "codex-compact",
          device_id: "device-claude",
          cwd: project,
          occurred_at: "2026-07-11T00:10:00.000Z"
        }
      });
      expect(claudeEnd).toMatchObject({
        action: "agent_finish",
        degradation: { mode: "native" },
        details: { record: { content: { synthesis_mode: "evidence_synthesized" } } }
      });

      const replayedEnd = await runHostHook({
        storePath: claudeStore,
        project_path: project,
        current_task: "Verify Claude restore",
        push: false,
        hook: {
          host: "claude",
          event: "session_end",
          session_id: "codex-compact",
          device_id: "device-claude",
          cwd: project,
          occurred_at: "2026-07-11T00:10:00.000Z"
        }
      });
      expect(replayedEnd).toMatchObject({
        action: "skip_duplicate_handoff",
        duplicate_handoff: { prior_record_id: (claudeEnd.details as { record: { id: string } }).record.id }
      });
      expect((await readEvents(claudeStore)).filter((event) => event.record?.type === "summary")).toHaveLength(1);

      expect((await pullGitSync(codexStore)).pulled).toBe(true);
      const codexStart = await agentStart({
        storePath: codexStore,
        projectPath: project,
        currentTask: "Review Claude handoff",
        agent: { client: "codex", session_id: "codex-next", device_id: "device-codex" },
        pull: false
      });
      expect(codexStart.handoff.inbox.filter((entry) => entry.type === "summary")).toHaveLength(1);
      const codexEngine = createEngine({ storePath: codexStore });
      const handoff = await codexEngine.recall({
        project_id: "moryn",
        query: "Hook runner implemented verify Claude restore rollback integration test"
      });
      expect(
        handoff.results.some(
          (result) =>
            result.record.content.synthesis_mode === "evidence_synthesized" &&
            result.record.content.text.includes("Hook runner implemented; next verify Claude restore.") &&
            result.record.content.text.includes("Run rollback integration test")
        )
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records one activation receipt for repeated host hook dispatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-host-activation-receipt-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { id: () => "device-claude" });
      const input = {
        storePath: store,
        project_path: project,
        activation_id: "moryn-v03-moryn-claude",
        command_digest: "b".repeat(64),
        hook: {
          host: "claude" as const,
          event: "pre_compact" as const,
          session_id: "activation-session",
          device_id: "device-claude",
          cwd: project,
          occurred_at: "2026-07-12T00:00:00.000Z",
          compact_summary: "Activation receipt checkpoint"
        }
      };

      const first = await runHostHook(input);
      const replay = await runHostHook(input);
      const receiptEvents = (await readEvents(store)).filter((event) => event.event_id.startsWith("evt_activation_"));

      expect(first.activation_receipt).toMatchObject({
        created: true,
        receipt: { activation_id: "moryn-v03-moryn-claude", event: "pre_compact" }
      });
      expect(replay.activation_receipt).toMatchObject({
        created: false,
        record: { id: first.activation_receipt?.record.id }
      });
      expect(receiptEvents).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("synthesizes a useful SessionEnd handoff from same-session checkpoint evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-host-synthesized-finish-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const base = {
        host: "claude" as const,
        session_id: "claude-synthesis",
        device_id: "device-claude",
        cwd: project
      };
      await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Implement autonomous summaries",
        hook: {
          ...base,
          event: "pre_compact",
          occurred_at: "2026-07-12T01:00:00.000Z",
          trigger: "auto",
          compact_summary: "Added checkpoint-backed synthesis."
        },
        knowledge_investigations: [
          {
            resolution_id: "synthesis-smoke",
            question: "Does compact preserve the handoff?",
            recall_status: "knowledge_gap",
            recalled_record_ids: [],
            evidence: [],
            status: "unresolved",
            next_step: "Run synthesized handoff smoke"
          }
        ]
      });

      const ended = await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Implement autonomous summaries",
        push: false,
        hook: { ...base, event: "session_end", occurred_at: "2026-07-12T01:05:00.000Z" }
      });
      expect(ended).toMatchObject({
        action: "agent_finish",
        details: {
          record: {
            content: {
              synthesis_mode: "evidence_synthesized",
              synthesis_source_record_ids: [expect.stringMatching(/^rec_checkpoint_/)]
            }
          }
        }
      });
      const endedText = (ended.details as { record: { content: { text: string } } }).record.content.text;
      expect(endedText).toContain("Task: Implement autonomous summaries");
      expect(endedText).toContain("Progress: Added checkpoint-backed synthesis.");
      expect(endedText).toContain("Next: Run synthesized handoff smoke");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("synthesizes in-progress Stop status from same-session checkpoint evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-host-synthesized-stop-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const base = { host: "codex" as const, session_id: "codex-synthesis", device_id: "device-codex", cwd: project };
      await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Continue autonomous work",
        hook: {
          ...base,
          event: "pre_compact",
          occurred_at: "2026-07-12T02:00:00.000Z",
          trigger: "auto",
          compact_summary: "Implemented evidence synthesis."
        }
      });

      const stopped = await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Continue autonomous work",
        push: false,
        hook: { ...base, event: "stop", occurred_at: "2026-07-12T02:05:00.000Z" }
      });
      expect(stopped).toMatchObject({
        action: "agent_status",
        details: {
          record: {
            content: { synthesis_mode: "evidence_synthesized", synthesis_progress: ["Implemented evidence synthesis."] }
          }
        }
      });
      const stoppedText = (stopped.details as { record: { content: { text: string } } }).record.content.text;
      expect(stoppedText).toContain("Task: Continue autonomous work");
      expect(stoppedText).toContain("Progress: Implemented evidence synthesis.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips repeated Codex Stop status when no durable evidence exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-host-empty-stop-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store, { id: () => "device-codex" });
      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: project,
        store_path: store
      });
      const base = { host: "codex" as const, session_id: "codex-empty", device_id: "device-codex", cwd: project };
      const first = await runHostHook({
        storePath: store,
        project_path: project,
        activation_id: artifact.activation_id,
        push: false,
        hook: { ...base, event: "stop", occurred_at: "2026-07-12T03:00:00.000Z" }
      });
      const second = await runHostHook({
        storePath: store,
        project_path: project,
        activation_id: artifact.activation_id,
        push: false,
        hook: { ...base, event: "stop", occurred_at: "2026-07-12T03:05:00.000Z" }
      });

      expect(first).toMatchObject({
        action: "skip_empty_status",
        skipped: { reason: "no_durable_session_evidence" },
        activation_receipt: { created: true }
      });
      expect(second).toMatchObject({
        action: "skip_empty_status",
        skipped: { reason: "no_durable_session_evidence" },
        activation_receipt: { created: false, record: { id: first.activation_receipt?.record.id } }
      });
      const records = (
        await createEngine({ storePath: store }).recall({ project_id: "moryn", kinds: ["session_summary"], limit: 20 })
      ).results;
      expect(records).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays bounded semantic consolidation across Codex and Claude Code without routine approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-cross-host-semantic-"));
    const remote = join(root, "remote.git");
    const codexStore = join(root, "codex-store");
    const claudeStore = join(root, "claude-store");
    const secondCodexStore = join(root, "second-codex-store");
    const project = join(root, "project");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeProjectConfig(project, { project_id: "moryn" });
      for (const [storePath, deviceId] of [
        [codexStore, "device-codex"],
        [claudeStore, "device-claude"],
        [secondCodexStore, "device-codex-2"]
      ] as const) {
        await initializeStore(storePath, { id: () => deviceId });
        await initializeGitSync(storePath, remote);
      }
      const codexEngine = createEngine({ storePath: codexStore, now: () => "2026-07-12T00:00:00.000Z" });
      const targets = await Promise.all([
        codexEngine.write({
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          content: { text: "Agents pull memory on project enter." },
          state: "canonical",
          confirmed: true,
          source: { client: "user" }
        }),
        codexEngine.write({
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          content: { text: "Checkpoint before compact preserves context." },
          source: { client: "codex" }
        }),
        codexEngine.write({
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          content: { text: "Finish sync is manually triggered." },
          source: { client: "codex" }
        }),
        codexEngine.write({
          kind: "memory",
          type: "fact",
          scope: "project",
          project_id: "moryn",
          content: { text: "Retry 3 times." },
          source: { client: "codex" }
        })
      ]);
      const evidence = await codexEngine.write({
        kind: "memory",
        type: "evidence",
        scope: "project",
        project_id: "moryn",
        content: { text: "Lifecycle source code confirms automatic finish sync." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learnings = [
        {
          question: "When do agents pull?",
          conclusion: "Agents pull memories when entering a project.",
          evidence_type: "source_code" as const,
          scope: "project" as const,
          confidence: 0.99,
          recommended_kind: "memory" as const,
          recommended_type: "fact",
          related_record_ids: []
        },
        {
          question: "What protects compact?",
          conclusion: "A checkpoint immediately before compact preserves task context.",
          evidence_type: "source_code" as const,
          scope: "project" as const,
          confidence: 0.99,
          recommended_kind: "memory" as const,
          recommended_type: "fact",
          related_record_ids: []
        },
        {
          question: "How does finish sync?",
          conclusion: "Finish now triggers sync automatically.",
          evidence_type: "source_code" as const,
          scope: "project" as const,
          confidence: 0.99,
          recommended_kind: "memory" as const,
          recommended_type: "fact",
          related_record_ids: []
        },
        {
          question: "How many retries?",
          conclusion: "Retry 4 times.",
          evidence_type: "source_code" as const,
          scope: "project" as const,
          confidence: 0.99,
          recommended_kind: "memory" as const,
          recommended_type: "fact",
          related_record_ids: []
        }
      ];
      const sourceIds = learnings.map(
        (learning) => learningRecordIdentity({ project_id: "moryn", learning }).record_id
      );
      const proposals = [
        {
          proposal_id: "cross-duplicate",
          source_record_id: sourceIds[0],
          target_record_id: targets[0].record.id,
          relationship: "duplicate_of" as const,
          confidence: 0.99,
          rationale: "Equivalent enter behavior.",
          semantic_equivalence: "equivalent" as const,
          material_differences: [],
          evidence_record_ids: []
        },
        {
          proposal_id: "cross-revision",
          source_record_id: sourceIds[1],
          target_record_id: targets[1].record.id,
          relationship: "revises" as const,
          confidence: 0.98,
          rationale: "Refines compact timing.",
          semantic_equivalence: "refinement" as const,
          material_differences: [
            {
              field: "timing",
              before: "before compact",
              after: "immediately before compact",
              significance: "minor" as const
            }
          ],
          evidence_record_ids: [evidence.record.id]
        },
        {
          proposal_id: "cross-replacement",
          source_record_id: sourceIds[2],
          target_record_id: targets[2].record.id,
          relationship: "supersedes" as const,
          confidence: 0.99,
          rationale: "Replaces manual finish sync behavior.",
          semantic_equivalence: "replacement" as const,
          material_differences: [
            { field: "trigger", before: "manual", after: "automatic", significance: "material" as const }
          ],
          evidence_record_ids: [evidence.record.id]
        },
        {
          proposal_id: "cross-protected",
          source_record_id: sourceIds[3],
          target_record_id: targets[3].record.id,
          relationship: "duplicate_of" as const,
          confidence: 0.99,
          rationale: "Incorrectly treats retry count as equivalent.",
          semantic_equivalence: "equivalent" as const,
          material_differences: [{ field: "retry count", before: "3", after: "4", significance: "minor" as const }],
          evidence_record_ids: []
        }
      ];
      const checkpoint = await codexEngine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "codex-semantic", device_id: "device-codex" },
        occurred_at: "2026-07-12T00:05:00.000Z",
        delta: {
          session_id: "codex-semantic",
          checkpoint_id: "semantic-cross-host",
          current_task: "Verify semantic lifecycle",
          progress: ["Codex authored bounded proposals"],
          learnings,
          semantic_consolidation_proposals: proposals
        }
      });
      expect(checkpoint.semantic_consolidation).toMatchObject({
        proposals_received: 4,
        proposals_accepted: 3,
        proposals_rejected: 1,
        rejected_by_reason: { protected_signal_difference: 1 }
      });
      expect((await pushGitSync(codexStore, { message: "codex semantic checkpoint" })).pushed).toBe(true);

      const claudeRestore = await runHostHook({
        storePath: claudeStore,
        project_path: project,
        current_task: "Verify semantic lifecycle",
        pull: true,
        hook: {
          host: "claude",
          event: "post_compact",
          session_id: "codex-semantic",
          device_id: "device-claude",
          cwd: project,
          occurred_at: "2026-07-12T00:10:00.000Z"
        }
      });
      expect(claudeRestore.hook_output.additional_context).toContain("Codex authored bounded proposals");
      const claudeEngine = createEngine({ storePath: claudeStore, now: () => "2026-07-12T00:11:00.000Z" });
      const repeated = await Promise.all([
        claudeEngine.consolidateSemanticProposals({
          proposals: proposals.slice(0, 3),
          project_id: "moryn",
          source: { client: "claude-code", session_id: "claude-semantic" }
        }),
        claudeEngine.consolidateSemanticProposals({
          proposals: proposals.slice(0, 3),
          project_id: "moryn",
          source: { client: "codex", session_id: "codex-replay" }
        })
      ]);
      expect(repeated).toEqual(repeated.map((receipt) => expect.objectContaining({ idempotent_replays: 3 })));
      const finish = await agentFinish({
        storePath: claudeStore,
        projectPath: project,
        currentTask: "Verify semantic lifecycle",
        agent: { client: "claude-code", session_id: "claude-semantic", device_id: "device-claude" },
        summary: "Claude verified semantic links and protected rejection.",
        push: true
      });
      expect(finish.sync.push?.pushed).toBe(true);

      expect((await pullGitSync(secondCodexStore)).pulled).toBe(true);
      const secondEngine = createEngine({ storePath: secondCodexStore });
      const active = await secondEngine.recall({
        project_id: "moryn",
        record_ids: [sourceIds[3], targets[3].record.id]
      });
      expect(active.results.map((result) => result.record.id).sort()).toEqual(
        [sourceIds[3], targets[3].record.id].sort()
      );
      const semanticEvents = (await readEvents(secondCodexStore)).filter((event) =>
        event.event_id.startsWith("evt_semantic_consolidation_")
      );
      expect(semanticEvents).toHaveLength(3);
      expect(new Set(semanticEvents.map((event) => event.event_id)).size).toBe(3);
      const dashboard = await buildDashboardData(secondCodexStore, { project_id: "moryn" });
      expect(dashboard.quiet_dashboard.attention_needed).toEqual([]);
      expect(dashboard.decision_summary.items).toEqual([]);
      const handoff = await secondEngine.recall({
        project_id: "moryn",
        query: "Claude verified semantic links protected rejection"
      });
      expect(
        handoff.results.some(
          (result) => result.record.content.text === "Claude verified semantic links and protected rejection."
        )
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["codex", "claude-code"])(
    "returns the autonomous knowledge protocol from guide and start for %s",
    async (client) => {
      const root = await mkdtemp(join(tmpdir(), "moryn-agent-knowledge-protocol-"));
      const store = join(root, "store");
      const project = join(root, "project");
      try {
        await initializeProjectConfig(project, { project_id: "moryn" });
        await initializeStore(store, { now: () => "2026-07-12T00:00:00.000Z", id: () => `device_${client}` });
        const agent = { client, session_id: `session-${client}` };

        const guide = await agentGuide({
          storePath: store,
          projectPath: project,
          currentTask: "Resolve unknown project knowledge",
          agent
        });
        const start = await agentStart({
          storePath: store,
          projectPath: project,
          currentTask: "Resolve unknown project knowledge",
          agent,
          pull: false
        });

        expect(guide.activation_status?.host).toBe(client === "codex" ? "codex" : "claude");
        expect(guide.activation_status?.status).toBe("not_installed");

        for (const result of [guide, start]) {
          expect(result.knowledge_protocol?.phases.map((phase) => phase.id)).toEqual([
            "recall_before_external_exploration",
            "follow_recall_actions",
            "capture_confirmed_learning",
            "preserve_before_compaction"
          ]);
          expect(result.knowledge_protocol?.rules_by_id.recall_first.action).toBe(
            "call_moryn_recall_before_broad_external_exploration"
          );
          expect(result.knowledge_protocol?.rules_by_id.compact_safety.action).toBe(
            "checkpoint_resolved_learning_and_unresolved_investigation_before_host_compaction"
          );
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["claude-code", "claude", ".claude/settings.local.json"],
    ["codex", "codex", ".codex/hooks.json"]
  ])("self-heals %s activation once during agent enter", async (client, host, target) => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-enter-activation-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const hostRuntime = {
        exec_file: "/runtime/node",
        cli_entry: "/runtime/moryn/dist/cli.js",
        package_version: "0.3.0"
      };
      const entered = await agentEnter({
        storePath: store,
        projectPath: project,
        currentTask: "Start with active hooks",
        agent: { client, session_id: `${host}-enter`, device_id: "device-1" },
        pull: false,
        hostRuntime
      });

      expect(entered.mode).toBe("start_session");
      expect(entered.activation).toMatchObject({
        attempted_repair: true,
        repair_succeeded: true,
        before: { status: "not_installed" },
        after: { status: "configured_unverified" }
      });
      expect(entered.start.activation_status).toMatchObject({ status: "configured_unverified", host });
      const configured = JSON.parse(await readFile(join(project, target), "utf8"));
      expect(configured.hooks.PreCompact).toBeDefined();
      expect(configured.hooks.PreCompact[0].hooks[0].command).toMatch(
        /^'\/runtime\/node' '\/runtime\/moryn\/dist\/cli\.js' --store/
      );
      const repeated = await agentEnter({
        storePath: store,
        projectPath: project,
        currentTask: "Continue with active hooks",
        agent: { client, session_id: `${host}-enter-2`, device_id: "device-1" },
        pull: false,
        hostRuntime
      });
      expect(repeated.activation).toMatchObject({
        attempted_repair: false,
        repair_succeeded: false,
        before: { status: "configured_unverified" },
        after: { status: "configured_unverified" }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bootstraps an absent store before Codex enter self-heals activation", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-enter-codex-bootstrap-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      const entered = await agentEnter({
        storePath: store,
        projectPath: project,
        currentTask: "Start from zero setup",
        agent: { client: "codex", session_id: "codex-zero", device_id: "device-1" },
        pull: false
      });
      expect(entered.activation).toMatchObject({
        attempted_repair: true,
        repair_succeeded: true,
        before: { status: "not_installed" },
        after: { status: "configured_unverified" }
      });
      expect(entered.start.activation_status).toMatchObject({ status: "configured_unverified", host: "codex" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["claude-code", "claude", ".claude/settings.local.json"],
    ["codex", "codex", ".codex/hooks.json"]
  ])("continues %s enter with degraded activation when safe repair is impossible", async (client, host, target) => {
    const root = await mkdtemp(join(tmpdir(), "moryn-agent-enter-activation-invalid-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn" });
      await initializeStore(store);
      const targetPath = join(project, target);
      await mkdir(join(targetPath, ".."), { recursive: true });
      await writeFile(targetPath, '{"hooks":', "utf8");

      const entered = await agentEnter({
        storePath: store,
        projectPath: project,
        currentTask: "Continue despite activation issue",
        agent: { client, session_id: `${host}-invalid`, device_id: "device-1" },
        pull: false
      });

      expect(entered.mode).toBe("start_session");
      expect(entered.activation).toMatchObject({
        attempted_repair: false,
        repair_succeeded: false,
        before: { status: "invalid_config" },
        after: { status: "invalid_config" }
      });
      expect(entered.start.activation_status).toMatchObject({ status: "invalid_config", host });
      expect(await readFile(targetPath, "utf8")).toBe('{"hooks":');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("finalization assurance", () => {
  it("recovers an unfinalized prior Codex checkpoint and consumes its Learning Inbox on next start", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-finalization-assurance-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn", sync: { mode: "manual" } });
      await initializeStore(store);
      const engine = createEngine({ storePath: store, now: () => "2026-07-13T00:05:00.000Z" });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "prior-session", device_id: "device-a" },
        occurred_at: "2026-07-13T00:05:00.000Z",
        delta: {
          session_id: "prior-session",
          checkpoint_id: "prior-compact",
          current_task: "Finish resilient finalization",
          progress: ["Implemented detector"],
          decisions: [],
          changed_facts: [],
          blockers: [],
          next_steps: ["Start a new Codex session"],
          files: [],
          candidate_memories: [],
          candidate_skills: [],
          learnings: [],
          knowledge_investigations: [],
          semantic_consolidation_proposals: []
        }
      });
      const queued = await queueLearning(store, {
        project_id: "moryn",
        question: "How are abandoned sessions sealed?",
        conclusion: "The next session recovers an abandoned prior session.",
        evidence_type: "source_code",
        source: { client: "codex", session_id: "prior-session", device_id: "device-a" },
        occurred_at: "2026-07-13T00:06:00.000Z"
      });

      const first = await agentStart(
        {
          storePath: store,
          projectPath: project,
          currentTask: "Continue finalization work",
          agent: { client: "codex", session_id: "current-session", device_id: "device-a" },
          pull: false
        },
        { now: () => "2026-07-13T00:10:00.000Z" }
      );
      const second = await agentStart(
        {
          storePath: store,
          projectPath: project,
          currentTask: "Continue finalization work",
          agent: { client: "codex", session_id: "current-session", device_id: "device-a" },
          pull: false
        },
        { now: () => "2026-07-13T00:11:00.000Z" }
      );

      expect(first).toMatchObject({
        finalization_assurance: {
          status: "recovered",
          prior_session: { session_id: "prior-session" },
          evidence_record_ids: [expect.stringMatching(/^rec_checkpoint_/)],
          recovered_handoff_record_id: expect.stringMatching(/^rec_/),
          learning_inbox: { selected: 1, consumed: 1 }
        }
      });
      expect(second).toMatchObject({
        finalization_assurance: {
          status: "already_finalized",
          prior_session: { session_id: "prior-session" },
          final_record_id: first.finalization_assurance?.recovered_handoff_record_id
        }
      });
      const [inbox] = await pendingLearningInbox(store, { project_id: "moryn", include_consumed: true });
      expect(inbox).toMatchObject({
        id: queued.record.id,
        content: {
          status: "consumed",
          consumed_by_record_id: first.finalization_assurance?.recovered_handoff_record_id
        }
      });
      const summaries = (
        await createEngine({ storePath: store }).recall({
          project_id: "moryn",
          kinds: ["session_summary"],
          types: ["summary"],
          limit: 20
        })
      ).results;
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.record.content).toMatchObject({
        finalization_assurance_version: 1,
        finalization_recovery_key: expect.stringMatching(/^finalize_/),
        synthesis_mode: "evidence_synthesized"
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a status-only prior Codex session without changing Stop semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-finalization-status-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, { project_id: "moryn", sync: { mode: "manual" } });
      await initializeStore(store);
      const stopped = await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Implement status recovery",
        push: false,
        hook: {
          host: "codex",
          event: "stop",
          session_id: "prior-status",
          device_id: "device-a",
          cwd: project,
          occurred_at: "2026-07-13T01:00:00.000Z",
          last_assistant_message: "Implemented status-only finalization evidence."
        }
      });
      expect(stopped).toMatchObject({ action: "agent_status" });

      const started = await runHostHook({
        storePath: store,
        project_path: project,
        current_task: "Continue work",
        pull: false,
        hook: {
          host: "codex",
          event: "session_start",
          session_id: "current-status",
          device_id: "device-a",
          cwd: project,
          occurred_at: "2026-07-13T01:05:00.000Z"
        }
      });
      expect(started).toMatchObject({
        action: "agent_start",
        details: {
          finalization_assurance: {
            status: "recovered",
            prior_session: { session_id: "prior-status" },
            recovered_handoff_record_id: expect.stringMatching(/^rec_/)
          }
        }
      });
      expect(started.hook_output.additional_context).toContain("finalization_assurance");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
