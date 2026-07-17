import { type HostAdapterId, normalizeHostId } from "./host-adapter-registry.js";

export type HostLifecycleEvent =
  | "session_start"
  | "user_prompt_submit"
  | "pre_compact"
  | "post_compact"
  | "stop"
  | "session_end";

export interface HostCapabilities {
  host: HostAdapterId;
  hook_transport: "command" | "none";
  context_injection: "hook_output" | "none";
  events: Record<HostLifecycleEvent, boolean>;
}

const HOOK_EVENT_NAMES: Record<HostLifecycleEvent, string> = {
  session_start: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
  pre_compact: "PreCompact",
  post_compact: "PostCompact",
  stop: "Stop",
  session_end: "SessionEnd"
};

const FALLBACK_COMMANDS: Record<HostLifecycleEvent, string> = {
  session_start: "moryn agent start --current-task <task>",
  user_prompt_submit: "moryn recall --query <prompt>",
  pre_compact: "moryn agent checkpoint --checkpoint-id <checkpoint_id> --progress <progress>",
  post_compact: "moryn agent start --current-task <task>",
  stop: "moryn agent status --status <status>",
  session_end: "moryn agent finish --summary <summary>"
};

const NONE: Record<HostLifecycleEvent, boolean> = {
  session_start: false,
  user_prompt_submit: false,
  pre_compact: false,
  post_compact: false,
  stop: false,
  session_end: false
};

export function getHostCapabilities(host: string): HostCapabilities {
  const normalized = normalizeHostId(host) ?? "shell";
  if (normalized === "codex") {
    return {
      host: normalized,
      hook_transport: "command",
      context_injection: "hook_output",
      events: {
        ...NONE,
        session_start: true,
        user_prompt_submit: true,
        pre_compact: true,
        post_compact: true,
        stop: true
      }
    };
  }
  if (normalized === "claude") {
    return {
      host: normalized,
      hook_transport: "command",
      context_injection: "hook_output",
      events: {
        session_start: true,
        user_prompt_submit: true,
        pre_compact: true,
        post_compact: true,
        stop: true,
        session_end: true
      }
    };
  }
  return { host: normalized, hook_transport: "none", context_injection: "none", events: { ...NONE } };
}

export function negotiateHostLifecycle(host: string, requestedEvents: HostLifecycleEvent[]) {
  const capabilities = getHostCapabilities(host);
  return {
    host: capabilities.host,
    capabilities,
    events_by_name: Object.fromEntries(
      requestedEvents.map((event) => [
        event,
        capabilities.events[event]
          ? { mode: "native" as const, hook_event: HOOK_EVENT_NAMES[event] }
          : { mode: "fallback" as const, command: FALLBACK_COMMANDS[event], reason: "host_hook_unavailable" as const }
      ])
    ) as Record<
      HostLifecycleEvent,
      { mode: "native"; hook_event: string } | { mode: "fallback"; command: string; reason: "host_hook_unavailable" }
    >
  };
}
