import { displayRecordText } from "./content-text.js";
import type { MorynRecord } from "./types.js";
import type { RecallOutcome } from "./recall-outcome.js";

export interface PromptRecallInput {
  outcome: RecallOutcome;
  results: Array<{ record: MorynRecord; score: number }>;
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
        instruction: "Moryn has no trusted answer. Investigate project files, local tools, web sources, or ask the user as needed. When a reusable conclusion is supported, queue an evidence-backed Learning Delta at the next checkpoint or finish. If still unresolved before compaction, preserve the question, evidence, blocker, and exact next verification step."
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
        instruction: "Moryn found only unverified knowledge. Inspect the candidate timeline and verify it with project files, local tools, web sources, or the user before relying on it. Queue an evidence-backed Learning Delta at the next checkpoint or finish only after the conclusion is supported."
      })
    };
  }
  const records = input.results.slice(0, 3);
  if (!records.length) return { injected: false, record_count: 0, additional_context: "" };
  const context = {
    source: "moryn",
    instruction: "Use this trusted local knowledge when relevant. If the current task contradicts it, verify before relying on it.",
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
