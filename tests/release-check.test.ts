import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertPackageFilesComplete, assertSafePackageFiles } from "../scripts/release-check.js";

const exec = promisify(execFile);
const sourceVersion = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string })
  .version;
const isPrerelease = sourceVersion.includes("-");

describe("release check", () => {
  it("rejects private Moryn store files from package contents", () => {
    expect(() => assertSafePackageFiles(["package/README.md", "package/.moryn/config.json"])).toThrow(
      /private Moryn store data/
    );

    expect(() => assertSafePackageFiles(["package/.moryn.json"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/.gemini/settings.json"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/.codex/session.json"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/.superpowers/notes.md"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/state/dashboard/index.html"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/temp/release-notes.md"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/docs/superpowers/plans/internal-plan.md"])).toThrow(
      /private Moryn store data/
    );

    expect(() => assertSafePackageFiles(["package/docs/v0.2-phase-plan.md"])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles(["package/docs/releases/v0.3-roadmap.md"])).toThrow(/private Moryn store data/);

    expect(() =>
      assertSafePackageFiles(["package/dist/cli.js", "package/docs/moryn-design.md", "package/assets/moryn-hero.png"])
    ).not.toThrow();
  });

  it("requires essential package files for the published CLI and API", () => {
    const completePackageFiles = [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/CHANGELOG.md",
      "package/docs/agent-install-prompt.md",
      "package/docs/agent-workflow.md",
      "package/docs/contracts.md",
      "package/docs/dashboard.md",
      "package/docs/development.md",
      "package/docs/implementation-roadmap.md",
      "package/docs/moryn-design.md",
      "package/docs/v0.4-migration.md",
      "package/dist/cli.js",
      "package/dist/index.js",
      "package/dist/mcp/server.js",
      "package/scripts/agent-lifecycle-smoke.js",
      "package/scripts/host-runtime-binding-smoke.js",
      "package/scripts/transcript-compact-safety-smoke.js",
      "package/scripts/official-host-handoff-smoke.js",
      "package/scripts/learning-inbox-smoke.js",
      "package/scripts/finalization-assurance-smoke.js",
      "package/scripts/dogfood-demo-smoke.js",
      "package/scripts/upgrade-compat-smoke.js",
      "package/scripts/sync-resilience-smoke.js",
      "package/scripts/sync-conflict-smoke.js",
      "package/scripts/permission-recovery-smoke.js",
      "package/scripts/large-store-smoke.js"
    ];
    expect(() => assertPackageFilesComplete(completePackageFiles)).not.toThrow();
    expect(() =>
      assertPackageFilesComplete(completePackageFiles.filter((file) => file !== "package/docs/dashboard.md"))
    ).toThrow(/missing required package files: .*docs\/dashboard\.md/);
    expect(() =>
      assertPackageFilesComplete(completePackageFiles.filter((file) => file !== "package/docs/v0.4-migration.md"))
    ).toThrow(/missing required package files: .*docs\/v0\.4-migration\.md/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/docs/v0.4-migration.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/host-runtime-binding-smoke.js",
        "package/scripts/transcript-compact-safety-smoke.js",
        "package/scripts/official-host-handoff-smoke.js",
        "package/scripts/finalization-assurance-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js",
        "package/scripts/large-store-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/learning-inbox-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/docs/v0.4-migration.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/host-runtime-binding-smoke.js",
        "package/scripts/transcript-compact-safety-smoke.js",
        "package/scripts/official-host-handoff-smoke.js",
        "package/scripts/learning-inbox-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js",
        "package/scripts/large-store-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/finalization-assurance-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/host-runtime-binding-smoke.js",
        "package/scripts/transcript-compact-safety-smoke.js",
        "package/scripts/official-host-handoff-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js"
      ])
    ).toThrow(/missing required package files: .*dist\/cli\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/agent-lifecycle-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/host-runtime-binding-smoke.js",
        "package/scripts/transcript-compact-safety-smoke.js",
        "package/scripts/official-host-handoff-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js"
      ])
    ).toThrow(/missing required package files: docs\/moryn-design\.md/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/host-runtime-binding-smoke.js",
        "package/scripts/transcript-compact-safety-smoke.js",
        "package/scripts/official-host-handoff-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js"
      ])
    ).toThrow(/missing required package files: docs\/agent-install-prompt\.md/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/dogfood-demo-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/host-runtime-binding-smoke.js",
        "package/scripts/transcript-compact-safety-smoke.js",
        "package/scripts/official-host-handoff-smoke.js",
        "package/scripts/dogfood-demo-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/upgrade-compat-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/sync-resilience-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/sync-conflict-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/permission-recovery-smoke\.js/);

    expect(() =>
      assertPackageFilesComplete([
        "package/package.json",
        "package/LICENSE",
        "package/README.md",
        "package/CHANGELOG.md",
        "package/docs/agent-install-prompt.md",
        "package/docs/agent-workflow.md",
        "package/docs/contracts.md",
        "package/docs/dashboard.md",
        "package/docs/development.md",
        "package/docs/implementation-roadmap.md",
        "package/docs/moryn-design.md",
        "package/dist/cli.js",
        "package/dist/index.js",
        "package/dist/mcp/server.js",
        "package/scripts/agent-lifecycle-smoke.js",
        "package/scripts/dogfood-demo-smoke.js",
        "package/scripts/upgrade-compat-smoke.js",
        "package/scripts/sync-resilience-smoke.js",
        "package/scripts/sync-conflict-smoke.js",
        "package/scripts/permission-recovery-smoke.js"
      ])
    ).toThrow(/missing required package files: .*scripts\/large-store-smoke\.js/);
  });

  it.skipIf(isPrerelease)(
    "runs the local release gate and skips external Git validation without a remote",
    async () => {
      const result = await exec("node", ["--import", "tsx", "scripts/release-check.ts"], {
        env: {
          ...process.env,
          MORYN_SKIP_SLOW_CHECKS: "1",
          MORYN_PRIVATE_GIT_REMOTE: ""
        }
      });

      expect(result.stdout).toContain("private Git remote validation skipped");
      expect(result.stdout).toContain("$ npm run release:readiness");
      expect(result.stdout).toContain("$ npm pack --dry-run --json");
      expect(result.stdout).not.toContain("$ npm run smoke:");
      expect(result.stdout).toContain('"status":"passed"');
    },
    180_000
  );

  it.skipIf(isPrerelease)(
    "runs from a checkout path containing spaces",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "moryn release check "));
      const script = join(root, "release check with spaces.ts");
      try {
        await copyFile(join(process.cwd(), "scripts", "release-check.ts"), script);
        const result = await exec("node", ["--import", "tsx", script], {
          env: {
            ...process.env,
            MORYN_SKIP_SLOW_CHECKS: "1",
            MORYN_PRIVATE_GIT_REMOTE: ""
          }
        });

        expect(result.stdout).toContain('"completed":["release_readiness","package"]');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000
  );
});
