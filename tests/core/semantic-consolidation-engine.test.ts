import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("engine.consolidateSemanticProposals", () => {
  async function fixtures(storePath: string) {
    let nextId = 0;
    const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
    const base = { kind: "memory", type: "decision", scope: "project", project_id: "moryn", source: { client: "codex" } } as const;
    const target = await engine.write({ ...base, content: { text: "Pull memories on agent enter." }, state: "canonical", confirmed: true });
    const source = await engine.write({ ...base, content: { text: "Agents pull memory when entering." }, state: "candidate" });
    return { engine, source: source.record, target: target.record };
  }

  function proposal(sourceId: string, targetId: string) {
    return {
      proposal_id: "proposal-1",
      source_record_id: sourceId,
      target_record_id: targetId,
      relationship: "duplicate_of" as const,
      confidence: 0.99,
      rationale: "Equivalent lifecycle behavior.",
      semantic_equivalence: "equivalent" as const,
      material_differences: [],
      evidence_record_ids: []
    };
  }

  it("persists accepted proposals and replays idempotently", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { engine, source, target } = await fixtures(storePath);
      const input = { proposals: [proposal(source.id, target.id)], project_id: "moryn", source: { client: "codex", session_id: "session-a" } };
      const first = await engine.consolidateSemanticProposals(input);
      const replay = await engine.consolidateSemanticProposals(input);
      const links = (await readEvents(storePath)).filter((event) => event.op === "link_records" && event.link_type === "duplicate_of");

      expect(first).toMatchObject({ proposals_received: 1, proposals_accepted: 1, proposals_rejected: 0, links_created: 1, idempotent_replays: 0, accepted_by_relationship: { duplicate_of: 1 } });
      expect(replay).toMatchObject({ proposals_received: 1, proposals_accepted: 0, proposals_rejected: 0, links_created: 0, idempotent_replays: 1 });
      expect(first.proposal_results[0]).toMatchObject({ status: "accepted", reason: "accepted", event_id: expect.stringMatching(/^evt_semantic_consolidation_/) });
      expect(links).toHaveLength(1);
    });
  });

  it("rejects unsafe proposals without appending relationship events", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { engine, source, target } = await fixtures(storePath);
      const before = await readEvents(storePath);
      const receipt = await engine.consolidateSemanticProposals({
        proposals: [{ ...proposal(source.id, target.id), confidence: 0.5 }],
        project_id: "moryn",
        source: { client: "codex" }
      });

      expect(receipt).toMatchObject({ proposals_received: 1, proposals_accepted: 0, proposals_rejected: 1, links_created: 0, rejected_by_reason: { below_confidence_threshold: 1 } });
      expect(await readEvents(storePath)).toHaveLength(before.length);
    });
  });

  it("creates at most one relationship across concurrent agents", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { source, target } = await fixtures(storePath);
      const codex = createEngine({ storePath });
      const claude = createEngine({ storePath });
      const results = await Promise.all([
        codex.consolidateSemanticProposals({ proposals: [proposal(source.id, target.id)], project_id: "moryn", source: { client: "codex" } }),
        claude.consolidateSemanticProposals({ proposals: [proposal(source.id, target.id)], project_id: "moryn", source: { client: "claude-code" } })
      ]);
      const links = (await readEvents(storePath)).filter((event) => event.op === "link_records" && event.link_type === "duplicate_of");
      expect(results.reduce((count, receipt) => count + receipt.links_created, 0)).toBe(1);
      expect(results.reduce((count, receipt) => count + receipt.idempotent_replays, 0)).toBe(1);
      expect(links).toHaveLength(1);
    });
  });

  it("returns safe failure receipts without changing records", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { source, target } = await fixtures(storePath);
      const before = await readEvents(storePath);
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async () => { throw new Error("disk unavailable"); }
      });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [proposal(source.id, target.id)], project_id: "moryn", source: { client: "codex" } });
      expect(receipt).toMatchObject({ proposals_received: 1, proposals_accepted: 0, proposals_rejected: 1, links_created: 0, rejected_by_reason: { persistence_failed: 1 } });
      expect(receipt.proposal_results[0]).toMatchObject({ status: "failed", reason: "persistence_failed" });
      expect(JSON.stringify(receipt)).not.toContain("disk unavailable");
      expect(await readEvents(storePath)).toEqual(before);
    });
  });

  it("does not expose private record text in authorized receipts", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const base = { kind: "memory", type: "preference", scope: "global", tags: ["private"], source: { client: "codex" } } as const;
      const target = await engine.write({ ...base, content: { text: "Private preference uses local sync" }, state: "canonical", confirmed: true });
      const source = await engine.write({ ...base, content: { text: "Private preference uses local sync" } });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [proposal(source.record.id, target.record.id)], include_private: true, source: { client: "codex" } });
      expect(receipt.links_created).toBe(1);
      expect(JSON.stringify(receipt)).not.toContain("Private preference uses local sync");
    });
  });
});
