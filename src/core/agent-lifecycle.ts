import { access } from "node:fs/promises";
import { createEngine } from "./engine.js";
import { initializeStore, readStoreConfig } from "./config.js";
import { resolveProjectContext, type ProjectContext, type SyncMode } from "./project.js";
import { displayRecordText } from "./content-text.js";
import type { MorynRecord, RecordSource } from "./types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync, type GitSyncResult, type GitSyncStatus } from "../sync/git.js";
import { toErrorEnvelope, type MorynErrorEnvelope } from "./errors.js";
import { actionSafety, type ActionSafety } from "./action-safety.js";

interface AgentIdentity {
  client: string;
  session_id?: string;
  model?: string;
  device_id?: string;
}

interface AgentLifecycleInput {
  storePath: string;
  projectPath?: string;
  projectId?: string;
  currentTask?: string;
  agent?: AgentIdentity;
  syncRemote?: string;
}

export interface AgentStartInput extends AgentLifecycleInput {
  pull?: boolean;
  refreshSince?: string;
  limit?: number;
}

export interface AgentFinishInput extends AgentLifecycleInput {
  summary: string;
  push?: boolean;
}

export interface AgentStatusInput extends AgentLifecycleInput {
  status: string;
  push?: boolean;
}

type DoctorSeverity = "ok" | "notice" | "warning";
type DoctorCheck = { name: string; ok: boolean; severity: DoctorSeverity; message: string };
type LifecycleActionTemplate = {
  action: string;
  tool: string;
  safe_to_run: boolean;
  command: string;
  required_when: string;
  required_fields: string[];
  arguments: Record<string, unknown>;
  interfaces: ActionInterfaces<Record<string, unknown>>;
  safety: ActionSafety;
};

type ActionInterfaces<TArguments> = {
  cli: {
    command: string;
  };
  mcp: {
    tool: string;
    arguments: TArguments;
  };
};

export interface AgentDoctorInput extends AgentLifecycleInput {}

export interface AgentEnterInput extends AgentStartInput {}

export interface AgentGuideInput extends AgentLifecycleInput {}

const ACTIVE_SESSION_TTL_MINUTES = 120;
const ACTIVE_SESSION_TTL_MS = ACTIVE_SESSION_TTL_MINUTES * 60 * 1000;
const START_OR_RESUME_WHEN = "At the start of an agent turn, or whenever store/project/sync context is uncertain.";
const PUBLISH_STATUS_WHEN = "During meaningful long-running work, before interruption, or when another agent may need coordination.";
const FINISH_HANDOFF_WHEN = "At the end of meaningful work, before stopping, or before handing off to another agent.";
const REFRESH_CONTEXT_WHEN = "When the user asks to refresh memory, or after receiving a refresh cursor from a lifecycle response.";
const START_NEXT_SESSION_WHEN = "When another agent or device should start the next session from this handoff.";
const LIST_PROJECTS_WHEN = "When the shared store has projects but this agent has no explicit project context.";
const CHOOSE_DISCOVERED_PROJECT_WHEN = "After choosing this project from discovery results.";
const LIFECYCLE_SMOKE_WHEN = "Before trusting lifecycle sync on a new machine or remote.";
const INSPECT_SYNC_CONFLICT_WHEN = "Before retrying lifecycle writes or sync operations after a Git conflict.";
const FIX_PROJECT_CONFIG_WHEN = "Before starting lifecycle work when project context is invalid or missing.";

interface BootstrapResult {
  initialized_store: boolean;
  sync_init?: GitSyncResult;
  sync_init_error?: string;
  sync_init_error_details?: MorynErrorEnvelope["error"];
  sync_pull?: GitSyncResult;
  sync_pull_error?: string;
  sync_pull_error_details?: MorynErrorEnvelope["error"];
}

interface AgentHandoffEntry {
  record_id: string;
  type: string;
  text: string;
  current_task?: string;
  agent: RecordSource;
  updated_at: string;
  active_until?: string;
  recommended_action: "review_handoff_summary" | "coordinate_with_active_session";
}

function sourceFromAgent(agent: AgentIdentity | undefined): RecordSource {
  return {
    client: agent?.client ?? "agent",
    session_id: agent?.session_id,
    model: agent?.model,
    device_id: agent?.device_id
  };
}

function projectEnvelope(project: ProjectContext): {
  project_id: string;
  project_path: string;
  source: ProjectContext["source"];
  sync_mode: SyncMode;
  tags: string[];
  default_skills: string[];
} {
  return {
    project_id: project.project_id,
    project_path: project.project_path,
    source: project.source,
    sync_mode: project.config?.sync.mode ?? "session",
    tags: project.config?.tags ?? [],
    default_skills: project.config?.default_skills ?? []
  };
}

function withActionInterfaces<T extends { tool: string; command: string; arguments: unknown; safe_to_run: boolean; required_fields: string[] }>(
  action: T
): T & { interfaces: ActionInterfaces<T["arguments"]>; safety: ActionSafety } {
  return {
    ...action,
    interfaces: {
      cli: {
        command: action.command
      },
      mcp: {
        tool: action.tool,
        arguments: action.arguments
      }
    },
    safety: actionSafety(action)
  };
}

async function trySync<T>(fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string; cause: unknown }> {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), cause: error };
  }
}

function syncErrorDetails(error: unknown): MorynErrorEnvelope["error"] {
  return toErrorEnvelope(error).error;
}

function isMissingStore(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function knownProjectIds(input: AgentLifecycleInput): Promise<string[]> {
  const knownProjects = await trySync(() => createEngine({ storePath: input.storePath }).listProjects({ limit: 100 }));
  return knownProjects.ok ? knownProjects.result.projects.map((project) => project.project_id) : [];
}

async function resolveLifecycleProjectContext(input: AgentLifecycleInput, options: { requireExplicitProject?: boolean } = {}): Promise<ProjectContext> {
  if (input.projectPath) {
    try {
      await access(input.projectPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new Error(`Project path does not exist: ${input.projectPath}. Run project_init for a new project, or pass the correct project_path/project_id.`);
      }
      throw error;
    }
  }

  if (input.projectId) {
    const projectIds = await knownProjectIds(input);
    if (projectIds.length > 0 && !projectIds.includes(input.projectId)) {
      throw new Error(`Project id is not known in this store: ${input.projectId}. Run project_list and choose one of: ${projectIds.join(", ")}.`);
    }
  }

  const project = await resolveProjectContext({ projectPath: input.projectPath, projectId: input.projectId });
  if (input.projectPath && input.projectId && project.config?.project_id && project.config.project_id !== input.projectId) {
    throw new Error(`Project id conflict: project_path resolves to ${project.config.project_id}, but project_id was ${input.projectId}. Use the .moryn.json project_id or update the project config.`);
  }
  if (options.requireExplicitProject && !input.projectPath && !input.projectId && project.source !== "config") {
    const projectIds = await knownProjectIds(input);
    if (projectIds.length > 0) {
      throw new Error(`Project context required: this store already has known projects (${projectIds.join(", ")}). Run project_list or agent_enter, then retry with project_path/project_id.`);
    }
  }
  return project;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendOption(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined) return;
  parts.push(name, shellQuote(value));
}

function appendTemplateOption(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined) return;
  parts.push(name, /^<[^>]+>$/.test(value) ? value : shellQuote(value));
}

function ensureGuideProjectIdentity(input: AgentLifecycleInput): AgentLifecycleInput {
  if (input.projectPath || input.projectId) return input;
  return { ...input, projectId: "<project_id>" };
}

function guideRequiredFields(input: AgentLifecycleInput, fields: string[]): string[] {
  return input.projectPath || input.projectId ? fields : ["project_id", ...fields];
}

function buildAgentStartCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "start"];
  appendOption(parts, "--project", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  return parts.join(" ");
}

function buildAgentEnterCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "enter"];
  appendOption(parts, "--project", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  return parts.join(" ");
}

function buildAgentStartTemplateCommand(input: AgentLifecycleInput, requiredFields: string[]): string {
  const parts = ["moryn", "agent", "start"];
  appendOption(parts, "--project", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  if (input.currentTask) {
    appendOption(parts, "--current-task", input.currentTask);
  } else if (requiredFields.includes("current_task")) {
    parts.push("--current-task", "<current_task>");
  }
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  return parts.join(" ");
}

function buildAgentRefreshCommand(input: AgentLifecycleInput, cursor: string): string {
  const parts = ["moryn", "agent", "start"];
  appendOption(parts, "--project", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  appendOption(parts, "--refresh-since", cursor);
  return parts.join(" ");
}

function buildAgentRefreshTemplateCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "start"];
  appendOption(parts, "--project", input.projectPath);
  appendTemplateOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  parts.push("--refresh-since", "<refresh_since>");
  return parts.join(" ");
}

function buildAgentStatusTemplateCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "status"];
  appendOption(parts, "--project", input.projectPath);
  appendTemplateOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  parts.push("--status", "<status>");
  return parts.join(" ");
}

function buildAgentStatusCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "status"];
  appendOption(parts, "--project", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  parts.push("--status", "<status>");
  return parts.join(" ");
}

function buildAgentFinishTemplateCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "finish"];
  appendOption(parts, "--project", input.projectPath);
  appendTemplateOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  parts.push("--summary", "<summary>");
  return parts.join(" ");
}

function buildAgentFinishCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "agent", "finish"];
  appendOption(parts, "--project", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  appendOption(parts, "--sync-remote", input.syncRemote);
  appendOption(parts, "--current-task", input.currentTask);
  appendOption(parts, "--agent", input.agent?.client);
  appendOption(parts, "--session-id", input.agent?.session_id);
  appendOption(parts, "--model", input.agent?.model);
  appendOption(parts, "--device-id", input.agent?.device_id);
  parts.push("--summary", "<summary>");
  return parts.join(" ");
}

function buildProjectInitCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "project", "init"];
  appendOption(parts, "--path", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  return parts.join(" ");
}

function projectInitInput(input: AgentLifecycleInput, projectError: string | undefined): AgentLifecycleInput {
  if (projectError?.startsWith("Project id conflict:")) {
    return { ...input, projectId: undefined };
  }
  return input;
}

function projectInitArguments(input: AgentLifecycleInput): {
  path?: string;
  project_id?: string;
} {
  return {
    path: input.projectPath,
    ...(input.projectId ? { project_id: input.projectId } : {})
  };
}

function buildProjectListCommand(): string {
  return "moryn project list";
}

function lifecycleActionArguments(input: AgentLifecycleInput): {
  project_path?: string;
  project_id?: string;
  sync_remote?: string;
  current_task?: string;
  agent?: AgentIdentity;
} {
  return {
    project_path: input.projectPath,
    project_id: input.projectId,
    sync_remote: input.syncRemote,
    current_task: input.currentTask,
    agent: input.agent
  };
}

function agentEnterActionTemplate(command: string, args: ReturnType<typeof lifecycleActionArguments>) {
  const requiredFields: string[] = [];
  return withActionInterfaces({
    tool: "agent_enter",
    command,
    safe_to_run: true,
    required_when: START_OR_RESUME_WHEN,
    required_fields: requiredFields,
    workflow: singleNextWorkflow("call_agent_enter", "agent_enter", START_OR_RESUME_WHEN, requiredFields, "startup"),
    arguments: args
  });
}

function agentGuideGuardrails(startup: ReturnType<typeof agentEnterActionTemplate>) {
  const callAgentEnter = {
    recommended_action: "call_agent_enter",
    ...startup
  };
  return [
    {
      id: "prefer_agent_enter_for_startup",
      when: START_OR_RESUME_WHEN,
      risk: "Manual startup sequences can skip sync, project discovery, boot, or refresh steps.",
      avoid: ["manual_sync_pull_boot_refresh", "manual_lower_level_startup_sequence"],
      required_behavior: "Call the returned agent_enter startup action instead of composing lower-level startup tools.",
      use_instead: callAgentEnter
    },
    {
      id: "discover_project_before_lifecycle_writes",
      when: "When project context is unclear or no project_path/project_id was provided.",
      risk: "Guessing project ids can write status or handoff records into the wrong project.",
      avoid: ["guess_project_id", "write_project_scoped_lifecycle_without_project_id"],
      required_behavior: "When project context is unclear, call agent_enter discovery and choose a returned project before lifecycle writes.",
      use_instead: callAgentEnter
    },
    {
      id: "use_returned_actions_verbatim",
      when: "Before executing lifecycle follow-up actions.",
      risk: "Reconstructing commands can rename fields, omit placeholders, or bypass required_fields checks.",
      avoid: ["reconstruct_command_from_memory", "rename_argument_fields", "drop_required_fields"],
      required_behavior: "Use returned command strings or arguments exactly; fill only placeholders named in required_fields.",
      allowed_action_sources: ["startup", "next", "lifecycle", "response.next.actions"]
    },
    {
      id: "publish_status_and_finish_handoff",
      when: `${PUBLISH_STATUS_WHEN} ${FINISH_HANDOFF_WHEN}`,
      risk: "Silent sessions leave other agents without coordination or handoff context.",
      avoid: ["stop_without_status_or_summary", "leave_active_work_unpublished"],
      required_behavior: "Publish agent_status before long interruptions and call agent_finish with a concise final summary when meaningful work ends.",
      allowed_action_sources: ["lifecycle", "response.next.actions"]
    },
    {
      id: "pass_sync_remote_for_cross_device_handoff",
      when: "When cross-device handoff or shared memory sync matters.",
      risk: "Without sync_remote, status and summaries may stay local to this machine.",
      avoid: ["omit_sync_remote_for_shared_handoff", "assume_local_store_is_shared"],
      required_behavior: "Pass sync_remote whenever cross-device handoff matters so lifecycle writes reach the shared store.",
      allowed_action_sources: ["startup", "next", "lifecycle", "response.next.actions"]
    }
  ];
}

function refreshActionArguments(input: AgentLifecycleInput, cursor: string): {
  project_path?: string;
  project_id?: string;
  sync_remote?: string;
  current_task?: string;
  refresh_since: string;
  agent?: AgentIdentity;
} {
  return {
    ...lifecycleActionArguments(input),
    refresh_since: cursor
  };
}

function statusActionArguments(input: AgentLifecycleInput): {
  project_path?: string;
  project_id?: string;
  sync_remote?: string;
  current_task?: string;
  status: string;
  agent?: AgentIdentity;
} {
  return {
    ...lifecycleActionArguments(input),
    status: "<status>"
  };
}

function finishActionArguments(input: AgentLifecycleInput): {
  project_path?: string;
  project_id?: string;
  sync_remote?: string;
  current_task?: string;
  summary: string;
  agent?: AgentIdentity;
} {
  return {
    ...lifecycleActionArguments(input),
    summary: "<summary>"
  };
}

function agentStartActionArguments(input: AgentLifecycleInput, requiredFields: string[] = []): {
  project_path?: string;
  project_id?: string;
  sync_remote?: string;
  current_task?: string;
  agent?: AgentIdentity;
} {
  const args = lifecycleActionArguments(input);
  if (requiredFields.includes("current_task") && !input.currentTask) {
    return { ...args, current_task: "<current_task>" };
  }
  return args;
}

function portableLifecycleInput(input: AgentLifecycleInput, project: ProjectContext): AgentLifecycleInput {
  if (input.projectPath || input.projectId) return input;
  return { ...input, projectId: project.project_id };
}

function nextActions(input: AgentLifecycleInput, cursor?: string): LifecycleActionTemplate[] {
  const actions: LifecycleActionTemplate[] = [
    withActionInterfaces({
      action: "publish_status",
      tool: "agent_status",
      safe_to_run: false,
      command: buildAgentStatusCommand(input),
      required_when: PUBLISH_STATUS_WHEN,
      required_fields: ["status"],
      arguments: statusActionArguments(input)
    }),
    withActionInterfaces({
      action: "finish_session",
      tool: "agent_finish",
      safe_to_run: false,
      command: buildAgentFinishCommand(input),
      required_when: FINISH_HANDOFF_WHEN,
      required_fields: ["summary"],
      arguments: finishActionArguments(input)
    })
  ];
  if (cursor) {
    actions.push(withActionInterfaces({
      action: "refresh_context",
      tool: "agent_start",
      safe_to_run: true,
      command: buildAgentRefreshCommand(input, cursor),
      required_when: REFRESH_CONTEXT_WHEN,
      required_fields: [],
      arguments: refreshActionArguments(input, cursor)
    }));
  }
  return actions;
}

function syncConflictNextActions() {
  return [
    withActionInterfaces({
      action: "inspect_sync_conflict",
      tool: "sync_status",
      safe_to_run: true,
      command: "moryn sync --status",
      required_when: INSPECT_SYNC_CONFLICT_WHEN,
      required_fields: [],
      arguments: {}
    })
  ];
}

function syncConflictNextAction() {
  return withActionInterfaces({
    recommended_action: "resolve_sync_conflict_before_lifecycle",
    tool: "sync_status",
    safe_to_run: true,
    command: "moryn sync --status",
    required_when: INSPECT_SYNC_CONFLICT_WHEN,
    required_fields: [],
    workflow: singleNextWorkflow("resolve_sync_conflict_before_lifecycle", "sync_status", INSPECT_SYNC_CONFLICT_WHEN, []),
    arguments: {}
  });
}

async function assertSyncNotConflicted(storePath: string): Promise<GitSyncStatus> {
  const status = await getGitSyncStatus(storePath);
  if (status.sync_state === "conflict") {
    throw new Error("Sync conflict: resolve Git conflicts before lifecycle writes");
  }
  return status;
}

function finishNextActions(input: AgentLifecycleInput) {
  const requiredFields = input.currentTask ? [] : ["current_task"];
  return [
    withActionInterfaces({
      action: "start_next_session",
      tool: "agent_start",
      safe_to_run: true,
      command: buildAgentStartTemplateCommand(input, requiredFields),
      required_when: START_NEXT_SESSION_WHEN,
      required_fields: requiredFields,
      arguments: agentStartActionArguments(input, requiredFields)
    })
  ];
}

function statusNextActions(input: AgentLifecycleInput, cursor: string) {
  return [
    withActionInterfaces({
      action: "finish_session",
      tool: "agent_finish",
      safe_to_run: false,
      command: buildAgentFinishCommand(input),
      required_when: FINISH_HANDOFF_WHEN,
      required_fields: ["summary"],
      arguments: finishActionArguments(input)
    }),
    withActionInterfaces({
      action: "refresh_context",
      tool: "agent_start",
      safe_to_run: true,
      command: buildAgentRefreshCommand(input, cursor),
      required_when: REFRESH_CONTEXT_WHEN,
      required_fields: [],
      arguments: refreshActionArguments(input, cursor)
    })
  ];
}

function buildLifecycleSmokeCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn-agent-smoke"];
  appendTemplateOption(parts, "--remote", input.syncRemote ?? "<remote>");
  return parts.join(" ");
}

function lifecycleSmokeActionArguments(input: AgentLifecycleInput): {
  remote: string;
} {
  return {
    remote: input.syncRemote ?? "<remote>"
  };
}

function doctorNextActions(input: AgentLifecycleInput) {
  return [
    withActionInterfaces({
      action: "start_session",
      tool: "agent_start",
      safe_to_run: true,
      command: buildAgentStartCommand(input),
      required_when: START_OR_RESUME_WHEN,
      required_fields: [],
      arguments: agentStartActionArguments(input)
    }),
    withActionInterfaces({
      action: "run_lifecycle_smoke",
      tool: "moryn-agent-smoke",
      safe_to_run: true,
      command: buildLifecycleSmokeCommand(input),
      required_when: LIFECYCLE_SMOKE_WHEN,
      required_fields: input.syncRemote ? [] : ["remote"],
      arguments: lifecycleSmokeActionArguments(input)
    })
  ];
}

function doctorReadiness(
  checks: DoctorCheck[],
  next: {
    recommended_action: string;
    tool: string;
    safe_to_run: boolean;
    command: string;
    required_when?: string;
    required_fields?: string[];
    safety?: ActionSafety;
    arguments?: Record<string, unknown>;
    interfaces?: ActionInterfaces<Record<string, unknown>>;
    workflow?: ReturnType<typeof singleNextWorkflow>;
  }
) {
  const nextArguments = next.arguments ?? {};
  const nextInterfaces = next.interfaces ?? {
    cli: {
      command: next.command
    },
    mcp: {
      tool: next.tool,
      arguments: nextArguments
    }
  };
  const nextRequiredFields = next.required_fields ?? [];
  const nextRequiredWhen = next.required_when ?? "When this action is the selected next action.";
  const nextWorkflow = next.workflow ?? singleNextWorkflow(
    next.recommended_action,
    next.tool,
    nextRequiredWhen,
    nextRequiredFields
  );

  return {
    safe_to_start: next.tool === "agent_start",
    blocking_checks: checks
      .filter((check) => !check.ok && check.severity === "warning")
      .map((check) => check.name),
    recommended_action: next.recommended_action,
    next_tool: next.tool,
    next_command: next.command,
    next_safe_to_run: next.safe_to_run,
    next_required_when: next.required_when,
    next_required_fields: nextRequiredFields,
    next_safety: next.safety,
    next_interfaces: nextInterfaces,
    next_workflow: nextWorkflow,
    next_arguments: nextArguments
  };
}

function projectListNextActions() {
  return [
    withActionInterfaces({
      action: "list_projects",
      tool: "project_list",
      safe_to_run: true,
      command: buildProjectListCommand(),
      required_when: LIST_PROJECTS_WHEN,
      required_fields: [],
      arguments: {}
    })
  ];
}

function lifecycleStepWorkflow(step: string, tool: string, requiredWhen: string, requiredFields: string[]) {
  return {
    version: 1,
    start: "lifecycle",
    continue_from: ["lifecycle"],
    phases: [
      {
        phase: step,
        order: 1,
        action_source: `lifecycle.${step}`,
        tool,
        required_when: requiredWhen,
        required_fields: requiredFields
      }
    ]
  };
}

function agentGuideLifecycle(input: AgentLifecycleInput, startTool = "agent_enter") {
  const lifecycleInput = ensureGuideProjectIdentity(input);
  const lifecycleArguments = lifecycleActionArguments(lifecycleInput);
  const startCommand = startTool === "agent_start"
    ? buildAgentStartCommand(lifecycleInput)
    : buildAgentEnterCommand(input);
  const startArguments = startTool === "agent_start"
    ? lifecycleArguments
    : lifecycleActionArguments(input);
  const startRequiredFields: string[] = [];
  const statusRequiredFields = guideRequiredFields(input, ["status"]);
  const finishRequiredFields = guideRequiredFields(input, ["summary"]);
  const refreshRequiredFields = guideRequiredFields(input, ["refresh_since"]);
  return [
    withActionInterfaces({
      step: "start_or_resume",
      tool: startTool,
      safe_to_run: true,
      required_when: START_OR_RESUME_WHEN,
      command: startCommand,
      required_fields: startRequiredFields,
      workflow: lifecycleStepWorkflow("start_or_resume", startTool, START_OR_RESUME_WHEN, startRequiredFields),
      arguments: startArguments
    }),
    withActionInterfaces({
      step: "publish_status",
      tool: "agent_status",
      safe_to_run: false,
      required_when: PUBLISH_STATUS_WHEN,
      command: buildAgentStatusTemplateCommand(lifecycleInput),
      required_fields: statusRequiredFields,
      workflow: lifecycleStepWorkflow("publish_status", "agent_status", PUBLISH_STATUS_WHEN, statusRequiredFields),
      arguments: { ...lifecycleArguments, status: "<status>" }
    }),
    withActionInterfaces({
      step: "finish_handoff",
      tool: "agent_finish",
      safe_to_run: false,
      required_when: FINISH_HANDOFF_WHEN,
      command: buildAgentFinishTemplateCommand(lifecycleInput),
      required_fields: finishRequiredFields,
      workflow: lifecycleStepWorkflow("finish_handoff", "agent_finish", FINISH_HANDOFF_WHEN, finishRequiredFields),
      arguments: { ...lifecycleArguments, summary: "<summary>" }
    }),
    withActionInterfaces({
      step: "refresh_context",
      tool: "agent_start",
      safe_to_run: true,
      required_when: REFRESH_CONTEXT_WHEN,
      command: buildAgentRefreshTemplateCommand(lifecycleInput),
      required_fields: refreshRequiredFields,
      workflow: lifecycleStepWorkflow("refresh_context", "agent_start", REFRESH_CONTEXT_WHEN, refreshRequiredFields),
      arguments: { ...lifecycleArguments, refresh_since: "<refresh_since>" }
    })
  ];
}

function lifecyclePhase(
  lifecycle: ReturnType<typeof agentGuideLifecycle>,
  step: string,
  order: number
) {
  const action = lifecycle.find((item) => item.step === step);
  if (!action) throw new Error(`Missing guide lifecycle step: ${step}`);
  return {
    phase: action.step,
    order,
    action_source: `lifecycle.${action.step}`,
    tool: action.tool,
    required_when: action.required_when,
    required_fields: action.required_fields
  };
}

function agentGuideWorkflow(lifecycle: ReturnType<typeof agentGuideLifecycle>) {
  const start = lifecycle.find((item) => item.step === "start_or_resume");
  if (!start) throw new Error("Missing guide lifecycle step: start_or_resume");
  return {
    version: 1,
    start: "startup",
    continue_from: ["agent_enter.next.actions", "lifecycle"],
    phases: [
      {
        phase: "start_or_resume",
        order: 1,
        action_source: "startup",
        tool: start.tool,
        required_when: start.required_when,
        required_fields: start.required_fields
      },
      {
        phase: "follow_returned_next_actions",
        order: 2,
        action_source: "agent_enter.next.actions",
        required_when: "After agent_enter returns, prefer its response.next.actions over static guide templates.",
        required_fields: []
      },
      lifecyclePhase(lifecycle, "publish_status", 3),
      lifecyclePhase(lifecycle, "finish_handoff", 4),
      lifecyclePhase(lifecycle, "refresh_context", 5)
    ]
  };
}

function runtimeActionPhase(
  actions: LifecycleActionTemplate[],
  actionName: string,
  phase: string,
  order: number
) {
  const action = actions.find((item) => item.action === actionName);
  if (!action) throw new Error(`Missing runtime action: ${actionName}`);
  return {
    phase,
    order,
    action_source: `next.actions.${action.action}`,
    tool: action.tool,
    required_when: action.required_when,
    required_fields: action.required_fields
  };
}

function startSessionWorkflow(actions: LifecycleActionTemplate[]) {
  return {
    version: 1,
    start: "start",
    continue_from: ["start.boot", "start.refresh", "start.handoff", "next.actions"],
    phases: [
      {
        phase: "work_with_handoff_context",
        order: 1,
        action_source: "start",
        required_when: "Immediately after agent_enter returns start_session mode, review boot, refresh, and handoff context before taking user-task actions.",
        required_fields: []
      },
      runtimeActionPhase(actions, "publish_status", "publish_status", 2),
      runtimeActionPhase(actions, "finish_session", "finish_session", 3),
      runtimeActionPhase(actions, "refresh_context", "refresh_context", 4)
    ]
  };
}

function directStartWorkflow(actions: LifecycleActionTemplate[]) {
  return {
    version: 1,
    start: "context",
    continue_from: ["boot", "refresh", "handoff", "next.actions"],
    phases: [
      {
        phase: "review_context",
        order: 1,
        action_source: "boot+refresh+handoff",
        required_when: "Immediately after agent_start returns, review boot, refresh, and handoff context before taking user-task actions.",
        required_fields: []
      },
      runtimeActionPhase(actions, "publish_status", "publish_status", 2),
      runtimeActionPhase(actions, "finish_session", "finish_session", 3),
      runtimeActionPhase(actions, "refresh_context", "refresh_context", 4)
    ]
  };
}

function directStatusWorkflow(actions: LifecycleActionTemplate[]) {
  return {
    version: 1,
    start: "next.actions",
    continue_from: ["record", "next.actions"],
    phases: [
      runtimeActionPhase(actions, "finish_session", "finish_session", 1),
      runtimeActionPhase(actions, "refresh_context", "refresh_context", 2)
    ]
  };
}

function directFinishWorkflow(actions: LifecycleActionTemplate[]) {
  return {
    version: 1,
    start: "next.actions",
    continue_from: ["next.actions"],
    phases: [
      runtimeActionPhase(actions, "start_next_session", "start_next_session", 1)
    ]
  };
}

function singleNextWorkflow(
  recommendedAction: string,
  tool: string,
  requiredWhen: string,
  requiredFields: string[],
  actionSource = "next"
) {
  return {
    version: 1,
    start: actionSource,
    continue_from: [actionSource],
    phases: [
      {
        phase: recommendedAction,
        order: 1,
        action_source: actionSource,
        tool,
        required_when: requiredWhen,
        required_fields: requiredFields
      }
    ]
  };
}

function discoverProjectsWorkflow() {
  return {
    version: 1,
    start: "projects",
    continue_from: ["next.actions", "next.actions[].lifecycle", "agent_start.next.actions"],
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
        action_source: "next.actions.start_session",
        tool: "agent_start",
        required_when: CHOOSE_DISCOVERED_PROJECT_WHEN,
        required_fields: []
      },
      {
        phase: "continue_selected_project_lifecycle",
        order: 3,
        action_source: "next.actions[].lifecycle",
        required_when: "After the selected project starts, use that action's lifecycle templates for status, finish, and refresh.",
        required_fields: []
      }
    ]
  };
}

async function hasKnownProjects(input: AgentLifecycleInput, storeInitialized: boolean): Promise<boolean> {
  if (!storeInitialized) return false;
  const result = await trySync(() => createEngine({ storePath: input.storePath }).listProjects({ limit: 1 }));
  return result.ok && result.result.projects.length > 0;
}

function shouldDiscoverProjects(
  input: AgentLifecycleInput,
  storeHasProjects: boolean,
  project: Awaited<ReturnType<typeof trySync<ProjectContext>>>
): boolean {
  if (!storeHasProjects) return false;
  if (input.projectPath) return false;
  if (input.projectId && project.ok) return false;
  return !project.ok || project.result.source !== "config";
}

function sourceSessionKey(source: RecordSource): string {
  return [
    source.client,
    source.session_id ?? "",
    source.device_id ?? ""
  ].join("\0");
}

function sourceActorKey(source: RecordSource): string {
  return source.client;
}

function isSameAgentSession(source: RecordSource, agent: AgentIdentity | undefined): boolean {
  return Boolean(agent?.session_id)
    && source.client === agent?.client
    && source.session_id === agent.session_id;
}

function handoffEntry(record: MorynRecord, recommendedAction: AgentHandoffEntry["recommended_action"]): AgentHandoffEntry {
  const currentTask = typeof record.content.current_task === "string" ? record.content.current_task : undefined;
  const updatedAt = Date.parse(record.updated_at);
  const activeUntil = recommendedAction === "coordinate_with_active_session" && Number.isFinite(updatedAt)
    ? new Date(updatedAt + ACTIVE_SESSION_TTL_MS).toISOString()
    : undefined;
  return {
    record_id: record.id,
    type: record.type,
    text: displayRecordText(record),
    current_task: currentTask,
    agent: record.source,
    updated_at: record.updated_at,
    active_until: activeUntil,
    recommended_action: recommendedAction
  };
}

function isFreshActiveStatus(record: MorynRecord, now: Date): boolean {
  const updatedAt = Date.parse(record.updated_at);
  return Number.isFinite(updatedAt) && updatedAt + ACTIVE_SESSION_TTL_MS > now.getTime();
}

function buildHandoff(records: MorynRecord[], input: AgentLifecycleInput, now = new Date()): {
  inbox: AgentHandoffEntry[];
  active_sessions: AgentHandoffEntry[];
  active_session_ttl_minutes: number;
  recommended_action: "continue_current_task" | "review_handoff_inbox" | "coordinate_with_active_sessions";
} {
  const sorted = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  const finalSummaries = sorted.filter((record) => record.type !== "status");
  const finalSummaryBySession = new Map(finalSummaries.map((record) => [sourceSessionKey(record.source), record]));
  const finalSummaryByActor = new Map<string, MorynRecord>();
  for (const record of finalSummaries) {
    const key = sourceActorKey(record.source);
    if (!finalSummaryByActor.has(key)) finalSummaryByActor.set(key, record);
  }
  const seenActiveActors = new Set<string>();
  const activeSessions: AgentHandoffEntry[] = [];

  for (const record of sorted.filter((record) => record.type === "status")) {
    if (isSameAgentSession(record.source, input.agent)) continue;
    if (!isFreshActiveStatus(record, now)) continue;
    const key = sourceSessionKey(record.source);
    const finalSummary = finalSummaryBySession.get(key);
    if (finalSummary && finalSummary.updated_at >= record.updated_at) continue;
    const actorKey = sourceActorKey(record.source);
    const actorFinalSummary = finalSummaryByActor.get(actorKey);
    if (actorFinalSummary && actorFinalSummary.updated_at >= record.updated_at) continue;
    if (seenActiveActors.has(actorKey)) continue;
    seenActiveActors.add(actorKey);
    activeSessions.push(handoffEntry(record, "coordinate_with_active_session"));
    if (activeSessions.length >= 5) break;
  }

  const inbox = finalSummaries
    .filter((record) => !isSameAgentSession(record.source, input.agent))
    .slice(0, 5)
    .map((record) => handoffEntry(record, "review_handoff_summary"));

  return {
    inbox,
    active_sessions: activeSessions,
    active_session_ttl_minutes: ACTIVE_SESSION_TTL_MINUTES,
    recommended_action: activeSessions.length
      ? "coordinate_with_active_sessions"
      : inbox.length
        ? "review_handoff_inbox"
        : "continue_current_task"
  };
}

async function agentHandoff(engine: ReturnType<typeof createEngine>, projectId: string, input: AgentLifecycleInput) {
  const summaries = await engine.recall({
    project_id: projectId,
    kinds: ["session_summary"],
    scopes: ["project"],
    limit: 100
  });
  return buildHandoff(summaries.results.map((result) => result.record), input);
}

async function initializeLifecycleSync(storePath: string, syncRemote: string | undefined, result: BootstrapResult): Promise<void> {
  if (!syncRemote) return;
  const initialized = await trySync(() => initializeGitSync(storePath, syncRemote));
  if (initialized.ok) {
    result.sync_init = initialized.result;
  } else {
    result.sync_init_error = initialized.error;
    result.sync_init_error_details = syncErrorDetails(initialized.cause);
  }
}

async function ensureLifecycleBootstrap(input: AgentLifecycleInput): Promise<BootstrapResult> {
  try {
    await readStoreConfig(input.storePath);
  } catch (error) {
    if (!isMissingStore(error)) throw error;
    await initializeStore(input.storePath);
    const result: BootstrapResult = { initialized_store: true };
    await initializeLifecycleSync(input.storePath, input.syncRemote, result);
    return result;
  }

  await initializeStore(input.storePath);
  const result: BootstrapResult = { initialized_store: false };
  await initializeLifecycleSync(input.storePath, input.syncRemote, result);
  return result;
}

async function pullLifecycleSync(storePath: string, result: BootstrapResult): Promise<void> {
  const pulled = await trySync(() => pullGitSync(storePath));
  if (pulled.ok) {
    result.sync_pull = pulled.result;
  } else {
    result.sync_pull_error = pulled.error;
    result.sync_pull_error_details = syncErrorDetails(pulled.cause);
  }
}

async function enterDiscoveryBootstrap(input: AgentEnterInput): Promise<BootstrapResult | undefined> {
  if (!input.syncRemote || input.projectPath || input.projectId) return undefined;
  const store = await trySync(() => readStoreConfig(input.storePath));
  if (store.ok && await hasKnownProjects(input, true)) return undefined;
  const bootstrap = await ensureLifecycleBootstrap(input);
  if (!bootstrap.sync_init_error) {
    await pullLifecycleSync(input.storePath, bootstrap);
  }
  return bootstrap;
}

export async function agentDoctor(input: AgentDoctorInput) {
  const checks: DoctorCheck[] = [];
  let storeInitialized = false;
  let storeError: string | undefined;

  try {
    await readStoreConfig(input.storePath);
    storeInitialized = true;
    checks.push({ name: "store", ok: true, severity: "ok", message: "Store is initialized." });
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error);
    checks.push({
      name: "store",
      ok: false,
      severity: "notice",
      message: input.syncRemote
        ? "Store is not initialized; agent_start can create it and connect sync_remote."
        : "Store is not initialized; pass sync_remote to agent_start or run moryn init."
    });
  }

  const project = await trySync(() => resolveLifecycleProjectContext(input));
  const projectResult = project.ok
    ? { ok: true, ...projectEnvelope(project.result) }
    : { ok: false, error: project.error };
  checks.push(project.ok
    ? { name: "project", ok: true, severity: "ok", message: `Project resolves as ${project.result.project_id}.` }
    : { name: "project", ok: false, severity: "warning", message: project.error });

  const syncStatus = storeInitialized
    ? await getGitSyncStatus(input.storePath)
    : { configured: false, error: "Store not initialized" };
  const syncConfigured = Boolean(syncStatus.configured && syncStatus.remote);
  const remoteMatches = input.syncRemote === undefined || syncStatus.remote === input.syncRemote;
  const syncConflict = syncStatus.sync_state === "conflict";
  checks.push({
    name: "sync",
    ok: syncConfigured && remoteMatches && !syncConflict,
    severity: syncConflict ? "warning" : syncConfigured && remoteMatches ? "ok" : "notice",
    message: syncConflict
      ? "Sync has unresolved Git conflicts; inspect sync_status and resolve conflicts before lifecycle writes."
      : syncConfigured && remoteMatches
      ? "Sync is configured."
      : input.syncRemote
        ? "Sync is not connected to the expected remote; agent_start can initialize or update it."
        : "Sync is not configured; pass sync_remote when cross-device handoff is needed."
  });

  const discoverProjects = shouldDiscoverProjects(input, await hasKnownProjects(input, storeInitialized), project);
  const setupInput = projectInitInput(input, project.ok ? undefined : project.error);
  const setupRequiredFields = setupInput.projectPath ? [] : ["path"];
  const next = syncConflict
    ? syncConflictNextAction()
    : discoverProjects
    ? withActionInterfaces({
        recommended_action: "list_projects",
        tool: "project_list",
        safe_to_run: true,
        command: buildProjectListCommand(),
        required_when: LIST_PROJECTS_WHEN,
        required_fields: [],
        workflow: singleNextWorkflow("list_projects", "project_list", LIST_PROJECTS_WHEN, []),
        actions: projectListNextActions(),
        arguments: {}
      })
    : project.ok
    ? withActionInterfaces({
        recommended_action: "call_agent_start",
        tool: "agent_start",
        safe_to_run: true,
        command: buildAgentStartCommand(input),
        required_when: START_OR_RESUME_WHEN,
        required_fields: [],
        workflow: singleNextWorkflow("call_agent_start", "agent_start", START_OR_RESUME_WHEN, []),
        actions: doctorNextActions(input),
        arguments: {
          project_path: input.projectPath,
          project_id: input.projectId,
          sync_remote: input.syncRemote,
          current_task: input.currentTask,
          agent: input.agent
        }
      })
    : withActionInterfaces({
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: buildProjectInitCommand(setupInput),
        required_when: FIX_PROJECT_CONFIG_WHEN,
        required_fields: setupRequiredFields,
        workflow: singleNextWorkflow("fix_project_config", "project_init", FIX_PROJECT_CONFIG_WHEN, setupRequiredFields),
        arguments: projectInitArguments(setupInput)
      });

  return {
    ok: true,
    agent: sourceFromAgent(input.agent),
    store: {
      path: input.storePath,
      initialized: storeInitialized,
      error: storeInitialized ? undefined : storeError
    },
    project: projectResult,
    sync: {
      ...syncStatus,
      configured: syncConfigured,
      expected_remote: input.syncRemote,
      remote_matches: remoteMatches
    },
    checks,
    readiness: doctorReadiness(checks, next),
    next
  };
}

export async function agentEnter(input: AgentEnterInput) {
  const bootstrap = await enterDiscoveryBootstrap(input);
  const doctor = await agentDoctor(input);
  if (doctor.next.tool === "project_list") {
    const engine = createEngine({ storePath: input.storePath });
    const projects = await engine.listProjects({
      limit: input.limit,
      current_task: input.currentTask,
      sync_remote: input.syncRemote,
      agent: sourceFromAgent(input.agent)
    });
    return {
      ok: true,
      mode: "discover_projects",
      agent: sourceFromAgent(input.agent),
      bootstrap,
      doctor,
      projects,
      next: {
        recommended_action: "choose_project_and_call_agent_start",
        tool: "agent_start",
        safe_to_run: true,
        workflow: discoverProjectsWorkflow(),
        actions: projects.projects.map((project) => ({
          action: "start_session",
          project_id: project.project_id,
          tool: project.next.tool,
          safe_to_run: true,
          command: project.next.command,
          required_when: CHOOSE_DISCOVERED_PROJECT_WHEN,
          required_fields: [],
          arguments: project.next.arguments,
          interfaces: project.next.interfaces,
          lifecycle: agentGuideLifecycle({ ...input, projectId: project.project_id }, "agent_start")
        }))
      }
    };
  }

  if (doctor.next.tool === "agent_start") {
    const start = await agentStart(input);
    const actions = start.next.actions;
    return {
      ok: true,
      mode: "start_session",
      agent: sourceFromAgent(input.agent),
      bootstrap,
      doctor,
      project: start.project,
      start,
      next: {
        recommended_action: "work_with_handoff_context",
        tool: "agent_start",
        safe_to_run: true,
        workflow: startSessionWorkflow(actions),
        actions
      }
    };
  }

  return {
    ok: true,
    mode: "needs_setup",
    agent: sourceFromAgent(input.agent),
    bootstrap,
    doctor,
    next: doctor.next
  };
}

export function agentGuide(input: AgentGuideInput) {
  const command = buildAgentEnterCommand(input);
  const startupArguments = lifecycleActionArguments(input);
  const startup = agentEnterActionTemplate(command, startupArguments);
  const lifecycle = agentGuideLifecycle(input);
  return {
    ok: true,
    recommended_entrypoint: "agent_enter",
    startup,
    lifecycle,
    rules: [
      "Prefer agent_enter for startup; do not manually compose sync_pull, boot, and refresh.",
      "When the project is unclear, follow project_list or agent_enter discovery results instead of guessing a project id.",
      "Use returned next.actions commands or arguments verbatim when continuing the lifecycle.",
      "Publish agent_status before long interruptions, and call agent_finish with a concise final summary when meaningful work ends.",
      "Pass sync_remote whenever cross-device handoff matters so status and summaries reach the shared store."
    ],
    guardrails: agentGuideGuardrails(startup),
    workflow: agentGuideWorkflow(lifecycle),
    next: {
      recommended_action: "call_agent_enter",
      ...startup,
      workflow: singleNextWorkflow("call_agent_enter", "agent_enter", startup.required_when, startup.required_fields)
    }
  };
}

export async function agentStart(input: AgentStartInput) {
  const bootstrap = await ensureLifecycleBootstrap(input);
  const project = await resolveLifecycleProjectContext(input, { requireExplicitProject: true });
  const actionInput = portableLifecycleInput(input, project);
  const projectInfo = projectEnvelope(project);
  const shouldPull = input.pull ?? projectInfo.sync_mode !== "manual";
  const sync: {
    before?: GitSyncStatus;
    pull?: GitSyncResult;
    pull_error?: string;
    pull_error_details?: MorynErrorEnvelope["error"];
    after?: GitSyncStatus;
  } = {};

  sync.before = await assertSyncNotConflicted(input.storePath);
  if (shouldPull) {
    const pulled = await trySync(() => pullGitSync(input.storePath));
    if (pulled.ok) {
      sync.pull = pulled.result;
    } else {
      sync.pull_error = pulled.error;
      sync.pull_error_details = syncErrorDetails(pulled.cause);
    }
  }
  sync.after = await assertSyncNotConflicted(input.storePath);

  const engine = createEngine({
    storePath: input.storePath,
    syncStatus: () => getGitSyncStatus(input.storePath)
  });
  const boot = await engine.boot({
    project_id: project.project_id,
    default_skills: projectInfo.default_skills,
    current_task: input.currentTask
  });
  const refresh = await engine.refresh({
    project_id: project.project_id,
    cursor: input.refreshSince,
    current_task: input.currentTask,
    limit: input.limit
  });
  const handoff = await agentHandoff(engine, project.project_id, input);
  const actions = nextActions(actionInput, refresh.cursor);

  return {
    ok: true,
    agent: sourceFromAgent(input.agent),
    project: projectInfo,
    bootstrap,
    sync,
    boot,
    refresh,
    handoff,
    next: {
      required_end_action: "call agent_finish with a session_summary",
      recommended_refresh_action: "call agent_start again with the previous refresh cursor, or call refresh directly",
      workflow: directStartWorkflow(actions),
      actions
    }
  };
}

export async function agentFinish(input: AgentFinishInput) {
  const bootstrap = await ensureLifecycleBootstrap(input);
  const project = await resolveLifecycleProjectContext(input, { requireExplicitProject: true });
  const actionInput = portableLifecycleInput(input, project);
  const projectInfo = projectEnvelope(project);
  await assertSyncNotConflicted(input.storePath);
  const engine = createEngine({ storePath: input.storePath });
  const record = await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: project.project_id,
    tags: projectInfo.tags,
    content: { text: input.summary, format: "text" },
    source: sourceFromAgent(input.agent)
  });
  const shouldPush = input.push ?? projectInfo.sync_mode !== "manual";
  const sync: {
    push?: GitSyncResult;
    push_error?: string;
    push_error_details?: MorynErrorEnvelope["error"];
    status?: GitSyncStatus;
  } = {};

  if (shouldPush) {
    const pushed = await trySync(() => pushGitSync(input.storePath, { message: `agent finish: ${project.project_id}` }));
    if (pushed.ok) {
      sync.push = pushed.result;
    } else {
      sync.push_error = pushed.error;
      sync.push_error_details = syncErrorDetails(pushed.cause);
    }
  }
  sync.status = await getGitSyncStatus(input.storePath);
  const actions = finishNextActions(actionInput);

  return {
    ok: true,
    agent: sourceFromAgent(input.agent),
    project: projectInfo,
    bootstrap,
    record: record.record,
    warning: record.warning,
    sync,
    next: {
      recommended_start_command: "moryn agent start --project <path> --current-task <task>",
      workflow: directFinishWorkflow(actions),
      actions
    }
  };
}

export async function agentStatus(input: AgentStatusInput) {
  const bootstrap = await ensureLifecycleBootstrap(input);
  const project = await resolveLifecycleProjectContext(input, { requireExplicitProject: true });
  const actionInput = portableLifecycleInput(input, project);
  const projectInfo = projectEnvelope(project);
  await assertSyncNotConflicted(input.storePath);
  const engine = createEngine({ storePath: input.storePath });
  const record = await engine.write({
    kind: "session_summary",
    type: "status",
    scope: "project",
    project_id: project.project_id,
    tags: projectInfo.tags,
    content: {
      text: input.status,
      format: "json",
      current_task: input.currentTask,
      status: input.status
    },
    source: sourceFromAgent(input.agent)
  });
  const shouldPush = input.push ?? projectInfo.sync_mode !== "manual";
  const sync: {
    push?: GitSyncResult;
    push_error?: string;
    push_error_details?: MorynErrorEnvelope["error"];
    status?: GitSyncStatus;
  } = {};

  if (shouldPush) {
    const pushed = await trySync(() => pushGitSync(input.storePath, { message: `agent status: ${project.project_id}` }));
    if (pushed.ok) {
      sync.push = pushed.result;
    } else {
      sync.push_error = pushed.error;
      sync.push_error_details = syncErrorDetails(pushed.cause);
    }
  }
  sync.status = await getGitSyncStatus(input.storePath);
  const actions = statusNextActions(actionInput, record.record.updated_at);

  return {
    ok: true,
    agent: sourceFromAgent(input.agent),
    project: projectInfo,
    bootstrap,
    record: record.record,
    warning: record.warning,
    sync,
    next: {
      recommended_finish_action: "call agent_finish with the final session_summary when meaningful work ends",
      workflow: directStatusWorkflow(actions),
      actions
    }
  };
}
