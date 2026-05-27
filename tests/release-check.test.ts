import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertSafePackageFiles } from "../scripts/release-check.js";

const exec = promisify(execFile);

describe("release check", () => {
  it("rejects private Memora store files from package contents", () => {
    expect(() => assertSafePackageFiles([
      "package/README.md",
      "package/.memora/config.json"
    ])).toThrow(/private Memora store data/);

    expect(() => assertSafePackageFiles([
      "package/dist/cli.js",
      "package/docs/memora-design.md",
      "package/assets/memora-hero.png"
    ])).not.toThrow();
  });

  it("runs the local release gate and skips external Git validation without a remote", async () => {
    const result = await exec("node", ["--import", "tsx", "scripts/release-check.ts"], {
      env: {
        ...process.env,
        MEMORA_SKIP_SLOW_CHECKS: "1",
        MEMORA_PRIVATE_GIT_REMOTE: ""
      }
    });

    expect(result.stdout).toContain("private Git remote validation skipped");
    expect(result.stdout).toContain("release check passed");
  });
});
