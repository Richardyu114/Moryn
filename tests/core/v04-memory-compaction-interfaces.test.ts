import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { readEvents } from "../../src/core/store.js";
import { getOperationContract } from "../../src/operation-contracts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const identity = { project_id: "moryn", session_id: "compaction-public-api" };
const source = { client: "codex", session_id: identity.session_id, device_id: "device-a" };

async function seedReadySession(engine: ReturnType<typeof createEngine>): Promise<void> {
  await engine.checkpoint({
    project_id: identity.project_id,
    source,
    occurred_at: "2026-07-20T08:00:00.000Z",
    delta: {
      session_id: identity.session_id,
      checkpoint_id: "compaction-public-checkpoint",
      current_task: "Expose unified Memory Compaction",
      decisions: ["Require an exact sealed plan"],
      changed_facts: ["Preview and plan are read-only"],
      blockers: [],
      next_steps: ["Apply only with confirmation"],
      files: ["src/core/engine.ts"]
    }
  });
  const finalText = "Unified Memory Compaction public API is ready.";
  const preview = await engine.previewSessionFold({ ...identity, proposed_final_text: finalText });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: identity.project_id,
    content: { text: finalText, session_fold_coverage: preview.coverage },
    source
  });
}

async function seedPrivateReadySession(
  engine: ReturnType<typeof createEngine>,
  privateIdentity: { project_id: string; session_id: string },
  marker: string
): Promise<void> {
  const privateSource = { client: "codex", session_id: privateIdentity.session_id, device_id: "device-private" };
  await engine.write({
    kind: "session_summary",
    type: "status",
    scope: "project",
    project_id: privateIdentity.project_id,
    tags: ["private", `session:${privateIdentity.session_id}`],
    content: { text: marker, format: "text" },
    source: privateSource
  });
  const finalText = `${marker}. Private session complete.`;
  const privatePreview = await engine.previewSessionFold({
    ...privateIdentity,
    proposed_final_text: finalText,
    include_private: true
  });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: privateIdentity.project_id,
    tags: ["private", `session:${privateIdentity.session_id}`],
    content: { text: finalText, session_fold_coverage: privatePreview.coverage },
    source: privateSource
  });
}

describe("v0.4 Memory Compaction Engine interface", () => {
  it("runs preview, plan, confirmed apply, and confirmed append-only restore", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T08:00:01.000Z" });
      await seedReadySession(engine);

      const beforePreview = await readEvents(storePath);
      const preview = await engine.previewMemoryCompaction(identity);
      expect(preview).toMatchObject({
        status: "ready",
        filters: identity,
        plans: [{ kind: "session_fold", status: "ready" }],
        purge: { included: false }
      });
      expect(await readEvents(storePath)).toEqual(beforePreview);

      const plan = await engine.planMemoryCompaction({ preview });
      expect(plan).toMatchObject({
        plan_id: preview.plan_id,
        status: "ready",
        sync_impact: { event_model: "append_only", physical_purge: false }
      });
      expect(await readEvents(storePath)).toEqual(beforePreview);

      await expect(engine.applyMemoryCompaction({ plan, confirmed: false })).rejects.toThrow(
        "requires explicit confirmed: true"
      );
      const applied = await engine.applyMemoryCompaction({ plan, confirmed: true });
      expect(applied.receipt).toMatchObject({
        status: "committed",
        plan_id: plan.plan_id,
        purge_performed: false,
        git_history_erased: false
      });

      await expect(engine.restoreMemoryCompaction({ plan_id: plan.plan_id, confirmed: false })).rejects.toThrow(
        "requires explicit confirmed: true"
      );
      const restored = await engine.restoreMemoryCompaction({ plan_id: plan.plan_id, confirmed: true });
      expect(restored.receipt).toMatchObject({
        status: "restored",
        compaction_plan_id: plan.plan_id,
        logical_restore: true,
        purge_performed: false,
        git_history_erased: false
      });

      const records = (await readCurrentRecords(storePath)).records;
      const sourceIds = plan.plans[0]!.archived_source_record_ids;
      expect(
        records.filter((record) => sourceIds.includes(record.id)).every((record) => record.visibility === "active")
      ).toBe(true);
      expect(records.find((record) => record.id === plan.plans[0]!.derived_record_id)).toMatchObject({
        state: "archived",
        visibility: "archived"
      });
    });
  });

  it("uses strict wrapper shapes while delegating artifact integrity validation to core", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await expect(engine.previewMemoryCompaction({ unexpected: true })).rejects.toThrow(
        "Unknown memory compaction preview input.unexpected"
      );
      await expect(engine.previewMemoryCompaction({ bucket_kind: "week" })).rejects.toThrow(
        "bucket_kind must be one of"
      );
      await expect(engine.previewMemoryCompaction({ include_private: "yes" })).rejects.toThrow(
        "include_private must be a boolean"
      );
      await expect(engine.planMemoryCompaction({ preview: {} })).rejects.toThrow("Invalid Memory Compaction preview");
      await expect(engine.applyMemoryCompaction({ plan: {}, confirmed: true })).rejects.toThrow(
        "Invalid Memory Compaction plan envelope"
      );
    });
  });

  it("omits private sources by default, binds the omission to the artifact, and requires explicit opt-in", async () => {
    await withInitializedTempStore(async (storePath) => {
      const privateIdentity = { project_id: "moryn", session_id: "private-compaction-engine" };
      const marker = "PRIVATE-COMPACTION-ENGINE-MARKER-7D2A";
      const engine = createEngine({ storePath, now: () => "2026-07-20T08:30:00.000Z" });
      await seedPrivateReadySession(engine, privateIdentity, marker);
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: privateIdentity.project_id,
        tags: [`session:${privateIdentity.session_id}`],
        content: { text: "Public evidence remains visible inside the mixed scope.", format: "text" },
        source: { client: "codex", session_id: privateIdentity.session_id, device_id: "device-public" }
      });

      await expect(engine.previewSessionFold(privateIdentity)).rejects.toThrow(
        "require explicit include_private: true"
      );
      await expect(engine.planSessionFold(privateIdentity)).rejects.toThrow("require explicit include_private: true");
      const privateSessionPlan = await engine.planSessionFold({ ...privateIdentity, include_private: true });
      expect(JSON.stringify(privateSessionPlan)).toContain(marker);

      const preview = await engine.previewMemoryCompaction(privateIdentity);
      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain("final_handoff_content");
      expect(serialized).not.toContain('"claims"');
      expect(preview).toMatchObject({
        status: "review_required",
        filters: { ...privateIdentity, include_private: false, recent_window_days: 7 },
        private_access: {
          include_private: false,
          scope_complete: false,
          omitted_private_source_count: 2,
          omission_reason: "private_sources_require_explicit_include_private"
        },
        plans: [{ kind: "session_fold", privacy: { boundary: "public" } }],
        blockers: expect.arrayContaining([
          expect.objectContaining({
            code: "private_sources_omitted",
            record_ids: [],
            omitted_source_count: 2,
            disposition: "review_required"
          })
        ])
      });
      const blockedPlan = await engine.planMemoryCompaction({ preview });
      expect(blockedPlan.status).toBe("review_required");
      await expect(engine.applyMemoryCompaction({ plan: blockedPlan, confirmed: true })).rejects.toThrow("not ready");

      const authorized = await engine.previewMemoryCompaction({ ...privateIdentity, include_private: true });
      expect(authorized).toMatchObject({
        filters: { include_private: true },
        private_access: { include_private: true, scope_complete: true, omitted_private_source_count: 0 },
        plans: [{ kind: "session_fold", privacy: { boundary: "mixed" } }]
      });
      expect(JSON.stringify(authorized)).toContain(marker);
      expect(authorized.preview_id).not.toBe(preview.preview_id);
      expect(authorized.plan_id).not.toBe(preview.plan_id);
    });
  });
});

describe("v0.4 Memory Compaction operation contracts", () => {
  it("marks preview and plan safe while requiring confirmation for apply and restore", () => {
    const preview = getOperationContract("memory_compaction_preview")!.operation;
    const plan = getOperationContract("memory_compaction_plan")!.operation;
    const apply = getOperationContract("memory_compaction_apply")!.operation;
    const restore = getOperationContract("memory_compaction_restore")!.operation;

    expect(preview).toMatchObject({
      safe_to_run: true,
      arguments_by_name: {
        include_private: { required: false, type: "boolean", default: false }
      },
      interfaces: {
        cli: { command: "moryn memory compact preview" },
        mcp: { tool: "memory_compaction_preview" }
      }
    });
    expect(plan).toMatchObject({ safe_to_run: true, required_fields: ["preview"] });
    expect(apply).toMatchObject({
      safe_to_run: false,
      required_fields: ["plan", "confirm"],
      arguments_by_name: { confirm: { required: true, type: "boolean" } }
    });
    expect(restore).toMatchObject({
      safe_to_run: false,
      required_fields: ["plan_id", "confirm"],
      arguments_by_name: { confirm: { required: true, type: "boolean" } }
    });
  });
});
