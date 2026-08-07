import { createHash } from "node:crypto";
import type { getGitSyncStatus, pullGitSync, pushGitSync } from "../sync/git.js";
import { type GitSyncResult, isGitSyncConfigured } from "../sync/git.js";
import { type ActivationReceiptInput, recordActivationReceipt } from "./activation-receipts.js";
import {
  type AgentLifecycleDeps,
  agentFinish,
  agentStart,
  agentStatus,
  buildLearningCandidateReviewAction
} from "./agent-lifecycle.js";
import {
  type KnowledgeInvestigationInput,
  type LearningDeltaInput,
  learningDeltaSchema,
  type SemanticConsolidationProposalInput,
  semanticConsolidationProposalSchema
} from "./context-delta.js";
import { createEngine } from "./engine.js";
import { getHostCapabilities } from "./host-capabilities.js";
import { type HostHookExecutionStage, recordHostHookExecutionReceipt } from "./host-hook-receipts.js";
import type { NormalizedHostHookEvent } from "./host-hooks.js";
import { buildHostIntegrationArtifact, type HostRuntimeDescriptor } from "./host-integration-artifacts.js";
import { buildPromptRecallContext } from "./host-prompt-recall.js";
import {
  defaultHostTranscriptRoots,
  type HostTranscriptEvidence,
  readHostTranscriptEvidence
} from "./host-transcript-evidence.js";
import { unresolvedLearningCandidates } from "./learning-candidate-review.js";
import {
  isOperationCancelled,
  isOperationDeadlineExceeded,
  rethrowIfOperationDeadlineExceeded,
  throwIfOperationDeadlineExceeded,
  withoutOperationDeadline
} from "./operation-deadline.js";
import { readPendingHostFollowUp, writePendingHostFollowUp } from "./pending-host-follow-up.js";
import { type ProjectContext, resolveProjectContext } from "./project.js";
import { readCurrentRecords } from "./record-read-model.js";
import { detectSensitiveContent } from "./sensitive.js";
import { type SessionSynthesis, synthesizeSession } from "./session-synthesis.js";
import { deliverEffectiveSoul } from "./soul-host-delivery.js";
import { evaluateTurnSyncCadence, type TurnSyncCadenceDecision } from "./turn-sync-cadence.js";

export interface RunHostHookInput {
  storePath: string;
  hook: NormalizedHostHookEvent;
  project_id?: string;
  project_path?: string;
  current_task?: string;
  hostRuntime?: HostRuntimeDescriptor;
  pull?: boolean;
  push?: boolean;
  learnings?: LearningDeltaInput[];
  knowledge_investigations?: KnowledgeInvestigationInput[];
  semantic_consolidation_proposals?: SemanticConsolidationProposalInput[];
  activation_id?: string;
  command_digest?: string;
  transcript_roots?: string[];
}

export interface RunHostHookDeps {
  getGitSyncStatus?: typeof getGitSyncStatus;
  pullGitSync?: typeof pullGitSync;
  pushGitSync?: typeof pushGitSync;
  isGitSyncConfigured?: typeof isGitSyncConfigured;
  writePendingHostFollowUp?: typeof writePendingHostFollowUp;
}

export type HostHookSyncCadence = {
  due: boolean;
  reason:
    | TurnSyncCadenceDecision["reason"]
    | "explicit_push"
    | "explicit_no_push"
    | "manual_mode"
    | "remote_unconfigured";
  interval_minutes: 15;
  last_success_at?: string;
  push_requested: boolean;
  push_succeeded?: boolean;
  deferred?: HostHookDeferredWork;
};

export type HostHookCheckpointSync = {
  requested: boolean;
  reason:
    | "explicit_push"
    | "explicit_no_push"
    | "manual_mode"
    | "remote_unconfigured"
    | "new_checkpoint"
    | "idempotent_replay";
  succeeded?: boolean;
  deferred?: HostHookDeferredWork;
  push?: GitSyncResult;
  error?: string;
};

export type HostHookDuplicateHandoffSync = {
  requested: boolean;
  succeeded?: boolean;
  deferred?: HostHookDeferredWork;
  push?: GitSyncResult;
  error?: string;
};

export interface HostHookDeferredWork {
  work: "pull" | "checkpoint_sync" | "handoff_sync" | "status_sync";
  reason: "operation_deadline_budget" | "host_hook_local_fast_path";
  remaining_ms?: number;
  minimum_remaining_ms?: number;
}

export type HostTranscriptEvidenceSummary = Pick<
  HostTranscriptEvidence,
  "status" | "reason" | "lines_considered" | "malformed_lines" | "truncated"
> & {
  source: "hook_payload" | "transcript" | "none";
};

type SafeHostLifecycleEvidence = {
  compactSummary?: string;
  assistant?: string;
  summary: HostTranscriptEvidenceSummary;
};

export interface HostHookRunResult {
  ok: true;
  event: NormalizedHostHookEvent["event"];
  action:
    | "agent_start"
    | "defer_to_session_start"
    | "recall_prompt"
    | "checkpoint_before_compaction"
    | "resume_from_checkpoint"
    | "agent_status"
    | "agent_finish"
    | "skip_empty_status"
    | "skip_duplicate_status"
    | "skip_duplicate_handoff";
  degradation: { mode: "native" } | { mode: "fallback"; reason: "host_hook_unavailable" };
  hook_output: { additional_context: string };
  checkpoint?: { idempotent_replay: boolean; record: { id: string } };
  checkpoint_sync?: HostHookCheckpointSync;
  activation_receipt?: Awaited<ReturnType<typeof recordActivationReceipt>>;
  activation_warning?: { code: "ACTIVATION_RECEIPT_FAILED"; reason: string };
  pending_follow_up_warning?: { code: "PENDING_FOLLOW_UP_WRITE_FAILED"; reason: string };
  soul_delivery?: Awaited<ReturnType<typeof deliverEffectiveSoul>>;
  skipped?: { reason: "no_durable_session_evidence" };
  duplicate_status?: { prior_record_id: string };
  duplicate_handoff?: { prior_record_id: string };
  duplicate_handoff_sync?: HostHookDuplicateHandoffSync;
  details?: unknown;
  prompt_recall?: {
    outcome: { status: "trusted_match" | "verification_required" | "knowledge_gap"; best_record_id?: string };
    injected: boolean;
    record_count: number;
    historical_recovery?: { status: "not_found" | "recovered" | "unavailable"; record_ids: string[] };
  };
  sync_cadence?: HostHookSyncCadence;
  transcript_evidence?: HostTranscriptEvidenceSummary;
  deferred_work?: HostHookDeferredWork[];
}

function deferRemoteWork(work: HostHookDeferredWork["work"]): HostHookDeferredWork {
  return { work, reason: "host_hook_local_fast_path" };
}

function localHostLifecycleDeps(deps: RunHostHookDeps): AgentLifecycleDeps {
  return {
    getGitSyncStatus: deps.getGitSyncStatus,
    pullGitSync: deps.pullGitSync,
    pushGitSync: deps.pushGitSync,
    allowRemoteSync: false,
    allowSlowMaintenance: false
  };
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
    .sort(
      (left, right) =>
        left.proposal_id.localeCompare(right.proposal_id) || JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  return createHash("sha256")
    .update(JSON.stringify({ synthesis: JSON.parse(synthesisFingerprint(synthesis)), learnings, proposals }))
    .digest("hex");
}

function checkpointId(hook: NormalizedHostHookEvent): string {
  const digest = createHash("sha256")
    .update(`${hook.host}\u0000${hook.session_id}\u0000${hook.occurred_at}\u0000${hook.trigger ?? "compact"}`)
    .digest("hex");
  return `hook-${digest.slice(0, 24)}`;
}

function lifecycleInput(input: RunHostHookInput) {
  return {
    storePath: input.storePath,
    projectId: input.project_id,
    projectPath: input.project_path,
    currentTask: input.current_task,
    hostRuntime: input.hostRuntime,
    agent: { client: input.hook.host, session_id: input.hook.session_id, device_id: input.hook.device_id }
  };
}

function contextText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function pendingFollowUpIdentity(input: RunHostHookInput, projectId: string) {
  return {
    project_id: projectId,
    host: input.hook.host,
    session_id: input.hook.session_id,
    device_id: input.hook.device_id
  };
}

function agentFollowUpContext(action: unknown) {
  return {
    version: 1 as const,
    reason: "learning_candidates_require_agent_review" as const,
    action,
    instruction:
      "Recall the supplied record ids before proposing a semantic relationship; no routine user confirmation is required."
  };
}

function evidenceSummary(
  evidence: HostTranscriptEvidence,
  source: HostTranscriptEvidenceSummary["source"]
): HostTranscriptEvidenceSummary {
  return {
    status: evidence.status,
    ...(evidence.reason ? { reason: evidence.reason } : {}),
    lines_considered: evidence.lines_considered,
    malformed_lines: evidence.malformed_lines,
    truncated: evidence.truncated,
    source
  };
}

function protectedHookPayloadEvidence(): HostTranscriptEvidenceSummary {
  return {
    status: "protected",
    reason: "sensitive_content",
    lines_considered: 0,
    malformed_lines: 0,
    truncated: false,
    source: "hook_payload"
  };
}

async function hookTranscriptEvidence(
  input: RunHostHookInput
): Promise<{ assistant?: string; summary: HostTranscriptEvidenceSummary }> {
  const payloadAssistant = input.hook.last_assistant_message?.trim();
  if (payloadAssistant) {
    if (detectSensitiveContent(payloadAssistant).sensitive)
      return {
        summary: protectedHookPayloadEvidence()
      };
    return {
      assistant: payloadAssistant,
      summary: {
        status: "available",
        lines_considered: 0,
        malformed_lines: 0,
        truncated: false,
        source: "hook_payload"
      }
    };
  }
  if (!input.hook.transcript_path)
    return {
      summary: {
        status: "unavailable",
        reason: "missing_path",
        lines_considered: 0,
        malformed_lines: 0,
        truncated: false,
        source: "none"
      }
    };
  const host = input.hook.host === "claude" ? "claude" : "codex";
  const evidence = await readHostTranscriptEvidence({
    host,
    transcript_path: input.hook.transcript_path,
    allowed_roots: input.transcript_roots?.length ? input.transcript_roots : defaultHostTranscriptRoots(host)
  });
  return {
    ...(evidence.last_assistant_message ? { assistant: evidence.last_assistant_message } : {}),
    summary: evidenceSummary(evidence, "transcript")
  };
}

async function safeHostLifecycleEvidence(input: RunHostHookInput): Promise<SafeHostLifecycleEvidence> {
  const compactSummary = input.hook.compact_summary;
  if (compactSummary && detectSensitiveContent(compactSummary).sensitive) {
    return { summary: protectedHookPayloadEvidence() };
  }
  const transcriptEvidence = await hookTranscriptEvidence(input);
  return {
    ...(compactSummary ? { compactSummary } : {}),
    ...transcriptEvidence
  };
}

async function sessionSynthesis(
  input: RunHostHookInput,
  projectId: string,
  compactSummary?: string,
  assistantEvidence?: string
): Promise<SessionSynthesis> {
  try {
    const engine = createEngine({ storePath: input.storePath });
    const boot = await engine.boot({ project_id: projectId, agent_session_id: input.hook.session_id });
    const recovery = boot.checkpoint_recovery_pack;
    const hasRecoveryEvidence =
      recovery?.available === true &&
      Boolean(
        recovery.progress?.length ||
          recovery.decisions?.length ||
          recovery.blockers?.length ||
          recovery.next_steps?.length ||
          recovery.learnings?.length ||
          recovery.source_record_ids?.length
      );
    return synthesizeSession({
      host_summary: compactSummary ?? (hasRecoveryEvidence ? undefined : assistantEvidence),
      current_task: input.current_task,
      recovery_pack: recovery
    });
  } catch (error) {
    rethrowIfOperationDeadlineExceeded(error);
    return synthesizeSession({
      host_summary: compactSummary ?? assistantEvidence,
      current_task: input.current_task
    });
  }
}

async function runResolvedHostHook(
  input: RunHostHookInput,
  deps: RunHostHookDeps,
  project: ProjectContext,
  setStage: (stage: HostHookExecutionStage) => void
): Promise<HostHookRunResult> {
  let syncConfigured: boolean | undefined;
  const hasConfiguredSync = async () =>
    (syncConfigured ??= await (deps.isGitSyncConfigured ?? isGitSyncConfigured)(input.storePath));
  const capabilities = getHostCapabilities(input.hook.host);
  const native = capabilities.events[input.hook.event];
  const degradation = native
    ? { mode: "native" as const }
    : { mode: "fallback" as const, reason: "host_hook_unavailable" as const };
  const common = lifecycleInput({
    ...input,
    project_id: project.project_id,
    project_path: input.project_id && !input.project_path ? undefined : project.project_path
  });
  let activation_receipt: Awaited<ReturnType<typeof recordActivationReceipt>> | undefined;
  let activation_warning: HostHookRunResult["activation_warning"];
  if (
    input.activation_id &&
    input.hook.event !== "user_prompt_submit" &&
    (input.hook.host === "codex" || input.hook.host === "claude")
  ) {
    setStage("activation_receipt");
    try {
      const expectedArtifact = buildHostIntegrationArtifact({
        host: input.hook.host,
        project_id: project.project_id,
        project_path: project.project_path,
        store_path: input.storePath,
        runtime: input.hostRuntime
      });
      if (input.activation_id !== expectedArtifact.activation_id)
        throw new Error(`Activation ID mismatch: expected ${expectedArtifact.activation_id}`);
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
      rethrowIfOperationDeadlineExceeded(error);
      activation_warning = {
        code: "ACTIVATION_RECEIPT_FAILED",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }
  const activationEvidence = {
    ...(activation_receipt ? { activation_receipt } : {}),
    ...(activation_warning ? { activation_warning } : {})
  };
  if (input.hook.event === "user_prompt_submit") {
    setStage("recall");
    const engine = createEngine({ storePath: input.storePath });
    const primaryRecall = await engine.recall({
      query: input.hook.prompt,
      project_id: project.project_id,
      kinds: ["memory", "skill", "soul"],
      limit: 3,
      include_private: false
    });
    let recall = primaryRecall;
    if (primaryRecall.outcome?.status !== "trusted_match") {
      const sessionRecall = await engine.recall({
        query: input.hook.prompt,
        project_id: project.project_id,
        kinds: ["session_summary"],
        limit: 3,
        include_private: false
      });
      const statusRank = { knowledge_gap: 0, verification_required: 1, trusted_match: 2 } as const;
      const primaryRank = statusRank[primaryRecall.outcome!.status];
      const sessionRank = statusRank[sessionRecall.outcome!.status];
      if (
        sessionRank > primaryRank ||
        (sessionRank === primaryRank && sessionRecall.outcome!.coverage > primaryRecall.outcome!.coverage)
      )
        recall = sessionRecall;
    }
    const promptRecall = buildPromptRecallContext({
      outcome: recall.outcome!,
      results: recall.results,
      question: input.hook.prompt!,
      historical_recovery: recall.historical_recovery,
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
        record_count: promptRecall.record_count,
        ...(recall.historical_recovery
          ? {
              historical_recovery: {
                status: recall.historical_recovery.status,
                record_ids: recall.historical_recovery.matches.map((match) => match.record_id)
              }
            }
          : {})
      },
      ...activationEvidence
    };
  }
  if (input.hook.event === "post_compact") {
    return {
      ok: true,
      event: input.hook.event,
      action: "defer_to_session_start",
      degradation,
      hook_output: { additional_context: "" },
      ...activationEvidence
    };
  }
  if (input.hook.event === "session_start") {
    setStage("start");
    const requestedPull =
      input.pull !== undefined
        ? input.pull
        : project.config?.sync.mode === "manual"
          ? false
          : await hasConfiguredSync();
    const pullDeferred = requestedPull ? deferRemoteWork("pull") : undefined;
    const result = await agentStart({ ...common, pull: false }, localHostLifecycleDeps(deps));
    const pendingFollowUp =
      input.hook.trigger?.trim().toLowerCase() === "compact"
        ? await readPendingHostFollowUp(input.storePath, pendingFollowUpIdentity(input, project.project_id), {
            now: () => input.hook.occurred_at
          })
        : undefined;
    const soulDelivery = await deliverEffectiveSoul({
      store_path: input.storePath,
      effective_soul: result.effective_soul,
      host: input.hook.host,
      project_id: project.project_id,
      session_id: input.hook.session_id,
      device_id: input.hook.device_id,
      event: input.hook.event,
      occurred_at: input.hook.occurred_at
    });
    const restoreContext = contextText({
      current_task: input.current_task,
      startup_overview: result.startup_overview,
      finalization_assurance:
        result.finalization_assurance.status === "recovered"
          ? {
              status: result.finalization_assurance.status,
              prior_session: result.finalization_assurance.prior_session,
              recovered_handoff_record_id: result.finalization_assurance.recovered_handoff_record_id,
              learning_inbox: result.finalization_assurance.learning_inbox
            }
          : { status: result.finalization_assurance.status },
      checkpoint_recovery_pack: result.boot.checkpoint_recovery_pack,
      active_checkpoint: result.boot.active_checkpoint,
      effective_soul: soulDelivery.context,
      ...(pendingFollowUp ? { moryn_follow_up: agentFollowUpContext(pendingFollowUp.action) } : {})
    });
    return {
      ok: true as const,
      event: input.hook.event,
      action: "agent_start",
      degradation,
      details: result,
      soul_delivery: soulDelivery,
      hook_output: { additional_context: restoreContext },
      ...(pullDeferred ? { deferred_work: [pullDeferred] } : {}),
      ...activationEvidence
    };
  }
  if (input.hook.event === "pre_compact") {
    setStage("checkpoint");
    const engine = createEngine({ storePath: input.storePath });
    const hostEvidence = await safeHostLifecycleEvidence(input);
    const summary =
      hostEvidence.compactSummary ??
      hostEvidence.assistant ??
      `Checkpoint before ${input.hook.trigger ?? "compaction"}`;
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
    } else if (!(await hasConfiguredSync())) {
      checkpointSync = { requested: false, reason: "remote_unconfigured" };
    } else if (checkpoint.idempotent_replay) {
      checkpointSync = { requested: false, reason: "idempotent_replay" };
    } else {
      checkpointSync = { requested: true, reason: "new_checkpoint" };
    }
    if (checkpointSync.requested) checkpointSync.deferred = deferRemoteWork("checkpoint_sync");
    const additionalContext =
      checkpointSync.deferred || checkpointSync.succeeded === false
        ? `Moryn checkpoint saved and locally protected: ${checkpoint.record.id}. Remote synchronization is pending.`
        : `Moryn checkpoint saved: ${checkpoint.record.id}`;
    const candidateReview = buildLearningCandidateReviewAction(
      project.project_id,
      unresolvedLearningCandidates(
        checkpoint.learning_ingestion.semantic_candidates.candidates,
        checkpoint.semantic_consolidation
      )
    );
    let pendingFollowUpWarning: HostHookRunResult["pending_follow_up_warning"];
    if (candidateReview)
      try {
        await (deps.writePendingHostFollowUp ?? writePendingHostFollowUp)(
          input.storePath,
          { ...pendingFollowUpIdentity(input, project.project_id), action: candidateReview },
          { now: () => input.hook.occurred_at }
        );
      } catch (error) {
        rethrowIfOperationDeadlineExceeded(error);
        pendingFollowUpWarning = {
          code: "PENDING_FOLLOW_UP_WRITE_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        };
      }
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
      ...(pendingFollowUpWarning ? { pending_follow_up_warning: pendingFollowUpWarning } : {}),
      transcript_evidence: hostEvidence.summary,
      hook_output: { additional_context: candidateContext },
      ...(checkpointSync.deferred ? { deferred_work: [checkpointSync.deferred] } : {}),
      ...activationEvidence
    };
  }
  if (input.hook.event === "session_end") {
    setStage("synthesis");
    const hostEvidence = await safeHostLifecycleEvidence(input);
    const synthesis = await sessionSynthesis(
      input,
      project.project_id,
      hostEvidence.compactSummary,
      hostEvidence.assistant
    );
    const payloadFingerprint = sessionEndPayloadFingerprint(input, synthesis);
    const requestedPush =
      input.push !== undefined
        ? input.push
        : project.config?.sync.mode === "manual"
          ? false
          : await hasConfiguredSync();
    const pushDeferred = requestedPush ? deferRemoteWork("handoff_sync") : undefined;
    const current = await readCurrentRecords(input.storePath);
    const priorSummary = current.records
      .filter(
        (record) =>
          record.project_id === project.project_id &&
          record.type === "summary" &&
          record.source.client === input.hook.host &&
          record.source.session_id === input.hook.session_id &&
          record.source.device_id === input.hook.device_id
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))[0];
    if (priorSummary?.content.handoff_payload_fingerprint === payloadFingerprint) {
      const duplicateSync: HostHookDuplicateHandoffSync = { requested: requestedPush };
      if (pushDeferred) duplicateSync.deferred = pushDeferred;
      return {
        ok: true,
        event: input.hook.event,
        action: "skip_duplicate_handoff",
        degradation,
        duplicate_handoff: { prior_record_id: priorSummary.id },
        duplicate_handoff_sync: duplicateSync,
        transcript_evidence: hostEvidence.summary,
        hook_output: { additional_context: `Moryn reused unchanged handoff: ${priorSummary.id}` },
        ...(duplicateSync.deferred ? { deferred_work: [duplicateSync.deferred] } : {}),
        ...activationEvidence
      };
    }
    setStage("finish");
    const result = await agentFinish(
      {
        ...common,
        summary: synthesis.summary,
        synthesis,
        push: false,
        learnings: input.learnings,
        semanticConsolidationProposals: input.semantic_consolidation_proposals
      },
      { ...localHostLifecycleDeps(deps), handoffPayloadFingerprint: payloadFingerprint }
    );
    return {
      ok: true,
      event: input.hook.event,
      action: "agent_finish",
      degradation,
      details: result,
      transcript_evidence: hostEvidence.summary,
      hook_output: { additional_context: `Moryn handoff saved: ${result.record.id}` },
      ...(pushDeferred ? { deferred_work: [pushDeferred] } : {}),
      ...activationEvidence
    };
  }
  setStage("synthesis");
  const hostEvidence = await safeHostLifecycleEvidence(input);
  const synthesis = await sessionSynthesis(
    input,
    project.project_id,
    hostEvidence.compactSummary,
    hostEvidence.assistant
  );
  if (input.hook.event === "stop" && synthesis.mode === "minimal_fallback") {
    return {
      ok: true,
      event: input.hook.event,
      action: "skip_empty_status",
      degradation,
      skipped: { reason: "no_durable_session_evidence" },
      transcript_evidence: hostEvidence.summary,
      hook_output: {
        additional_context: "Moryn skipped an empty turn status because no durable session evidence was available."
      },
      ...activationEvidence
    };
  }
  let syncCadence: HostHookSyncCadence | undefined;
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
    } else if (!(await hasConfiguredSync())) {
      syncCadence = { due: false, reason: "remote_unconfigured", interval_minutes: 15, push_requested: false };
    } else {
      const decision = await evaluateTurnSyncCadence(input.storePath, identity);
      syncCadence = { ...decision, push_requested: decision.due };
    }
    if (syncCadence.push_requested) syncCadence.deferred = deferRemoteWork("status_sync");
    const current = await readCurrentRecords(input.storePath);
    const priorStatus = current.records
      .filter(
        (record) =>
          record.project_id === project.project_id &&
          record.type === "status" &&
          record.source.client === input.hook.host &&
          record.source.session_id === input.hook.session_id &&
          record.source.device_id === input.hook.device_id
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))[0];
    if (priorStatus && recordSynthesisFingerprint(priorStatus.content) === synthesisFingerprint(synthesis)) {
      return {
        ok: true,
        event: input.hook.event,
        action: "skip_duplicate_status",
        degradation,
        duplicate_status: { prior_record_id: priorStatus.id },
        transcript_evidence: hostEvidence.summary,
        sync_cadence: syncCadence,
        hook_output: { additional_context: `Moryn reused unchanged status: ${priorStatus.id}` },
        ...(syncCadence.deferred ? { deferred_work: [syncCadence.deferred] } : {}),
        ...activationEvidence
      };
    }
    setStage("status");
    const result = await agentStatus(
      { ...common, status: synthesis.summary, synthesis, push: false },
      localHostLifecycleDeps(deps)
    );
    return {
      ok: true,
      event: input.hook.event,
      action: "agent_status",
      degradation,
      details: result,
      transcript_evidence: hostEvidence.summary,
      sync_cadence: syncCadence,
      hook_output: { additional_context: `Moryn status saved: ${result.record.id}` },
      ...(syncCadence.deferred ? { deferred_work: [syncCadence.deferred] } : {}),
      ...activationEvidence
    };
  }
  setStage("status");
  const result = await agentStatus(
    { ...common, status: synthesis.summary, synthesis, push: false },
    localHostLifecycleDeps(deps)
  );
  return {
    ok: true,
    event: input.hook.event,
    action: "agent_status",
    degradation,
    details: result,
    transcript_evidence: hostEvidence.summary,
    hook_output: { additional_context: `Moryn status saved: ${result.record.id}` },
    ...activationEvidence
  };
}

export async function runHostHook(input: RunHostHookInput, deps: RunHostHookDeps = {}): Promise<HostHookRunResult> {
  let stage: HostHookExecutionStage = "resolve_project";
  let project: ProjectContext | undefined;
  try {
    project = await resolveProjectContext({
      projectId: input.project_id,
      projectPath: input.project_path ?? input.hook.cwd
    });
    const result = await runResolvedHostHook(input, deps, project, (nextStage) => {
      stage = nextStage;
    });
    throwIfOperationDeadlineExceeded();
    return result;
  } catch (error) {
    const receiptProjectId = project?.project_id ?? input.project_id;
    if ((isOperationDeadlineExceeded(error) || isOperationCancelled(error)) && receiptProjectId) {
      try {
        await withoutOperationDeadline(() =>
          recordHostHookExecutionReceipt(input.storePath, {
            host: input.hook.host,
            event: input.hook.event,
            project_id: receiptProjectId,
            session_id: input.hook.session_id,
            device_id: input.hook.device_id,
            occurred_at: input.hook.occurred_at,
            status: isOperationDeadlineExceeded(error) ? "timed_out" : "cancelled",
            stage,
            activation_id: input.activation_id,
            command_digest: input.command_digest
          })
        );
      } catch {
        // The original cancellation remains authoritative when its receipt cannot be persisted.
      }
    }
    throw error;
  }
}
