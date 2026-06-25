import type { MorynRecord } from "./types.js";

function capturePolicy(record: MorynRecord): Record<string, unknown> | undefined {
  const capture = record.content.capture;
  if (typeof capture !== "object" || capture === null || Array.isArray(capture)) return undefined;
  const policy = (capture as Record<string, unknown>).policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return undefined;
  return policy as Record<string, unknown>;
}

function policyRequestsCaptureReview(policy: Record<string, unknown>): boolean {
  return policy.review_required === true
    || policy.user_action_required === true
    || policy.dashboard_surface === "capture_inbox"
    || policy.decision === "review";
}

export function isCaptureReviewCandidate(record: MorynRecord): boolean {
  if (record.state !== "candidate" || record.kind !== "session_summary") return false;
  const policy = capturePolicy(record);
  if (policy) return policyRequestsCaptureReview(policy);
  return record.tags.includes("review");
}
