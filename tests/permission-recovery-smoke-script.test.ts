import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
const exec = promisify(execFile);
describe("permission recovery smoke script", () => {
  it("preserves local continuity and resumes after credentials are repaired", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.bin?.["moryn-permission-smoke"]).toBe("scripts/permission-recovery-smoke.js");
    expect(pkg.scripts?.["smoke:permission-recovery"]).toBe("node scripts/permission-recovery-smoke.js");
    const result = await exec("node", ["scripts/permission-recovery-smoke.js"], { cwd: process.cwd() });
    expect(result.stdout).toContain("permission recovery smoke passed");
    expect(result.stdout).toContain('"permission_denied_classified":true');
    expect(result.stdout).toContain('"local_handoff_preserved":true');
    expect(result.stdout).toContain('"credential_guardrails_present":true');
    expect(result.stdout).toContain('"repair_then_compensated":true');
    expect(result.stdout).toContain('"second_device_recalled_handoff":true');
    expect(result.stdout).toContain('"credentials_absent_from_events":true');
  }, 60_000);
});
