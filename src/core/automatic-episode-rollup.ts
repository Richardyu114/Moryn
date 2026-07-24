import {
  type AutomaticEpisodeRollupRecoveryPlan,
  countPrivateAutomaticEpisodeRollupRecoveryPlans,
  persistAutomaticEpisodeRollupRecoveryPlan,
  readAutomaticEpisodeRollupRecoveryPlans,
  removeAutomaticEpisodeRollupRecoveryPlan
} from "./automatic-episode-rollup-recovery.js";
import { type EpisodeRollupPlan, episodeRollupSourceBucket, planEpisodeRollups } from "./episode-rollup.js";
import { applyEpisodeRollupPlan, type EpisodeRollupApplyResult } from "./episode-rollup-transaction.js";
import { readCurrentRecords } from "./record-read-model.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";

export interface AutomaticEpisodeRollupInput {
  store_path: string;
  project_id: string;
  now: string;
  include_private?: boolean;
}

interface AutomaticEpisodeRollupFailure {
  stage: "plan" | "persist" | "apply" | "cleanup";
  reason: string;
  plan_id?: string;
  bucket_key?: string;
  recovery?: boolean;
}

interface AutomaticEpisodeRollupCommit {
  plan: EpisodeRollupPlan;
  result: EpisodeRollupApplyResult;
  recovered?: boolean;
}

export interface AutomaticEpisodeRollupResult {
  status: "committed" | "partial" | "failed" | "skipped";
  inspected_plan_count: number;
  eligible_plan_count: number;
  deferred_plan_count: number;
  review_required_plan_count: number;
  privacy_blocked_plan_count: number;
  omitted_private_record_count: number;
  omitted_private_recovery_plan_count: number;
  recovery_attempted_plan_count: number;
  recovered_plan_count: number;
  pending_recovery_plan_count: number;
  committed: AutomaticEpisodeRollupCommit[];
  failures: AutomaticEpisodeRollupFailure[];
}

export interface AutomaticEpisodeRollupDeps {
  read_records?: typeof readCurrentRecords;
  apply_plan?: typeof applyEpisodeRollupPlan;
  read_recovery_plans?: typeof readAutomaticEpisodeRollupRecoveryPlans;
  persist_recovery_plan?: typeof persistAutomaticEpisodeRollupRecoveryPlan;
  remove_recovery_plan?: typeof removeAutomaticEpisodeRollupRecoveryPlan;
  count_private_recovery_plans?: typeof countPrivateAutomaticEpisodeRollupRecoveryPlans;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultStatus(
  eligiblePlanCount: number,
  committedCount: number,
  failureCount: number
): AutomaticEpisodeRollupResult["status"] {
  if (eligiblePlanCount === 0) return "skipped";
  if (failureCount === 0) return "committed";
  return committedCount === 0 ? "failed" : "partial";
}

/**
 * Applies only deterministic, public, closed-day Episode Rollups. Review and
 * deferred plans remain untouched, and private records require an explicit
 * caller opt-in.
 */
export async function runAutomaticEpisodeRollups(
  input: AutomaticEpisodeRollupInput,
  deps: AutomaticEpisodeRollupDeps = {}
): Promise<AutomaticEpisodeRollupResult> {
  const readRecords = deps.read_records ?? readCurrentRecords;
  const applyPlan = deps.apply_plan ?? applyEpisodeRollupPlan;
  const readRecoveryPlans = deps.read_recovery_plans ?? readAutomaticEpisodeRollupRecoveryPlans;
  const persistRecoveryPlan = deps.persist_recovery_plan ?? persistAutomaticEpisodeRollupRecoveryPlan;
  const removeRecoveryPlan = deps.remove_recovery_plan ?? removeAutomaticEpisodeRollupRecoveryPlan;
  const countPrivateRecoveryPlans =
    deps.count_private_recovery_plans ?? countPrivateAutomaticEpisodeRollupRecoveryPlans;
  const projectId = typeof input.project_id === "string" ? input.project_id.trim() : "";
  let plans: EpisodeRollupPlan[];
  let omittedPrivateRecordCount = 0;
  let omittedPrivateRecoveryPlanCount = 0;
  const privateBucketKeys = new Set<string>();
  const committed: AutomaticEpisodeRollupCommit[] = [];
  const failures: AutomaticEpisodeRollupFailure[] = [];
  const recoveryBlockedBucketKeys = new Set<string>();
  const pendingRecoveryPlanIds = new Set<string>();
  let recoveryPlans: AutomaticEpisodeRollupRecoveryPlan[];

  try {
    if (!projectId) throw new Error("Automatic Episode Rollup requires project_id as a non-empty string");
    recoveryPlans = await readRecoveryPlans(input.store_path, projectId, {
      include_private: input.include_private
    });
    omittedPrivateRecoveryPlanCount = input.include_private
      ? 0
      : await countPrivateRecoveryPlans(input.store_path, projectId);
    for (const artifact of recoveryPlans) pendingRecoveryPlanIds.add(artifact.plan.plan_id);
  } catch (error) {
    return {
      status: "failed",
      inspected_plan_count: 0,
      eligible_plan_count: 0,
      deferred_plan_count: 0,
      review_required_plan_count: 0,
      privacy_blocked_plan_count: 0,
      omitted_private_record_count: 0,
      omitted_private_recovery_plan_count: 0,
      recovery_attempted_plan_count: 0,
      recovered_plan_count: 0,
      pending_recovery_plan_count: 0,
      committed: [],
      failures: [{ stage: "plan", reason: failureReason(error) }]
    };
  }

  for (const artifact of recoveryPlans) {
    const plan = artifact.plan;
    try {
      const result = await applyPlan(input.store_path, plan);
      committed.push({ plan, result, recovered: true });
    } catch (error) {
      recoveryBlockedBucketKeys.add(plan.identity.bucket_key);
      failures.push({
        stage: "apply",
        reason: failureReason(error),
        plan_id: plan.plan_id,
        bucket_key: plan.identity.bucket_key,
        recovery: true
      });
      continue;
    }
    try {
      await removeRecoveryPlan(input.store_path, plan);
      pendingRecoveryPlanIds.delete(plan.plan_id);
    } catch (error) {
      failures.push({
        stage: "cleanup",
        reason: failureReason(error),
        plan_id: plan.plan_id,
        bucket_key: plan.identity.bucket_key,
        recovery: true
      });
    }
  }

  try {
    const current = await readRecords(input.store_path);
    const projectRecords = current.records.filter((record) => record.project_id === projectId);
    omittedPrivateRecordCount = input.include_private ? 0 : projectRecords.filter(isPrivateMemoryBoundary).length;
    if (!input.include_private) {
      for (const record of projectRecords) {
        if (!isPrivateMemoryBoundary(record)) continue;
        const source = episodeRollupSourceBucket(record, "day");
        if (source) {
          privateBucketKeys.add(
            `${source.identity.project_id}\u0000${source.identity.bucket_kind}\u0000${source.identity.bucket_key}`
          );
        }
      }
    }
    const visibleRecords = input.include_private
      ? current.records
      : current.records.filter((record) => !isPrivateMemoryBoundary(record));
    plans = planEpisodeRollups(visibleRecords, {
      project_id: projectId,
      bucket_kind: "day",
      now: input.now
    });
  } catch (error) {
    return {
      status: committed.length > 0 ? "partial" : "failed",
      inspected_plan_count: recoveryPlans.length,
      eligible_plan_count: recoveryPlans.length,
      deferred_plan_count: 0,
      review_required_plan_count: 0,
      privacy_blocked_plan_count: 0,
      omitted_private_record_count: omittedPrivateRecordCount,
      omitted_private_recovery_plan_count: omittedPrivateRecoveryPlanCount,
      recovery_attempted_plan_count: recoveryPlans.length,
      recovered_plan_count: committed.filter((commit) => commit.recovered).length,
      pending_recovery_plan_count: pendingRecoveryPlanIds.size,
      committed,
      failures: [...failures, { stage: "plan", reason: failureReason(error) }]
    };
  }

  const automaticPlans = plans.filter((plan) => plan.status === "ready" && plan.auto_rollup);
  const privacyBlockedPlans = automaticPlans.filter((plan) =>
    privateBucketKeys.has(
      `${plan.identity.project_id}\u0000${plan.identity.bucket_kind}\u0000${plan.identity.bucket_key}`
    )
  );
  const blockedPlanIds = new Set(privacyBlockedPlans.map((plan) => plan.plan_id));
  const recoveryBlockedPlans = automaticPlans.filter((plan) => recoveryBlockedBucketKeys.has(plan.identity.bucket_key));
  const blockedForReviewPlanIds = new Set([
    ...privacyBlockedPlans.map((plan) => plan.plan_id),
    ...recoveryBlockedPlans.map((plan) => plan.plan_id)
  ]);
  const eligiblePlans = automaticPlans.filter(
    (plan) => !blockedPlanIds.has(plan.plan_id) && !recoveryBlockedBucketKeys.has(plan.identity.bucket_key)
  );
  for (const plan of eligiblePlans) {
    try {
      await persistRecoveryPlan(input.store_path, plan);
      pendingRecoveryPlanIds.add(plan.plan_id);
    } catch (error) {
      failures.push({
        stage: "persist",
        reason: failureReason(error),
        plan_id: plan.plan_id,
        bucket_key: plan.identity.bucket_key
      });
      continue;
    }
    try {
      committed.push({ plan, result: await applyPlan(input.store_path, plan) });
    } catch (error) {
      failures.push({
        stage: "apply",
        reason: failureReason(error),
        plan_id: plan.plan_id,
        bucket_key: plan.identity.bucket_key
      });
      continue;
    }
    try {
      await removeRecoveryPlan(input.store_path, plan);
      pendingRecoveryPlanIds.delete(plan.plan_id);
    } catch (error) {
      failures.push({
        stage: "cleanup",
        reason: failureReason(error),
        plan_id: plan.plan_id,
        bucket_key: plan.identity.bucket_key
      });
    }
  }

  const eligiblePlanCount = recoveryPlans.length + eligiblePlans.length;

  return {
    status: resultStatus(eligiblePlanCount, committed.length, failures.length),
    inspected_plan_count: recoveryPlans.length + plans.length,
    eligible_plan_count: eligiblePlanCount,
    deferred_plan_count: plans.filter((plan) => plan.status === "deferred").length,
    review_required_plan_count:
      plans.filter((plan) => plan.status === "review_required").length + blockedForReviewPlanIds.size,
    privacy_blocked_plan_count: privacyBlockedPlans.length,
    omitted_private_record_count: omittedPrivateRecordCount,
    omitted_private_recovery_plan_count: omittedPrivateRecoveryPlanCount,
    recovery_attempted_plan_count: recoveryPlans.length,
    recovered_plan_count: committed.filter((commit) => commit.recovered).length,
    pending_recovery_plan_count: pendingRecoveryPlanIds.size,
    committed,
    failures
  };
}
