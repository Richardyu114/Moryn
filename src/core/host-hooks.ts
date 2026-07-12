import { normalizeHostId, type HostAdapterId } from "./host-adapter-registry.js";
import type { HostLifecycleEvent } from "./host-capabilities.js";

export interface NormalizedHostHookEvent {
  host: HostAdapterId;
  event: HostLifecycleEvent;
  session_id: string;
  device_id: string;
  cwd: string;
  trigger?: string;
  compact_summary?: string;
  prompt?: string;
  transcript_path?: string;
  turn_id?: string;
  last_assistant_message?: string;
  occurred_at: string;
}

const EVENT_NAMES: Record<string, HostLifecycleEvent> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  Stop: "stop",
  SessionEnd: "session_end"
};

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid argument: host hook ${name} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoundedText(value: unknown, maxLength: number): string | undefined {
  const text = optionalText(value);
  return text ? text.slice(0, maxLength) : undefined;
}

export function normalizeHostHookEvent(host: string, input: unknown, defaults: { device_id: string; occurred_at: string }): NormalizedHostHookEvent {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid argument: host hook input must be an object");
  const payload = input as Record<string, unknown>;
  const normalizedHost = normalizeHostId(host);
  if (!normalizedHost) throw new Error(`Invalid argument: unsupported host: ${host}`);
  const hookEventName = nonEmpty(payload.hook_event_name ?? payload.hookEventName ?? payload.event, "hook_event_name");
  const event = EVENT_NAMES[hookEventName];
  if (!event) throw new Error(`Invalid argument: unsupported host hook event: ${hookEventName}`);
  const occurredAt = nonEmpty(payload.occurred_at ?? defaults.occurred_at, "occurred_at");
  if (!Number.isFinite(Date.parse(occurredAt)) || new Date(Date.parse(occurredAt)).toISOString() !== occurredAt) {
    throw new Error("Invalid argument: host hook occurred_at must be a canonical ISO timestamp");
  }
  const prompt = event === "user_prompt_submit" ? nonEmpty(payload.prompt, "prompt") : undefined;
  return {
    host: normalizedHost,
    event,
    session_id: nonEmpty(payload.session_id ?? payload.sessionId, "session_id"),
    device_id: nonEmpty(payload.device_id ?? payload.deviceId ?? defaults.device_id, "device_id"),
    cwd: nonEmpty(payload.cwd ?? payload.project_path ?? payload.projectPath, "cwd"),
    ...(optionalText(payload.source ?? payload.trigger) ? { trigger: optionalText(payload.source ?? payload.trigger) } : {}),
    ...(optionalText(payload.compact_summary ?? payload.compactSummary ?? payload.summary) ? { compact_summary: optionalText(payload.compact_summary ?? payload.compactSummary ?? payload.summary) } : {}),
    ...(prompt ? { prompt } : {}),
    ...(optionalBoundedText(payload.transcript_path ?? payload.transcriptPath, 4096) ? { transcript_path: optionalBoundedText(payload.transcript_path ?? payload.transcriptPath, 4096) } : {}),
    ...(optionalBoundedText(payload.turn_id ?? payload.turnId, 256) ? { turn_id: optionalBoundedText(payload.turn_id ?? payload.turnId, 256) } : {}),
    ...(optionalBoundedText(payload.last_assistant_message ?? payload.lastAssistantMessage, 4000) ? { last_assistant_message: optionalBoundedText(payload.last_assistant_message ?? payload.lastAssistantMessage, 4000) } : {}),
    occurred_at: occurredAt
  };
}
