import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveSoul } from "./soul-profile.js";

export interface SoulCompilationReceipt {
  version: 1;
  receipt_id: string;
  project_id?: string;
  status: EffectiveSoul["status"];
  deliverable: boolean;
  source_revision_ids: string[];
  source_digest: string;
  rendered_digest: string;
  budget: EffectiveSoul["budget"];
  omissions: Array<Pick<EffectiveSoul["omissions"][number], "clause_id" | "mandatory" | "reason">>;
  conflicts: Array<{
    kind: EffectiveSoul["conflicts"][number]["kind"];
    profile_id: string;
    profile_ids?: string[];
    revision_ids?: string[];
    clause_ids?: string[];
  }>;
  compiled_at: string;
}

const RECEIPT_DIRECTORY = "soul-compilation";

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Invalid Soul compilation receipt: compiled_at must be a canonical ISO timestamp");
  }
  return value;
}

function identity(receipt: Omit<SoulCompilationReceipt, "receipt_id" | "compiled_at">): unknown {
  return receipt;
}

function receiptDirectory(storePath: string): string {
  return join(storePath, "state", RECEIPT_DIRECTORY);
}

function receiptPath(storePath: string, receiptId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(receiptId)) throw new Error("Invalid Soul compilation receipt id");
  return join(receiptDirectory(storePath), `${receiptId}.json`);
}

function normalizedReceiptInput(
  effectiveSoul: EffectiveSoul
): Omit<SoulCompilationReceipt, "receipt_id" | "compiled_at"> {
  return {
    version: 1,
    ...(effectiveSoul.project_id ? { project_id: effectiveSoul.project_id } : {}),
    status: effectiveSoul.status,
    deliverable: effectiveSoul.deliverable,
    source_revision_ids: effectiveSoul.selected_revisions
      .map((revision) => revision.revision_id)
      .sort(compareCodeUnits),
    source_digest: effectiveSoul.source_digest,
    rendered_digest: effectiveSoul.rendered_digest,
    budget: effectiveSoul.budget,
    omissions: effectiveSoul.omissions
      .map((omission) => ({
        clause_id: omission.clause_id,
        mandatory: omission.mandatory,
        reason: omission.reason
      }))
      .sort(
        (left, right) =>
          compareCodeUnits(left.clause_id, right.clause_id) || compareCodeUnits(left.reason, right.reason)
      ),
    conflicts: effectiveSoul.conflicts
      .map((conflict) => ({
        kind: conflict.kind,
        profile_id: conflict.profile_id,
        ...(conflict.profile_ids ? { profile_ids: [...conflict.profile_ids].sort(compareCodeUnits) } : {}),
        ...(conflict.revision_ids ? { revision_ids: [...conflict.revision_ids].sort(compareCodeUnits) } : {}),
        ...(conflict.clause_ids ? { clause_ids: [...conflict.clause_ids].sort(compareCodeUnits) } : {})
      }))
      .sort(
        (left, right) => compareCodeUnits(left.profile_id, right.profile_id) || compareCodeUnits(left.kind, right.kind)
      )
  };
}

function parseReceipt(value: unknown): SoulCompilationReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<SoulCompilationReceipt>;
  if (
    candidate.version !== 1 ||
    typeof candidate.receipt_id !== "string" ||
    (candidate.status !== "ready" && candidate.status !== "ready_with_omissions" && candidate.status !== "blocked") ||
    typeof candidate.deliverable !== "boolean" ||
    !Array.isArray(candidate.source_revision_ids) ||
    candidate.source_revision_ids.some((revisionId) => typeof revisionId !== "string") ||
    typeof candidate.source_digest !== "string" ||
    typeof candidate.rendered_digest !== "string" ||
    !candidate.budget ||
    !Array.isArray(candidate.omissions) ||
    !Array.isArray(candidate.conflicts) ||
    typeof candidate.compiled_at !== "string"
  ) {
    return undefined;
  }
  try {
    canonicalTimestamp(candidate.compiled_at);
    const core = {
      version: 1 as const,
      ...(candidate.project_id ? { project_id: candidate.project_id } : {}),
      status: candidate.status,
      deliverable: candidate.deliverable,
      source_revision_ids: candidate.source_revision_ids,
      source_digest: candidate.source_digest,
      rendered_digest: candidate.rendered_digest,
      budget: candidate.budget,
      omissions: candidate.omissions,
      conflicts: candidate.conflicts
    };
    if (sha256(JSON.stringify(canonicalValue(identity(core)))) !== candidate.receipt_id) return undefined;
    return candidate as SoulCompilationReceipt;
  } catch {
    return undefined;
  }
}

export async function readSoulCompilationReceipt(
  storePath: string,
  receiptId: string
): Promise<SoulCompilationReceipt | undefined> {
  try {
    return parseReceipt(JSON.parse(await readFile(receiptPath(storePath, receiptId), "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeSoulCompilationReceipt(
  storePath: string,
  effectiveSoul: EffectiveSoul,
  compiledAt: string
): Promise<{ created: boolean; receipt: SoulCompilationReceipt }> {
  const core = normalizedReceiptInput(effectiveSoul);
  const receiptId = sha256(JSON.stringify(canonicalValue(identity(core))));
  const existing = await readSoulCompilationReceipt(storePath, receiptId);
  if (existing) return { created: false, receipt: existing };
  const receipt: SoulCompilationReceipt = {
    ...core,
    receipt_id: receiptId,
    compiled_at: canonicalTimestamp(compiledAt)
  };
  const directory = receiptDirectory(storePath);
  const path = receiptPath(storePath, receiptId);
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
