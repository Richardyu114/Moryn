import { displayRecordText } from "./content-text.js";
import type { RecallOutcome } from "./recall-outcome.js";
import type { MorynRecord } from "./types.js";

export interface PromptRecallInput {
  outcome: RecallOutcome;
  results: Array<{ record: MorynRecord; score: number }>;
  question: string;
  capture_context?: {
    project_id: string;
    current_task?: string;
    agent: {
      client: string;
      session_id: string;
      device_id: string;
    };
  };
}

function learningBridge(input: PromptRecallInput): Record<string, unknown> {
  const candidateRecordId = input.outcome.best_record_id;
  const question = candidateRecordId ? "<verified question or situation>" : "<current user question or situation>";
  const captureContext = input.capture_context;
  const queueLearning = captureContext
    ? {
        mcp_tool: "learn",
        mcp_arguments: {
          project_id: captureContext.project_id,
          question,
          conclusion: "<supported reusable conclusion>",
          evidence_type: "<user_confirmed|source_code|documentation|web|inference>",
          ...(captureContext.current_task ? { current_task: captureContext.current_task } : {}),
          source: captureContext.agent,
          ...(candidateRecordId ? { related_record_ids: [candidateRecordId] } : {})
        },
        lifecycle_consumption: "automatic_on_checkpoint_or_finish"
      }
    : {
        mcp_tool: "learn",
        mcp_arguments: {
          question,
          conclusion: "<supported reusable conclusion>",
          evidence_type: "<user_confirmed|source_code|documentation|web|inference>",
          ...(candidateRecordId ? { related_record_ids: [candidateRecordId] } : {})
        },
        requires_lifecycle_context: true,
        lifecycle_consumption: "automatic_on_checkpoint_or_finish"
      };
  return {
    version: 1,
    question_source: "current_user_prompt",
    ...(candidateRecordId ? { candidate_record_id: candidateRecordId } : {}),
    write_policy: "write_only_after_supported_reusable_conclusion",
    unresolved_policy: "preserve_investigation_at_checkpoint_before_compaction",
    learning_delta_template: {
      question,
      conclusion: "<supported reusable conclusion>",
      evidence_type: "<user_confirmed|source_code|documentation|web|inference>",
      scope: "project",
      confidence: "<0..1>",
      recommended_kind: "memory",
      recommended_type: "fact",
      related_record_ids: candidateRecordId ? [candidateRecordId] : []
    },
    queue_learning: queueLearning
  };
}

export interface PromptRecallContext {
  injected: boolean;
  record_count: number;
  additional_context: string;
}

function boundedText(record: MorynRecord): string {
  const text = displayRecordText(record).replace(/\s+/g, " ").trim();
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

export function buildPromptRecallContext(input: PromptRecallInput): PromptRecallContext {
  if (input.outcome.status === "knowledge_gap") {
    return {
      injected: true,
      record_count: 0,
      additional_context: JSON.stringify({
        source: "moryn",
        status: "knowledge_gap",
        instruction:
          "Moryn has no trusted answer. Investigate project files, local tools, web sources, or ask the user as needed. When a reusable conclusion is supported, call learning_bridge.queue_learning once. Moryn will consume it automatically at checkpoint or finish. If still unresolved before compaction, preserve the question, evidence, blocker, and exact next verification step.",
        learning_bridge: learningBridge(input)
      })
    };
  }
  if (input.outcome.status === "verification_required") {
    return {
      injected: true,
      record_count: 0,
      additional_context: JSON.stringify({
        source: "moryn",
        status: "verification_required",
        ...(input.outcome.best_record_id ? { candidate_record_id: input.outcome.best_record_id } : {}),
        instruction:
          "Moryn found only unverified knowledge. Inspect the candidate timeline and verify it with project files, local tools, web sources, or the user before relying on it. Only after the conclusion is supported, call learning_bridge.queue_learning once.",
        learning_bridge: learningBridge(input)
      })
    };
  }
  const records = input.results.slice(0, 3);
  if (!records.length) return { injected: false, record_count: 0, additional_context: "" };
  const context = {
    source: "moryn",
    instruction:
      "Use this trusted local knowledge when relevant. If the current task contradicts it, verify before relying on it.",
    records: records.map(({ record }) => ({
      id: record.id,
      kind: record.kind,
      type: record.type,
      scope: record.scope,
      state: record.state,
      confidence: record.confidence,
      updated_at: record.updated_at,
      text: boundedText(record)
    }))
  };
  return { injected: true, record_count: records.length, additional_context: JSON.stringify(context, null, 2) };
}
