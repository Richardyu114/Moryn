import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("official host handoff smoke script", () => {
  it("is exposed as a packaged npm smoke", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.scripts?.["smoke:official-host-handoff"]).toBe("node scripts/official-host-handoff-smoke.js");
  });

  it("executes the generated Codex and Claude cross-device journey", async () => {
    const result = await exec("node", ["scripts/official-host-handoff-smoke.js"], { cwd: process.cwd() });
    const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    expect(evidence).toMatchObject({
      codex_generated_session_start: true,
      codex_generated_prompt_gap: true,
      codex_generated_precompact: true,
      codex_checkpoint_explicitly_pushed: true,
      claude_generated_session_start: true,
      claude_compact_session_start: true,
      claude_postcompact_not_registered: true,
      claude_legacy_postcompact_silent: true,
      claude_checkpoint_explicitly_pulled: true,
      claude_generated_session_end: true,
      claude_handoff_explicitly_pushed: true,
      second_codex_generated_session_start: true,
      second_codex_handoff_explicitly_pulled: true,
      checkpoint_restored: true,
      handoff_visible_on_second_device: true,
      sync_transitions_recorded: true,
      bounded_context: true,
      private_transcript_content_absent: true
    });
  }, 120_000);
});
