import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import type { HistoricalRecallMatch } from "../../src/core/historical-recall.js";
import { evaluateRecall } from "../../src/core/recall-eval.js";
import { readEvents } from "../../src/core/store.js";
import type { MorynRecord, RecordKind, RecordScope, RecordState } from "../../src/core/types.js";
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

function evalRecord(id: string, overrides: Partial<MorynRecord> = {}): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope: "project",
    project_id: "moryn",
    tags: [],
    content: { text: id },
    state: "canonical",
    confidence: 0.9,
    priority: "normal",
    visibility: "active",
    created_at: "2026-05-28T00:00:00.000Z",
    updated_at: "2026-05-28T00:00:00.000Z",
    source: { client: "test" },
    provenance: { method: "user-confirmed" },
    ...overrides
  };
}

function historicalMatch(record: MorynRecord, overrides: Partial<HistoricalRecallMatch> = {}): HistoricalRecallMatch {
  return {
    record_id: record.id,
    kind: record.kind,
    type: record.type,
    scope: record.scope,
    ...(record.project_id ? { project_id: record.project_id } : {}),
    state: record.state,
    visibility: record.visibility,
    confidence: record.confidence,
    priority: record.priority,
    updated_at: record.updated_at,
    layer: "L1",
    tier: "cold",
    reasons: ["archived"],
    covered_by_record_ids: [],
    matched_tokens: ["historical"],
    query_tokens: ["historical"],
    coverage: 1,
    score: 10,
    content_mode: "full",
    source_estimated_tokens: 10,
    returned_estimated_tokens: 10,
    record,
    ...overrides
  };
}

describe("recall eval", () => {
  async function writeFixtureRecord(
    engine: ReturnType<typeof createEngine>,
    input: {
      kind: RecordKind;
      type: string;
      scope: RecordScope;
      project_id?: string;
      tags?: string[];
      text: string;
      privacy?: "private";
      distribution?: "local_only";
      state?: RecordState;
      confirmed?: boolean;
    }
  ) {
    return engine.write({
      kind: input.kind,
      type: input.type,
      scope: input.scope,
      project_id: input.project_id,
      tags: input.tags ?? [],
      content: {
        text: input.text,
        format: "text",
        ...(input.privacy ? { privacy: input.privacy } : {}),
        ...(input.distribution ? { distribution: input.distribution } : {})
      },
      state: input.state ?? "canonical",
      confirmed: input.confirmed ?? true,
      source: { client: "test" },
      provenance: {
        method: input.confirmed === false ? "agent-proposed" : "user-confirmed",
        reason: "Golden eval fixture"
      }
    });
  }

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
      expect(report.suggested_actions).toContainEqual(
        expect.objectContaining({
          action_id: "revise-golden-case:missing-private",
          recommended_action: "revise_golden_case_or_memory",
          tool: "recall",
          command: 'moryn recall "private credential" --project-id moryn --limit 5'
        })
      );
      expect(report.suggested_actions_by_id["revise-golden-case:missing-private"]).toEqual(report.suggested_actions[0]);
      expect(JSON.stringify(report)).not.toContain("Private dashboard credential rotation details");
    });
  });

  it("evaluates a compact v0.2 golden suite and reports hidden expected records without writing", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({
        storePath,
        now: () => `2026-05-28T00:${String(nextId).padStart(2, "0")}:00.000Z`,
        id: (prefix) => `${prefix}_golden_${++nextId}`
      });

      const decision = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        text: "Dashboard confirmations require explicit approval before canonical memory changes."
      });
      const _skill = await writeFixtureRecord(engine, {
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        text: "Release verification runs typecheck, tests, smoke, package inspection, and dashboard health."
      });
      const _preference = await writeFixtureRecord(engine, {
        kind: "soul",
        type: "preference",
        scope: "global",
        tags: ["principle"],
        text: "Prefer dry-run evidence before local setup writes."
      });
      const _handoff = await writeFixtureRecord(engine, {
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["handoff"],
        text: "Phase 4 recall eval should explain missing, hidden, and ranked records."
      });
      const _agentNote = await writeFixtureRecord(engine, {
        kind: "agent_note",
        type: "observation",
        scope: "project",
        project_id: "moryn",
        tags: ["analysis"],
        text: "Agent note captured recall eval fixture coverage for dashboard evidence.",
        state: "candidate"
      });
      const raw = await writeFixtureRecord(engine, {
        kind: "agent_note",
        type: "raw_note",
        scope: "project",
        project_id: "moryn",
        tags: ["raw"],
        text: "Raw eval draft should stay hidden unless raw state is requested.",
        state: "raw"
      });
      const archived = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["retired"],
        text: "Archived eval decision is preserved but hidden from default recall.",
        state: "archived"
      });
      const quarantined = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["unsafe"],
        text: "Quarantined eval warning is preserved but hidden from default recall.",
        state: "quarantined"
      });
      const privateRecord = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        text: "Private eval token rotation note should never leak by default."
      });
      const contentPrivateRecord = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["privacy-marker"],
        text: "Content-private eval note should never leak by default.",
        privacy: "private"
      });
      const localOnlyRecord = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["distribution-marker"],
        text: "Local-only eval note should never leak by default.",
        distribution: "local_only"
      });
      const otherProject = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "other",
        tags: ["other-project"],
        text: "Other project eval memory should not satisfy moryn project cases."
      });
      const stale = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["conflict"],
        text: "Recall eval stale decision says dashboard approvals can be automatic."
      });
      const replacement = await writeFixtureRecord(engine, {
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["conflict"],
        text: "Recall eval replacement decision says dashboard approvals stay explicit."
      });

      const beforeEvents = await readEvents(storePath);
      const report = await engine.recallEval({
        project_id: "moryn",
        cases: [
          {
            case_id: "visible-kinds",
            query: "dashboard confirmations explicit approval",
            expected_record_ids: [decision.record.id],
            limit: 10
          },
          {
            case_id: "default-hidden",
            query: "raw archived quarantined private other project",
            expected_record_ids: [
              raw.record.id,
              archived.record.id,
              quarantined.record.id,
              privateRecord.record.id,
              contentPrivateRecord.record.id,
              localOnlyRecord.record.id,
              otherProject.record.id
            ],
            limit: 10
          },
          {
            case_id: "conflicting-pair",
            query: "recall eval dashboard approvals",
            expected_record_ids: [stale.record.id, replacement.record.id],
            limit: 10
          }
        ]
      });

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(report.summary).toMatchObject({
        total_cases: 3,
        passed_cases: 2,
        failed_cases: 1,
        privacy_leaks: 0
      });
      expect(report.cases_by_id["visible-kinds"]).toMatchObject({
        status: "pass",
        matched_record_ids: [decision.record.id],
        missing_record_ids: [],
        hidden_record_ids: []
      });
      expect(report.cases_by_id["default-hidden"]).toMatchObject({
        status: "fail",
        matched_record_ids: [],
        missing_record_ids: [],
        hidden_record_ids: expect.arrayContaining([
          raw.record.id,
          archived.record.id,
          quarantined.record.id,
          privateRecord.record.id,
          contentPrivateRecord.record.id,
          localOnlyRecord.record.id,
          otherProject.record.id
        ])
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[raw.record.id]).toMatchObject({
        record_id: raw.record.id,
        reason: "state_filter",
        state: "raw"
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[archived.record.id]).toMatchObject({
        reason: "state_filter",
        state: "archived"
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[quarantined.record.id]).toMatchObject({
        reason: "state_filter",
        state: "quarantined"
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[privateRecord.record.id]).toMatchObject({
        reason: "private_filter",
        tags: ["private"]
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[contentPrivateRecord.record.id]).toMatchObject({
        reason: "private_filter",
        tags: ["privacy-marker"]
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[localOnlyRecord.record.id]).toMatchObject({
        reason: "private_filter",
        tags: ["distribution-marker"]
      });
      expect(report.cases_by_id["default-hidden"]?.hidden_records_by_id[otherProject.record.id]).toMatchObject({
        reason: "project_filter",
        project_id: "other"
      });
      expect(report.cases_by_id["conflicting-pair"]).toMatchObject({
        status: "pass",
        matched_record_ids: expect.arrayContaining([stale.record.id, replacement.record.id]),
        missing_record_ids: [],
        hidden_record_ids: []
      });
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]).toMatchObject({
        recommended_action: "inspect_hidden_expected_records",
        tool: "recall",
        case_id: "default-hidden",
        hidden_record_ids: expect.arrayContaining([
          raw.record.id,
          archived.record.id,
          quarantined.record.id,
          privateRecord.record.id,
          contentPrivateRecord.record.id,
          localOnlyRecord.record.id,
          otherProject.record.id
        ])
      });
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).toContain(
        `--record-id ${raw.record.id}`
      );
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).toContain("--state raw");
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).toContain(
        "--state archived"
      );
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).toContain(
        "--state quarantined"
      );
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).toContain(
        "--state canonical"
      );
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).toContain(
        "--include-private"
      );
      expect(report.suggested_actions_by_id["inspect-hidden-records:default-hidden"]?.command).not.toContain(
        'moryn recall ""'
      );
      expect(report.suggested_actions_by_id["revise-golden-case:default-hidden"]).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("Private eval token rotation note");
      expect(JSON.stringify(report)).not.toContain("Content-private eval note");
      expect(JSON.stringify(report)).not.toContain("Local-only eval note");
    });
  });

  it("flags content-level private records returned by a faulty recall adapter", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_leak_${++nextId}` });
      const contentPrivate = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["privacy-marker"],
        content: { text: "Private adapter result.", privacy: "private" },
        state: "canonical",
        confirmed: true,
        source: { client: "test" }
      });
      const localOnly = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        tags: ["distribution-marker"],
        content: { text: "Local adapter result.", distribution: "local_only" },
        state: "canonical",
        confirmed: true,
        source: { client: "test" }
      });
      const leakedRecords = [contentPrivate.record, localOnly.record];

      const report = await evaluateRecall(
        {
          project_id: "moryn",
          cases: [
            {
              case_id: "faulty-adapter",
              query: "adapter result",
              expected_record_ids: leakedRecords.map((record) => record.id)
            }
          ]
        },
        async () => ({
          results: leakedRecords.map((record) => ({ record, score: 1, reason: ["fault injection"] }))
        })
      );

      expect(report.privacy).toEqual({
        include_private: false,
        leaked_private_record_ids: leakedRecords.map((record) => record.id),
        leak_count: 2
      });
      expect(report.summary.privacy_leaks).toBe(2);
    });
  });

  it("ranks keyed historical recovery after ordinary results and removes duplicate record ids", async () => {
    const ordinary = evalRecord("rec-ordinary");
    const historical = evalRecord("rec-historical", {
      state: "archived",
      visibility: "archived",
      updated_at: "2026-05-27T00:00:00.000Z"
    });

    const report = await evaluateRecall(
      {
        project_id: "moryn",
        cases: [
          {
            case_id: "historical-recovery",
            query: "historical detail",
            expected_record_ids: [ordinary.id, historical.id]
          }
        ]
      },
      async () => ({
        results: [{ record: ordinary, score: 20, reason: ["ordinary_result"] }],
        historical_recovery: {
          matches_by_record_id: {
            [ordinary.id]: historicalMatch(ordinary, { score: 100 }),
            [historical.id]: historicalMatch(historical, { score: 15 })
          }
        }
      })
    );

    expect(report.cases_by_id["historical-recovery"]).toMatchObject({
      status: "pass",
      matched_record_ids: [ordinary.id, historical.id],
      missing_record_ids: [],
      hidden_record_ids: [],
      top_record_id: ordinary.id,
      results: [
        { record_id: ordinary.id, rank: 1, score: 20, reason: ["ordinary_result"] },
        { record_id: historical.id, rank: 2, score: 15 }
      ]
    });
    expect(report.cases_by_id["historical-recovery"]?.results[1]?.reason).toContain("historical_recovery");
  });

  it("flags private records returned through keyed historical recovery", async () => {
    const privateHistorical = evalRecord("rec-private-historical", {
      tags: ["private"],
      state: "archived",
      visibility: "archived"
    });

    const report = await evaluateRecall(
      {
        project_id: "moryn",
        cases: [
          {
            case_id: "historical-private-leak",
            query: "private historical detail",
            expected_record_ids: [privateHistorical.id]
          }
        ]
      },
      async () => ({
        results: [],
        historical_recovery: {
          matches_by_record_id: {
            [privateHistorical.id]: historicalMatch(privateHistorical)
          }
        }
      })
    );

    expect(report.cases_by_id["historical-private-leak"]).toMatchObject({
      status: "pass",
      matched_record_ids: [privateHistorical.id],
      results: [{ record_id: privateHistorical.id, rank: 1 }]
    });
    expect(report.privacy).toEqual({
      include_private: false,
      leaked_private_record_ids: [privateHistorical.id],
      leak_count: 1
    });
    expect(report.summary.privacy_leaks).toBe(1);
  });
});
