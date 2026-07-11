import { z } from "zod";

const nonEmptyStringSchema = z.string().transform((value) => value.trim()).pipe(z.string().min(1));
const optionalStringSchema = z.string().transform((value) => value.trim() || undefined).optional();

const stringListSchema = z.array(z.string()).optional().transform((values) => {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  return [...new Set(normalized)];
});

const strictUniqueStringListSchema = z.array(z.string()).optional().transform((values, context) => {
  const normalized = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: "custom", message: "Expected unique non-empty strings" });
    return z.NEVER;
  }
  return normalized;
});

const canonicalIsoTimestampSchema = z.string().refine((value) => {
  try {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
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
}).strict();

export type LearningDeltaInput = z.input<typeof learningDeltaSchema>;
export type LearningDelta = z.output<typeof learningDeltaSchema>;

export const semanticConsolidationDifferenceSchema = z.object({
  field: nonEmptyStringSchema,
  before: optionalStringSchema,
  after: optionalStringSchema,
  significance: z.enum(["none", "minor", "material"])
}).strict();

export const semanticConsolidationProposalSchema = z.object({
  proposal_id: nonEmptyStringSchema,
  source_record_id: nonEmptyStringSchema,
  target_record_id: nonEmptyStringSchema,
  relationship: z.enum(["duplicate_of", "revises", "supersedes", "conflicts_with"]),
  confidence: z.number().finite().min(0).max(1),
  rationale: nonEmptyStringSchema,
  semantic_equivalence: z.enum(["equivalent", "refinement", "replacement", "conflict"]),
  material_differences: z.array(semanticConsolidationDifferenceSchema).max(16).optional().default([]),
  evidence_record_ids: strictUniqueStringListSchema
}).strict().superRefine((proposal, context) => {
  if (proposal.source_record_id === proposal.target_record_id) {
    context.addIssue({ code: "custom", path: ["target_record_id"], message: "source and target records must differ" });
  }
  const expected = { duplicate_of: "equivalent", revises: "refinement", supersedes: "replacement", conflicts_with: "conflict" } as const;
  if (proposal.semantic_equivalence !== expected[proposal.relationship]) {
    context.addIssue({ code: "custom", path: ["semantic_equivalence"], message: "semantic equivalence must match relationship" });
  }
});

export type SemanticConsolidationDifferenceInput = z.input<typeof semanticConsolidationDifferenceSchema>;
export type SemanticConsolidationDifference = z.output<typeof semanticConsolidationDifferenceSchema>;
export type SemanticConsolidationProposalInput = z.input<typeof semanticConsolidationProposalSchema>;
export type SemanticConsolidationProposal = z.output<typeof semanticConsolidationProposalSchema>;

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
  learnings: z.array(learningDeltaSchema).optional().default([]),
  semantic_consolidation_proposals: z.array(semanticConsolidationProposalSchema).max(24).optional().default([])
}).strict().superRefine((delta, context) => {
  const hasSemanticContent = Boolean(delta.current_task)
    || delta.progress.length > 0
    || delta.decisions.length > 0
    || delta.changed_facts.length > 0
    || delta.blockers.length > 0
    || delta.next_steps.length > 0
    || delta.files.length > 0
    || delta.candidate_memories.length > 0
    || delta.candidate_skills.length > 0
    || delta.learnings.length > 0
    || delta.semantic_consolidation_proposals.length > 0;
  if (!hasSemanticContent) {
    context.addIssue({
      code: "custom",
      message: "context delta requires semantic content",
      path: ["semantic_content"]
    });
  }
});

export type ContextDeltaInput = z.input<typeof contextDeltaSchema>;
export type ContextDelta = z.output<typeof contextDeltaSchema>;

export function validateContextDelta(input: unknown): ContextDelta {
  return contextDeltaSchema.parse(input);
}
