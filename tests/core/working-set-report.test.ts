import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { buildWorkingSetReport } from "../../src/core/working-set-report.js";
import { initializeStore } from "../../src/core/config.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("working set report", () => {
  it("reports logical compaction and bounded default boot records", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = { kind: "memory", type: "decision", scope: "project", project_id: "moryn", source: { client: "codex" } } as const;
      const canonical = await engine.write({ ...base, content: { text: "Use autonomous sync" }, state: "canonical", confirmed: true });
      const duplicate = await engine.write({ ...base, content: { text: "Use autonomous sync" } });
      const old = await engine.write({ ...base, content: { text: "Use manual sync" } });
      const replacement = await engine.write({ ...base, content: { text: "Use managed sync" } });
      const draft = await engine.write({ ...base, content: { text: "Draft retry policy" } });
      const revision = await engine.write({ ...base, content: { text: "Final retry policy" } });
      const conflictA = await engine.write({ ...base, content: { text: "Push at finish" } });
      const conflictB = await engine.write({ ...base, content: { text: "Never push automatically" } });
      const cycleA = await engine.write({ ...base, content: { text: "Cycle A" } });
      const cycleB = await engine.write({ ...base, content: { text: "Cycle B" } });
      await engine.logicalLink({ record_id: duplicate.record.id, linked_record_id: canonical.record.id, relationship: "duplicate_of", reason: "Same decision" });
      await engine.logicalLink({ record_id: replacement.record.id, linked_record_id: old.record.id, relationship: "supersedes", reason: "New policy" });
      await engine.logicalLink({ record_id: revision.record.id, linked_record_id: draft.record.id, relationship: "revises", reason: "Final wording" });
      await engine.logicalLink({ record_id: conflictA.record.id, linked_record_id: conflictB.record.id, relationship: "conflicts_with", reason: "Policy conflict" });
      await engine.logicalLink({ record_id: cycleA.record.id, linked_record_id: cycleB.record.id, relationship: "supersedes", reason: "Cycle edge" });
      await engine.logicalLink({ record_id: cycleB.record.id, linked_record_id: cycleA.record.id, relationship: "supersedes", reason: "Cycle edge" });

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
      expect(report.selection_sources).toEqual(expect.objectContaining({
        total_events: "store.events",
        active_logical_records: "logical_memory.active_records",
        default_boot_records: "boot.records_by_id"
      }));
    });
  });

  it("excludes private records unless explicitly requested", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      const base = { kind: "memory", type: "preference", scope: "global", source: { client: "codex" } } as const;
      await engine.write({ ...base, content: { text: "Public preference" }, state: "canonical", confirmed: true });
      await engine.write({ ...base, tags: ["private"], content: { text: "Private preference" }, state: "canonical", confirmed: true });

      const safe = await buildWorkingSetReport(storePath);
      const privateReport = await buildWorkingSetReport(storePath, { include_private: true });

      expect(safe).toMatchObject({ total_records: 1, active_logical_records: 1, default_boot_records: 1, excluded_private_records: 1 });
      expect(privateReport).toMatchObject({ total_records: 2, active_logical_records: 2, default_boot_records: 2, excluded_private_records: 0 });
    });
  });
});
