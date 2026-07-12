import { createHash } from "node:crypto";
import { agentFinish, agentStart, agentStatus, buildLearningCandidateReviewAction } from "./agent-lifecycle.js";
import { createEngine } from "./engine.js";
import { getHostCapabilities } from "./host-capabilities.js";
import type { NormalizedHostHookEvent } from "./host-hooks.js";
import { learningDeltaSchema, semanticConsolidationProposalSchema, type KnowledgeInvestigationInput, type LearningDeltaInput, type SemanticConsolidationProposalInput } from "./context-delta.js";
import { resolveProjectContext } from "./project.js";
import { recordActivationReceipt, type ActivationReceiptInput } from "./activation-receipts.js";
import { buildHostIntegrationArtifact } from "./host-integration-artifacts.js";
import { synthesizeSession, type SessionSynthesis } from "./session-synthesis.js";
import { buildPromptRecallContext } from "./host-prompt-recall.js";
import { evaluateTurnSyncCadence, recordTurnSyncSuccess, type TurnSyncCadenceDecision } from "./turn-sync-cadence.js";
import { isGitSyncConfigured, pushGitSync, type GitSyncResult } from "../sync/git.js";
import { readCurrentRecords } from "./record-read-model.js";
import { unresolvedLearningCandidates } from "./learning-candidate-review.js";

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
  isGitSyncConfigured?: typeof isGitSyncConfigured;
}

export type HostHookSyncCadence = {
  due: boolean;
  reason: TurnSyncCadenceDecision["reason"] | "explicit_push" | "explicit_no_push" | "manual_mode" | "remote_unconfigured";
  interval_minutes: 15;
  last_success_at?: string;
  push_requested: boolean;
  push_succeeded?: boolean;
};

export type HostHookCheckpointSync = {
  requested: boolean;
  reason: "explicit_push" | "explicit_no_push" | "manual_mode" | "remote_unconfigured" | "new_checkpoint" | "idempotent_replay";
  succeeded?: boolean;
  push?: GitSyncResult;
  error?: string;
};

export type HostHookDuplicateHandoffSync = {
  requested: boolean;
  succeeded?: boolean;
  push?: GitSyncResult;
  error?: string;
};

export interface HostHookRunResult {
  ok: true;
  event: NormalizedHostHookEvent["event"];
  action: "agent_start" | "recall_prompt" | "checkpoint_before_compaction" | "resume_from_checkpoint" | "agent_status" | "agent_finish" | "skip_empty_status" | "skip_duplicate_status" | "skip_duplicate_handoff";
  degradation: { mode: "native" } | { mode: "fallback"; reason: "host_hook_unavailable" };
  hook_output: { additional_context: string };
  checkpoint?: { idempotent_replay: boolean; record: { id: string } };
  checkpoint_sync?: HostHookCheckpointSync;
  activation_receipt?: Awaited<ReturnType<typeof recordActivationReceipt>>;
  activation_warning?: { code: "ACTIVATION_RECEIPT_FAILED"; reason: string };
  skipped?: { reason: "no_durable_session_evidence" };
  duplicate_status?: { prior_record_id: string };
  duplicate_handoff?: { prior_record_id: string };
  duplicate_handoff_sync?: HostHookDuplicateHandoffSync;
  details?: unknown;
  prompt_recall?: {
    outcome: { status: "trusted_match" | "verification_required" | "knowledge_gap"; best_record_id?: string };
    injected: boolean;
    record_count: number;
  };
  sync_cadence?: HostHookSyncCadence;
}

function synthesisFingerprint(synthesis: SessionSynthesis): string {
  return JSON.stringify({
    version: synthesis.version,
    mode: synthesis.mode,
    summary: synthesis.summary,
    current_task: synthesis.current_task,
    progress: synthesis.progress,
    decisions: synthesis.decisions,
    blockers: synthesis.blockers,
    next_steps: synthesis.next_steps,
    learning_conclusions: synthesis.learning_conclusions,
    unresolved_investigations: synthesis.unresolved_investigations,
    source_record_ids: synthesis.source_record_ids
  });
}

function recordSynthesisFingerprint(content: Record<string, unknown>): string | undefined {
  if (content.synthesis_version !== 1 || typeof content.synthesis_mode !== "string") return undefined;
  return JSON.stringify({
    version: content.synthesis_version,
    mode: content.synthesis_mode,
    summary: content.text,
    current_task: content.synthesis_current_task,
    progress: content.synthesis_progress,
    decisions: content.synthesis_decisions,
    blockers: content.synthesis_blockers,
    next_steps: content.synthesis_next_steps,
    learning_conclusions: content.synthesis_learning_conclusions,
    unresolved_investigations: content.synthesis_unresolved_investigations,
    source_record_ids: content.synthesis_source_record_ids
  });
}

function sessionEndPayloadFingerprint(input: RunHostHookInput, synthesis: SessionSynthesis): string {
  const learnings = (input.learnings ?? [])
    .map((learning) => learningDeltaSchema.parse(learning))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const proposals = (input.semantic_consolidation_proposals ?? [])
    .map((proposal) => semanticConsolidationProposalSchema.parse(proposal))
    .sort((left, right) => left.proposal_id.localeCompare(right.proposal_id) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify({ synthesis: JSON.parse(synthesisFingerprint(synthesis)), learnings, proposals })).digest("hex");
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
  let syncConfigured: boolean | undefined;
  const hasConfiguredSync = async () => syncConfigured ??= await (deps.isGitSyncConfigured ?? isGitSyncConfigured)(input.storePath);
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
    const promptRecall = buildPromptRecallContext({
      outcome: recall.outcome!,
      results: recall.results,
      question: input.hook.prompt!,
      capture_context: {
        project_id: project.project_id,
        current_task: input.current_task,
        agent: {
          client: input.hook.host,
          session_id: input.hook.session_id,
          device_id: input.hook.device_id
        }
      }
    });
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
    const pull = input.pull !== undefined
      ? input.pull
      : project.config?.sync.mode === "manual"
        ? false
        : await hasConfiguredSync();
    const result = await agentStart({ ...common, pull });
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
    } else if (!await hasConfiguredSync()) {
      checkpointSync = { requested: false, reason: "remote_unconfigured" };
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
    const candidateReview = buildLearningCandidateReviewAction(
      project.project_id,
      unresolvedLearningCandidates(checkpoint.learning_ingestion.semantic_candidates.candidates, checkpoint.semantic_consolidation)
    );
    const candidateContext = candidateReview
      ? `${additionalContext} Moryn found ${candidateReview.candidate_pairs.length} bounded semantic candidate pair(s); follow candidate_review recalls before proposing a relationship.`
      : additionalContext;
    return {
      ok: true,
      event: input.hook.event,
      action: "checkpoint_before_compaction",
      degradation,
      checkpoint,
      checkpoint_sync: checkpointSync,
      ...(candidateReview ? { candidate_review: candidateReview } : {}),
      hook_output: { additional_context: candidateContext },
      ...activationEvidence
    };
  }
  if (input.hook.event === "session_end") {
    const synthesis = await sessionSynthesis(input, project.project_id);
    const payloadFingerprint = sessionEndPayloadFingerprint(input, synthesis);
    const push = input.push !== undefined
      ? input.push
      : project.config?.sync.mode === "manual"
        ? false
        : await hasConfiguredSync();
    const current = await readCurrentRecords(input.storePath);
    const priorSummary = current.records
      .filter((record) =>
        record.project_id === project.project_id
        && record.type === "summary"
        && record.source.client === input.hook.host
        && record.source.session_id === input.hook.session_id
        && record.source.device_id === input.hook.device_id
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))[0];
    if (priorSummary?.content.handoff_payload_fingerprint === payloadFingerprint) {
      const duplicateSync: HostHookDuplicateHandoffSync = { requested: input.push === true };
      if (duplicateSync.requested) {
        try {
          duplicateSync.push = await (deps.pushGitSync ?? pushGitSync)(input.storePath, { message: `agent finish: ${project.project_id}` });
          duplicateSync.succeeded = duplicateSync.push.ok;
          if (!duplicateSync.succeeded) duplicateSync.error = duplicateSync.push.message ?? "remote synchronization failed";
        } catch (error) {
          duplicateSync.succeeded = false;
          duplicateSync.error = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        ok: true,
        event: input.hook.event,
        action: "skip_duplicate_handoff",
        degradation,
        duplicate_handoff: { prior_record_id: priorSummary.id },
        duplicate_handoff_sync: duplicateSync,
        hook_output: { additional_context: `Moryn reused unchanged handoff: ${priorSummary.id}` },
        ...activationEvidence
      };
    }
    const result = await agentFinish({ ...common, summary: synthesis.summary, synthesis, push, learnings: input.learnings, semanticConsolidationProposals: input.semantic_consolidation_proposals }, { pushGitSync: deps.pushGitSync, handoffPayloadFingerprint: payloadFingerprint });
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
    } else if (!await hasConfiguredSync()) {
      syncCadence = { due: false, reason: "remote_unconfigured", interval_minutes: 15, push_requested: false };
      push = false;
    } else {
      const decision = await evaluateTurnSyncCadence(input.storePath, identity);
      syncCadence = { ...decision, push_requested: decision.due };
      push = decision.due;
    }
    const current = await readCurrentRecords(input.storePath);
    const priorStatus = current.records
      .filter((record) =>
        record.project_id === project.project_id
        && record.type === "status"
        && record.source.client === input.hook.host
        && record.source.session_id === input.hook.session_id
        && record.source.device_id === input.hook.device_id
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))[0];
    if (priorStatus && recordSynthesisFingerprint(priorStatus.content) === synthesisFingerprint(synthesis)) {
      if (syncCadence.push_requested) {
        try {
          const pushed = await (deps.pushGitSync ?? pushGitSync)(input.storePath, { message: `agent status: ${project.project_id}` });
          syncCadence.push_succeeded = pushed.ok;
          if (pushed.ok) await recordTurnSyncSuccess(input.storePath, identity);
        } catch {
          syncCadence.push_succeeded = false;
        }
      }
      return {
        ok: true,
        event: input.hook.event,
        action: "skip_duplicate_status",
        degradation,
        duplicate_status: { prior_record_id: priorStatus.id },
        sync_cadence: syncCadence,
        hook_output: { additional_context: `Moryn reused unchanged status: ${priorStatus.id}` },
        ...activationEvidence
      };
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
