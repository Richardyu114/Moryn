import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ContextDelta,
  type ContextDeltaInput,
  type LearningDelta,
  type LearningDeltaInput,
  type SemanticConsolidationProposal,
  validateContextDelta
} from "../../src/index.js";

describe("validateContextDelta", () => {
  it("normalizes strings, defaults arrays, filters blanks, and deduplicates in first-seen order", () => {
    const input: ContextDeltaInput = {
      session_id: " session-1 ",
      checkpoint_id: " checkpoint-1 ",
      current_task: " ship contracts ",
      progress: [" wrote tests ", "", "wrote tests", "  ", " ran tests "],
      decisions: [" use zod ", "use zod"],
      files: [" src/a.ts ", "src/a.ts", " src/b.ts "],
      learnings: [
        {
          question: " What changed? ",
          conclusion: " Contracts are explicit. ",
          evidence_type: "source_code",
          scope: "project",
          confidence: 0.9,
          recommended_kind: "memory",
          recommended_type: " contract ",
          related_record_ids: [" rec-2 ", "", "rec-1", "rec-2", "  "]
        }
      ]
    };

    const result: ContextDelta = validateContextDelta(input);

    expect(result).toEqual({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      current_task: "ship contracts",
      progress: ["wrote tests", "ran tests"],
      decisions: ["use zod"],
      changed_facts: [],
      blockers: [],
      next_steps: [],
      files: ["src/a.ts", "src/b.ts"],
      candidate_memories: [],
      candidate_skills: [],
      knowledge_investigations: [],
      semantic_consolidation_proposals: [],
      learnings: [
        {
          question: "What changed?",
          conclusion: "Contracts are explicit.",
          evidence_type: "source_code",
          scope: "project",
          confidence: 0.9,
          recommended_kind: "memory",
          recommended_type: "contract",
          related_record_ids: ["rec-2", "rec-1"]
        }
      ]
    });
  });

  it("accepts current_task as the only semantic content", () => {
    expect(
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        current_task: "Investigate context loss"
      })
    ).toMatchObject({ current_task: "Investigate context loss" });
  });

  it("filters an empty optional current_task when other semantic content exists", () => {
    const result = validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      current_task: "  ",
      progress: ["done"]
    });

    expect(result.current_task).toBeUndefined();
  });

  it("rejects empty identity fields and identity-only deltas", () => {
    expect(() =>
      validateContextDelta({
        session_id: " ",
        checkpoint_id: "checkpoint-1",
        progress: ["done"]
      })
    ).toThrow();
    expect(() =>
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: " ",
        progress: ["done"]
      })
    ).toThrow();
    expect(() =>
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        progress: ["", "  "]
      })
    ).toThrow();
  });

  it("reports semantic-empty deltas with a stable issue message and path", () => {
    try {
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1"
      });
      expect.fail("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect((error as z.ZodError).issues).toContainEqual(
        expect.objectContaining({
          message: "context delta requires semantic content",
          path: ["semantic_content"]
        })
      );
    }
  });

  it("rejects unknown keys on context and learning objects", () => {
    expect(() =>
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        next_step: ["ship it"]
      })
    ).toThrow(z.ZodError);

    expect(() =>
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        learnings: [
          {
            question: "What is stable?",
            conclusion: "The contract shape.",
            evidence_type: "source_code",
            scope: "project",
            confidence: 0.9,
            confidence_score: 0.9,
            recommended_kind: "memory",
            recommended_type: "contract"
          }
        ]
      })
    ).toThrow(z.ZodError);
  });

  it("validates learning enums, confidence, and required strings", () => {
    const base: LearningDeltaInput = {
      question: "What is stable?",
      conclusion: "The contract shape.",
      evidence_type: "user_confirmed",
      scope: "session",
      confidence: 1,
      recommended_kind: "skill",
      recommended_type: "workflow"
    };
    const valid: LearningDelta = validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      learnings: [base]
    }).learnings[0];
    expect(valid.related_record_ids).toEqual([]);

    for (const patch of [
      { question: " " },
      { conclusion: " " },
      { recommended_type: " " },
      { evidence_type: "guess" },
      { scope: "workspace" },
      { recommended_kind: "note" },
      { confidence: -0.01 },
      { confidence: 1.01 }
    ]) {
      expect(() =>
        validateContextDelta({
          session_id: "session-1",
          checkpoint_id: "checkpoint-1",
          learnings: [{ ...base, ...patch }]
        })
      ).toThrow();
    }
  });

  it("requires a strict parseable ISO timestamp and preserves its canonical string", () => {
    const result = validateContextDelta({
      session_id: "session-1",
      checkpoint_id: "checkpoint-1",
      learnings: [
        {
          question: "How long is it valid?",
          conclusion: "Until the release.",
          evidence_type: "documentation",
          scope: "global",
          confidence: 0.75,
          valid_until: "2026-07-11T12:34:56.000Z",
          recommended_kind: "memory",
          recommended_type: "release_fact"
        }
      ]
    });
    expect(result.learnings[0].valid_until).toBe("2026-07-11T12:34:56.000Z");

    for (const valid_until of [
      "2026-07-11",
      "2026-07-11T12:34:56Z",
      "2026-07-11T20:34:56.000+08:00",
      "not-a-date",
      "2026-02-30T12:34:56.000Z"
    ]) {
      expect(() =>
        validateContextDelta({
          session_id: "session-1",
          checkpoint_id: "checkpoint-1",
          learnings: [
            {
              question: "How long is it valid?",
              conclusion: "Until the release.",
              evidence_type: "web",
              scope: "global",
              confidence: 0.5,
              valid_until,
              recommended_kind: "memory",
              recommended_type: "release_fact"
            }
          ]
        })
      ).toThrow();
    }
  });

  it("reports extreme ISO years as ZodError without leaking RangeError", () => {
    expect(() =>
      validateContextDelta({
        session_id: "session-1",
        checkpoint_id: "checkpoint-1",
        learnings: [
          {
            question: "How long is it valid?",
            conclusion: "Until the release.",
            evidence_type: "inference",
            scope: "global",
            confidence: 0.5,
            valid_until: "+999999-01-01T00:00:00.000Z",
            recommended_kind: "memory",
            recommended_type: "release_fact"
          }
        ]
      })
    ).toThrow(z.ZodError);
  });

  it("normalizes strict semantic consolidation proposals", () => {
    const proposal: SemanticConsolidationProposal = validateContextDelta({
      session_id: " session-1 ",
      checkpoint_id: " checkpoint-1 ",
      semantic_consolidation_proposals: [
        {
          proposal_id: " proposal-1 ",
          source_record_id: " rec-new ",
          target_record_id: " rec-old ",
          relationship: "revises",
          confidence: 0.98,
          rationale: " Clarifies the same retry policy with source-code evidence. ",
          semantic_equivalence: "refinement",
          material_differences: [
            { field: " retry count ", before: " three retries ", after: " 3 retries ", significance: "minor" }
          ],
          evidence_record_ids: [" rec-evidence "]
        }
      ]
    }).semantic_consolidation_proposals[0];

    expect(proposal).toEqual({
      proposal_id: "proposal-1",
      source_record_id: "rec-new",
      target_record_id: "rec-old",
      relationship: "revises",
      confidence: 0.98,
      rationale: "Clarifies the same retry policy with source-code evidence.",
      semantic_equivalence: "refinement",
      material_differences: [
        { field: "retry count", before: "three retries", after: "3 retries", significance: "minor" }
      ],
      evidence_record_ids: ["rec-evidence"]
    });
  });

  it("normalizes an opt-in structured merge field plan", () => {
    const proposal = validateContextDelta({
      session_id: "session-structured",
      checkpoint_id: "checkpoint-structured",
      semantic_consolidation_proposals: [
        {
          proposal_id: " structured-1 ",
          source_record_id: " rec-new ",
          target_record_id: " rec-old ",
          relationship: "revises",
          confidence: 0.99,
          rationale: "Preserve cumulative commands and replace one source-backed label.",
          semantic_equivalence: "refinement",
          material_differences: [{ field: "commands", significance: "minor" }],
          evidence_record_ids: [" evidence-1 "],
          structured_merge: {
            version: 1,
            requested_state: "canonical",
            fields: [
              {
                field: " commands ",
                disposition: "union",
                source_record_ids: ["rec-new", "rec-old"]
              },
              {
                field: " label ",
                disposition: "replace",
                source_record_id: "rec-new",
                replaced_source_record_ids: ["rec-old"],
                evidence_record_ids: ["evidence-1"]
              }
            ]
          }
        }
      ]
    }).semantic_consolidation_proposals[0];

    expect(proposal?.structured_merge).toEqual({
      version: 1,
      requested_state: "canonical",
      fields: [
        { field: "commands", disposition: "union", source_record_ids: ["rec-new", "rec-old"] },
        {
          field: "label",
          disposition: "replace",
          source_record_id: "rec-new",
          replaced_source_record_ids: ["rec-old"],
          evidence_record_ids: ["evidence-1"]
        }
      ]
    });
  });

  it("rejects malformed semantic consolidation proposals", () => {
    const valid = {
      proposal_id: "proposal-1",
      source_record_id: "rec-new",
      target_record_id: "rec-old",
      relationship: "revises" as const,
      confidence: 0.98,
      rationale: "Clarifies the same retry policy.",
      semantic_equivalence: "refinement" as const,
      material_differences: [{ field: "wording", significance: "minor" as const }],
      evidence_record_ids: ["rec-evidence"]
    };
    const invalid = [
      { ...valid, unknown: true },
      { ...valid, target_record_id: "rec-new" },
      { ...valid, semantic_equivalence: "equivalent" },
      { ...valid, confidence: -0.01 },
      { ...valid, confidence: 1.01 },
      { ...valid, rationale: " " },
      { ...valid, evidence_record_ids: ["rec-evidence", " rec-evidence "] },
      { ...valid, material_differences: [{ field: " ", significance: "minor" }] },
      { ...valid, material_differences: [{ field: "wording", significance: "major" }] },
      {
        ...valid,
        structured_merge: {
          version: 1,
          fields: [{ field: "text", disposition: "union", source_record_ids: ["rec-other"] }]
        }
      },
      {
        ...valid,
        structured_merge: {
          version: 1,
          fields: [
            {
              field: "text",
              disposition: "replace",
              source_record_id: "rec-new",
              replaced_source_record_ids: ["rec-old"],
              evidence_record_ids: ["undeclared-evidence"]
            }
          ]
        }
      }
    ];

    for (const proposal of invalid) {
      expect(() =>
        validateContextDelta({
          session_id: "session-1",
          checkpoint_id: "checkpoint-1",
          semantic_consolidation_proposals: [proposal]
        })
      ).toThrow(z.ZodError);
    }
  });
});

describe("knowledge investigations", () => {
  it("normalizes bounded resolved and unresolved investigation state", () => {
    const result = validateContextDelta({
      session_id: "session-knowledge",
      checkpoint_id: "checkpoint-knowledge",
      knowledge_investigations: [
        {
          resolution_id: " rollback-policy ",
          question: " What is the rollback policy? ",
          recall_status: "knowledge_gap",
          recalled_record_ids: [" rec-b ", "rec-a", "rec-b"],
          evidence: [
            { type: "source_code", reference: " src/release.ts ", summary: " Rollback uses the signed tag. " }
          ],
          status: "unresolved",
          next_step: " Run the rollback integration test. "
        }
      ]
    });

    expect(result.knowledge_investigations).toEqual([
      {
        resolution_id: "rollback-policy",
        question: "What is the rollback policy?",
        recall_status: "knowledge_gap",
        recalled_record_ids: ["rec-b", "rec-a"],
        evidence: [{ type: "source_code", reference: "src/release.ts", summary: "Rollback uses the signed tag." }],
        status: "unresolved",
        next_step: "Run the rollback integration test."
      }
    ]);
  });

  it("requires conclusions for resolved items and next steps for unresolved items", () => {
    const base = { session_id: "session-knowledge", checkpoint_id: "checkpoint-knowledge" };
    expect(() =>
      validateContextDelta({
        ...base,
        knowledge_investigations: [
          { resolution_id: "resolved", question: "Q", recall_status: "knowledge_gap", status: "resolved", evidence: [] }
        ]
      })
    ).toThrow();
    expect(() =>
      validateContextDelta({
        ...base,
        knowledge_investigations: [
          {
            resolution_id: "unresolved",
            question: "Q",
            recall_status: "knowledge_gap",
            status: "unresolved",
            evidence: []
          }
        ]
      })
    ).toThrow();
    expect(() =>
      validateContextDelta({
        ...base,
        knowledge_investigations: [
          {
            resolution_id: "same",
            question: "Q1",
            recall_status: "knowledge_gap",
            status: "unresolved",
            next_step: "N1",
            evidence: []
          },
          {
            resolution_id: "same",
            question: "Q2",
            recall_status: "verification_required",
            status: "unresolved",
            next_step: "N2",
            evidence: []
          }
        ]
      })
    ).toThrow();
  });
});
