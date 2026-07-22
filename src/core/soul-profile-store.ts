import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rebuildDerivedViews } from "./derived.js";
import { readCurrentRecords } from "./record-read-model.js";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import {
  parseSoulApprovalReceipt,
  readSoulApprovalReceipt,
  type SoulApprovalReceipt
} from "./soul-approval-receipts.js";
import {
  createSoulProfileRevision,
  parseLegacySoulRecords,
  type SoulClause,
  type SoulProfileRevision,
  type SoulRevisionState,
  soulProfilePersonalSyncDigest,
  soulProfileRevisionDigest
} from "./soul-profile.js";
import { appendEventIfAbsent } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource, RecordState, RecordVisibility } from "./types.js";

export const SOUL_PROFILE_RECORD_TYPE = "profile_revision" as const;

export interface SoulProfileProjectionEnvelope {
  version: 1;
  projection: "local_full" | "personal_sync";
  full_revision_id: string;
  partial: boolean;
  revision: SoulProfileRevision;
  approval_attestation?: SoulApprovalReceipt;
  integrity_digest: string;
}

export interface WriteSoulProfileRevisionInput {
  revision: SoulProfileRevision;
  source: RecordSource;
  confirmed?: boolean;
  occurred_at?: string;
}

export interface WriteSoulProfileRevisionResult {
  revision_id: string;
  profile_id: string;
  local_saved: boolean;
  personal_sync_saved: boolean;
  personal_sync_event_created: boolean;
  personal_sync_event_id?: string;
  personal_sync_record_id?: string;
}

export interface SoulProfileLoadWarning {
  code:
    | "invalid_local_projection"
    | "invalid_synced_projection"
    | "projection_collision"
    | "unverified_approval_attestation";
  source: string;
}

export interface ReadSoulProfileRevisionsResult {
  /** Revisions safe to pass to Effective Soul compilation. */
  revisions: SoulProfileRevision[];
  revisions_by_id: Record<string, SoulProfileRevision>;
  /** Exact stored projections, including active revisions whose approval evidence is not verified. */
  stored_revisions: SoulProfileRevision[];
  stored_revisions_by_id: Record<string, SoulProfileRevision>;
  local_revision_ids: string[];
  personal_sync_revision_ids: string[];
  partial_revision_ids: string[];
  verified_approval_revision_ids: string[];
  approval_attestations: SoulApprovalReceipt[];
  legacy_record_ids: string[];
  warnings: SoulProfileLoadWarning[];
}

export interface ReadSoulProfileRevisionsOptions {
  records?: MorynRecord[];
  include_legacy_private?: boolean;
  /** Disable ignored local-full overlays when verifying an exact remote projection set. */
  include_local_projections?: boolean;
}

const LOCAL_DIRECTORY = "soul-profiles";
const REVISION_ID_PATTERN = /^soul_revision_[a-f0-9]{24}$/u;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Invalid Soul Profile projection: ${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function assertRevisionId(value: string): void {
  if (!REVISION_ID_PATTERN.test(value)) throw new Error("Invalid Soul Profile projection: revision_id");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function revisionFromUnknown(value: unknown): SoulProfileRevision {
  if (!isObject(value)) throw new Error("Invalid Soul Profile projection: revision");
  if (!isObject(value.subject) || (value.subject.kind !== "user" && value.subject.kind !== "agent")) {
    throw new Error("Invalid Soul Profile projection: subject");
  }
  if (!Array.isArray(value.clauses) || !Array.isArray(value.parent_revision_ids)) {
    throw new Error("Invalid Soul Profile projection: revision arrays");
  }
  if (
    value.state !== "draft" &&
    value.state !== "active" &&
    value.state !== "superseded" &&
    value.state !== "conflicted"
  ) {
    throw new Error("Invalid Soul Profile projection: revision state");
  }
  const revision = value as unknown as SoulProfileRevision;
  assertRevisionId(revision.revision_id);
  const normalized = createSoulProfileRevision({
    subject: revision.subject,
    profile_id: revision.profile_id,
    generation: revision.generation,
    parent_revision_ids: revision.parent_revision_ids,
    clauses: revision.clauses,
    state: revision.state,
    approved: revision.approved,
    approval_receipt_id: revision.approval_receipt_id,
    created_at: revision.created_at
  });
  if (normalized.clauses.some((clause, index) => clause.clause_id !== revision.clauses[index]?.clause_id)) {
    throw new Error("Invalid Soul Profile projection: unstable clause identity");
  }
  return { ...normalized, revision_id: revision.revision_id };
}

function envelopeIdentity(envelope: Omit<SoulProfileProjectionEnvelope, "integrity_digest">): unknown {
  return {
    version: envelope.version,
    projection: envelope.projection,
    full_revision_id: envelope.full_revision_id,
    partial: envelope.partial,
    revision: envelope.revision,
    approval_attestation: envelope.approval_attestation
  };
}

function createEnvelope(
  revision: SoulProfileRevision,
  projection: SoulProfileProjectionEnvelope["projection"],
  clauses: SoulClause[],
  approvalAttestation?: SoulApprovalReceipt
): SoulProfileProjectionEnvelope {
  const projected = { ...revision, clauses };
  const envelope = {
    version: 1 as const,
    projection,
    full_revision_id: revision.revision_id,
    partial: clauses.length !== revision.clauses.length,
    revision: projected,
    ...(approvalAttestation ? { approval_attestation: approvalAttestation } : {})
  };
  return { ...envelope, integrity_digest: sha256(canonicalJson(envelopeIdentity(envelope))) };
}

export function parseSoulProfileProjection(value: unknown): SoulProfileProjectionEnvelope {
  if (!isObject(value) || value.version !== 1) throw new Error("Invalid Soul Profile projection: version");
  if (value.projection !== "local_full" && value.projection !== "personal_sync") {
    throw new Error("Invalid Soul Profile projection: projection kind");
  }
  if (typeof value.full_revision_id !== "string" || typeof value.partial !== "boolean") {
    throw new Error("Invalid Soul Profile projection: identity");
  }
  if (typeof value.integrity_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.integrity_digest)) {
    throw new Error("Invalid Soul Profile projection: integrity digest");
  }
  assertRevisionId(value.full_revision_id);
  const revision = revisionFromUnknown(value.revision);
  if (revision.revision_id !== value.full_revision_id) {
    throw new Error("Invalid Soul Profile projection: revision identity mismatch");
  }
  if (
    value.projection === "personal_sync" &&
    revision.clauses.some((clause) => clause.distribution !== "personal_sync")
  ) {
    throw new Error("Invalid Soul Profile projection: local-only clause in personal sync payload");
  }
  const approvalAttestation =
    value.approval_attestation === undefined ? undefined : parseSoulApprovalReceipt(value.approval_attestation);
  if (value.approval_attestation !== undefined && !approvalAttestation) {
    throw new Error("Invalid Soul Profile projection: approval attestation integrity");
  }
  if (
    approvalAttestation &&
    (!revision.approved ||
      revision.approval_receipt_id !== approvalAttestation.receipt_id ||
      revision.profile_id !== approvalAttestation.profile_id ||
      revision.revision_id !== approvalAttestation.approved_revision_id)
  ) {
    throw new Error("Invalid Soul Profile projection: approval attestation association");
  }
  const normalized: Omit<SoulProfileProjectionEnvelope, "integrity_digest"> = {
    version: 1,
    projection: value.projection,
    full_revision_id: value.full_revision_id,
    partial: value.partial,
    revision,
    ...(approvalAttestation ? { approval_attestation: approvalAttestation } : {})
  };
  if (sha256(canonicalJson(envelopeIdentity(normalized))) !== value.integrity_digest) {
    throw new Error("Invalid Soul Profile projection: integrity mismatch");
  }
  if (
    !normalized.partial &&
    createSoulProfileRevision(normalized.revision).revision_id !== normalized.full_revision_id
  ) {
    throw new Error("Invalid Soul Profile projection: unstable full revision identity");
  }
  return { ...normalized, integrity_digest: value.integrity_digest };
}

function localDirectory(storePath: string): string {
  return join(storePath, "state", LOCAL_DIRECTORY);
}

function localPath(storePath: string, revisionId: string): string {
  assertRevisionId(revisionId);
  return join(localDirectory(storePath), `${revisionId}.json`);
}

async function writeLocalEnvelope(storePath: string, envelope: SoulProfileProjectionEnvelope): Promise<void> {
  const directory = localDirectory(storePath);
  const path = localPath(storePath, envelope.full_revision_id);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function recordState(state: SoulRevisionState): { state: RecordState; visibility: RecordVisibility } {
  if (state === "active") return { state: "canonical", visibility: "active" };
  if (state === "superseded") return { state: "archived", visibility: "archived" };
  if (state === "conflicted") return { state: "quarantined", visibility: "quarantined" };
  return { state: "candidate", visibility: "active" };
}

function projectionEvent(
  envelope: SoulProfileProjectionEnvelope,
  source: RecordSource,
  occurredAt: string
): Extract<MorynEvent, { op: "upsert_record" }> {
  const suffix = sha256(canonicalJson(envelope)).slice(0, 32);
  const lifecycle = recordState(envelope.revision.state);
  const record: MorynRecord = {
    id: `rec_soul_${suffix}`,
    kind: "soul",
    type: SOUL_PROFILE_RECORD_TYPE,
    scope: "global",
    tags: ["soul-profile", "personal-sync", `subject:${envelope.revision.subject.kind}`],
    content: {
      format: "json",
      text: `Soul Profile ${envelope.revision.profile_id} revision ${envelope.full_revision_id}`,
      soul_profile_projection: envelope
    },
    ...lifecycle,
    confidence: envelope.revision.approved ? 1 : 0.5,
    priority: "high",
    created_at: occurredAt,
    updated_at: occurredAt,
    source,
    provenance: {
      reason: "Versioned Soul Profile projection.",
      method: envelope.revision.approved ? "user-confirmed" : "agent-proposed"
    }
  };
  return {
    event_id: `evt_soul_${suffix}`,
    op: "upsert_record",
    record,
    created_at: occurredAt,
    source
  };
}

function validateApproval(input: WriteSoulProfileRevisionInput): void {
  const revision = input.revision;
  if (revision.state !== "active") return;
  if (!revision.approved || !revision.approval_receipt_id?.trim()) {
    throw new Error("Soul Profile activation requires an approval receipt");
  }
  if (input.confirmed !== true) throw new Error("Soul Profile activation requires explicit user confirmation");
}

async function approvalAttestationForRevision(
  storePath: string,
  revision: SoulProfileRevision
): Promise<SoulApprovalReceipt | undefined> {
  if (revision.state !== "active") return undefined;
  const receiptId = revision.approval_receipt_id!;
  const receipt = await readSoulApprovalReceipt(storePath, receiptId);
  if (
    !receipt ||
    receipt.profile_id !== revision.profile_id ||
    receipt.approved_revision_id !== revision.revision_id ||
    !revision.parent_revision_ids.includes(receipt.source_revision_id)
  ) {
    throw new Error("Soul Profile activation requires a verifiable approval attestation");
  }
  return receipt;
}

function normalizeRevision(revision: SoulProfileRevision): SoulProfileRevision {
  const normalized = createSoulProfileRevision({
    subject: revision.subject,
    profile_id: revision.profile_id,
    generation: revision.generation,
    parent_revision_ids: revision.parent_revision_ids,
    clauses: revision.clauses,
    state: revision.state,
    approved: revision.approved,
    approval_receipt_id: revision.approval_receipt_id,
    created_at: revision.created_at
  });
  if (normalized.revision_id !== revision.revision_id) {
    throw new Error("Invalid Soul Profile revision: revision_id does not match content");
  }
  return normalized;
}

export async function writeSoulProfileRevision(
  storePath: string,
  input: WriteSoulProfileRevisionInput
): Promise<WriteSoulProfileRevisionResult> {
  validateApproval(input);
  const revision = normalizeRevision(input.revision);
  const occurredAt = canonicalTimestamp(
    input.occurred_at ?? revision.created_at ?? new Date().toISOString(),
    "occurred_at"
  );
  const approvalAttestation = await approvalAttestationForRevision(storePath, revision);
  const localClauses = revision.clauses.filter((clause) => clause.distribution === "local_only");
  const personalClauses = revision.clauses.filter((clause) => clause.distribution === "personal_sync");
  const localSaved = localClauses.length > 0;
  if (localSaved) {
    await writeLocalEnvelope(storePath, createEnvelope(revision, "local_full", revision.clauses, approvalAttestation));
  }

  if (personalClauses.length === 0) {
    return {
      revision_id: revision.revision_id,
      profile_id: revision.profile_id,
      local_saved: localSaved,
      personal_sync_saved: false,
      personal_sync_event_created: false
    };
  }

  const event = projectionEvent(
    createEnvelope(revision, "personal_sync", personalClauses, approvalAttestation),
    input.source,
    occurredAt
  );
  const appended = await appendEventIfAbsent(storePath, event);
  if (
    appended.event.op !== "upsert_record" ||
    appended.event.event_id !== event.event_id ||
    appended.event.record.id !== event.record.id ||
    canonicalJson(appended.event.record.content.soul_profile_projection) !==
      canonicalJson(event.record.content.soul_profile_projection)
  ) {
    throw new Error(`Soul Profile event id collision: ${event.event_id}`);
  }
  if (appended.created) await rebuildDerivedViews(storePath);
  return {
    revision_id: revision.revision_id,
    profile_id: revision.profile_id,
    local_saved: localSaved,
    personal_sync_saved: true,
    personal_sync_event_created: appended.created,
    personal_sync_event_id: event.event_id,
    personal_sync_record_id: event.record.id
  };
}

async function readLocalEnvelopes(
  storePath: string
): Promise<Array<{ source: string; envelope?: SoulProfileProjectionEnvelope }>> {
  let files: string[];
  try {
    files = await readdir(localDirectory(storePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(
    files
      .filter((file) => /^soul_revision_[a-f0-9]{24}\.json$/u.test(file))
      .sort(compareCodeUnits)
      .map(async (file) => {
        try {
          const envelope = parseSoulProfileProjection(
            JSON.parse(await readFile(join(localDirectory(storePath), file), "utf8"))
          );
          if (envelope.projection !== "local_full") throw new Error("not local");
          return { source: `state/${LOCAL_DIRECTORY}/${file}`, envelope };
        } catch {
          return { source: `state/${LOCAL_DIRECTORY}/${file}` };
        }
      })
  );
}

function syncedEnvelope(record: MorynRecord): SoulProfileProjectionEnvelope | undefined {
  if (record.kind !== "soul" || record.type !== SOUL_PROFILE_RECORD_TYPE) return undefined;
  return parseSoulProfileProjection(record.content.soul_profile_projection);
}

function projectionOrder(left: SoulProfileRevision, right: SoulProfileRevision): number {
  return (
    compareCodeUnits(left.profile_id, right.profile_id) ||
    left.generation - right.generation ||
    compareCodeUnits(left.revision_id, right.revision_id)
  );
}

interface LoadedProjectionEntry {
  revision: SoulProfileRevision;
  source: "local" | "personal_sync" | "legacy";
  partial: boolean;
  approval_attestation?: SoulApprovalReceipt;
}

function verifiedApprovalRevisionIds(byId: ReadonlyMap<string, LoadedProjectionEntry>): Set<string> {
  const verified = new Map<string, boolean>();
  const visiting = new Set<string>();

  const verify = (revisionId: string): boolean => {
    const memoized = verified.get(revisionId);
    if (memoized !== undefined) return memoized;
    const entry = byId.get(revisionId);
    if (!entry) return false;
    if (entry.source === "legacy") return true;
    if (visiting.has(revisionId)) return false;
    const revision = entry.revision;
    const receipt = entry.approval_attestation;
    if (revision.state !== "active" || !revision.approved || !receipt) return false;

    visiting.add(revisionId);
    const source = byId.get(receipt.source_revision_id);
    const portableComparison = Boolean(source && (entry.partial || source.partial));
    const sourceClauses = source?.revision.clauses.filter(
      (clause) => !portableComparison || clause.distribution === "personal_sync"
    );
    const approvedClauses = revision.clauses.filter(
      (clause) => !portableComparison || clause.distribution === "personal_sync"
    );
    const associationValid = Boolean(
      source &&
        receipt.profile_id === revision.profile_id &&
        receipt.approved_revision_id === revision.revision_id &&
        revision.approval_receipt_id === receipt.receipt_id &&
        revision.parent_revision_ids.includes(receipt.source_revision_id) &&
        source.revision.profile_id === revision.profile_id &&
        canonicalJson(source.revision.subject) === canonicalJson(revision.subject) &&
        canonicalJson(sourceClauses) === canonicalJson(approvedClauses) &&
        source.revision.generation < revision.generation &&
        receipt.source_projection_digest === soulProfilePersonalSyncDigest(source.revision) &&
        (source.partial || receipt.source_revision_digest === soulProfileRevisionDigest(source.revision)) &&
        (receipt.action === "approve"
          ? source.revision.state === "draft" && !source.revision.approved
          : source.revision.approved &&
            (source.revision.state === "active" || source.revision.state === "superseded") &&
            verify(source.revision.revision_id))
    );
    visiting.delete(revisionId);
    verified.set(revisionId, associationValid);
    return associationValid;
  };

  return new Set(
    [...byId.values()]
      .filter((entry) => entry.source !== "legacy" && entry.revision.approved && verify(entry.revision.revision_id))
      .map((entry) => entry.revision.revision_id)
  );
}

export async function readSoulProfileRevisions(
  storePath: string,
  options: ReadSoulProfileRevisionsOptions = {}
): Promise<ReadSoulProfileRevisionsResult> {
  const records = options.records ?? (await readCurrentRecords(storePath)).records;
  const warnings: SoulProfileLoadWarning[] = [];
  const byId = new Map<string, LoadedProjectionEntry>();
  const personalIds = new Set<string>();
  const localIds = new Set<string>();

  for (const record of records) {
    if (record.kind !== "soul" || record.type !== SOUL_PROFILE_RECORD_TYPE) continue;
    let envelope: SoulProfileProjectionEnvelope;
    try {
      envelope = syncedEnvelope(record)!;
      if (envelope.projection !== "personal_sync") throw new Error("not synced");
    } catch {
      warnings.push({ code: "invalid_synced_projection", source: record.id });
      continue;
    }
    const existing = byId.get(envelope.full_revision_id);
    if (
      existing &&
      (canonicalJson(existing.revision) !== canonicalJson(envelope.revision) ||
        canonicalJson(existing.approval_attestation) !== canonicalJson(envelope.approval_attestation))
    ) {
      warnings.push({ code: "projection_collision", source: record.id });
      continue;
    }
    byId.set(envelope.full_revision_id, {
      revision: envelope.revision,
      source: "personal_sync",
      partial: envelope.partial,
      ...(envelope.approval_attestation ? { approval_attestation: envelope.approval_attestation } : {})
    });
    personalIds.add(envelope.full_revision_id);
  }

  if (options.include_local_projections !== false) {
    for (const local of await readLocalEnvelopes(storePath)) {
      if (!local.envelope) {
        warnings.push({ code: "invalid_local_projection", source: local.source });
        continue;
      }
      const existing = byId.get(local.envelope.full_revision_id);
      if (
        existing?.approval_attestation &&
        canonicalJson(existing.approval_attestation) !== canonicalJson(local.envelope.approval_attestation)
      ) {
        warnings.push({ code: "projection_collision", source: local.source });
      }
      byId.set(local.envelope.full_revision_id, {
        revision: local.envelope.revision,
        source: "local",
        partial: false,
        ...(local.envelope.approval_attestation ? { approval_attestation: local.envelope.approval_attestation } : {})
      });
      localIds.add(local.envelope.full_revision_id);
    }
  }

  const legacyRecords = records.filter(
    (record) =>
      record.kind === "soul" &&
      record.type !== SOUL_PROFILE_RECORD_TYPE &&
      (options.include_legacy_private === true || !isPrivateMemoryBoundary(record))
  );
  for (const revision of parseLegacySoulRecords(legacyRecords)) {
    if (!byId.has(revision.revision_id)) byId.set(revision.revision_id, { revision, source: "legacy", partial: false });
  }

  const verifiedIds = verifiedApprovalRevisionIds(byId);
  for (const entry of byId.values()) {
    if (entry.source !== "legacy" && entry.revision.approved && !verifiedIds.has(entry.revision.revision_id)) {
      warnings.push({ code: "unverified_approval_attestation", source: entry.revision.revision_id });
    }
  }
  const storedRevisions = [...byId.values()].map((entry) => entry.revision).sort(projectionOrder);
  const revisions = [...byId.values()]
    .map((entry) =>
      entry.source !== "legacy" && entry.revision.approved && !verifiedIds.has(entry.revision.revision_id)
        ? { ...entry.revision, approved: false }
        : entry.revision
    )
    .sort(projectionOrder);
  const attestations = [...byId.values()]
    .filter((entry) => verifiedIds.has(entry.revision.revision_id) && entry.approval_attestation)
    .map((entry) => entry.approval_attestation!)
    .sort(
      (left, right) =>
        right.approved_at.localeCompare(left.approved_at) || compareCodeUnits(left.receipt_id, right.receipt_id)
    );
  return {
    revisions,
    revisions_by_id: Object.fromEntries(revisions.map((revision) => [revision.revision_id, revision])),
    stored_revisions: storedRevisions,
    stored_revisions_by_id: Object.fromEntries(storedRevisions.map((revision) => [revision.revision_id, revision])),
    local_revision_ids: [...localIds].sort(compareCodeUnits),
    personal_sync_revision_ids: [...personalIds].sort(compareCodeUnits),
    partial_revision_ids: [...byId.values()]
      .filter((entry) => entry.partial)
      .map((entry) => entry.revision.revision_id)
      .sort(compareCodeUnits),
    verified_approval_revision_ids: [...verifiedIds].sort(compareCodeUnits),
    approval_attestations: attestations,
    legacy_record_ids: legacyRecords.map((record) => record.id).sort(compareCodeUnits),
    warnings: warnings.sort(
      (left, right) => compareCodeUnits(left.code, right.code) || compareCodeUnits(left.source, right.source)
    )
  };
}
