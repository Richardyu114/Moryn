import { z } from "zod";
import type { MorynEvent } from "./types.js";

export const RECORD_KINDS = ["memory", "skill", "soul", "session_summary", "agent_note"] as const;
export const RECORD_STATES = ["raw", "candidate", "canonical", "archived", "quarantined"] as const;
export const RECORD_SCOPES = ["global", "project", "topic", "session", "artifact"] as const;
export const RECORD_PRIORITIES = ["low", "normal", "high"] as const;
export const RECORD_VISIBILITIES = ["active", "archived", "quarantined"] as const;
export const CONTENT_FORMATS = ["text", "json"] as const;
export const CONFLICT_RESOLUTIONS = ["needs_review", "resolved"] as const;
export const PROVENANCE_METHODS = ["agent-proposed", "rule-promoted", "user-confirmed"] as const;

export const recordKindSchema = z.enum(RECORD_KINDS);
export const recordStateSchema = z.enum(RECORD_STATES);
export const recordScopeSchema = z.enum(RECORD_SCOPES);
export const recordPrioritySchema = z.enum(RECORD_PRIORITIES);
export const recordVisibilitySchema = z.enum(RECORD_VISIBILITIES);
export const isoDateTimeSchema = z.string().datetime();
const nonEmptyStringSchema = z.string().min(1);

export const recordSourceSchema = z.object({
  client: z.string().min(1),
  session_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  device_id: z.string().min(1).optional()
});

const revisionPatchSchema = z.record(z.string(), z.unknown()).refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "Patch must not be empty" }
).refine(
  (patch) => Object.keys(patch).every(isValidPatchPath),
  { message: "Patch paths must not be empty" }
);

const recordContentSchema = z.record(z.string(), z.unknown())
  .refine((content) => Object.keys(content).length > 0, { message: "Content must not be empty" })
  .and(z.object({
    text: nonEmptyStringSchema.optional(),
    format: z.enum(CONTENT_FORMATS).optional()
  }));

export function isValidPatchPath(path: string): boolean {
  return path.split(".").every((part) => part.length > 0);
}

export const recordLinkSchema = z.object({
  record_id: z.string().min(1),
  link_type: z.string().min(1),
  created_at: isoDateTimeSchema
});

export const recordConflictSchema = z.object({
  kind: z.literal("semantic"),
  with: z.array(z.string().min(1)),
  resolution: z.enum(CONFLICT_RESOLUTIONS)
});

export const recordSchema = z.object({
  id: z.string().min(1),
  kind: recordKindSchema,
  type: z.string().min(1),
  scope: recordScopeSchema,
  project_id: z.string().min(1).optional(),
  tags: z.array(nonEmptyStringSchema).default([]),
  content: recordContentSchema,
  state: recordStateSchema,
  confidence: z.number().min(0).max(1).default(0.5),
  priority: recordPrioritySchema.default("normal"),
  visibility: recordVisibilitySchema.default("active"),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  source: recordSourceSchema,
  provenance: z.object({
    derived_from: z.array(nonEmptyStringSchema).optional(),
    reason: nonEmptyStringSchema.optional(),
    method: z.enum(PROVENANCE_METHODS).optional(),
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
    patch: revisionPatchSchema,
    reason: nonEmptyStringSchema.optional(),
    confirmed: z.boolean().optional(),
    conflict: recordConflictSchema.optional(),
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  }),
  z.object({
    event_id: z.string().min(1),
    op: z.literal("promote_record"),
    record_id: z.string().min(1),
    target_state: recordStateSchema,
    reason: nonEmptyStringSchema.optional(),
    confirmed: z.boolean().optional(),
    conflict: recordConflictSchema.optional(),
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  }),
  z.object({
    event_id: z.string().min(1),
    op: z.literal("archive_record"),
    record_id: z.string().min(1),
    target_state: z.undefined().optional(),
    reason: nonEmptyStringSchema.optional(),
    confirmed: z.boolean().optional(),
    conflict: recordConflictSchema.optional(),
    created_at: isoDateTimeSchema,
    source: recordSourceSchema
  }),
  z.object({
    event_id: z.string().min(1),
    op: z.literal("quarantine_record"),
    record_id: z.string().min(1),
    target_state: z.undefined().optional(),
    reason: nonEmptyStringSchema.optional(),
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

interface SchemaValidationIssue {
  code: string;
  path: Array<string | number>;
  path_string: string;
  message: string;
  expected?: unknown;
}

function pathString(path: Array<string | number | symbol>): string {
  return path.map((part) => String(part)).join(".");
}

function validationIssue(issue: z.core.$ZodIssue): SchemaValidationIssue {
  const output: SchemaValidationIssue = {
    code: issue.code,
    path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
    path_string: pathString(issue.path),
    message: issue.message
  };
  if ("values" in issue) output.expected = { values: issue.values };
  if ("minimum" in issue) output.expected = { minimum: issue.minimum };
  return output;
}

class MorynSchemaValidationError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: {
    rejected_schema: "record" | "event";
    validation_issues: SchemaValidationIssue[];
    expected: { kind: "moryn_record_schema" | "moryn_event_schema" };
    retry_with: { argument: "record" | "event"; value_placeholder: string };
  };

  constructor(schema: "record" | "event", error: z.ZodError) {
    super(`Invalid ${schema}: ${z.prettifyError(error)}`);
    this.name = "MorynSchemaValidationError";
    this.recommended_action = `retry with a valid Moryn ${schema} schema`;
    this.recovery_hint = {
      rejected_schema: schema,
      validation_issues: error.issues.map(validationIssue),
      expected: { kind: `moryn_${schema}_schema` },
      retry_with: { argument: schema, value_placeholder: `<valid Moryn ${schema}>` }
    };
  }
}

export function parseRecord(input: unknown): ParsedRecord {
  const result = recordSchema.safeParse(input);
  if (!result.success) {
    throw new MorynSchemaValidationError("record", result.error);
  }
  return result.data;
}

export function parseEvent(input: unknown): MorynEvent {
  const result = eventSchema.safeParse(input);
  if (!result.success) {
    throw new MorynSchemaValidationError("event", result.error);
  }
  return result.data as MorynEvent;
}
