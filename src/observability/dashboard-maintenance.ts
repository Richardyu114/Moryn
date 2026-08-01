import { createHash } from "node:crypto";
import { displayRecordText } from "../core/content-text.js";
import { createEngine } from "../core/engine.js";
import { buildActiveLogicalMemoryView } from "../core/logical-memory.js";
import {
  activeProjectAliasAttestations,
  PROJECT_ALIAS_ATTESTATION_TYPE,
  projectAliasAttestationConflict,
  projectAliasAttestationIdentity,
  projectAliasAttestationKey,
  readProjectAliasAttestation,
  readProjectAliasAttestationDeclaration,
  recordProjectAliasAttestation
} from "../core/project-alias-attestation.js";
import { replayEvents } from "../core/replay.js";
import { isPrivateMemoryBoundary } from "../core/sensitive.js";
import { withStoreStateLease } from "../core/state-lease.js";
import { readEvents } from "../core/store.js";
import type { MorynRecord, RecordState } from "../core/types.js";

const PRIVATE_RECORD_TAGS = new Set(["private", "secret", "sensitive"]);
const GENERIC_TAGS = new Set(["javascript", "node", "nodejs", "typescript"]);
const ARCHIVE_MARKER_REASON = "Memory doctor: e2e marker/noise candidate";

export type DashboardMaintenancePlanType = "project_identity_repair" | "candidate_noise_archive";

export interface DashboardMaintenanceSafetyCheck {
  id:
    | "dry_run_completed"
    | "target_project_explicit"
    | "exact_record_selection"
    | "alias_attestation"
    | "alias_topology"
    | "eligible_record_states"
    | "no_unresolved_conflicts"
    | "candidate_noise_detected"
    | "no_private_records"
    | "append_only";
  label: string;
  ok: boolean;
}

export interface DashboardMaintenanceDecisionCard {
  title: string;
  issue: string;
  impact: string;
  recommended_action: string;
  rollback_path: string;
  evidence: string[];
  examples: DashboardMaintenanceRecordExample[];
  raw_evidence: {
    plan_hash: string;
    command: string;
    record_ids: string[];
    safety_checks: DashboardMaintenanceSafetyCheck[];
  };
}

export interface DashboardMaintenanceRecordExample {
  record_id: string;
  kind: MorynRecord["kind"];
  type: string;
  state: RecordState;
  updated_at: string;
  preview: string;
}

export interface DashboardMaintenancePlan {
  plan_id: string;
  plan_hash: string;
  type: DashboardMaintenancePlanType;
  finding_id: "project_identity_split" | "candidate_marker_noise";
  from_project_id?: string;
  to_project_id?: string;
  command: string;
  record_ids: string[];
  dry_run: {
    matched_records: number;
    skipped_private_records: number;
    included_private_records: number;
    states: Partial<Record<RecordState, number>>;
  };
  safety_checks: DashboardMaintenanceSafetyCheck[];
  approval: {
    requires_user_confirmation: boolean;
    safe_to_auto_apply: boolean;
  };
  decision_card: DashboardMaintenanceDecisionCard;
}

export interface DashboardMaintenanceData {
  plans: DashboardMaintenancePlan[];
  plans_by_id: Record<string, DashboardMaintenancePlan>;
}

export interface DashboardMaintenanceApprovalTrace {
  timeline_commands: string[];
  recall_commands: string[];
}

export interface DashboardMaintenanceOptions {
  project_id?: string;
  include_private?: boolean;
}

export const AUTOMATIC_DASHBOARD_MAINTENANCE_MAX_PLANS = 1;

export interface AutomaticDashboardMaintenanceResult {
  status: "applied" | "skipped" | "failed";
  maximum_plans: 1;
  evaluated_plans: number;
  eligible_plans: number;
  applied_plan_ids: string[];
  records_changed: number;
  event_ids: string[];
  failures: Array<{ plan_id?: string; reason: string }>;
}

export type DashboardMaintenanceApprovalResult =
  | {
      ok: true;
      status: "applied";
      plan_id: string;
      plan_hash: string;
      from_project_id?: string;
      to_project_id?: string;
      migrated_records: number;
      records_changed: number;
      events_written: number;
      record_ids: string[];
      event_ids: string[];
      alias_attestation?: {
        created: boolean;
        reactivated: boolean;
        record_id: string;
        event_id: string;
      };
      trace: DashboardMaintenanceApprovalTrace;
    }
  | {
      ok: true;
      status: "applied";
      plan_id: string;
      plan_hash: string;
      archived_records: number;
      records_changed: number;
      events_written: number;
      record_ids: string[];
      event_ids: string[];
      trace: DashboardMaintenanceApprovalTrace;
    }
  | {
      ok: false;
      status: "plan_not_found" | "stale_plan" | "alias_conflict";
      plan_id: string;
      message: string;
    };

function meaningfulTags(record: MorynRecord): string[] {
  return record.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.length > 0 && !GENERIC_TAGS.has(tag) && !PRIVATE_RECORD_TAGS.has(tag));
}

function hasGeneratedLegacyProjectId(sourceProjectId: string, targetProjectId: string): boolean {
  const source = sourceProjectId.toLowerCase();
  const target = targetProjectId.toLowerCase();
  if (source === target) return sourceProjectId !== targetProjectId;
  for (const separator of ["-", "_"]) {
    const prefix = `${target}${separator}`;
    if (!source.startsWith(prefix)) continue;
    return /^[a-f0-9]{8,64}$/u.test(source.slice(prefix.length));
  }
  return false;
}

function hasExplicitProjectIdentityEvidence(
  currentProjectTags: ReadonlySet<string>,
  record: MorynRecord,
  targetProjectId: string
): boolean {
  if (!record.project_id) return false;
  if (hasGeneratedLegacyProjectId(record.project_id, targetProjectId)) return true;

  const targetTag = targetProjectId.toLowerCase();
  return currentProjectTags.has(targetTag) && meaningfulTags(record).includes(targetTag);
}

function isMarkerNoiseCandidate(record: MorynRecord): boolean {
  if (record.state !== "candidate") return false;
  const haystack = `${record.kind} ${record.type} ${record.tags.join(" ")} ${displayRecordText(record)}`.toLowerCase();
  return /\b(?:e2e|smoke|marker)\b/.test(haystack);
}

function stableRecordSort(left: MorynRecord, right: MorynRecord): number {
  return right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id);
}

function stateCounts(records: MorynRecord[]): Partial<Record<RecordState, number>> {
  const counts: Partial<Record<RecordState, number>> = {};
  for (const record of records) {
    counts[record.state] = (counts[record.state] ?? 0) + 1;
  }
  return counts;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function stateSummary(states: Partial<Record<RecordState, number>>): string {
  const order: RecordState[] = ["canonical", "candidate", "raw", "archived", "quarantined"];
  return order
    .filter((state) => states[state])
    .map((state) => pluralize(states[state] ?? 0, state, state))
    .join(", ");
}

function privateRecordsSummary(skipped: number, included: number): string {
  if (included > 0) return `${pluralize(included, "private record")} included.`;
  if (skipped > 0) return `${pluralize(skipped, "private record")} skipped.`;
  return "No private records included.";
}

function recordExamples(records: MorynRecord[]): DashboardMaintenanceRecordExample[] {
  return records.slice(0, 5).map((record) => {
    const text = displayRecordText(record).replace(/\s+/g, " ").trim();
    return {
      record_id: record.id,
      kind: record.kind,
      type: record.type,
      state: record.state,
      updated_at: record.updated_at,
      preview: text.length > 180 ? `${text.slice(0, 177).trimEnd()}...` : text || `${record.kind} / ${record.type}`
    };
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendProjectId(parts: string[], projectId: string | undefined): void {
  if (projectId) parts.push("--project-id", projectId);
}

function recallCommand(recordId: string, projectId: string | undefined): string {
  const parts = ["moryn", "recall", "--record-id", recordId];
  appendProjectId(parts, projectId);
  return parts.join(" ");
}

function timelineEventCommand(eventId: string, projectId: string | undefined): string {
  const parts = ["moryn", "timeline", "--event-id", eventId];
  appendProjectId(parts, projectId);
  return parts.join(" ");
}

function approvalTrace(
  eventIds: string[],
  recordIds: string[],
  projectId: string | undefined
): DashboardMaintenanceApprovalTrace {
  return {
    timeline_commands: eventIds.map((eventId) => timelineEventCommand(eventId, projectId)),
    recall_commands: recordIds.map((recordId) => recallCommand(recordId, projectId))
  };
}

function exactProjectRevisionCommand(recordId: string, projectId: string, reason: string): string {
  return [
    "moryn",
    "revise",
    shellQuote(recordId),
    "--set",
    shellQuote(`project_id=${projectId}`),
    "--reason",
    shellQuote(reason),
    "--confirm"
  ].join(" ");
}

function exactProjectApplyCommand(recordIds: string[], fromProjectId: string, toProjectId: string): string {
  return recordIds
    .map((recordId) =>
      exactProjectRevisionCommand(
        recordId,
        toProjectId,
        `Project identity migration: ${fromProjectId} -> ${toProjectId}`
      )
    )
    .join(" && ");
}

function exactProjectRollbackCommand(recordIds: string[], fromProjectId: string, toProjectId: string): string {
  const attestationId = projectAliasAttestationIdentity(fromProjectId, toProjectId).record_id;
  const revoke = [
    "moryn",
    "archive",
    shellQuote(attestationId),
    "--reason",
    shellQuote(`Revoke project alias: ${fromProjectId} -> ${toProjectId}`)
  ].join(" ");
  const restore = recordIds.map((recordId) =>
    exactProjectRevisionCommand(
      recordId,
      fromProjectId,
      `Rollback project alias migration: ${fromProjectId} -> ${toProjectId}`
    )
  );
  return [revoke, ...restore].join(" && ");
}

function projectMigrationIdempotencyKey(planHash: string, recordId: string): string {
  const digest = createHash("sha256").update(`${planHash}\u0000${recordId}`).digest("hex");
  return `dashboard-project-alias:${digest}`;
}

function projectAliasReactivationIdempotencyKey(planHash: string, record: MorynRecord): string {
  const digest = createHash("sha256").update(`${planHash}\u0000${record.id}\u0000${record.updated_at}`).digest("hex");
  return `dashboard-project-alias-reactivate:${digest}`;
}

function planHash(input: {
  type: DashboardMaintenancePlanType;
  from_project_id?: string;
  to_project_id?: string;
  record_ids: string[];
  updated_at_by_record_id: Record<string, string>;
  include_private: boolean;
  alias_attestation_guard?: {
    record_id: string;
    state: RecordState | "missing";
    visibility?: MorynRecord["visibility"];
    updated_at?: string;
    declaration?: ReturnType<typeof readProjectAliasAttestationDeclaration> | null;
  };
}): string {
  const stableJson = JSON.stringify(input);
  return `sha256:${createHash("sha256").update(stableJson).digest("hex")}`;
}

function projectAliasPlanGuard(
  records: MorynRecord[],
  fromProjectId: string,
  toProjectId: string
): NonNullable<Parameters<typeof planHash>[0]["alias_attestation_guard"]> {
  const recordId = projectAliasAttestationIdentity(fromProjectId, toProjectId).record_id;
  const record = records.find((candidate) => candidate.id === recordId);
  if (!record) return { record_id: recordId, state: "missing" };
  return {
    record_id: recordId,
    state: record.state,
    visibility: record.visibility,
    updated_at: record.updated_at,
    declaration: readProjectAliasAttestationDeclaration(record) ?? null
  };
}

function candidateArchiveApplyCommand(records: MorynRecord[]): string {
  return records
    .map((record) =>
      ["moryn", "archive", shellQuote(record.id), "--reason", shellQuote(ARCHIVE_MARKER_REASON)].join(" ")
    )
    .join(" && ");
}

function buildCandidateNoiseArchivePlan(
  allRecords: MorynRecord[],
  projectId: string,
  includePrivate: boolean
): DashboardMaintenancePlan | undefined {
  const matchingRecords = allRecords
    .filter((record) => record.project_id === projectId)
    .filter(isMarkerNoiseCandidate)
    .sort(stableRecordSort);
  const records = matchingRecords.filter((record) => includePrivate || !isPrivateMemoryBoundary(record));
  if (records.length === 0) return undefined;

  const skippedPrivateRecords = matchingRecords.length - records.length;
  const includedPrivateRecords = records.filter(isPrivateMemoryBoundary).length;
  const recordIds = records.map((record) => record.id);
  const states = stateCounts(records);
  const hash = planHash({
    type: "candidate_noise_archive",
    to_project_id: projectId,
    record_ids: recordIds,
    updated_at_by_record_id: Object.fromEntries(records.map((record) => [record.id, record.updated_at])),
    include_private: includePrivate
  });
  const command = candidateArchiveApplyCommand(records);
  const safetyChecks: DashboardMaintenanceSafetyCheck[] = [
    { id: "dry_run_completed", label: "Dry-run completed", ok: true },
    { id: "candidate_noise_detected", label: "Only smoke/e2e/marker candidates selected", ok: true },
    { id: "no_private_records", label: "No private records included", ok: includedPrivateRecords === 0 },
    { id: "append_only", label: "Operation appends archive_record events only", ok: true }
  ];

  return {
    plan_id: `candidate_noise_archive:${projectId}`,
    plan_hash: hash,
    type: "candidate_noise_archive",
    finding_id: "candidate_marker_noise",
    to_project_id: projectId,
    command,
    record_ids: recordIds,
    dry_run: {
      matched_records: records.length,
      skipped_private_records: skippedPrivateRecords,
      included_private_records: includedPrivateRecords,
      states
    },
    safety_checks: safetyChecks,
    approval: {
      requires_user_confirmation: true,
      safe_to_auto_apply: false
    },
    decision_card: {
      title: "Candidate noise cleanup",
      issue: `${pluralize(records.length, "candidate record")} look${records.length === 1 ? "s" : ""} like smoke/e2e marker noise.`,
      impact: "Candidate review stays noisy until confirmed test markers are archived.",
      recommended_action: "Archive these candidates only after confirming they are test noise or obsolete markers.",
      rollback_path:
        "If this was wrong, use the record ids and timeline events below to inspect the append-only archive before restoring manually.",
      evidence: [
        `Matched records: ${pluralize(records.length, "record")}; ${stateSummary(states)}.`,
        `Private records: ${privateRecordsSummary(skippedPrivateRecords, includedPrivateRecords)}`,
        "Write behavior: append-only archive_record events; no deletion."
      ],
      examples: recordExamples(records),
      raw_evidence: {
        plan_hash: hash,
        command,
        record_ids: recordIds,
        safety_checks: safetyChecks
      }
    }
  };
}

function buildProjectIdentityPlan(
  allRecords: MorynRecord[],
  fromProjectId: string,
  toProjectId: string,
  includePrivate: boolean,
  aliasAttested: boolean,
  logicalConflictRecordIds: ReadonlySet<string>
): DashboardMaintenancePlan | undefined {
  const matchingRecords = allRecords
    .filter((record) => record.project_id === fromProjectId)
    .filter((record) => record.type !== PROJECT_ALIAS_ATTESTATION_TYPE)
    .sort(stableRecordSort);
  const records = matchingRecords.filter((record) => includePrivate || !isPrivateMemoryBoundary(record));
  if (records.length === 0) return undefined;

  const skippedPrivateRecords = matchingRecords.length - records.length;
  const includedPrivateRecords = records.filter(isPrivateMemoryBoundary).length;
  const recordIds = records.map((record) => record.id);
  const states = stateCounts(records);
  const hash = planHash({
    type: "project_identity_repair",
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    record_ids: recordIds,
    updated_at_by_record_id: Object.fromEntries(records.map((record) => [record.id, record.updated_at])),
    include_private: includePrivate,
    alias_attestation_guard: projectAliasPlanGuard(allRecords, fromProjectId, toProjectId)
  });
  const command = exactProjectApplyCommand(recordIds, fromProjectId, toProjectId);
  const aliasConflict = projectAliasAttestationConflict(allRecords, fromProjectId, toProjectId);
  const safetyChecks: DashboardMaintenanceSafetyCheck[] = [
    { id: "dry_run_completed", label: "Dry-run completed", ok: true },
    { id: "target_project_explicit", label: "Target project is explicit", ok: toProjectId.length > 0 },
    {
      id: "exact_record_selection",
      label: "Apply is limited to the sealed record ids",
      ok: true
    },
    {
      id: "alias_attestation",
      label: "Alias direction was user-confirmed",
      ok: aliasAttested
    },
    {
      id: "alias_topology",
      label: "Alias does not conflict, chain, or form a cycle",
      ok: aliasConflict === undefined
    },
    {
      id: "eligible_record_states",
      label: "No quarantined records included",
      ok: records.every((record) => record.state !== "quarantined" && record.visibility !== "quarantined")
    },
    {
      id: "no_unresolved_conflicts",
      label: "No unresolved record conflicts included",
      ok: records.every(
        (record) => record.conflict?.resolution !== "needs_review" && !logicalConflictRecordIds.has(record.id)
      )
    },
    { id: "no_private_records", label: "No private records included", ok: includedPrivateRecords === 0 },
    { id: "append_only", label: "Operation appends events without rewriting history", ok: true }
  ];
  const safeToAutoApply = aliasAttested && safetyChecks.every((check) => check.ok);
  const rollbackCommand = exactProjectRollbackCommand(recordIds, fromProjectId, toProjectId);

  return {
    plan_id: `project_migrate:${fromProjectId}->${toProjectId}`,
    plan_hash: hash,
    type: "project_identity_repair",
    finding_id: "project_identity_split",
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    command,
    record_ids: recordIds,
    dry_run: {
      matched_records: records.length,
      skipped_private_records: skippedPrivateRecords,
      included_private_records: includedPrivateRecords,
      states
    },
    safety_checks: safetyChecks,
    approval: {
      requires_user_confirmation: !safeToAutoApply,
      safe_to_auto_apply: safeToAutoApply
    },
    decision_card: {
      title: "Project identity repair",
      issue: `${pluralize(records.length, "record")} under ${fromProjectId} likely belong${records.length === 1 ? "s" : ""} to ${toProjectId}.`,
      impact: `Boot and recall can miss these memories when agents ask for project ${toProjectId}.`,
      recommended_action: aliasConflict
        ? `Revoke the conflicting alias (${aliasConflict.conflicting_directions.join(", ")}) before approving this direction.`
        : aliasAttested
          ? `Absorb these late records using the confirmed ${fromProjectId} -> ${toProjectId} alias.`
          : `Apply the repair once to confirm ${fromProjectId} is an old id for ${toProjectId}; later records can then move automatically.`,
      rollback_path: `If this was wrong, revoke the alias and restore only this plan's records with ${rollbackCommand}.`,
      evidence: [
        `Matched records: ${pluralize(records.length, "record")}; ${stateSummary(states)}.`,
        `Private records: ${privateRecordsSummary(skippedPrivateRecords, includedPrivateRecords)}`,
        "Write behavior: one durable alias attestation plus exact append-only revisions; no history rewrite."
      ],
      examples: recordExamples(records),
      raw_evidence: {
        plan_hash: hash,
        command,
        record_ids: recordIds,
        safety_checks: safetyChecks
      }
    }
  };
}

export function buildDashboardMaintenance(
  allRecords: MorynRecord[],
  options: DashboardMaintenanceOptions = {}
): DashboardMaintenanceData {
  const projectId = options.project_id;
  if (!projectId) return { plans: [], plans_by_id: {} };
  const includePrivate = options.include_private === true;
  const maintenanceRecords = allRecords.filter((record) => record.kind !== "soul");
  const visibleRecords = maintenanceRecords.filter((record) => includePrivate || !isPrivateMemoryBoundary(record));

  const currentProjectRecords = visibleRecords.filter((record) => record.project_id === projectId);
  if (currentProjectRecords.length === 0) return { plans: [], plans_by_id: {} };
  const currentProjectTags = new Set(
    currentProjectRecords.filter((record) => record.type !== PROJECT_ALIAS_ATTESTATION_TYPE).flatMap(meaningfulTags)
  );
  const aliasAttestations = activeProjectAliasAttestations(maintenanceRecords);
  const logicalConflictRecordIds = new Set(buildActiveLogicalMemoryView(maintenanceRecords).conflict_record_ids);
  const attestedSourceProjectIds = [...aliasAttestations.values()]
    .filter((attestation) => attestation.to_project_id === projectId)
    .map((attestation) => attestation.from_project_id);

  const relatedProjectIds = [
    ...new Set([
      ...visibleRecords
        .filter((record) => record.project_id && record.project_id !== projectId)
        .filter((record) => hasExplicitProjectIdentityEvidence(currentProjectTags, record, projectId))
        .map((record) => record.project_id as string),
      ...attestedSourceProjectIds
    ])
  ].sort();

  const plans = relatedProjectIds
    .map((fromProjectId) =>
      buildProjectIdentityPlan(
        maintenanceRecords,
        fromProjectId,
        projectId,
        includePrivate,
        aliasAttestations.has(projectAliasAttestationKey(fromProjectId, projectId)),
        logicalConflictRecordIds
      )
    )
    .filter((plan): plan is DashboardMaintenancePlan => plan !== undefined);
  const candidateNoiseArchivePlan = buildCandidateNoiseArchivePlan(maintenanceRecords, projectId, includePrivate);
  if (candidateNoiseArchivePlan) plans.push(candidateNoiseArchivePlan);

  return {
    plans,
    plans_by_id: Object.fromEntries(plans.map((plan) => [plan.plan_id, plan]))
  };
}

async function currentMaintenanceSnapshot(
  storePath: string,
  options: DashboardMaintenanceOptions
): Promise<{ records: MorynRecord[]; plans: DashboardMaintenancePlan[] }> {
  const events = await readEvents(storePath);
  const records = [...replayEvents(events).values()];
  return { records, plans: buildDashboardMaintenance(records, options).plans };
}

export async function approveMaintenancePlan(
  storePath: string,
  options: DashboardMaintenanceOptions,
  planId: string,
  planHash: string,
  execution: { automatic?: boolean } = {}
): Promise<DashboardMaintenanceApprovalResult> {
  return withStoreStateLease(storePath, async () => {
    const snapshot = await currentMaintenanceSnapshot(storePath, options);
    const plan = snapshot.plans.find((candidate) => candidate.plan_id === planId);
    if (!plan) {
      return {
        ok: false,
        status: "plan_not_found",
        plan_id: planId,
        message: "This maintenance plan is no longer available."
      };
    }
    if (plan.plan_hash !== planHash) {
      return {
        ok: false,
        status: "stale_plan",
        plan_id: planId,
        message: "The store changed after this plan was rendered. Review the refreshed plan before approving."
      };
    }

    const engine = createEngine({ storePath });
    const batchId = plan.plan_hash.replace(/^sha256:/u, "").slice(0, 16);
    const source = {
      client: "dashboard",
      session_id: `${execution.automatic ? "dashboard-maintenance-auto" : "dashboard-maintenance-approval"}:${batchId}`
    };
    if (plan.type === "candidate_noise_archive") {
      const eventIds: string[] = [];
      for (const recordId of plan.record_ids) {
        const archived = await engine.archive({
          record_id: recordId,
          reason: ARCHIVE_MARKER_REASON,
          source
        });
        eventIds.push(archived.event.event_id);
      }

      return {
        ok: true,
        status: "applied",
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        archived_records: plan.record_ids.length,
        records_changed: plan.record_ids.length,
        events_written: eventIds.length,
        record_ids: plan.record_ids,
        event_ids: eventIds,
        trace: approvalTrace(eventIds, plan.record_ids, plan.to_project_id)
      };
    }

    const fromProjectId = plan.from_project_id ?? "";
    const toProjectId = plan.to_project_id ?? "";
    const aliasConflict = projectAliasAttestationConflict(snapshot.records, fromProjectId, toProjectId);
    if (aliasConflict) {
      return {
        ok: false,
        status: "alias_conflict",
        plan_id: planId,
        message: `Project alias conflicts with ${aliasConflict.conflicting_directions.join(", ")}. Revoke the conflicting direction first.`
      };
    }
    if (execution.automatic && !plan.approval.safe_to_auto_apply) {
      return {
        ok: false,
        status: "stale_plan",
        plan_id: planId,
        message: "Automatic project repair requires an active user-confirmed alias attestation."
      };
    }

    const attestation = execution.automatic
      ? undefined
      : await recordProjectAliasAttestation(storePath, {
          from_project_id: fromProjectId,
          to_project_id: toProjectId,
          confirmed_at: new Date().toISOString(),
          source
        });
    let attestationReactivationEventId: string | undefined;
    if (attestation && !attestation.created) {
      const currentAttestationRecord = replayEvents(await readEvents(storePath)).get(attestation.record.id);
      if (!currentAttestationRecord) {
        throw new Error(`Project alias attestation disappeared: ${attestation.record.id}`);
      }
      if (!readProjectAliasAttestation(currentAttestationRecord)) {
        const declaration = readProjectAliasAttestationDeclaration(currentAttestationRecord);
        if (!declaration || currentAttestationRecord.state !== "archived") {
          throw new Error(`Project alias attestation cannot be reactivated: ${attestation.record.id}`);
        }
        const reactivated = await engine.promote({
          record_id: currentAttestationRecord.id,
          target_state: "canonical",
          reason: `User re-approved project alias: ${fromProjectId} -> ${toProjectId}`,
          confirmed: true,
          source,
          idempotency_key: projectAliasReactivationIdempotencyKey(plan.plan_hash, currentAttestationRecord)
        });
        attestationReactivationEventId = reactivated.event.event_id;
        const reactivatedRecord = replayEvents(await readEvents(storePath)).get(currentAttestationRecord.id);
        if (!reactivatedRecord || !readProjectAliasAttestation(reactivatedRecord)) {
          throw new Error(`Project alias attestation reactivation failed: ${currentAttestationRecord.id}`);
        }
      }
    }
    const migrationEventIds: string[] = [];
    for (const recordId of plan.record_ids) {
      const revised = await engine.revise({
        record_id: recordId,
        patch: { project_id: toProjectId },
        reason: `Project identity migration: ${fromProjectId} -> ${toProjectId}`,
        confirmed: true,
        source,
        idempotency_key: projectMigrationIdempotencyKey(plan.plan_hash, recordId)
      });
      migrationEventIds.push(revised.event.event_id);
    }
    const attestationEventIds = attestation?.created
      ? [attestation.event.event_id]
      : attestationReactivationEventId
        ? [attestationReactivationEventId]
        : [];
    const eventIds = [...attestationEventIds, ...migrationEventIds];
    const traceRecordIds = [...(attestation ? [attestation.record.id] : []), ...plan.record_ids];

    return {
      ok: true,
      status: "applied",
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      from_project_id: fromProjectId,
      to_project_id: toProjectId,
      migrated_records: migrationEventIds.length,
      records_changed: migrationEventIds.length,
      events_written: eventIds.length,
      record_ids: plan.record_ids,
      event_ids: eventIds,
      ...(attestation
        ? {
            alias_attestation: {
              created: attestation.created,
              reactivated: attestationReactivationEventId !== undefined,
              record_id: attestation.record.id,
              event_id: attestationReactivationEventId ?? attestation.event.event_id
            }
          }
        : {}),
      trace: approvalTrace(eventIds, traceRecordIds, toProjectId)
    };
  });
}

export async function runAutomaticDashboardMaintenance(
  storePath: string,
  options: DashboardMaintenanceOptions
): Promise<AutomaticDashboardMaintenanceResult> {
  try {
    const { plans } = await currentMaintenanceSnapshot(storePath, options);
    const eligible = plans.filter(
      (plan) =>
        plan.type === "project_identity_repair" &&
        plan.approval.safe_to_auto_apply &&
        !plan.approval.requires_user_confirmation
    );
    const selected = eligible.slice(0, AUTOMATIC_DASHBOARD_MAINTENANCE_MAX_PLANS);
    if (!selected.length) {
      return {
        status: "skipped",
        maximum_plans: AUTOMATIC_DASHBOARD_MAINTENANCE_MAX_PLANS,
        evaluated_plans: plans.length,
        eligible_plans: eligible.length,
        applied_plan_ids: [],
        records_changed: 0,
        event_ids: [],
        failures: []
      };
    }

    const appliedPlanIds: string[] = [];
    const eventIds: string[] = [];
    const failures: AutomaticDashboardMaintenanceResult["failures"] = [];
    let recordsChanged = 0;
    for (const plan of selected) {
      const result = await approveMaintenancePlan(storePath, options, plan.plan_id, plan.plan_hash, {
        automatic: true
      });
      if (!result.ok) {
        failures.push({ plan_id: plan.plan_id, reason: result.message });
        continue;
      }
      appliedPlanIds.push(plan.plan_id);
      recordsChanged += result.records_changed;
      eventIds.push(...result.event_ids);
    }
    return {
      status: failures.length ? "failed" : "applied",
      maximum_plans: AUTOMATIC_DASHBOARD_MAINTENANCE_MAX_PLANS,
      evaluated_plans: plans.length,
      eligible_plans: eligible.length,
      applied_plan_ids: appliedPlanIds,
      records_changed: recordsChanged,
      event_ids: eventIds,
      failures
    };
  } catch (error) {
    return {
      status: "failed",
      maximum_plans: AUTOMATIC_DASHBOARD_MAINTENANCE_MAX_PLANS,
      evaluated_plans: 0,
      eligible_plans: 0,
      applied_plan_ids: [],
      records_changed: 0,
      event_ids: [],
      failures: [{ reason: error instanceof Error ? error.message : String(error) }]
    };
  }
}
