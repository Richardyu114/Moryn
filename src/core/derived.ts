import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { replayEvents } from "./replay.js";
import { readEvents } from "./store.js";
import type { MemoraRecord } from "./types.js";
import { displayRecordText, searchableRecordText } from "./content-text.js";

export interface RebuildResult {
  ok: true;
  records: number;
  projects: string[];
  skills: number;
}

function textOf(record: MemoraRecord): string {
  return displayRecordText(record);
}

function active(records: MemoraRecord[]): MemoraRecord[] {
  return records.filter((record) => record.state !== "archived" && record.state !== "quarantined");
}

function canonical(records: MemoraRecord[]): MemoraRecord[] {
  return active(records).filter((record) => record.state === "canonical");
}

function projectSummary(records: MemoraRecord[]): string {
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

export async function rebuildDerivedViews(storePath: string): Promise<RebuildResult> {
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

  return { ok: true, records: activeRecords.length, projects: projectIds, skills: skills.length };
}
