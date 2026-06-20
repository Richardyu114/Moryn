import { displayRecordText } from "./content-text.js";
import type { MorynRecord, RecordState } from "./types.js";

export type AutocapturePolicyDecision = "review" | "archive";
export type AutocapturePolicyRuleId = "default_review_for_agent_handoff" | "smoke_test_marker" | "duplicate_text";

export interface AutocapturePolicy {
  id: "default_autocapture_policy";
  version: 1;
  mode: "policy_review";
  auto_canonical: false;
  canonical_requires_user_action: true;
  archive_noise_without_review: true;
  rules: Array<{
    id: AutocapturePolicyRuleId;
    decision: AutocapturePolicyDecision;
    description: string;
  }>;
}

export interface AutocapturePolicyInput {
  summary: string;
  project_id?: string;
  host: string;
  current_task?: string;
  existing_records?: MorynRecord[];
}

export interface AutocapturePolicyResult {
  policy_id: AutocapturePolicy["id"];
  version: 1;
  decision: AutocapturePolicyDecision;
  target_state: RecordState;
  review_required: boolean;
  auto_canonical: false;
  rule_ids: AutocapturePolicyRuleId[];
  reasons: string[];
  tags: string[];
  confidence: number;
  duplicate_of_record_id?: string;
}

export const DEFAULT_AUTOCAPTURE_POLICY: AutocapturePolicy = {
  id: "default_autocapture_policy",
  version: 1,
  mode: "policy_review",
  auto_canonical: false,
  canonical_requires_user_action: true,
  archive_noise_without_review: true,
  rules: [
    {
      id: "default_review_for_agent_handoff",
      decision: "review",
      description: "Normal agent handoffs enter Capture Inbox as candidates and require user approval before canonical memory."
    },
    {
      id: "smoke_test_marker",
      decision: "archive",
      description: "Smoke, test, fixture, e2e, or marker captures are archived without review because they are usually verification noise."
    },
    {
      id: "duplicate_text",
      decision: "archive",
      description: "Repeated autocapture text for the same project is archived without review while preserving append-only history."
    }
  ]
};

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function isAutocaptureRecord(record: MorynRecord): boolean {
  return record.kind === "session_summary"
    && record.tags.some((tag) => tag.toLowerCase() === "autocapture");
}

function sameProject(record: MorynRecord, projectId: string | undefined): boolean {
  return record.project_id === projectId;
}

function duplicateAutocaptureRecord(input: AutocapturePolicyInput): MorynRecord | undefined {
  const summary = normalizeText(input.summary);
  if (!summary) return undefined;
  return [...(input.existing_records ?? [])]
    .filter(isAutocaptureRecord)
    .filter((record) => sameProject(record, input.project_id))
    .find((record) => normalizeText(displayRecordText(record)) === summary);
}

export function evaluateAutocapturePolicy(input: AutocapturePolicyInput): AutocapturePolicyResult {
  const searchable = input.summary.toLowerCase();
  const ruleIds: AutocapturePolicyRuleId[] = [];
  const reasons: string[] = [];
  const duplicate = duplicateAutocaptureRecord(input);

  if (/\b(smoke|test|fixture|e2e|marker)\b/.test(searchable)) {
    ruleIds.push("smoke_test_marker");
    reasons.push("smoke_test_marker");
  }
  if (duplicate) {
    ruleIds.push("duplicate_text");
    reasons.push("duplicate_text");
  }

  if (ruleIds.length > 0) {
    const tags = [
      "autocapture",
      `host:${input.host}`,
      "policy-archived",
      ...ruleIds.map((ruleId) => `noise:${ruleId}`)
    ];
    return {
      policy_id: DEFAULT_AUTOCAPTURE_POLICY.id,
      version: DEFAULT_AUTOCAPTURE_POLICY.version,
      decision: "archive",
      target_state: "archived",
      review_required: false,
      auto_canonical: false,
      rule_ids: ruleIds,
      reasons,
      tags: [...new Set(tags)],
      confidence: 0.1,
      ...(duplicate ? { duplicate_of_record_id: duplicate.id } : {})
    };
  }

  return {
    policy_id: DEFAULT_AUTOCAPTURE_POLICY.id,
    version: DEFAULT_AUTOCAPTURE_POLICY.version,
    decision: "review",
    target_state: "candidate",
    review_required: true,
    auto_canonical: false,
    rule_ids: ["default_review_for_agent_handoff"],
    reasons: ["default_review_for_agent_handoff"],
    tags: ["autocapture", "review", `host:${input.host}`],
    confidence: 0.5
  };
}
