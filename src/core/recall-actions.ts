import type { RecallOutcome } from "./recall-outcome.js";

export type RecallNextActionId =
  | "use_recalled_knowledge"
  | "inspect_record_timeline"
  | "inspect_recalled_candidate"
  | "verify_with_external_evidence"
  | "explore_external_sources"
  | "capture_confirmed_learning"
  | "preserve_unresolved_investigation";

export interface RecallNextAction {
  id: RecallNextActionId;
  title: string;
  description: string;
  executor: "moryn" | "host_agent";
  safe_to_run: boolean;
  evidence?: { record_ids: string[] };
  source_order?: string[];
  destinations?: string[];
  arguments_by_name?: Record<string, unknown>;
  required_fields_by_name?: Record<string, string>;
  execution?: { external_side_effects: boolean };
  interfaces?: {
    cli: { executable: string; argv: string[]; command_line: string };
    mcp: { tool: string; arguments: Record<string, unknown> };
  };
}

export interface RecallActionContract {
  next_actions: RecallNextAction[];
  next_actions_by_id: Partial<Record<RecallNextActionId, RecallNextAction>>;
  selection_sources: typeof RECALL_ACTION_SELECTION_SOURCES;
}

export const RECALL_ACTION_SELECTION_SOURCES = {
  action: "next_actions_by_id.<action_id>",
  ordered_action: "next_actions[]",
  action_id: "next_actions_by_id.<action_id>.id",
  executor: "next_actions_by_id.<action_id>.executor",
  evidence_record_id: "next_actions_by_id.<action_id>.evidence.record_ids[]",
  destination: "next_actions_by_id.<action_id>.destinations[]",
  required_field: "next_actions_by_id.<action_id>.required_fields_by_name.<field>",
  cli_argv: "next_actions_by_id.<action_id>.interfaces.cli.argv[]",
  mcp_tool: "next_actions_by_id.<action_id>.interfaces.mcp.tool"
} as const;

const LEARNING_FIELDS = {
  question: "question",
  conclusion: "conclusion",
  evidence_type: "evidence_type",
  scope: "scope",
  confidence: "confidence",
  recommended_kind: "recommended_kind",
  recommended_type: "recommended_type"
};

function timelineAction(
  id: "inspect_record_timeline" | "inspect_recalled_candidate",
  recordId: string,
  includePrivate: boolean
): RecallNextAction {
  const argv = ["timeline", "--record-id", recordId, ...(includePrivate ? ["--include-private"] : [])];
  return {
    id,
    title: id === "inspect_record_timeline" ? "Inspect recalled knowledge provenance" : "Inspect recalled candidate",
    description: "Inspect the record timeline before relying on provenance or nearby changes.",
    executor: "moryn",
    safe_to_run: true,
    evidence: { record_ids: [recordId] },
    arguments_by_name: { record_id: recordId, include_private: includePrivate },
    execution: { external_side_effects: false },
    interfaces: {
      cli: { executable: "moryn", argv, command_line: ["moryn", ...argv].join(" ") },
      mcp: { tool: "timeline", arguments: { record_id: recordId, include_private: includePrivate } }
    }
  };
}

function captureLearningAction(): RecallNextAction {
  return {
    id: "capture_confirmed_learning",
    title: "Capture confirmed reusable learning",
    description: "After verification, queue an evidence-backed Learning Delta for the next checkpoint or finish.",
    executor: "host_agent",
    safe_to_run: true,
    destinations: ["checkpoint.delta.learnings[]", "finish.learnings[]"],
    required_fields_by_name: LEARNING_FIELDS,
    execution: { external_side_effects: false }
  };
}

function keyed(actions: RecallNextAction[]): RecallActionContract {
  return {
    next_actions: actions,
    next_actions_by_id: Object.fromEntries(actions.map((action) => [action.id, action])),
    selection_sources: RECALL_ACTION_SELECTION_SOURCES
  };
}

export function buildRecallNextActions(input: {
  query: string;
  outcome: RecallOutcome;
  include_private?: boolean;
}): RecallActionContract {
  const includePrivate = input.include_private === true;
  if (input.outcome.status === "trusted_match" && input.outcome.best_record_id) {
    return keyed([
      {
        id: "use_recalled_knowledge",
        title: "Use recalled knowledge",
        description: "Use the trusted record and retain its record ID as answer evidence.",
        executor: "host_agent",
        safe_to_run: true,
        evidence: { record_ids: [input.outcome.best_record_id] },
        execution: { external_side_effects: false }
      },
      timelineAction("inspect_record_timeline", input.outcome.best_record_id, includePrivate)
    ]);
  }
  if (input.outcome.status === "verification_required" && input.outcome.best_record_id) {
    return keyed([
      timelineAction("inspect_recalled_candidate", input.outcome.best_record_id, includePrivate),
      {
        id: "verify_with_external_evidence",
        title: "Verify with external evidence",
        description:
          "Verify the candidate with project files, local tools, web sources, or the user before relying on it.",
        executor: "host_agent",
        safe_to_run: true,
        source_order: ["project_files", "local_tools", "web_when_needed", "user_when_needed"],
        execution: { external_side_effects: false }
      },
      captureLearningAction()
    ]);
  }
  return keyed([
    {
      id: "explore_external_sources",
      title: "Explore external sources",
      description: "Moryn has no reliable answer; investigate the bounded question using host-accessible sources.",
      executor: "host_agent",
      safe_to_run: true,
      source_order: ["project_files", "local_tools", "web_when_needed", "user_when_needed"],
      execution: { external_side_effects: false }
    },
    captureLearningAction(),
    {
      id: "preserve_unresolved_investigation",
      title: "Preserve unresolved investigation",
      description:
        "If still unresolved, checkpoint the question, evidence, blocker, and exact next verification step before compact or handoff.",
      executor: "host_agent",
      safe_to_run: true,
      destinations: ["checkpoint.delta.blockers[]", "checkpoint.delta.next_steps[]", "checkpoint.delta.files[]"],
      execution: { external_side_effects: false }
    }
  ]);
}
