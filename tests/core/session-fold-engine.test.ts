import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const identity = { project_id: "moryn", session_id: "session-a" };
const source = { client: "codex", session_id: identity.session_id, device_id: "device-a" };

describe("Session Fold engine API", () => {
  it("previews unsafe plain text without mutating the store", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T01:00:01.000Z" });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: identity.project_id,
        content: { text: "Detail not present in the final handoff" },
        source
      });
      const before = await readEvents(storePath);
      const preview = await engine.previewSessionFold({
        ...identity,
        proposed_final_text: "A different final handoff"
      });

      expect(preview.plan).toMatchObject({ status: "review_required", closed: false });
      expect(preview.coverage).toMatchObject({
        covered_sources: [],
        uncovered_sources: [
          { record_id: expect.any(String), blockers: expect.arrayContaining(["non_verbatim_status"]) }
        ]
      });
      expect(await readEvents(storePath)).toEqual(before);
    });
  });

  it("plans and explicitly applies a verified structured fold idempotently", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T01:00:02.000Z" });
      await engine.checkpoint({
        project_id: identity.project_id,
        source,
        occurred_at: "2026-07-20T01:00:01.000Z",
        delta: {
          session_id: identity.session_id,
          checkpoint_id: "verified-checkpoint",
          current_task: "Verify the Engine Session Fold API",
          decisions: ["Require explicit apply"],
          changed_facts: ["Preview is read-only"],
          blockers: [],
          next_steps: ["Apply the verified plan"],
          files: ["src/core/engine.ts"]
        }
      });
      const finalText = "Verified structured Session Fold API.";
      const preview = await engine.previewSessionFold({ ...identity, proposed_final_text: finalText });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: identity.project_id,
        content: { text: finalText, session_fold_coverage: preview.coverage },
        source
      });

      const eventCountBeforePlan = (await readEvents(storePath)).length;
      const plan = await engine.planSessionFold(identity);
      expect(plan).toMatchObject({
        status: "ready",
        auto_fold: true,
        coverage: {
          coverage_attestation: "verified",
          coverage_ratio: 1,
          unverified_source_records: 0
        }
      });
      expect(await readEvents(storePath)).toHaveLength(eventCountBeforePlan);

      const first = await engine.applySessionFold({ plan: plan! });
      const second = await engine.applySessionFold({ plan: plan! });
      expect(first.created_event_ids).toHaveLength(3);
      expect(second.created_event_ids).toEqual([]);
      expect(second.existing_event_ids).toEqual(first.receipt.event_ids);

      const activeSessionRecords = (await readCurrentRecords(storePath)).records.filter(
        (record) => record.kind === "session_summary" && record.visibility === "active"
      );
      expect(activeSessionRecords).toHaveLength(1);
      expect(activeSessionRecords[0]).toMatchObject({
        type: "session_rollup",
        content: { source_record_ids: expect.any(Array) }
      });
    });
  });

  it("requires explicit private access for untagged legacy privacy markers", async () => {
    await withInitializedTempStore(async (storePath) => {
      const privateIdentity = { project_id: "moryn", session_id: "legacy-private-session" };
      const privateSource = { client: "codex", session_id: privateIdentity.session_id, device_id: "device-private" };
      const marker = "UNTAGGED-PRIVATE-SESSION-MARKER-C18F";
      const status = await createEngine({ storePath, now: () => "2026-07-20T02:00:00.000Z" }).write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: privateIdentity.project_id,
        content: { text: marker, format: "text", privacy: "private" },
        source: privateSource
      });
      const engine = createEngine({ storePath, now: () => "2026-07-20T02:00:01.000Z" });
      const finalText = `${marker}. Legacy private session complete.`;
      const coverage = await engine.previewSessionFold({
        ...privateIdentity,
        proposed_final_text: finalText,
        include_private: true
      });
      const final = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: privateIdentity.project_id,
        content: {
          text: finalText,
          distribution: "local_only",
          session_fold_coverage: coverage.coverage
        },
        source: privateSource
      });

      for (const operation of [
        () => engine.previewSessionFold(privateIdentity),
        () => engine.planSessionFold(privateIdentity)
      ]) {
        const error = await operation().then(
          () => "unexpected success",
          (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
        );
        expect(error).toContain("require explicit include_private: true");
        expect(error).not.toContain(marker);
        expect(error).not.toContain(status.record.id);
        expect(error).not.toContain(final.record.id);
      }

      const authorized = await engine.planSessionFold({ ...privateIdentity, include_private: true });
      expect(authorized).toMatchObject({ privacy_boundary: "private" });
      expect(JSON.stringify(authorized)).toContain(marker);
    });
  });
});
