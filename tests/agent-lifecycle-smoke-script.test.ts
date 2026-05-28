import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("agent lifecycle smoke script", () => {
  it("is exposed as an npm script and validates two agent stores over Git sync", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.["smoke:agent-lifecycle"]).toBe("node scripts/agent-lifecycle-smoke.js");

    const result = await exec("node", ["scripts/agent-lifecycle-smoke.js"], { cwd: process.cwd() });

    expect(result.stdout).toContain("agent lifecycle smoke passed");
    expect(result.stdout).toContain("Codex smoke status reached Gemini");
    expect(result.stdout).toContain("Gemini smoke finish reached Codex");
  }, 60000);
});
