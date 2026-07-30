import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { hostHookExecutionReceiptIdentity, recordHostHookExecutionReceipt } from "../../src/core/host-hook-receipts.js";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { OperationDeadlineExceededError, withOperationDeadline } from "../../src/core/operation-deadline.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const receiptInput = {
  host: "codex" as const,
  event: "session_start" as const,
  project_id: "moryn",
  session_id: "session-timeout",
  device_id: "device-a",
  occurred_at: "2026-07-30T01:00:00.000Z",
  status: "timed_out" as const,
  stage: "start" as const
};

const hookBase = {
  host: "codex" as const,
  session_id: "session-timeout",
  device_id: "device-a",
  cwd: "/repo",
  occurred_at: "2026-07-30T01:00:00.000Z"
};

describe("host hook execution receipts", () => {
  it("uses deterministic identities and appends one receipt on replay", async () => {
    await withInitializedTempStore(async (storePath) => {
      expect(hostHookExecutionReceiptIdentity(receiptInput)).toEqual(
        hostHookExecutionReceiptIdentity({ ...receiptInput })
      );
      const first = await recordHostHookExecutionReceipt(storePath, receiptInput);
      const replay = await recordHostHookExecutionReceipt(storePath, receiptInput);

      expect(first).toMatchObject({ created: true, receipt: { status: "timed_out", stage: "start" } });
      expect(replay).toMatchObject({ created: false, record: { id: first.record.id } });
      expect(
        (await readEvents(storePath)).filter((event) => event.event_id.startsWith("evt_hook_execution_"))
      ).toHaveLength(1);
    });
  });

  it("persists the last stage after a host operation exceeds its deadline", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(
        withOperationDeadline(10, () =>
          runHostHook(
            {
              storePath,
              project_id: "moryn",
              hook: { ...hookBase, event: "session_start" }
            },
            {
              isGitSyncConfigured: async () => {
                await delay(30);
                return true;
              }
            }
          )
        )
      ).rejects.toBeInstanceOf(OperationDeadlineExceededError);

      const receipt = (await readEvents(storePath)).find((event) => event.event_id.startsWith("evt_hook_execution_"));
      expect(receipt).toMatchObject({
        op: "upsert_record",
        record: {
          type: "host_hook_execution_receipt",
          content: { status: "timed_out", stage: "start", session_id: "session-timeout" }
        }
      });
    });
  });

  it("persists cancellation when the hook body resolves after the outer signal aborts", async () => {
    await withInitializedTempStore(async (storePath) => {
      const controller = new AbortController();
      await expect(
        withOperationDeadline(
          10_000,
          () =>
            runHostHook(
              {
                storePath,
                project_id: "moryn",
                push: true,
                current_task: "protect checkpoint",
                hook: {
                  ...hookBase,
                  event: "pre_compact",
                  compact_summary: "Checkpoint before cancellation."
                }
              },
              {
                pushGitSync: async () => {
                  controller.abort(new Error("SDK request cancelled"));
                  await delay(10);
                  return { ok: true, pushed: true };
                }
              }
            ),
          controller.signal
        )
      ).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });

      const receipt = (await readEvents(storePath)).find((event) => event.event_id.startsWith("evt_hook_execution_"));
      expect(receipt).toMatchObject({
        op: "upsert_record",
        record: {
          type: "host_hook_execution_receipt",
          content: { status: "cancelled", stage: "checkpoint_sync", session_id: "session-timeout" }
        }
      });
    });
  });

  it("defers remote checkpoint sync while preserving the local checkpoint", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await withOperationDeadline(1_000, () =>
        runHostHook(
          {
            storePath,
            project_id: "moryn",
            push: true,
            current_task: "protect checkpoint",
            hook: {
              ...hookBase,
              event: "pre_compact",
              compact_summary: "Local checkpoint is durable before optional remote synchronization."
            }
          },
          {
            pushGitSync: async () => {
              throw new Error("deferred sync must not run");
            }
          }
        )
      );

      expect(result).toMatchObject({
        action: "checkpoint_before_compaction",
        checkpoint: { record: { id: expect.any(String) } },
        checkpoint_sync: {
          requested: true,
          deferred: { work: "checkpoint_sync", reason: "operation_deadline_budget" }
        },
        deferred_work: [{ work: "checkpoint_sync", reason: "operation_deadline_budget" }]
      });
    });
  });
});
