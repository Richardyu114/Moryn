import { describe, expect, it } from "vitest";
import { selectPriorSessionForFinalization } from "../../src/core/finalization-assurance.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(input: Partial<MorynRecord> & Pick<MorynRecord, "id" | "type" | "updated_at">): MorynRecord {
  return {
    id: input.id,
    kind: input.kind ?? "session_summary",
    type: input.type,
    scope: input.scope ?? "project",
    project_id: input.project_id ?? "moryn",
    tags: input.tags ?? [],
    content: input.content ?? { text: input.id },
    state: input.state ?? "candidate",
    confidence: input.confidence ?? 0.8,
    priority: input.priority ?? "normal",
    visibility: input.visibility ?? "active",
    created_at: input.created_at ?? input.updated_at,
    updated_at: input.updated_at,
    source: input.source ?? { client: "codex", session_id: "prior", device_id: "device-a" },
    provenance: input.provenance ?? { method: "agent-proposed" }
  };
}

const incoming = { project_id: "moryn", host: "codex", session_id: "current", device_id: "device-a" } as const;

describe("finalization assurance selection", () => {
  it("selects the latest prior session with durable status or checkpoint evidence", () => {
    const result = selectPriorSessionForFinalization([
      record({ id: "old", type: "status", updated_at: "2026-07-13T00:01:00.000Z", source: { client: "codex", session_id: "old", device_id: "device-a" } }),
      record({ id: "checkpoint", type: "checkpoint", updated_at: "2026-07-13T00:05:00.000Z" }),
      record({ id: "status", type: "status", updated_at: "2026-07-13T00:06:00.000Z" })
    ], incoming);

    expect(result).toEqual({
      status: "eligible",
      prior_session: { host: "codex", session_id: "prior", device_id: "device-a" },
      latest_evidence_at: "2026-07-13T00:06:00.000Z",
      evidence_record_ids: ["checkpoint", "status"],
      recovery_key: expect.stringMatching(/^finalize_[a-f0-9]{32}$/)
    });
  });

  it("excludes the incoming session, other host/device/project, and noise-only records", () => {
    const result = selectPriorSessionForFinalization([
      record({ id: "current", type: "checkpoint", updated_at: "2026-07-13T00:09:00.000Z", source: { client: "codex", session_id: "current", device_id: "device-a" } }),
      record({ id: "claude", type: "status", updated_at: "2026-07-13T00:08:00.000Z", source: { client: "claude", session_id: "claude-old", device_id: "device-a" } }),
      record({ id: "other-device", type: "status", updated_at: "2026-07-13T00:07:00.000Z", source: { client: "codex", session_id: "device-old", device_id: "device-b" } }),
      record({ id: "other-project", type: "status", project_id: "other", updated_at: "2026-07-13T00:06:00.000Z" }),
      record({ id: "receipt", kind: "agent_note", type: "activation_receipt", updated_at: "2026-07-13T00:05:00.000Z" })
    ], incoming);

    expect(result).toEqual({ status: "nothing_to_finalize" });
  });

  it("reports a normally finished prior session instead of recovering it", () => {
    const result = selectPriorSessionForFinalization([
      record({ id: "status", type: "status", updated_at: "2026-07-13T00:05:00.000Z" }),
      record({ id: "summary", type: "summary", updated_at: "2026-07-13T00:06:00.000Z" })
    ], incoming);

    expect(result).toEqual({
      status: "already_finalized",
      prior_session: { host: "codex", session_id: "prior", device_id: "device-a" },
      final_record_id: "summary",
      evidence_record_ids: ["status"]
    });
  });

  it("treats evidence newer than an earlier summary as eligible and keeps identity deterministic", () => {
    const records = [
      record({ id: "summary", type: "summary", updated_at: "2026-07-13T00:04:00.000Z" }),
      record({ id: "status", type: "status", updated_at: "2026-07-13T00:05:00.000Z" })
    ];
    const first = selectPriorSessionForFinalization(records, incoming);
    const second = selectPriorSessionForFinalization([...records].reverse(), incoming);

    expect(first).toMatchObject({ status: "eligible", evidence_record_ids: ["status"] });
    expect(second).toEqual(first);
  });

  it("treats a cross-host synthesized handoff covering the checkpoint as finalized", () => {
    const result = selectPriorSessionForFinalization([
      record({ id: "checkpoint", type: "checkpoint", updated_at: "2026-07-13T00:05:00.000Z" }),
      record({ id: "claude-summary", type: "summary", updated_at: "2026-07-13T00:06:00.000Z", source: { client: "claude", session_id: "handoff", device_id: "device-b" }, content: { text: "Cross-host handoff", synthesis_source_record_ids: ["checkpoint"] } })
    ], incoming);

    expect(result).toEqual({ status: "already_finalized", prior_session: { host: "codex", session_id: "prior", device_id: "device-a" }, final_record_id: "claude-summary", evidence_record_ids: ["checkpoint"] });
  });
});
