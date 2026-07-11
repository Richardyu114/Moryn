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

      expect(first).toMatchObject({ created: true, receipt: { activation_id: input.activation_id, event: "pre_compact" } });
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
});
