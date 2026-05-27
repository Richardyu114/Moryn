import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoraEvent } from "./types.js";
import { parseEvent } from "./schema.js";
import { detectSensitiveContent, sensitiveScanText } from "./sensitive.js";

function monthFromIso(iso: string): string {
  return iso.slice(0, 7);
}

function deviceFromEvent(event: MemoraEvent): string {
  return event.source.device_id ?? "device_default";
}

function eventPath(storePath: string, event: MemoraEvent): string {
  return join(storePath, "events", deviceFromEvent(event), monthFromIso(event.created_at), `${event.event_id}.json`);
}

async function ensureStoreInitialized(storePath: string): Promise<void> {
  try {
    await access(join(storePath, "config.json"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Store not initialized");
    }
    throw error;
  }
}

function assertNoUnredactedSensitiveContent(event: MemoraEvent): void {
  const text = sensitiveScanText(event);
  if (detectSensitiveContent(text).sensitive) {
    throw new Error("Sensitive content detected: event must be redacted before append");
  }
}

export async function appendEvent(storePath: string, event: MemoraEvent): Promise<string> {
  await ensureStoreInitialized(storePath);
  const parsed = parseEvent(event);
  assertNoUnredactedSensitiveContent(parsed);
  const path = eventPath(storePath, event);
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

export async function readEvents(storePath: string): Promise<MemoraEvent[]> {
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
