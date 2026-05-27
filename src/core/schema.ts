import { z } from "zod";

export const recordKindSchema = z.enum(["memory", "skill", "soul", "session_summary", "agent_note"]);
export const recordStateSchema = z.enum(["raw", "candidate", "canonical", "archived", "quarantined"]);
export const recordScopeSchema = z.enum(["global", "project", "topic", "session", "artifact"]);
export const recordPrioritySchema = z.enum(["low", "normal", "high"]);
export const recordVisibilitySchema = z.enum(["active", "archived", "quarantined"]);

export const recordSourceSchema = z.object({
  client: z.string().min(1),
  session_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  device_id: z.string().min(1).optional()
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
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  source: recordSourceSchema,
  provenance: z.object({
    derived_from: z.array(z.string()).optional(),
    reason: z.string().optional()
  }).optional()
});

export type ParsedRecord = z.infer<typeof recordSchema>;

export function parseRecord(input: unknown): ParsedRecord {
  const result = recordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid record: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
