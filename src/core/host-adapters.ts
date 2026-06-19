import { agentStart } from "./agent-lifecycle.js";
import { createEngine } from "./engine.js";
import { resolveProjectContext } from "./project.js";
import type { MorynRecord, RecordSource } from "./types.js";

export type HostAdapterId = "claude" | "codex" | "gemini" | "cursor" | "shell";

export type HostAdapter = {
  id: HostAdapterId;
  display_name: string;
  normalized_client: HostAdapterId;
  aliases: string[];
  detection_signals: string[];
  supported_install_steps: string[];
  mcp_registration: {
    command: string;
    notes: string[];
  };
  lifecycle_prompt: string;
  capture_strategy: {
    default_command: string;
    records: string[];
  };
  limitations: string[];
};

export type InstallPlanAction = {
  action: "initialize_store" | "initialize_project" | "register_mcp" | "context_pack" | "capture_session";
  title: string;
  command: string;
  safe_to_auto_run: boolean;
  writes: "none" | "moryn_store" | "project_config";
  adapter?: HostAdapterId;
};

export type InstallPlan = {
  mode: "dry_run" | "apply";
  host: HostAdapterId | "all";
  project_path?: string;
  sync_remote?: string;
  adapters: HostAdapter[];
  actions: InstallPlanAction[];
  actions_by_id: Record<string, InstallPlanAction>;
  warnings: string[];
  next: {
    recommended_action: "run_context_pack";
    command: string;
    safe_to_run: boolean;
  };
  selection_sources: typeof INSTALL_PLAN_SELECTION_SOURCES;
};

export type InstallPlanInput = {
  host?: string;
  projectPath?: string;
  syncRemote?: string;
  apply?: boolean;
};

export type CaptureSessionInput = {
  storePath: string;
  projectPath?: string;
  projectId?: string;
  syncRemote?: string;
  summary: string;
  currentTask?: string;
  agent?: Partial<RecordSource>;
};

export type CaptureSessionResult = {
  ok: true;
  mode: "capture_session";
  adapter: HostAdapter;
  record: MorynRecord;
  next: {
    recommended_action: "run_context_pack";
    command: string;
    safe_to_run: boolean;
  };
  selection_sources: typeof CAPTURE_SESSION_SELECTION_SOURCES;
};

export type ContextPackInput = {
  storePath: string;
  projectPath?: string;
  projectId?: string;
  syncRemote?: string;
  currentTask?: string;
  agent?: Partial<RecordSource>;
  limit?: number;
  includePrivate?: boolean;
  pull?: boolean;
};

export type ContextPackResult = {
  ok: true;
  kind: "context_pack";
  adapter: HostAdapter;
  agent: RecordSource;
  project: Record<string, unknown>;
  sections: {
    boot: unknown;
    refresh: unknown;
    handoff: {
      inbox: Array<{ text: string }>;
      active_sessions: unknown[];
      [key: string]: unknown;
    };
  };
  lifecycle: unknown;
  next: {
    required_end_action_id: "capture_session";
    required_end_action_source: "next.actions_by_id.capture_session";
    recommended_refresh_action_id?: string;
    actions: unknown[];
    actions_by_id: Record<string, unknown>;
    selection_sources: typeof CONTEXT_PACK_NEXT_SELECTION_SOURCES;
  };
  selection_sources: typeof CONTEXT_PACK_SELECTION_SOURCES;
};

export const INSTALL_PLAN_SELECTION_SOURCES = {
  adapter: "adapters[]",
  action: "actions_by_id.<action>",
  ordered_action: "actions[]",
  next: "next",
  warning: "warnings[]"
} as const;

export const CAPTURE_SESSION_SELECTION_SOURCES = {
  record: "record",
  record_id: "record.id",
  adapter: "adapter",
  next: "next"
} as const;

export const CONTEXT_PACK_SELECTION_SOURCES = {
  context_pack: "context_pack",
  project: "project",
  boot: "sections.boot",
  refresh: "sections.refresh",
  handoff: "sections.handoff",
  next: "next"
} as const;

export const CONTEXT_PACK_NEXT_SELECTION_SOURCES = {
  action: "next.actions_by_id.<action>",
  ordered_action: "next.actions[]",
  capture_session: "next.actions_by_id.capture_session"
} as const;

const HOST_ADAPTERS: HostAdapter[] = [
  {
    id: "claude",
    display_name: "Claude Code",
    normalized_client: "claude",
    aliases: ["claude", "claude-code", "claude_code", "anthropic-claude"],
    detection_signals: ["CLAUDECODE", "Claude Code config", ".claude"],
    supported_install_steps: ["register_mcp", "print_lifecycle_prompt", "print_capture_commands"],
    mcp_registration: {
      command: "claude mcp add moryn -- moryn mcp",
      notes: ["Use the host-specific MCP registration command when Claude Code exposes MCP configuration."]
    },
    lifecycle_prompt: "Use moryn context pack at session start and moryn capture session before handoff.",
    capture_strategy: {
      default_command: "moryn capture session --agent claude --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["MVP does not mutate Claude Code configuration files automatically."]
  },
  {
    id: "codex",
    display_name: "Codex",
    normalized_client: "codex",
    aliases: ["codex", "codex-cli", "codex_cli", "openai-codex"],
    detection_signals: ["CODEX_HOME", ".codex", "Codex MCP config"],
    supported_install_steps: ["register_mcp", "print_lifecycle_prompt", "print_capture_commands"],
    mcp_registration: {
      command: "codex mcp add moryn -- moryn mcp",
      notes: ["Use project scope when the host supports per-project MCP config."]
    },
    lifecycle_prompt: "Use moryn context pack at session start and moryn capture session before final response.",
    capture_strategy: {
      default_command: "moryn capture session --agent codex --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["MVP returns exact commands instead of editing Codex configuration."]
  },
  {
    id: "gemini",
    display_name: "Gemini CLI",
    normalized_client: "gemini",
    aliases: ["gemini", "gemini-cli", "gemini_cli", "google-gemini"],
    detection_signals: ["GEMINI_HOME", "Gemini MCP config", ".gemini"],
    supported_install_steps: ["register_mcp", "print_lifecycle_prompt", "print_capture_commands"],
    mcp_registration: {
      command: "gemini mcp add moryn moryn mcp --scope project",
      notes: ["Prefer project scope so Moryn follows the current repository."]
    },
    lifecycle_prompt: "Use moryn context pack when opening a project and moryn capture session for session-end handoff.",
    capture_strategy: {
      default_command: "moryn capture session --agent gemini --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["MVP does not detect all Gemini CLI configuration locations."]
  },
  {
    id: "cursor",
    display_name: "Cursor",
    normalized_client: "cursor",
    aliases: ["cursor", "cursor-agent", "cursor_ai", "cursor-ai"],
    detection_signals: ["Cursor MCP config", ".cursor"],
    supported_install_steps: ["register_mcp", "print_lifecycle_prompt", "print_capture_commands"],
    mcp_registration: {
      command: "Add a moryn MCP server with command 'moryn' and args ['mcp'] in Cursor MCP settings.",
      notes: ["Cursor configuration format can vary; Moryn prints instructions instead of editing config in MVP."]
    },
    lifecycle_prompt: "Use moryn context pack for startup context and moryn capture session for handoff notes.",
    capture_strategy: {
      default_command: "moryn capture session --agent cursor --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["MVP does not mutate Cursor settings."]
  },
  {
    id: "shell",
    display_name: "Shell Agent",
    normalized_client: "shell",
    aliases: ["shell", "bash", "zsh", "script", "cli"],
    detection_signals: ["SHELL", "generic shell environment"],
    supported_install_steps: ["print_lifecycle_prompt", "print_capture_commands"],
    mcp_registration: {
      command: "moryn mcp",
      notes: ["Shell agents can use the CLI directly or expose this command through their own MCP host."]
    },
    lifecycle_prompt: "Run moryn context pack before work and moryn capture session after meaningful work.",
    capture_strategy: {
      default_command: "moryn capture session --agent shell --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["Generic shell usage cannot be fully auto-detected."]
  }
];

const HOST_ALIASES = new Map<string, HostAdapterId>();

for (const adapter of HOST_ADAPTERS) {
  HOST_ALIASES.set(adapter.id, adapter.id);
  for (const alias of adapter.aliases) {
    HOST_ALIASES.set(alias, adapter.id);
  }
}

export function normalizeHostId(host?: string): HostAdapterId {
  if (!host) return "shell";
  const key = host.trim().toLowerCase();
  return HOST_ALIASES.get(key) ?? "shell";
}

export function getHostAdapters(): HostAdapter[] {
  return HOST_ADAPTERS.map((adapter) => ({
    ...adapter,
    aliases: [...adapter.aliases],
    detection_signals: [...adapter.detection_signals],
    supported_install_steps: [...adapter.supported_install_steps],
    mcp_registration: {
      command: adapter.mcp_registration.command,
      notes: [...adapter.mcp_registration.notes]
    },
    capture_strategy: {
      default_command: adapter.capture_strategy.default_command,
      records: [...adapter.capture_strategy.records]
    },
    limitations: [...adapter.limitations]
  }));
}

export function getHostAdapter(host?: string): HostAdapter | undefined {
  const normalized = normalizeHostId(host);
  return getHostAdapters().find((adapter) => adapter.id === normalized);
}

export function planInstall(input: InstallPlanInput = {}): InstallPlan {
  const normalizedHost = input.host ? normalizeHostId(input.host) : "all";
  const adapters = normalizedHost === "all"
    ? getHostAdapters()
    : getHostAdapters().filter((adapter) => adapter.id === normalizedHost);
  const projectPath = input.projectPath;
  const syncRemote = input.syncRemote;
  const firstAdapter = adapters[0] ?? getHostAdapter("shell")!;
  const agent = normalizedHost === "all" ? firstAdapter.normalized_client : normalizedHost;
  const projectArgs = projectPath ? ` --project ${quoteCli(projectPath)}` : "";
  const syncArgs = syncRemote ? ` --sync-remote ${quoteCli(syncRemote)}` : "";
  const currentTask = "<current task>";
  const actions: InstallPlanAction[] = [
    {
      action: "initialize_store",
      title: "Initialize the local Moryn store",
      command: "moryn init",
      safe_to_auto_run: true,
      writes: "moryn_store"
    }
  ];

  if (projectPath) {
    actions.push({
      action: "initialize_project",
      title: "Attach this repository as a Moryn project",
      command: `moryn project init --path ${quoteCli(projectPath)}`,
      safe_to_auto_run: true,
      writes: "project_config"
    });
  }

  for (const adapter of adapters) {
    actions.push({
      action: "register_mcp",
      title: `Register Moryn MCP for ${adapter.display_name}`,
      command: adapter.mcp_registration.command,
      safe_to_auto_run: false,
      writes: "none",
      adapter: adapter.id
    });
    actions.push({
      action: "context_pack",
      title: `Start ${adapter.display_name} with Moryn context`,
      command: `moryn context pack${projectArgs}${syncArgs} --current-task ${quoteCli(currentTask)} --agent ${adapter.normalized_client}`,
      safe_to_auto_run: true,
      writes: "none",
      adapter: adapter.id
    });
    actions.push({
      action: "capture_session",
      title: `Capture ${adapter.display_name} session handoff`,
      command: `moryn capture session${projectArgs}${syncArgs} --agent ${adapter.normalized_client} --summary ${quoteCli("<summary>")}`,
      safe_to_auto_run: true,
      writes: "moryn_store",
      adapter: adapter.id
    });
  }

  const actionsById = Object.fromEntries(actions.map((action) => [action.action, action]));
  const warnings = [
    "MVP install planning does not mutate host configuration files.",
    "Git sync is configured only when a sync remote is supplied by the user."
  ];
  const nextCommand = `moryn context pack${projectArgs}${syncArgs} --current-task ${quoteCli(currentTask)} --agent ${agent}`;

  return {
    mode: input.apply ? "apply" : "dry_run",
    host: normalizedHost,
    project_path: projectPath,
    sync_remote: syncRemote,
    adapters,
    actions,
    actions_by_id: actionsById,
    warnings,
    next: {
      recommended_action: "run_context_pack",
      command: nextCommand,
      safe_to_run: true
    },
    selection_sources: INSTALL_PLAN_SELECTION_SOURCES
  };
}

export async function captureSession(input: CaptureSessionInput): Promise<CaptureSessionResult> {
  const summary = input.summary.trim();
  if (!summary) {
    throw new Error("Invalid argument: --summary must not be empty");
  }
  const adapter = getHostAdapter(input.agent?.client) ?? getHostAdapter("shell")!;
  const project = await resolveProjectContext({
    projectPath: input.projectPath,
    projectId: input.projectId
  });
  const source: RecordSource = {
    client: adapter.normalized_client,
    session_id: input.agent?.session_id,
    model: input.agent?.model,
    device_id: input.agent?.device_id
  };
  const engine = createEngine({ storePath: input.storePath });
  const written = await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: project.project_id,
    tags: ["autocapture", "review", `host:${adapter.normalized_client}`],
    content: {
      format: "json",
      text: summary,
      capture: {
        mode: "autocapture",
        host: adapter.normalized_client,
        adapter: adapter.id,
        session_id: input.agent?.session_id,
        current_task: input.currentTask
      }
    },
    source,
    provenance: {
      method: "agent-proposed",
      reason: "Captured through Moryn host adapter autocapture."
    }
  });

  const projectArg = input.projectId
    ? ` --project-id ${quoteCli(input.projectId)}`
    : input.projectPath
      ? ` --project ${quoteCli(input.projectPath)}`
      : "";
  const taskArg = input.currentTask ? ` --current-task ${quoteCli(input.currentTask)}` : "";
  const syncArg = input.syncRemote ? ` --sync-remote ${quoteCli(input.syncRemote)}` : "";
  return {
    ok: true,
    mode: "capture_session",
    adapter,
    record: written.record,
    next: {
      recommended_action: "run_context_pack",
      command: `moryn context pack${projectArg}${syncArg}${taskArg} --agent ${adapter.normalized_client}`,
      safe_to_run: true
    },
    selection_sources: CAPTURE_SESSION_SELECTION_SOURCES
  };
}

export async function contextPack(input: ContextPackInput): Promise<ContextPackResult> {
  const adapter = getHostAdapter(input.agent?.client) ?? getHostAdapter("shell")!;
  const agent: RecordSource = {
    client: adapter.normalized_client,
    session_id: input.agent?.session_id,
    model: input.agent?.model,
    device_id: input.agent?.device_id
  };
  const started = await agentStart({
    storePath: input.storePath,
    projectPath: input.projectPath,
    projectId: input.projectId,
    syncRemote: input.syncRemote,
    currentTask: input.currentTask,
    limit: input.limit,
    includePrivate: input.includePrivate,
    pull: input.pull,
    agent
  });
  const projectArg = input.projectId
    ? ` --project-id ${quoteCli(input.projectId)}`
    : input.projectPath
      ? ` --project ${quoteCli(input.projectPath)}`
      : "";
  const taskArg = input.currentTask ? ` --current-task ${quoteCli(input.currentTask)}` : "";
  const syncArg = input.syncRemote ? ` --sync-remote ${quoteCli(input.syncRemote)}` : "";
  const captureAction = {
    action: "capture_session",
    tool: "capture_session",
    safe_to_run: true,
    required_when: "Before ending the host session, capture a handoff summary for other agents and devices.",
    required_fields: ["summary"],
    command: `moryn capture session${projectArg}${syncArg}${taskArg} --agent ${adapter.normalized_client} --summary <summary>`,
    arguments: {
      ...(input.projectId ? { project_id: input.projectId } : {}),
      ...(input.projectPath ? { project_path: input.projectPath } : {}),
      ...(input.syncRemote ? { sync_remote: input.syncRemote } : {}),
      ...(input.currentTask ? { current_task: input.currentTask } : {}),
      agent,
      summary: "<summary>"
    }
  };
  const actions = [captureAction, ...started.next.actions];
  const actionsById = {
    capture_session: captureAction,
    ...started.next.actions_by_id
  };

  return {
    ok: true,
    kind: "context_pack",
    adapter,
    agent,
    project: started.project as unknown as Record<string, unknown>,
    sections: {
      boot: started.boot,
      refresh: started.refresh,
      handoff: started.handoff
    },
    lifecycle: started.next.workflow,
    next: {
      required_end_action_id: "capture_session",
      required_end_action_source: "next.actions_by_id.capture_session",
      recommended_refresh_action_id: started.next.recommended_refresh_action_id,
      actions,
      actions_by_id: actionsById,
      selection_sources: CONTEXT_PACK_NEXT_SELECTION_SOURCES
    },
    selection_sources: CONTEXT_PACK_SELECTION_SOURCES
  };
}

function quoteCli(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
