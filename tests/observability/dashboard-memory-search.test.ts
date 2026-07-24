import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { startDashboardServer } from "../../src/observability/dashboard.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

interface MemorySearchResponse {
  read_only: boolean;
  scope: {
    mode: "store" | "project";
    project_id?: string;
    includes_global: boolean;
  };
  breakdown: {
    usable: number;
    history: number;
    quarantined: number;
  };
  total_visible: number;
  total_matches: number;
  offset: number;
  limit: number;
  returned: number;
  has_more: boolean;
  records: Array<{ id: string; text: string; state: string }>;
}

describe("dashboard memory search API scope", () => {
  it("explains project visibility and paginated result counts", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const base = {
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "current-project",
        source: { client: "codex" }
      } as const;

      await engine.write({
        ...base,
        content: { text: "Current canonical" },
        state: "canonical",
        confirmed: true
      });
      await engine.write({ ...base, content: { text: "Current candidate" }, state: "candidate" });
      await engine.write({ ...base, content: { text: "Current raw" }, state: "raw" });
      await engine.write({ ...base, content: { text: "Current history" }, state: "archived" });
      const toQuarantine = await engine.write({
        ...base,
        content: { text: "Current quarantine" },
        state: "candidate"
      });
      await engine.quarantine({ record_id: toQuarantine.record.id, reason: "Test quarantine" });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "global",
        content: { text: "Shared canonical" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        ...base,
        project_id: "other-project",
        content: { text: "Other project canonical" },
        state: "canonical",
        confirmed: true
      });
      await engine.write({
        ...base,
        tags: ["private"],
        content: { text: "Private current canonical" },
        state: "canonical",
        confirmed: true
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        project_id: "current-project"
      });
      try {
        const response = (await (
          await fetch(new URL("/api/memory/search?limit=2&offset=0", server.url))
        ).json()) as MemorySearchResponse;

        expect(response).toMatchObject({
          read_only: true,
          scope: {
            mode: "project",
            project_id: "current-project",
            includes_global: true
          },
          breakdown: {
            usable: 4,
            history: 1,
            quarantined: 1
          },
          total_visible: 6,
          total_matches: 6,
          offset: 0,
          limit: 2,
          returned: 2,
          has_more: true
        });
        expect(response.breakdown.usable + response.breakdown.history + response.breakdown.quarantined).toBe(
          response.total_visible
        );
        expect(JSON.stringify(response)).not.toContain("Other project canonical");
        expect(JSON.stringify(response)).not.toContain("Private current canonical");
      } finally {
        await server.close();
      }
    });
  });

  it("reports store scope while preserving search match and return counts", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "one-project",
        content: { text: "Needle one" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "another-project",
        content: { text: "Needle two" },
        state: "archived",
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "global",
        content: { text: "Unrelated shared record" },
        state: "candidate",
        source: { client: "codex" }
      });

      const server = await startDashboardServer(storePath, { host: "127.0.0.1", port: 0 });
      try {
        const response = (await (
          await fetch(new URL("/api/memory/search?q=needle&limit=1", server.url))
        ).json()) as MemorySearchResponse;

        expect(response).toMatchObject({
          scope: { mode: "store", includes_global: true },
          breakdown: { usable: 2, history: 1, quarantined: 0 },
          total_visible: 3,
          total_matches: 2,
          returned: 1,
          has_more: true
        });
        expect(response.scope).not.toHaveProperty("project_id");
      } finally {
        await server.close();
      }
    });
  });
});
