import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listSoulDeliveryReceipts,
  readSoulDeliveryReceipt,
  soulDeliveryReceiptIdentity,
  writeSoulDeliveryReceipt
} from "../../src/core/soul-delivery-receipts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const sourceDigest = "1".repeat(64);
const renderedDigest = "2".repeat(64);

const input = {
  profile_id: "agent-codex",
  source_revision_ids: ["rev-b", "rev-a", "rev-a"],
  source_digest: sourceDigest,
  rendered_digest: renderedDigest,
  host: "codex" as const,
  project_id: "moryn",
  session_id: "session-a",
  device_id: "device-a",
  event: "session_start" as const,
  occurred_at: "2026-07-20T06:00:00.000Z"
};

describe("Soul delivery receipts", () => {
  it("normalizes revision order into a stable identity", () => {
    expect(soulDeliveryReceiptIdentity(input)).toBe(
      soulDeliveryReceiptIdentity({ ...input, source_revision_ids: ["rev-a", "rev-b"] })
    );
  });

  it("writes an idempotent digest-only local receipt", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await writeSoulDeliveryReceipt(storePath, input);
      const second = await writeSoulDeliveryReceipt(storePath, {
        ...input,
        source_revision_ids: ["rev-a", "rev-b"]
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.receipt).toEqual(first.receipt);
      expect(first.receipt.source_revision_ids).toEqual(["rev-a", "rev-b"]);
      expect(first.receipt.proof_scope).toBe("hook_output_prepared_not_host_acknowledged_or_obedience");

      const path = join(storePath, "state", "soul-delivery", `${first.receipt.receipt_id}.json`);
      const raw = await readFile(path, "utf8");
      expect(raw).toContain(renderedDigest);
      expect(raw).not.toContain("Soul clause text");
    });
  });

  it("lists valid receipts newest first and ignores malformed files", async () => {
    await withInitializedTempStore(async (storePath) => {
      const older = await writeSoulDeliveryReceipt(storePath, input);
      const newer = await writeSoulDeliveryReceipt(storePath, {
        ...input,
        event: "post_compact",
        occurred_at: "2026-07-20T06:05:00.000Z"
      });
      const directory = join(storePath, "state", "soul-delivery");
      await writeFile(join(directory, `${"f".repeat(64)}.json`), "{not-json", "utf8");
      await writeFile(join(directory, "README.txt"), "ignored", "utf8");

      const receipts = await listSoulDeliveryReceipts(storePath);
      expect(receipts.map((receipt) => receipt.receipt_id)).toEqual([
        newer.receipt.receipt_id,
        older.receipt.receipt_id
      ]);
    });
  });

  it("rejects invalid digests and empty revision sets", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(writeSoulDeliveryReceipt(storePath, { ...input, rendered_digest: "not-a-digest" })).rejects.toThrow(
        "rendered_digest must be a SHA-256 digest"
      );
      await expect(writeSoulDeliveryReceipt(storePath, { ...input, source_revision_ids: [] })).rejects.toThrow(
        "source_revision_ids must not be empty"
      );
      await expect(writeSoulDeliveryReceipt(storePath, { ...input, host: "unknown" as "codex" })).rejects.toThrow(
        "host must be codex or claude"
      );
    });
  });

  it("rejects tampered receipt content instead of trusting its filename", async () => {
    await withInitializedTempStore(async (storePath) => {
      const written = await writeSoulDeliveryReceipt(storePath, input);
      const path = join(storePath, "state", "soul-delivery", `${written.receipt.receipt_id}.json`);
      const tampered = { ...written.receipt, rendered_digest: "3".repeat(64) };
      await writeFile(path, `${JSON.stringify(tampered)}\n`, "utf8");
      expect(await readSoulDeliveryReceipt(storePath, written.receipt.receipt_id)).toBeUndefined();
    });
  });

  it("creates private receipt files", async () => {
    await withInitializedTempStore(async (storePath) => {
      const written = await writeSoulDeliveryReceipt(storePath, input);
      const path = join(storePath, "state", "soul-delivery", `${written.receipt.receipt_id}.json`);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    });
  });

  it("returns an empty list when no receipt directory exists", async () => {
    await withInitializedTempStore(async (storePath) => {
      await mkdir(join(storePath, "state"), { recursive: true });
      expect(await listSoulDeliveryReceipts(storePath)).toEqual([]);
    });
  });
});
