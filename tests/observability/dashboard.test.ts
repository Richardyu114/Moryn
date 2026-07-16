import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { initializeStore } from "../../src/core/config.js";
import { readEvents } from "../../src/core/store.js";
import { recordActivationReceipt } from "../../src/core/activation-receipts.js";
import { writeSyncCompensationReceipt } from "../../src/core/sync-compensation.js";
import {
  buildDashboardData,
  createDashboardDataLoader,
  renderDashboardHtml,
  renderDashboardServerHtml,
  startDashboardServer,
  writeDashboardSnapshot
} from "../../src/observability/dashboard.js";
import { initializeGitSync } from "../../src/sync/git.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

function quietFirstScreenHtml(html: string): string {
  const start = html.indexOf('data-quiet-dashboard="first-screen"');
  const end = html.indexOf('data-quiet-dashboard-end');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("observability dashboard", () => {
  it("reuses an in-flight dashboard data build for concurrent server reads", async () => {
    let calls = 0;
    let release: ((value: { generation: number }) => void) | undefined;
    const loader = createDashboardDataLoader(async () => {
      calls += 1;
      return await new Promise<{ generation: number }>((resolve) => {
        release = resolve;
      });
    });

    const first = loader.load();
    const second = loader.load();
    expect(calls).toBe(1);

    release?.({ generation: 1 });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { generation: 1 },
      { generation: 1 }
    ]);

    const third = loader.load();
    expect(calls).toBe(2);
    release?.({ generation: 2 });
    await expect(third).resolves.toEqual({ generation: 2 });
  });

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
            "2026-06-01T00:03:00.000Z",
            "2026-06-01T00:04:00.000Z"
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
      expect(data.decision_summary).toMatchObject({
        read_only: true,
        total_decisions: 0,
        summary: {
          capture_inbox_groups: 0,
          review_queue_plans: 0,
          candidate_triage_promotions: 0
        },
        items: []
      });
      expect(data.selection_sources).toMatchObject({
        decision_summary: "decision_summary"
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

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("needs-attention-quiet-summary");
      expect(html).not.toContain("<div class=\"attention-focus\" aria-label=\"Action Signals focus\">");
      expect(html).not.toContain("<details id=\"needs-attention\" class=\"panel needs-attention quiet\" data-dashboard-detail=\"needs-attention\" data-dashboard-section=\"needs-attention\">");
      expect(html).not.toContain("<section id=\"needs-attention\" class=\"panel\" data-dashboard-section=\"needs-attention\">");
      expect(html).not.toContain("data-dashboard-detail=\"decision-summary\"");
    });
  });

  it("renders background check items with explicit Chinese translations", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_attention_i18n_${++record}` : `evt_attention_i18n_${++event}`;
        })()
      });

      const unsafe = await engine.write({
        kind: "skill",
        type: "codex_workflow_bundle",
        scope: "global",
        tags: ["full-content", "portable-install"],
        content: { text: "sk-test_attention_i18n_1234567890abcdefghijklmnopqrstuvwxyz", format: "text" },
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
          supersedes_quarantined_record: unsafe.record.id
        },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "A stable memory keeps candidate threshold realistic.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "agent_note",
        type: "raw_note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Temporary raw note should be explained plainly.", format: "text" },
        state: "raw",
        source: { client: "codex" }
      });
      for (let index = 1; index <= 10; index += 1) {
        await engine.write({
          kind: "session_summary",
          type: "status",
          scope: "project",
          project_id: "moryn",
          content: { text: `Saved, not organized item ${index}`, format: "text" },
          state: "candidate",
          source: { client: "codex" }
        });
      }

      const data = await buildDashboardData(storePath, {
        limit: 20,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.attention_items.map((item) => item.title)).toEqual(expect.arrayContaining([
        "Quarantined records superseded",
        "Session notes not remembered",
        "Many items to organize"
      ]));
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("reports configured dirty sync as Sync Pending instead of generic review", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-sync-"));
    const storePath = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      await initializeGitSync(storePath, remote);

      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_sync_pending" : "evt_sync_pending"
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dirty sync should be shown as pending sync.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.sync).toMatchObject({
        configured: true,
        dirty: true,
        sync_state: "dirty",
        ahead: 0,
        behind: 0
      });
      expect(data.health).toMatchObject({
        status: "sync_pending",
        label: "Sync Pending",
        explanation: "Local sync changes are waiting to be pushed or pulled; memory data remains usable on this device."
      });
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Sync changes not pushed",
          description: "Local event history has changes that are not committed or pushed yet.",
          action_label: "Push sync",
          action_command: "moryn sync --push"
        })
      ]));
      expect(data.action_board.items_by_id.sync).toMatchObject({
        label: "Sync",
        value: 1,
        summary: "Sync Pending",
        hint: "Local changes",
        detail: "Local changes"
      });
      expect(data.action_board.items_by_id.review).toMatchObject({
        label: "Review",
        value: 0,
        summary: "No urgent review",
        hint: "Sync handled separately",
        detail: "Sync pending is shown in the Sync lane and Shared copy details.",
        next_action_label: "Open checks",
        target: "needs-attention"
      });
      expect(data.dashboard_overview).toMatchObject({
        headline: "Inspect sync",
        detail: "Local changes",
        primary_action: {
          label: "Inspect sync",
          target: "store-signals",
          source: "action_board.items_by_id.sync"
        }
      });
      expect(data.dashboard_overview.cards_by_id.health.summary).toContain("Local sync changes are waiting to be pushed or pulled");
      expect(data.dashboard_overview.cards.map((card) => card.id)).toEqual(["health", "action", "context", "sync"]);
      expect(data.quiet_dashboard.attention_needed.map((item) => item.title)).not.toContain("Sync changes not pushed");
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Sync changes not pushed"
        })
      ]));
      expect(data.charts.agent_activity.length).toBeGreaterThan(0);
      expect(data.charts.memory_states.length).toBeGreaterThan(0);
      expect(data.charts.record_types.length).toBeGreaterThan(0);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("data-dashboard-work-lanes");
      expect(html).not.toContain("<section id=\"needs-attention\" class=\"needs-attention-quiet-line\" data-dashboard-section=\"needs-attention\" data-dashboard-detail=\"needs-attention\">");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a human-first dashboard with memory inventory, shared copy, recent status, and language switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-action-board-"));
    const storePath = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
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
          return () => timestamps.shift() ?? "2026-06-01T00:02:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_action_board_${++record}` : `evt_action_board_${++event}`;
        })()
      });
      await engine.write({
        kind: "agent_note",
        type: "raw_note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Routine raw note remains API evidence only.", format: "text" },
        state: "raw",
        source: { client: "codex", session_id: "dashboard-all-clear-info" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Moryn should make dashboard storage easy to understand.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", session_id: "dashboard-all-clear-info" }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Recent session status belongs on the dashboard front page.", format: "text" },
        state: "candidate",
        source: { client: "gemini", session_id: "dashboard-all-clear-info" }
      });
      await initializeGitSync(storePath, remote);

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });

      expect(data.action_board.items.map((item) => item.value)).toEqual([0, 0, 0, 0]);
      expect(data.action_board.items.map((item) => item.id)).toEqual(["confirm", "review", "inspect", "sync"]);
      expect(data.health.status).toBe("healthy");
      expect(data.memory_inventory).toMatchObject({
        summary: {
          remembered: 1,
          new_items: 1,
          temporary: 1,
          set_aside: 0,
          total_visible: 3
        },
        review_suggested: true
      });
      expect(data.memory_inventory.states.map((state) => state.id)).toEqual(["remembered", "new_items", "temporary", "set_aside"]);
      expect(data.memory_inventory.states.map((state) => state.label)).toEqual(["Ready to use", "Saved for later", "Saved briefly", "Set aside"]);
      expect(data.memory_inventory.kind_summary).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "memory", label: "Memories", count: 1 }),
        expect.objectContaining({ kind: "session_summary", label: "Session notes", count: 1 }),
        expect.objectContaining({ kind: "agent_note", label: "Agent notes", count: 1 })
      ]));
      expect(data.dashboard_overview.headline).toBe("No action needed");
      expect(data.dashboard_overview.detail).toBe("1 saved item and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.");
      expect(data.dashboard_overview.primary_action).toMatchObject({
        label: "Search saved content",
        target: "stored-content",
        source: "memory_inventory"
      });
      expect(data.attention_items).toContainEqual(expect.objectContaining({
        severity: "info",
        title: "Session notes not remembered"
      }));
      expect(data.health.explanation).toBe("Everything is synced and no action is waiting.");
      expect(data.dashboard_overview.cards.map((card) => card.id)).toEqual(["health", "action", "context", "sync"]);
      expect(data.recent_records[0]).toMatchObject({
        source: { client: "gemini" },
        text: "Recent session status belongs on the dashboard front page."
      });
      expect(data.action_board.items.map((item) => item.id)).toEqual(["confirm", "review", "inspect", "sync"]);
      expect(data.action_board.items_by_id.review).toMatchObject({
        label: "Review",
        value: 0,
        next_action_label: "Open checks",
        target: "needs-attention"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).toContain("<div class=\"editorial-brand\">Moryn</div>");
      expect(html).toContain("<span class=\"editorial-language-label\" data-i18n-en=\"Language\" data-i18n-zh=\"语言\">Language</span>");
      expect(html).toContain("<button type=\"button\" class=\"language-option active\" data-dashboard-language-option=\"en\" aria-pressed=\"true\"><span>EN</span></button>");
      expect(html).toContain("const staticTranslations = new Map(");
      expect(html).not.toContain("data-dashboard-overview");
      expect(html).not.toContain("<article class=\"supporting-evidence-summary-row\"");
      expect(html).not.toContain("<details class=\"panel supporting-evidence\" data-dashboard-detail=\"supporting-evidence\" aria-label=\"Supporting Evidence\">");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("translates recent status empty saved-content state", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_empty_recent_status"
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-01T00:05:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).toContain("Nothing has been saved yet. Saved memories will be searchable here.");
    });
  });

  it("keeps the seven-day saved-content trend in audit details", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-15T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-15T00:01:00.000Z",
            "2026-06-17T00:01:00.000Z",
            "2026-06-20T00:01:00.000Z",
            "2026-06-21T00:01:00.000Z",
            "2026-06-21T00:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-21T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_activity_trend_${++record}` : `evt_activity_trend_${++event}`;
        })()
      });

      for (const text of [
        "Saved trend day one",
        "Saved trend day three",
        "Saved trend day six",
        "Saved trend day seven first",
        "Saved trend day seven second"
      ]) {
        await engine.write({
          kind: "memory",
          type: "status",
          scope: "project",
          project_id: "moryn",
          content: { text, format: "text" },
          state: "candidate",
          source: { client: "codex", session_id: "dashboard-activity-trend" }
        });
      }

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T12:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });

      expect(data.charts.activity_trend).toMatchObject({
        total: 5,
        peak: 2
      });
      expect(data.charts.activity_trend.days.map((day) => day.date)).toEqual([
        "2026-06-15",
        "2026-06-16",
        "2026-06-17",
        "2026-06-18",
        "2026-06-19",
        "2026-06-20",
        "2026-06-21"
      ]);
      expect(data.charts.activity_trend.days.map((day) => day.count)).toEqual([1, 0, 1, 0, 0, 1, 2]);
      expect(data.charts.activity_trend.days.map((day) => day.percent)).toEqual([50, 0, 50, 0, 0, 50, 100]);

      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).toContain("Recent saves");
    });
  });

  it("expands additional stored content from the first-screen view-more control", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_stored_more_${++record}` : `evt_stored_more_${++event}`;
        })()
      });
      for (let index = 1; index <= 6; index += 1) {
        await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          content: { text: `Stored content item ${index}`, format: "text" },
          state: "canonical",
          confirmed: true,
          source: { client: "codex" }
        });
      }

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });
      const serverHtml = renderDashboardServerHtml(data, 2000, { showStoredContent: true });

      expect(data.recent_value).toHaveLength(6);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(serverHtml).toContain("window.dashboardWorkspaceInteraction");
    });
  });

  it("keeps first-screen stored content representative across memory states", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_representative_${++record}` : `evt_representative_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Representative canonical memory", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Representative candidate memory", format: "text" },
        state: "candidate",
        source: { client: "codex" }
      });
      await engine.write({
        kind: "agent_note",
        type: "raw_note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Representative raw note", format: "text" },
        state: "raw",
        source: { client: "codex" }
      });
      for (let index = 1; index <= 4; index += 1) {
        await engine.write({
          kind: "session_summary",
          type: "status",
          scope: "project",
          project_id: "moryn",
          content: { text: `Newest archived memory ${index}`, format: "text" },
          state: "archived",
          source: { client: "codex" }
        });
      }

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });

      expect(data.recent_value.slice(0, 4).map((item) => item.state)).toEqual(["archived", "archived", "archived", "archived"]);
      expect(data.stored_content_preview.map((item) => item.state)).toEqual(["candidate", "canonical", "raw", "archived"]);
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("explains saved-content cards before opening details", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_saved_explain_${++record}` : `evt_saved_explain_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Explained canonical memory", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" },
        provenance: {
          method: "user-confirmed",
          reason: "User confirmed this as durable project memory."
        }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Explained candidate memory", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "saved-explain" },
        provenance: {
          method: "agent-proposed",
          reason: "Captured through Moryn host adapter autocapture."
        }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Explained low-risk handoff", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "saved-explain-low-risk" },
        provenance: {
          method: "agent-proposed",
          reason: "Autocapture policy retained this low-risk handoff without canonical promotion."
        }
      });
      await engine.write({
        kind: "agent_note",
        type: "raw_note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Explained raw memory", format: "text" },
        state: "raw",
        source: { client: "gemini" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });
      const candidateValue = data.recent_value.find((record) => record.id === "rec_saved_explain_2") as {
        provenance_method?: string;
        provenance_reason?: string;
      } | undefined;

      expect(candidateValue).toMatchObject({
        provenance_method: "agent-proposed",
        provenance_reason: "Captured through Moryn host adapter autocapture."
      });
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("keeps dashboard action targets resolvable from visible controls", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_action_target_${++record}` : `evt_action_target_${++event}`;
        })()
      });
      for (let index = 1; index <= 5; index += 1) {
        await engine.write({
          kind: "session_summary",
          type: "status",
          scope: "project",
          project_id: "moryn",
          content: { text: `Action target saved content ${index}`, format: "text" },
          state: index === 1 ? "candidate" : "canonical",
          confirmed: index !== 1,
          source: { client: "codex" }
        });
      }

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });
      const targetMatches = [...html.matchAll(/data-drawer-target="([^"]+)"/g)].map((match) => match[1]);
      const unresolved = targetMatches.filter((target) => {
        const escaped = target?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return !new RegExp(`data-drawer-payload="${escaped}"`).test(html);
      });

      expect(targetMatches.length).toBeGreaterThan(0);
      expect(unresolved).toEqual([]);
    });
  });

  it("renders a local memory search for stored records and events", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_memory_search_${++record}` : `evt_memory_search_${++event}`;
        })()
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Searchable dashboard keyword alpha", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });

      expect(data.recent_records.map((record) => record.id)).toContain("rec_memory_search_1");
      expect(data.recent_events.map((event) => event.event_id)).toContain("evt_memory_search_1");
      expect(html).toContain("data-memory-search");
      expect(html).toContain("data-memory-search-input");
      expect(html).toContain("data-memory-result");
      expect(html).toContain("data-drawer-target=\"record-rec_memory_search_1\"");
      expect(html).toContain("Searchable dashboard keyword alpha");
      expect(html).toContain("data-drawer-payload=\"record-rec_memory_search_1\"");
    });
  });

  it("keeps memory search scrolling stable with compact result cards", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_memory_perf_${++record}` : `evt_memory_perf_${++event}`;
        })()
      });
      const longText = Array.from({ length: 36 }, (_, index) => `long dashboard memory paragraph ${index + 1}`).join(" ");
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: longText, format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });

      // The redesigned Memory view surfaces a searchable result per record; the
      // long body is exposed through the searchable result and its drawer.
      expect(html).toContain("data-memory-result");
      expect(html).toContain("data-drawer-target=\"record-rec_memory_perf_1\"");
      expect(html).toContain("data-drawer-payload=\"record-rec_memory_perf_1\"");
    });
  });

  it("supports command-style memory search shortcuts", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-18T00:01:00.000Z",
            "2026-06-10T00:01:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-21T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_memory_command_${++record}` : `evt_memory_command_${++event}`;
        })()
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Codex decision for command search", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Gemini handoff queue command search", format: "text" },
        state: "candidate",
        source: { client: "gemini" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data, { showStoredContent: true });

      // The redesigned Memory view exposes per-kind chips and searchable results
      // instead of the removed command-style search panel.
      expect(html).toContain("data-memory-search");
      expect(html).toContain("data-memory-chip");
      expect(html).toContain("data-chip-kind=\"memory\"");
      expect(html).toContain("data-chip-kind=\"session_summary\"");
      expect(html).toContain("data-memory-result");
      expect(html).toContain("Codex decision for command search");
      expect(html).toContain("Gemini handoff queue command search");
    });
  });

  it("keeps compact technical details quiet when only saved notes need review", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-quiet-background-"));
    const storePath = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let timestamp = 0;
          return () => `2026-06-01T00:${String(++timestamp).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_quiet_background_${++record}` : `evt_quiet_background_${++event}`;
        })()
      });
      await engine.write({
        kind: "agent_note",
        type: "raw_note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Routine raw note remains API evidence only.", format: "text" },
        state: "raw",
        source: { client: "codex", session_id: "quiet-background" }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dogfood timeout blocked a dashboard review.", format: "text" },
        state: "canonical",
        confirmed: true,
        confidence: 0.8,
        source: { client: "codex", session_id: "quiet-background" }
      });
      for (let index = 1; index <= 3; index++) {
        await engine.write({
          kind: "agent_note",
          type: "raw_note",
          scope: "project",
          project_id: "moryn",
          tags: ["scratch"],
          content: { text: `Temporary scratch candidate ${index}.`, format: "text" },
          state: "candidate",
          source: { client: "codex", session_id: "quiet-background" }
        });
      }
      await initializeGitSync(storePath, remote);

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.health.status).toBe("healthy");
      expect(data.dashboard_overview.headline).toBe("No action needed");
      expect(data.dashboard_overview.detail).toBe("3 saved items and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.");
      expect(data.dashboard_overview.primary_action).toMatchObject({
        label: "Search saved content",
        target: "stored-content",
        source: "memory_inventory"
      });
      expect(data.candidate_triage.summary).toMatchObject({
        total_candidates: 3,
        groups: 1,
        needs_inspection: 3
      });
      expect(data.governance.summary).toMatchObject({
        total_items: 2,
        needs_user_action: 0,
        safe_inspections: 2
      });
      expect(data.dogfood_report.findings).toHaveLength(1);
      expect(html).toContain("data-dashboard-editorial-shell");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a compact read-only Health Check summary", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-21T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-21T00:01:00.000Z",
            "2026-06-21T00:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-21T00:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_health_${++record}` : `evt_health_${++event}`;
        })()
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Dashboard health check should point at Capture Inbox.", format: "text" },
        source: { client: "codex", session_id: "dashboard-health" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private dashboard health check detail must stay hidden.", format: "text" },
        source: { client: "codex" }
      });
      await writeSyncCompensationReceipt(storePath, { occurred_at: "2026-06-21T00:04:00.000Z", project_id: "moryn", decision: "pushed", reason: "pending_continuity_events", pending_paths: ["events/checkpoint.json"], continuity_record_ids: ["rec_health_1"] });

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        readiness_host: "codex",
        sync_remote: "git@github.com:user/moryn-store.git",
        now: "2026-06-21T00:10:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.health_check).toMatchObject({
        read_only: true,
        status: "needs_attention",
        retrieval_index: { status: "fresh", source: "retrieval_index", repaired: false },
        sync_compensation: { decision: "pushed", reason: "pending_continuity_events" },
        summary: {
          warning_checks: 1,
          failing_checks: 0
        }
      });
      expect(data.health_check.checks_by_id.capture_review_backlog).toMatchObject({
        status: "warning",
        category: "capture",
        record_ids: ["rec_health_1"]
      });
      expect(data.health_check.suggested_actions_by_id.review_capture_inbox).toMatchObject({
        tool: "dashboard",
        safe_to_run: true
      });
      expect(data.health_check.suggested_actions_by_id.capture_session).toMatchObject({
        tool: "capture_session",
        safe_to_run: false,
        required_fields: ["summary"]
      });
      expect(data.health_check.setup_readiness).toMatchObject({
        host: "codex",
        host_adapter: "Codex",
        sync_remote: "git@github.com:user/moryn-store.git",
        install_command: "moryn install --host codex --sync-remote git@github.com:user/moryn-store.git",
        context_pack_command: "moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task '<current task>' --agent codex",
        capture_command: "moryn capture session --project-id moryn --sync-remote git@github.com:user/moryn-store.git --agent codex --summary '<summary>'"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(data.health_check.suggested_actions.map((action) => action.command)).toEqual(expect.arrayContaining([
        "moryn dashboard --serve --project-id moryn",
        "moryn install --host codex --sync-remote git@github.com:user/moryn-store.git",
        "moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task '<current task>' --agent codex"
      ]));
      expect(JSON.stringify(data.health_check)).not.toContain("Private dashboard health check detail");
      expect(html).not.toContain("Private dashboard health check detail");
    });
  });

  it("adds a read-only Governance Hub shell without writing events", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_governance_${++record}` : `evt_governance_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Visible governance context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private governance context must stay hidden.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        governance: {
          read_only: boolean;
          version: number;
          scope: string;
          summary: {
            total_items: number;
            needs_user_action: number;
            safe_inspections: number;
            hidden_private_records: number;
          };
          sources: Record<string, boolean>;
          items: unknown[];
          items_by_id: Record<string, unknown>;
          selection_sources: Record<string, string>;
        };
        actions_by_id: Record<string, {
          action_id: string;
          surface: string;
          kind: string;
          label: string;
          intent: string;
          target: { type: string; id: string };
          endpoint?: string;
          method?: string;
          request_body?: Record<string, unknown>;
          safety: {
            safe_to_auto_run: boolean;
            requires_user_confirmation: boolean;
            writes: string;
            stale_guard?: string;
          };
          source_path: string;
        }>;
      };

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.governance).toMatchObject({
        read_only: true,
        version: 1,
        scope: "local_dashboard",
        summary: {
          total_items: 0,
          needs_user_action: 0,
          safe_inspections: 0,
          hidden_private_records: 1
        },
        sources: {
          capture_policy: true,
          memory_lifecycle: true,
          maintenance: true,
          dogfood_report: true
        },
        selection_sources: {
          governance: "governance",
          item: "governance.items_by_id.<item_id>",
          item_id: "governance.items_by_id.<item_id>.id"
        }
      });
      expect(data.governance.items).toEqual([]);
      expect(data.governance.items_by_id).toEqual({});
      expect(JSON.stringify(data.governance)).not.toContain("Private governance context must stay hidden");
    });
  });

  it("renders safe-only Governance Hub as an API-backed index", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_governance_safe_only" : "evt_governance_safe_only"
      });

      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dogfood timeout blocked a dashboard review.", format: "text" },
        state: "canonical",
        confirmed: true,
        confidence: 0.8,
        source: { client: "codex", session_id: "governance-safe-only" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.governance.summary).toMatchObject({
        total_items: 1,
        needs_user_action: 0,
        safe_inspections: 1,
        hidden_private_records: 0
      });
      expect(data.governance.items_by_id["dogfood_report:failure_signals"]).toMatchObject({
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("excludes unrelated global records from project dogfood findings", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let tick = 0;
          return () => `2026-06-01T00:01:${String(tick++).padStart(2, "0")}.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_project_dogfood_${++record}` : `evt_project_dogfood_${++event}`;
        })()
      });

      const projectFailure = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dogfood timeout blocked the dashboard review.", format: "text" },
        source: { client: "codex", session_id: "project-dogfood" }
      });
      const unrelatedGlobal = await engine.write({
        kind: "memory",
        type: "notion_publish_event",
        scope: "global",
        tags: ["notion", "verified-publish"],
        content: { text: "Global Notion publish failed once but was verified in another workflow.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", session_id: "global-dogfood" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });

      expect(data.dogfood_report.findings_by_id.failure_signals).toMatchObject({
        record_ids: [projectFailure.record.id]
      });
      expect(data.dogfood_report.findings_by_id.failure_signals?.record_ids).not.toContain(unrelatedGlobal.record.id);
      expect(data.dogfood_report.records_by_id[unrelatedGlobal.record.id]).toBeUndefined();
      expect(JSON.stringify(data.dogfood_report)).not.toContain("Global Notion publish failed once");
    });
  });

  it("surfaces candidate backlog as a read-only memory doctor governance item", async () => {
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
            "2026-06-01T00:05:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:06:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_memory_doctor_${++record}` : `evt_memory_doctor_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical baseline for memory doctor governance.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      for (const text of [
        "Candidate backlog item one.",
        "Candidate backlog item two.",
        "Candidate backlog item three.",
        "Candidate backlog item four."
      ]) {
        await engine.write({
          kind: "session_summary",
          type: "summary",
          scope: "project",
          project_id: "moryn",
          tags: ["autocapture"],
          content: { text, format: "text" },
          state: "candidate",
          source: { client: "codex", session_id: "memory-doctor-dashboard-test" }
        });
      }

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        memory_doctor: {
          read_only: boolean;
          findings_by_id: Record<string, { summary: string; reason: string }>;
          suggested_actions: Array<{ safe_to_run: boolean }>;
        };
      };
      const html = renderDashboardHtml(data);

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.memory_doctor).toMatchObject({
        read_only: true,
        findings_by_id: {
          candidate_backlog: {
            summary: "Candidate records are accumulating faster than canonical records.",
            reason: "4 candidate records vs 1 canonical records."
          }
        },
        suggested_actions: []
      });
      expect(data.governance.sources).toMatchObject({
        memory_doctor: true
      });
      expect(data.governance.items_by_id["memory_doctor:candidate_backlog"]).toMatchObject({
        source: "memory_doctor",
        category: "candidate_backlog",
        severity: "warning",
        title: "Candidate records are accumulating faster than canonical records.",
        summary: "4 candidate records vs 1 canonical records.",
        record_ids: [],
        evidence_path: "memory_doctor.findings_by_id.candidate_backlog",
        action_label: "Review candidate backlog",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none",
        review_log: [
          "Detected: Candidate records are accumulating faster than canonical records.",
          "Recommended next step: Review candidate backlog.",
          "Write boundary: read-only inspection; no memory writes.",
          "Evidence source: memory_doctor.findings_by_id.candidate_backlog"
        ]
      });
      expect(data.actions.some((action) => action.source_path.startsWith("memory_doctor"))).toBe(false);
      expect(data.candidate_triage.review_focus?.summary).toBe("Start with Session summaries: Inspect handoff value");
      expect(data.candidate_triage.groups_by_id.session_summaries?.evidence_path).toBe("candidate_triage.groups_by_id.session_summaries");
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("data-dashboard-action-id=\"memory_doctor");
    });
  });

  it("surfaces duplicate and conflicting candidate doctor findings as read-only governance items", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_doctor_quality_${++record}` : `evt_doctor_quality_${++event}`;
        })()
      });
      const duplicateOne = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Use dashboard approvals for canonical memory.", format: "text" },
        source: { client: "codex" }
      });
      const duplicateTwo = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Use dashboard approvals for canonical memory.", format: "text" },
        source: { client: "claude" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["storage"],
        content: { text: "Use SQLite for the local event store.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const conflicting = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["storage"],
        content: { text: "Use JSONL for the local event store.", format: "text" },
        state: "canonical",
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.memory_doctor.findings_by_id.duplicate_candidates).toMatchObject({
        summary: "Some candidate records appear to duplicate each other.",
        record_ids: [duplicateOne.record.id, duplicateTwo.record.id]
      });
      expect(data.memory_doctor.findings_by_id.conflicting_candidates).toMatchObject({
        summary: "Some candidate records conflict with canonical memory.",
        record_ids: [conflicting.record.id]
      });
      expect(data.governance.items_by_id["memory_doctor:duplicate_candidates"]).toMatchObject({
        source: "memory_doctor",
        category: "candidate_quality",
        evidence_path: "memory_doctor.findings_by_id.duplicate_candidates",
        action_label: "Review duplicate candidates",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.governance.items_by_id["memory_doctor:conflicting_candidates"]).toMatchObject({
        source: "memory_doctor",
        category: "candidate_quality",
        evidence_path: "memory_doctor.findings_by_id.conflicting_candidates",
        action_label: "Review conflicting candidates",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.governance.summary).toMatchObject({
        total_items: 3,
        needs_user_action: 0,
        safe_inspections: 3
      });
      expect(data.actions.some((action) => action.source_path.startsWith("memory_doctor"))).toBe(false);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("data-dashboard-action-id=\"memory_doctor");
    });
  });

  it("adds a read-only candidate triage queue for memory doctor backlog", async () => {
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
            "2026-06-01T00:06:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:07:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_candidate_triage_${++record}` : `evt_candidate_triage_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical baseline for candidate triage.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["smoke", "autocapture"],
        content: { text: "Smoke marker from dashboard test.", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "candidate-triage" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Always keep dashboard governance readable.", format: "text" },
        state: "candidate",
        priority: "high",
        confidence: 0.95,
        source: { client: "codex", session_id: "candidate-triage" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["handoff"],
        content: { text: "Finished dashboard polish and ran release check.", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "candidate-triage" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        tags: ["scratch"],
        content: { text: "Temporary implementation note.", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "candidate-triage" }
      });

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        candidate_triage: {
          read_only: true;
          available: boolean;
          summary: {
            total_candidates: number;
            groups: number;
            likely_noise: number;
            promotable: number;
            session_summaries: number;
            needs_inspection: number;
            shown_records: number;
          };
          groups: Array<{
            id: string;
            label: string;
            recommended_next_step: string;
            review_handoff: {
              label: string;
              existing_control: string;
              guidance: string;
              write_boundary: string;
            };
            writes: string;
            requires_user_confirmation: boolean;
            record_ids: string[];
            evidence_path: string;
          }>;
          groups_by_id: Record<string, {
            id: string;
            record_ids: string[];
            evidence_path: string;
            records: Array<{
              id: string;
              text: string;
            }>;
            records_by_id: Record<string, {
              id: string;
              record_index: number;
              evidence_path: string;
              text?: string;
              citation?: unknown;
            }>;
            promotion_drafts_by_id?: Record<string, {
              record_id: string;
              target_state: string;
              reason: string;
              command: string;
              requires_user_confirmation: boolean;
              writes: string;
              source_path: string;
              approve_endpoint: string;
              action_id: string;
            }>;
            review_handoff: {
              label: string;
              existing_control: string;
              guidance: string;
              write_boundary: string;
            };
          }>;
          selection_sources: Record<string, string>;
        };
      };
      const html = renderDashboardHtml(data);

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.candidate_triage).toMatchObject({
        read_only: true,
        available: true,
        review_focus: {
          group_id: "promotable",
          label: "Promotable candidates",
          summary: "Start with Promotable candidates: Inspect before promotion",
          recommended_next_step: "Inspect before promotion",
          evidence_path: "candidate_triage.groups_by_id.promotable",
          writes: "none",
          requires_user_confirmation: false
        },
        summary: {
          total_candidates: 4,
          groups: 4,
          likely_noise: 1,
          promotable: 1,
          session_summaries: 1,
          needs_inspection: 1,
          shown_records: 4
        },
        selection_sources: {
          candidate_triage: "candidate_triage",
          review_focus: "candidate_triage.review_focus",
          group: "candidate_triage.groups_by_id.<group_id>",
          group_id: "candidate_triage.groups_by_id.<group_id>.id",
          record: "candidate_triage.groups_by_id.<group_id>.records[]",
          record_id: "candidate_triage.groups_by_id.<group_id>.records_by_id.<record_id>.id"
        }
      });
      expect(data.candidate_triage.groups_by_id.likely_noise).toMatchObject({
        id: "likely_noise",
        record_ids: ["rec_candidate_triage_2"],
        evidence_path: "candidate_triage.groups_by_id.likely_noise",
        review_handoff: {
          label: "Archive review",
          existing_control: "Capture Inbox or Memory Doctor",
          guidance: "Reject eligible Capture Inbox candidates; archive confirmed noise only through explicit Memory Doctor guidance.",
          write_boundary: "Review first; approve only through draft rows"
        }
      });
      expect(data.candidate_triage.groups_by_id.likely_noise.records[0]).toMatchObject({
        id: "rec_candidate_triage_2",
        text: "Smoke marker from dashboard test."
      });
      expect(data.candidate_triage.groups_by_id.likely_noise.records_by_id.rec_candidate_triage_2).toEqual({
        id: "rec_candidate_triage_2",
        record_index: 0,
        evidence_path: "candidate_triage.groups_by_id.likely_noise.records[0]"
      });
      expect(data.candidate_triage.groups_by_id.promotable).toMatchObject({
        id: "promotable",
        record_ids: ["rec_candidate_triage_3"],
        evidence_path: "candidate_triage.groups_by_id.promotable",
        review_handoff: {
          label: "Approval review",
          existing_control: "Capture Inbox",
          guidance: "Approve eligible Capture Inbox candidates only after checking provenance and record text.",
          write_boundary: "Review first; approve only through draft rows"
        }
      });
      expect(data.candidate_triage.groups_by_id.promotable.promotion_drafts_by_id).toEqual({
        rec_candidate_triage_3: {
          record_id: "rec_candidate_triage_3",
          target_state: "canonical",
          reason: "User approved Candidate Triage promotion draft.",
          command: "moryn promote rec_candidate_triage_3 --state canonical --reason 'User approved Candidate Triage promotion draft.' --confirm",
          requires_user_confirmation: true,
          writes: "append_only_events",
          source_path: "candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.rec_candidate_triage_3",
          approve_endpoint: "api/candidate-triage/promotions/rec_candidate_triage_3/approve",
          action_id: "candidate_triage.promotion.approve.rec_candidate_triage_3"
        }
      });
      expect(data.actions_by_id["candidate_triage.promotion.approve.rec_candidate_triage_3"]).toMatchObject({
        action_id: "candidate_triage.promotion.approve.rec_candidate_triage_3",
        surface: "candidate_triage",
        kind: "dashboard_api",
        label: "Approve Memory",
        intent: "approve",
        target: { type: "record", id: "rec_candidate_triage_3" },
        endpoint: "api/candidate-triage/promotions/rec_candidate_triage_3/approve",
        method: "POST",
        request_body: {},
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.rec_candidate_triage_3"
      });
      expect(data.candidate_triage.groups_by_id.likely_noise.promotion_drafts_by_id).toEqual({});
      expect(data.decision_summary).toMatchObject({
        total_decisions: 2,
        summary: {
          capture_inbox_groups: 0,
          review_queue_plans: 1,
          candidate_triage_promotions: 1
        }
      });
      expect(data.decision_summary.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "candidate_triage:promotion:rec_candidate_triage_3",
          surface: "candidate_triage",
          title: "Approve Candidate Triage promotion",
          decision_label: "Approve Memory",
          target: "candidate-triage",
          target_label: "Open Candidate Triage",
          primary_action_id: "candidate_triage.promotion.approve.rec_candidate_triage_3",
          requires_user_confirmation: true,
          writes: "append_only_events",
          safety_note: "Approve Memory appends a promotion event only after the active candidate guard passes.",
          evidence_path: "candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.rec_candidate_triage_3"
        })
      ]));
      expect(data.decision_summary.items_by_id["candidate_triage:promotion:rec_candidate_triage_3"]).toMatchObject({
        target: "candidate-triage"
      });
      expect(data.candidate_triage.groups.map((group) => group.id)).toEqual([
        "likely_noise",
        "promotable",
        "session_summaries",
        "needs_inspection"
      ]);
      expect(data.candidate_triage.groups[0]).not.toHaveProperty("records");
      expect(data.candidate_triage.groups[0]).not.toHaveProperty("records_by_id");
      expect(data.candidate_triage.groups.every((group) => group.writes === "none")).toBe(true);
      expect(data.candidate_triage.groups.every((group) => group.requires_user_confirmation === false)).toBe(true);

      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("data-dashboard-action-id=\"candidate-triage");
      expect(html).not.toContain("Approve Triage");
      expect(html).not.toContain("Archive Group");
      expect(html).not.toContain("Promote Selected");
    });
  });

  it("keeps read-only candidate backlog samples out of HTML while preserving full API evidence", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let minute = 0;
          return () => `2026-06-01T00:${String(++minute).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_budgeted_triage_${++record}` : `evt_budgeted_triage_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Canonical baseline for budgeted triage.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      for (let index = 1; index <= 7; index++) {
        await engine.write({
          kind: "agent_note",
          type: "note",
          scope: "project",
          project_id: "moryn",
          tags: ["scratch"],
          content: { text: `Temporary scratch candidate ${index}.`, format: "text" },
          state: "candidate",
          source: { client: "codex", session_id: "budgeted-triage" }
        });
      }

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);
      const needsInspection = data.candidate_triage.groups_by_id.needs_inspection;

      expect(needsInspection?.record_ids).toHaveLength(7);
      expect(needsInspection?.records).toHaveLength(3);
      expect(needsInspection?.records.map((record) => record.id)).toEqual([
        "rec_budgeted_triage_8",
        "rec_budgeted_triage_7",
        "rec_budgeted_triage_6"
      ]);
      expect(needsInspection?.records_by_id.rec_budgeted_triage_8).toMatchObject({
        id: "rec_budgeted_triage_8"
      });
      expect(needsInspection?.records_by_id.rec_budgeted_triage_5).toEqual({
        id: "rec_budgeted_triage_5",
        record_index: 3,
        evidence_path: "candidate_triage.groups_by_id.needs_inspection.record_ids[3]"
      });
      expect(data.candidate_triage.review_focus).toEqual({
        group_id: "needs_inspection",
        label: "Needs inspection",
        summary: "Start with Needs inspection: Inspect timeline",
        recommended_next_step: "Inspect timeline",
        evidence_path: "candidate_triage.groups_by_id.needs_inspection",
        writes: "none",
        requires_user_confirmation: false
      });
      expect(JSON.stringify(data.candidate_triage)).toContain("Temporary scratch candidate 7.");
      expect(JSON.stringify(data.candidate_triage)).not.toContain("Temporary scratch candidate 4.");
      expect(data.candidate_triage.groups_by_id.needs_inspection?.evidence_path).toBe("candidate_triage.groups_by_id.needs_inspection");
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("data-dashboard-action-id=\"candidate-triage");
    });
  });

  it("keeps generated candidate triage sample ids in API evidence for read-only backlog", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let minute = 0;
          return () => `2026-06-01T00:${String(++minute).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          const recordIds = [
            "rec_candidate_short_baseline",
            "rec_abcdef1234567890abcdef1234567890",
            "rec_candidate_short_context"
          ];
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? recordIds[record++] : `evt_candidate_short_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Canonical baseline for short candidate sample labels.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "moryn",
        content: { text: "Keep generated candidate sample ids compact in folded dashboard rows.", format: "text" },
        state: "candidate",
        priority: "normal",
        confidence: 0.5,
        source: { client: "codex", session_id: "candidate-short-labels" }
      });
      await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        content: { text: "Readable id candidate keeps its full label.", format: "text" },
        state: "candidate",
        source: { client: "codex", session_id: "candidate-short-labels" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);
      const generatedId = "rec_abcdef1234567890abcdef1234567890";

      expect(data.candidate_triage.groups_by_id.needs_inspection?.records_by_id[generatedId]).toMatchObject({
        id: generatedId,
        record_index: 1
      });
      expect(data.candidate_triage.groups_by_id.needs_inspection?.records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: generatedId,
          citation: expect.objectContaining({
            timeline_command: `moryn timeline --record-id ${generatedId} --project-id moryn`,
            recall_command: `moryn recall --record-id ${generatedId} --project-id moryn`
          })
        })
      ]));
      expect(data.candidate_triage.review_focus?.summary).toBe("Start with Needs inspection: Inspect timeline");
      expect(data.candidate_triage.groups_by_id.needs_inspection?.evidence_path).toBe("candidate_triage.groups_by_id.needs_inspection");
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("aggregates existing reports into Governance Hub items", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-20T00:01:00.000Z",
            "2026-06-20T00:02:00.000Z",
            "2026-06-20T00:03:00.000Z",
            "2026-06-20T00:04:00.000Z",
            "2026-04-01T00:00:00.000Z",
            "2026-06-20T00:05:00.000Z",
            "2026-06-20T00:06:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-20T00:07:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_governance_item_${++record}` : `evt_governance_item_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn governance context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project governance context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "json",
          text: "Governance handoff still needs manual review.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "review",
              review_required: true,
              auto_canonical: false,
              rule_ids: ["default_review_for_agent_handoff"]
            }
          }
        },
        confidence: 0.8,
        source: { client: "codex", session_id: "governance-review" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          format: "json",
          text: "Governance low-risk handoff was retained.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        confidence: 0.8,
        source: { client: "codex", session_id: "governance-auto-capture" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Old governance decision needs timeline inspection.", format: "text" },
        state: "canonical",
        confirmed: true,
        confidence: 0.8,
        source: { client: "user" }
      });
      await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "Governance dogfood note: timeout blocked the dashboard review.", format: "text" },
        confidence: 0.8,
        source: { client: "codex", session_id: "governance-dogfood" }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private Governance Hub item must stay hidden.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        governance: {
          summary: {
            total_items: number;
            needs_user_action: number;
            safe_inspections: number;
            hidden_private_records: number;
          };
          sources: Record<string, boolean>;
          items: Array<{
            id: string;
            source: string;
            category: string;
            severity: string;
            title: string;
            summary: string;
            record_ids: string[];
            evidence_path: string;
            action_label: string;
            action_id?: string;
            review_log: string[];
            safe_to_run: boolean;
            requires_user_confirmation: boolean;
            writes: string;
          }>;
          items_by_id: Record<string, {
            id: string;
            source: string;
            category: string;
            severity: string;
            title: string;
            summary: string;
            record_ids: string[];
            evidence_path: string;
            action_label: string;
            action_id?: string;
            review_log: string[];
            safe_to_run: boolean;
            requires_user_confirmation: boolean;
            writes: string;
          }>;
        };
        dogfood_report: {
          findings_by_id: Record<string, { summary: string; reason?: string; record_ids?: string[] }>;
          suggested_actions_by_id: Record<string, { recommended_action: string; command: string }>;
        };
      };

      const maintenancePlan = data.maintenance.plans[0];
      const maintenanceActionId = `maintenance.plan.approve.${maintenancePlan?.plan_hash.replace(/^sha256:/, "")}`;

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.governance.summary).toMatchObject({
        total_items: 6,
        needs_user_action: 1,
        safe_inspections: 5,
        hidden_private_records: 1
      });
      expect(data.governance.sources).toMatchObject({
        capture_policy: true,
        memory_doctor: true,
        memory_lifecycle: true,
        maintenance: true,
        dogfood_report: true
      });
      expect(Object.keys(data.governance.items_by_id)).toEqual(data.governance.items.map((item) => item.id));
      expect(data.governance.items_by_id["capture_policy:review_required"]).toMatchObject({
        source: "capture_policy",
        category: "capture_review",
        severity: "info",
        record_ids: ["rec_governance_item_3"],
        evidence_path: "capture_policy.findings_by_id.review_required",
        action_label: "Review in Capture Inbox",
        review_log: [
          "Detected: Some captured records are waiting for a human decision.",
          "Recommended next step: Review in Capture Inbox.",
          "Write boundary: requires explicit approval before append-only memory events.",
          "Evidence source: capture_policy.findings_by_id.review_required"
        ],
        safe_to_run: false,
        requires_user_confirmation: true,
        writes: "append_only_events"
      });
      expect(data.governance.items_by_id["capture_policy:auto_captured"]).toMatchObject({
        source: "capture_policy",
        category: "auto_capture",
        record_ids: ["rec_governance_item_4"],
        evidence_path: "capture_policy.findings_by_id.auto_captured",
        action_label: "inspect_auto_captured_handoff",
        action_id: "capture_policy.inspect.rec_governance_item_4",
        review_log: [
          "Detected: Captured handoff records already handled by policy.",
          "Recommended next step: inspect_auto_captured_handoff.",
          "Write boundary: read-only inspection; no memory writes.",
          "Evidence source: capture_policy.findings_by_id.auto_captured"
        ],
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.governance.items_by_id["memory_doctor:candidate_backlog"]).toMatchObject({
        source: "memory_doctor",
        category: "candidate_backlog",
        severity: "warning",
        evidence_path: "memory_doctor.findings_by_id.candidate_backlog",
        action_label: "Review candidate backlog",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.governance.items_by_id["memory_lifecycle:stale_records"]).toMatchObject({
        source: "memory_lifecycle",
        category: "memory_lifecycle",
        severity: "info",
        record_ids: ["rec_governance_item_5"],
        evidence_path: "memory_lifecycle.findings_by_id.stale_records",
        action_label: "inspect_timeline",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.maintenance.plans_by_id[maintenancePlan?.plan_id ?? ""]).toBeDefined();
      expect(data.decision_summary.items_by_id[`maintenance_review:${maintenancePlan?.plan_hash.replace(/^sha256:/, "")}`]).toMatchObject({
        surface: "maintenance_review",
        title: "Project identity repair",
        decision_label: "Apply Repair",
        primary_action_id: maintenanceActionId,
        evidence_path: "maintenance.plans[]"
      });
      expect(data.governance.items_by_id[`maintenance:${maintenancePlan?.plan_id}`]).toBeUndefined();
      expect(data.governance.items_by_id["dogfood_report:capture_review_backlog"]).toMatchObject({
        source: "dogfood_report",
        category: "dogfood_friction",
        record_ids: ["rec_governance_item_3"],
        evidence_path: "dogfood_report.findings_by_id.capture_review_backlog",
        action_label: "review_capture_inbox",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.governance.items_by_id["dogfood_report:capture_review_backlog"].record_ids)
        .not.toContain("rec_governance_item_4");
      expect(data.governance.items_by_id["dogfood_report:failure_signals"]).toMatchObject({
        source: "dogfood_report",
        category: "dogfood_friction",
        severity: "warning",
        record_ids: ["rec_governance_item_6"],
        evidence_path: "dogfood_report.findings_by_id.failure_signals",
        action_label: "inspect_failure_signals",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
      expect(data.dogfood_report.findings_by_id.failure_signals).toMatchObject({
        reason: "1 active record mention failure, timeout, blocked, or similar friction.",
        record_ids: ["rec_governance_item_6"]
      });
      expect(data.dogfood_report.suggested_actions_by_id.inspect_failure_signals).toMatchObject({
        recommended_action: "inspect_failure_signals",
        command: "moryn timeline --record-id rec_governance_item_6 --project-id moryn --before 3 --after 3"
      });
      expect(JSON.stringify(data.governance)).not.toContain("Private Governance Hub item must stay hidden");

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("Private Governance Hub item must stay hidden");
    });
  });

  it("keeps maintenance approvals in Review Queue instead of duplicating them in Governance Hub", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_governance_dedupe_${++record}` : `evt_governance_dedupe_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn governance dedupe context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project id record should only be approved from Review Queue.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-01T00:05:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.maintenance.plans).toHaveLength(1);
      expect(data.decision_summary.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          surface: "maintenance_review",
          title: "Project identity repair",
          decision_label: "Apply Repair",
          target: "maintenance-review-queue"
        })
      ]));
      expect(data.governance.summary.needs_user_action).toBe(0);
      expect(data.governance.items.some((item) => item.source === "maintenance")).toBe(false);
      expect(html).toContain("Review Queue");
      expect(html).toContain("Project identity repair");
      expect(html).not.toContain("maintenance.plans_by_id.project_migrate");
    });
  });

  it("surfaces stored recall eval failures as read-only Governance Hub inspections", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-20T00:01:00.000Z",
            "2026-06-20T00:02:00.000Z",
            "2026-06-20T00:03:00.000Z",
            "2026-06-20T00:04:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-20T00:05:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_recall_eval_${++record}` : `evt_recall_eval_${++event}`;
        })()
      });

      const durableMemory = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Dashboard review cards must stay read-only until a user approves writes.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" },
        provenance: { method: "user-confirmed", reason: "Recall eval target" }
      });
      const hiddenPrivateMemory = await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private dashboard recall eval token should stay hidden by default.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" },
        provenance: { method: "user-confirmed", reason: "Recall eval hidden target" }
      });
      await engine.write({
        kind: "agent_note",
        type: "recall_eval_case",
        scope: "project",
        project_id: "moryn",
        tags: ["recall-eval", "golden"],
        content: {
          format: "json",
          text: "Dashboard recall eval golden cases.",
          cases: [
            {
              case_id: "dashboard-read-only",
              query: "dashboard review cards read only",
              expected_record_ids: [durableMemory.record.id],
              limit: 5
            },
            {
              case_id: "missing-dashboard-memory",
              query: "dashboard memory that does not exist",
              expected_record_ids: ["rec_missing_dashboard_memory"],
              limit: 5
            },
            {
              case_id: "hidden-dashboard-memory",
              query: "private dashboard recall eval token",
              expected_record_ids: [hiddenPrivateMemory.record.id],
              limit: 5
            }
          ]
        },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", session_id: "recall-eval-case" }
      });

      const remoteRoot = await mkdtemp(join(tmpdir(), "moryn-dashboard-recall-sync-"));
      const remote = join(remoteRoot, "remote.git");
      await exec("git", ["init", "--bare", remote]);
      await initializeGitSync(storePath, remote);

      const beforeEvents = await readEvents(storePath);
      try {
        const data = await buildDashboardData(storePath, {
          limit: 10,
          project_id: "moryn",
          now: "2026-06-21T00:00:00.000Z"
        }) as Awaited<ReturnType<typeof buildDashboardData>> & {
          recall_eval: {
            available: boolean;
            generated_from: {
              store: string;
              writes: string;
            };
            case_sources: Array<{ record_id: string; case_count: number }>;
            report: {
              summary: {
                total_cases: number;
                passed_cases: number;
                failed_cases: number;
                privacy_leaks: number;
              };
              cases_by_id: Record<string, { status: string; missing_record_ids: string[]; hidden_record_ids: string[] }>;
            } | null;
          };
        };

        expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
        expect(data.sync).toMatchObject({
          configured: true,
          dirty: false,
          sync_state: "clean",
          ahead: 0,
          behind: 0
        });
        expect(data.recall_eval).toMatchObject({
          available: true,
          generated_from: {
            store: "local_event_history",
            writes: "none"
          },
          case_sources: [
            {
              record_id: "rec_recall_eval_3",
              case_count: 3
            }
          ],
          report: {
            summary: {
              total_cases: 3,
              passed_cases: 1,
              failed_cases: 2,
              privacy_leaks: 0
            }
          }
        });
        expect(data.recall_eval.report?.cases_by_id["missing-dashboard-memory"]).toMatchObject({
          status: "fail",
          missing_record_ids: ["rec_missing_dashboard_memory"]
        });
        expect(data.recall_eval.report?.cases_by_id["hidden-dashboard-memory"]).toMatchObject({
          status: "fail",
          missing_record_ids: [],
          hidden_record_ids: [hiddenPrivateMemory.record.id]
        });
        expect(data.governance.items_by_id["recall_eval:missing-dashboard-memory"]).toMatchObject({
          source: "recall_eval",
          category: "recall_quality",
          severity: "warning",
          record_ids: ["rec_missing_dashboard_memory"],
          evidence_path: "recall_eval.report.cases_by_id.missing-dashboard-memory",
          action_label: "revise_golden_case_or_memory",
          safe_to_run: true,
          requires_user_confirmation: false,
          writes: "none"
        });
        expect(data.governance.items_by_id["recall_eval:hidden-dashboard-memory"]).toMatchObject({
          source: "recall_eval",
          category: "recall_quality",
          severity: "warning",
          record_ids: [hiddenPrivateMemory.record.id],
          evidence_path: "recall_eval.report.cases_by_id.hidden-dashboard-memory",
          action_label: "inspect_hidden_expected_records",
          safe_to_run: true,
          requires_user_confirmation: false,
          writes: "none"
        });
        expect(data.governance.summary).toMatchObject({
          needs_user_action: 0,
          safe_inspections: 2
        });
        expect(data.action_board.items_by_id.inspect.value).toBe(2);
        expect(data.dashboard_overview).toMatchObject({
          status: "good",
          headline: "All clear",
          detail: "No confirmations, warnings, or sync actions need attention. Read-only inspections remain available below.",
          primary_action: {
            label: "Inspect checks",
            target: "governance-hub",
            source: "action_board.items_by_id.inspect"
          }
        });
        expect(data.dashboard_overview.cards_by_id.action).toMatchObject({
          value: "All clear",
          summary: "2 safe checks available",
          severity: "good",
          target: "governance-hub",
          target_label: "Inspect checks",
          source: "action_board.items_by_id.inspect"
        });

        const html = renderDashboardHtml(data);
        expect(html).toContain("data-dashboard-editorial-shell");
        expect(html).not.toContain("Private dashboard recall eval token should stay hidden by default.");
        expect(JSON.stringify(data.recall_eval)).not.toContain("Private");
      } finally {
        await rm(remoteRoot, { recursive: true, force: true });
      }
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

      const data = await buildDashboardData(storePath, { limit: 10, now: "2026-06-01T00:02:00.000Z" });
      const quarantined = data.recent_records.find((record) => record.state === "quarantined");
      expect(quarantined?.text).toBe("[quarantined]");
      expect(JSON.stringify(data)).not.toContain("sk-test_1234567890abcdefghijklmnopqrstuvwxyz");
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Quarantined records hidden"
        })
      ]));
      expect(data.action_board.items.map((item) => item.id)).toEqual(["confirm", "review", "inspect", "sync"]);
      expect(data.action_board.items_by_id.confirm).toMatchObject({
        label: "Confirm",
        value: 0,
        severity: "good",
        summary: "No approvals waiting",
        hint: "No confirmation needed",
        next_action_label: "Check attention",
        target: "needs-attention"
      });
      expect(data.action_board.items_by_id.review).toMatchObject({
        label: "Review",
        value: 1,
        severity: "warning",
        summary: "1 attention item",
        hint: "Important checks found",
        detail: "Important checks stay visible in Needs a look.",
        next_action_label: "Review what changed"
      });
      expect(data.action_board.items_by_id.sync).toMatchObject({
        label: "Sync",
        value: 1,
        severity: "info",
        summary: "Local Only",
        hint: "Local only",
        next_action_label: "Inspect sync"
      });
      expect(data.action_board.items_by_id.inspect).toMatchObject({
        label: "Inspect",
        value: 0,
        severity: "good",
        summary: "No safe checks",
        hint: "No inspection needed",
        detail: "Read-only inspections are grouped in Governance Hub.",
        next_action_label: "Open governance"
      });
      expect(data.dashboard_overview).toMatchObject({
        status: "warning",
        headline: "Review what changed",
        primary_action: {
          label: "Review what changed",
          target: "needs-attention",
          source: "action_board.items_by_id.review"
        },
        safety: {
          read_only: true,
          mutation_surfaces: ["Capture Inbox", "Review Queue", "Candidate Triage"]
        },
        cards: [
          expect.objectContaining({
            id: "health",
            label: "Health",
            value: "Local Only",
            severity: "info",
            target: "needs-attention",
            target_label: "Review health",
            source: "health"
          }),
          expect.objectContaining({
            id: "action",
            label: "Next",
            value: "Review what changed",
            target: "needs-attention",
            target_label: "Review what changed",
            source: "action_board.items_by_id.review"
          }),
          expect.objectContaining({
            id: "context",
            label: "Context",
            target_label: "Open context",
            source: "context_pack_review"
          }),
          expect.objectContaining({
            id: "sync",
            label: "Sync",
            value: "Local Only",
            target: "store-signals",
            target_label: "Inspect sync",
            source: "action_board.items_by_id.sync"
          })
        ],
        evidence_sources: {
          action_board: "action_board",
          health_check: "health_check",
          context_pack_review: "context_pack_review",
          governance: "governance"
        }
      });
      expect(data.recent_value.find((record) => record.state === "quarantined")?.summary).toBe("[quarantined]");
      expect(data.recent_value.map((record) => record.summary)).toContain("<script>alert('x')</script> visible text");

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      // The redesigned Memory view shows record bodies, but they must be HTML-escaped.
      expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; visible text");
      expect(html).not.toContain("<script>alert('x')</script>");
      expect(html).not.toContain("sk-test_1234567890abcdefghijklmnopqrstuvwxyz");
    });
  });

  it("renders Recent Value as an API-backed index while keeping full JSON data", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_recent_long" : "evt_recent_long"
      });
      const longText = `Important compact recent value intro. ${"dashboard-noise ".repeat(80)}FULL_CONTENT_SENTINEL`;

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: longText, format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.recent_value[0]?.summary).toBe(longText);
      expect(data.recent_value[0]?.citation).toMatchObject({
        record_id: "rec_recent_long",
        event_id: "evt_recent_long",
        timeline_command: "moryn timeline --record-id rec_recent_long --project-id moryn",
        recall_command: "moryn recall --record-id rec_recent_long --project-id moryn"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("uses short generated record labels in Recent Value cards while preserving full trace ids", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_abcdef1234567890abcdef1234567890" : "evt_recent_hash"
      });

      await engine.write({
        kind: "skill",
        type: "codex_skill_bundle",
        scope: "project",
        project_id: "moryn",
        content: { text: "Generated record id should stay compact in visible labels.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "moryn-local" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.recent_value[0]?.citation).toMatchObject({
        record_id: "rec_abcdef1234567890abcdef1234567890",
        event_id: "evt_recent_hash",
        timeline_command: "moryn timeline --record-id rec_abcdef1234567890abcdef1234567890 --project-id moryn",
        recall_command: "moryn recall --record-id rec_abcdef1234567890abcdef1234567890 --project-id moryn"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).toContain("moryn recall --record-id rec_abcdef1234567890abcdef1234567890");
    });
  });

  it("keeps Raw Store as API index hints instead of raw HTML tables", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let minute = 0;
          return () => `2026-06-01T00:${String(++minute).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => {
            if (prefix !== "rec") return `evt_debug_budget_${++event}`;
            record += 1;
            return record === 13 ? "rec_1234567890abcdef1234567890abcdef" : `rec_debug_budget_${record}`;
          };
        })()
      });

      for (let index = 1; index <= 12; index++) {
        await engine.write({
          kind: "memory",
          type: "note",
          scope: "project",
          project_id: "moryn",
          content: { text: `Debug inspector budget record ${index}.`, format: "text" },
          state: "canonical",
          confirmed: true,
          source: { client: "codex", session_id: "debug-budget" }
        });
      }
      const noisySummaryRecord = await engine.write({
        kind: "memory",
        type: "artifact",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "base64 IyBSZW53ZWkgV3JpdGluZyDigJQgTGljZW5zZQoKQ29weXJpZ2h0IChjKSAyMDI2 very long encoded artifact payload that should stay out of the folded Record Index summary.",
          format: "text"
        },
        state: "canonical",
        confirmed: true,
        source: { client: "codex", session_id: "debug-budget" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 13,
        project_id: "moryn",
        now: "2026-06-21T00:00:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.recent_records).toHaveLength(13);
      expect(data.recent_events).toHaveLength(13);
      expect(data.recent_records[0]?.text).toContain("base64 IyBSZW53ZWkgV3JpdGluZy");
      expect(data.recent_events[0]?.op).toBe("upsert_record");
      expect(html).toContain("data-dashboard-editorial-shell");
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

  it("keeps extra Recent Value records in the API-backed index instead of HTML overflow cards", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          let minute = 0;
          return () => `2026-06-01T00:${String(++minute).padStart(2, "0")}:00.000Z`;
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_value_${++record}` : `evt_value_${++event}`;
        })()
      });

      for (let index = 1; index <= 6; index += 1) {
        await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: "moryn",
          content: { text: `Recent value ${index}`, format: "text" },
          state: "canonical",
          confirmed: true,
          source: { client: "codex" }
        });
      }

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
      const html = renderDashboardHtml(data);

      expect(data.recent_value).toHaveLength(6);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).not.toContain("<details class=\"panel recent-value-panel\" data-dashboard-detail=\"recent-value\">");
      expect(html.match(/class="value-card(?: |")/g) ?? []).toHaveLength(0);
      expect(html.match(/class="value-card value-card-overflow"/g) ?? []).toHaveLength(0);
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
        event_path: "events/device_test/2026-06/evt_cite_1.json",
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
      expect(html).toContain("data-dashboard-editorial-shell");
      // Trace commands remain surfaced through the editorial drawer/history evidence.
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
          recent_value: Array<{ id: string; summary: string }>;
        };
        expect(serverData.recent_records.map((record) => record.id)).toContain(privateRecord.record.id);
        expect(serverData.recent_value.map((record) => record.id)).toContain(privateRecord.record.id);
        expect(serverData.recent_value.map((record) => record.summary)).toContain("Private dashboard memory.");
        const fragment = await (await fetch(new URL("/fragment", server.url))).text();
        expect(fragment).toContain("data-dashboard-editorial-shell");
        // include_private was explicitly requested, so the redesigned Memory view
        // (which now shows record bodies) surfaces the opted-in private body.
        expect(fragment).toContain("Private dashboard memory.");
      } finally {
        await server.close();
      }
    });
  });

  it("surfaces a read-only memory lifecycle panel without mutating or exposing private records", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-01-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-01-01T00:01:00.000Z",
            "2026-01-02T00:01:00.000Z",
            "2026-06-15T00:01:00.000Z",
            "2026-01-03T00:01:00.000Z",
            "2026-01-04T00:01:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-04-16T00:01:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_lifecycle_${++record}` : `evt_lifecycle_${++event}`;
        })()
      });

      const archiveCandidate = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review"],
        content: { text: "Old low-confidence dashboard lifecycle candidate.", format: "text" },
        confidence: 0.2,
        source: { client: "codex", session_id: "lifecycle-dashboard" }
      });
      const staleRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Old canonical decision needs timeline inspection.", format: "text" },
        state: "canonical",
        confirmed: true,
        confidence: 0.8,
        source: { client: "user" }
      });
      const recentRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Recent dashboard lifecycle memory stays retained.", format: "text" },
        confidence: 0.7,
        source: { client: "codex" }
      });
      const otherProjectRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "other",
        content: { text: "Other project lifecycle memory stays out.", format: "text" },
        confidence: 0.2,
        source: { client: "codex" }
      });
      const privateRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Private dashboard lifecycle memory must stay hidden.", format: "text" },
        confidence: 0.1,
        source: { client: "codex" }
      });

      const beforeEvents = await readEvents(storePath);
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-20T00:00:00.000Z"
      });

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.memory_lifecycle).toMatchObject({
        read_only: true,
        project_id: "moryn",
        generated_at: "2026-06-20T00:00:00.000Z",
        policy: { id: "default_memory_lifecycle_policy" },
        stats: {
          total_records: 3,
          excluded_private_records: 1,
          archive_candidate_records: 1,
          stale_records: 1,
          retained_records: 1
        }
      });
      expect(data.memory_lifecycle.assessments_by_record_id[archiveCandidate.record.id]).toMatchObject({
        lifecycle_state: "archive_candidate",
        recommended_action: "archive_after_review"
      });
      expect(data.memory_lifecycle.assessments_by_record_id[staleRecord.record.id]).toMatchObject({
        lifecycle_state: "stale",
        recommended_action: "inspect_timeline"
      });
      expect(data.memory_lifecycle.assessments_by_record_id[recentRecord.record.id]).toMatchObject({
        lifecycle_state: "retained"
      });
      expect(data.memory_lifecycle.assessments_by_record_id[otherProjectRecord.record.id]).toBeUndefined();
      expect(data.memory_lifecycle.assessments_by_record_id[privateRecord.record.id]).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain("Private dashboard lifecycle memory");
      expect(JSON.stringify(data.memory_lifecycle)).not.toContain("Other project lifecycle memory");
      expect(data.memory_lifecycle.suggested_actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          action_id: `archive:${archiveCandidate.record.id}`,
          command: expect.stringContaining(`moryn archive ${archiveCandidate.record.id}`),
          safe_to_run: false
        }),
        expect.objectContaining({
          action_id: `inspect:${staleRecord.record.id}`,
          command: expect.stringContaining(`moryn timeline --record-id ${staleRecord.record.id} --project-id moryn`),
          safe_to_run: true
        })
      ]));

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(JSON.stringify(data.memory_lifecycle)).toContain("default_memory_lifecycle_policy");
      expect(JSON.stringify(data.memory_lifecycle)).toContain("archive_after_review");
      expect(JSON.stringify(data.memory_lifecycle)).toContain(`moryn archive ${archiveCandidate.record.id}`);
      expect(JSON.stringify(data.memory_lifecycle)).toContain(`moryn timeline --record-id ${staleRecord.record.id} --project-id moryn`);
      expect(html).not.toContain("Apply Lifecycle");
      expect(html).not.toContain("data-lifecycle-approve");
      expect(html).not.toContain("Private dashboard lifecycle memory");
    });
  });

  it("marks included private dashboard lifecycle records as private-retained", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-01-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-01-01T00:01:00.000Z",
            "2026-01-02T00:01:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-01-03T00:01:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_lifecycle_private_${++record}` : `evt_lifecycle_private_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Public lifecycle memory.", format: "text" },
        confidence: 0.3,
        source: { client: "codex" }
      });
      const privateRecord = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["private"],
        content: { text: "Included private lifecycle memory.", format: "text" },
        confidence: 0.1,
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        include_private: true,
        now: "2026-06-20T00:00:00.000Z"
      });

      expect(data.memory_lifecycle.stats).toMatchObject({
        total_records: 2,
        excluded_private_records: 0,
        private_retained_records: 1
      });
      expect(data.memory_lifecycle.assessments_by_record_id[privateRecord.record.id]).toMatchObject({
        lifecycle_state: "private_retained",
        recommended_action: "keep",
        reasons: ["private_record_retained_by_boundary"]
      });
      expect(JSON.stringify(data)).toContain("Included private lifecycle memory.");
    });
  });

  it("adds project identity repair plans to dashboard data", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_split_${++record}` : `evt_split_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn project context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const canonicalOld = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Moryn rule under old project id.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const candidateOld = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Moryn session under old project id.", format: "text" },
        source: { client: "codex" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn", "private"],
        content: { text: "Private split record stays out.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
      const planActionId = `maintenance.plan.approve.${data.maintenance.plans[0]?.plan_hash.replace(/^sha256:/, "")}`;

      expect(data.maintenance.plans).toHaveLength(1);
      expect(data.maintenance.plans[0]).toMatchObject({
        plan_id: "project_migrate:repo-e6f0166fd942->moryn",
        type: "project_identity_repair",
        finding_id: "project_identity_split",
        from_project_id: "repo-e6f0166fd942",
        to_project_id: "moryn",
        command: "moryn project migrate --from repo-e6f0166fd942 --to moryn --apply --confirm",
        dry_run: {
          matched_records: 2,
          skipped_private_records: 1,
          included_private_records: 0,
          states: {
            canonical: 1,
            candidate: 1
          }
        },
        approval: {
          requires_user_confirmation: true,
          safe_to_auto_apply: false
        },
        decision_card: {
          title: "Project identity repair",
          issue: "2 records under repo-e6f0166fd942 likely belong to moryn.",
          impact: "Boot and recall can miss these memories when agents ask for project moryn.",
          recommended_action: "Apply the repair only after confirming repo-e6f0166fd942 is an old or generated id for moryn.",
          rollback_path: "If this was wrong, review the refreshed plan and run moryn project migrate --from moryn --to repo-e6f0166fd942 --apply --confirm.",
          evidence: expect.arrayContaining([
            "Matched records: 2 records; 1 canonical, 1 candidate.",
            "Private records: 1 private record skipped.",
            "Write behavior: append-only revise_record events; no history rewrite."
          ])
        }
      });
      expect(data.maintenance.plans[0]?.decision_card.raw_evidence).toMatchObject({
        plan_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        command: "moryn project migrate --from repo-e6f0166fd942 --to moryn --apply --confirm",
        record_ids: [
          candidateOld.record.id,
          canonicalOld.record.id
        ]
      });
      expect(data.maintenance.plans[0]?.plan_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(data.maintenance.plans[0]?.record_ids).toEqual([
        candidateOld.record.id,
        canonicalOld.record.id
      ]);
      expect(data.maintenance.plans[0]?.safety_checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "dry_run_completed", ok: true }),
        expect.objectContaining({ id: "target_project_explicit", ok: true }),
        expect.objectContaining({ id: "no_private_records", ok: true }),
        expect.objectContaining({ id: "append_only", ok: true })
      ]));
      expect(data.actions_by_id[planActionId]).toMatchObject({
        action_id: planActionId,
        surface: "maintenance_review",
        kind: "dashboard_api",
        label: "Apply Repair",
        intent: "approve",
        target: {
          type: "maintenance_plan",
          id: "project_migrate:repo-e6f0166fd942->moryn",
          plan_hash: data.maintenance.plans[0]?.plan_hash
        },
        method: "POST",
        endpoint: "api/maintenance/plans/project_migrate%3Arepo-e6f0166fd942-%3Emoryn/approve",
        request_body: {
          plan_hash: data.maintenance.plans[0]?.plan_hash
        },
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "plan_hash"
        },
        source_path: "maintenance.plans[]"
      });
    });
  });

  it("does not treat a tag shared across many distinct projects as project identity evidence", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      for (let projectIndex = 0; projectIndex < 4; projectIndex += 1) {
        await engine.write({
          kind: "memory",
          type: "decision",
          scope: "project",
          project_id: `project-${projectIndex}`,
          tags: ["large-store"],
          content: { text: `Independent project ${projectIndex} decision.`, format: "text" },
          state: "canonical",
          confirmed: true,
          source: { client: "user" }
        });
      }

      const data = await buildDashboardData(storePath, { project_id: "project-0" });

      expect(data.maintenance.plans.filter((plan) => plan.type === "project_identity_repair")).toEqual([]);
      expect(data.quiet_dashboard.attention_needed).toEqual([]);
    });
  });

  it("keeps include_private explicit in maintenance repair plans", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_private_plan_${++record}` : `evt_private_plan_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn project context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Public old project record.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn", "private"],
        content: { text: "Private old project record.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        include_private: true
      });
      const plan = data.maintenance.plans[0];

      expect(plan).toMatchObject({
        command: "moryn project migrate --from repo-e6f0166fd942 --to moryn --apply --confirm --include-private",
        dry_run: {
          matched_records: 2,
          skipped_private_records: 0,
          included_private_records: 1,
          states: {
            canonical: 2
          }
        }
      });
      expect(plan?.safety_checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "no_private_records", ok: false })
      ]));
    });
  });

  it("turns marker noise candidates into an explicit Review Queue archive plan", async () => {
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
            "2026-06-01T00:05:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:06:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_noise_plan_${++record}` : `evt_noise_plan_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn project context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const marker = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn", "marker"],
        content: { text: "Marker candidate from dashboard smoke test.", format: "text" },
        source: { client: "codex" }
      });
      const smoke = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn", "smoke"],
        content: { text: "Smoke candidate left by package e2e.", format: "text" },
        source: { client: "codex" }
      });
      const e2e = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "E2E marker note should be reviewed before archive.", format: "text" },
        state: "candidate",
        source: { client: "codex" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn", "private", "smoke"],
        content: { text: "Private smoke marker stays out unless include-private is set.", format: "text" },
        source: { client: "codex" }
      });

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
      const plan = data.maintenance.plans.find((candidate) => candidate.type === "candidate_noise_archive");
      expect(plan).toBeDefined();
      const planActionId = `maintenance.plan.approve.${plan?.plan_hash.replace(/^sha256:/, "")}`;
      const html = renderDashboardHtml(data);

      expect(plan).toMatchObject({
        plan_id: "candidate_noise_archive:moryn",
        type: "candidate_noise_archive",
        finding_id: "candidate_marker_noise",
        command: "moryn archive rec_noise_plan_4 --reason 'Memory doctor: e2e marker/noise candidate' && moryn archive rec_noise_plan_3 --reason 'Memory doctor: e2e marker/noise candidate' && moryn archive rec_noise_plan_2 --reason 'Memory doctor: e2e marker/noise candidate'",
        dry_run: {
          matched_records: 3,
          skipped_private_records: 1,
          included_private_records: 0,
          states: {
            candidate: 3
          }
        },
        decision_card: {
          title: "Candidate noise cleanup",
          issue: "3 candidate records look like smoke/e2e marker noise.",
          impact: "Candidate review stays noisy until confirmed test markers are archived.",
          recommended_action: "Archive these candidates only after confirming they are test noise or obsolete markers.",
          rollback_path: "If this was wrong, use the record ids and timeline events below to inspect the append-only archive before restoring manually.",
          evidence: expect.arrayContaining([
            "Matched records: 3 records; 3 candidate.",
            "Private records: 1 private record skipped.",
            "Write behavior: append-only archive_record events; no deletion."
          ])
        }
      });
      expect(plan?.record_ids).toEqual([
        e2e.record.id,
        smoke.record.id,
        marker.record.id
      ]);
      expect(plan?.safety_checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "dry_run_completed", ok: true }),
        expect.objectContaining({ id: "candidate_noise_detected", ok: true }),
        expect.objectContaining({ id: "no_private_records", ok: true }),
        expect.objectContaining({ id: "append_only", ok: true })
      ]));
      expect(data.actions_by_id[planActionId]).toMatchObject({
        action_id: planActionId,
        surface: "maintenance_review",
        kind: "dashboard_api",
        label: "Archive Noise",
        intent: "approve",
        target: {
          type: "maintenance_plan",
          id: "candidate_noise_archive:moryn",
          plan_hash: plan?.plan_hash
        },
        method: "POST",
        endpoint: "api/maintenance/plans/candidate_noise_archive%3Amoryn/approve",
        request_body: {
          plan_hash: plan?.plan_hash
        },
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "plan_hash"
        },
        source_path: "maintenance.plans[]"
      });
      expect(data.decision_summary.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          surface: "maintenance_review",
          title: "Candidate noise cleanup",
          decision_label: "Archive Noise",
          safety_note: "Archive Noise appends archive_record events only after the plan_hash guard passes.",
          evidence_path: "maintenance.plans[]"
        })
      ]));
      expect(data.candidate_triage.review_focus).toMatchObject({
        group_id: "likely_noise",
        summary: "Start with Likely noise: Inspect likely noise before archive",
        evidence_path: "candidate_triage.groups_by_id.likely_noise"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("keeps large maintenance archive plans compact while preserving raw ids and commands", async () => {
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
            "2026-06-01T00:07:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:08:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_large_noise_${++record}` : `evt_large_noise_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn project context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      for (let index = 1; index <= 6; index += 1) {
        await engine.write({
          kind: "session_summary",
          type: "summary",
          scope: "project",
          project_id: "moryn",
          tags: ["moryn", index % 2 === 0 ? "smoke" : "marker"],
          content: { text: `Smoke marker candidate ${index} from dashboard e2e.`, format: "text" },
          source: { client: "codex" }
        });
      }

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
      const plan = data.maintenance.plans.find((candidate) => candidate.type === "candidate_noise_archive");
      expect(plan?.record_ids).toHaveLength(6);
      const html = renderDashboardHtml(data);

      expect(html).toContain("data-dashboard-editorial-shell");
      // Raw ids and archive commands remain preserved in the underlying data model.
      expect(JSON.stringify(data.maintenance)).toContain("moryn archive rec_large_noise_7");
      expect(JSON.stringify(data.maintenance)).toContain("rec_large_noise_2 --reason");
    });
  });

  it("renders maintenance review queue controls", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_review_${++record}` : `evt_review_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project id record.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
      const html = renderDashboardHtml(data);

      expect(data.decision_summary).toMatchObject({
        read_only: true,
        total_decisions: 1,
        summary: {
          capture_inbox_groups: 0,
          review_queue_plans: 1
        },
        items: [
          expect.objectContaining({
            surface: "maintenance_review",
            title: "Project identity repair",
            decision_label: "Apply Repair",
            target: "maintenance-review-queue",
            target_label: "Open Review Queue",
            requires_user_confirmation: true,
            writes: "append_only_events",
            safety_note: "Apply Repair appends revise_record events only after the plan_hash guard passes.",
            evidence_path: "maintenance.plans[]"
          })
        ]
      });
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(data.attention_items.some((item) => item.severity === "info")).toBe(true);
      expect(data.action_board.items_by_id.review).toMatchObject({
        target: "needs-attention",
        next_action_label: "Open checks"
      });
      expect(data.action_board.items_by_id.review.next_action_label).not.toBe("Review warnings");
    });
  });

  it("does not repeat the primary decision action as an overview card", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_overview_dedupe_${++record}` : `evt_overview_dedupe_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn overview context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project id record creates one Review Queue decision.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-01T00:05:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.dashboard_overview.headline).toBe("Approval needed");
      expect(data.dashboard_overview.primary_action).toMatchObject({
        label: "Review approvals",
        target: "decision-summary",
        source: "action_board.items_by_id.confirm"
      });
      expect(data.dashboard_overview.cards_by_id.action).toMatchObject({
        id: "action",
        label: "Next",
        value: "Approval needed",
        source: "action_board.items_by_id.confirm"
      });
      expect(data.quiet_dashboard.attention_needed.length).toBeGreaterThan(0);
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("keeps pending decisions ahead of sync warnings in the overview", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-decision-sync-"));
    const storePath = join(root, "store");
    const remote = join(root, "remote.git");
    try {
      await exec("git", ["init", "--bare", remote]);
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      await initializeGitSync(storePath, remote);
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
          return (prefix: string) => prefix === "rec" ? `rec_decision_sync_${++record}` : `evt_decision_sync_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical project record keeps Moryn project visible.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project id creates a pending review decision while sync is dirty.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn",
        now: "2026-06-01T00:05:00.000Z"
      });
      const html = renderDashboardHtml(data);

      expect(data.health.status).toBe("sync_pending");
      expect(data.decision_summary.total_decisions).toBe(1);
      expect(data.action_board.items_by_id.review).toMatchObject({
        value: 0,
        next_action_label: "Open checks",
        target: "needs-attention"
      });
      expect(data.action_board.items_by_id.sync).toMatchObject({
        value: 1,
        next_action_label: "Inspect sync",
        target: "store-signals"
      });
      expect(data.dashboard_overview).toMatchObject({
        headline: "Approval needed",
        detail: "Explicit approvals stay in Capture Inbox, Review Queue, and Candidate Triage.",
        primary_action: {
          label: "Review approvals",
          target: "decision-summary",
          source: "action_board.items_by_id.confirm"
        }
      });
      expect(data.dashboard_overview.cards_by_id.sync).toMatchObject({
        value: "Sync Pending",
        target: "store-signals",
        source: "action_board.items_by_id.sync"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes routine Context Pack Review handoff readiness in diagnostics", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_pack_${++record}` : `evt_pack_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: "Dashboard should review context pack readiness.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "memory",
        type: "warning",
        scope: "project",
        project_id: "moryn",
        content: { text: "Do not make dashboard context review mutate memory.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        content: { text: "Codex finished handoff review implementation.", format: "text" },
        source: { client: "codex", session_id: "pack-review" }
      });

      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn"
      }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        context_pack_review: {
          available: boolean;
          project_id?: string;
          handoff_pack: {
            purpose: string;
            recent_decisions: Array<{ text: string; evidence: { source: string; record_id?: string } }>;
            open_threads: Array<{ text: string; evidence: { source: string; record_id?: string } }>;
            risks: Array<{ text: string; evidence: { source: string; record_id?: string } }>;
            quality_gate: {
              status: string;
              read_only: boolean;
              checks_by_id: Record<string, { status: string; source: string; count?: number }>;
              failed_check_ids: string[];
            };
            next_actions: Array<{ id: string; command?: string; evidence: { source: string } }>;
          };
          selection_sources: Record<string, string>;
        };
        selection_sources: Record<string, string>;
      };

      expect(data.context_pack_review).toMatchObject({
        available: true,
        project_id: "moryn",
        handoff_pack: {
          purpose: "agent_handoff",
          recent_decisions: [
            expect.objectContaining({
              text: "Dashboard should review context pack readiness.",
              evidence: expect.objectContaining({ source: "context_pack_review.handoff_pack.recent_decisions[]" })
            })
          ],
          open_threads: [
            expect.objectContaining({
              text: "Codex finished handoff review implementation.",
              evidence: expect.objectContaining({ source: "context_pack_review.handoff_pack.open_threads[]" })
            })
          ],
          risks: [
            expect.objectContaining({
              text: "Do not make dashboard context review mutate memory.",
              evidence: expect.objectContaining({ source: "context_pack_review.handoff_pack.risks[]" })
            })
          ],
          quality_gate: expect.objectContaining({
            status: "ready",
            read_only: true,
            failed_check_ids: [],
            checks_by_id: expect.objectContaining({
              recent_decisions: expect.objectContaining({ status: "pass", count: 1 }),
              open_threads: expect.objectContaining({ status: "pass", count: 1 }),
              risks: expect.objectContaining({ status: "pass", count: 1 }),
              capture_next_action: expect.objectContaining({
                status: "pass",
                source: "next.actions_by_id.capture_session"
              })
            })
          }),
          next_actions: expect.arrayContaining([
            expect.objectContaining({
              id: "capture_session",
              evidence: expect.objectContaining({ source: "next.actions_by_id.capture_session" })
            })
          ])
        },
        selection_sources: expect.objectContaining({
          context_pack_review: "context_pack_review",
          quality_gate: "context_pack_review.handoff_pack.quality_gate",
          evidence: "context_pack_review.handoff_pack.evidence"
        })
      });
      expect(data.selection_sources.context_pack_review).toBe("context_pack_review");

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).toContain("Codex finished handoff review implementation.");
      expect(JSON.stringify(data.context_pack_review)).toContain("Do not make dashboard context review mutate memory.");
      expect(html).not.toContain("data-context-pack-approve");
      expect(html).not.toContain("data-dashboard-action-id=\"context_pack");
    });
  });

  it("indexes empty Context Pack Review without zero-value evidence rows", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const data = await buildDashboardData(storePath, {
        limit: 10,
        project_id: "moryn"
      });
      const html = renderDashboardHtml(data);

      expect(data.context_pack_review.available).toBe(true);
      expect(data.context_pack_review.handoff_pack?.recent_decisions).toHaveLength(0);
      expect(data.context_pack_review.handoff_pack?.open_threads).toHaveLength(0);
      expect(data.context_pack_review.handoff_pack?.risks).toHaveLength(0);
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("keeps Context Pack Review unavailable without explicit project context", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T00:01:00.000Z",
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_no_project_${++record}` : `evt_no_project_${++event}`;
        })()
      });
      const projectText = "Project memory should not make dashboard guess context.";
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        content: { text: projectText, format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        context_pack_review: {
          available: boolean;
          unavailable_reason?: string;
          handoff_pack?: unknown;
          generated_from: { writes: string; sync_pull: boolean };
        };
      };

      expect(data.context_pack_review).toMatchObject({
        available: false,
        unavailable_reason: "Open the dashboard with --project-id or --project to review a project context pack.",
        generated_from: {
          writes: "none",
          sync_pull: false
        }
      });
      expect(data.context_pack_review.handoff_pack).toBeUndefined();

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      // Without explicit project context, the unavailable context pack must not leak the project record text.
      expect(JSON.stringify(data.context_pack_review)).not.toContain(projectText);
    });
  });

  it("adds autocapture candidates to the Capture Inbox", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_capture_${++record}` : `evt_capture_${++event}`;
        })()
      });

      const capture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "json",
          text: "Codex finished Capture Inbox planning.",
          capture: {
            mode: "autocapture",
            host: "codex",
            current_task: "Capture Inbox"
          }
        },
        source: { client: "codex", session_id: "capture-inbox-test" },
        provenance: {
          method: "agent-proposed",
          reason: "Captured through Moryn host adapter autocapture."
        }
      });
      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["review"],
        content: { text: "Canonical review tag should not be in capture inbox.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        actions_by_id: Record<string, {
          action_id: string;
          surface: string;
          kind: string;
          label: string;
          intent: string;
          target: { type: string; id: string };
          endpoint?: string;
          method?: string;
          request_body?: Record<string, unknown>;
          safety: {
            safe_to_auto_run: boolean;
            requires_user_confirmation: boolean;
            writes: string;
            stale_guard?: string;
          };
          source_path: string;
        }>;
        capture_inbox: {
          total: number;
          groups: Array<{
            id: string;
            source_label: string;
          }>;
          items: Array<{
            id: string;
            text: string;
            source_label: string;
            source_detail: string;
            project_id?: string;
            provenance_reason?: string;
            approve_endpoint: string;
            reject_endpoint: string;
            citation: { recall_command: string };
          }>;
        };
        decision_summary: {
          read_only: true;
          total_decisions: number;
          summary: {
            capture_inbox_groups: number;
            review_queue_plans: number;
            candidate_triage_promotions: number;
          };
          items: Array<{
            id: string;
            surface: string;
            title: string;
            decision_label: string;
            target: string;
            target_label: string;
            primary_action_id?: string;
            secondary_action_id?: string;
            requires_user_confirmation: boolean;
            writes: string;
            safety_note: string;
            evidence_path: string;
          }>;
          items_by_id: Record<string, unknown>;
        };
      };

      expect(data.capture_inbox.total).toBe(1);
      const captureDecisionGroup = data.capture_inbox.groups[0]!;
      expect(data.action_board.items_by_id.confirm).toMatchObject({
        value: 1,
        summary: "1 approval waiting",
        hint: "Open decision summary",
        next_action_label: "Approval needed",
        target: "decision-summary"
      });
      expect(data.decision_summary).toMatchObject({
        read_only: true,
        total_decisions: 1,
        summary: {
          capture_inbox_groups: 1,
          review_queue_plans: 0
        },
        items: [
          expect.objectContaining({
            id: `capture_inbox:${captureDecisionGroup.id}`,
            surface: "capture_inbox",
            title: "Review Codex capture group",
            decision_label: "Approve Group or Reject Group",
            target: "capture-inbox",
            target_label: "Open Capture Inbox",
            primary_action_id: `capture_inbox.group.approve.${captureDecisionGroup.id}`,
            secondary_action_id: `capture_inbox.group.reject.${captureDecisionGroup.id}`,
            requires_user_confirmation: true,
            writes: "append_only_events",
            safety_note: "Approve Group promotes candidates; Reject Group archives them. Both append audit events.",
            evidence_path: "capture_inbox.groups[]"
          })
        ]
      });
      expect(data.decision_summary.items_by_id[`capture_inbox:${captureDecisionGroup.id}`]).toMatchObject({
        target: "capture-inbox"
      });
      expect(data.capture_inbox.items[0]).toMatchObject({
        id: capture.record.id,
        text: "Codex finished Capture Inbox planning.",
        source_label: "Codex",
        source_detail: "codex / capture-inbox-test",
        project_id: "moryn",
        provenance_reason: "Captured through Moryn host adapter autocapture.",
        approve_endpoint: `api/capture-inbox/${capture.record.id}/approve`,
        reject_endpoint: `api/capture-inbox/${capture.record.id}/reject`,
        citation: {
          recall_command: `moryn recall --record-id ${capture.record.id} --project-id moryn`
        }
      });
      expect(data.actions_by_id[`capture_inbox.record.approve.${capture.record.id}`]).toMatchObject({
        action_id: `capture_inbox.record.approve.${capture.record.id}`,
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Approve Memory",
        intent: "approve",
        target: { type: "record", id: capture.record.id },
        endpoint: `api/capture-inbox/${capture.record.id}/approve`,
        method: "POST",
        request_body: {},
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "capture_inbox.items[]"
      });
      expect(data.actions_by_id[`capture_inbox.record.reject.${capture.record.id}`]).toMatchObject({
        action_id: `capture_inbox.record.reject.${capture.record.id}`,
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Reject",
        intent: "reject",
        target: { type: "record", id: capture.record.id },
        endpoint: `api/capture-inbox/${capture.record.id}/reject`,
        method: "POST",
        request_body: { reason: "User rejected Capture Inbox candidate." },
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "capture_inbox.items[]"
      });

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(data.action_board.items_by_id.confirm).toMatchObject({
        value: 1,
        target: "decision-summary",
        next_action_label: "Approval needed"
      });
      expect(data.attention_items.every((item) => item.severity === "info")).toBe(true);
    });
  });

  it("groups Capture Inbox candidates and exposes manual review policy with noise signals", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T10:01:00.000Z",
            "2026-06-01T10:02:00.000Z",
            "2026-06-01T10:03:00.000Z",
            "2026-06-01T10:04:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T10:05:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_capture_group_${++record}` : `evt_capture_group_${++event}`;
        })()
      });

      const firstCodex = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Codex finished dashboard grouping.", format: "text" },
        source: { client: "codex", session_id: "codex-session-1" }
      });
      const secondCodex = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Codex prepared bulk review controls.", format: "text" },
        source: { client: "codex", session_id: "codex-session-1" }
      });
      const smoke = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:claude", "smoke"],
        content: { text: "Smoke test marker only.", format: "text" },
        source: { client: "claude", session_id: "claude-smoke" }
      });
      const duplicate = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:claude"],
        content: { text: "Smoke test marker only.", format: "text" },
        source: { client: "claude", session_id: "claude-smoke" }
      });

      const data = await buildDashboardData(storePath, { limit: 10 }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        capture_inbox: {
          policy: {
            id: string;
            version: number;
            mode: "manual_review";
            auto_canonical: false;
            trust_policy: "disabled_by_default";
            canonical_requires_user_action: true;
            grouping: {
              enabled: boolean;
              group_by: string[];
              stale_batch_protection: boolean;
            };
            noise_rules: Array<{
              id: string;
              label: string;
              suggested_action: string;
            }>;
          };
          groups: Array<{
            id: string;
            total: number;
            record_ids: string[];
            source_detail: string;
            approve_endpoint: string;
            reject_endpoint: string;
            noise: { level: string; reasons: string[]; rule_ids: string[]; suggested_action: string };
          }>;
          items: Array<{
            id: string;
            group_id: string;
            noise: { level: string; reasons: string[]; rule_ids: string[]; suggested_action: string };
          }>;
        };
      };

      expect(data.capture_inbox.policy).toMatchObject({
        id: "default_capture_review_policy",
        version: 1,
        mode: "manual_review",
        auto_canonical: false,
        trust_policy: "disabled_by_default",
        canonical_requires_user_action: true,
        grouping: {
          enabled: true,
          group_by: ["project_or_scope", "source_client", "source_session", "capture_day"],
          stale_batch_protection: true
        },
        noise_rules: expect.arrayContaining([
          expect.objectContaining({
            id: "smoke_test_marker",
            label: "Smoke/test marker",
            suggested_action: "archive"
          }),
          expect.objectContaining({
            id: "duplicate_text",
            label: "Duplicate capture text",
            suggested_action: "archive"
          })
        ])
      });
      expect(data.capture_inbox.groups).toHaveLength(2);
      const codexGroup = data.capture_inbox.groups.find((group) => group.source_detail === "codex / codex-session-1");
      expect(codexGroup).toMatchObject({
        total: 2,
        record_ids: [secondCodex.record.id, firstCodex.record.id],
        approve_endpoint: expect.stringMatching(/^api\/capture-inbox\/groups\/capture_group_[a-f0-9]+\/approve$/),
        reject_endpoint: expect.stringMatching(/^api\/capture-inbox\/groups\/capture_group_[a-f0-9]+\/reject$/),
        noise: { level: "normal", rule_ids: [], suggested_action: "review" }
      });
      expect(data.capture_inbox.items.filter((item) => item.group_id === codexGroup?.id).map((item) => item.id)).toEqual([
        secondCodex.record.id,
        firstCodex.record.id
      ]);

      const noisyGroup = data.capture_inbox.groups.find((group) => group.source_detail === "claude / claude-smoke");
      expect(noisyGroup).toMatchObject({
        total: 2,
        record_ids: [duplicate.record.id, smoke.record.id],
        noise: {
          level: "likely_noise",
          suggested_action: "archive",
          rule_ids: ["smoke_test_marker", "duplicate_text"],
          reasons: expect.arrayContaining([
            "Looks like smoke, test, or fixture output.",
            "Duplicate capture text appears in this batch."
          ])
        }
      });
      expect(data.capture_inbox.items.find((item) => item.id === smoke.record.id)?.noise.reasons).toEqual(expect.arrayContaining([
        "Looks like smoke, test, or fixture output.",
        "Duplicate capture text appears in this batch."
      ]));

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("keeps Capture Inbox autocapture evidence explainable from API and trace details", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T10:01:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_capture_evidence" : "evt_capture_evidence"
      });

      const capture = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "json",
          text: "Decision: keep review approval explicit before long-term memory.",
          capture: {
            mode: "autocapture",
            host: "codex",
            adapter: "codex",
            session_id: "codex-risk-1",
            current_task: "dashboard review approval",
            files: ["src/observability/dashboard.ts"],
            policy: {
              id: "default_autocapture_policy",
              version: 1,
              decision: "review",
              route: "manual_review",
              review_required: true,
              user_action_required: true,
              auto_canonical: false,
              dashboard_surface: "capture_inbox",
              rule_ids: ["review_risk_marker"],
              reasons: ["review_risk_marker"]
            }
          }
        },
        state: "candidate",
        source: { client: "codex", session_id: "codex-risk-1" },
        provenance: {
          method: "agent-proposed",
          reason: "Captured through Moryn host adapter autocapture."
        }
      });

      const data = await buildDashboardData(storePath, { limit: 10 }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        capture_inbox: {
          items: Array<{
            id: string;
            project_id?: string;
            text: string;
            source_detail: string;
            current_task?: string;
            files?: string[];
            policy_decision?: string;
            policy_route?: string;
            policy_rule_ids: string[];
            policy_reasons: string[];
            citation: { timeline_command: string; recall_command: string };
          }>;
        };
      };

      const item = data.capture_inbox.items.find((candidate) => candidate.id === capture.record.id);
      expect(item).toMatchObject({
        project_id: "moryn",
        text: "Decision: keep review approval explicit before long-term memory.",
        source_detail: "codex / codex-risk-1",
        current_task: "dashboard review approval",
        files: ["src/observability/dashboard.ts"],
        policy_decision: "review",
        policy_route: "manual_review",
        policy_rule_ids: ["review_risk_marker"],
        policy_reasons: ["review_risk_marker"],
        citation: {
          timeline_command: "moryn timeline --record-id rec_capture_evidence --project-id moryn",
          recall_command: "moryn recall --record-id rec_capture_evidence --project-id moryn"
        }
      });

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
    });
  });

  it("surfaces policy-archived autocaptures without putting them back in the Capture Inbox", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: (() => {
          const timestamps = [
            "2026-06-01T10:01:00.000Z",
            "2026-06-01T10:02:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T10:03:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_capture_policy_${++record}` : `evt_capture_policy_${++event}`;
        })()
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "json",
          text: "Useful handoff still needs user review.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "review",
              review_required: true,
              auto_canonical: false,
              rule_ids: ["default_review_for_agent_handoff"]
            }
          }
        },
        source: { client: "codex", session_id: "policy-review" }
      });
      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "policy-archived", "host:codex", "noise:smoke_test_marker"],
        content: {
          format: "json",
          text: "Smoke test marker only.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "archive",
              review_required: false,
              auto_canonical: false,
              rule_ids: ["smoke_test_marker"],
              reasons: ["smoke_test_marker"]
            }
          }
        },
        state: "archived",
        confidence: 0.1,
        source: { client: "codex", session_id: "policy-archive" },
        provenance: {
          method: "agent-proposed",
          reason: "Autocapture policy archived this handoff: smoke_test_marker."
        }
      });

      const data = await buildDashboardData(storePath, { limit: 10 }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        capture_policy: {
          read_only: boolean;
          policy: { id: string; auto_canonical: boolean };
          stats: { review_records: number; policy_archived_records: number; archived_by_rule: Record<string, number> };
          decisions_by_record_id: Record<string, { decision: string; review_required: boolean; auto_canonical: boolean; rule_ids: string[] }>;
          findings_by_id: Record<string, { category: string; record_ids: string[] }>;
          suggested_actions_by_id: Record<string, { recommended_action: string; tool: string; safe_to_run: boolean }>;
        };
        capture_inbox: {
          total: number;
          policy: {
            id: string;
          };
          autocapture_policy: {
            id: string;
            archived_total: number;
            archived_by_rule: Record<string, number>;
            archived_examples: Array<{ id: string; text: string; rule_ids: string[]; reason?: string }>;
          };
          items: Array<{ text: string }>;
        };
      };

      expect(data.capture_inbox.total).toBe(1);
      expect(data.capture_inbox.items.map((item) => item.text)).toEqual(["Useful handoff still needs user review."]);
      expect(data.capture_inbox.policy.id).toBe("default_capture_review_policy");
      expect(data.capture_inbox.autocapture_policy).toMatchObject({
        id: "default_autocapture_policy",
        archived_total: 1,
        archived_by_rule: { smoke_test_marker: 1 },
        archived_examples: [
          expect.objectContaining({
            text: "Smoke test marker only.",
            rule_ids: ["smoke_test_marker"],
            reason: "Autocapture policy archived this handoff: smoke_test_marker."
          })
        ]
      });
      expect(data.capture_policy).toMatchObject({
        read_only: true,
        policy: {
          id: "default_autocapture_policy",
          auto_canonical: false
        },
        stats: {
          review_records: 1,
          policy_archived_records: 1,
          archived_by_rule: { smoke_test_marker: 1 }
        }
      });
      expect(data.capture_policy.decisions_by_record_id.rec_capture_policy_1).toMatchObject({
        decision: "review",
        review_required: true,
        auto_canonical: false,
        rule_ids: ["default_review_for_agent_handoff"]
      });
      expect(data.capture_policy.decisions_by_record_id.rec_capture_policy_2).toMatchObject({
        decision: "archive",
        review_required: false,
        auto_canonical: false,
        rule_ids: ["smoke_test_marker"]
      });
      expect(data.capture_policy.findings_by_id.policy_archived).toMatchObject({
        category: "policy_archive",
        record_ids: ["rec_capture_policy_2"]
      });
      expect(data.capture_policy.suggested_actions_by_id["inspect:rec_capture_policy_2"]).toMatchObject({
        recommended_action: "inspect_policy_archived_record",
        tool: "timeline",
        safe_to_run: true
      });
      expect(data.actions_by_id["capture_inbox.record.approve.rec_capture_policy_1"]).toMatchObject({
        action_id: "capture_inbox.record.approve.rec_capture_policy_1",
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Approve Memory",
        intent: "approve",
        target: { type: "record", id: "rec_capture_policy_1" },
        endpoint: "api/capture-inbox/rec_capture_policy_1/approve",
        method: "POST",
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "capture_inbox.items[]"
      });
      expect(data.actions_by_id["capture_inbox.record.reject.rec_capture_policy_1"]).toMatchObject({
        action_id: "capture_inbox.record.reject.rec_capture_policy_1",
        surface: "capture_inbox",
        kind: "dashboard_api",
        label: "Reject",
        intent: "reject",
        target: { type: "record", id: "rec_capture_policy_1" },
        endpoint: "api/capture-inbox/rec_capture_policy_1/reject",
        method: "POST",
        safety: {
          safe_to_auto_run: false,
          requires_user_confirmation: true,
          writes: "append_only_events",
          stale_guard: "active_candidate_record"
        },
        source_path: "capture_inbox.items[]"
      });
      expect(data.actions_by_id["capture_policy.inspect.rec_capture_policy_2"]).toMatchObject({
        action_id: "capture_policy.inspect.rec_capture_policy_2",
        surface: "capture_policy",
        kind: "cli_command",
        label: "inspect_policy_archived_record",
        intent: "inspect",
        command: "moryn timeline --record-id rec_capture_policy_2 --project-id moryn --before 3 --after 3",
        safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          writes: "none"
        },
        source_path: "capture_policy.suggested_actions_by_id.inspect:rec_capture_policy_2"
      });

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      // Policy-archived records must not be surfaced as actionable Capture Inbox items.
      expect(html).not.toContain("api/capture-inbox/rec_capture_policy_2/approve");
      expect(html).not.toContain("api/capture-inbox/rec_capture_policy_2/reject");
      expect(JSON.stringify(data.capture_policy)).toContain("policy_archived");
      expect(JSON.stringify(data.capture_policy)).toContain("moryn timeline --record-id rec_capture_policy_2 --project-id moryn --before 3 --after 3");
    });
  });

  it("keeps auto-captured handoffs out of Capture Inbox while preserving audit evidence", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T10:11:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_auto_capture_1" : "evt_auto_capture_1"
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "auto-captured", "host:codex"],
        content: {
          format: "json",
          text: "Codex finished setup wizard polish.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "capture",
              route: "auto_capture",
              review_required: false,
              user_action_required: false,
              auto_canonical: false,
              dashboard_surface: "handoff",
              rule_ids: ["low_risk_handoff_auto_capture"],
              reasons: ["low_risk_handoff_auto_capture"]
            }
          }
        },
        source: { client: "codex", session_id: "auto-capture" },
        provenance: {
          method: "agent-proposed",
          reason: "Autocapture policy retained this low-risk handoff without canonical promotion."
        }
      });

      const data = await buildDashboardData(storePath, { limit: 10 }) as Awaited<ReturnType<typeof buildDashboardData>> & {
        actions_by_id: Record<string, {
          action_id: string;
          surface: string;
          kind: string;
          label: string;
          intent: string;
          command?: string;
          safety: {
            safe_to_auto_run: boolean;
            requires_user_confirmation: boolean;
            writes: string;
          };
          source_path: string;
        }>;
        capture_inbox: {
          total: number;
          autocapture_policy: {
            auto_captured_total: number;
            captured_by_rule: Record<string, number>;
            auto_captured_examples: Array<{ id: string; text: string; rule_ids: string[]; reason?: string }>;
          };
          items: Array<{ id: string; text: string }>;
        };
        capture_policy: {
          stats: {
            total_autocapture_records: number;
            auto_captured_records: number;
            review_records: number;
            policy_archived_records: number;
            captured_by_rule: Record<string, number>;
          };
          decisions_by_record_id: Record<string, { decision: string; review_required: boolean; auto_canonical: boolean; rule_ids: string[] }>;
          findings_by_id: Record<string, { category: string; record_ids: string[] }>;
          suggested_actions_by_id: Record<string, { recommended_action: string; tool: string; safe_to_run: boolean }>;
        };
      };

      expect(data.capture_inbox.total).toBe(0);
      expect(data.capture_inbox.items).toHaveLength(0);
      expect(data.health_check.status).toBe("healthy");
      expect(data.health_check.stats.capture_review_candidates).toBe(0);
      expect(data.health_check.checks_by_id.capture_review_backlog).toMatchObject({
        status: "pass",
        summary: "No active capture candidates need review."
      });
      expect(data.capture_inbox.autocapture_policy).toMatchObject({
        auto_captured_total: 1,
        captured_by_rule: { low_risk_handoff_auto_capture: 1 },
        auto_captured_examples: [
          expect.objectContaining({
            id: "rec_auto_capture_1",
            text: "Codex finished setup wizard polish.",
            rule_ids: ["low_risk_handoff_auto_capture"],
            reason: "Autocapture policy retained this low-risk handoff without canonical promotion."
          })
        ]
      });
      expect(data.capture_policy.stats).toMatchObject({
        total_autocapture_records: 1,
        auto_captured_records: 1,
        review_records: 0,
        policy_archived_records: 0,
        captured_by_rule: { low_risk_handoff_auto_capture: 1 }
      });
      expect(data.capture_policy.decisions_by_record_id.rec_auto_capture_1).toMatchObject({
        decision: "capture",
        review_required: false,
        auto_canonical: false,
        rule_ids: ["low_risk_handoff_auto_capture"]
      });
      expect(data.capture_policy.findings_by_id.auto_captured).toMatchObject({
        category: "auto_capture",
        record_ids: ["rec_auto_capture_1"]
      });
      expect(data.capture_policy.suggested_actions_by_id["inspect:rec_auto_capture_1"]).toMatchObject({
        recommended_action: "inspect_auto_captured_handoff",
        tool: "timeline",
        safe_to_run: true
      });
      expect(data.actions_by_id["capture_inbox.record.approve.rec_auto_capture_1"]).toBeUndefined();
      expect(data.actions_by_id["capture_inbox.record.reject.rec_auto_capture_1"]).toBeUndefined();
      expect(data.actions_by_id["capture_policy.inspect.rec_auto_capture_1"]).toMatchObject({
        action_id: "capture_policy.inspect.rec_auto_capture_1",
        surface: "capture_policy",
        kind: "cli_command",
        label: "inspect_auto_captured_handoff",
        intent: "inspect",
        safety: {
          safe_to_auto_run: true,
          requires_user_confirmation: false,
          writes: "none"
        },
        source_path: "capture_policy.suggested_actions_by_id.inspect:rec_auto_capture_1"
      });

      const html = renderDashboardHtml(data);
      expect(html).toContain("data-dashboard-editorial-shell");
      expect(html).toContain("Codex finished setup wizard polish.");
      expect(JSON.stringify(data.capture_policy)).toContain("low_risk_handoff_auto_capture");
      expect(JSON.stringify(data.capture_policy)).toContain("Codex finished setup wizard polish.");
      expect(JSON.stringify(data.capture_policy)).toContain("inspect_auto_captured_handoff");
      expect(JSON.stringify(data.capture_policy)).toContain("moryn timeline --record-id rec_auto_capture_1 --project-id moryn --before 3 --after 3");
      // Auto-captured handoff must not be an actionable Capture Inbox item.
      expect(html).not.toContain("api/capture-inbox/rec_auto_capture_1/approve");
      expect(html).not.toContain("api/capture-inbox/rec_auto_capture_1/reject");
    });
  });

  it("rechecks stale review metadata before surfacing low-risk handoffs in Capture Inbox", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T10:12:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_stale_review_handoff" : "evt_stale_review_handoff"
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "json",
          text: "Dashboard UI decluttering slice completed on main. The Overview now prioritizes explicit Pending Decisions over sync warnings when both are present: focusBriefPrimaryItem priority changed to confirm -> review -> sync. Sync pending remains visible through health badge, Store Signals, Action Board review/sync entries, and dashboard_overview cards/API evidence, but the first-screen headline and primary action stay on Review decisions / decision-summary when user confirmation is waiting. Added regression coverage for the combined pending decision + dirty sync scenario, preserved sync-only overview behavior, updated dashboard docs/docs-contract, verified dashboard suite, docs-contract suite, typecheck, build, release check, git diff check, live dashboard API, commit pushed, and dashboard service restarted.",
          capture: {
            mode: "autocapture",
            host: "codex",
            current_task: "Moryn v0.2.0 dashboard UI decluttering and prioritization",
            policy: {
              id: "default_autocapture_policy",
              version: 1,
              decision: "review",
              route: "manual_review",
              review_required: true,
              user_action_required: true,
              auto_canonical: false,
              dashboard_surface: "capture_inbox",
              rule_ids: ["review_risk_marker"],
              reasons: ["review_risk_marker"]
            }
          }
        },
        state: "candidate",
        source: { client: "codex", session_id: "dashboard-route-1" },
        provenance: {
          method: "agent-proposed",
          reason: "Captured through Moryn host adapter autocapture."
        }
      });

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
      const html = renderDashboardHtml(data);

      expect(data.capture_inbox.total).toBe(0);
      expect(data.capture_inbox.items).toHaveLength(0);
      expect(data.health_check.status).toBe("healthy");
      expect(data.health_check.stats.capture_review_candidates).toBe(0);
      expect(data.health_check.checks_by_id.capture_review_backlog).toMatchObject({
        status: "pass",
        summary: "No active capture candidates need review."
      });
      expect(data.dogfood_report.findings_by_id.capture_review_backlog).toBeUndefined();
      expect(data.dogfood_report.stats.autocapture_candidates).toBe(0);
      expect(data.capture_policy.stats).toMatchObject({
        total_autocapture_records: 1,
        auto_captured_records: 1,
        review_records: 0,
        policy_archived_records: 0,
        captured_by_rule: { low_risk_handoff_auto_capture: 1 }
      });
      expect(data.capture_policy.decisions_by_record_id.rec_stale_review_handoff).toMatchObject({
        decision: "capture",
        review_required: false,
        auto_canonical: false,
        rule_ids: ["low_risk_handoff_auto_capture"]
      });
      expect(data.capture_policy.findings_by_id.review_required).toBeUndefined();
      expect(data.capture_policy.suggested_actions_by_id.review_capture_inbox).toBeUndefined();
      expect(data.governance.items_by_id["capture_policy:review_required"]).toBeUndefined();
      expect(data.governance.items_by_id["dogfood_report:capture_review_backlog"]).toBeUndefined();
      expect(data.actions_by_id["capture_inbox.record.approve.rec_stale_review_handoff"]).toBeUndefined();
      expect(data.actions_by_id["capture_inbox.record.reject.rec_stale_review_handoff"]).toBeUndefined();
      expect(data.actions_by_id["capture_policy.inspect.rec_stale_review_handoff"]).toMatchObject({
        action_id: "capture_policy.inspect.rec_stale_review_handoff",
        surface: "capture_policy",
        kind: "cli_command",
        label: "inspect_auto_captured_handoff",
        intent: "inspect"
      });
      expect(html).toContain("data-dashboard-editorial-shell");
      // Auto-captured low-risk handoff must not appear as an actionable Capture Inbox item.
      expect(html).not.toContain("api/capture-inbox/rec_stale_review_handoff/approve");
      expect(html).not.toContain("api/capture-inbox/rec_stale_review_handoff/reject");
      expect(JSON.stringify(data.capture_policy)).toContain("low_risk_handoff_auto_capture");
    });
  });

  it("does not render Capture Policy review actions for records no longer actionable in Capture Inbox", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });
      const engine = createEngine({
        storePath,
        now: () => "2026-06-01T10:01:00.000Z",
        id: (prefix: string) => prefix === "rec" ? "rec_policy_handled" : "evt_policy_handled"
      });

      await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: {
          format: "json",
          text: "Already handled autocapture review.",
          capture: {
            mode: "autocapture",
            host: "codex",
            policy: {
              id: "default_autocapture_policy",
              decision: "review",
              review_required: true,
              auto_canonical: false,
              rule_ids: ["default_review_for_agent_handoff"]
            }
          }
        },
        state: "canonical",
        confirmed: true,
        source: { client: "user", session_id: "policy-handled" }
      });

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn", now: "2026-06-01T10:02:00.000Z" });
      const html = renderDashboardHtml(data);

      expect(data.capture_inbox.total).toBe(0);
      expect(data.capture_policy.decisions_by_record_id.rec_policy_handled).toMatchObject({
        decision: "review",
        state: "canonical",
        review_required: false
      });
      expect(data.capture_policy.findings_by_id.review_required).toBeUndefined();
      expect(data.capture_policy.suggested_actions_by_id.review_capture_inbox).toBeUndefined();
      expect(data.governance.items_by_id["capture_policy:review_required"]).toBeUndefined();
      expect(data.governance.summary.needs_user_action).toBe(0);
      expect(data.actions_by_id["capture_inbox.record.approve.rec_policy_handled"]).toBeUndefined();
      expect(data.actions_by_id["capture_inbox.record.reject.rec_policy_handled"]).toBeUndefined();
      expect(data.memory_lifecycle.findings).toHaveLength(0);
      expect(data.memory_lifecycle.suggested_actions).toHaveLength(0);
      expect(data.capture_policy.findings).toHaveLength(0);
      expect(data.capture_policy.suggested_actions).toHaveLength(0);
      expect(html).toContain("data-dashboard-editorial-shell");
      // Already-handled record must not appear as an actionable Capture Inbox item.
      expect(html).not.toContain("api/capture-inbox/rec_policy_handled/approve");
      expect(html).not.toContain("api/capture-inbox/rec_policy_handled/reject");
      expect(html).not.toContain("data-dashboard-action-id=\"capture_inbox.record.approve.rec_policy_handled\"");
      expect(html).not.toContain("data-dashboard-action-id=\"capture_inbox.record.reject.rec_policy_handled\"");
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
      const snapshotHtml = await readFile(snapshot.path, "utf8");
      expect(snapshotHtml).toContain("data-dashboard-editorial-shell");
      // The redesigned Memory view shows saved record bodies in the snapshot.
      expect(snapshotHtml).toContain("Snapshot contains this memory");
      const snapshotData = await buildDashboardData(storePath, { limit: 5 });
      expect(snapshotData.recent_value.map((record) => record.summary)).toContain("Snapshot contains this memory");
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
        refreshIntervalMs: 250,
        project_id: "moryn",
        readiness_host: "codex",
        sync_remote: "git@github.com:user/moryn-store.git"
      });
      try {
        expect(server.serving).toBe(true);
        expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

        const page = await (await fetch(server.url)).text();
        expect(page).toContain("class=\"neutral-intelligence\"");
        expect(page).toContain("data-dashboard-refresh=\"250\"");
        expect(page).toContain("fetch(\"fragment\"");
        expect(page).toContain("data-dashboard-editorial-shell");
        expect(page).toContain("data-memory-result");
        expect(page).toContain("Initial live dashboard memory");

        const head = await fetch(server.url, { method: "HEAD" });
        expect(head.status).toBe(200);

        const initialApi = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          totals: { records: number };
          recent_value: Array<{
            summary: string;
            citation: {
              record_id: string;
              event_id?: string;
              timeline_command: string;
              recall_command: string;
            };
          }>;
          health_check: {
            setup_readiness: {
              host: string;
              sync_remote?: string;
              install_command: string;
              context_pack_command: string;
            };
          };
        };
        expect(initialApi.totals.records).toBe(1);
        expect(initialApi.recent_value[0]?.summary).toBe("Initial live dashboard memory");
        expect(initialApi.recent_value[0]?.citation).toMatchObject({
          record_id: "rec_live_1",
          timeline_command: "moryn timeline --record-id rec_live_1 --project-id moryn",
          recall_command: "moryn recall --record-id rec_live_1 --project-id moryn"
        });
        expect(initialApi.recent_value[0]?.citation.event_id).toMatch(/^evt_live_\d+$/);
        expect(initialApi.health_check.setup_readiness).toMatchObject({
          host: "codex",
          sync_remote: "git@github.com:user/moryn-store.git",
          install_command: "moryn install --host codex --sync-remote git@github.com:user/moryn-store.git",
          context_pack_command: "moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task '<current task>' --agent codex"
        });

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
        expect(refreshedFragment).toContain("data-dashboard-editorial-shell");
        expect(refreshedFragment).toContain("data-memory-result");
        expect(refreshedFragment).toContain("Live dashboard refresh memory");

        const missing = await fetch(new URL("/missing", server.url));
        expect(missing.status).toBe(404);
      } finally {
        await server.close();
      }
    });
  });

  it("approves and rejects Capture Inbox records from the dashboard server", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_capture_action_${++record}` : `evt_capture_action_${++event}`;
        })()
      });

      const approved = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Approve this captured handoff.", format: "text" },
        source: { client: "codex" }
      });
      const rejected = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:claude"],
        content: { text: "Reject this captured handoff.", format: "text" },
        source: { client: "claude" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const approveResponse = await fetch(new URL(`/api/capture-inbox/${approved.record.id}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const approveBody = await approveResponse.json() as {
          ok: boolean;
          status: string;
          record_id: string;
          event_id: string;
          trace: { timeline_command: string; recall_command: string };
        };

        expect(approveResponse.status).toBe(200);
        expect(approveBody).toMatchObject({
          ok: true,
          status: "approved",
          record_id: approved.record.id
        });
        expect(approveBody.event_id).toMatch(/^evt_/);
        expect(approveBody.trace).toEqual({
          timeline_command: `moryn timeline --event-id ${approveBody.event_id} --project-id moryn`,
          recall_command: `moryn recall --record-id ${approved.record.id} --project-id moryn`
        });
        expect((await engine.recall({ record_ids: [approved.record.id], states: ["canonical"], project_id: "moryn" })).results[0]?.record.state).toBe("canonical");

        const rejectResponse = await fetch(new URL(`/api/capture-inbox/${rejected.record.id}/reject`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "User rejected Capture Inbox candidate." })
        });
        const rejectBody = await rejectResponse.json() as {
          ok: boolean;
          status: string;
          record_id: string;
          event_id: string;
          trace: { timeline_command: string; recall_command: string };
        };

        expect(rejectResponse.status).toBe(200);
        expect(rejectBody).toMatchObject({
          ok: true,
          status: "rejected",
          record_id: rejected.record.id
        });
        expect(rejectBody.event_id).toMatch(/^evt_/);
        expect(rejectBody.trace).toEqual({
          timeline_command: `moryn timeline --event-id ${rejectBody.event_id} --project-id moryn`,
          recall_command: `moryn recall --record-id ${rejected.record.id} --project-id moryn`
        });
        expect((await engine.recall({ record_ids: [rejected.record.id], states: ["archived"], project_id: "moryn" })).results[0]?.record.state).toBe("archived");

        const refreshed = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          capture_inbox: { total: number };
        };
        expect(refreshed.capture_inbox.total).toBe(0);
      } finally {
        await server.close();
      }
    });
  });

  it("approves and rejects Capture Inbox groups from the dashboard server", async () => {
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
            "2026-06-01T00:05:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:06:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_capture_bulk_${++record}` : `evt_capture_bulk_${++event}`;
        })()
      });

      const approveOne = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Approve grouped capture one.", format: "text" },
        source: { client: "codex", session_id: "approve-group" }
      });
      const approveTwo = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Approve grouped capture two.", format: "text" },
        source: { client: "codex", session_id: "approve-group" }
      });
      const rejectOne = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:claude"],
        content: { text: "Reject grouped capture one.", format: "text" },
        source: { client: "claude", session_id: "reject-group" }
      });
      const rejectTwo = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:claude"],
        content: { text: "Reject grouped capture two.", format: "text" },
        source: { client: "claude", session_id: "reject-group" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const dashboard = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          capture_inbox: {
            groups: Array<{ source_detail: string; record_ids: string[]; approve_endpoint: string; reject_endpoint: string }>;
          };
        };
        const approveGroup = dashboard.capture_inbox.groups.find((group) => group.source_detail === "codex / approve-group")!;
        const rejectGroup = dashboard.capture_inbox.groups.find((group) => group.source_detail === "claude / reject-group")!;

        const approveResponse = await fetch(new URL(approveGroup.approve_endpoint, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ record_ids: approveGroup.record_ids })
        });
        const approved = await approveResponse.json() as {
          ok: boolean;
          status: string;
          group_id: string;
          records_changed: number;
          record_ids: string[];
          event_ids: string[];
          trace: { timeline_commands: string[]; recall_commands: string[] };
        };

        expect(approveResponse.status).toBe(200);
        expect(approved).toMatchObject({
          ok: true,
          status: "approved",
          records_changed: 2,
          record_ids: [approveTwo.record.id, approveOne.record.id]
        });
        expect(approved.trace).toEqual({
          timeline_commands: approved.event_ids.map((eventId) => `moryn timeline --event-id ${eventId} --project-id moryn`),
          recall_commands: [approveTwo.record.id, approveOne.record.id].map((recordId) => `moryn recall --record-id ${recordId} --project-id moryn`)
        });
        expect((await engine.recall({ record_ids: [approveOne.record.id, approveTwo.record.id], states: ["canonical"], project_id: "moryn" })).results.map((result) => result.record.id).sort()).toEqual([
          approveOne.record.id,
          approveTwo.record.id
        ].sort());

        const rejectResponse = await fetch(new URL(rejectGroup.reject_endpoint, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            record_ids: rejectGroup.record_ids,
            reason: "User rejected Capture Inbox group."
          })
        });
        const rejected = await rejectResponse.json() as {
          ok: boolean;
          status: string;
          records_changed: number;
          record_ids: string[];
          event_ids: string[];
          trace: { timeline_commands: string[]; recall_commands: string[] };
        };

        expect(rejectResponse.status).toBe(200);
        expect(rejected).toMatchObject({
          ok: true,
          status: "rejected",
          records_changed: 2,
          record_ids: [rejectTwo.record.id, rejectOne.record.id]
        });
        expect(rejected.trace).toEqual({
          timeline_commands: rejected.event_ids.map((eventId) => `moryn timeline --event-id ${eventId} --project-id moryn`),
          recall_commands: [rejectTwo.record.id, rejectOne.record.id].map((recordId) => `moryn recall --record-id ${recordId} --project-id moryn`)
        });
        expect((await engine.recall({ record_ids: [rejectOne.record.id, rejectTwo.record.id], states: ["archived"], project_id: "moryn" })).results.map((result) => result.record.id).sort()).toEqual([
          rejectOne.record.id,
          rejectTwo.record.id
        ].sort());

        const refreshed = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          capture_inbox: { total: number; groups: unknown[] };
        };
        expect(refreshed.capture_inbox).toMatchObject({ total: 0, groups: [] });
      } finally {
        await server.close();
      }
    });
  });

  it("rejects stale Capture Inbox group actions", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_capture_stale_${++record}` : `evt_capture_stale_${++event}`;
        })()
      });
      const first = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "First stale group item.", format: "text" },
        source: { client: "codex", session_id: "stale-group" }
      });
      const second = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["autocapture", "review", "host:codex"],
        content: { text: "Second stale group item.", format: "text" },
        source: { client: "codex", session_id: "stale-group" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const dashboard = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          capture_inbox: { groups: Array<{ approve_endpoint: string; record_ids: string[] }> };
        };
        const group = dashboard.capture_inbox.groups[0]!;

        await engine.promote({
          record_id: first.record.id,
          target_state: "canonical",
          reason: "User approved separately.",
          source: { client: "user" },
          confirmed: true
        });

        const response = await fetch(new URL(group.approve_endpoint, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ record_ids: group.record_ids })
        });
        const body = await response.json() as { ok: boolean; status: string; message: string };

        expect(response.status).toBe(409);
        expect(body).toEqual({
          ok: false,
          status: "not_actionable",
          message: "Capture Inbox group actions require current active candidate records from the selected group."
        });
        expect((await engine.recall({ record_ids: [second.record.id], states: ["candidate"], project_id: "moryn" })).results[0]?.record.state).toBe("candidate");
      } finally {
        await server.close();
      }
    });
  });

  it("rejects Capture Inbox actions for non-candidate records", async () => {
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
          return (prefix: string) => `${prefix}_capture_invalid_${++count}`;
        })()
      });
      const canonical = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["review"],
        content: { text: "Already canonical.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const response = await fetch(new URL(`/api/capture-inbox/${canonical.record.id}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const body = await response.json() as { ok: boolean; status: string; message: string };

        expect(response.status).toBe(409);
        expect(body).toEqual({
          ok: false,
          status: "not_actionable",
          message: "Capture Inbox actions require an active review candidate record."
        });
      } finally {
        await server.close();
      }
    });
  });

  it("approves Candidate Triage promotion drafts from the dashboard server", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_candidate_promote_${++record}` : `evt_candidate_promote_${++event}`;
        })()
      });
      const candidate = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Keep dashboard approval explicit.", format: "text" },
        state: "candidate",
        confidence: 0.95,
        priority: "high",
        source: { client: "codex", session_id: "candidate-approve" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const dashboard = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          candidate_triage: {
            groups_by_id: {
              promotable?: {
                promotion_drafts_by_id: Record<string, { approve_endpoint: string; action_id: string }>;
              };
            };
          };
        };
        const draft = dashboard.candidate_triage.groups_by_id.promotable?.promotion_drafts_by_id[candidate.record.id];
        expect(draft).toMatchObject({
          approve_endpoint: `api/candidate-triage/promotions/${candidate.record.id}/approve`,
          action_id: `candidate_triage.promotion.approve.${candidate.record.id}`
        });

        const response = await fetch(new URL(draft!.approve_endpoint, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const approved = await response.json() as {
          ok: boolean;
          status: string;
          record_id: string;
          event_id: string;
          trace: { timeline_command: string; recall_command: string };
        };

        expect(response.status).toBe(200);
        expect(approved).toMatchObject({
          ok: true,
          status: "approved",
          record_id: candidate.record.id
        });
        expect(approved.event_id).toMatch(/^evt_/);
        expect(approved.trace).toEqual({
          timeline_command: `moryn timeline --event-id ${approved.event_id} --project-id moryn`,
          recall_command: `moryn recall --record-id ${candidate.record.id} --project-id moryn`
        });
        expect((await engine.recall({ record_ids: [candidate.record.id], states: ["canonical"], project_id: "moryn" })).results[0]?.record.state).toBe("canonical");

        const refreshed = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          candidate_triage: { groups_by_id: { promotable?: { record_ids: string[] } } };
        };
        expect(refreshed.candidate_triage.groups_by_id.promotable?.record_ids ?? []).not.toContain(candidate.record.id);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects stale Candidate Triage promotion approvals", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_candidate_stale_${++record}` : `evt_candidate_stale_${++event}`;
        })()
      });
      const candidate = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "moryn",
        tags: ["dashboard"],
        content: { text: "Candidate already handled elsewhere.", format: "text" },
        state: "candidate",
        confidence: 0.95,
        priority: "high",
        source: { client: "codex", session_id: "candidate-stale" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        await engine.promote({
          record_id: candidate.record.id,
          target_state: "canonical",
          reason: "User approved elsewhere.",
          source: { client: "user" },
          confirmed: true
        });

        const response = await fetch(new URL(`/api/candidate-triage/promotions/${candidate.record.id}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        });
        const body = await response.json() as { ok: boolean; status: string; message: string };

        expect(response.status).toBe(409);
        expect(body).toEqual({
          ok: false,
          status: "not_actionable",
          message: "Candidate Triage promotion requires a current promotable candidate record."
        });
      } finally {
        await server.close();
      }
    });
  });

  it("approves project identity repair plans from the dashboard server", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_approve_${++record}` : `evt_approve_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const oldRecord = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project id record.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const dashboard = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          maintenance: {
            plans: Array<{ plan_id: string; plan_hash: string }>;
          };
        };
        const plan = dashboard.maintenance.plans[0];
        expect(plan).toBeDefined();

        const response = await fetch(new URL(`/api/maintenance/plans/${encodeURIComponent(plan.plan_id)}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan_hash: plan.plan_hash })
        });
        const applied = await response.json() as {
          ok: boolean;
          status: string;
          migrated_records: number;
          events_written: number;
          record_ids: string[];
          event_ids: string[];
          trace: { timeline_commands: string[]; recall_commands: string[] };
        };

        expect(response.status).toBe(200);
        expect(applied).toMatchObject({
          ok: true,
          status: "applied",
          migrated_records: 1,
          events_written: 1,
          record_ids: [oldRecord.record.id]
        });
        expect(applied.event_ids).toHaveLength(1);
        expect(applied.event_ids[0]).toMatch(/^evt_/);
        expect(applied.trace).toEqual({
          timeline_commands: applied.event_ids.map((eventId) => `moryn timeline --event-id ${eventId} --project-id moryn`),
          recall_commands: [oldRecord.record.id].map((recordId) => `moryn recall --record-id ${recordId} --project-id moryn`)
        });
        expect((await engine.recall({ record_ids: [oldRecord.record.id], project_id: "moryn" })).results[0]?.record.project_id).toBe("moryn");
      } finally {
        await server.close();
      }
    });
  });

  it("approves candidate noise archive plans from the dashboard server", async () => {
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
            "2026-06-01T00:07:00.000Z"
          ];
          return () => timestamps.shift() ?? "2026-06-01T00:08:00.000Z";
        })(),
        id: (() => {
          let record = 0;
          let event = 0;
          return (prefix: string) => prefix === "rec" ? `rec_noise_apply_${++record}` : `evt_noise_apply_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const marker = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn", "marker"],
        content: { text: "Marker candidate from dashboard smoke test.", format: "text" },
        source: { client: "codex" }
      });
      const smoke = await engine.write({
        kind: "session_summary",
        type: "summary",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn", "smoke"],
        content: { text: "Smoke candidate left by package e2e.", format: "text" },
        source: { client: "codex" }
      });
      const e2e = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "E2E marker note should be reviewed before archive.", format: "text" },
        state: "candidate",
        source: { client: "codex" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const dashboard = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          maintenance: {
            plans: Array<{ plan_id: string; plan_hash: string; type: string }>;
          };
        };
        const plan = dashboard.maintenance.plans.find((candidate) => candidate.type === "candidate_noise_archive");
        expect(plan).toBeDefined();

        const response = await fetch(new URL(`/api/maintenance/plans/${encodeURIComponent(plan?.plan_id ?? "")}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan_hash: plan?.plan_hash })
        });
        const applied = await response.json() as {
          ok: boolean;
          status: string;
          archived_records: number;
          records_changed: number;
          events_written: number;
          record_ids: string[];
          event_ids: string[];
          trace: { timeline_commands: string[]; recall_commands: string[] };
        };

        expect(response.status).toBe(200);
        expect(applied).toMatchObject({
          ok: true,
          status: "applied",
          archived_records: 3,
          records_changed: 3,
          events_written: 3,
          record_ids: [
            e2e.record.id,
            smoke.record.id,
            marker.record.id
          ]
        });
        expect(applied.event_ids).toHaveLength(3);
        expect(applied.event_ids.every((eventId) => /^evt_/.test(eventId))).toBe(true);
        expect(applied.trace).toEqual({
          timeline_commands: applied.event_ids.map((eventId) => `moryn timeline --event-id ${eventId} --project-id moryn`),
          recall_commands: [e2e.record.id, smoke.record.id, marker.record.id].map((recordId) => `moryn recall --record-id ${recordId} --project-id moryn`)
        });
        const recalled = await engine.recall({
          record_ids: [e2e.record.id, smoke.record.id, marker.record.id],
          states: ["archived"],
          project_id: "moryn"
        });
        expect(recalled.results.map((result) => result.record.state)).toEqual(["archived", "archived", "archived"]);
      } finally {
        await server.close();
      }
    });
  });

  it("rejects stale maintenance plan approvals", async () => {
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
          return (prefix: string) => prefix === "rec" ? `rec_stale_${++record}` : `evt_stale_${++event}`;
        })()
      });

      await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "moryn",
        tags: ["moryn"],
        content: { text: "Canonical Moryn context.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });
      const oldRecord = await engine.write({
        kind: "memory",
        type: "rule",
        scope: "project",
        project_id: "repo-e6f0166fd942",
        tags: ["moryn"],
        content: { text: "Old project id record.", format: "text" },
        state: "canonical",
        confirmed: true,
        source: { client: "user" }
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        limit: 10,
        project_id: "moryn"
      });
      try {
        const dashboard = await (await fetch(new URL("/api/dashboard", server.url))).json() as {
          maintenance: {
            plans: Array<{ plan_id: string; plan_hash: string }>;
          };
        };
        const plan = dashboard.maintenance.plans[0];
        expect(plan).toBeDefined();

        await engine.write({
          kind: "session_summary",
          type: "summary",
          scope: "project",
          project_id: "repo-e6f0166fd942",
          tags: ["moryn"],
          content: { text: "New old-project record changes the dry run.", format: "text" },
          source: { client: "codex" }
        });

        const response = await fetch(new URL(`/api/maintenance/plans/${encodeURIComponent(plan.plan_id)}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ plan_hash: plan.plan_hash })
        });
        const stale = await response.json() as {
          ok: boolean;
          status: string;
          message: string;
        };

        expect(response.status).toBe(409);
        expect(stale).toMatchObject({
          ok: false,
          status: "stale_plan",
          message: "The store changed after this plan was rendered. Review the refreshed plan before approving."
        });
        expect((await engine.recall({ record_ids: [oldRecord.record.id], project_id: "repo-e6f0166fd942" })).results[0]?.record.project_id).toBe("repo-e6f0166fd942");
      } finally {
        await server.close();
      }
    });
  });

  it("rejects malformed maintenance approval JSON", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, {
        now: () => "2026-06-01T00:00:00.000Z",
        id: () => "device_test"
      });

      const server = await startDashboardServer(storePath, {
        host: "127.0.0.1",
        port: 0,
        project_id: "moryn"
      });
      try {
        const response = await fetch(new URL(`/api/maintenance/plans/${encodeURIComponent("project_migrate:old->moryn")}/approve`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{"
        });
        const body = await response.json() as { error: string };

        expect(response.status).toBe(400);
        expect(body).toEqual({
          error: "Invalid request: JSON body is required"
        });
      } finally {
        await server.close();
      }
    });
  });
});

describe("logical memory capacity telemetry", () => {
  it("reports a bounded active working set without deleting store history", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      let nextId = 0;
      const engine = createEngine({ storePath, id: (prefix) => `${prefix}_${++nextId}` });
      const base = { kind: "memory", type: "decision", scope: "project", project_id: "moryn", source: { client: "codex" } } as const;
      const first = await engine.write({ ...base, content: { text: "Autonomous sync" } });
      const duplicate = await engine.write({ ...base, content: { text: "Autonomous sync" } });
      await engine.logicalLink({ record_id: duplicate.record.id, linked_record_id: first.record.id, relationship: "duplicate_of", reason: "Exact duplicate" });
      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.logical_memory).toEqual({ store_records: 2, active_working_set_records: 1, hidden_logical_records: 1, conflict_records: 0, cycle_findings: 0, learned_records: 0, learned_canonical_records: 0, learned_candidate_records: 0, learning_evidence_links: 0 });
      expect(data.quiet_dashboard.memory_flow).toMatchObject({
        store_events: 3,
        store_records: 2,
        active_working_set_records: 1,
        hidden_duplicate_records: 1,
        hidden_superseded_records: 0,
        hidden_revised_records: 0,
        compaction_ratio: 0.5
      });
      expect(data.maintenance.plans).toEqual([]);
      const firstScreen = quietFirstScreenHtml(renderDashboardHtml(data));
      expect(firstScreen).toContain("Reduced");
      expect(firstScreen).toContain("50%");
      expect(firstScreen).toContain("3 events");
    });
  });
});

describe("quiet dashboard model", () => {
  it("summarizes a healthy run without exceptional attention", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "session-a", device_id: "device_dda1e19fac3e45e1acb86f26115acc00" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { session_id: "session-a", checkpoint_id: "checkpoint-a", current_task: "Polish dashboard", progress: ["First screen ready"] } });
      const data = await buildDashboardData(storePath, { project_id: "moryn", now: "2026-07-11T00:01:00.000Z" });
      expect(data.quiet_dashboard.system_pulse).toMatchObject({ healthy: true, context_protected: true });
      expect(data.quiet_dashboard.current_context).toMatchObject({ project_id: "moryn", task: "Polish dashboard", agent: "codex", device_id: "device_dda1e19fac3e45e1acb86f26115acc00", checkpoint_available: true });
      expect(data.quiet_dashboard.memory_flow).toMatchObject({ store_records: 1, active_working_set_records: 1 });
      expect(data.quiet_dashboard.attention_needed).toEqual([]);
      const firstScreen = quietFirstScreenHtml(renderDashboardHtml(data));
      expect(firstScreen).toContain(">device · dda1e1<");
      expect(firstScreen).toContain('title="device_dda1e19fac3e45e1acb86f26115acc00"');
    });
  });

  it("keeps routine candidate-noise maintenance out of first-screen attention", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device_dda1e19fac3e45e1acb86f26115acc00" });
      const engine = createEngine({ storePath });
      await engine.write({ kind: "agent_note", type: "note", scope: "project", project_id: "moryn", tags: ["smoke", "marker"], content: { text: "Smoke marker candidate one" }, state: "candidate", source: { client: "codex" } });
      await engine.write({ kind: "agent_note", type: "note", scope: "project", project_id: "moryn", tags: ["e2e", "marker"], content: { text: "E2E marker candidate two" }, state: "candidate", source: { client: "codex" } });
      await engine.write({ kind: "agent_note", type: "note", scope: "project", project_id: "moryn", tags: ["smoke"], content: { text: "Smoke marker candidate three" }, state: "candidate", source: { client: "codex" } });

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      const html = renderDashboardHtml(data);
      const firstScreen = quietFirstScreenHtml(html);
      expect(data.maintenance.plans.some((plan) => plan.type === "candidate_noise_archive")).toBe(true);
      expect(data.quiet_dashboard.attention_needed.map((item) => item.title)).not.toContain("Candidate noise cleanup");
      expect(firstScreen).not.toContain("Candidate noise cleanup");
    });
  });

  it("uses activation receipts instead of agent activity for autopilot status", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "session-a", device_id: "device-a" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { session_id: "session-a", checkpoint_id: "checkpoint-a", current_task: "Observe activation" } });

      const inactive = await buildDashboardData(storePath, { project_id: "moryn", now: "2026-07-11T00:01:00.000Z" });
      expect(inactive.quiet_dashboard.system_pulse).toMatchObject({ autopilot_active: false, autopilot: { status: "not_installed", host: "unknown" } });

      await recordActivationReceipt(storePath, { activation_id: "moryn-v03-moryn-codex", host: "codex", project_id: "moryn", event: "session_start", session_id: "session-a", device_id: "device-a", occurred_at: "2026-07-11T00:02:00.000Z", command_digest: "digest" });
      const active = await buildDashboardData(storePath, { project_id: "moryn", now: "2026-07-11T00:03:00.000Z" });
      expect(active.quiet_dashboard.system_pulse).toMatchObject({ autopilot_active: true, autopilot: { status: "active", host: "codex", last_event: "session_start" } });
      expect(quietFirstScreenHtml(renderDashboardHtml(active))).toContain("Active · Codex");
    });
  });

  it("renders stale activation evidence as degraded without controls", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      await recordActivationReceipt(storePath, { activation_id: "moryn-v03-moryn-claude", host: "claude", project_id: "moryn", event: "pre_compact", session_id: "session-a", device_id: "device-a", occurred_at: "2026-07-10T00:00:00.000Z", command_digest: "digest" });
      const data = await buildDashboardData(storePath, { project_id: "moryn", now: "2026-07-12T00:01:00.000Z" });
      expect(data.quiet_dashboard.system_pulse).toMatchObject({ autopilot_active: false, autopilot: { status: "degraded", host: "claude", last_event: "pre_compact" } });
      const html = quietFirstScreenHtml(renderDashboardHtml(data));
      expect(html).toContain("Degraded · Claude");
      expect(html).not.toMatch(/activation apply|repair hooks|merge hooks/i);
    });
  });

  it("includes only exceptional review items in attention needed", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.write({ kind: "session_summary", type: "summary", scope: "project", project_id: "moryn", tags: ["autocapture", "review", "host:codex"], content: { text: "User preference requires review" }, state: "candidate", source: { client: "codex" } });
      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.quiet_dashboard.attention_needed.length).toBeGreaterThan(0);
      expect(data.quiet_dashboard.attention_needed.every((item) => item.severity !== "info")).toBe(true);
    });
  });
});

describe("quiet dashboard first screen", () => {
  it("renders the warm editorial workspace as the default dashboard view", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.checkpoint({
        project_id: "moryn",
        source: { client: "codex", session_id: "session-dashboard", device_id: "device-test" },
        occurred_at: "2026-07-13T12:00:00.000Z",
        delta: {
          session_id: "session-dashboard",
          checkpoint_id: "checkpoint-dashboard",
          current_task: "Redesign the Moryn dashboard"
        }
      });

      const html = renderDashboardHtml(await buildDashboardData(storePath, { project_id: "moryn" }));

      expect(html).toContain('data-dashboard-view="workspace"');
      expect(html).toContain('data-dashboard-nav="workspace"');
      expect(html).toContain('data-editorial-section="current-context"');
      expect(html).toContain('data-editorial-section="memory-state"');
      expect(html).toContain('data-editorial-section="what-changed"');
      expect(html).toContain('data-editorial-sidebar="important-now"');
      expect(html).toContain("Redesign the Moryn dashboard");
      expect(html).not.toContain("color-scheme: dark");
    });
  });

  it("omits editorial attention when no intervention is required", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const html = renderDashboardHtml(await buildDashboardData(storePath, {
        project_id: "moryn",
        now: "2026-07-13T12:00:00.000Z"
      }));

      expect(html).not.toContain('data-editorial-section="attention"');
      expect(html).toContain('data-editorial-conclusion="no-action-required"');
    });
  });

  it("renders read-only drill-down targets and an accessible drawer", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "drawer-session", device_id: "device-test" }, occurred_at: "2026-07-13T12:00:00.000Z", delta: { session_id: "drawer-session", checkpoint_id: "drawer-checkpoint", current_task: "Verify read-only details" } });
      const html = renderDashboardHtml(await buildDashboardData(storePath, { project_id: "moryn" }));

      expect(html).toContain('data-drawer-target="context-current"');
      expect(html).toContain('data-drawer-target="memory-active"');
      expect(html).toMatch(/data-drawer-target="event-[^"]+"/);
      expect(html).toContain('data-dashboard-drawer');
      expect(html).toContain('role="dialog"');
      expect(html).toContain('aria-modal="true"');
      expect(html).toContain('data-dashboard-drawer-close');
      expect(html).not.toContain('data-dashboard-drawer-write');
    });
  });

  it("ships navigation and drawer state restoration behavior", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const html = renderDashboardServerHtml(await buildDashboardData(storePath), 1000);

      expect(html).toContain("dashboardWorkspaceState?.capture");
      expect(html).toContain("dashboardWorkspaceState?.restore");
      expect(html).toContain("restoreDashboardWorkspaceAfterFragment?.(workspaceState)");
      expect(html).toContain("aria-current");
      expect(html).toContain("event.key === 'Escape'");
      expect(html).toContain("lastTrigger.focus()");
      expect(html).toContain("restoreDashboardWorkspaceAfterFragment");
      expect(html).toContain("openDrawer(state.drawer, null, { focus: true })");
    });
  });

  it("localizes editorial navigation, conclusions, and drawer controls", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const html = renderDashboardHtml(await buildDashboardData(storePath));

      expect(html).toContain('data-i18n-en="Workspace" data-i18n-zh="工作区"');
      expect(html).toContain('data-i18n-en="Memory" data-i18n-zh="记忆"');
      expect(html).toContain('data-i18n-en="History" data-i18n-zh="历史"');
      expect(html).toContain('data-i18n-en="No action required" data-i18n-zh="无需操作"');
      expect(html).toContain('data-i18n-en="Close details" data-i18n-zh="关闭详情"');
      expect(html).toContain('data-i18n-en="Local only" data-i18n-zh="仅保存在本机"');
      expect(html).toContain('data-i18n-en="Active knowledge" data-i18n-zh="活跃知识"');
      expect(html).toContain('data-i18n-en="The bounded working set currently available for agent context." data-i18n-zh="当前可供 Agent 上下文使用的有界工作记忆。"');
      expect(html).toContain('data-i18n-en="context" data-i18n-zh="上下文"');
      expect(html).toContain("window.applyDashboardLanguage?.()");
    });
  });

  it("keeps interaction smooth and unifies audit and language surfaces", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const html = renderDashboardServerHtml(await buildDashboardData(storePath), 2000);

      expect(html).toContain("data-drawer-state=\"open\"");
      expect(html).toContain("data-drawer-state=\"closing\"");
      expect(html).toContain("const wasHidden = drawer.hidden;");
      expect(html).toContain('drawer.dataset.drawerState = "open";');
      expect(html).toContain("document.documentElement.classList.add('dashboard-drawer-open')");
      expect(html).toContain("overscroll-behavior: contain");
      expect(html).toContain("touch-action: pan-y");
      expect(html).toContain("transition: opacity 220ms ease");
      expect(html).toContain("transform: translate3d(100%, 0, 0)");
      expect(html).toContain(".editorial-language-switch");
      expect(html).toContain('data-dashboard-language-toggle class="editorial-language-switch"');
    });
  });

  it("monitors knowledge-loop learning and compact recovery without user controls", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath, now: () => "2026-07-12T00:00:00.000Z" });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "knowledge-dashboard", device_id: "device-test" }, occurred_at: "2026-07-12T00:00:00.000Z", delta: {
        session_id: "knowledge-dashboard",
        checkpoint_id: "knowledge-dashboard-1",
        learnings: [{ question: "When should Moryn recall?", conclusion: "Recall before broad external exploration when durable knowledge is uncertain.", evidence_type: "source_code", scope: "project", confidence: 0.9, recommended_kind: "memory", recommended_type: "fact" }],
        knowledge_investigations: [
          { resolution_id: "recall-first", question: "When should Moryn recall?", recall_status: "knowledge_gap", recalled_record_ids: [], evidence: [{ type: "source_code", reference: "src/core/knowledge-protocol.ts", summary: "Recall-first protocol" }], status: "resolved", conclusion: "Recall first" },
          { resolution_id: "rollback", question: "What is rollback policy?", recall_status: "knowledge_gap", recalled_record_ids: [], evidence: [], status: "unresolved", next_step: "Run rollback integration test" }
        ]
      } });

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.quiet_dashboard.knowledge_loop).toEqual({
        learned_records: 1,
        learned_canonical_records: 1,
        learned_candidate_records: 0,
        investigations: 2,
        resolved_investigations: 1,
        unresolved_investigations: 1,
        preserved_before_compact: 1
      });
      expect(data.quiet_dashboard.attention_needed).toEqual([]);
      const html = quietFirstScreenHtml(renderDashboardHtml(data));
      expect(html).toContain("Learned");
      expect(html).toContain("<strong>1</strong><small>1 investigations resolved</small>");
      expect(html).toContain("1 unresolved preserved");
      expect(html).toContain('data-dashboard-detail="quiet-flow-details"');
      expect(html).not.toContain('data-quiet-section="knowledge-loop"');
      expect(html).not.toMatch(/button|form|Approve|Review knowledge/i);
    });
  });

  it("reports semantic consolidation telemetry without adding routine attention", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath, now: () => "2026-07-12T00:00:00.000Z" });
      const source = await engine.write({ kind: "memory", type: "fact", scope: "project", project_id: "moryn", content: { text: "Moryn syncs when an agent finishes." }, source: { client: "codex" } });
      const target = await engine.write({ kind: "memory", type: "fact", scope: "project", project_id: "moryn", content: { text: "Moryn syncs at agent finish." }, source: { client: "codex" } });
      await engine.consolidateSemanticProposals({ proposals: [{ proposal_id: "dashboard-duplicate", source_record_id: source.record.id, target_record_id: target.record.id, relationship: "duplicate_of", confidence: 0.99, rationale: "Equivalent finish behavior.", semantic_equivalence: "equivalent", material_differences: [], evidence_record_ids: [] }], project_id: "moryn", source: { client: "codex" } });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "dashboard-session", device_id: "device-test" }, occurred_at: "2026-07-12T00:05:00.000Z", delta: { session_id: "dashboard-session", checkpoint_id: "dashboard-rejected", current_task: "Polish dashboard", progress: ["Telemetry ready"], semantic_consolidation_proposals: [{ proposal_id: "dashboard-rejected", source_record_id: "rec-unbounded", target_record_id: target.record.id, relationship: "duplicate_of", confidence: 0.5, rationale: "Unbounded proposal.", semantic_equivalence: "equivalent", material_differences: [], evidence_record_ids: [] }] } });

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.quiet_dashboard.memory_flow).toMatchObject({ semantic_equivalent_links: 1, semantic_revision_links: 0, semantic_superseded_links: 0, semantic_conflict_links: 0, semantic_rejected_proposals: 1 });
      expect(data.quiet_dashboard.attention_needed).toEqual([]);
      const html = renderDashboardHtml(data);
      expect(quietFirstScreenHtml(html)).toContain("1 equivalent");
      expect(quietFirstScreenHtml(html)).not.toContain("Review semantic consolidation");
    });
  });

  it("monitors session synthesis quality without surfacing routine automation", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      for (const [mode, text] of [["host_authored", "Host summary"], ["evidence_synthesized", "Evidence summary"]] as const) {
        await engine.write({ kind: "session_summary", type: "summary", scope: "project", project_id: "moryn", content: { text, synthesis_mode: mode }, source: { client: "codex" } });
      }

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.quiet_dashboard.session_synthesis).toEqual({ host_authored: 1, evidence_synthesized: 1, minimal_fallback: 0 });
      expect(data.quiet_dashboard.attention_needed).toEqual([]);
    });
  });

  it("surfaces repeated minimal session fallbacks as exceptional attention", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      for (const text of ["Fallback one", "Fallback two"]) {
        await engine.write({ kind: "session_summary", type: "summary", scope: "project", project_id: "moryn", content: { text, synthesis_mode: "minimal_fallback" }, source: { client: "codex" } });
      }

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.quiet_dashboard.session_synthesis).toEqual({ host_authored: 0, evidence_synthesized: 0, minimal_fallback: 2 });
      expect(data.quiet_dashboard.attention_needed).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Session summaries lack durable evidence", severity: "warning" })]));
    });
  });

  it("raises attention only for current-task material semantic conflicts", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath, now: () => "2026-07-12T00:00:00.000Z" });
      const source = await engine.write({ kind: "memory", type: "decision", scope: "project", project_id: "moryn", content: { text: "Dashboard refresh must remain read-only." }, source: { client: "codex" } });
      const target = await engine.write({ kind: "memory", type: "decision", scope: "project", project_id: "moryn", content: { text: "Dashboard refresh may write maintenance events." }, source: { client: "codex" } });
      await engine.consolidateSemanticProposals({ proposals: [{ proposal_id: "dashboard-conflict", source_record_id: source.record.id, target_record_id: target.record.id, relationship: "conflicts_with", confidence: 0.99, rationale: "Material dashboard refresh conflict.", semantic_equivalence: "conflict", material_differences: [{ field: "write behavior", before: "must remain read-only", after: "may write", significance: "material" }], evidence_record_ids: [] }], project_id: "moryn", source: { client: "codex" } });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "dashboard-task", device_id: "device-test" }, occurred_at: "2026-07-12T00:05:00.000Z", delta: { session_id: "dashboard-task", checkpoint_id: "dashboard-task", current_task: "Keep dashboard refresh read-only", progress: ["Conflict detected"] } });

      const data = await buildDashboardData(storePath, { project_id: "moryn" });
      expect(data.quiet_dashboard.memory_flow.semantic_conflict_links).toBe(1);
      expect(data.quiet_dashboard.attention_needed).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Semantic memory conflict" })]));
    });
  });

  it("renders quiet monitoring sections and moves legacy detail panels below audit details", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.checkpoint({ project_id: "moryn", source: { client: "codex", session_id: "session-a", device_id: "device-a" }, occurred_at: "2026-07-11T00:00:00.000Z", delta: { session_id: "session-a", checkpoint_id: "checkpoint-a", current_task: "Polish dashboard", progress: ["Ready"] } });
      const html = renderDashboardHtml(await buildDashboardData(storePath, { project_id: "moryn" }));
      expect(html).toContain('data-quiet-dashboard="first-screen"');
      expect(html).toContain('class="quiet-dashboard-shell"');
      expect(html).toContain('data-quiet-section="system-pulse"');
      expect(html).toContain('class="quiet-pulse-band');
      expect(html).toContain('data-quiet-section="current-context"');
      expect(html).toContain('class="quiet-current-task"');
      expect(html).toContain('data-quiet-section="memory-flow"');
      expect(html).toContain('class="quiet-flow-strip"');
      expect(html).not.toContain('data-quiet-layout="context-flow"');
      const firstScreen = quietFirstScreenHtml(html);
      expect(firstScreen).toContain('data-quiet-flow-summary');
      expect(firstScreen).toContain('<details class="quiet-flow-details" data-dashboard-detail="quiet-flow-details">');
      expect(firstScreen).not.toContain('<details open class="quiet-flow-details"');
      expect(firstScreen).not.toContain('data-dashboard-confirm');
      expect(firstScreen).not.toContain('<button');
      const flowSummaryStart = firstScreen.indexOf('data-quiet-flow-summary');
      const flowDetailsStart = firstScreen.indexOf('data-dashboard-detail="quiet-flow-details"');
      expect(flowSummaryStart).toBeGreaterThan(-1);
      expect(flowDetailsStart).toBeGreaterThan(flowSummaryStart);
      expect(firstScreen.slice(flowSummaryStart, flowDetailsStart)).not.toContain('recent events');
      expect(firstScreen.slice(flowSummaryStart, flowDetailsStart)).not.toContain('equivalent');
      expect(html).not.toContain('data-quiet-section="knowledge-loop"');
      expect(html).not.toContain('data-quiet-section="attention-needed"');
      expect(html).toContain(".quiet-dashboard-shell {");
      expect(html).toContain(".quiet-current-task {");
      expect(html).toContain(".quiet-flow-strip {");
      expect(html).not.toContain('data-dashboard-command-flow');
    });
  });

  it("renders Attention Needed only for exceptional review work", async () => {
    await withTempStore(async (storePath) => {
      await initializeStore(storePath, { device_id: "device-test" });
      const engine = createEngine({ storePath });
      await engine.write({ kind: "session_summary", type: "summary", scope: "project", project_id: "moryn", tags: ["autocapture", "review", "host:codex"], content: { text: "User preference requires review" }, state: "candidate", source: { client: "codex" } });
      const html = renderDashboardHtml(await buildDashboardData(storePath, { project_id: "moryn" }));
      expect(html).toContain('data-quiet-section="attention-needed"');
      expect(html).toContain("User preference requires review");
    });
  });
});
