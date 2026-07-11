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
    ["PostCompact", "post_compact"],
    ["Stop", "stop"],
    ["SessionEnd", "session_end"]
  ])("maps %s to %s", (hookEvent, expected) => {
    expect(normalizeHostHookEvent("claude", { hook_event_name: hookEvent, session_id: "s", cwd: "/repo" }, { device_id: "d", occurred_at: "2026-07-11T00:00:00.000Z" }).event).toBe(expected);
  });

  it("rejects unknown events and missing stable identity", () => {
    expect(() => normalizeHostHookEvent("codex", { hook_event_name: "BeforeTool", session_id: "s", cwd: "/repo" }, { device_id: "d", occurred_at: "2026-07-11T00:00:00.000Z" })).toThrow("unsupported host hook event");
    expect(() => normalizeHostHookEvent("codex", { hook_event_name: "SessionStart", cwd: "/repo" }, { device_id: "d", occurred_at: "2026-07-11T00:00:00.000Z" })).toThrow("session_id");
  });
});
