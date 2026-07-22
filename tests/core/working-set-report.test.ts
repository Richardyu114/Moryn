import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { buildWorkingSetReport } from "../../src/core/working-set-report.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("working set report", () => {
  it("reports logical compaction and bounded default boot records", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        source: { client: "codex" }
      } as const;
      const canonical = await engine.write({
        ...base,
        content: { text: "Use autonomous sync" },
        state: "canonical",
        confirmed: true
      });
      const duplicate = await engine.write({ ...base, content: { text: "Use autonomous sync" } });
      const old = await engine.write({ ...base, content: { text: "Use manual sync" } });
      const replacement = await engine.write({ ...base, content: { text: "Use managed sync" } });
      const draft = await engine.write({ ...base, content: { text: "Draft retry policy" } });
      const revision = await engine.write({ ...base, content: { text: "Final retry policy" } });
      const conflictA = await engine.write({ ...base, content: { text: "Push at finish" } });
      const conflictB = await engine.write({ ...base, content: { text: "Never push automatically" } });
      const cycleA = await engine.write({ ...base, content: { text: "Cycle A" } });
      const cycleB = await engine.write({ ...base, content: { text: "Cycle B" } });
      await engine.logicalLink({
        record_id: duplicate.record.id,
        linked_record_id: canonical.record.id,
        relationship: "duplicate_of",
        reason: "Same decision"
      });
      await engine.logicalLink({
        record_id: replacement.record.id,
        linked_record_id: old.record.id,
        relationship: "supersedes",
        reason: "New policy"
      });
      await engine.logicalLink({
        record_id: revision.record.id,
        linked_record_id: draft.record.id,
        relationship: "revises",
        reason: "Final wording"
      });
      await engine.logicalLink({
        record_id: conflictA.record.id,
        linked_record_id: conflictB.record.id,
        relationship: "conflicts_with",
        reason: "Policy conflict"
      });
      await engine.logicalLink({
        record_id: cycleA.record.id,
        linked_record_id: cycleB.record.id,
        relationship: "supersedes",
        reason: "Cycle edge"
      });
      await engine.logicalLink({
        record_id: cycleB.record.id,
        linked_record_id: cycleA.record.id,
        relationship: "supersedes",
        reason: "Cycle edge"
      });

      const report = await buildWorkingSetReport(storePath, { project_id: "moryn" });

      expect(report).toMatchObject({
        total_events: 16,
        total_records: 10,
        active_logical_records: 7,
        hidden_duplicate_records: 1,
        hidden_superseded_records: 1,
        hidden_revised_records: 1,
        conflict_records: 2,
        cycle_findings: 1,
        default_boot_records: 1,
        compaction_ratio: 0.3
      });
      expect(report.selection_sources).toEqual(
        expect.objectContaining({
          total_events: "store.events",
          active_logical_records: "logical_memory.active_records",
          default_boot_records: "boot.records_by_id"
        })
      );
    });
  });

  it("excludes tagged and legacy content-private records unless explicitly requested", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      const base = { kind: "memory", type: "preference", scope: "global", source: { client: "codex" } } as const;
      await engine.write({ ...base, content: { text: "Public preference" }, state: "canonical", confirmed: true });
      await engine.write({
        ...base,
        tags: ["private"],
        content: { text: "Private preference" },
        state: "canonical",
        confirmed: true
      });
      await engine.write({
        ...base,
        content: { text: "Legacy private preference", privacy: "private" },
        state: "canonical",
        confirmed: true
      });
      await engine.write({
        ...base,
        content: { text: "Local-only preference", distribution: "local_only" },
        state: "canonical",
        confirmed: true
      });

      const safe = await buildWorkingSetReport(storePath);
      const privateReport = await buildWorkingSetReport(storePath, { include_private: true });

      expect(safe).toMatchObject({
        total_records: 1,
        active_logical_records: 1,
        default_boot_records: 1,
        excluded_private_records: 3
      });
      expect(privateReport).toMatchObject({
        total_records: 4,
        active_logical_records: 4,
        default_boot_records: 4,
        excluded_private_records: 0
      });
    });
  });

  it("reports semantic relationships and rejected proposals across the privacy boundary", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath, now: () => "2026-07-12T00:00:00.000Z" });
      const publicSource = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Agents sync at finish." },
        source: { client: "codex" }
      });
      const publicTarget = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Agent finish triggers sync." },
        source: { client: "codex" }
      });
      await engine.consolidateSemanticProposals({
        proposals: [
          {
            proposal_id: "public-semantic",
            source_record_id: publicSource.record.id,
            target_record_id: publicTarget.record.id,
            relationship: "duplicate_of",
            confidence: 0.99,
            rationale: "Equivalent finish behavior.",
            semantic_equivalence: "equivalent",
            material_differences: [],
            evidence_record_ids: []
          }
        ],
        project_id: "moryn",
        source: { client: "codex" }
      });
      const privateSource = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private agent sync fact." },
        source: { client: "codex" }
      });
      const privateTarget = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private finish sync fact." },
        source: { client: "codex" }
      });
      await engine.consolidateSemanticProposals({
        proposals: [
          {
            proposal_id: "private-semantic",
            source_record_id: privateSource.record.id,
            target_record_id: privateTarget.record.id,
            relationship: "duplicate_of",
            confidence: 0.99,
            rationale: "Equivalent private behavior.",
            semantic_equivalence: "equivalent",
            material_differences: [],
            evidence_record_ids: []
          }
        ],
        project_id: "moryn",
        include_private: true,
        source: { client: "codex" }
      });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "working-set", device_id: "device-test" },
        occurred_at: "2026-07-12T00:05:00.000Z",
        delta: {
          session_id: "working-set",
          checkpoint_id: "working-set-rejected",
          progress: ["Capacity audit"],
          semantic_consolidation_proposals: [
            {
              proposal_id: "rejected-public",
              source_record_id: "rec-unbounded",
              target_record_id: publicTarget.record.id,
              relationship: "duplicate_of",
              confidence: 0.5,
              rationale: "Rejected public proposal.",
              semantic_equivalence: "equivalent",
              material_differences: [],
              evidence_record_ids: []
            },
            {
              proposal_id: "rejected-private",
              source_record_id: "rec-private-unbounded",
              target_record_id: privateTarget.record.id,
              relationship: "duplicate_of",
              confidence: 0.5,
              rationale: "Rejected private proposal.",
              semantic_equivalence: "equivalent",
              material_differences: [],
              evidence_record_ids: []
            }
          ]
        }
      });

      const safe = await buildWorkingSetReport(storePath, { project_id: "moryn" });
      const privateReport = await buildWorkingSetReport(storePath, { project_id: "moryn", include_private: true });
      expect(safe).toMatchObject({
        semantic_equivalent_links: 1,
        semantic_revision_links: 0,
        semantic_superseded_links: 0,
        semantic_conflict_links: 0,
        semantic_rejected_proposals: 1
      });
      expect(privateReport).toMatchObject({ semantic_equivalent_links: 2, semantic_rejected_proposals: 2 });
    });
  });
});
