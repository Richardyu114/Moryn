import { createHash } from "node:crypto";
import { chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { compileEffectiveSoul, createSoulProfileRevision } from "../../src/core/soul-profile.js";
import { approveSoulProfileDraft, createSoulProfileDraft } from "../../src/core/soul-profile-management.js";
import {
  parseSoulProfileProjection,
  readSoulProfileRevisions,
  type SoulProfileProjectionEnvelope,
  writeSoulProfileRevision
} from "../../src/core/soul-profile-store.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const source = { client: "user", device_id: "device-a" };
const occurredAt = "2026-07-20T00:00:00.000Z";
const approvedAt = "2026-07-20T00:01:00.000Z";

function revision(input: {
  local?: boolean;
  mixed?: boolean;
  state?: "draft" | "active" | "superseded" | "conflicted";
  approved?: boolean;
  approval_receipt_id?: string;
}) {
  return createSoulProfileRevision({
    subject: { kind: "agent", subject_id: "moryn" },
    generation: 1,
    clauses: [
      {
        clause_key: "mission",
        category: "mission",
        text: "Carry the same persona across hosts.",
        distribution: input.local ? "local_only" : "personal_sync"
      },
      ...(input.mixed
        ? [
            {
              clause_key: "device-secret",
              category: "collaboration" as const,
              text: "LOCAL PAYLOAD MUST NEVER SYNC",
              distribution: "local_only" as const
            }
          ]
        : [])
    ],
    state: input.state ?? "draft",
    approved: input.approved ?? false,
    approval_receipt_id: input.approval_receipt_id,
    created_at: occurredAt
  });
}

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

function envelopeWithAttestation(
  envelope: SoulProfileProjectionEnvelope,
  approvalAttestation: SoulProfileProjectionEnvelope["approval_attestation"]
): SoulProfileProjectionEnvelope {
  const { integrity_digest: _integrityDigest, approval_attestation: _oldAttestation, ...identity } = envelope;
  const normalized = {
    ...identity,
    ...(approvalAttestation ? { approval_attestation: approvalAttestation } : {})
  };
  return {
    ...normalized,
    integrity_digest: createHash("sha256")
      .update(JSON.stringify(canonicalValue(normalized)))
      .digest("hex")
  };
}

async function approvedMixedProfile(storePath: string, subjectId = "moryn") {
  const draft = await createSoulProfileDraft(storePath, {
    subject: { kind: "agent", subject_id: subjectId },
    clauses: [
      {
        clause_key: "mission",
        category: "mission",
        text: "Carry the same persona across hosts.",
        distribution: "personal_sync"
      },
      {
        clause_key: "device-secret",
        category: "collaboration",
        text: "LOCAL PAYLOAD MUST NEVER SYNC",
        distribution: "local_only"
      }
    ],
    source,
    occurred_at: occurredAt
  });
  const approved = await approveSoulProfileDraft(storePath, {
    revision_id: draft.revision.revision_id,
    confirmed: true,
    source,
    occurred_at: approvedAt
  });
  return { draft, approved };
}

describe("Soul Profile persistence", () => {
  it("writes and idempotently reloads a personal-sync revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      const profile = revision({});
      const first = await writeSoulProfileRevision(storePath, {
        revision: profile,
        source,
        confirmed: true,
        occurred_at: occurredAt
      });
      const second = await writeSoulProfileRevision(storePath, {
        revision: profile,
        source,
        confirmed: true,
        occurred_at: occurredAt
      });

      expect(first).toMatchObject({
        revision_id: profile.revision_id,
        local_saved: false,
        personal_sync_saved: true,
        personal_sync_event_created: true
      });
      expect(second.personal_sync_event_created).toBe(false);
      expect(await readEvents(storePath)).toHaveLength(1);
      const loaded = await readSoulProfileRevisions(storePath);
      expect(loaded.revisions).toEqual([profile]);
      expect(loaded.personal_sync_revision_ids).toEqual([profile.revision_id]);
      expect(loaded.warnings).toEqual([]);
    });
  });

  it("keeps local-only payloads under ignored state with private permissions", async () => {
    await withInitializedTempStore(async (storePath) => {
      const profile = revision({ local: true });
      const result = await writeSoulProfileRevision(storePath, {
        revision: profile,
        source,
        confirmed: true,
        occurred_at: occurredAt
      });

      expect(result).toMatchObject({ local_saved: true, personal_sync_saved: false });
      expect(await readEvents(storePath)).toEqual([]);
      const directory = join(storePath, "state", "soul-profiles");
      const path = join(directory, `${profile.revision_id}.json`);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readSoulProfileRevisions(storePath)).revisions).toEqual([profile]);
    });
  });

  it("syncs only the portable projection while the local device compiles the full mixed revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      const profile = revision({ mixed: true });
      await writeSoulProfileRevision(storePath, {
        revision: profile,
        source,
        confirmed: true,
        occurred_at: occurredAt
      });

      const events = await readEvents(storePath);
      const serializedEvents = JSON.stringify(events);
      expect(serializedEvents).not.toContain("LOCAL PAYLOAD MUST NEVER SYNC");
      expect((await readSoulProfileRevisions(storePath)).revisions[0]?.clauses).toHaveLength(2);

      await rm(join(storePath, "state", "soul-profiles", `${profile.revision_id}.json`));
      const remoteProjection = await readSoulProfileRevisions(storePath);
      expect(remoteProjection.revisions[0]?.revision_id).toBe(profile.revision_id);
      expect(remoteProjection.revisions[0]?.clauses.map((clause) => clause.text)).toEqual([
        "Carry the same persona across hosts."
      ]);
    });
  });

  it("embeds metadata-only approval evidence in the portable active projection", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { approved } = await approvedMixedProfile(storePath);
      const activeEvent = (await readEvents(storePath)).find(
        (event) =>
          event.op === "upsert_record" &&
          (event.record.content.soul_profile_projection as SoulProfileProjectionEnvelope | undefined)
            ?.full_revision_id === approved.revision.revision_id
      );
      expect(activeEvent?.op).toBe("upsert_record");
      if (activeEvent?.op !== "upsert_record") throw new Error("active Soul projection event was not found");
      const envelope = activeEvent.record.content.soul_profile_projection as SoulProfileProjectionEnvelope;
      expect(envelope).toMatchObject({
        projection: "personal_sync",
        partial: true,
        approval_attestation: {
          receipt_id: approved.approval_receipt.receipt_id,
          source_revision_id: approved.approval_receipt.source_revision_id,
          approved_revision_id: approved.revision.revision_id
        }
      });
      expect(envelope.revision.clauses).toHaveLength(1);
      expect(JSON.stringify(envelope)).not.toContain("LOCAL PAYLOAD MUST NEVER SYNC");

      await rm(join(storePath, "state", "soul-profiles"), { recursive: true });
      const remote = await readSoulProfileRevisions(storePath);
      expect(remote.verified_approval_revision_ids).toEqual([approved.revision.revision_id]);
      expect(remote.revisions_by_id[approved.revision.revision_id]).toMatchObject({ approved: true });
    });
  });

  it("keeps an active projection visible but non-effective when its attestation is absent", async () => {
    await withInitializedTempStore(async (storePath) => {
      const { approved } = await approvedMixedProfile(storePath);
      const records = (await readEvents(storePath)).flatMap((event) =>
        event.op === "upsert_record" ? [event.record] : []
      );
      const withoutAttestation = records.map((record) => {
        const envelope = record.content.soul_profile_projection as SoulProfileProjectionEnvelope | undefined;
        if (envelope?.full_revision_id !== approved.revision.revision_id) return record;
        return {
          ...record,
          content: {
            ...record.content,
            soul_profile_projection: envelopeWithAttestation(envelope, undefined)
          }
        };
      });

      await rm(join(storePath, "state", "soul-profiles"), { recursive: true });
      const loaded = await readSoulProfileRevisions(storePath, { records: withoutAttestation });
      expect(loaded.stored_revisions_by_id[approved.revision.revision_id]).toMatchObject({
        state: "active",
        approved: true
      });
      expect(loaded.revisions_by_id[approved.revision.revision_id]).toMatchObject({
        state: "active",
        approved: false
      });
      expect(loaded.verified_approval_revision_ids).toEqual([]);
      expect(loaded.approval_attestations).toEqual([]);
      expect(loaded.warnings).toContainEqual({
        code: "unverified_approval_attestation",
        source: approved.revision.revision_id
      });
      expect(compileEffectiveSoul({ revisions: loaded.revisions }).selected_revisions).toEqual([]);
    });
  });

  it("rejects an approval attestation belonging to another profile revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      const first = await approvedMixedProfile(storePath, "first");
      const second = await approvedMixedProfile(storePath, "second");
      const activeEvent = (await readEvents(storePath)).find(
        (event) =>
          event.op === "upsert_record" &&
          (event.record.content.soul_profile_projection as SoulProfileProjectionEnvelope | undefined)
            ?.full_revision_id === first.approved.revision.revision_id
      );
      if (activeEvent?.op !== "upsert_record") throw new Error("active Soul projection event was not found");
      const envelope = activeEvent.record.content.soul_profile_projection as SoulProfileProjectionEnvelope;
      expect(() =>
        parseSoulProfileProjection(envelopeWithAttestation(envelope, second.approved.approval_receipt))
      ).toThrow("approval attestation association");
    });
  });

  it("requires a receipt and explicit confirmation before activating a revision", async () => {
    await withInitializedTempStore(async (storePath) => {
      const missingReceipt = revision({ state: "active", approved: true, approval_receipt_id: "" });
      await expect(
        writeSoulProfileRevision(storePath, {
          revision: missingReceipt,
          source,
          confirmed: true,
          occurred_at: occurredAt
        })
      ).rejects.toThrow("approval receipt");

      const profile = revision({ state: "active", approved: true, approval_receipt_id: "user-approved:test" });
      await expect(
        writeSoulProfileRevision(storePath, { revision: profile, source, occurred_at: occurredAt })
      ).rejects.toThrow("explicit user confirmation");
      expect(await readEvents(storePath)).toEqual([]);
    });
  });

  it("detects a tampered local envelope without echoing its payload", async () => {
    await withInitializedTempStore(async (storePath) => {
      const profile = revision({ local: true });
      await writeSoulProfileRevision(storePath, {
        revision: profile,
        source,
        confirmed: true,
        occurred_at: occurredAt
      });
      const path = join(storePath, "state", "soul-profiles", `${profile.revision_id}.json`);
      const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await chmod(path, 0o600);
      await writeFile(path, `${JSON.stringify({ ...stored, integrity_digest: "0".repeat(64) })}\n`, "utf8");

      const loaded = await readSoulProfileRevisions(storePath);
      expect(loaded.revisions).toEqual([]);
      expect(loaded.warnings).toEqual([
        { code: "invalid_local_projection", source: `state/soul-profiles/${profile.revision_id}.json` }
      ]);
      expect(JSON.stringify(loaded.warnings)).not.toContain("LOCAL");
    });
  });

  it("loads legacy canonical Soul records as one active head beside v1 projections", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => occurredAt });
      const publicLegacy = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer concise updates." },
        state: "canonical",
        confirmed: true,
        source
      });
      const contentPrivate = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        tags: ["privacy-marker"],
        content: { text: "Device-local concise updates.", privacy: "private" },
        state: "canonical",
        confirmed: true,
        source
      });
      const localOnly = await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        tags: ["distribution-marker"],
        content: { text: "Host-local concise updates.", distribution: "local_only" },
        state: "canonical",
        confirmed: true,
        source
      });
      const loaded = await readSoulProfileRevisions(storePath);
      expect(loaded.revisions).toHaveLength(1);
      expect(loaded.revisions[0]).toMatchObject({ state: "active", approved: true });
      expect(loaded.legacy_record_ids).toEqual([publicLegacy.record.id]);

      const withPrivate = await readSoulProfileRevisions(storePath, { include_legacy_private: true });
      expect(withPrivate.legacy_record_ids).toEqual(
        expect.arrayContaining([publicLegacy.record.id, contentPrivate.record.id, localOnly.record.id])
      );
      expect(withPrivate.legacy_record_ids).toHaveLength(3);
      expect(withPrivate.revisions.flatMap((revision) => revision.clauses)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provenance_record_ids: [contentPrivate.record.id], distribution: "local_only" }),
          expect.objectContaining({ provenance_record_ids: [localOnly.record.id], distribution: "local_only" })
        ])
      );
    });
  });

  it("rejects personal-sync envelopes containing local-only clauses", () => {
    const profile = revision({ local: true });
    const envelope = {
      version: 1,
      projection: "personal_sync",
      full_revision_id: profile.revision_id,
      partial: false,
      revision: profile,
      integrity_digest: "0".repeat(64)
    };
    expect(() => parseSoulProfileProjection(envelope)).toThrow("local-only clause");
  });
});
