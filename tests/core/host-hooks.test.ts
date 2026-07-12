import { describe, expect, it } from "vitest";
import { normalizeHostHookEvent } from "../../src/core/host-hooks.js";

describe("host hook normalization", () => {
  it("normalizes Codex SessionStart input", () => {
    expect(normalizeHostHookEvent("codex", {
      hook_event_name: "SessionStart",
      session_id: "codex-session",
      cwd: "/repo",
      source: "startup"
    }, { device_id: "device-a", occurred_at: "2026-07-11T00:00:00.000Z" })).toEqual({
      host: "codex",
      event: "session_start",
      session_id: "codex-session",
      device_id: "device-a",
      cwd: "/repo",
      trigger: "startup",
      occurred_at: "2026-07-11T00:00:00.000Z"
    });
  });

  it("retains bounded transcript evidence fields from observed Codex payloads", () => {
    expect(normalizeHostHookEvent("codex", {
      hook_event_name: "Stop",
      session_id: "codex-session",
      turn_id: "turn-1",
      transcript_path: "/home/user/.codex/sessions/session.jsonl",
      cwd: "/repo",
      last_assistant_message: "Implemented the parser and verified tests."
    }, { device_id: "device-a", occurred_at: "2026-07-11T00:00:00.000Z" })).toMatchObject({
      turn_id: "turn-1",
      transcript_path: "/home/user/.codex/sessions/session.jsonl",
      last_assistant_message: "Implemented the parser and verified tests."
    });
  });

  it("retains transcript evidence fields from observed Claude payloads", () => {
    expect(normalizeHostHookEvent("claude", {
      hook_event_name: "SessionEnd",
      session_id: "claude-session",
      transcript_path: "/home/user/.claude/projects/repo/session.jsonl",
      cwd: "/repo",
      reason: "other"
    }, { device_id: "device-b", occurred_at: "2026-07-11T00:00:00.000Z" })).toMatchObject({
      transcript_path: "/home/user/.claude/projects/repo/session.jsonl"
    });
  });

  it("normalizes Claude Code PreCompact and compact summary aliases", () => {
    expect(normalizeHostHookEvent("claude-code", {
      hook_event_name: "PreCompact",
      session_id: "claude-session",
      cwd: "/repo",
      trigger: "auto",
      compact_summary: "Implemented parser; next run tests."
    }, { device_id: "device-b", occurred_at: "2026-07-11T00:01:00.000Z" })).toMatchObject({
      host: "claude",
      event: "pre_compact",
      session_id: "claude-session",
      device_id: "device-b",
      trigger: "auto",
      compact_summary: "Implemented parser; next run tests."
    });
  });

  it.each([
    ["UserPromptSubmit", "user_prompt_submit"],
    ["PostCompact", "post_compact"],
    ["Stop", "stop"],
    ["SessionEnd", "session_end"]
  ])("maps %s to %s", (hookEvent, expected) => {
    const input = { hook_event_name: hookEvent, session_id: "s", cwd: "/repo", ...(hookEvent === "UserPromptSubmit" ? { prompt: "How does release rollback work?" } : {}) };
    expect(normalizeHostHookEvent("claude", input, { device_id: "d", occurred_at: "2026-07-11T00:00:00.000Z" }).event).toBe(expected);
  });

  it("normalizes a user prompt and rejects empty prompt input", () => {
    expect(normalizeHostHookEvent("codex", {
      hook_event_name: "UserPromptSubmit",
      session_id: "prompt-session",
      cwd: "/repo",
      prompt: "  How does release rollback work?  "
    }, { device_id: "device-a", occurred_at: "2026-07-11T00:00:00.000Z" })).toMatchObject({
      event: "user_prompt_submit",
      prompt: "How does release rollback work?"
    });
    expect(() => normalizeHostHookEvent("codex", {
      hook_event_name: "UserPromptSubmit",
      session_id: "prompt-session",
      cwd: "/repo",
      prompt: "  "
    }, { device_id: "device-a", occurred_at: "2026-07-11T00:00:00.000Z" })).toThrow("prompt");
  });

  it("rejects unknown events and missing stable identity", () => {
    expect(() => normalizeHostHookEvent("codex", { hook_event_name: "BeforeTool", session_id: "s", cwd: "/repo" }, { device_id: "d", occurred_at: "2026-07-11T00:00:00.000Z" })).toThrow("unsupported host hook event");
    expect(() => normalizeHostHookEvent("codex", { hook_event_name: "SessionStart", cwd: "/repo" }, { device_id: "d", occurred_at: "2026-07-11T00:00:00.000Z" })).toThrow("session_id");
  });
});
