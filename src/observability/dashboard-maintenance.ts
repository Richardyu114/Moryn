import { createHash } from "node:crypto";
import { createEngine } from "../core/engine.js";
import { replayEvents } from "../core/replay.js";
import { readEvents } from "../core/store.js";
import type { MorynRecord, RecordState } from "../core/types.js";

const PRIVATE_RECORD_TAGS = new Set(["private", "secret", "sensitive"]);
const GENERIC_TAGS = new Set(["javascript", "node", "nodejs", "typescript"]);

export type DashboardMaintenancePlanType = "project_identity_repair";

export interface DashboardMaintenanceSafetyCheck {
  id: "dry_run_completed" | "target_project_explicit" | "no_private_records" | "append_only";
  label: string;
  ok: boolean;
}

export interface DashboardMaintenancePlan {
  plan_id: string;
  plan_hash: string;
  type: DashboardMaintenancePlanType;
  finding_id: "project_identity_split";
  from_project_id: string;
  to_project_id: string;
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
    requires_user_confirmation: true;
    safe_to_auto_apply: false;
  };
}

export interface DashboardMaintenanceData {
  plans: DashboardMaintenancePlan[];
}

export interface DashboardMaintenanceOptions {
  project_id?: string;
  include_private?: boolean;
}

export type DashboardMaintenanceApprovalResult =
  | {
    ok: true;
    status: "applied";
    plan_id: string;
    plan_hash: string;
    from_project_id: string;
    to_project_id: string;
    migrated_records: number;
    events_written: number;
  }
  | {
    ok: false;
    status: "plan_not_found" | "stale_plan";
    plan_id: string;
    message: string;
  };

function isPrivateRecord(record: MorynRecord): boolean {
  return record.tags.some((tag) => PRIVATE_RECORD_TAGS.has(tag.toLowerCase()));
}

function meaningfulTags(record: MorynRecord): string[] {
  return record.tags
    .map((tag) => tag.toLowerCase())
    .filter((tag) => tag.length > 0 && !GENERIC_TAGS.has(tag) && !PRIVATE_RECORD_TAGS.has(tag));
}

function hasSharedMeaningfulTag(left: MorynRecord[], record: MorynRecord): boolean {
  const leftTags = new Set(left.flatMap(meaningfulTags));
  return meaningfulTags(record).some((tag) => leftTags.has(tag));
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

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function projectMigrateApplyCommand(fromProjectId: string, toProjectId: string, includePrivate = false): string {
  const parts = [
    "moryn",
    "project",
    "migrate",
    "--from",
    shellQuote(fromProjectId),
    "--to",
    shellQuote(toProjectId),
    "--apply",
    "--confirm"
  ];
  if (includePrivate) parts.push("--include-private");
  return parts.join(" ");
}

function planHash(input: {
  type: DashboardMaintenancePlanType;
  from_project_id: string;
  to_project_id: string;
  record_ids: string[];
  updated_at_by_record_id: Record<string, string>;
  include_private: boolean;
}): string {
  const stableJson = JSON.stringify(input);
  return `sha256:${createHash("sha256").update(stableJson).digest("hex")}`;
}

function buildProjectIdentityPlan(
  allRecords: MorynRecord[],
  fromProjectId: string,
  toProjectId: string,
  includePrivate: boolean
): DashboardMaintenancePlan | undefined {
  const matchingRecords = allRecords
    .filter((record) => record.project_id === fromProjectId)
    .sort(stableRecordSort);
  const records = matchingRecords.filter((record) => includePrivate || !isPrivateRecord(record));
  if (records.length === 0) return undefined;

  const skippedPrivateRecords = matchingRecords.length - records.length;
  const includedPrivateRecords = records.filter(isPrivateRecord).length;
  const recordIds = records.map((record) => record.id);
  const hash = planHash({
    type: "project_identity_repair",
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    record_ids: recordIds,
    updated_at_by_record_id: Object.fromEntries(records.map((record) => [record.id, record.updated_at])),
    include_private: includePrivate
  });

  return {
    plan_id: `project_migrate:${fromProjectId}->${toProjectId}`,
    plan_hash: hash,
    type: "project_identity_repair",
    finding_id: "project_identity_split",
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    command: projectMigrateApplyCommand(fromProjectId, toProjectId, includePrivate),
    record_ids: recordIds,
    dry_run: {
      matched_records: records.length,
      skipped_private_records: skippedPrivateRecords,
      included_private_records: includedPrivateRecords,
      states: stateCounts(records)
    },
    safety_checks: [
      { id: "dry_run_completed", label: "Dry-run completed", ok: true },
      { id: "target_project_explicit", label: "Target project is explicit", ok: toProjectId.length > 0 },
      { id: "no_private_records", label: "No private records included", ok: includedPrivateRecords === 0 },
      { id: "append_only", label: "Operation appends revise_record events only", ok: true }
    ],
    approval: {
      requires_user_confirmation: true,
      safe_to_auto_apply: false
    }
  };
}

export function buildDashboardMaintenance(
  allRecords: MorynRecord[],
  options: DashboardMaintenanceOptions = {}
): DashboardMaintenanceData {
  const projectId = options.project_id;
  if (!projectId) return { plans: [] };
  const includePrivate = options.include_private === true;

  const currentProjectRecords = allRecords
    .filter((record) => record.project_id === projectId)
    .filter((record) => includePrivate || !isPrivateRecord(record));
  if (currentProjectRecords.length === 0) return { plans: [] };

  const relatedProjectIds = [...new Set(allRecords
    .filter((record) => record.project_id && record.project_id !== projectId)
    .filter((record) => hasSharedMeaningfulTag(currentProjectRecords, record))
    .map((record) => record.project_id as string))]
    .sort();

  const plans = relatedProjectIds
    .map((fromProjectId) => buildProjectIdentityPlan(allRecords, fromProjectId, projectId, includePrivate))
    .filter((plan): plan is DashboardMaintenancePlan => plan !== undefined);

  return { plans };
}

async function currentMaintenancePlans(storePath: string, options: DashboardMaintenanceOptions): Promise<DashboardMaintenancePlan[]> {
  const events = await readEvents(storePath);
  const allRecords = [...replayEvents(events).values()];
  return buildDashboardMaintenance(allRecords, options).plans;
}

export async function approveMaintenancePlan(
  storePath: string,
  options: DashboardMaintenanceOptions,
  planId: string,
  planHash: string
): Promise<DashboardMaintenanceApprovalResult> {
  const plans = await currentMaintenancePlans(storePath, options);
  const plan = plans.find((candidate) => candidate.plan_id === planId);
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
  const applied = await engine.migrateProject({
    from_project_id: plan.from_project_id,
    to_project_id: plan.to_project_id,
    dry_run: false,
    confirmed: true,
    include_private: options.include_private === true,
    source: { client: "dashboard", session_id: "dashboard-maintenance-approval" }
  });

  return {
    ok: true,
    status: "applied",
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    from_project_id: plan.from_project_id,
    to_project_id: plan.to_project_id,
    migrated_records: applied.migrated_records,
    events_written: applied.events.length
  };
}
