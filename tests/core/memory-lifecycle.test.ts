import { describe, expect, it } from "vitest";
import { diagnoseMemoryLifecycle } from "../../src/core/memory-lifecycle.js";
import type { MorynRecord } from "../../src/core/types.js";

const NOW = "2026-07-20T00:00:00.000Z";

function record(id: string, overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "decision",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: "ordinary fact" },
    state: "candidate",
    confidence: 0.2,
    priority: "normal",
    visibility: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    source: { client: "test" },
    ...overrides
  };
}

describe("memory lifecycle retention v2 integration", () => {
  it.each([
    ["private tag", { tags: ["private"] }],
    ["content privacy", { content: { text: "private", privacy: "private" } }],
    ["local-only distribution", { content: { text: "local", distribution: "local_only" } }]
  ] as const)("fails closed for %s in direct planner calls", (_label, overrides) => {
    const privateRecord = record("private-direct", overrides);

    const result = diagnoseMemoryLifecycle({ records: [privateRecord], now: NOW });

    expect(result.stats).toMatchObject({ total_records: 0, excluded_private_records: 1 });
    expect(result.assessments).toEqual([]);
    expect(result.suggested_actions).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(privateRecord.id);

    const included = diagnoseMemoryLifecycle({ records: [privateRecord], now: NOW, include_private: true });
    expect(included.assessments_by_record_id[privateRecord.id]).toMatchObject({
      lifecycle_state: "private_retained",
      recommended_action: "keep"
    });
    expect(included.suggested_actions_by_id[`recall:${privateRecord.id}`]?.arguments).toMatchObject({
      record_ids: [privateRecord.id],
      include_private: true
    });
  });

  it("treats explicit private record ids as a fail-closed boundary", () => {
    const externallyPrivate = record("external-private");

    const result = diagnoseMemoryLifecycle({
      records: [externallyPrivate],
      private_record_ids: [externallyPrivate.id],
      now: NOW
    });

    expect(result.stats).toMatchObject({ total_records: 0, excluded_private_records: 1 });
    expect(JSON.stringify(result)).not.toContain(externallyPrivate.id);
  });

  it("keeps cold and purged records outside the working set without repeated archive advice", () => {
    const cold = record("cold", {
      content: { text: "ordinary fact", memory_retention: { version: 2, retention: { tier: "cold" } } }
    });
    const purged = record("purged", {
      kind: "agent_note",
      type: "observation",
      state: "raw",
      content: { text: "trace", memory_retention: { version: 2, retention: { tier: "purged" } } }
    });

    const result = diagnoseMemoryLifecycle({ records: [purged, cold], now: NOW });

    expect(result.stats).toMatchObject({
      total_records: 2,
      retained_records: 2,
      stale_records: 0,
      archive_candidate_records: 0,
      layers: { L0: 1, L2: 1 },
      tiers: { cold: 1, purged: 1 }
    });
    expect(result.assessments_by_record_id.cold).toMatchObject({
      lifecycle_state: "retained",
      recommended_action: "keep",
      memory_layer: "L2",
      retention_tier: "cold",
      reasons: ["retention_tier_cold_outside_working_set"]
    });
    expect(result.assessments_by_record_id.purged).toMatchObject({
      lifecycle_state: "retained",
      recommended_action: "keep",
      memory_layer: "L0",
      retention_tier: "purged",
      reasons: ["retention_tier_purged_outside_working_set"]
    });
    expect(result.findings).toEqual([]);
    expect(result.suggested_actions).toEqual([]);
  });

  it("retains identity and pinned memory while routing protected stale records to inspection", () => {
    const identity = record("identity", {
      kind: "soul",
      type: "principle",
      scope: "global",
      project_id: undefined,
      content: { text: "Be concise" }
    });
    const pinned = record("pinned", {
      content: { text: "ordinary fact", memory_retention: { version: 2, retention: { pinned: true } } }
    });
    const protectedRule = record("protected", {
      type: "deployment_rule",
      content: { text: "ordinary fact" }
    });

    const result = diagnoseMemoryLifecycle({ records: [protectedRule, pinned, identity], now: NOW });

    expect(result.assessments_by_record_id.identity).toMatchObject({
      lifecycle_state: "retained",
      recommended_action: "keep",
      memory_layer: "L3",
      retention_safety: { never_forget: true, automatic_archive_safe: false }
    });
    expect(result.assessments_by_record_id.pinned).toMatchObject({
      lifecycle_state: "retained",
      recommended_action: "keep",
      retention_safety: { pinned: true, automatic_archive_safe: false }
    });
    expect(result.assessments_by_record_id.protected).toMatchObject({
      lifecycle_state: "stale",
      recommended_action: "inspect_timeline",
      reasons: expect.arrayContaining(["automatic_archive_blocked_by_retention_safety"]),
      retention_safety: {
        protected_type: true,
        automatic_archive_safe: false,
        archive_blockers: expect.arrayContaining(["protected_type"])
      }
    });
    expect(result.findings_by_id.archive_candidates).toBeUndefined();
    expect(result.suggested_actions_by_id["archive:protected"]).toBeUndefined();
    expect(result.suggested_actions_by_id["inspect:protected"]).toBeDefined();
  });

  it("surfaces validity and retention-window expiry without silently deleting memory", () => {
    const stale = record("stale", {
      updated_at: "2026-07-10T00:00:00.000Z",
      content: {
        text: "ordinary fact",
        memory_retention: {
          version: 2,
          policy: { retain_until: "2026-07-15T00:00:00.000Z" },
          validity: {
            stale_at: "2026-07-12T00:00:00.000Z",
            valid_until: "2026-07-19T00:00:00.000Z"
          }
        }
      }
    });

    const result = diagnoseMemoryLifecycle({ records: [stale], now: NOW });
    expect(result.assessments_by_record_id.stale).toMatchObject({
      lifecycle_state: "retained",
      recommended_action: "keep",
      validity_status: "expired",
      reasons: expect.arrayContaining(["validity_expired", "retention_window_elapsed", "recent_or_retained_by_default"])
    });
    expect(result.stats.validity_statuses).toEqual({ expired: 1 });
  });
});
