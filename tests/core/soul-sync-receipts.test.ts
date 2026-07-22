import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import {
  listSoulSyncReceipts,
  parseSoulSyncReceipt,
  type SoulSyncReceiptInput,
  soulRemoteIdentityDigest,
  writeSoulSyncReceipt
} from "../../src/core/soul-sync-receipts.js";

const input = (overrides: Partial<SoulSyncReceiptInput> = {}): SoulSyncReceiptInput => ({
  stage: "remote_pushed",
  operation: "push",
  profile_id: "soul_profile_user_owner",
  revision_id: `soul_revision_${"a".repeat(24)}`,
  event_id: `evt_soul_${"b".repeat(32)}`,
  event_path: `events/idempotent/evt_soul_${"b".repeat(32)}.json`,
  event_blob_oid: "c".repeat(40),
  projection_integrity_digest: "d".repeat(64),
  approval_verification: "not_checked",
  remote_name: "origin",
  remote_ref: "refs/heads/main",
  remote_identity_digest: "e".repeat(64),
  remote_commit: "f".repeat(40),
  ...overrides
});

describe("Soul remote sync receipts", () => {
  it("writes metadata-only receipts idempotently with private state permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-receipt-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, { id: () => "device-receipt" });
      const remoteUrl = "https://user:token@example.test/private.git";
      const receiptInput = input({ remote_identity_digest: soulRemoteIdentityDigest(remoteUrl) });
      const first = await writeSoulSyncReceipt(store, receiptInput);
      const second = await writeSoulSyncReceipt(store, receiptInput);

      expect(first.created).toBe(true);
      expect(second).toEqual({ created: false, receipt: first.receipt });
      expect(await listSoulSyncReceipts(store)).toEqual([first.receipt]);

      const directory = join(store, "state", "soul-sync");
      const path = join(directory, `${first.receipt.receipt_id}.json`);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const serialized = await readFile(path, "utf8");
      expect(serialized).not.toContain("private clause text");
      expect(serialized).not.toContain(remoteUrl);
      expect(first.receipt.remote_identity_digest).toBe(soulRemoteIdentityDigest(remoteUrl));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stage claims whose operation or approval semantics are inconsistent", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-semantics-"));
    const store = join(root, "store");
    try {
      await initializeStore(store, { id: () => "device-semantics" });
      await expect(
        writeSoulSyncReceipt(
          store,
          input({
            stage: "remote_pulled_and_verified",
            operation: "pull",
            approval_verification: "not_checked"
          })
        )
      ).rejects.toThrow("remote_pulled_and_verified proof semantics");
      await expect(
        writeSoulSyncReceipt(
          store,
          input({
            stage: "remote_pulled_and_verified",
            operation: "push",
            approval_verification: "verified"
          })
        )
      ).rejects.toThrow("remote_pulled_and_verified proof semantics");
      expect(await listSoulSyncReceipts(store)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects integrity tampering", () => {
    expect(
      parseSoulSyncReceipt({
        version: 1,
        proof_scope: "exact_git_event_blob",
        ...input(),
        receipt_id: `soul_sync_${"0".repeat(32)}`,
        integrity_digest: "0".repeat(64)
      })
    ).toBeUndefined();
  });
});
