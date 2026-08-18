import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  chmod,
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { readStoreConfig, validateStorePath } from "./config.js";
import { removeEventAuditProof } from "./event-audit-proof.js";
import { parseEvent } from "./schema.js";
import { detectSensitiveContent, sensitiveScanText } from "./sensitive.js";
import { withStoreStateLease } from "./state-lease.js";
import type { MorynEvent } from "./types.js";

export const EVENT_STORAGE_CLASSES = ["synced", "local"] as const;
export type EventStorageClass = (typeof EVENT_STORAGE_CLASSES)[number];
export type EventStorageSelection = EventStorageClass | "auto";

const LOCAL_EVENT_DIRECTORY = join("state", "local-events");

function monthFromIso(iso: string): string {
  return iso.slice(0, 7);
}

function deviceFromEvent(event: MorynEvent): string {
  return event.source.device_id ?? "device_default";
}

class EventPathComponentArgumentError extends Error {
  readonly recommended_action = "retry with safe event path components";
  readonly recovery_hint: {
    rejected_argument: { argument: string; value: string };
    expected: {
      kind: "safe_path_component";
      disallowed_values: [".", ".."];
      disallowed_characters: ["/", "\\", "\\0"];
    };
    retry_with: { argument: string; value_placeholder: string };
  };

  constructor(name: string, value: string) {
    super(`Invalid argument: Invalid event path component: ${name}`);
    this.name = "EventPathComponentArgumentError";
    this.recovery_hint = {
      rejected_argument: { argument: name, value },
      expected: {
        kind: "safe_path_component",
        disallowed_values: [".", ".."],
        disallowed_characters: ["/", "\\", "\\0"]
      },
      retry_with: { argument: name, value_placeholder: `<${name}>` }
    };
  }
}

function assertSafeEventPathComponent(value: string, name: string): void {
  if (value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new EventPathComponentArgumentError(name, value);
  }
}

function eventRoot(storePath: string, storage: EventStorageClass): string {
  return storage === "local" ? join(storePath, LOCAL_EVENT_DIRECTORY) : join(storePath, "events");
}

export function eventStorageFromPath(storePath: string, path: string): EventStorageClass {
  const relativePath = relative(storePath, path).split("\\").join("/");
  return relativePath === LOCAL_EVENT_DIRECTORY || relativePath.startsWith(`${LOCAL_EVENT_DIRECTORY}/`)
    ? "local"
    : "synced";
}

function eventPath(storePath: string, event: MorynEvent, storage: EventStorageClass): string {
  const deviceId = deviceFromEvent(event);
  assertSafeEventPathComponent(deviceId, "source.device_id");
  assertSafeEventPathComponent(event.event_id, "event_id");
  return join(eventRoot(storePath, storage), deviceId, monthFromIso(event.created_at), `${event.event_id}.json`);
}

function idempotentEventPath(storePath: string, eventId: string, storage: EventStorageClass): string {
  assertSafeEventPathComponent(eventId, "event_id");
  return join(eventRoot(storePath, storage), "idempotent", `${eventId}.json`);
}

async function ensureStoreInitialized(storePath: string): Promise<void> {
  validateStorePath(storePath);
  try {
    await access(join(storePath, "config.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Store not initialized");
    }
    throw error;
  }
}

function withDefaultDeviceId(event: MorynEvent, deviceId: string): MorynEvent {
  if (event.source.device_id) return event;
  const source = { ...event.source, device_id: deviceId };
  if (event.op !== "upsert_record") return { ...event, source };
  return {
    ...event,
    source,
    record: {
      ...event.record,
      source: event.record.source.device_id ? event.record.source : { ...event.record.source, device_id: deviceId }
    }
  };
}

function assertNoUnredactedSensitiveContent(event: MorynEvent): void {
  const text = sensitiveScanText(event);
  if (detectSensitiveContent(text).sensitive) {
    throw new Error("Sensitive content detected: event must be redacted before append");
  }
}

function contentDistribution(content: unknown): unknown {
  return content && typeof content === "object" && !Array.isArray(content)
    ? (content as Record<string, unknown>).distribution
    : undefined;
}

function eventDeclaresLocalOnly(event: MorynEvent): boolean {
  if (event.op === "upsert_record") return contentDistribution(event.record.content) === "local_only";
  if (event.op !== "revise_record") return false;
  if (event.patch["content.distribution"] === "local_only") return true;
  return Object.hasOwn(event.patch, "content") && contentDistribution(event.patch.content) === "local_only";
}

function recordIdsFromEvent(event: MorynEvent): string[] {
  if (event.op === "upsert_record") return [event.record.id];
  if (event.op === "link_records") return [event.record_id, event.linked_record_id];
  return [event.record_id];
}

async function localLineageRecordIds(storePath: string): Promise<Set<string>> {
  const events = await readEventsFromRoot(eventRoot(storePath, "local"));
  return new Set(events.flatMap(recordIdsFromEvent));
}

async function resolveEventStorage(
  storePath: string,
  event: MorynEvent,
  selection: EventStorageSelection = "auto"
): Promise<EventStorageClass> {
  if (selection === "local") return "local";
  const localLineage = await localLineageRecordIds(storePath);
  const referencesLocalLineage = recordIdsFromEvent(event).some((recordId) => localLineage.has(recordId));
  if (selection === "synced") {
    if (eventDeclaresLocalOnly(event) || referencesLocalLineage) {
      throw new Error("Sync policy denied: local event lineage cannot be written to the synced event journal");
    }
    return "synced";
  }
  return eventDeclaresLocalOnly(event) || referencesLocalLineage ? "local" : "synced";
}

async function prepareEventDirectory(path: string, storage: EventStorageClass): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (storage === "local") await chmod(dirname(path), 0o700);
}

async function appendEventWithLease(
  storePath: string,
  event: MorynEvent,
  options: AppendEventOptions = {}
): Promise<string> {
  const config = await readStoreConfig(storePath);
  const parsed = parseEvent(withDefaultDeviceId(event, config.device_id));
  assertNoUnredactedSensitiveContent(parsed);
  const storage = await resolveEventStorage(storePath, parsed, options.storage);
  const path = eventPath(storePath, parsed, storage);
  await removeEventAuditProof(storePath);
  const tempDir = join(storePath, "state", "event-writes");
  await prepareEventDirectory(path, storage);
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(
    tempDir,
    `${parsed.event_id}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      ...(storage === "local" ? { mode: 0o600 } : {})
    });
    await rename(tempPath, path);
    if (storage === "local") await chmod(path, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return path;
}

export interface AppendEventOptions {
  storage?: EventStorageSelection;
}

export async function appendEvent(
  storePath: string,
  event: MorynEvent,
  options: AppendEventOptions = {}
): Promise<string> {
  await ensureStoreInitialized(storePath);
  return withStoreStateLease(storePath, () => appendEventWithLease(storePath, event, options));
}

export interface AppendEventIfAbsentOptions {
  storage?: EventStorageSelection;
  before_publish?: (tempPath: string, finalPath: string) => Promise<void>;
  fs?: Partial<{
    open: typeof open;
    link: typeof link;
    unlink: typeof unlink;
  }>;
}

export interface AppendEventIfAbsentWarning {
  code:
    | "IDEMPOTENT_EVENT_DIRECTORY_SYNC_UNSUPPORTED"
    | "IDEMPOTENT_EVENT_DIRECTORY_SYNC_FAILED"
    | "IDEMPOTENT_EVENT_DIRECTORY_CLOSE_FAILED"
    | "IDEMPOTENT_EVENT_TEMP_CLEANUP_FAILED";
  reason: string;
}

export type EventDurability = "confirmed" | "best_effort" | "failed";

export interface AppendEventIfAbsentResult {
  created: boolean;
  event: MorynEvent;
  path: string;
  storage: EventStorageClass;
  durability: EventDurability;
  warnings?: AppendEventIfAbsentWarning[];
}

async function confirmPublishedEventDirectory(path: string, fsOpen: typeof open) {
  let durability: EventDurability = "confirmed";
  const warnings: AppendEventIfAbsentWarning[] = [];
  let directoryHandle: FileHandle | undefined;
  try {
    directoryHandle = await fsOpen(dirname(path), "r");
    await directoryHandle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "EINVAL" || code === "ENOTSUP") {
      durability = "best_effort";
      warnings.push({
        code: "IDEMPOTENT_EVENT_DIRECTORY_SYNC_UNSUPPORTED",
        reason: `directory sync unsupported: ${code}`
      });
    } else {
      durability = "failed";
      warnings.push({
        code: "IDEMPOTENT_EVENT_DIRECTORY_SYNC_FAILED",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  } finally {
    try {
      await directoryHandle?.close();
    } catch {
      durability = "failed";
      warnings.push({ code: "IDEMPOTENT_EVENT_DIRECTORY_CLOSE_FAILED", reason: "directory close failed" });
    }
  }
  return { durability, warnings };
}

async function appendEventIfAbsentWithLease(
  storePath: string,
  event: MorynEvent,
  options: AppendEventIfAbsentOptions = {}
): Promise<AppendEventIfAbsentResult> {
  const config = await readStoreConfig(storePath);
  const parsed = parseEvent(withDefaultDeviceId(event, config.device_id));
  assertNoUnredactedSensitiveContent(parsed);
  const storage = await resolveEventStorage(storePath, parsed, options.storage);
  const path = idempotentEventPath(storePath, parsed.event_id, storage);
  await removeEventAuditProof(storePath);
  const tempDir = join(storePath, "state", "event-writes");
  await prepareEventDirectory(path, storage);
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(
    tempDir,
    `${parsed.event_id}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const fsOpen = options.fs?.open ?? open;
  const fsLink = options.fs?.link ?? link;
  const fsUnlink = options.fs?.unlink ?? unlink;
  let result: AppendEventIfAbsentResult | undefined;
  let operationError: unknown;
  try {
    for (const candidateStorage of EVENT_STORAGE_CLASSES) {
      const candidatePath = idempotentEventPath(storePath, parsed.event_id, candidateStorage);
      try {
        const existing = parseEvent(JSON.parse(await readFile(candidatePath, "utf8")));
        const { durability, warnings } = await confirmPublishedEventDirectory(candidatePath, fsOpen);
        result = {
          created: false,
          event: existing,
          path: candidatePath,
          storage: candidateStorage,
          durability,
          ...(warnings.length ? { warnings } : {})
        };
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw new Error(`Corrupt idempotent event: ${parsed.event_id}`);
        }
      }
    }
    if (result) return result;
    const handle = await fsOpen(tempPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (storage === "local") await chmod(tempPath, 0o600);
    await options.before_publish?.(tempPath, path);
    try {
      await fsLink(tempPath, path);
      if (storage === "local") await chmod(path, 0o600);
      const { durability, warnings } = await confirmPublishedEventDirectory(path, fsOpen);
      result = { created: true, event: parsed, path, storage, durability, ...(warnings.length ? { warnings } : {}) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code && ["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(code)) {
        throw new Error(`Atomic idempotent event publish unsupported: ${code}`);
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const existing = parseEvent(JSON.parse(await readFile(path, "utf8")));
        const { durability, warnings } = await confirmPublishedEventDirectory(path, fsOpen);
        result = {
          created: false,
          event: existing,
          path,
          storage,
          durability,
          ...(warnings.length ? { warnings } : {})
        };
      } catch {
        throw new Error(`Corrupt idempotent event: ${parsed.event_id}`);
      }
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await fsUnlink(tempPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT") && result) {
        result = {
          ...result,
          warnings: [
            ...(result.warnings ?? []),
            { code: "IDEMPOTENT_EVENT_TEMP_CLEANUP_FAILED", reason: "temporary event cleanup failed" }
          ]
        };
      } else if (!(error instanceof Error && "code" in error && error.code === "ENOENT") && !operationError) {
        operationError = error;
      }
    }
  }
  if (operationError) throw operationError;
  if (!result) throw new Error(`Idempotent event append failed: ${parsed.event_id}`);
  return result;
}

export async function appendEventIfAbsent(
  storePath: string,
  event: MorynEvent,
  options: AppendEventIfAbsentOptions = {}
): Promise<AppendEventIfAbsentResult> {
  await ensureStoreInitialized(storePath);
  return withStoreStateLease(storePath, () => appendEventIfAbsentWithLease(storePath, event, options));
}

async function walkJsonFiles(dir: string, strictDirectoryReads = false): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    if (!strictDirectoryReads) return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(path, strictDirectoryReads)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

export interface EventFileManifest {
  count: number;
  digest: string;
}

export interface EventInputFile {
  path: string;
  input: unknown;
}

interface EventRoot {
  path: string;
  manifest_prefix: string;
}

function eventRoots(storePath: string): EventRoot[] {
  return [
    { path: eventRoot(storePath, "synced"), manifest_prefix: "" },
    { path: eventRoot(storePath, "local"), manifest_prefix: "local/" }
  ];
}

export async function readEventFileManifest(storePath: string): Promise<EventFileManifest> {
  await ensureStoreInitialized(storePath);
  const files = (
    await Promise.all(
      eventRoots(storePath).map(async (root) =>
        (
          await walkJsonFiles(root.path, true)
        ).map((path) => ({ path, key: `${root.manifest_prefix}${relative(root.path, path)}` }))
      )
    )
  )
    .flat()
    .sort((left, right) => left.key.localeCompare(right.key));
  const hash = createHash("sha256");
  for (const file of files) {
    const metadata = await stat(file.path);
    hash.update(file.key);
    hash.update("\u0000");
    hash.update(`${metadata.size}\u0000${metadata.mtimeMs}\u0000${metadata.ctimeMs}`);
    hash.update("\u0000");
  }
  return { count: files.length, digest: hash.digest("hex") };
}

/**
 * Reads event JSON inputs without applying the event schema. Malformed JSON is
 * represented as an invalid input so integrity audits can classify it with
 * schema failures, while filesystem read failures still reject the operation.
 */
export async function readEventInputFiles(storePath: string): Promise<EventInputFile[]> {
  await ensureStoreInitialized(storePath);
  const files = (await Promise.all(eventRoots(storePath).map((root) => walkJsonFiles(root.path, true)))).flat().sort();
  return Promise.all(
    files.map(async (file) => {
      const text = await readFile(file, "utf8");
      const path = relative(storePath, file).split("\\").join("/");
      try {
        return { path, input: JSON.parse(text) as unknown };
      } catch {
        return { path, input: undefined };
      }
    })
  );
}

export async function readEventInputs(storePath: string): Promise<unknown[]> {
  return (await readEventInputFiles(storePath)).map((file) => file.input);
}

export async function readEvents(storePath: string): Promise<MorynEvent[]> {
  await ensureStoreInitialized(storePath);
  const [synced, local] = await Promise.all([readSyncedEvents(storePath), readLocalEvents(storePath)]);
  return [...synced, ...local].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id)
  );
}

async function readEventsFromRoot(root: string): Promise<MorynEvent[]> {
  const files = await walkJsonFiles(root);
  const events = await Promise.all(
    files.map(async (file) => {
      try {
        return parseEvent(JSON.parse(await readFile(file, "utf8")));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} in ${file}`);
      }
    })
  );
  return events.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id));
}

export async function readSyncedEvents(storePath: string): Promise<MorynEvent[]> {
  await ensureStoreInitialized(storePath);
  return readEventsFromRoot(eventRoot(storePath, "synced"));
}

export async function readLocalEvents(storePath: string): Promise<MorynEvent[]> {
  await ensureStoreInitialized(storePath);
  return readEventsFromRoot(eventRoot(storePath, "local"));
}
