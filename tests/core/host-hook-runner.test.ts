import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { createEngine } from "../../src/core/engine.js";
import { learningRecordIdentity } from "../../src/core/learning-ingestion.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";
import { SYNC_RESULT_SELECTION_SOURCES } from "../../src/sync/git.js";
import { initializeProjectConfig } from "../../src/core/project.js";

const base = {
  host: "codex" as const,
  session_id: "session-a",
  device_id: "device-a",
  cwd: "/repo",
  occurred_at: "2026-07-11T00:00:00.000Z"
};

const configuredSync = async () => true;

describe("host hook runner", () => {
  it("injects bounded trusted project knowledge for a submitted prompt", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const memory = await engine.write({
        kind: "memory",
        type: "release_policy",
        scope: "project",
        project_id: "moryn",
        content: { text: "Production rollback requires a tagged release and the rollback runbook." },
        state: "canonical",
        confirmed: true,
        confidence: 0.98,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "private_release_note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Production rollback secret token is private." },
        state: "canonical",
        confirmed: true,
        confidence: 0.99,
        tags: ["private"],
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "other_project",
        scope: "project",
        project_id: "other",
        content: { text: "Production rollback in other project uses a different process." },
        state: "canonical",
        confirmed: true,
        confidence: 0.99,
        source: { client: "user" }
      });

      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "user_prompt_submit", prompt: "Does production rollback require a tagged release and the rollback runbook?" },
        project_id: "moryn"
      });

      expect(result).toMatchObject({
        event: "user_prompt_submit",
        action: "recall_prompt",
        prompt_recall: {
          outcome: { status: "trusted_match", best_record_id: memory.record.id },
          injected: true,
          record_count: 1
        }
      });
      expect(result.hook_output.additional_context).toContain(memory.record.id);
      expect(result.hook_output.additional_context).toContain("tagged release");
      expect(result.hook_output.additional_context).not.toContain("secret token");
      expect(result.hook_output.additional_context).not.toContain("other project");
    });
  });

  it("guides prompt recall misses toward evidence-backed learning without writing", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const before = (await engine.listRecent({ project_id: "moryn", limit: 100 })).records.length;
      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "user_prompt_submit", prompt: "What is the unknown lunar deployment protocol?" },
        project_id: "moryn"
      });
      const after = (await engine.listRecent({ project_id: "moryn", limit: 100 })).records.length;

      expect(result).toMatchObject({
        action: "recall_prompt",
        prompt_recall: { outcome: { status: "knowledge_gap" }, injected: true, record_count: 0 }
      });
      expect(result.hook_output.additional_context).toContain("knowledge_gap");
      expect(result.hook_output.additional_context).toContain("Learning Delta");
      expect(result.hook_output.additional_context).toContain("checkpoint or finish");
      expect(after).toBe(before);
    });
  });

  it("guides weak matches without injecting unverified candidate content", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const candidate = await engine.write({
        kind: "memory",
        type: "candidate_policy",
        scope: "project",
        project_id: "moryn",
        content: { text: "Candidate lunar deployment protocol uses an unverified launch window." },
        state: "candidate",
        confidence: 0.6,
        source: { client: "agent" }
      });
      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "user_prompt_submit", prompt: "Does the candidate lunar deployment protocol use an unverified launch window?" },
        project_id: "moryn"
      });

      expect(result).toMatchObject({
        prompt_recall: {
          outcome: { status: "verification_required", best_record_id: candidate.record.id },
          injected: true,
          record_count: 0
        }
      });
      expect(result.hook_output.additional_context).toContain(candidate.record.id);
      expect(result.hook_output.additional_context).toContain("verification_required");
      expect(result.hook_output.additional_context).not.toContain("unverified launch window");
    });
  });

  it("does not create activation receipts for high-frequency prompt recall", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const before = (await engine.listRecent({ project_id: "moryn", limit: 100 })).records.length;
      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "user_prompt_submit", prompt: "What is the unknown lunar deployment protocol?" },
        project_id: "moryn",
        activation_id: "moryn-v03-moryn-codex"
      });
      const after = (await engine.listRecent({ project_id: "moryn", limit: 100 })).records.length;

      expect(result.activation_receipt).toBeUndefined();
      expect(result.activation_warning).toBeUndefined();
      expect(after).toBe(before);
    });
  });

  it("starts a session and returns host-injectable context", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({ storePath, hook: { ...base, event: "session_start", trigger: "startup" }, project_id: "moryn", current_task: "Implement hooks", pull: false });
      expect(result).toMatchObject({ ok: true, event: "session_start", action: "agent_start", degradation: { mode: "native" } });
      expect(result.hook_output.additional_context).toContain("Implement hooks");
    });
  });

  it("keeps automatic hooks quiet when no sync remote is configured", async () => {
    await withInitializedTempStore(async (storePath) => {
      const started = await runHostHook({ storePath, hook: { ...base, event: "session_start", trigger: "startup" }, project_id: "moryn", current_task: "Work locally" });
      expect((started.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
      expect((started.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();

      const checkpoint = await runHostHook({ storePath, hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Local checkpoint." }, project_id: "moryn", current_task: "Work locally" });
      expect(checkpoint).toMatchObject({ checkpoint_sync: { requested: false, reason: "remote_unconfigured" } });

      const restored = await runHostHook({ storePath, hook: { ...base, event: "post_compact" }, project_id: "moryn", current_task: "Work locally" });
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();
      expect(restored.hook_output.additional_context).toContain("Local checkpoint.");

      const stopped = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" }, project_id: "moryn", current_task: "Work locally" });
      expect(stopped).toMatchObject({ sync_cadence: { reason: "remote_unconfigured", push_requested: false } });
      expect((stopped.details as { sync: { push?: unknown; push_error?: unknown } }).sync.push_error).toBeUndefined();

      const ended = await runHostHook({ storePath, hook: { ...base, host: "claude", event: "session_end", occurred_at: "2026-07-11T00:02:00.000Z" }, project_id: "moryn", current_task: "Work locally" });
      expect((ended.details as { sync: { push?: unknown; push_error?: unknown } }).sync.push).toBeUndefined();
      expect((ended.details as { sync: { push?: unknown; push_error?: unknown } }).sync.push_error).toBeUndefined();

      const explicitPull = await runHostHook({ storePath, hook: { ...base, event: "post_compact", occurred_at: "2026-07-11T00:03:00.000Z" }, project_id: "moryn", pull: true });
      expect(explicitPull).toMatchObject({ details: { sync: { pull_error: expect.stringContaining("not configured") } } });
      const explicitPush = await runHostHook({ storePath, hook: { ...base, event: "pre_compact", occurred_at: "2026-07-11T00:04:00.000Z", trigger: "manual", compact_summary: "Force sync." }, project_id: "moryn", push: true });
      expect(explicitPush).toMatchObject({ checkpoint_sync: { requested: true, reason: "explicit_push", succeeded: false, error: expect.stringContaining("not configured") } });
    });
  });

  it("checkpoints idempotently before compact and restores after compact", async () => {
    await withInitializedTempStore(async (storePath) => {
      const preCompact = { ...base, event: "pre_compact" as const, trigger: "auto", compact_summary: "Implemented parser; next run tests." };
      const pushes: string[] = [];
      const deps = { isGitSyncConfigured: configuredSync, pushGitSync: async (_storePath: string, options: { message?: string }) => {
        pushes.push(options.message ?? "");
        return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
      } };
      const first = await runHostHook({ storePath, hook: preCompact, project_id: "moryn", current_task: "Implement hooks", pull: false }, deps);
      const replay = await runHostHook({ storePath, hook: preCompact, project_id: "moryn", current_task: "Implement hooks", pull: false }, deps);
      const restored = await runHostHook({ storePath, hook: { ...base, event: "post_compact" }, project_id: "moryn", current_task: "Implement hooks", pull: false });
      expect(first).toMatchObject({ action: "checkpoint_before_compaction", checkpoint: { idempotent_replay: false }, checkpoint_sync: { requested: true, reason: "new_checkpoint", succeeded: true } });
      expect(replay).toMatchObject({ checkpoint: { idempotent_replay: true }, checkpoint_sync: { requested: false, reason: "idempotent_replay" } });
      expect(restored).toMatchObject({ action: "resume_from_checkpoint" });
      expect(restored.hook_output.additional_context).toContain("Implemented parser; next run tests.");
      expect(pushes).toHaveLength(1);
    });
  });

  it("keeps a failed pre-compact push non-blocking and locally durable", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Checkpoint before remote outage." },
        project_id: "moryn",
        current_task: "Preserve local checkpoint"
      }, { isGitSyncConfigured: configuredSync, pushGitSync: async () => { throw new Error("remote unavailable"); } });

      expect(result).toMatchObject({
        action: "checkpoint_before_compaction",
        checkpoint: { idempotent_replay: false },
        checkpoint_sync: { requested: true, reason: "new_checkpoint", succeeded: false, error: "remote unavailable" }
      });
      expect(result.hook_output.additional_context).toContain("locally protected");
      const restored = await runHostHook({ storePath, hook: { ...base, event: "post_compact" }, project_id: "moryn", current_task: "Preserve local checkpoint" });
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();
      expect(restored.hook_output.additional_context).toContain("Checkpoint before remote outage.");
    });
  });

  it("reports a non-throwing pre-compact sync failure", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Checkpoint before rejected sync." },
        project_id: "moryn"
      }, { isGitSyncConfigured: configuredSync, pushGitSync: async () => ({ ok: false, message: "remote rejected update", selection_sources: SYNC_RESULT_SELECTION_SOURCES }) });

      expect(result).toMatchObject({ checkpoint_sync: { requested: true, succeeded: false, error: "remote rejected update" } });
      expect(result.hook_output.additional_context).toContain("locally protected");
    });
  });

  it("honors explicit pre-compact push overrides", async () => {
    await withInitializedTempStore(async (storePath) => {
      let pushes = 0;
      const deps = { pushGitSync: async () => {
        pushes += 1;
        return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
      } };
      const localOnly = await runHostHook({ storePath, hook: { ...base, event: "pre_compact", trigger: "manual", compact_summary: "Local only." }, project_id: "moryn", push: false }, deps);
      const forcedReplay = await runHostHook({ storePath, hook: { ...base, event: "pre_compact", trigger: "manual", compact_summary: "Local only." }, project_id: "moryn", push: true }, deps);

      expect(localOnly).toMatchObject({ checkpoint_sync: { requested: false, reason: "explicit_no_push" } });
      expect(forcedReplay).toMatchObject({ checkpoint: { idempotent_replay: true }, checkpoint_sync: { requested: true, reason: "explicit_push", succeeded: true } });
      expect(pushes).toBe(1);
    });
  });

  it("keeps pre-compact checkpoints local in manual sync mode", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "moryn-manual-precompact-"));
    try {
      await initializeProjectConfig(projectPath, { project_id: "moryn", sync: { mode: "manual" } });
      await withInitializedTempStore(async (storePath) => {
        let pushes = 0;
        const result = await runHostHook({
          storePath,
          project_path: projectPath,
          hook: { ...base, cwd: projectPath, event: "pre_compact", trigger: "auto", compact_summary: "Manual mode checkpoint." }
        }, { pushGitSync: async () => {
          pushes += 1;
          return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
        } });

        expect(result).toMatchObject({ checkpoint: { idempotent_replay: false }, checkpoint_sync: { requested: false, reason: "manual_mode" } });
        const restored = await runHostHook({
          storePath,
          project_path: projectPath,
          hook: { ...base, cwd: projectPath, event: "post_compact" }
        });
        expect(restored).toMatchObject({ action: "resume_from_checkpoint", details: { sync: { before: { configured: false }, after: { configured: false } } } });
        expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
        expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();
        expect(restored.hook_output.additional_context).toContain("Manual mode checkpoint.");
        expect(pushes).toBe(0);
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("consolidates authored pre-compact learnings without mutating post-compact restore", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const target = await engine.write({ kind: "memory", type: "fact", scope: "project", project_id: "moryn", content: { text: "Compact checkpoints preserve task context." }, state: "canonical", confirmed: true, source: { client: "user" } });
      const learning = { question: "What survives compact?", conclusion: "Compact checkpoints preserve the current task context.", evidence_type: "source_code" as const, scope: "project" as const, confidence: 0.9, recommended_kind: "memory" as const, recommended_type: "fact", related_record_ids: [] };
      const sourceRecordId = learningRecordIdentity({ project_id: "moryn", learning }).record_id;
      const proposal = { proposal_id: "compact-proposal", source_record_id: sourceRecordId, target_record_id: target.record.id, relationship: "duplicate_of" as const, confidence: 0.99, rationale: "Equivalent compact behavior.", semantic_equivalence: "equivalent" as const, material_differences: [], evidence_record_ids: [] };

      const preCompact = await runHostHook({ storePath, hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Compact lifecycle implemented." }, project_id: "moryn", current_task: "Implement hooks", learnings: [learning], semantic_consolidation_proposals: [proposal], pull: false });
      const eventsBeforeRestore = (await engine.listRecent({ project_id: "moryn", limit: 20 })).records;
      const restored = await runHostHook({ storePath, hook: { ...base, event: "post_compact" }, project_id: "moryn", current_task: "Implement hooks", pull: false });
      const eventsAfterRestore = (await engine.listRecent({ project_id: "moryn", limit: 20 })).records;

      expect(preCompact).toMatchObject({ checkpoint: { semantic_consolidation: { proposals_received: 1, proposals_accepted: 1, links_created: 1 } } });
      expect(restored).toMatchObject({ action: "resume_from_checkpoint" });
      expect(eventsAfterRestore).toEqual(eventsBeforeRestore);
    });
  });

  it("writes stop status and Claude session-end handoff without requiring sync success", async () => {
    await withInitializedTempStore(async (storePath) => {
      const stopped = await runHostHook({ storePath, hook: { ...base, event: "stop", compact_summary: "Tests passing." }, project_id: "moryn", current_task: "Implement hooks", push: false });
      const ended = await runHostHook({ storePath, hook: { ...base, host: "claude", event: "session_end", compact_summary: "Hooks complete." }, project_id: "moryn", current_task: "Implement hooks", push: false });
      expect(stopped).toMatchObject({ action: "agent_status", degradation: { mode: "native" } });
      expect(ended).toMatchObject({ action: "agent_finish", degradation: { mode: "native" } });
    });
  });

  it("throttles automatic turn pushes while explicit push overrides cadence", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "session-a", device_id: "device-a" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { session_id: "session-a", checkpoint_id: "sync-cadence", progress: ["Durable status evidence"] } });
      const pushes: string[] = [];
      const deps = { isGitSyncConfigured: configuredSync, pushGitSync: async (_storePath: string, options: { message?: string }) => {
        pushes.push(options.message ?? "");
        return { ok: true, committed: true, pushed: true, message: `commit-${pushes.length}`, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
      } };

      const first = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" }, project_id: "moryn" }, deps);
      const second = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" }, project_id: "moryn" }, deps);
      const third = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:16:00.000Z" }, project_id: "moryn" }, deps);
      const explicit = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:17:00.000Z" }, project_id: "moryn", push: true }, deps);

      expect(first).toMatchObject({ sync_cadence: { due: true, reason: "first_turn_sync", push_requested: true, push_succeeded: true } });
      expect(second).toMatchObject({ sync_cadence: { due: false, reason: "within_interval", push_requested: false } });
      expect(third).toMatchObject({ sync_cadence: { due: true, reason: "interval_elapsed", push_requested: true, push_succeeded: true } });
      expect(explicit).toMatchObject({ sync_cadence: { reason: "explicit_push", push_requested: true, push_succeeded: true } });
      expect(pushes).toHaveLength(3);
    });
  });

  it("retries automatic turn sync after a failed push", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "claude", session_id: "session-a", device_id: "device-a" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { session_id: "session-a", checkpoint_id: "failed-sync-cadence", progress: ["Durable status evidence"] } });
      let attempts = 0;
      const deps = { isGitSyncConfigured: configuredSync, pushGitSync: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("remote unavailable");
        return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
      } };

      const failed = await runHostHook({ storePath, hook: { ...base, host: "claude", event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" }, project_id: "moryn" }, deps);
      const retried = await runHostHook({ storePath, hook: { ...base, host: "claude", event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" }, project_id: "moryn" }, deps);

      expect(failed).toMatchObject({ sync_cadence: { reason: "first_turn_sync", push_requested: true, push_succeeded: false } });
      expect(retried).toMatchObject({ sync_cadence: { reason: "first_turn_sync", push_requested: true, push_succeeded: true } });
      expect(attempts).toBe(2);
    });
  });

  it("honors an explicit no-push override without advancing cadence", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "session-a", device_id: "device-a" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { session_id: "session-a", checkpoint_id: "no-push-cadence", progress: ["Durable status evidence"] } });
      let pushes = 0;
      const deps = { isGitSyncConfigured: configuredSync, pushGitSync: async () => {
        pushes += 1;
        return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
      } };

      const skipped = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" }, project_id: "moryn", push: false }, deps);
      const automatic = await runHostHook({ storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" }, project_id: "moryn" }, deps);

      expect(skipped).toMatchObject({ sync_cadence: { reason: "explicit_no_push", push_requested: false } });
      expect(automatic).toMatchObject({ sync_cadence: { reason: "first_turn_sync", push_requested: true, push_succeeded: true } });
      expect(pushes).toBe(1);
    });
  });
});
