import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { agentDoctor, agentEnter, agentFinish, agentStart, agentStatus } from "../../src/core/agent-lifecycle.js";
import { initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";

const exec = promisify(execFile);
const LIFECYCLE_ACTION_SELECTION_SOURCES = {
  action: "next.actions_by_id.<action>",
  action_id: "next.actions_by_id.<action>.action",
  ordered_action: "next.actions[]",
  argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
  ordered_argument: "next.actions[].arguments_by_name.<argument>",
  required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
  ordered_required_field: "next.actions[].required_fields_by_name.<field>",
  required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
  ordered_required_input: "next.actions[].execution.required_inputs_by_field.<field>",
  argument_source: "next.actions_by_id.<action>.argument_sources.<field>",
  ordered_argument_source: "next.actions[].argument_sources.<field>"
};
const DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES = {
  lifecycle_action: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>",
  step: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.step",
  ordered_lifecycle_action: "next.actions_by_project_id.<project_id>.lifecycle[]",
  argument: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.arguments_by_name.<argument>",
  ordered_argument: "next.actions_by_project_id.<project_id>.lifecycle[].arguments_by_name.<argument>",
  required_field: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.required_fields_by_name.<field>",
  ordered_required_field: "next.actions_by_project_id.<project_id>.lifecycle[].required_fields_by_name.<field>",
  required_input: "next.actions_by_project_id.<project_id>.lifecycle_by_step.<step>.execution.required_inputs_by_field.<field>",
  ordered_required_input: "next.actions_by_project_id.<project_id>.lifecycle[].execution.required_inputs_by_field.<field>",
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
  recent_change: "recent_changes_by_id.<record_id>"
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
        files.push(...await walk(fullPath, relative));
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
  await writeFile(join(input.storeA, input.conflictFile), "{\"from\":\"a\"}\n", "utf8");
  await writeFile(join(input.storeB, input.conflictFile), "{\"from\":\"b\"}\n", "utf8");
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

function expectRefreshChangeNextAction(action: {
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
}, recordId: string, projectId: string) {
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
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
      argument: "refresh.changes_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
      ordered_argument: "refresh.changes[].next_action.arguments_by_name.<argument>",
      required_field: "refresh.changes_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
      ordered_required_field: "refresh.changes[].next_action.required_fields_by_name.<field>",
      required_input: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
      ordered_required_input: "refresh.changes[].next_action.execution.required_inputs_by_field.<field>",
      argument_source: "refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>",
      ordered_argument_source: "refresh.changes[].next_action.argument_sources.<field>"
    }
  });
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
  expect(action.arguments_by_name?.record_ids).toMatchObject({
    name: "record_ids",
    type: "string[]",
    required: false,
    cli: { flag: "--record-id", repeatable: true },
    mcp: { argument: "record_ids" }
  });
  expectActionExecution(action);
}

function expectHandoffEntryNextAction(action: {
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
}, recordId: string, projectId: string, source: "inbox" | "active_sessions" = "inbox") {
  const actionSource = source === "inbox"
    ? "handoff.inbox_by_record_id.<record_id>.next_action"
    : "handoff.active_sessions_by_record_id.<record_id>.next_action";
  const recordIdSource = source === "inbox"
    ? "handoff.inbox_by_record_id.<record_id>.record_id"
    : "handoff.active_sessions_by_record_id.<record_id>.record_id";
  expect(action).toMatchObject({
    recommended_action: "call_recall_with_record_id",
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
      argument_source: `${actionSource}.argument_sources.<field>`,
      ordered_argument_source: source === "inbox"
        ? "handoff.inbox[].next_action.argument_sources.<field>"
        : "handoff.active_sessions[].next_action.argument_sources.<field>"
    },
    interfaces: {
      cli: { command: `moryn recall --record-id ${recordId} --project-id ${projectId}` },
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
  selection_sources?: Record<string, string>;
  safe_to_run?: boolean;
  required_fields?: string[];
  required_fields_by_name?: Record<string, { argument_path?: string }>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
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
    Object.entries(action.selection_sources ?? {}).filter(([key]) => key.endsWith("required_input"))
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
      next_step: "collect_required_fields"
    });
  } else if (action.safety?.requires_user_confirmation) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "confirm_with_user"
    });
  } else {
    expect(action.execution).toMatchObject({
      ready_to_run: action.safe_to_run,
      next_step: action.safe_to_run ? "run" : "do_not_auto_run"
    });
  }
  expect(action.execution?.reason).toEqual(expect.any(String));
}

function expectDiscoveredLifecycleStepSelectionSources(action: {
  selection_sources?: Record<string, string>;
  safe_to_run?: boolean;
  required_fields?: string[];
  required_fields_by_name?: Record<string, { argument_path?: string }>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
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

      const codexFinish = await agentFinish({
        storePath: storeA,
        projectPath: project,
        agent: { client: "codex", device_id: "device_codex", session_id: "codex-1" },
        summary: "Codex finished lifecycle wiring and left a Gemini handoff.",
        push: true
      });

      expect(codexFinish.project.project_id).toBe("moryn");
      expect(codexFinish.record.content.text).toBe("Codex finished lifecycle wiring and left a Gemini handoff.");
      expect(codexFinish.sync.push?.pushed).toBe(true);
      expect(codexFinish.next.recommended_start_command).toBe("moryn agent start --project <path> --current-task <task>");
      expect(codexFinish.next.recommended_start_action_id).toBe("start_next_session");
      expect(codexFinish.next.recommended_start_action_source).toBe("next.actions_by_id.start_next_session");
      expect(codexFinish.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(codexFinish.next.actions).toContainEqual(expect.objectContaining({
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
      }));
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
      expect(geminiStart.refresh.changes).toEqual([
        expect.objectContaining({
          importance: "notice",
          summary: "Codex finished lifecycle wiring and left a Gemini handoff.",
          recommended_action: "call recall with record_id",
          next_action: expect.any(Object)
        })
      ]);
      expect(geminiStart.refresh.changes_by_record_id[codexFinish.record.id]).toEqual(geminiStart.refresh.changes[0]);
      expect(geminiStart.refresh.selection_sources).toEqual({
        change: "changes_by_record_id.<record_id>",
        record_id: "changes_by_record_id.<record_id>.record_id",
        next_action: "changes_by_record_id.<record_id>.next_action"
      });
      expectRefreshChangeNextAction(geminiStart.refresh.changes[0]!.next_action, codexFinish.record.id, "moryn");
      expect(geminiStart.refresh.changes_by_record_id[codexFinish.record.id]!.next_action).toEqual(geminiStart.refresh.changes[0]!.next_action);
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
        inbox_next_action_argument: "handoff.inbox_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        inbox_next_action_required_field: "handoff.inbox_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        inbox_next_action_required_input: "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        inbox_next_action_argument_source: "handoff.inbox_by_record_id.<record_id>.next_action.argument_sources.<field>",
        active_session_entry: "handoff.active_sessions_by_record_id.<record_id>",
        active_session_record_id: "handoff.active_sessions_by_record_id.<record_id>.record_id",
        active_session_next_action: "handoff.active_sessions_by_record_id.<record_id>.next_action",
        active_session_next_action_argument: "handoff.active_sessions_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        active_session_next_action_required_field: "handoff.active_sessions_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        active_session_next_action_required_input: "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        active_session_next_action_argument_source: "handoff.active_sessions_by_record_id.<record_id>.next_action.argument_sources.<field>"
      });
      expect(geminiStart.handoff.active_sessions_by_record_id).toEqual({});
      expectHandoffEntryNextAction(geminiStart.handoff.inbox[0]!.next_action, codexFinish.record.id, "moryn");
      expect(geminiStart.handoff.inbox_by_record_id[codexFinish.record.id]!.next_action).toEqual(geminiStart.handoff.inbox[0]!.next_action);
      expect(geminiStart.handoff.next_action).toEqual(geminiStart.handoff.inbox[0]!.next_action);
      expectHandoffEntryNextAction(geminiStart.handoff.next_action!, codexFinish.record.id, "moryn");
      expect(geminiStart.boot.recent_changes.map((record) => record.content.text)).toContain("Codex finished lifecycle wiring and left a Gemini handoff.");
      expect(geminiStart.next.required_end_action).toBe("call agent_finish with a session_summary");
      expect(geminiStart.next.required_end_action_id).toBe("finish_session");
      expect(geminiStart.next.required_end_action_source).toBe("next.actions_by_id.finish_session");
      expect(geminiStart.next.recommended_refresh_action_id).toBe("refresh_context");
      expect(geminiStart.next.recommended_refresh_action_source).toBe("next.actions_by_id.refresh_context");
      expect(geminiStart.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(geminiStart.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        tool: "agent_status",
        safe_to_run: false,
        command: expect.stringContaining("moryn agent status"),
        required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
        required_fields: ["status"],
        argument_sources: {
          status: "user_input.status"
        },
        arguments: expect.objectContaining({
          project_path: project,
          status: "<status>",
          current_task: "continue lifecycle wiring",
          agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
        })
      }));
      expect(geminiStart.next.actions).toContainEqual(expect.objectContaining({
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
          summary: "<summary>",
          current_task: "continue lifecycle wiring",
          agent: { client: "gemini", device_id: "device_gemini", session_id: "gemini-1" }
        })
      }));
      expect(geminiStart.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        tool: "agent_start",
        safe_to_run: true,
        command: expect.stringContaining("--refresh-since"),
        required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
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
      }));
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
      expect(recall.results[0]?.record.content.text).toBe("Gemini picked up the Codex handoff and continued lifecycle wiring.");
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
      expect(firstStart.refresh.changes).toContainEqual(expect.objectContaining({
        summary: "Fresh Codex device bootstrapped Moryn and pushed a handoff.",
        importance: "notice"
      }));
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
      expect(status.next.actions).toContainEqual(expect.objectContaining({
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
          current_task: "lifecycle status propagation"
        })
      }));
      expect(status.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        tool: "agent_start",
        safe_to_run: true,
        command: expect.stringContaining("moryn agent start"),
        required_when: "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.",
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
      }));
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

      expect(start.refresh.changes).toContainEqual(expect.objectContaining({
        importance: "notice",
        summary: "Codex is refactoring lifecycle status propagation.",
        recommended_action: "call recall with record_id"
      }));
      expect(start.boot.recent_changes).toContainEqual(expect.objectContaining({
        type: "status",
        content: expect.objectContaining({ text: "Codex is refactoring lifecycle status propagation." })
      }));
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
        inbox_next_action_argument: "handoff.inbox_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        inbox_next_action_required_field: "handoff.inbox_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        inbox_next_action_required_input: "handoff.inbox_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        inbox_next_action_argument_source: "handoff.inbox_by_record_id.<record_id>.next_action.argument_sources.<field>",
        active_session_entry: "handoff.active_sessions_by_record_id.<record_id>",
        active_session_record_id: "handoff.active_sessions_by_record_id.<record_id>.record_id",
        active_session_next_action: "handoff.active_sessions_by_record_id.<record_id>.next_action",
        active_session_next_action_argument: "handoff.active_sessions_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
        active_session_next_action_required_field: "handoff.active_sessions_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
        active_session_next_action_required_input: "handoff.active_sessions_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
        active_session_next_action_argument_source: "handoff.active_sessions_by_record_id.<record_id>.next_action.argument_sources.<field>"
      });
      expectHandoffEntryNextAction(start.handoff.active_sessions[0]!.next_action, status.record.id, "moryn", "active_sessions");
      expect(start.handoff.active_sessions_by_record_id[status.record.id]!.next_action).toEqual(start.handoff.active_sessions[0]!.next_action);
      expect(start.handoff.next_action).toEqual(start.handoff.active_sessions[0]!.next_action);
      expectHandoffEntryNextAction(start.handoff.next_action!, status.record.id, "moryn", "active_sessions");
      expect(start.handoff.inbox).toEqual([]);
      expect(start.handoff.inbox_by_record_id).toEqual({});
      expect(start.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        tool: "agent_status",
        required_fields: ["status"],
        arguments: expect.objectContaining({
          project_path: project,
          sync_remote: remote,
          current_task: "coordinate lifecycle status propagation"
        })
      }));
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
      expect(start.handoff.active_sessions).not.toContainEqual(expect.objectContaining({
        text: "Codex left an old status that should not look active forever."
      }));
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
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "store",
        ok: false,
        severity: "notice"
      }));
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "sync",
        ok: false,
        severity: "notice"
      }));
      expect(doctor.checks_by_name.store).toEqual(doctor.checks.find((check) => check.name === "store"));
      expect(doctor.checks_by_name.project).toEqual(doctor.checks.find((check) => check.name === "project"));
      expect(doctor.checks_by_name.sync).toEqual(doctor.checks.find((check) => check.name === "sync"));
      expect(doctor.selection_sources).toEqual({
        check: "checks_by_name.<check_name>",
        blocking_check: "readiness.blocking_checks_by_name.<check_name>",
        next_action: "next",
        next_argument: "next.arguments_by_name.<argument>",
        next_required_field: "next.required_fields_by_name.<field>",
        next_required_input: "next.execution.required_inputs_by_field.<field>",
        next_argument_source: "next.argument_sources.<field>"
      });
      expect(doctor.next).toMatchObject({
        recommended_action: "call_agent_start",
        tool: "agent_start",
        safe_to_run: true
      });
      expect(doctor.next.actions).toContainEqual(expect.objectContaining({
        action: "run_lifecycle_smoke",
        tool: "moryn-agent-smoke",
        safe_to_run: true,
        command: expect.stringContaining("moryn-agent-smoke"),
        required_when: "Before trusting lifecycle sync on a new machine or remote.",
        required_fields: [],
        arguments: expect.objectContaining({
          remote
        })
      }));
      expect(doctor.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
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

      expect(doctor.next.actions).toContainEqual(expect.objectContaining({
        action: "run_lifecycle_smoke",
        tool: "moryn-agent-smoke",
        safe_to_run: true,
        command: "moryn-agent-smoke --remote <remote>",
        required_when: "Before trusting lifecycle sync on a new machine or remote.",
        required_fields: ["remote"],
        argument_sources: {
          remote: "user_input.remote"
        },
        arguments: { remote: "<remote>" }
      }));
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
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "sync",
        ok: false,
        severity: "warning",
        message: expect.stringContaining("conflict")
      }));
      expect(doctor.next).toMatchObject({
        recommended_action: "resolve_sync_conflict_before_lifecycle",
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
      expect(doctor.checks_by_name.sync).toEqual(expect.objectContaining({
        name: "sync",
        ok: false,
        severity: "warning",
        message: "Sync has unresolved Git conflicts; inspect sync_status and resolve conflicts before lifecycle writes."
      }));

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

      await expect(agentStart({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        currentTask: "avoid sync conflict hallucination",
        agent: { client: "codex", session_id: "codex-conflict" }
      })).rejects.toThrow("Sync conflict: resolve Git conflicts before lifecycle writes");

      const filesBeforeWrites = await eventFiles(storeB);
      await expect(agentStatus({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        currentTask: "avoid sync conflict hallucination",
        status: "Do not write status while sync is conflicted.",
        agent: { client: "codex", session_id: "codex-conflict" }
      })).rejects.toThrow("Sync conflict: resolve Git conflicts before lifecycle writes");
      await expect(agentFinish({
        storePath: storeB,
        projectPath: project,
        syncRemote: remote,
        summary: "Do not write finish handoff while sync is conflicted.",
        agent: { client: "codex", session_id: "codex-conflict" }
      })).rejects.toThrow("Sync conflict: resolve Git conflicts before lifecycle writes");
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
        tool: "project_list",
        safe_to_run: true,
        command: "moryn project list"
      });
      expect(doctor.readiness).toEqual({
        safe_to_start: false,
        blocking_checks: [],
        blocking_checks_by_name: {},
        recommended_action: "list_projects",
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
      expect(doctor.next.actions).toContainEqual(expect.objectContaining({
        action: "list_projects",
        tool: "project_list",
        command: "moryn project list",
        required_when: "When the shared store has projects but this agent has no explicit project context.",
        required_fields: [],
        arguments: {}
      }));
      expect(doctor.next.actions_by_id.list_projects).toEqual(doctor.next.actions[0]);
      expectLifecycleActionSelectionSources(doctor.next.actions_by_id.list_projects);
      expect(doctor.next.selection_sources).toEqual({
        action: "next.actions_by_id.<action>",
        action_id: "next.actions_by_id.<action>.action",
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
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
            start_action: "next.actions_by_project_id.<project_id>",
            start_action_argument: "next.actions_by_project_id.<project_id>.arguments_by_name.<argument>",
            start_action_required_field: "next.actions_by_project_id.<project_id>.required_fields_by_name.<field>",
            start_action_required_input: "next.actions_by_project_id.<project_id>.execution.required_inputs_by_field.<field>",
            start_action_argument_source: "next.actions_by_project_id.<project_id>.argument_sources.<field>",
            lifecycle_actions: "next.actions_by_project_id.<project_id>.lifecycle_by_step"
          },
          arguments: { project_id: "<project_id>" },
          safety: {
            safe_to_auto_run: true,
            requires_user_confirmation: false,
            requires_authored_input: true,
            writes_local_config: false,
            reasons: ["required_fields"]
          }
        }
      });
      expect(entered.next.command).toBe("moryn agent start --project-id <project_id> --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list");
      expect(entered.next.interfaces).toEqual({
        cli: { command: entered.next.command },
        mcp: {
          tool: "agent_start",
          arguments: { project_id: "<project_id>" }
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
            command: "moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list"
          }),
          expect.objectContaining({
            step: "publish_status",
            tool: "agent_status",
            safe_to_run: false,
            command: "moryn agent status --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list --status <status>",
            required_fields: ["status"],
            argument_sources: {
              status: "user_input.status"
            },
            arguments: expect.objectContaining({ project_id: "moryn", status: "<status>" })
          }),
          expect.objectContaining({
            step: "finish_handoff",
            tool: "agent_finish",
            safe_to_run: false,
            command: "moryn agent finish --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list --summary <summary>",
            required_fields: ["summary"],
            argument_sources: {
              summary: "user_input.summary"
            },
            arguments: expect.objectContaining({ project_id: "moryn", summary: "<summary>" })
          }),
          expect.objectContaining({
            step: "refresh_context",
            tool: "agent_start",
            safe_to_run: true,
            command: "moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list --refresh-since <refresh_since>",
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
      expect(entered.next.actions[0]?.lifecycle_by_step.publish_status).toEqual(discoveredLifecycle.find((action) => action.step === "publish_status"));
      expect(entered.next.actions[0]?.lifecycle_by_step.finish_handoff).toEqual(discoveredLifecycle.find((action) => action.step === "finish_handoff"));
      expect(entered.next.actions[0]?.lifecycle_by_step.refresh_context).toEqual(discoveredLifecycle.find((action) => action.step === "refresh_context"));
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
          command: "moryn agent start --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task 'find project to continue' --agent gemini --session-id gemini-enter-project-list",
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
          arguments: { project_id: "<project_id>" },
          selection_sources: {
            project: "projects.projects_by_id.<project_id>",
            project_id: "projects.projects_by_id.<project_id>.project_id",
            start_action: "next.actions_by_project_id.<project_id>",
            start_action_argument: "next.actions_by_project_id.<project_id>.arguments_by_name.<argument>",
            start_action_required_field: "next.actions_by_project_id.<project_id>.required_fields_by_name.<field>",
            start_action_required_input: "next.actions_by_project_id.<project_id>.execution.required_inputs_by_field.<field>",
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
        start: {
          ok: true,
          project: { project_id: "moryn" }
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
        action_argument: "next.actions_by_id.<action>.arguments_by_name.<argument>",
        action_required_field: "next.actions_by_id.<action>.required_fields_by_name.<field>",
        action_required_input: "next.actions_by_id.<action>.execution.required_inputs_by_field.<field>",
        action_argument_source: "next.actions_by_id.<action>.argument_sources.<field>"
      });
      expect(entered.next.workflow.phases.map((phase) => phase.action_source)).toContain("next.actions_by_id.publish_status");
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

      expect(started.next.actions).toContainEqual(expect.objectContaining({
        action: "publish_status",
        safe_to_run: false,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn" })
      }));
      expect(started.next.actions).toContainEqual(expect.objectContaining({
        action: "finish_session",
        safe_to_run: false,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn" })
      }));
      expect(started.next.actions).toContainEqual(expect.objectContaining({
        action: "refresh_context",
        safe_to_run: true,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn" })
      }));

      const status = await agentStatus({
        storePath: store,
        agent: { client: "codex", session_id: "codex-portable-actions" },
        currentTask: "continue from portable actions",
        status: "Publishing portable action templates."
      });
      expect(status.next.actions).toContainEqual(expect.objectContaining({
        action: "finish_session",
        safe_to_run: false,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn" })
      }));

      const finish = await agentFinish({
        storePath: store,
        agent: { client: "codex", session_id: "codex-portable-actions" },
        currentTask: "continue from portable actions",
        summary: "Finished portable action template checks."
      });
      expect(finish.next.actions).toContainEqual(expect.objectContaining({
        action: "start_next_session",
        safe_to_run: true,
        command: expect.stringContaining("--project-id moryn"),
        arguments: expect.objectContaining({ project_id: "moryn" })
      }));
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
      await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8").catch(async (error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          await mkdir(project, { recursive: true });
          await writeFile(join(project, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8");
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
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "project",
        ok: false,
        severity: "warning"
      }));
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
      await writeFile(join(root, ".moryn.json"), "{\"project_id\":\"\"}\n", "utf8");
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
      expect(doctor.checks).toContainEqual(expect.objectContaining({
        name: "project",
        ok: false,
        severity: "warning"
      }));
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
          tool: "agent_start",
          safe_to_run: true,
          required_when: "When agent_enter returns discover_projects mode, choose one returned project_id before calling agent_start.",
          required_fields: ["project_id"],
          arguments: { project_id: "<project_id>" }
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

      await expect(agentStart({
        storePath: store,
        projectPath: project,
        projectId: "other",
        agent: { client: "codex" },
        currentTask: "avoid conflicting project id"
      })).rejects.toThrow("Project id conflict");
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

      await expect(agentStart({
        storePath: store,
        agent: { client: "codex" },
        currentTask: "avoid ambient project"
      })).rejects.toThrow("Project context required");

      await expect(agentStatus({
        storePath: store,
        agent: { client: "codex" },
        currentTask: "avoid ambient project",
        status: "Do not write status to an inferred project."
      })).rejects.toThrow("Project context required");

      await expect(agentFinish({
        storePath: store,
        agent: { client: "codex" },
        currentTask: "avoid ambient project",
        summary: "Do not write summary to an inferred project."
      })).rejects.toThrow("Project context required");
    } finally {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
    }
  });
});
