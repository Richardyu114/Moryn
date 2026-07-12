import { describe, expect, it } from "vitest";
import { discoverAutomaticDuplicateProposal } from "../../src/core/automatic-consolidation.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "new",
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: ["learning"],
    content: { text: "Moryn automatically pulls project memory when an agent enters the project." },
    state: "canonical",
    confidence: 0.95,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-12T00:01:00.000Z",
    updated_at: "2026-07-12T00:01:00.000Z",
    source: { client: "codex" },
    provenance: { method: "rule-promoted" },
    ...overrides
  };
}

describe("automatic near-duplicate consolidation", () => {
  it("proposes one deterministic duplicate link for equivalent wording", () => {
    const source = record();
    const target = record({
      id: "old",
      tags: ["learning", "stable"],
      content: { text: "When an agent enters a project, Moryn automatically pulls the project memory." },
      created_at: "2026-07-12T00:00:00.000Z",
      updated_at: "2026-07-12T00:00:00.000Z",
      provenance: { method: "user-confirmed" }
    });

    expect(discoverAutomaticDuplicateProposal([source, target], source.id)).toMatchObject({
      source_record_id: target.id,
      target_record_id: source.id,
      relationship: "duplicate_of",
      semantic_equivalence: "equivalent",
      confidence: 0.99,
      material_differences: []
    });
  });

  it.each([
    ["number", "Retry 3 times", "Retry 4 times"],
    ["version", "Use Moryn v0.2", "Use Moryn v0.3"],
    ["permission", "Agents may push automatically", "Agents must not push automatically"],
    ["preference", "User prefers concise output", "User prefers detailed output"]
  ])("rejects protected %s differences", (_label, sourceText, targetText) => {
    const source = record({ content: { text: sourceText } });
    const target = record({ id: "old", content: { text: targetText } });
    expect(discoverAutomaticDuplicateProposal([source, target], source.id)).toBeUndefined();
  });

  it("rejects weak overlap, private boundaries, and incompatible domains", () => {
    const source = record();
    expect(discoverAutomaticDuplicateProposal([source, record({ id: "weak", content: { text: "Dashboard uses a quiet status pulse." } })], source.id)).toBeUndefined();
    expect(discoverAutomaticDuplicateProposal([source, record({ id: "private", tags: ["private"], content: { text: source.content.text } })], source.id)).toBeUndefined();
    expect(discoverAutomaticDuplicateProposal([source, record({ id: "skill", kind: "skill", content: { text: source.content.text } })], source.id)).toBeUndefined();
  });
});
