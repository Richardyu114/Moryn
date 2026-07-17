import type { RecoveryPack } from "./checkpoint.js";

export interface SessionSynthesis {
  version: 1;
  mode: "host_authored" | "evidence_synthesized" | "minimal_fallback";
  summary: string;
  current_task?: string;
  progress: string[];
  decisions: string[];
  blockers: string[];
  next_steps: string[];
  learning_conclusions: string[];
  unresolved_investigations: Array<{ question: string; next_step: string }>;
  source_record_ids: string[];
}

export interface SessionSynthesisInput {
  host_summary?: string;
  current_task?: string;
  recovery_pack?: RecoveryPack;
}

function bounded(values: Array<string | undefined>, limit: number): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function summaryText(input: {
  currentTask?: string;
  progress: string[];
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
  learningConclusions: string[];
}): string {
  return [
    input.currentTask ? `Task: ${input.currentTask}` : undefined,
    input.progress.length ? `Progress: ${input.progress.join("; ")}` : undefined,
    input.decisions.length ? `Decisions: ${input.decisions.join("; ")}` : undefined,
    input.blockers.length ? `Blockers: ${input.blockers.join("; ")}` : undefined,
    input.nextSteps.length ? `Next: ${input.nextSteps.join("; ")}` : undefined,
    input.learningConclusions.length ? `Learned: ${input.learningConclusions.join("; ")}` : undefined
  ]
    .filter(Boolean)
    .join(" | ");
}

export function synthesizeSession(input: SessionSynthesisInput): SessionSynthesis {
  const hostSummary = input.host_summary?.trim();
  if (hostSummary) {
    return {
      version: 1,
      mode: "host_authored",
      summary: hostSummary,
      ...(input.current_task ? { current_task: input.current_task } : {}),
      progress: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      learning_conclusions: [],
      unresolved_investigations: [],
      source_record_ids: []
    };
  }

  const recovery = input.recovery_pack;
  const currentTask = recovery?.current_task ?? input.current_task;
  const progress = bounded(recovery?.progress ?? [], 5);
  const decisions = bounded(recovery?.decisions ?? [], 3);
  const blockers = bounded(recovery?.blockers ?? [], 3);
  const unresolvedInvestigations = (recovery?.knowledge_investigations ?? [])
    .filter((investigation) => investigation.status === "unresolved" && investigation.next_step)
    .slice(0, 5)
    .map((investigation) => ({ question: investigation.question, next_step: investigation.next_step! }));
  const nextSteps = bounded(
    [...(recovery?.next_steps ?? []), ...unresolvedInvestigations.map((investigation) => investigation.next_step)],
    5
  );
  const learningConclusions = bounded(
    (recovery?.learnings ?? []).map((learning) => learning.conclusion),
    5
  );
  const sourceRecordIds = bounded(recovery?.source_record_ids ?? [], 10);
  const summary = summaryText({ currentTask, progress, decisions, blockers, nextSteps, learningConclusions });
  const hasEvidence = Boolean(
    summary &&
      (progress.length ||
        decisions.length ||
        blockers.length ||
        nextSteps.length ||
        learningConclusions.length ||
        sourceRecordIds.length)
  );

  return {
    version: 1,
    mode: hasEvidence ? "evidence_synthesized" : "minimal_fallback",
    summary: hasEvidence
      ? summary
      : currentTask
        ? `Session ended for task: ${currentTask}.`
        : "Session ended; no durable progress evidence was available.",
    ...(currentTask ? { current_task: currentTask } : {}),
    progress,
    decisions,
    blockers,
    next_steps: nextSteps,
    learning_conclusions: learningConclusions,
    unresolved_investigations: unresolvedInvestigations,
    source_record_ids: sourceRecordIds
  };
}
