import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertPackageFilesComplete, assertSafePackageFiles } from "../scripts/release-check.js";

const exec = promisify(execFile);

describe("release check", () => {
  it("rejects private Moryn store files from package contents", () => {
    expect(() => assertSafePackageFiles([
      "package/README.md",
      "package/.moryn/config.json"
    ])).toThrow(/private Moryn store data/);

    expect(() => assertSafePackageFiles([
      "package/dist/cli.js",
      "package/docs/moryn-design.md",
      "package/assets/moryn-hero.png"
    ])).not.toThrow();
  });

  it("requires essential package files for the published CLI and API", () => {
    expect(() => assertPackageFilesComplete([
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/cli.js",
      "package/dist/index.js",
      "package/dist/mcp/server.js",
      "package/scripts/agent-lifecycle-smoke.js"
    ])).not.toThrow();

    expect(() => assertPackageFilesComplete([
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/index.js",
      "package/dist/mcp/server.js"
    ])).toThrow(/missing required package files: dist\/cli\.js/);

    expect(() => assertPackageFilesComplete([
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/cli.js",
      "package/dist/index.js",
      "package/dist/mcp/server.js"
    ])).toThrow(/missing required package files: scripts\/agent-lifecycle-smoke\.js/);
  });

  it("runs the local release gate and skips external Git validation without a remote", async () => {
    const result = await exec("node", ["--import", "tsx", "scripts/release-check.ts"], {
      env: {
        ...process.env,
        MORYN_SKIP_SLOW_CHECKS: "1",
        MORYN_PRIVATE_GIT_REMOTE: ""
      }
    });

    expect(result.stdout).toContain("private Git remote validation skipped");
    expect(result.stdout).toContain("release check passed");
  });

  it("runs from a checkout path containing spaces", async () => {
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

      expect(result.stdout).toContain("release check passed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
