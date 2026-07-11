export type KnowledgeProtocolHost = "codex" | "claude";
export type KnowledgeProtocolPhaseId =
  | "recall_before_external_exploration"
  | "follow_recall_actions"
  | "capture_confirmed_learning"
  | "preserve_before_compaction";

export interface KnowledgeProtocolPhase {
  id: KnowledgeProtocolPhaseId;
  instruction: string;
}

export interface KnowledgeProtocolRule {
  id: string;
  trigger?: string;
  action: string;
}

export interface KnowledgeProtocol {
  version: 1;
  host: KnowledgeProtocolHost;
  display_name: "Codex" | "Claude Code";
  phases: KnowledgeProtocolPhase[];
  phases_by_id: Record<KnowledgeProtocolPhaseId, KnowledgeProtocolPhase>;
  rules: KnowledgeProtocolRule[];
  rules_by_id: Record<string, KnowledgeProtocolRule>;
  prompt: string;
  selection_sources: typeof KNOWLEDGE_PROTOCOL_SELECTION_SOURCES;
}

export const KNOWLEDGE_PROTOCOL_SELECTION_SOURCES = {
  phase: "knowledge_protocol.phases_by_id.<phase_id>",
  ordered_phase: "knowledge_protocol.phases[]",
  rule: "knowledge_protocol.rules_by_id.<rule_id>",
  prompt: "knowledge_protocol.prompt"
} as const;

export function knowledgeProtocolForHost(host: KnowledgeProtocolHost): KnowledgeProtocol {
  const displayName = host === "codex" ? "Codex" : "Claude Code";
  const phases: KnowledgeProtocolPhase[] = [{
    id: "recall_before_external_exploration",
    instruction: "When durable project or user knowledge is uncertain, call Moryn recall before broad external exploration."
  }, {
    id: "follow_recall_actions",
    instruction: "Follow returned recall next actions in order; Moryn supplies memory evidence while the host agent performs project, local-tool, web, or user exploration."
  }, {
    id: "capture_confirmed_learning",
    instruction: "After a reusable conclusion is supported, queue an evidence-backed Learning Delta for the next checkpoint or finish; never canonicalize unsupported inference."
  }, {
    id: "preserve_before_compaction",
    instruction: "Checkpoint resolved learnings plus unresolved questions, gathered evidence, blockers, and exact next verification steps before compaction."
  }];
  const rules: KnowledgeProtocolRule[] = [{
    id: "recall_first",
    trigger: "uncertain_durable_knowledge",
    action: "call_moryn_recall_before_broad_external_exploration"
  }, {
    id: "host_owns_exploration",
    action: "host_agent_explores_project_local_web_or_user_sources"
  }, {
    id: "evidence_before_learning",
    action: "queue_learning_delta_only_after_reusable_conclusion_is_supported"
  }, {
    id: "unsupported_inference",
    action: "do_not_canonicalize_unsupported_agent_inference"
  }, {
    id: "compact_safety",
    action: "checkpoint_resolved_learning_and_unresolved_investigation_before_host_compaction"
  }];
  return {
    version: 1,
    host,
    display_name: displayName,
    phases,
    phases_by_id: Object.fromEntries(phases.map((phase) => [phase.id, phase])) as Record<KnowledgeProtocolPhaseId, KnowledgeProtocolPhase>,
    rules,
    rules_by_id: Object.fromEntries(rules.map((rule) => [rule.id, rule])),
    prompt: `${displayName}: ${phases.map((phase) => phase.instruction).join(" ")}`,
    selection_sources: KNOWLEDGE_PROTOCOL_SELECTION_SOURCES
  };
}
