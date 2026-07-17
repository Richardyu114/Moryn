import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replayEvents } from "./replay.js";
import { parseRecord } from "./schema.js";
import { type EventFileManifest, readEventFileManifest, readEvents } from "./store.js";
import type { MorynEvent, MorynRecord } from "./types.js";

export interface EventManifest extends EventFileManifest {}

export interface RecordReadModelV1 {
  version: 1;
  generated_at: string;
  event_manifest: EventManifest;
  records: MorynRecord[];
}

export function eventManifest(events: MorynEvent[]): EventManifest {
  const identities = [...events]
    .sort(
      (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
    )
    .map((event) => `${event.created_at}\u0000${event.event_id}\u0000${event.op}`);
  return {
    count: identities.length,
    digest: createHash("sha256").update(identities.join("\n")).digest("hex")
  };
}

export function buildRecordReadModel(
  events: MorynEvent[],
  records: MorynRecord[],
  manifest: EventManifest
): RecordReadModelV1 {
  return {
    version: 1,
    generated_at:
      [...events].sort(
        (left, right) => right.created_at.localeCompare(left.created_at) || right.event_id.localeCompare(left.event_id)
      )[0]?.created_at ?? "1970-01-01T00:00:00.000Z",
    event_manifest: manifest,
    records: [...records].sort((left, right) => left.id.localeCompare(right.id))
  };
}

export type RecordReadFallbackReason = "missing" | "invalid" | "version_mismatch" | "stale";

export interface CurrentRecordReadResult {
  records: MorynRecord[];
  source: "read_model" | "event_replay";
  repaired: boolean;
  fallback_reason?: RecordReadFallbackReason;
  event_manifest: EventManifest;
}

export interface ReadCurrentRecordsOptions {
  write_read_model?: (path: string, model: RecordReadModelV1) => Promise<void>;
}

function sameManifest(left: EventManifest, right: EventManifest): boolean {
  return left.count === right.count && left.digest === right.digest;
}

function parseReadModel(value: unknown): RecordReadModelV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const model = value as Record<string, unknown>;
  if (model.version !== 1) throw new Error("version_mismatch");
  const manifest = model.event_manifest as Record<string, unknown> | undefined;
  if (
    !manifest ||
    typeof manifest.count !== "number" ||
    typeof manifest.digest !== "string" ||
    !Array.isArray(model.records) ||
    typeof model.generated_at !== "string"
  )
    throw new Error("invalid");
  return {
    version: 1,
    generated_at: model.generated_at,
    event_manifest: { count: manifest.count, digest: manifest.digest },
    records: model.records.map((record) => parseRecord(record))
  };
}

async function writeReadModel(path: string, model: RecordReadModelV1): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function authoritativeReplay(
  storePath: string
): Promise<{ events: MorynEvent[]; records: MorynRecord[]; manifest: EventManifest }> {
  let events = await readEvents(storePath);
  let manifest = await readEventFileManifest(storePath);
  if (manifest.count !== events.length) {
    events = await readEvents(storePath);
    manifest = await readEventFileManifest(storePath);
  }
  return { events, records: [...replayEvents(events).values()], manifest };
}

export async function readCurrentRecords(
  storePath: string,
  options: ReadCurrentRecordsOptions = {}
): Promise<CurrentRecordReadResult> {
  const path = join(storePath, "snapshots", "records.json");
  const before = await readEventFileManifest(storePath);
  let fallbackReason: RecordReadFallbackReason | undefined;
  try {
    const model = parseReadModel(JSON.parse(await readFile(path, "utf8")));
    const after = await readEventFileManifest(storePath);
    if (sameManifest(before, after) && sameManifest(model.event_manifest, after)) {
      return { records: model.records, source: "read_model", repaired: false, event_manifest: after };
    }
    fallbackReason = "stale";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fallbackReason = "missing";
    else if (error instanceof Error && error.message === "version_mismatch") fallbackReason = "version_mismatch";
    else fallbackReason = "invalid";
  }

  const replay = await authoritativeReplay(storePath);
  let repaired = false;
  try {
    await (options.write_read_model ?? writeReadModel)(
      path,
      buildRecordReadModel(replay.events, replay.records, replay.manifest)
    );
    repaired = true;
  } catch {}
  return {
    records: replay.records,
    source: "event_replay",
    repaired,
    fallback_reason: fallbackReason,
    event_manifest: replay.manifest
  };
}
