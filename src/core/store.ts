import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
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
import { parseEvent } from "./schema.js";
import { detectSensitiveContent, sensitiveScanText } from "./sensitive.js";
import { withStoreStateLease } from "./state-lease.js";
import type { MorynEvent } from "./types.js";

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

function eventPath(storePath: string, event: MorynEvent): string {
  const deviceId = deviceFromEvent(event);
  assertSafeEventPathComponent(deviceId, "source.device_id");
  assertSafeEventPathComponent(event.event_id, "event_id");
  return join(storePath, "events", deviceId, monthFromIso(event.created_at), `${event.event_id}.json`);
}

function idempotentEventPath(storePath: string, eventId: string): string {
  assertSafeEventPathComponent(eventId, "event_id");
  return join(storePath, "events", "idempotent", `${eventId}.json`);
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

async function appendEventWithLease(storePath: string, event: MorynEvent): Promise<string> {
  const config = await readStoreConfig(storePath);
  const parsed = parseEvent(withDefaultDeviceId(event, config.device_id));
  assertNoUnredactedSensitiveContent(parsed);
  const path = eventPath(storePath, parsed);
  const tempDir = join(storePath, "state", "event-writes");
  await mkdir(dirname(path), { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(
    tempDir,
    `${parsed.event_id}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return path;
}

export async function appendEvent(storePath: string, event: MorynEvent): Promise<string> {
  await ensureStoreInitialized(storePath);
  return withStoreStateLease(storePath, () => appendEventWithLease(storePath, event));
}

export interface AppendEventIfAbsentOptions {
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
  durability: EventDurability;
  warnings?: AppendEventIfAbsentWarning[];
}

async function appendEventIfAbsentWithLease(
  storePath: string,
  event: MorynEvent,
  options: AppendEventIfAbsentOptions = {}
): Promise<AppendEventIfAbsentResult> {
  const config = await readStoreConfig(storePath);
  const parsed = parseEvent(withDefaultDeviceId(event, config.device_id));
  assertNoUnredactedSensitiveContent(parsed);
  const path = idempotentEventPath(storePath, parsed.event_id);
  const tempDir = join(storePath, "state", "event-writes");
  await mkdir(dirname(path), { recursive: true });
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
    const handle = await fsOpen(tempPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await options.before_publish?.(tempPath, path);
    try {
      await fsLink(tempPath, path);
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
      result = { created: true, event: parsed, path, durability, ...(warnings.length ? { warnings } : {}) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
      if (code && ["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(code)) {
        throw new Error(`Atomic idempotent event publish unsupported: ${code}`);
      }
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        result = {
          created: false,
          event: parseEvent(JSON.parse(await readFile(path, "utf8"))),
          path,
          durability: "best_effort"
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

async function walkJsonFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonFiles(path)));
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

export async function readEventFileManifest(storePath: string): Promise<EventFileManifest> {
  await ensureStoreInitialized(storePath);
  const eventsPath = join(storePath, "events");
  const files = (await walkJsonFiles(eventsPath)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const metadata = await stat(file);
    hash.update(relative(eventsPath, file));
    hash.update("\u0000");
    hash.update(`${metadata.size}\u0000${metadata.mtimeMs}\u0000${metadata.ctimeMs}`);
    hash.update("\u0000");
  }
  return { count: files.length, digest: hash.digest("hex") };
}

export async function readEvents(storePath: string): Promise<MorynEvent[]> {
  await ensureStoreInitialized(storePath);
  const files = await walkJsonFiles(join(storePath, "events"));
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
