import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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

export interface StoreLockOptions {
  timeout_ms?: number;
  poll_ms?: number;
  stale_ms?: number;
  heartbeat_ms?: number;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export async function withStoreLock<T>(storePath: string, lockName: string, fn: () => Promise<T>, options: StoreLockOptions = {}): Promise<T> {
  await ensureStoreInitialized(storePath);
  if (typeof lockName !== "string" || !lockName.trim()) throw new Error("Invalid argument: lock_name must be a non-empty string");
  const normalizedLockName = lockName.trim();
  assertSafeEventPathComponent(normalizedLockName, "lock_name");
  const timeoutMs = options.timeout_ms ?? 5_000;
  const pollMs = options.poll_ms ?? 20;
  const staleMs = options.stale_ms ?? 30_000;
  const heartbeatMs = options.heartbeat_ms ?? Math.max(5, Math.floor(staleMs / 3));
  const lockPath = join(storePath, "state", "locks", normalizedLockName);
  const ownerPath = join(lockPath, "owner.json");
  const ownerToken = randomUUID();
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  async function readOwner(): Promise<{ token: string; heartbeat_at: string } | undefined> {
    try {
      const value = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown; heartbeat_at?: unknown };
      if (typeof value.token !== "string" || typeof value.heartbeat_at !== "string") return undefined;
      return { token: value.token, heartbeat_at: value.heartbeat_at };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      return undefined;
    }
  }

  async function removeIfOwned(token: string): Promise<boolean> {
    const owner = await readOwner();
    if (owner?.token !== token) return false;
    const tombstonePath = `${lockPath}.remove-${token}`;
    try {
      await rename(lockPath, tombstonePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    const movedOwner = await (async () => {
      try {
        return JSON.parse(await readFile(join(tombstonePath, "owner.json"), "utf8")) as { token?: unknown };
      } catch {
        return undefined;
      }
    })();
    if (movedOwner?.token !== token) {
      try { await rename(tombstonePath, lockPath); } catch { /* replacement already exists */ }
      return false;
    }
    await rm(tombstonePath, { recursive: true, force: true });
    return true;
  }

  async function removeUninitializedOwner(): Promise<void> {
    if (await readOwner()) return;
    const tombstonePath = `${lockPath}.init-failed-${ownerToken}`;
    try {
      await rename(lockPath, tombstonePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    try {
      const replacement = await (async () => {
        try {
          return JSON.parse(await readFile(join(tombstonePath, "owner.json"), "utf8")) as { token?: unknown };
        } catch {
          return undefined;
        }
      })();
      if (typeof replacement?.token === "string") {
        try { await rename(tombstonePath, lockPath); } catch { /* replacement already restored */ }
        return;
      }
      await rm(tombstonePath, { recursive: true, force: true });
    } catch (error) {
      try { await rename(tombstonePath, lockPath); } catch { /* preserve current owner */ }
      throw error;
    }
  }

  while (true) {
    try {
      await mkdir(lockPath);
      try {
        const timestamp = new Date().toISOString();
        await writeFile(ownerPath, JSON.stringify({ token: ownerToken, pid: process.pid, acquired_at: timestamp, heartbeat_at: timestamp }), { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (!await removeIfOwned(ownerToken)) await removeUninitializedOwner();
        throw error;
      }
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const firstOwner = await readOwner();
      if (firstOwner) {
        const heartbeatTime = Date.parse(firstOwner.heartbeat_at);
        if (Number.isFinite(heartbeatTime) && Date.now() - heartbeatTime > staleMs) {
          const confirmedOwner = await readOwner();
          if (confirmedOwner?.token === firstOwner.token && confirmedOwner.heartbeat_at === firstOwner.heartbeat_at) {
            if (await removeIfOwned(firstOwner.token)) continue;
          }
        }
      }
      if (Date.now() - startedAt >= timeoutMs) throw new Error(`Store lock timeout: ${normalizedLockName}`);
      await sleep(pollMs);
    }
  }

  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let stopHeartbeatWait: (() => void) | undefined;
  let heartbeatStopped = false;
  const heartbeat = (async () => {
    while (!heartbeatStopped) {
      await new Promise<void>((resolve) => {
        stopHeartbeatWait = resolve;
        heartbeatTimer = setTimeout(resolve, heartbeatMs);
      });
      heartbeatTimer = undefined;
      stopHeartbeatWait = undefined;
      if (heartbeatStopped) break;
      const owner = await readOwner();
      if (owner?.token !== ownerToken) break;
      await writeFile(ownerPath, JSON.stringify({ token: ownerToken, pid: process.pid, heartbeat_at: new Date().toISOString() }), "utf8");
    }
  })();
  try {
    return await fn();
  } finally {
    heartbeatStopped = true;
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    stopHeartbeatWait?.();
    await heartbeat;
    await removeIfOwned(ownerToken);
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
  const tempDir = join(storePath, "state", "event-writes");
  await mkdir(dirname(path), { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${parsed.event_id}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
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
