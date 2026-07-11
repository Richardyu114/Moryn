import { createHash } from "node:crypto";
import type { LearningDelta } from "./context-delta.js";
import { learningStatePolicy, type LearningStatePolicyResult } from "./learning-policy.js";
import type { MorynRecord, RecordSource } from "./types.js";

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalLearning(input: { project_id?: string; learning: LearningDelta }): string {
  return JSON.stringify({
    project_id: input.project_id ?? null,
    conclusion: input.learning.conclusion,
    evidence_type: input.learning.evidence_type,
    scope: input.learning.scope,
    confidence: input.learning.confidence,
    valid_until: input.learning.valid_until ?? null,
    recommended_kind: input.learning.recommended_kind,
    recommended_type: input.learning.recommended_type,
    related_record_ids: [...input.learning.related_record_ids].sort(compareCodeUnits)
  });
}

export function learningRecordIdentity(input: { project_id?: string; learning: LearningDelta }): {
  digest: string;
  record_id: string;
  event_id: string;
} {
  const digest = createHash("sha256").update(canonicalLearning(input)).digest("hex");
  return { digest, record_id: `rec_learning_${digest.slice(0, 32)}`, event_id: `evt_learning_${digest.slice(0, 32)}` };
}

export function normalizeLearningRecord(input: {
  project_id?: string;
  learning: LearningDelta;
  source: RecordSource;
  occurred_at: string;
  policy?: LearningStatePolicyResult;
}): MorynRecord {
  const identity = learningRecordIdentity(input);
  const policy = input.policy ?? learningStatePolicy(input.learning, { now: input.occurred_at });
  const tags = ["learning", `evidence:${input.learning.evidence_type}`, `policy:${policy.reason}`];
  if (input.learning.valid_until) tags.push("time-bounded");
  return {
    id: identity.record_id,
    kind: input.learning.recommended_kind,
    type: input.learning.recommended_type,
    scope: input.learning.scope,
    project_id: input.learning.scope === "project" ? input.project_id : undefined,
    tags: tags.sort(compareCodeUnits),
    content: {
      text: input.learning.conclusion,
      evidence_type: input.learning.evidence_type,
      ...(input.learning.valid_until ? { valid_until: input.learning.valid_until } : {})
    },
    state: policy.state,
    confidence: input.learning.confidence,
    priority: "normal",
    visibility: "active",
    created_at: input.occurred_at,
    updated_at: input.occurred_at,
    source: input.source,
    provenance: {
      derived_from: input.learning.related_record_ids,
      reason: input.learning.question,
      method: policy.state === "canonical" ? "rule-promoted" : "agent-proposed",
      ...(policy.state === "canonical" ? { promoted_at: input.occurred_at } : {})
    }
  };
}
