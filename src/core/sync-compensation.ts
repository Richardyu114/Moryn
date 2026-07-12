import type { GitSyncStatus } from "../sync/git.js";
import type { MorynEvent } from "./types.js";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SyncCompensationReason =
  | "sync_not_configured"
  | "sync_conflict"
  | "remote_updates_pending"
  | "unowned_pending_paths"
  | "no_pending_changes"
  | "no_pending_continuity_events"
  | "pending_continuity_events"
  | "evidence_unavailable";

export interface SyncCompensationAssessment {
  decision: "safe_to_push" | "not_needed" | "blocked";
  reason: SyncCompensationReason;
  pending_paths: string[];
  continuity_record_ids: string[];
}

export interface SyncCompensationAssessmentInput {
  project_id: string;
  status: GitSyncStatus;
  pending_paths: string[];
  pending_events: MorynEvent[];
}

export interface SyncCompensationReceipt extends Omit<SyncCompensationAssessment, "decision"> {
  version: 1;
  occurred_at: string;
  project_id: string;
  decision: "not_needed" | "blocked" | "pushed" | "failed";
  error?: string;
}

export async function writeSyncCompensationReceipt(storePath: string, input: Omit<SyncCompensationReceipt, "version">): Promise<void> {
  const path = join(storePath, "state", "sync-compensation.json");
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...input }, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readSyncCompensationReceipt(storePath: string): Promise<SyncCompensationReceipt | undefined> {
  try {
    const value = JSON.parse(await readFile(join(storePath, "state", "sync-compensation.json"), "utf8")) as SyncCompensationReceipt;
    if (value.version !== 1 || typeof value.occurred_at !== "string" || typeof value.project_id !== "string" || !Array.isArray(value.pending_paths) || !Array.isArray(value.continuity_record_ids)) return undefined;
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

function isOwnedPendingPath(path: string): boolean {
  return path === ".gitignore" || path.startsWith("events/");
}

function continuityRecordIds(events: MorynEvent[], projectId: string): string[] {
  return [...new Set(events
    .filter((event) => event.op === "upsert_record")
    .map((event) => event.op === "upsert_record" ? event.record : undefined)
    .filter((record) => record?.kind === "session_summary" && record.scope === "project" && record.project_id === projectId)
    .filter((record) => record?.type === "checkpoint" || record?.type === "status" || record?.type === "summary")
    .map((record) => record!.id))].sort();
}

export function assessSyncCompensation(input: SyncCompensationAssessmentInput): SyncCompensationAssessment {
  const pendingPaths = [...new Set(input.pending_paths)].sort();
  const continuityIds = continuityRecordIds(input.pending_events, input.project_id);
  const result = (decision: SyncCompensationAssessment["decision"], reason: SyncCompensationReason): SyncCompensationAssessment => ({ decision, reason, pending_paths: pendingPaths, continuity_record_ids: continuityIds });
  if (!input.status.configured || !input.status.remote) return result("not_needed", "sync_not_configured");
  if (input.status.sync_state === "conflict") return result("blocked", "sync_conflict");
  if ((input.status.behind ?? 0) > 0) return result("blocked", "remote_updates_pending");
  if (pendingPaths.some((path) => !isOwnedPendingPath(path))) return result("blocked", "unowned_pending_paths");
  if (!pendingPaths.length && (input.status.ahead ?? 0) === 0) return result("not_needed", "no_pending_changes");
  if (!continuityIds.length) return result("not_needed", "no_pending_continuity_events");
  return result("safe_to_push", "pending_continuity_events");
}
