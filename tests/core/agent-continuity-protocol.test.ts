import { describe, expect, it } from "vitest";
import {
  AGENT_CONTINUITY_PROTOCOL_VERSION,
  buildAgentContinuityTransferPlan,
  negotiateAgentContinuity
} from "../../src/core/agent-continuity-protocol.js";

describe("Agent Continuity Protocol", () => {
  it.each(["codex", "claude"])("normalizes lifecycle routes for %s", (host) => {
    const result = negotiateAgentContinuity({ host });

    expect(result.protocol_version).toBe(AGENT_CONTINUITY_PROTOCOL_VERSION);
    expect(result.operations_by_name.start.mode).toBe("native_hook");
    expect(result.operations_by_name.checkpoint.mode).toBe("native_hook");
    expect(result.operations_by_name.recover.mode).toBe("native_hook");
    expect(result.conformance.conformant).toBe(true);
    expect(result.receipt).toMatchObject({ content_included: false });
    expect(result.receipt.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("falls back from Codex session-end operations to MCP", () => {
    const result = negotiateAgentContinuity({ host: "codex", operations: ["finish", "handoff"] });

    expect(result.operations_by_name.finish).toMatchObject({
      mode: "mcp",
      tool: "agent_finish",
      reason: "native_hook_not_supported"
    });
    expect(result.operations_by_name.handoff).toMatchObject({ mode: "mcp", tool: "agent_finish" });
  });

  it("supports OpenCode through the same MCP contract without inventing native hooks", () => {
    const result = negotiateAgentContinuity({ host: "open-code" });

    expect(result.host).toBe("opencode");
    expect(result.descriptor.hooks.transport).toBe("none");
    expect(result.descriptor.mcp.supported).toBe(true);
    expect(Object.values(result.operations_by_name).every((route) => route.mode === "mcp")).toBe(true);
  });

  it("degrades explicitly to CLI or unavailable routes", () => {
    const cli = negotiateAgentContinuity({
      host: "opencode",
      operations: ["checkpoint"],
      available_transports: { native_hook: false, mcp: false, cli: true }
    });
    expect(cli.operations_by_name.checkpoint).toMatchObject({ mode: "cli", reason: "mcp_not_available" });

    const unavailable = negotiateAgentContinuity({
      host: "shell",
      operations: ["recover"],
      available_transports: { native_hook: false, mcp: false, cli: false }
    });
    expect(unavailable.operations_by_name.recover).toMatchObject({
      mode: "unavailable",
      reason: "no_declared_transport"
    });
    expect(unavailable.conformance).toEqual({ conformant: false, unavailable_operations: ["recover"] });
  });

  it("builds a content-free cross-client resume plan for one workspace", () => {
    const plan = buildAgentContinuityTransferPlan({
      project_id: "moryn",
      source_host: "codex",
      target_host: "opencode",
      source_transports: { native_hook: false, mcp: true, cli: true },
      target_transports: { native_hook: false, mcp: true, cli: true }
    });

    expect(plan.ready).toBe(true);
    expect(plan.source.host).toBe("codex");
    expect(plan.target.host).toBe("opencode");
    expect(plan.sequence.map((step) => [step.operation, step.route.mode])).toEqual([
      ["checkpoint", "mcp"],
      ["handoff", "mcp"],
      ["enter", "mcp"],
      ["recover", "mcp"]
    ]);
    expect(plan.workspace.identity_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.receipt).toMatchObject({ content_included: false });
    expect(JSON.stringify(plan.receipt)).not.toContain("moryn");
  });

  it("produces deterministic receipts for identical capability evidence", () => {
    const first = negotiateAgentContinuity({ host: "opencode", operations: ["enter", "handoff"] });
    const second = negotiateAgentContinuity({ host: "opencode", operations: ["enter", "handoff"] });

    expect(second.receipt).toEqual(first.receipt);
  });
});
