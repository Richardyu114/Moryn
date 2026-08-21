import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventManifest } from "./record-read-model.js";
import { readEventFileManifest, readEvents } from "./store.js";
import { createStringKeyedRecord } from "./string-keyed-record.js";
import type { MorynEvent } from "./types.js";

export const EXECUTION_ORIGIN_INDEX_VERSION = 1 as const;
export const EXECUTION_ORIGIN_INDEX_PATH = "indexes/execution-origin.json" as const;

export interface ExecutionOriginIndexEntry {
  record_id: string;
  source_device_ids: string[];
  has_unknown_source: boolean;
  creation_source_device_id?: string;
  latest_source_device_id?: string;
  event_count: number;
}

export interface ExecutionOriginIndex {
  version: typeof EXECUTION_ORIGIN_INDEX_VERSION;
  event_manifest: EventManifest;
  records_by_id: Record<string, ExecutionOriginIndexEntry>;
}

export interface ExecutionOriginIndexDependencies {
  read_events?: (storePath: string) => Promise<MorynEvent[]>;
  read_event_manifest?: (storePath: string) => Promise<EventManifest>;
  write_index?: (storePath: string, index: ExecutionOriginIndex) => Promise<void>;
}

export interface LoadedExecutionOriginIndex {
  source: "derived_index" | "event_replay";
  repaired: boolean;
  index: ExecutionOriginIndex;
}

export class ExecutionOriginIndexSourceChangedError extends Error {
  constructor() {
    super("Execution origin index source changed during rebuild");
    this.name = "ExecutionOriginIndexSourceChangedError";
  }
}

function recordIdsFromEvent(event: MorynEvent): string[] {
  if (event.op === "upsert_record") return [event.record.id];
  if (event.op === "link_records") return [event.record_id, event.linked_record_id];
  return [event.record_id];
}

function normalizedDeviceId(event: MorynEvent): string | undefined {
  const value = event.source.device_id?.trim();
  return value || undefined;
}

function sameManifest(left: EventManifest, right: EventManifest): boolean {
  return left.count === right.count && left.digest === right.digest;
}

function validManifest(value: unknown): value is EventManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<EventManifest>;
  return (
    typeof candidate.count === "number" &&
    Number.isSafeInteger(candidate.count) &&
    candidate.count >= 0 &&
    typeof candidate.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.digest)
  );
}

function parseEntry(recordId: string, value: unknown): ExecutionOriginIndexEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid entry");
  const candidate = value as Partial<ExecutionOriginIndexEntry>;
  if (
    candidate.record_id !== recordId ||
    !Array.isArray(candidate.source_device_ids) ||
    candidate.source_device_ids.some((deviceId) => typeof deviceId !== "string" || !deviceId.trim()) ||
    typeof candidate.has_unknown_source !== "boolean" ||
    typeof candidate.event_count !== "number" ||
    !Number.isSafeInteger(candidate.event_count) ||
    candidate.event_count < 1 ||
    (candidate.creation_source_device_id !== undefined && typeof candidate.creation_source_device_id !== "string") ||
    (candidate.latest_source_device_id !== undefined && typeof candidate.latest_source_device_id !== "string")
  ) {
    throw new Error("invalid entry");
  }
  return {
    record_id: recordId,
    source_device_ids: [...new Set(candidate.source_device_ids.map((deviceId) => deviceId.trim()))].sort(),
    has_unknown_source: candidate.has_unknown_source,
    ...(candidate.creation_source_device_id?.trim()
      ? { creation_source_device_id: candidate.creation_source_device_id.trim() }
      : {}),
    ...(candidate.latest_source_device_id?.trim()
      ? { latest_source_device_id: candidate.latest_source_device_id.trim() }
      : {}),
    event_count: candidate.event_count
  };
}

function parseIndex(value: unknown): ExecutionOriginIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid index");
  const candidate = value as Partial<ExecutionOriginIndex>;
  if (
    candidate.version !== EXECUTION_ORIGIN_INDEX_VERSION ||
    !validManifest(candidate.event_manifest) ||
    !candidate.records_by_id ||
    typeof candidate.records_by_id !== "object" ||
    Array.isArray(candidate.records_by_id)
  ) {
    throw new Error("invalid index");
  }
  const recordsById = createStringKeyedRecord<ExecutionOriginIndexEntry>();
  for (const [recordId, entry] of Object.entries(candidate.records_by_id)) {
    recordsById[recordId] = parseEntry(recordId, entry);
  }
  return {
    version: EXECUTION_ORIGIN_INDEX_VERSION,
    event_manifest: candidate.event_manifest,
    records_by_id: recordsById
  };
}

export function buildExecutionOriginIndex(
  events: readonly MorynEvent[],
  manifest: EventManifest
): ExecutionOriginIndex {
  if (!validManifest(manifest)) throw new Error("Invalid execution origin index manifest");
  if (events.length !== manifest.count) throw new Error("Invalid execution origin index: event count mismatch");
  const mutable = new Map<
    string,
    {
      devices: Set<string>;
      hasUnknown: boolean;
      creation?: string;
      latest?: string;
      count: number;
    }
  >();
  const ordered = [...events].sort(
    (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
  );
  for (const event of ordered) {
    const deviceId = normalizedDeviceId(event);
    for (const recordId of recordIdsFromEvent(event)) {
      const entry = mutable.get(recordId) ?? {
        devices: new Set<string>(),
        hasUnknown: false,
        count: 0
      };
      if (deviceId) entry.devices.add(deviceId);
      else entry.hasUnknown = true;
      if (entry.count === 0) entry.creation = deviceId;
      entry.latest = deviceId;
      entry.count += 1;
      mutable.set(recordId, entry);
    }
  }
  const recordsById = createStringKeyedRecord<ExecutionOriginIndexEntry>();
  for (const recordId of [...mutable.keys()].sort()) {
    const entry = mutable.get(recordId)!;
    recordsById[recordId] = {
      record_id: recordId,
      source_device_ids: [...entry.devices].sort(),
      has_unknown_source: entry.hasUnknown,
      ...(entry.creation ? { creation_source_device_id: entry.creation } : {}),
      ...(entry.latest ? { latest_source_device_id: entry.latest } : {}),
      event_count: entry.count
    };
  }
  return {
    version: EXECUTION_ORIGIN_INDEX_VERSION,
    event_manifest: manifest,
    records_by_id: recordsById
  };
}

function indexPath(storePath: string): string {
  return join(storePath, EXECUTION_ORIGIN_INDEX_PATH);
}

export async function writeExecutionOriginIndex(storePath: string, index: ExecutionOriginIndex): Promise<void> {
  const parsed = parseIndex(index);
  const path = indexPath(storePath);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readExecutionOriginIndex(storePath: string): Promise<ExecutionOriginIndex | undefined> {
  try {
    return parseIndex(JSON.parse(await readFile(indexPath(storePath), "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function loadExecutionOriginIndex(
  storePath: string,
  expectedManifest?: EventManifest,
  dependencies: ExecutionOriginIndexDependencies = {}
): Promise<LoadedExecutionOriginIndex> {
  const readEventsForIndex = dependencies.read_events ?? readEvents;
  const readManifest = dependencies.read_event_manifest ?? readEventFileManifest;
  const targetManifest = expectedManifest ?? (await readManifest(storePath));
  const existing = await readExecutionOriginIndex(storePath);
  if (existing && sameManifest(existing.event_manifest, targetManifest)) {
    return { source: "derived_index", repaired: false, index: existing };
  }

  let before = await readManifest(storePath);
  let events = await readEventsForIndex(storePath);
  let manifest = await readManifest(storePath);
  if (
    !sameManifest(before, manifest) ||
    events.length !== manifest.count ||
    (expectedManifest !== undefined && !sameManifest(manifest, targetManifest))
  ) {
    before = await readManifest(storePath);
    events = await readEventsForIndex(storePath);
    manifest = await readManifest(storePath);
    if (
      !sameManifest(before, manifest) ||
      events.length !== manifest.count ||
      (expectedManifest !== undefined && !sameManifest(manifest, targetManifest))
    ) {
      throw new ExecutionOriginIndexSourceChangedError();
    }
  }
  const index = buildExecutionOriginIndex(events, manifest);
  let repaired = false;
  try {
    await (dependencies.write_index ?? writeExecutionOriginIndex)(storePath, index);
    repaired = true;
  } catch {}
  return { source: "event_replay", repaired, index };
}
