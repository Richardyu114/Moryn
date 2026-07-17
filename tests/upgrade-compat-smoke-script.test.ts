import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("upgrade compatibility smoke script", () => {
  it("is exposed as an npm script and upgrades a frozen v0.2 store in place", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.bin?.["moryn-upgrade-smoke"]).toBe("scripts/upgrade-compat-smoke.js");
    expect(pkg.scripts?.["smoke:upgrade-compat"]).toBe("node scripts/upgrade-compat-smoke.js");

    const result = await exec("node", ["scripts/upgrade-compat-smoke.js"], { cwd: process.cwd() });

    expect(result.stdout).toContain("upgrade compatibility smoke passed");
    expect(result.stdout).toContain('"legacy_event_preserved":true');
    expect(result.stdout).toContain('"legacy_fact_recalled":true');
    expect(result.stdout).toContain('"read_model_repaired":true');
    expect(result.stdout).toContain('"retrieval_index_repaired":true');
    expect(result.stdout).toContain('"checkpoint_created":true');
    expect(result.stdout).toContain('"learning_reused_by_claude":true');
    expect(result.stdout).toContain('"migration_required":false');
    expect(await exists(".claude")).toBe(false);
  }, 60_000);
});
