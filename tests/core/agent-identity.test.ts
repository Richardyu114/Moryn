import { describe, expect, it } from "vitest";
import { normalizeAgentIdentity } from "../../src/core/agent-identity.js";

describe("agent identity normalization", () => {
  it("normalizes known agent hosts and local transports", () => {
    expect(normalizeAgentIdentity("codex")).toMatchObject({
      client: "Codex",
      family: "codex",
      confidence: "known"
    });
    expect(normalizeAgentIdentity("codex-cli")).toMatchObject({
      client: "Codex",
      family: "codex",
      confidence: "known"
    });
    expect(normalizeAgentIdentity("claude-code")).toMatchObject({
      client: "Claude",
      family: "claude",
      confidence: "known"
    });
    expect(normalizeAgentIdentity("kimi-k2")).toMatchObject({
      client: "Kimi",
      family: "kimi",
      confidence: "known"
    });
    expect(normalizeAgentIdentity("gemini")).toMatchObject({
      client: "Gemini",
      family: "gemini",
      confidence: "known"
    });
    expect(normalizeAgentIdentity("mcp")).toMatchObject({
      client: "Moryn Local",
      family: "moryn-local",
      confidence: "generic"
    });
    expect(normalizeAgentIdentity("openai-agent")).toMatchObject({
      client: "Openai Agent",
      family: "openai-agent",
      confidence: "generic"
    });
  });
});
