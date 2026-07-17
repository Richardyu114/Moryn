import { describe, expect, it } from "vitest";
import { activationReceiptIdentity, recordActivationReceipt } from "../../src/core/activation-receipts.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const input = {
  activation_id: "moryn-v03-moryn-claude",
  host: "claude" as const,
  project_id: "moryn",
  event: "pre_compact" as const,
  session_id: "session-1",
  device_id: "device-1",
  occurred_at: "2026-07-12T00:00:00.000Z",
  command_digest: "a".repeat(64)
};

describe("activation receipts", () => {
  it("derives stable replay identity without storing hook payload", () => {
    expect(activationReceiptIdentity(input)).toEqual({
      record_id: expect.stringMatching(/^rec_activation_[a-f0-9]{32}$/),
      event_id: expect.stringMatching(/^evt_activation_[a-f0-9]{32}$/),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(activationReceiptIdentity(input)).toEqual(activationReceiptIdentity({ ...input }));
  });

  it("appends one idempotent receipt for repeated hook dispatch", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await recordActivationReceipt(storePath, input);
      const replay = await recordActivationReceipt(storePath, input);
      const events = (await readEvents(storePath)).filter((event) => event.event_id.startsWith("evt_activation_"));

      expect(first).toMatchObject({
        created: true,
        receipt: { activation_id: input.activation_id, event: "pre_compact" }
      });
      expect(replay).toMatchObject({ created: false, record: { id: first.record.id } });
      expect(events).toHaveLength(1);
      expect(first.record.content).toEqual({
        format: "json",
        text: "Claude activation receipt: pre_compact",
        activation_receipt_version: 1,
        activation_id: input.activation_id,
        host: "claude",
        event: "pre_compact",
        session_id: "session-1",
        device_id: "device-1",
        command_digest: input.command_digest
      });
      expect(JSON.stringify(first.record.content)).not.toContain("prompt");
      expect(JSON.stringify(first.record.content)).not.toContain("summary");
    });
  });

  it("coalesces high-frequency Stop receipts by session and UTC hour", async () => {
    await withInitializedTempStore(async (storePath) => {
      const stop = {
        ...input,
        host: "codex" as const,
        event: "stop" as const,
        occurred_at: "2026-07-12T03:01:00.000Z"
      };
      const first = await recordActivationReceipt(storePath, stop);
      const sameHour = await recordActivationReceipt(storePath, { ...stop, occurred_at: "2026-07-12T03:59:59.999Z" });
      const nextHour = await recordActivationReceipt(storePath, { ...stop, occurred_at: "2026-07-12T04:00:00.000Z" });
      const events = (await readEvents(storePath)).filter((event) => event.event_id.startsWith("evt_activation_"));

      expect(first).toMatchObject({ created: true, receipt: { occurred_at: "2026-07-12T03:00:00.000Z" } });
      expect(sameHour).toMatchObject({
        created: false,
        record: { id: first.record.id },
        receipt: { occurred_at: "2026-07-12T03:00:00.000Z" }
      });
      expect(nextHour).toMatchObject({ created: true, receipt: { occurred_at: "2026-07-12T04:00:00.000Z" } });
      expect(events).toHaveLength(2);
    });
  });

  it("keeps exact receipt timing for lifecycle boundary events", () => {
    expect(activationReceiptIdentity(input)).not.toEqual(
      activationReceiptIdentity({ ...input, occurred_at: "2026-07-12T00:00:01.000Z" })
    );
  });
});
