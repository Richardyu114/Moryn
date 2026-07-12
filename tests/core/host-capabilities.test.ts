import { describe, expect, it } from "vitest";
import { getHostCapabilities, negotiateHostLifecycle } from "../../src/core/host-capabilities.js";

describe("host capabilities", () => {
  it("describes official Codex lifecycle hooks and command-only transport", () => {
    expect(getHostCapabilities("codex")).toMatchObject({
      host: "codex",
      hook_transport: "command",
      context_injection: "hook_output",
      events: { session_start: true, user_prompt_submit: true, pre_compact: true, post_compact: true, stop: true, session_end: false }
    });
  });

  it("describes Claude Code session-end and compaction hooks", () => {
    expect(getHostCapabilities("claude-code")).toMatchObject({
      host: "claude",
      hook_transport: "command",
      context_injection: "hook_output",
      events: { session_start: true, user_prompt_submit: true, pre_compact: true, post_compact: true, stop: true, session_end: true }
    });
  });
});

describe("host lifecycle negotiation", () => {
  it("uses native hooks when available", () => {
    expect(negotiateHostLifecycle("claude", ["session_start", "pre_compact", "post_compact", "session_end"]).events_by_name).toEqual({
      session_start: { mode: "native", hook_event: "SessionStart" },
      pre_compact: { mode: "native", hook_event: "PreCompact" },
      post_compact: { mode: "native", hook_event: "PostCompact" },
      session_end: { mode: "native", hook_event: "SessionEnd" }
    });
  });

  it("falls back from Codex session end to agent finish guidance", () => {
    expect(negotiateHostLifecycle("codex", ["session_end"]).events_by_name.session_end).toEqual({
      mode: "fallback",
      command: "moryn agent finish --summary <summary>",
      reason: "host_hook_unavailable"
    });
  });

  it("reports unsupported hosts without inventing hooks", () => {
    expect(negotiateHostLifecycle("shell", ["pre_compact"]).events_by_name.pre_compact).toEqual({
      mode: "fallback",
      command: "moryn agent checkpoint --checkpoint-id <checkpoint_id> --progress <progress>",
      reason: "host_hook_unavailable"
    });
  });
});
