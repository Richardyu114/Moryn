import { operationArgumentsByTool } from "../operation-contracts.js";
import { type ActionInterfaces, actionInterfaces } from "./action-interfaces.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import { displayRecordText } from "./content-text.js";
import {
  commandForArchiveContext,
  commandForLinkContext,
  commandForPromoteContext,
  commandForReviseContext,
  commandForTimelineContext
} from "./errors.js";
import type { MorynRecord, RecordKind, RecordState } from "./types.js";
import { type RequiredFieldMetadata, withPhasesByName, withRequiredFieldsByName } from "./workflow.js";

export interface MemoryDoctorInput {
  project_id?: string;
  limit?: number;
  include_private?: boolean;
}

export interface MemoryDoctorDiagnoseInput extends MemoryDoctorInput {
  records: MorynRecord[];
  excluded_private_records?: number;
}

type MemoryDoctorSeverity = "info" | "warning";
type MemoryDoctorCategory = "backlog" | "candidate_quality" | "project_identity";
type MemoryDoctorActionTool = "promote" | "archive" | "project_list" | "link" | "revise" | "timeline";

export interface MemoryDoctorFinding {
  id: string;
  category: MemoryDoctorCategory;
  severity: MemoryDoctorSeverity;
  summary: string;
  reason: string;
  project_id?: string;
  record_id?: string;
  record_ids?: string[];
  related_project_ids?: string[];
}

export interface MemoryDoctorSuggestedAction {
  action_id: string;
  recommended_action: string;
  tool: MemoryDoctorActionTool;
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
        tool: MemoryDoctorActionTool;
        required_when: string;
        required_fields: string[];
      }>;
    }>
  >;
}

export interface MemoryDoctorStats {
  total_records: number;
  excluded_private_records: number;
  states: Partial<Record<RecordState, number>>;
  kinds: Partial<Record<RecordKind, number>>;
  projects: Record<string, number>;
  candidate_records: number;
  canonical_records: number;
}

export interface MemoryDoctorResult {
  read_only: true;
  project_id?: string;
  stats: MemoryDoctorStats;
  findings: MemoryDoctorFinding[];
  findings_by_id: Record<string, MemoryDoctorFinding>;
  suggested_actions: MemoryDoctorSuggestedAction[];
  suggested_actions_by_id: Record<string, MemoryDoctorSuggestedAction>;
  records: MorynRecord[];
  records_by_id: Record<string, MorynRecord>;
  selection_sources: typeof MEMORY_DOCTOR_SELECTION_SOURCES;
}

export const MEMORY_DOCTOR_SELECTION_SOURCES = {
  finding: "findings_by_id.<finding_id>",
  finding_id: "findings_by_id.<finding_id>.id",
  action: "suggested_actions_by_id.<action_id>",
  action_id: "suggested_actions_by_id.<action_id>.action_id",
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id"
} as const;

const PROMOTE_REASON = "Memory doctor: confirmed/high-confidence candidate review";
const ARCHIVE_MARKER_REASON = "Memory doctor: e2e marker/noise candidate";
const ARCHIVE_DUPLICATE_REASON = "Memory doctor: duplicate candidate after linking or review";
const REVISE_CONFLICT_REASON = "Memory doctor: resolve semantic conflict before promotion";
const PROJECT_ID_UNKNOWN = "(none)";

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

function stats(records: MorynRecord[], excludedPrivateRecords: number): MemoryDoctorStats {
  return {
    total_records: records.length,
    excluded_private_records: excludedPrivateRecords,
    states: countBy(records.map((record) => record.state)),
    kinds: countBy(records.map((record) => record.kind)),
    projects: Object.fromEntries(
      [
        ...records.reduce((counts, record) => {
          const projectId = record.project_id ?? PROJECT_ID_UNKNOWN;
          counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
          return counts;
        }, new Map<string, number>())
      ].sort(([left], [right]) => left.localeCompare(right))
    ),
    candidate_records: records.filter((record) => record.state === "candidate").length,
    canonical_records: records.filter((record) => record.state === "canonical").length
  };
}

function recordText(record: MorynRecord): string {
  return displayRecordText(record).toLowerCase();
}

function isPromotableCandidate(record: MorynRecord): boolean {
  if (record.state !== "candidate") return false;
  if (record.kind !== "memory") return false;
  const userConfirmed = record.provenance?.method === "user-confirmed" || record.source.client === "user";
  const highConfidenceRule = record.type === "rule" && record.confidence >= 0.9 && record.priority === "high";
  return userConfirmed || highConfidenceRule;
}

function isMarkerNoiseCandidate(record: MorynRecord): boolean {
  if (record.state !== "candidate") return false;
  const haystack = `${recordText(record)} ${record.tags.join(" ")}`.toLowerCase();
  return /\b(?:e2e|smoke|marker)\b/.test(haystack);
}

function commandWithConfirm(command: string): string {
  return command.includes(" --confirm") ? command : `${command} --confirm`;
}

function withSuggestedActionMetadata(input: {
  action_id: string;
  recommended_action: string;
  tool: MemoryDoctorActionTool;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields?: string[];
}): MemoryDoctorSuggestedAction {
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
      continue_from: ["memory_doctor.suggested_actions_by_id.<action_id>", "memory_doctor.suggested_actions[]"],
      phases: [
        {
          phase: input.recommended_action,
          order: 1,
          action_source: "memory_doctor.suggested_actions_by_id.<action_id>",
          tool: input.tool,
          required_when: input.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

function promoteAction(record: MorynRecord): MemoryDoctorSuggestedAction {
  const args = {
    record_id: record.id,
    target_state: "canonical",
    reason: PROMOTE_REASON,
    confirmed: true
  };
  return withSuggestedActionMetadata({
    action_id: `promote:${record.id}`,
    recommended_action: "promote_candidate",
    tool: "promote",
    command: commandWithConfirm(commandForPromoteContext(args)),
    arguments: args,
    safe_to_run: false,
    required_when: "After the user confirms this candidate should become canonical memory."
  });
}

function archiveAction(record: MorynRecord): MemoryDoctorSuggestedAction {
  const args = {
    record_id: record.id,
    reason: ARCHIVE_MARKER_REASON
  };
  return withSuggestedActionMetadata({
    action_id: `archive:${record.id}`,
    recommended_action: "archive_record",
    tool: "archive",
    command: commandForArchiveContext(args),
    arguments: args,
    safe_to_run: false,
    required_when: "After the user confirms this candidate is test noise or an obsolete marker."
  });
}

function archiveDuplicateAction(record: MorynRecord): MemoryDoctorSuggestedAction {
  const args = {
    record_id: record.id,
    reason: ARCHIVE_DUPLICATE_REASON
  };
  return withSuggestedActionMetadata({
    action_id: `archive_duplicate:${record.id}`,
    recommended_action: "archive_duplicate_candidate",
    tool: "archive",
    command: commandForArchiveContext(args),
    arguments: args,
    safe_to_run: false,
    required_when: "After the user confirms this candidate duplicates another record and should leave normal review."
  });
}

function linkDuplicateAction(record: MorynRecord, duplicateOf: MorynRecord): MemoryDoctorSuggestedAction {
  const args = {
    record_id: record.id,
    linked_record_id: duplicateOf.id,
    link_type: "duplicate_of"
  };
  return withSuggestedActionMetadata({
    action_id: `link_duplicate:${record.id}`,
    recommended_action: "link_duplicate_candidate",
    tool: "link",
    command: commandForLinkContext(args),
    arguments: args,
    safe_to_run: false,
    required_when: "After the user confirms these candidates describe the same durable memory."
  });
}

function reviseConflictAction(record: MorynRecord): MemoryDoctorSuggestedAction {
  const args = {
    record_id: record.id,
    patch: {},
    reason: REVISE_CONFLICT_REASON
  };
  return withSuggestedActionMetadata({
    action_id: `revise_conflict:${record.id}`,
    recommended_action: "revise_conflicting_candidate",
    tool: "revise",
    command: commandForReviseContext(args),
    arguments: args,
    safe_to_run: false,
    required_when: "After the user decides how this candidate should differ from the conflicting canonical memory."
  });
}

function inspectConflictAction(record: MorynRecord, projectId: string | undefined): MemoryDoctorSuggestedAction {
  const args = {
    record_id: record.id,
    ...(projectId ? { project_id: projectId } : {}),
    before: 3,
    after: 3
  };
  return withSuggestedActionMetadata({
    action_id: `inspect_conflict:${record.id}`,
    recommended_action: "inspect_conflict_timeline",
    tool: "timeline",
    command: commandForTimelineContext(args),
    arguments: args,
    safe_to_run: true,
    required_when: "Before revising or promoting a candidate that conflicts with canonical memory."
  });
}

function projectListAction(): MemoryDoctorSuggestedAction {
  return withSuggestedActionMetadata({
    action_id: "review_project_identity",
    recommended_action: "review_project_identity",
    tool: "project_list",
    command: "moryn project list --limit 20",
    arguments: { limit: 20 },
    safe_to_run: true,
    required_when: "When memory doctor finds records for likely-same work under multiple project ids."
  });
}

function normalizedCandidateText(record: MorynRecord): string {
  return recordText(record).replace(/\s+/g, " ").trim();
}

function duplicateCandidateGroups(records: MorynRecord[]): MorynRecord[][] {
  const groups = new Map<string, MorynRecord[]>();
  for (const record of records.filter((record) => record.state === "candidate")) {
    const text = normalizedCandidateText(record);
    if (!text) continue;
    const key = `${record.kind}\u0000${record.type}\u0000${record.scope}\u0000${record.project_id ?? ""}\u0000${text}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.values()]
    .map((group) =>
      [...group].sort(
        (left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
      )
    )
    .filter((group) => group.length > 1);
}

function duplicateCandidateFinding(groups: MorynRecord[][]): MemoryDoctorFinding | undefined {
  if (!groups.length) return undefined;
  const records = groups.flat();
  return {
    id: "duplicate_candidates",
    category: "candidate_quality",
    severity: "warning",
    summary: "Some candidate records appear to duplicate each other.",
    reason: `${groups.length} duplicate candidate text group${groups.length === 1 ? "" : "s"} found.`,
    record_ids: records.map((record) => record.id)
  };
}

function conflictingCandidates(records: MorynRecord[]): MorynRecord[] {
  return records.filter((record) => record.state === "candidate" && record.conflict?.with?.length);
}

function conflictingCandidateFinding(records: MorynRecord[]): MemoryDoctorFinding | undefined {
  if (!records.length) return undefined;
  return {
    id: "conflicting_candidates",
    category: "candidate_quality",
    severity: "warning",
    summary: "Some candidate records conflict with canonical memory.",
    reason: `${records.length} candidate record${records.length === 1 ? "" : "s"} should be revised, linked, archived, or explicitly promoted after review.`,
    record_ids: records.map((record) => record.id)
  };
}

function candidateBacklogFinding(memoryStats: MemoryDoctorStats): MemoryDoctorFinding | undefined {
  if (memoryStats.candidate_records < 3) return undefined;
  const ratio =
    memoryStats.canonical_records === 0
      ? memoryStats.candidate_records
      : memoryStats.candidate_records / memoryStats.canonical_records;
  if (ratio < 1.25) return undefined;
  return {
    id: "candidate_backlog",
    category: "backlog",
    severity: "warning",
    summary: "Candidate records are accumulating faster than canonical records.",
    reason: `${memoryStats.candidate_records} candidate records vs ${memoryStats.canonical_records} canonical records.`
  };
}

function sharedMeaningfulTags(left: MorynRecord[], right: MorynRecord[]): string[] {
  const generic = new Set(["javascript", "node", "nodejs", "typescript"]);
  const leftTags = new Set(
    left.flatMap((record) => record.tags.map((tag) => tag.toLowerCase())).filter((tag) => !generic.has(tag))
  );
  const rightTags = new Set(
    right.flatMap((record) => record.tags.map((tag) => tag.toLowerCase())).filter((tag) => !generic.has(tag))
  );
  return [...leftTags].filter((tag) => rightTags.has(tag)).sort();
}

function projectIdentityFinding(
  records: MorynRecord[],
  projectId: string | undefined
): MemoryDoctorFinding | undefined {
  if (!projectId) return undefined;
  const currentProject = records.filter((record) => record.project_id === projectId);
  if (!currentProject.length) return undefined;
  const relatedProjectIds = [
    ...new Set(
      records
        .filter((record) => record.project_id && record.project_id !== projectId)
        .filter((record) => sharedMeaningfulTags(currentProject, [record]).length > 0)
        .map((record) => record.project_id as string)
    )
  ].sort();
  if (!relatedProjectIds.length) return undefined;
  return {
    id: "project_identity_split",
    category: "project_identity",
    severity: "warning",
    summary: "Related memories appear under multiple project ids.",
    reason: `Current project ${projectId} shares tags with ${relatedProjectIds.join(", ")}.`,
    project_id: projectId,
    related_project_ids: relatedProjectIds
  };
}

function actionFindings(promotable: MorynRecord[], markerNoise: MorynRecord[]): MemoryDoctorFinding[] {
  return [
    ...promotable.map((record) => ({
      id: `promote:${record.id}`,
      category: "candidate_quality" as const,
      severity: "info" as const,
      summary: "High-confidence candidate is ready for user promotion review.",
      reason: "Candidate is user-confirmed or a high-confidence high-priority rule.",
      record_id: record.id,
      record_ids: [record.id]
    })),
    ...markerNoise.map((record) => ({
      id: `archive:${record.id}`,
      category: "candidate_quality" as const,
      severity: "info" as const,
      summary: "Candidate looks like smoke/e2e marker noise.",
      reason: "Record text or tags contain e2e, smoke, or marker.",
      record_id: record.id,
      record_ids: [record.id]
    }))
  ];
}

function stableRecordSort(left: MorynRecord, right: MorynRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function uniqueActions(actions: MemoryDoctorSuggestedAction[], limit: number): MemoryDoctorSuggestedAction[] {
  const byId = new Map<string, MemoryDoctorSuggestedAction>();
  for (const action of actions) {
    if (!byId.has(action.action_id)) byId.set(action.action_id, action);
  }
  return [...byId.values()].slice(0, limit);
}

export function diagnoseMemory(input: MemoryDoctorDiagnoseInput): MemoryDoctorResult {
  const limit = input.limit ?? 20;
  const records = [...input.records].sort(stableRecordSort);
  const memoryStats = stats(records, input.excluded_private_records ?? 0);
  const promotable = records.filter(isPromotableCandidate).slice(0, limit);
  const markerNoise = records.filter(isMarkerNoiseCandidate).slice(0, limit);
  const duplicateGroups = duplicateCandidateGroups(records);
  const duplicateRecordsForActions = duplicateGroups.flatMap((group) => group.slice(1)).slice(0, limit);
  const conflictRecords = conflictingCandidates(records).slice(0, limit);
  const findings = [
    candidateBacklogFinding(memoryStats),
    projectIdentityFinding(records, input.project_id),
    duplicateCandidateFinding(duplicateGroups),
    conflictingCandidateFinding(conflictRecords),
    ...actionFindings(promotable, markerNoise)
  ].filter((finding): finding is MemoryDoctorFinding => finding !== undefined);
  const actions = uniqueActions(
    [
      ...promotable.map(promoteAction),
      ...markerNoise.map(archiveAction),
      ...duplicateGroups.flatMap((group) =>
        group.slice(1).flatMap((record) => [linkDuplicateAction(record, group[0]!), archiveDuplicateAction(record)])
      ),
      ...conflictRecords.flatMap((record) => [
        reviseConflictAction(record),
        inspectConflictAction(record, input.project_id)
      ]),
      ...(findings.some((finding) => finding.id === "project_identity_split") ? [projectListAction()] : [])
    ],
    limit
  );
  const referencedRecordIds = new Set([
    ...findings.flatMap((finding) => finding.record_ids ?? (finding.record_id ? [finding.record_id] : [])),
    ...actions.flatMap((action) => (typeof action.arguments.record_id === "string" ? [action.arguments.record_id] : []))
  ]);
  const recordSelection = records
    .filter(
      (record) =>
        referencedRecordIds.has(record.id) || duplicateRecordsForActions.some((duplicate) => duplicate.id === record.id)
    )
    .slice(0, limit);
  return {
    read_only: true,
    ...(input.project_id ? { project_id: input.project_id } : {}),
    stats: memoryStats,
    findings,
    findings_by_id: Object.fromEntries(findings.map((finding) => [finding.id, finding])),
    suggested_actions: actions,
    suggested_actions_by_id: Object.fromEntries(actions.map((action) => [action.action_id, action])),
    records: recordSelection,
    records_by_id: recordsById(recordSelection),
    selection_sources: MEMORY_DOCTOR_SELECTION_SOURCES
  };
}
