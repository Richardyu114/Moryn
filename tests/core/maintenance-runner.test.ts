import { describe, expect, it, vi } from "vitest";
import type { AutomaticEventAuditReceipt } from "../../src/core/automatic-event-audit.js";
import type { AutomaticSemanticMaintenanceResult } from "../../src/core/automatic-semantic-maintenance.js";
import { createEngine } from "../../src/core/engine.js";
import { buildActiveLogicalMemoryView } from "../../src/core/logical-memory.js";
import { type MaintenanceRunBlockedError, runMaintenanceOnce } from "../../src/core/maintenance-runner.js";
import { readCurrentRecords } from "../../src/core/record-read-model.js";
import { readEvents } from "../../src/core/store.js";
import { type GitSyncStatus, SYNC_STATUS_SELECTION_SOURCES } from "../../src/sync/git.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

function skippedMaintenance(projectId = "moryn"): AutomaticSemanticMaintenanceResult {
  return {
    status: "skipped",
    project_id: projectId,
    maximum_merges: 1,
    drafts_ready: 0,
    merges_attempted: 0,
    merges_committed: 0,
    before: { current_records: 0, estimated_tokens: 0 },
    after: { current_records: 0, estimated_tokens: 0 },
    committed: [],
    failures: [],
    proof: {
      strict_record_decrease_required: true,
      strict_token_decrease_required: true,
      strict_record_decrease_observed: false,
      strict_token_decrease_observed: false,
      source_history_retained: true,
      physical_delete: false
    }
  };
}

function completedAudit(): AutomaticEventAuditReceipt {
  return {
    status: "completed",
    event_count: 0,
    record_count: 0,
    snapshot_status: "fresh"
  };
}

function clearSyncStatus(): GitSyncStatus {
  return {
    configured: false,
    error: "Not a git repository",
    selection_sources: SYNC_STATUS_SELECTION_SOURCES
  };
}

function failedMaintenance(projectId = "moryn"): AutomaticSemanticMaintenanceResult {
  return {
    ...skippedMaintenance(projectId),
    status: "failed",
    failures: [{ reason: "Injected maintenance failure" }]
  };
}

function failedAudit(): AutomaticEventAuditReceipt {
  return {
    status: "failed",
    failure_stage: "schema",
    code: "EVENT_SCHEMA_INVALID",
    reason: "Invalid event fixture",
    event_count: 1,
    record_count: 0,
    snapshot_status: "not_checked"
  };
}

describe("maintenance runner", () => {
  it("commits at most one local proof-gated merge, audits it, and retains source history", async () => {
    await withInitializedTempStore(async (storePath) => {
      let tick = 0;
      const engine = createEngine({
        storePath,
        now: () => new Date(Date.parse("2026-07-27T00:00:00.000Z") + tick++).toISOString()
      });
      const shared = `The bounded maintenance proof retains every source unit ${"shared ".repeat(600)}.`;
      const base = {
        kind: "skill" as const,
        type: "procedure",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["maintenance"],
        state: "canonical" as const,
        confirmed: true,
        confidence: 0.99,
        source: { client: "test" }
      };
      const first = (await engine.write({ ...base, content: { text: `${shared} Preserve retry handling.` } })).record;
      const second = (await engine.write({ ...base, content: { text: `${shared} Preserve timeout handling.` } }))
        .record;
      const beforeEvents = await readEvents(storePath);

      const receipt = await runMaintenanceOnce({
        store_path: storePath,
        project_id: "moryn",
        source: { client: "test", session_id: "session-1" }
      });

      expect(receipt).toMatchObject({
        status: "completed",
        maintenance: {
          status: "committed",
          maximum_merges: 1,
          merges_attempted: 1,
          merges_committed: 1,
          before: { current_records: 2 },
          after: { current_records: 1 }
        },
        event_audit: { status: "completed" },
        sync_preflight: { status: "clear", configured: false },
        policy: {
          execution: "one_shot",
          working_set: "public_project",
          physical_delete: false,
          source_history_retained: true,
          remote_publish: false,
          remote_publish_operation: "sync_push"
        }
      });
      const records = (await readCurrentRecords(storePath)).records;
      expect(records.find((record) => record.id === first.id)).toBeDefined();
      expect(records.find((record) => record.id === second.id)).toBeDefined();
      expect(
        buildActiveLogicalMemoryView(records).active_records.filter((record) => record.visibility === "active")
      ).toHaveLength(1);
      expect((await readEvents(storePath)).length).toBeGreaterThan(beforeEvents.length);
    });
  });

  it("audits a skipped local pass", async () => {
    const maintenance = vi.fn(async () => skippedMaintenance());
    const audit = vi.fn(async () => completedAudit());

    const receipt = await runMaintenanceOnce(
      { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
      {
        get_git_sync_status: async () => clearSyncStatus(),
        create_engine: () => ({ applyAutomaticSemanticMaintenance: maintenance }),
        run_automatic_event_audit: audit
      }
    );

    expect(maintenance).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledTimes(2);
    expect(receipt).toMatchObject({
      status: "completed",
      maintenance: { status: "skipped" },
      preflight_event_audit: { status: "completed" },
      event_audit: { status: "completed" },
      sync_preflight: { status: "clear", configured: false }
    });
  });

  it("reports failed maintenance, still audits, and has no remote publication path", async () => {
    const audit = vi.fn(async () => completedAudit());
    const receipt = await runMaintenanceOnce(
      { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
      {
        get_git_sync_status: async () => clearSyncStatus(),
        create_engine: () => ({ applyAutomaticSemanticMaintenance: async () => failedMaintenance() }),
        run_automatic_event_audit: audit
      }
    );

    expect(audit).toHaveBeenCalledTimes(2);
    expect(receipt).toMatchObject({
      status: "failed",
      maintenance: { status: "failed" },
      preflight_event_audit: { status: "completed" },
      event_audit: { status: "completed" },
      policy: { remote_publish: false, remote_publish_operation: "sync_push" }
    });
    expect(receipt).not.toHaveProperty("sync");
  });

  it("fails closed on a sync conflict before creating the engine or auditing", async () => {
    const createEngine = vi.fn();
    const audit = vi.fn();
    const run = runMaintenanceOnce(
      { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
      {
        get_git_sync_status: async () => ({
          configured: true,
          sync_state: "conflict",
          conflict: {
            operation: "rebase",
            files: ["events/device/2026-07/event.json"],
            files_by_path: {},
            safe_to_auto_resolve: false,
            safe_to_retry_sync: false,
            recommended_action: "Resolve the sync conflict."
          },
          selection_sources: SYNC_STATUS_SELECTION_SOURCES
        }),
        create_engine: createEngine,
        run_automatic_event_audit: audit
      }
    );

    await expect(run).rejects.toMatchObject({
      name: "MaintenanceRunBlockedError",
      code: "SYNC_CONFLICT"
    });
    expect(createEngine).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("fails closed when sync status cannot be verified", async () => {
    const createEngine = vi.fn();
    await expect(
      runMaintenanceOnce(
        { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
        {
          get_git_sync_status: async () => {
            throw new Error("private status details");
          },
          create_engine: createEngine
        }
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<MaintenanceRunBlockedError>>({
        name: "MaintenanceRunBlockedError",
        code: "SYNC_STATUS_UNAVAILABLE"
      })
    );
    expect(createEngine).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the configured shared copy is unreachable",
      status: {
        configured: true,
        remote: "https://example.invalid/moryn.git",
        sync_state: "clean" as const,
        remote_observation: { checked: true as const, reachable: false }
      },
      recommended_action: "check sync status and retry maintenance after the shared copy is reachable"
    },
    {
      label: "newer shared changes have not been pulled",
      status: {
        configured: true,
        remote: "https://example.invalid/moryn.git",
        sync_state: "clean" as const,
        behind: 1,
        remote_observation: {
          checked: true as const,
          reachable: true,
          remote_commit: "abc123",
          contains_local_head: true
        }
      },
      recommended_action: "pull the shared changes and retry maintenance after the local store is current"
    }
  ])("fails closed before maintenance when $label", async ({ status, recommended_action }) => {
    const createEngine = vi.fn();
    const audit = vi.fn();
    await expect(
      runMaintenanceOnce(
        { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
        {
          get_git_sync_status: async () => ({
            ...status,
            selection_sources: SYNC_STATUS_SELECTION_SOURCES
          }),
          create_engine: createEngine,
          run_automatic_event_audit: audit
        }
      )
    ).rejects.toMatchObject({
      name: "MaintenanceRunBlockedError",
      code: "SYNC_STATUS_UNAVAILABLE",
      recommended_action
    });
    expect(createEngine).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("returns a failed receipt when Event Audit rejects the local state", async () => {
    const createEngine = vi.fn();
    const audit = vi.fn(async () => failedAudit());
    const receipt = await runMaintenanceOnce(
      { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
      {
        get_git_sync_status: async () => clearSyncStatus(),
        create_engine: createEngine,
        run_automatic_event_audit: audit
      }
    );

    expect(createEngine).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      status: "failed",
      maintenance: {
        status: "failed",
        merges_attempted: 0,
        merges_committed: 0,
        failures: [{ reason: "Preflight event integrity verification failed." }]
      },
      preflight_event_audit: { status: "failed", code: "EVENT_SCHEMA_INVALID" },
      event_audit: { status: "failed", code: "EVENT_SCHEMA_INVALID" }
    });
  });

  it("maps an unexpected audit throw to a conservative read failure without exposing the thrown text", async () => {
    const privateFailureText = "private event body must not escape";
    const createEngine = vi.fn();
    const receipt = await runMaintenanceOnce(
      { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
      {
        get_git_sync_status: async () => clearSyncStatus(),
        create_engine: createEngine,
        run_automatic_event_audit: async () => {
          throw new Error(privateFailureText);
        }
      }
    );

    expect(receipt).toMatchObject({
      status: "failed",
      maintenance: { status: "failed", merges_attempted: 0, merges_committed: 0 },
      preflight_event_audit: {
        status: "failed",
        failure_stage: "read_events",
        code: "EVENT_READ_FAILED",
        snapshot_status: "not_checked"
      },
      event_audit: {
        status: "failed",
        failure_stage: "read_events",
        code: "EVENT_READ_FAILED",
        snapshot_status: "not_checked"
      }
    });
    expect(createEngine).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain(privateFailureText);
  });

  it("checks sync state, append-only history, and preflight audit before maintenance, then audits afterwards", async () => {
    const order: string[] = [];
    const receipt = await runMaintenanceOnce(
      { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
      {
        get_git_sync_status: async () => {
          order.push("sync_preflight");
          return clearSyncStatus();
        },
        assert_git_event_history_append_only: async () => {
          order.push("append_only_gate");
        },
        create_engine: () => ({
          applyAutomaticSemanticMaintenance: async () => {
            order.push("maintenance");
            return skippedMaintenance();
          }
        }),
        run_automatic_event_audit: async () => {
          order.push(order.includes("maintenance") ? "post_audit" : "preflight_audit");
          return completedAudit();
        }
      }
    );

    expect(order).toEqual(["sync_preflight", "append_only_gate", "preflight_audit", "maintenance", "post_audit"]);
    expect(receipt).toMatchObject({
      status: "completed",
      preflight_event_audit: { status: "completed" },
      event_audit: { status: "completed" },
      sync_preflight: { status: "clear" }
    });
  });

  it("fails closed at the append-only history gate before creating the engine or auditing", async () => {
    const createEngine = vi.fn();
    const audit = vi.fn();
    const privateFailureText = "/private/store/events/old.json was rewritten";

    await expect(
      runMaintenanceOnce(
        { store_path: "/tmp/moryn-test", project_id: "moryn", source: { client: "test" } },
        {
          get_git_sync_status: async () => clearSyncStatus(),
          assert_git_event_history_append_only: async () => {
            throw new Error(privateFailureText);
          },
          create_engine: createEngine,
          run_automatic_event_audit: audit
        }
      )
    ).rejects.toThrow(privateFailureText);

    expect(createEngine).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("does not touch private, global, high-priority, Soul, or externally conflicted records", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const text = (group: string, suffix: string) =>
        `The ${group} record preserves this full proof ${`${group} `.repeat(600)}. ${suffix}`;
      const writePair = async (group: string, overrides: Partial<Parameters<typeof engine.write>[0]> = {}) => {
        const base = {
          kind: "memory" as const,
          type: "decision",
          scope: "project" as const,
          project_id: "moryn",
          state: "canonical" as const,
          confirmed: true,
          confidence: 0.99,
          source: { client: "test" },
          ...overrides
        };
        return [
          (await engine.write({ ...base, content: { text: text(group, "First detail.") } })).record,
          (await engine.write({ ...base, content: { text: text(group, "Second detail.") } })).record
        ] as const;
      };

      await writePair("private", { tags: ["private"] });
      await writePair("global", { scope: "global", project_id: undefined });
      await writePair("priority", { priority: "high" });
      await writePair("soul", { kind: "soul", type: "principle", scope: "global", project_id: undefined });
      const conflicted = await writePair("conflict");
      const external = (
        await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          content: { text: "An external canonical decision remains unresolved." },
          state: "canonical",
          confirmed: true,
          source: { client: "test" }
        })
      ).record;
      await engine.logicalLink({
        record_id: conflicted[0].id,
        linked_record_id: external.id,
        relationship: "conflicts_with",
        reason: "The decisions are not reconciled.",
        source: { client: "test" }
      });
      const beforeEvents = await readEvents(storePath);

      const receipt = await runMaintenanceOnce({
        store_path: storePath,
        project_id: "moryn",
        source: { client: "test" }
      });

      expect(receipt).toMatchObject({
        status: "completed",
        maintenance: { status: "skipped", merges_attempted: 0, merges_committed: 0 },
        event_audit: { status: "completed" }
      });
      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
    });
  });

  it("leaves pair-internal unresolved conflicts for user review", async () => {
    await withInitializedTempStore(async (storePath) => {
      let recordIndex = 0;
      let eventIndex = 0;
      const engine = createEngine({
        storePath,
        id: (prefix) =>
          prefix === "rec" ? `rec_internal_conflict_${++recordIndex}` : `evt_internal_conflict_${++eventIndex}`
      });
      const shared = `The unresolved alternatives retain complete evidence ${"shared ".repeat(600)}.`;
      const base = {
        kind: "memory" as const,
        type: "decision",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["maintenance"],
        state: "canonical" as const,
        confirmed: true,
        confidence: 0.99,
        source: { client: "test" }
      };
      await engine.write({
        ...base,
        content: { text: `${shared} Keep the old endpoint.` },
        conflict: { kind: "semantic", with: ["rec_internal_conflict_2"], resolution: "needs_review" }
      });
      await engine.write({
        ...base,
        content: { text: `${shared} Use the new endpoint.` },
        conflict: { kind: "semantic", with: ["rec_internal_conflict_1"], resolution: "needs_review" }
      });
      const beforeEvents = await readEvents(storePath);

      const receipt = await runMaintenanceOnce({
        store_path: storePath,
        project_id: "moryn",
        source: { client: "test" }
      });

      expect(receipt).toMatchObject({
        status: "completed",
        maintenance: { status: "skipped", drafts_ready: 0, merges_attempted: 0, merges_committed: 0 },
        event_audit: { status: "completed" }
      });
      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
    });
  });
});
