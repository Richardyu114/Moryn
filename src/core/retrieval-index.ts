import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildActiveLogicalMemoryView } from "./logical-memory.js";
import type { EventManifest } from "./record-read-model.js";
import { type CurrentRecordReadResult, readCurrentRecords } from "./record-read-model.js";
import { parseRecord } from "./schema.js";
import { readEventFileManifest } from "./store.js";
import type { MorynRecord } from "./types.js";

export interface RetrievalIndexMetadataV1 {
  version: 1;
  event_manifest: EventManifest;
  active_records: number;
  global_records: number;
  project_buckets: number;
  projects: Record<string, { shard: string; records: number }>;
}

export interface RetrievalIndexShardV1 {
  version: 1;
  event_manifest: EventManifest;
  scope: "global" | "project";
  project_id?: string;
  records: MorynRecord[];
}

export interface BuiltRetrievalIndex {
  metadata: RetrievalIndexMetadataV1;
  global: RetrievalIndexShardV1;
  projects: Record<string, RetrievalIndexShardV1>;
}

export type RetrievalIndexFallbackReason = "missing" | "invalid" | "version_mismatch" | "stale";

export interface RetrievalCandidateReadResult {
  records: MorynRecord[];
  source: "retrieval_index" | "record_read_model";
  repaired: boolean;
  fallback_reason?: RetrievalIndexFallbackReason;
  event_manifest: EventManifest;
  total_active_records: number;
  global_records: number;
  project_buckets: number;
  candidate_count: number;
}

export interface ReadRetrievalCandidatesInput {
  project_id: string;
  read_event_manifest?: (storePath: string) => Promise<EventManifest>;
  read_current_records?: (storePath: string) => Promise<CurrentRecordReadResult>;
  write_index?: (storePath: string, index: BuiltRetrievalIndex) => Promise<void>;
}

function sameManifest(left: EventManifest, right: EventManifest): boolean {
  return left.count === right.count && left.digest === right.digest;
}

export function retrievalProjectShardName(projectId: string): string {
  return `${Buffer.from(projectId, "utf8").toString("base64url")}.json`;
}

export function buildRetrievalIndex(records: MorynRecord[], eventManifest: EventManifest): BuiltRetrievalIndex {
  const active = buildActiveLogicalMemoryView(records)
    .active_records.filter((record) => record.state !== "archived" && record.state !== "quarantined")
    .sort((left, right) => left.id.localeCompare(right.id));
  const globalRecords = active.filter((record) => record.scope === "global");
  const projects: Record<string, RetrievalIndexShardV1> = {};
  for (const record of active) {
    if (record.scope !== "project" || !record.project_id) continue;
    const shard = projects[record.project_id] ?? {
      version: 1,
      event_manifest: eventManifest,
      scope: "project" as const,
      project_id: record.project_id,
      records: []
    };
    shard.records.push(record);
    projects[record.project_id] = shard;
  }
  const projectMetadata = Object.fromEntries(
    Object.keys(projects)
      .sort()
      .map((projectId) => [
        projectId,
        {
          shard: retrievalProjectShardName(projectId),
          records: projects[projectId]!.records.length
        }
      ])
  );
  return {
    metadata: {
      version: 1,
      event_manifest: eventManifest,
      active_records: active.length,
      global_records: globalRecords.length,
      project_buckets: Object.keys(projects).length,
      projects: projectMetadata
    },
    global: { version: 1, event_manifest: eventManifest, scope: "global", records: globalRecords },
    projects
  };
}

function parseManifest(value: unknown): EventManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.count !== "number" || typeof manifest.digest !== "string") throw new Error("invalid");
  return { count: manifest.count, digest: manifest.digest };
}

function parseMetadata(value: unknown): RetrievalIndexMetadataV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== 1) throw new Error("version_mismatch");
  if (
    typeof metadata.active_records !== "number" ||
    typeof metadata.global_records !== "number" ||
    typeof metadata.project_buckets !== "number" ||
    !metadata.projects ||
    typeof metadata.projects !== "object" ||
    Array.isArray(metadata.projects)
  )
    throw new Error("invalid");
  const projects: RetrievalIndexMetadataV1["projects"] = {};
  for (const [projectId, raw] of Object.entries(metadata.projects as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid");
    const entry = raw as Record<string, unknown>;
    if (typeof entry.shard !== "string" || typeof entry.records !== "number") throw new Error("invalid");
    if (entry.shard !== retrievalProjectShardName(projectId)) throw new Error("invalid");
    projects[projectId] = { shard: entry.shard, records: entry.records };
  }
  return {
    version: 1,
    event_manifest: parseManifest(metadata.event_manifest),
    active_records: metadata.active_records,
    global_records: metadata.global_records,
    project_buckets: metadata.project_buckets,
    projects
  };
}

function parseShard(
  value: unknown,
  expectedScope: RetrievalIndexShardV1["scope"],
  expectedProjectId?: string
): RetrievalIndexShardV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const shard = value as Record<string, unknown>;
  if (shard.version !== 1) throw new Error("version_mismatch");
  if (shard.scope !== expectedScope || !Array.isArray(shard.records)) throw new Error("invalid");
  if (expectedScope === "project" && shard.project_id !== expectedProjectId) throw new Error("invalid");
  const records = shard.records.map((record) => parseRecord(record));
  if (
    records.some(
      (record) =>
        record.scope !== expectedScope || (expectedScope === "project" && record.project_id !== expectedProjectId)
    )
  )
    throw new Error("invalid");
  return {
    version: 1,
    event_manifest: parseManifest(shard.event_manifest),
    scope: expectedScope,
    ...(expectedProjectId ? { project_id: expectedProjectId } : {}),
    records
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeRetrievalIndex(storePath: string, index: BuiltRetrievalIndex): Promise<void> {
  const root = join(storePath, "snapshots", "retrieval");
  const projectsPath = join(root, "projects");
  await writeJsonAtomic(join(root, "global.json"), index.global);
  for (const projectId of Object.keys(index.projects).sort()) {
    await writeJsonAtomic(join(projectsPath, retrievalProjectShardName(projectId)), index.projects[projectId]);
  }
  await writeJsonAtomic(join(root, "metadata.json"), index.metadata);
  const retained = new Set(Object.values(index.metadata.projects).map((entry) => entry.shard));
  try {
    for (const file of await readdir(projectsPath)) {
      if (!retained.has(file)) await rm(join(projectsPath, file), { force: true });
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function selectedRecords(index: BuiltRetrievalIndex, projectId: string): MorynRecord[] {
  return [...index.global.records, ...(index.projects[projectId]?.records ?? [])];
}

export async function readRetrievalCandidates(
  storePath: string,
  input: ReadRetrievalCandidatesInput
): Promise<RetrievalCandidateReadResult> {
  const root = join(storePath, "snapshots", "retrieval");
  const readManifest = input.read_event_manifest ?? readEventFileManifest;
  const readRecords = input.read_current_records ?? readCurrentRecords;
  const before = await readManifest(storePath);
  let fallbackReason: RetrievalIndexFallbackReason | undefined;
  try {
    const metadata = parseMetadata(JSON.parse(await readFile(join(root, "metadata.json"), "utf8")));
    if (!sameManifest(metadata.event_manifest, before)) throw new Error("stale");
    const global = parseShard(JSON.parse(await readFile(join(root, "global.json"), "utf8")), "global");
    if (!sameManifest(global.event_manifest, before)) throw new Error("stale");
    const projectEntry = metadata.projects[input.project_id];
    let project: RetrievalIndexShardV1 | undefined;
    if (projectEntry) {
      project = parseShard(
        JSON.parse(await readFile(join(root, "projects", projectEntry.shard), "utf8")),
        "project",
        input.project_id
      );
      if (!sameManifest(project.event_manifest, before)) throw new Error("stale");
    }
    const after = await readManifest(storePath);
    if (!sameManifest(before, after)) throw new Error("stale");
    const records = [...global.records, ...(project?.records ?? [])];
    return {
      records,
      source: "retrieval_index",
      repaired: false,
      event_manifest: after,
      total_active_records: metadata.active_records,
      global_records: metadata.global_records,
      project_buckets: metadata.project_buckets,
      candidate_count: records.length
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") fallbackReason = "missing";
    else if (error instanceof Error && error.message === "version_mismatch") fallbackReason = "version_mismatch";
    else if (error instanceof Error && error.message === "stale") fallbackReason = "stale";
    else fallbackReason = "invalid";
  }

  const current = await readRecords(storePath);
  const index = buildRetrievalIndex(current.records, current.event_manifest);
  let repaired = false;
  try {
    await (input.write_index ?? writeRetrievalIndex)(storePath, index);
    repaired = true;
  } catch {}
  const records = selectedRecords(index, input.project_id);
  return {
    records,
    source: "record_read_model",
    repaired,
    fallback_reason: fallbackReason,
    event_manifest: current.event_manifest,
    total_active_records: index.metadata.active_records,
    global_records: index.metadata.global_records,
    project_buckets: index.metadata.project_buckets,
    candidate_count: records.length
  };
}
