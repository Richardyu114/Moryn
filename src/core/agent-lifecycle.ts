import { createEngine } from "./engine.js";
import { initializeStore, readStoreConfig } from "./config.js";
import { resolveProjectContext, type ProjectContext, type SyncMode } from "./project.js";
import type { RecordSource } from "./types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync, type GitSyncResult, type GitSyncStatus } from "../sync/git.js";

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

type DoctorSeverity = "ok" | "notice" | "warning";

export interface AgentDoctorInput extends AgentLifecycleInput {}

interface BootstrapResult {
  initialized_store: boolean;
  sync_init?: GitSyncResult;
  sync_init_error?: string;
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

async function trySync<T>(fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isMissingStore(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendOption(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined) return;
  parts.push(name, shellQuote(value));
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

function buildProjectInitCommand(input: AgentLifecycleInput): string {
  const parts = ["moryn", "project", "init"];
  appendOption(parts, "--path", input.projectPath);
  appendOption(parts, "--project-id", input.projectId);
  return parts.join(" ");
}

async function initializeLifecycleSync(storePath: string, syncRemote: string | undefined, result: BootstrapResult): Promise<void> {
  if (!syncRemote) return;
  const initialized = await trySync(() => initializeGitSync(storePath, syncRemote));
  if (initialized.ok) {
    result.sync_init = initialized.result;
  } else {
    result.sync_init_error = initialized.error;
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

export async function agentDoctor(input: AgentDoctorInput) {
  const checks: Array<{ name: string; ok: boolean; severity: DoctorSeverity; message: string }> = [];
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

  const project = await trySync(() => resolveProjectContext({ projectPath: input.projectPath, projectId: input.projectId }));
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
  checks.push({
    name: "sync",
    ok: syncConfigured && remoteMatches,
    severity: syncConfigured && remoteMatches ? "ok" : "notice",
    message: syncConfigured && remoteMatches
      ? "Sync is configured."
      : input.syncRemote
        ? "Sync is not connected to the expected remote; agent_start can initialize or update it."
        : "Sync is not configured; pass sync_remote when cross-device handoff is needed."
  });

  const next = project.ok
    ? {
        recommended_action: "call_agent_start",
        tool: "agent_start",
        safe_to_run: true,
        command: buildAgentStartCommand(input),
        arguments: {
          project_path: input.projectPath,
          project_id: input.projectId,
          sync_remote: input.syncRemote,
          current_task: input.currentTask,
          agent: input.agent
        }
      }
    : {
        recommended_action: "fix_project_config",
        tool: "project_init",
        safe_to_run: false,
        command: buildProjectInitCommand(input),
        arguments: {
          path: input.projectPath,
          project_id: input.projectId
        }
      };

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
    next
  };
}

export async function agentStart(input: AgentStartInput) {
  const bootstrap = await ensureLifecycleBootstrap(input);
  const project = await resolveProjectContext({ projectPath: input.projectPath, projectId: input.projectId });
  const projectInfo = projectEnvelope(project);
  const shouldPull = input.pull ?? projectInfo.sync_mode !== "manual";
  const sync: {
    before?: GitSyncStatus;
    pull?: GitSyncResult;
    pull_error?: string;
    after?: GitSyncStatus;
  } = {};

  sync.before = await getGitSyncStatus(input.storePath);
  if (shouldPull) {
    const pulled = await trySync(() => pullGitSync(input.storePath));
    if (pulled.ok) {
      sync.pull = pulled.result;
    } else {
      sync.pull_error = pulled.error;
    }
  }
  sync.after = await getGitSyncStatus(input.storePath);

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

  return {
    ok: true,
    agent: sourceFromAgent(input.agent),
    project: projectInfo,
    bootstrap,
    sync,
    boot,
    refresh,
    next: {
      required_end_action: "call agent_finish with a session_summary",
      recommended_refresh_action: "call agent_start again with the previous refresh cursor, or call refresh directly"
    }
  };
}

export async function agentFinish(input: AgentFinishInput) {
  const bootstrap = await ensureLifecycleBootstrap(input);
  const project = await resolveProjectContext({ projectPath: input.projectPath, projectId: input.projectId });
  const projectInfo = projectEnvelope(project);
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
    status?: GitSyncStatus;
  } = {};

  if (shouldPush) {
    const pushed = await trySync(() => pushGitSync(input.storePath, { message: `agent finish: ${project.project_id}` }));
    if (pushed.ok) {
      sync.push = pushed.result;
    } else {
      sync.push_error = pushed.error;
    }
  }
  sync.status = await getGitSyncStatus(input.storePath);

  return {
    ok: true,
    agent: sourceFromAgent(input.agent),
    project: projectInfo,
    bootstrap,
    record: record.record,
    warning: record.warning,
    sync,
    next: {
      recommended_start_command: "moryn agent start --project <path> --current-task <task>"
    }
  };
}
