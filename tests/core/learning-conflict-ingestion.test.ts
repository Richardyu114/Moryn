import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

function reliableLearning(conclusion: string) {
  return {
    question: "What does the source code establish?",
    conclusion,
    evidence_type: "source_code" as const,
    scope: "project" as const,
    confidence: 0.95,
    recommended_kind: "memory" as const,
    recommended_type: "fact",
    related_record_ids: []
  };
}

describe("learning conflict ingestion", () => {
  it("keeps a conflicting reliable learning as a review candidate", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const existing = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dashboard deployment uses workflow version one." },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const input = {
        project_id: "moryn",
        occurred_at: "2026-07-30T00:01:00.000Z",
        source: { client: "codex" },
        learnings: [reliableLearning("Dashboard deployment uses workflow version two.")]
      };

      const first = await engine.ingestLearnings(input);
      const retry = await engine.ingestLearnings(input);

      expect(first.dispositions[0]).toMatchObject({
        created: true,
        state: "candidate",
        requires_confirmation: true,
        policy_reason: "semantic_conflict_requires_confirmation"
      });
      expect(retry.dispositions[0]).toMatchObject({
        created: false,
        state: "candidate",
        requires_confirmation: true,
        policy_reason: "semantic_conflict_requires_confirmation"
      });
      const event = (await readEvents(storePath)).find(
        (candidate) => candidate.op === "upsert_record" && candidate.record.id === first.dispositions[0]?.record_id
      );
      expect(event?.op === "upsert_record" ? event.record.conflict : undefined).toEqual({
        kind: "semantic",
        with: [existing.record.id],
        resolution: "needs_review"
      });
      expect((await readEvents(storePath)).filter((candidate) => candidate.op === "link_records")).toHaveLength(0);
    });
  });

  it("does not treat shared Learning system tags as a semantic conflict", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const first = await engine.ingestLearnings({
        project_id: "moryn",
        occurred_at: "2026-07-30T00:01:00.000Z",
        source: { client: "codex" },
        learnings: [reliableLearning("Dashboard deployment uses the signed release workflow.")]
      });
      const second = await engine.ingestLearnings({
        project_id: "moryn",
        occurred_at: "2026-07-30T00:02:00.000Z",
        source: { client: "codex" },
        learnings: [reliableLearning("Memory retention keeps raw evidence in warm storage.")]
      });

      expect(first.dispositions[0]).toMatchObject({ state: "canonical", requires_confirmation: false });
      expect(second.dispositions[0]).toMatchObject({ state: "canonical", requires_confirmation: false });
    });
  });
});
