import { describe, expect, it } from "vitest";
import {
  expandMemorySources,
  MEMORY_EXPANSION_SELECTION_SOURCES,
  memoryRecordDigest
} from "../../src/core/memory-expansion.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(id: string, overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: id },
    state: "candidate",
    confidence: 0.7,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    source: { client: "codex", session_id: "session-a" },
    ...overrides
  };
}

describe("memory source expansion", () => {
  it("expands a rollup to digest-verified cold source evidence", () => {
    const activeSource = record("rec-source", {
      kind: "session_summary",
      type: "status"
    });
    const source = {
      ...activeSource,
      state: "archived",
      visibility: "archived",
      updated_at: "2026-07-01T00:00:01.000Z"
    } satisfies MorynRecord;
    const root = record("rec-rollup", {
      kind: "session_summary",
      type: "session_rollup",
      content: {
        text: "rollup",
        source_record_ids: [source.id],
        source_digests: [
          {
            record_id: source.id,
            updated_at: activeSource.updated_at,
            digest: memoryRecordDigest(activeSource)
          }
        ]
      }
    });

    const result = expandMemorySources({ records: [source, root], record_id: root.id });
    expect(result).toMatchObject({
      status: "complete",
      root_record_id: root.id,
      stats: { returned_records: 2, returned_source_records: 1, verified_edges: 1, mismatched_edges: 0 },
      selection_sources: MEMORY_EXPANSION_SELECTION_SOURCES
    });
    expect(result.records_by_id[source.id]).toMatchObject({ depth: 1, tier: "cold", path: [root.id, source.id] });
    expect(result.edges).toEqual([
      expect.objectContaining({
        from_record_id: root.id,
        to_record_id: source.id,
        relation: "covered_record",
        verification: "verified",
        verification_basis: "pre_archive_projection"
      })
    ]);
  });

  it("returns tampered evidence with an explicit digest mismatch", () => {
    const original = record("rec-source");
    const root = record("rec-rollup", {
      content: {
        text: "rollup",
        source_record_ids: [original.id],
        source_digests: [{ record_id: original.id, digest: memoryRecordDigest(original) }]
      }
    });
    const tampered = { ...original, content: { text: "changed" } };
    const result = expandMemorySources({ records: [root, tampered], record_id: root.id });

    expect(result.status).toBe("partial");
    expect(result.stats).toMatchObject({ mismatched_edges: 1, returned_records: 2 });
    expect(result.edges[0]).toMatchObject({ verification: "mismatch" });
  });

  it("keeps private leaf payloads behind an explicit boundary", () => {
    const privateLeaf = record("rec-private", { tags: ["private"], content: { text: "do not expose" } });
    const root = record("rec-episode", {
      kind: "session_summary",
      type: "episode_rollup",
      content: {
        text: "episode",
        leaf_evidence: [{ record_id: privateLeaf.id, digest: memoryRecordDigest(privateLeaf) }]
      }
    });

    const hidden = expandMemorySources({ records: [root, privateLeaf], record_id: root.id });
    expect(hidden.records.map((entry) => entry.record.id)).toEqual([root.id]);
    expect(hidden.omissions).toEqual([
      { from_record_id: root.id, record_id: privateLeaf.id, reason: "private_boundary" }
    ]);
    expect(JSON.stringify(hidden.records)).not.toContain("do not expose");

    const visible = expandMemorySources({
      records: [root, privateLeaf],
      record_id: root.id,
      include_private: true
    });
    expect(visible.records_by_id[privateLeaf.id]?.private).toBe(true);
  });

  it("is cycle-safe and bounds depth and record count", () => {
    const leaf = record("rec-leaf");
    const middle = record("rec-middle", { provenance: { derived_from: [leaf.id] } });
    const root = record("rec-root", { provenance: { derived_from: [middle.id] } });
    leaf.provenance = { derived_from: [root.id] };

    const depthBound = expandMemorySources({ records: [root, middle, leaf], record_id: root.id, max_depth: 1 });
    expect(depthBound.records.map((entry) => entry.record.id)).toEqual([root.id, middle.id]);
    expect(depthBound.omissions).toContainEqual({
      from_record_id: middle.id,
      record_id: leaf.id,
      reason: "depth_limit"
    });

    const cycle = expandMemorySources({ records: [root, middle, leaf], record_id: root.id, max_depth: 4 });
    expect(cycle.records).toHaveLength(3);
    expect(cycle.omissions).toContainEqual({ from_record_id: leaf.id, record_id: root.id, reason: "cycle" });

    const recordBound = expandMemorySources({ records: [root, middle, leaf], record_id: root.id, max_records: 1 });
    expect(recordBound.records).toHaveLength(1);
    expect(recordBound.omissions[0]?.reason).toBe("record_limit");
  });

  it("requires explicit private access when the requested root itself is private", () => {
    const root = record("rec-private-root", { tags: ["private"] });
    expect(() => expandMemorySources({ records: [root], record_id: root.id })).toThrow(
      "Private memory expansion requires include_private"
    );
  });
});
