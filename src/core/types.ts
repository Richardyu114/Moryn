export type RecordKind = "memory" | "skill" | "soul" | "session_summary" | "agent_note";
export type RecordState = "raw" | "candidate" | "canonical" | "archived" | "quarantined";
export type RecordScope = "global" | "project" | "topic" | "session" | "artifact";
export type RecordPriority = "low" | "normal" | "high";
export type RecordVisibility = "active" | "archived" | "quarantined";

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
  created_at: string;
}

export interface RecordConflict {
  kind: "semantic";
  with: string[];
  resolution: "needs_review" | "resolved";
}

export interface MemoraRecord {
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
}

export type MemoraEvent =
  | {
      event_id: string;
      op: "upsert_record";
      record: MemoraRecord;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "revise_record";
      record_id: string;
      patch: Record<string, unknown>;
      reason?: string;
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
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "link_records";
      record_id: string;
      linked_record_id: string;
      link_type: string;
      created_at: string;
      source: RecordSource;
    };
