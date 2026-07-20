import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type SoulDeliveryHost = "codex" | "claude";
export type SoulDeliveryEvent = "session_start" | "post_compact";
export const SOUL_DELIVERY_PROOF_SCOPE = "hook_output_prepared_not_host_acknowledged_or_obedience" as const;

export interface SoulDeliveryReceiptInput {
  profile_id: string;
  source_revision_ids: string[];
  source_digest: string;
  rendered_digest: string;
  host: SoulDeliveryHost;
  project_id: string;
  session_id: string;
  device_id: string;
  event: SoulDeliveryEvent;
  occurred_at: string;
}

export interface SoulDeliveryReceipt extends SoulDeliveryReceiptInput {
  version: 1;
  receipt_id: string;
  proof_scope: typeof SOUL_DELIVERY_PROOF_SCOPE;
}

const RECEIPT_DIRECTORY = "soul-delivery";

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Invalid Soul delivery receipt: ${field} must be non-empty`);
  return normalized;
}

function digest(value: string, field: string): string {
  const normalized = nonEmpty(value, field).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`Invalid Soul delivery receipt: ${field} must be a SHA-256 digest`);
  }
  return normalized;
}

function occurredAt(value: string): string {
  const normalized = nonEmpty(value, "occurred_at");
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new Error("Invalid Soul delivery receipt: occurred_at must be an ISO timestamp");
  }
  return new Date(normalized).toISOString();
}

function host(value: SoulDeliveryReceiptInput["host"]): SoulDeliveryHost {
  if (value !== "codex" && value !== "claude") {
    throw new Error("Invalid Soul delivery receipt: host must be codex or claude");
  }
  return value;
}

function event(value: SoulDeliveryReceiptInput["event"]): SoulDeliveryEvent {
  if (value !== "session_start" && value !== "post_compact") {
    throw new Error("Invalid Soul delivery receipt: unsupported delivery event");
  }
  return value;
}

function normalizeReceiptInput(input: SoulDeliveryReceiptInput): SoulDeliveryReceiptInput {
  const sourceRevisionIds = [
    ...new Set(input.source_revision_ids.map((value) => nonEmpty(value, "source_revision_ids")))
  ].sort();
  if (sourceRevisionIds.length === 0) {
    throw new Error("Invalid Soul delivery receipt: source_revision_ids must not be empty");
  }
  return {
    profile_id: nonEmpty(input.profile_id, "profile_id"),
    source_revision_ids: sourceRevisionIds,
    source_digest: digest(input.source_digest, "source_digest"),
    rendered_digest: digest(input.rendered_digest, "rendered_digest"),
    host: host(input.host),
    project_id: nonEmpty(input.project_id, "project_id"),
    session_id: nonEmpty(input.session_id, "session_id"),
    device_id: nonEmpty(input.device_id, "device_id"),
    event: event(input.event),
    occurred_at: occurredAt(input.occurred_at)
  };
}

function canonicalReceiptInput(input: SoulDeliveryReceiptInput): string {
  return JSON.stringify({
    profile_id: input.profile_id,
    source_revision_ids: input.source_revision_ids,
    source_digest: input.source_digest,
    rendered_digest: input.rendered_digest,
    host: input.host,
    project_id: input.project_id,
    session_id: input.session_id,
    device_id: input.device_id,
    event: input.event,
    occurred_at: input.occurred_at
  });
}

export function soulDeliveryReceiptIdentity(input: SoulDeliveryReceiptInput): string {
  const normalized = normalizeReceiptInput(input);
  return createHash("sha256").update(canonicalReceiptInput(normalized)).digest("hex");
}

function receiptDirectory(storePath: string): string {
  return join(storePath, "state", RECEIPT_DIRECTORY);
}

function receiptPath(storePath: string, receiptId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(receiptId)) throw new Error("Invalid Soul delivery receipt id");
  return join(receiptDirectory(storePath), `${receiptId}.json`);
}

function parseReceipt(value: unknown): SoulDeliveryReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SoulDeliveryReceipt>;
  if (
    candidate.version !== 1 ||
    typeof candidate.receipt_id !== "string" ||
    typeof candidate.profile_id !== "string" ||
    !Array.isArray(candidate.source_revision_ids) ||
    candidate.source_revision_ids.some((item) => typeof item !== "string") ||
    typeof candidate.source_digest !== "string" ||
    typeof candidate.rendered_digest !== "string" ||
    (candidate.host !== "codex" && candidate.host !== "claude") ||
    typeof candidate.project_id !== "string" ||
    typeof candidate.session_id !== "string" ||
    typeof candidate.device_id !== "string" ||
    (candidate.event !== "session_start" && candidate.event !== "post_compact") ||
    candidate.proof_scope !== SOUL_DELIVERY_PROOF_SCOPE ||
    typeof candidate.occurred_at !== "string"
  ) {
    return undefined;
  }
  try {
    const normalized = normalizeReceiptInput(candidate as SoulDeliveryReceiptInput);
    const receiptId = soulDeliveryReceiptIdentity(normalized);
    if (candidate.receipt_id !== receiptId) return undefined;
    return { version: 1, receipt_id: receiptId, proof_scope: SOUL_DELIVERY_PROOF_SCOPE, ...normalized };
  } catch {
    return undefined;
  }
}

export async function writeSoulDeliveryReceipt(
  storePath: string,
  input: SoulDeliveryReceiptInput
): Promise<{ created: boolean; receipt: SoulDeliveryReceipt }> {
  const normalized = normalizeReceiptInput(input);
  const receiptId = soulDeliveryReceiptIdentity(normalized);
  const receipt: SoulDeliveryReceipt = {
    version: 1,
    receipt_id: receiptId,
    proof_scope: SOUL_DELIVERY_PROOF_SCOPE,
    ...normalized
  };
  const directory = receiptDirectory(storePath);
  const path = receiptPath(storePath, receiptId);
  const existing = await readSoulDeliveryReceipt(storePath, receiptId);
  if (existing) return { created: false, receipt: existing };

  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { created: true, receipt };
}

export async function readSoulDeliveryReceipt(
  storePath: string,
  receiptId: string
): Promise<SoulDeliveryReceipt | undefined> {
  try {
    return parseReceipt(JSON.parse(await readFile(receiptPath(storePath, receiptId), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function listSoulDeliveryReceipts(storePath: string): Promise<SoulDeliveryReceipt[]> {
  let files: string[];
  try {
    files = await readdir(receiptDirectory(storePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    return [];
  }
  const receipts = await Promise.all(
    files
      .filter((file) => /^[a-f0-9]{64}\.json$/u.test(file))
      .map((file) => readSoulDeliveryReceipt(storePath, file.slice(0, -".json".length)))
  );
  return receipts
    .filter((receipt): receipt is SoulDeliveryReceipt => receipt !== undefined)
    .sort(
      (left, right) =>
        right.occurred_at.localeCompare(left.occurred_at) || left.receipt_id.localeCompare(right.receipt_id)
    );
}
