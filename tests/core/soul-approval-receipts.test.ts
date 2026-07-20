import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listSoulApprovalReceipts,
  parseSoulApprovalReceipt,
  readSoulApprovalReceipt,
  soulApprovalReceiptIdentity,
  writeSoulApprovalReceipt
} from "../../src/core/soul-approval-receipts.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const input = {
  action: "approve" as const,
  profile_id: "soul_profile_test",
  source_revision_id: `soul_revision_${"1".repeat(24)}`,
  approved_revision_id: `soul_revision_${"2".repeat(24)}`,
  source_revision_digest: "3".repeat(64),
  source_projection_digest: "4".repeat(64),
  confirmed: true as const,
  approved_at: "2026-07-20T08:00:00.000Z",
  source: { client: "user", device_id: "device-a" }
};

describe("Soul approval receipts", () => {
  it("derives a stable identity from normalized metadata", () => {
    expect(soulApprovalReceiptIdentity(input)).toEqual(
      soulApprovalReceiptIdentity({ ...input, source: { device_id: "device-a", client: "user" } })
    );
    expect(soulApprovalReceiptIdentity(input).integrity_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("writes an idempotent metadata-only receipt with private permissions", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await writeSoulApprovalReceipt(storePath, input);
      const second = await writeSoulApprovalReceipt(storePath, input);
      expect(first.created).toBe(true);
      expect(second).toEqual({ created: false, receipt: first.receipt });

      const directory = join(storePath, "state", "soul-approvals");
      const path = join(directory, `${first.receipt.receipt_id}.json`);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const raw = await readFile(path, "utf8");
      expect(raw).toContain(first.receipt.integrity_digest);
      expect(raw).not.toContain("LOCAL SOUL CLAUSE");
      expect(await listSoulApprovalReceipts(storePath)).toEqual([first.receipt]);
    });
  });

  it("rejects missing confirmation, invalid timestamps, and tampered receipts", async () => {
    await withInitializedTempStore(async (storePath) => {
      await expect(writeSoulApprovalReceipt(storePath, { ...input, confirmed: false as true })).rejects.toThrow(
        "explicit user confirmation"
      );
      await expect(writeSoulApprovalReceipt(storePath, { ...input, approved_at: "not-a-time" })).rejects.toThrow(
        "approved_at"
      );

      const written = await writeSoulApprovalReceipt(storePath, input);
      expect(parseSoulApprovalReceipt(written.receipt)).toEqual(written.receipt);
      expect(
        parseSoulApprovalReceipt({ ...written.receipt, source_projection_digest: "5".repeat(64) })
      ).toBeUndefined();
      const path = join(storePath, "state", "soul-approvals", `${written.receipt.receipt_id}.json`);
      await writeFile(path, `${JSON.stringify({ ...written.receipt, action: "rollback" })}\n`, "utf8");
      expect(await readSoulApprovalReceipt(storePath, written.receipt.receipt_id)).toBeUndefined();
      expect(await listSoulApprovalReceipts(storePath)).toEqual([]);
    });
  });
});
