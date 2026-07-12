import { describe, expect, it, vi } from "vitest";
import { releaseGateSteps, runReleaseGate } from "../scripts/release-check.js";

describe("v0.3 release gate", () => {
  it("defines one ordered gate containing tests, both smokes, package validation, and optional remote validation", () => {
    expect(releaseGateSteps(false, true).map((step) => step.id)).toEqual(["build", "typecheck", "tests", "dogfood_smoke", "lifecycle_smoke", "package", "private_remote"]);
    expect(releaseGateSteps(true, false).map((step) => [step.id, step.mode])).toEqual([
      ["build", "skipped"], ["typecheck", "skipped"], ["tests", "skipped"], ["dogfood_smoke", "required"], ["lifecycle_smoke", "required"], ["package", "required"], ["private_remote", "optional_skipped"]
    ]);
  });

  it("emits machine-readable evidence only after every required step succeeds", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await runReleaseGate({ skip_slow_checks: true, private_remote: undefined, run_command: async (command, args) => { calls.push([command, ...args].join(" ")); return command === "npm" && args[0] === "pack" ? JSON.stringify([{ files: [{ path: "package.json" }, { path: "LICENSE" }, { path: "README.md" }, { path: "CHANGELOG.md" }, { path: "docs/agent-install-prompt.md" }, { path: "docs/agent-workflow.md" }, { path: "docs/contracts.md" }, { path: "docs/development.md" }, { path: "docs/implementation-roadmap.md" }, { path: "docs/moryn-design.md" }, { path: "dist/cli.js" }, { path: "dist/index.js" }, { path: "dist/mcp/server.js" }, { path: "scripts/agent-lifecycle-smoke.js" }, { path: "scripts/dogfood-demo-smoke.js" }] }]) : "ok"; }, log: (line) => logs.push(line) });
    expect(calls).toEqual(["npm run smoke:dogfood-demo", "npm run smoke:agent-lifecycle", "npm pack --dry-run --json"]);
    expect(result).toMatchObject({ version: 1, status: "passed", completed: ["dogfood_smoke", "lifecycle_smoke", "package"], skipped: ["build", "typecheck", "tests", "private_remote"] });
    expect(JSON.parse(logs.at(-1)!)).toEqual(result);
  });

  it("stops on the first failed required step without success evidence", async () => {
    const logs: string[] = [];
    const run = vi.fn(async (_command: string, args: string[]) => { if (args.includes("smoke:agent-lifecycle")) throw new Error("lifecycle failed"); return "ok"; });
    await expect(runReleaseGate({ skip_slow_checks: true, run_command: run, log: (line) => logs.push(line) })).rejects.toThrow("lifecycle failed");
    expect(logs.some((line) => line.includes('"status":"passed"'))).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
