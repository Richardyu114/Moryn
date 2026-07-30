import type { LearningDelta } from "./context-delta.js";
import { detectSensitiveContent } from "./sensitive.js";
import type { RecordState } from "./types.js";

export type LearningPolicyReason =
  | "reliable_project_memory"
  | "reusable_skill_candidate"
  | "global_learning_candidate"
  | "unverified_evidence_candidate"
  | "low_confidence_candidate"
  | "session_learning_candidate"
  | "expired_learning_candidate"
  | "semantic_conflict_requires_confirmation"
  | "high_risk_learning_requires_confirmation";

export interface LearningStatePolicyResult {
  state: Extract<RecordState, "canonical" | "candidate">;
  requires_confirmation: boolean;
  reason: LearningPolicyReason;
}

const HIGH_RISK_TYPES = new Set([
  "identity",
  "identity_rule",
  "security",
  "security_rule",
  "sync_config",
  "sync_configuration"
]);

export function learningStatePolicy(
  learning: LearningDelta,
  options: { now?: string } = {}
): LearningStatePolicyResult {
  const normalizedType = learning.recommended_type.trim().toLowerCase();
  if (HIGH_RISK_TYPES.has(normalizedType) || detectSensitiveContent(learning.conclusion).sensitive) {
    return { state: "candidate", requires_confirmation: true, reason: "high_risk_learning_requires_confirmation" };
  }
  if (learning.recommended_kind === "skill") {
    return { state: "candidate", requires_confirmation: false, reason: "reusable_skill_candidate" };
  }
  if (learning.scope === "global") {
    return { state: "candidate", requires_confirmation: false, reason: "global_learning_candidate" };
  }
  if (learning.scope === "session") {
    return { state: "candidate", requires_confirmation: false, reason: "session_learning_candidate" };
  }
  if (learning.evidence_type === "inference" || learning.evidence_type === "web") {
    return { state: "candidate", requires_confirmation: false, reason: "unverified_evidence_candidate" };
  }
  if (learning.confidence < 0.8) {
    return { state: "candidate", requires_confirmation: false, reason: "low_confidence_candidate" };
  }
  if (learning.valid_until && options.now && Date.parse(learning.valid_until) < Date.parse(options.now)) {
    return { state: "candidate", requires_confirmation: false, reason: "expired_learning_candidate" };
  }
  return { state: "canonical", requires_confirmation: false, reason: "reliable_project_memory" };
}
