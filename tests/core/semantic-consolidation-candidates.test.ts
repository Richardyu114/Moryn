import { describe, expect, it } from "vitest";
import {
  discoverSemanticConsolidationCandidates,
  retrieveSemanticConsolidationCandidates
} from "../../src/core/semantic-consolidation-candidates.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "source",
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    tags: ["sync"],
    content: { text: "Pull memory on agent enter", files: ["src/core/agent-lifecycle.ts"] },
    state: "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    source: { client: "codex" },
    ...overrides
  };
}

describe("retrieveSemanticConsolidationCandidates", () => {
  it("preserves prototype-shaped source record ids as own serializable keys", () => {
    const sourceRecordIds = ["__proto__", "constructor", "prototype"];
    const records = sourceRecordIds.map((id) => record({ id }));
    const result = retrieveSemanticConsolidationCandidates(records, { source_record_ids: sourceRecordIds });
    const serialized = JSON.parse(JSON.stringify(result.candidates_by_source_record_id)) as Record<string, unknown>;

    expect(Object.getPrototypeOf(result.candidates_by_source_record_id)).toBeNull();
    for (const sourceRecordId of sourceRecordIds) {
      expect(Object.hasOwn(result.candidates_by_source_record_id, sourceRecordId)).toBe(true);
      expect(result.candidates_by_source_record_id[sourceRecordId]).toHaveLength(2);
      expect(Object.hasOwn(serialized, sourceRecordId)).toBe(true);
    }
  });

  it("returns only compatible active logical records", () => {
    const source = record();
    const compatible = record({
      id: "compatible",
      content: { text: "Agents pull memories when entering", files: ["src/core/agent-lifecycle.ts"] }
    });
    const duplicateHistory = record({
      id: "duplicate-history",
      links: [{ record_id: compatible.id, link_type: "duplicate_of", created_at: "2026-07-11T00:01:00.000Z" }]
    });
    const superseded = record({ id: "superseded", content: { text: "Old pull behavior" } });
    const replacement = record({
      id: "replacement",
      content: { text: "New pull behavior" },
      links: [{ record_id: superseded.id, link_type: "supersedes", created_at: "2026-07-11T00:02:00.000Z" }]
    });
    const revisionDraft = record({ id: "revision-draft", content: { text: "Draft pull behavior" } });
    const revision = record({
      id: "revision",
      content: { text: "Final pull behavior" },
      links: [{ record_id: revisionDraft.id, link_type: "revises", created_at: "2026-07-11T00:03:00.000Z" }]
    });
    const records = [
      source,
      compatible,
      duplicateHistory,
      superseded,
      replacement,
      revisionDraft,
      revision,
      record({ id: "archived", state: "archived", visibility: "archived" }),
      record({ id: "quarantined", state: "quarantined", visibility: "quarantined" }),
      record({ id: "other-kind", kind: "skill" }),
      record({ id: "other-type", type: "warning" }),
      record({ id: "other-scope", scope: "global", project_id: undefined }),
      record({ id: "other-project", project_id: "other" })
    ];

    const result = retrieveSemanticConsolidationCandidates(records, { source_record_ids: [source.id] });

    expect(result.candidates_by_source_record_id[source.id].map((candidate) => candidate.record_id)).toEqual([
      "compatible",
      "replacement",
      "revision"
    ]);
    expect(result.candidates.map((candidate) => candidate.source_record_id)).toEqual([source.id, source.id, source.id]);
  });

  it("keeps candidates inside the same authorized privacy boundary", () => {
    const publicSource = record({ id: "public-source" });
    const publicTarget = record({ id: "public-target" });
    const privateSource = record({
      id: "private-source",
      content: { text: "Pull memory on agent enter", files: ["src/core/agent-lifecycle.ts"], privacy: "private" }
    });
    const privateTarget = record({
      id: "private-target",
      content: {
        text: "Pull memory on agent enter",
        files: ["src/core/agent-lifecycle.ts"],
        distribution: "local_only"
      }
    });
    const records = [publicSource, publicTarget, privateSource, privateTarget];

    expect(
      retrieveSemanticConsolidationCandidates(records, {
        source_record_ids: [publicSource.id],
        include_private: true
      }).candidates.map((candidate) => candidate.record_id)
    ).toEqual([publicTarget.id]);
    expect(
      retrieveSemanticConsolidationCandidates(records, {
        source_record_ids: [privateSource.id]
      }).candidates
    ).toEqual([]);
    expect(
      retrieveSemanticConsolidationCandidates(records, {
        source_record_ids: [privateSource.id],
        include_private: true
      }).candidates.map((candidate) => candidate.record_id)
    ).toEqual([privateTarget.id]);
  });

  it("ranks exact fingerprints before shared evidence and token overlap", () => {
    const source = record({
      id: "source",
      tags: ["sync", "lifecycle"],
      provenance: { derived_from: ["evidence-a"], method: "agent-proposed" }
    });
    const exact = record({ id: "z-exact", tags: ["lifecycle", "sync"], source: { client: "claude-code" } });
    const sharedEvidence = record({
      id: "a-evidence",
      tags: ["sync"],
      content: { text: "Load context during startup", files: ["src/core/agent-lifecycle.ts"] },
      provenance: { derived_from: ["evidence-a"], method: "agent-proposed" }
    });
    const overlap = record({
      id: "b-overlap",
      tags: [],
      content: { text: "Agent enter should pull local memory context" }
    });

    const candidates = retrieveSemanticConsolidationCandidates([source, overlap, sharedEvidence, exact], {
      source_record_ids: [source.id]
    }).candidates;

    expect(candidates.map((candidate) => candidate.record_id)).toEqual([exact.id, sharedEvidence.id, overlap.id]);
    expect(candidates[0]).toMatchObject({ exact_fingerprint: true });
    expect(candidates[1].signals).toEqual(expect.arrayContaining(["shared_file", "shared_provenance"]));
    expect(candidates[2].token_overlap).toBeGreaterThan(0);
  });

  it("uses deterministic record IDs for score ties", () => {
    const source = record({ id: "source", content: { text: "Checkpoint lifecycle" }, tags: [] });
    const first = record({ id: "candidate-a", content: { text: "Checkpoint lifecycle flow" }, tags: [] });
    const second = record({ id: "candidate-b", content: { text: "Checkpoint lifecycle flow" }, tags: [] });

    expect(
      retrieveSemanticConsolidationCandidates([source, second, first], {
        source_record_ids: [source.id]
      }).candidates.map((candidate) => candidate.record_id)
    ).toEqual([first.id, second.id]);
  });

  it("bounds per-source and total candidate counts without mutating records", () => {
    const sources = [
      record({ id: "source-a" }),
      record({ id: "source-b", content: { text: "Push memory on agent finish" } }),
      record({ id: "source-c", content: { text: "Restore after compaction" } })
    ];
    const targets = Array.from({ length: 30 }, (_, index) =>
      record({
        id: `candidate-${String(index).padStart(2, "0")}`,
        content: { text: index % 2 === 0 ? "Pull memory on agent enter" : "Push memory on agent finish" }
      })
    );
    const records = [...sources, ...targets];
    const before = JSON.stringify(records);

    const result = retrieveSemanticConsolidationCandidates(records, {
      source_record_ids: sources.map((source) => source.id),
      per_source_limit: 8,
      total_limit: 24
    });

    expect(result.candidates).toHaveLength(24);
    expect(Object.values(result.candidates_by_source_record_id).every((items) => items.length <= 8)).toBe(true);
    expect(JSON.stringify(records)).toBe(before);
    expect(result.selection_sources).toMatchObject({
      candidate: "candidates_by_source_record_id.<source_record_id>[]",
      score: "candidates_by_source_record_id.<source_record_id>[].score"
    });
  });
});

describe("discoverSemanticConsolidationCandidates", () => {
  it("discovers each compatible pair once across the current project working set", () => {
    const records = [
      record({ id: "newest", updated_at: "2026-07-12T00:00:00.000Z" }),
      record({ id: "middle", content: { text: "Pull project memory when an agent enters" } }),
      record({ id: "oldest", content: { text: "Agent startup pulls project memory context" } }),
      record({ id: "other-project", project_id: "other" })
    ];

    const result = discoverSemanticConsolidationCandidates(records, {
      project_id: "moryn",
      include_global: false,
      minimum_token_overlap: 0.2
    });

    expect(result.inspected_source_record_count).toBe(3);
    expect(result.candidate_pairs).toHaveLength(3);
    expect(
      new Set(
        result.candidate_pairs.map((candidate) => [candidate.source_record_id, candidate.record_id].sort().join(":"))
      ).size
    ).toBe(3);
    expect(result.selection_sources.candidate).toBe("candidate_pairs[]");
  });

  it("keeps private records out by default and reports bounded deterministic results", () => {
    const records = [
      record({ id: "public-a" }),
      record({ id: "public-b" }),
      record({ id: "public-c" }),
      record({ id: "private-a", content: { text: "Pull memory on agent enter", privacy: "private" } }),
      record({ id: "private-b", content: { text: "Pull memory on agent enter", privacy: "private" } })
    ];
    const before = JSON.stringify(records);
    const first = discoverSemanticConsolidationCandidates(records, { project_id: "moryn", limit: 2 });
    const second = discoverSemanticConsolidationCandidates([...records].reverse(), { project_id: "moryn", limit: 2 });

    expect(first.omitted_private_record_count).toBe(2);
    expect(first.candidate_pairs).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(second.candidate_pairs).toEqual(first.candidate_pairs);
    expect(JSON.stringify(records)).toBe(before);
  });

  it("validates discovery bounds", () => {
    expect(() => discoverSemanticConsolidationCandidates([], { limit: 0 })).toThrow("limit");
    expect(() => discoverSemanticConsolidationCandidates([], { minimum_token_overlap: 1.1 })).toThrow(
      "minimum_token_overlap"
    );
    expect(() => discoverSemanticConsolidationCandidates([], { project_id: " " })).toThrow("project_id");
  });
});
