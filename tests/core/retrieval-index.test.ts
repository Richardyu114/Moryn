import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRetrievalIndex, readRetrievalCandidates, retrievalProjectShardName } from "../../src/core/retrieval-index.js";
import type { EventManifest } from "../../src/core/record-read-model.js";
import type { MorynRecord } from "../../src/core/types.js";

function record(id: string, scope: "global" | "project", projectId?: string, state: MorynRecord["state"] = "canonical"): MorynRecord {
  return {
    id,
    kind: "memory",
    type: "fact",
    scope,
    ...(projectId ? { project_id: projectId } : {}),
    tags: [],
    content: { text: id, format: "text" },
    state,
    confidence: 0.8,
    priority: "normal",
    visibility: "active",
    created_at: "2026-07-12T00:00:00.000Z",
    updated_at: "2026-07-12T00:00:00.000Z",
    source: { client: "test" }
  };
}

const manifest: EventManifest = { count: 4, digest: "a".repeat(64) };

async function withTempStore(run: (storePath: string) => Promise<void>): Promise<void> {
  const storePath = join(tmpdir(), `moryn-retrieval-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(storePath, { recursive: true });
  try { await run(storePath); } finally { await rm(storePath, { recursive: true, force: true }); }
}

describe("retrieval index", () => {
  it("builds deterministic global and project shards from the active logical view", () => {
    const index = buildRetrievalIndex([
      record("global", "global"),
      record("alpha", "project", "alpha"),
      record("beta", "project", "beta"),
      record("archived", "project", "alpha", "archived")
    ], manifest);

    expect(index.metadata).toMatchObject({ version: 1, event_manifest: manifest, global_records: 1, project_buckets: 2, active_records: 3 });
    expect(index.global.records.map((item) => item.id)).toEqual(["global"]);
    expect(index.projects.alpha?.records.map((item) => item.id)).toEqual(["alpha"]);
    expect(index.projects.beta?.records.map((item) => item.id)).toEqual(["beta"]);
    expect(retrievalProjectShardName("a/b c")).toBe("YS9iIGM.json");
  });

  it("reads only global plus the selected project shard when the manifest is fresh", async () => {
    await withTempStore(async (storePath) => {
      const built = buildRetrievalIndex([record("global", "global"), record("alpha", "project", "alpha"), record("beta", "project", "beta")], manifest);
      const root = join(storePath, "snapshots", "retrieval");
      await mkdir(join(root, "projects"), { recursive: true });
      await writeFile(join(root, "metadata.json"), JSON.stringify(built.metadata));
      await writeFile(join(root, "global.json"), JSON.stringify(built.global));
      await writeFile(join(root, "projects", retrievalProjectShardName("alpha")), JSON.stringify(built.projects.alpha));
      await writeFile(join(root, "projects", retrievalProjectShardName("beta")), "not-json");

      let completeReads = 0;
      const result = await readRetrievalCandidates(storePath, { project_id: "alpha", read_event_manifest: async () => manifest, read_current_records: async () => { completeReads += 1; throw new Error("unexpected complete read"); } });
      expect(result).toMatchObject({ source: "retrieval_index", repaired: false, candidate_count: 2, total_active_records: 3 });
      expect(result.records.map((item) => item.id)).toEqual(["global", "alpha"]);
      expect(completeReads).toBe(0);
    });
  });

  it("repairs missing or stale shards from verified records", async () => {
    await withTempStore(async (storePath) => {
      const records = [record("global", "global"), record("alpha", "project", "alpha"), record("beta", "project", "beta")];
      const stale = buildRetrievalIndex(records, { count: 1, digest: "b".repeat(64) });
      const root = join(storePath, "snapshots", "retrieval");
      await mkdir(join(root, "projects"), { recursive: true });
      await writeFile(join(root, "metadata.json"), JSON.stringify(stale.metadata));
      await writeFile(join(root, "projects", "orphan.json"), "{}\n");

      const result = await readRetrievalCandidates(storePath, { project_id: "alpha", read_event_manifest: async () => manifest, read_current_records: async () => ({ records, source: "read_model", repaired: false, event_manifest: manifest }) });
      expect(result).toMatchObject({ source: "record_read_model", repaired: true, fallback_reason: "stale", candidate_count: 2 });
      expect(result.records.map((item) => item.id)).toEqual(["global", "alpha"]);
      expect(JSON.parse(await readFile(join(root, "metadata.json"), "utf8"))).toMatchObject({ event_manifest: manifest });
      expect(await readdir(join(root, "projects"))).not.toContain("orphan.json");
    });
  });

  it("rejects unsafe shard paths and mismatched project records", async () => {
    await withTempStore(async (storePath) => {
      const records = [record("alpha", "project", "alpha")];
      const built = buildRetrievalIndex(records, manifest);
      const root = join(storePath, "snapshots", "retrieval");
      await mkdir(join(root, "projects"), { recursive: true });
      built.metadata.projects.alpha!.shard = "../../records.json";
      await writeFile(join(root, "metadata.json"), JSON.stringify(built.metadata));
      await writeFile(join(root, "global.json"), JSON.stringify(built.global));

      const result = await readRetrievalCandidates(storePath, { project_id: "alpha", read_event_manifest: async () => manifest, read_current_records: async () => ({ records, source: "read_model", repaired: false, event_manifest: manifest }) });
      expect(result).toMatchObject({ source: "record_read_model", repaired: true, fallback_reason: "invalid" });
      expect(result.records.map((item) => item.id)).toEqual(["alpha"]);
    });
  });
});
