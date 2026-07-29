import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeStore } from "../../src/core/config.js";
import { OperationDeadlineExceededError, withOperationDeadline } from "../../src/core/operation-deadline.js";
import type { SoulClauseInput } from "../../src/core/soul-profile.js";
import {
  approveSoulProfileDraft,
  createSoulProfileDraft,
  readSoulProfileStatus
} from "../../src/core/soul-profile-management.js";
import { listSoulSyncReceipts, soulRemoteIdentityDigest } from "../../src/core/soul-sync-receipts.js";
import { buildDashboardSoulStudio } from "../../src/observability/dashboard-v04.js";
import { initializeGitSync, pullGitSync, pushGitSync } from "../../src/sync/git.js";
import {
  captureSoulGitPushRemoteIdentityDigest,
  recordPushedSoulSyncReceipts
} from "../../src/sync/soul-git-receipts.js";

const exec = promisify(execFile);
const localOnlyMarker = "LOCAL_ONLY_MARKER_7e78592b";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

const clause = (clauseKey: string, text: string, distribution: "local_only" | "personal_sync"): SoulClauseInput => ({
  clause_key: clauseKey,
  category: "collaboration",
  text,
  distribution,
  priority: 80
});

async function approvedMixedProfile(storePath: string, deviceId: string) {
  const source = { client: "user", device_id: deviceId };
  const draft = await createSoulProfileDraft(storePath, {
    subject: { kind: "agent", subject_id: "codex" },
    clauses: [
      clause("portable-style", "Explain remote evidence precisely.", "personal_sync"),
      clause("device-note", localOnlyMarker, "local_only")
    ],
    source,
    occurred_at: "2026-07-21T00:01:00.000Z"
  });
  const approved = await approveSoulProfileDraft(storePath, {
    revision_id: draft.revision.revision_id,
    confirmed: true,
    source,
    occurred_at: "2026-07-21T00:02:00.000Z"
  });
  return { draft, approved };
}

async function git(storePath: string, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: storePath })).stdout.trim();
}

async function bareGit(repository: string, ...args: string[]): Promise<string> {
  return (await exec("git", ["--git-dir", repository, ...args])).stdout.trim();
}

describe("portable Soul Git stage receipts", () => {
  it("bounds Soul receipt Git inspection with the inherited operation deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-receipt-deadline-"));
    const store = join(root, "store");
    const fakeBin = join(root, "fake-bin");
    const fakeGit = join(fakeBin, "git");
    await mkdir(store);
    await mkdir(fakeBin);
    await writeFile(
      fakeGit,
      [
        "#!/bin/sh",
        'if [ "$1" = "ls-tree" ]; then',
        "  printf '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\tevents/idempotent/evt_soul_00000000000000000000000000000000.json\\0'",
        "  exit 0",
        "fi",
        "trap '' TERM",
        "while :; do sleep 1; done"
      ].join("\n"),
      "utf8"
    );
    await chmod(fakeGit, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
    const startedAt = Date.now();
    try {
      await expect(
        withOperationDeadline(300, () => recordPushedSoulSyncReceipts(store, "remote-digest", "deadbeef"))
      ).rejects.toBeInstanceOf(OperationDeadlineExceededError);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("proves exact pushed, pulled, and init-imported projections without leaking local-only clauses", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-evidence-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "device-a");
    const storeB = join(root, "device-b");
    const storeC = join(root, "device-c");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, { id: () => "device-a" });
      await initializeStore(storeB, { id: () => "device-b" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);

      const { approved } = await approvedMixedProfile(storeA, "device-a");
      await expect(pushGitSync(storeA, { message: "push portable Soul proof" })).resolves.toMatchObject({
        pushed: true
      });
      await expect(pullGitSync(storeB)).resolves.toMatchObject({ pulled: true });

      await initializeStore(storeC, { id: () => "device-c" });
      await expect(initializeGitSync(storeC, remote)).resolves.toMatchObject({ ok: true });

      const pushed = (await listSoulSyncReceipts(storeA)).filter((receipt) => receipt.stage === "remote_pushed");
      const pulled = (await listSoulSyncReceipts(storeB)).filter(
        (receipt) => receipt.stage === "remote_pulled_and_verified"
      );
      const imported = (await listSoulSyncReceipts(storeC)).filter(
        (receipt) => receipt.stage === "remote_pulled_and_verified"
      );
      expect(pushed.length).toBeGreaterThanOrEqual(2);
      expect(pulled.length).toBeGreaterThanOrEqual(2);
      expect(imported.length).toBeGreaterThanOrEqual(2);
      expect(imported.every((receipt) => receipt.operation === "init")).toBe(true);

      for (const [store, receipts] of [
        [storeA, pushed],
        [storeB, pulled],
        [storeC, imported]
      ] as const) {
        for (const receipt of receipts) {
          expect(receipt.remote_identity_digest).toBe(soulRemoteIdentityDigest(remote));
          expect(receipt.remote_ref).toBe("refs/heads/main");
          expect(receipt.profile_id).toBe(approved.revision.profile_id);
          expect(await git(store, "rev-parse", `${receipt.remote_commit}:${receipt.event_path}`)).toBe(
            receipt.event_blob_oid
          );
        }
      }
      expect(pulled.find((receipt) => receipt.revision_id === approved.revision.revision_id)).toMatchObject({
        approval_verification: "verified"
      });

      const statusA = await readSoulProfileStatus(storeA);
      const statusB = await readSoulProfileStatus(storeB);
      const pushedRevision = statusA.profiles
        .flatMap((profile) => profile.revisions)
        .find((revision) => revision.revision_id === approved.revision.revision_id);
      const pulledRevision = statusB.profiles
        .flatMap((profile) => profile.revisions)
        .find((revision) => revision.revision_id === approved.revision.revision_id);
      expect(pushedRevision).toMatchObject({
        personal_sync_saved: true,
        remote_pushed: true,
        remote_pulled_and_verified: false
      });
      expect(pushedRevision?.remote_pushed_receipt_ids).not.toHaveLength(0);
      expect(pulledRevision).toMatchObject({
        personal_sync_saved: true,
        approval_receipt_verified: true,
        remote_pushed: false,
        remote_pulled_and_verified: true
      });
      expect(pulledRevision?.remote_pulled_and_verified_receipt_ids).not.toHaveLength(0);

      const dashboard = await buildDashboardSoulStudio(storeB, {});
      expect(
        dashboard.profiles
          .flatMap((profile) => profile.revisions)
          .find((revision) => revision.revision_id === approved.revision.revision_id)
      ).toMatchObject({
        remote_pushed: false,
        remote_pushed_receipt_ids: [],
        remote_pulled_and_verified: true
      });

      for (const store of [storeA, storeB, storeC]) {
        const serialized = (await listSoulSyncReceipts(store)).map((receipt) => JSON.stringify(receipt)).join("\n");
        expect(serialized).not.toContain(localOnlyMarker);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim remote_pushed when the Git server rejects the push", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-rejected-"));
    const remote = join(root, "remote.git");
    const store = join(root, "device-a");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device-a" });
      await initializeGitSync(store, remote);
      const { approved } = await approvedMixedProfile(store, "device-a");
      const hook = join(remote, "hooks", "pre-receive");
      await writeFile(hook, "#!/bin/sh\nexit 1\n", "utf8");
      await chmod(hook, 0o700);

      await expect(pushGitSync(store, { message: "rejected portable Soul" })).rejects.toThrow();
      expect((await listSoulSyncReceipts(store)).filter((receipt) => receipt.stage === "remote_pushed")).toEqual([]);
      const revision = (await readSoulProfileStatus(store)).profiles
        .flatMap((profile) => profile.revisions)
        .find((entry) => entry.revision_id === approved.revision.revision_id);
      expect(revision).toMatchObject({ personal_sync_saved: true, remote_pushed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds pushed receipts to the first effective push URL instead of the fetch URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-pushurl-"));
    const fetchRemote = join(root, "fetch.git");
    const pushRemote = join(root, "push.git");
    const store = join(root, "device-a");
    try {
      await exec("git", ["init", "--bare", fetchRemote]);
      await exec("git", ["init", "--bare", pushRemote]);
      await initializeStore(store, { id: () => "device-a" });
      await initializeGitSync(store, fetchRemote);
      const fetchHeadBeforePush = await bareGit(fetchRemote, "rev-parse", "refs/heads/main");

      await git(store, "config", "--add", "remote.origin.pushurl", pushRemote);
      await git(store, "config", "--add", "remote.origin.pushurl", `file://${pushRemote}`);
      const { approved } = await approvedMixedProfile(store, "device-a");
      await expect(pushGitSync(store, { message: "push Soul to explicit push URLs" })).resolves.toMatchObject({
        pushed: true
      });

      const head = await git(store, "rev-parse", "HEAD");
      expect(await bareGit(pushRemote, "rev-parse", "refs/heads/main")).toBe(head);
      expect(await bareGit(fetchRemote, "rev-parse", "refs/heads/main")).toBe(fetchHeadBeforePush);
      const pushed = (await listSoulSyncReceipts(store)).filter((receipt) => receipt.stage === "remote_pushed");
      expect(pushed.find((receipt) => receipt.revision_id === approved.revision.revision_id)).toBeDefined();
      expect(pushed.every((receipt) => receipt.remote_identity_digest === soulRemoteIdentityDigest(pushRemote))).toBe(
        true
      );
      expect(pushed.some((receipt) => receipt.remote_identity_digest === soulRemoteIdentityDigest(fetchRemote))).toBe(
        false
      );
      expect(
        pushed.some((receipt) => receipt.remote_identity_digest === soulRemoteIdentityDigest(`file://${pushRemote}`))
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams a tree larger than execFile's default buffer without collecting non-Soul paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-large-tree-"));
    const remote = join(root, "remote.git");
    const store = join(root, "device-a");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(store, { id: () => "device-a" });
      await initializeGitSync(store, remote);
      const { draft, approved } = await approvedMixedProfile(store, "device-a");

      const noiseSuffix = "x".repeat(180);
      const noiseCount = 4_500;
      for (let start = 0; start < noiseCount; start += 250) {
        await Promise.all(
          Array.from({ length: Math.min(250, noiseCount - start) }, (_, offset) => {
            const sequence = String(start + offset).padStart(4, "0");
            return writeFile(
              join(store, "events", "idempotent", `evt_noise_${sequence}_${noiseSuffix}.json`),
              "{}\n",
              "utf8"
            );
          })
        );
      }
      await git(store, "add", "events");
      await git(store, "commit", "--quiet", "-m", "Add large non-Soul event tree");
      const head = await git(store, "rev-parse", "HEAD");
      const fullTree = await exec("git", ["ls-tree", "-r", "-z", head, "--", "events/idempotent"], {
        cwd: store,
        maxBuffer: 8 * 1024 * 1024
      });
      expect(Buffer.byteLength(fullTree.stdout)).toBeGreaterThan(1024 * 1024);

      const remoteIdentityDigest = await captureSoulGitPushRemoteIdentityDigest(store);
      await git(store, "push", "-u", "origin", "main");
      await expect(recordPushedSoulSyncReceipts(store, remoteIdentityDigest, head)).resolves.toBeUndefined();

      const expectedEventIds = [
        draft.persistence.personal_sync_event_id,
        approved.persistence.personal_sync_event_id
      ].filter((eventId): eventId is string => eventId !== undefined);
      const pushed = (await listSoulSyncReceipts(store)).filter((receipt) => receipt.stage === "remote_pushed");
      expect([...new Set(pushed.map((receipt) => receipt.event_id))].sort()).toEqual(expectedEventIds.sort());
      expect(pushed.every((receipt) => receipt.event_path.startsWith("events/idempotent/evt_soul_"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim pulled-and-verified for an approved projection missing its attestation", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-soul-sync-unverified-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "device-a");
    const storeB = join(root, "device-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storeA, { id: () => "device-a" });
      await initializeStore(storeB, { id: () => "device-b" });
      await initializeGitSync(storeA, remote);
      await initializeGitSync(storeB, remote);
      const { approved } = await approvedMixedProfile(storeA, "device-a");
      const eventId = approved.persistence.personal_sync_event_id!;
      const eventPath = join(storeA, "events", "idempotent", `${eventId}.json`);
      const event = JSON.parse(await readFile(eventPath, "utf8")) as {
        record: { content: { soul_profile_projection: Record<string, unknown> } };
      };
      const envelope = event.record.content.soul_profile_projection;
      delete envelope.approval_attestation;
      const { integrity_digest: _oldDigest, ...identity } = envelope;
      envelope.integrity_digest = createHash("sha256")
        .update(JSON.stringify(canonicalValue(identity)))
        .digest("hex");
      await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`, "utf8");

      await pushGitSync(storeA, { message: "push projection without approval attestation" });
      await pullGitSync(storeA);
      await pullGitSync(storeB);

      for (const store of [storeA, storeB]) {
        expect(
          (await listSoulSyncReceipts(store)).find(
            (receipt) =>
              receipt.stage === "remote_pulled_and_verified" && receipt.revision_id === approved.revision.revision_id
          )
        ).toBeUndefined();
      }
      const localOverlayRevision = (await readSoulProfileStatus(storeA)).profiles
        .flatMap((profile) => profile.revisions)
        .find((entry) => entry.revision_id === approved.revision.revision_id);
      expect(localOverlayRevision).toMatchObject({
        approval_receipt_verified: true,
        remote_pulled_and_verified: false
      });
      const revision = (await readSoulProfileStatus(storeB)).profiles
        .flatMap((profile) => profile.revisions)
        .find((entry) => entry.revision_id === approved.revision.revision_id);
      expect(revision).toMatchObject({
        approved: true,
        approval_receipt_verified: false,
        remote_pulled_and_verified: false,
        remote_pulled_and_verified_receipt_ids: []
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
