import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { replayEvents } from "./replay.js";
import { readEvents } from "./store.js";
import type { MorynRecord } from "./types.js";
import { displayRecordText, searchableRecordText } from "./content-text.js";

export const REBUILD_SELECTION_SOURCES = {
  record_count: "records",
  project_ids: "projects",
  skill_count: "skills",
  artifacts: "artifacts",
  user_snapshot: "artifacts.snapshots.user",
  project_snapshots: "artifacts.snapshots.projects_by_id",
  skills_snapshot: "artifacts.snapshots.skills",
  recall_index: "artifacts.indexes.recall",
  sync_cursors_index: "artifacts.indexes.sync_cursors"
} as const;

export interface RebuildResult {
  ok: true;
  records: number;
  projects: string[];
  skills: number;
  artifacts: {
    snapshots: {
      user: string;
      projects_by_id: Record<string, string>;
      skills: string;
    };
    indexes: {
      recall: string;
      sync_cursors: string;
    };
  };
  selection_sources: typeof REBUILD_SELECTION_SOURCES;
}

const REBUILD_LOCK_TIMEOUT_MS = 60_000;
const REBUILD_LOCK_STALE_MS = 120_000;
const REBUILD_LOCK_POLL_MS = 25;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function lockOwner(token: string): string {
  return `${JSON.stringify({
    token,
    pid: process.pid,
    updated_at: new Date().toISOString()
  }, null, 2)}\n`;
}

async function readLockToken(ownerPath: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
    return typeof raw.token === "string" ? raw.token : undefined;
  } catch {
    return undefined;
  }
}

async function lockUpdatedAt(lockPath: string, ownerPath: string): Promise<number | undefined> {
  try {
    return (await stat(ownerPath)).mtimeMs;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    return (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function withRebuildLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  const statePath = join(storePath, "state");
  const lockPath = join(statePath, "rebuild.lock");
  const ownerPath = join(lockPath, "owner.json");
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();

  await mkdir(statePath, { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;

      const updatedAt = await lockUpdatedAt(lockPath, ownerPath);
      if (updatedAt === undefined) continue;
      if (Date.now() - updatedAt > REBUILD_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > REBUILD_LOCK_TIMEOUT_MS) {
        throw new Error("Derived view rebuild lock timed out");
      }
      await delay(REBUILD_LOCK_POLL_MS);
    }
  }

  try {
    await writeFile(ownerPath, lockOwner(token), "utf8");
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true });
    throw error;
  }
  const heartbeat = setInterval(() => {
    void writeFile(ownerPath, lockOwner(token), "utf8").catch(() => undefined);
  }, REBUILD_LOCK_STALE_MS / 4);
  heartbeat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    if (await readLockToken(ownerPath) === token) {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

function textOf(record: MorynRecord): string {
  return displayRecordText(record);
}

function active(records: MorynRecord[]): MorynRecord[] {
  return records.filter((record) => record.state !== "archived" && record.state !== "quarantined");
}

function canonical(records: MorynRecord[]): MorynRecord[] {
  return active(records).filter((record) => record.state === "canonical");
}

function projectSummary(records: MorynRecord[]): string {
  const summary = [...records]
    .filter((record) => record.kind === "memory")
    .filter((record) => record.type === "summary" || record.type === "project_summary")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
  return summary ? textOf(summary) : "";
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readLegacyJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return await readJsonIfExists(path);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function rebuildArtifacts(projectIds: string[]): RebuildResult["artifacts"] {
  return {
    snapshots: {
      user: "snapshots/user.json",
      projects_by_id: Object.fromEntries(
        projectIds.map((projectId) => [projectId, `snapshots/projects/${projectId}.json`])
      ),
      skills: "snapshots/skills/index.json"
    },
    indexes: {
      recall: "indexes/recall.json",
      sync_cursors: "indexes/sync-cursors.json"
    }
  };
}

export async function rebuildDerivedViews(storePath: string): Promise<RebuildResult> {
  return withRebuildLock(storePath, () => rebuildDerivedViewsUnlocked(storePath));
}

async function rebuildDerivedViewsUnlocked(storePath: string): Promise<RebuildResult> {
  const records = [...replayEvents(await readEvents(storePath)).values()];
  const trusted = canonical(records);
  const activeRecords = active(records);
  const snapshotPath = join(storePath, "snapshots");
  const indexPath = join(storePath, "indexes");
  const generatedFromCursor = [...activeRecords].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_at;
  const syncStatus = await readJsonIfExists(join(storePath, "state", "sync-status.json"))
    ?? await readLegacyJsonIfExists(join(storePath, "indexes", "sync-status.json"));

  await rm(snapshotPath, { recursive: true, force: true });
  await rm(indexPath, { recursive: true, force: true });
  await mkdir(join(snapshotPath, "projects"), { recursive: true });
  await mkdir(join(snapshotPath, "skills"), { recursive: true });
  await mkdir(indexPath, { recursive: true });

  if (syncStatus !== undefined) {
    await writeJson(join(storePath, "state", "sync-status.json"), syncStatus);
  }

  const user = {
    generated_from_cursor: generatedFromCursor,
    soul: trusted.filter((record) => record.kind === "soul"),
    preferences: trusted.filter((record) => record.scope === "global" && record.type === "preference"),
    rules: trusted.filter((record) => record.scope === "global" && record.type === "rule")
  };
  await writeJson(join(snapshotPath, "user.json"), user);

  const projectIds = [...new Set(activeRecords
    .filter((record) => record.scope === "project")
    .map((record) => record.project_id)
    .filter((id): id is string => Boolean(id)))].sort();
  for (const projectId of projectIds) {
    const projectRecords = trusted.filter((record) => record.scope === "project" && record.project_id === projectId);
    await writeJson(join(snapshotPath, "projects", `${projectId}.json`), {
      project_id: projectId,
      generated_from_cursor: generatedFromCursor,
      summary: projectSummary(projectRecords),
      decisions: projectRecords.filter((record) => record.kind === "memory" && record.type === "decision"),
      warnings: projectRecords.filter((record) => record.kind === "memory" && (record.type === "warning" || record.type === "blocker")),
      skills: trusted.filter((record) => record.kind === "skill" && (record.scope === "global" || record.project_id === projectId)),
      recent_changes: projectRecords.sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20)
    });
  }

  const skills = trusted.filter((record) => record.kind === "skill").sort((a, b) => a.id.localeCompare(b.id));
  await writeJson(join(snapshotPath, "skills", "index.json"), {
    generated_from_cursor: generatedFromCursor,
    skills
  });

  await writeJson(join(indexPath, "recall.json"), {
    generated_from_cursor: generatedFromCursor,
    records: activeRecords
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        type: record.type,
        scope: record.scope,
        project_id: record.project_id,
        state: record.state,
        priority: record.priority,
        tags: record.tags,
        text: searchableRecordText(record),
        updated_at: record.updated_at
      }))
  });

  await writeJson(join(indexPath, "sync-cursors.json"), {
    generated_from_cursor: generatedFromCursor,
    latest_record_update: generatedFromCursor
  });

  return {
    ok: true,
    records: activeRecords.length,
    projects: projectIds,
    skills: skills.length,
    artifacts: rebuildArtifacts(projectIds),
    selection_sources: REBUILD_SELECTION_SOURCES
  };
}
