import { derivedIdempotencyKey } from "./idempotency.js";
import { detectSensitiveContent, isPrivateTags, sensitiveScanText } from "./sensitive.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export const SYNC_GATE_POLICY_VERSION = "moryn.sync-gate.v1" as const;
export const SYNC_GATE_DESTINATIONS = ["personal_sync", "trusted_team", "public_export"] as const;
export const SYNC_GATE_DISTRIBUTIONS = ["local_only", "personal_sync", "trusted_team", "public_export"] as const;

export type SyncGateDestination = (typeof SYNC_GATE_DESTINATIONS)[number];
export type SyncGateDistribution = (typeof SYNC_GATE_DISTRIBUTIONS)[number];
export type SyncGateDecision = "allow" | "review_required" | "deny";

export type SyncGateFindingCode =
  | "sensitive_content"
  | "local_only_distribution"
  | "private_boundary"
  | "invalid_distribution"
  | "distribution_unspecified"
  | "destination_not_authorized"
  | "noncanonical_public_export"
  | "missing_record_evidence";

export interface SyncGateFinding {
  event_id: string;
  record_ids: string[];
  code: SyncGateFindingCode;
  decision: Exclude<SyncGateDecision, "allow">;
  reason: string;
  content_included: false;
}

export const SYNC_GATE_SELECTION_SOURCES = {
  policy_version: "policy.version",
  destination: "request.destination",
  evidence_digest: "pending_events.canonical_digest",
  decision: "event_decisions.highest_severity",
  summary: "event_decisions.counts",
  findings: "event_decisions.non_allow_findings"
} as const;

export interface SyncGatePreflight {
  schema_version: 1;
  policy_version: typeof SYNC_GATE_POLICY_VERSION;
  mode: "shadow";
  enforced: false;
  destination: SyncGateDestination;
  evidence_digest: string;
  receipt_id: string;
  decision: SyncGateDecision;
  would_block: boolean;
  summary: {
    total_events: number;
    allowed_events: number;
    review_required_events: number;
    denied_events: number;
  };
  findings: SyncGateFinding[];
  selection_sources: typeof SYNC_GATE_SELECTION_SOURCES;
}

export interface EvaluateSyncGateInput {
  events: MorynEvent[];
  destination?: SyncGateDestination;
  current_records?: ReadonlyMap<string, MorynRecord>;
}

type DistributionEvidence = SyncGateDistribution | "unspecified" | "invalid";

const DECISION_RANK: Record<SyncGateDecision, number> = {
  allow: 0,
  review_required: 1,
  deny: 2
};

function isSyncGateDistribution(value: unknown): value is SyncGateDistribution {
  return typeof value === "string" && (SYNC_GATE_DISTRIBUTIONS as readonly string[]).includes(value);
}

export function parseSyncGateDestination(value: unknown): SyncGateDestination {
  if (typeof value === "string" && (SYNC_GATE_DESTINATIONS as readonly string[]).includes(value)) {
    return value as SyncGateDestination;
  }
  throw new Error(`Invalid sync destination; expected one of: ${SYNC_GATE_DESTINATIONS.join(", ")}`);
}

function contentDistribution(content: unknown): DistributionEvidence {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "unspecified";
  const value = (content as Record<string, unknown>).distribution;
  if (value === undefined) return "unspecified";
  return isSyncGateDistribution(value) ? value : "invalid";
}

function recordDistribution(record: MorynRecord): DistributionEvidence {
  return contentDistribution(record.content);
}

function recordHasPrivateBoundary(record: MorynRecord): boolean {
  const content = record.content as Record<string, unknown>;
  return isPrivateTags(record.tags) || content.privacy === "private";
}

function eventRecordIds(event: MorynEvent): string[] {
  if (event.op === "upsert_record") return [event.record.id];
  if (event.op === "link_records") return [event.record_id, event.linked_record_id];
  return [event.record_id];
}

function revisionDistribution(event: Extract<MorynEvent, { op: "revise_record" }>): DistributionEvidence | undefined {
  if (Object.hasOwn(event.patch, "content.distribution")) {
    const value = event.patch["content.distribution"];
    return isSyncGateDistribution(value) ? value : "invalid";
  }
  if (Object.hasOwn(event.patch, "content")) return contentDistribution(event.patch.content);
  return undefined;
}

function revisionAddsPrivateBoundary(event: Extract<MorynEvent, { op: "revise_record" }>): boolean {
  const privacy = event.patch["content.privacy"];
  const content = event.patch.content;
  const tags = event.patch.tags;
  return (
    privacy === "private" ||
    (content !== null &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).privacy === "private") ||
    (Array.isArray(tags) && tags.every((tag) => typeof tag === "string") && isPrivateTags(tags as string[]))
  );
}

function evidenceForEvent(event: MorynEvent, currentRecords?: ReadonlyMap<string, MorynRecord>) {
  const recordIds = eventRecordIds(event);
  if (event.op === "upsert_record") {
    return {
      records: [event.record],
      distributions: [recordDistribution(event.record)],
      privateBoundary: recordHasPrivateBoundary(event.record)
    };
  }

  const records = recordIds
    .map((recordId) => currentRecords?.get(recordId))
    .filter((record): record is MorynRecord => record !== undefined);
  const revision = event.op === "revise_record" ? revisionDistribution(event) : undefined;
  return {
    records,
    distributions: [...(revision ? [revision] : []), ...records.map(recordDistribution)],
    privateBoundary:
      records.some(recordHasPrivateBoundary) || (event.op === "revise_record" && revisionAddsPrivateBoundary(event))
  };
}

function finding(
  event: MorynEvent,
  code: SyncGateFindingCode,
  decision: Exclude<SyncGateDecision, "allow">,
  reason: string
): SyncGateFinding {
  return {
    event_id: event.event_id,
    record_ids: eventRecordIds(event),
    code,
    decision,
    reason,
    content_included: false
  };
}

function decideEvent(
  event: MorynEvent,
  destination: SyncGateDestination,
  currentRecords?: ReadonlyMap<string, MorynRecord>
): { decision: SyncGateDecision; finding?: SyncGateFinding } {
  if (detectSensitiveContent(sensitiveScanText(event)).sensitive) {
    return {
      decision: "deny",
      finding: finding(event, "sensitive_content", "deny", "The event matches a sensitive-content detector.")
    };
  }

  const evidence = evidenceForEvent(event, currentRecords);
  if (evidence.distributions.includes("local_only")) {
    return {
      decision: "deny",
      finding: finding(
        event,
        "local_only_distribution",
        "deny",
        "A local-only event is not authorized for any remote destination."
      )
    };
  }

  if (destination === "personal_sync") return { decision: "allow" };

  if (evidence.records.length === 0) {
    return {
      decision: "review_required",
      finding: finding(
        event,
        "missing_record_evidence",
        "review_required",
        "The destination policy cannot resolve the event's current record boundary."
      )
    };
  }

  if (evidence.privateBoundary) {
    return {
      decision: "deny",
      finding: finding(event, "private_boundary", "deny", "Private records cannot enter this destination.")
    };
  }

  if (evidence.distributions.includes("invalid")) {
    return {
      decision: "review_required",
      finding: finding(
        event,
        "invalid_distribution",
        "review_required",
        "The event contains an unrecognized distribution value."
      )
    };
  }

  const distributions = evidence.distributions.filter(
    (distribution): distribution is SyncGateDistribution => distribution !== "unspecified" && distribution !== "invalid"
  );
  if (distributions.length === 0 || evidence.distributions.includes("unspecified")) {
    return {
      decision: "review_required",
      finding: finding(
        event,
        "distribution_unspecified",
        "review_required",
        "Broader destinations require an explicit distribution value."
      )
    };
  }

  const authorized =
    destination === "trusted_team"
      ? distributions.every((distribution) => distribution === "trusted_team" || distribution === "public_export")
      : distributions.every((distribution) => distribution === "public_export");
  if (!authorized) {
    return {
      decision: "deny",
      finding: finding(
        event,
        "destination_not_authorized",
        "deny",
        "The record distribution does not authorize this destination."
      )
    };
  }

  if (destination === "public_export" && evidence.records.some((record) => record.state !== "canonical")) {
    return {
      decision: "deny",
      finding: finding(event, "noncanonical_public_export", "deny", "Public export requires canonical records.")
    };
  }

  return { decision: "allow" };
}

export function evaluateSyncGate(input: EvaluateSyncGateInput): SyncGatePreflight {
  const destination = parseSyncGateDestination(input.destination ?? "personal_sync");
  const events = [...input.events].sort(
    (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
  );
  const evaluated = events.map((event) => decideEvent(event, destination, input.current_records));
  const findings = evaluated.flatMap((result) => (result.finding ? [result.finding] : []));
  const decision = evaluated.reduce<SyncGateDecision>(
    (highest, result) => (DECISION_RANK[result.decision] > DECISION_RANK[highest] ? result.decision : highest),
    "allow"
  );
  const evidenceDigest = derivedIdempotencyKey("sync_gate_preflight", {
    policy_version: SYNC_GATE_POLICY_VERSION,
    destination,
    events
  }).split(":sha256:")[1]!;

  return {
    schema_version: 1,
    policy_version: SYNC_GATE_POLICY_VERSION,
    mode: "shadow",
    enforced: false,
    destination,
    evidence_digest: evidenceDigest,
    receipt_id: `sync_gate_${evidenceDigest.slice(0, 32)}`,
    decision,
    would_block: decision !== "allow",
    summary: {
      total_events: events.length,
      allowed_events: evaluated.filter((result) => result.decision === "allow").length,
      review_required_events: evaluated.filter((result) => result.decision === "review_required").length,
      denied_events: evaluated.filter((result) => result.decision === "deny").length
    },
    findings,
    selection_sources: SYNC_GATE_SELECTION_SOURCES
  };
}
