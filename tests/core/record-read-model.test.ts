import { describe, expect, it } from "vitest";
import {
  buildRecordReadModel,
  DEFAULT_MEMORY_WORKING_SET_OPTIONS,
  estimateMemoryRecordTokens,
  eventManifest,
  selectMemoryWorkingSet
} from "../../src/core/record-read-model.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";

function record(id: string): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: id, format: "text" },
    state: "canonical",
    confidence: 1,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    source: { client: "test" }
  };
}

function event(eventId: string, value: MorynRecord, createdAt = "2026-07-12T00:00:00.000Z"): MorynEvent {
  return { event_id: eventId, op: "upsert_record", record: value, created_at: createdAt, source: { client: "test" } };
}

describe("record read model", () => {
  it("builds deterministic manifests independent of input order", () => {
    const first = event("evt-b", record("rec-b"));
    const second = event("evt-a", record("rec-a"));
    expect(eventManifest([first, second])).toEqual(eventManifest([second, first]));
    expect(eventManifest([first, second])).toMatchObject({ count: 2, digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("stores complete records in deterministic order", () => {
    const first = record("rec-b");
    const second = record("rec-a");
    second.links = [{ record_id: first.id, link_type: "duplicate_of", created_at: "2026-07-12T00:01:00.000Z" }];
    const model = buildRecordReadModel(
      [event("evt-b", first), event("evt-a", second)],
      [first, second],
      eventManifest([event("evt-b", first), event("evt-a", second)])
    );
    expect(model).toMatchObject({
      version: 1,
      generated_at: "2026-07-12T00:00:00.000Z",
      records: [{ id: "rec-a", links: second.links }, { id: "rec-b" }]
    });
  });

  it("selects hot and warm records without truncating the authoritative read model", () => {
    const identity = {
      ...record("identity"),
      kind: "soul" as const,
      type: "principle",
      scope: "global" as const,
      project_id: undefined,
      content: { text: "Be concise" }
    };
    const semantic = { ...record("semantic"), type: "decision", content: { text: "Use SQLite" } };
    const episodic = {
      ...record("episodic"),
      kind: "session_summary" as const,
      type: "summary",
      state: "candidate" as const,
      content: { text: "Session summary" }
    };
    const evidence = {
      ...record("evidence"),
      kind: "agent_note" as const,
      type: "observation",
      state: "raw" as const,
      content: { text: "trace" }
    };
    const cold = {
      ...record("cold"),
      state: "candidate" as const,
      content: { text: "old fact", memory_retention: { version: 2, retention: { tier: "cold" } } }
    };
    const purged = {
      ...evidence,
      id: "purged",
      content: { text: "trace", memory_retention: { version: 2, retention: { tier: "purged" } } }
    };

    const full = buildRecordReadModel([], [cold, evidence, identity, purged, semantic, episodic], {
      count: 0,
      digest: "a".repeat(64)
    });
    const selected = selectMemoryWorkingSet(full.records);

    expect(full.records).toHaveLength(6);
    expect(selected.selected.map((entry) => entry.record.id)).toEqual(["identity", "semantic", "episodic", "evidence"]);
    expect(selected.excluded.map((entry) => [entry.record.id, entry.reason])).toEqual([
      ["cold", "cold_tier"],
      ["purged", "purged_tier"]
    ]);
    expect(selected.counts).toMatchObject({
      total_records: 6,
      selected_records: 4,
      excluded_records: 2,
      selected_layers: { L0: 1, L1: 1, L2: 1, L3: 1 },
      exclusion_reasons: { cold_tier: 1, purged_tier: 1, layer_limit: 0 }
    });
  });

  it("supports explicit history inclusion and deterministic per-layer budgets", () => {
    const older = {
      ...record("older"),
      type: "decision",
      updated_at: "2026-07-10T00:00:00.000Z",
      content: {
        text: "older",
        memory_retention: { version: 2, usage: { recall_count: 8, useful_count: 4 } }
      }
    };
    const newer = {
      ...record("newer"),
      type: "decision",
      updated_at: "2026-07-13T00:00:00.000Z",
      content: {
        text: "newer",
        memory_retention: { version: 2, usage: { recall_count: 2, useful_count: 2 } }
      }
    };
    const archived = {
      ...record("archived"),
      type: "decision",
      state: "archived" as const,
      visibility: "archived" as const
    };

    const left = selectMemoryWorkingSet([newer, archived, older], {
      include_archived: true,
      layer_limits: { L2: 2 }
    });
    const right = selectMemoryWorkingSet([older, newer, archived], {
      include_cold: true,
      layer_limits: { L2: 2 }
    });

    expect(left).toEqual(right);
    expect(left.selected.map((entry) => entry.record.id)).toEqual(["older", "newer"]);
    expect(left.excluded.map((entry) => [entry.record.id, entry.reason])).toEqual([["archived", "layer_limit"]]);
  });

  it("enforces a deterministic primary token budget in L3 to L0 order", () => {
    const identity: MorynRecord = {
      ...record("identity"),
      kind: "soul",
      type: "principle",
      scope: "global",
      project_id: undefined,
      content: { text: "identity" }
    };
    const semantic: MorynRecord = { ...record("semantic"), type: "decision", content: { text: "semantic" } };
    const episodic: MorynRecord = {
      ...record("episodic"),
      kind: "session_summary",
      type: "summary",
      state: "candidate",
      content: { text: "episodic" }
    };
    const evidence: MorynRecord = {
      ...record("evidence"),
      kind: "agent_note",
      type: "observation",
      state: "raw",
      content: { text: "evidence" }
    };
    const budget = estimateMemoryRecordTokens(identity) + estimateMemoryRecordTokens(semantic);

    const left = selectMemoryWorkingSet([evidence, episodic, semantic, identity], {
      total_token_budget: budget
    });
    const right = selectMemoryWorkingSet([identity, semantic, episodic, evidence], {
      total_token_budget: budget
    });

    expect(left).toEqual(right);
    expect(left.selected.map((entry) => entry.record.id)).toEqual(["identity", "semantic"]);
    expect(left.excluded.map((entry) => [entry.record.id, entry.reason])).toEqual([
      ["episodic", "total_token_budget"],
      ["evidence", "total_token_budget"]
    ]);
    expect(left.tokens).toMatchObject({
      selected_estimated_tokens: budget,
      selected_by_layer: {
        L0: 0,
        L1: 0,
        L2: estimateMemoryRecordTokens(semantic),
        L3: estimateMemoryRecordTokens(identity)
      },
      budgets: { total_token_budget: budget, layer_token_budgets: {} },
      overflow: { total_tokens: 0, mandatory_record_ids: [], pinned_record_ids: [] }
    });
    expect(left.tokens.total_estimated_tokens).toBe(
      left.tokens.selected_estimated_tokens + left.tokens.omitted_estimated_tokens
    );
  });

  it("applies per-layer token budgets after stable usage ranking", () => {
    const preferred: MorynRecord = {
      ...record("preferred"),
      type: "decision",
      content: {
        text: "preferred",
        memory_retention: { version: 2, usage: { recall_count: 8, useful_count: 6 } }
      }
    };
    const other: MorynRecord = {
      ...record("other"),
      type: "decision",
      content: {
        text: "other",
        memory_retention: { version: 2, usage: { recall_count: 2, useful_count: 1 } }
      }
    };
    const budget = estimateMemoryRecordTokens(preferred);

    const selected = selectMemoryWorkingSet([other, preferred], { layer_token_budgets: { L2: budget } });

    expect(selected.selected.map((entry) => entry.record.id)).toEqual(["preferred"]);
    expect(selected.excluded.map((entry) => [entry.record.id, entry.reason])).toEqual([
      ["other", "layer_token_budget"]
    ]);
    expect(selected.tokens).toMatchObject({
      selected_by_layer: { L2: budget },
      budgets: { layer_token_budgets: { L2: budget } },
      overflow: { by_layer: { L2: 0 } }
    });
  });

  it("keeps high-priority memory first under the default active-context policy", () => {
    const important = {
      ...record("important"),
      priority: "high" as const,
      content: { text: "important" }
    };
    const ordinary = {
      ...record("ordinary"),
      updated_at: "2026-07-20T23:59:59.000Z",
      content: { text: "ordinary" }
    };
    const selected = selectMemoryWorkingSet([ordinary, important], {
      ...DEFAULT_MEMORY_WORKING_SET_OPTIONS,
      total_token_budget: estimateMemoryRecordTokens(important),
      layer_token_budgets: {}
    });

    expect(selected.selected.map((entry) => entry.record.id)).toEqual(["important"]);
    expect(selected.excluded.map((entry) => [entry.record.id, entry.reason])).toEqual([
      ["ordinary", "total_token_budget"]
    ]);
  });

  it("keeps mandatory identity and pinned records while reporting unavoidable token overflow", () => {
    const identity: MorynRecord = {
      ...record("identity"),
      kind: "soul",
      type: "principle",
      scope: "global",
      project_id: undefined,
      content: { text: "identity contract" }
    };
    const pinned: MorynRecord = {
      ...record("pinned"),
      type: "decision",
      content: { text: "pinned", memory_retention: { version: 2, retention: { pinned: true } } }
    };
    const ordinary: MorynRecord = { ...record("ordinary"), type: "decision", content: { text: "ordinary" } };

    const selected = selectMemoryWorkingSet([ordinary, pinned, identity], {
      total_token_budget: 1,
      layer_token_budgets: { L2: 1, L3: 1 }
    });

    expect(selected.selected.map((entry) => entry.record.id)).toEqual(["identity", "pinned"]);
    expect(selected.excluded.map((entry) => [entry.record.id, entry.reason])).toEqual([
      ["ordinary", "layer_token_budget"]
    ]);
    expect(selected.tokens.overflow).toEqual({
      total_tokens: estimateMemoryRecordTokens(identity) + estimateMemoryRecordTokens(pinned) - 1,
      by_layer: {
        L0: 0,
        L1: 0,
        L2: estimateMemoryRecordTokens(pinned) - 1,
        L3: estimateMemoryRecordTokens(identity) - 1
      },
      mandatory_record_ids: ["identity", "pinned"],
      pinned_record_ids: ["pinned"]
    });
  });

  it("estimates canonical records independently of object key order", () => {
    const left = record("stable");
    const right = { ...left, content: { format: "text", text: "stable" } };
    expect(estimateMemoryRecordTokens(left)).toBe(estimateMemoryRecordTokens(right));
  });
});
