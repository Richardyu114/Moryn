import { describe, expect, it, vi } from "vitest";
import { releaseGateSteps, runReleaseGate, v03AcceptanceMatrix } from "../scripts/release-check.js";

describe("v0.3 release gate", () => {
  it("defines one ordered gate containing tests, both smokes, package validation, and optional remote validation", () => {
    expect(releaseGateSteps(false, true).map((step) => step.id)).toEqual(["build", "typecheck", "tests", "dogfood_smoke", "lifecycle_smoke", "host_runtime_binding_smoke", "transcript_compact_safety_smoke", "official_host_handoff_smoke", "upgrade_compat_smoke", "sync_resilience_smoke", "sync_conflict_smoke", "permission_recovery_smoke", "large_store_smoke", "package", "private_remote"]);
    expect(releaseGateSteps(true, false).map((step) => [step.id, step.mode])).toEqual([
      ["build", "skipped"], ["typecheck", "skipped"], ["tests", "skipped"], ["dogfood_smoke", "required"], ["lifecycle_smoke", "required"], ["host_runtime_binding_smoke", "required"], ["transcript_compact_safety_smoke", "required"], ["official_host_handoff_smoke", "required"], ["upgrade_compat_smoke", "required"], ["sync_resilience_smoke", "required"], ["sync_conflict_smoke", "required"], ["permission_recovery_smoke", "required"], ["large_store_smoke", "required"], ["package", "required"], ["private_remote", "optional_skipped"]
    ]);
  });

  it("emits machine-readable evidence only after every required step succeeds", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await runReleaseGate({ skip_slow_checks: true, private_remote: undefined, run_command: async (command, args) => { calls.push([command, ...args].join(" ")); return command === "npm" && args[0] === "pack" ? JSON.stringify([{ files: [{ path: "package.json" }, { path: "LICENSE" }, { path: "README.md" }, { path: "CHANGELOG.md" }, { path: "docs/agent-install-prompt.md" }, { path: "docs/agent-workflow.md" }, { path: "docs/contracts.md" }, { path: "docs/development.md" }, { path: "docs/implementation-roadmap.md" }, { path: "docs/moryn-design.md" }, { path: "dist/cli.js" }, { path: "dist/index.js" }, { path: "dist/mcp/server.js" }, { path: "scripts/agent-lifecycle-smoke.js" }, { path: "scripts/host-runtime-binding-smoke.js" }, { path: "scripts/transcript-compact-safety-smoke.js" }, { path: "scripts/official-host-handoff-smoke.js" }, { path: "scripts/dogfood-demo-smoke.js" }, { path: "scripts/upgrade-compat-smoke.js" }, { path: "scripts/sync-resilience-smoke.js" }, { path: "scripts/sync-conflict-smoke.js" }, { path: "scripts/permission-recovery-smoke.js" }, { path: "scripts/large-store-smoke.js" }] }]) : "ok"; }, log: (line) => logs.push(line) });
    expect(calls).toEqual(["npm run smoke:dogfood-demo", "npm run smoke:agent-lifecycle", "npm run smoke:host-runtime-binding", "npm run smoke:transcript-compact-safety", "npm run smoke:official-host-handoff", "npm run smoke:upgrade-compat", "npm run smoke:sync-resilience", "npm run smoke:sync-conflict", "npm run smoke:permission-recovery", "npm run smoke:large-store", "npm pack --dry-run --json"]);
    expect(result).toMatchObject({ version: 1, status: "passed", completed: ["dogfood_smoke", "lifecycle_smoke", "host_runtime_binding_smoke", "transcript_compact_safety_smoke", "official_host_handoff_smoke", "upgrade_compat_smoke", "sync_resilience_smoke", "sync_conflict_smoke", "permission_recovery_smoke", "large_store_smoke", "package"], skipped: ["build", "typecheck", "tests", "private_remote"], acceptance_complete: false });
    expect(Object.values(result.acceptance).every((area) => area.status === "not_verified")).toBe(true);
    expect(JSON.parse(logs.at(-1)!)).toEqual(result);
  });

  it("maps a full release run to all nine v0.3 acceptance areas", () => {
    const completed = releaseGateSteps(false, false).filter((step) => step.mode === "required").map((step) => step.id);
    const acceptance = v03AcceptanceMatrix(completed);
    expect(Object.keys(acceptance)).toEqual(["autopilot", "sync", "working_set", "consolidation", "learning", "hosts", "dashboard", "audit", "reliability"]);
    expect(Object.values(acceptance).every((area) => area.status === "passed" && area.missing_evidence.length === 0)).toBe(true);
    expect(acceptance.dashboard.required_evidence).toEqual(expect.arrayContaining(["tests", "large_store_smoke"]));
    expect(acceptance.autopilot.required_evidence).toContain("official_host_handoff_smoke");
    expect(acceptance.sync.required_evidence).toContain("official_host_handoff_smoke");
    expect(acceptance.hosts.required_evidence).toEqual(expect.arrayContaining(["tests", "lifecycle_smoke", "host_runtime_binding_smoke", "transcript_compact_safety_smoke", "official_host_handoff_smoke"]));
    expect(acceptance.reliability.required_evidence).toContain("official_host_handoff_smoke");
  });

  it("stops on the first failed required step without success evidence", async () => {
    const logs: string[] = [];
    const run = vi.fn(async (_command: string, args: string[]) => { if (args.includes("smoke:agent-lifecycle")) throw new Error("lifecycle failed"); return "ok"; });
    await expect(runReleaseGate({ skip_slow_checks: true, run_command: run, log: (line) => logs.push(line) })).rejects.toThrow("lifecycle failed");
    expect(logs.some((line) => line.includes('"status":"passed"'))).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
