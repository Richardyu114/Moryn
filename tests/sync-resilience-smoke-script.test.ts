import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const exec = promisify(execFile);
describe("sync resilience smoke script", () => {
  it("retains a failed finish locally and compensates when the remote returns", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.bin?.["moryn-resilience-smoke"]).toBe("scripts/sync-resilience-smoke.js");
    expect(pkg.scripts?.["smoke:sync-resilience"]).toBe("node scripts/sync-resilience-smoke.js");
    const result = await exec("node", ["scripts/sync-resilience-smoke.js"], { cwd: process.cwd() });
    expect(result.stdout).toContain("sync resilience smoke passed");
    expect(result.stdout).toContain('"finish_local_recorded":true');
    expect(result.stdout).toContain('"push_failed_recoverably":true');
    expect(result.stdout).toContain('"local_store_ahead":true');
    expect(result.stdout).toContain('"enter_compensation_pushed":true');
    expect(result.stdout).toContain('"second_device_recalled_handoff":true');
  }, 60_000);
});
