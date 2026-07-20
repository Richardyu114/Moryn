import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { writeSoulDeliveryReceipt } from "../../src/core/soul-delivery-receipts.js";
import {
  approveSoulProfileDraft,
  createSoulProfileDraft,
  readSoulProfileStatus,
  rollbackSoulProfile,
  soulProfileRevisionDigest
} from "../../src/core/soul-profile-management.js";
import { readSoulProfileRevisions } from "../../src/core/soul-profile-store.js";
import { appendEventIfAbsent, readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const source = { client: "user", device_id: "device-a", session_id: "session-a" };
const firstAt = "2026-07-20T08:00:00.000Z";
const secondAt = "2026-07-20T08:05:00.000Z";
const thirdAt = "2026-07-20T08:10:00.000Z";
const secret = "LOCAL SOUL SECRET MUST NEVER SYNC";

const initialClauses = [
  {
    clause_key: "mission",
    category: "mission" as const,
    text: "Carry a consistent persona across hosts.",
    distribution: "personal_sync" as const
  },
  {
    clause_key: "private-context",
    category: "collaboration" as const,
    text: secret,
    distribution: "local_only" as const
  }
];

async function copyEvents(fromStorePath: string, toStorePath: string): Promise<void> {
  for (const event of await readEvents(fromStorePath)) {
    await appendEventIfAbsent(toStorePath, event);
  }
  await rebuildDerivedViews(toStorePath);
}

describe("Soul Profile management", () => {
  it("creates stable direct and derived drafts without leaking local-only clauses", async () => {
    await withInitializedTempStore(async (storePath) => {
      const direct = await createSoulProfileDraft(storePath, {
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: initialClauses,
        source,
        occurred_at: firstAt
      });
      const retry = await createSoulProfileDraft(storePath, {
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: initialClauses,
        source,
        occurred_at: secondAt
      });
      expect(direct.created).toBe(true);
      expect(direct.revision).toMatchObject({ generation: 1, parent_revision_ids: [], state: "draft" });
      expect(retry).toMatchObject({ created: false, revision: { revision_id: direct.revision.revision_id } });
      await expect(
        rollbackSoulProfile(storePath, {
          target_revision_id: direct.revision.revision_id,
          profile_id: direct.revision.profile_id,
          confirmed: true,
          source,
          occurred_at: secondAt
        })
      ).rejects.toThrow("never an approved active revision");
      expect(await readSoulProfileStatus(storePath)).toMatchObject({
        compilation: { status: "not_configured", deliverable: false }
      });

      const derived = await createSoulProfileDraft(storePath, {
        from_revision_id: direct.revision.revision_id,
        clauses: [{ ...initialClauses[0], text: "Keep the persona consistent and evidence-led." }, initialClauses[1]],
        source,
        occurred_at: secondAt
      });
      const derivedRetry = await createSoulProfileDraft(storePath, {
        from_revision_id: direct.revision.revision_id,
        clauses: [{ ...initialClauses[0], text: "Keep the persona consistent and evidence-led." }, initialClauses[1]],
        source,
        occurred_at: thirdAt
      });
      expect(derived.revision).toMatchObject({
        generation: 2,
        parent_revision_ids: [direct.revision.revision_id]
      });
      expect(derivedRetry).toMatchObject({ created: false, revision: { revision_id: derived.revision.revision_id } });
      expect(JSON.stringify(await readEvents(storePath))).not.toContain(secret);
    });
  });

  it("requires explicit confirmation and activates a draft through a new revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      const draft = await createSoulProfileDraft(storePath, {
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: initialClauses,
        source,
        occurred_at: firstAt
      });
      await expect(
        approveSoulProfileDraft(storePath, {
          revision_id: draft.revision.revision_id,
          source,
          occurred_at: secondAt
        })
      ).rejects.toThrow("explicit user confirmation");

      const approved = await approveSoulProfileDraft(storePath, {
        revision_id: draft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: secondAt
      });
      expect(approved.revision).toMatchObject({
        generation: 2,
        parent_revision_ids: [draft.revision.revision_id],
        state: "active",
        approved: true,
        approval_receipt_id: approved.approval_receipt.receipt_id
      });
      expect(approved.revision.revision_id).not.toBe(draft.revision.revision_id);
      expect(approved.approval_receipt).toMatchObject({
        action: "approve",
        source_revision_id: draft.revision.revision_id,
        approved_revision_id: approved.revision.revision_id,
        source_revision_digest: soulProfileRevisionDigest(draft.revision),
        confirmed: true
      });

      const receiptPath = join(storePath, "state", "soul-approvals", `${approved.approval_receipt.receipt_id}.json`);
      expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
      expect(await readFile(receiptPath, "utf8")).not.toContain(secret);
      expect(JSON.stringify(await readEvents(storePath))).not.toContain(secret);

      const retry = await approveSoulProfileDraft(storePath, {
        revision_id: draft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: thirdAt
      });
      expect(retry).toMatchObject({
        created: false,
        approval_receipt_created: false,
        revision: { revision_id: approved.revision.revision_id }
      });
    });
  });

  it("verifies a remote approval attestation and compiles the portable active revision", async () => {
    await withInitializedTempStore(async (sourceStorePath) => {
      await withInitializedTempStore(async (remoteStorePath) => {
        const draft = await createSoulProfileDraft(sourceStorePath, {
          subject: { kind: "agent", subject_id: "moryn" },
          clauses: initialClauses,
          source,
          occurred_at: firstAt
        });
        const approved = await approveSoulProfileDraft(sourceStorePath, {
          revision_id: draft.revision.revision_id,
          confirmed: true,
          source,
          occurred_at: secondAt
        });

        await copyEvents(sourceStorePath, remoteStorePath);

        const loaded = await readSoulProfileRevisions(remoteStorePath);
        expect(loaded.local_revision_ids).toEqual([]);
        expect(loaded.partial_revision_ids).toEqual([draft.revision.revision_id, approved.revision.revision_id].sort());
        expect(loaded.verified_approval_revision_ids).toEqual([approved.revision.revision_id]);
        expect(loaded.revisions_by_id[approved.revision.revision_id]).toMatchObject({
          state: "active",
          approved: true
        });

        const status = await readSoulProfileStatus(remoteStorePath);
        expect(status.compilation).toMatchObject({
          status: "ready",
          deliverable: true,
          selected_revision_ids: [approved.revision.revision_id]
        });
        expect(status.profiles[0]?.revisions).toContainEqual(
          expect.objectContaining({
            revision_id: approved.revision.revision_id,
            approval_receipt_verified: true,
            is_effective: true
          })
        );
        expect(status.approval_receipts).toContainEqual(
          expect.objectContaining({ receipt_id: approved.approval_receipt.receipt_id })
        );
        expect(JSON.stringify(status)).not.toContain(secret);
      });
    });
  });

  it("preserves the newest local-only clauses when deriving from a remote partial parent", async () => {
    await withInitializedTempStore(async (sourceStorePath) => {
      await withInitializedTempStore(async (localStorePath) => {
        const localSecret = "DEVICE B LOCAL SOUL CONTEXT";
        const remoteSecret = "DEVICE A LOCAL SOUL CONTEXT";

        const createBase = async (storePath: string) => {
          const draft = await createSoulProfileDraft(storePath, {
            subject: { kind: "agent", subject_id: "moryn" },
            clauses: initialClauses,
            source,
            occurred_at: firstAt
          });
          return approveSoulProfileDraft(storePath, {
            revision_id: draft.revision.revision_id,
            confirmed: true,
            source,
            occurred_at: secondAt
          });
        };
        const sourceBase = await createBase(sourceStorePath);
        const localBase = await createBase(localStorePath);
        expect(localBase.revision.revision_id).toBe(sourceBase.revision.revision_id);

        const localDraft = await createSoulProfileDraft(localStorePath, {
          from_revision_id: localBase.revision.revision_id,
          clauses: [initialClauses[0], { ...initialClauses[1], text: localSecret }],
          source,
          occurred_at: thirdAt
        });
        const local = await approveSoulProfileDraft(localStorePath, {
          revision_id: localDraft.revision.revision_id,
          confirmed: true,
          source,
          occurred_at: "2026-07-20T08:15:00.000Z"
        });

        const remoteDraft = await createSoulProfileDraft(sourceStorePath, {
          from_revision_id: sourceBase.revision.revision_id,
          clauses: [
            { ...initialClauses[0], text: "Use the first remotely updated persona." },
            { ...initialClauses[1], text: remoteSecret }
          ],
          source,
          occurred_at: thirdAt
        });
        const remote = await approveSoulProfileDraft(sourceStorePath, {
          revision_id: remoteDraft.revision.revision_id,
          confirmed: true,
          source,
          occurred_at: "2026-07-20T08:16:00.000Z"
        });
        const newestRemoteDraft = await createSoulProfileDraft(sourceStorePath, {
          from_revision_id: remote.revision.revision_id,
          clauses: [
            { ...initialClauses[0], text: "Use the newest remotely updated persona." },
            { ...initialClauses[1], text: remoteSecret }
          ],
          source,
          occurred_at: "2026-07-20T08:17:00.000Z"
        });
        const newestRemote = await approveSoulProfileDraft(sourceStorePath, {
          revision_id: newestRemoteDraft.revision.revision_id,
          confirmed: true,
          source,
          occurred_at: "2026-07-20T08:18:00.000Z"
        });
        expect(newestRemote.revision.generation).toBeGreaterThan(local.revision.generation);

        await copyEvents(sourceStorePath, localStorePath);
        const beforeDerive = await readSoulProfileRevisions(localStorePath);
        expect(beforeDerive.partial_revision_ids).toContain(newestRemote.revision.revision_id);
        expect(beforeDerive.local_revision_ids).not.toContain(newestRemote.revision.revision_id);

        const derived = await createSoulProfileDraft(localStorePath, {
          from_revision_id: newestRemote.revision.revision_id,
          clauses: [{ ...initialClauses[0], text: "Adopt the remote persona on device B." }],
          source,
          occurred_at: "2026-07-20T08:20:00.000Z"
        });
        expect(derived.revision.clauses).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ distribution: "local_only", text: localSecret }),
            expect.objectContaining({ distribution: "personal_sync", text: "Adopt the remote persona on device B." })
          ])
        );
        expect(derived.revision.clauses.map((clause) => clause.text)).not.toContain(remoteSecret);

        const serializedEvents = JSON.stringify(await readEvents(localStorePath));
        expect(serializedEvents).not.toContain(localSecret);
        expect(serializedEvents).not.toContain(remoteSecret);
      });
    });
  });

  it("reports heads, storage, compilation, conflicts, and current delivery without clause payloads", async () => {
    await withInitializedTempStore(async (storePath) => {
      const draft = await createSoulProfileDraft(storePath, {
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: initialClauses,
        source,
        occurred_at: firstAt
      });
      const approved = await approveSoulProfileDraft(storePath, {
        revision_id: draft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: secondAt
      });
      const beforeDelivery = await readSoulProfileStatus(storePath, { project_id: "moryn" });
      expect(beforeDelivery.profiles[0]).toMatchObject({
        head_revision_ids: [approved.revision.revision_id],
        active_revision_id: approved.revision.revision_id,
        selection_status: "active",
        conflicted: false
      });
      expect(beforeDelivery.profiles[0]?.revisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            revision_id: approved.revision.revision_id,
            local_saved: true,
            personal_sync_saved: true,
            approval_receipt_verified: true,
            is_effective: true
          })
        ])
      );
      expect(beforeDelivery.compilation).toMatchObject({
        status: "ready",
        deliverable: true,
        selected_revision_ids: [approved.revision.revision_id]
      });
      expect(JSON.stringify(beforeDelivery)).not.toContain(secret);

      const delivery = await writeSoulDeliveryReceipt(storePath, {
        profile_id: approved.revision.profile_id,
        source_revision_ids: [approved.revision.revision_id],
        source_digest: beforeDelivery.compilation.source_digest,
        rendered_digest: beforeDelivery.compilation.rendered_digest,
        host: "codex",
        project_id: "moryn",
        session_id: "session-a",
        device_id: "device-a",
        event: "session_start",
        occurred_at: thirdAt
      });
      const afterDelivery = await readSoulProfileStatus(storePath, { project_id: "moryn" });
      expect(afterDelivery.delivery).toMatchObject({
        host_context_prepared: true,
        current_receipt_ids: [delivery.receipt.receipt_id],
        receipts: [expect.objectContaining({ receipt_id: delivery.receipt.receipt_id, current_compilation: true })]
      });
      expect(JSON.stringify(afterDelivery)).not.toContain(secret);
    });
  });

  it("surfaces concurrent draft heads as a profile conflict", async () => {
    await withInitializedTempStore(async (storePath) => {
      const baseDraft = await createSoulProfileDraft(storePath, {
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: [initialClauses[0]],
        source,
        occurred_at: firstAt
      });
      const base = await approveSoulProfileDraft(storePath, {
        revision_id: baseDraft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: secondAt
      });
      const left = await createSoulProfileDraft(storePath, {
        from_revision_id: base.revision.revision_id,
        clauses: [{ ...initialClauses[0], text: "Prefer the left branch." }],
        source,
        occurred_at: thirdAt
      });
      const right = await createSoulProfileDraft(storePath, {
        from_revision_id: base.revision.revision_id,
        clauses: [{ ...initialClauses[0], text: "Prefer the right branch." }],
        source,
        occurred_at: "2026-07-20T08:11:00.000Z"
      });

      const status = await readSoulProfileStatus(storePath);
      expect(status.profiles[0]).toMatchObject({
        conflicted: true,
        active_revision_id: base.revision.revision_id
      });
      expect(status.profiles[0]?.head_revision_ids).toEqual(
        [left.revision.revision_id, right.revision.revision_id].sort()
      );
      expect(status.profiles[0]?.conflicted_revision_ids).toEqual(
        [left.revision.revision_id, right.revision.revision_id].sort()
      );
    });
  });

  it("rolls back by appending an approved revision that copies old content", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstDraft = await createSoulProfileDraft(storePath, {
        subject: { kind: "agent", subject_id: "moryn" },
        clauses: initialClauses,
        source,
        occurred_at: firstAt
      });
      const first = await approveSoulProfileDraft(storePath, {
        revision_id: firstDraft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: secondAt
      });
      const changedDraft = await createSoulProfileDraft(storePath, {
        from_revision_id: first.revision.revision_id,
        clauses: [
          { ...initialClauses[0], text: "Use a deliberately different persona." },
          { ...initialClauses[1], text: "A DIFFERENT LOCAL SECRET" }
        ],
        source,
        occurred_at: thirdAt
      });
      const changed = await approveSoulProfileDraft(storePath, {
        revision_id: changedDraft.revision.revision_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-20T08:15:00.000Z"
      });
      await expect(
        rollbackSoulProfile(storePath, {
          target_revision_id: first.revision.revision_id,
          profile_id: first.revision.profile_id,
          source,
          occurred_at: "2026-07-20T08:20:00.000Z"
        })
      ).rejects.toThrow("explicit user confirmation");

      const rollback = await rollbackSoulProfile(storePath, {
        target_revision_id: first.revision.revision_id,
        profile_id: first.revision.profile_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-20T08:20:00.000Z"
      });
      expect(rollback.revision.revision_id).not.toBe(first.revision.revision_id);
      expect(rollback.revision.revision_id).not.toBe(changed.revision.revision_id);
      expect(rollback.revision.generation).toBeGreaterThan(changed.revision.generation);
      expect(rollback.revision.parent_revision_ids).toEqual(
        [first.revision.revision_id, changed.revision.revision_id].sort()
      );
      expect(rollback.revision.clauses).toEqual(first.revision.clauses);
      expect(rollback.approval_receipt.action).toBe("rollback");

      const retry = await rollbackSoulProfile(storePath, {
        target_revision_id: first.revision.revision_id,
        profile_id: first.revision.profile_id,
        confirmed: true,
        source,
        occurred_at: "2026-07-20T08:25:00.000Z"
      });
      expect(retry).toMatchObject({
        created: false,
        approval_receipt_created: false,
        revision: { revision_id: rollback.revision.revision_id }
      });

      const loaded = await readSoulProfileRevisions(storePath);
      expect(loaded.revisions_by_id[first.revision.revision_id]?.clauses).toEqual(first.revision.clauses);
      expect(loaded.revisions_by_id[changed.revision.revision_id]?.clauses).toEqual(changed.revision.clauses);
      expect(loaded.revisions_by_id[rollback.revision.revision_id]?.clauses).toEqual(first.revision.clauses);
      const status = await readSoulProfileStatus(storePath);
      expect(status.profiles[0]).toMatchObject({
        head_revision_ids: [rollback.revision.revision_id],
        active_revision_id: rollback.revision.revision_id
      });
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(JSON.stringify(await readEvents(storePath))).not.toContain(secret);
    });
  });
});
