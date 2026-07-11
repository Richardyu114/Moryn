import { z } from "zod";

const nonEmptyStringSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1));
const optionalStringSchema = z.string().transform((value) => value.trim() || undefined).optional();

const stringListSchema = z.array(z.string()).optional().transform((values) => {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return [...new Set(normalized)];
});

const canonicalIsoTimestampSchema = z.string().refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, "Expected a canonical ISO timestamp");

export const learningDeltaSchema = z.object({
  question: nonEmptyStringSchema,
  conclusion: nonEmptyStringSchema,
  evidence_type: z.enum(["user_confirmed", "source_code", "documentation", "web", "inference"]),
  scope: z.enum(["session", "project", "global"]),
  confidence: z.number().min(0).max(1),
  valid_until: canonicalIsoTimestampSchema.optional(),
  recommended_kind: z.enum(["memory", "skill"]),
  recommended_type: nonEmptyStringSchema,
  related_record_ids: stringListSchema
});

export type LearningDeltaInput = z.input<typeof learningDeltaSchema>;
export type LearningDelta = z.output<typeof learningDeltaSchema>;

export const contextDeltaSchema = z.object({
  session_id: nonEmptyStringSchema,
  checkpoint_id: nonEmptyStringSchema,
  current_task: optionalStringSchema,
  progress: stringListSchema,
  decisions: stringListSchema,
  changed_facts: stringListSchema,
  blockers: stringListSchema,
  next_steps: stringListSchema,
  files: stringListSchema,
  candidate_memories: stringListSchema,
  candidate_skills: stringListSchema,
  learnings: z.array(learningDeltaSchema).optional().default([])
}).refine((delta) => {
  return Boolean(delta.current_task)
    || delta.progress.length > 0
    || delta.decisions.length > 0
    || delta.changed_facts.length > 0
    || delta.blockers.length > 0
    || delta.next_steps.length > 0
    || delta.files.length > 0
    || delta.candidate_memories.length > 0
    || delta.candidate_skills.length > 0
    || delta.learnings.length > 0;
}, "Context delta requires semantic content");

export type ContextDeltaInput = z.input<typeof contextDeltaSchema>;
export type ContextDelta = z.output<typeof contextDeltaSchema>;

export function validateContextDelta(input: unknown): ContextDelta {
  return contextDeltaSchema.parse(input);
}
