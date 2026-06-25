import { evaluateAutocapturePolicy, type AutocapturePolicyResult } from "./autocapture-policy.js";
import { displayRecordText } from "./content-text.js";
import type { MorynRecord } from "./types.js";

function capturePayload(record: MorynRecord): Record<string, unknown> | undefined {
  const capture = record.content.capture;
  if (typeof capture !== "object" || capture === null || Array.isArray(capture)) return undefined;
  return capture as Record<string, unknown>;
}

function capturePolicy(record: MorynRecord): Record<string, unknown> | undefined {
  const policy = capturePayload(record)?.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return undefined;
  return policy as Record<string, unknown>;
}

function policyRequestsCaptureReview(policy: Record<string, unknown>): boolean {
  return policy.review_required === true
    || policy.user_action_required === true
    || policy.dashboard_surface === "capture_inbox"
    || policy.decision === "review";
}

function hasStoredReviewPolicy(record: MorynRecord): boolean {
  const policy = capturePolicy(record);
  return policy !== undefined && policyRequestsCaptureReview(policy);
}

function isAutocaptureRecord(record: MorynRecord): boolean {
  const capture = capturePayload(record);
  return record.kind === "session_summary"
    && (record.tags.some((tag) => tag.toLowerCase() === "autocapture") || capture?.mode === "autocapture");
}

function captureString(record: MorynRecord, key: string): string | undefined {
  const value = capturePayload(record)?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function hostForRecord(record: MorynRecord): string {
  const captureHost = captureString(record, "host");
  if (captureHost) return captureHost;
  const hostTag = record.tags.find((tag) => tag.toLowerCase().startsWith("host:"));
  if (hostTag) return hostTag.slice("host:".length) || record.source.client || "unknown";
  return record.source.client || "unknown";
}

export function currentAutocaptureDecisionForRecord(record: MorynRecord): AutocapturePolicyResult | undefined {
  if (!isAutocaptureRecord(record)) return undefined;
  return evaluateAutocapturePolicy({
    summary: displayRecordText(record),
    project_id: record.project_id,
    host: hostForRecord(record),
    current_task: captureString(record, "current_task")
  });
}

export function currentPolicyTreatsAsLowRiskCapture(record: MorynRecord): boolean {
  if (!hasStoredReviewPolicy(record)) return false;
  return currentAutocaptureDecisionForRecord(record)?.decision === "capture";
}

export function isCaptureReviewCandidate(record: MorynRecord): boolean {
  if (record.state !== "candidate" || record.kind !== "session_summary") return false;
  if (currentPolicyTreatsAsLowRiskCapture(record)) return false;
  const policy = capturePolicy(record);
  if (policy) return policyRequestsCaptureReview(policy);
  return record.tags.includes("review");
}
