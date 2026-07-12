import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("agent lifecycle smoke script", () => {
  it("is exposed as an npm script and validates two agent stores over Git sync", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { bin?: Record<string, string>; scripts?: Record<string, string> };

    expect(pkg.bin?.["moryn-agent-smoke"]).toBe("scripts/agent-lifecycle-smoke.js");
    expect(pkg.scripts?.["smoke:agent-lifecycle"]).toBe("node scripts/agent-lifecycle-smoke.js");

    const result = await exec("node", ["scripts/agent-lifecycle-smoke.js"], { cwd: process.cwd() });

    expect(result.stdout).toContain("agent lifecycle smoke passed");
    expect(result.stdout).toContain("Codex smoke status reached Gemini");
    expect(result.stdout).toContain("Task: verify checkpoint lifecycle smoke");
    expect(result.stdout).toContain("Next: Run the rollback integration smoke");
    expect(result.stdout).toContain('"checkpoint_record_id":"rec_checkpoint_');
    expect(result.stdout).toContain('"checkpoint_idempotent_replay":true');
    expect(result.stdout).toContain('"semantic_links_created":1');
    expect(result.stdout).toContain('"protected_rejections":1');
    expect(result.stdout).toContain('"claude_activation_status":"configured_unverified"');
    expect(result.stdout).toContain('"claude_activation_receipt_created":true');
    expect(result.stdout).toContain('"codex_activation_status":"host_schema_unknown"');
    expect(result.stdout).toContain('"record_read_model_status":"fresh"');
    expect(result.stdout).toContain('"session_synthesis_mode":"evidence_synthesized"');
    expect(result.stdout).toContain('"abnormal_exit_compensation":"pushed"');
    expect(result.stdout).toContain('"acceptance":{"cross_host_handoff":true');
    expect(result.stdout).toContain('"abnormal_exit_recovery":true');
  }, 60000);
});
