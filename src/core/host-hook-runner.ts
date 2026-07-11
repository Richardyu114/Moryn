import { createHash } from "node:crypto";
import { agentFinish, agentStart, agentStatus } from "./agent-lifecycle.js";
import { createEngine } from "./engine.js";
import { getHostCapabilities } from "./host-capabilities.js";
import type { NormalizedHostHookEvent } from "./host-hooks.js";
import type { KnowledgeInvestigationInput, LearningDeltaInput, SemanticConsolidationProposalInput } from "./context-delta.js";
import { resolveProjectContext } from "./project.js";
import { recordActivationReceipt, type ActivationReceiptInput } from "./activation-receipts.js";
import { buildHostIntegrationArtifact } from "./host-integration-artifacts.js";

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

export interface HostHookRunResult {
  ok: true;
  event: NormalizedHostHookEvent["event"];
  action: "agent_start" | "checkpoint_before_compaction" | "resume_from_checkpoint" | "agent_status" | "agent_finish";
  degradation: { mode: "native" } | { mode: "fallback"; reason: "host_hook_unavailable" };
  hook_output: { additional_context: string };
  checkpoint?: { idempotent_replay: boolean; record: { id: string } };
  activation_receipt?: Awaited<ReturnType<typeof recordActivationReceipt>>;
  activation_warning?: { code: "ACTIVATION_RECEIPT_FAILED"; reason: string };
  details?: unknown;
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

export async function runHostHook(input: RunHostHookInput): Promise<HostHookRunResult> {
  const project = await resolveProjectContext({ projectId: input.project_id, projectPath: input.project_path ?? input.hook.cwd });
  const capabilities = getHostCapabilities(input.hook.host);
  const native = capabilities.events[input.hook.event];
  const degradation = native
    ? { mode: "native" as const }
    : { mode: "fallback" as const, reason: "host_hook_unavailable" as const };
  const common = lifecycleInput({ ...input, project_id: project.project_id, project_path: input.project_id && !input.project_path ? undefined : project.project_path });
  let activation_receipt: Awaited<ReturnType<typeof recordActivationReceipt>> | undefined;
  let activation_warning: HostHookRunResult["activation_warning"];
  if (input.activation_id && (input.hook.host === "codex" || input.hook.host === "claude")) {
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
  if (input.hook.event === "session_start" || input.hook.event === "post_compact") {
    const result = await agentStart({ ...common, pull: input.pull ?? input.hook.event === "session_start" });
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
    return { ok: true, event: input.hook.event, action: "checkpoint_before_compaction", degradation, checkpoint, hook_output: { additional_context: `Moryn checkpoint saved: ${checkpoint.record.id}` }, ...activationEvidence };
  }
  if (input.hook.event === "session_end") {
    const result = await agentFinish({ ...common, summary: input.hook.compact_summary ?? "Host session ended.", push: input.push, learnings: input.learnings, semanticConsolidationProposals: input.semantic_consolidation_proposals });
    return { ok: true, event: input.hook.event, action: "agent_finish", degradation, details: result, hook_output: { additional_context: `Moryn handoff saved: ${result.record.id}` }, ...activationEvidence };
  }
  const result = await agentStatus({ ...common, status: input.hook.compact_summary ?? "Host stop hook reached.", push: input.push });
  return { ok: true, event: input.hook.event, action: "agent_status", degradation, details: result, hook_output: { additional_context: `Moryn status saved: ${result.record.id}` }, ...activationEvidence };
}
