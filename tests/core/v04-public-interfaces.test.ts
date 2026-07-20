import { describe, expect, it } from "vitest";
import { readStoreConfig } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { memoryRecordDigest } from "../../src/core/memory-expansion.js";
import type { MemoryCompactionPrivateAccessSummary } from "../../src/index.js";
import { getOperationContract } from "../../src/operation-contracts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const secret = "LOCAL SOUL COMMAND SECRET";

describe("v0.4 public Engine interfaces", () => {
  it("exports the compaction private-access evidence type from the package root", () => {
    const privateAccess: MemoryCompactionPrivateAccessSummary = {
      include_private: false,
      scope_complete: false,
      omitted_private_source_count: 1,
      omission_reason: "private_sources_require_explicit_include_private"
    };
    expect(privateAccess).toMatchObject({ include_private: false, omitted_private_source_count: 1 });
  });

  it("wraps the complete Soul draft, approval, status, and rollback lifecycle", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.parse("2026-07-20T10:00:00.000Z") + tick++ * 60_000).toISOString()
      });
      const firstDraft = await engine.createSoulProfileDraft({
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: [
          {
            clause_key: "mission",
            category: "mission",
            text: "Keep memory evidence-led.",
            distribution: "personal_sync"
          },
          {
            clause_key: "private-context",
            category: "collaboration",
            text: secret,
            distribution: "local_only"
          }
        ]
      });

      await expect(engine.approveSoulProfileDraft({ revision_id: firstDraft.revision.revision_id })).rejects.toThrow(
        "explicit user confirmation"
      );
      const first = await engine.approveSoulProfileDraft({
        revision_id: firstDraft.revision.revision_id,
        confirmed: true
      });
      const changedDraft = await engine.createSoulProfileDraft({
        from_revision_id: first.revision.revision_id,
        clauses: [
          {
            clause_key: "mission",
            category: "mission",
            text: "Keep memory compact and evidence-led.",
            distribution: "personal_sync"
          }
        ]
      });
      const changed = await engine.approveSoulProfileDraft({
        revision_id: changedDraft.revision.revision_id,
        confirmed: true
      });
      const rollback = await engine.rollbackSoulProfile({
        profile_id: first.revision.profile_id,
        target_revision_id: first.revision.revision_id,
        confirmed: true
      });
      const status = await engine.readSoulProfileStatus({ agent_profile_id: first.revision.profile_id });

      expect(changed.revision.revision_id).not.toBe(first.revision.revision_id);
      expect(rollback.revision).toMatchObject({
        profile_id: first.revision.profile_id,
        state: "active",
        approved: true
      });
      expect(rollback.approval_receipt.action).toBe("rollback");
      expect(status.profiles[0]).toMatchObject({
        profile_id: first.revision.profile_id,
        active_revision_id: rollback.revision.revision_id,
        conflicted: false
      });
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(JSON.stringify(status)).not.toContain("Keep memory compact and evidence-led.");
    });
  });

  it("strictly validates Soul and Memory Expand request shapes", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T10:00:00.000Z" });
      await expect(
        engine.createSoulProfileDraft({
          subject: { kind: "agent", subject_id: "moryn", unexpected: true },
          clauses: [{ clause_key: "mission", category: "mission", text: "Be useful." }]
        })
      ).rejects.toThrow("Unknown subject.unexpected");
      await expect(engine.readSoulProfileStatus({ token_budget: "100" })).rejects.toThrow(
        "token_budget must be a positive integer"
      );
      await expect(engine.rollbackSoulProfile({ target_revision_id: "revision", confirmed: true })).rejects.toThrow(
        "profile_id"
      );
      await expect(engine.expandMemorySources({ record_id: "missing", max_depth: "2" })).rejects.toThrow(
        "max_depth must be an integer"
      );
      await expect(engine.expandMemorySources({ record_id: "missing", extra: true })).rejects.toThrow(
        "Unknown memory expansion input.extra"
      );
    });
  });

  it("expands source evidence from the Engine current-record view", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T10:00:00.000Z" });
      const deviceId = (await readStoreConfig(storePath)).device_id;
      const source = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "source evidence" },
        source: { client: "test", device_id: deviceId }
      });
      const rollup = await engine.write({
        kind: "session_summary",
        type: "session_rollup",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "rollup",
          source_record_ids: [source.record.id],
          source_digests: [{ record_id: source.record.id, digest: memoryRecordDigest(source.record) }]
        },
        source: { client: "test", device_id: deviceId }
      });

      const expansion = await engine.expandMemorySources({ record_id: rollup.record.id, max_depth: 1 });
      expect(expansion.records.map((entry) => entry.record.id)).toEqual([rollup.record.id, source.record.id]);
      expect(expansion.edges[0]).toMatchObject({
        from_record_id: rollup.record.id,
        to_record_id: source.record.id,
        verification: "verified"
      });
    });
  });
});

describe("v0.4 public operation contracts", () => {
  it("publishes safe reads and guarded Soul activation operations", () => {
    const soulStatus = getOperationContract("soul_status")!.operation;
    const soulApprove = getOperationContract("soul_approve")!.operation;
    const soulRollback = getOperationContract("soul_rollback")!.operation;
    const memoryExpand = getOperationContract("memory_expand")!.operation;

    expect(soulStatus).toMatchObject({
      safe_to_run: true,
      interfaces: { cli: { command: "moryn soul status" }, mcp: { tool: "soul_status" } }
    });
    expect(memoryExpand).toMatchObject({
      safe_to_run: true,
      required_fields: ["record_id"],
      interfaces: { mcp: { tool: "memory_expand" } }
    });
    expect(soulApprove).toMatchObject({
      safe_to_run: false,
      required_fields: ["revision_id", "confirm"],
      arguments_by_name: { confirm: { required: true, type: "boolean" } }
    });
    expect(soulRollback).toMatchObject({
      safe_to_run: false,
      required_fields: ["profile_id", "to_revision", "confirm"],
      arguments_by_name: { confirm: { required: true, type: "boolean" } }
    });
  });
});
