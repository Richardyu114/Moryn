import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { rebuildDerivedViews } from "../../src/core/derived.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

describe("derived views", () => {
  it("rebuilds snapshots and recall index from replayed events", async () => {
    await withInitializedTempStore(async (storePath) => {
      let nextId = 0;
      const engine = createEngine({
        storePath,
        now: () => {
          const timestamp = new Date(Date.UTC(2026, 4, 27, 0, nextId, 0)).toISOString();
          return timestamp;
        },
        id: (prefix) => `${prefix}_${++nextId}`
      });

      await engine.write({
        kind: "soul",
        type: "preference",
        scope: "global",
        content: { text: "Prefer concise updates.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Older summary should be superseded.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "other",
        content: { text: "Other project summary.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Candidate summary should not be snapshotted.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "global",
        content: { text: "Global summary should not become project summary.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "summary",
        scope: "project",
        project_id: "memora",
        content: { text: "Memora is a local-first agent memory layer.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use Git sync.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });
      await engine.write({
        kind: "skill",
        type: "procedure",
        scope: "global",
        tags: ["release"],
        content: { text: "Run tests before release.", format: "text" },
        state: "canonical",
        source: { client: "test" }
      });

      const result = await rebuildDerivedViews(storePath);

      expect(result.records).toBe(8);
      expect(result.projects).toEqual(["memora", "other"]);
      expect(result.skills).toBe(1);

      const user = JSON.parse(await readFile(join(storePath, "snapshots", "user.json"), "utf8")) as { soul: unknown[] };
      expect(user.soul).toHaveLength(1);

      const project = JSON.parse(await readFile(join(storePath, "snapshots", "projects", "memora.json"), "utf8")) as { summary: string; decisions: Array<{ content: { text: string } }> };
      expect(project.summary).toBe("Memora is a local-first agent memory layer.");
      expect(project.decisions[0]?.content.text).toBe("Use Git sync.");

      const skills = JSON.parse(await readFile(join(storePath, "snapshots", "skills", "index.json"), "utf8")) as { skills: Array<{ tags: string[] }> };
      expect(skills.skills[0]?.tags).toEqual(["release"]);

      const firstRecallRaw = await readFile(join(storePath, "indexes", "recall.json"), "utf8");
      const recall = JSON.parse(firstRecallRaw) as { records: Array<{ id: string; text: string; tags: string[] }> };
      expect(recall.records.map((record) => record.text)).toContain("Use Git sync.");

      await rm(join(storePath, "snapshots"), { recursive: true, force: true });
      await rm(join(storePath, "indexes"), { recursive: true, force: true });
      const rebuilt = await rebuildDerivedViews(storePath);
      const rebuiltRecallRaw = await readFile(join(storePath, "indexes", "recall.json"), "utf8");
      const rebuiltRecall = JSON.parse(rebuiltRecallRaw) as { records: Array<{ id: string }> };

      expect(rebuilt.records).toBe(8);
      expect(rebuiltRecall.records).toHaveLength(8);
      expect(rebuiltRecallRaw).toBe(firstRecallRaw);
    });
  });
});
