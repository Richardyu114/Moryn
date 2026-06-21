import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const RECALL_EVAL_SELECTION_SOURCES = {
  case: "cases_by_id.<case_id>",
  case_id: "cases_by_id.<case_id>.case_id",
  expected_record: "cases_by_id.<case_id>.expected_record_ids[]",
  matched_record: "cases_by_id.<case_id>.matched_record_ids[]",
  missing_record: "cases_by_id.<case_id>.missing_record_ids[]",
  privacy_check: "privacy",
  suggested_action: "suggested_actions_by_id.<action_id>",
  suggested_action_id: "suggested_actions_by_id.<action_id>.action_id"
};

describe("recall eval", () => {
  it("evaluates golden recall cases without exposing private records by default", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-05-27T00:00:0${nextId}.000Z`,
        id: (prefix) => `${prefix}_${++nextId}`
      });

      const decision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Keep dashboard approval actions explicit and auditable.", format: "text" },
        state: "canonical",
        source: { client: "test" },
        provenance: { method: "user-confirmed", reason: "Golden eval target" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private dashboard credential rotation details.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const report = await engine.recallEval({
        project_id: "moryn",
        cases: [
          {
            case_id: "dashboard-approval",
            query: "dashboard approval auditable",
            expected_record_ids: [decision.record.id],
            limit: 5
          },
          {
            case_id: "missing-private",
            query: "private credential",
            expected_record_ids: ["rec_missing_private"],
            limit: 5
          }
        ]
      });

      expect(report.selection_sources).toEqual(RECALL_EVAL_SELECTION_SOURCES);
      expect(report.summary).toMatchObject({
        total_cases: 2,
        passed_cases: 1,
        failed_cases: 1,
        hit_rate: 0.5,
        privacy_leaks: 0
      });
      expect(report.cases_by_id["dashboard-approval"]).toMatchObject({
        case_id: "dashboard-approval",
        status: "pass",
        matched_record_ids: [decision.record.id],
        missing_record_ids: [],
        top_record_id: decision.record.id
      });
      expect(report.cases_by_id["dashboard-approval"]?.results[0]).toMatchObject({
        record_id: decision.record.id,
        rank: 1,
        provenance_method: "user-confirmed"
      });
      expect(report.cases_by_id["dashboard-approval"]?.results[0]?.reason).toContain("source_trust:user-confirmed");
      expect(report.cases_by_id["missing-private"]).toMatchObject({
        case_id: "missing-private",
        status: "fail",
        matched_record_ids: [],
        missing_record_ids: ["rec_missing_private"]
      });
      expect(report.privacy).toEqual({
        include_private: false,
        leaked_private_record_ids: [],
        leak_count: 0
      });
      expect(report.suggested_actions).toContainEqual(expect.objectContaining({
        action_id: "revise-golden-case:missing-private",
        recommended_action: "revise_golden_case_or_memory",
        tool: "recall",
        command: "moryn recall \"private credential\" --project-id moryn --limit 5"
      }));
      expect(report.suggested_actions_by_id["revise-golden-case:missing-private"]).toEqual(report.suggested_actions[0]);
      expect(JSON.stringify(report)).not.toContain("Private dashboard credential rotation details");
    });
  });
});
