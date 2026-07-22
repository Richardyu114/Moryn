import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { planSessionFold } from "../../src/core/session-fold.js";
import { applySessionFoldPlan } from "../../src/core/session-fold-transaction.js";
import type { MorynRecord } from "../../src/core/types.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const projectId = "v04-quality-gate";
const sessionId = "quality-session";
const source = { client: "codex", session_id: sessionId, device_id: "quality-device" };

function activeSessionRecords(records: readonly MorynRecord[]): MorynRecord[] {
  return records.filter(
    (record) =>
      record.kind === "session_summary" &&
      record.project_id === projectId &&
      record.source.session_id === sessionId &&
      record.visibility === "active" &&
      record.state !== "archived" &&
      record.state !== "quarantined"
  );
}

describe("v0.4 quantitative compaction quality gate", () => {
  it("reduces active episodic context without recall, protected-fact, canonical, or privacy loss", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      let nextSecond = 20;
      const engine = createEngine({
        storePath,
        id: (prefix) => `${prefix}_quality_${++nextId}`,
        now: () => new Date(Date.UTC(2026, 6, 20, 0, 0, nextSecond++)).toISOString()
      });
      const goldenInputs = [
        ["release-policy", "Amber zeppelin releases require npm test before moryn sync push."],
        ["rollback-policy", "Cobalt lantern rollback keeps the signed v0.4.0 tag."],
        ["approval-policy", "Ivory compass canonical changes require explicit approval."],
        ["privacy-policy", "Saffron harbor local-only content must never enter Git."],
        ["recovery-policy", "Violet meadow crash recovery replays append-only receipts."]
      ] as const;
      const goldenRecords = [];
      for (const [type, text] of goldenInputs) {
        goldenRecords.push(
          (
            await engine.write({
              kind: "memory",
              type,
              scope: "project",
              project_id: projectId,
              content: { text, format: "text" },
              state: "canonical",
              confirmed: true,
              source: { client: "user" },
              provenance: { method: "user-confirmed", reason: "v0.4 compaction golden set" }
            })
          ).record
        );
      }
      const privateRecord = (
        await engine.write({
          kind: "memory",
          type: "credential-note",
          scope: "project",
          project_id: projectId,
          tags: ["private"],
          content: { text: "Private obsidian credential must remain local.", format: "text" },
          state: "canonical",
          confirmed: true,
          source: { client: "user" }
        })
      ).record;

      const protectedDecisions = [
        "Never publish credentials.",
        "Run npm test before release v0.4.0.",
        "Keep path state/ private.",
        "Rollback requires explicit approval on 2026-07-21."
      ];
      for (let index = 0; index < protectedDecisions.length; index += 1) {
        await engine.checkpoint({
          project_id: projectId,
          source,
          occurred_at: new Date(Date.UTC(2026, 6, 20, 0, 0, index + 1)).toISOString(),
          delta: {
            session_id: sessionId,
            checkpoint_id: `quality-checkpoint-${index + 1}`,
            current_task: "Verify v0.4 compaction quality",
            blockers: [],
            decisions: [protectedDecisions[index]!],
            changed_facts: [],
            next_steps: ["Continue the quality gate"],
            files: ["tests/core/v04-compaction-quality-gate.test.ts"]
          },
          tags: []
        });
      }
      const finalText = "Verified v0.4 compaction quality without losing protected evidence.";
      const preview = await engine.previewSessionFold({
        project_id: projectId,
        session_id: sessionId,
        proposed_final_text: finalText
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: projectId,
        content: {
          text: finalText,
          synthesis_blockers: [],
          synthesis_next_steps: ["Keep the quantitative gate in release evidence"],
          session_fold_coverage: preview.coverage
        },
        source
      });

      const cases = goldenRecords.map((record, index) => ({
        case_id: goldenInputs[index]![0],
        query: goldenInputs[index]![1],
        expected_record_ids: [record.id],
        limit: 5
      }));
      const beforeRecords = (await readCurrentRecords(storePath)).records;
      const beforeActive = activeSessionRecords(beforeRecords).length;
      const beforeRecall = await engine.recallEval({ project_id: projectId, cases });
      const plan = planSessionFold(beforeRecords, { project_id: projectId, session_id: sessionId });
      expect(plan).toMatchObject({ status: "ready", coverage: { coverage_ratio: 1 } });
      await applySessionFoldPlan(storePath, plan!);

      const afterRecords = (await readCurrentRecords(storePath)).records;
      const afterActive = activeSessionRecords(afterRecords).length;
      const afterRecall = await engine.recallEval({ project_id: projectId, cases });
      const activeReduction = 1 - afterActive / beforeActive;
      const canonicalPreservation =
        goldenRecords.filter((golden) =>
          afterRecords.some(
            (record) => record.id === golden.id && record.state === "canonical" && record.visibility === "active"
          )
        ).length / goldenRecords.length;
      const recallAtFiveDecline = beforeRecall.summary.hit_rate - afterRecall.summary.hit_rate;
      const rollup = afterRecords.find((record) => record.id === plan!.rollup_record!.id);
      const preservedDecisions = Array.isArray(rollup?.content.decisions) ? rollup.content.decisions : [];
      const protectedFactLoss = protectedDecisions.filter((decision) => !preservedDecisions.includes(decision)).length;
      const privateRecall = await engine.recall({
        project_id: projectId,
        query: "private obsidian credential",
        limit: 5
      });
      const privacyLeakage = privateRecall.results.filter((result) => result.record.id === privateRecord.id).length;

      expect({
        active_session_summary_reduction: activeReduction,
        canonical_preservation_rate: canonicalPreservation,
        recall_at_5_decline: recallAtFiveDecline,
        protected_fact_loss: protectedFactLoss,
        privacy_leakage: privacyLeakage
      }).toEqual({
        active_session_summary_reduction: 0.8,
        canonical_preservation_rate: 1,
        recall_at_5_decline: 0,
        protected_fact_loss: 0,
        privacy_leakage: 0
      });
      expect(beforeRecall.summary.hit_rate).toBe(1);
      expect(afterRecall.summary.hit_rate).toBe(1);
      expect(afterRecall.summary.privacy_leaks).toBe(0);
      expect(activeReduction).toBeGreaterThanOrEqual(0.7);
      expect(recallAtFiveDecline).toBeLessThanOrEqual(0.01);
    });
  });
});
