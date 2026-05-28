import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MorynEvent } from "./types.js";
import { parseEvent } from "./schema.js";
import { detectSensitiveContent, sensitiveScanText } from "./sensitive.js";
import { readStoreConfig, validateStorePath } from "./config.js";

function monthFromIso(iso: string): string {
  return iso.slice(0, 7);
}

function deviceFromEvent(event: MorynEvent): string {
  return event.source.device_id ?? "device_default";
}

function assertSafeEventPathComponent(value: string, name: string): void {
  if (value === "." || value === ".." || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid argument: Invalid event path component: ${name}`);
  }
}

function eventPath(storePath: string, event: MorynEvent): string {
  const deviceId = deviceFromEvent(event);
  assertSafeEventPathComponent(deviceId, "source.device_id");
  assertSafeEventPathComponent(event.event_id, "event_id");
  return join(storePath, "events", deviceId, monthFromIso(event.created_at), `${event.event_id}.json`);
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

export async function appendEvent(storePath: string, event: MorynEvent): Promise<string> {
  await ensureStoreInitialized(storePath);
  const config = await readStoreConfig(storePath);
  const parsed = parseEvent(withDefaultDeviceId(event, config.device_id));
  assertNoUnredactedSensitiveContent(parsed);
  const path = eventPath(storePath, parsed);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return path;
}

async function walkJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

export async function readEvents(storePath: string): Promise<MorynEvent[]> {
  await ensureStoreInitialized(storePath);
  const files = await walkJsonFiles(join(storePath, "events"));
  const events = await Promise.all(files.map(async (file) => {
    try {
      return parseEvent(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} in ${file}`);
    }
  }));
  return events.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id));
}
