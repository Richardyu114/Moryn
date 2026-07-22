import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type SoulSyncReceiptStage = "remote_pushed" | "remote_pulled_and_verified";
export type SoulSyncReceiptOperation = "init" | "pull" | "push";
export type SoulSyncApprovalVerification = "not_checked" | "not_required" | "verified";

export interface SoulSyncReceiptInput {
  stage: SoulSyncReceiptStage;
  operation: SoulSyncReceiptOperation;
  profile_id: string;
  revision_id: string;
  event_id: string;
  event_path: string;
  event_blob_oid: string;
  projection_integrity_digest: string;
  approval_verification: SoulSyncApprovalVerification;
  remote_name: "origin";
  remote_ref: "refs/heads/main";
  remote_identity_digest: string;
  remote_commit: string;
}

export interface SoulSyncReceipt extends SoulSyncReceiptInput {
  version: 1;
  proof_scope: "exact_git_event_blob";
  receipt_id: string;
  integrity_digest: string;
}

const RECEIPT_DIRECTORY = "soul-sync";
const RECEIPT_ID_PATTERN = /^soul_sync_[a-f0-9]{32}$/u;
const REVISION_ID_PATTERN = /^soul_revision_[a-f0-9]{24}$/u;
const EVENT_ID_PATTERN = /^evt_soul_[a-f0-9]{32}$/u;
const OBJECT_ID_PATTERN = /^[a-f0-9]{40,64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

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

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Invalid Soul sync receipt: ${field} must be non-empty`);
  return normalized;
}

function matching(value: string, field: string, pattern: RegExp): string {
  const normalized = nonEmpty(value, field).toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`Invalid Soul sync receipt: ${field}`);
  return normalized;
}

function normalizeInput(input: SoulSyncReceiptInput): SoulSyncReceiptInput {
  if (input.stage !== "remote_pushed" && input.stage !== "remote_pulled_and_verified") {
    throw new Error("Invalid Soul sync receipt: stage");
  }
  if (input.operation !== "init" && input.operation !== "pull" && input.operation !== "push") {
    throw new Error("Invalid Soul sync receipt: operation");
  }
  if (input.stage === "remote_pushed") {
    if (input.operation !== "push" || input.approval_verification !== "not_checked") {
      throw new Error("Invalid Soul sync receipt: remote_pushed proof semantics");
    }
  } else if (
    input.operation === "push" ||
    (input.approval_verification !== "not_required" && input.approval_verification !== "verified")
  ) {
    throw new Error("Invalid Soul sync receipt: remote_pulled_and_verified proof semantics");
  }
  if (input.remote_name !== "origin" || input.remote_ref !== "refs/heads/main") {
    throw new Error("Invalid Soul sync receipt: remote identity");
  }
  const eventId = matching(input.event_id, "event_id", EVENT_ID_PATTERN);
  const eventPath = nonEmpty(input.event_path, "event_path");
  if (eventPath !== `events/idempotent/${eventId}.json` || basename(eventPath) !== `${eventId}.json`) {
    throw new Error("Invalid Soul sync receipt: event_path");
  }
  return {
    stage: input.stage,
    operation: input.operation,
    profile_id: nonEmpty(input.profile_id, "profile_id"),
    revision_id: matching(input.revision_id, "revision_id", REVISION_ID_PATTERN),
    event_id: eventId,
    event_path: eventPath,
    event_blob_oid: matching(input.event_blob_oid, "event_blob_oid", OBJECT_ID_PATTERN),
    projection_integrity_digest: matching(
      input.projection_integrity_digest,
      "projection_integrity_digest",
      DIGEST_PATTERN
    ),
    approval_verification: input.approval_verification,
    remote_name: "origin",
    remote_ref: "refs/heads/main",
    remote_identity_digest: matching(input.remote_identity_digest, "remote_identity_digest", DIGEST_PATTERN),
    remote_commit: matching(input.remote_commit, "remote_commit", OBJECT_ID_PATTERN)
  };
}

function receiptCore(input: SoulSyncReceiptInput): Omit<SoulSyncReceipt, "receipt_id" | "integrity_digest"> {
  return { version: 1, proof_scope: "exact_git_event_blob", ...input };
}

function createReceipt(input: SoulSyncReceiptInput): SoulSyncReceipt {
  const core = receiptCore(normalizeInput(input));
  const integrityDigest = sha256(canonicalJson(core));
  return {
    ...core,
    receipt_id: `soul_sync_${integrityDigest.slice(0, 32)}`,
    integrity_digest: integrityDigest
  };
}

function receiptDirectory(storePath: string): string {
  return join(storePath, "state", RECEIPT_DIRECTORY);
}

function receiptPath(storePath: string, receiptId: string): string {
  if (!RECEIPT_ID_PATTERN.test(receiptId)) throw new Error("Invalid Soul sync receipt id");
  return join(receiptDirectory(storePath), `${receiptId}.json`);
}

export function soulRemoteIdentityDigest(remoteUrl: string): string {
  return sha256(nonEmpty(remoteUrl, "remote_url"));
}

export function soulSyncReceiptIdentity(input: SoulSyncReceiptInput): {
  receipt_id: string;
  integrity_digest: string;
} {
  const receipt = createReceipt(input);
  return { receipt_id: receipt.receipt_id, integrity_digest: receipt.integrity_digest };
}

export function parseSoulSyncReceipt(value: unknown): SoulSyncReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SoulSyncReceipt>;
  if (
    candidate.version !== 1 ||
    candidate.proof_scope !== "exact_git_event_blob" ||
    !RECEIPT_ID_PATTERN.test(candidate.receipt_id ?? "") ||
    typeof candidate.integrity_digest !== "string" ||
    typeof candidate.stage !== "string" ||
    typeof candidate.operation !== "string" ||
    typeof candidate.profile_id !== "string" ||
    typeof candidate.revision_id !== "string" ||
    typeof candidate.event_id !== "string" ||
    typeof candidate.event_path !== "string" ||
    typeof candidate.event_blob_oid !== "string" ||
    typeof candidate.projection_integrity_digest !== "string" ||
    typeof candidate.approval_verification !== "string" ||
    typeof candidate.remote_name !== "string" ||
    typeof candidate.remote_ref !== "string" ||
    typeof candidate.remote_identity_digest !== "string" ||
    typeof candidate.remote_commit !== "string"
  ) {
    return undefined;
  }
  try {
    const expected = createReceipt(candidate as SoulSyncReceiptInput);
    if (candidate.receipt_id !== expected.receipt_id || candidate.integrity_digest !== expected.integrity_digest) {
      return undefined;
    }
    return expected;
  } catch {
    return undefined;
  }
}

export async function writeSoulSyncReceipt(
  storePath: string,
  input: SoulSyncReceiptInput
): Promise<{ created: boolean; receipt: SoulSyncReceipt }> {
  const receipt = createReceipt(input);
  const existing = await readSoulSyncReceipt(storePath, receipt.receipt_id);
  if (existing) return { created: false, receipt: existing };

  const directory = receiptDirectory(storePath);
  const path = receiptPath(storePath, receipt.receipt_id);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
  return { created: true, receipt };
}

export async function readSoulSyncReceipt(storePath: string, receiptId: string): Promise<SoulSyncReceipt | undefined> {
  try {
    return parseSoulSyncReceipt(JSON.parse(await readFile(receiptPath(storePath, receiptId), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function listSoulSyncReceipts(storePath: string): Promise<SoulSyncReceipt[]> {
  let files: string[];
  try {
    files = await readdir(receiptDirectory(storePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
  const receipts = await Promise.all(
    files
      .filter((file) => /^soul_sync_[a-f0-9]{32}\.json$/u.test(file))
      .map((file) => readSoulSyncReceipt(storePath, file.slice(0, -".json".length)))
  );
  return receipts
    .filter((receipt): receipt is SoulSyncReceipt => receipt !== undefined)
    .sort(
      (left, right) =>
        compareCodeUnits(left.profile_id, right.profile_id) ||
        compareCodeUnits(left.revision_id, right.revision_id) ||
        compareCodeUnits(left.stage, right.stage) ||
        compareCodeUnits(left.receipt_id, right.receipt_id)
    );
}
