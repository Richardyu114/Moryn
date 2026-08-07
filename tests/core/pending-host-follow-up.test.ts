import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES,
  PENDING_HOST_FOLLOW_UP_TTL_MS,
  pendingHostFollowUpPath,
  readPendingHostFollowUp,
  writePendingHostFollowUp
} from "../../src/core/pending-host-follow-up.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const identity = {
  project_id: "moryn",
  host: "codex" as const,
  session_id: "session-compact",
  device_id: "device-a"
};
const createdAt = "2026-08-07T00:00:00.000Z";
const beforeExpiry = "2026-08-07T23:59:59.999Z";
const atExpiry = new Date(Date.parse(createdAt) + PENDING_HOST_FOLLOW_UP_TTL_MS).toISOString();

describe("pending host follow-up", () => {
  it("round-trips a bounded JSON action under local-only state", async () => {
    await withInitializedTempStore(async (storePath) => {
      const action = {
        action: "review_learning_candidates",
        candidate_pairs: [{ source_record_id: "rec_source", candidate_record_id: "rec_candidate" }]
      };
      const written = await writePendingHostFollowUp(storePath, { ...identity, action }, { now: () => createdAt });
      const read = await readPendingHostFollowUp(storePath, identity, { now: () => beforeExpiry });

      expect(read).toEqual(written);
      expect(read).toMatchObject({ version: 1, ...identity, action, created_at: createdAt, expires_at: atExpiry });
      expect(pendingHostFollowUpPath(storePath, identity)).toContain(join("state", "pending-host-follow-ups"));
    });
  });

  it("isolates follow-ups by project, host, session, and device", async () => {
    await withInitializedTempStore(async (storePath) => {
      await writePendingHostFollowUp(
        storePath,
        { ...identity, action: { id: "only-this-identity" } },
        { now: () => createdAt }
      );

      const mismatches = [
        { ...identity, project_id: "other-project" },
        { ...identity, host: "claude" as const },
        { ...identity, session_id: "other-session" },
        { ...identity, device_id: "device-b" }
      ];
      for (const mismatch of mismatches) {
        await expect(
          readPendingHostFollowUp(storePath, mismatch, { now: () => beforeExpiry })
        ).resolves.toBeUndefined();
        expect(pendingHostFollowUpPath(storePath, mismatch)).not.toBe(pendingHostFollowUpPath(storePath, identity));
      }
    });
  });

  it("returns undefined without throwing for corrupt, invalid, and expired state", async () => {
    await withInitializedTempStore(async (storePath) => {
      const path = pendingHostFollowUpPath(storePath, identity);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "{partial", "utf8");
      await expect(readPendingHostFollowUp(storePath, identity, { now: () => beforeExpiry })).resolves.toBeUndefined();

      await writeFile(
        path,
        `${JSON.stringify({
          version: 1,
          ...identity,
          action: { valid: true },
          created_at: createdAt,
          expires_at: atExpiry,
          unexpected: true
        })}\n`,
        "utf8"
      );
      await expect(readPendingHostFollowUp(storePath, identity, { now: () => beforeExpiry })).resolves.toBeUndefined();

      await writePendingHostFollowUp(storePath, { ...identity, action: { expired: true } }, { now: () => createdAt });
      await expect(readPendingHostFollowUp(storePath, identity, { now: () => atExpiry })).resolves.toBeUndefined();
    });
  });

  it("rejects non-JSON and oversized actions", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(
        writePendingHostFollowUp(storePath, { ...identity, action: { invalid: undefined } }, { now: () => createdAt })
      ).rejects.toThrow();
      await expect(
        writePendingHostFollowUp(
          storePath,
          { ...identity, action: "x".repeat(PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES + 1) },
          { now: () => createdAt }
        )
      ).rejects.toThrow(`exceeds ${PENDING_HOST_FOLLOW_UP_ACTION_LIMIT_BYTES} bytes`);
    });
  });

  it("never exposes a partial file during concurrent writes", async () => {
    await withInitializedTempStore(async (storePath) => {
      await writePendingHostFollowUp(storePath, { ...identity, action: { writer: -1 } }, { now: () => createdAt });
      const writes = Array.from({ length: 32 }, (_, writer) =>
        writePendingHostFollowUp(
          storePath,
          { ...identity, action: { writer, payload: "x".repeat(1_024) } },
          { now: () => createdAt }
        )
      );
      const reads = Array.from({ length: 64 }, async () => {
        const observed = await readPendingHostFollowUp(storePath, identity, { now: () => beforeExpiry });
        expect(observed).toBeDefined();
        expect(observed?.action).toEqual(expect.objectContaining({ writer: expect.any(Number) }));
      });

      await Promise.all([...writes, ...reads]);
      const path = pendingHostFollowUpPath(storePath, identity);
      const persisted = await readFile(path, "utf8");
      expect(() => JSON.parse(persisted)).not.toThrow();
      expect((await readdir(dirname(path))).filter((name) => name.includes(".tmp-"))).toEqual([]);
    });
  });
});
