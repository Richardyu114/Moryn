import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("dogfood demo smoke script", () => {
  it("is exposed as an npm script and proves the v0.2 dashboard review path", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { bin?: Record<string, string>; scripts?: Record<string, string> };

    expect(pkg.bin?.["moryn-dogfood-demo"]).toBe("scripts/dogfood-demo-smoke.js");
    expect(pkg.scripts?.["smoke:dogfood-demo"]).toBe("node scripts/dogfood-demo-smoke.js");

    const result = await exec("node", ["scripts/dogfood-demo-smoke.js"], { cwd: process.cwd() });

    expect(result.stdout).toContain("dogfood demo smoke passed");
    expect(result.stdout).toContain("setup applied");
    expect(result.stdout).toContain("context pack ready");
    expect(result.stdout).toContain("low-risk handoff auto-captured");
    expect(result.stdout).toContain("review handoff routed to Capture Inbox");
    expect(result.stdout).toContain("dashboard snapshot generated");
  }, 60000);
});
