import { describe, expect, it } from "vitest";
import { type EpisodeRollupIdentity, planEpisodeRollup, planEpisodeRollups } from "../../src/core/episode-rollup.js";
import type { MorynRecord } from "../../src/core/types.js";

interface RollupInput {
  id: string;
  closed_at?: string;
  updated_at?: string;
  leafs?: Array<{ record_id: string; digest: string }>;
  text?: string;
  decisions?: string[];
  blockers?: string[];
  task_id?: string;
  project_epoch_id?: string;
  tags?: string[];
  state?: MorynRecord["state"];
  visibility?: MorynRecord["visibility"];
  priority?: MorynRecord["priority"];
  conflict?: MorynRecord["conflict"];
  links?: MorynRecord["links"];
  claims?: unknown;
  layer?: string;
  type?: string;
  source_digest?: string;
}

const POLICY = { now: "2026-07-20T12:00:00.000Z", recent_window_days: 7 };

function leaf(recordId: string, character: string): { record_id: string; digest: string } {
  return { record_id: recordId, digest: character.repeat(64) };
}

function rollup(input: RollupInput): MorynRecord {
  const leafs = input.leafs ?? [leaf(`leaf-${input.id}`, "a")];
  const updatedAt = input.updated_at ?? input.closed_at ?? "2026-07-10T12:00:00.000Z";
  return {
    id: input.id,
    kind: "session_summary",
    type: input.type ?? "session_rollup",
    scope: "project",
    project_id: "moryn",
    tags: input.tags ?? ["session-fold"],
    content: {
      text: input.text ?? `Summary for ${input.id}`,
      format: "json",
      session_fold_version: 1,
      ...(input.closed_at === undefined ? {} : { closed_at: input.closed_at }),
      source_record_ids: leafs.map((item) => item.record_id),
      source_digests: leafs,
      decisions: input.decisions ?? [],
      blockers: input.blockers ?? [],
      next_steps: [],
      changed_facts: [],
      important_files: [],
      ...(input.task_id ? { task_id: input.task_id } : {}),
      ...(input.project_epoch_id ? { project_epoch_id: input.project_epoch_id } : {}),
      ...(input.claims === undefined ? {} : { claims: input.claims }),
      ...(input.layer ? { memory_retention: { version: 2, layer: input.layer } } : {}),
      ...(input.source_digest ? { source_digest: input.source_digest } : {})
    },
    state: input.state ?? "candidate",
    confidence: 0.9,
    priority: input.priority ?? "normal",
    visibility: input.visibility ?? "active",
    created_at: updatedAt,
    updated_at: updatedAt,
    source: { client: "codex", session_id: `session-${input.id}`, device_id: "device-a" },
    provenance: { derived_from: leafs.map((item) => item.record_id), method: "rule-promoted" },
    conflict: input.conflict,
    links: input.links
  };
}

function dayIdentity(day: string): EpisodeRollupIdentity {
  return { project_id: "moryn", bucket_kind: "day", bucket_key: day };
}

describe("Episode Rollup planning", () => {
  it("builds a deterministic day golden plan with lineage-backed claims and only old covered sources cold", () => {
    const sharedDecision = "Keep leaf evidence authoritative";
    const records = [
      rollup({
        id: "session-a",
        closed_at: "2026-07-10T10:00:00.000Z",
        leafs: [leaf("event-a", "a"), leaf("checkpoint-a", "b")],
        text: "Implemented Episode Rollup",
        decisions: [sharedDecision]
      }),
      rollup({
        id: "session-b",
        closed_at: "2026-07-10T18:00:00.000Z",
        leafs: [leaf("event-b", "c")],
        text: "Verified Episode Rollup",
        decisions: [sharedDecision]
      }),
      rollup({ id: "session-unfinished", updated_at: "2026-07-10T20:00:00.000Z" }),
      {
        ...rollup({ id: "not-a-rollup", closed_at: "2026-07-10T21:00:00.000Z" }),
        type: "summary",
        content: { text: "Plain session summary", format: "text" as const }
      },
      {
        ...rollup({ id: "already-cold", closed_at: "2026-07-10T08:00:00.000Z" }),
        state: "archived" as const,
        visibility: "archived" as const
      }
    ];

    const first = planEpisodeRollup(records, dayIdentity("2026-07-10"), POLICY);
    const reordered = planEpisodeRollup([...records].reverse(), dayIdentity("2026-07-10"), POLICY);

    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      version: 1,
      plan_id: expect.stringMatching(/^episode_rollup_[a-f0-9]{32}$/u),
      identity: dayIdentity("2026-07-10"),
      policy: POLICY,
      status: "ready",
      auto_rollup: true,
      privacy_boundary: "public",
      source_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      observation_digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      source_record_ids: ["session-a", "session-b"],
      review_reasons: [],
      deferred_reasons: [],
      coverage: {
        total_source_rollups: 2,
        covered_source_rollups: 2,
        coverage_ratio: 1,
        source_leaf_evidence: 3,
        covered_leaf_evidence: 3,
        output_claims: 3,
        claims_with_leaf_evidence: 3,
        cold_source_rollups: 2,
        preserved_warm_rollups: 1
      }
    });
    expect(first?.cold_candidates).toEqual([
      {
        record_id: "session-a",
        closed_at: "2026-07-10T10:00:00.000Z",
        reason: "old_and_fully_covered"
      },
      {
        record_id: "session-b",
        closed_at: "2026-07-10T18:00:00.000Z",
        reason: "old_and_fully_covered"
      }
    ]);
    expect(first?.warm_candidates).toEqual([
      {
        record_id: "session-unfinished",
        reason: "unfinished",
        digest: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    ]);
    const shared = first?.claims.find((claim) => claim.text === sharedDecision);
    expect(shared).toEqual({
      claim_id: expect.stringMatching(/^episode_claim_[a-f0-9]{32}$/u),
      kind: "decision",
      text: sharedDecision,
      source_rollup_ids: ["session-a", "session-b"],
      source_claim_ids: [expect.any(String), expect.any(String)],
      leaf_evidence: [leaf("checkpoint-a", "b"), leaf("event-a", "a"), leaf("event-b", "c")]
    });
    expect(first?.rollup_record).toMatchObject({
      id: `rec_${first.plan_id}`,
      type: "episode_rollup",
      state: "candidate",
      visibility: "active",
      content: {
        episode_rollup_version: 1,
        episode_rollup_plan_id: first.plan_id,
        bucket: dayIdentity("2026-07-10"),
        source_rollup_ids: ["session-a", "session-b"],
        claims: first.claims,
        leaf_evidence: first.leaf_evidence,
        memory_retention: {
          layer: "L1",
          retention: { tier: "warm" },
          lineage: {
            derived_from: ["session-a", "session-b"],
            covered_record_ids: ["session-a", "session-b"],
            coverage_verified: true,
            compression_level: 2
          }
        }
      },
      provenance: { derived_from: ["session-a", "session-b"] }
    });
  });

  it("flattens explicit claim lineage to leaves and deduplicates without summarizing a summary", () => {
    const leafA = leaf("raw-event-a", "d");
    const leafB = leaf("raw-event-b", "e");
    const claim = (claimId: string, evidence: unknown[]) => ({
      claim_id: claimId,
      kind: "changed_fact",
      text: "The durable format is append-only",
      source_rollup_ids: ["an-older-rollup-that-must-not-become-a-leaf"],
      leaf_evidence: evidence
    });
    const records = [
      rollup({
        id: "session-a",
        closed_at: "2026-07-09T10:00:00.000Z",
        leafs: [leafA],
        claims: [claim("claim-a", [leafA])]
      }),
      rollup({
        id: "session-b",
        closed_at: "2026-07-09T11:00:00.000Z",
        leafs: [leafB],
        claims: [claim("claim-b", [leafB])]
      })
    ];

    const plan = planEpisodeRollup(records, dayIdentity("2026-07-09"), POLICY)!;
    expect(plan.status).toBe("ready");
    expect(plan.claims).toEqual([
      {
        claim_id: expect.stringMatching(/^episode_claim_[a-f0-9]{32}$/u),
        kind: "changed_fact",
        text: "The durable format is append-only",
        source_rollup_ids: ["session-a", "session-b"],
        source_claim_ids: ["claim-a", "claim-b"],
        leaf_evidence: [leafA, leafB]
      }
    ]);
    expect(plan.leaf_evidence).toEqual([leafA, leafB]);
    expect(JSON.stringify(plan.rollup_record)).not.toContain("an-older-rollup-that-must-not-become-a-leaf");
  });

  it("keeps recent and unfinished rollups warm and defers a current-day automatic bucket", () => {
    const records = [
      rollup({ id: "recent", closed_at: "2026-07-20T08:00:00.000Z" }),
      rollup({ id: "unfinished", updated_at: "2026-07-20T09:00:00.000Z" })
    ];
    const plan = planEpisodeRollup(records, dayIdentity("2026-07-20"), POLICY)!;

    expect(plan).toMatchObject({ status: "deferred", auto_rollup: false, cold_candidates: [] });
    expect(plan.deferred_reasons.map((reason) => reason.code)).toEqual([
      "recent_sources_preserved",
      "bucket_not_closed"
    ]);
    expect(plan.warm_candidates).toEqual([
      {
        record_id: "recent",
        reason: "recent",
        digest: expect.any(String),
        closed_at: "2026-07-20T08:00:00.000Z"
      },
      { record_id: "unfinished", reason: "unfinished", digest: expect.any(String) }
    ]);
  });

  it("requires review across privacy, conflict, quarantine, protected, missing-lineage, and incomplete coverage gates", () => {
    const completeA = leaf("complete-a", "1");
    const completeB = leaf("complete-b", "2");
    const records = [
      rollup({ id: "public", closed_at: "2026-07-08T01:00:00.000Z" }),
      rollup({ id: "private", closed_at: "2026-07-08T02:00:00.000Z", tags: ["private"] }),
      rollup({
        id: "conflicted",
        closed_at: "2026-07-08T03:00:00.000Z",
        conflict: { kind: "semantic", with: ["public"], resolution: "needs_review" }
      }),
      rollup({
        id: "quarantined",
        closed_at: "2026-07-08T04:00:00.000Z",
        state: "quarantined",
        visibility: "quarantined"
      }),
      rollup({ id: "protected", closed_at: "2026-07-08T05:00:00.000Z", priority: "high" }),
      rollup({ id: "missing", closed_at: "2026-07-08T06:00:00.000Z", leafs: [] }),
      rollup({
        id: "incomplete",
        closed_at: "2026-07-08T07:00:00.000Z",
        leafs: [completeA, completeB],
        claims: [
          {
            claim_id: "only-half-covered",
            kind: "decision",
            text: "Only one leaf is mapped",
            leaf_evidence: [completeA]
          }
        ]
      }),
      rollup({ id: "wrong-layer", closed_at: "2026-07-08T08:00:00.000Z", layer: "L2" }),
      rollup({
        id: "digest-mismatch",
        closed_at: "2026-07-08T09:00:00.000Z",
        source_digest: "0".repeat(64)
      })
    ];

    const plan = planEpisodeRollup(records, dayIdentity("2026-07-08"), POLICY)!;
    expect(plan.status).toBe("review_required");
    expect(plan.auto_rollup).toBe(false);
    expect(plan.cold_candidates).toEqual([]);
    expect(plan.rollup_record).toBeUndefined();
    expect(plan.review_reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        "not_l1_session_rollup",
        "missing_lineage",
        "lineage_digest_mismatch",
        "incomplete_coverage",
        "unresolved_conflict",
        "quarantined_source",
        "unique_protected_information",
        "mixed_privacy_boundary"
      ])
    );
    expect(plan.warm_candidates).toHaveLength(records.length);
  });

  it("detects leaf digest and source claim identity conflicts", () => {
    const records = [
      rollup({
        id: "session-a",
        closed_at: "2026-07-07T01:00:00.000Z",
        leafs: [leaf("same-leaf", "a")],
        claims: [
          {
            claim_id: "same-claim",
            kind: "decision",
            text: "Use A",
            leaf_evidence: [leaf("same-leaf", "a")]
          }
        ]
      }),
      rollup({
        id: "session-b",
        closed_at: "2026-07-07T02:00:00.000Z",
        leafs: [leaf("same-leaf", "b")],
        claims: [
          {
            claim_id: "same-claim",
            kind: "decision",
            text: "Use B",
            leaf_evidence: [leaf("same-leaf", "b")]
          }
        ]
      })
    ];
    const plan = planEpisodeRollup(records, dayIdentity("2026-07-07"), POLICY)!;
    expect(plan.review_reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(["claim_identity_conflict", "leaf_digest_conflict"])
    );
  });

  it("accepts a structurally equivalent L1 session rollup with verified retention lineage", () => {
    const source = rollup({
      id: "equivalent-session",
      closed_at: "2026-07-04T01:00:00.000Z",
      leafs: [leaf("raw-equivalent", "f")]
    });
    const equivalent: MorynRecord = {
      ...source,
      type: "derived_session",
      content: {
        text: "Equivalent verified session",
        format: "json",
        rollup_kind: "session",
        session_rollup_version: 1,
        closed_at: "2026-07-04T01:00:00.000Z",
        decisions: ["Use portable L1 lineage"],
        memory_retention: {
          version: 2,
          layer: "L1",
          lineage: {
            derived_from: ["raw-equivalent"],
            source_digests: { "raw-equivalent": "f".repeat(64) },
            coverage_verified: true
          }
        }
      }
    };

    const plan = planEpisodeRollup([equivalent], dayIdentity("2026-07-04"), POLICY)!;
    expect(plan).toMatchObject({
      status: "ready",
      source_record_ids: ["equivalent-session"],
      leaf_evidence: [leaf("raw-equivalent", "f")],
      review_reasons: []
    });
    expect(plan.claims.every((claim) => claim.leaf_evidence.length > 0)).toBe(true);
  });

  it("supports task and project_epoch buckets while reserving automatic execution for day plans", () => {
    const records = [
      rollup({
        id: "session-a",
        closed_at: "2026-07-05T01:00:00.000Z",
        task_id: "ship-v0.4",
        project_epoch_id: "v0.4"
      }),
      rollup({
        id: "session-b",
        closed_at: "2026-07-06T01:00:00.000Z",
        task_id: "ship-v0.4",
        project_epoch_id: "v0.4"
      })
    ];

    const taskPlans = planEpisodeRollups(records, { ...POLICY, bucket_kind: "task" });
    const epochPlans = planEpisodeRollups(records, { ...POLICY, bucket_kind: "project_epoch" });
    expect(taskPlans).toHaveLength(1);
    expect(taskPlans[0]).toMatchObject({
      identity: { project_id: "moryn", bucket_kind: "task", bucket_key: "ship-v0.4" },
      status: "ready",
      auto_rollup: false,
      source_record_ids: ["session-a", "session-b"]
    });
    expect(epochPlans[0]).toMatchObject({
      identity: { project_id: "moryn", bucket_kind: "project_epoch", bucket_key: "v0.4" },
      status: "ready",
      auto_rollup: false
    });
  });
});
