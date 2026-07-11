import { describe, expect, it } from "vitest";
import { validateSemanticConsolidationProposal } from "../../src/core/semantic-consolidation.js";
import type { SemanticConsolidationProposal } from "../../src/core/context-delta.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "new",
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    tags: ["lifecycle"],
    content: { text: "Agents pull memory when entering a project." },
    state: "canonical",
    confidence: 0.95,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-12T00:01:00.000Z",
    updated_at: "2026-07-12T00:01:00.000Z",
    source: { client: "codex" },
    provenance: { derived_from: ["evidence"], method: "agent-proposed" },
    ...overrides
  };
}

function proposal(overrides: Partial<SemanticConsolidationProposal> = {}): SemanticConsolidationProposal {
  return {
    proposal_id: "proposal-1",
    source_record_id: "new",
    target_record_id: "old",
    relationship: "duplicate_of",
    confidence: 0.98,
    rationale: "Equivalent lifecycle behavior.",
    semantic_equivalence: "equivalent",
    material_differences: [],
    evidence_record_ids: [],
    ...overrides
  };
}

describe("validateSemanticConsolidationProposal", () => {
  it("accepts a high-confidence equivalent paraphrase and corrects the canonical target", () => {
    const newRecord = record({ id: "new", state: "candidate", priority: "high" });
    const oldRecord = record({ id: "old", content: { text: "Pull memories on agent enter." }, provenance: { method: "user-confirmed" } });

    expect(validateSemanticConsolidationProposal([newRecord, oldRecord], proposal())).toMatchObject({
      status: "accepted",
      reason: "accepted",
      source_record_id: newRecord.id,
      target_record_id: oldRecord.id,
      relationship: "duplicate_of",
      proposal_digest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    expect(validateSemanticConsolidationProposal([newRecord, oldRecord], proposal({
      source_record_id: oldRecord.id,
      target_record_id: newRecord.id
    }))).toMatchObject({
      status: "accepted",
      source_record_id: newRecord.id,
      target_record_id: oldRecord.id
    });
  });

  it("enforces relationship-specific thresholds and evidence", () => {
    const newRecord = record();
    const oldRecord = record({ id: "old", updated_at: "2026-07-11T00:00:00.000Z" });
    const evidence = record({ id: "evidence", type: "evidence", content: { text: "Source code confirms the lifecycle behavior." } });

    expect(validateSemanticConsolidationProposal([newRecord, oldRecord], proposal({ confidence: 0.979 }))).toMatchObject({ status: "rejected", reason: "below_confidence_threshold" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord, evidence], proposal({
      relationship: "revises",
      semantic_equivalence: "refinement",
      confidence: 0.97,
      material_differences: [{ field: "wording", before: "on enter", after: "when entering", significance: "minor" }],
      evidence_record_ids: [evidence.id]
    }))).toMatchObject({ status: "accepted", reason: "accepted" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord], proposal({
      relationship: "revises",
      semantic_equivalence: "refinement",
      confidence: 0.97,
      material_differences: [{ field: "wording", significance: "minor" }]
    }))).toMatchObject({ status: "rejected", reason: "missing_evidence" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord, evidence], proposal({
      relationship: "supersedes",
      semantic_equivalence: "replacement",
      confidence: 0.99,
      material_differences: [{ field: "policy", before: "manual pull", after: "automatic pull", significance: "material" }],
      evidence_record_ids: [evidence.id]
    }))).toMatchObject({ status: "accepted", reason: "accepted" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord], proposal({
      relationship: "conflicts_with",
      semantic_equivalence: "conflict",
      confidence: 0.95,
      material_differences: [{ field: "policy", before: "pull", after: "do not pull", significance: "material" }]
    }))).toMatchObject({ status: "accepted", reason: "accepted" });
  });

  it("rejects missing, incompatible, private, inactive, and hidden records", () => {
    const newRecord = record();
    const oldRecord = record({ id: "old" });
    expect(validateSemanticConsolidationProposal([newRecord], proposal())).toMatchObject({ status: "rejected", reason: "missing_record" });

    for (const incompatible of [
      oldRecord,
      record({ id: "old", kind: "skill" }),
      record({ id: "old", type: "warning" }),
      record({ id: "old", scope: "global", project_id: undefined }),
      record({ id: "old", project_id: "other" })
    ].slice(1)) {
      expect(validateSemanticConsolidationProposal([newRecord, incompatible], proposal())).toMatchObject({ status: "rejected", reason: "incompatible_domain" });
    }

    expect(validateSemanticConsolidationProposal([newRecord, record({ id: "old", tags: ["private"] })], proposal(), { include_private: true })).toMatchObject({ status: "rejected", reason: "private_boundary" });
    expect(validateSemanticConsolidationProposal([record({ tags: ["private"] }), record({ id: "old", tags: ["private"] })], proposal())).toMatchObject({ status: "rejected", reason: "private_boundary" });
    expect(validateSemanticConsolidationProposal([newRecord, record({ id: "old", state: "archived", visibility: "archived" })], proposal())).toMatchObject({ status: "rejected", reason: "inactive_record" });
    expect(validateSemanticConsolidationProposal([newRecord, record({ id: "old", state: "quarantined", visibility: "quarantined" })], proposal())).toMatchObject({ status: "rejected", reason: "inactive_record" });

    const active = record({ id: "active" });
    const hidden = record({ id: "old", links: [{ record_id: active.id, link_type: "duplicate_of", created_at: "2026-07-12T00:00:00.000Z" }] });
    expect(validateSemanticConsolidationProposal([newRecord, hidden, active], proposal())).toMatchObject({ status: "rejected", reason: "inactive_record" });
  });

  it("rejects existing, contradictory, and cyclic relationships", () => {
    const existingSource = record({ links: [{ record_id: "old", link_type: "duplicate_of", created_at: "2026-07-12T00:00:00.000Z" }] });
    const oldRecord = record({ id: "old" });
    expect(validateSemanticConsolidationProposal([existingSource, oldRecord], proposal())).toMatchObject({ status: "idempotent", reason: "existing_relationship" });

    const contradictory = record({ id: "old", links: [{ record_id: "new", link_type: "supersedes", created_at: "2026-07-12T00:00:00.000Z" }] });
    expect(validateSemanticConsolidationProposal([record(), contradictory], proposal({
      relationship: "supersedes",
      semantic_equivalence: "replacement",
      confidence: 0.99,
      material_differences: [{ field: "policy", significance: "material" }],
      evidence_record_ids: ["new"]
    }))).toMatchObject({ status: "rejected", reason: "contradictory_relationship" });

    const first = record({ id: "first", links: [{ record_id: "second", link_type: "supersedes", created_at: "2026-07-12T00:00:00.000Z" }] });
    const second = record({ id: "second", links: [{ record_id: "third", link_type: "supersedes", created_at: "2026-07-12T00:01:00.000Z" }] });
    const third = record({ id: "third" });
    expect(validateSemanticConsolidationProposal([first, second, third], proposal({
      source_record_id: third.id,
      target_record_id: first.id,
      relationship: "supersedes",
      semantic_equivalence: "replacement",
      confidence: 0.99,
      material_differences: [{ field: "policy", significance: "material" }],
      evidence_record_ids: [third.id]
    }))).toMatchObject({ status: "rejected", reason: "replacement_cycle" });
  });

  it("replays an existing duplicate link after canonical target timestamps change", () => {
    const originalSource = record({ id: "new", updated_at: "2026-07-12T00:02:00.000Z", links: [{ record_id: "old", link_type: "duplicate_of", created_at: "2026-07-12T00:02:00.000Z" }] });
    const originalTarget = record({ id: "old", updated_at: "2026-07-12T00:01:00.000Z", provenance: { method: "user-confirmed" } });
    expect(validateSemanticConsolidationProposal([originalSource, originalTarget], proposal())).toMatchObject({ status: "idempotent", reason: "existing_relationship", source_record_id: "new", target_record_id: "old" });
  });

  it.each([
    ["negation", "Pull on enter", "Never pull on enter"],
    ["number", "Retry 3 times", "Retry 4 times"],
    ["date", "Valid until 2026-07-12", "Valid until 2026-08-12"],
    ["version", "Use v0.2", "Use v0.3"],
    ["path", "Edit src/a.ts", "Edit src/b.ts"],
    ["command", "Run npm test", "Run npm publish"],
    ["permission", "May push", "Must not push"],
    ["security", "Public token", "Private credential"],
    ["status", "Task pending", "Task completed"],
    ["outcome", "Tests failed", "Tests passed"],
    ["preference", "User prefers concise output", "User prefers detailed output"]
  ])("rejects protected %s differences for duplicate and refinement", (_label, before, after) => {
    const newRecord = record({ content: { text: after } });
    const oldRecord = record({ id: "old", content: { text: before } });
    const evidence = record({ id: "evidence", type: "evidence" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord], proposal({
      material_differences: [{ field: "content", before, after, significance: "minor" }]
    }))).toMatchObject({ status: "rejected", reason: "protected_signal_difference" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord, evidence], proposal({
      relationship: "revises",
      semantic_equivalence: "refinement",
      confidence: 0.97,
      material_differences: [{ field: "content", before, after, significance: "minor" }],
      evidence_record_ids: [evidence.id]
    }))).toMatchObject({ status: "rejected", reason: "protected_signal_difference" });
  });

  it("requires user-confirmed evidence for protected replacements", () => {
    const newRecord = record({ content: { text: "Never auto-push credentials." } });
    const oldRecord = record({ id: "old", content: { text: "Auto-push credentials." } });
    const agentEvidence = record({ id: "evidence", type: "evidence", provenance: { method: "agent-proposed" } });
    const userEvidence = record({ id: "user-evidence", type: "evidence", provenance: { method: "user-confirmed" } });
    const replacement = proposal({
      relationship: "supersedes",
      semantic_equivalence: "replacement",
      confidence: 0.99,
      material_differences: [{ field: "security policy", before: "Auto-push credentials", after: "Never auto-push credentials", significance: "material" }],
      evidence_record_ids: [agentEvidence.id]
    });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord, agentEvidence], replacement)).toMatchObject({ status: "rejected", reason: "protected_replacement_requires_user_evidence" });
    expect(validateSemanticConsolidationProposal([newRecord, oldRecord, userEvidence], { ...replacement, evidence_record_ids: [userEvidence.id] })).toMatchObject({ status: "accepted", reason: "accepted" });
  });
});
