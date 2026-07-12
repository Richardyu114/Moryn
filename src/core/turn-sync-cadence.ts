import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostAdapterId } from "./host-adapter-registry.js";

export type TurnSyncCadenceHost = HostAdapterId;

export interface TurnSyncCadenceIdentity {
  project_id: string;
  host: TurnSyncCadenceHost;
  session_id: string;
  device_id: string;
  occurred_at: string;
}

export interface TurnSyncCadenceEntry extends Omit<TurnSyncCadenceIdentity, "occurred_at"> {
  last_success_at: string;
}

export interface TurnSyncCadenceState {
  version: 1;
  entries: TurnSyncCadenceEntry[];
}

export interface TurnSyncCadenceDecision {
  due: boolean;
  reason: "first_turn_sync" | "within_interval" | "interval_elapsed";
  interval_minutes: 15;
  last_success_at?: string;
}

const intervalMs = 15 * 60 * 1000;
const statePath = (storePath: string) => join(storePath, "state", "turn-sync-cadence.json");
const key = (input: Omit<TurnSyncCadenceIdentity, "occurred_at">) => `${input.project_id}\u0000${input.host}\u0000${input.session_id}\u0000${input.device_id}`;

export async function readTurnSyncCadence(storePath: string): Promise<TurnSyncCadenceState> {
  try {
    const value = JSON.parse(await readFile(statePath(storePath), "utf8")) as TurnSyncCadenceState;
    if (value.version !== 1 || !Array.isArray(value.entries)) return { version: 1, entries: [] };
    return { version: 1, entries: value.entries.filter((entry) => typeof entry?.last_success_at === "string") };
  } catch {
    return { version: 1, entries: [] };
  }
}

export async function evaluateTurnSyncCadence(storePath: string, input: TurnSyncCadenceIdentity): Promise<TurnSyncCadenceDecision> {
  const state = await readTurnSyncCadence(storePath);
  const entry = state.entries.find((candidate) => key(candidate) === key(input));
  if (!entry) return { due: true, reason: "first_turn_sync", interval_minutes: 15 };
  const elapsed = Date.parse(input.occurred_at) - Date.parse(entry.last_success_at);
  if (elapsed >= intervalMs) return { due: true, reason: "interval_elapsed", interval_minutes: 15, last_success_at: entry.last_success_at };
  return { due: false, reason: "within_interval", interval_minutes: 15, last_success_at: entry.last_success_at };
}

export async function recordTurnSyncSuccess(storePath: string, input: TurnSyncCadenceIdentity): Promise<void> {
  const state = await readTurnSyncCadence(storePath);
  const entry: TurnSyncCadenceEntry = { project_id: input.project_id, host: input.host, session_id: input.session_id, device_id: input.device_id, last_success_at: input.occurred_at };
  const entries = [...state.entries.filter((candidate) => key(candidate) !== key(entry)), entry]
    .sort((left, right) => key(left).localeCompare(key(right)))
    .slice(-128);
  const path = statePath(storePath);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
