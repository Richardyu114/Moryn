import { describe, expect, it } from "vitest";
import { evaluateTurnSyncCadence, readTurnSyncCadence, recordTurnSyncSuccess } from "../../src/core/turn-sync-cadence.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const identity = { project_id: "moryn", host: "codex" as const, session_id: "session-a", device_id: "device-a" };

describe("turn sync cadence", () => {
  it("is due before the first successful push and inside a stale window", async () => {
    await withInitializedTempStore(async (storePath) => {
      expect(await evaluateTurnSyncCadence(storePath, { ...identity, occurred_at: "2026-07-12T00:00:00.000Z" })).toMatchObject({ due: true, reason: "first_turn_sync" });
      await recordTurnSyncSuccess(storePath, { ...identity, occurred_at: "2026-07-12T00:00:00.000Z" });
      expect(await evaluateTurnSyncCadence(storePath, { ...identity, occurred_at: "2026-07-12T00:05:00.000Z" })).toMatchObject({ due: false, reason: "within_interval", last_success_at: "2026-07-12T00:00:00.000Z" });
      expect(await evaluateTurnSyncCadence(storePath, { ...identity, occurred_at: "2026-07-12T00:15:00.000Z" })).toMatchObject({ due: true, reason: "interval_elapsed" });
    });
  });

  it("keeps independent session and device receipts", async () => {
    await withInitializedTempStore(async (storePath) => {
      await recordTurnSyncSuccess(storePath, { ...identity, occurred_at: "2026-07-12T00:00:00.000Z" });
      expect(await evaluateTurnSyncCadence(storePath, { ...identity, session_id: "session-b", occurred_at: "2026-07-12T00:01:00.000Z" })).toMatchObject({ due: true, reason: "first_turn_sync" });
      expect((await readTurnSyncCadence(storePath)).entries).toHaveLength(1);
    });
  });
});
