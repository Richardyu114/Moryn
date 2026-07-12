import { createHash } from "node:crypto";
import { agentFinish, agentStart, agentStatus } from "./agent-lifecycle.js";
import { createEngine } from "./engine.js";
import { getHostCapabilities } from "./host-capabilities.js";
import type { NormalizedHostHookEvent } from "./host-hooks.js";
import type { KnowledgeInvestigationInput, LearningDeltaInput, SemanticConsolidationProposalInput } from "./context-delta.js";
import { resolveProjectContext } from "./project.js";
import { recordActivationReceipt, type ActivationReceiptInput } from "./activation-receipts.js";
import { buildHostIntegrationArtifact } from "./host-integration-artifacts.js";
import { synthesizeSession, type SessionSynthesis } from "./session-synthesis.js";
import { buildPromptRecallContext } from "./host-prompt-recall.js";
import { evaluateTurnSyncCadence, recordTurnSyncSuccess, type TurnSyncCadenceDecision } from "./turn-sync-cadence.js";
import { pushGitSync, type GitSyncResult } from "../sync/git.js";

export interface RunHostHookInput {
  storePath: string;
  hook: NormalizedHostHookEvent;
  project_id?: string;
  project_path?: string;
  current_task?: string;
  pull?: boolean;
  push?: boolean;
  learnings?: LearningDeltaInput[];
  knowledge_investigations?: KnowledgeInvestigationInput[];
  semantic_consolidation_proposals?: SemanticConsolidationProposalInput[];
  activation_id?: string;
  command_digest?: string;
}

export interface RunHostHookDeps {
  pushGitSync?: typeof pushGitSync;
}

export type HostHookSyncCadence = {
  due: boolean;
  reason: TurnSyncCadenceDecision["reason"] | "explicit_push" | "explicit_no_push" | "manual_mode";
  interval_minutes: 15;
  last_success_at?: string;
  push_requested: boolean;
  push_succeeded?: boolean;
};

export type HostHookCheckpointSync = {
  requested: boolean;
  reason: "explicit_push" | "explicit_no_push" | "manual_mode" | "new_checkpoint" | "idempotent_replay";
  succeeded?: boolean;
  push?: GitSyncResult;
  error?: string;
};

export interface HostHookRunResult {
  ok: true;
  event: NormalizedHostHookEvent["event"];
  action: "agent_start" | "recall_prompt" | "checkpoint_before_compaction" | "resume_from_checkpoint" | "agent_status" | "agent_finish" | "skip_empty_status";
  degradation: { mode: "native" } | { mode: "fallback"; reason: "host_hook_unavailable" };
  hook_output: { additional_context: string };
  checkpoint?: { idempotent_replay: boolean; record: { id: string } };
  checkpoint_sync?: HostHookCheckpointSync;
  activation_receipt?: Awaited<ReturnType<typeof recordActivationReceipt>>;
  activation_warning?: { code: "ACTIVATION_RECEIPT_FAILED"; reason: string };
  skipped?: { reason: "no_durable_session_evidence" };
  details?: unknown;
  prompt_recall?: {
    outcome: { status: "trusted_match" | "verification_required" | "knowledge_gap"; best_record_id?: string };
    injected: boolean;
    record_count: number;
  };
  sync_cadence?: HostHookSyncCadence;
}

function checkpointId(hook: NormalizedHostHookEvent): string {
  const digest = createHash("sha256").update(`${hook.host}\u0000${hook.session_id}\u0000${hook.occurred_at}\u0000${hook.trigger ?? "compact"}`).digest("hex");
  return `hook-${digest.slice(0, 24)}`;
}

function lifecycleInput(input: RunHostHookInput) {
  return {
    storePath: input.storePath,
    projectId: input.project_id,
    projectPath: input.project_path,
    currentTask: input.current_task,
    agent: { client: input.hook.host, session_id: input.hook.session_id, device_id: input.hook.device_id }
  };
}

function contextText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function sessionSynthesis(input: RunHostHookInput, projectId: string): Promise<SessionSynthesis> {
  try {
    const engine = createEngine({ storePath: input.storePath });
    const boot = await engine.boot({ project_id: projectId, agent_session_id: input.hook.session_id });
    return synthesizeSession({ host_summary: input.hook.compact_summary, current_task: input.current_task, recovery_pack: boot.checkpoint_recovery_pack });
  } catch {
    return synthesizeSession({ host_summary: input.hook.compact_summary, current_task: input.current_task });
  }
}

export async function runHostHook(input: RunHostHookInput, deps: RunHostHookDeps = {}): Promise<HostHookRunResult> {
  const project = await resolveProjectContext({ projectId: input.project_id, projectPath: input.project_path ?? input.hook.cwd });
  const capabilities = getHostCapabilities(input.hook.host);
  const native = capabilities.events[input.hook.event];
  const degradation = native
    ? { mode: "native" as const }
    : { mode: "fallback" as const, reason: "host_hook_unavailable" as const };
  const common = lifecycleInput({ ...input, project_id: project.project_id, project_path: input.project_id && !input.project_path ? undefined : project.project_path });
  let activation_receipt: Awaited<ReturnType<typeof recordActivationReceipt>> | undefined;
  let activation_warning: HostHookRunResult["activation_warning"];
  if (input.activation_id && input.hook.event !== "user_prompt_submit" && (input.hook.host === "codex" || input.hook.host === "claude")) {
    try {
      const expectedArtifact = buildHostIntegrationArtifact({ host: input.hook.host, project_id: project.project_id, project_path: project.project_path, store_path: input.storePath });
      if (input.activation_id !== expectedArtifact.activation_id) throw new Error(`Activation ID mismatch: expected ${expectedArtifact.activation_id}`);
      activation_receipt = await recordActivationReceipt(input.storePath, {
        activation_id: input.activation_id,
        host: input.hook.host,
        project_id: project.project_id,
        event: input.hook.event,
        session_id: input.hook.session_id,
        device_id: input.hook.device_id,
        occurred_at: input.hook.occurred_at,
        command_digest: input.command_digest ?? expectedArtifact.command_digest
      } satisfies ActivationReceiptInput);
    } catch (error) {
      activation_warning = { code: "ACTIVATION_RECEIPT_FAILED", reason: error instanceof Error ? error.message : String(error) };
    }
  }
  const activationEvidence = {
    ...(activation_receipt ? { activation_receipt } : {}),
    ...(activation_warning ? { activation_warning } : {})
  };
  if (input.hook.event === "user_prompt_submit") {
    const engine = createEngine({ storePath: input.storePath });
    const recall = await engine.recall({
      query: input.hook.prompt,
      project_id: project.project_id,
      kinds: ["memory", "skill", "soul"],
      limit: 3,
      include_private: false
    });
    const promptRecall = buildPromptRecallContext({ outcome: recall.outcome!, results: recall.results });
    return {
      ok: true,
      event: input.hook.event,
      action: "recall_prompt",
      degradation,
      hook_output: { additional_context: promptRecall.additional_context },
      prompt_recall: {
        outcome: recall.outcome!,
        injected: promptRecall.injected,
        record_count: promptRecall.record_count
      },
      ...activationEvidence
    };
  }
  if (input.hook.event === "session_start" || input.hook.event === "post_compact") {
    const result = await agentStart({ ...common, pull: input.pull });
    return {
      ok: true as const,
      event: input.hook.event,
      action: input.hook.event === "session_start" ? "agent_start" as const : "resume_from_checkpoint" as const,
      degradation,
      details: result,
      hook_output: { additional_context: contextText({ current_task: input.current_task, startup_overview: result.startup_overview, checkpoint_recovery_pack: result.boot.checkpoint_recovery_pack, active_checkpoint: result.boot.active_checkpoint }) },
      ...activationEvidence
    };
  }
  if (input.hook.event === "pre_compact") {
    const engine = createEngine({ storePath: input.storePath });
    const summary = input.hook.compact_summary ?? `Checkpoint before ${input.hook.trigger ?? "compaction"}`;
    const checkpoint = await engine.checkpoint({
      project_id: project.project_id,
      source: { client: input.hook.host, session_id: input.hook.session_id, device_id: input.hook.device_id },
      occurred_at: input.hook.occurred_at,
      delta: {
        session_id: input.hook.session_id,
        checkpoint_id: checkpointId(input.hook),
        current_task: input.current_task,
        progress: [summary],
        learnings: input.learnings ?? [],
        knowledge_investigations: input.knowledge_investigations ?? [],
        semantic_consolidation_proposals: input.semantic_consolidation_proposals ?? []
      }
    });
    let checkpointSync: HostHookCheckpointSync;
    if (input.push === true) {
      checkpointSync = { requested: true, reason: "explicit_push" };
    } else if (input.push === false) {
      checkpointSync = { requested: false, reason: "explicit_no_push" };
    } else if (project.config?.sync.mode === "manual") {
      checkpointSync = { requested: false, reason: "manual_mode" };
    } else if (checkpoint.idempotent_replay) {
      checkpointSync = { requested: false, reason: "idempotent_replay" };
    } else {
      checkpointSync = { requested: true, reason: "new_checkpoint" };
    }
    if (checkpointSync.requested) {
      try {
        checkpointSync.push = await (deps.pushGitSync ?? pushGitSync)(input.storePath, { message: `precompact checkpoint: ${project.project_id}` });
        checkpointSync.succeeded = checkpointSync.push.ok;
        if (!checkpointSync.succeeded) checkpointSync.error = checkpointSync.push.message ?? "remote synchronization failed";
      } catch (error) {
        checkpointSync.succeeded = false;
        checkpointSync.error = error instanceof Error ? error.message : String(error);
      }
    }
    const additionalContext = checkpointSync.succeeded === false
      ? `Moryn checkpoint saved and locally protected: ${checkpoint.record.id}. Remote synchronization is pending.`
      : `Moryn checkpoint saved: ${checkpoint.record.id}`;
    return { ok: true, event: input.hook.event, action: "checkpoint_before_compaction", degradation, checkpoint, checkpoint_sync: checkpointSync, hook_output: { additional_context: additionalContext }, ...activationEvidence };
  }
  if (input.hook.event === "session_end") {
    const synthesis = await sessionSynthesis(input, project.project_id);
    const result = await agentFinish({ ...common, summary: synthesis.summary, synthesis, push: input.push, learnings: input.learnings, semanticConsolidationProposals: input.semantic_consolidation_proposals });
    return { ok: true, event: input.hook.event, action: "agent_finish", degradation, details: result, hook_output: { additional_context: `Moryn handoff saved: ${result.record.id}` }, ...activationEvidence };
  }
  const synthesis = await sessionSynthesis(input, project.project_id);
  if (input.hook.event === "stop" && synthesis.mode === "minimal_fallback") {
    return {
      ok: true,
      event: input.hook.event,
      action: "skip_empty_status",
      degradation,
      skipped: { reason: "no_durable_session_evidence" },
      hook_output: { additional_context: "Moryn skipped an empty turn status because no durable session evidence was available." },
      ...activationEvidence
    };
  }
  let syncCadence: HostHookSyncCadence | undefined;
  let push = input.push;
  if (input.hook.event === "stop") {
    const identity = {
      project_id: project.project_id,
      host: input.hook.host,
      session_id: input.hook.session_id,
      device_id: input.hook.device_id,
      occurred_at: input.hook.occurred_at
    };
    if (input.push === true) {
      syncCadence = { due: true, reason: "explicit_push", interval_minutes: 15, push_requested: true };
    } else if (input.push === false) {
      syncCadence = { due: false, reason: "explicit_no_push", interval_minutes: 15, push_requested: false };
    } else if (project.config?.sync.mode === "manual") {
      syncCadence = { due: false, reason: "manual_mode", interval_minutes: 15, push_requested: false };
      push = false;
    } else {
      const decision = await evaluateTurnSyncCadence(input.storePath, identity);
      syncCadence = { ...decision, push_requested: decision.due };
      push = decision.due;
    }
    const result = await agentStatus({ ...common, status: synthesis.summary, synthesis, push }, { pushGitSync: deps.pushGitSync });
    if (syncCadence.push_requested) {
      syncCadence.push_succeeded = result.sync.push?.ok === true;
      if (syncCadence.push_succeeded) await recordTurnSyncSuccess(input.storePath, identity);
    }
    return { ok: true, event: input.hook.event, action: "agent_status", degradation, details: result, sync_cadence: syncCadence, hook_output: { additional_context: `Moryn status saved: ${result.record.id}` }, ...activationEvidence };
  }
  const result = await agentStatus({ ...common, status: synthesis.summary, synthesis, push }, { pushGitSync: deps.pushGitSync });
  return { ok: true, event: input.hook.event, action: "agent_status", degradation, details: result, hook_output: { additional_context: `Moryn status saved: ${result.record.id}` }, ...activationEvidence };
}
