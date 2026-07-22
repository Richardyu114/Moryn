import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentFinish } from "../../src/core/agent-lifecycle.js";
import { createEngine } from "../../src/core/engine.js";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { learningRecordIdentity } from "../../src/core/learning-ingestion.js";
import { initializeProjectConfig } from "../../src/core/project.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import { SYNC_RESULT_SELECTION_SOURCES } from "../../src/sync/git.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const base = {
  host: "codex" as const,
  session_id: "session-a",
  device_id: "device-a",
  cwd: "/repo",
  occurred_at: "2026-07-11T00:00:00.000Z"
};

const configuredSync = async () => true;

describe("host hook runner", () => {
  it("checkpoints public transcript progress when PreCompact has no summary", async () => {
    await withInitializedTempStore(async (storePath) => {
      const transcriptRoot = join(storePath, "sessions");
      const transcriptPath = join(transcriptRoot, "session.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Implemented bounded compact recovery; next verify restore." } })}\n`
      );
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Implement compact safety",
        transcript_roots: [transcriptRoot],
        hook: { ...base, event: "pre_compact", transcript_path: transcriptPath }
      });
      expect(result).toMatchObject({
        checkpoint: { recovery_pack: { progress: ["Implemented bounded compact recovery; next verify restore."] } },
        transcript_evidence: { status: "available" }
      });
      expect(JSON.stringify(result)).not.toContain(transcriptPath);
    });
  });

  it("synthesizes Stop progress from the host last assistant message without a checkpoint", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Implement compact safety",
        hook: { ...base, event: "stop", last_assistant_message: "Completed transcript parsing and ran focused tests." },
        push: false
      });
      expect(result).toMatchObject({
        action: "agent_status",
        details: { record: { content: { synthesis_mode: "host_authored" } } },
        transcript_evidence: { status: "available", source: "hook_payload" }
      });
      expect(result.details?.record?.content.text).toContain("Completed transcript parsing");
    });
  });

  it("does not checkpoint sensitive transcript text", async () => {
    await withInitializedTempStore(async (storePath) => {
      const transcriptRoot = join(storePath, "sessions");
      const transcriptPath = join(transcriptRoot, "session.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      await writeFile(
        transcriptPath,
        `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Use api_key=abcdefghijklmnop for deployment." } })}\n`
      );
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Protect compact evidence",
        transcript_roots: [transcriptRoot],
        hook: { ...base, event: "pre_compact", transcript_path: transcriptPath }
      });
      expect(result).toMatchObject({ transcript_evidence: { status: "protected" } });
      expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    });
  });

  it("does not persist a sensitive Stop last assistant message", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Protect stop evidence",
        hook: { ...base, event: "stop", last_assistant_message: "Use api_key=abcdefghijklmnop for deployment." },
        push: false
      });
      expect(result).toMatchObject({
        action: "skip_empty_status",
        transcript_evidence: { status: "protected", source: "hook_payload" }
      });
      expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    });
  });

  it("keeps durable checkpoint synthesis ahead of a weaker SessionEnd assistant message", async () => {
    await withInitializedTempStore(async (storePath) => {
      await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Preserve structured evidence",
        hook: { ...base, event: "pre_compact", compact_summary: "Implemented parser; next run full release gate." }
      });
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Preserve structured evidence",
        hook: {
          ...base,
          event: "session_end",
          occurred_at: "2026-07-11T00:05:00.000Z",
          last_assistant_message: "Done."
        },
        push: false
      });
      expect(result).toMatchObject({
        action: "agent_finish",
        details: { record: { content: { synthesis_mode: "evidence_synthesized" } } }
      });
      expect(result.details?.record?.content.text).toContain("Implemented parser; next run full release gate.");
      expect(result.details?.record?.content.text).not.toBe("Done.");
    });
  });

  it("returns a safe PostCompact host summary alongside restored checkpoint evidence", async () => {
    await withInitializedTempStore(async (storePath) => {
      await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Restore compact context",
        hook: { ...base, event: "pre_compact", compact_summary: "Checkpointed parser implementation." }
      });
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Restore compact context",
        hook: {
          ...base,
          event: "post_compact",
          occurred_at: "2026-07-11T00:02:00.000Z",
          compact_summary: "Host compact retained the parser decision."
        }
      });
      expect(result.hook_output.additional_context).toContain("Checkpointed parser implementation.");
      expect(result.hook_output.additional_context).toContain("Host compact retained the parser decision.");
    });
  });

  it("omits a sensitive PostCompact host summary while restoring the checkpoint", async () => {
    await withInitializedTempStore(async (storePath) => {
      await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Restore protected compact context",
        hook: { ...base, event: "pre_compact", compact_summary: "Checkpointed safe progress." }
      });
      const result = await runHostHook({
        storePath,
        project_id: "moryn",
        current_task: "Restore protected compact context",
        hook: {
          ...base,
          event: "post_compact",
          occurred_at: "2026-07-11T00:03:00.000Z",
          compact_summary: "Use api_key=abcdefghijklmnop after compact."
        }
      });
      expect(result.hook_output.additional_context).toContain("Checkpointed safe progress.");
      expect(result.hook_output.additional_context).not.toContain("abcdefghijklmnop");
    });
  });

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
        hook: {
          ...base,
          event: "user_prompt_submit",
          prompt: "Does production rollback require a tagged release and the rollback runbook?"
        },
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
      expect(result.hook_output.additional_context).toContain("queue_learning");
      expect(result.hook_output.additional_context).toContain("automatic_on_checkpoint_or_finish");
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
        hook: {
          ...base,
          event: "user_prompt_submit",
          prompt: "Does the candidate lunar deployment protocol use an unverified launch window?"
        },
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
      const result = await runHostHook({
        storePath,
        hook: { ...base, event: "session_start", trigger: "startup" },
        project_id: "moryn",
        current_task: "Implement hooks",
        pull: false
      });
      expect(result).toMatchObject({
        ok: true,
        event: "session_start",
        action: "agent_start",
        degradation: { mode: "native" }
      });
      expect(result.hook_output.additional_context).toContain("Implement hooks");
    });
  });

  it("uses the project Soul binding for automatic SessionStart delivery", async () => {
    await withInitializedTempStore(async (storePath) => {
      const projectPath = join(storePath, "project");
      const source = { client: "user", device_id: "device-a" };
      const approvedProfiles = [];
      for (const [subjectId, text] of [
        ["primary", "Use the primary project persona."],
        ["secondary", "Use the secondary project persona."]
      ] as const) {
        const draft = await createSoulProfileDraft(storePath, {
          subject: { kind: "agent", subject_id: subjectId },
          clauses: [
            {
              clause_key: "persona",
              category: "identity",
              text,
              distribution: "personal_sync"
            }
          ],
          source,
          occurred_at: "2026-07-10T23:58:00.000Z"
        });
        approvedProfiles.push(
          (
            await approveSoulProfileDraft(storePath, {
              revision_id: draft.revision.revision_id,
              confirmed: true,
              source,
              occurred_at: "2026-07-10T23:59:00.000Z"
            })
          ).revision
        );
      }
      const initialized = await initializeProjectConfig(projectPath, {
        project_id: "moryn",
        sync: { mode: "manual" }
      });
      await writeFile(
        initialized.path,
        `${JSON.stringify(
          {
            ...initialized.config,
            soul: { agent_profile_id: approvedProfiles[0]!.profile_id, char_budget: 2048, token_budget: 512 }
          },
          null,
          2
        )}\n`,
        "utf8"
      );

      const result = await runHostHook({
        storePath,
        project_path: projectPath,
        hook: { ...base, cwd: projectPath, event: "session_start", trigger: "startup" },
        current_task: "Use a configured project persona",
        pull: false
      });
      const details = result.details as {
        effective_soul: { status: string; deliverable: boolean; clauses: Array<{ text: string }> };
      };

      expect(details.effective_soul).toMatchObject({ status: "ready", deliverable: true });
      expect(details.effective_soul.clauses.map((clause) => clause.text)).toEqual(["Use the primary project persona."]);
      expect(result.soul_delivery).toMatchObject({
        delivery: "prepared",
        context: { host_context_prepared: true }
      });
    });
  });

  it("keeps automatic hooks quiet when no sync remote is configured", async () => {
    await withInitializedTempStore(async (storePath) => {
      const started = await runHostHook({
        storePath,
        hook: { ...base, event: "session_start", trigger: "startup" },
        project_id: "moryn",
        current_task: "Work locally"
      });
      expect((started.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
      expect((started.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();

      const checkpoint = await runHostHook({
        storePath,
        hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Local checkpoint." },
        project_id: "moryn",
        current_task: "Work locally"
      });
      expect(checkpoint).toMatchObject({ checkpoint_sync: { requested: false, reason: "remote_unconfigured" } });

      const restored = await runHostHook({
        storePath,
        hook: { ...base, event: "post_compact" },
        project_id: "moryn",
        current_task: "Work locally"
      });
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();
      expect(restored.hook_output.additional_context).toContain("Local checkpoint.");

      const stopped = await runHostHook({
        storePath,
        hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" },
        project_id: "moryn",
        current_task: "Work locally"
      });
      expect(stopped).toMatchObject({ sync_cadence: { reason: "remote_unconfigured", push_requested: false } });
      expect((stopped.details as { sync: { push?: unknown; push_error?: unknown } }).sync.push_error).toBeUndefined();

      const ended = await runHostHook({
        storePath,
        hook: { ...base, host: "claude", event: "session_end", occurred_at: "2026-07-11T00:02:00.000Z" },
        project_id: "moryn",
        current_task: "Work locally"
      });
      expect((ended.details as { sync: { push?: unknown; push_error?: unknown } }).sync.push).toBeUndefined();
      expect((ended.details as { sync: { push?: unknown; push_error?: unknown } }).sync.push_error).toBeUndefined();

      const explicitPull = await runHostHook({
        storePath,
        hook: { ...base, event: "post_compact", occurred_at: "2026-07-11T00:03:00.000Z" },
        project_id: "moryn",
        pull: true
      });
      expect(explicitPull).toMatchObject({
        details: { sync: { pull_error: expect.stringContaining("not configured") } }
      });
      const explicitPush = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "pre_compact",
          occurred_at: "2026-07-11T00:04:00.000Z",
          trigger: "manual",
          compact_summary: "Force sync."
        },
        project_id: "moryn",
        push: true
      });
      expect(explicitPush).toMatchObject({
        checkpoint_sync: {
          requested: true,
          reason: "explicit_push",
          succeeded: false,
          error: expect.stringContaining("not configured")
        }
      });
    });
  });

  it("checkpoints idempotently before compact and restores after compact", async () => {
    await withInitializedTempStore(async (storePath) => {
      const preCompact = {
        ...base,
        event: "pre_compact" as const,
        trigger: "auto",
        compact_summary: "Implemented parser; next run tests."
      };
      const pushes: string[] = [];
      const deps = {
        isGitSyncConfigured: configuredSync,
        pushGitSync: async (_storePath: string, options: { message?: string }) => {
          pushes.push(options.message ?? "");
          return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
        }
      };
      const first = await runHostHook(
        { storePath, hook: preCompact, project_id: "moryn", current_task: "Implement hooks", pull: false },
        deps
      );
      const replay = await runHostHook(
        { storePath, hook: preCompact, project_id: "moryn", current_task: "Implement hooks", pull: false },
        deps
      );
      const restored = await runHostHook({
        storePath,
        hook: { ...base, event: "post_compact" },
        project_id: "moryn",
        current_task: "Implement hooks",
        pull: false
      });
      expect(first).toMatchObject({
        action: "checkpoint_before_compaction",
        checkpoint: { idempotent_replay: false },
        checkpoint_sync: { requested: true, reason: "new_checkpoint", succeeded: true }
      });
      expect(replay).toMatchObject({
        checkpoint: { idempotent_replay: true },
        checkpoint_sync: { requested: false, reason: "idempotent_replay" }
      });
      expect(restored).toMatchObject({ action: "resume_from_checkpoint" });
      expect(restored.hook_output.additional_context).toContain("Implemented parser; next run tests.");
      expect(pushes).toHaveLength(1);
    });
  });

  it("keeps a failed pre-compact push non-blocking and locally durable", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook(
        {
          storePath,
          hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Checkpoint before remote outage." },
          project_id: "moryn",
          current_task: "Preserve local checkpoint"
        },
        {
          isGitSyncConfigured: configuredSync,
          pushGitSync: async () => {
            throw new Error("remote unavailable");
          }
        }
      );

      expect(result).toMatchObject({
        action: "checkpoint_before_compaction",
        checkpoint: { idempotent_replay: false },
        checkpoint_sync: { requested: true, reason: "new_checkpoint", succeeded: false, error: "remote unavailable" }
      });
      expect(result.hook_output.additional_context).toContain("locally protected");
      const restored = await runHostHook({
        storePath,
        hook: { ...base, event: "post_compact" },
        project_id: "moryn",
        current_task: "Preserve local checkpoint"
      });
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
      expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error).toBeUndefined();
      expect(restored.hook_output.additional_context).toContain("Checkpoint before remote outage.");
    });
  });

  it("reports a non-throwing pre-compact sync failure", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook(
        {
          storePath,
          hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Checkpoint before rejected sync." },
          project_id: "moryn"
        },
        {
          isGitSyncConfigured: configuredSync,
          pushGitSync: async () => ({
            ok: false,
            message: "remote rejected update",
            selection_sources: SYNC_RESULT_SELECTION_SOURCES
          })
        }
      );

      expect(result).toMatchObject({
        checkpoint_sync: { requested: true, succeeded: false, error: "remote rejected update" }
      });
      expect(result.hook_output.additional_context).toContain("locally protected");
    });
  });

  it("honors explicit pre-compact push overrides", async () => {
    await withInitializedTempStore(async (storePath) => {
      let pushes = 0;
      const deps = {
        pushGitSync: async () => {
          pushes += 1;
          return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
        }
      };
      const localOnly = await runHostHook(
        {
          storePath,
          hook: { ...base, event: "pre_compact", trigger: "manual", compact_summary: "Local only." },
          project_id: "moryn",
          push: false
        },
        deps
      );
      const forcedReplay = await runHostHook(
        {
          storePath,
          hook: { ...base, event: "pre_compact", trigger: "manual", compact_summary: "Local only." },
          project_id: "moryn",
          push: true
        },
        deps
      );

      expect(localOnly).toMatchObject({ checkpoint_sync: { requested: false, reason: "explicit_no_push" } });
      expect(forcedReplay).toMatchObject({
        checkpoint: { idempotent_replay: true },
        checkpoint_sync: { requested: true, reason: "explicit_push", succeeded: true }
      });
      expect(pushes).toBe(1);
    });
  });

  it("keeps pre-compact checkpoints local in manual sync mode", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "moryn-manual-precompact-"));
    try {
      await initializeProjectConfig(projectPath, { project_id: "moryn", sync: { mode: "manual" } });
      await withInitializedTempStore(async (storePath) => {
        let pushes = 0;
        const result = await runHostHook(
          {
            storePath,
            project_path: projectPath,
            hook: {
              ...base,
              cwd: projectPath,
              event: "pre_compact",
              trigger: "auto",
              compact_summary: "Manual mode checkpoint."
            }
          },
          {
            pushGitSync: async () => {
              pushes += 1;
              return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
            }
          }
        );

        expect(result).toMatchObject({
          checkpoint: { idempotent_replay: false },
          checkpoint_sync: { requested: false, reason: "manual_mode" }
        });
        const restored = await runHostHook({
          storePath,
          project_path: projectPath,
          hook: { ...base, cwd: projectPath, event: "post_compact" }
        });
        expect(restored).toMatchObject({
          action: "resume_from_checkpoint",
          details: { sync: { before: { configured: false }, after: { configured: false } } }
        });
        expect((restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull).toBeUndefined();
        expect(
          (restored.details as { sync: { pull?: unknown; pull_error?: unknown } }).sync.pull_error
        ).toBeUndefined();
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
      const target = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Compact checkpoints preserve task context." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "What survives compact?",
        conclusion: "Compact checkpoints preserve the current task context.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 0.9,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const sourceRecordId = learningRecordIdentity({ project_id: "moryn", learning }).record_id;
      const proposal = {
        proposal_id: "compact-proposal",
        source_record_id: sourceRecordId,
        target_record_id: target.record.id,
        relationship: "duplicate_of" as const,
        confidence: 0.99,
        rationale: "Equivalent compact behavior.",
        semantic_equivalence: "equivalent" as const,
        material_differences: [],
        evidence_record_ids: []
      };

      const preCompact = await runHostHook({
        storePath,
        hook: { ...base, event: "pre_compact", trigger: "auto", compact_summary: "Compact lifecycle implemented." },
        project_id: "moryn",
        current_task: "Implement hooks",
        learnings: [learning],
        semantic_consolidation_proposals: [proposal],
        pull: false
      });
      const eventsBeforeRestore = (await engine.listRecent({ project_id: "moryn", limit: 20 })).records;
      const restored = await runHostHook({
        storePath,
        hook: { ...base, event: "post_compact" },
        project_id: "moryn",
        current_task: "Implement hooks",
        pull: false
      });
      const eventsAfterRestore = (await engine.listRecent({ project_id: "moryn", limit: 20 })).records;

      expect(preCompact).toMatchObject({
        checkpoint: { semantic_consolidation: { proposals_received: 1, proposals_accepted: 1, links_created: 1 } }
      });
      expect(restored).toMatchObject({ action: "resume_from_checkpoint" });
      expect(eventsAfterRestore).toEqual(eventsBeforeRestore);
    });
  });

  it("returns an agent-owned candidate review workflow before compaction", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const target = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn restores project context after host compaction." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "What happens after compact?",
        conclusion: "Moryn restores project context when compaction completes.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 0.9,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };

      const result = await runHostHook({
        storePath,
        hook: {
          ...base,
          host: "claude",
          event: "pre_compact",
          trigger: "auto",
          compact_summary: "Checkpoint before compact."
        },
        project_id: "moryn",
        current_task: "Verify compaction recovery",
        learnings: [learning],
        pull: false,
        push: false
      });

      expect(result).toMatchObject({
        action: "checkpoint_before_compaction",
        candidate_review: {
          action: "review_learning_candidates",
          owner: "agent",
          candidate_pairs: [{ candidate_record_id: target.record.id }]
        }
      });
      expect(result.hook_output.additional_context).toContain("semantic candidate");
      expect(result.hook_output.additional_context).not.toContain(target.record.content.text);
    });
  });

  it("writes stop status and Claude session-end handoff without requiring sync success", async () => {
    await withInitializedTempStore(async (storePath) => {
      const stopped = await runHostHook({
        storePath,
        hook: { ...base, event: "stop", compact_summary: "Tests passing." },
        project_id: "moryn",
        current_task: "Implement hooks",
        push: false
      });
      const ended = await runHostHook({
        storePath,
        hook: { ...base, host: "claude", event: "session_end", compact_summary: "Hooks complete." },
        project_id: "moryn",
        current_task: "Implement hooks",
        push: false
      });
      expect(stopped).toMatchObject({ action: "agent_status", degradation: { mode: "native" } });
      expect(ended).toMatchObject({ action: "agent_finish", degradation: { mode: "native" } });
    });
  });

  it("keeps distinct host-authored Stop summaries", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "stop",
          occurred_at: "2026-07-11T00:01:00.000Z",
          compact_summary: "Implemented parser."
        },
        project_id: "moryn",
        push: false
      });
      const second = await runHostHook({
        storePath,
        hook: {
          ...base,
          event: "stop",
          occurred_at: "2026-07-11T00:02:00.000Z",
          compact_summary: "Parser tests pass."
        },
        project_id: "moryn",
        push: false
      });

      expect(first).toMatchObject({ action: "agent_status" });
      expect(second).toMatchObject({ action: "agent_status" });
      const engine = createEngine({ storePath });
      expect(
        (await engine.listRecent({ project_id: "moryn", limit: 20 })).records.filter(
          (record) => record.type === "status"
        )
      ).toHaveLength(2);
    });
  });

  it("coalesces repeated SessionEnd handoffs while preserving explicit push", async () => {
    await withInitializedTempStore(async (storePath) => {
      const pushes: string[] = [];
      const deps = {
        isGitSyncConfigured: configuredSync,
        pushGitSync: async (_storePath: string, options: { message?: string }) => {
          pushes.push(options.message ?? "");
          return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
        }
      };
      const hook = {
        ...base,
        host: "claude" as const,
        event: "session_end" as const,
        occurred_at: "2026-07-11T00:10:00.000Z",
        compact_summary: "Final handoff."
      };
      const first = await runHostHook({ storePath, hook, project_id: "moryn" }, deps);
      const replay = await runHostHook({ storePath, hook, project_id: "moryn" }, deps);
      const forced = await runHostHook({ storePath, hook, project_id: "moryn", push: true }, deps);

      expect(first).toMatchObject({ action: "agent_finish" });
      expect(replay).toMatchObject({
        action: "skip_duplicate_handoff",
        duplicate_handoff: { prior_record_id: first.details.record.id }
      });
      expect(forced).toMatchObject({
        action: "skip_duplicate_handoff",
        duplicate_handoff: { prior_record_id: first.details.record.id },
        duplicate_handoff_sync: { requested: true, succeeded: true }
      });
      expect(pushes).toHaveLength(2);
      const engine = createEngine({ storePath });
      expect(
        (await engine.listRecent({ project_id: "moryn", limit: 20 })).records.filter(
          (record) => record.type === "summary"
        )
      ).toHaveLength(1);
    });
  });

  it("does not coalesce SessionEnd when new learning arrives with the same summary", async () => {
    await withInitializedTempStore(async (storePath) => {
      const hook = {
        ...base,
        host: "claude" as const,
        event: "session_end" as const,
        occurred_at: "2026-07-11T00:10:00.000Z",
        compact_summary: "Final handoff."
      };
      const learning = {
        question: "What protects rollback?",
        conclusion: "Rollback requires the signed release tag.",
        evidence_type: "user_confirmed" as const,
        scope: "project" as const,
        confidence: 1,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const first = await runHostHook({ storePath, hook, project_id: "moryn", push: false });
      const learned = await runHostHook({ storePath, hook, project_id: "moryn", push: false, learnings: [learning] });
      const replay = await runHostHook({ storePath, hook, project_id: "moryn", push: false, learnings: [learning] });

      expect(first).toMatchObject({ action: "agent_finish" });
      expect(learned).toMatchObject({
        action: "agent_finish",
        details: { learning_ingestion: { records_created: 1 } }
      });
      expect(replay).toMatchObject({
        action: "skip_duplicate_handoff",
        duplicate_handoff: { prior_record_id: learned.details.record.id }
      });
      const engine = createEngine({ storePath });
      const records = (await engine.listRecent({ project_id: "moryn", limit: 30 })).records;
      expect(records.filter((record) => record.type === "summary")).toHaveLength(2);
      expect(records.some((record) => record.content.text === learning.conclusion)).toBe(true);
    });
  });

  it("normalizes Learning Delta order for exact SessionEnd replay", async () => {
    await withInitializedTempStore(async (storePath) => {
      const hook = {
        ...base,
        host: "claude" as const,
        event: "session_end" as const,
        occurred_at: "2026-07-11T00:10:00.000Z",
        compact_summary: "Final handoff."
      };
      const firstLearning = {
        question: "What protects rollback?",
        conclusion: "Rollback requires the signed release tag.",
        evidence_type: "user_confirmed" as const,
        scope: "project" as const,
        confidence: 1,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const secondLearning = {
        question: "What validates release?",
        conclusion: "The complete release gate must pass.",
        evidence_type: "source_code" as const,
        scope: "project" as const,
        confidence: 1,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const first = await runHostHook({
        storePath,
        hook,
        project_id: "moryn",
        push: false,
        learnings: [firstLearning, secondLearning]
      });
      const replay = await runHostHook({
        storePath,
        hook,
        project_id: "moryn",
        push: false,
        learnings: [secondLearning, firstLearning]
      });

      expect(first).toMatchObject({ action: "agent_finish" });
      expect(replay).toMatchObject({
        action: "skip_duplicate_handoff",
        duplicate_handoff: { prior_record_id: first.details.record.id }
      });
    });
  });

  it("does not let a legacy summary suppress an automatic SessionEnd", async () => {
    await withInitializedTempStore(async (storePath) => {
      await agentFinish({
        storePath,
        projectId: "moryn",
        agent: { client: "claude", session_id: "session-a", device_id: "device-a" },
        summary: "Final handoff.",
        push: false
      });
      const result = await runHostHook({
        storePath,
        hook: {
          ...base,
          host: "claude",
          event: "session_end",
          occurred_at: "2026-07-11T00:10:00.000Z",
          compact_summary: "Final handoff."
        },
        project_id: "moryn",
        push: false
      });

      expect(result).toMatchObject({
        action: "agent_finish",
        details: { record: { content: { handoff_payload_fingerprint: expect.any(String) } } }
      });
      const engine = createEngine({ storePath });
      expect(
        (await engine.listRecent({ project_id: "moryn", limit: 20 })).records.filter(
          (record) => record.type === "summary"
        )
      ).toHaveLength(2);
    });
  });

  it("does not coalesce SessionEnd when a new semantic proposal arrives", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const target = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Rollback uses a signed tag." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const learning = {
        question: "What protects rollback?",
        conclusion: "Rollback uses a signed tag.",
        evidence_type: "user_confirmed" as const,
        scope: "project" as const,
        confidence: 1,
        recommended_kind: "memory" as const,
        recommended_type: "fact",
        related_record_ids: []
      };
      const sourceRecordId = learningRecordIdentity({ project_id: "moryn", learning }).record_id;
      const proposal = {
        proposal_id: "finish-proposal",
        source_record_id: sourceRecordId,
        target_record_id: target.record.id,
        relationship: "duplicate_of" as const,
        confidence: 1,
        rationale: "Equivalent rollback fact.",
        semantic_equivalence: "equivalent" as const,
        material_differences: [],
        evidence_record_ids: []
      };
      const hook = {
        ...base,
        host: "claude" as const,
        event: "session_end" as const,
        occurred_at: "2026-07-11T00:10:00.000Z",
        compact_summary: "Final handoff."
      };
      await runHostHook({ storePath, hook, project_id: "moryn", push: false, learnings: [learning] });
      const proposed = await runHostHook({
        storePath,
        hook,
        project_id: "moryn",
        push: false,
        learnings: [learning],
        semantic_consolidation_proposals: [proposal]
      });

      expect(proposed).toMatchObject({
        action: "agent_finish",
        details: { semantic_consolidation: { proposals_received: 1, proposals_accepted: 1 } }
      });
    });
  });

  it("throttles automatic turn pushes while explicit push overrides cadence", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-a", device_id: "device-a" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: { session_id: "session-a", checkpoint_id: "sync-cadence", progress: ["Durable status evidence"] }
      });
      const pushes: string[] = [];
      const deps = {
        isGitSyncConfigured: configuredSync,
        pushGitSync: async (_storePath: string, options: { message?: string }) => {
          pushes.push(options.message ?? "");
          return {
            ok: true,
            committed: true,
            pushed: true,
            message: `commit-${pushes.length}`,
            selection_sources: SYNC_RESULT_SELECTION_SOURCES
          };
        }
      };

      const first = await runHostHook(
        { storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" }, project_id: "moryn" },
        deps
      );
      const second = await runHostHook(
        { storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" }, project_id: "moryn" },
        deps
      );
      const third = await runHostHook(
        { storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:16:00.000Z" }, project_id: "moryn" },
        deps
      );
      const explicit = await runHostHook(
        {
          storePath,
          hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:17:00.000Z" },
          project_id: "moryn",
          push: true
        },
        deps
      );

      expect(first).toMatchObject({
        action: "agent_status",
        sync_cadence: { due: true, reason: "first_turn_sync", push_requested: true, push_succeeded: true }
      });
      expect(second).toMatchObject({
        action: "skip_duplicate_status",
        duplicate_status: { prior_record_id: first.details.record.id },
        sync_cadence: { due: false, reason: "within_interval", push_requested: false }
      });
      expect(third).toMatchObject({
        action: "skip_duplicate_status",
        duplicate_status: { prior_record_id: first.details.record.id },
        sync_cadence: { due: true, reason: "interval_elapsed", push_requested: true, push_succeeded: true }
      });
      expect(explicit).toMatchObject({
        action: "skip_duplicate_status",
        duplicate_status: { prior_record_id: first.details.record.id },
        sync_cadence: { reason: "explicit_push", push_requested: true, push_succeeded: true }
      });
      expect(pushes).toHaveLength(3);
      expect(
        (await engine.listRecent({ project_id: "moryn", limit: 20 })).records.filter(
          (record) => record.type === "status"
        )
      ).toHaveLength(1);
    });
  });

  it("retries automatic turn sync after a failed push", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "claude", session_id: "session-a", device_id: "device-a" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: { session_id: "session-a", checkpoint_id: "failed-sync-cadence", progress: ["Durable status evidence"] }
      });
      let attempts = 0;
      const deps = {
        isGitSyncConfigured: configuredSync,
        pushGitSync: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("remote unavailable");
          return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
        }
      };

      const failed = await runHostHook(
        {
          storePath,
          hook: { ...base, host: "claude", event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" },
          project_id: "moryn"
        },
        deps
      );
      const retried = await runHostHook(
        {
          storePath,
          hook: { ...base, host: "claude", event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" },
          project_id: "moryn"
        },
        deps
      );

      expect(failed).toMatchObject({
        sync_cadence: { reason: "first_turn_sync", push_requested: true, push_succeeded: false }
      });
      expect(retried).toMatchObject({
        action: "skip_duplicate_status",
        sync_cadence: { reason: "first_turn_sync", push_requested: true, push_succeeded: true }
      });
      expect(attempts).toBe(2);
    });
  });

  it("writes a new Stop status when durable session evidence changes", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-a", device_id: "device-a" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: { session_id: "session-a", checkpoint_id: "status-change-a", progress: ["Implemented parser"] }
      });
      const first = await runHostHook({
        storePath,
        hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" },
        project_id: "moryn",
        push: false
      });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-a", device_id: "device-a" },
        occurred_at: "2026-07-11T00:02:00.000Z",
        delta: {
          session_id: "session-a",
          checkpoint_id: "status-change-b",
          progress: ["Integration tests pass"],
          next_steps: ["Review release gate"]
        }
      });
      const changed = await runHostHook({
        storePath,
        hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:03:00.000Z" },
        project_id: "moryn",
        push: false
      });

      expect(first).toMatchObject({ action: "agent_status" });
      expect(changed).toMatchObject({ action: "agent_status" });
      expect(
        (await engine.listRecent({ project_id: "moryn", limit: 20 })).records.filter(
          (record) => record.type === "status"
        )
      ).toHaveLength(2);
    });
  });

  it("does not coalesce a status that changed away and later returned", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const checkpoint = async (checkpointId: string, occurredAt: string, progress: string) =>
        engine.checkpoint({
          project_id: "moryn",
          source: { client: "codex", session_id: "session-a", device_id: "device-a" },
          occurred_at: occurredAt,
          delta: { session_id: "session-a", checkpoint_id: checkpointId, progress: [progress] }
        });
      await checkpoint("status-a-1", "2026-07-11T00:00:00.000Z", "State A");
      await runHostHook({
        storePath,
        hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" },
        project_id: "moryn",
        push: false
      });
      await checkpoint("status-b", "2026-07-11T00:02:00.000Z", "State B");
      await runHostHook({
        storePath,
        hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:03:00.000Z" },
        project_id: "moryn",
        push: false
      });
      await checkpoint("status-a-2", "2026-07-11T00:04:00.000Z", "State A");
      const returned = await runHostHook({
        storePath,
        hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" },
        project_id: "moryn",
        push: false
      });

      expect(returned).toMatchObject({ action: "agent_status" });
      expect(
        (await engine.listRecent({ project_id: "moryn", limit: 30 })).records.filter(
          (record) => record.type === "status"
        )
      ).toHaveLength(3);
    });
  });

  it("honors an explicit no-push override without advancing cadence", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-a", device_id: "device-a" },
        occurred_at: "2026-07-11T00:00:00.000Z",
        delta: { session_id: "session-a", checkpoint_id: "no-push-cadence", progress: ["Durable status evidence"] }
      });
      let pushes = 0;
      const deps = {
        isGitSyncConfigured: configuredSync,
        pushGitSync: async () => {
          pushes += 1;
          return { ok: true, pushed: true, selection_sources: SYNC_RESULT_SELECTION_SOURCES };
        }
      };

      const skipped = await runHostHook(
        {
          storePath,
          hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:01:00.000Z" },
          project_id: "moryn",
          push: false
        },
        deps
      );
      const automatic = await runHostHook(
        { storePath, hook: { ...base, event: "stop", occurred_at: "2026-07-11T00:05:00.000Z" }, project_id: "moryn" },
        deps
      );

      expect(skipped).toMatchObject({ sync_cadence: { reason: "explicit_no_push", push_requested: false } });
      expect(automatic).toMatchObject({
        sync_cadence: { reason: "first_turn_sync", push_requested: true, push_succeeded: true }
      });
      expect(pushes).toBe(1);
    });
  });
});
