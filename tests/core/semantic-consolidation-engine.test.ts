import { describe, expect, it } from "vitest";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { createEngine } from "../../src/core/engine.js";
import { buildActiveLogicalMemoryView } from "../../src/core/logical-memory.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { readRetrievalCandidates } from "../../src/core/retrieval-index.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("engine.consolidateSemanticProposals", () => {
  async function fixtures(storePath: string) {
    let nextId = 0;
    const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
    const base = {
      kind: "memory",
      type: "decision",
      scope: "project",
      project_id: "moryn",
      source: { client: "codex" }
    } as const;
    const target = await engine.write({
      ...base,
      content: { text: "Pull memories on agent enter." },
      state: "canonical",
      confirmed: true
    });
    const source = await engine.write({
      ...base,
      content: { text: "Agents pull memory when entering." },
      state: "candidate"
    });
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

  async function structuredFixtures(storePath: string) {
    let nextId = 0;
    let tick = 0;
    const engine = createEngine({
      storePath,
      id: (prefix) => `${prefix}_structured_${++nextId}`,
      now: () => new Date(Date.parse("2026-07-20T00:00:00.000Z") + tick++).toISOString()
    });
    const base = {
      kind: "memory",
      type: "decision",
      scope: "project",
      project_id: "moryn",
      source: { client: "codex" },
      state: "canonical",
      confirmed: true,
      confidence: 0.99
    } as const;
    const target = await engine.write({
      ...base,
      tags: ["legacy"],
      content: {
        text: "Historical runner note.",
        commands: ["npm test", "npm lint"],
        versions: ["v0.4"]
      }
    });
    const source = await engine.write({
      ...base,
      tags: ["current"],
      content: {
        text: "Build lifecycle knowledge.",
        commands: ["npm build", "npm test"],
        versions: ["v0.4.1"]
      }
    });
    const evidence = await engine.write({
      kind: "memory",
      type: "evidence",
      scope: "project",
      project_id: "moryn",
      content: { text: "The user verified the repository scripts." },
      source: { client: "user" },
      state: "canonical",
      confirmed: true
    });
    const mergeProposal = {
      proposal_id: "structured-engine-1",
      source_record_id: source.record.id,
      target_record_id: target.record.id,
      relationship: "revises" as const,
      confidence: 0.99,
      rationale: "Cumulative command and version lists are exact source-backed arrays.",
      semantic_equivalence: "refinement" as const,
      material_differences: [
        { field: "text", significance: "minor" as const },
        { field: "commands", significance: "minor" as const },
        { field: "versions", significance: "minor" as const }
      ],
      evidence_record_ids: [evidence.record.id],
      structured_merge: {
        version: 1 as const,
        requested_state: "canonical" as const,
        fields: [
          {
            field: "text",
            disposition: "replace" as const,
            source_record_id: source.record.id,
            replaced_source_record_ids: [target.record.id],
            evidence_record_ids: [evidence.record.id]
          },
          {
            field: "commands",
            disposition: "union" as const,
            source_record_ids: [source.record.id, target.record.id]
          },
          {
            field: "versions",
            disposition: "union" as const,
            source_record_ids: [target.record.id, source.record.id]
          }
        ]
      }
    };
    return { engine, source: source.record, target: target.record, evidence: evidence.record, mergeProposal };
  }

  function competingStructuredProposal(
    fixture: Awaited<ReturnType<typeof structuredFixtures>>,
    requestedState: "candidate" | "canonical"
  ) {
    const { mergeProposal, source, target, evidence } = fixture;
    return {
      ...mergeProposal,
      proposal_id: `structured-engine-competing-${requestedState}`,
      structured_merge: {
        ...mergeProposal.structured_merge,
        requested_state: requestedState,
        fields: [
          {
            field: "text",
            disposition: "replace" as const,
            source_record_id: source.id,
            replaced_source_record_ids: [target.id],
            evidence_record_ids: [evidence.id]
          },
          {
            field: "commands",
            disposition: "replace" as const,
            source_record_id: source.id,
            replaced_source_record_ids: [target.id],
            evidence_record_ids: [evidence.id]
          },
          mergeProposal.structured_merge.fields[2]!
        ]
      }
    };
  }

  function candidateStructuredProposal(fixture: Awaited<ReturnType<typeof structuredFixtures>>, proposalId: string) {
    return {
      ...fixture.mergeProposal,
      proposal_id: proposalId,
      structured_merge: { ...fixture.mergeProposal.structured_merge, requested_state: "candidate" as const }
    };
  }

  it("persists accepted proposals and replays idempotently", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { engine, source, target } = await fixtures(storePath);
      const input = {
        proposals: [proposal(source.id, target.id)],
        project_id: "moryn",
        source: { client: "codex", session_id: "session-a" }
      };
      const first = await engine.consolidateSemanticProposals(input);
      const replay = await engine.consolidateSemanticProposals(input);
      const links = (await readEvents(storePath)).filter(
        (event) => event.op === "link_records" && event.link_type === "duplicate_of"
      );

      expect(first).toMatchObject({
        proposals_received: 1,
        proposals_accepted: 1,
        proposals_rejected: 0,
        links_created: 1,
        idempotent_replays: 0,
        accepted_by_relationship: { duplicate_of: 1 }
      });
      expect(replay).toMatchObject({
        proposals_received: 1,
        proposals_accepted: 0,
        proposals_rejected: 0,
        links_created: 0,
        idempotent_replays: 1
      });
      expect(first.proposal_results[0]).toMatchObject({
        status: "accepted",
        reason: "accepted",
        event_id: expect.stringMatching(/^evt_semantic_consolidation_/)
      });
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

      expect(receipt).toMatchObject({
        proposals_received: 1,
        proposals_accepted: 0,
        proposals_rejected: 1,
        links_created: 0,
        rejected_by_reason: { below_confidence_threshold: 1 }
      });
      expect(await readEvents(storePath)).toHaveLength(before.length);
    });
  });

  it("creates at most one relationship across concurrent agents", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { source, target } = await fixtures(storePath);
      const codex = createEngine({ storePath });
      const claude = createEngine({ storePath });
      const results = await Promise.all([
        codex.consolidateSemanticProposals({
          proposals: [proposal(source.id, target.id)],
          project_id: "moryn",
          source: { client: "codex" }
        }),
        claude.consolidateSemanticProposals({
          proposals: [proposal(source.id, target.id)],
          project_id: "moryn",
          source: { client: "claude-code" }
        })
      ]);
      const links = (await readEvents(storePath)).filter(
        (event) => event.op === "link_records" && event.link_type === "duplicate_of"
      );
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
        appendEventIfAbsent: async () => {
          throw new Error("disk unavailable");
        }
      });
      const receipt = await engine.consolidateSemanticProposals({
        proposals: [proposal(source.id, target.id)],
        project_id: "moryn",
        source: { client: "codex" }
      });
      expect(receipt).toMatchObject({
        proposals_received: 1,
        proposals_accepted: 0,
        proposals_rejected: 1,
        links_created: 0,
        rejected_by_reason: { persistence_failed: 1 }
      });
      expect(receipt.proposal_results[0]).toMatchObject({ status: "failed", reason: "persistence_failed" });
      expect(JSON.stringify(receipt)).not.toContain("disk unavailable");
      expect(await readEvents(storePath)).toEqual(before);
    });
  });

  it("does not expose private record text in authorized receipts", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const base = {
        kind: "memory",
        type: "preference",
        scope: "global",
        tags: ["private"],
        source: { client: "codex" }
      } as const;
      const target = await engine.write({
        ...base,
        content: { text: "Private preference uses local sync" },
        state: "canonical",
        confirmed: true
      });
      const source = await engine.write({ ...base, content: { text: "Private preference uses local sync" } });
      const receipt = await engine.consolidateSemanticProposals({
        proposals: [proposal(source.record.id, target.record.id)],
        include_private: true,
        source: { client: "codex" }
      });
      expect(receipt.links_created).toBe(1);
      expect(JSON.stringify(receipt)).not.toContain("Private preference uses local sync");
    });
  });

  it("writes and reads back a canonical derived merge before hiding either source", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { engine, source, target, mergeProposal } = await structuredFixtures(storePath);
      const first = await engine.consolidateSemanticProposals({
        proposals: [mergeProposal],
        project_id: "moryn",
        source: { client: "codex" }
      });
      const replay = await engine.consolidateSemanticProposals({
        proposals: [mergeProposal],
        project_id: "moryn",
        source: { client: "claude-code" }
      });
      const result = first.proposal_results[0];
      expect(first).toMatchObject({
        proposals_accepted: 1,
        proposals_rejected: 0,
        links_created: 3,
        accepted_by_relationship: { revises: 1 }
      });
      expect(result).toMatchObject({
        status: "accepted",
        merged_record_id: expect.stringMatching(/^rec_semantic_merge_[a-f0-9]{32}$/),
        merged_record_state: "canonical",
        merged_record_persistence: "created",
        links_created: 3
      });
      expect(replay).toMatchObject({ proposals_accepted: 0, idempotent_replays: 1, links_created: 0 });
      expect(replay.proposal_results[0]).toMatchObject({
        merged_record_id: result?.merged_record_id,
        merged_record_state: "canonical",
        merged_record_persistence: "existing"
      });

      const records = (await readCurrentRecords(storePath)).records;
      const merged = records.find((record) => record.id === result?.merged_record_id);
      expect(merged).toMatchObject({
        state: "canonical",
        content: {
          commands: ["npm build", "npm lint", "npm test"],
          versions: ["v0.4", "v0.4.1"],
          structured_semantic_merge: {
            source_record_ids: [source.id, target.id].sort(),
            source_digests: {
              [source.id]: expect.stringMatching(/^[a-f0-9]{64}$/),
              [target.id]: expect.stringMatching(/^[a-f0-9]{64}$/)
            },
            field_lineage: expect.arrayContaining([
              expect.objectContaining({ field: "commands", disposition: "union" }),
              expect.objectContaining({ field: "versions", disposition: "union" })
            ])
          }
        }
      });
      const logical = buildActiveLogicalMemoryView(records);
      expect(logical.hidden_by_record_id[source.id]?.active_record_id).toBe(merged?.id);
      expect(logical.hidden_by_record_id[target.id]?.active_record_id).toBe(merged?.id);
      const expansion = await engine.expandMemorySources({ record_id: merged?.id });
      expect(expansion.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            to_record_id: source.id,
            verification: "verified",
            verification_basis: "structured_semantic_merge_v1"
          }),
          expect.objectContaining({
            to_record_id: target.id,
            verification: "verified",
            verification_basis: "structured_semantic_merge_v1"
          })
        ])
      );

      const events = await readEvents(storePath);
      const upsertIndex = events.findIndex((event) => event.op === "upsert_record" && event.record.id === merged?.id);
      const firstHideIndex = events.findIndex(
        (event) =>
          event.op === "link_records" &&
          event.link_type === "revises" &&
          (event.linked_record_id === source.id || event.linked_record_id === target.id)
      );
      expect(upsertIndex).toBeGreaterThanOrEqual(0);
      expect(firstHideIndex).toBeGreaterThan(upsertIndex);
      expect(JSON.stringify(first)).not.toContain("Build lifecycle knowledge");
    });
  });

  it("keeps a requested canonical merge as candidate when a source is not canonical", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_candidate_${++nextId}` });
      const base = {
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "The exact same source-backed fact." },
        source: { client: "codex" }
      } as const;
      const target = (await engine.write({ ...base, state: "canonical", confirmed: true })).record;
      const source = (await engine.write({ ...base, state: "candidate" })).record;
      const receipt = await engine.consolidateSemanticProposals({
        proposals: [
          {
            ...proposal(source.id, target.id),
            structured_merge: { version: 1, requested_state: "canonical", fields: [] }
          }
        ],
        project_id: "moryn"
      });
      expect(receipt.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_state: "candidate",
        merged_record_persistence: "created",
        links_created: 2
      });
      const records = (await readCurrentRecords(storePath)).records;
      const logical = buildActiveLogicalMemoryView(records);
      expect(logical.hidden_by_record_id[source.id]).toBeUndefined();
      expect(logical.hidden_by_record_id[target.id]).toBeUndefined();
    });
  });

  it("resumes after a canonical promotion and one source hide were persisted", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { source, target, mergeProposal } = await structuredFixtures(storePath);
      let hideAttempts = 0;
      const interrupted = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.event_id.startsWith("evt_structured_semantic_merge_hide_") && ++hideAttempts === 2) {
            throw new Error("simulated interruption");
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const partial = await interrupted.consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(partial.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "persistence_failed",
        merged_record_state: "canonical",
        merged_record_persistence: "created"
      });
      const during = buildActiveLogicalMemoryView((await readCurrentRecords(storePath)).records);
      expect(
        [during.hidden_by_record_id[source.id], during.hidden_by_record_id[target.id]].filter(Boolean)
      ).toHaveLength(1);

      const resumed = await createEngine({ storePath }).consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(resumed.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_state: "canonical",
        merged_record_persistence: "existing",
        links_created: 1
      });
      const after = buildActiveLogicalMemoryView((await readCurrentRecords(storePath)).records);
      expect(after.hidden_by_record_id[source.id]?.active_record_id).toBe(
        resumed.proposal_results[0]?.merged_record_id
      );
      expect(after.hidden_by_record_id[target.id]?.active_record_id).toBe(
        resumed.proposal_results[0]?.merged_record_id
      );
    });
  });

  it("keeps a claim-crashed provisional merge quarantined and resumes the same plan", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal } = await structuredFixtures(storePath);
      const interrupted = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.event_id.startsWith("evt_structured_semantic_merge_claim_")) {
            throw new Error("simulated claim crash");
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const partial = await interrupted.consolidateSemanticProposals({ proposals: [mergeProposal] });
      const partialResult = partial.proposal_results[0];
      expect(partialResult).toMatchObject({
        status: "failed",
        reason: "persistence_failed",
        merged_record_persistence: "created",
        links_created: 0
      });
      expect(partialResult).not.toHaveProperty("merged_record_state");

      const provisional = (await readCurrentRecords(storePath)).records.find(
        (record) => record.id === partialResult?.merged_record_id
      );
      expect(provisional).toMatchObject({ state: "quarantined", visibility: "quarantined" });
      await rebuildDerivedViews(storePath);
      expect(
        (await readRetrievalCandidates(storePath, { project_id: "moryn" })).records.some(
          (record) => record.id === provisional?.id
        )
      ).toBe(false);

      const resumed = await createEngine({ storePath }).consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(resumed.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_id: provisional?.id,
        merged_record_state: "canonical",
        merged_record_persistence: "existing",
        links_created: 3
      });
      const events = await readEvents(storePath);
      expect(
        events.filter((event) => event.op === "upsert_record" && event.record.id === provisional?.id)
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.event_id.startsWith("evt_structured_semantic_merge_activate_"))
      ).toHaveLength(1);
    });
  });

  it("creates one derived record and one relationship set across concurrent replays", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal } = await structuredFixtures(storePath);
      const [left, right] = await Promise.all([
        createEngine({ storePath }).consolidateSemanticProposals({ proposals: [mergeProposal] }),
        createEngine({ storePath }).consolidateSemanticProposals({ proposals: [mergeProposal] })
      ]);
      const results = [left.proposal_results[0], right.proposal_results[0]];
      expect(results.map((result) => result?.merged_record_persistence).sort()).toEqual(["created", "existing"]);
      expect(new Set(results.map((result) => result?.merged_record_id)).size).toBe(1);
      expect(left.links_created + right.links_created).toBe(3);
      const events = await readEvents(storePath);
      expect(
        events.filter((event) => event.op === "upsert_record" && event.record.id === results[0]?.merged_record_id)
      ).toHaveLength(1);
      expect(events.filter((event) => event.event_id.startsWith("evt_structured_semantic_merge_hide_"))).toHaveLength(
        2
      );
    });
  });

  it("rejects a sequential competing candidate plan before creating its derived record", async () => {
    await withInitializedTempStore(async (storePath) => {
      const fixture = await structuredFixtures(storePath);
      const winner = candidateStructuredProposal(fixture, "structured-engine-candidate-winner");
      const competing = competingStructuredProposal(fixture, "candidate");
      const engine = createEngine({ storePath });
      const accepted = await engine.consolidateSemanticProposals({ proposals: [winner] });
      const rejected = await engine.consolidateSemanticProposals({ proposals: [competing] });

      expect(accepted.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_state: "candidate",
        merged_record_persistence: "created",
        links_created: 2
      });
      expect(rejected.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "structured_merge_concurrent_conflict",
        links_created: 0
      });
      expect(rejected.proposal_results[0]).not.toHaveProperty("merged_record_persistence");
      const derived = (await readCurrentRecords(storePath)).records.filter((record) =>
        record.id.startsWith("rec_semantic_merge_")
      );
      expect(derived).toHaveLength(1);
      expect(derived[0]?.id).toBe(accepted.proposal_results[0]?.merged_record_id);
      expect(derived[0]?.state).toBe("candidate");
      expect(derived.some((record) => record.id === rejected.proposal_results[0]?.merged_record_id)).toBe(false);
    });
  });

  it("persists only one active candidate across concurrent competing field plans", async () => {
    await withInitializedTempStore(async (storePath) => {
      const fixture = await structuredFixtures(storePath);
      const leftProposal = candidateStructuredProposal(fixture, "structured-engine-candidate-left");
      const rightProposal = competingStructuredProposal(fixture, "candidate");
      const receipts = await Promise.all(
        [leftProposal, rightProposal].map((candidate) =>
          createEngine({ storePath }).consolidateSemanticProposals({ proposals: [candidate] })
        )
      );
      const results = receipts.map((receipt) => receipt.proposal_results[0]);
      const accepted = results.find((result) => result?.status === "accepted");
      const rejected = results.find((result) => result?.status === "failed");

      expect(accepted).toMatchObject({ merged_record_state: "candidate", links_created: 2 });
      expect(rejected).toMatchObject({ reason: "structured_merge_concurrent_conflict", links_created: 0 });
      expect(receipts.reduce((count, receipt) => count + receipt.links_created, 0)).toBe(2);
      const derived = (await readCurrentRecords(storePath)).records.filter((record) =>
        record.id.startsWith("rec_semantic_merge_")
      );
      expect(derived).toHaveLength(1);
      expect(derived[0]?.id).toBe(accepted?.merged_record_id);
      expect(derived[0]?.state).toBe("candidate");
      expect(
        (await readEvents(storePath)).filter((event) =>
          event.event_id.startsWith("evt_structured_semantic_merge_claim_")
        )
      ).toHaveLength(1);
    });
  });

  it("keeps a claim-crashed losing plan quarantined when a different candidate plan wins", async () => {
    await withInitializedTempStore(async (storePath) => {
      const fixture = await structuredFixtures(storePath);
      const crashedPlan = candidateStructuredProposal(fixture, "structured-engine-crashed-candidate");
      const winningPlan = competingStructuredProposal(fixture, "candidate");
      const interrupted = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.event_id.startsWith("evt_structured_semantic_merge_claim_")) {
            throw new Error("simulated claim crash");
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const crashed = await interrupted.consolidateSemanticProposals({ proposals: [crashedPlan] });
      const crashedId = crashed.proposal_results[0]?.merged_record_id;
      expect(crashed.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "persistence_failed",
        merged_record_persistence: "created"
      });

      const won = await createEngine({ storePath }).consolidateSemanticProposals({ proposals: [winningPlan] });
      const winnerId = won.proposal_results[0]?.merged_record_id;
      expect(won.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_state: "candidate",
        merged_record_persistence: "created",
        links_created: 2
      });
      expect(winnerId).not.toBe(crashedId);

      const retryLoser = await createEngine({ storePath }).consolidateSemanticProposals({ proposals: [crashedPlan] });
      expect(retryLoser.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "structured_merge_concurrent_conflict",
        links_created: 0
      });
      const derived = (await readCurrentRecords(storePath)).records.filter((record) =>
        record.id.startsWith("rec_semantic_merge_")
      );
      expect(derived).toHaveLength(2);
      expect(derived.filter((record) => record.visibility === "active")).toEqual([
        expect.objectContaining({ id: winnerId, state: "candidate" })
      ]);
      expect(derived.find((record) => record.id === crashedId)).toMatchObject({
        state: "quarantined",
        visibility: "quarantined"
      });
      await rebuildDerivedViews(storePath);
      const retrievalIds = (await readRetrievalCandidates(storePath, { project_id: "moryn" })).records.map(
        (record) => record.id
      );
      expect(retrievalIds).toContain(winnerId);
      expect(retrievalIds).not.toContain(crashedId);
    });
  });

  it("upgrades an activated candidate with a distinct deterministic canonical promotion", async () => {
    await withInitializedTempStore(async (storePath) => {
      const fixture = await structuredFixtures(storePath);
      const candidatePlan = candidateStructuredProposal(fixture, "structured-engine-later-canonical");
      const engine = createEngine({ storePath });
      const candidate = await engine.consolidateSemanticProposals({ proposals: [candidatePlan] });
      expect(candidate.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_state: "candidate",
        merged_record_persistence: "created",
        links_created: 2
      });

      const canonical = await engine.consolidateSemanticProposals({ proposals: [fixture.mergeProposal] });
      expect(canonical.proposal_results[0]).toMatchObject({
        status: "accepted",
        merged_record_id: candidate.proposal_results[0]?.merged_record_id,
        merged_record_state: "canonical",
        merged_record_persistence: "existing",
        links_created: 2
      });
      const events = await readEvents(storePath);
      const activation = events.find((event) => event.event_id.startsWith("evt_structured_semantic_merge_activate_"));
      const promotion = events.find((event) => event.event_id.startsWith("evt_structured_semantic_merge_promote_"));
      expect(activation).toMatchObject({ op: "promote_record", target_state: "candidate" });
      expect(promotion).toMatchObject({ op: "promote_record", target_state: "canonical" });
      expect(activation?.event_id).not.toBe(promotion?.event_id);
      expect(Date.parse(promotion?.created_at ?? "") - Date.parse(activation?.created_at ?? "")).toBe(1);
    });
  });

  it("rejects a competing stale field plan instead of creating a second canonical merge", async () => {
    await withInitializedTempStore(async (storePath) => {
      const fixture = await structuredFixtures(storePath);
      const { mergeProposal } = fixture;
      const engine = createEngine({ storePath });
      const accepted = await engine.consolidateSemanticProposals({ proposals: [mergeProposal] });
      const winnerId = accepted.proposal_results[0]?.merged_record_id;
      const competing = competingStructuredProposal(fixture, "canonical");
      const rejected = await engine.consolidateSemanticProposals({ proposals: [competing] });
      expect(rejected).toMatchObject({
        proposals_accepted: 0,
        proposals_rejected: 1,
        rejected_by_reason: { inactive_record: 1 }
      });
      expect(rejected.proposal_results[0]?.merged_record_id).toBeUndefined();
      const derived = (await readCurrentRecords(storePath)).records.filter((record) =>
        record.id.startsWith("rec_semantic_merge_")
      );
      expect(derived).toHaveLength(1);
      expect(derived[0]?.id).toBe(winnerId);
      expect(derived[0]?.state).toBe("canonical");
    });
  });

  it("fails the source-digest CAS before writing when the snapshot changes after planning", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal, source } = await structuredFixtures(storePath);
      let reads = 0;
      const engine = createEngine({
        storePath,
        readCurrentRecords: async (path) => {
          const result = await readCurrentRecords(path);
          reads += 1;
          if (reads !== 2) return result;
          return {
            ...result,
            records: result.records.map((record) =>
              record.id === source.id
                ? { ...record, content: { ...record.content, commands: ["npm changed-concurrently"] } }
                : record
            )
          };
        }
      });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(receipt).toMatchObject({
        proposals_accepted: 0,
        proposals_rejected: 1,
        links_created: 0,
        rejected_by_reason: { structured_merge_source_changed: 1 }
      });
      expect(receipt.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "structured_merge_source_changed"
      });
      expect(receipt.proposal_results[0]).not.toHaveProperty("merged_record_persistence");
      expect(
        (await readEvents(storePath)).some(
          (event) => event.op === "upsert_record" && event.record.id.startsWith("rec_semantic_merge_")
        )
      ).toBe(false);
    });
  });

  it("fails the dependency CAS before writing when cited evidence changes after planning", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal, evidence } = await structuredFixtures(storePath);
      let reads = 0;
      const engine = createEngine({
        storePath,
        readCurrentRecords: async (path) => {
          const result = await readCurrentRecords(path);
          reads += 1;
          if (reads !== 2) return result;
          return {
            ...result,
            records: result.records.map((record) =>
              record.id === evidence.id
                ? { ...record, content: { text: "The evidence changed concurrently." } }
                : record
            )
          };
        }
      });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(receipt).toMatchObject({
        proposals_accepted: 0,
        proposals_rejected: 1,
        links_created: 0,
        rejected_by_reason: { structured_merge_source_changed: 1 }
      });
      expect(receipt.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "structured_merge_source_changed"
      });
      expect(
        (await readEvents(storePath)).some(
          (event) => event.op === "upsert_record" && event.record.id.startsWith("rec_semantic_merge_")
        )
      ).toBe(false);
    });
  });

  it("does not promote when a claimed relationship reports success without projecting", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal } = await structuredFixtures(storePath);
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (event.event_id.startsWith("evt_structured_semantic_merge_claim_")) {
            return {
              created: true,
              event,
              path: "synthetic-unpersisted-claim",
              durability: "confirmed" as const
            };
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(receipt.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "structured_merge_readback_failed",
        merged_record_persistence: "created",
        links_created: 0
      });
      expect(receipt.proposal_results[0]).not.toHaveProperty("merged_record_state");
      const events = await readEvents(storePath);
      expect(events.some((event) => event.event_id.startsWith("evt_structured_semantic_merge_claim_"))).toBe(false);
      expect(events.some((event) => event.event_id.startsWith("evt_structured_semantic_merge_promote_"))).toBe(false);
      expect(events.some((event) => event.event_id.startsWith("evt_structured_semantic_merge_hide_"))).toBe(false);
      const merged = (await readCurrentRecords(storePath)).records.find(
        (record) => record.id === receipt.proposal_results[0]?.merged_record_id
      );
      expect(merged).toMatchObject({ state: "quarantined", visibility: "quarantined" });
    });
  });

  it("stops after an unprojected hide and counts only relationships verified by readback", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal } = await structuredFixtures(storePath);
      let droppedHide = false;
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          if (!droppedHide && event.event_id.startsWith("evt_structured_semantic_merge_hide_")) {
            droppedHide = true;
            return {
              created: true,
              event,
              path: "synthetic-unpersisted-hide",
              durability: "confirmed" as const
            };
          }
          return appendEventIfAbsent(path, event);
        }
      });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(receipt.proposal_results[0]).toMatchObject({
        status: "failed",
        reason: "structured_merge_readback_failed",
        merged_record_state: "canonical",
        merged_record_persistence: "created",
        links_created: 1
      });
      const events = await readEvents(storePath);
      expect(events.filter((event) => event.event_id.startsWith("evt_structured_semantic_merge_claim_"))).toHaveLength(
        1
      );
      expect(
        events.filter((event) => event.event_id.startsWith("evt_structured_semantic_merge_promote_"))
      ).toHaveLength(1);
      expect(events.filter((event) => event.event_id.startsWith("evt_structured_semantic_merge_hide_"))).toHaveLength(
        0
      );
    });
  });

  it("fails closed when an idempotent event readback changes an immutable field", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { mergeProposal } = await structuredFixtures(storePath);
      const engine = createEngine({
        storePath,
        appendEventIfAbsent: async (path, event) => {
          const appended = await appendEventIfAbsent(path, event);
          if (appended.event.op !== "upsert_record" || !event.event_id.startsWith("evt_structured_semantic_merge_")) {
            return appended;
          }
          return {
            ...appended,
            event: {
              ...appended.event,
              record: {
                ...appended.event.record,
                provenance: { ...appended.event.record.provenance, reason: "tampered collision" }
              }
            }
          };
        }
      });
      const receipt = await engine.consolidateSemanticProposals({ proposals: [mergeProposal] });
      expect(receipt).toMatchObject({
        proposals_accepted: 0,
        proposals_rejected: 1,
        links_created: 0,
        rejected_by_reason: { structured_merge_concurrent_conflict: 1 }
      });
      expect(
        (await readEvents(storePath)).filter(
          (event) => event.op === "link_records" && event.record_id.startsWith("rec_semantic_merge_")
        )
      ).toHaveLength(0);
    });
  });

  it("keeps both facts and creates only a conflict relationship for conflict proposals", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { engine, source, target } = await fixtures(storePath);
      const receipt = await engine.consolidateSemanticProposals({
        proposals: [
          {
            ...proposal(source.id, target.id),
            relationship: "conflicts_with",
            semantic_equivalence: "conflict",
            confidence: 0.99,
            material_differences: [{ field: "policy", before: "pull", after: "do not pull", significance: "material" }],
            structured_merge: { version: 1, requested_state: "canonical", fields: [] }
          }
        ]
      });
      expect(receipt).toMatchObject({ proposals_accepted: 1, links_created: 1 });
      expect(receipt.proposal_results[0]?.merged_record_id).toBeUndefined();
      const records = (await readCurrentRecords(storePath)).records;
      expect(records.some((record) => record.id.startsWith("rec_semantic_merge_"))).toBe(false);
      const logical = buildActiveLogicalMemoryView(records);
      expect(logical.conflict_record_ids).toEqual([source.id, target.id].sort());
      expect(logical.hidden_by_record_id[source.id]).toBeUndefined();
      expect(logical.hidden_by_record_id[target.id]).toBeUndefined();
    });
  });
});
