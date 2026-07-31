import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { releaseGateSteps, runReleaseGate, v04AcceptanceMatrix } from "../scripts/release-check.js";

describe("v0.4 release gate", () => {
  it("defines one ordered gate containing tests, both smokes, package validation, and optional remote validation", () => {
    expect(releaseGateSteps(false, true).map((step) => step.id)).toEqual([
      "build",
      "typecheck",
      "lint",
      "tests",
      "release_readiness",
      "dogfood_smoke",
      "lifecycle_smoke",
      "learning_inbox_smoke",
      "finalization_assurance_smoke",
      "host_runtime_binding_smoke",
      "transcript_compact_safety_smoke",
      "official_host_handoff_smoke",
      "upgrade_compat_smoke",
      "sync_resilience_smoke",
      "sync_conflict_smoke",
      "permission_recovery_smoke",
      "large_store_smoke",
      "v04_acceptance",
      "package",
      "private_remote"
    ]);
    expect(releaseGateSteps(true, false).map((step) => [step.id, step.mode])).toEqual([
      ["build", "skipped"],
      ["typecheck", "skipped"],
      ["lint", "skipped"],
      ["tests", "skipped"],
      ["release_readiness", "required"],
      ["dogfood_smoke", "skipped"],
      ["lifecycle_smoke", "skipped"],
      ["learning_inbox_smoke", "skipped"],
      ["finalization_assurance_smoke", "skipped"],
      ["host_runtime_binding_smoke", "skipped"],
      ["transcript_compact_safety_smoke", "skipped"],
      ["official_host_handoff_smoke", "skipped"],
      ["upgrade_compat_smoke", "skipped"],
      ["sync_resilience_smoke", "skipped"],
      ["sync_conflict_smoke", "skipped"],
      ["permission_recovery_smoke", "skipped"],
      ["large_store_smoke", "skipped"],
      ["v04_acceptance", "skipped"],
      ["package", "required"],
      ["private_remote", "skipped"]
    ]);
  });

  it("runs the full gate in CI and builds clean-checkout artifacts before readiness and packaging", () => {
    const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "release-check.yml"), "utf8");
    expect(workflow).toContain("run: npm run release:check");
    expect(workflow).not.toContain("MORYN_SKIP_SLOW_CHECKS");

    const requiredSteps = releaseGateSteps(false, false)
      .filter((step) => step.mode === "required")
      .map((step) => step.id);
    expect(requiredSteps.indexOf("build")).toBeLessThan(requiredSteps.indexOf("release_readiness"));
    expect(requiredSteps.indexOf("build")).toBeLessThan(requiredSteps.indexOf("package"));
  });

  it("pins the focused v0.4 acceptance evidence to the required transaction and portability fixtures", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const acceptanceCommand = packageJson.scripts?.["test:v04-acceptance"];
    expect(acceptanceCommand).toBeDefined();
    expect(acceptanceCommand).toMatch(/^npm run build && vitest run /);
    expect(acceptanceCommand?.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "tests/core/v04-compaction-quality-gate.test.ts",
        "tests/core/state-lease.test.ts",
        "tests/core/session-fold-transaction.test.ts",
        "tests/core/episode-rollup-transaction.test.ts",
        "tests/core/automatic-episode-rollup.test.ts",
        "tests/core/memory-compaction.test.ts",
        "tests/core/memory-expansion.test.ts",
        "tests/core/session-fold-conflict-projection.test.ts",
        "tests/core/structured-semantic-merge.test.ts",
        "tests/core/semantic-consolidation-engine.test.ts",
        "tests/core/automatic-semantic-maintenance.test.ts",
        "tests/core/memory-feedback.test.ts",
        "tests/core/project-alias-attestation.test.ts",
        "tests/e2e/historical-recovery-upgrade.test.ts",
        "tests/e2e/soul-git-portability.test.ts",
        "tests/e2e/soul-git-sync-receipts.test.ts",
        "tests/e2e/compaction-git-concurrency.test.ts",
        "tests/mcp/historical-recall.test.ts",
        "tests/mcp/memory-feedback.test.ts",
        "tests/sync/git-state-lease.test.ts"
      ])
    );
  });

  it("emits machine-readable evidence only after every required step succeeds", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const result = await runReleaseGate({
      skip_slow_checks: true,
      private_remote: undefined,
      run_command: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return command === "npm" && args[0] === "pack"
          ? JSON.stringify([
              {
                files: [
                  { path: "package.json" },
                  { path: "LICENSE" },
                  { path: "README.md" },
                  { path: "CHANGELOG.md" },
                  { path: "docs/agent-install-prompt.md" },
                  { path: "docs/agent-workflow.md" },
                  { path: "docs/contracts.md" },
                  { path: "docs/dashboard.md" },
                  { path: "docs/development.md" },
                  { path: "docs/implementation-roadmap.md" },
                  { path: "docs/moryn-design.md" },
                  { path: "docs/v0.4-migration.md" },
                  { path: "dist/cli.js" },
                  { path: "dist/index.js" },
                  { path: "dist/mcp/server.js" },
                  { path: "scripts/agent-lifecycle-smoke.js" },
                  { path: "scripts/host-runtime-binding-smoke.js" },
                  { path: "scripts/transcript-compact-safety-smoke.js" },
                  { path: "scripts/official-host-handoff-smoke.js" },
                  { path: "scripts/learning-inbox-smoke.js" },
                  { path: "scripts/finalization-assurance-smoke.js" },
                  { path: "scripts/dogfood-demo-smoke.js" },
                  { path: "scripts/upgrade-compat-smoke.js" },
                  { path: "scripts/sync-resilience-smoke.js" },
                  { path: "scripts/sync-conflict-smoke.js" },
                  { path: "scripts/permission-recovery-smoke.js" },
                  { path: "scripts/large-store-smoke.js" }
                ]
              }
            ])
          : "ok";
      },
      log: (line) => logs.push(line)
    });
    expect(calls).toEqual(["npm run release:readiness", "npm pack --dry-run --json"]);
    expect(result).toMatchObject({
      version: 1,
      status: "passed",
      completed: ["release_readiness", "package"],
      skipped: [
        "build",
        "typecheck",
        "lint",
        "tests",
        "dogfood_smoke",
        "lifecycle_smoke",
        "learning_inbox_smoke",
        "finalization_assurance_smoke",
        "host_runtime_binding_smoke",
        "transcript_compact_safety_smoke",
        "official_host_handoff_smoke",
        "upgrade_compat_smoke",
        "sync_resilience_smoke",
        "sync_conflict_smoke",
        "permission_recovery_smoke",
        "large_store_smoke",
        "v04_acceptance",
        "private_remote"
      ],
      acceptance_complete: false
    });
    expect(Object.values(result.acceptance).every((area) => area.status === "not_verified")).toBe(true);
    expect(JSON.parse(logs.at(-1)!)).toEqual(result);
  });

  it("does not expose a configured private remote to tests or lifecycle smoke", async () => {
    const testEnvironments: NodeJS.ProcessEnv[] = [];
    const lifecycleEnvironments: NodeJS.ProcessEnv[] = [];
    vi.stubEnv("MORYN_PRIVATE_GIT_REMOTE", "https://example.invalid/private-store.git");
    try {
      await runReleaseGate({
        private_remote: "https://example.invalid/private-store.git",
        run_command: async (command, args, options) => {
          if (command === "npm" && args[0] === "test") testEnvironments.push(options?.env ?? {});
          if (command === "npm" && args.includes("smoke:agent-lifecycle")) {
            lifecycleEnvironments.push(options?.env ?? {});
          }
          if (command === "npm" && args[0] === "pack") {
            throw new Error("stop after test environment capture");
          }
          return "ok";
        },
        log: () => undefined
      }).catch((error: unknown) => {
        if (!(error instanceof Error && error.message === "stop after test environment capture")) throw error;
      });

      expect(testEnvironments).toHaveLength(1);
      expect(testEnvironments[0]?.MORYN_AGENT_LIFECYCLE_REMOTE).toBeUndefined();
      expect(testEnvironments[0]?.MORYN_PRIVATE_GIT_REMOTE).toBeUndefined();
      expect(lifecycleEnvironments).toHaveLength(1);
      expect(lifecycleEnvironments[0]?.MORYN_PRIVATE_GIT_REMOTE).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("maps a full release run to all eleven v0.4 acceptance areas", () => {
    const completed = releaseGateSteps(false, false)
      .filter((step) => step.mode === "required")
      .map((step) => step.id);
    const acceptance = v04AcceptanceMatrix(completed);
    expect(Object.keys(acceptance)).toEqual([
      "autopilot",
      "sync",
      "working_set",
      "consolidation",
      "memory_distillation",
      "portable_soul",
      "learning",
      "hosts",
      "dashboard",
      "audit",
      "reliability"
    ]);
    expect(
      Object.values(acceptance).every((area) => area.status === "passed" && area.missing_evidence.length === 0)
    ).toBe(true);
    expect(acceptance.learning.required_evidence).toEqual(
      expect.arrayContaining(["learning_inbox_smoke", "finalization_assurance_smoke"])
    );
    expect(acceptance.dashboard.required_evidence).toEqual(expect.arrayContaining(["tests", "large_store_smoke"]));
    expect(acceptance.memory_distillation.required_evidence).toEqual(
      expect.arrayContaining(["tests", "lifecycle_smoke", "large_store_smoke", "v04_acceptance"])
    );
    expect(acceptance.portable_soul.required_evidence).toEqual(
      expect.arrayContaining(["tests", "host_runtime_binding_smoke", "official_host_handoff_smoke", "v04_acceptance"])
    );
    expect(acceptance.autopilot.required_evidence).toContain("official_host_handoff_smoke");
    expect(acceptance.sync.required_evidence).toContain("official_host_handoff_smoke");
    expect(acceptance.hosts.required_evidence).toEqual(
      expect.arrayContaining([
        "tests",
        "lifecycle_smoke",
        "host_runtime_binding_smoke",
        "transcript_compact_safety_smoke",
        "official_host_handoff_smoke"
      ])
    );
    expect(acceptance.reliability.required_evidence).toEqual(
      expect.arrayContaining(["official_host_handoff_smoke", "v04_acceptance"])
    );
  });

  it("stops on the first failed required step without success evidence", async () => {
    const logs: string[] = [];
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("smoke:agent-lifecycle")) throw new Error("lifecycle failed");
      return "ok";
    });
    await expect(runReleaseGate({ run_command: run, log: (line) => logs.push(line) })).rejects.toThrow(
      "lifecycle failed"
    );
    expect(logs.some((line) => line.includes('"status":"passed"'))).toBe(false);
    expect(run).toHaveBeenCalledTimes(7);
  });
});
