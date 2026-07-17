import { operationArgumentsByTool } from "../operation-contracts.js";
import { type ActionInterfaces, actionInterfaces } from "./action-interfaces.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import { commandForArchiveContext, commandForRecallContext, commandForTimelineContext } from "./errors.js";
import type { MorynRecord, RecordKind, RecordState } from "./types.js";
import { type RequiredFieldMetadata, withPhasesByName, withRequiredFieldsByName } from "./workflow.js";

export interface MemoryLifecycleInput {
  project_id?: string;
  limit?: number;
  include_private?: boolean;
  now?: string;
}

export interface MemoryLifecycleDiagnoseInput extends MemoryLifecycleInput {
  records: MorynRecord[];
  private_record_ids?: string[];
  excluded_private_records?: number;
}

type MemoryLifecycleState = "retained" | "stale" | "archive_candidate" | "private_retained";
type MemoryLifecycleRecommendedAction = "keep" | "inspect_timeline" | "archive_after_review";
type MemoryLifecycleSeverity = "info" | "warning";
type MemoryLifecycleCategory = "archive_candidates" | "stale_records";
type MemoryLifecycleActionTool = "archive" | "timeline" | "recall";

export interface MemoryLifecyclePolicy {
  id: "default_memory_lifecycle_policy";
  stale_after_days: number;
  archive_after_days: number;
  low_confidence_threshold: number;
  retain_high_priority: true;
  retain_canonical_rules: true;
}

export interface MemoryLifecycleAssessment {
  record_id: string;
  lifecycle_state: MemoryLifecycleState;
  recommended_action: MemoryLifecycleRecommendedAction;
  age_days: number;
  updated_at: string;
  reasons: string[];
}

export interface MemoryLifecycleFinding {
  id: string;
  category: MemoryLifecycleCategory;
  severity: MemoryLifecycleSeverity;
  summary: string;
  reason: string;
  record_ids: string[];
}

export interface MemoryLifecycleSuggestedAction {
  action_id: string;
  recommended_action: string;
  tool: MemoryLifecycleActionTool;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  required_fields_by_name: Record<string, RequiredFieldMetadata>;
  arguments_by_name: ReturnType<typeof operationArgumentsByTool>;
  interfaces: ActionInterfaces<Record<string, unknown>>;
  safety: ReturnType<typeof actionSafety>;
  execution: ReturnType<typeof actionExecution>;
  workflow: ReturnType<
    typeof withPhasesByName<{
      version: 1;
      start: "suggested_action";
      continue_from: string[];
      phases: Array<{
        phase: string;
        order: number;
        action_source: string;
        tool: MemoryLifecycleActionTool;
        required_when: string;
        required_fields: string[];
      }>;
    }>
  >;
}

export interface MemoryLifecycleStats {
  total_records: number;
  excluded_private_records: number;
  states: Partial<Record<RecordState, number>>;
  kinds: Partial<Record<RecordKind, number>>;
  retained_records: number;
  stale_records: number;
  archive_candidate_records: number;
  private_retained_records: number;
}

export interface MemoryLifecycleResult {
  read_only: true;
  version: 1;
  scope: "local_store";
  project_id?: string;
  generated_at: string;
  policy: MemoryLifecyclePolicy;
  stats: MemoryLifecycleStats;
  assessments: MemoryLifecycleAssessment[];
  assessments_by_record_id: Record<string, MemoryLifecycleAssessment>;
  findings: MemoryLifecycleFinding[];
  findings_by_id: Record<string, MemoryLifecycleFinding>;
  suggested_actions: MemoryLifecycleSuggestedAction[];
  suggested_actions_by_id: Record<string, MemoryLifecycleSuggestedAction>;
  records: MorynRecord[];
  records_by_id: Record<string, MorynRecord>;
  selection_sources: typeof MEMORY_LIFECYCLE_SELECTION_SOURCES;
}

export const MEMORY_LIFECYCLE_SELECTION_SOURCES = {
  assessment: "assessments_by_record_id.<record_id>",
  assessment_record_id: "assessments_by_record_id.<record_id>.record_id",
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id"
} as const;

const DEFAULT_POLICY: MemoryLifecyclePolicy = {
  id: "default_memory_lifecycle_policy",
  stale_after_days: 30,
  archive_after_days: 90,
  low_confidence_threshold: 0.5,
  retain_high_priority: true,
  retain_canonical_rules: true
};

const ARCHIVE_STALE_LOW_CONFIDENCE_REASON = "Memory lifecycle: archive stale low-confidence candidate";

function countBy<T extends string>(values: T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function recordsById(records: MorynRecord[]): Record<string, MorynRecord> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

function ageDays(record: MorynRecord, now: string): number {
  const updatedAtMs = Date.parse(record.updated_at);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs) || nowMs <= updatedAtMs) return 0;
  return Math.floor((nowMs - updatedAtMs) / 86_400_000);
}

function isRetainedByPolicy(record: MorynRecord): boolean {
  if (record.priority === "high") return true;
  return record.state === "canonical" && record.type === "rule";
}

function lifecycleAssessment(
  record: MorynRecord,
  now: string,
  policy: MemoryLifecyclePolicy,
  privateRecordIds: Set<string>
): MemoryLifecycleAssessment {
  const age = ageDays(record, now);
  const reasons: string[] = [];

  if (privateRecordIds.has(record.id)) {
    return {
      record_id: record.id,
      lifecycle_state: "private_retained",
      recommended_action: "keep",
      age_days: age,
      updated_at: record.updated_at,
      reasons: ["private_record_retained_by_boundary"]
    };
  }

  if (isRetainedByPolicy(record)) {
    if (record.priority === "high") reasons.push("high_priority_retained");
    if (record.state === "canonical" && record.type === "rule") reasons.push("canonical_rule_retained");
    return {
      record_id: record.id,
      lifecycle_state: "retained",
      recommended_action: "keep",
      age_days: age,
      updated_at: record.updated_at,
      reasons
    };
  }

  if (age >= policy.archive_after_days) reasons.push("older_than_archive_after_days");
  if (age >= policy.stale_after_days) reasons.push("older_than_stale_after_days");
  if (record.state === "candidate" && record.confidence < policy.low_confidence_threshold)
    reasons.push("low_confidence_candidate");

  if (reasons.includes("older_than_archive_after_days") && reasons.includes("low_confidence_candidate")) {
    return {
      record_id: record.id,
      lifecycle_state: "archive_candidate",
      recommended_action: "archive_after_review",
      age_days: age,
      updated_at: record.updated_at,
      reasons
    };
  }

  if (reasons.includes("older_than_stale_after_days")) {
    return {
      record_id: record.id,
      lifecycle_state: "stale",
      recommended_action: "inspect_timeline",
      age_days: age,
      updated_at: record.updated_at,
      reasons
    };
  }

  reasons.push("recent_or_retained_by_default");
  return {
    record_id: record.id,
    lifecycle_state: "retained",
    recommended_action: "keep",
    age_days: age,
    updated_at: record.updated_at,
    reasons
  };
}

function stats(
  records: MorynRecord[],
  assessments: MemoryLifecycleAssessment[],
  excludedPrivateRecords: number
): MemoryLifecycleStats {
  return {
    total_records: records.length,
    excluded_private_records: excludedPrivateRecords,
    states: countBy(records.map((record) => record.state)),
    kinds: countBy(records.map((record) => record.kind)),
    retained_records: assessments.filter((assessment) => assessment.lifecycle_state === "retained").length,
    stale_records: assessments.filter((assessment) => assessment.lifecycle_state === "stale").length,
    archive_candidate_records: assessments.filter((assessment) => assessment.lifecycle_state === "archive_candidate")
      .length,
    private_retained_records: assessments.filter((assessment) => assessment.lifecycle_state === "private_retained")
      .length
  };
}

function archiveFinding(assessments: MemoryLifecycleAssessment[]): MemoryLifecycleFinding | undefined {
  const recordIds = assessments
    .filter((assessment) => assessment.lifecycle_state === "archive_candidate")
    .map((assessment) => assessment.record_id);
  if (!recordIds.length) return undefined;
  return {
    id: "archive_candidates",
    category: "archive_candidates",
    severity: "warning",
    summary: "Some stale low-confidence candidate records should be reviewed for archive.",
    reason: `${recordIds.length} records are older than the archive threshold and still low-confidence candidates.`,
    record_ids: recordIds
  };
}

function staleFinding(assessments: MemoryLifecycleAssessment[]): MemoryLifecycleFinding | undefined {
  const recordIds = assessments
    .filter((assessment) => assessment.lifecycle_state === "stale")
    .map((assessment) => assessment.record_id);
  if (!recordIds.length) return undefined;
  return {
    id: "stale_records",
    category: "stale_records",
    severity: "info",
    summary: "Some active records are old enough to deserve timeline inspection.",
    reason: `${recordIds.length} records are older than the stale threshold but are not automatic archive candidates.`,
    record_ids: recordIds
  };
}

function withSuggestedActionMetadata(input: {
  action_id: string;
  recommended_action: string;
  tool: MemoryLifecycleActionTool;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields?: string[];
}): MemoryLifecycleSuggestedAction {
  const action = withRequiredFieldsByName({
    ...input,
    required_fields: input.required_fields ?? []
  });
  const argumentsByName = operationArgumentsByTool(input.tool);
  return {
    ...action,
    arguments_by_name: argumentsByName,
    interfaces: actionInterfaces({
      tool: input.tool,
      command: input.command,
      arguments: input.arguments
    }),
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      arguments_by_name: argumentsByName,
      required_fields_by_name: action.required_fields_by_name
    }),
    workflow: withPhasesByName({
      version: 1,
      start: "suggested_action",
      continue_from: ["memory_lifecycle.suggested_actions_by_id.<action_id>", "memory_lifecycle.suggested_actions[]"],
      phases: [
        {
          phase: input.recommended_action,
          order: 1,
          action_source: "memory_lifecycle.suggested_actions_by_id.<action_id>",
          tool: input.tool,
          required_when: input.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

function archiveAction(recordId: string): MemoryLifecycleSuggestedAction {
  const args = {
    record_id: recordId,
    reason: ARCHIVE_STALE_LOW_CONFIDENCE_REASON
  };
  return withSuggestedActionMetadata({
    action_id: `archive:${recordId}`,
    recommended_action: "archive_after_review",
    tool: "archive",
    command: commandForArchiveContext(args),
    arguments: args,
    safe_to_run: false,
    required_when: "After the user confirms this stale low-confidence candidate is obsolete."
  });
}

function inspectAction(
  recordId: string,
  projectId: string | undefined,
  includePrivate: boolean | undefined
): MemoryLifecycleSuggestedAction {
  const args = {
    record_id: recordId,
    ...(projectId ? { project_id: projectId } : {}),
    before: 3,
    after: 3,
    ...(includePrivate === true ? { include_private: true } : {})
  };
  return withSuggestedActionMetadata({
    action_id: `inspect:${recordId}`,
    recommended_action: "inspect_timeline",
    tool: "timeline",
    command: commandForTimelineContext(args),
    arguments: args,
    safe_to_run: true,
    required_when: "When deciding whether a stale record is still useful or should be revised, linked, or archived."
  });
}

function recallAction(
  recordId: string,
  projectId: string | undefined,
  includePrivate: boolean | undefined
): MemoryLifecycleSuggestedAction {
  const args = {
    record_ids: [recordId],
    ...(projectId ? { project_id: projectId } : {}),
    ...(includePrivate === true ? { include_private: true } : {})
  };
  return withSuggestedActionMetadata({
    action_id: `recall:${recordId}`,
    recommended_action: "inspect_record",
    tool: "recall",
    command: commandForRecallContext(args),
    arguments: args,
    safe_to_run: true,
    required_when: "When the user needs the full record before deciding lifecycle treatment."
  });
}

function stableRecordSort(left: MorynRecord, right: MorynRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function stableAssessmentSort(left: MemoryLifecycleAssessment, right: MemoryLifecycleAssessment): number {
  const priority = { archive_candidate: 3, stale: 2, private_retained: 1, retained: 0 } satisfies Record<
    MemoryLifecycleState,
    number
  >;
  return (
    priority[right.lifecycle_state] - priority[left.lifecycle_state] ||
    right.updated_at.localeCompare(left.updated_at) ||
    left.record_id.localeCompare(right.record_id)
  );
}

function uniqueActions(actions: MemoryLifecycleSuggestedAction[], limit: number): MemoryLifecycleSuggestedAction[] {
  const byId = new Map<string, MemoryLifecycleSuggestedAction>();
  for (const action of actions) {
    if (!byId.has(action.action_id)) byId.set(action.action_id, action);
  }
  return [...byId.values()].slice(0, limit);
}

export function diagnoseMemoryLifecycle(input: MemoryLifecycleDiagnoseInput): MemoryLifecycleResult {
  const limit = input.limit ?? 20;
  const generatedAt = input.now ?? new Date().toISOString();
  const policy = DEFAULT_POLICY;
  const records = [...input.records].sort(stableRecordSort);
  const privateRecordIds = new Set(input.private_record_ids ?? []);
  const assessments = records
    .map((record) => lifecycleAssessment(record, generatedAt, policy, privateRecordIds))
    .sort(stableAssessmentSort);
  const findings = [archiveFinding(assessments), staleFinding(assessments)].filter(
    (finding): finding is MemoryLifecycleFinding => finding !== undefined
  );
  const assessmentByRecordId = Object.fromEntries(assessments.map((assessment) => [assessment.record_id, assessment]));
  const actions = uniqueActions(
    [
      ...assessments
        .filter((assessment) => assessment.lifecycle_state === "archive_candidate")
        .map((assessment) => archiveAction(assessment.record_id)),
      ...assessments
        .filter((assessment) => assessment.lifecycle_state === "stale")
        .map((assessment) => inspectAction(assessment.record_id, input.project_id, input.include_private)),
      ...assessments
        .filter((assessment) => assessment.lifecycle_state !== "retained")
        .map((assessment) => recallAction(assessment.record_id, input.project_id, input.include_private))
    ],
    limit
  );
  const referencedRecordIds = new Set([
    ...findings.flatMap((finding) => finding.record_ids),
    ...actions.flatMap((action) => {
      const recordId = action.arguments.record_id;
      return typeof recordId === "string" ? [recordId] : [];
    })
  ]);
  const recordSelection = records.filter((record) => referencedRecordIds.has(record.id)).slice(0, limit);
  return {
    read_only: true,
    version: 1,
    scope: "local_store",
    ...(input.project_id ? { project_id: input.project_id } : {}),
    generated_at: generatedAt,
    policy,
    stats: stats(records, assessments, input.excluded_private_records ?? 0),
    assessments,
    assessments_by_record_id: assessmentByRecordId,
    findings,
    findings_by_id: Object.fromEntries(findings.map((finding) => [finding.id, finding])),
    suggested_actions: actions,
    suggested_actions_by_id: Object.fromEntries(actions.map((action) => [action.action_id, action])),
    records: recordSelection,
    records_by_id: recordsById(recordSelection),
    selection_sources: MEMORY_LIFECYCLE_SELECTION_SOURCES
  };
}
