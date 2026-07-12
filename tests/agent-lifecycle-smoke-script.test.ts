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
    expect(result.stdout).toContain("Task: verify repeated checkpoint lifecycle smoke");
    expect(result.stdout).toContain("Progress: Checkpoint smoke persisted with semantic consolidation.; Second checkpoint advanced rollback verification.");
    expect(result.stdout).toContain("Next: Verify rollback behavior in the release candidate");
    expect(result.stdout).toContain('"checkpoint_record_id":"rec_checkpoint_');
    expect(result.stdout).toContain('"checkpoint_idempotent_replay":true');
    expect(result.stdout).toContain('"semantic_links_created":1');
    expect(result.stdout).toContain('"protected_rejections":1');
    expect(result.stdout).toContain('"claude_activation_status":"configured_unverified"');
    expect(result.stdout).toContain('"claude_activation_receipt_created":true');
    expect(result.stdout).toContain('"codex_activation_status":"configured_unverified"');
    expect(result.stdout).toContain('"codex_enter_self_healed":true');
    expect(result.stdout).toContain('"record_read_model_status":"fresh"');
    expect(result.stdout).toContain('"session_synthesis_mode":"evidence_synthesized"');
    expect(result.stdout).toContain('"abnormal_exit_compensation":"pushed"');
    const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      cross_host_handoff?: {
        codex_status_pushed: boolean;
        claude_checkpoint_pulled: boolean;
        claude_handoff_pushed: boolean;
        second_codex_handoff_pulled: boolean;
        second_codex_handoff_visible: boolean;
      };
      checkpoint_compaction_recovery?: {
        checkpoint_created: boolean;
        idempotent_replay: boolean;
        second_checkpoint_created: boolean;
        second_checkpoint_pushed: boolean;
        recovery_pack_available: boolean;
        resume_action_ready: boolean;
        claude_checkpoint_restored: boolean;
        claude_checkpoint_count: number;
        claude_latest_checkpoint_restored: boolean;
        claude_latest_investigation_restored: boolean;
      };
      semantic_consolidation?: {
        proposals_accepted: number;
        links_created: number;
        protected_rejections: number;
      };
      recall_explore_learn?: {
        initial_prompt_status: string;
        initial_prompt_read_only: boolean;
        learning_records_created: number;
        unresolved_investigations_preserved: number;
        second_device_prompt_status: string;
        second_device_prompt_record_count: number;
        second_device_prompt_read_only: boolean;
        second_device_learning_restored: boolean;
        second_device_investigation_restored: boolean;
      };
      bounded_verified_reads?: {
        source: string;
        status: string;
        project_id: string;
      };
      abnormal_exit?: {
        compensation: string;
        recovery_pack_available: boolean;
        resume_action_ready: boolean;
        second_device_checkpoint_restored: boolean;
        second_device_investigation_restored: boolean;
        checkpoint_records_after_recovery: number;
      };
      acceptance?: Record<string, boolean>;
    };
    expect(evidence.cross_host_handoff).toEqual({
      codex_status_pushed: true,
      claude_checkpoint_pulled: true,
      claude_handoff_pushed: true,
      second_codex_handoff_pulled: true,
      second_codex_handoff_visible: true
    });
    expect(evidence.checkpoint_compaction_recovery).toEqual({
      checkpoint_created: true,
      idempotent_replay: true,
      second_checkpoint_created: true,
      second_checkpoint_pushed: true,
      recovery_pack_available: true,
      resume_action_ready: true,
      claude_checkpoint_restored: true,
      claude_checkpoint_count: 2,
      claude_latest_checkpoint_restored: true,
      claude_latest_investigation_restored: true
    });
    expect(evidence.semantic_consolidation).toEqual({
      proposals_accepted: 1,
      links_created: 1,
      protected_rejections: 1
    });
    expect(evidence.recall_explore_learn).toEqual({
      initial_prompt_status: "knowledge_gap",
      initial_prompt_read_only: true,
      learning_records_created: 3,
      unresolved_investigations_preserved: 1,
      second_device_prompt_status: "trusted_match",
      second_device_prompt_record_count: 1,
      second_device_prompt_read_only: true,
      second_device_learning_restored: true,
      second_device_investigation_restored: true
    });
    expect(evidence.bounded_verified_reads).toEqual({
      source: "read_model",
      status: "fresh",
      project_id: "moryn-smoke"
    });
    expect(evidence.abnormal_exit).toEqual({
      compensation: "pushed",
      recovery_pack_available: true,
      resume_action_ready: true,
      second_device_checkpoint_restored: true,
      second_device_investigation_restored: true,
      checkpoint_records_after_recovery: 1
    });
    expect(evidence.acceptance).toEqual({
      cross_host_handoff: true,
      checkpoint_compaction_recovery: true,
      semantic_consolidation: true,
      recall_explore_learn: true,
      bounded_verified_reads: true,
      abnormal_exit_recovery: true
    });
  }, 60000);
});
