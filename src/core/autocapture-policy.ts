import { displayRecordText } from "./content-text.js";
import type { MorynRecord, RecordState } from "./types.js";

export type AutocapturePolicyDecision = "capture" | "review" | "archive";
export type AutocapturePolicyRoute = "auto_capture" | "manual_review" | "policy_archive";
export type AutocapturePolicyDashboardSurface = "handoff" | "capture_inbox" | "capture_policy";
export type AutocapturePolicyRuleId =
  | "low_risk_handoff_auto_capture"
  | "review_risk_marker"
  | "default_review_for_agent_handoff"
  | "smoke_test_marker"
  | "duplicate_text";

export interface AutocapturePolicy {
  id: "default_autocapture_policy";
  version: 1;
  mode: "policy_review";
  auto_canonical: false;
  canonical_requires_user_action: true;
  capture_low_risk_without_review: true;
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
  route: AutocapturePolicyRoute;
  target_state: RecordState;
  review_required: boolean;
  user_action_required: boolean;
  auto_canonical: false;
  dashboard_surface: AutocapturePolicyDashboardSurface;
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
  capture_low_risk_without_review: true,
  archive_noise_without_review: true,
  rules: [
    {
      id: "low_risk_handoff_auto_capture",
      decision: "capture",
      description: "Low-risk agent handoffs are retained locally for context packs without requiring user approval or canonical promotion."
    },
    {
      id: "review_risk_marker",
      decision: "review",
      description: "Handoffs with decisions, risks, blockers, preferences, credentials, or approval language enter Capture Inbox for explicit user review."
    },
    {
      id: "default_review_for_agent_handoff",
      decision: "review",
      description: "Legacy review route for older autocapture records that do not carry newer policy metadata."
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

function needsManualReview(input: AutocapturePolicyInput): boolean {
  const searchable = `${input.summary} ${input.current_task ?? ""}`.toLowerCase();
  const verifiedImplementationHandoff = isVerifiedImplementationHandoff(searchable);
  if (verifiedImplementationHandoff && !hasExplicitUserReviewMarker(searchable, verifiedImplementationHandoff)) {
    return false;
  }
  if (hasExplicitUserReviewMarker(searchable, verifiedImplementationHandoff)) {
    return true;
  }
  return /\b(decision|decided|risk|risky|blocker|blocked|warning|warn|preference|principle|credential|credentials|secret|token|password|security|permission|approval|approve|confirm|canonical|promote|delete|destructive)\b/.test(searchable);
}

function isVerifiedImplementationHandoff(searchable: string): boolean {
  return /\b(completed|complete|finished|implemented|fixed|updated|changed|shipped|landed|merged|committed|pushed|restarted)\b/.test(searchable)
    && /\b(verified|passing|passed|typecheck|build|release check|suite|regression)\b/.test(searchable);
}

function hasExplicitUserReviewMarker(searchable: string, verifiedImplementationHandoff = false): boolean {
  return /\b(credential|credentials|secret|token|password|security|permission|canonical|promote|delete|destructive|blocker|blocked|risky)\b/.test(searchable)
    || /\b(decision|decided|preference|principle)\s*:/.test(searchable)
    || /\b(decision|decided|preference|principle)\s+(?:to|that)\b/.test(searchable)
    || /\brisk\s*:/.test(searchable)
    || (!verifiedImplementationHandoff && (
      /\b(needs?|requires?|awaits?|waiting for|pending)\s+(?:user\s+|human\s+|manual\s+)?(?:review|approval|confirmation|confirm|decision)\b/.test(searchable)
      || /\bmanual\s+review\b/.test(searchable)
      || /\b(?:approval|confirmation|review)\s+(?:required|needed|pending)\b/.test(searchable)
      || /\b(?:user|human)\s+(?:must|should|needs?|has to)\s+(?:review|approve|confirm|decide)\b/.test(searchable)
    ));
}

export function evaluateAutocapturePolicy(input: AutocapturePolicyInput): AutocapturePolicyResult {
  const searchable = `${input.summary} ${input.current_task ?? ""}`.toLowerCase();
  const verifiedImplementationHandoff = isVerifiedImplementationHandoff(searchable);
  const ruleIds: AutocapturePolicyRuleId[] = [];
  const reasons: string[] = [];
  const duplicate = duplicateAutocaptureRecord(input);

  if (!verifiedImplementationHandoff && /\b(smoke|test|fixture|e2e|marker)\b/.test(searchable)) {
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
      route: "policy_archive",
      target_state: "archived",
      review_required: false,
      user_action_required: false,
      auto_canonical: false,
      dashboard_surface: "capture_policy",
      rule_ids: ruleIds,
      reasons,
      tags: [...new Set(tags)],
      confidence: 0.1,
      ...(duplicate ? { duplicate_of_record_id: duplicate.id } : {})
    };
  }

  if (needsManualReview(input)) {
    return {
      policy_id: DEFAULT_AUTOCAPTURE_POLICY.id,
      version: DEFAULT_AUTOCAPTURE_POLICY.version,
      decision: "review",
      route: "manual_review",
      target_state: "candidate",
      review_required: true,
      user_action_required: true,
      auto_canonical: false,
      dashboard_surface: "capture_inbox",
      rule_ids: ["review_risk_marker"],
      reasons: ["review_risk_marker"],
      tags: ["autocapture", "review", `host:${input.host}`],
      confidence: 0.5
    };
  }

  return {
    policy_id: DEFAULT_AUTOCAPTURE_POLICY.id,
    version: DEFAULT_AUTOCAPTURE_POLICY.version,
    decision: "capture",
    route: "auto_capture",
    target_state: "candidate",
    review_required: false,
    user_action_required: false,
    auto_canonical: false,
    dashboard_surface: "handoff",
    rule_ids: ["low_risk_handoff_auto_capture"],
    reasons: ["low_risk_handoff_auto_capture"],
    tags: ["autocapture", "auto-captured", `host:${input.host}`],
    confidence: 0.45
  };
}
