import { describe, expect, it } from "vitest";
import { evaluateSyncGate } from "../../src/core/sync-gate.js";
import type { MorynEvent, MorynRecord } from "../../src/core/types.js";

const CREATED_AT = "2026-08-18T00:00:00.000Z";
const SOURCE = { client: "test", device_id: "device_test" };

function record(
  id: string,
  content: Record<string, unknown>,
  options: Partial<Pick<MorynRecord, "tags" | "state">> = {}
): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: options.tags ?? [],
    content,
    state: options.state ?? "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    source: SOURCE
  };
}

function upsert(item: MorynRecord, suffix = item.id): MorynEvent {
  return {
    event_id: `evt_${suffix}`,
    op: "upsert_record",
    record: item,
    created_at: CREATED_AT,
    source: SOURCE
  };
}

describe("sync gate", () => {
  it("keeps the personal Git path backward compatible while identifying local-only payloads", () => {
    const ordinary = upsert(record("rec_ordinary", { text: "ordinary project memory" }));
    const privateRecord = upsert(record("rec_private", { text: "private project memory" }, { tags: ["private"] }));
    const localOnly = upsert(record("rec_local", { text: "local workspace note", distribution: "local_only" }));

    const result = evaluateSyncGate({ events: [ordinary, privateRecord, localOnly] });

    expect(result).toMatchObject({
      mode: "shadow",
      enforced: false,
      destination: "personal_sync",
      decision: "deny",
      would_block: true,
      summary: {
        total_events: 3,
        allowed_events: 2,
        review_required_events: 0,
        denied_events: 1
      }
    });
    expect(result.findings).toEqual([
      expect.objectContaining({
        event_id: localOnly.event_id,
        code: "local_only_distribution",
        decision: "deny",
        content_included: false
      })
    ]);
  });

  it("requires explicit authorization for team and public destinations", () => {
    const unspecified = upsert(record("rec_unspecified", { text: "no distribution" }));
    const team = upsert(record("rec_team", { text: "team decision", distribution: "trusted_team" }));
    const publicCandidate = upsert(
      record(
        "rec_public_candidate",
        { text: "draft public note", distribution: "public_export" },
        { state: "candidate" }
      )
    );

    const teamResult = evaluateSyncGate({ events: [unspecified, team], destination: "trusted_team" });
    expect(teamResult.decision).toBe("review_required");
    expect(teamResult.summary).toMatchObject({ allowed_events: 1, review_required_events: 1, denied_events: 0 });
    expect(teamResult.findings[0]?.code).toBe("distribution_unspecified");

    const publicResult = evaluateSyncGate({ events: [publicCandidate], destination: "public_export" });
    expect(publicResult).toMatchObject({ decision: "deny", would_block: true });
    expect(publicResult.findings[0]?.code).toBe("noncanonical_public_export");
  });

  it("returns content-free findings for sensitive payloads", () => {
    const secret = "api_key=abcdefghijklmnop";
    const result = evaluateSyncGate({ events: [upsert(record("rec_secret", { text: secret }))] });

    expect(result.findings[0]).toMatchObject({ code: "sensitive_content", content_included: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("produces a stable receipt for the same event set regardless of input order", () => {
    const first = upsert(record("rec_a", { text: "A" }), "a");
    const second = {
      ...upsert(record("rec_b", { text: "B" }), "b"),
      created_at: "2026-08-18T00:00:01.000Z"
    };

    const forward = evaluateSyncGate({ events: [first, second] });
    const reverse = evaluateSyncGate({ events: [second, first] });

    expect(reverse.evidence_digest).toBe(forward.evidence_digest);
    expect(reverse.receipt_id).toBe(forward.receipt_id);
  });
});
