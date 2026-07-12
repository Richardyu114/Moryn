import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const exec = promisify(execFile);
describe("sync conflict smoke script", () => {
  it("blocks lifecycle writes during a real Git conflict", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.bin?.["moryn-conflict-smoke"]).toBe("scripts/sync-conflict-smoke.js");
    expect(pkg.scripts?.["smoke:sync-conflict"]).toBe("node scripts/sync-conflict-smoke.js");
    const result = await exec("node", ["scripts/sync-conflict-smoke.js"], { cwd: process.cwd() });
    expect(result.stdout).toContain("sync conflict smoke passed");
    expect(result.stdout).toContain('"conflict_detected":true');
    expect(result.stdout).toContain('"safe_to_retry_sync":false');
    expect(result.stdout).toContain('"lifecycle_write_blocked":true');
    expect(result.stdout).toContain('"event_count_unchanged":true');
    expect(result.stdout).toContain('"manual_resolution_required":true');
  }, 60_000);
});
