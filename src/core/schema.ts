import { z } from "zod";
import type { MemoraEvent } from "./types.js";

export const recordKindSchema = z.enum(["memory", "skill", "soul", "session_summary", "agent_note"]);
export const recordStateSchema = z.enum(["raw", "candidate", "canonical", "archived", "quarantined"]);
export const recordScopeSchema = z.enum(["global", "project", "topic", "session", "artifact"]);
export const recordPrioritySchema = z.enum(["low", "normal", "high"]);
export const recordVisibilitySchema = z.enum(["active", "archived", "quarantined"]);
export const isoDateTimeSchema = z.string().datetime();

export const recordSourceSchema = z.object({
  client: z.string().min(1),
  session_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  device_id: z.string().min(1).optional()
});

export const recordLinkSchema = z.object({
  record_id: z.string().min(1),
  link_type: z.string().min(1),
  created_at: isoDateTimeSchema
});

export const recordConflictSchema = z.object({
  kind: z.literal("semantic"),
  with: z.array(z.string().min(1)),
  resolution: z.enum(["needs_review", "resolved"])
});

export const recordSchema = z.object({
  id: z.string().min(1),
  kind: recordKindSchema,
  type: z.string().min(1),
  scope: recordScopeSchema,
  project_id: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]),
  content: z.record(z.string(), z.unknown()).and(z.object({
    text: z.string().optional(),
    format: z.enum(["text", "json"]).optional()
  })),
  state: recordStateSchema,
  confidence: z.number().min(0).max(1).default(0.5),
  priority: recordPrioritySchema.default("normal"),
  visibility: recordVisibilitySchema.default("active"),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  source: recordSourceSchema,
  provenance: z.object({
    derived_from: z.array(z.string()).optional(),
    reason: z.string().optional(),
    method: z.enum(["agent-proposed", "rule-promoted", "user-confirmed"]).optional(),
    promoted_at: isoDateTimeSchema.optional()
  }).optional(),
  conflict: recordConflictSchema.optional(),
  links: z.array(recordLinkSchema).optional()
});

export type ParsedRecord = z.infer<typeof recordSchema>;

export const eventSchema = z.discriminatedUnion("op", [
  z.object({
    event_id: z.string().min(1),
    op: z.literal("upsert_record"),
    record: recordSchema,
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  }),
  z.object({
    event_id: z.string().min(1),
    op: z.literal("revise_record"),
    record_id: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
    reason: z.string().optional(),
    confirmed: z.boolean().optional(),
    conflict: recordConflictSchema.optional(),
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  }),
  z.object({
    event_id: z.string().min(1),
    op: z.union([z.literal("promote_record"), z.literal("archive_record"), z.literal("quarantine_record")]),
    record_id: z.string().min(1),
    target_state: recordStateSchema.optional(),
    reason: z.string().optional(),
    confirmed: z.boolean().optional(),
    conflict: recordConflictSchema.optional(),
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  }),
  z.object({
    event_id: z.string().min(1),
    op: z.literal("link_records"),
    record_id: z.string().min(1),
    linked_record_id: z.string().min(1),
    link_type: z.string().min(1),
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  })
]);

export type ParsedEvent = z.infer<typeof eventSchema>;

export function parseRecord(input: unknown): ParsedRecord {
  const result = recordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid record: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function parseEvent(input: unknown): MemoraEvent {
  const result = eventSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid event: ${z.prettifyError(result.error)}`);
  }
  return result.data as MemoraEvent;
}
