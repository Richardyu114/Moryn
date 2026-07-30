import type { MorynEvent, MorynRecord } from "./types.js";

function usageCount(value: unknown, path: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Cannot apply record feedback: ${path} must be a non-negative safe integer`);
  }
  return Number(value);
}

function incrementUsageCount(value: number, path: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Cannot apply record feedback: ${path} exceeds the safe integer limit`);
  }
  return value + 1;
}

function latestTimestamp(current: string | undefined, candidate: string): string {
  return current === undefined || candidate > current ? candidate : current;
}

/** Applies one final recall outcome to the non-semantic usage projection. */
export function applyRecordFeedback(
  record: MorynRecord,
  event: Extract<MorynEvent, { op: "record_feedback" }>
): MorynRecord {
  const usage = record.memory_usage;
  if (usage !== undefined && usage.version !== 1) {
    throw new Error("Cannot apply record feedback: memory_usage must use projection version 1");
  }
  const recallCount = usageCount(usage?.recall_count, "memory_usage.recall_count");
  const usefulCount = usageCount(usage?.useful_count, "memory_usage.useful_count");
  const rejectedCount = usageCount(usage?.rejected_count, "memory_usage.rejected_count");
  if (usefulCount + rejectedCount > recallCount) {
    throw new Error("Cannot apply record feedback: useful and rejected counts exceed recall count");
  }

  const useful = event.outcome === "used" || event.outcome === "verified";
  const rejected = event.outcome === "rejected";
  const memoryUsage = {
    version: 1 as const,
    ...(usage ?? {}),
    last_recalled_at: latestTimestamp(usage?.last_recalled_at, event.created_at),
    recall_count: incrementUsageCount(recallCount, "memory_usage.recall_count"),
    useful_count: useful ? incrementUsageCount(usefulCount, "memory_usage.useful_count") : usefulCount,
    rejected_count: rejected ? incrementUsageCount(rejectedCount, "memory_usage.rejected_count") : rejectedCount,
    ...(useful ? { last_useful_at: latestTimestamp(usage?.last_useful_at, event.created_at) } : {}),
    ...(rejected ? { last_rejected_at: latestTimestamp(usage?.last_rejected_at, event.created_at) } : {}),
    ...(event.outcome === "verified"
      ? { last_verified_at: latestTimestamp(usage?.last_verified_at, event.created_at) }
      : {})
  };

  return {
    ...record,
    memory_usage: memoryUsage
  };
}
