import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventFileManifest } from "./store.js";
import type { MorynEvent } from "./types.js";

const EVENT_AUDIT_PROOF_VERSION = 1;
const EVENT_AUDIT_PROOF_PATH = join("state", "event-audit-proof.json");
const RECORDS_SNAPSHOT_PATH = join("snapshots", "records.json");

export interface EventAuditProofV1 {
  version: 1;
  event_manifest: EventFileManifest;
  event_count: number;
  record_count: number;
  records_snapshot: RecordsSnapshotFingerprint;
  proof_digest: string;
}

export interface RecordsSnapshotFingerprint {
  size: number;
  mtime_ms: number;
  ctime_ms: number;
}

type EventAuditProofCoreV1 = Omit<EventAuditProofV1, "proof_digest">;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function proofDigest(proof: EventAuditProofCoreV1): string {
  return sha256(JSON.stringify(proof));
}

function parseEventAuditProof(value: unknown): EventAuditProofV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid event audit proof");
  const proof = value as Record<string, unknown>;
  const manifest = proof.event_manifest as Record<string, unknown> | undefined;
  const snapshot = proof.records_snapshot as Record<string, unknown> | undefined;
  if (
    proof.version !== EVENT_AUDIT_PROOF_VERSION ||
    !manifest ||
    !nonNegativeSafeInteger(manifest.count) ||
    !sha256Digest(manifest.digest) ||
    !nonNegativeSafeInteger(proof.event_count) ||
    !nonNegativeSafeInteger(proof.record_count) ||
    !snapshot ||
    !nonNegativeSafeInteger(snapshot.size) ||
    !nonNegativeFiniteNumber(snapshot.mtime_ms) ||
    !nonNegativeFiniteNumber(snapshot.ctime_ms) ||
    !sha256Digest(proof.proof_digest)
  ) {
    throw new Error("invalid event audit proof");
  }
  if (proof.event_count !== manifest.count) throw new Error("invalid event audit proof");
  const core: EventAuditProofCoreV1 = {
    version: 1,
    event_manifest: { count: manifest.count, digest: manifest.digest },
    event_count: proof.event_count,
    record_count: proof.record_count,
    records_snapshot: {
      size: snapshot.size,
      mtime_ms: snapshot.mtime_ms,
      ctime_ms: snapshot.ctime_ms
    }
  };
  if (proof.proof_digest !== proofDigest(core)) throw new Error("invalid event audit proof");
  return { ...core, proof_digest: proof.proof_digest };
}

export function buildEventAuditProof(input: {
  events: readonly MorynEvent[];
  event_manifest: EventFileManifest;
  record_count: number;
  records_snapshot: RecordsSnapshotFingerprint;
}): EventAuditProofV1 | undefined {
  if (input.event_manifest.count !== input.events.length) return undefined;
  if (new Set(input.events.map((event) => event.event_id)).size !== input.events.length) return undefined;
  const core: EventAuditProofCoreV1 = {
    version: 1,
    event_manifest: input.event_manifest,
    event_count: input.events.length,
    record_count: input.record_count,
    records_snapshot: input.records_snapshot
  };
  return { ...core, proof_digest: proofDigest(core) };
}

export async function readEventAuditProof(storePath: string): Promise<EventAuditProofV1 | undefined> {
  try {
    return parseEventAuditProof(JSON.parse(await readFile(join(storePath, EVENT_AUDIT_PROOF_PATH), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readRecordsSnapshotFingerprint(storePath: string): Promise<RecordsSnapshotFingerprint> {
  const metadata = await stat(join(storePath, RECORDS_SNAPSHOT_PATH));
  return { size: metadata.size, mtime_ms: metadata.mtimeMs, ctime_ms: metadata.ctimeMs };
}

export function sameRecordsSnapshotFingerprint(
  left: RecordsSnapshotFingerprint,
  right: RecordsSnapshotFingerprint
): boolean {
  return left.size === right.size && left.mtime_ms === right.mtime_ms && left.ctime_ms === right.ctime_ms;
}

export async function writeEventAuditProof(storePath: string, proof: EventAuditProofV1): Promise<void> {
  const path = join(storePath, EVENT_AUDIT_PROOF_PATH);
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function removeEventAuditProof(storePath: string): Promise<void> {
  await rm(join(storePath, EVENT_AUDIT_PROOF_PATH), { force: true });
}
