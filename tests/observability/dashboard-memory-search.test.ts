import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import {
  buildDashboardData,
  type DashboardRecordSummary,
  startDashboardServer
} from "../../src/observability/dashboard.js";
import { renderMemorySearch } from "../../src/observability/dashboard-workspace.js";
import { dashboardWorkspaceScript } from "../../src/observability/dashboard-workspace-script.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

interface MemorySearchResponse {
  read_only: boolean;
  scope: {
    mode: "store" | "project";
    project_id?: string;
    includes_global: boolean;
  };
  breakdown: {
    current: number;
    older_versions: number;
    history: number;
    set_aside: number;
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

      const currentCanonical = await engine.write({
        ...base,
        content: { text: "Current canonical" },
        state: "canonical",
        confirmed: true
      });
      const currentCandidate = await engine.write({
        ...base,
        content: { text: "Current candidate" },
        state: "candidate"
      });
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
      await engine.logicalLink({
        record_id: currentCanonical.record.id,
        linked_record_id: currentCandidate.record.id,
        relationship: "supersedes",
        reason: "The canonical conclusion replaced the earlier candidate."
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
            current: 3,
            older_versions: 1,
            history: 1,
            set_aside: 1
          },
          total_visible: 3,
          total_matches: 3,
          offset: 0,
          limit: 2,
          returned: 2,
          has_more: true
        });
        expect(response.total_visible).toBe(response.breakdown.current);
        expect(JSON.stringify(response)).not.toContain("Current candidate");
        expect(JSON.stringify(response)).not.toContain("Current history");
        expect(JSON.stringify(response)).not.toContain("Current quarantine");
        expect(JSON.stringify(response)).not.toContain("Other project canonical");
        expect(JSON.stringify(response)).not.toContain("Private current canonical");

        const oldSourceSearch = (await (
          await fetch(new URL("/api/memory/search?q=current%20candidate", server.url))
        ).json()) as MemorySearchResponse;
        expect(oldSourceSearch).toMatchObject({ total_visible: 3, total_matches: 0, records: [] });
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
          breakdown: { current: 2, older_versions: 0, history: 1, set_aside: 0 },
          total_visible: 2,
          total_matches: 1,
          returned: 1,
          has_more: false
        });
        expect(response.scope).not.toHaveProperty("project_id");
      } finally {
        await server.close();
      }
    });
  });

  it("keeps Soul in the dedicated preferences projection instead of generic search", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      await engine.write({
        kind: "memory",
        type: "fact",
        scope: "global",
        content: { text: "Ordinary searchable memory" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "soul",
        type: "working_principle",
        scope: "global",
        content: { text: "Portable preference shown only in Preferences" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const server = await startDashboardServer(storePath, { host: "127.0.0.1", port: 0 });
      try {
        const page = await (await fetch(server.url)).text();
        const response = (await (
          await fetch(new URL("/api/memory/search?kind=soul", server.url))
        ).json()) as MemorySearchResponse & { kind?: string };
        const textSearch = (await (
          await fetch(new URL("/api/memory/search?q=portable%20preference", server.url))
        ).json()) as MemorySearchResponse;
        const data = await buildDashboardData(storePath);
        const ordinaryRecord = data.all_records[0]!;
        const genericSearchHtml = renderMemorySearch(data, [
          ordinaryRecord,
          {
            ...ordinaryRecord,
            id: "rec_defensive_soul_filter",
            kind: "soul",
            text: "Portable preference shown only in Preferences"
          }
        ]);

        expect(page).not.toContain('data-chip-kind="soul"');
        expect(page).toContain("Portable preference shown only in Preferences");
        expect(genericSearchHtml).toContain("Ordinary searchable memory");
        expect(genericSearchHtml).not.toContain("Portable preference shown only in Preferences");
        expect(response).not.toHaveProperty("kind");
        expect(response.total_visible).toBe(1);
        expect(response.total_visible).toBe(response.breakdown.current);
        expect(
          response.records.every((record) => record.text !== "Portable preference shown only in Preferences")
        ).toBe(true);
        expect(textSearch).toMatchObject({ total_visible: 1, total_matches: 0, records: [] });
      } finally {
        await server.close();
      }
    });
  });

  it("offers API-backed continuation after the 600 embedded results", async () => {
    await withInitializedTempStore(async (storePath) => {
      const data = await buildDashboardData(storePath);
      const records: DashboardRecordSummary[] = Array.from({ length: 601 }, (_, index) => {
        const id = `rec_memory_page_${String(index + 1).padStart(3, "0")}`;
        return {
          id,
          kind: "memory",
          type: "fact",
          scope: "global",
          state: "canonical",
          priority: "normal",
          source: { client: "codex" },
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          text: `Searchable memory ${index + 1}`,
          citation: {
            record_id: id,
            timeline_command: `moryn timeline --record-id ${id}`,
            recall_command: `moryn recall --record-id ${id}`
          }
        };
      });
      const fixture = {
        ...data,
        memory_status: {
          ...data.memory_status,
          summary: {
            ...data.memory_status.summary,
            saved_total: records.length,
            current_total: records.length
          }
        }
      };

      const html = renderMemorySearch(fixture, records, { endpoint: "api/memory/search" });
      const script = dashboardWorkspaceScript();

      expect(html.match(/data-memory-result /g)).toHaveLength(600);
      expect(html).toContain('data-total="600" data-visible-total="601"');
      expect(html).toContain('data-memory-search-more data-i18n-en="Show more saved memories"');
      expect(html).not.toContain("data-memory-search-more hidden");
      expect(script).toContain("let remoteOffset = initialRenderedTotal");
      expect(script).toContain("url.searchParams.set('offset', String(remoteOffset))");
      expect(script).toContain("moreButton.addEventListener('click', () => { void runRemote(true); })");
    });
  });
});
