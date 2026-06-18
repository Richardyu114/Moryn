import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { initializeStore } from "../../src/core/config.js";
import {
  buildDashboardData,
  renderDashboardHtml,
  startDashboardServer,
  writeDashboardSnapshot
} from "../../src/observability/dashboard.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("observability dashboard", () => {
  it("summarizes sync status, recent records, events, and agent activity", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z",
            "2026-06-01T00:03:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:04:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_${++record}` : `evt_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dashboard shows sync health", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", session_id: "codex-dashboard-test" }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Gemini reviewed handoff", format: "text" },
        source: { client: "gemini", session_id: "gemini-dashboard-test" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });

      expect(data.store.path).toBe(storePath);
      expect(data.sync.configured).toBe(false);
      expect(data.totals.events).toBe(2);
      expect(data.totals.records).toBe(2);
      expect(data.recent_records[0]).toMatchObject({
        id: "rec_2",
        kind: "session_summary",
        type: "status",
        source: { client: "gemini", session_id: "gemini-dashboard-test" },
        text: "Gemini reviewed handoff"
      });
      expect(data.recent_records[1]).toMatchObject({
        id: "rec_1",
        source: { client: "codex", session_id: "codex-dashboard-test" },
        text: "Dashboard shows sync health"
      });
      expect(data.recent_events.map((event) => event.op)).toEqual(["upsert_record", "upsert_record"]);
      expect(data.agent_activity).toEqual([
        expect.objectContaining({ client: "Codex", raw_clients: ["codex"], events: 1, records: 1, latest_at: "2026-06-01T00:01:00.000Z" }),
        expect.objectContaining({ client: "Gemini", raw_clients: ["gemini"], events: 1, records: 1, latest_at: "2026-06-01T00:02:00.000Z" })
      ]);
      expect(data.health).toMatchObject({
        status: "local_only",
        label: "Local Only"
      });
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          title: "Sync is not configured"
        })
      ]));
      expect(data.charts.agent_activity.map((agent) => agent.client)).toEqual(["Codex", "Gemini"]);
      expect(data.charts.memory_states.map((state) => state.state)).toEqual(expect.arrayContaining([
        "canonical",
        "candidate"
      ]));
      expect(data.charts.record_types).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "memory", count: 1 }),
        expect.objectContaining({ kind: "session_summary", count: 1 })
      ]));
      expect(data.charts.sync_position).toMatchObject({
        configured: false,
        state: "not_configured",
        ahead: 0,
        behind: 0
      });
      expect(data.recent_value[0]).toMatchObject({
        title: "Status",
        kind: "session_summary",
        type: "status",
        state: "candidate",
        source_label: "Gemini"
      });
    });
  });

  it("redacts quarantined record text and escapes rendered HTML", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (() => {
          let count = 0;
          return (prefix: string) => `${prefix}_${++count}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "<script>alert('x')</script> visible text", format: "text" },
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "secret",
        scope: "project",
        project_id: "moryn",
        content: { text: "sk-test_1234567890abcdefghijklmnopqrstuvwxyz", format: "text" },
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });
      const quarantined = data.recent_records.find((record) => record.state === "quarantined");
      expect(quarantined?.text).toBe("[quarantined]");
      expect(JSON.stringify(data)).not.toContain("sk-test_1234567890abcdefghijklmnopqrstuvwxyz");
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Quarantined records hidden"
        })
      ]));
      expect(data.recent_value.find((record) => record.state === "quarantined")?.summary).toBe("[quarantined]");

      const html = renderDashboardHtml(data);
      expect(html).toContain("class=\"health-badge");
      expect(html).toContain("Needs Attention");
      expect(html).toContain("Agent Activity");
      expect(html).toContain("Record Quality");
      expect(html).toContain("Record Types");
      expect(html).toContain("Recent Value");
      expect(html).toContain("Debug Inspector");
      expect(html).toContain("agent-bars");
      expect(html).toContain("state-stack");
      expect(html).toContain("type-bars");
      expect(html).toContain("sync-rail");
      expect(html).toContain("value-card");
      expect(html).toContain("table-wrap");
      expect(html).toContain("class=\"neutral-intelligence\"");
      expect(html).toContain("--canvas:");
      expect(html).toContain("--ink:");
      expect(html).toContain("--signal-blue:");
      expect(html).toContain("font-feature-settings:");
      expect(html).toContain(".metric:nth-child(3)");
      expect(html).toContain(".bar-row:nth-child(3)");
      expect(html).toContain(".value-card:nth-child(4)");
      expect(html).not.toContain("Memory Quality");
      expect(html).toContain("overflow-wrap: anywhere");
      expect(html).toContain("table-layout: fixed");
      expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; visible text");
      expect(html).not.toContain("<script>alert('x')</script>");
      expect(html).not.toContain("sk-test_1234567890abcdefghijklmnopqrstuvwxyz");
    });
  });

  it("does not mark health as needs_review for quarantined records superseded by safe indexes", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_${++record}` : `evt_${++event}`;
        })()
      });

      const unsafe = await engine.write({
        kind: "skill",
        type: "codex_workflow_bundle",
        scope: "global",
        tags: ["full-content", "portable-install"],
        content: { text: "sk-test_1234567890abcdefghijklmnopqrstuvwxyz", format: "text" },
        priority: "high",
        source: { client: "codex" }
      });
      await engine.write({
        kind: "skill",
        type: "codex_workflow_bundle_index",
        scope: "global",
        tags: ["portable-install", "index"],
        content: {
          format: "json",
          name: "safe encoded replacement",
          supersedes_quarantined_record: unsafe.record.id,
          artifact_records: [
            { record_id: "rec_artifact", path: "/tmp/artifact", sha256: "abc123", content_encoding: "utf8-hex" }
          ]
        },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });

      expect(data.totals.quarantined_records).toBe(1);
      expect(data.health.status).toBe("local_only");
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          title: "Quarantined records superseded"
        })
      ]));
      expect(data.attention_items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Quarantined records hidden"
        })
      ]));
    });
  });

  it("follows active replacement index chains when resolving quarantined records", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z",
            "2026-06-01T00:03:00.000Z",
            "2026-06-01T00:04:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:05:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_chain_${++record}` : `evt_chain_${++event}`;
        })()
      });

      const unsafe = await engine.write({
        kind: "skill",
        type: "codex_workflow_bundle",
        scope: "global",
        tags: ["full-content", "portable-install"],
        content: { text: "sk-test_abcdefghijklmnopqrstuvwxyz1234567890", format: "text" },
        priority: "high",
        source: { client: "codex" }
      });
      const firstIndex = await engine.write({
        kind: "skill",
        type: "codex_workflow_bundle_index",
        scope: "global",
        tags: ["portable-install", "index"],
        content: {
          format: "json",
          name: "first safe encoded replacement",
          supersedes_quarantined_record: unsafe.record.id
        },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "skill",
        type: "codex_workflow_bundle_index",
        scope: "global",
        tags: ["portable-install", "index"],
        content: {
          format: "json",
          name: "final safe encoded replacement",
          supersedes_index_record: firstIndex.record.id
        },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.archive({
        record_id: firstIndex.record.id,
        reason: "Superseded by final safe encoded replacement.",
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });

      expect(data.totals.quarantined_records).toBe(1);
      expect(data.health.status).toBe("local_only");
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "info",
          title: "Quarantined records superseded"
        })
      ]));
      expect(data.attention_items).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Quarantined records hidden"
        })
      ]));
    });
  });

  it("normalizes agent activity rows by host family", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z",
            "2026-06-01T00:03:00.000Z",
            "2026-06-01T00:04:00.000Z",
            "2026-06-01T00:05:00.000Z",
            "2026-06-01T00:06:00.000Z",
            "2026-06-01T00:07:00.000Z",
            "2026-06-01T00:08:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:09:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_agent_${++record}` : `evt_agent_${++event}`;
        })()
      });

      for (const client of ["codex", "codex-cli", "cli", "agent", "mcp", "claude-code", "kimi-k2", "gemini"]) {
        await engine.write({
          kind: "session_summary",
          type: "status",
          scope: "project",
          project_id: "moryn",
          content: { text: `${client} wrote dashboard activity`, format: "text" },
          source: { client }
        });
      }

      const data = await buildDashboardData(storePath, { limit: 10 });

      expect(data.agent_activity).toEqual([
        expect.objectContaining({
          client: "Codex",
          events: 2,
          records: 2,
          raw_clients: ["codex", "codex-cli"],
          latest_at: "2026-06-01T00:02:00.000Z"
        }),
        expect.objectContaining({
          client: "Moryn Local",
          events: 3,
          records: 3,
          raw_clients: ["agent", "cli", "mcp"],
          latest_at: "2026-06-01T00:05:00.000Z"
        }),
        expect.objectContaining({
          client: "Claude",
          events: 1,
          records: 1,
          raw_clients: ["claude-code"],
          latest_at: "2026-06-01T00:06:00.000Z"
        }),
        expect.objectContaining({
          client: "Kimi",
          events: 1,
          records: 1,
          raw_clients: ["kimi-k2"],
          latest_at: "2026-06-01T00:07:00.000Z"
        }),
        expect.objectContaining({
          client: "Gemini",
          events: 1,
          records: 1,
          raw_clients: ["gemini"],
          latest_at: "2026-06-01T00:08:00.000Z"
        })
      ]);
      expect(data.charts.agent_activity.map((agent) => agent.client)).toEqual(["Codex", "Moryn Local", "Claude", "Kimi", "Gemini"]);
    });
  });

  it("orders Recent Value by newest updated time before value score", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_recent_${++record}` : `evt_recent_${++event}`;
        })()
      });

      const olderDecision = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Older high-value decision", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      const newerStatus = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Newer lower-score status", format: "text" },
        source: { client: "mcp" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });

      expect(data.recent_value.map((record) => record.id)).toEqual([
        newerStatus.record.id,
        olderDecision.record.id
      ]);
    });
  });

  it("adds dashboard citations and timeline links for records, events, and agent activity", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_cite_${++record}` : `evt_cite_${++event}`;
        })()
      });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dashboard citation source", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", session_id: "citation-session" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });
      const value = data.recent_value[0] as {
        citation: {
          record_id: string;
          event_id?: string;
          timeline_command: string;
          recall_command: string;
        };
      };
      const record = data.recent_records[0] as {
        citation: {
          record_id: string;
          event_id?: string;
          timeline_command: string;
          recall_command: string;
        };
      };
      const event = data.recent_events[0] as {
        citation: {
          record_id?: string;
          event_id: string;
          timeline_command: string;
          recall_command?: string;
        };
      };
      const agent = data.agent_activity[0] as {
        citation: {
          event_id: string;
          record_id?: string;
          timeline_command: string;
        };
      };

      expect(value.citation).toEqual({
        record_id: written.record.id,
        event_id: "evt_cite_1",
        timeline_command: `moryn timeline --record-id ${written.record.id} --project-id moryn`,
        recall_command: `moryn recall --record-id ${written.record.id} --project-id moryn`
      });
      expect(record.citation).toEqual(value.citation);
      expect(event.citation).toEqual({
        record_id: written.record.id,
        event_id: "evt_cite_1",
        timeline_command: "moryn timeline --event-id evt_cite_1 --project-id moryn",
        recall_command: `moryn recall --record-id ${written.record.id} --project-id moryn`
      });
      expect(agent.citation).toEqual({
        event_id: "evt_cite_1",
        record_id: written.record.id,
        timeline_command: "moryn timeline --event-id evt_cite_1 --project-id moryn"
      });

      const html = renderDashboardHtml(data);
      expect(html).toContain(`data-dashboard-citation="record:${written.record.id}"`);
      expect(html).toContain(`data-dashboard-citation="event:evt_cite_1"`);
      expect(html).toContain(`moryn timeline --event-id evt_cite_1 --project-id moryn`);
      expect(html).toContain(`moryn recall --record-id ${written.record.id} --project-id moryn`);
    });
  });

  it("hides private-tagged records from the dashboard unless explicitly included", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_private_${++record}` : `evt_private_${++event}`;
        })()
      });

      const publicRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Public dashboard memory.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });
      const privateRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private dashboard memory.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 });
      expect(data.recent_records.map((record) => record.id)).toEqual([publicRecord.record.id]);
      expect(data.recent_value.map((record) => record.id)).toEqual([publicRecord.record.id]);
      expect(data.recent_events.map((event) => event.record_id)).toEqual([publicRecord.record.id]);
      expect(JSON.stringify(data)).not.toContain("Private dashboard memory.");

      const withPrivate = await buildDashboardData(storePath, { limit: 10, include_private: true });
      expect(withPrivate.recent_records.map((record) => record.id)).toEqual([
        privateRecord.record.id,
        publicRecord.record.id
      ]);
      expect(JSON.stringify(withPrivate)).toContain("Private dashboard memory.");

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        include_private: true
      });
      try {
        const serverData = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          recent_records: Array<{ id: string }>;
        };
        expect(serverData.recent_records.map((record) => record.id)).toContain(privateRecord.record.id);
        await expect((await fetch(new URL("/fragment", server.url))).text()).resolves.toContain("Private dashboard memory.");
      } finally {
        await server.close();
      }
    });
  });

  it("writes a local-only static dashboard snapshot", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (prefix: string) => `${prefix}_snapshot`
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Snapshot contains this memory", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const snapshot = await writeDashboardSnapshot(storePath, { limit: 5 });

      expect(snapshot.generated).toBe(true);
      expect(snapshot.opened).toBe(false);
      expect(snapshot.path).toBe(join(storePath, "state", "dashboard", "index.html"));
      expect(snapshot.url).toMatch(/^file:\/\//);
      await expect(readFile(snapshot.path, "utf8")).resolves.toContain("Snapshot contains this memory");
    });
  });

  it("serves a live dashboard that refreshes from the current store", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T00:01:00.000Z",
            "2026-06-01T00:02:00.000Z",
            "2026-06-01T00:03:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:04:00.000Z";
        })(),
        id: (() => {
          let count = 0;
          return (prefix: string) => `${prefix}_live_${++count}`;
        })()
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Initial live dashboard memory", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 5,
        refreshIntervalMs: 250
      });
      try {
        expect(server.serving).toBe(true);
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

        const page = await (await fetch(server.url)).text();
        expect(page).toContain("class=\"neutral-intelligence\"");
        expect(page).toContain("data-dashboard-refresh=\"250\"");
        expect(page).toContain("fetch(\"fragment\"");
        expect(page).toContain("data-dashboard-detail=\"inspector:records\"");
        expect(page).toContain("data-dashboard-detail=\"value:rec_live_1\"");
        expect(page).toContain("captureDetailState");
        expect(page).toContain("restoreDetailState");
        expect(page).toContain("detailState");
        expect(page).toContain("main.addEventListener(\"toggle\"");
        expect(page).toContain("Initial live dashboard memory");

        const head = await fetch(server.url, { method: "HEAD" });
        expect(head.status).toBe(200);

        const initialApi = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          totals: { records: number };
          recent_value: Array<{ summary: string }>;
        };
        expect(initialApi.totals.records).toBe(1);
        expect(initialApi.recent_value[0]?.summary).toBe("Initial live dashboard memory");

        await engine.write({
          kind: "session_summary",
          type: "status",
          scope: "project",
          project_id: "moryn",
          content: { text: "Live dashboard refresh memory", format: "text" },
          source: { client: "codex" }
        });

        const refreshedApi = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          totals: { records: number };
          recent_value: Array<{ summary: string }>;
        };
        expect(refreshedApi.totals.records).toBe(2);
        expect(refreshedApi.recent_value.map((record) => record.summary)).toContain("Live dashboard refresh memory");

        const refreshedFragment = await (await fetch(new URL("/fragment", server.url))).text();
        expect(refreshedFragment).toContain("Live dashboard refresh memory");

        const missing = await fetch(new URL("/missing", server.url));
        expect(missing.status).toBe(404);
      } finally {
        await server.close();
      }
    });
  });
});
