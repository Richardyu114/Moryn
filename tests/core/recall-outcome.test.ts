import { describe, expect, it } from "vitest";
import { assessRecallOutcome, queryTokenCoverage } from "../../src/core/recall-outcome.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id: "rec-a",
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: "Moryn pulls on agent enter and pushes on agent finish" },
    state: "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-11T00:00:00.000Z",
    updated_at: "2026-07-11T00:00:00.000Z",
    source: { client: "codex" },
    provenance: { method: "rule-promoted" },
    ...overrides
  };
}

describe("query token coverage", () => {
  it("measures distinct meaningful query tokens", () => {
    expect(queryTokenCoverage("when does moryn pull push", record())).toEqual({
      matched_tokens: ["moryn", "pull", "push"],
      query_tokens: ["when", "does", "moryn", "pull", "push"],
      coverage: 0.6
    });
  });

  it("matches shared terms in an unspaced Chinese query", () => {
    const chinesePreference = record({
      content: {
        text: "用户经常在手机上查看和操作。修改 Notion 文章时，应默认直接写入 Notion 子页并回传链接。"
      }
    });

    const match = queryTokenCoverage("手机上看Notion时应该怎么处理", chinesePreference);

    expect(match.query_tokens).toEqual(expect.arrayContaining(["手", "机", "上", "看", "notion", "时", "应"]));
    expect(match.matched_tokens).toEqual(expect.arrayContaining(["手", "机", "上", "看", "notion", "时", "应"]));
    expect(match.coverage).toBeGreaterThanOrEqual(0.5);
    expect(
      assessRecallOutcome({
        query: "手机上看Notion时应该怎么处理",
        results: [{ record: chinesePreference, score: 20, reason: [] }]
      }).status
    ).toBe("verification_required");
  });

  it("does not trust scattered single-character CJK overlap", () => {
    const unrelated = record({
      content: { text: "参数已记录，依据明确，仓库稳定，迁徙完成，移动端可用。" }
    });

    expect(queryTokenCoverage("数据库迁移", unrelated)).toMatchObject({
      matched_tokens: ["数", "据", "库", "迁", "移"],
      query_tokens: ["数", "据", "库", "迁", "移"],
      coverage: 1
    });
    expect(
      assessRecallOutcome({
        query: "数据库迁移",
        results: [{ record: unrelated, score: 20, reason: [] }]
      }).status
    ).toBe("knowledge_gap");
  });

  it("prefers an anchored CJK match over higher scattered-character coverage", () => {
    const relevant = record({
      id: "rec-relevant",
      content: { text: "用户经常在手机上查看和操作。修改 Notion 文章时，应默认直接写入子页。" }
    });
    const scattered = record({
      id: "rec-scattered",
      content: { text: "手册；机器；上层；看法；时间；响应；该项；怎样；这么；处置；理由。" }
    });

    expect(
      assessRecallOutcome({
        query: "手机上看Notion时应该怎么处理",
        results: [
          { record: scattered, score: 100, reason: [] },
          { record: relevant, score: 10, reason: [] }
        ]
      })
    ).toMatchObject({ best_record_id: relevant.id, status: "verification_required" });
  });

  it("bounds the number of query tokens", () => {
    const longQuery = Array.from({ length: 600 }, (_value, index) => String.fromCodePoint(0x4e00 + index)).join("");

    expect(queryTokenCoverage(longQuery, record()).query_tokens).toHaveLength(128);
  });
});

describe("recall outcomes", () => {
  it("returns a trusted match for relevant trusted current knowledge", () => {
    expect(
      assessRecallOutcome({
        query: "moryn pull push",
        now: "2026-07-11T01:00:00.000Z",
        results: [{ record: record(), score: 25, reason: [] }]
      })
    ).toMatchObject({
      status: "trusted_match",
      best_record_id: "rec-a",
      coverage: 1,
      trust: "trusted",
      recommended_action: "use_recalled_knowledge"
    });
  });

  it("prefers equally relevant trusted knowledge over a higher-scoring unverified summary", () => {
    const trusted = record({ id: "rec-trusted" });
    const unverifiedSummary = record({
      id: "rec-summary",
      kind: "session_summary",
      state: "candidate",
      confidence: 0.7,
      provenance: { method: "agent-proposed" }
    });

    expect(
      assessRecallOutcome({
        query: "moryn pull push",
        now: "2026-07-11T01:00:00.000Z",
        results: [
          { record: unverifiedSummary, score: 100, reason: [] },
          { record: trusted, score: 10, reason: [] }
        ]
      })
    ).toMatchObject({
      status: "trusted_match",
      best_record_id: trusted.id,
      trust: "trusted"
    });
  });

  it.each([
    ["candidate", record({ state: "candidate", confidence: 0.6, provenance: { method: "agent-proposed" } })],
    ["stale", record({ content: { text: "Moryn pulls on enter", valid_until: "2026-07-10T00:00:00.000Z" } })],
    ["partial", record({ content: { text: "Moryn pulls on enter" } })]
  ])("requires verification for %s matches", (_label, candidate) => {
    expect(
      assessRecallOutcome({
        query: "moryn pull push",
        now: "2026-07-11T01:00:00.000Z",
        results: [{ record: candidate, score: 12, reason: [] }]
      })
    ).toMatchObject({
      status: "verification_required",
      recommended_action: "verify_then_use_or_learn"
    });
  });

  it.each([
    [
      "v2 validity expiry",
      record({
        content: {
          text: "Moryn pulls on agent enter and pushes on agent finish",
          memory_retention: {
            version: 2,
            validity: { valid_until: "2026-07-11T01:00:00.000Z" }
          }
        }
      })
    ],
    [
      "v2 staleness",
      record({
        content: {
          text: "Moryn pulls on agent enter and pushes on agent finish",
          memory_retention: {
            version: 2,
            validity: {
              stale_at: "2026-07-10T00:00:00.000Z",
              valid_until: "2026-07-20T00:00:00.000Z"
            }
          }
        }
      })
    ],
    [
      "legacy validity expiry",
      record({
        content: {
          text: "Moryn pulls on agent enter and pushes on agent finish",
          valid_until: "2026-07-10T00:00:00.000Z"
        }
      })
    ]
  ])("marks %s as stale for recall", (_label, candidate) => {
    expect(
      assessRecallOutcome({
        query: "moryn pull push",
        now: "2026-07-11T01:00:00.000Z",
        results: [{ record: candidate, score: 12, reason: [] }]
      })
    ).toMatchObject({
      status: "verification_required",
      stale: true,
      recommended_action: "verify_then_use_or_learn"
    });
  });

  it("uses v2 validity in preference to an expired legacy field", () => {
    const candidate = record({
      content: {
        text: "Moryn pulls on agent enter and pushes on agent finish",
        valid_until: "2026-07-10T00:00:00.000Z",
        memory_retention: {
          version: 2,
          validity: { valid_until: "2026-07-20T00:00:00.000Z" }
        }
      }
    });

    expect(
      assessRecallOutcome({
        query: "moryn pull push",
        now: "2026-07-11T01:00:00.000Z",
        results: [{ record: candidate, score: 12, reason: [] }]
      })
    ).toMatchObject({ status: "trusted_match", stale: false });
  });

  it("returns an explicit knowledge gap for absent or incidental matches", () => {
    expect(assessRecallOutcome({ query: "database migration policy", results: [] })).toEqual({
      status: "knowledge_gap",
      best_record_id: undefined,
      best_score: 0,
      coverage: 0,
      trust: "none",
      stale: false,
      recommended_action: "explore_then_capture_learning"
    });
    expect(
      assessRecallOutcome({
        query: "database migration policy",
        results: [{ record: record({ content: { text: "Moryn database" } }), score: 9, reason: [] }]
      }).status
    ).toBe("knowledge_gap");
  });
});
