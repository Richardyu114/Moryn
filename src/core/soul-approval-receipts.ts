import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordSource } from "./types.js";

export type SoulApprovalAction = "approve" | "rollback";

export interface SoulApprovalReceiptInput {
  action: SoulApprovalAction;
  profile_id: string;
  source_revision_id: string;
  approved_revision_id: string;
  source_revision_digest: string;
  source_projection_digest: string;
  confirmed: true;
  approved_at: string;
  source: RecordSource;
}

export interface SoulApprovalReceipt extends SoulApprovalReceiptInput {
  version: 1;
  receipt_id: string;
  integrity_digest: string;
}

const RECEIPT_DIRECTORY = "soul-approvals";
const RECEIPT_ID_PATTERN = /^soul_approval_[a-f0-9]{32}$/u;
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

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Invalid Soul approval receipt: ${field} must be non-empty`);
  return normalized;
}

function revisionId(value: string, field: string): string {
  const normalized = nonEmpty(value, field);
  if (!REVISION_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid Soul approval receipt: ${field} must be a Soul revision id`);
  }
  return normalized;
}

function digest(value: string, field: string): string {
  const normalized = nonEmpty(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`Invalid Soul approval receipt: ${field} must be a SHA-256 digest`);
  }
  return normalized;
}

function canonicalTimestamp(value: string): string {
  const parsed = Date.parse(nonEmpty(value, "approved_at"));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Invalid Soul approval receipt: approved_at must be a canonical ISO timestamp");
  }
  return value;
}

function normalizedSource(source: RecordSource): RecordSource {
  const normalized: RecordSource = { client: nonEmpty(source.client, "source.client") };
  for (const key of ["session_id", "model", "device_id"] as const) {
    const value = source[key]?.trim();
    if (value) normalized[key] = value;
  }
  return normalized;
}

function normalizeInput(input: SoulApprovalReceiptInput): SoulApprovalReceiptInput {
  if (input.action !== "approve" && input.action !== "rollback") {
    throw new Error("Invalid Soul approval receipt: unsupported action");
  }
  if (input.confirmed !== true) {
    throw new Error("Soul Profile activation requires explicit user confirmation");
  }
  return {
    action: input.action,
    profile_id: nonEmpty(input.profile_id, "profile_id"),
    source_revision_id: revisionId(input.source_revision_id, "source_revision_id"),
    approved_revision_id: revisionId(input.approved_revision_id, "approved_revision_id"),
    source_revision_digest: digest(input.source_revision_digest, "source_revision_digest"),
    source_projection_digest: digest(input.source_projection_digest, "source_projection_digest"),
    confirmed: true,
    approved_at: canonicalTimestamp(input.approved_at),
    source: normalizedSource(input.source)
  };
}

function receiptCore(input: SoulApprovalReceiptInput): Omit<SoulApprovalReceipt, "receipt_id" | "integrity_digest"> {
  return { version: 1, ...input };
}

function receiptDirectory(storePath: string): string {
  return join(storePath, "state", RECEIPT_DIRECTORY);
}

function receiptPath(storePath: string, receiptId: string): string {
  if (!RECEIPT_ID_PATTERN.test(receiptId)) throw new Error("Invalid Soul approval receipt id");
  return join(receiptDirectory(storePath), `${receiptId}.json`);
}

function createReceipt(input: SoulApprovalReceiptInput): SoulApprovalReceipt {
  const normalized = normalizeInput(input);
  const core = receiptCore(normalized);
  const integrityDigest = sha256(canonicalJson(core));
  return {
    ...core,
    receipt_id: `soul_approval_${integrityDigest.slice(0, 32)}`,
    integrity_digest: integrityDigest
  };
}

export function parseSoulApprovalReceipt(value: unknown): SoulApprovalReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SoulApprovalReceipt>;
  if (
    candidate.version !== 1 ||
    !RECEIPT_ID_PATTERN.test(candidate.receipt_id ?? "") ||
    typeof candidate.integrity_digest !== "string" ||
    (candidate.action !== "approve" && candidate.action !== "rollback") ||
    typeof candidate.profile_id !== "string" ||
    typeof candidate.source_revision_id !== "string" ||
    typeof candidate.approved_revision_id !== "string" ||
    typeof candidate.source_revision_digest !== "string" ||
    typeof candidate.source_projection_digest !== "string" ||
    candidate.confirmed !== true ||
    typeof candidate.approved_at !== "string" ||
    !candidate.source ||
    typeof candidate.source.client !== "string"
  ) {
    return undefined;
  }
  try {
    const expected = createReceipt(candidate as SoulApprovalReceiptInput);
    if (candidate.receipt_id !== expected.receipt_id || candidate.integrity_digest !== expected.integrity_digest) {
      return undefined;
    }
    return expected;
  } catch {
    return undefined;
  }
}

export function soulApprovalReceiptIdentity(input: SoulApprovalReceiptInput): {
  receipt_id: string;
  integrity_digest: string;
} {
  const receipt = createReceipt(input);
  return { receipt_id: receipt.receipt_id, integrity_digest: receipt.integrity_digest };
}

export async function writeSoulApprovalReceipt(
  storePath: string,
  input: SoulApprovalReceiptInput
): Promise<{ created: boolean; receipt: SoulApprovalReceipt }> {
  const receipt = createReceipt(input);
  const existing = await readSoulApprovalReceipt(storePath, receipt.receipt_id);
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

export async function readSoulApprovalReceipt(
  storePath: string,
  receiptId: string
): Promise<SoulApprovalReceipt | undefined> {
  try {
    return parseSoulApprovalReceipt(JSON.parse(await readFile(receiptPath(storePath, receiptId), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function listSoulApprovalReceipts(storePath: string): Promise<SoulApprovalReceipt[]> {
  let files: string[];
  try {
    files = await readdir(receiptDirectory(storePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
  const receipts = await Promise.all(
    files
      .filter((file) => /^soul_approval_[a-f0-9]{32}\.json$/u.test(file))
      .map((file) => readSoulApprovalReceipt(storePath, file.slice(0, -".json".length)))
  );
  return receipts
    .filter((receipt): receipt is SoulApprovalReceipt => receipt !== undefined)
    .sort(
      (left, right) =>
        right.approved_at.localeCompare(left.approved_at) || left.receipt_id.localeCompare(right.receipt_id)
    );
}
