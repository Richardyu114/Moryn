import { describe, expect, it } from "vitest";
import type { SemanticConsolidationProposal } from "../../src/core/context-delta.js";
import { isPrivateMemoryBoundary } from "../../src/core/sensitive.js";
import {
  losslessSemanticMergeSegmentUnionText,
  planStructuredSemanticMerge,
  projectStructuredSemanticMergeFinalRecord,
  STRUCTURED_SEMANTIC_MERGE_ACTIVATION_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY,
  STRUCTURED_SEMANTIC_MERGE_HIDE_REASON,
  STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON,
  structuredSemanticMergeInitialRecordMatches,
  structuredSemanticMergeProvisionalRecordMatches,
  structuredSemanticMergeRecordMatches,
  structuredSemanticMergeSourceDigest
} from "../../src/core/structured-semantic-merge.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(id: string, content: MorynRecord["content"], overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    tags: ["policy"],
    content,
    state: "canonical",
    confidence: 0.99,
    priority: "normal",
    visibility: "active",
    created_at: id === "new" ? "2026-07-20T00:00:01.000Z" : "2026-07-20T00:00:00.000Z",
    updated_at: id === "new" ? "2026-07-20T00:00:01.000Z" : "2026-07-20T00:00:00.000Z",
    source: { client: "codex" },
    provenance: { method: "user-confirmed" },
    ...overrides
  };
}

function proposal(overrides: Partial<SemanticConsolidationProposal> = {}): SemanticConsolidationProposal {
  return {
    proposal_id: "structured-1",
    source_record_id: "new",
    target_record_id: "old",
    relationship: "revises",
    confidence: 0.99,
    rationale: "Preserve exact cumulative values.",
    semantic_equivalence: "refinement",
    material_differences: [{ field: "commands", significance: "minor" }],
    evidence_record_ids: ["evidence"],
    structured_merge: {
      version: 1,
      requested_state: "canonical",
      fields: [{ field: "commands", disposition: "union", source_record_ids: ["new", "old"] }]
    },
    ...overrides
  };
}

describe("planStructuredSemanticMerge", () => {
  it("enforces active, domain, logical, and privacy boundaries on source records", () => {
    const duplicateProposal = proposal({
      relationship: "duplicate_of",
      semantic_equivalence: "equivalent",
      material_differences: [],
      evidence_record_ids: [],
      structured_merge: { version: 1, requested_state: "candidate", fields: [] }
    });
    const old = record("old", { text: "Same source-backed fact." });
    const next = record("new", { text: "Same source-backed fact." });

    expect(planStructuredSemanticMerge([old], duplicateProposal)).toEqual({
      status: "rejected",
      reason: "missing_record"
    });
    expect(
      planStructuredSemanticMerge([old, { ...next, state: "archived", visibility: "archived" }], duplicateProposal)
    ).toEqual({ status: "rejected", reason: "inactive_record" });
    expect(planStructuredSemanticMerge([old, { ...next, project_id: "other" }], duplicateProposal)).toEqual({
      status: "rejected",
      reason: "incompatible_domain"
    });

    const contentPrivate = record("new", { text: "Same source-backed fact.", privacy: "private" });
    expect(planStructuredSemanticMerge([old, contentPrivate], duplicateProposal, { include_private: true })).toEqual({
      status: "rejected",
      reason: "private_boundary"
    });
    const localOnlyOld = record("old", {
      text: "Same source-backed fact.",
      distribution: "local_only"
    });
    const localOnlyNext = record("new", {
      text: "Same source-backed fact.",
      distribution: "local_only"
    });
    expect(planStructuredSemanticMerge([localOnlyOld, localOnlyNext], duplicateProposal)).toEqual({
      status: "rejected",
      reason: "private_boundary"
    });
    expect(
      planStructuredSemanticMerge([localOnlyOld, localOnlyNext], duplicateProposal, { include_private: true }).status
    ).toBe("ready");

    const other = record("other", { text: "An existing logical winner." });
    const logicallyHidden = {
      ...old,
      links: [
        {
          record_id: other.id,
          link_type: "duplicate_of",
          created_at: "2026-07-20T00:00:02.000Z"
        }
      ]
    };
    expect(planStructuredSemanticMerge([logicallyHidden, next, other], duplicateProposal)).toEqual({
      status: "rejected",
      reason: "inactive_record"
    });
  });

  it("keeps a derived record private when structured dispositions obsolete legacy privacy fields", () => {
    const old = record("old", { text: "Device-only policy.", privacy: "private" });
    const next = record("new", { text: "Device-only policy.", distribution: "local_only" });
    const evidence = record(
      "evidence",
      { text: "The user approved the local-only merge.", privacy: "private" },
      { type: "evidence", source: { client: "user" } }
    );
    const result = planStructuredSemanticMerge(
      [old, next, evidence],
      proposal({
        evidence_record_ids: [evidence.id],
        structured_merge: {
          version: 1,
          requested_state: "canonical",
          fields: [
            {
              field: "privacy",
              disposition: "obsolete",
              source_record_ids: [old.id],
              evidence_record_ids: [evidence.id]
            },
            {
              field: "distribution",
              disposition: "obsolete",
              source_record_ids: [next.id],
              evidence_record_ids: [evidence.id]
            }
          ]
        }
      }),
      { include_private: true }
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan.initial_record.content.privacy).toBeUndefined();
    expect(result.plan.initial_record.content.distribution).toBeUndefined();
    expect(result.plan.initial_record.tags).toContain("private");
    expect(isPrivateMemoryBoundary(result.plan.initial_record)).toBe(true);
  });

  it("builds a stable source-backed union with per-value lineage", () => {
    const old = record("old", { text: "Use verified commands.", commands: ["npm test", "npm lint"] });
    const next = record("new", { text: "Use verified commands.", commands: ["npm build", "npm test"] });
    const evidence = record("evidence", { text: "The repository scripts are verified." }, { type: "evidence" });

    const first = planStructuredSemanticMerge([next, evidence, old], proposal());
    const reordered = planStructuredSemanticMerge([old, next, evidence], proposal());
    expect(first.status).toBe("ready");
    expect(reordered.status).toBe("ready");
    if (first.status !== "ready" || reordered.status !== "ready") return;

    expect(first.plan.initial_record.id).toBe(reordered.plan.initial_record.id);
    expect(first.plan.final_state).toBe("canonical");
    expect(first.plan.initial_record).toMatchObject({ state: "quarantined", visibility: "quarantined" });
    expect(structuredSemanticMergeProvisionalRecordMatches(first.plan.initial_record, first.plan)).toBe(true);
    expect(first.plan.initial_record.content.commands).toEqual(["npm build", "npm lint", "npm test"]);
    expect(first.plan.initial_record.provenance?.derived_from).toEqual(["new", "old"]);
    expect(first.plan.initial_record.content[STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY]).toMatchObject({
      version: 1,
      source_record_ids: ["new", "old"],
      source_digests: {
        new: structuredSemanticMergeSourceDigest(next),
        old: structuredSemanticMergeSourceDigest(old)
      },
      field_lineage: [
        {
          field: "commands",
          disposition: "union",
          source_record_ids: ["new", "old"],
          evidence_record_ids: [],
          values: [
            { value_digest: expect.stringMatching(/^[a-f0-9]{64}$/), source_record_ids: ["new"] },
            { value_digest: expect.stringMatching(/^[a-f0-9]{64}$/), source_record_ids: ["old"] },
            { value_digest: expect.stringMatching(/^[a-f0-9]{64}$/), source_record_ids: ["new", "old"] }
          ]
        },
        {
          field: "text",
          disposition: "retain",
          source_record_ids: ["new", "old"]
        }
      ]
    });
  });

  it("requires replace rather than retain when retain would discard a distinct source value", () => {
    const old = record("old", { text: "old wording" });
    const next = record("new", { text: "new wording" });
    const evidence = record("evidence", { text: "Verified wording." }, { type: "evidence" });
    const result = planStructuredSemanticMerge(
      [old, next, evidence],
      proposal({
        structured_merge: {
          version: 1,
          requested_state: "canonical",
          fields: [{ field: "text", disposition: "retain", source_record_id: "new" }]
        }
      })
    );

    expect(result).toEqual({ status: "rejected", reason: "structured_merge_invalid_field_disposition" });
  });

  it("accepts only the deterministic lossless text-segment union and projects the final transaction record", () => {
    const shared = "The source-backed deployment command is npm run dashboard.";
    const old = record("old", { text: `${shared} The old endpoint remains available.` });
    const next = record("new", { text: `${shared} The new endpoint is canonical.` });
    const value = losslessSemanticMergeSegmentUnionText([next, old]);
    expect(value).toBe(`${shared}\nThe old endpoint remains available.\nThe new endpoint is canonical.`);
    const mergeProposal = proposal({
      evidence_record_ids: [old.id, next.id],
      material_differences: [{ field: "text", significance: "minor" }],
      structured_merge: {
        version: 1,
        requested_state: "canonical",
        fields: [
          {
            field: "text",
            disposition: "synthesize",
            strategy: "lossless_segment_union",
            source_record_ids: [old.id, next.id],
            value: value as string
          }
        ]
      }
    });
    const result = planStructuredSemanticMerge([next, old], mergeProposal);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan.initial_record.content.text).toBe(value);
    expect(result.plan.initial_record.content[STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY]).toMatchObject({
      field_lineage: expect.arrayContaining([
        expect.objectContaining({ field: "text", disposition: "synthesize", source_record_ids: ["new", "old"] })
      ])
    });
    const projected = projectStructuredSemanticMergeFinalRecord(result.plan, "revises");
    expect(projected).toMatchObject({ state: "canonical", visibility: "active" });
    expect(projected.links).toHaveLength(3);
    expect(projected.links?.filter((link) => link.link_type === "revises")).toHaveLength(2);

    const changed = planStructuredSemanticMerge([next, old], {
      ...mergeProposal,
      structured_merge: {
        ...mergeProposal.structured_merge!,
        fields: [
          {
            ...mergeProposal.structured_merge!.fields[0]!,
            value: `${value}\nUnverified interpretation.`
          }
        ]
      }
    });
    expect(changed).toEqual({ status: "rejected", reason: "structured_merge_invalid_field_disposition" });
  });

  it("rejects union across incompatible cumulative value shapes", () => {
    const old = record("old", { text: "Cumulative values", values: [1] });
    const next = record("new", { text: "Cumulative values", values: ["one"] });
    const result = planStructuredSemanticMerge(
      [old, next],
      proposal({
        evidence_record_ids: [],
        structured_merge: {
          version: 1,
          fields: [{ field: "values", disposition: "union", source_record_ids: ["new", "old"] }]
        }
      })
    );
    expect(result).toEqual({ status: "rejected", reason: "structured_merge_invalid_field_disposition" });
  });

  it("rejects missing dispositions, untrusted replacement evidence, and protected obsolescence", () => {
    const old = record("old", { text: "Policy", label: "old", security_policy: "Never publish tokens" });
    const next = record("new", { text: "Policy", label: "new" });
    const agentEvidence = record(
      "evidence",
      { text: "Agent inferred the update." },
      { type: "evidence", state: "candidate", provenance: { method: "agent-proposed" } }
    );
    expect(
      planStructuredSemanticMerge(
        [old, next, agentEvidence],
        proposal({ structured_merge: { version: 1, requested_state: "canonical", fields: [] } })
      )
    ).toEqual({ status: "rejected", reason: "structured_merge_missing_field_disposition" });

    expect(
      planStructuredSemanticMerge(
        [old, next, agentEvidence],
        proposal({
          structured_merge: {
            version: 1,
            requested_state: "canonical",
            fields: [
              {
                field: "label",
                disposition: "replace",
                source_record_id: "new",
                replaced_source_record_ids: ["old"],
                evidence_record_ids: ["evidence"]
              },
              {
                field: "security_policy",
                disposition: "obsolete",
                source_record_ids: ["old"],
                evidence_record_ids: ["evidence"]
              }
            ]
          }
        })
      )
    ).toEqual({ status: "rejected", reason: "structured_merge_untrusted_evidence" });

    const canonicalAgentEvidence = record(
      "evidence",
      { text: "A canonical but non-user source says this is obsolete." },
      { type: "evidence", provenance: { method: "agent-proposed" } }
    );
    expect(
      planStructuredSemanticMerge(
        [old, next, canonicalAgentEvidence],
        proposal({
          structured_merge: {
            version: 1,
            requested_state: "canonical",
            fields: [
              {
                field: "label",
                disposition: "replace",
                source_record_id: "new",
                replaced_source_record_ids: ["old"],
                evidence_record_ids: ["evidence"]
              },
              {
                field: "security_policy",
                disposition: "obsolete",
                source_record_ids: ["old"],
                evidence_record_ids: ["evidence"]
              }
            ]
          }
        })
      )
    ).toEqual({
      status: "rejected",
      reason: "structured_merge_protected_obsolete_requires_user_evidence"
    });
  });

  it("downgrades to candidate when any source lacks canonical trust", () => {
    const old = record("old", { text: "Same fact" });
    const next = record("new", { text: "Same fact" }, { state: "candidate", provenance: { method: "agent-proposed" } });
    const result = planStructuredSemanticMerge(
      [old, next],
      proposal({
        relationship: "duplicate_of",
        semantic_equivalence: "equivalent",
        material_differences: [],
        evidence_record_ids: [],
        structured_merge: { version: 1, requested_state: "canonical", fields: [] }
      })
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.plan.final_state).toBe("candidate");
  });

  it("rejects an id collision whose immutable provenance or conflict state differs", () => {
    const old = record("old", { text: "Same fact" });
    const next = record("new", { text: "Same fact" });
    const result = planStructuredSemanticMerge(
      [old, next],
      proposal({
        relationship: "duplicate_of",
        semantic_equivalence: "equivalent",
        material_differences: [],
        evidence_record_ids: [],
        structured_merge: { version: 1, fields: [] }
      })
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const activated: MorynRecord = {
      ...result.plan.initial_record,
      state: "candidate",
      visibility: "active",
      updated_at: new Date(
        Date.parse(result.plan.initial_record.created_at) + STRUCTURED_SEMANTIC_MERGE_ACTIVATION_OFFSET_MS
      ).toISOString()
    };
    expect(
      structuredSemanticMergeRecordMatches(
        {
          ...activated,
          provenance: { ...result.plan.initial_record.provenance, reason: "collision" }
        },
        result.plan
      )
    ).toBe(false);
    expect(
      structuredSemanticMergeRecordMatches(
        {
          ...activated,
          conflict: { kind: "semantic", with: ["other"], resolution: "needs_review" }
        },
        result.plan
      )
    ).toBe(false);
  });

  it("fails closed on reserved metadata fields and cross-privacy evidence", () => {
    const reserved = record("old", {
      text: "Same fact",
      [STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY]: "user-authored value"
    });
    const next = record("new", { text: "Same fact" });
    expect(
      planStructuredSemanticMerge(
        [reserved, next],
        proposal({
          relationship: "duplicate_of",
          semantic_equivalence: "equivalent",
          material_differences: [],
          evidence_record_ids: [],
          structured_merge: { version: 1, fields: [] }
        })
      )
    ).toEqual({ status: "rejected", reason: "structured_merge_reserved_field_collision" });

    const old = record("old", { text: "Policy", label: "old" });
    const updated = record("new", { text: "Policy", label: "new" });
    const privateEvidence = record(
      "evidence",
      { text: "Private user confirmation." },
      { type: "evidence", tags: ["private"], source: { client: "user" } }
    );
    const replacement = proposal({
      structured_merge: {
        version: 1,
        requested_state: "canonical",
        fields: [
          {
            field: "label",
            disposition: "replace",
            source_record_id: "new",
            replaced_source_record_ids: ["old"],
            evidence_record_ids: ["evidence"]
          }
        ]
      }
    });
    expect(planStructuredSemanticMerge([old, updated, privateEvidence], replacement)).toEqual({
      status: "rejected",
      reason: "structured_merge_untrusted_evidence"
    });
    expect(
      planStructuredSemanticMerge([old, updated, privateEvidence], replacement, { include_private: true })
    ).toEqual({
      status: "rejected",
      reason: "structured_merge_untrusted_evidence"
    });

    const legacyPrivateEvidence = record(
      "evidence",
      { text: "Legacy local-only user confirmation.", distribution: "local_only" },
      { type: "evidence", source: { client: "user" } }
    );
    expect(
      planStructuredSemanticMerge([old, updated, legacyPrivateEvidence], replacement, { include_private: true })
    ).toEqual({
      status: "rejected",
      reason: "structured_merge_untrusted_evidence"
    });

    const evidenceWinner = record(
      "evidence-winner",
      { text: "Newer evidence." },
      { type: "evidence", source: { client: "user" } }
    );
    const hiddenEvidence = {
      ...record(
        "evidence",
        { text: "Superseded user confirmation." },
        { type: "evidence", source: { client: "user" } }
      ),
      links: [
        {
          record_id: evidenceWinner.id,
          link_type: "duplicate_of",
          created_at: "2026-07-20T00:00:02.000Z"
        }
      ]
    };
    expect(planStructuredSemanticMerge([old, updated, hiddenEvidence, evidenceWinner], replacement)).toEqual({
      status: "rejected",
      reason: "structured_merge_untrusted_evidence"
    });
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "rejects the unsafe semantic field name %s without prototype mutation",
    (fieldName) => {
      const oldContent: MorynRecord["content"] = { text: "Same fact" };
      const nextContent: MorynRecord["content"] = { text: "Same fact" };
      for (const content of [oldContent, nextContent]) {
        Object.defineProperty(content, fieldName, {
          configurable: true,
          enumerable: true,
          value: { polluted: true },
          writable: true
        });
      }

      expect(
        planStructuredSemanticMerge(
          [record("old", oldContent), record("new", nextContent)],
          proposal({
            relationship: "duplicate_of",
            semantic_equivalence: "equivalent",
            material_differences: [],
            evidence_record_ids: [],
            structured_merge: { version: 1, fields: [] }
          })
        )
      ).toEqual({ status: "rejected", reason: "structured_merge_unsafe_field_name" });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  );

  it("rejects the whole field evidence set when any cited record crosses its authorization boundary", () => {
    const old = record("old", { text: "Policy", label: "old" });
    const next = record("new", { text: "Policy", label: "new" });
    const trusted = record("evidence", { text: "Verified replacement." }, { type: "evidence" });
    const foreign = record(
      "foreign-evidence",
      { text: "Unrelated project evidence." },
      { type: "evidence", project_id: "another-project" }
    );
    const result = planStructuredSemanticMerge(
      [old, next, trusted, foreign],
      proposal({
        evidence_record_ids: [trusted.id, foreign.id],
        structured_merge: {
          version: 1,
          fields: [
            {
              field: "label",
              disposition: "replace",
              source_record_id: next.id,
              replaced_source_record_ids: [old.id],
              evidence_record_ids: [trusted.id, foreign.id]
            }
          ]
        }
      })
    );

    expect(result).toEqual({ status: "rejected", reason: "structured_merge_untrusted_evidence" });
  });

  it("binds evidence digests into lineage, identity, and the causal creation timestamp", () => {
    const old = record("old", { text: "Policy", label: "old" }, { updated_at: "2026-07-20T00:00:05.000Z" });
    const next = record("new", { text: "Policy", label: "new" }, { updated_at: "2026-07-20T00:00:10.000Z" });
    const evidence = record(
      "evidence",
      { text: "The user verified the replacement." },
      { type: "evidence", updated_at: "2026-07-20T00:00:20.000Z" }
    );
    const replacement = proposal({
      evidence_record_ids: [evidence.id],
      structured_merge: {
        version: 1,
        requested_state: "canonical",
        fields: [
          {
            field: "label",
            disposition: "replace",
            source_record_id: next.id,
            replaced_source_record_ids: [old.id],
            evidence_record_ids: [evidence.id]
          }
        ]
      }
    });
    const first = planStructuredSemanticMerge([old, next, evidence], replacement);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;

    const evidenceDigest = structuredSemanticMergeSourceDigest(evidence);
    expect(first.plan.initial_record.created_at).toBe("2026-07-20T00:00:20.001Z");
    expect(first.plan.evidence_digests).toEqual({ evidence: evidenceDigest });
    expect(first.plan.initial_record.content[STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY]).toMatchObject({
      evidence_record_ids: [evidence.id],
      evidence_digests: { [evidence.id]: evidenceDigest },
      field_lineage: expect.arrayContaining([
        expect.objectContaining({
          field: "label",
          evidence_record_ids: [evidence.id],
          evidence_digests: { [evidence.id]: evidenceDigest }
        })
      ])
    });

    const revisedEvidence = {
      ...evidence,
      content: { text: "The user verified a corrected replacement." },
      updated_at: "2026-07-20T00:00:30.000Z"
    };
    const revised = planStructuredSemanticMerge([old, next, revisedEvidence], replacement);
    expect(revised.status).toBe("ready");
    if (revised.status !== "ready") return;
    expect(revised.plan.initial_record.id).not.toBe(first.plan.initial_record.id);
    expect(revised.plan.initial_record.created_at).toBe("2026-07-20T00:00:30.001Z");
    expect(revised.plan.evidence_digests[evidence.id]).toBe(structuredSemanticMergeSourceDigest(revisedEvidence));
  });

  it("reuses the existing derived creation timestamp after a deterministic duplicate hide updates a source", () => {
    const old = record("old", { text: "Same fact" });
    const next = record("new", { text: "Same fact" });
    const duplicate = proposal({
      relationship: "duplicate_of",
      semantic_equivalence: "equivalent",
      material_differences: [],
      evidence_record_ids: [],
      structured_merge: { version: 1, requested_state: "canonical", fields: [] }
    });
    const first = planStructuredSemanticMerge([old, next], duplicate);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;

    const hiddenOld: MorynRecord = {
      ...old,
      updated_at: "2026-07-20T00:01:00.000Z",
      links: [
        {
          record_id: first.plan.initial_record.id,
          link_type: "duplicate_of",
          reason: STRUCTURED_SEMANTIC_MERGE_HIDE_REASON,
          created_at: "2026-07-20T00:01:00.000Z"
        }
      ]
    };
    const replay = planStructuredSemanticMerge([hiddenOld, next, first.plan.initial_record], duplicate);
    expect(replay.status).toBe("ready");
    if (replay.status !== "ready") return;
    expect(replay.plan.initial_record.id).toBe(first.plan.initial_record.id);
    expect(replay.plan.initial_record.created_at).toBe(first.plan.initial_record.created_at);
  });

  it("allows canonical projection readback but rejects it as an initial upsert collision", () => {
    const old = record("old", { text: "Same fact" });
    const next = record("new", { text: "Same fact" });
    const result = planStructuredSemanticMerge(
      [old, next],
      proposal({
        relationship: "duplicate_of",
        semantic_equivalence: "equivalent",
        material_differences: [],
        evidence_record_ids: [],
        structured_merge: { version: 1, requested_state: "canonical", fields: [] }
      })
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const promotedAt = new Date(
      Date.parse(result.plan.initial_record.created_at) + STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS
    ).toISOString();
    const promoted: MorynRecord = {
      ...result.plan.initial_record,
      state: "canonical",
      visibility: "active",
      updated_at: promotedAt,
      provenance: {
        ...result.plan.initial_record.provenance,
        reason: STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON,
        method: "rule-promoted",
        promoted_at: promotedAt
      }
    };

    expect(structuredSemanticMergeRecordMatches(promoted, result.plan)).toBe(true);
    expect(structuredSemanticMergeInitialRecordMatches(promoted, result.plan)).toBe(false);
    expect(
      structuredSemanticMergeRecordMatches(
        {
          ...promoted,
          provenance: {
            ...promoted.provenance,
            promoted_at: new Date(Date.parse(promotedAt) + 1).toISOString()
          }
        },
        result.plan
      )
    ).toBe(false);
  });
});
