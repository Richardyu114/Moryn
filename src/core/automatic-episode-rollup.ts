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
  stage: "plan" | "apply";
  reason: string;
  plan_id?: string;
  bucket_key?: string;
}

interface AutomaticEpisodeRollupCommit {
  plan: EpisodeRollupPlan;
  result: EpisodeRollupApplyResult;
}

export interface AutomaticEpisodeRollupResult {
  status: "committed" | "partial" | "failed" | "skipped";
  inspected_plan_count: number;
  eligible_plan_count: number;
  deferred_plan_count: number;
  review_required_plan_count: number;
  privacy_blocked_plan_count: number;
  omitted_private_record_count: number;
  committed: AutomaticEpisodeRollupCommit[];
  failures: AutomaticEpisodeRollupFailure[];
}

export interface AutomaticEpisodeRollupDeps {
  read_records?: typeof readCurrentRecords;
  apply_plan?: typeof applyEpisodeRollupPlan;
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
  let plans: EpisodeRollupPlan[];
  let omittedPrivateRecordCount = 0;
  const privateBucketKeys = new Set<string>();

  try {
    const projectId = typeof input.project_id === "string" ? input.project_id.trim() : "";
    if (!projectId) throw new Error("Automatic Episode Rollup requires project_id as a non-empty string");
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
      status: "failed",
      inspected_plan_count: 0,
      eligible_plan_count: 0,
      deferred_plan_count: 0,
      review_required_plan_count: 0,
      privacy_blocked_plan_count: 0,
      omitted_private_record_count: omittedPrivateRecordCount,
      committed: [],
      failures: [{ stage: "plan", reason: failureReason(error) }]
    };
  }

  const automaticPlans = plans.filter((plan) => plan.status === "ready" && plan.auto_rollup);
  const privacyBlockedPlans = automaticPlans.filter((plan) =>
    privateBucketKeys.has(
      `${plan.identity.project_id}\u0000${plan.identity.bucket_kind}\u0000${plan.identity.bucket_key}`
    )
  );
  const blockedPlanIds = new Set(privacyBlockedPlans.map((plan) => plan.plan_id));
  const eligiblePlans = automaticPlans.filter((plan) => !blockedPlanIds.has(plan.plan_id));
  const committed: AutomaticEpisodeRollupCommit[] = [];
  const failures: AutomaticEpisodeRollupFailure[] = [];
  for (const plan of eligiblePlans) {
    try {
      committed.push({ plan, result: await applyPlan(input.store_path, plan) });
    } catch (error) {
      failures.push({
        stage: "apply",
        reason: failureReason(error),
        plan_id: plan.plan_id,
        bucket_key: plan.identity.bucket_key
      });
    }
  }

  return {
    status: resultStatus(eligiblePlans.length, committed.length, failures.length),
    inspected_plan_count: plans.length,
    eligible_plan_count: eligiblePlans.length,
    deferred_plan_count: plans.filter((plan) => plan.status === "deferred").length,
    review_required_plan_count:
      plans.filter((plan) => plan.status === "review_required").length + privacyBlockedPlans.length,
    privacy_blocked_plan_count: privacyBlockedPlans.length,
    omitted_private_record_count: omittedPrivateRecordCount,
    committed,
    failures
  };
}
