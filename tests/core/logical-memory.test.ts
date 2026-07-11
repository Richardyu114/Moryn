import { describe, expect, it } from "vitest";
import { logicalMemoryFingerprint, validateLogicalRelationship } from "../../src/core/logical-memory.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "rec-a",
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "project-a",
    tags: [],
    content: { text: "Use append-only events" },
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

const relationshipTypes = ["duplicate_of", "supports", "revises", "supersedes", "conflicts_with"] as const;

describe("logical memory relationships", () => {
  it.each(relationshipTypes)("normalizes compatible %s links", (relationship) => {
    const source = record();
    const target = record({ id: "rec-b", content: { text: "Keep an append-only event log" } });

    expect(validateLogicalRelationship([source, target], {
      record_id: source.id,
      linked_record_id: target.id,
      relationship,
      reason: " Agent proposed consolidation "
    })).toEqual({
      record: source,
      linked_record: target,
      relationship,
      direction: relationship === "conflicts_with" ? "symmetric" : "directed",
      reason: "Agent proposed consolidation"
    });
  });

  it("rejects self links and unknown relationships", () => {
    const source = record();
    expect(() => validateLogicalRelationship([source], {
      record_id: source.id,
      linked_record_id: source.id,
      relationship: "duplicate_of",
      reason: "same"
    })).toThrow("logical memory records must be different");
    expect(() => validateLogicalRelationship([source, record({ id: "rec-b" })], {
      record_id: source.id,
      linked_record_id: "rec-b",
      relationship: "similar_to" as never,
      reason: "same"
    })).toThrow("unsupported logical relationship");
  });

  it.each([
    ["kind", record({ id: "rec-b", kind: "skill" })],
    ["type", record({ id: "rec-b", type: "warning" })],
    ["scope", record({ id: "rec-b", scope: "global", project_id: undefined })],
    ["project", record({ id: "rec-b", project_id: "project-b" })]
  ])("rejects incompatible %s", (_label, target) => {
    const source = record();
    expect(() => validateLogicalRelationship([source, target], {
      record_id: source.id,
      linked_record_id: target.id,
      relationship: "supports",
      reason: "incompatible"
    })).toThrow("incompatible logical memory records");
  });

  it("rejects missing, archived, and quarantined records for new links", () => {
    const source = record();
    expect(() => validateLogicalRelationship([source], {
      record_id: source.id,
      linked_record_id: "missing",
      relationship: "supports",
      reason: "missing"
    })).toThrow("Logical memory record not found: missing");
    for (const target of [
      record({ id: "rec-b", state: "archived", visibility: "archived" }),
      record({ id: "rec-b", state: "quarantined", visibility: "quarantined" })
    ]) {
      expect(() => validateLogicalRelationship([source, target], {
        record_id: source.id,
        linked_record_id: target.id,
        relationship: "supports",
        reason: "inactive"
      })).toThrow("logical memory records must be active");
    }
  });

  it("requires a non-empty authored reason", () => {
    const source = record();
    const target = record({ id: "rec-b" });
    expect(() => validateLogicalRelationship([source, target], {
      record_id: source.id,
      linked_record_id: target.id,
      relationship: "supports",
      reason: " "
    })).toThrow("logical relationship reason must be a non-empty string");
  });
});

describe("logical memory fingerprints", () => {
  it("ignores event identity and mutable lifecycle metadata", () => {
    const first = record({
      id: "rec-a",
      state: "raw",
      confidence: 0.4,
      priority: "low",
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
      source: { client: "codex", session_id: "session-a" },
      provenance: { reason: "first capture", method: "agent-proposed" },
      links: [{ record_id: "rec-c", link_type: "supports", created_at: "2026-07-10T00:00:00.000Z" }]
    });
    const second = record({
      id: "rec-b",
      state: "canonical",
      confidence: 0.99,
      priority: "high",
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:00:00.000Z",
      source: { client: "claude-code", session_id: "session-b" },
      provenance: { reason: "confirmed later", method: "user-confirmed" }
    });

    expect(logicalMemoryFingerprint(first)).toBe(logicalMemoryFingerprint(second));
  });

  it("normalizes text whitespace, tag order, and JSON object key order", () => {
    const first = record({
      tags: ["storage", "architecture"],
      content: {
        text: "  Use   append-only\n events  ",
        format: "json",
        detail: { durable: true, order: ["write", "sync"] }
      }
    });
    const second = record({
      tags: ["architecture", "storage", "storage"],
      content: {
        detail: { order: ["write", "sync"], durable: true },
        format: "json",
        text: "Use append-only events"
      }
    });

    expect(logicalMemoryFingerprint(first)).toBe(logicalMemoryFingerprint(second));
  });

  it.each([
    ["kind", { kind: "skill" }],
    ["type", { type: "warning" }],
    ["scope", { scope: "global", project_id: undefined }],
    ["project", { project_id: "project-b" }],
    ["tags", { tags: ["different"] }],
    ["content", { content: { text: "Use mutable snapshots" } }]
  ] as const)("changes when logical %s changes", (_label, overrides) => {
    expect(logicalMemoryFingerprint(record())).not.toBe(
      logicalMemoryFingerprint(record(overrides as Partial<MorynRecord>))
    );
  });
});

describe("active logical memory view", () => {
  it("hides duplicate sources and superseded or revised targets", async () => {
    const { buildActiveLogicalMemoryView } = await import("../../src/core/logical-memory.js");
    const duplicate = record({ id: "duplicate", links: [{ record_id: "canonical", link_type: "duplicate_of", created_at: "2026-07-11T00:00:00.000Z" }] });
    const canonical = record({ id: "canonical" });
    const replacement = record({ id: "replacement", links: [{ record_id: "old", link_type: "supersedes", created_at: "2026-07-11T00:00:00.000Z" }] });
    const old = record({ id: "old" });
    const revision = record({ id: "revision", links: [{ record_id: "draft", link_type: "revises", created_at: "2026-07-11T00:00:00.000Z" }] });
    const draft = record({ id: "draft" });
    const view = buildActiveLogicalMemoryView([duplicate, canonical, replacement, old, revision, draft]);
    expect(view.active_records.map((item) => item.id).sort()).toEqual(["canonical", "replacement", "revision"]);
    expect(view.hidden_by_record_id).toMatchObject({ duplicate: { relationship: "duplicate_of", active_record_id: "canonical" }, old: { relationship: "supersedes", active_record_id: "replacement" }, draft: { relationship: "revises", active_record_id: "revision" } });
  });

  it("keeps conflicts and supports visible", async () => {
    const { buildActiveLogicalMemoryView } = await import("../../src/core/logical-memory.js");
    const first = record({ id: "first", links: [{ record_id: "second", link_type: "conflicts_with", created_at: "2026-07-11T00:00:00.000Z" }] });
    const second = record({ id: "second", links: [{ record_id: "third", link_type: "supports", created_at: "2026-07-11T00:00:00.000Z" }] });
    const third = record({ id: "third" });
    const view = buildActiveLogicalMemoryView([first, second, third]);
    expect(view.active_records).toHaveLength(3);
    expect(view.conflict_record_ids).toEqual(["first", "second"]);
  });

  it("keeps cyclic logical replacements visible and reports them", async () => {
    const { buildActiveLogicalMemoryView } = await import("../../src/core/logical-memory.js");
    const first = record({ id: "first", links: [{ record_id: "second", link_type: "supersedes", created_at: "2026-07-11T00:00:00.000Z" }] });
    const second = record({ id: "second", links: [{ record_id: "first", link_type: "supersedes", created_at: "2026-07-11T00:00:00.000Z" }] });
    const view = buildActiveLogicalMemoryView([first, second]);
    expect(view.active_records.map((item) => item.id).sort()).toEqual(["first", "second"]);
    expect(view.findings).toContainEqual(expect.objectContaining({ code: "LOGICAL_RELATIONSHIP_CYCLE", record_ids: ["first", "second"] }));
  });
});
