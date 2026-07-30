export type RecordKind = "memory" | "skill" | "soul" | "session_summary" | "agent_note";
export type RecordState = "raw" | "candidate" | "canonical" | "archived" | "quarantined";
export type RecordScope = "global" | "project" | "topic" | "session" | "artifact";
export type RecordPriority = "low" | "normal" | "high";
export type RecordVisibility = "active" | "archived" | "quarantined";
export const RECORD_FEEDBACK_OUTCOMES = ["recalled", "used", "verified", "rejected"] as const;
export type RecordFeedbackOutcome = (typeof RECORD_FEEDBACK_OUTCOMES)[number];

export interface RecordContent {
  text?: string;
  format?: "text" | "json";
  [key: string]: unknown;
}

export interface RecordSource {
  client: string;
  session_id?: string;
  model?: string;
  device_id?: string;
}

export interface RecordProvenance {
  derived_from?: string[];
  reason?: string;
  method?: "agent-proposed" | "rule-promoted" | "user-confirmed";
  promoted_at?: string;
}

export interface RecordLink {
  record_id: string;
  link_type: string;
  reason?: string;
  created_at: string;
}

export interface RecordConflict {
  kind: "semantic";
  with: string[];
  resolution: "needs_review" | "resolved";
}

export interface RecordMemoryUsage {
  version: 1;
  last_recalled_at?: string;
  last_useful_at?: string;
  last_rejected_at?: string;
  last_verified_at?: string;
  recall_count: number;
  useful_count: number;
  rejected_count: number;
}

export interface EventIdempotency {
  version: 1;
  operation: string;
  key_digest: string;
  request_digest: string;
}

export interface EventRedaction {
  kind: "sensitive_content";
  applied: true;
}

export interface MorynRecord {
  id: string;
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  tags: string[];
  content: RecordContent;
  state: RecordState;
  confidence: number;
  priority: RecordPriority;
  visibility: RecordVisibility;
  created_at: string;
  updated_at: string;
  source: RecordSource;
  provenance?: RecordProvenance;
  conflict?: RecordConflict;
  links?: RecordLink[];
  memory_usage?: RecordMemoryUsage;
}

export type MorynEvent = { idempotency?: EventIdempotency } & (
  | {
      event_id: string;
      op: "upsert_record";
      record: MorynRecord;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "revise_record";
      record_id: string;
      patch: Record<string, unknown>;
      reason?: string;
      confirmed?: boolean;
      conflict?: RecordConflict;
      redaction?: EventRedaction;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "promote_record" | "archive_record" | "quarantine_record";
      record_id: string;
      target_state?: RecordState;
      reason?: string;
      confirmed?: boolean;
      conflict?: RecordConflict;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "record_feedback";
      record_id: string;
      outcome: RecordFeedbackOutcome;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "link_records";
      record_id: string;
      linked_record_id: string;
      link_type: string;
      reason?: string;
      created_at: string;
      source: RecordSource;
    }
);
