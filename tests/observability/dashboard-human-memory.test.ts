import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { buildDashboardData, renderDashboardHtml } from "../../src/observability/dashboard.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("human-facing dashboard memory status", () => {
  it("shows scoped counts and the concrete learning and organization content behind them", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const base = {
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "current-project",
        source: { client: "codex" }
      } as const;

      await engine.write({
        ...base,
        content: { text: "A current project fact." },
        state: "canonical",
        confirmed: true
      });
      await engine.write({ ...base, content: { text: "A retained historical fact." }, state: "archived" });
      const quarantined = await engine.write({ ...base, content: { text: "A fact waiting for review." } });
      await engine.quarantine({ record_id: quarantined.record.id, reason: "Conflicting source" });

      const pendingText = "Use exact hardware identifiers before inferring a GPU model.";
      await engine.write({
        kind: "agent_note",
        type: "learning_inbox",
        scope: "project",
        project_id: "current-project",
        tags: ["learning", "learning-inbox", "pending"],
        content: {
          text: `Pending learning: ${pendingText}`,
          learning_inbox_version: 1,
          status: "pending"
        },
        state: "candidate",
        source: { client: "codex" }
      });
      const absorbedText = "Save a durable checkpoint before compacting a long session.";
      await engine.write({
        ...base,
        tags: ["learning"],
        content: { text: absorbedText },
        state: "canonical",
        confirmed: true
      });

      const olderText = "The older retry policy used two attempts.";
      const currentText = "The current retry policy uses three bounded attempts.";
      const older = await engine.write({ ...base, content: { text: olderText } });
      const current = await engine.write({
        ...base,
        content: { text: currentText },
        state: "canonical",
        confirmed: true
      });
      await engine.logicalLink({
        record_id: current.record.id,
        linked_record_id: older.record.id,
        relationship: "supersedes",
        reason: "The retry policy was updated."
      });
      await engine.write({
        kind: "skill",
        type: "workflow",
        scope: "global",
        content: { text: "A shared workflow." },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const foreignText = "FOREIGN_PROJECT_CONTENT_MUST_NOT_ENTER_THE_HUMAN_DASHBOARD";
      await engine.write({
        ...base,
        project_id: "other-project",
        content: { text: foreignText },
        state: "canonical",
        confirmed: true
      });

      const data = await buildDashboardData(storePath, { project_id: "current-project" });
      const html = renderDashboardHtml(data);

      expect(data.memory_status.summary).toEqual({
        saved_total: 8,
        current_total: 5,
        history_total: 1,
        quarantined_total: 1,
        organized_total: 1,
        conflict_total: 0
      });
      expect(data.memory_status.learning).toMatchObject({
        absorbed_total: 1,
        canonical_total: 1,
        candidate_total: 0,
        pending_total: 1
      });
      expect(data.memory_status.organization).toMatchObject({ hidden_total: 1, group_total: 1 });
      expect(html).toContain("8 items saved for this project and shared use");
      expect(html).toContain("5 current · 1 older version tucked away · 1 history · 1 set aside");
      expect(html).toContain(absorbedText);
      expect(html).toContain(pendingText);
      expect(html).toContain(currentText);
      expect(html).toContain(olderText);
      expect(html).not.toContain(foreignText);
      expect(html).not.toContain("Organized</span><strong>1%");
    });
  });
});
