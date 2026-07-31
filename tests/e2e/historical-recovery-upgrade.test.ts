import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { pendingLearningInbox, queueLearning } from "../../src/core/learning-inbox.js";
import { buildDashboardData, renderDashboardHtml } from "../../src/observability/dashboard.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("historical recovery upgrade journey", () => {
  it("recovers a natural-language memory, persists verified learning, and shows only the upgraded current result", async () => {
    await withInitializedTempStore(async (storePath) => {
      let sequence = 0;
      const engine = createEngine({
        storePath,
        now: () => "2026-07-30T10:00:00.000Z",
        id: (prefix) => `${prefix}_upgrade_journey_${++sequence}`
      });
      const historicalText = "手机端处理 Notion 文章时，默认直接写入 Notion 子页。";
      const historical = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: historicalText },
        state: "archived",
        confidence: 0.8,
        source: { client: "codex", session_id: "session-old" }
      });

      const first = await engine.recall({
        query: "手机端的 Notion 文章默认写入哪里",
        project_id: "moryn"
      });

      expect(first.results).toEqual([]);
      expect(first.historical_recovery).toMatchObject({
        status: "recovered",
        matches: [{ record_id: historical.record.id }]
      });

      const upgradedText = "手机端处理 Notion 文章时，默认直接写入对应的 Notion 子页。";
      const queued = await queueLearning(storePath, {
        project_id: "moryn",
        question: "手机端的 Notion 文章默认写入哪里？",
        conclusion: upgradedText,
        evidence_type: "user_confirmed",
        related_record_ids: [historical.record.id],
        current_task: "恢复并升级历史记忆",
        source: { client: "codex", session_id: "session-current", device_id: "device-test" },
        occurred_at: "2026-07-30T10:00:01.000Z"
      });
      expect(queued.created).toBe(true);
      expect((await pendingLearningInbox(storePath, { project_id: "moryn" })).map((record) => record.id)).toEqual([
        queued.record.id
      ]);

      const checkpoint = await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-current", device_id: "device-test" },
        occurred_at: "2026-07-30T10:00:02.000Z",
        delta: {
          session_id: "session-current",
          checkpoint_id: "historical-upgrade",
          current_task: "恢复并升级历史记忆",
          progress: ["已验证历史候选并保存当前结论。"],
          decisions: [],
          changed_facts: [],
          blockers: [],
          next_steps: [],
          files: [],
          candidate_memories: [],
          candidate_skills: [],
          learnings: []
        }
      });
      const upgradedId = checkpoint.learning_ingestion.dispositions[0]?.record_id;
      expect(checkpoint.learning_inbox).toMatchObject({ selected: 1, consumed: 1 });
      expect(upgradedId).toBeTruthy();
      expect(await pendingLearningInbox(storePath, { project_id: "moryn" })).toEqual([]);

      const second = await engine.recall({
        query: "手机端的 Notion 文章默认写入哪里",
        project_id: "moryn"
      });
      expect(second.outcome).toMatchObject({ status: "trusted_match", best_record_id: upgradedId });
      expect(second.results[0]?.record).toMatchObject({
        id: upgradedId,
        content: { text: upgradedText },
        provenance: { derived_from: [historical.record.id] }
      });
      expect(second.historical_recovery).toBeUndefined();

      const dashboard = await buildDashboardData(storePath, { project_id: "moryn" });
      const html = renderDashboardHtml(dashboard);
      const memoryLibraryStart = html.indexOf('id="saved-memory-library" data-memory-search');
      const memoryLibraryEnd = html.indexOf("data-v04-summary", memoryLibraryStart);
      const memoryLibrary = html.slice(memoryLibraryStart, memoryLibraryEnd);
      expect(dashboard.memory_status.current_record_ids).toContain(upgradedId);
      expect(dashboard.memory_status.current_record_ids).not.toContain(historical.record.id);
      expect(memoryLibrary).toContain(upgradedText);
      expect(memoryLibrary).not.toContain(historicalText);
    });
  });
});
