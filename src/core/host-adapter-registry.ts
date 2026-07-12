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
  knowledge_protocol?: KnowledgeProtocol;
  capture_strategy: {
    default_command: string;
    records: string[];
  };
  limitations: string[];
};

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
    lifecycle_prompt: knowledgeProtocolForHost("claude").prompt,
    knowledge_protocol: knowledgeProtocolForHost("claude"),
    capture_strategy: {
      default_command: "moryn capture session --agent claude --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["Moryn supports automatic lifecycle activation with safe merge, backup, and atomic replacement; invalid host configuration degrades without modification."]
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
    lifecycle_prompt: knowledgeProtocolForHost("codex").prompt,
    knowledge_protocol: knowledgeProtocolForHost("codex"),
    capture_strategy: {
      default_command: "moryn capture session --agent codex --summary <summary>",
      records: ["session_summary", "agent_note", "memory(candidate)", "skill(candidate)"]
    },
    limitations: ["Moryn supports automatic lifecycle activation in .codex/hooks.json; Codex still requires one-time project hook review through /hooks."]
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

function cloneHostAdapter(adapter: HostAdapter): HostAdapter {
  return {
    ...adapter,
    aliases: [...adapter.aliases],
    detection_signals: [...adapter.detection_signals],
    supported_install_steps: [...adapter.supported_install_steps],
    mcp_registration: {
      command: adapter.mcp_registration.command,
      notes: [...adapter.mcp_registration.notes]
    },
    ...(adapter.knowledge_protocol ? { knowledge_protocol: structuredClone(adapter.knowledge_protocol) } : {}),
    capture_strategy: {
      default_command: adapter.capture_strategy.default_command,
      records: [...adapter.capture_strategy.records]
    },
    limitations: [...adapter.limitations]
  };
}

export function normalizeHostId(host?: string): HostAdapterId {
  if (!host) return "shell";
  const key = host.trim().toLowerCase();
  return HOST_ALIASES.get(key) ?? "shell";
}

export function getHostAdapters(): HostAdapter[] {
  return HOST_ADAPTERS.map(cloneHostAdapter);
}

export function getHostAdapter(host?: string): HostAdapter | undefined {
  const normalized = normalizeHostId(host);
  const adapter = HOST_ADAPTERS.find((candidate) => candidate.id === normalized);
  return adapter ? cloneHostAdapter(adapter) : undefined;
}
import { knowledgeProtocolForHost, type KnowledgeProtocol } from "./knowledge-protocol.js";
