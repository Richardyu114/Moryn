import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { initializeStore } from "../../src/core/config.js";
import { readEvents } from "../../src/core/store.js";
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

function dashboardDetailBlock(html: string, detail: string): string {
  const marker = `data-dashboard-detail="${detail}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rowStart = html.lastIndexOf("<div class=\"reference-library-index-row\"", start);
  if (rowStart >= 0) {
    const rowEnd = html.indexOf("</div>", html.indexOf("</small>", start));
    expect(rowEnd).toBeGreaterThan(start);
    return html.slice(rowStart, rowEnd + "</div>".length);
  }
  const articleStart = html.lastIndexOf("<article", start);
  const detailsStart = html.lastIndexOf("<details", start);
  const blockStart = articleStart > detailsStart ? articleStart : (detailsStart >= 0 ? detailsStart : start);
  const articleEnd = html.indexOf("</article>", start);
  if (articleStart > detailsStart && articleEnd >= 0) return html.slice(blockStart, articleEnd + "</article>".length);
  const detailsEnd = html.indexOf("</details>", start);
  expect(detailsEnd).toBeGreaterThan(start);
  return html.slice(start, detailsEnd + "</details>".length);
}

function referenceLibraryIndexHtml(html: string): string {
  return dashboardDetailBlock(html, "reference-library:index");
}

function referenceLibraryIndexWrapHtml(html: string): string {
  const marker = "<div class=\"reference-library-index-wrap\">";
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</div>", html.indexOf("</article>", start));
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end + "</div>".length);
}

function dashboardArticleBlockByMarker(html: string, marker: string): string {
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const articleStart = html.lastIndexOf("<article", start);
  expect(articleStart).toBeGreaterThan(-1);
  const articleEnd = html.indexOf("</article>", start);
  expect(articleEnd).toBeGreaterThan(start);
  return html.slice(articleStart, articleEnd);
}

function memoryExplorerDetailHtml(html: string): string {
  const marker = "<aside class=\"memory-explorer-detail\" data-memory-explorer-detail aria-live=\"polite\">";
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</aside>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end + "</aside>".length);
}

function supportingEvidenceSummaryRowHtml(html: string, row: "audit-reports" | "store-snapshot" | "raw-store"): string {
  const marker = `data-supporting-evidence-summary="${row}"`;
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const rowStart = html.lastIndexOf("<div class=\"reference-library-index-row\"", start);
  expect(rowStart).toBeGreaterThan(-1);
  const nextRow = html.indexOf("<div class=\"reference-library-index-row\"", start + 1);
  const articleEnd = html.indexOf("</article>", start);
  const rowEnd = nextRow > start && nextRow < articleEnd ? nextRow : articleEnd;
  expect(rowEnd).toBeGreaterThan(rowStart);
  return html.slice(rowStart, rowEnd);
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
      expect(html).toContain("<section id=\"needs-attention\" class=\"needs-attention-quiet-line\" data-dashboard-section=\"needs-attention\" data-dashboard-detail=\"needs-attention\">");
      expect(html).toContain("<span data-i18n-en=\"Background checks\" data-i18n-zh=\"后台检查\">Background checks</span>");
      expect(html).toContain("<small data-i18n-en=\"Routine checks\" data-i18n-zh=\"日常检查\">Routine checks</small>");
      expect(html).toContain("<details class=\"attention-info-group\" data-dashboard-detail=\"attention-info-checks\">");
      expect(html).toContain("<details class=\"attention-info-details\" data-dashboard-detail=\"attention-info-details\">");
      expect(html).toContain("<span data-i18n-en=\"Check details\" data-i18n-zh=\"检查详情\">Check details</span>");
      expect(html).toContain("<small data-i18n-en=\"1 routine check\" data-i18n-zh=\"1 项日常检查\">1 routine check</small>");
      const quietInfoStart = html.indexOf("data-dashboard-detail=\"attention-info-checks\"");
      const quietInfoDetailsStart = html.indexOf("data-dashboard-detail=\"attention-info-details\"", quietInfoStart);
      const quietInfoSummaryHtml = html.slice(quietInfoStart, quietInfoDetailsStart);
      expect(quietInfoSummaryHtml).not.toContain("data-dashboard-detail=\"attention:Sync is not configured\"");
      expect(quietInfoSummaryHtml).not.toContain("<strong>Sync is not configured</strong>");
      expect(html).not.toContain("needs-attention-quiet-summary");
      expect(html).not.toContain("<small>No action needed | 1 info check</small>");
      expect(html).not.toContain("<div class=\"attention-focus\" aria-label=\"Action Signals focus\">");
      expect(html).not.toContain("<span>Needs Attention</span>");
      expect(html).not.toContain("<small>0 action signals | 1 info item | collapsed by default</small>");
      expect(html).not.toContain("<small>1 info item</small>");
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
      expect(html).toContain("<span data-i18n-en=\"Background checks\" data-i18n-zh=\"后台检查\">Background checks</span>");
      expect(html).toContain("<small data-i18n-en=\"Routine checks\" data-i18n-zh=\"日常检查\">Routine checks</small>");
      expect(html).toContain("<strong data-i18n-en=\"Paused content has a safe replacement\" data-i18n-zh=\"暂停内容已有安全替代\">Paused content has a safe replacement</strong>");
      expect(html).toContain("<p data-i18n-en=\"1 paused item(s) already have a safe replacement.\" data-i18n-zh=\"1 条暂停内容已有安全替代版本。\">1 paused item(s) already have a safe replacement.</p>");
      expect(html).not.toContain("<strong data-i18n-en=\"Quarantined records superseded\"");
      expect(html).not.toContain("quarantined record(s)");
      expect(html).toContain("<strong data-i18n-en=\"Session notes not remembered\" data-i18n-zh=\"会话笔记未记住\">Session notes not remembered</strong>");
      expect(html).toContain("<p data-i18n-en=\"1 session note(s) are searchable for context but not treated as long-term memory.\" data-i18n-zh=\"1 条会话笔记可作为上下文搜索，但不会被当作长期记忆。\">1 session note(s) are searchable for context but not treated as long-term memory.</p>");
      expect(html).toContain("<strong data-i18n-en=\"Many items to organize\" data-i18n-zh=\"较多内容待整理\">Many items to organize</strong>");
      expect(html).toContain("<p data-i18n-en=\"10 item(s) are saved and searchable. They stay searchable unless you choose to make them long-term memory.\" data-i18n-zh=\"10 条内容已保存并可搜索；除非你决定整理为长期记忆，否则会保持可搜索。\">10 item(s) are saved and searchable. They stay searchable unless you choose to make them long-term memory.</p>");
      expect(html).toContain("<span data-i18n-en=\"Info\" data-i18n-zh=\"信息\">Info</span>");
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
      expect(html).toContain("<span class=\"health-badge warning\" data-i18n-en=\"Sync Pending\" data-i18n-zh=\"等待同步\">Sync Pending</span>");
      expect(html).not.toContain("<p class=\"dashboard-status-line warning\" data-dashboard-status=\"sync_pending\">");
      expect(html).not.toContain("<section class=\"status-strip warning\" data-dashboard-status=\"sync_pending\">");
      expect(html).not.toContain("Local sync changes are waiting to be pushed or pulled");
      expect(data.dashboard_overview.cards_by_id.health.summary).toContain("Local sync changes are waiting to be pushed or pulled");
      expect(html).not.toContain("<strong>Review sync changes</strong>");
      expect(html).toContain("<strong data-i18n-en=\"Inspect sync\" data-i18n-zh=\"检查共享副本\">Inspect sync</strong>");
      expect(html).toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"store-signals\" aria-controls=\"store-signals\" data-i18n-en=\"Inspect sync\" data-i18n-zh=\"检查共享副本\">Inspect sync</button>");
      expect(html).not.toContain("<div class=\"dashboard-overview-grid\">");
      expect(html).not.toContain("data-dashboard-overview-card=\"action\"");
      expect(html).not.toContain("data-dashboard-overview-card=\"health\"");
      expect(html).not.toContain("data-dashboard-overview-card=\"sync\"");
      expect(html).not.toContain("<details class=\"dashboard-overview-quiet\" data-dashboard-detail=\"dashboard-overview-quiet-cards\">");
      expect(html).not.toContain("<span>Background Status</span>");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary dashboard-overview-quiet-fold\" aria-label=\"Background Status: Healthy signals kept for context\">");
      expect(html).not.toContain("<small>Signals ready</small>");
      expect(html).not.toContain("<small>Healthy signals kept for context</small>");
      expect(html).not.toContain("<small>4 reference cards</small>");
      expect(html).not.toContain("<span>Reference Cards</span>");
      expect(html).not.toContain("<span>Quiet Overview</span>");
      expect(html).not.toContain("<small>4 quiet cards</small>");
      expect(html).not.toContain("data-dashboard-overview-quiet-card=\"health\"");
      expect(html).not.toContain("data-dashboard-overview-quiet-card=\"action\"");
      expect(html).not.toContain("data-dashboard-overview-quiet-card=\"context\"");
      expect(html).not.toContain("data-dashboard-overview-quiet-card=\"sync\"");
      expect(data.dashboard_overview.cards.map((card) => card.id)).toEqual(["health", "action", "context", "sync"]);
      expect(html).not.toContain("<section class=\"dashboard-work-lanes\" data-dashboard-work-lanes aria-label=\"Dashboard Work Lanes\">");
      expect(html).not.toContain("data-dashboard-work-lane=\"health\"");
      expect(html).not.toContain("<span>Health</span>\n          <strong>Sync Pending</strong>");
      expect(html).not.toContain("<small>Review sync changes</small>\n      <em class=\"action-board-next\">Review sync changes</em>");
      expect(html).not.toContain("<em class=\"action-board-next\">Review sync changes</em>");
      expect(html).not.toContain("<span class=\"attention-next-action\" data-attention-next-action>Push sync</span>");
      expect(html).not.toContain("<details class=\"action-board action-board-secondary\" aria-label=\"Page Shortcuts\" data-dashboard-detail=\"action-board\" data-action-board-nav>");
      expect(html).not.toContain("<span>Page Shortcuts</span>");
      expect(html).not.toContain("<small>Optional section links</small>");
      expect(html).not.toContain("<span class=\"action-board-activity\">1 sync issue</span>");
      expect(html).not.toContain("action-board-activity");
      expect(html).not.toContain("<span>Navigation Details</span>");
      expect(html).not.toContain("<small>1 review / 1 sync</small>");
      expect(html).not.toContain("data-action-board-item=\"review\"");
      expect(html).not.toContain("data-action-board-item=\"sync\"");
      expect(html).not.toContain("data-action-board-nav");
      expect(html).not.toContain("<details class=\"action-board-quiet\" data-dashboard-detail=\"action-board-quiet-targets\">");
      expect(html).not.toContain("<span>Quiet Shortcuts</span>");
      expect(html).not.toContain("data-dashboard-detail=\"dashboard-work-lanes-background\"");
      expect(html).not.toContain("<span>Background Lanes</span>");
      expect(html).not.toContain("<small>Quiet lanes ready</small>");
      expect(html).not.toContain("data-action-board-quiet-item=\"confirm\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"review\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"inspect\"");
      expect(html).not.toContain("<em class=\"action-board-next\">Open checks</em>");
      expect(html).not.toContain("<details class=\"attention warning\" data-dashboard-detail=\"attention:Sync changes not pushed\">");
      expect(html).not.toContain("Local event history has changes that are not committed or pushed yet.");
      expect(html).not.toContain("<section id=\"needs-attention\" class=\"needs-attention-quiet-line\" data-dashboard-section=\"needs-attention\" data-dashboard-detail=\"needs-attention\">");
      expect(html).not.toContain("data-dashboard-detail=\"attention-info-checks\"");
      expect(html).not.toContain("<span>Background checks</span>");
      expect(html).not.toContain("data-dashboard-detail=\"attention-info-details\"");
      expect(data.attention_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          title: "Sync changes not pushed"
        })
      ]));
      expect(html).toContain("<section class=\"sync-action-brief warning\" data-dashboard-sync-action>");
      expect(html).toContain("<h3>Sync Action</h3>");
      expect(html).toContain("<strong>Push sync</strong>");
      expect(html).toContain("<code>moryn sync --push</code>");
      expect(html).toContain("<span>Remote configured</span>");
      expect(html).toContain("<span>Branch main</span>");
      expect(html).toContain("<span>0 behind</span>");
      expect(html).toContain("<span>0 ahead</span>");
      expect(html).toContain("<section class=\"signal-card sync-position-focus\" data-dashboard-sync-position-focus>");
      expect(data.charts.agent_activity.length).toBeGreaterThan(0);
      expect(data.charts.memory_states.length).toBeGreaterThan(0);
      expect(data.charts.record_types.length).toBeGreaterThan(0);
      const workLanesStart = html.indexOf("data-dashboard-work-lanes");
      const evidenceLibraryStart = html.indexOf("<details class=\"evidence-library evidence-library-compact\" data-dashboard-detail=\"evidence-library\" data-dashboard-background-reference aria-label=\"More details\">");
      expect(html).toContain("<section id=\"store-signals\" class=\"panel store-signals store-signals-promoted\" data-dashboard-detail=\"store-signals\" data-dashboard-promoted-store-signals aria-label=\"Shared copy details\">");
      expect(html).toContain("<div class=\"store-signals-promoted-head\">\n        <span data-i18n-en=\"Shared copy details\" data-i18n-zh=\"共享副本详情\">Shared copy details</span>\n        <small data-i18n-en=\"Sync action ready\" data-i18n-zh=\"同步操作已就绪\">Sync action ready</small>\n      </div>");
      expect(html).not.toContain("<details open id=\"store-signals\" class=\"panel store-signals\" data-dashboard-detail=\"store-signals\">");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary\">\n        <span>Store Signals</span>\n        <small>Sync action ready</small>\n      </summary>");
      expect(html).not.toContain("<span>Store Signals</span>\n        <small>Operational health signals</small>");
      expect(html).not.toContain("<details open class=\"store-telemetry-context\" data-dashboard-detail=\"store-telemetry-context\">");
      const storeSignalsStart = html.indexOf("<section id=\"store-signals\" class=\"panel store-signals store-signals-promoted\" data-dashboard-detail=\"store-signals\" data-dashboard-promoted-store-signals aria-label=\"Shared copy details\"");
      const overviewStart = html.indexOf("data-dashboard-overview");
      expect(workLanesStart).toBe(-1);
      expect(overviewStart).toBeGreaterThan(-1);
      expect(evidenceLibraryStart).toBeGreaterThan(-1);
      expect(storeSignalsStart).toBeGreaterThan(overviewStart);
      expect(storeSignalsStart).toBeLessThan(evidenceLibraryStart);
      expect(html).toContain("<details class=\"evidence-library evidence-library-compact\" data-dashboard-detail=\"evidence-library\" data-dashboard-background-reference aria-label=\"More details\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary evidence-library-fold evidence-library-compact-fold\" aria-label=\"More details: Extra context\">");
      expect(html).toContain("<span data-i18n-en=\"More details\" data-i18n-zh=\"更多细节\">More details</span>");
      expect(html).toContain("<small data-i18n-en=\"Extra context\" data-i18n-zh=\"补充信息\">Extra context</small>");
      expect(html).not.toContain("<small>Audit route available</small>");
      expect(html).not.toContain("<details class=\"panel evidence-library\" data-dashboard-detail=\"evidence-library\" aria-label=\"Reference Library\">");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary evidence-library-fold\" aria-label=\"Reference Library: Reference evidence only\">");
      const referenceIndexWrapHtml = referenceLibraryIndexWrapHtml(html);
      const referenceIndexHtml = referenceLibraryIndexHtml(html);
      const referenceRoutesStart = referenceIndexHtml.indexOf("<details class=\"reference-library-routes\" data-dashboard-detail=\"reference-library:routes\">");
      expect(referenceRoutesStart).toBeGreaterThan(-1);
      const referenceIndexFaceHtml = referenceIndexHtml.slice(0, referenceRoutesStart);
      const referenceRoutesHtml = referenceIndexHtml.slice(referenceRoutesStart);
      expect(referenceIndexFaceHtml).toContain("<strong data-i18n-en=\"Inspect saved content\" data-i18n-zh=\"查看保存内容\">Inspect saved content</strong>");
      expect(referenceIndexFaceHtml).not.toContain("<strong>Audit Index</strong>");
      expect(referenceIndexFaceHtml).toContain("<span data-i18n-en=\"Read-only, no memory changes\" data-i18n-zh=\"只查看，不改记忆\">Read-only, no memory changes</span>");
      expect(referenceIndexFaceHtml).toContain("<small data-i18n-en=\"Helpful context\" data-i18n-zh=\"补充上下文\">Helpful context</small>");
      expect(referenceIndexFaceHtml).not.toContain("<strong>Reference Library Index</strong>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Open related views\" data-i18n-zh=\"打开相关内容\">Open related views</span>");
      expect(referenceRoutesHtml).toContain("<small data-i18n-en=\"Sources and status\" data-i18n-zh=\"来源和状态\">Sources and status</small>");
      expect(referenceRoutesHtml).not.toContain("<span>Audit details</span>");
      expect(referenceRoutesHtml).not.toContain("<small>Routes and raw evidence</small>");
      expect(referenceIndexFaceHtml).not.toContain("Saved details");
      expect(referenceIndexFaceHtml).not.toContain("Read-only details available");
      expect(referenceRoutesHtml).not.toContain("Detail links");
      expect(referenceRoutesHtml).not.toContain("Routes and checks");
      expect(referenceIndexFaceHtml).not.toContain("data-reference-library-route=");
      expect(referenceIndexWrapHtml.slice(0, referenceRoutesStart)).not.toContain("Open <code>/api/dashboard</code>");
      expect(referenceRoutesHtml).toContain("Raw technical details stay in <code>/api/dashboard</code>.");
      expect(referenceRoutesHtml).not.toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"routine-diagnostics\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"routine-diagnostics\" data-i18n-en=\"Store status\" data-i18n-zh=\"存储状态\">Store status</code>");
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"supporting-evidence\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"supporting-evidence\" data-i18n-en=\"History\" data-i18n-zh=\"历史记录\">History</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-reference-library-route=\"routine-diagnostics\">diagnostics</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-reference-library-route=\"supporting-evidence\">audit_trail</code>");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Store Status\" data-i18n-zh=\"存储状态\">Store Status</strong>");
      expect(referenceRoutesHtml).not.toContain("<strong>Diagnostics Index</strong>");
      expect(referenceRoutesHtml).toContain("<code data-dashboard-detail=\"health-check\" aria-label=\"Health Check: Healthy local store. Full report is available in /api/dashboard.health_check.\" data-i18n-en=\"Store check\" data-i18n-zh=\"存储检查\">Store check</code>");
      expect(referenceRoutesHtml).toContain("<code data-dashboard-detail=\"recall-eval\" aria-label=\"Recall Eval: No recall eval cases yet. Full report is available in /api/dashboard.recall_eval.\" data-i18n-en=\"Search check\" data-i18n-zh=\"搜索检查\">Search check</code>");
      expect(referenceRoutesHtml).not.toContain(">health_check</code>");
      expect(referenceRoutesHtml).not.toContain(">recall_eval</code>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Status sources ready\" data-i18n-zh=\"状态来源已就绪\">Status sources ready</span>");
      expect(referenceRoutesHtml).not.toContain("<span>Health Check, Recall Eval, Context Pack Review indexed</span>");
      expect(html.match(/<section id="store-signals" class="panel store-signals store-signals-promoted" data-dashboard-detail="store-signals" data-dashboard-promoted-store-signals aria-label="Shared copy details"/g)?.length).toBe(1);
      const storeSignalsEnd = evidenceLibraryStart;
      const storeSignalsHtml = html.slice(storeSignalsStart, storeSignalsEnd);
      expect(storeSignalsHtml).toContain("<details class=\"store-sync-details\" data-dashboard-detail=\"store-sync-details\">");
      expect(storeSignalsHtml).toContain("<span>Sync details</span>");
      expect(storeSignalsHtml).toContain("<small>Position rail</small>");
      expect(storeSignalsHtml).not.toContain("<details open class=\"store-sync-details\" data-dashboard-detail=\"store-sync-details\">");
      const syncDetailsStart = storeSignalsHtml.indexOf("data-dashboard-detail=\"store-sync-details\"");
      expect(syncDetailsStart).toBeGreaterThan(-1);
      const focusHtml = storeSignalsHtml.slice(0, syncDetailsStart);
      const syncDetailsHtml = storeSignalsHtml.slice(syncDetailsStart);
      expect(focusHtml).not.toContain("<h2>Sync Position</h2>");
      expect(syncDetailsHtml).toContain("<h2>Sync Position</h2>");
      expect(storeSignalsHtml).not.toContain("data-dashboard-detail=\"store-telemetry-context\"");
      expect(storeSignalsHtml).not.toContain("<span>Telemetry Context</span>");
      expect(storeSignalsHtml).not.toContain("<h2>Agent Activity</h2>");
      expect(storeSignalsHtml).not.toContain("<h2>Record Quality</h2>");
      expect(storeSignalsHtml).not.toContain("<h2>Record Types</h2>");
      expect(html).toContain("<div class=\"rail-labels\"><span>Remote</span><strong>Local Changes</strong><span>Local</span></div>");
      expect(html).not.toContain("data-dashboard-detail=\"attention:Local store has uncommitted sync state\"");
      expect(html).not.toContain("<div class=\"rail-labels\"><span>Remote</span><strong>Dirty</strong><span>Local</span></div>");
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
      expect(html).not.toContain("<p class=\"dashboard-status-line good\" data-dashboard-status=\"healthy\">");
      expect(html).not.toContain("Sync is clean and no urgent safety items were detected in this snapshot.");
      expect(html).toContain("<span class=\"language-toggle-label\" data-i18n-en=\"Language\" data-i18n-zh=\"语言\">Language</span>");
      expect(html).toContain("<button type=\"button\" class=\"language-option active\" data-dashboard-language-option=\"en\" aria-pressed=\"true\">EN</button>");
      expect(html).toContain("<button type=\"button\" class=\"language-option\" data-dashboard-language-option=\"zh\" aria-pressed=\"false\">中文</button>");
      expect(html).toContain("const key = \"moryn.dashboard.language\";");
      expect(html).toContain("const staticTranslations = new Map(");
      expect(html).toContain("[\"Background checks\", \"后台检查\"]");
      expect(html).toContain("[\"Check details\", \"检查详情\"]");
      expect(html).toContain("[\"Routine checks\", \"日常检查\"]");
      expect(html).toContain("[\"Info Checks\", \"后台检查\"]");
      expect(html).toContain("[\"Info Details\", \"检查详情\"]");
      expect(html).toContain("[\"Routine status checks\", \"日常检查\"]");
      expect(html).toContain("[\"Check records\", \"检查记录\"]");
      expect(html).toContain("[\"Read-only details available\", \"可查看只读详情\"]");
      expect(html).toContain("[\"Optional details\", \"可选详情\"]");
      expect(html).toContain("[\"Detail links\", \"详情入口\"]");
      expect(html).toContain("[\"Routes and checks\", \"路线和检查\"]");
      expect(html).toContain("[\"Health checks\", \"健康检查\"]");
      expect(html).toContain("[\"Session notes not remembered\", \"会话笔记未记住\"]");
      expect(html).toContain("[\"Many items to organize\", \"较多内容待整理\"]");
      expect(html).not.toContain("[\"Raw records waiting for review\", \"临时内容待整理\"]");
      expect(html).not.toContain("[\"Many candidate records\", \"较多已保存内容待整理\"]");
      expect(html).toContain("[\"Sync details\", \"同步详情\"]");
      expect(html).toContain("[\"Position rail\", \"位置状态\"]");
      expect(html).toContain("[\"Sync Position\", \"同步位置\"]");
      expect(html).toContain("[\"Sync Action\", \"同步操作\"]");
      expect(html).toContain("[\"Push sync\", \"上传同步\"]");
      expect(html).toContain("[\"Remote configured\", \"远端已连接\"]");
      expect(html).toContain("const branchMatch = text.match(/^Branch (.+)$/);");
      expect(html).toContain("const behindMatch = text.match(/^(\\d+) behind$/);");
      expect(html).toContain("const aheadMatch = text.match(/^(\\d+) ahead$/);");
      expect(html).toContain("[data-dashboard-sync-action], [data-dashboard-detail='store-sync-details']");
      expect(html).toContain("<strong data-i18n-en=\"Inspect saved content\" data-i18n-zh=\"查看保存内容\">Inspect saved content</strong>");
      expect(html).toContain("<span data-i18n-en=\"Read-only, no memory changes\" data-i18n-zh=\"只查看，不改记忆\">Read-only, no memory changes</span>");
      expect(html).toContain("<small data-i18n-en=\"Helpful context\" data-i18n-zh=\"补充上下文\">Helpful context</small>");
      expect(html).toContain("<span data-i18n-en=\"Open related views\" data-i18n-zh=\"打开相关内容\">Open related views</span>");
      expect(html).toContain("<small data-i18n-en=\"Sources and status\" data-i18n-zh=\"来源和状态\">Sources and status</small>");
      expect(html).not.toContain("<strong data-i18n-en=\"Saved details\" data-i18n-zh=\"保存细节\">Saved details</strong>");
      expect(html).not.toContain("<span data-i18n-en=\"Read-only details available\" data-i18n-zh=\"可查看只读详情\">Read-only details available</span>");
      expect(html).not.toContain("<span data-i18n-en=\"Detail links\" data-i18n-zh=\"详情入口\">Detail links</span>");
      expect(html).toContain("translateStaticText(original)");
      expect(html).toContain("translateLegacyText(document.body, language);");
      expect(html).toContain("localStorage.getItem(key)");
      expect(html).toContain("color-scheme: dark;");
      expect(html).toContain("--canvas: #050505;");
      expect(html).toContain("--surface: #101216;");
      expect(html).toContain("--panel-glow: 0 0 0 1px rgba(116, 242, 145, 0.08), 0 24px 70px rgba(0, 0, 0, 0.46);");
      expect(html).toContain("--elevation-card: 0 18px 48px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.045);");
      expect(html).toContain("--surface-glass: rgba(13, 16, 21, 0.82);");
      expect(html).toContain("--surface-hover:");
      expect(html).toContain("--panel-highlight:");
      expect(html).toContain("--ring-soft:");
      expect(html).toContain("--elevation-hover:");
      expect(html).not.toContain("--canvas: #f4f2ee;");
      expect(html).toContain("<strong data-i18n-en=\"No action needed\" data-i18n-zh=\"无需操作\">No action needed</strong>");
      expect(html).not.toContain("data-dashboard-overview");
      expect(html).not.toContain("aria-label=\"Dashboard Overview\"");
      expect(html).not.toContain("<span data-i18n-en=\"Other status\" data-i18n-zh=\"其他状态\">Other status</span>");
      expect(html).not.toContain("<p data-i18n-en=\"1 saved item and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.\" data-i18n-zh=\"1 条保存内容和 1 条会话笔记现在可搜索；需要时再整理，这个摘要不会写入记忆。\">1 saved item and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.</p>");
      expect(html).not.toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-i18n-en=\"Search saved content\" data-i18n-zh=\"搜索已保存内容\">Search saved content</button>");
      expect(html).not.toContain("<p data-i18n-en=\"2 saved items\" data-i18n-zh=\"2 条已保存内容\">2 saved items</p>");
      expect(html).not.toContain("<p data-i18n-en=\"Clean\" data-i18n-zh=\"已同步\">Clean</p>");
      expect(html).not.toContain("data-i18n-zh=\"2 saved items\"");
      expect(html).not.toContain("data-i18n-zh=\"Clean\"");
      expect(html).not.toContain("<strong>All clear</strong>");
      expect(html).not.toContain("<p>No work needs attention.</p>");
      expect(html).toContain("<span class=\"health-badge good\" data-i18n-en=\"Healthy\" data-i18n-zh=\"正常\">Healthy</span>");
      expect(html).toContain(`<p class="store-path" title="${storePath}" data-i18n-en="Local memory" data-i18n-zh="本机记忆">Local memory</p>`);
      expect(html).toContain("<p class=\"dashboard-generated-at\"><time datetime=\"2026-06-21T00:00:00.000Z\" title=\"2026-06-21T00:00:00.000Z\">Updated 00:00 UTC</time></p>");
      expect(html).toContain("<section class=\"status-board\" data-status-board aria-label=\"Right now\">");
      expect(html).toContain("<h2 data-i18n-en=\"Right now\" data-i18n-zh=\"现在情况\">Right now</h2>");
      expect(html).toContain("<small data-i18n-en=\"Action, saved content, and shared copy\" data-i18n-zh=\"要不要操作、存了什么、共享副本是否同步\">Action, saved content, and shared copy</small>");
      expect(html).not.toContain("<h2 data-i18n-en=\"Current answers\" data-i18n-zh=\"当前结论\">Current answers</h2>");
      expect(html).not.toContain("<small data-i18n-en=\"Act, memory, and shared copy\" data-i18n-zh=\"操作、记忆和共享副本\">Act, memory, and shared copy</small>");
      expect(html).not.toContain("<h2 data-i18n-en=\"Status Board\" data-i18n-zh=\"状态总览\">Status Board</h2>");
      expect(html).toContain("<div class=\"status-board-rail\" data-status-board-rail aria-label=\"Local and shared status\">");
      expect(html).not.toContain("<section class=\"front-status-grid\" data-front-status-grid aria-label=\"Local and shared status\">");
      expect(html).toContain("<article class=\"status-chip good\" data-status-chip=\"device\">");
      expect(html).toContain("<span data-i18n-en=\"This device\" data-i18n-zh=\"本机记忆\">This device</span>");
      expect(html).toContain("<strong data-i18n-en=\"Healthy\" data-i18n-zh=\"正常\">Healthy</strong>");
      expect(html).toContain("<article class=\"status-chip good\" data-status-chip=\"shared-copy\">");
      expect(html).toContain("<span data-i18n-en=\"Shared copy\" data-i18n-zh=\"共享副本\">Shared copy</span>");
      expect(html).toContain("<strong data-i18n-en=\"Up to date\" data-i18n-zh=\"已同步\">Up to date</strong>");
      expect(html).toContain("<small data-i18n-en=\"0 behind · 0 ahead\" data-i18n-zh=\"落后 0 · 待上传 0\">0 behind · 0 ahead</small>");
      expect(html).toContain("<div class=\"status-board-answers\" data-status-board-answers>");
      expect(html).not.toContain("<section class=\"dashboard-priority-strip\" data-dashboard-priority-strip aria-label=\"Dashboard priorities\">");
      expect(html).toContain("<button type=\"button\" class=\"answer-card action calm\" data-dashboard-priority=\"action\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-memory-explorer-stored-filter=\"candidate,raw,archived,quarantined\" data-memory-explorer-state-filter=\"candidate,raw,archived,quarantined\" data-memory-explorer-focus-search=\"true\">");
      expect(html).toContain("<span data-i18n-en=\"Do I need to act?\" data-i18n-zh=\"我需要操作吗？\">Do I need to act?</span>");
      expect(html).toContain("<p class=\"answer-card-conclusion\" data-i18n-en=\"Saved items are searchable; no confirmation is waiting.\" data-i18n-zh=\"内容已保存可搜索；没有等待确认的操作。\">Saved items are searchable; no confirmation is waiting.</p>");
      expect(html).toContain("<button type=\"button\" class=\"answer-card memory\" data-dashboard-priority=\"memory\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-memory-explorer-stored-filter=\"all\" data-memory-explorer-state-filter=\"all\" data-memory-explorer-focus-search=\"true\">");
      expect(html).toContain("<span data-i18n-en=\"What is stored?\" data-i18n-zh=\"存了什么？\">What is stored?</span>");
      expect(html).toContain("<p class=\"answer-card-conclusion\" data-i18n-en=\"1 ready to use · 2 searchable\" data-i18n-zh=\"1 条可直接使用 · 2 条可搜索\">1 ready to use · 2 searchable</p>");
      expect(html).toContain("<div class=\"answer-memory-mix\" data-answer-memory-mix aria-label=\"Stored content mix\">");
      expect(html).toContain("<span class=\"answer-memory-segment memory-state-remembered\" style=\"width: 33%\" title=\"Ready to use 1\"></span>");
      expect(html).toContain("<span class=\"answer-memory-segment memory-state-to-organize\" style=\"width: 33%\" title=\"Saved for later 1\"></span>");
      expect(html).toContain("<span class=\"answer-memory-segment memory-state-temporary\" style=\"width: 33%\" title=\"Saved briefly 1\"></span>");
      expect(html).toContain("<div class=\"answer-memory-counts\" data-answer-memory-counts>");
      expect(html).toContain("<span data-i18n-en=\"1 ready to use\" data-i18n-zh=\"1 条可直接使用\">1 ready to use</span>");
      expect(html).toContain("<span data-i18n-en=\"1 saved for later\" data-i18n-zh=\"1 条已保存，稍后整理\">1 saved for later</span>");
      expect(html).toContain("<span data-i18n-en=\"1 saved briefly\" data-i18n-zh=\"1 条临时保存\">1 saved briefly</span>");
      expect(html).toContain("<button type=\"button\" class=\"answer-card recent\" data-dashboard-priority=\"recent\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-memory-explorer-stored-filter=\"all\" data-memory-explorer-state-filter=\"all\" data-memory-explorer-selected-id=\"rec_action_board_3\">");
      expect(html).toContain("<span data-i18n-en=\"What changed recently?\" data-i18n-zh=\"最近有什么变化？\">What changed recently?</span>");
      expect(html).toContain("<strong><time datetime=\"2026-06-01T00:03:00.000Z\" title=\"2026-06-01T00:03:00.000Z\" data-i18n-en=\"19d ago\" data-i18n-zh=\"19 天前\">19d ago</time></strong>");
      expect(html).toContain("<p class=\"answer-card-conclusion\" data-i18n-en=\"Latest saved content came from Gemini.\" data-i18n-zh=\"最近保存内容来自 Gemini。\">Latest saved content came from Gemini.</p>");
      expect(html).toContain("<small data-i18n-en=\"Latest saved content\" data-i18n-zh=\"最近保存的内容\">Latest saved content</small>");
      expect(html).toContain("<button type=\"button\" class=\"answer-card sync good\" data-dashboard-priority=\"sync\" data-action-board-target=\"store-signals\" aria-controls=\"store-signals\">");
      expect(html).toContain("<span data-i18n-en=\"Is everything synced?\" data-i18n-zh=\"都同步了吗？\">Is everything synced?</span>");
      expect(html).toContain("<p class=\"answer-card-conclusion\" data-i18n-en=\"Shared copy is current on this device.\" data-i18n-zh=\"这台设备上的共享副本是最新的。\">Shared copy is current on this device.</p>");
      expect(html).not.toContain("<div class=\"status-board-ticker\" data-status-board-ticker aria-label=\"Latest status ticker\">");
      expect(html).toContain("<div class=\"status-board-explain\" data-status-board-explain>");
      expect(html).toContain("<span data-i18n-en=\"Write safety\" data-i18n-zh=\"写入边界\">Write safety</span>");
      expect(html).toContain("<p data-i18n-en=\"Only confirmation buttons can change long-term memory.\" data-i18n-zh=\"只有确认按钮会改变长期记忆。\">Only confirmation buttons can change long-term memory.</p>");
      expect(html).not.toContain("<span data-i18n-en=\"Why this is here\" data-i18n-zh=\"为什么会看到这些内容\">Why this is here</span>");
      expect(html).not.toContain("They stay searchable here; only rows with confirm buttons can change long-term memory.");
      expect(html).toContain("grid-template-rows: minmax(1.35em, auto) minmax(2.35em, auto) minmax(2.4em, auto) minmax(1.4em, auto) minmax(40px, auto);");
      expect(html).toContain("grid-template-columns: repeat(4, minmax(0, 1fr));");
      expect(html).toContain(".answer-card-conclusion {");
      expect(html).toContain(".status-chip,");
      expect(html).toContain("min-height: 76px;");
      expect(html).toContain(".answer-card.recent { border-left-color: var(--signal-amber); }");
      expect(html).toContain("white-space: nowrap;");
      expect(html).toContain("text-overflow: ellipsis;");
      expect(html).toContain("box-shadow: var(--panel-glow);");
      expect(html).toContain("background: var(--surface-glass);");
      expect(html).toContain("<section class=\"dashboard-command-flow\" data-dashboard-command-flow aria-label=\"Moryn control flow\">");
      expect(html).toContain("<div class=\"dashboard-command-flow-head\" data-dashboard-command-flow-head>");
      expect(html).toContain("<span data-i18n-en=\"Control flow\" data-i18n-zh=\"控制流\">Control flow</span>");
      expect(html).toContain("<strong data-i18n-en=\"Act, inspect, then search\" data-i18n-zh=\"先看是否要操作，再查看和搜索\">Act, inspect, then search</strong>");
      expect(html).toContain("<small data-i18n-en=\"No write happens in this flow unless a real confirm button appears.\" data-i18n-zh=\"这里不会写入；只有真正的确认按钮才会改变记忆。\">No write happens in this flow unless a real confirm button appears.</small>");
      const commandFlowStart = html.indexOf("data-dashboard-command-flow");
      const statusBoardStart = html.indexOf("data-status-board");
      const decisionPanelStart = html.indexOf("data-dashboard-decision-panel");
      const glanceStart = html.indexOf("data-dashboard-glance");
      const storedContentStart = html.indexOf("data-stored-content");
      const memoryInventoryStart = html.indexOf("data-memory-inventory");
      expect(commandFlowStart).toBeLessThan(statusBoardStart);
      expect(statusBoardStart).toBeLessThan(decisionPanelStart);
      expect(decisionPanelStart).toBeLessThan(glanceStart);
      expect(glanceStart).toBeLessThan(storedContentStart);
      expect(storedContentStart).toBeLessThan(memoryInventoryStart);
      expect(html.slice(commandFlowStart, memoryInventoryStart)).toContain("data-stored-content");
      expect(html).toContain(".dashboard-command-flow {");
      expect(html).toContain("background: linear-gradient(180deg, rgba(69, 185, 255, 0.075), rgba(116, 242, 145, 0.026) 42%, rgba(255, 255, 255, 0.012)), rgba(8, 10, 13, 0.86);");
      expect(html).toContain(".dashboard-command-flow > .status-board,");
      expect(html).toContain("box-shadow: none;");
      expect(html).toContain("<section class=\"glance-board\" data-dashboard-glance aria-label=\"At a glance\">");
      expect(html).toContain("<h2 data-i18n-en=\"At a glance\" data-i18n-zh=\"一眼看懂\">At a glance</h2>");
      expect(html).toContain("<div class=\"glance-summary-strip\" data-glance-summary-strip aria-label=\"Recent activity summary\">");
      expect(html).toContain("<button type=\"button\" data-glance-summary=\"recent-writes\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-glance-filter=\"all\">");
      expect(html).toContain("<span data-i18n-en=\"Recent writes\" data-i18n-zh=\"最近写入\">Recent writes</span>");
      expect(html).toContain("<strong>3</strong>");
      expect(html).toContain("<small data-i18n-en=\"3 visible records\" data-i18n-zh=\"3 条可见内容\">3 visible records</small>");
      expect(html).toContain("<button type=\"button\" data-glance-summary=\"remembered-now\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-glance-filter=\"canonical\">");
      expect(html).toContain("<span data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</span>");
      expect(html).toContain("<small data-i18n-en=\"Moryn can use now\" data-i18n-zh=\"Moryn 现在可用\">Moryn can use now</small>");
      expect(html).toContain("<button type=\"button\" data-glance-summary=\"to-organize\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-glance-filter=\"candidate,raw,archived,quarantined\">");
      expect(html).toContain("<span data-i18n-en=\"Searchable\" data-i18n-zh=\"可搜索内容\">Searchable</span>");
      expect(html).toContain("<strong>2</strong>");
      expect(html).toContain("<small data-i18n-en=\"Saved, not final\" data-i18n-zh=\"已保存，未定稿\">Saved, not final</small>");
      expect(html).toContain("<button type=\"button\" data-glance-summary=\"top-source\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-glance-source=\"Codex\">");
      expect(html).toContain("<span data-i18n-en=\"Top source\" data-i18n-zh=\"主要来源\">Top source</span>");
      expect(html).toContain("<strong>Codex</strong>");
      expect(html).toContain("<small data-i18n-en=\"4 recent signals\" data-i18n-zh=\"4 条最近信号\">4 recent signals</small>");
      expect(html).toContain("<article class=\"glance-chart memory-shape\" data-memory-state-chart>");
      expect(html).toContain(".glance-chart {");
      expect(html).toContain("grid-template-rows: minmax(15px, auto) minmax(2.3em, auto) minmax(0, 1fr);");
      expect(html).toContain("align-content: stretch;");
      expect(html).toContain("<div class=\"memory-state-meter\" aria-label=\"Memory state chart\">");
      expect(html).toContain("<p class=\"glance-chart-insight\" data-i18n-en=\"33% ready to use · 67% searchable\" data-i18n-zh=\"33% 可直接使用 · 67% 可搜索\">33% ready to use · 67% searchable</p>");
      expect(html).toContain("<span data-memory-state-percent=\"remembered\" data-i18n-en=\"33%\" data-i18n-zh=\"33%\">33%</span>");
      expect(html).toContain("<span data-memory-state-percent=\"new_items\" data-i18n-en=\"33%\" data-i18n-zh=\"33%\">33%</span>");
      expect(html).toContain("<button type=\"button\" class=\"memory-state-filter memory-state-to-organize\" data-memory-state-filter=\"candidate\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<button type=\"button\" class=\"memory-state-filter memory-state-remembered\" data-memory-state-filter=\"canonical\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<article class=\"glance-chart memory-types\" data-memory-kind-chart>");
      expect(html).toContain("<p class=\"glance-chart-insight\" data-i18n-en=\"Most are Memories: 1 item\" data-i18n-zh=\"最多的是记忆，共 1 条\">Most are Memories: 1 item</p>");
      expect(html).toContain("<span data-i18n-en=\"1 · 33%\" data-i18n-zh=\"1 条 · 33%\">1 · 33%</span>");
      expect(html).toContain("<article class=\"glance-chart shared-copy good\" data-shared-copy-chart>");
      expect(html).toContain("<article class=\"glance-chart recent-activity\" data-recent-activity-chart>");
      expect(html).toContain(".memory-state-key,");
      expect(html).toContain(".kind-bars,");
      expect(html).toContain(".activity-bars { align-self: end; }");
      expect(html).toContain("<p class=\"glance-chart-insight\" data-i18n-en=\"Top source: Codex, 67% of recent activity\" data-i18n-zh=\"主要来源：Codex，占最近活动的 67%\">Top source: Codex, 67% of recent activity</p>");
      expect(html).toContain("<strong data-i18n-en=\"19d ago\" data-i18n-zh=\"19 天前\">19d ago</strong>");
      expect(html).toContain("<span data-i18n-en=\"1 saved | 19d ago\" data-i18n-zh=\"1 条保存内容 | 19 天前\">1 saved | 19d ago</span>");
      expect(html).toContain("<span data-i18n-en=\"67%\" data-i18n-zh=\"67%\">67%</span>");
      expect(html.indexOf("data-dashboard-glance")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(data.dashboard_overview.cards.map((card) => card.id)).toEqual(["health", "action", "context", "sync"]);
      expect(html).toContain("<section class=\"decision-panel saved-later\" data-dashboard-decision-panel aria-label=\"Saved and searchable\">");
      expect(html).toContain("<h2 data-i18n-en=\"Saved and searchable\" data-i18n-zh=\"已保存可搜索\">Saved and searchable</h2>");
      expect(html).toContain("<span data-i18n-en=\"No action needed\" data-i18n-zh=\"无需操作\">No action needed</span>");
      expect(html).toContain("<strong data-i18n-en=\"2 searchable items\" data-i18n-zh=\"2 条可搜索内容\">2 searchable items</strong>");
      expect(html).toContain("<button type=\"button\" class=\"decision-panel-link\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-memory-explorer-stored-filter=\"candidate,raw,archived,quarantined\" data-memory-explorer-state-filter=\"candidate,raw,archived,quarantined\" data-memory-explorer-focus-search=\"true\" data-i18n-en=\"Search saved content\" data-i18n-zh=\"搜索已保存内容\">Search saved content</button>");
      expect(html).toContain("<small data-i18n-en=\"Opening this is read-only; it will not change long-term memory.\" data-i18n-zh=\"打开这里只是只读查看，不会改变长期记忆。\">Opening this is read-only; it will not change long-term memory.</small>");
      expect(html).toContain("const feedback = document.querySelector(\"[data-dashboard-action-feedback]\");");
      expect(html).toContain("if (!target) {");
      expect(html).toContain("feedback.textContent = document.documentElement.lang === \"zh\"");
      expect(html).toContain("feedback.dataset.i18nZh || \"这里暂时没有可打开的内容。\"");
      expect(html).toContain("feedback.dataset.i18nEn || \"Nothing to open here yet.\";");
      expect(html).toContain("target.classList.add(\"dashboard-target-active\");");
      expect(html).toContain("window.setTimeout(() => target.classList.remove(\"dashboard-target-active\"), 1800);");
      expect(html).toContain("window.openStoredContentPanel?.(trigger);");
      expect(html).toContain("const explorerIntentFromTrigger = (triggerOrIntent) => {");
      expect(html).toContain("triggerOrIntent.dataset.memoryExplorerStoredFilter");
      expect(html).toContain("triggerOrIntent.dataset.memoryExplorerStateFilter");
      expect(html).toContain("triggerOrIntent.dataset.memoryExplorerSelectedId");
      expect(html).toContain("focusSearch: triggerOrIntent.dataset.memoryExplorerFocusSearch === \"true\"");
      expect(html).toContain("writeStoredContentState({ overflowOpen: true, searchOpen: true, ...intent });");
      expect(html).toContain(".dashboard-target-active,");
      expect(html).toContain(".stored-content-active {");
      expect(html.indexOf("data-dashboard-decision-panel")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(html).toContain("<section id=\"stored-content\" class=\"stored-content memory-explorer\" data-stored-content data-memory-explorer aria-label=\"Find what Moryn saved\">");
      expect(html).toContain("<h2 data-i18n-en=\"Find what Moryn saved\" data-i18n-zh=\"查找 Moryn 保存的内容\">Find what Moryn saved</h2>");
      expect(html).toContain("<small data-i18n-en=\"Search first, then open any item for full text. Nothing writes here.\" data-i18n-zh=\"先搜索，再打开任何内容查看全文；这里不会写入。\">Search first, then open any item for full text. Nothing writes here.</small>");
      expect(html).toContain("<div class=\"memory-state-guide\" data-memory-state-guide aria-label=\"Memory status guide\">");
      expect(html).toContain("<span data-i18n-en=\"Memory status guide\" data-i18n-zh=\"记忆状态说明\">Memory status guide</span>");
      expect(html).toContain("<button type=\"button\" class=\"memory-state-guide-card memory-state-remembered\" data-memory-state-filter=\"canonical\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<strong data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</strong>");
      expect(html).toContain("<small data-i18n-en=\"Moryn can already use this as long-term memory.\" data-i18n-zh=\"Moryn 已经可以把这些作为长期记忆使用。\">Moryn can already use this as long-term memory.</small>");
      expect(html).toContain("<button type=\"button\" class=\"memory-state-guide-card memory-state-to-organize\" data-memory-state-filter=\"candidate\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<strong data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</strong>");
      expect(html).toContain("<small data-i18n-en=\"Saved and searchable; organize later only if useful.\" data-i18n-zh=\"已保存并可搜索；有用时再整理。\">Saved and searchable; organize later only if useful.</small>");
      expect(html).toContain("<button type=\"button\" class=\"memory-state-guide-card memory-state-temporary\" data-memory-state-filter=\"raw\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<strong data-i18n-en=\"Saved briefly\" data-i18n-zh=\"临时保存\">Saved briefly</strong>");
      expect(html).toContain("<button type=\"button\" class=\"memory-state-guide-card memory-state-set-aside\" data-memory-state-filter=\"archived,quarantined\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<strong data-i18n-en=\"Set aside\" data-i18n-zh=\"已放一边\">Set aside</strong>");
      expect(html).toContain("<div class=\"memory-explorer-layout\" data-memory-explorer-layout>");
      expect(html).toContain("<div class=\"memory-explorer-main\" data-memory-explorer-main>");
      const detailHtml = memoryExplorerDetailHtml(html);
      expect(detailHtml).toContain("<aside class=\"memory-explorer-detail\" data-memory-explorer-detail aria-live=\"polite\">");
      expect(detailHtml).toContain("<strong data-memory-explorer-detail-title data-i18n-en=\"Status\" data-i18n-zh=\"状态\">Status</strong>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-read-first\" data-memory-explorer-read-first>");
      expect(detailHtml).toContain("<span data-i18n-en=\"Read first\" data-i18n-zh=\"先看这个\">Read first</span>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-read-first-grid\">");
      expect(detailHtml).toContain("<article><span data-i18n-en=\"Status\" data-i18n-zh=\"状态\">Status</span><strong data-memory-explorer-summary-state data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</strong></article>");
      expect(detailHtml).toContain("<article><span data-i18n-en=\"Meaning\" data-i18n-zh=\"含义\">Meaning</span><strong data-memory-explorer-summary-meaning data-i18n-en=\"Saved and searchable\" data-i18n-zh=\"已保存并可搜索\">Saved and searchable</strong></article>");
      expect(detailHtml).toContain("<article><span data-i18n-en=\"Why saved\" data-i18n-zh=\"为什么保存\">Why saved</span><strong data-memory-explorer-summary-why data-i18n-en=\"Saved by Gemini for later organization.\" data-i18n-zh=\"Gemini 保存，稍后可整理。\">Saved by Gemini for later organization.</strong></article>");
      expect(detailHtml).toContain("<article><span data-i18n-en=\"Next\" data-i18n-zh=\"下一步\">Next</span><strong data-memory-explorer-summary-next data-i18n-en=\"Organize later if useful\" data-i18n-zh=\"需要时再整理\">Organize later if useful</strong></article>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-full-text\" data-memory-explorer-full-text>");
      expect(detailHtml).toContain("<span data-i18n-en=\"Full text\" data-i18n-zh=\"全文\">Full text</span>");
      expect(detailHtml).toContain("<p data-memory-explorer-detail-text>Recent session status belongs on the dashboard front page.</p>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-meaning\" data-memory-explorer-meaning>");
      expect(detailHtml).toContain("<span data-i18n-en=\"What this means\" data-i18n-zh=\"这意味着什么\">What this means</span>");
      expect(detailHtml).toContain("<strong data-memory-explorer-detail-meaning data-i18n-en=\"Saved and searchable\" data-i18n-zh=\"已保存并可搜索\">Saved and searchable</strong>");
      expect(detailHtml).toContain("<small data-memory-explorer-detail-meaning-detail data-i18n-en=\"Useful context is kept here, but it is not long-term memory yet.\" data-i18n-zh=\"有用上下文保存在这里，但还不是长期记忆。\">Useful context is kept here, but it is not long-term memory yet.</small>");
      expect(detailHtml).toContain("<dl class=\"memory-explorer-detail-grid\" data-memory-explorer-detail-grid>");
      expect(detailHtml).toContain("<dd data-memory-explorer-detail-state data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</dd>");
      expect(detailHtml).toContain("<dd data-memory-explorer-detail-source data-i18n-en=\"Gemini session\" data-i18n-zh=\"Gemini 会话\">Gemini session</dd>");
      expect(detailHtml).not.toContain("gemini / dashboard-all-clear-info");
      expect(detailHtml).toContain("<dd data-memory-explorer-detail-updated data-i18n-en=\"19d ago | 2026-06-01T00:03:00.000Z\" data-i18n-zh=\"19 天前 | 2026-06-01T00:03:00.000Z\">19d ago | 2026-06-01T00:03:00.000Z</dd>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-guidance\" data-memory-explorer-guidance>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-guidance-card\" data-memory-explorer-guidance-card=\"why-saved\">");
      expect(detailHtml).toContain("<span data-i18n-en=\"Why saved\" data-i18n-zh=\"为什么保存\">Why saved</span>");
      expect(detailHtml).toContain("<strong data-memory-explorer-detail-why data-i18n-en=\"Saved by Gemini for later organization.\" data-i18n-zh=\"Gemini 保存，稍后可整理。\">Saved by Gemini for later organization.</strong>");
      expect(detailHtml).toContain("<div class=\"memory-explorer-guidance-card\" data-memory-explorer-guidance-card=\"next-step\">");
      expect(detailHtml).toContain("<span data-i18n-en=\"Next step\" data-i18n-zh=\"下一步\">Next step</span>");
      expect(detailHtml).toContain("<strong data-memory-explorer-detail-next-step data-i18n-en=\"Organize later if useful\" data-i18n-zh=\"需要时再整理\">Organize later if useful</strong>");
      expect(detailHtml).toContain("<small data-memory-explorer-detail-next-step-detail data-i18n-en=\"Already saved and searchable. Organize it only if it should become long-term memory.\" data-i18n-zh=\"已保存并可搜索；只有需要成为长期记忆时再整理。\">Already saved and searchable. Organize it only if it should become long-term memory.</small>");
      expect(detailHtml).toContain("<details class=\"memory-explorer-trace\" data-memory-explorer-trace>");
      expect(detailHtml).toContain("<summary data-i18n-en=\"Trace details\" data-i18n-zh=\"追踪详情\">Trace details</summary>");
      expect(detailHtml).not.toContain("<span data-i18n-en=\"History links\" data-i18n-zh=\"历史入口\">History links</span>");
      expect(detailHtml).toContain("<code data-memory-explorer-detail-timeline>moryn timeline --record-id rec_action_board_3 --project-id moryn</code>");
      expect(detailHtml).toContain("<code data-memory-explorer-detail-recall>moryn recall --record-id rec_action_board_3 --project-id moryn</code>");
      expect(detailHtml).not.toContain("Select an item");
      expect(detailHtml).not.toContain("Select a saved item to read its full text, source, and status.");
      expect(html).not.toContain("trace commands.");
      expect(html).toContain("data-memory-explorer-detail-timeline");
      expect(html).toContain("data-memory-explorer-detail-recall");
      expect(html).toContain("<div class=\"stored-content-filterbar\" data-stored-content-filterbar aria-label=\"Stored content filters\">");
      expect(html).toContain("<button type=\"button\" class=\"stored-content-filter active\" data-stored-content-filter=\"all\" aria-pressed=\"true\" data-i18n-en=\"All\" data-i18n-zh=\"全部\">All</button>");
      expect(html).toContain("data-stored-content-filter=\"candidate\"");
      expect(html).toContain("data-stored-content-filter=\"canonical\"");
      expect(html).toContain("<article class=\"stored-content-item state-candidate selected\" data-stored-content-item=\"rec_action_board_3\"");
      expect(html).toContain("data-stored-content-state=\"candidate\"");
      expect(html).toContain("data-stored-content-source=\"Gemini\"");
      expect(html).toContain("data-memory-explorer-source=\"Gemini session\"");
      expect(html).toContain("data-memory-explorer-source-zh=\"Gemini 会话\"");
      expect(html).toContain("data-memory-explorer-title=\"Status\"");
      expect(html).toContain("data-memory-explorer-title-zh=\"状态\"");
      expect(html).toContain("data-memory-explorer-full-text=\"Recent session status belongs on the dashboard front page.\"");
      expect(html).toContain("data-memory-explorer-why-saved=\"Saved by Gemini for later organization.\"");
      expect(html).toContain("data-memory-explorer-why-saved-zh=\"Gemini 保存，稍后可整理。\"");
      expect(html).toContain("data-memory-explorer-meaning=\"Saved and searchable\"");
      expect(html).toContain("data-memory-explorer-meaning-zh=\"已保存并可搜索\"");
      expect(html).toContain("data-memory-explorer-meaning-detail=\"Useful context is kept here, but it is not long-term memory yet.\"");
      expect(html).toContain("data-memory-explorer-meaning-detail-zh=\"有用上下文保存在这里，但还不是长期记忆。\"");
      expect(html).toContain("data-memory-explorer-next-step=\"Organize later if useful\"");
      expect(html).toContain("data-memory-explorer-next-step-zh=\"需要时再整理\"");
      expect(html).toContain("data-memory-explorer-next-step-detail=\"Already saved and searchable. Organize it only if it should become long-term memory.\"");
      expect(html).toContain("data-memory-explorer-next-step-detail-zh=\"已保存并可搜索；只有需要成为长期记忆时再整理。\"");
      expect(html).toContain("data-memory-explorer-state-en=\"Saved for later\"");
      expect(html).toContain("data-memory-explorer-state-zh=\"已保存，稍后整理\"");
      expect(html).toContain("data-memory-explorer-updated-zh=\"19 天前 | 2026-06-01T00:03:00.000Z\"");
      expect(html).toContain("data-memory-explorer-timeline=\"moryn timeline --record-id rec_action_board_3 --project-id moryn\"");
      expect(html).toContain("data-memory-explorer-recall=\"moryn recall --record-id rec_action_board_3 --project-id moryn\"");
      expect(html).toContain("<div class=\"stored-content-explain\" data-stored-content-explain>");
      expect(html).toContain("<div class=\"stored-content-explain-card\" data-stored-content-explain-card=\"why-saved\">");
      expect(html).toContain("<span data-i18n-en=\"Why saved\" data-i18n-zh=\"为什么保存\">Why saved</span>");
      expect(html).toContain("<strong data-i18n-en=\"Saved by Gemini for later organization.\" data-i18n-zh=\"Gemini 保存，稍后可整理。\">Saved by Gemini for later organization.</strong>");
      expect(html).toContain("<div class=\"stored-content-explain-card\" data-stored-content-explain-card=\"status\">");
      expect(html).toContain("<span data-i18n-en=\"Status\" data-i18n-zh=\"状态\">Status</span>");
      expect(html).toContain("<strong data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</strong>");
      expect(html).toContain("<div class=\"stored-content-explain-card\" data-stored-content-explain-card=\"next-step\">");
      expect(html).toContain("<span data-i18n-en=\"Next step\" data-i18n-zh=\"下一步\">Next step</span>");
      expect(html).toContain("<strong data-i18n-en=\"Organize later if useful\" data-i18n-zh=\"需要时再整理\">Organize later if useful</strong>");
      expect(html).toContain("<small data-i18n-en=\"Already saved and searchable. Organize it only if it should become long-term memory.\" data-i18n-zh=\"已保存并可搜索；只有需要成为长期记忆时再整理。\">Already saved and searchable. Organize it only if it should become long-term memory.</small>");
      expect(html).toContain("<button type=\"button\" class=\"stored-content-open\" data-memory-explorer-open data-i18n-en=\"Open details\" data-i18n-zh=\"打开详情\">Open details</button>");
      expect(html).not.toContain("data-stored-content-remember");
      expect(html).not.toContain("data-stored-content-dismiss");
      expect(html).toContain("<p>Recent session status belongs on the dashboard front page.</p>");
      expect(html).toContain("<article class=\"stored-content-item state-canonical\" data-stored-content-item=\"rec_action_board_2\"");
      expect(html).toContain("<strong data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</strong>");
      expect(html).toContain("<small data-i18n-en=\"Moryn can use this now as long-term memory.\" data-i18n-zh=\"Moryn 现在可把这条作为长期记忆使用。\">Moryn can use this now as long-term memory.</small>");
      expect(html).toContain("<article class=\"stored-content-item state-raw\" data-stored-content-item=\"rec_action_board_1\"");
      expect(html).toContain("<strong data-i18n-en=\"Keep for context\" data-i18n-zh=\"作为上下文保留\">Keep for context</strong>");
      expect(html).toContain("<small data-i18n-en=\"Session notes stay searchable for context but are not long-term memory.\" data-i18n-zh=\"会话记录可作为上下文搜索，但不是长期记忆。\">Session notes stay searchable for context but are not long-term memory.</small>");
      expect(html).toContain("<p>Moryn should make dashboard storage easy to understand.</p>");
      expect(html.indexOf("data-stored-content")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(html).toContain("<section class=\"memory-inventory\" data-memory-inventory aria-label=\"What Moryn stores\">");
      expect(html).toContain("<h2 data-i18n-en=\"What Moryn stores\" data-i18n-zh=\"Moryn 存了什么\">What Moryn stores</h2>");
      expect(html).toContain("<button type=\"button\" class=\"memory-inventory-card memory-inventory-remembered\" data-memory-state-filter=\"canonical\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</span>");
      expect(html).toContain("<small data-i18n-en=\"Moryn can use these as long-term memory.\" data-i18n-zh=\"Moryn 可以把这些作为长期记忆使用。\">Moryn can use these as long-term memory.</small>");
      expect(html).toContain("<strong>1</strong>");
      expect(html).toContain("<button type=\"button\" class=\"memory-inventory-card memory-inventory-new_items\" data-memory-state-filter=\"candidate\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</span>");
      expect(html).toContain("<small data-i18n-en=\"Saved and searchable; organize later only if useful.\" data-i18n-zh=\"已保存并可搜索；有用时再整理。\">Saved and searchable; organize later only if useful.</small>");
      expect(html).toContain("<button type=\"button\" class=\"memory-inventory-card memory-inventory-temporary\" data-memory-state-filter=\"raw\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Saved briefly\" data-i18n-zh=\"临时保存\">Saved briefly</span>");
      expect(html).toContain("<small data-i18n-en=\"Context from this session kept for lookup.\" data-i18n-zh=\"本次会话上下文已保留，可供查找。\">Context from this session kept for lookup.</small>");
      expect(html).toContain("<button type=\"button\" class=\"memory-inventory-card memory-inventory-set_aside\" data-memory-state-filter=\"archived,quarantined\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Set aside\" data-i18n-zh=\"已放一边\">Set aside</span>");
      expect(html).toContain("<small data-i18n-en=\"Archived or replaced items kept for traceability.\" data-i18n-zh=\"为追溯保留的归档或已替换内容。\">Archived or replaced items kept for traceability.</small>");
      expect(html).not.toContain("<article class=\"memory-inventory-card");
      expect(html).toContain(".memory-inventory-card,");
      expect(html).toContain(".recent-status article {");
      expect(html).toContain("grid-template-rows: minmax(1.25em, auto) minmax(30px, 1fr) minmax(2.6em, auto);");
      expect(html).toContain("min-height: 86px;");
      expect(html).toContain("align-content: stretch;");
      expect(html).toContain(".memory-inventory-card:hover {");
      expect(html).toContain("background: var(--surface-hover);");
      expect(html).toContain("box-shadow: var(--elevation-hover);");
      expect(html).toContain(".memory-inventory-card:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }");
      expect(html).not.toContain("Saved recently");
      expect(html).not.toContain("Recent notes");
      expect(html).toContain("<section class=\"recent-status\" data-recent-status aria-label=\"Recent status\">");
      expect(html).toContain("<h2 data-i18n-en=\"Recent status\" data-i18n-zh=\"最近状态\">Recent status</h2>");
      expect(html).toContain("<span data-i18n-en=\"Last write\" data-i18n-zh=\"最近写入\">Last write</span>");
      expect(html).toContain("<time datetime=\"2026-06-01T00:03:00.000Z\" title=\"2026-06-01T00:03:00.000Z\" data-i18n-en=\"19d ago\" data-i18n-zh=\"19 天前\">19d ago</time>");
      expect(html).toContain("<span data-i18n-en=\"Latest source\" data-i18n-zh=\"最近来源\">Latest source</span>");
      expect(html).toContain("<span data-i18n-en=\"Shared copy\" data-i18n-zh=\"共享副本\">Shared copy</span>");
      const recentStatusHtml = html.slice(html.indexOf("data-recent-status"), html.indexOf("data-recent-changes"));
      expect(recentStatusHtml).toContain("<span data-i18n-en=\"Searchable\" data-i18n-zh=\"可搜索内容\">Searchable</span>");
      expect(recentStatusHtml).toContain("<strong data-i18n-en=\"2 searchable items\" data-i18n-zh=\"2 条可搜索内容\">2 searchable items</strong>");
      expect(html).toContain("<div class=\"recent-changes\" data-recent-changes aria-label=\"Recent changes\">");
      expect(html).toContain("<div class=\"recent-changes-heading\">");
      expect(html).toContain("<span data-i18n-en=\"Recent changes\" data-i18n-zh=\"最近变化\">Recent changes</span>");
      expect(html).toContain("<small data-i18n-en=\"Latest saved content\" data-i18n-zh=\"最近保存的内容\">Latest saved content</small>");
      expect(html).toContain("<button type=\"button\" class=\"recent-change-row state-candidate\" data-recent-change-record=\"rec_action_board_3\" data-recent-change-select=\"rec_action_board_3\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</span>");
      expect(html).toContain("<strong data-i18n-en=\"Status\" data-i18n-zh=\"状态\">Status</strong>");
      expect(html).toContain("<small data-i18n-en=\"Gemini | 19d ago\" data-i18n-zh=\"Gemini | 19 天前\">Gemini | 19d ago</small>");
      expect(html).toContain("<button type=\"button\" class=\"recent-change-row state-canonical\" data-recent-change-record=\"rec_action_board_2\" data-recent-change-select=\"rec_action_board_2\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</span>");
      expect(html).toContain("<strong data-i18n-en=\"Decision\" data-i18n-zh=\"决策\">Decision</strong>");
      expect(html).toContain("<button type=\"button\" class=\"recent-change-row state-raw\" data-recent-change-record=\"rec_action_board_1\" data-recent-change-select=\"rec_action_board_1\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\">");
      expect(html).toContain("<span data-i18n-en=\"Saved briefly\" data-i18n-zh=\"临时保存\">Saved briefly</span>");
      expect(html).toContain("<strong data-i18n-en=\"Raw Note\" data-i18n-zh=\"临时笔记\">Raw Note</strong>");
      expect(html).not.toContain("<strong>Status</strong>");
      expect(html).not.toContain("<strong>Summary</strong>");
      expect(html).toContain("const recentChange = target.closest(\"[data-recent-change-select]\");");
      expect(html).toContain("selectedItemId: recentChange.dataset.recentChangeSelect || null");
      expect(html).toContain(".recent-change-row:hover {");
      expect(html).toContain(".recent-change-row:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }");
      expect(data.recent_records[0]).toMatchObject({
        source: { client: "gemini" },
        text: "Recent session status belongs on the dashboard front page."
      });
      expect(html).toContain("2 searchable items");
      expect(html).toContain("<strong data-i18n-en=\"2 searchable items\" data-i18n-zh=\"2 条可搜索内容\">2 searchable items</strong>");
      expect(html).not.toContain("2 saved or temporary items");
      expect(data.action_board.items.map((item) => item.id)).toEqual(["confirm", "review", "inspect", "sync"]);
      expect(data.action_board.items_by_id.review).toMatchObject({
        label: "Review",
        value: 0,
        next_action_label: "Open checks",
        target: "needs-attention"
      });
      expect(html).not.toContain("<details class=\"action-board-background\" aria-label=\"Background Shortcuts\" data-dashboard-detail=\"action-board\" data-dashboard-background-shortcuts>");
      expect(html).not.toContain("<span>Background Shortcuts</span>");
      expect(html).not.toContain("data-dashboard-background-shortcuts");
      expect(html).not.toContain("data-dashboard-detail=\"action-board-quiet-targets\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"confirm\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"review\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"inspect\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"sync\"");
      expect(html).not.toContain("<details class=\"action-board action-board-secondary\" aria-label=\"Page Shortcuts\" data-dashboard-detail=\"action-board\" data-action-board-nav>");
      expect(html).not.toContain("<span>Page Shortcuts</span>");
      expect(html).not.toContain("<span class=\"action-board-activity\">all clear</span>");
      expect(html).not.toContain("action-board-activity");
      expect(html).not.toContain("<span>Navigation Details</span>");
      expect(html).not.toContain("<small>0 confirm / 0 review / 0 inspect / 0 sync</small>");
      expect(html).not.toContain("<details class=\"action-board-quiet\" data-dashboard-detail=\"action-board-quiet-targets\">");
      expect(html).not.toContain("<span>Quiet Shortcuts</span>");
      expect(html).not.toContain("<small>Background section links</small>");
      expect(html).not.toContain("<small>4 reference checks</small>");
      expect(html).not.toContain("<span>Reference Checks</span>");
      expect(html).not.toContain("<span>Quiet Targets</span>");
      expect(html).not.toContain("<small>4 quiet targets</small>");
      expect(html).not.toContain("<div class=\"action-board-grid\">");
      expect(html).not.toContain("data-action-board-item=\"confirm\"");
      expect(html).not.toContain("data-action-board-item=\"review\"");
      expect(html).not.toContain("data-action-board-item=\"inspect\"");
      expect(html).not.toContain("data-action-board-item=\"sync\"");
      expect(html).not.toContain("<section class=\"dashboard-work-lanes\" data-dashboard-work-lanes aria-label=\"Dashboard Work Lanes\">");
      expect(html).not.toContain("data-dashboard-detail=\"dashboard-work-lanes-background\"");
      expect(html).not.toContain("<span>Background Lanes</span>");
      expect(html).not.toContain("data-dashboard-work-lane-quiet=\"decide\"");
      expect(html).not.toContain("data-dashboard-work-lane-quiet=\"context\"");
      expect(html).not.toContain("data-dashboard-work-lane-quiet=\"health\"");
      expect(html).not.toContain("data-dashboard-work-lane-quiet=\"evidence\"");
      expect(html).not.toContain("<div class=\"dashboard-overview-safety\" aria-label=\"Dashboard safety\">");
      expect(html).not.toContain("<span>Read-only overview</span>");
      expect(html).not.toContain("<span>Writes stay in Capture Inbox, Review Queue, and Candidate Triage</span>");
      expect(html).toContain("<details class=\"evidence-library evidence-library-compact\" data-dashboard-detail=\"evidence-library\" data-dashboard-background-reference aria-label=\"More details\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary evidence-library-fold evidence-library-compact-fold\" aria-label=\"More details: Extra context\">");
      expect(html).toContain("<span data-i18n-en=\"More details\" data-i18n-zh=\"更多细节\">More details</span>");
      expect(html).toContain("<small data-i18n-en=\"Extra context\" data-i18n-zh=\"补充信息\">Extra context</small>");
      expect(html).not.toContain("<small>Audit route available</small>");
      expect(html).not.toContain("<details class=\"panel evidence-library\" data-dashboard-detail=\"evidence-library\" aria-label=\"Reference Library\">");
      expect(html).not.toContain("<span>Reference Library</span>");
      expect(html).not.toContain("<small>Reference evidence only</small>");
      expect(html).toContain("<article class=\"reference-library-index\" data-dashboard-detail=\"reference-library:index\" data-reference-library-index>");
      const referenceIndexWrapHtml = referenceLibraryIndexWrapHtml(html);
      const referenceIndexHtml = referenceLibraryIndexHtml(html);
      const referenceRoutesStart = referenceIndexHtml.indexOf("<details class=\"reference-library-routes\" data-dashboard-detail=\"reference-library:routes\">");
      expect(referenceRoutesStart).toBeGreaterThan(-1);
      const referenceIndexFaceHtml = referenceIndexHtml.slice(0, referenceRoutesStart);
      const referenceRoutesHtml = referenceIndexHtml.slice(referenceRoutesStart);
      expect(referenceIndexFaceHtml).toContain("<strong data-i18n-en=\"Inspect saved content\" data-i18n-zh=\"查看保存内容\">Inspect saved content</strong>");
      expect(referenceIndexFaceHtml).not.toContain("<strong>Audit Index</strong>");
      expect(referenceIndexFaceHtml).toContain("<span data-i18n-en=\"Read-only, no memory changes\" data-i18n-zh=\"只查看，不改记忆\">Read-only, no memory changes</span>");
      expect(referenceIndexFaceHtml).toContain("<small data-i18n-en=\"Helpful context\" data-i18n-zh=\"补充上下文\">Helpful context</small>");
      expect(referenceIndexFaceHtml).not.toContain("<strong>Reference Library Index</strong>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Open related views\" data-i18n-zh=\"打开相关内容\">Open related views</span>");
      expect(referenceRoutesHtml).toContain("<small data-i18n-en=\"Sources and status\" data-i18n-zh=\"来源和状态\">Sources and status</small>");
      expect(referenceRoutesHtml).not.toContain("<span>Audit details</span>");
      expect(referenceRoutesHtml).not.toContain("<small>Routes and raw evidence</small>");
      expect(referenceIndexFaceHtml).not.toContain("Saved details");
      expect(referenceIndexFaceHtml).not.toContain("Read-only details available");
      expect(referenceRoutesHtml).not.toContain("Detail links");
      expect(referenceRoutesHtml).not.toContain("Routes and checks");
      expect(referenceIndexFaceHtml).not.toContain("data-reference-library-route=");
      expect(referenceIndexWrapHtml.slice(0, referenceRoutesStart)).not.toContain("Open <code>/api/dashboard</code>");
      expect(referenceRoutesHtml).toContain("Raw technical details stay in <code>/api/dashboard</code>.");
      expect(referenceRoutesHtml).not.toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"routine-diagnostics\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"routine-diagnostics\" data-i18n-en=\"Store status\" data-i18n-zh=\"存储状态\">Store status</code>");
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"supporting-evidence\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"supporting-evidence\" data-i18n-en=\"History\" data-i18n-zh=\"历史记录\">History</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-reference-library-route=\"routine-diagnostics\">diagnostics</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-reference-library-route=\"supporting-evidence\">audit_trail</code>");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Store Status\" data-i18n-zh=\"存储状态\">Store Status</strong>");
      expect(referenceRoutesHtml).not.toContain("<strong>Diagnostics Index</strong>");
      expect(referenceRoutesHtml).toContain("<code data-dashboard-detail=\"supporting-evidence\" data-i18n-en=\"History\" data-i18n-zh=\"历史记录\">History</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-dashboard-detail=\"supporting-evidence\">audit_trail</code>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Status sources ready\" data-i18n-zh=\"状态来源已就绪\">Status sources ready</span>");
      expect(referenceRoutesHtml).not.toContain("<span>Health Check, Recall Eval, Context Pack Review indexed</span>");
      expect(html).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"diagnostics\" data-dashboard-detail=\"routine-diagnostics\" data-routine-diagnostics-reference data-reference-library-index=\"diagnostics\">");
      expect(html).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"raw-store\" data-supporting-evidence-summary=\"raw-store\" data-dashboard-detail=\"debug-inspector\">");
      expect(html).toContain("<code data-dashboard-detail=\"supporting-evidence\" data-i18n-en=\"History\" data-i18n-zh=\"历史记录\">History</code>");
      expect(html).not.toContain("<article class=\"routine-diagnostics-reference\"");
      expect(html).not.toContain("<article class=\"supporting-evidence-summary-row\"");
      expect(html).toContain("Raw technical details stay in <code>/api/dashboard</code>.");
      expect(html).not.toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(html).not.toContain("data-evidence-library-brief");
      expect(html).not.toContain("<h3>Evidence index</h3>");
      expect(html).not.toContain("<div class=\"evidence-library-routebar\" role=\"list\" aria-label=\"Evidence index\">");
      expect(html).not.toContain("data-evidence-library-route=\"findings\"");
      expect(html).not.toContain("No read-only notes");
      expect(html).not.toContain("data-evidence-library-route=\"diagnostics\"");
      expect(html).not.toContain("data-evidence-library-route=\"audit\"");
      expect(html).not.toContain("<span>Routine Reference</span>");
      expect(html).not.toContain("<details class=\"evidence-library-group evidence-library-background\" data-dashboard-detail=\"evidence-background-evidence\">");
      expect(html).not.toContain("<details class=\"panel routine-diagnostics\" data-dashboard-detail=\"routine-diagnostics\" aria-label=\"Routine Diagnostics\">");
      expect(html).not.toContain("<details class=\"panel supporting-evidence\" data-dashboard-detail=\"supporting-evidence\" aria-label=\"Supporting Evidence\">");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("translates recent status empty write state", async () => {
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

      expect(html).toContain("<section class=\"recent-status\" data-recent-status aria-label=\"Recent status\">");
      expect(html).toContain("<span data-i18n-en=\"Last write\" data-i18n-zh=\"最近写入\">Last write</span>");
      expect(html).toContain("<strong data-i18n-en=\"None\" data-i18n-zh=\"暂无写入\">None</strong>");
      expect(html).toContain("<strong data-i18n-en=\"None\" data-i18n-zh=\"暂无写入\">None</strong>\n            <small data-i18n-en=\"No writes yet\" data-i18n-zh=\"还没有写入\">No writes yet</small>");
      expect(html).toContain("<button type=\"button\" class=\"answer-card recent\" data-dashboard-priority=\"recent\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-memory-explorer-stored-filter=\"all\" data-memory-explorer-state-filter=\"all\" data-memory-explorer-focus-search=\"true\">");
      expect(html).toContain("<span data-i18n-en=\"What changed recently?\" data-i18n-zh=\"最近有什么变化？\">What changed recently?</span>");
      expect(html).toContain("<strong data-i18n-en=\"No writes yet\" data-i18n-zh=\"还没有写入\">No writes yet</strong>");
      expect(html).toContain("<p class=\"answer-card-conclusion\" data-i18n-en=\"No saved content has changed yet.\" data-i18n-zh=\"还没有保存内容变化。\">No saved content has changed yet.</p>");
      expect(html).toContain("<small data-i18n-en=\"Waiting for saved content\" data-i18n-zh=\"等待保存内容\">Waiting for saved content</small>");
      expect(html).not.toContain("data-status-ticker-item=\"last-write\"");
    });
  });

  it("shows a seven-day saved-content trend on the first screen", async () => {
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

      expect(html).toContain("<article class=\"glance-chart activity-trend\" data-activity-trend-chart>");
      expect(html).toContain("<h3 data-i18n-en=\"Saved trend\" data-i18n-zh=\"保存趋势\">Saved trend</h3>");
      expect(html).toContain("<span data-i18n-en=\"Last 7 days\" data-i18n-zh=\"最近 7 天\">Last 7 days</span>");
      expect(html).toContain("<strong data-i18n-en=\"5 saved\" data-i18n-zh=\"5 条保存内容\">5 saved</strong>");
      expect(html).toContain("<div class=\"activity-trend-bars\" aria-label=\"Saved content by day\">");
      expect(html).toContain("<i style=\"height: 50%\" title=\"2026-06-15: 1 saved item\"></i>");
      expect(html).toContain("<i style=\"height: 0%\" title=\"2026-06-16: 0 saved items\"></i>");
      expect(html).toContain("<i style=\"height: 100%\" title=\"2026-06-21: 2 saved items\"></i>");
      expect(html).toContain("<span>15</span>");
      expect(html).toContain("<span>21</span>");
      expect(html).toContain(".activity-trend-bars {");
      expect(html).toContain("grid-template-columns: repeat(7, minmax(0, 1fr));");
      expect(html).toContain(".activity-trend-bars i {");
      expect(html).toContain("min-height: 4px;");
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
      expect(html).toContain("[hidden] { display: none !important; }");
      expect(html).toContain("<button type=\"button\" class=\"stored-content-more\" data-stored-content-more aria-expanded=\"false\" aria-controls=\"stored-content-overflow\"");
      expect(html).toContain("data-i18n-en=\"View 2 more\" data-i18n-zh=\"查看更多 2 条\"");
      expect(html).toContain("data-stored-content-expanded-en=\"Show fewer\" data-stored-content-expanded-zh=\"收起\"");
      expect(html).toContain("<div id=\"stored-content-overflow\" class=\"stored-content-list stored-content-overflow\" data-stored-content-overflow hidden>");
      expect(html).toContain("<article class=\"stored-content-item state-canonical\" data-stored-content-item=\"rec_stored_more_2\"");
      expect(html).toContain("<p>Stored content item 2</p>");
      expect(html).toContain("<article class=\"stored-content-item state-canonical\" data-stored-content-item=\"rec_stored_more_1\"");
      expect(html).toContain("<p>Stored content item 1</p>");
      expect(html).not.toContain("href=\"#\" data-action-board-target=\"recent-value\"");
      expect(html).toContain("data-stored-content-more");
      expect(serverHtml).toContain("const storedContentKey = \"moryn.dashboard.storedContentState\";");
      expect(serverHtml).toContain("writeStoredContentState({ overflowOpen: willOpen });");
      expect(serverHtml).toContain("const explorerIntentFromTrigger = (triggerOrIntent) => {");
      expect(serverHtml).toContain("window.openStoredContentPanel = (triggerOrIntent) => {");
      expect(serverHtml).toContain("writeStoredContentState({ overflowOpen: true, searchOpen: true, ...intent });");
      expect(serverHtml).toContain("applyStoredContentState({ highlight: true, focusSearch: intent.focusSearch === true });");
      expect(serverHtml).toContain("storedContentFilter: \"all\"");
      expect(serverHtml).toContain("const filterStoredContent = (state) => {");
      expect(serverHtml).toContain("const matches = state.storedContentFilter === \"all\" || String(state.storedContentFilter || \"\").split(\",\").includes(node.dataset.storedContentState || \"\");");
      expect(serverHtml).toContain("const memoryStateFilter = target.closest(\"[data-memory-state-filter]\");");
      expect(serverHtml).toContain("writeStoredContentState({ overflowOpen: true, storedContentFilter: memoryStateFilter.dataset.memoryStateFilter || \"all\", searchOpen: true, searchStateFilter: memoryStateFilter.dataset.memoryStateFilter || \"all\" });");
      expect(serverHtml).toContain("const glanceFilter = target.closest(\"[data-glance-filter]\");");
      expect(serverHtml).toContain("writeStoredContentState({ overflowOpen: true, storedContentFilter: glanceFilter.dataset.glanceFilter || \"all\", searchOpen: true, searchStateFilter: glanceFilter.dataset.glanceFilter || \"all\" });");
      expect(serverHtml).toContain("const glanceSource = target.closest(\"[data-glance-source]\");");
      expect(serverHtml).toContain("writeStoredContentState({ overflowOpen: true, storedContentFilter: \"all\", searchOpen: true, searchSourceFilter: glanceSource.dataset.glanceSource || \"all\" });");
      expect(serverHtml).toContain("const storedFilter = target.closest(\"[data-stored-content-filter]\");");
      expect(serverHtml).toContain("writeStoredContentState({ storedContentFilter: storedFilter.dataset.storedContentFilter || \"all\", searchOpen: true, searchStateFilter: storedFilter.dataset.storedContentFilter || \"all\" });");
      expect(serverHtml).not.toContain("writeStoredContentState({ storedContentFilter: storedFilter.dataset.storedContentFilter || \"all\" });");
      expect(serverHtml).not.toContain("writeStoredContentState({ overflowOpen: true, searchOpen: true });");
      expect(serverHtml).not.toContain("applyStoredContentState({ focusSearch: true, highlight: true });");
      expect(serverHtml).toContain("section.classList.add(\"stored-content-active\");");
      expect(serverHtml).toContain("window.restoreStoredContentState = applyStoredContentState;");
      expect(serverHtml).toContain("const hadStoredContentSearchFocus = document.activeElement instanceof HTMLInputElement && document.activeElement.matches(\"[data-memory-search-input]\");");
      expect(serverHtml).toContain("if (window.shouldPauseStoredContentRefresh?.()) return;");
      expect(serverHtml).toContain("window.restoreStoredContentState?.({ focusSearch: hadStoredContentSearchFocus });");
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
      const visibleStart = html.indexOf("<div class=\"stored-content-list\">");
      const overflowStart = html.indexOf("<div id=\"stored-content-overflow\"");
      const visibleHtml = html.slice(visibleStart, overflowStart);
      const overflowHtml = html.slice(overflowStart);

      expect(data.recent_value.slice(0, 4).map((item) => item.state)).toEqual(["archived", "archived", "archived", "archived"]);
      expect(data.stored_content_preview.map((item) => item.state)).toEqual(["candidate", "canonical", "raw", "archived"]);
      expect(visibleHtml).toContain("Representative candidate memory");
      expect(visibleHtml).toContain("Representative canonical memory");
      expect(visibleHtml).toContain("Representative raw note");
      expect(visibleHtml).toContain("Newest archived memory 4");
      expect(visibleHtml).not.toContain("Newest archived memory 3");
      expect(overflowHtml).toContain("Newest archived memory 3");
      expect(html).toContain("data-i18n-en=\"View 3 more\" data-i18n-zh=\"查看更多 3 条\"");
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
      expect(html).toContain("<div class=\"stored-content-explain\" data-stored-content-explain>");
      expect(html).toContain("<div class=\"stored-content-explain-card\" data-stored-content-explain-card=\"why-saved\">");
      expect(html).toContain("<span data-i18n-en=\"Why saved\" data-i18n-zh=\"为什么保存\">Why saved</span>");
      expect(html).toContain("<strong data-i18n-en=\"Captured through Moryn host adapter autocapture.\" data-i18n-zh=\"Moryn 自动保存了这条内容，稍后可整理。\">Captured through Moryn host adapter autocapture.</strong>");
      expect(html).toContain("<strong data-i18n-en=\"Autocapture policy retained this low-risk handoff without canonical promotion.\" data-i18n-zh=\"低风险交接已保存为本地依据，但不会自动变成长期记忆。\">Autocapture policy retained this low-risk handoff without canonical promotion.</strong>");
      expect(html).toContain("<strong data-i18n-en=\"User confirmed this as durable project memory.\" data-i18n-zh=\"用户已确认这条可作为长期项目记忆。\">User confirmed this as durable project memory.</strong>");
      expect(html).toContain("<div class=\"stored-content-explain-card\" data-stored-content-explain-card=\"status\">");
      expect(html).toContain("<span data-i18n-en=\"Status\" data-i18n-zh=\"状态\">Status</span>");
      expect(html).toContain("<strong data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</strong>");
      expect(html).toContain("<div class=\"stored-content-explain-card\" data-stored-content-explain-card=\"next-step\">");
      expect(html).toContain("<span data-i18n-en=\"Next step\" data-i18n-zh=\"下一步\">Next step</span>");
      expect(html).toContain("<strong data-i18n-en=\"Organize later if useful\" data-i18n-zh=\"需要时再整理\">Organize later if useful</strong>");
      expect(html).toContain("<small data-i18n-en=\"Already saved and searchable. Organize it only if it should become long-term memory.\" data-i18n-zh=\"已保存并可搜索；只有需要成为长期记忆时再整理。\">Already saved and searchable. Organize it only if it should become long-term memory.</small>");
      expect(html).toContain("<strong data-i18n-en=\"Saved as session context by Gemini.\" data-i18n-zh=\"Gemini 保存为会话上下文。\">Saved as session context by Gemini.</strong>");
      expect(html).toContain(".stored-content-explain {");
      expect(html).toContain(".stored-content-explain-card {");
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
      const targetMatches = [...html.matchAll(/data-action-board-target="([^"]+)"/g)].map((match) => match[1]);
      const unresolved = targetMatches.filter((target) => {
        const escaped = target?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return !new RegExp(`id="${escaped}"`).test(html) && !new RegExp(`data-dashboard-detail="${escaped}"`).test(html);
      });

      expect(targetMatches).toContain("stored-content");
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
      expect(html).not.toContain("<button type=\"button\" class=\"memory-search-toggle\" data-memory-search-toggle");
      expect(html).toContain("<div id=\"memory-search-panel\" class=\"memory-search-panel primary-memory-search\" data-memory-search-panel data-memory-search-now=\"2026-06-21T00:00:00.000Z\" aria-label=\"Find memory\">");
      expect(html).toContain("<label class=\"memory-search-label\" for=\"memory-search-input\" data-i18n-en=\"Find memory or events\" data-i18n-zh=\"查找记忆或事件\">Find memory or events</label>");
      expect(html).toContain("<input id=\"memory-search-input\" class=\"memory-search-input\" type=\"search\" data-memory-search-input placeholder=\"Type a keyword, source, or topic\" aria-label=\"Find memory or events\" data-i18n-placeholder-en=\"Type a keyword, source, or topic\" data-i18n-placeholder-zh=\"输入关键词、来源或主题\" data-i18n-aria-label-en=\"Find memory or events\" data-i18n-aria-label-zh=\"查找记忆或事件\">");
      expect(html).toContain("<div class=\"memory-search-controls\" data-memory-search-controls>");
      expect(html).toContain("<select class=\"memory-search-select\" data-memory-search-state aria-label=\"Filter search by memory state\">");
      expect(html).toContain("<option value=\"all\" data-i18n-en=\"All statuses\" data-i18n-zh=\"全部状态\">All statuses</option>");
      expect(html).toContain("<option value=\"canonical\" data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</option>");
      expect(html).toContain("<option value=\"event\" data-i18n-en=\"Events\" data-i18n-zh=\"事件\">Events</option>");
      expect(html).toContain("<select class=\"memory-search-select\" data-memory-search-source aria-label=\"Filter search by source\">");
      expect(html).toContain("<option value=\"all\" data-i18n-en=\"All sources\" data-i18n-zh=\"全部来源\">All sources</option>");
      expect(html).toContain("<option value=\"Codex\">Codex</option>");
      expect(html).toContain("<span data-memory-search-status data-i18n-en=\"2 items to search\" data-i18n-zh=\"可搜索 2 条内容\">2 items to search</span>");
      expect(html).toContain("<div class=\"memory-search-summary\" data-memory-search-summary aria-label=\"Search summary\">");
      expect(html).toContain("<article class=\"memory-search-summary-card\">");
      expect(html).toContain("<span data-i18n-en=\"Searchable\" data-i18n-zh=\"可搜索\">Searchable</span>");
      expect(html).toContain("<strong data-memory-search-summary-total data-i18n-en=\"2 items\" data-i18n-zh=\"2 条内容\">2 items</strong>");
      expect(html).toContain("<span data-i18n-en=\"Showing\" data-i18n-zh=\"当前显示\">Showing</span>");
      expect(html).toContain("<strong data-memory-search-summary-visible data-i18n-en=\"2 items\" data-i18n-zh=\"2 条内容\">2 items</strong>");
      expect(html).toContain("<span data-i18n-en=\"Selected\" data-i18n-zh=\"当前选择\">Selected</span>");
      expect(html).toContain("<strong data-memory-search-summary-selected data-i18n-en=\"Decision\" data-i18n-zh=\"决策\">Decision</strong>");
      expect(html).toContain("<small class=\"memory-search-summary-readonly\" data-i18n-en=\"Read-only: opening an item only updates this detail view.\" data-i18n-zh=\"只读：打开内容只会更新详情视图。\">Read-only: opening an item only updates this detail view.</small>");
      expect(html).toContain("<div class=\"memory-search-active-filters\" data-memory-search-active-filters aria-label=\"Active memory filters\">");
      expect(html).toContain("<span data-i18n-en=\"Current view\" data-i18n-zh=\"当前视图\">Current view</span>");
      expect(html).toContain("<strong data-memory-search-active-query data-i18n-en=\"All keywords\" data-i18n-zh=\"全部关键词\">All keywords</strong>");
      expect(html).toContain("<strong data-memory-search-active-state data-i18n-en=\"All statuses\" data-i18n-zh=\"全部状态\">All statuses</strong>");
      expect(html).toContain("<strong data-memory-search-active-source data-i18n-en=\"All sources\" data-i18n-zh=\"全部来源\">All sources</strong>");
      expect(html).toContain("<div class=\"memory-search-mix\" data-memory-search-mix aria-label=\"Search result mix\">");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-mix-item\" data-memory-search-mix-item=\"canonical\" data-memory-search-mix-filter=\"canonical\" aria-pressed=\"false\" data-i18n-singular-en=\"Ready to use\" data-i18n-plural-en=\"Ready to use\" data-i18n-label-zh=\"可直接使用\" data-i18n-en=\"1 Ready to use\" data-i18n-zh=\"1 条可直接使用\">1 Ready to use</button>");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-mix-item\" data-memory-search-mix-item=\"event\" data-memory-search-mix-filter=\"event\" aria-pressed=\"false\" data-i18n-singular-en=\"Event\" data-i18n-plural-en=\"Events\" data-i18n-label-zh=\"事件\" data-i18n-en=\"1 Event\" data-i18n-zh=\"1 条事件\">1 Event</button>");
      expect(html).toContain("<article class=\"memory-search-result record\" data-memory-search-entry=\"record:rec_memory_search_1\"");
      expect(html).toContain("data-memory-explorer-title=\"Decision\"");
      expect(html).toContain("data-memory-explorer-title-zh=\"决策\"");
      expect(html).toContain("data-memory-explorer-full-text=\"Searchable dashboard keyword alpha\"");
      expect(html).toContain("data-memory-explorer-state-en=\"Ready to use\"");
      expect(html).toContain("data-memory-explorer-state-zh=\"可直接使用\"");
      expect(html).toContain("data-memory-explorer-why-saved=\"Saved as long-term memory.\"");
      expect(html).toContain("data-memory-explorer-why-saved-zh=\"已保存为长期记忆。\"");
      expect(html).toContain("data-memory-explorer-meaning=\"Long-term memory\"");
      expect(html).toContain("data-memory-explorer-meaning-zh=\"长期记忆\"");
      expect(html).toContain("data-memory-explorer-meaning-detail=\"Moryn can use this automatically when this project needs context.\"");
      expect(html).toContain("data-memory-explorer-meaning-detail-zh=\"项目需要上下文时，Moryn 可以自动使用这条。\"");
      expect(html).toContain("data-memory-explorer-next-step=\"Ready to use\"");
      expect(html).toContain("data-memory-explorer-next-step-zh=\"可直接使用\"");
      expect(html).toContain("data-memory-explorer-next-step-detail=\"Moryn can use this now as long-term memory.\"");
      expect(html).toContain("data-memory-explorer-next-step-detail-zh=\"Moryn 现在可把这条作为长期记忆使用。\"");
      expect(html).toContain("data-memory-explorer-source=\"Codex\"");
      expect(html).toContain("data-memory-explorer-updated=\"19d ago | 2026-06-01T00:01:00.000Z\"");
      expect(html).toContain("data-memory-explorer-updated-zh=\"19 天前 | 2026-06-01T00:01:00.000Z\"");
      expect(html).toContain("data-memory-explorer-timeline=\"moryn timeline --record-id rec_memory_search_1 --project-id moryn\"");
      expect(html).toContain("data-memory-explorer-recall=\"moryn recall --record-id rec_memory_search_1 --project-id moryn\"");
      expect(html).toContain("tabindex=\"0\"");
      expect(html).toContain("data-memory-search-state=\"canonical\"");
      expect(html).toContain("data-memory-search-source=\"Codex\"");
      expect(html).toContain("Searchable dashboard keyword alpha");
      expect(html).toContain("<span data-i18n-en=\"Memory\" data-i18n-zh=\"记忆\">Memory</span>");
      expect(html).toContain("<small data-i18n-en=\"Ready to use | Codex | 19d ago\" data-i18n-zh=\"可直接使用 | Codex | 19 天前\">Ready to use | Codex | 19d ago</small>");
      expect(html).toContain("<article class=\"memory-search-result event\" data-memory-search-entry=\"event:evt_memory_search_1\"");
      expect(html).toContain("data-memory-explorer-title=\"upsert_record\"");
      expect(html).toContain("data-memory-explorer-full-text=\"Saved item rec_memory_search_1\"");
      expect(html).toContain("data-memory-explorer-state-en=\"Event\"");
      expect(html).toContain("data-memory-explorer-state-zh=\"事件\"");
      expect(html).toContain("data-memory-explorer-has-guidance=\"false\"");
      expect(html).toContain("data-memory-explorer-updated=\"19d ago | 2026-06-01T00:01:00.000Z\"");
      expect(html).toContain("data-memory-explorer-updated-zh=\"19 天前 | 2026-06-01T00:01:00.000Z\"");
      expect(html).toContain("data-memory-explorer-timeline=\"moryn timeline --event-id evt_memory_search_1 --project-id moryn\"");
      expect(html).toContain("data-memory-explorer-recall=\"moryn recall --record-id rec_memory_search_1 --project-id moryn\"");
      expect(html).toContain("data-memory-search-state=\"event\"");
      expect(html).toContain("data-memory-search-source=\"Codex\"");
      expect(html).toContain("<span data-i18n-en=\"Event\" data-i18n-zh=\"事件\">Event</span>");
      expect(html).toContain("<p><span data-i18n-en=\"Saved item\" data-i18n-zh=\"保存内容\">Saved item</span> <code>rec_memory_search_1</code></p>");
      expect(html).toContain("<small data-i18n-en=\"Codex | 19d ago\" data-i18n-zh=\"Codex | 19 天前\">Codex | 19d ago</small>");
      expect(html).not.toContain("data-i18n-zh=\"Ready to use | Codex | 19d ago\"");
      expect(html).not.toContain("data-i18n-zh=\"Codex | 19d ago\"");
      expect(html).toContain("data-memory-search-text=");
      expect(html).toContain("writeStoredContentState({ searchQuery: query, searchOpen: true });");
      expect(html).toContain("selectedItemId: null");
      expect(html).toContain("const selectMemoryExplorerItem = (item) => {");
      expect(html).toContain("document.querySelectorAll(\"[data-stored-content-item], [data-memory-search-entry]\").forEach((node) => {");
      expect(html).toContain("node.classList.toggle(\"selected\", item instanceof HTMLElement && selectedId.length > 0 && node.dataset.memoryExplorerItemId === selectedId);");
      expect(html).toContain("const setLocalizedDetailText = (node, value, zhValue = value) => {");
      expect(html).toContain("node.dataset.i18nEn = value || \"\";");
      expect(html).toContain("node.dataset.i18nZh = zhValue || \"\";");
      expect(html).toContain("document.querySelectorAll(\"[data-i18n-placeholder-en][data-i18n-placeholder-zh]\").forEach((node) => {");
      expect(html).toContain("node.setAttribute(\"placeholder\", language === \"zh\" ? node.dataset.i18nPlaceholderZh || \"\" : node.dataset.i18nPlaceholderEn || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailTitle, item.dataset.memoryExplorerTitle || \"Saved item\", item.dataset.memoryExplorerTitleZh || item.dataset.memoryExplorerTitle || \"Saved item\");");
      expect(html).toContain("setLocalizedDetailText(detailText, item.dataset.memoryExplorerFullText || item.textContent || \"\", item.dataset.memoryExplorerFullTextZh || item.dataset.memoryExplorerFullText || item.textContent || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailState, item.dataset.memoryExplorerStateEn || item.dataset.memoryExplorerState || \"\", item.dataset.memoryExplorerStateZh || item.dataset.memoryExplorerState || \"\");");
      expect(html).toContain("const detailWhy = detail.querySelector(\"[data-memory-explorer-detail-why]\");");
      expect(html).toContain("const detailNextStep = detail.querySelector(\"[data-memory-explorer-detail-next-step]\");");
      expect(html).toContain("const detailNextStepDetail = detail.querySelector(\"[data-memory-explorer-detail-next-step-detail]\");");
      expect(html).toContain("const detailMeaning = detail.querySelector(\"[data-memory-explorer-detail-meaning]\");");
      expect(html).toContain("const detailMeaningDetail = detail.querySelector(\"[data-memory-explorer-detail-meaning-detail]\");");
      expect(html).toContain("const summaryState = detail.querySelector(\"[data-memory-explorer-summary-state]\");");
      expect(html).toContain("const summaryMeaning = detail.querySelector(\"[data-memory-explorer-summary-meaning]\");");
      expect(html).toContain("const summaryWhy = detail.querySelector(\"[data-memory-explorer-summary-why]\");");
      expect(html).toContain("const summaryNext = detail.querySelector(\"[data-memory-explorer-summary-next]\");");
      expect(html).toContain("const hasGuidance = item.dataset.memoryExplorerHasGuidance !== \"false\" && (item.dataset.memoryExplorerWhySaved || item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep);");
      expect(html).toContain("setLocalizedDetailText(summaryState, item.dataset.memoryExplorerStateEn || item.dataset.memoryExplorerState || \"\", item.dataset.memoryExplorerStateZh || item.dataset.memoryExplorerState || \"\");");
      expect(html).toContain("setLocalizedDetailText(summaryMeaning, item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || \"\", item.dataset.memoryExplorerMeaningZh || item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || \"\");");
      expect(html).toContain("setLocalizedDetailText(summaryWhy, item.dataset.memoryExplorerWhySaved || \"\", item.dataset.memoryExplorerWhySavedZh || item.dataset.memoryExplorerWhySaved || \"\");");
      expect(html).toContain("setLocalizedDetailText(summaryNext, item.dataset.memoryExplorerNextStep || \"\", item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerNextStep || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailWhy, item.dataset.memoryExplorerWhySaved || \"\", item.dataset.memoryExplorerWhySavedZh || item.dataset.memoryExplorerWhySaved || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailNextStep, item.dataset.memoryExplorerNextStep || \"\", item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerNextStep || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailNextStepDetail, item.dataset.memoryExplorerNextStepDetail || \"\", item.dataset.memoryExplorerNextStepDetailZh || item.dataset.memoryExplorerNextStepDetail || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailMeaning, item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || \"\", item.dataset.memoryExplorerMeaningZh || item.dataset.memoryExplorerNextStepZh || item.dataset.memoryExplorerMeaning || item.dataset.memoryExplorerNextStep || \"\");");
      expect(html).toContain("setLocalizedDetailText(detailMeaningDetail, item.dataset.memoryExplorerMeaningDetail || item.dataset.memoryExplorerNextStepDetail || \"\", item.dataset.memoryExplorerMeaningDetailZh || item.dataset.memoryExplorerNextStepDetailZh || item.dataset.memoryExplorerMeaningDetail || item.dataset.memoryExplorerNextStepDetail || \"\");");
      expect(html).toContain("if (guidance instanceof HTMLElement) guidance.hidden = !hasGuidance;");
      expect(html).toContain("if (meaning instanceof HTMLElement) meaning.hidden = !hasGuidance;");
      expect(html).toContain("const detailUpdated = detail.querySelector(\"[data-memory-explorer-detail-updated]\");");
      expect(html).toContain("setLocalizedDetailText(detailUpdated, item.dataset.memoryExplorerUpdated || \"\", item.dataset.memoryExplorerUpdatedZh || item.dataset.memoryExplorerUpdated || \"\");");
      expect(html).not.toContain("setLocalizedDetailText(\"[data-memory-explorer-detail-updated]\"");
      expect(html).toContain("writeStoredContentState({ selectedItemId: item.dataset.memoryExplorerItemId || item.dataset.storedContentItem || item.dataset.memorySearchEntry || null });");
      expect(html).toContain("const resetMemoryExplorerDetail = () => {");
      expect(html).toContain("setLocalizedDetailText(detail.querySelector(\"[data-memory-explorer-summary-state]\"), \"\");");
      expect(html).toContain("setLocalizedDetailText(detail.querySelector(\"[data-memory-explorer-summary-meaning]\"), \"\");");
      expect(html).toContain("setLocalizedDetailText(detail.querySelector(\"[data-memory-explorer-summary-why]\"), \"\");");
      expect(html).toContain("setLocalizedDetailText(detail.querySelector(\"[data-memory-explorer-summary-next]\"), \"\");");
      expect(html).toContain("detailGrid.hidden = true;");
      expect(html).toContain("trace.hidden = true;");
      expect(html).toContain("writeStoredContentState({ selectedItemId: null });");
      expect(html).toContain("const visibleMemoryExplorerItem = (section = document) => {");
      expect(html).toContain("return Array.from(section.querySelectorAll(\"[data-stored-content-item], [data-memory-search-entry]\")).find((node) => {");
      expect(html).toContain("const selected = state.selectedItemId ? document.querySelector(`[data-memory-explorer-item-id=\"${cssEscape(state.selectedItemId)}\"]`) : null;");
      expect(html).toContain("const firstVisible = visibleMemoryExplorerItem();");
      expect(html).toContain("selectMemoryExplorerItem(firstVisible);");
      expect(html).toContain("selected.offsetParent !== null");
      expect(html).toContain(".memory-explorer-read-first {");
      expect(html).toContain(".memory-explorer-read-first-grid {");
      expect(html).toContain(".memory-explorer-read-first-grid article {");
      expect(html).toContain("searchStateFilter:");
      expect(html).toContain("searchSourceFilter:");
      expect(html).toContain("filterMemorySearch(panel, {");
      expect(html).toContain("const stateFilters = String(filters.state || \"all\").split(\",\").filter(Boolean);");
      expect(html).toContain("const matchesState = filters.state === \"all\" || stateFilters.includes(entry.dataset.memorySearchState || \"\");");
      expect(html).toContain("const matchesSource = filters.source === \"all\" || entry.dataset.memorySearchSource === filters.source;");
      expect(html).toContain("const setMemorySearchStatus = (status, count, filtered) => {");
      expect(html).toContain("status.dataset.i18nZh = filtered ? `显示 ${count} 条内容` : `可搜索 ${count} 条内容`;");
      expect(html).toContain("const updateMemorySearchSummary = (panel, totalCount, visibleCount) => {");
      expect(html).toContain("setMemorySearchSummaryValue(panel.querySelector(\"[data-memory-search-summary-visible]\"), itemCountLabel(visibleCount).en, itemCountLabel(visibleCount).zh);");
      expect(html).toContain("const updateMemorySearchActiveFilters = (panel, filters) => {");
      expect(html).toContain("setMemorySearchSummaryValue(panel.querySelector(\"[data-memory-search-active-query]\"), activeQueryLabel(filters.query).en, activeQueryLabel(filters.query).zh);");
      expect(html).toContain("setMemorySearchSummaryValue(panel.querySelector(\"[data-memory-search-active-state]\"), activeStateLabel(filters.state).en, activeStateLabel(filters.state).zh);");
      expect(html).toContain("setMemorySearchSummaryValue(panel.querySelector(\"[data-memory-search-active-source]\"), activeSourceLabel(filters.source).en, activeSourceLabel(filters.source).zh);");
      expect(html).toContain("setMemorySearchSummaryValue(document.querySelectorAll(\"[data-memory-search-summary-selected]\"), item.dataset.memoryExplorerTitle || \"Selected item\", item.dataset.memoryExplorerTitleZh || item.dataset.memoryExplorerTitle || \"Selected item\");");
      expect(html).toContain("setMemorySearchSummaryValue(document.querySelectorAll(\"[data-memory-search-summary-selected]\"), \"Nothing selected\", \"未选择\");");
      expect(html).toContain("const updateMemorySearchMix = (panel, visibleEntries) => {");
      expect(html).toContain("const key = entry.dataset.memorySearchState || \"event\";");
      expect(html).toContain("item.hidden = count === 0;");
      expect(html).toContain("item.setAttribute(\"aria-pressed\", selectedState === item.dataset.memorySearchMixFilter ? \"true\" : \"false\");");
      expect(html).toContain("item.classList.toggle(\"active\", selectedState === item.dataset.memorySearchMixFilter);");
      expect(html).toContain("setMemorySearchMixItem(item, count);");
      expect(html).toContain("const mixItem = target.closest(\"[data-memory-search-mix-filter]\");");
      expect(html).toContain("writeStoredContentState({ searchStateFilter: mixItem.dataset.memorySearchMixFilter || \"all\", searchOpen: true });");
      expect(html).toContain("const explorerTrigger = target.closest(\"[data-memory-explorer-open], [data-stored-content-item], [data-memory-search-entry]\");");
      expect(html).toContain("const item = explorerTrigger.matches(\"[data-stored-content-item], [data-memory-search-entry]\") ? explorerTrigger : explorerTrigger.closest(\"[data-stored-content-item], [data-memory-search-entry]\");");
      expect(html).toContain("document.addEventListener(\"keydown\", (event) => {");
      expect(html).toContain("if (event.key !== \"Enter\" && event.key !== \" \") return;");
      expect(html).toContain("selectMemoryExplorerItem(item);");
      expect(html).toContain("writeStoredContentState({ searchQuery: query, searchOpen: true });");
      expect(html).toContain("writeStoredContentState({ searchStateFilter: target.value, searchOpen: true });");
      expect(html).toContain("writeStoredContentState({ searchSourceFilter: target.value, searchOpen: true });");
      expect(html).toContain("window.shouldPauseStoredContentRefresh = () => {");
      expect(html).toContain("return state.searchOpen === true && (String(state.searchQuery || \"\").trim().length > 0 || hasSearchFocus);");
      expect(html).toContain("data-memory-search-status");
      expect(html).toContain(".primary-memory-search {");
      expect(html).toContain("border-color: rgba(69, 185, 255, 0.42);");
      expect(html).toContain("grid-template-columns: minmax(12ch, max-content) minmax(0, 1fr);");
      expect(html).toContain("span[data-memory-search-status]");
      expect(html).toContain(".memory-explorer-full-text {");
      expect(html).toContain(".memory-explorer-meaning {");
      expect(html).toContain(".memory-search-summary {");
      expect(html).toContain(".memory-search-summary-card {");
      expect(html).toContain(".memory-search-summary-readonly {");
      expect(html).toContain(".memory-search-active-filters {");
      expect(html).toContain(".memory-search-active-filter {");
      expect(html).toContain(".memory-search-mix-item {");
      expect(html).toContain(".memory-search-result.selected {");
      expect(html).toContain(".memory-search-result:focus-visible { outline: 2px solid var(--signal-blue); outline-offset: 2px; }");
      expect(html).toContain(".stored-content-item:hover,");
      expect(html).toContain(".memory-search-result:hover,");
      expect(html).toContain(".glance-summary-strip button:hover,");
      expect(html).toContain(".evidence-library-route:hover,");
      expect(html).toContain(".reference-library-index-row:hover,");
      expect(html).toContain(".routine-diagnostics-route:hover {");
      expect(html).toContain("height: clamp(320px, 46vh, 520px);");
      expect(html).toContain("scrollbar-gutter: stable both-edges;");
      expect(html).toContain("transition: border-color 160ms ease, background 160ms ease, box-shadow 160ms ease, transform 160ms ease;");
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
      const serverHtml = renderDashboardServerHtml(data, 2000, { showStoredContent: true });

      expect(html).toContain("<div id=\"memory-search-panel\" class=\"memory-search-panel primary-memory-search\" data-memory-search-panel data-memory-search-now=\"2026-06-21T00:00:00.000Z\" aria-label=\"Find memory\">");
      expect(html).toContain("<div class=\"memory-search-chips\" data-memory-search-chips aria-label=\"Search shortcuts\">");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-chip\" data-memory-search-chip=\"source:Codex\" data-i18n-en=\"Codex\" data-i18n-zh=\"Codex\">Codex</button>");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-chip\" data-memory-search-chip=\"source:Gemini\" data-i18n-en=\"Gemini\" data-i18n-zh=\"Gemini\">Gemini</button>");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-chip\" data-memory-search-chip=\"state:long-term\" data-i18n-en=\"Ready to use\" data-i18n-zh=\"可直接使用\">Ready to use</button>");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-chip\" data-memory-search-chip=\"state:recently-saved\" data-i18n-en=\"Saved for later\" data-i18n-zh=\"已保存，稍后整理\">Saved for later</button>");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-chip\" data-memory-search-chip=\"type:event\" data-i18n-en=\"Events\" data-i18n-zh=\"事件\">Events</button>");
      expect(html).toContain("<button type=\"button\" class=\"memory-search-chip\" data-memory-search-chip=\"recent:7d\" data-i18n-en=\"Recent 7d\" data-i18n-zh=\"最近 7 天\">Recent 7d</button>");
      expect(html).toContain("data-memory-search-kind=\"memory\"");
      expect(html).toContain("data-memory-search-record-type=\"decision\"");
      expect(html).toContain("data-memory-search-updated-at=\"2026-06-18T00:01:00.000Z\"");
      expect(html).toContain("data-memory-search-kind=\"session_summary\"");
      expect(html).toContain("data-memory-search-record-type=\"status\"");
      expect(html).toContain("data-memory-search-updated-at=\"2026-06-10T00:01:00.000Z\"");
      expect(html).toContain("data-memory-search-kind=\"event\"");
      expect(html).toContain("data-memory-search-record-type=\"upsert_record\"");

      expect(serverHtml).toContain("const parseMemorySearchQuery = (query) => {");
      expect(serverHtml).toContain("const commandMatch = token.match(/^([a-z]+):(.+)$/);");
      expect(serverHtml).toContain("const normalizeMemoryStateQuery = (value) => {");
      expect(serverHtml).toContain("if (normalized === \"long-term\" || normalized === \"remembered\") return \"canonical\";");
      expect(serverHtml).toContain("if (normalized === \"recently-saved\" || normalized === \"to-organize\" || normalized === \"organize\") return \"candidate\";");
      expect(serverHtml).toContain("if (normalized === \"for-this-session\" || normalized === \"session-notes\" || normalized === \"session\") return \"raw\";");
      expect(serverHtml).toContain("parsed.source = value;");
      expect(serverHtml).toContain("parsed.state = normalizeMemoryStateQuery(value);");
      expect(serverHtml).toContain("parsed.type = value;");
      expect(serverHtml).toContain("parsed.recentDays = Number(value.replace(/d$/, \"\"));");
      expect(serverHtml).toContain("const matchesCommandSource = !parsed.source || String(entry.dataset.memorySearchSource || \"\").toLowerCase() === parsed.source;");
      expect(serverHtml).toContain("const matchesCommandState = !parsed.state || entry.dataset.memorySearchState === parsed.state;");
      expect(serverHtml).toContain("const matchesCommandType = !parsed.type || [entry.dataset.memorySearchKind, entry.dataset.memorySearchRecordType, entry.dataset.memorySearchState].some((value) => String(value || \"\").toLowerCase() === parsed.type);");
      expect(serverHtml).toContain("const matchesRecent = !parsed.recentDays || entryIsRecent(entry, parsed.recentDays, panel.dataset.memorySearchNow || \"\");");
      expect(serverHtml).toContain("const chip = target.closest(\"[data-memory-search-chip]\");");
      expect(serverHtml).toContain("writeStoredContentState({ searchQuery: chip.dataset.memorySearchChip || \"\", searchStateFilter: \"all\", searchSourceFilter: \"all\", searchOpen: true });");
      expect(serverHtml).toContain(".memory-search-chips {");
      expect(serverHtml).toContain(".memory-search-chip {");
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
      const referenceIndexHtml = referenceLibraryIndexHtml(html);
      const referenceRoutesStart = referenceIndexHtml.indexOf("<details class=\"reference-library-routes\" data-dashboard-detail=\"reference-library:routes\">");
      expect(referenceRoutesStart).toBeGreaterThan(-1);
      const referenceRoutesHtml = referenceIndexHtml.slice(referenceRoutesStart);

      expect(data.health.status).toBe("healthy");
      expect(data.dashboard_overview.headline).toBe("No action needed");
      expect(data.dashboard_overview.detail).toBe("3 saved items and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.");
      expect(html).not.toContain("<p data-i18n-en=\"3 saved items and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.\" data-i18n-zh=\"3 条保存内容和 1 条会话笔记现在可搜索；需要时再整理，这个摘要不会写入记忆。\">3 saved items and 1 session note are searchable now. Organize later if useful; this summary does not write to memory.</p>");
      expect(data.dashboard_overview.primary_action).toMatchObject({
        label: "Search saved content",
        target: "stored-content",
        source: "memory_inventory"
      });
      expect(html).not.toContain("<section class=\"dashboard-overview");
      expect(html).not.toContain("data-dashboard-overview");
      expect(html).not.toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"stored-content\" aria-controls=\"stored-content\" data-i18n-en=\"Search saved content\" data-i18n-zh=\"搜索已保存内容\">Search saved content</button>");
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
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"candidate-triage\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"candidate-triage\" data-i18n-en=\"Saved notes\" data-i18n-zh=\"已保存内容\">Saved notes</code>");
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"governance-hub\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"governance-hub\" data-i18n-en=\"Safety checks\" data-i18n-zh=\"安全检查\">Safety checks</code>");
      expect(referenceRoutesHtml).toContain("data-reference-library-route=\"dogfood-review\"");
      expect(referenceRoutesHtml).toContain("<code data-reference-library-route=\"dogfood-review\" data-i18n-en=\"Product notes\" data-i18n-zh=\"产品记录\">Product notes</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-reference-library-route=\"candidate-triage\">candidate_triage</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-reference-library-route=\"dogfood-review\">dogfood_report</code>");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Saved Notes\" data-i18n-zh=\"已保存内容\">Saved Notes</strong>");
      expect(referenceRoutesHtml).toContain("<code data-dashboard-detail=\"candidate-triage:index\" data-i18n-en=\"Saved notes\" data-i18n-zh=\"已保存内容\">Saved notes</code>");
      expect(referenceRoutesHtml).not.toContain("<code data-dashboard-detail=\"candidate-triage:index\">candidate_triage</code>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Saved notes indexed\" data-i18n-zh=\"已保存内容已建立索引\">Saved notes indexed</span>");
      expect(referenceRoutesHtml).not.toContain("<span>3 candidates across 1 group indexed</span>");
      expect(referenceRoutesHtml).not.toContain("data-candidate-triage-focus");
      expect(referenceRoutesHtml).not.toContain("Audit focus:");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Safety Checks\" data-i18n-zh=\"安全检查\">Safety Checks</strong>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Safety checks indexed\" data-i18n-zh=\"安全检查已建立索引\">Safety checks indexed</span>");
      expect(referenceRoutesHtml).not.toContain("<span>2 governance notes indexed</span>");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Product Notes\" data-i18n-zh=\"产品记录\">Product Notes</strong>");
      expect(referenceRoutesHtml).toContain("<code data-i18n-en=\"Product notes\" data-i18n-zh=\"产品记录\">Product notes</code>");
      expect(referenceRoutesHtml).not.toContain("<code>dogfood_report</code>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Product notes indexed\" data-i18n-zh=\"产品记录已建立索引\">Product notes indexed</span>");
      expect(referenceRoutesHtml).not.toContain("<span>1 finding indexed</span>");
      expect(referenceRoutesHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"audit-reports\" data-supporting-evidence-summary=\"audit-reports\" data-dashboard-detail=\"supporting-operational-evidence\">");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Cleanup Checks\" data-i18n-zh=\"清理检查\">Cleanup Checks</strong>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Cleanup checks indexed\" data-i18n-zh=\"清理检查已建立索引\">Cleanup checks indexed</span>");
      expect(referenceRoutesHtml).not.toContain("<strong>Audit Reports</strong>");
      expect(referenceRoutesHtml).not.toContain("<span>Lifecycle checks indexed</span>");
      expect(referenceRoutesHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"store-snapshot\" data-supporting-evidence-summary=\"store-snapshot\" data-dashboard-detail=\"supporting-operational-snapshots\">");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"Shared Copy\" data-i18n-zh=\"共享副本\">Shared Copy</strong>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"Shared copy indexed\" data-i18n-zh=\"共享副本已建立索引\">Shared copy indexed</span>");
      expect(referenceRoutesHtml).not.toContain("<strong>Store Snapshot</strong>");
      expect(referenceRoutesHtml).not.toContain("<span>Store signals indexed</span>");
      expect(referenceRoutesHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"raw-store\" data-supporting-evidence-summary=\"raw-store\" data-dashboard-detail=\"debug-inspector\">");
      expect(referenceRoutesHtml).toContain("<strong data-i18n-en=\"History\" data-i18n-zh=\"历史记录\">History</strong>");
      expect(referenceRoutesHtml).toContain("<span data-i18n-en=\"History indexed\" data-i18n-zh=\"历史记录已建立索引\">History indexed</span>");
      expect(referenceRoutesHtml).not.toContain("<strong>Raw Store</strong>");
      expect(referenceRoutesHtml).not.toContain("<span>Raw evidence indexed</span>");
      expect(referenceRoutesHtml).toContain("Raw technical details stay in <code>/api/dashboard</code>.");
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
      expect(html).toContain("<details class=\"panel health-check-panel\" data-dashboard-detail=\"health-check\" data-dashboard-section=\"health-check\">");
      expect(html).toContain("<span data-i18n-en=\"Moryn Health Check\" data-i18n-zh=\"Moryn 健康检查\">Moryn Health Check</span>");
      expect(html).toContain("<small data-i18n-en=\"needs attention | 1 warning\" data-i18n-zh=\"需要看一下 | 1 条提醒\">needs attention | 1 warning</small>");
      expect(html).not.toContain("<small>needs attention | 1 warning | 0 failed</small>");
      expect(data.health_check.checks_by_id.mcp_runtime).toMatchObject({
        label: "MCP runtime freshness",
        summary: "MCP hosts load Moryn when the host process starts.",
        reason: "After upgrading, rebuilding, or linking a local checkout, restart the MCP host if MCP tool output disagrees with the CLI or dashboard."
      });
      expect(html).toContain("<strong data-i18n-en=\"Connection may need restart\" data-i18n-zh=\"连接可能需要重启\" data-health-check-raw-label=\"MCP runtime freshness\">Connection may need restart</strong>");
      expect(html).toContain("<p data-i18n-en=\"Long-running app connections load Moryn when they start.\" data-i18n-zh=\"长时间运行的应用连接会在启动时加载 Moryn。\" data-health-check-raw-summary=\"MCP hosts load Moryn when the host process starts.\">Long-running app connections load Moryn when they start.</p>");
      expect(html).toContain("<small data-i18n-en=\"After an upgrade or local rebuild, restart the connected app if its tool output disagrees with the CLI or dashboard.\" data-i18n-zh=\"升级或本地重建后，如果连接应用的工具输出和 CLI 或 dashboard 不一致，请重启这个应用。\" data-health-check-raw-reason=\"After upgrading, rebuilding, or linking a local checkout, restart the MCP host if MCP tool output disagrees with the CLI or dashboard.\">After an upgrade or local rebuild, restart the connected app if its tool output disagrees with the CLI or dashboard.</small>");
      expect(html).not.toContain("<strong>MCP runtime freshness</strong>");
      expect(html).not.toContain("<p>MCP hosts load Moryn when the host process starts.</p>");
      const healthBriefHtml = html.slice(html.indexOf("<div class=\"health-check-brief\">"), html.indexOf("<dl class=\"health-check-stats\">"));
      expect(healthBriefHtml).toContain("<span data-i18n-en=\"Read-only\" data-i18n-zh=\"只读\">Read-only</span>");
      expect(healthBriefHtml).toContain("<span data-i18n-en=\"4 safe suggestions\" data-i18n-zh=\"4 条安全建议\">4 safe suggestions</span>");
      expect(healthBriefHtml).toContain("<span data-i18n-en=\"1 need input\" data-i18n-zh=\"1 条需要输入\">1 need input</span>");
      expect(healthBriefHtml).not.toContain("moryn dashboard --serve --project-id moryn");
      expect(html).toContain("<dt data-i18n-en=\"Visible records\" data-i18n-zh=\"可见内容\">Visible records</dt>");
      expect(html).toContain("<dt data-i18n-en=\"Private hidden\" data-i18n-zh=\"已隐藏私有内容\">Private hidden</dt>");
      expect(html).toContain("<dt data-i18n-en=\"Events\" data-i18n-zh=\"事件\">Events</dt>");
      expect(html).toContain("<dt data-i18n-en=\"Capture review\" data-i18n-zh=\"待确认捕获内容\">Capture review</dt>");
      expect(html).toContain("<section class=\"health-check-install-trust\" aria-label=\"Install Trust\" data-i18n-aria-label-en=\"Install Trust\" data-i18n-aria-label-zh=\"安装信任说明\">");
      expect(html).toContain("<h4 data-i18n-en=\"Install Trust\" data-i18n-zh=\"安装信任说明\">Install Trust</h4>");
      expect(html).toContain("<p data-i18n-en=\"Review readiness commands before setup\" data-i18n-zh=\"设置前先查看准备命令\">Review readiness commands before setup</p>");
      expect(html).toContain("<strong data-i18n-en=\"Safe to inspect\" data-i18n-zh=\"可安全查看\">Safe to inspect</strong>");
      expect(html).toContain("<span data-i18n-en=\"4 safe checks\" data-i18n-zh=\"4 条安全检查\">4 safe checks</span>");
      expect(html).toContain("<span data-i18n-en=\"1 manual input\" data-i18n-zh=\"1 项需要输入\">1 manual input</span>");
      expect(html).toContain("<span data-i18n-en=\"No host config writes from dashboard\" data-i18n-zh=\"dashboard 不会写入主机配置\">No host config writes from dashboard</span>");
      const installTrustStart = html.indexOf("<section class=\"health-check-install-trust\" aria-label=\"Install Trust\" data-i18n-aria-label-en=\"Install Trust\" data-i18n-aria-label-zh=\"安装信任说明\">");
      const readinessActionsIndex = html.indexOf("data-dashboard-detail=\"health-check-readiness-actions\"");
      expect(installTrustStart).toBeGreaterThan(-1);
      expect(readinessActionsIndex).toBeGreaterThan(installTrustStart);
      const installTrustHtml = html.slice(installTrustStart, readinessActionsIndex);
      expect(installTrustHtml).toContain("Review readiness commands before setup");
      expect(installTrustHtml).not.toContain("moryn install --host codex");
      expect(installTrustHtml).not.toContain("moryn context pack --project-id moryn");
      expect(html).toContain("<details class=\"health-check-readiness-actions\" data-dashboard-detail=\"health-check-readiness-actions\">");
      expect(html).toContain("<span data-i18n-en=\"Setup Commands\" data-i18n-zh=\"设置命令\">Setup Commands</span>");
      expect(html).not.toContain("<span>Readiness Actions</span>");
      expect(html).toContain("<small data-i18n-en=\"4 safe checks | 1 manual input\" data-i18n-zh=\"4 条安全检查 | 1 项需要输入\">4 safe checks | 1 manual input</small>");
      expect(html).not.toContain("<small>4 safe | 1 need input</small>");
      expect(html).toContain("<h4 data-i18n-en=\"Safe checks\" data-i18n-zh=\"安全检查\">Safe checks</h4>");
      expect(html).toContain("<h4 data-i18n-en=\"Manual input\" data-i18n-zh=\"需要输入\">Manual input</h4>");
      expect(html).not.toContain("<h4>Safe to run</h4>");
      expect(html).not.toContain("<h4>Needs input</h4>");
      expect(html).toContain("data-health-check-action=\"review_capture_inbox\"");
      expect(html).toContain("data-health-check-action=\"capture_session\"");
      const reviewActionStart = html.indexOf("data-health-check-action=\"review_capture_inbox\"");
      const reviewActionEnd = html.indexOf("</article>", reviewActionStart);
      expect(reviewActionStart).toBeGreaterThan(-1);
      const reviewActionHtml = html.slice(reviewActionStart, reviewActionEnd);
      expect(reviewActionHtml).not.toContain("<details class=\"health-check-action-command\"");
      expect(reviewActionHtml).not.toContain("<span>CLI command</span>");
      expect(reviewActionHtml).not.toContain("<small>copy from CLI</small>");
      expect(reviewActionHtml).toContain("<span class=\"pill state-canonical\" data-i18n-en=\"Read-only\" data-i18n-zh=\"只读\">Read-only</span>");
      expect(reviewActionHtml).toContain("<small data-i18n-en=\"When Health Check finds capture candidates waiting for explicit review.\" data-i18n-zh=\"当健康检查发现有捕获内容等待明确确认时。\">When Health Check finds capture candidates waiting for explicit review.</small>");
      expect(reviewActionHtml).not.toContain("moryn dashboard --serve --project-id moryn");
      expect(html).not.toContain("moryn install --host codex --sync-remote git@github.com:user/moryn-store.git");
      expect(html).not.toContain("moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task &#39;&lt;current task&gt;&#39; --agent codex");
      expect(data.health_check.suggested_actions.map((action) => action.command)).toEqual(expect.arrayContaining([
        "moryn dashboard --serve --project-id moryn",
        "moryn install --host codex --sync-remote git@github.com:user/moryn-store.git",
        "moryn context pack --project-id moryn --sync-remote git@github.com:user/moryn-store.git --current-task '<current task>' --agent codex"
      ]));
      const captureActionStart = html.indexOf("data-health-check-action=\"capture_session\"");
      const captureActionEnd = html.indexOf("</article>", captureActionStart);
      const captureActionHtml = html.slice(captureActionStart, captureActionEnd);
      expect(captureActionHtml).toContain("<details class=\"health-check-action-command\" data-dashboard-detail=\"health-check-action-command:capture_session\">");
      expect(captureActionHtml).toContain("<span data-i18n-en=\"CLI command\" data-i18n-zh=\"命令行命令\">CLI command</span>");
      expect(captureActionHtml).toContain("<small data-i18n-en=\"copy from CLI\" data-i18n-zh=\"从命令行复制\">copy from CLI</small>");
      expect(captureActionHtml).toContain("<small data-i18n-en=\"At the end of a meaningful agent session, with a user-authored or agent-authored summary.\" data-i18n-zh=\"在一次有意义的 agent 会话结束时，填写用户或 agent 写的总结。\">At the end of a meaningful agent session, with a user-authored or agent-authored summary.</small>");
      expect(captureActionHtml).toContain("moryn capture session --project-id moryn");
      expect(html).toContain("<details class=\"health-check-details\" data-dashboard-detail=\"health-check-details\">");
      expect(html).toContain("<span data-i18n-en=\"Check Details\" data-i18n-zh=\"检查详情\">Check Details</span>");
      expect(html).toContain("<small data-i18n-en=\"4 pass | 4 info | 1 warning\" data-i18n-zh=\"4 项通过 | 4 条信息 | 1 条提醒\">4 pass | 4 info | 1 warning</small>");
      const checkDetailsIndex = html.indexOf("data-dashboard-detail=\"health-check-details\"");
      const healthCheckListIndex = html.indexOf("<div class=\"health-check-list\">", checkDetailsIndex);
      expect(checkDetailsIndex).toBeGreaterThan(readinessActionsIndex);
      expect(healthCheckListIndex).toBeGreaterThan(checkDetailsIndex);
      expect(html.indexOf("Connection may need restart")).toBeGreaterThan(healthCheckListIndex);
      expect(html).toContain("<span class=\"pill warning\" data-i18n-en=\"Requires summary\" data-i18n-zh=\"需要填写 summary\">Requires summary</span>");
      expect(html).toContain("Read-only");
      expect(html.indexOf("data-dashboard-background-shortcuts")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(html.indexOf("data-dashboard-detail=\"evidence-library\"")).toBeLessThan(html.indexOf("data-dashboard-section=\"health-check\""));
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
      const governanceIndexHtml = dashboardDetailBlock(html, "governance-hub");
      expect(governanceIndexHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"governance\" data-dashboard-detail=\"governance-hub\" data-governance-reference data-reference-library-index=\"governance\">");
      expect(governanceIndexHtml).toContain("<strong data-i18n-en=\"Governance Index\" data-i18n-zh=\"治理索引\">Governance Index</strong>");
      expect(governanceIndexHtml).toContain("<span data-i18n-en=\"1 governance note indexed\" data-i18n-zh=\"1 条治理记录已建立索引\">1 governance note indexed</span>");
      expect(governanceIndexHtml).toContain("<code>governance</code>");
      expect(governanceIndexHtml).not.toContain("<article class=\"governance-reference\"");
      expect(html).not.toContain("<details id=\"governance-hub\" class=\"panel governance-hub\" data-dashboard-detail=\"governance-hub\" aria-label=\"Governance Hub\">");
      expect(html).not.toContain("<span>Read-only Governance</span>");
      expect(html).not.toContain("<small>Reference checks</small>");
      expect(html).not.toContain("<span>Governance Hub</span>");
      expect(html).not.toContain("<small>Read-only governance checks</small>");
      expect(html).not.toContain("<small>1 safe check</small>");
      const evidenceReviewGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">");
      const evidenceBackgroundGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-background\" data-dashboard-detail=\"evidence-background-evidence\">");
      const governanceHubIndex = html.indexOf("data-dashboard-detail=\"governance-hub\"");
      const dogfoodReviewIndex = html.indexOf("data-dashboard-detail=\"dogfood-review\"");
      expect(html.indexOf("data-dashboard-background-shortcuts")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(html.indexOf("data-dashboard-detail=\"evidence-library\"")).toBeLessThan(governanceHubIndex);
      expect(evidenceBackgroundGroupIndex).toBe(-1);
      expect(governanceHubIndex).toBeGreaterThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(dogfoodReviewIndex).toBeGreaterThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      const reviewHtml = evidenceReviewGroupIndex === -1 ? "" : html.slice(evidenceReviewGroupIndex, evidenceBackgroundGroupIndex);
      expect(reviewHtml).not.toContain("data-dashboard-detail=\"governance-hub\"");
      expect(reviewHtml).not.toContain("data-dashboard-detail=\"dogfood-review\"");
      expect(html).not.toContain("data-evidence-library-route=\"findings\"");
      expect(html).not.toContain("<span>Review Notes</span>");
      expect(html).not.toContain("<small>Reference notes</small>");
      expect(html).not.toContain("0 need confirmation");
      expect(html).not.toContain("0 private hidden");
      expect(html).not.toContain("<span>0 safe checks</span>");
      expect(html).not.toContain("<div class=\"governance-hub-body\">");
      expect(html).not.toContain("<article class=\"governance-reference\" data-dashboard-detail=\"governance:index\" data-governance-reference>");
      expect(html).toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(html).not.toContain("<span>1 safe check</span>");
      expect(html).not.toContain("<p>Reference checks only</p>");
      expect(html).not.toContain("<p>Read-only inspection index</p>");
      expect(html).not.toContain("<p><code>governance.summary</code></p>");
      expect(html).not.toContain("<details class=\"governance-safe-group\" data-dashboard-detail=\"governance-safe-inspections\">");
      expect(html).not.toContain("<span>Reference Checks</span>");
      expect(html).not.toContain("<small>Read-only, no writes</small>");
      expect(html).not.toContain("<span>Safe Inspections</span>");
      expect(html).not.toContain("<small>Background checks, read-only</small>");
      expect(html).not.toContain("<small>Read-only checks ready</small>");
      expect(html).not.toContain("<small>1 read-only check</small>");
      expect(html).not.toContain("data-governance-item=\"dogfood_report:failure_signals\"");
      expect(html).not.toContain("data-governance-safe-item=\"dogfood_report:failure_signals\"");
      expect(html).not.toContain("<span>Dogfood Review</span>");
      expect(html).not.toContain("<small>Inspect Failure Signals | Read-only</small>");
      const safeRowStart = html.indexOf("data-governance-safe-item=\"dogfood_report:failure_signals\"");
      const safeRow = "";
      expect(safeRowStart).toBe(-1);
      expect(safeRow).not.toContain("<strong>Recent dogfood notes contain failure or timeout language.</strong>");
      expect(safeRow).not.toContain("<details class=\"governance-safe-notes\"");
      expect(safeRow).not.toContain("<span>Audit notes</span>");
      expect(safeRow).not.toContain("dogfood_report.findings_by_id.failure_signals");
      const referenceAuditStart = html.indexOf("<details class=\"governance-reference-audit\" data-dashboard-detail=\"governance-reference-audit\">");
      const referenceAuditHtml = "";
      expect(referenceAuditStart).toBe(-1);
      expect(referenceAuditHtml).not.toContain("<details class=\"governance-reference-audit\" data-dashboard-detail=\"governance-reference-audit\">");
      expect(referenceAuditHtml).not.toContain("<span>Reference audit</span>");
      expect(referenceAuditHtml).not.toContain("<small>Detection, boundary, and evidence</small>");
      expect(referenceAuditHtml).not.toContain("<h4>Failure signals</h4>");
      expect(referenceAuditHtml).not.toContain("Detected: Dogfood notes surfaced product friction worth inspecting.");
      expect(referenceAuditHtml).not.toContain("Recommended next step: inspect_failure_signals.");
      expect(referenceAuditHtml).not.toContain("Write boundary: read-only inspection; no memory writes.");
      expect(referenceAuditHtml).not.toContain("Evidence source: <code>dogfood_report.findings_by_id.failure_signals</code>");
      expect(referenceAuditHtml).not.toContain("<span>Review notes</span>");
      expect(html).not.toContain("data-dashboard-detail=\"governance-notes:");
      expect(safeRow).not.toContain("<details class=\"governance-safe-evidence\">");
      expect(safeRow).not.toContain("<span>Evidence path</span>");
      expect(safeRow).not.toContain("<small>Failure signals</small>");
      expect(safeRow).not.toContain("<summary>Evidence path</summary>");
      expect(safeRow).not.toContain("<small>Inspect Failure Signals | Read-only</small>\n      <code>dogfood_report.findings_by_id.failure_signals</code>");
      expect(html).not.toContain("<section class=\"panel governance-hub\"");
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

      expect(html).toContain("data-governance-safe-item=\"memory_doctor:candidate_backlog\"");
      expect(html).toContain("<span>Memory Doctor</span>");
      expect(html).toContain("<small>Review Candidate Backlog | Read-only</small>");
      expect(html).toContain("<code>memory_doctor.findings_by_id.candidate_backlog</code>");
      const evidenceReviewGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">");
      const evidenceBackgroundGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-background\" data-dashboard-detail=\"evidence-background-evidence\">");
      const candidateTriageIndex = html.indexOf("data-dashboard-detail=\"candidate-triage\"");
      const candidateTriageHtml = dashboardDetailBlock(html, "candidate-triage");
      expect(candidateTriageIndex).toBeGreaterThan(evidenceBackgroundGroupIndex);
      expect(evidenceReviewGroupIndex === -1 || candidateTriageIndex > evidenceReviewGroupIndex).toBe(true);
      const reviewHtml = evidenceReviewGroupIndex === -1 ? "" : html.slice(evidenceReviewGroupIndex, evidenceBackgroundGroupIndex);
      expect(reviewHtml).not.toContain("data-dashboard-detail=\"candidate-triage\"");
      expect(evidenceBackgroundGroupIndex).toBeGreaterThan(evidenceReviewGroupIndex);
      expect(candidateTriageHtml).toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage:index\" data-candidate-triage-reference>");
      expect(candidateTriageHtml).toContain("<strong data-i18n-en=\"Candidate Backlog Index\" data-i18n-zh=\"待整理内容索引\">Candidate Backlog Index</strong>");
      expect(candidateTriageHtml).not.toContain("<strong>Candidate Backlog Index</strong>");
      expect(candidateTriageHtml).toContain("<span>4 candidates across 1 group indexed</span>");
      expect(data.candidate_triage.review_focus?.summary).toBe("Start with Session summaries: Inspect handoff value");
      expect(candidateTriageHtml).toContain("<span data-candidate-triage-focus>Audit focus: Session summaries - Inspect handoff value</span>");
      expect(candidateTriageHtml).not.toContain("<span data-candidate-triage-focus>Start with Session summaries: Inspect handoff value</span>");
      expect(candidateTriageHtml).toContain("<code>candidate_triage</code>");
      expect(candidateTriageHtml).toContain("<p>Open <code>/api/dashboard</code> for candidate groups, record order, evidence paths, and trace commands.</p>");
      expect(candidateTriageHtml).not.toContain("<h2>Candidate Backlog</h2>");
      expect(candidateTriageHtml).not.toContain("<p>Read-only candidate groups; promotion drafts appear as explicit decisions.</p>");
      expect(candidateTriageHtml).not.toContain("candidate-triage-backlog-brief");
      expect(candidateTriageHtml).not.toContain("<h3>Backlog brief</h3>");
      expect(candidateTriageHtml).not.toContain("data-dashboard-detail=\"candidate-triage-backlog-lanes\"");
      expect(candidateTriageHtml).not.toContain("<span>Backlog index</span>");
      expect(candidateTriageHtml).not.toContain("candidate-triage-index-card");
      expect(candidateTriageHtml).not.toContain("<div class=\"candidate-triage-index-list\" aria-label=\"Candidate backlog API index\">");
      expect(candidateTriageHtml).not.toContain("<span>Session summaries</span>");
      expect(candidateTriageHtml).not.toContain("<strong>Handoff evidence</strong>");
      expect(candidateTriageHtml).not.toContain("<small>4 records indexed | Keep as context</small>");
      expect(data.candidate_triage.groups_by_id.session_summaries?.evidence_path).toBe("candidate_triage.groups_by_id.session_summaries");
      expect(candidateTriageHtml).not.toContain("<details class=\"candidate-triage-index-evidence\" data-dashboard-detail=\"candidate-triage-index-evidence:session_summaries\">");
      expect(candidateTriageHtml).not.toContain("<span>Evidence path</span>");
      expect(candidateTriageHtml).not.toContain("<small>API group index</small>");
      expect(candidateTriageHtml).not.toContain("<code>candidate_triage.groups_by_id.session_summaries</code>");
      expect(candidateTriageHtml).not.toContain("<div class=\"candidate-triage-list\">");
      expect(candidateTriageHtml).not.toContain("<details class=\"candidate-triage-group\"");
      expect(candidateTriageHtml).not.toContain("data-dashboard-detail=\"candidate-triage-records:");
      expect(candidateTriageHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:");
      expect(candidateTriageHtml).not.toContain("<span>Record samples</span>");
      expect(candidateTriageHtml).not.toContain("<span>Hidden record index</span>");
      expect(candidateTriageHtml).not.toContain("<span>Candidate Triage</span>");
      expect(candidateTriageHtml).not.toContain("<small>Background candidate audit</small>");
      expect(candidateTriageHtml).not.toContain("<h2>Candidate Triage Queue</h2>");
      expect(candidateTriageHtml).not.toContain("<p>Review grouping for memory doctor backlog.</p>");
      expect(html).not.toContain("data-dashboard-action-id=\"memory_doctor");
      expect(html).not.toContain("Apply Memory Doctor");
      expect(html).not.toContain("Approve Backlog");
      expect(html).not.toContain("Archive Backlog");
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

      const evidenceLibraryDetailIndex = html.indexOf("data-dashboard-detail=\"evidence-library\"");
      const evidenceReviewGroupPanel = "<details class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">";
      const evidenceReviewGroupIndex = html.indexOf(evidenceReviewGroupPanel);
      const evidenceBackgroundGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-background\" data-dashboard-detail=\"evidence-background-evidence\">");
      const captureInboxIndex = html.indexOf("data-dashboard-detail=\"capture-inbox\"");
      const candidateTriageIndex = html.indexOf("data-dashboard-detail=\"candidate-triage\"");
      expect(candidateTriageIndex).toBeGreaterThan(evidenceReviewGroupIndex);
      expect(candidateTriageIndex).toBeLessThan(evidenceBackgroundGroupIndex);
      expect(candidateTriageIndex).toBeGreaterThan(evidenceLibraryDetailIndex);
      expect(candidateTriageIndex).toBeGreaterThan(captureInboxIndex);
      expect(html.slice(0, evidenceLibraryDetailIndex)).not.toContain("data-dashboard-detail=\"candidate-triage\"");
      expect(html).not.toContain("<div class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">");
      expect(html).not.toContain("<details open class=\"evidence-library-group evidence-library-review\"");
      expect(html).toContain("<details class=\"panel candidate-triage\" data-dashboard-detail=\"candidate-triage\" aria-label=\"Candidate Triage Queue\">");
      expect(html).toContain("<span>Candidate Triage</span>");
      expect(html).toContain("<small>1 promotion draft waiting</small>");
      expect(html).not.toContain("<small>Review candidate backlog</small>");
      expect(html).not.toContain("<small>Background candidate audit</small>");
      expect(html).toContain("<section id=\"decision-summary\" class=\"panel decision-summary\" data-dashboard-detail=\"decision-summary\" aria-label=\"Decision Summary\">");
      expect(html).toContain("<span>1 Candidate Triage</span>");
      const decisionSummaryStart = html.indexOf("data-dashboard-detail=\"decision-summary\"");
      const decisionSummaryEnd = html.indexOf("data-dashboard-detail=\"evidence-library\"", decisionSummaryStart);
      const decisionSummaryHtml = html.slice(decisionSummaryStart, decisionSummaryEnd);
      expect(decisionSummaryHtml).toContain("<strong>Candidate Triage</strong>");
      expect(decisionSummaryHtml).toContain("1 explicit approval waiting in Candidate Triage.");
      expect(decisionSummaryHtml).toContain("data-decision-summary-route=\"candidate-triage\"");
      expect(decisionSummaryHtml).toContain("data-action-board-target=\"candidate-triage\"");
      expect(decisionSummaryHtml).toContain("<small>Append-only, guarded in owning surface</small>");
      expect(decisionSummaryHtml).not.toContain("<span>Approve Memory</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Append-only events</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Active candidate guard</span>");
      expect(decisionSummaryHtml).not.toContain("<span>approval required</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Audit evidence</span>");
      expect(decisionSummaryHtml).not.toContain("candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.rec_candidate_triage_3");
      expect(html).not.toContain("<small>4 candidates grouped for review</small>");
      expect(html).toContain("<h2>Candidate Triage Queue</h2>");
      expect(html).toContain("<span>4 candidates</span>");
      expect(html).toContain("<span>4 groups</span>");
      expect(data.candidate_triage.summary.shown_records).toBe(4);
      expect(html).not.toContain("<span>4 shown records</span>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Candidate group: Likely noise, 1 record, Inspect likely noise before archive\">");
      expect(html).toContain("<span>Likely noise</span>");
      expect(html).toContain("<strong>Likely noise</strong>");
      expect(html).toContain("<small>Review before archive</small>");
      expect(html).not.toContain("<strong>Audit only</strong>");
      expect(html).not.toContain("<strong>Archive review</strong>");
      expect(html).not.toContain("<small>Records indexed</small>");
      expect(html).not.toContain("<strong>1 record</strong>");
      expect(html).not.toContain("<small>Review path ready</small>");
      expect(html).not.toContain("<small>Inspect likely noise before archive</small>");
      expect(html).toContain("<details class=\"candidate-triage-group-details\" data-dashboard-detail=\"candidate-triage-details:likely_noise\">");
      expect(html).toContain("<span>Triage details</span>");
      expect(html).toContain("<small>Review path, audit notes, samples</small>");
      const likelyNoiseGroupStart = html.indexOf("data-dashboard-detail=\"candidate-triage:likely_noise\"");
      const likelyNoiseDetailsStart = html.indexOf("data-dashboard-detail=\"candidate-triage-details:likely_noise\"", likelyNoiseGroupStart);
      expect(likelyNoiseGroupStart).toBeGreaterThan(-1);
      expect(likelyNoiseDetailsStart).toBeGreaterThan(likelyNoiseGroupStart);
      const likelyNoiseGroupFace = html.slice(likelyNoiseGroupStart, likelyNoiseDetailsStart);
      expect(likelyNoiseGroupFace).not.toContain("Group context");
      expect(likelyNoiseGroupFace).not.toContain("<span>Review path</span>");
      expect(likelyNoiseGroupFace).not.toContain("Audit boundary");
      expect(likelyNoiseGroupFace).not.toContain("Record samples");
      const likelyNoiseReviewPathStart = html.indexOf("data-dashboard-detail=\"candidate-triage-review-path:likely_noise\"", likelyNoiseGroupStart);
      const likelyNoiseAuditNotesStart = html.indexOf("data-dashboard-detail=\"candidate-triage-audit-notes:likely_noise\"", likelyNoiseGroupStart);
      const likelyNoiseContextStart = html.indexOf("data-dashboard-detail=\"candidate-triage-context:likely_noise\"", likelyNoiseGroupStart);
      const likelyNoiseAuditBoundaryStart = html.indexOf("data-dashboard-detail=\"candidate-triage-audit:likely_noise\"", likelyNoiseGroupStart);
      const likelyNoiseRecordsStart = html.indexOf("data-dashboard-detail=\"candidate-triage-records:likely_noise\"", likelyNoiseGroupStart);
      expect(likelyNoiseReviewPathStart).toBeGreaterThan(likelyNoiseDetailsStart);
      expect(likelyNoiseAuditNotesStart).toBeGreaterThan(likelyNoiseReviewPathStart);
      expect(likelyNoiseContextStart).toBeGreaterThan(likelyNoiseAuditNotesStart);
      expect(likelyNoiseAuditBoundaryStart).toBeGreaterThan(likelyNoiseContextStart);
      expect(likelyNoiseRecordsStart).toBeGreaterThan(likelyNoiseAuditBoundaryStart);
      expect(html).toContain("<details class=\"candidate-triage-audit-notes\" data-dashboard-detail=\"candidate-triage-audit-notes:likely_noise\">");
      expect(html).toContain("<span>Audit notes</span>");
      expect(html).toContain("<small>Context and boundary</small>");
      expect(html).toContain("<details class=\"candidate-triage-group-context\" data-dashboard-detail=\"candidate-triage-context:likely_noise\">");
      expect(html).toContain("<span>Group context</span>");
      expect(html).toContain("<small>Likely noise, 1 record</small>");
      expect(html).toContain("<p>Candidates that look like smoke/test output or marker records.</p>");
      expect(html).not.toContain("<div class=\"candidate-triage-group-body\">\n        <p>Candidates that look like smoke/test output or marker records.</p>");
      expect(html).toContain("<details class=\"candidate-triage-review-path\" data-dashboard-detail=\"candidate-triage-review-path:likely_noise\" data-candidate-triage-handoff=\"likely_noise\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Review path: Archive review via Capture Inbox or Memory Doctor\">");
      expect(html).toContain("<span>Review path</span>");
      expect(html).toContain("<small>Archive review</small>");
      expect(html).not.toContain("<small>Archive review via Capture Inbox or Memory Doctor</small>");
      expect(html).not.toContain("<div class=\"candidate-triage-handoff\" data-candidate-triage-handoff=\"likely_noise\">");
      expect(html).not.toContain("<h4>Review handoff</h4>");
      expect(html).toContain("<dt>Existing control</dt><dd>Capture Inbox or Memory Doctor</dd>");
      expect(html).toContain("<dt>Write boundary</dt><dd>Review first; approve only through draft rows</dd>");
      expect(html).not.toContain("Candidate Triage is read-only");
      expect(html).toContain("Reject eligible Capture Inbox candidates; archive confirmed noise only through explicit Memory Doctor guidance.");
      expect(html).toContain("<details class=\"candidate-triage-record-samples\" data-dashboard-detail=\"candidate-triage-records:likely_noise\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Record samples: Likely noise: 1 sample with trace commands\">");
      expect(html).toContain("<span>Record samples</span>");
      expect(html).toContain("<small>1 sample, trace ready</small>");
      expect(html).not.toContain("<small>Likely noise: 1 sample with trace commands</small>");
      expect(html).toContain("<summary class=\"candidate-triage-record-summary\" aria-label=\"Session summary sample rec_candidate_triage_2 from Codex, ");
      expect(html).toContain("<strong>Sample</strong>");
      expect(html).not.toContain("<strong>Sample rec_candidate_triage_2</strong>");
      expect(html).toContain("<small>Trace ready</small>");
      expect(html).not.toContain("<small>Codex | ");
      expect(html).toContain("<span class=\"candidate-triage-record-meta\">Session Summary</span>");
      expect(html).toContain("<summary class=\"candidate-triage-record-summary\" aria-label=\"Memory sample rec_candidate_triage_3 from Codex, ");
      expect(html).not.toContain("<strong>Sample rec_candidate_triage_3</strong>");
      expect(html).toContain("<span class=\"candidate-triage-record-meta\">Memory</span>");
      expect(html).not.toContain("<strong>Session summary sample rec_candidate_triage_2</strong>");
      expect(html).not.toContain("<strong>Memory sample rec_candidate_triage_3</strong>");
      expect(html).toContain("<div><dt>Content</dt><dd>Smoke marker from dashboard test.</dd></div>");
      expect(html).toContain("<div><dt>Content</dt><dd>Always keep dashboard governance readable.</dd></div>");
      expect(html).not.toContain("<dt>Text</dt>");
      expect(html).not.toContain("<strong>Smoke marker from dashboard test.</strong>");
      expect(html).not.toContain("<strong>Always keep dashboard governance readable.</strong>");
      expect(html).toContain("<span>Promotable candidates</span>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Candidate group: Promotable candidates, 1 record, Inspect before promotion\">");
      expect(html).toContain("<strong>Approval review</strong>");
      expect(html).not.toContain("<small>Inspect before promotion</small>");
      expect(html).toContain("<details class=\"candidate-triage-group-context\" data-dashboard-detail=\"candidate-triage-context:promotable\">");
      expect(html).toContain("<small>Promotable candidates, 1 record</small>");
      expect(html).toContain("<p>High-confidence candidate memories that may deserve explicit promotion.</p>");
      expect(html).toContain("<details class=\"candidate-triage-review-path\" data-dashboard-detail=\"candidate-triage-review-path:promotable\" data-candidate-triage-handoff=\"promotable\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Review path: Approval review via Capture Inbox\">");
      expect(html).toContain("<small>Approval review</small>");
      expect(html).not.toContain("<small>Approval review via Capture Inbox</small>");
      expect(html).toContain("<dt>Existing control</dt><dd>Capture Inbox</dd>");
      expect(html).toContain("Approve eligible Capture Inbox candidates only after checking provenance and record text.");
      expect(html).toContain("<details class=\"candidate-triage-promotion-drafts\" data-dashboard-detail=\"candidate-triage-promotion-drafts:promotable\">");
      expect(html).toContain("<span>Promotion draft</span>");
      expect(html).toContain("<small>1 candidate ready</small>");
      const promotionDraftStart = html.indexOf("data-candidate-triage-promotion-draft=\"rec_candidate_triage_3\"");
      const promotionActionsStart = html.indexOf("<div class=\"candidate-triage-promotion-actions\">", promotionDraftStart);
      expect(promotionDraftStart).toBeGreaterThan(-1);
      expect(promotionActionsStart).toBeGreaterThan(promotionDraftStart);
      const promotionDraftHtml = html.slice(promotionDraftStart, promotionActionsStart);
      expect(promotionDraftHtml).toContain("data-candidate-triage-approval-brief");
      expect(promotionDraftHtml).toContain("<h4>Approval brief</h4>");
      expect(promotionDraftHtml).toContain("<dt>Change</dt><dd>Promote 1 candidate</dd>");
      expect(promotionDraftHtml).toContain("<dt>Scope</dt><dd>rec_candidate_triage_3 to canonical</dd>");
      expect(promotionDraftHtml).toContain("<dt>Guard</dt><dd>Server rechecks active candidate before writing</dd>");
      expect(promotionDraftHtml).toContain("<dt>Writes</dt><dd>Approve Memory appends an append-only promotion event</dd>");
      expect(promotionDraftHtml).not.toContain("<dt>Target</dt><dd>canonical</dd>");
      expect(promotionDraftHtml).not.toContain("<dt>Confirmation</dt><dd>User approval required</dd>");
      expect(promotionDraftHtml).not.toContain("<dt>Write</dt><dd>append-only promotion event</dd>");
      expect(html).toContain("<details class=\"candidate-triage-promotion-evidence\" data-dashboard-detail=\"candidate-triage-promotion-evidence:rec_candidate_triage_3\">");
      expect(html).toContain("<span>Draft evidence</span>");
      expect(html).toContain("<small>Command and source</small>");
      expect(html).toContain("<code>moryn promote rec_candidate_triage_3 --state canonical --reason &#39;User approved Candidate Triage promotion draft.&#39; --confirm</code>");
      expect(html).toContain("<code>candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.rec_candidate_triage_3</code>");
      expect(html).toContain("data-candidate-triage-promotion-approve");
      expect(html).toContain("data-dashboard-action-id=\"candidate_triage.promotion.approve.rec_candidate_triage_3\"");
      expect(html).toContain("data-endpoint=\"api/candidate-triage/promotions/rec_candidate_triage_3/approve\"");
      expect(html).toContain(">Approve Memory</button>");
      expect(html).toContain("data-candidate-triage-promotion-status");
      expect(html).not.toContain("data-dashboard-detail=\"candidate-triage-promotion-drafts:likely_noise\"");
      expect(html).toContain(".candidate-triage-review-path {");
      expect(html).toContain(".candidate-triage-review-path dl {");
      expect(html).toContain("<details class=\"candidate-triage-audit-boundary\" data-dashboard-detail=\"candidate-triage-audit:likely_noise\">");
      expect(html).toContain("<span>Audit boundary</span>");
      expect(html).toContain("<small>Likely noise audit boundary</small>");
      expect(html).toContain("<small>Promotable candidates audit boundary</small>");
      expect(html).toContain("<dt>Write boundary</dt><dd>Draft approve appends promotion events only</dd>");
      expect(html).toContain("<dt>Confirmation</dt><dd>User approval required for promotion drafts</dd>");
      expect(html).not.toContain("<dt>Write boundary</dt><dd>No memory writes</dd>");
      expect(html).not.toContain("<dt>Confirmation</dt><dd>Inspection only</dd>");
      expect(html).not.toContain("<small>Read-only evidence and confirmation</small>");
      expect(html).toContain("<code>candidate_triage.groups_by_id.likely_noise</code>");
      expect(html).not.toContain("<dl class=\"candidate-triage-brief\">");
      expect(html).toContain("<details class=\"candidate-triage-record-samples\" data-dashboard-detail=\"candidate-triage-records:promotable\">");
      expect(html).toContain("<span>Session summaries</span>");
      expect(html).toContain("<strong>Handoff evidence</strong>");
      expect(html).toContain("<small>Keep as context</small>");
      expect(html).toContain("<span>Needs inspection</span>");
      expect(html).toContain("<strong>Needs inspection</strong>");
      expect(html).toContain("<small>Timeline check</small>");
      expect(html).toContain("<code>rec_candidate_triage_2</code>");
      expect(html).toContain("<code>rec_candidate_triage_3</code>");
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

      const groupHtml = dashboardDetailBlock(html, "candidate-triage");
      expect(groupHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"candidate-triage\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(groupHtml).toContain("<strong data-i18n-en=\"Candidate Backlog Index\" data-i18n-zh=\"待整理内容索引\">Candidate Backlog Index</strong>");
      expect(groupHtml).not.toContain("<strong>Candidate Backlog Index</strong>");
      expect(groupHtml).toContain("<span>7 candidates across 1 group indexed</span>");
      expect(groupHtml).toContain("<span data-candidate-triage-focus>Audit focus: Needs inspection - Inspect timeline</span>");
      expect(groupHtml).not.toContain("<span data-candidate-triage-focus>Start with Needs inspection: Inspect timeline</span>");
      expect(groupHtml).toContain("<code data-dashboard-detail=\"candidate-triage:index\">candidate_triage</code>");
      expect(groupHtml).not.toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(groupHtml).not.toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage:index\" data-candidate-triage-reference>");
      expect(groupHtml).not.toContain("candidate-triage-index-card");
      expect(groupHtml).not.toContain("<span>Needs inspection</span>");
      expect(groupHtml).not.toContain("<strong>Needs inspection</strong>");
      expect(groupHtml).not.toContain("<small>7 records indexed | Timeline check</small>");
      expect(data.candidate_triage.groups_by_id.needs_inspection?.evidence_path).toBe("candidate_triage.groups_by_id.needs_inspection");
      expect(groupHtml).not.toContain("<details class=\"candidate-triage-index-evidence\" data-dashboard-detail=\"candidate-triage-index-evidence:needs_inspection\">");
      expect(groupHtml).not.toContain("<span>Evidence path</span>");
      expect(groupHtml).not.toContain("<small>API group index</small>");
      expect(groupHtml).not.toContain("<code>candidate_triage.groups_by_id.needs_inspection</code>");
      expect(groupHtml).not.toContain("<strong>Audit only</strong>");
      expect(groupHtml).not.toContain("<strong>Inspection review</strong>");
      expect(groupHtml).not.toContain("<small>Records indexed</small>");
      expect(groupHtml).not.toContain("<strong>7 records</strong>");
      expect(groupHtml).not.toContain("<small>Review path ready</small>");
      expect(groupHtml).not.toContain("<small>Inspect timeline</small>");
      expect(groupHtml).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Review path: Inspection review via Timeline, recall, or Capture Inbox\">");
      expect(groupHtml).not.toContain("<small>Inspection review</small>");
      expect(groupHtml).not.toContain("<small>Needs inspection, 7 records</small>");
      expect(groupHtml).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Record samples: Needs inspection: 3 of 7 samples with trace commands\">");
      expect(groupHtml).not.toContain("<small>3 samples, trace ready</small>");
      expect(groupHtml).not.toContain("<small>Needs inspection: 3 of 7 samples with trace commands</small>");
      expect(groupHtml).not.toContain("<small>5 of 7 samples with trace commands</small>");
      expect(groupHtml).not.toContain("<summary class=\"candidate-triage-record-summary\" aria-label=\"Agent note sample rec_budgeted_triage_8 from Codex, 19d ago\">");
      expect(groupHtml).not.toContain("<strong>Sample</strong>");
      expect(groupHtml).not.toContain("<strong>Sample rec_budgeted_triage_8</strong>");
      expect(groupHtml).not.toContain("<small>Trace ready</small>");
      expect(groupHtml).not.toContain("<small>Codex | 19d ago</small>");
      expect(groupHtml).not.toContain("<summary class=\"candidate-triage-record-summary\" aria-label=\"Agent note sample rec_budgeted_triage_7 from Codex, 19d ago\">");
      expect(groupHtml).not.toContain("<strong>Sample rec_budgeted_triage_7</strong>");
      expect(groupHtml).not.toContain("<strong>Agent note sample rec_budgeted_triage_8</strong>");
      expect(groupHtml).not.toContain("<strong>Agent note sample rec_budgeted_triage_7</strong>");
      expect(groupHtml).not.toContain("<strong>Agent note sample</strong>");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_8\"");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_7\"");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_6\"");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_5\"");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_4\"");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_3\"");
      expect(groupHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:rec_budgeted_triage_2\"");
      expect(groupHtml).not.toContain("<span class=\"candidate-triage-overflow-count\">4 more records indexed</span>");
      expect(groupHtml).not.toContain("indexed in API evidence");
      expect(groupHtml).not.toContain("<span>More samples</span>");
      expect(groupHtml).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"More samples: Needs inspection: 4 hidden with record index available\">");
      expect(groupHtml).not.toContain("<small>4 hidden, indexed</small>");
      expect(groupHtml).not.toContain("<p>Open the hidden record index when the displayed samples are not enough.</p>");
      expect(groupHtml).not.toContain("hidden in API index and Raw Store");
      expect(groupHtml).not.toContain("Use the API index or Raw Store when the displayed samples are not enough.");
      expect(groupHtml).not.toContain("<small>Needs inspection: 4 hidden in API and Raw Store</small>");
      expect(groupHtml).not.toContain("<small>Full group available in API and Raw Store</small>");
      expect(groupHtml).not.toContain("<span>Hidden record index</span>");
      expect(groupHtml).not.toContain("<span>API evidence path</span>");
      expect(groupHtml).not.toContain("<small>Needs inspection index</small>");
      expect(groupHtml).not.toContain("<code>candidate_triage.groups_by_id.needs_inspection.records_by_id</code>");
      expect(groupHtml).not.toContain("Full group stays in <code>candidate_triage.groups_by_id.needs_inspection.records[]</code> and Raw Store.");
      expect(groupHtml).not.toContain("Full group available in API and Raw Inspector");
      expect(groupHtml).not.toContain("data-dashboard-action-id=\"candidate-triage");
      expect(groupHtml).not.toContain("Approve Triage");
      expect(groupHtml).not.toContain("Archive Group");
      expect(groupHtml).not.toContain("Promote Selected");
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
      const groupHtml = dashboardDetailBlock(html, "candidate-triage");
      expect(groupHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"candidate-triage\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(groupHtml).toContain("<span>2 candidates across 1 group indexed</span>");
      expect(data.candidate_triage.review_focus?.summary).toBe("Start with Needs inspection: Inspect timeline");
      expect(groupHtml).toContain("<span data-candidate-triage-focus>Audit focus: Needs inspection - Inspect timeline</span>");
      expect(groupHtml).not.toContain("<span data-candidate-triage-focus>Start with Needs inspection: Inspect timeline</span>");
      expect(groupHtml).not.toContain("candidate-triage-index-card");
      expect(groupHtml).not.toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(data.candidate_triage.groups_by_id.needs_inspection?.evidence_path).toBe("candidate_triage.groups_by_id.needs_inspection");
      expect(groupHtml).not.toContain("<details class=\"candidate-triage-index-evidence\" data-dashboard-detail=\"candidate-triage-index-evidence:needs_inspection\">");
      expect(groupHtml).not.toContain("<span>Evidence path</span>");
      expect(groupHtml).not.toContain("<code>candidate_triage.groups_by_id.needs_inspection</code>");
      expect(groupHtml).not.toContain("<summary class=\"candidate-triage-record-summary\" aria-label=\"Memory sample rec_abcdef12 from Codex, 19d ago\">");
      expect(groupHtml).not.toContain("<strong>Sample</strong>");
      expect(groupHtml).not.toContain("<strong>Sample rec_abcdef12</strong>");
      expect(groupHtml).not.toContain(`<strong>Sample ${generatedId}</strong>`);
      expect(groupHtml).not.toContain("<strong>Memory sample rec_abcdef12</strong>");
      expect(groupHtml).not.toContain(`<strong>Memory sample ${generatedId}</strong>`);
      expect(groupHtml).not.toContain("<summary class=\"candidate-triage-record-summary\" aria-label=\"Agent note sample rec_candidate_short_context from Codex, 19d ago\">");
      expect(groupHtml).not.toContain("<strong>Sample rec_candidate_short_context</strong>");
      expect(groupHtml).not.toContain("<strong>Agent note sample rec_candidate_short_context</strong>");
      expect(groupHtml).not.toContain(`<div><dt>Record</dt><dd><code>${generatedId}</code></dd></div>`);
      expect(groupHtml).not.toContain(`moryn timeline --record-id ${generatedId}`);
      expect(groupHtml).not.toContain(`moryn recall --record-id ${generatedId}`);
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
      expect(html).toContain("Governance Hub");
      const dogfoodPanelStart = html.indexOf("<details class=\"panel dogfood-review\" data-dashboard-detail=\"dogfood-review\" aria-label=\"Dogfood Notes\">");
      const dogfoodPanelBody = html.indexOf("<div class=\"dogfood-review-body\">", dogfoodPanelStart);
      const dogfoodPanelSummary = html.slice(dogfoodPanelStart, dogfoodPanelBody);
      expect(dogfoodPanelStart).toBeGreaterThan(-1);
      expect(dogfoodPanelSummary).toContain("<span>Dogfood Notes</span>");
      expect(dogfoodPanelSummary).toContain("<small>Read-only notes</small>");
      expect(dogfoodPanelSummary).not.toContain("<span>Dogfood Review</span>");
      expect(dogfoodPanelSummary).not.toContain("<small>Read-only dogfood findings</small>");
      expect(dogfoodPanelSummary).not.toContain("<small>2 findings | 2 safe steps | read-only</small>");
      const dogfoodPanelEnd = html.indexOf("<details class=\"panel supporting-evidence\"", dogfoodPanelStart);
      const dogfoodPanelHtml = html.slice(dogfoodPanelStart, dogfoodPanelEnd);
      expect(dogfoodPanelHtml).toContain("<strong class=\"warning\">Note</strong>");
      expect(dogfoodPanelHtml).not.toContain("<strong class=\"warning\">Warning</strong>");
      expect(dogfoodPanelHtml).toContain("<article class=\"dogfood-review-reference\" data-dashboard-detail=\"dogfood-review:index\" data-dogfood-review-reference>");
      expect(dogfoodPanelHtml).toContain("<strong>Dogfood Notes Index</strong>");
      expect(dogfoodPanelHtml).toContain("<span>2 findings indexed</span>");
      expect(dogfoodPanelHtml).toContain("<code>dogfood_report</code>");
      expect(dogfoodPanelHtml).toContain("<p>Open <code>/api/dashboard</code> for dogfood findings, impact notes, evidence paths, affected records, and safe inspection commands.</p>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary evidence-library-fold\" aria-label=\"Reference Library: Read-only reference material\">");
      expect(html).toContain("<span>Reference Library</span>");
      expect(html).toContain("<small>Audit evidence only</small>");
      expect(html).not.toContain("<small>Reference material</small>");
      expect(html).not.toContain("<span>Read-only Evidence</span>");
      expect(html).not.toContain("<small>Read-only findings and reference evidence</small>");
      expect(html).not.toContain("<small>Findings and references</small>");
      expect(html).not.toContain("<small>1 finding group / 1 reference group</small>");
      expect(html).not.toContain("<small>Read-only diagnostics grouped here</small>");
      const evidenceLibraryDetailIndex = html.indexOf("data-dashboard-detail=\"evidence-library\"");
      const evidenceBriefIndex = html.indexOf("<div class=\"evidence-library-brief\" data-evidence-library-brief>", evidenceLibraryDetailIndex);
      const evidenceReviewGroupPanel = "<details class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">";
      const evidenceReviewGroupIndex = html.indexOf(evidenceReviewGroupPanel);
      const evidenceBackgroundGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-background\" data-dashboard-detail=\"evidence-background-evidence\">");
      const dogfoodReviewIndex = html.indexOf("data-dashboard-detail=\"dogfood-review\"");
      const governanceHubIndex = html.indexOf("id=\"governance-hub\"");
      const candidateTriageIndex = html.indexOf("data-dashboard-detail=\"candidate-triage\"");
      expect(data.decision_summary.total_decisions).toBeGreaterThan(0);
      expect(evidenceBriefIndex).toBe(-1);
      expect(html).not.toContain("data-evidence-library-brief");
      expect(html).not.toContain("<h3>Evidence index</h3>");
      expect(html).not.toContain("<div class=\"evidence-library-routebar\" role=\"list\" aria-label=\"Evidence index\">");
      expect(html).not.toContain("class=\"evidence-library-route\" data-evidence-library-route=\"findings\"");
      expect(evidenceReviewGroupIndex).toBeGreaterThan(evidenceLibraryDetailIndex);
      expect(evidenceBackgroundGroupIndex).toBeGreaterThan(evidenceReviewGroupIndex);
      expect(html).not.toContain("<div class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">");
      expect(html).not.toContain("<details open class=\"evidence-library-group evidence-library-review\"");
      expect(dogfoodReviewIndex).toBeGreaterThan(evidenceBackgroundGroupIndex);
      expect(governanceHubIndex).toBeGreaterThan(evidenceReviewGroupIndex);
      expect(governanceHubIndex).toBeLessThan(evidenceBackgroundGroupIndex);
      expect(html.slice(evidenceReviewGroupIndex, evidenceBackgroundGroupIndex)).not.toContain("data-dashboard-detail=\"dogfood-review\"");
      expect(candidateTriageIndex).toBeGreaterThan(evidenceBackgroundGroupIndex);
      expect(html.slice(evidenceReviewGroupIndex, evidenceBackgroundGroupIndex)).not.toContain("data-dashboard-detail=\"candidate-triage\"");
      expect(html).toContain("<span data-i18n-en=\"Review Notes\" data-i18n-zh=\"审查记录\">Review Notes</span>");
      expect(html).not.toContain("<span>Review Notes</span>");
      expect(html).not.toContain("<span>Read-only Notes</span>");
      expect(html).not.toContain("<h3>Evidence map</h3>");
      expect(html).not.toContain("<h3>Evidence routes</h3>");
      expect(html).not.toContain("<div class=\"evidence-library-brief-grid\">");
      expect(html).toContain("<small data-i18n-en=\"Reference notes\" data-i18n-zh=\"参考记录\">Reference notes</small>");
      expect(html).not.toContain("<small>Reference notes</small>");
      expect(html).not.toContain("<span>Reference Findings</span>");
      expect(html).not.toContain("<span>Read-only Findings</span>");
      expect(html).not.toContain("<small>Findings to inspect</small>");
      expect(html).not.toContain("inspection panels</small>");
      expect(html).not.toContain("<span>Inspection Evidence</span>");
      expect(html).not.toContain("<span>Review Evidence</span>");
      expect(html).toContain("<span data-i18n-en=\"Routine Reference\" data-i18n-zh=\"日常参考\">Routine Reference</span>");
      expect(html).not.toContain("<span>Routine Reference</span>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary evidence-library-group-heading\" aria-label=\"Routine Reference: Routine checks and audit trail\">");
      expect(html).toContain("<small data-i18n-en=\"Checks and audit\" data-i18n-zh=\"检查和追踪\">Checks and audit</small>");
      expect(html).not.toContain("<small>Checks and audit</small>");
      const evidenceBackgroundGroupHtml = html.slice(evidenceBackgroundGroupIndex, dogfoodReviewIndex);
      expect(evidenceBackgroundGroupHtml).toContain("<button type=\"button\" class=\"routine-diagnostics-route info\" data-dashboard-detail=\"recall-eval\"");
      expect(evidenceBackgroundGroupHtml).toContain("<span data-i18n-en=\"Recall Eval\" data-i18n-zh=\"召回检查\">Recall Eval</span>");
      expect(evidenceBackgroundGroupHtml).toContain("<button type=\"button\" class=\"routine-diagnostics-route good\" data-dashboard-detail=\"context-pack-review\"");
      expect(evidenceBackgroundGroupHtml).toContain("<span data-i18n-en=\"Context Pack Review\" data-i18n-zh=\"交接上下文\">Context Pack Review</span>");
      expect(evidenceBackgroundGroupHtml).not.toContain("<span>Recall Eval</span>");
      expect(evidenceBackgroundGroupHtml).not.toContain("<span>Context Pack Review</span>");
      expect(html).not.toContain("<span>Reference Evidence</span>");
      expect(html).not.toContain("<small>Routine checks and audit trail</small>");
      expect(html).not.toContain("reference panels</small>");
      expect(html).not.toContain("<span>Background Evidence</span>");
      expect(dogfoodPanelHtml).not.toContain("data-dogfood-review-item=\"capture_review_backlog\"");
      expect(dogfoodPanelHtml).not.toContain("data-dogfood-review-item=\"failure_signals\"");
      expect(dogfoodPanelHtml).not.toContain("<details class=\"dogfood-note-details\" data-dashboard-detail=\"dogfood-note:failure_signals\">");
      expect(dogfoodPanelHtml).not.toContain("<span>Note Details</span>");
      expect(dogfoodPanelHtml).not.toContain("<small>1 record | inspect_failure_signals</small>");
      const dogfoodFindingStart = html.indexOf("data-dogfood-review-item=\"failure_signals\"");
      const dogfoodDetailsHtml = dogfoodPanelHtml;
      expect(dogfoodFindingStart).toBe(-1);
      expect(dogfoodDetailsHtml).not.toContain("<h4>Issue brief</h4>");
      expect(dogfoodDetailsHtml).not.toContain("<dt>Impact</dt><dd>1 active record mention failure, timeout, blocked, or similar friction.</dd>");
      expect(dogfoodDetailsHtml).not.toContain("<dt>Impact</dt><dd>2 autocapture/review candidate records are active.</dd>");
      expect(dogfoodDetailsHtml).not.toContain("<dt>Read-only next step</dt><dd>inspect_failure_signals</dd>");
      expect(dogfoodDetailsHtml).not.toContain("<dt>Evidence</dt><dd><code>dogfood_report.findings_by_id.failure_signals</code></dd>");
      expect(dogfoodDetailsHtml).not.toContain("<code>moryn timeline --record-id rec_governance_item_6 --project-id moryn --before 3 --after 3</code>");
      expect(JSON.stringify(data.governance)).toContain("dogfood_report.findings_by_id.failure_signals");
      expect(JSON.stringify(data.dogfood_report)).toContain("moryn timeline --record-id rec_governance_item_6 --project-id moryn --before 3 --after 3");
      expect(html).not.toContain("<code>moryn dashboard --serve --project-id moryn</code>");
      expect(html).toContain("<details class=\"governance-item");
      expect(html).toContain("data-dashboard-detail=\"governance:capture_policy:review_required\"");
      expect(html).toContain("<details class=\"governance-safe-group\" data-dashboard-detail=\"governance-safe-inspections\">");
      expect(html).toContain("<span data-i18n-en=\"Safe Inspections\" data-i18n-zh=\"安全检查\">Safe Inspections</span>");
      expect(html).toContain("<small data-i18n-en=\"Background checks, read-only\" data-i18n-zh=\"后台检查，只读\">Background checks, read-only</small>");
      expect(html).not.toContain("<span>Safe Inspections</span>");
      expect(html).not.toContain("<small>Background checks, read-only</small>");
      expect(html).not.toContain("<small>Read-only checks ready</small>");
      expect(html).not.toContain("<small>5 read-only checks</small>");
      expect(html).toContain("<div class=\"governance-safe-list\" data-governance-safe-list>");
      expect(html).toContain("class=\"governance-safe-row warning\" data-dashboard-detail=\"governance:memory_doctor:candidate_backlog\"");
      expect(html).toContain("class=\"governance-safe-row info\" data-dashboard-detail=\"governance:capture_policy:auto_captured\"");
      expect(html).toContain("class=\"governance-safe-row warning\" data-dashboard-detail=\"governance:dogfood_report:failure_signals\"");
      const memoryDoctorSafeRowStart = html.indexOf("data-governance-safe-item=\"memory_doctor:candidate_backlog\"");
      const memoryDoctorSafeRowEnd = html.indexOf("</div>", memoryDoctorSafeRowStart);
      const memoryDoctorSafeRow = html.slice(memoryDoctorSafeRowStart, memoryDoctorSafeRowEnd);
      expect(memoryDoctorSafeRow).toContain("<strong>Candidate backlog</strong>");
      expect(memoryDoctorSafeRow).not.toContain("<strong>Candidate records are accumulating faster than canonical records.</strong>");
      expect(memoryDoctorSafeRow).not.toContain("<details class=\"governance-safe-notes\"");
      expect(memoryDoctorSafeRow).not.toContain("<span>Audit notes</span>");
      expect(memoryDoctorSafeRow).not.toContain("memory_doctor.findings_by_id.candidate_backlog");
      const referenceAuditStart = html.indexOf("<details class=\"governance-reference-audit\" data-dashboard-detail=\"governance-reference-audit\">");
      const referenceAuditEnd = html.indexOf("</details>", referenceAuditStart);
      const referenceAuditHtml = html.slice(referenceAuditStart, referenceAuditEnd);
      expect(referenceAuditStart).toBeGreaterThan(memoryDoctorSafeRowEnd);
      expect(referenceAuditHtml).toContain("<details class=\"governance-reference-audit\" data-dashboard-detail=\"governance-reference-audit\">");
      expect(referenceAuditHtml).toContain("<span>Reference audit</span>");
      expect(referenceAuditHtml).toContain("<h4>Candidate backlog</h4>");
      expect(referenceAuditHtml).toContain("Detected: Candidate records are accumulating faster than canonical records.");
      expect(referenceAuditHtml).toContain("Recommended next step: Review candidate backlog.");
      expect(referenceAuditHtml).toContain("Write boundary: read-only inspection; no memory writes.");
      expect(referenceAuditHtml).toContain("Evidence source: <code>memory_doctor.findings_by_id.candidate_backlog</code>");
      expect(html).not.toContain("data-dashboard-detail=\"governance-notes:");
      expect(memoryDoctorSafeRow).not.toContain("<details class=\"governance-safe-evidence\">");
      expect(html).toContain("<span>Memory Doctor</span>");
      expect(html).toContain("<span>Dogfood Review</span>");
      expect(html).toContain("<small>Inspect Failure Signals | Read-only</small>");
      expect(html).not.toContain("<span>dogfood_report</span>");
      expect(html).not.toContain("<small>inspect_failure_signals | Read-only</small>");
      expect(html).toContain("<summary class=\"governance-item-summary\">");
      expect(html).toContain("data-governance-finding-summary");
      expect(html).toContain("<h4>Finding summary</h4>");
      expect(html).toContain("<dt>Records affected</dt><dd>1 record</dd>");
      expect(html).toContain("<dt>Safe next step</dt><dd>Review in Capture Inbox</dd>");
      expect(html).toContain("<dt>Write boundary</dt><dd>Append-only after approval</dd>");
      expect(html).toContain("<dt>Evidence source</dt><dd><code>capture_policy.findings_by_id.review_required</code></dd>");
      expect(html).toContain("data-governance-evidence");
      expect(html).toContain("data-governance-review-log");
      expect(html).toContain("<h4>Review notes</h4>");
      expect(html).not.toContain("<h4>Review log</h4>");
      expect(html).toContain("Detected: Some captured records are waiting for a human decision.");
      expect(html).toContain("Recommended next step: Review in Capture Inbox.");
      expect(html).toContain("Write boundary: requires explicit approval before append-only memory events.");
      expect(html).toContain("Evidence source: capture_policy.findings_by_id.review_required");
      expect(html).not.toContain("Audit trail: capture_policy.findings_by_id.review_required");
      expect(html).toContain("<summary>Raw audit fields</summary>");
      expect(html).toContain("data-governance-item=\"capture_policy:review_required\"");
      expect(html).not.toContain("data-governance-item=\"memory_lifecycle:stale_records\"");
      expect(html).toContain("data-governance-safe-item=\"memory_lifecycle:stale_records\"");
      expect(html).not.toContain("data-governance-item=\"dogfood_report:failure_signals\"");
      expect(html).toContain("data-governance-safe-item=\"dogfood_report:failure_signals\"");
      expect(data.governance.summary.total_items).toBeGreaterThan(0);
      expect(html).not.toContain("<p><code>governance.summary</code></p>");
      expect(html).toContain("capture_policy.findings_by_id.review_required");
      expect(html).toContain("Read-only");
      expect(html).toContain("User confirmation");
      expect(html).toContain("Safe Inspections");
      expect(html).not.toContain("<article class=\"governance-item");
      expect(html).toContain("data-dashboard-detail=\"debug-inspector\"");
      expect(html).toContain("data-dashboard-detail=\"inspector:records\"");
      expect(html).toContain("<article class=\"supporting-evidence-summary-row\" data-supporting-evidence-summary=\"raw-store\" data-dashboard-detail=\"debug-inspector\">");
      expect(html).toContain("<strong data-i18n-en=\"Raw Store\" data-i18n-zh=\"原始存储\">Raw Store</strong>");
      expect(html).not.toContain("<strong>Raw Store</strong>");
      expect(html).toContain("<code data-dashboard-detail=\"inspector:records\">recent_records</code>");
      expect(html).toContain("<code data-dashboard-detail=\"inspector:events\">recent_events</code>");
      expect(html).toContain("<code data-dashboard-detail=\"inspector:sync\">sync</code>");
      expect(html).not.toContain("<article class=\"debug-inspector-reference\" data-dashboard-detail=\"inspector:records\">");
      expect(html).not.toContain("<article class=\"debug-inspector-reference\" data-dashboard-detail=\"inspector:events\">");
      expect(html).not.toContain("<article class=\"debug-inspector-reference\" data-dashboard-detail=\"inspector:sync\">");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:records\">");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:events\">");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:sync\">");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:records\">\n          <summary>Record table</summary>");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:events\">\n          <summary>Event log</summary>");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:sync\">\n          <summary>Sync state</summary>");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:records\">\n          <summary>Records</summary>");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:events\">\n          <summary>Events</summary>");
      expect(html).not.toContain("<details data-dashboard-detail=\"inspector:sync\">\n          <summary>Sync</summary>");
      expect(html).not.toContain("<details open data-dashboard-detail=\"inspector:records\">");
      expect(html).toContain("<article class=\"supporting-evidence-summary-row\" data-supporting-evidence-summary=\"audit-reports\" data-dashboard-detail=\"supporting-operational-evidence\">");
      expect(html).toContain("<code data-dashboard-detail=\"memory-lifecycle-audit\">memory_lifecycle</code>");
      expect(html).toContain("<code data-dashboard-detail=\"capture-policy-audit\">capture_policy</code>");
      expect(html).not.toContain("<details class=\"panel memory-lifecycle\" data-dashboard-detail=\"memory-lifecycle-audit\"");
      expect(html).not.toContain("<details class=\"panel capture-policy-audit\" data-dashboard-detail=\"capture-policy-audit\"");
      expect(html).not.toContain("<section class=\"panel memory-lifecycle\"");
      expect(html).not.toContain("<section class=\"panel capture-policy-audit\"");
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
              cases_by_id: Record<string, { status: string; missing_record_ids: string[] }>;
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
              record_id: "rec_recall_eval_2",
              case_count: 2
            }
          ],
          report: {
            summary: {
              total_cases: 2,
              passed_cases: 1,
              failed_cases: 1,
              privacy_leaks: 0
            }
          }
        });
        expect(data.recall_eval.report?.cases_by_id["missing-dashboard-memory"]).toMatchObject({
          status: "fail",
          missing_record_ids: ["rec_missing_dashboard_memory"]
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
        expect(data.governance.summary).toMatchObject({
          needs_user_action: 0,
          safe_inspections: 1
        });
        expect(data.action_board.items_by_id.inspect.value).toBe(1);
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
          summary: "1 safe check available",
          severity: "good",
          target: "governance-hub",
          target_label: "Inspect checks",
          source: "action_board.items_by_id.inspect"
        });

        const html = renderDashboardHtml(data);
        expect(html).toContain("Recall Eval");
        expect(html).not.toContain("<section class=\"dashboard-overview");
        expect(html).not.toContain("data-dashboard-overview");
        expect(html).not.toContain("<p data-i18n-en=\"No work needs attention.\" data-i18n-zh=\"No work needs attention.\">No work needs attention.</p>");
        expect(html).not.toContain("<p>No confirmations, warnings, or sync actions need attention. Read-only inspections remain available below.</p>");
        expect(html).not.toContain("<button type=\"button\" class=\"dashboard-overview-action dashboard-overview-action-quiet\" data-action-board-target=\"governance-hub\" aria-controls=\"governance-hub\" data-i18n-en=\"View checks\" data-i18n-zh=\"查看检查\">View checks</button>");
        expect(html).not.toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"governance-hub\" aria-controls=\"governance-hub\">Inspect checks</button>");
        expect(html).not.toContain("<div class=\"dashboard-overview-safety\" aria-label=\"Dashboard safety\">");
        expect(html).not.toContain("<span>Read-only overview</span>");
        expect(html).not.toContain("<span>Writes stay in Capture Inbox, Review Queue, and Candidate Triage</span>");
        expect(html).not.toContain("<div class=\"dashboard-overview-grid\">");
        expect(html).not.toContain("data-dashboard-overview-card=\"health\"");
        expect(html).not.toContain("data-dashboard-overview-card=\"action\"");
        expect(html).not.toContain("data-dashboard-overview-card=\"context\"");
        expect(html).not.toContain("data-dashboard-overview-card=\"sync\"");
        expect(html).not.toContain("<details class=\"dashboard-overview-quiet\" data-dashboard-detail=\"dashboard-overview-quiet-cards\">");
        expect(html).not.toContain("<span>Background Status</span>");
        expect(html).not.toContain("<summary class=\"dashboard-fold-summary dashboard-overview-quiet-fold\" aria-label=\"Background Status: Healthy signals kept for context\">");
        expect(html).not.toContain("<small>Signals ready</small>");
        expect(html).not.toContain("<small>Healthy signals kept for context</small>");
        expect(html).not.toContain("<small>4 reference cards</small>");
        expect(html).not.toContain("<span>Reference Cards</span>");
        expect(html).not.toContain("<span>Quiet Overview</span>");
        expect(html).not.toContain("<small>4 quiet cards</small>");
        expect(html).not.toContain("<div class=\"dashboard-overview-quiet-list\">");
        expect(html).not.toContain("data-dashboard-overview-quiet-card=\"health\"");
        expect(html).not.toContain("data-dashboard-overview-quiet-card=\"action\"");
        expect(html).not.toContain("data-dashboard-overview-quiet-card=\"context\"");
        expect(html).not.toContain("data-dashboard-overview-quiet-card=\"sync\"");
        expect(data.dashboard_overview.cards_by_id.health).toMatchObject({
          value: "Healthy",
          source: "health"
        });
        expect(data.dashboard_overview.cards_by_id.context).toMatchObject({
          source: "context_pack_review"
        });
        expect(data.dashboard_overview.cards_by_id.sync).toMatchObject({
          value: "Healthy",
          source: "action_board.items_by_id.sync"
        });
        expect(data.action_board.items.map((item) => item.id)).toEqual(["confirm", "review", "inspect", "sync"]);
        expect(data.action_board.items_by_id.inspect).toMatchObject({
          label: "Inspect",
          value: 1,
          next_action_label: "Open governance",
          target: "governance-hub"
        });
        expect(html).not.toContain("<details class=\"action-board-background\" aria-label=\"Background Shortcuts\" data-dashboard-detail=\"action-board\" data-dashboard-background-shortcuts>");
        expect(html).not.toContain("<span>Background Shortcuts</span>");
        expect(html).not.toContain("data-dashboard-background-shortcuts");
        expect(html).not.toContain("data-dashboard-detail=\"action-board-quiet-targets\"");
        expect(html).not.toContain("<details class=\"action-board action-board-secondary\" aria-label=\"Page Shortcuts\" data-dashboard-detail=\"action-board\" data-action-board-nav>");
        expect(html).not.toContain("<span>Page Shortcuts</span>");
        expect(html).not.toContain("<span class=\"action-board-activity\">all clear</span>");
        expect(html).not.toContain("action-board-activity");
        expect(html).not.toContain("<small>1 inspect</small>");
        expect(html).not.toContain("<div class=\"action-board-grid\">");
        expect(html).not.toContain("<details class=\"action-board-quiet\" data-dashboard-detail=\"action-board-quiet-targets\">");
        expect(html).not.toContain("<span>Quiet Shortcuts</span>");
        expect(html).not.toContain("<small>Background section links</small>");
        const evidenceLibraryStart = html.indexOf("data-dashboard-detail=\"evidence-library\"");
        expect(evidenceLibraryStart).toBeGreaterThan(-1);
        const evidenceBriefIndex = html.indexOf("<div class=\"evidence-library-brief\" data-evidence-library-brief>", evidenceLibraryStart);
        const evidenceListIndex = html.indexOf("<div class=\"evidence-library-list\">", evidenceLibraryStart);
        expect(evidenceBriefIndex).toBeGreaterThan(evidenceLibraryStart);
        expect(evidenceBriefIndex).toBeLessThan(evidenceListIndex);
        expect(html).toContain("<h3 data-i18n-en=\"Evidence index\" data-i18n-zh=\"依据索引\">Evidence index</h3>");
        expect(html).toContain("data-evidence-library-route=\"findings\"");
        expect(html).toContain("data-action-board-target=\"evidence-review-evidence\"");
        expect(html).toContain("<strong data-i18n-en=\"Findings\" data-i18n-zh=\"发现\">Findings</strong><span data-i18n-en=\"Reference notes\" data-i18n-zh=\"参考记录\">Reference notes</span>");
        expect(html).toContain("<strong data-i18n-en=\"Diagnostics\" data-i18n-zh=\"诊断\">Diagnostics</strong><span data-i18n-en=\"Healthy checks and handoff readiness\" data-i18n-zh=\"健康检查和交接状态\">Healthy checks and handoff readiness</span>");
        expect(html).toContain("<strong data-i18n-en=\"Audit\" data-i18n-zh=\"追踪\">Audit</strong><span data-i18n-en=\"Optional trace data\" data-i18n-zh=\"可选追踪数据\">Optional trace data</span>");
        expect(html).not.toContain("<strong>Findings</strong><span>Reference notes</span>");
        expect(html).not.toContain("<strong>Diagnostics</strong><span>Healthy checks and handoff readiness</span>");
        expect(html).not.toContain("<strong>Audit</strong><span>Optional trace data</span>");
        expect(html).toContain("<span data-i18n-en=\"Review Notes\" data-i18n-zh=\"审查记录\">Review Notes</span>");
        expect(html).toContain("<span data-i18n-en=\"Routine Reference\" data-i18n-zh=\"日常参考\">Routine Reference</span>");
        expect(html).not.toContain("<h3>Evidence index</h3>");
        expect(html).not.toContain("<span>Review Notes</span>");
        expect(html).not.toContain("<span>Routine Reference</span>");
        expect(html).not.toContain("<small>4 reference checks</small>");
        expect(html).not.toContain("<span>Reference Checks</span>");
        expect(html).not.toContain("<span>Quiet Targets</span>");
        expect(html).not.toContain("<small>4 quiet targets</small>");
        expect(html).not.toContain("data-action-board-quiet-item=\"inspect\"");
        expect(html).not.toContain("data-action-board-item=\"inspect\"");
        expect(html).not.toContain("data-governance-item=\"recall_eval:missing-dashboard-memory\"");
        expect(html).not.toContain("data-governance-safe-item=\"recall_eval:missing-dashboard-memory\"");
        expect(html).not.toContain("recall_eval.report.cases_by_id.missing-dashboard-memory");
        expect(html).not.toContain("<small>Revise Golden Case Or Memory | Read-only</small>");
        expect(html).not.toContain("<small>revise_golden_case_or_memory | Read-only</small>");
        expect(JSON.stringify(data.governance)).toContain("revise_golden_case_or_memory");
        expect(JSON.stringify(data.governance)).toContain("recall_eval.report.cases_by_id.missing-dashboard-memory");
        expect(html).toContain("<span data-i18n-en=\"Read-only Governance\" data-i18n-zh=\"只读治理\">Read-only Governance</span>");
        expect(html).toContain("<small data-i18n-en=\"Reference checks\" data-i18n-zh=\"参考检查\">Reference checks</small>");
        expect(html).not.toContain("<span>Read-only Governance</span>");
        expect(html).not.toContain("<small>Reference checks</small>");
        expect(html).toContain("<article class=\"governance-reference\" data-dashboard-detail=\"governance:index\" data-governance-reference>");
        expect(html).toContain("<strong data-i18n-en=\"Governance Index\" data-i18n-zh=\"治理索引\">Governance Index</strong>");
        expect(html).toContain("<span data-i18n-en=\"1 read-only check indexed\" data-i18n-zh=\"1 项只读检查已建立索引\">1 read-only check indexed</span>");
        expect(html).toContain("Open <code>/api/dashboard</code> for governance items, evidence paths, review logs, and safe inspection commands.");
        expect(html).not.toContain("<small>1 safe check</small>");
        expect(html).not.toContain("<span>1 safe check</span>");
        expect(html).not.toContain("<details class=\"governance-safe-group\" data-dashboard-detail=\"governance-safe-inspections\">");
        expect(html).not.toContain("<details class=\"governance-reference-audit\" data-dashboard-detail=\"governance-reference-audit\">");
        expect(html).not.toContain("<section class=\"dashboard-work-lanes\" data-dashboard-work-lanes aria-label=\"Dashboard Work Lanes\">");
        expect(html).not.toContain("<details class=\"dashboard-work-lanes-quiet\" data-dashboard-detail=\"dashboard-work-lanes-background\">");
        expect(html).not.toContain("<span>Background Lanes</span>");
        expect(html).not.toContain("<small>Quiet lanes ready</small>");
        expect(html).not.toContain("<small>Decide, Context, Health, and Evidence are quiet</small>");
        expect(html).not.toContain("data-dashboard-work-lane=\"evidence\"");
        expect(html).not.toContain("data-dashboard-work-lane=\"decide\"");
        expect(html).not.toContain("data-dashboard-work-lane=\"context\"");
        expect(html).not.toContain("data-dashboard-work-lane=\"health\"");
        expect(html).not.toContain("data-dashboard-work-lane-quiet=\"decide\"");
        expect(html).not.toContain("data-dashboard-work-lane-quiet=\"context\"");
        expect(html).not.toContain("data-dashboard-work-lane-quiet=\"health\"");
        expect(html).not.toContain("data-dashboard-work-lane-quiet=\"evidence\"");
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
      expect(html).toContain("class=\"health-badge");
      expect(html).toContain("<section class=\"status-strip");
      expect(html).toContain("<strong>Dashboard Status</strong>");
      expect(html).toContain("data-dashboard-status=\"");
      expect(html).not.toContain("<section class=\"hero\">");
      expect(html).toContain("<section class=\"dashboard-overview warning\" data-dashboard-overview aria-label=\"Dashboard Overview\">");
      expect(html).not.toContain("<h2>Dashboard Overview</h2>");
      expect(html).toContain("<h2><span data-i18n-en=\"Do I need to act?\" data-i18n-zh=\"我需要操作吗？\">Do I need to act?</span></h2>");
      expect(html).toContain("<strong data-i18n-en=\"Review what changed\" data-i18n-zh=\"查看变化\">Review what changed</strong>");
      expect(html).toContain("<p data-i18n-en=\"Important checks stay visible in Needs a look.\" data-i18n-zh=\"重要检查会继续显示在需要看一下区域。\">Important checks stay visible in Needs a look.</p>");
      expect(html).toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\" data-i18n-en=\"Review what changed\" data-i18n-zh=\"查看变化\">Review what changed</button>");
      expect(html).not.toContain("<div class=\"dashboard-overview-grid\">");
      expect(html).not.toContain("data-dashboard-overview-card=\"health\"");
      expect(html).not.toContain("data-dashboard-overview-card=\"context\"");
      expect(html).not.toContain("data-dashboard-overview-card=\"sync\"");
      expect(html).toContain("<details class=\"dashboard-overview-quiet\" data-dashboard-detail=\"dashboard-overview-quiet-cards\">");
      expect(html).toContain("<span data-i18n-en=\"Other status\" data-i18n-zh=\"其他状态\">Other status</span>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary dashboard-overview-quiet-fold\" aria-label=\"Other status: supporting signals are ready\">");
      expect(html).toContain("<small data-i18n-en=\"Ready if needed\" data-i18n-zh=\"需要时可查看\">Ready if needed</small>");
      expect(html).toContain("<button type=\"button\" class=\"dashboard-overview-card info\" data-dashboard-overview-quiet-card=\"health\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\" data-dashboard-overview-source=\"health\">");
      expect(html).toContain("<span data-i18n-en=\"Health\" data-i18n-zh=\"健康\">Health</span>");
      expect(html).toContain("<strong data-i18n-en=\"Local Only\" data-i18n-zh=\"仅本机\">Local Only</strong>");
      expect(html).toContain("<small data-i18n-en=\"Review health\" data-i18n-zh=\"查看健康状态\">Review health</small>");
      expect(html).not.toContain("<button type=\"button\" class=\"dashboard-overview-card warning\" data-dashboard-overview-card=\"action\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\" data-dashboard-overview-source=\"action_board.items_by_id.review\">");
      expect(html).toContain("<small data-i18n-en=\"Open context\" data-i18n-zh=\"查看上下文\">Open context</small>");
      expect(html).toContain("<button type=\"button\" class=\"dashboard-overview-card info\" data-dashboard-overview-quiet-card=\"sync\" data-action-board-target=\"store-signals\" aria-controls=\"store-signals\" data-dashboard-overview-source=\"action_board.items_by_id.sync\">");
      expect(html).toContain("<small data-i18n-en=\"Inspect sync\" data-i18n-zh=\"检查共享副本\">Inspect sync</small>");
      expect(html).not.toContain("<small>action_board.items_by_id.sync</small>");
      expect(html).not.toContain("<small>context_pack_review</small>");
      expect(html).not.toContain("<article class=\"dashboard-overview-card");
      expect(html).toContain("<span data-i18n-en=\"Read-only summary\" data-i18n-zh=\"只读摘要\">Read-only summary</span>");
      expect(html).toContain("<span data-i18n-en=\"Approvals stay in Capture Inbox, Review Queue, and Candidate Triage\" data-i18n-zh=\"确认操作仍在 Capture Inbox, Review Queue, and Candidate Triage 中完成\">Approvals stay in Capture Inbox, Review Queue, and Candidate Triage</span>");
      expect(html).not.toContain("data-dashboard-focus-brief");
      expect(html.indexOf("data-dashboard-overview")).toBeLessThan(html.indexOf("data-dashboard-detail=\"health-check\""));
      expect(html.indexOf("data-dashboard-overview")).toBeLessThan(html.indexOf("data-action-board-nav"));
      expect(html).not.toContain("data-dashboard-action-id=\"overview");
      expect(html).toContain("<section class=\"dashboard-work-lanes\" data-dashboard-work-lanes aria-label=\"Dashboard Work Lanes\">");
      expect(html.indexOf("data-dashboard-overview")).toBeLessThan(html.indexOf("data-dashboard-work-lanes"));
      expect(html.indexOf("data-dashboard-work-lanes")).toBeLessThan(html.indexOf("id=\"needs-attention\""));
      const workLanesStart = html.indexOf("data-dashboard-work-lanes");
      const workLanesEnd = html.indexOf("data-action-board-nav", workLanesStart);
      const workLanesHtml = html.slice(workLanesStart, workLanesEnd);
      const quietWorkLanesStart = workLanesHtml.indexOf("data-dashboard-detail=\"dashboard-work-lanes-background\"");
      expect(quietWorkLanesStart).toBeGreaterThan(-1);
      const activeWorkLanesHtml = workLanesHtml.slice(0, quietWorkLanesStart);
      const quietWorkLanesHtml = workLanesHtml.slice(quietWorkLanesStart);
      expect(activeWorkLanesHtml).toContain("<button type=\"button\" class=\"dashboard-work-lane warning\" data-dashboard-work-lane=\"health\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\">");
      expect(activeWorkLanesHtml).toContain("<span data-i18n-en=\"Health\" data-i18n-zh=\"健康\">Health</span>");
      expect(activeWorkLanesHtml).toContain("<strong data-i18n-en=\"1 attention item\" data-i18n-zh=\"1 条提醒\">1 attention item</strong>");
      expect(activeWorkLanesHtml).toContain("<em data-i18n-en=\"Review what changed\" data-i18n-zh=\"查看变化\">Review what changed</em>");
      expect(activeWorkLanesHtml).not.toContain("data-dashboard-work-lane=\"decide\"");
      expect(activeWorkLanesHtml).not.toContain("data-dashboard-work-lane=\"context\"");
      expect(activeWorkLanesHtml).not.toContain("data-dashboard-work-lane=\"evidence\"");
      expect(html).toContain("<details class=\"dashboard-work-lanes-quiet\" data-dashboard-detail=\"dashboard-work-lanes-background\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary dashboard-work-lanes-quiet-fold\" aria-label=\"Other paths: Decide, Context, and Evidence are quiet\">");
      expect(html).toContain("<span data-i18n-en=\"Other paths\" data-i18n-zh=\"其他入口\">Other paths</span>");
      expect(html).toContain("<small data-i18n-en=\"Ready if needed\" data-i18n-zh=\"需要时可查看\">Ready if needed</small>");
      expect(quietWorkLanesHtml).toContain("<button type=\"button\" class=\"dashboard-work-lane good\" data-dashboard-work-lane-quiet=\"decide\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\">");
      expect(quietWorkLanesHtml).toContain("<span data-i18n-en=\"Decide\" data-i18n-zh=\"决定\">Decide</span>");
      expect(quietWorkLanesHtml).toContain("<strong data-i18n-en=\"No approvals waiting\" data-i18n-zh=\"没有等待确认的内容\">No approvals waiting</strong>");
      expect(quietWorkLanesHtml).toContain("<em data-i18n-en=\"Inspect decision surfaces\" data-i18n-zh=\"查看可确认的地方\">Inspect decision surfaces</em>");
      expect(quietWorkLanesHtml).toContain("<button type=\"button\" class=\"dashboard-work-lane info\" data-dashboard-work-lane-quiet=\"context\" data-action-board-target=\"context-pack-review\" aria-controls=\"context-pack-review\">");
      expect(quietWorkLanesHtml).toContain("<span data-i18n-en=\"Context\" data-i18n-zh=\"上下文\">Context</span>");
      expect(quietWorkLanesHtml).toContain("<strong data-i18n-en=\"Context unavailable\" data-i18n-zh=\"暂无上下文\">Context unavailable</strong>");
      expect(quietWorkLanesHtml).toContain("<em data-i18n-en=\"Open handoff review\" data-i18n-zh=\"打开交接查看\">Open handoff review</em>");
      expect(quietWorkLanesHtml).toContain("<button type=\"button\" class=\"dashboard-work-lane info\" data-dashboard-work-lane-quiet=\"evidence\" data-action-board-target=\"evidence-library\" aria-controls=\"evidence-library\">");
      expect(quietWorkLanesHtml).toContain("<span data-i18n-en=\"Evidence\" data-i18n-zh=\"依据\">Evidence</span>");
      expect(quietWorkLanesHtml).toContain("<strong data-i18n-en=\"Read-only reference material\" data-i18n-zh=\"只读参考资料\">Read-only reference material</strong>");
      expect(quietWorkLanesHtml).toContain("<em data-i18n-en=\"Open read-only evidence\" data-i18n-zh=\"打开只读依据\">Open read-only evidence</em>");
      expect(html).not.toContain("<strong>Read-only findings and reference evidence</strong>");
      expect(html).not.toContain("<em>Open evidence library</em>");
      expect(workLanesHtml).not.toContain("data-dashboard-action-id");
      expect(workLanesHtml).not.toContain("Approve");
      expect(workLanesHtml).not.toContain("Reject");
      expect(workLanesHtml).not.toContain("Promote");
      expect(workLanesHtml).not.toContain("Archive");
      expect(workLanesHtml).not.toContain("Apply");
      expect(html).toContain("<details class=\"action-board action-board-secondary\" aria-label=\"Page Shortcuts\" data-dashboard-detail=\"action-board\" data-action-board-nav>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary action-board-fold\">");
      expect(html).toContain("<span>Page Shortcuts</span>");
      expect(html).toContain("<small>Optional section links</small>");
      expect(html).not.toContain("<span class=\"action-board-activity\">1 review / 1 sync</span>");
      expect(html).not.toContain("action-board-activity");
      expect(html).not.toContain("<small>0 confirm / 1 review / 0 inspect / 1 sync</small>");
      expect(html).toContain("<div class=\"action-board-grid\">");
      expect(html.indexOf("data-action-board-nav")).toBeGreaterThan(html.indexOf("id=\"needs-attention\""));
      expect(html.indexOf("data-action-board-nav")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(html).not.toContain("<section class=\"action-board\" aria-label=\"Action Board\" data-action-board-nav>");
      expect(html).not.toContain("<span>Action Board</span>");
      expect(html).not.toContain("<h2>Action Board</h2>");
      expect(html).not.toContain("<button type=\"button\" class=\"action-board-item good\" data-action-board-item=\"confirm\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\">");
      expect(html).toContain("<button type=\"button\" class=\"action-board-item warning\" data-action-board-item=\"review\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\">");
      expect(html).not.toContain("<button type=\"button\" class=\"action-board-item good\" data-action-board-item=\"inspect\" data-action-board-target=\"governance-hub\" aria-controls=\"governance-hub\">");
      expect(html).toContain("<button type=\"button\" class=\"action-board-item info\" data-action-board-item=\"sync\" data-action-board-target=\"store-signals\" aria-controls=\"store-signals\">");
      expect(html).not.toContain("<details class=\"action-board-quiet\" data-dashboard-detail=\"action-board-quiet-targets\">");
      expect(html).not.toContain("<span>Quiet Shortcuts</span>");
      expect(html).not.toContain("<small>Background section links</small>");
      const actionBoardStart = html.indexOf("data-action-board-nav");
      const evidenceLibraryStart = html.indexOf("data-dashboard-detail=\"evidence-library\"", actionBoardStart);
      const actionBoardHtml = html.slice(actionBoardStart, evidenceLibraryStart);
      expect(actionBoardHtml).not.toContain("<small>2 reference checks</small>");
      expect(actionBoardHtml).not.toContain("<span>Reference Checks</span>");
      expect(html).not.toContain("<span>Quiet Targets</span>");
      expect(html).not.toContain("<small>2 quiet targets</small>");
      expect(html).not.toContain("data-action-board-quiet-item=\"confirm\"");
      expect(html).not.toContain("data-action-board-quiet-item=\"inspect\"");
      expect(html).toContain("data-action-board-nav");
      expect(actionBoardHtml).not.toContain("<em class=\"action-board-next\">Check attention</em>");
      expect(actionBoardHtml).toContain("<em class=\"action-board-next\">Review what changed</em>");
      expect(actionBoardHtml).not.toContain("<em class=\"action-board-next\">Open governance</em>");
      expect(actionBoardHtml).toContain("<em class=\"action-board-next\">Inspect sync</em>");
      expect(actionBoardHtml).not.toContain("<small>No confirmation needed</small>");
      expect(actionBoardHtml).toContain("<small>Important checks found</small>");
      expect(actionBoardHtml).not.toContain("<small>No inspection needed</small>");
      expect(actionBoardHtml).toContain("<small>Local only</small>");
      expect(html).not.toContain("<small>Explicit approvals stay in Capture Inbox, Review Queue, and Candidate Triage.</small>");
      expect(html).not.toContain("Warnings and critical signals remain visible in Needs Attention.");
      expect(html).not.toContain("<small>Read-only inspections are grouped in Governance Hub.</small>");
      expect(html).toContain("<details class=\"panel evidence-library\" data-dashboard-detail=\"evidence-library\" aria-label=\"Reference Library\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary evidence-library-fold\" aria-label=\"Reference Library: Reference evidence only\">");
      expect(html).toContain("<span>Reference Library</span>");
      expect(html).toContain("<small>Reference evidence only</small>");
      expect(html).not.toContain("<details class=\"evidence-library evidence-library-compact\" data-dashboard-detail=\"evidence-library\" data-dashboard-background-reference aria-label=\"Background Reference\">");
      expect(html).not.toContain("<span>Read-only Evidence</span>");
      expect(html).not.toContain("<small>Read-only findings and reference evidence</small>");
      expect(html).not.toContain("<small>Findings and references</small>");
      expect(html).not.toContain("<span>Evidence Library</span>");
      expect(html).not.toContain("<small>Read-only diagnostics grouped here</small>");
      expect(html).not.toContain("<small>Health Check | Governance | Context | Supporting Evidence</small>");
      const evidenceLibraryDetailIndex = html.indexOf("data-dashboard-detail=\"evidence-library\"");
      const evidenceBriefIndex = html.indexOf("<div class=\"evidence-library-brief\" data-evidence-library-brief>", evidenceLibraryDetailIndex);
      const evidenceListIndex = html.indexOf("<div class=\"evidence-library-list\">", evidenceLibraryDetailIndex);
      const evidenceReviewGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">");
      const evidenceBackgroundGroupIndex = html.indexOf("<details class=\"evidence-library-group evidence-library-background\" data-dashboard-detail=\"evidence-background-evidence\">");
      const referenceIndexHtml = referenceLibraryIndexHtml(html);
      const routineDiagnosticsHtml = dashboardDetailBlock(html, "routine-diagnostics");
      const candidateTriageIndex = html.indexOf("data-dashboard-detail=\"candidate-triage\"");
      expect(candidateTriageIndex).toBeGreaterThan(evidenceLibraryDetailIndex);
      expect(html).not.toContain("<div class=\"evidence-library-group evidence-library-review\" data-dashboard-detail=\"evidence-review-evidence\">");
      expect(html).not.toContain("<details open class=\"evidence-library-group evidence-library-review\"");
      expect(html.slice(0, evidenceLibraryDetailIndex)).not.toContain("data-dashboard-detail=\"candidate-triage\"");
      expect(evidenceBriefIndex).toBe(-1);
      expect(evidenceListIndex).toBe(-1);
      expect(evidenceReviewGroupIndex).toBe(-1);
      expect(evidenceBackgroundGroupIndex).toBe(-1);
      expect(html).not.toContain("data-evidence-library-brief");
      expect(html).not.toContain("<h3>Evidence index</h3>");
      expect(html).not.toContain("<div class=\"evidence-library-routebar\" role=\"list\" aria-label=\"Evidence index\">");
      expect(html).not.toContain("<h3>Evidence map</h3>");
      expect(html).not.toContain("<h3>Evidence routes</h3>");
      expect(html).not.toContain("<div class=\"evidence-library-brief-grid\">");
      expect(html).not.toContain("class=\"evidence-library-route\" data-evidence-library-route=\"findings\"");
      expect(html).not.toContain("data-action-board-target=\"evidence-review-evidence\" aria-controls=\"evidence-review-evidence\" aria-label=\"Findings: Reference notes. Read-only dogfood, governance, or non-routine checks.\"");
      expect(html).not.toContain("<strong>Findings</strong><span>Reference notes</span>");
      expect(html).not.toContain("<strong>Findings</strong><span>Read-only findings available</span>");
      expect(html).not.toContain("No read-only notes");
      expect(html).not.toContain("<small>Start here for dogfood, governance, or non-routine checks.</small>");
      expect(html).not.toContain("class=\"evidence-library-route\" data-evidence-library-route=\"diagnostics\"");
      expect(html).not.toContain("data-action-board-target=\"routine-diagnostics\" aria-controls=\"routine-diagnostics\" aria-label=\"Diagnostics: Healthy checks and handoff readiness. Routine health, recall, and handoff context checks.\"");
      expect(html).not.toContain("<strong>Diagnostics</strong><span>Healthy checks and handoff readiness</span>");
      expect(html).not.toContain("No routine diagnostics in this snapshot.");
      expect(html).not.toContain("<small>Routine health, recall, and handoff context checks.</small>");
      expect(html).not.toContain("class=\"evidence-library-route\" data-evidence-library-route=\"audit\"");
      expect(html).not.toContain("data-action-board-target=\"supporting-evidence\" aria-controls=\"supporting-evidence\" aria-label=\"Audit: Optional trace data. Clean audits, store signals, recent value, and raw store.\"");
      expect(html).not.toContain("<strong>Audit</strong><span>Optional trace data</span>");
      expect(html).not.toContain("No audit trail rendered in this snapshot.");
      expect(html).not.toContain("<strong>Audit</strong><span>Audit logs and raw signals</span>");
      expect(html).not.toContain("<small>Clean audits, store signals, recent value, and raw store.</small>");
      expect(html).not.toContain("<strong>Audit</strong><span>Audit logs and raw signals</span><small>Clean audits, store signals, recent value, and raw inspector.</small>");
      expect(referenceIndexHtml).toContain("<strong data-i18n-en=\"Reference Library Index\" data-i18n-zh=\"参考资料索引\">Reference Library Index</strong>");
      expect(referenceIndexHtml).toContain("<span data-i18n-en=\"Background reports indexed\" data-i18n-zh=\"后台报告已建立索引\">Background reports indexed</span>");
      expect(referenceIndexHtml).toContain("data-reference-library-route=\"routine-diagnostics\"");
      expect(referenceIndexHtml).toContain("data-reference-library-route=\"candidate-triage\"");
      expect(referenceIndexHtml).toContain("data-reference-library-route=\"supporting-evidence\"");
      expect(referenceIndexHtml).toContain("<code data-reference-library-route=\"routine-diagnostics\">diagnostics</code>");
      expect(referenceIndexHtml).toContain("<code data-reference-library-route=\"candidate-triage\">candidate_triage</code>");
      expect(referenceIndexHtml).toContain("<code data-reference-library-route=\"supporting-evidence\">audit_trail</code>");
      expect(referenceIndexHtml).toContain("<code data-dashboard-detail=\"candidate-triage:index\">candidate_triage</code>");
      expect(referenceIndexHtml).toContain("<code data-dashboard-detail=\"supporting-evidence\">audit_trail</code>");
      expect(referenceIndexHtml).toContain("<strong data-i18n-en=\"Diagnostics Index\" data-i18n-zh=\"诊断索引\">Diagnostics Index</strong>");
      expect(referenceIndexHtml).toContain("<strong data-i18n-en=\"Candidate Backlog Index\" data-i18n-zh=\"待整理内容索引\">Candidate Backlog Index</strong>");
      expect(referenceIndexHtml).toContain("<span data-i18n-en=\"Routine checks indexed\" data-i18n-zh=\"日常检查已建立索引\">Routine checks indexed</span>");
      expect(referenceIndexHtml).not.toContain("<strong>Diagnostics Index</strong>");
      expect(referenceIndexHtml).not.toContain("<strong>Candidate Backlog Index</strong>");
      expect(referenceIndexHtml).not.toContain("<span>Routine checks indexed</span>");
      expect(referenceIndexHtml).not.toContain("<span>Health Check, Recall Eval, Context Pack Review indexed</span>");
      expect(referenceIndexHtml.match(/<article class=\"/g)?.length).toBe(1);
      expect(referenceIndexHtml).toContain("<details class=\"reference-library-routes\" data-dashboard-detail=\"reference-library:routes\">");
      expect(referenceIndexHtml).not.toContain("<details open class=\"reference-library-routes\"");
      expect(referenceIndexHtml).toContain("<span data-i18n-en=\"Reference routes\" data-i18n-zh=\"参考入口\">Reference routes</span>");
      expect(referenceIndexHtml).toContain("<small data-i18n-en=\"Indexed background sources\" data-i18n-zh=\"已索引的后台来源\">Indexed background sources</small>");
      const referenceRoutesIndex = referenceIndexHtml.indexOf("data-dashboard-detail=\"reference-library:routes\"");
      const firstRouteRowIndex = referenceIndexHtml.indexOf("data-reference-library-index-row=\"diagnostics\"");
      expect(firstRouteRowIndex).toBeGreaterThan(referenceRoutesIndex);
      expect(referenceIndexHtml).toContain("data-reference-library-index-row=\"diagnostics\"");
      expect(referenceIndexHtml).toContain("data-reference-library-index-row=\"candidate-triage\"");
      expect(referenceIndexHtml).toContain("data-reference-library-index-row=\"raw-store\"");
      expect(referenceIndexHtml).not.toContain("<article class=\"routine-diagnostics-reference\"");
      expect(referenceIndexHtml).not.toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage\"");
      expect(referenceIndexHtml).not.toContain("<article class=\"supporting-evidence-summary-row\"");
      expect(referenceIndexHtml).not.toContain("data-dashboard-action-id");
      expect(referenceIndexHtml).not.toContain("Approve");
      expect(referenceIndexHtml).not.toContain("Reject");
      expect(referenceIndexHtml).not.toContain("Promote");
      expect(referenceIndexHtml).not.toContain("Archive");
      expect(referenceIndexHtml).not.toContain("Apply");
      const candidateTriageHtml = dashboardDetailBlock(html, "candidate-triage");
      expect(candidateTriageHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"candidate-triage\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(candidateTriageHtml).toContain("<strong data-i18n-en=\"Candidate Backlog Index\" data-i18n-zh=\"待整理内容索引\">Candidate Backlog Index</strong>");
      expect(candidateTriageHtml).not.toContain("<strong>Candidate Backlog Index</strong>");
      expect(candidateTriageHtml).toContain("<span>1 candidate across 1 group indexed</span>");
      expect(candidateTriageHtml).toContain("<code data-dashboard-detail=\"candidate-triage:index\">candidate_triage</code>");
      expect(candidateTriageHtml).not.toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(candidateTriageHtml).not.toContain("<h2>Candidate Backlog</h2>");
      expect(candidateTriageHtml).not.toContain("<p>Read-only candidate groups; promotion drafts appear as explicit decisions.</p>");
      expect(candidateTriageHtml).not.toContain("<span>Candidate Triage</span>");
      expect(candidateTriageHtml).not.toContain("<small>Background candidate audit</small>");
      expect(candidateTriageHtml).not.toContain("<h2>Candidate Triage Queue</h2>");
      expect(candidateTriageHtml).not.toContain("<p>Review grouping for memory doctor backlog.</p>");
      expect(candidateTriageHtml).not.toContain("<small>Review candidate backlog</small>");
      expect(candidateTriageHtml).not.toContain("candidate-triage-index-card");
      expect(candidateTriageHtml).not.toContain("<span>Needs inspection</span>");
      expect(candidateTriageHtml).not.toContain("<strong>Needs inspection</strong>");
      expect(candidateTriageHtml).not.toContain("<small>1 record indexed | Timeline check</small>");
      expect(data.candidate_triage.groups_by_id.needs_inspection?.evidence_path).toBe("candidate_triage.groups_by_id.needs_inspection");
      expect(candidateTriageHtml).not.toContain("<details class=\"candidate-triage-index-evidence\" data-dashboard-detail=\"candidate-triage-index-evidence:needs_inspection\">");
      expect(candidateTriageHtml).not.toContain("<span>Evidence path</span>");
      expect(candidateTriageHtml).not.toContain("<small>API group index</small>");
      expect(candidateTriageHtml).not.toContain("<code>candidate_triage.groups_by_id.needs_inspection</code>");
      expect(candidateTriageHtml).not.toContain("<span>Likely noise</span>");
      expect(candidateTriageHtml).not.toContain("<strong>Likely noise</strong>");
      expect(candidateTriageHtml).not.toContain("<strong>Handoff evidence</strong>");
      expect(candidateTriageHtml).not.toContain("<small>Keep as context</small>");
      expect(candidateTriageHtml).not.toContain("<strong>Audit only</strong>");
      expect(candidateTriageHtml).not.toContain("<strong>Archive review</strong>");
      expect(candidateTriageHtml).not.toContain("<strong>Handoff review</strong>");
      expect(candidateTriageHtml).not.toContain("<strong>Inspection review</strong>");
      expect(candidateTriageHtml).not.toContain("<small>Records indexed</small>");
      expect(candidateTriageHtml).not.toContain("<span>Record samples</span>");
      expect(candidateTriageHtml).not.toContain("<details class=\"candidate-triage-group\"");
      expect(candidateTriageHtml).not.toContain("data-dashboard-detail=\"candidate-triage-record:");
      expect(candidateTriageHtml).not.toContain("data-dashboard-detail=\"candidate-triage-records:");
      expect(candidateTriageHtml).not.toContain("<span>Hidden record index</span>");
      expect(candidateTriageHtml).not.toContain("data-dashboard-action-id=\"candidate-triage");
      expect(candidateTriageHtml).not.toContain("Approve Triage");
      expect(candidateTriageHtml).not.toContain("Archive Group");
      expect(candidateTriageHtml).not.toContain("Promote Selected");
      expect(html).not.toContain("<span>Review Notes</span>");
      expect(html).not.toContain("<small>Reference notes</small>");
      expect(html).not.toContain("<span>Read-only Notes</span>");
      expect(html).not.toContain("<span>Reference Findings</span>");
      expect(html).not.toContain("<span>Read-only Findings</span>");
      expect(html).not.toContain("<small>Findings to inspect</small>");
      expect(html).not.toContain("<span>Routine Reference</span>");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary evidence-library-group-heading\" aria-label=\"Routine Reference: Routine checks and audit trail\">");
      expect(html).not.toContain("<small>Checks and audit</small>");
      expect(html).not.toContain("<span>Reference Evidence</span>");
      expect(html).not.toContain("<small>Routine checks and audit trail</small>");
      expect(html).not.toContain("reference panels</small>");
      expect(html).not.toContain("<span>Background Evidence</span>");
      const routineDiagnosticsIndex = html.indexOf("data-dashboard-detail=\"routine-diagnostics\"");
      expect(html).not.toContain("<details class=\"panel routine-diagnostics\" data-dashboard-detail=\"routine-diagnostics\" aria-label=\"Routine Diagnostics\">");
      expect(html).not.toContain("<span>Routine Diagnostics</span>");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary routine-diagnostics-fold\" aria-label=\"Routine Diagnostics: Healthy checks and handoff readiness\">");
      expect(html).not.toContain("<small>Checks ready</small>");
      expect(html).not.toContain("<small>Healthy checks and handoff readiness</small>");
      expect(html).not.toContain("<small>3 quiet checks</small>");
      expect(routineDiagnosticsHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"diagnostics\" data-dashboard-detail=\"routine-diagnostics\" data-routine-diagnostics-reference data-reference-library-index=\"diagnostics\">");
      expect(routineDiagnosticsHtml).toContain("<strong data-i18n-en=\"Diagnostics Index\" data-i18n-zh=\"诊断索引\">Diagnostics Index</strong>");
      expect(routineDiagnosticsHtml).toContain("<span data-i18n-en=\"Routine checks indexed\" data-i18n-zh=\"日常检查已建立索引\">Routine checks indexed</span>");
      expect(routineDiagnosticsHtml).not.toContain("<strong>Diagnostics Index</strong>");
      expect(routineDiagnosticsHtml).not.toContain("<span>Routine checks indexed</span>");
      expect(routineDiagnosticsHtml).not.toContain("<span>Health Check, Recall Eval, Context Pack Review indexed</span>");
      expect(routineDiagnosticsHtml).toContain("<code data-dashboard-detail=\"health-check\"");
      expect(routineDiagnosticsHtml).toContain(">health_check</code>");
      expect(routineDiagnosticsHtml).toContain("<code data-dashboard-detail=\"recall-eval\"");
      expect(routineDiagnosticsHtml).toContain(">recall_eval</code>");
      expect(routineDiagnosticsHtml).toContain("<code data-dashboard-detail=\"context-pack-review\"");
      expect(routineDiagnosticsHtml).toContain(">context_pack_review</code>");
      expect(html).toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(html).not.toContain("<small>healthy | 0 warnings | 0 failed</small>");
      expect(routineDiagnosticsHtml).toContain("data-dashboard-detail=\"health-check\"");
      expect(routineDiagnosticsHtml).toContain("data-dashboard-detail=\"recall-eval\"");
      expect(routineDiagnosticsHtml).toContain("data-dashboard-detail=\"context-pack-review\"");
      expect(routineDiagnosticsHtml).not.toContain("<article class=\"routine-diagnostics-reference\"");
      expect(html).not.toContain("<small>Unavailable | no stored cases</small>");
      expect(routineDiagnosticsHtml).not.toContain("<div class=\"routine-diagnostics-summary-list\" aria-label=\"Routine diagnostics summary\">");
      expect(routineDiagnosticsHtml).not.toContain("data-routine-diagnostic=\"health-check\"");
      expect(routineDiagnosticsHtml).not.toContain("data-routine-diagnostic=\"recall-eval\"");
      expect(routineDiagnosticsHtml).not.toContain("data-routine-diagnostic=\"context-pack-review\"");
      expect(routineDiagnosticsHtml).not.toContain("<strong>Health Check</strong>");
      expect(routineDiagnosticsHtml).not.toContain("<span>Healthy local store</span>");
      expect(routineDiagnosticsHtml).not.toContain("<strong>Recall Eval</strong>");
      expect(routineDiagnosticsHtml).not.toContain("<span>No recall eval cases yet</span>");
      expect(routineDiagnosticsHtml).not.toContain("<strong>Context Pack Review</strong>");
      expect(routineDiagnosticsHtml).not.toContain("<details class=\"panel health-check-panel\"");
      expect(routineDiagnosticsHtml).not.toContain("<details class=\"panel context-pack-review\"");
      expect(routineDiagnosticsHtml).not.toContain("<details class=\"routine-diagnostics-full-panels\" data-dashboard-detail=\"routine-diagnostics-full-panels\">");
      expect(routineDiagnosticsHtml).not.toContain("<span>Diagnostic Reports</span>");
      expect(routineDiagnosticsHtml).not.toContain("<small>Health, recall, handoff</small>");
      expect(html).not.toContain("<span>Full diagnostic details</span>");
      const evidenceHealthCheckIndex = html.indexOf("data-dashboard-detail=\"health-check\"");
      const evidenceGovernanceIndex = html.indexOf("data-dashboard-detail=\"governance-hub\"");
      const dogfoodReviewIndex = html.indexOf("data-dashboard-detail=\"dogfood-review\"");
      const evidenceContextPackIndex = html.indexOf("data-dashboard-detail=\"context-pack-review\"");
      const evidenceSupportingIndex = html.indexOf("data-dashboard-detail=\"supporting-evidence\"");
      const evidenceCaptureInboxIndex = html.indexOf("id=\"capture-inbox\"");
      expect(evidenceLibraryDetailIndex).toBeGreaterThan(html.indexOf("data-dashboard-background-shortcuts"));
      expect(dogfoodReviewIndex).toBe(-1);
      expect(routineDiagnosticsIndex).toBeGreaterThan(evidenceLibraryDetailIndex);
      expect(evidenceHealthCheckIndex).toBeGreaterThan(routineDiagnosticsIndex);
      if (evidenceGovernanceIndex !== -1) {
        expect(evidenceGovernanceIndex).toBeGreaterThan(evidenceLibraryDetailIndex);
      }
      expect(evidenceContextPackIndex).toBeGreaterThan(routineDiagnosticsIndex);
      expect(evidenceContextPackIndex).toBeLessThan(evidenceSupportingIndex);
      expect(evidenceSupportingIndex).toBeGreaterThan(evidenceBackgroundGroupIndex);
      expect(evidenceCaptureInboxIndex === -1 || evidenceCaptureInboxIndex < evidenceLibraryDetailIndex).toBe(true);
      expect(html).toContain("const findDashboardTarget = (targetId) => {");
      expect(html).toContain("const trigger = clicked.closest(\"[data-action-board-target]\");");
      expect(html).toContain("document.getElementById(targetId)");
      expect(html).toContain("document.querySelector(`[data-dashboard-detail=\"${cssEscape(targetId)}\"]`)");
      expect(html).toContain("const target = findDashboardTarget(targetId);");
      expect(html).toContain("target.open = true");
      expect(html).toContain("target.closest(\"details\")");
      expect(html).toContain("target.scrollIntoView({ block: \"start\", behavior: \"smooth\" })");
      expect(html).toContain("Important checks stay visible in Needs a look.");
      expect(html).not.toContain("Warnings and critical signals remain visible in Needs Attention.");
      expect(html).not.toContain("<section class=\"overview-grid\" aria-label=\"Dashboard overview\">");
      expect(html).not.toContain(">Action Signals<");
      expect(html).toContain("<section id=\"needs-attention\" class=\"panel action-signals\" data-dashboard-section=\"needs-attention\" data-dashboard-detail=\"needs-attention\">");
      expect(html).toContain("<h2 data-i18n-en=\"Needs a look\" data-i18n-zh=\"需要看一下\">Needs a look</h2>");
      expect(html).not.toContain("<h2>Needs Attention</h2>");
      expect(html).toContain("<small data-i18n-en=\"Warnings and important checks\" data-i18n-zh=\"提醒和重要检查\">Warnings and important checks</small>");
      expect(html).toContain("<div class=\"attention-focus\" aria-label=\"Needs a look summary\">");
      expect(html).toContain("<span data-attention-focus-count><strong>1</strong> thing to check</span>");
      expect(html).not.toContain("attention-focus-count critical");
      expect(html).toContain("<span class=\"attention-focus-count warning\">1 warning</span>");
      expect(html).toContain("<span class=\"attention-focus-count info\">1 info check</span>");
      expect(html).not.toContain("<span class=\"attention-focus-count info\">1 info</span>");
      expect(html).toContain("<span class=\"attention-next-action\" data-attention-next-action data-i18n-en=\"Review what changed\" data-i18n-zh=\"查看变化\">Review what changed</span>");
      expect(html).not.toContain("<em>Next: Review warnings</em>");
      expect(html).toContain("<details class=\"attention warning\" data-dashboard-detail=\"attention:Quarantined records hidden\">");
      expect(html).toContain("<strong data-i18n-en=\"Some saved content is paused\" data-i18n-zh=\"部分保存内容已暂停使用\">Some saved content is paused</strong>");
      expect(html).toContain("<p data-i18n-en=\"1 saved item(s) are paused because they may contain sensitive or unsafe content.\" data-i18n-zh=\"1 条保存内容已暂停使用，因为它们可能包含敏感或不安全内容。\">1 saved item(s) are paused because they may contain sensitive or unsafe content.</p>");
      expect(html).not.toContain("<strong data-i18n-en=\"Quarantined records hidden\"");
      expect(html).toContain("<details class=\"attention-info-group\" data-dashboard-detail=\"attention-info-checks\">");
      expect(html).toContain("<span data-i18n-en=\"Background checks\" data-i18n-zh=\"后台检查\">Background checks</span>");
      expect(html).toContain("<small data-i18n-en=\"Routine checks\" data-i18n-zh=\"日常检查\">Routine checks</small>");
      expect(html).not.toContain("<small>1 info item</small>");
      expect(html).toContain("<div class=\"attention-info-list\">");
      expect(html).toContain("<details class=\"attention info\" data-dashboard-detail=\"attention:Sync is not configured\">");
      expect(html).toContain("<summary class=\"attention-summary\">");
      expect(html).toContain("<div class=\"attention-body\">");
      expect(html).not.toContain("<article class=\"attention warning\">");
      expect(html).not.toContain("<details class=\"panel supporting-evidence\" data-dashboard-detail=\"supporting-evidence\" aria-label=\"Supporting Evidence\">");
      expect(html).not.toContain("<small>4 evidence groups | collapsed by default</small>");
      expect(html).not.toContain("<small>audit reports / store signals / debug inspector</small>");
      const auditReportsHtml = supportingEvidenceSummaryRowHtml(html, "audit-reports");
      const storeSnapshotHtml = supportingEvidenceSummaryRowHtml(html, "store-snapshot");
      const rawStoreHtml = supportingEvidenceSummaryRowHtml(html, "raw-store");
      expect(auditReportsHtml).toContain("data-dashboard-detail=\"supporting-operational-evidence\"");
      expect(storeSnapshotHtml).toContain("data-dashboard-detail=\"supporting-operational-snapshots\"");
      expect(rawStoreHtml).toContain("data-dashboard-detail=\"debug-inspector\"");
      expect(auditReportsHtml).toContain("<strong data-i18n-en=\"Audit Reports\" data-i18n-zh=\"审计报告\">Audit Reports</strong>");
      expect(auditReportsHtml).toContain("<span data-i18n-en=\"Lifecycle checks indexed\" data-i18n-zh=\"生命周期检查已建立索引\">Lifecycle checks indexed</span>");
      expect(auditReportsHtml).not.toContain("<span>Lifecycle and capture policy evidence</span>");
      expect(auditReportsHtml).toContain("<code data-dashboard-detail=\"memory-lifecycle-audit\">memory_lifecycle</code>");
      expect(auditReportsHtml).toContain("<code data-dashboard-detail=\"capture-policy-audit\">capture_policy</code>");
      expect(storeSnapshotHtml).toContain("<strong data-i18n-en=\"Store Snapshot\" data-i18n-zh=\"存储快照\">Store Snapshot</strong>");
      expect(storeSnapshotHtml).toContain("<span data-i18n-en=\"Store signals indexed\" data-i18n-zh=\"存储信号已建立索引\">Store signals indexed</span>");
      expect(storeSnapshotHtml).not.toContain("<span>Store signals and recent value</span>");
      expect(storeSnapshotHtml).toContain("<code data-dashboard-detail=\"store-signals\">sync</code>");
      expect(storeSnapshotHtml).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(rawStoreHtml).toContain("<strong data-i18n-en=\"Raw Store\" data-i18n-zh=\"原始存储\">Raw Store</strong>");
      expect(rawStoreHtml).toContain("<span data-i18n-en=\"Raw evidence indexed\" data-i18n-zh=\"原始依据已建立索引\">Raw evidence indexed</span>");
      expect(rawStoreHtml).not.toContain("<span>Records, events, and sync metadata</span>");
      expect(rawStoreHtml).toContain("<code data-dashboard-detail=\"supporting-evidence\">audit_trail</code>");
      expect(rawStoreHtml).toContain("<code data-dashboard-detail=\"inspector:records\">recent_records</code>");
      expect(rawStoreHtml).toContain("<code data-dashboard-detail=\"inspector:events\">recent_events</code>");
      expect(rawStoreHtml).toContain("<code data-dashboard-detail=\"inspector:sync\">sync</code>");
      expect(html).toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(html).not.toContain("<details class=\"supporting-evidence-full-details\"");
      expect(html).not.toContain("<details class=\"supporting-evidence-group");
      expect(html).not.toContain("<details class=\"panel debug-inspector\"");
      expect(html).not.toContain("<details id=\"store-signals\" class=\"panel store-signals\"");
      expect(html).not.toContain("<details class=\"panel recent-value-panel\"");
      expect(rawStoreHtml).not.toContain("Raw Store Inspector");
      expect(rawStoreHtml).not.toContain("Agent Activity");
      expect(rawStoreHtml).not.toContain("Record Quality");
      expect(rawStoreHtml).not.toContain("Record Types");
      expect(rawStoreHtml).not.toContain("recent-value-reference");
      expect(JSON.stringify(data.memory_lifecycle)).toContain("policy");
      expect(JSON.stringify(data.capture_policy)).toContain("decisions_by_record_id");
      expect(data.recent_records.length).toBeGreaterThan(0);
      expect(data.recent_events.length).toBeGreaterThan(0);
      expect(html).not.toContain("<div class=\"table-wrap\">");
      expect(html).toContain("class=\"neutral-intelligence\"");
      expect(html).toContain("--canvas:");
      expect(html).toContain("--ink:");
      expect(html).toContain("--signal-blue:");
      expect(html).toContain("font-feature-settings:");
      expect(html).toContain(".action-board-grid");
      expect(html).toContain(".action-board-item.warning");
      expect(html).toContain(".bar-row:nth-child(3)");
      expect(html).toContain(".reference-library-index");
      expect(html).toContain(".dashboard-fold-summary");
      expect(html).toContain("flex-wrap: wrap");
      expect(html).toContain("min-width: 0");
      expect(html).toContain("overflow-wrap: anywhere");
      expect(html).not.toContain("Memory Quality");
      expect(html).toContain("overflow-wrap: anywhere");
      expect(html).toContain("table-layout: fixed");
      expect(html).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
      expect(html).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(data.recent_value.length).toBeGreaterThan(0);
      expect(html).not.toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; visible text");
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
      const auditTrailHtml = supportingEvidenceSummaryRowHtml(html, "store-snapshot");

      expect(data.recent_value[0]?.summary).toBe(longText);
      expect(auditTrailHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"store-snapshot\" data-supporting-evidence-summary=\"store-snapshot\" data-dashboard-detail=\"supporting-operational-snapshots\">");
      expect(auditTrailHtml).toContain("<span data-i18n-en=\"Store signals indexed\" data-i18n-zh=\"存储信号已建立索引\">Store signals indexed</span>");
      expect(auditTrailHtml).not.toContain("<span>Store signals indexed</span>");
      expect(auditTrailHtml).not.toContain("<span>Store signals and recent value</span>");
      expect(auditTrailHtml).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(html).toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(auditTrailHtml).not.toContain("Important compact recent value intro.");
      expect(auditTrailHtml).not.toContain("data-full-summary-hidden=\"true\"");
      expect(auditTrailHtml).not.toContain("Full text available through timeline/recall.");
      expect(data.recent_value[0]?.citation).toMatchObject({
        record_id: "rec_recent_long",
        event_id: "evt_recent_long",
        timeline_command: "moryn timeline --record-id rec_recent_long --project-id moryn",
        recall_command: "moryn recall --record-id rec_recent_long --project-id moryn"
      });
      expect(auditTrailHtml).not.toContain("<details data-dashboard-detail=\"value:rec_recent_long\">");
      expect(auditTrailHtml).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Audit trace commands: Memory decision rec_recent_long\">");
      expect(auditTrailHtml).not.toContain("<small>rec_recent_long</small>");
      expect(auditTrailHtml).not.toContain("<span>Trace commands</span>");
      expect(auditTrailHtml).not.toContain("<small>Audit commands</small>");
      expect(auditTrailHtml).not.toContain("<small>Memory decision rec_recent_long</small>");
      expect(auditTrailHtml).not.toContain("<small>Memory decision</small>");
      expect(auditTrailHtml).not.toContain("<summary>Audit trace</summary>");
      expect(auditTrailHtml).not.toContain("<summary>Details</summary>");
      expect(auditTrailHtml).not.toContain("<summary>Trace commands</summary>");
      expect(auditTrailHtml).not.toContain("<article class=\"value-card\" data-dashboard-citation=\"record:rec_recent_long\">");
      expect(auditTrailHtml).not.toContain("<span>Codex rec_recent_long</span>");
      expect(auditTrailHtml).not.toContain("<footer>\n        <span>Codex</span>");
      expect(auditTrailHtml).not.toContain("<span>Trace</span>");
      expect(auditTrailHtml).not.toContain("<dt>ID</dt><dd><code>rec_recent_long</code></dd>");
      expect(auditTrailHtml).not.toContain("<dt>Event</dt><dd><code>evt_recent_long</code></dd>");
      expect(auditTrailHtml).not.toContain("<dt>Source</dt><dd>codex</dd>");
      expect(auditTrailHtml).not.toContain("<dt>Kind</dt><dd>memory / decision</dd>");
      expect(auditTrailHtml).not.toContain("moryn timeline --record-id rec_recent_long");
      expect(auditTrailHtml).not.toContain("moryn recall --record-id rec_recent_long");
      expect(auditTrailHtml).not.toContain("FULL_CONTENT_SENTINEL");
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

      expect(html).not.toContain("<span>Moryn Local rec_abcdef12</span>");
      expect(data.recent_value[0]?.citation).toMatchObject({
        record_id: "rec_abcdef1234567890abcdef1234567890",
        event_id: "evt_recent_hash",
        timeline_command: "moryn timeline --record-id rec_abcdef1234567890abcdef1234567890 --project-id moryn",
        recall_command: "moryn recall --record-id rec_abcdef1234567890abcdef1234567890 --project-id moryn"
      });
      expect(html).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
      expect(html).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(html).toContain("<strong data-i18n-en=\"Raw Store\" data-i18n-zh=\"原始存储\">Raw Store</strong>");
      expect(html).not.toContain("<strong>Raw Store</strong>");
      expect(html).toContain("<code data-dashboard-detail=\"inspector:records\">recent_records</code>");
      expect(html).not.toContain("<summary aria-label=\"Record details: Skill codex_skill_bundle from Moryn Local rec_abcdef12\">");
      expect(html).not.toContain("<summary aria-label=\"Record Index: Skill codex_skill_bundle from Moryn Local rec_abcdef12\">");
      expect(html.match(/Record Index/g) ?? []).toHaveLength(0);
      expect(html).not.toContain("<span>Record rec_abcdef12</span>");
      expect(html).not.toContain("<small>Details</small>");
      expect(html).not.toContain("<span>Skill codex_skill_bundle</span>");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Audit trace commands: Skill codex_skill_bundle rec_abcdef12\">");
      expect(html).not.toContain("<span>Trace</span>");
      expect(html).not.toContain("<small>rec_abcdef12</small>");
      expect(html).not.toContain("data-dashboard-detail=\"value:rec_abcdef1234567890abcdef1234567890\"");
      expect(html).not.toContain("<span>Trace commands</span>");
      expect(html).not.toContain("<small>Audit commands</small>");
      expect(html).not.toContain("<small>Skill codex_skill_bundle rec_abcdef12</small>");
      expect(html).not.toContain("<span>Moryn Local rec_abcdef1234567890abcdef1234567890</span>");
      expect(html).not.toContain("<small>Skill codex_skill_bundle rec_abcdef1234567890abcdef1234567890</small>");
      expect(html).not.toContain("<dt>ID</dt><dd><code>rec_abcdef1234567890abcdef1234567890</code></dd>");
      expect(html).not.toContain("moryn recall --record-id rec_abcdef1234567890abcdef1234567890");
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
      const debugHtml = supportingEvidenceSummaryRowHtml(html, "raw-store");

      expect(data.recent_records).toHaveLength(13);
      expect(data.recent_events).toHaveLength(13);
      expect(data.recent_records[0]?.text).toContain("base64 IyBSZW53ZWkgV3JpdGluZy");
      expect(debugHtml).toContain("<strong data-i18n-en=\"Raw Store\" data-i18n-zh=\"原始存储\">Raw Store</strong>");
      expect(debugHtml).toContain("<span data-i18n-en=\"Raw evidence indexed\" data-i18n-zh=\"原始依据已建立索引\">Raw evidence indexed</span>");
      expect(debugHtml).not.toContain("<span>Records, events, and sync metadata</span>");
      expect(debugHtml).toContain("<code data-dashboard-detail=\"inspector:records\">recent_records</code>");
      expect(debugHtml).toContain("<code data-dashboard-detail=\"inspector:events\">recent_events</code>");
      expect(debugHtml).toContain("<code data-dashboard-detail=\"inspector:sync\">sync</code>");
      expect(html).toContain("Open <code>/api/dashboard</code> for routine diagnostics, candidate backlog, governance notes, dogfood notes, audit reports, and raw evidence.");
      expect(html).not.toContain("Raw Store Inspector");
      expect(html).not.toContain("<small>API-backed raw evidence</small>");
      expect(html).not.toContain("<article class=\"debug-inspector-reference\" data-dashboard-detail=\"inspector:records\">");
      expect(html).not.toContain("<article class=\"debug-inspector-reference\" data-dashboard-detail=\"inspector:events\">");
      expect(html).not.toContain("<article class=\"debug-inspector-reference\" data-dashboard-detail=\"inspector:sync\">");
      expect(debugHtml).not.toContain("<div class=\"table-wrap\">");
      expect(debugHtml).not.toContain("<th>Content</th>");
      expect(debugHtml).not.toContain("<th>Text</th>");
      expect(debugHtml).not.toContain(`data-dashboard-detail="record:${noisySummaryRecord.record.id}"`);
      expect(debugHtml).not.toContain(`Codex ${noisySummaryRecord.record.id}`);
      expect(debugHtml).not.toContain("base64 IyBSZW53ZWkgV3JpdGluZy");
      expect(debugHtml.match(/data-dashboard-detail="record:rec_debug_budget_/g) ?? []).toHaveLength(0);
      expect(debugHtml.match(/data-dashboard-detail="event:evt_debug_budget_/g) ?? []).toHaveLength(0);
      expect(debugHtml).not.toContain("data-dashboard-detail=\"record:rec_debug_budget_3\"");
      expect(debugHtml).not.toContain("data-dashboard-detail=\"record:rec_debug_budget_2\"");
      expect(debugHtml).not.toContain("data-dashboard-detail=\"record:rec_debug_budget_1\"");
      expect(debugHtml).not.toContain("data-dashboard-detail=\"event:evt_debug_budget_3\"");
      expect(debugHtml).not.toContain("data-dashboard-detail=\"event:evt_debug_budget_2\"");
      expect(debugHtml).not.toContain("data-dashboard-detail=\"event:evt_debug_budget_1\"");
      expect(data.recent_events[0]?.op).toBe("upsert_record");
      expect(debugHtml).not.toContain("<span>Record update</span>");
      expect(debugHtml).not.toContain("<span>Upsert Record</span>");
      expect(debugHtml).not.toContain("<span class=\"debug-inspector-overflow-count\">");
      expect(debugHtml).not.toContain("<details data-dashboard-detail=\"inspector:records\">");
      expect(debugHtml).not.toContain("<details data-dashboard-detail=\"inspector:events\">");
      expect(debugHtml).not.toContain("<details data-dashboard-detail=\"inspector:sync\">");
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
      expect(html).not.toContain("<details class=\"panel recent-value-panel\" data-dashboard-detail=\"recent-value\">");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary recent-value-fold\">");
      expect(html).not.toContain("<span>Recent Value</span>");
      expect(html).not.toContain("<small>6 recent records</small>");
      expect(html).not.toContain("<small>6 records | newest first | full details kept</small>");
      expect(html).not.toContain("<div class=\"recent-value-body\">");
      expect(html).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
      expect(html).not.toContain("<span>6 recent records available</span>");
      expect(html).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(html).not.toContain("data-dashboard-detail=\"recent-value-overflow\"");
      expect(html).not.toContain("<span>More Recent Value</span>");
      expect(html).not.toContain("<small>2 additional records</small>");
      expect(html).not.toContain("<details open data-dashboard-detail=\"recent-value-overflow\"");
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
      expect(html).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
      expect(html).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(html).not.toContain(`data-dashboard-citation="record:${written.record.id}"`);
      expect(html).not.toContain(`data-dashboard-citation="event:evt_cite_1"`);
      expect(html).not.toContain(`moryn timeline --event-id evt_cite_1 --project-id moryn`);
      expect(html).not.toContain(`data-dashboard-detail="value:${written.record.id}"`);
      expect(html).not.toContain(`moryn recall --record-id ${written.record.id} --project-id moryn`);
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
        expect(fragment).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
        expect(fragment).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
        expect(fragment).not.toContain("Private dashboard memory.");
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
      expect(html).toContain("<article class=\"supporting-evidence-summary-row\" data-supporting-evidence-summary=\"audit-reports\" data-dashboard-detail=\"supporting-operational-evidence\">");
      expect(html).toContain("<code data-dashboard-detail=\"memory-lifecycle-audit\">memory_lifecycle</code>");
      expect(html).toContain("data-governance-item=\"memory_lifecycle:archive_candidates\"");
      expect(html).toContain("archive_after_review");
      expect(html).toContain("data-governance-safe-item=\"memory_lifecycle:stale_records\"");
      const auditTrailStart = html.indexOf("<details class=\"panel supporting-evidence\" data-dashboard-detail=\"supporting-evidence\" aria-label=\"Supporting Evidence\">");
      const auditTrailEnd = html.indexOf("</details>", auditTrailStart);
      const auditTrailHtml = html.slice(auditTrailStart, auditTrailEnd);
      expect(auditTrailStart).toBeGreaterThan(-1);
      expect(auditTrailHtml).not.toContain("default_memory_lifecycle_policy");
      expect(auditTrailHtml).not.toContain("Archive candidates");
      expect(auditTrailHtml).not.toContain("Stale records");
      expect(auditTrailHtml).not.toContain("archive_after_review");
      expect(auditTrailHtml).not.toContain(`moryn archive ${archiveCandidate.record.id}`);
      expect(auditTrailHtml).not.toContain(`moryn timeline --record-id ${staleRecord.record.id} --project-id moryn`);
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
      expect(html).toContain("Candidate noise cleanup");
      const candidateTriageHtml = dashboardDetailBlock(html, "candidate-triage");
      expect(candidateTriageHtml).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"candidate-triage\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(candidateTriageHtml).toContain("<span>3 candidates across 1 group indexed</span>");
      expect(data.candidate_triage.review_focus).toMatchObject({
        group_id: "likely_noise",
        summary: "Start with Likely noise: Inspect likely noise before archive",
        evidence_path: "candidate_triage.groups_by_id.likely_noise"
      });
      expect(candidateTriageHtml).toContain("<span data-candidate-triage-focus>Audit focus: Likely noise - Inspect likely noise before archive</span>");
      expect(candidateTriageHtml).not.toContain("<span data-candidate-triage-focus>Start with Likely noise: Inspect likely noise before archive</span>");
      expect(candidateTriageHtml).not.toContain("<article class=\"candidate-triage-reference\" data-dashboard-detail=\"candidate-triage\" data-candidate-triage-reference data-reference-library-index=\"candidate-triage\">");
      expect(candidateTriageHtml).not.toContain("candidate-triage-index-card");
      expect(candidateTriageHtml).not.toContain("<strong>Likely noise</strong>");
      expect(candidateTriageHtml).not.toContain("<small>3 records indexed | Review Queue cleanup ready</small>");
      expect(candidateTriageHtml).not.toContain("candidate-triage-index-route");
      expect(candidateTriageHtml).not.toContain("Review cleanup plan");
      expect(candidateTriageHtml).not.toContain("Archive happens only through Review Queue approval.");
      expect(candidateTriageHtml).not.toContain("data-dashboard-action-id");
      expect(candidateTriageHtml).not.toContain("data-maintenance-approve");
      expect(candidateTriageHtml).not.toContain("Archive Noise");
      expect(candidateTriageHtml).not.toContain("Approve Memory");
      const noiseBriefStart = html.indexOf("<div class=\"maintenance-brief\" data-maintenance-brief>");
      const noiseBriefEnd = html.indexOf("</p>", noiseBriefStart) + "</p>".length;
      const noiseBriefHtml = html.slice(noiseBriefStart, noiseBriefEnd);
      expect(noiseBriefHtml).toContain("<h4>Approval brief</h4>");
      expect(noiseBriefHtml).not.toContain("<h4>Approval summary</h4>");
      expect(noiseBriefHtml).toContain("<dt>Change</dt><dd>Archive 3 candidates</dd>");
      expect(noiseBriefHtml).toContain("<dt>Scope</dt><dd>Marker noise</dd>");
      expect(noiseBriefHtml).toContain("<dt>Guard</dt><dd>Server rechecks plan hash before writing</dd>");
      expect(noiseBriefHtml).toContain("<dt>Writes</dt><dd>append-only archive_record events</dd>");
      expect(noiseBriefHtml).not.toContain("<span>Plan hash checked</span>");
      expect(noiseBriefHtml).not.toContain("<span>1 private record skipped</span>");
      expect(noiseBriefHtml).toContain("<p>1 private record skipped.</p>");
      expect(noiseBriefHtml).not.toContain("This cleanup would archive 3 candidate records that look like smoke/e2e marker noise.");
      expect(noiseBriefHtml).not.toContain("<dl class=\"maintenance-outcome\" data-maintenance-outcome>");
      expect(noiseBriefHtml).not.toContain("Appends <code>archive_record</code> events after the <code>plan_hash</code> check");
      expect(noiseBriefHtml).not.toContain("Hides this card for this browser session only; store history is unchanged.");
      expect(html).not.toContain("class=\"maintenance-plan-flags\"");
      expect(html).not.toContain("<span>Review before write</span>");
      expect(html).not.toContain("<span>Plan hash guard</span>");
      expect(html).not.toContain("3 candidate records look like smoke/e2e marker noise.");
      expect(html).not.toContain("data-maintenance-decision-summary");
      expect(html).not.toContain("<span>Decision summary</span>");
      expect(html).not.toContain("<small>Why, change, safety, action</small>");
      expect(html).toContain("<span>Decision details</span>");
      expect(html).toContain("<small>Context and evidence</small>");
      expect(html).not.toContain("<span>Audit details</span>");
      expect(html).not.toContain("<small>Approval context, raw evidence</small>");
      expect(html).toContain("<div class=\"maintenance-review-notes\" data-maintenance-approval-context>");
      expect(html).toContain("<h4>Approval context</h4>");
      expect(html).toContain("<dt>Why</dt><dd>Memory Doctor found smoke/e2e marker candidates.</dd>");
      expect(html).toContain("<dt>Change</dt><dd>Archive 3 candidates after you confirm they are test noise.</dd>");
      expect(html).toContain("<dt>Guard</dt><dd>No write happens until Archive Noise; the server re-runs the dry run and checks <code>plan_hash</code> before writing.</dd>");
      expect(html).toContain("<dt>Trace</dt><dd>Raw record ids, equivalent archive commands, and <code>plan_hash</code> stay in Evidence trace.</dd>");
      expect(html).not.toContain("<h4>Review notes</h4>");
      expect(html).not.toContain("<dt>Impact</dt>");
      expect(html).not.toContain("<dt>Safety</dt>");
      expect(html).not.toContain("<dt>Audit</dt>");
      expect(html).not.toContain("<h4>Why this matters</h4>");
      expect(html).not.toContain("<h4>Write preview</h4>");
      expect(html).not.toContain("<strong>Detected</strong>");
      expect(html).not.toContain("<strong>Impact</strong>");
      expect(html).not.toContain("Candidate cleanup found smoke/e2e marker noise.");
      expect(html).not.toContain("Approving appends archive_record events only; Reject hides this card for the browser session.");
      expect(html).not.toContain("<strong>Issue:</strong> Candidate cleanup found smoke/e2e marker noise.");
      expect(html).not.toContain("<span>Confirm notes</span>");
      expect(html).not.toContain("<span>Approval checklist</span>");
      expect(html).toContain("Archive Noise");
      expect(html).toContain("Operation appends archive_record events only");
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

      expect(html).toContain("<span>Decision details</span>");
      expect(html).not.toContain("<span>Audit details</span>");
      expect(html).toContain("<dt>Record ids</dt>");
      expect(html).toContain("<div class=\"maintenance-record-id-summary\">");
      expect(html).toContain("<span class=\"maintenance-overflow-count\">3 more record ids kept below</span>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"All record ids: 6 record ids\">");
      expect(html).toContain("<span>All record ids</span>");
      expect(html).toContain("<small>6 ids, audit ready</small>");
      expect(html).toContain("<div class=\"maintenance-record-id-list\">");
      expect(html).toContain("<dt>Command</dt>");
      expect(html).toContain("<div class=\"maintenance-command-summary\">");
      expect(html).toContain("<code>6 archive commands</code>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Full command: 6 archive commands, copy button uses full command\">");
      expect(html).toContain("<span>Full command</span>");
      expect(html).toContain("<small>copy button uses full command</small>");
      const commandSummaryStart = html.indexOf("<div class=\"maintenance-command-summary\">");
      const commandSummaryEnd = html.indexOf("</div>", html.indexOf("</details>", commandSummaryStart));
      const commandSummaryHtml = html.slice(commandSummaryStart, commandSummaryEnd);
      expect(commandSummaryHtml).toContain("data-maintenance-copy");
      expect(commandSummaryHtml).toContain("Copy command");
      expect(html).toContain("data-command=\"moryn archive rec_large_noise_7");
      expect(html).toContain("rec_large_noise_2 --reason");
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
      expect(html).toContain("Review Queue");
      expect(html).toContain("<section id=\"decision-summary\" class=\"panel decision-summary\" data-dashboard-detail=\"decision-summary\" aria-label=\"Decision Summary\">");
      expect(html).toContain("<h2>Pending Decisions</h2>");
      expect(html).toContain("Review 1 explicit approval before any memory write.");
      const decisionSummaryStart = html.indexOf("data-dashboard-detail=\"decision-summary\"");
      const decisionSummaryEnd = html.indexOf("data-dashboard-detail=\"maintenance-review-queue\"", decisionSummaryStart);
      const decisionSummaryHtml = html.slice(decisionSummaryStart, decisionSummaryEnd);
      expect(decisionSummaryHtml).toContain("<span>1 Review Queue</span>");
      expect(decisionSummaryHtml).toContain("<strong>Review Queue</strong>");
      expect(decisionSummaryHtml).toContain("1 explicit approval waiting in Review Queue.");
      expect(decisionSummaryHtml).toContain("data-decision-summary-route=\"maintenance-review\"");
      expect(decisionSummaryHtml).toContain("<small>Append-only, guarded in owning surface</small>");
      expect(decisionSummaryHtml).not.toContain("<span>Apply Repair</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Append-only events</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Plan hash guard</span>");
      expect(decisionSummaryHtml).not.toContain("<span>approval required</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Audit evidence</span>");
      expect(decisionSummaryHtml).not.toContain("Project identity repair");
      expect(decisionSummaryHtml).not.toContain("Move 1 record from the old project id into moryn.");
      expect(html).toContain("Project identity repair");
      expect(html).not.toContain("<span>maintenance.plans[]</span>");
      expect(html).not.toContain("<details class=\"decision-summary-evidence\" data-dashboard-detail=\"decision-summary-evidence:");
      expect(html).not.toContain("<summary>Evidence source</summary>");
      expect(html).not.toContain("<dt>Path</dt><dd><code>maintenance.plans[]</code></dd>");
      expect(html).not.toContain("<dt>Write boundary</dt><dd>Append-only events<small>Apply Repair appends revise_record events only after the plan_hash guard passes.</small></dd>");
      expect(html).not.toContain("<dt>Evidence</dt><dd><code>maintenance.plans[]</code></dd>");
      expect(html).not.toContain("<dt>Writes</dt><dd>append_only_events");
      expect(html).toContain("data-action-board-target=\"maintenance-review-queue\"");
      expect(html).toContain("<details id=\"maintenance-review-queue\" class=\"maintenance-review-summary\" data-dashboard-detail=\"maintenance-review-queue\">");
      expect(html.indexOf("data-dashboard-detail=\"decision-summary\"")).toBeLessThan(
        html.indexOf("data-dashboard-detail=\"maintenance-review-queue\"")
      );
      expect(data.attention_items.some((item) => item.severity === "info")).toBe(true);
      expect(html).not.toContain("<section id=\"needs-attention\" class=\"needs-attention-quiet-line\"");
      expect(html).not.toContain("data-dashboard-detail=\"attention-info-checks\"");
      expect(html).not.toContain("<span>Background checks</span>");
      expect(html).not.toContain("data-dashboard-detail=\"action-board\"");
      expect(html).not.toContain("data-action-board-nav");
      expect(html).not.toContain("<span>Page Shortcuts</span>");
      expect(html).toContain("data-dashboard-detail=\"evidence-library\"");
      expect(html).toContain("<small>Audit evidence only</small>");
      expect(html).not.toContain("<small>Reference material</small>");
      expect(html).not.toContain("data-evidence-library-brief");
      expect(html).not.toContain("<h3>Evidence index</h3>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary maintenance-review-fold\">");
      expect(html).toContain("<span>Review Queue</span>");
      expect(html).toContain("<small>Approval required</small>");
      expect(html).not.toContain("<small>1 decision to review | 1 record to move | approval required</small>");
      expect(html).toContain("<div class=\"maintenance-review-body\">");
      expect(html).toContain("Project identity repair");
      expect(html).not.toContain("1 record under repo-e6f0166fd942 likely belongs to moryn.");
      expect(html).not.toContain("data-maintenance-decision-summary");
      expect(html).not.toContain("<span>Decision summary</span>");
      expect(html).not.toContain("<small>Why, change, safety, action</small>");
      expect(html).toContain("data-maintenance-brief");
      expect(html).toContain("<h4>Approval brief</h4>");
      expect(html).toContain("<dt>Change</dt><dd>Move 1 record</dd>");
      expect(html).toContain("<dt>Scope</dt><dd>repo-e6f0166fd942 to moryn</dd>");
      expect(html).toContain("<dt>Guard</dt><dd>Server rechecks plan hash before writing</dd>");
      expect(html).toContain("<dt>Writes</dt><dd>append-only revise_record events</dd>");
      expect(html).not.toContain("<span>Plan hash checked</span>");
      expect(html).toContain("<p>No private records included.</p>");
      expect(data.action_board.items_by_id.review).toMatchObject({
        target: "needs-attention",
        next_action_label: "Open checks"
      });
      expect(data.action_board.items_by_id.review.next_action_label).not.toBe("Review warnings");
      const repairBriefStart = html.indexOf("<div class=\"maintenance-brief\" data-maintenance-brief>");
      const repairBriefEnd = html.indexOf("</p>", repairBriefStart) + "</p>".length;
      const repairBriefHtml = html.slice(repairBriefStart, repairBriefEnd);
      expect(repairBriefHtml).not.toContain("<h4>Decision brief</h4>");
      expect(repairBriefHtml).not.toContain("<h4>Approval summary</h4>");
      expect(repairBriefHtml).not.toContain("This repair would relink 1 record from <code>repo-e6f0166fd942</code> to <code>moryn</code>.");
      expect(repairBriefHtml).not.toContain("Approval is explicit: the server re-runs the dry run and checks the same <code>plan_hash</code> before writing.");
      expect(repairBriefHtml).not.toContain("<dl class=\"maintenance-outcome\" data-maintenance-outcome>");
      expect(repairBriefHtml).not.toContain("<dt>Approve</dt>");
      expect(repairBriefHtml).not.toContain("Appends <code>revise_record</code> events after the <code>plan_hash</code> check");
      expect(repairBriefHtml).not.toContain("<dt>Reject</dt>");
      expect(repairBriefHtml).not.toContain("Hides this card for this browser session only; store history is unchanged.");
      expect(html).not.toContain("class=\"maintenance-plan-flags\"");
      expect(html).not.toContain("<span>Review before write</span>");
      expect(html).not.toContain("<span>Plan hash guard</span>");
      expect(html).not.toContain("<details class=\"maintenance-decision-summary-fold\" data-dashboard-detail=\"maintenance-decision-summary:");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary maintenance-decision-summary-summary\">");
      expect(html).not.toContain("<summary>Decision summary</summary>");
      expect(html).toContain("<div class=\"maintenance-review-notes\" data-maintenance-approval-context>");
      expect(html).toContain("<h4>Approval context</h4>");
      expect(html).toContain("Why");
      expect(html).toContain("Change");
      expect(html).toContain("Guard");
      expect(html).toContain("Trace");
      expect(html).not.toContain("<h4>Why this matters</h4>");
      expect(html).not.toContain("<h4>Write preview</h4>");
      expect(html).not.toContain("Proposed change");
      expect(html).not.toContain("Safety gate");
      expect(html).not.toContain("Approval writes");
      expect(html).toContain("Move 1 record");
      expect(html).toContain("repo-e6f0166fd942 to moryn");
      expect(html).toContain("No write happens until Apply Repair; the server re-runs the dry run and checks <code>plan_hash</code> before writing.");
      expect(html).not.toContain("data-maintenance-review-log");
      expect(html).toContain("<details class=\"maintenance-audit-details\" data-dashboard-detail=\"maintenance-audit:");
      expect(html).toContain("<summary class=\"dashboard-fold-summary maintenance-audit-details-fold\">");
      expect(html).toContain("<span>Decision details</span>");
      expect(html).toContain("<small>Context and evidence</small>");
      expect(html).not.toContain("<span>Audit details</span>");
      expect(html).not.toContain("<small>Approval context, raw evidence</small>");
      expect(html).not.toContain("<small>Review notes, evidence trace</small>");
      expect(html).not.toContain("<summary>Decision evidence</summary>");
      expect(html).not.toContain("<summary>Evidence, rollback, and raw plan</summary>");
      expect(html).not.toContain("<summary>Audit trail</summary>");
      expect(html).not.toContain("<details class=\"maintenance-confirm-notes\" data-dashboard-detail=\"maintenance-confirm-notes:");
      expect(html).not.toContain("<span>Confirm notes</span>");
      expect(html).not.toContain("<small>Checklist before approval</small>");
      expect(html).not.toContain("<details class=\"approval-checklist\" data-dashboard-detail=\"maintenance-approval-checklist:");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary maintenance-approval-checklist-fold\">");
      expect(html).not.toContain("<span>Approval checklist</span>");
      expect(html).not.toContain("<small>Issue, safety gate, and audit path</small>");
      expect(html).not.toContain("<h4>Before approving</h4>");
      expect(html).not.toContain("<div class=\"review-log approval-checklist\" data-maintenance-review-log>");
      expect(html).not.toContain("<div class=\"review-log\" data-maintenance-review-log>\n      <h4>Review log</h4>");
      expect(html).not.toContain("<h4>Why this matters</h4>");
      expect(html).not.toContain("<h4>Decision record</h4>");
      expect(html).not.toContain("<strong>Detected</strong>");
      expect(html).not.toContain("<strong>Impact</strong>");
      expect(html).not.toContain("<strong>Proposed change</strong>");
      expect(html).not.toContain("<strong>Safety gate</strong>");
      expect(html).not.toContain("<strong>Approval writes</strong>");
      expect(html).toContain("<dt>Why</dt><dd>Memory Doctor found records under an old project id.</dd>");
      expect(html).toContain("<dt>Change</dt><dd>Move 1 record from <code>repo-e6f0166fd942</code> to <code>moryn</code>.</dd>");
      expect(html).toContain("<dt>Guard</dt><dd>No write happens until Apply Repair; the server re-runs the dry run and checks <code>plan_hash</code> before writing.</dd>");
      expect(html).toContain("<dt>Trace</dt><dd>Raw record ids, rollback path, equivalent CLI command, and <code>plan_hash</code> stay in Evidence trace.</dd>");
      expect(html).not.toContain("<h4>Review notes</h4>");
      expect(html).not.toContain("<dt>Impact</dt>");
      expect(html).not.toContain("<dt>Safety</dt>");
      expect(html).not.toContain("<dt>Audit</dt>");
      expect(html).not.toContain("Project identity repair found records under an old project id.");
      expect(html).not.toContain("Boot and recall can miss these records until the project id is repaired.");
      expect(html).toContain("Move 1 record from <code>repo-e6f0166fd942</code> to <code>moryn</code>.");
      expect(html).not.toContain("The server re-runs the dry run and checks <code>plan_hash</code> before writing.");
      expect(html).not.toContain("Approving appends revise_record events only; Reject hides this card for the browser session.");
      expect(html).not.toContain("Raw plan, record ids, rollback path, equivalent CLI command, and <code>plan_hash</code> stay below.");
      expect(html).not.toContain("<strong>Issue:</strong> Project identity repair found records under an old project id.");
      expect(html).not.toContain("<strong>Proposed change:</strong> Move 1 record from <code>repo-e6f0166fd942</code> to <code>moryn</code>.");
      expect(html).not.toContain("<strong>Safety gate:</strong> Server re-runs the dry run and checks <code>plan_hash</code> before writing.");
      expect(html).not.toContain("<strong>Audit path:</strong> Raw plan, record ids, rollback path, equivalent CLI command, and <code>plan_hash</code> stay below.");
      expect(html).toContain("<details class=\"maintenance-plan-evidence\" data-dashboard-detail=\"maintenance-plan-evidence:");
      expect(html).toContain("<span>Evidence trace</span>");
      expect(html).toContain("<small>Rollback, raw plan, command</small>");
      expect(html).toContain("data-maintenance-detail=\"evidence\"");
      expect(html).toContain("data-maintenance-detail=\"rollback\"");
      expect(html).toContain("data-maintenance-detail=\"raw-plan\"");
      const auditDetailsStart = html.indexOf("<details class=\"maintenance-audit-details\" data-dashboard-detail=\"maintenance-audit:");
      const reviewNotesStart = html.indexOf("<div class=\"maintenance-review-notes\" data-maintenance-approval-context>", auditDetailsStart);
      const planEvidenceStart = html.indexOf("<details class=\"maintenance-plan-evidence\" data-dashboard-detail=\"maintenance-plan-evidence:", auditDetailsStart);
      const directGridStart = html.indexOf("<div class=\"maintenance-detail-grid\">", auditDetailsStart);
      expect(reviewNotesStart).toBeGreaterThan(auditDetailsStart);
      expect(planEvidenceStart).toBeGreaterThan(auditDetailsStart);
      expect(planEvidenceStart).toBeGreaterThan(reviewNotesStart);
      expect(directGridStart).toBeGreaterThan(planEvidenceStart);
      expect(html).toContain("Evidence");
      expect(html).toContain("Rollback path");
      expect(html).toContain("append-only revise_record events");
      expect(html).toContain("moryn project migrate --from moryn --to repo-e6f0166fd942 --apply --confirm");
      expect(html).toContain("repo-e6f0166fd942");
      expect(html).toContain("Apply Repair");
      const actionsStart = html.indexOf("<div class=\"maintenance-actions\">");
      const actionsEnd = html.indexOf("</div>", actionsStart);
      const actionsHtml = html.slice(actionsStart, actionsEnd);
      expect(actionsHtml).toContain("data-maintenance-reject");
      expect(actionsHtml).toContain("data-maintenance-approve");
      expect(actionsHtml).not.toContain("data-maintenance-copy");
      expect(actionsHtml).not.toContain("Copy command");
      expect(html).toContain("No private records included");
      expect(html).toContain("Dry-run completed");
      expect(html).toContain("Operation appends revise_record events only");
      expect(html).toContain("data-endpoint=\"api/maintenance/plans/");
      expect(html).not.toContain("data-endpoint=\"/api/maintenance/plans/");
      expect(html).toContain("plan_hash");
      expect(html).toContain("data-maintenance-plan");
      expect(html).toContain("data-maintenance-approve");
      expect(html).toContain("data-maintenance-reject");
      expect(html).toContain("data-dashboard-action-id=\"maintenance.plan.approve.");
      expect(html).toContain("Applying repair...");
      expect(html).toContain("renderActionReceipt");
      expect(html).toContain("<section id=\"last-action-receipt\"");
      expect(html).toContain("moryn.dashboard.lastActionReceipt");
      expect(html).toContain("Action receipt");
      expect(html).toContain("i18nPair(\"span\", \"Action receipt\", \"操作回执\", \"action-receipt-title\")");
      expect(html).toContain("Store updated");
      expect(html).toContain("i18nPair(\"strong\", \"Store updated\", \"存储已更新\")");
      expect(html).toContain("Write boundary");
      expect(html).toContain("i18nPair(\"strong\", \"Write boundary\", \"写入边界\")");
      expect(html).toContain("Changed");
      expect(html).toContain("i18nPair(\"strong\", \"Changed\", \"已更新\")");
      expect(html).toContain("Trace");
      expect(html).toContain("i18nPair(\"strong\", \"Trace\", \"追踪\")");
      expect(html).toContain("Trace details");
      expect(html).toContain("i18nPair(\"span\", \"Trace details\", \"追踪详情\")");
      expect(html).toContain("Records and events");
      expect(html).toContain("i18nPair(\"small\", \"Records and events\", \"记录和事件\")");
      expect(html).not.toContain("<span>Audit trail</span>");
      expect(html).not.toContain("<small>Record and event ids</small>");
      expect(html).toContain("Trace commands");
      expect(html).toContain("i18nPair(\"dt\", \"Trace commands\", \"追踪命令\")");
      expect(html).toContain("Decision");
      expect(html).toContain("i18nPair(\"dt\", \"Decision\", \"决定\")");
      expect(html).toContain("i18nPair(\"dt\", \"Context\", \"上下文\")");
      expect(html).toContain("i18nPair(\"dt\", \"Records\", \"记录\")");
      expect(html).toContain("i18nPair(\"dt\", \"Events\", \"事件\")");
      expect(html).toContain("Audit status");
      expect(html).toContain("i18nPair(\"dt\", \"Audit status\", \"追踪状态\")");
      expect(html).toContain("User approved Capture Inbox candidate.");
      expect(html).toContain("zh_decision: decisionLabelZh(result)");
      expect(html).toContain("User rejected Capture Inbox candidate.");
      expect(html).toContain("Append-only events");
      expect(html).toContain("zh_write_boundary: \"追加事件\"");
      expect(html).toContain("Timeline ready");
      expect(html).toContain("zh_audit_status: eventIds.length > 0 ? \"时间线已就绪\" : \"未返回追踪 id\"");
      expect(html).toContain("No trace id returned");
      expect(html).toContain("record updated");
      expect(html).toContain("zh_changed: changedLabelZh(changedCount)");
      expect(html).toContain("data-i18n-en=\"${htmlEscape(receipt.decision)}\" data-i18n-zh=\"${htmlEscape(receipt.zh_decision)}\"");
      expect(html).toContain("data-i18n-en=\"${htmlEscape(receipt.write_boundary)}\" data-i18n-zh=\"${htmlEscape(receipt.zh_write_boundary)}\"");
      expect(html).toContain("data-i18n-en=\"${htmlEscape(receipt.changed)}\" data-i18n-zh=\"${htmlEscape(receipt.zh_changed)}\"");
      expect(html).toContain("data-i18n-en=\"${htmlEscape(receipt.audit_status)}\" data-i18n-zh=\"${htmlEscape(receipt.zh_audit_status)}\"");
      expect(html).not.toContain("Targets");
      expect(html).not.toContain("write target");
      expect(html).not.toContain("Traceable by timeline");
      expect(html).not.toContain("No event id returned");
      expect(html).not.toContain("<dt>Result</dt>");
      expect(html).not.toContain("<dt>Changed</dt>");
      expect(html).not.toContain("<dt>Outcome</dt>");
      expect(html).not.toContain("<dt>Decision context</dt>");
      expect(html).not.toContain("<dt>Write targets</dt>");
      expect(html).not.toContain("<dt>Audit next</dt>");
      expect(html).not.toContain("<dt>Audit commands</dt>");
      expect(html).toContain("moryn timeline --event-id");
      expect(html).toContain("moryn recall --record-id");
      expect(html).toContain("const setActionStatus = (status, en, zh = en) => {");
      expect(html).toContain("status.dataset.i18nEn = en;");
      expect(html).toContain("status.dataset.i18nZh = zh;");
      expect(html).toContain("status.textContent = window.currentDashboardLanguage?.() === \"zh\" ? zh : en;");
      expect(html).toContain("setActionStatus(status, \"Approving memory...\", \"正在批准为记忆...\");");
      expect(html).toContain("setActionStatus(status, \"Rejecting candidate...\", \"正在拒绝候选内容...\");");
      expect(html).toContain("setActionStatus(status, \"Approved. Receipt saved; refreshing dashboard...\", \"已批准。回执已保存，正在刷新 dashboard...\");");
      expect(html).toContain("setActionStatus(status, \"Rejected. Receipt saved; refreshing dashboard...\", \"已拒绝。回执已保存，正在刷新 dashboard...\");");
      expect(html).toContain("setActionStatus(status, \"Capture Inbox action failed.\", \"Capture Inbox 操作失败。\");");
      expect(html).toContain("setActionStatus(status, \"Candidate Triage approval failed.\", \"候选内容批准失败。\");");
      expect(html).toContain("setActionStatus(status, \"Applying memory approval...\", \"正在批准为记忆...\");");
      expect(html).not.toContain("Receipt rendered below");
      expect(html).not.toContain("renderActionReceipt?.(status, result)");
      expect(html).toContain("renderActionReceipt?.(result)");
      expect(html).toContain("window.applyDashboardLanguage?.();");
      expect(html).not.toContain("window.confirm");
      expect(html).not.toContain("Technical details");
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
      expect(html).toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"decision-summary\" aria-controls=\"decision-summary\" data-i18n-en=\"Review approvals\" data-i18n-zh=\"查看确认项\">Review approvals</button>");
      expect(html).toContain("<strong data-i18n-en=\"Approval needed\" data-i18n-zh=\"需要确认\">Approval needed</strong>");
      expect(html).toContain("<small data-i18n-en=\"Review approvals\" data-i18n-zh=\"查看确认项\">Review approvals</small>");
      expect(html).toContain("data-i18n-en=\"Explicit approvals stay in Capture Inbox, Review Queue, and Candidate Triage.\" data-i18n-zh=\"需要明确确认的操作会保留在 Capture Inbox、Review Queue 和 Candidate Triage 中。\"");
      expect(html).not.toContain("data-dashboard-overview-card=\"action\"");
      expect(html).not.toContain("data-dashboard-overview-quiet-card=\"action\"");
      expect(html).not.toContain("data-dashboard-detail=\"dashboard-overview-quiet-cards\"");
      expect(html).not.toContain("<span>Background Status</span>");
      expect(html).not.toContain("data-dashboard-detail=\"dashboard-work-lanes-background\"");
      expect(html).not.toContain("<span>Background Lanes</span>");
      expect(html).toContain("<section class=\"dashboard-work-lanes\" data-dashboard-work-lanes aria-label=\"Dashboard Work Lanes\">");
      expect(html).toContain("<button type=\"button\" class=\"dashboard-work-lane warning\" data-dashboard-work-lane=\"decide\" data-action-board-target=\"decision-summary\" aria-controls=\"decision-summary\">");
      expect(html).toContain("<span data-i18n-en=\"Decide\" data-i18n-zh=\"决定\">Decide</span>");
      expect(html).toContain("<strong data-i18n-en=\"1 approval waiting\" data-i18n-zh=\"1 个确认项待处理\">1 approval waiting</strong>");
      expect(html).toContain("<em data-i18n-en=\"Approval needed\" data-i18n-zh=\"需要确认\">Approval needed</em>");
      expect(html).not.toContain("data-dashboard-detail=\"action-board\"");
      expect(html).not.toContain("data-action-board-nav");
      expect(html).not.toContain("<span>Page Shortcuts</span>");
      expect(html).toContain("<section id=\"decision-summary\" class=\"panel decision-summary\"");
      expect(html).toContain("<details id=\"maintenance-review-queue\"");
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
      expect(html).toContain("<button type=\"button\" class=\"dashboard-overview-action\" data-action-board-target=\"decision-summary\" aria-controls=\"decision-summary\" data-i18n-en=\"Review approvals\" data-i18n-zh=\"查看确认项\">Review approvals</button>");
      expect(html).toContain("<span class=\"health-badge warning\" data-i18n-en=\"Sync Pending\" data-i18n-zh=\"等待同步\">Sync Pending</span>");
      expect(html).not.toContain("<p class=\"dashboard-status-line warning\" data-dashboard-status=\"sync_pending\">");
      expect(html).not.toContain("<section class=\"status-strip warning\" data-dashboard-status=\"sync_pending\">");
      expect(html).toContain("<details id=\"maintenance-review-queue\"");
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
      expect(html).toContain("Context Pack Review");
      expect(html).not.toContain("<span>Routine Diagnostics</span>");
      expect(html).not.toContain("<small>Checks ready</small>");
      expect(html).not.toContain("<strong>Routine Diagnostics Index</strong>");
      expect(html).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"diagnostics\" data-dashboard-detail=\"routine-diagnostics\" data-routine-diagnostics-reference data-reference-library-index=\"diagnostics\">");
      expect(html).toContain("<strong data-i18n-en=\"Diagnostics Index\" data-i18n-zh=\"诊断索引\">Diagnostics Index</strong>");
      expect(html).not.toContain("<strong>Diagnostics Index</strong>");
      expect(html).toContain("data-dashboard-detail=\"context-pack-review\"");
      const diagnosticsIndexHtml = dashboardDetailBlock(html, "routine-diagnostics");
      expect(diagnosticsIndexHtml).not.toContain("data-action-board-target=\"context-pack-review\"");
      expect(html).toContain("<code data-dashboard-detail=\"context-pack-review\" aria-label=\"Context Pack Review: Ready handoff context. Full report is available in /api/dashboard.context_pack_review.\">context_pack_review</code>");
      expect(html).toContain("aria-label=\"Context Pack Review: Ready handoff context. Full report is available in /api/dashboard.context_pack_review.\"");
      expect(html).not.toContain("<details class=\"panel context-pack-review\" data-dashboard-detail=\"context-pack-review\" data-context-pack-state=\"ready\" aria-label=\"Context Pack Review\">");
      expect(html).not.toContain("<details open class=\"panel context-pack-review\"");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary context-pack-review-fold\">");
      expect(html).toContain("<details class=\"dashboard-work-lanes-quiet\" data-dashboard-detail=\"dashboard-work-lanes-background\">");
      expect(html).toContain("<span data-i18n-en=\"Other paths\" data-i18n-zh=\"其他入口\">Other paths</span>");
      expect(html).toContain("<small data-i18n-en=\"Ready if needed\" data-i18n-zh=\"需要时可查看\">Ready if needed</small>");
      expect(html).toContain("<button type=\"button\" class=\"dashboard-work-lane good\" data-dashboard-work-lane-quiet=\"context\" data-action-board-target=\"context-pack-review\" aria-controls=\"context-pack-review\">");
      expect(html).not.toContain("<button type=\"button\" class=\"dashboard-work-lane good\" data-dashboard-work-lane=\"context\" data-action-board-target=\"context-pack-review\" aria-controls=\"context-pack-review\">");
      expect(html).toContain("<strong data-i18n-en=\"Ready handoff context\" data-i18n-zh=\"交接上下文已就绪\">Ready handoff context</strong>");
      expect(html).toContain("<em data-i18n-en=\"Open handoff review\" data-i18n-zh=\"打开交接查看\">Open handoff review</em>");
      expect(html).not.toContain("<small>ready | all checks passed | 1 decision | 1 thread | 1 risk</small>");
      expect(html).not.toContain("<div class=\"context-pack-readiness\" aria-label=\"Context Pack readiness\">");
      expect(html).not.toContain("<span class=\"context-pack-chip good\">Ready</span>");
      expect(html).not.toContain("<span class=\"context-pack-chip good\">6/6 checks</span>");
      expect(html).not.toContain("<span class=\"context-pack-chip info\">3 evidence items</span>");
      expect(html).not.toContain("<span class=\"context-pack-chip good\">Capture action visible</span>");
      expect(html).not.toContain("<div class=\"context-pack-review-body\">");
      expect(html).not.toContain("data-context-pack-brief");
      expect(html).not.toContain("<h4>Handoff readiness</h4>");
      expect(html).not.toContain("Ready to hand off: all checks passed.");
      expect(html).not.toContain("Quality checks passed.");
      expect(html).not.toContain("Quality checks: 6 passed | 0 review.");
      expect(html).not.toContain("Evidence available: 1 decision | 1 thread | 1 risk.");
      expect(html).not.toContain("Capture action: <code>moryn capture session --project-id moryn --agent &lt;agent&gt; --summary &lt;summary&gt;</code>.");
      expect(html).not.toContain("<details class=\"context-pack-checks-fold\" data-dashboard-detail=\"context-pack-checks\">");
      expect(html).not.toContain("<span>Quality Checks</span>");
      expect(html).not.toContain("<small>All quality checks passed</small>");
      expect(html).not.toContain("<small>6 passed | 0 review</small>");
      expect(html).not.toContain("<ul class=\"context-pack-checks\">");
      expect(html).not.toContain("data-dashboard-detail=\"context-pack-evidence\"");
      expect(html).not.toContain("<span>Context Evidence</span>");
      expect(html).not.toContain("<small>Handoff evidence available</small>");
      expect(html).not.toContain("<small>1 decision | 1 thread | 1 risk</small>");
      expect(html).not.toContain("Dashboard should review context pack readiness.");
      expect(html).not.toContain("Codex finished handoff review implementation.");
      expect(html).not.toContain("Do not make dashboard context review mutate memory.");
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
      expect(html).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"diagnostics\" data-dashboard-detail=\"routine-diagnostics\" data-routine-diagnostics-reference data-reference-library-index=\"diagnostics\">");
      expect(html).toContain("data-dashboard-detail=\"context-pack-review\"");
      expect(html).toContain("aria-label=\"Context Pack Review: Ready handoff context | no handoff evidence. Full report is available in /api/dashboard.context_pack_review.\"");
      expect(html).not.toContain("<small>Ready handoff context | no handoff evidence</small>");
      expect(html).not.toContain("<small>ready | all checks passed | no handoff evidence</small>");
      expect(html).not.toContain("data-context-pack-brief");
      expect(html).not.toContain("Evidence available: No handoff evidence.");
      expect(html).not.toContain("<small>ready | all checks passed | 0 decisions | 0 threads | 0 risks</small>");
      expect(html).not.toContain("data-dashboard-detail=\"context-pack-evidence\"");
      expect(html).not.toContain("<span>Context Evidence</span>");
      expect(html).not.toContain("<small>No handoff evidence</small>");
      expect(html).not.toContain("<small>0 decisions | 0 threads | 0 risks</small>");
      expect(html).not.toContain("<h3>Recent Decisions</h3>");
      expect(html).not.toContain("<h3>Open Threads</h3>");
      expect(html).not.toContain("<h3>Risks</h3>");
      expect(html).not.toContain("<div class=\"empty-state\">None in this snapshot.</div>");
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
      expect(html).toContain("Context Pack Review");
      expect(html).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"diagnostics\" data-dashboard-detail=\"routine-diagnostics\" data-routine-diagnostics-reference data-reference-library-index=\"diagnostics\">");
      expect(html).toContain("data-dashboard-detail=\"context-pack-review\"");
      expect(html).toContain("aria-label=\"Context Pack Review: unavailable. Full report is available in /api/dashboard.context_pack_review.\"");
      expect(html).not.toContain("<div class=\"empty-state\">Open the dashboard with --project-id or --project to review a project context pack.</div>");
      expect(html).not.toContain("<details class=\"panel context-pack-review\" data-dashboard-detail=\"context-pack-review\" data-context-pack-state=\"unavailable\" aria-label=\"Context Pack Review\">");
      const contextPackSection = html.match(/data-dashboard-detail="context-pack-review"[\s\S]*?<\/button>/)?.[0] ?? "";
      expect(contextPackSection).not.toContain(projectText);
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
      expect(html).toContain("Capture Inbox");
      expect(html).toContain("<section class=\"decision-panel\" data-dashboard-decision-panel aria-label=\"Needs your confirmation\">");
      expect(html).toContain("<h2 data-i18n-en=\"Needs your confirmation\" data-i18n-zh=\"需要你确认\">Needs your confirmation</h2>");
      expect(html).not.toContain("Needs your decision");
      expect(html).toContain("<h2 data-i18n-en=\"Capture Inbox\" data-i18n-zh=\"捕获收件箱\">Capture Inbox</h2>");
      expect(html).toContain("<span data-i18n-en=\"Manual approval\" data-i18n-zh=\"手动确认\">Manual approval</span>");
      expect(html).not.toContain("<span>1 candidate | 1 group</span>");
      expect(data.action_board.items_by_id.confirm).toMatchObject({
        value: 1,
        target: "decision-summary",
        next_action_label: "Approval needed"
      });
      expect(html).toContain("<section id=\"decision-summary\" class=\"panel decision-summary\" data-dashboard-detail=\"decision-summary\" aria-label=\"Decision Summary\">");
      expect(html).toContain("<h2>Pending Decisions</h2>");
      expect(html).toContain("Review 1 explicit approval before any memory write.");
      expect(html).toContain("<span>1 Capture Inbox</span>");
      const decisionSummaryStart = html.indexOf("data-dashboard-detail=\"decision-summary\"");
      const decisionSummaryEnd = html.indexOf("id=\"capture-inbox\"", decisionSummaryStart);
      const decisionSummaryHtml = html.slice(decisionSummaryStart, decisionSummaryEnd);
      expect(decisionSummaryHtml).toContain("<strong>Capture Inbox</strong>");
      expect(decisionSummaryHtml).toContain("1 explicit approval waiting in Capture Inbox.");
      expect(decisionSummaryHtml).toContain("data-decision-summary-route=\"capture-inbox\"");
      expect(decisionSummaryHtml).toContain("<small>Append-only, guarded in owning surface</small>");
      expect(decisionSummaryHtml).not.toContain("<span>Group approve/reject</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Append-only events</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Active candidate guard</span>");
      expect(decisionSummaryHtml).not.toContain("<span>approval required</span>");
      expect(decisionSummaryHtml).not.toContain("<span>Audit evidence</span>");
      expect(decisionSummaryHtml).not.toContain("Review Codex capture group");
      expect(decisionSummaryHtml).not.toContain("Approve Group or Reject Group");
      expect(html).not.toContain("<span>capture_inbox.groups[]</span>");
      expect(html).not.toContain("Approve Group promotes candidates; Reject Group archives them. Both append audit events.");
      expect(html).not.toContain("<dt>Write boundary</dt><dd>Append-only events<small>Approve Group promotes candidates; Reject Group archives them. Both append audit events.</small></dd>");
      expect(html).not.toContain("<dt>Path</dt><dd><code>capture_inbox.groups[]</code></dd>");
      expect(html).not.toContain("<dt>Evidence</dt><dd><code>capture_inbox.groups[]</code></dd>");
      expect(html).not.toContain("<dt>Writes</dt><dd>append_only_events");
      expect(html).not.toContain("data-decision-summary-item=\"capture_inbox:");
      expect(html).toContain("data-action-board-target=\"capture-inbox\"");
      expect(html).not.toContain("data-dashboard-action-id=\"decision_summary");
      expect(html).not.toContain("data-dashboard-detail=\"dashboard-overview-quiet-cards\"");
      expect(html).not.toContain("<span>Background Status</span>");
      expect(html).not.toContain("data-dashboard-detail=\"dashboard-work-lanes-background\"");
      expect(html).not.toContain("<span>Background Lanes</span>");
      expect(html).not.toContain("data-dashboard-detail=\"action-board\"");
      expect(html).not.toContain("data-action-board-nav");
      expect(html).not.toContain("<span>Page Shortcuts</span>");
      expect(data.attention_items.every((item) => item.severity === "info")).toBe(true);
      expect(html).not.toContain("<section id=\"needs-attention\" class=\"needs-attention-quiet-line\"");
      expect(html).not.toContain("data-dashboard-detail=\"attention-info-checks\"");
      expect(html).not.toContain("<span>Background checks</span>");
      expect(html.indexOf("data-dashboard-detail=\"decision-summary\"")).toBeLessThan(html.indexOf("id=\"capture-inbox\""));
      expect(html.indexOf("id=\"capture-inbox\"")).toBeLessThan(html.indexOf("data-dashboard-detail=\"evidence-library\""));
      expect(html).toContain("<small>Audit evidence only</small>");
      expect(html).not.toContain("<small>Reference material</small>");
      expect(html).not.toContain("data-evidence-library-brief");
      expect(html).not.toContain("<h3>Evidence index</h3>");
      expect(html).toContain("1 candidate");
      expect(html).toContain("Codex finished Capture Inbox planning.");
      expect(html).toContain("data-capture-inbox-brief");
      expect(html).toContain("<h4 data-i18n-en=\"Approval brief\" data-i18n-zh=\"确认摘要\">Approval brief</h4>");
      expect(html).toContain("<dt data-i18n-en=\"Change\" data-i18n-zh=\"变化\">Change</dt><dd data-i18n-en=\"Review 1 candidate\" data-i18n-zh=\"查看 1 条候选内容\">Review 1 candidate</dd>");
      expect(html).toContain("<dt data-i18n-en=\"Scope\" data-i18n-zh=\"范围\">Scope</dt><dd data-i18n-en=\"Captured through Moryn host adapter autocapture.\" data-i18n-zh=\"由 Moryn 主机适配器自动捕获。\">Captured through Moryn host adapter autocapture.</dd>");
      expect(html).toContain("<dt data-i18n-en=\"Guard\" data-i18n-zh=\"保护\">Guard</dt><dd data-i18n-en=\"Server rechecks active candidate before writing\" data-i18n-zh=\"写入前服务器会重新检查当前候选内容\">Server rechecks active candidate before writing</dd>");
      expect(html).toContain("<dt data-i18n-en=\"Writes\" data-i18n-zh=\"写入\">Writes</dt><dd data-i18n-en=\"Approve appends memory; Reject appends archive\" data-i18n-zh=\"批准会追加记忆；拒绝会追加归档\">Approve appends memory; Reject appends archive</dd>");
      expect(html).not.toContain("<h4>Confirm preview</h4>");
      expect(html).not.toContain("<span>Captured through Moryn host adapter autocapture.</span>");
      expect(html).not.toContain("<span>Approve appends memory</span>");
      expect(html).not.toContain("<span>Reject appends archive</span>");
      expect(html).toContain("data-capture-inbox-group-brief");
      expect(html).toContain("<dt data-i18n-en=\"Scope\" data-i18n-zh=\"范围\">Scope</dt><dd data-i18n-en=\"Normal review\" data-i18n-zh=\"正常查看\">Normal review</dd>");
      expect(html).toContain("<dt data-i18n-en=\"Guard\" data-i18n-zh=\"保护\">Guard</dt><dd data-i18n-en=\"Server rechecks selected group records before writing\" data-i18n-zh=\"写入前服务器会重新检查所选分组记录\">Server rechecks selected group records before writing</dd>");
      expect(html).toContain("<dt data-i18n-en=\"Writes\" data-i18n-zh=\"写入\">Writes</dt><dd data-i18n-en=\"Approve Group appends memory; Reject Group appends archive\" data-i18n-zh=\"批准分组会追加记忆；拒绝分组会追加归档\">Approve Group appends memory; Reject Group appends archive</dd>");
      expect(html).not.toContain("<span>Approve Group appends memory</span>");
      expect(html).not.toContain("<span>Reject Group appends archive</span>");
      expect(html).not.toContain("<h4>Review summary</h4>");
      expect(html).not.toContain("<h4>Decision brief</h4>");
      expect(html).not.toContain("Needs review because: Captured through Moryn host adapter autocapture.");
      expect(html).not.toContain("Approve Memory promotes this candidate to canonical memory with an append-only user event.");
      expect(html).not.toContain("Reject archives it without deleting the local audit trail.");
      expect(html).toContain("User approved Capture Inbox group.");
      expect(html).toContain("User rejected Capture Inbox group.");
      expect(html).toContain("Write boundary");
      expect(html).toContain("Changed");
      expect(html).toContain("Trace");
      expect(html).toContain("Audit status");
      expect(html).toContain("Append-only events");
      expect(html).toContain("Timeline ready");
      expect(html).toContain("record updated");
      expect(html).not.toContain("Traceable by timeline");
      expect(html).not.toContain("write target");
      expect(html).toContain(">Reject</button>");
      expect(html).toContain("data-i18n-en=\"Reject\" data-i18n-zh=\"拒绝\"");
      expect(html).toContain("data-i18n-en=\"Approve Memory\" data-i18n-zh=\"批准为记忆\"");
      expect(html).toContain(`data-endpoint=\"api/capture-inbox/${capture.record.id}/approve\"`);
      expect(html).toContain(`data-endpoint=\"api/capture-inbox/${capture.record.id}/reject\"`);
      expect(html).toContain(`data-dashboard-action-id=\"capture_inbox.record.approve.${capture.record.id}\"`);
      expect(html).toContain(`data-dashboard-action-id=\"capture_inbox.record.reject.${capture.record.id}\"`);
      expect(html).not.toContain("window.confirm");
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
      expect(html).toContain("Review Policy");
      expect(html).toContain("Capture Policy");
      const inboxListIndex = html.indexOf("<div class=\"capture-inbox-list\">");
      const auditIndex = html.indexOf("<details class=\"capture-inbox-audit\" data-dashboard-detail=\"capture-inbox-audit\">");
      expect(inboxListIndex).toBeGreaterThan(-1);
      expect(auditIndex).toBeGreaterThan(inboxListIndex);
      expect(html).toContain("data-capture-inbox-queue-summary");
      expect(html).toContain("<h3 data-i18n-en=\"Queue summary\" data-i18n-zh=\"队列摘要\">Queue summary</h3>");
      expect(html).toContain("<p data-i18n-en=\"4 candidates grouped into 2 review groups.\" data-i18n-zh=\"4 条候选内容分成 2 个查看分组。\">4 candidates grouped into 2 review groups.</p>");
      expect(html).toContain("<h2 data-i18n-en=\"Capture Inbox\" data-i18n-zh=\"捕获收件箱\">Capture Inbox</h2>");
      expect(html).toContain("<span data-i18n-en=\"Manual approval\" data-i18n-zh=\"手动确认\">Manual approval</span>");
      expect(html).not.toContain("<span>4 candidates | 2 groups</span>");
      expect(html).toContain("Review groups first; open item details only when needed. Canonical memory still requires approval.");
      expect(html).not.toContain("Default path: review by group first, then open item details only when needed.");
      expect(html).not.toContain("Manual review: candidates become canonical only after Approve Memory or Approve Group.");
      expect(html).toContain("<span data-i18n-en=\"2 normal review\" data-i18n-zh=\"2 条正常查看\">2 normal review</span>");
      expect(html).toContain("<span data-i18n-en=\"2 likely noise\" data-i18n-zh=\"2 条可能是噪音\">2 likely noise</span>");
      expect(html.indexOf("data-capture-inbox-queue-summary")).toBeLessThan(inboxListIndex);
      expect(html).not.toContain("data-dashboard-action-id=\"capture_inbox.queue");
      expect(html).not.toContain("<details class=\"capture-policy-summary\" data-dashboard-detail=\"capture-policy-summary\">");
      expect(html).toContain("<span>Capture Audit</span>");
      expect(html).toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Capture Audit: manual review | no auto-canonical | 4 candidates | auto-captured 0 | policy archived 0\">");
      expect(html).toContain("<small>Manual review, no auto-canonical</small>");
      expect(html).not.toContain("<small>manual review | no auto-canonical | 4 candidates | auto-captured 0 | policy archived 0</small>");
      expect(html).not.toContain("<small>manual review | no auto-canonical | 4 candidates</small>");
      expect(html).toContain("default_capture_review_policy");
      expect(html).toContain("Manual review");
      expect(html).toContain("No auto-canonical");
      expect(html).toContain("Trust disabled");
      expect(html).toContain("User action required");
      expect(html).toContain("stale batch protection");
      expect(html).toContain("smoke_test_marker");
      expect(html).toContain("duplicate_text");
      expect(html).toContain("2 groups");
      expect(html).toContain("data-i18n-en=\"Approve Group\" data-i18n-zh=\"批准分组\"");
      expect(html).toContain("data-i18n-en=\"Reject Group\" data-i18n-zh=\"拒绝分组\"");
      expect(html).toContain("data-i18n-en=\"Likely noise\" data-i18n-zh=\"可能是噪音\"");
      expect(html).toContain("<h3 data-i18n-en=\"Review 2 captures\" data-i18n-zh=\"查看 2 条捕获内容\">Review 2 captures</h3>");
      expect(html).toContain("<p data-i18n-en=\"Approve or reject this group.\" data-i18n-zh=\"批准或拒绝这个分组。\">Approve or reject this group.</p>");
      expect(html).toContain("<details class=\"capture-inbox-context\" data-dashboard-detail=\"capture-inbox-context:");
      expect(html).toContain("<summary data-i18n-en=\"Review context\" data-i18n-zh=\"查看上下文\">Review context</summary>");
      const codexGroupStart = html.indexOf(`data-capture-inbox-group="${codexGroup?.id}"`);
      const codexContextStart = html.indexOf("<details class=\"capture-inbox-context\"", codexGroupStart);
      const codexItemReviewStart = html.indexOf("<summary data-i18n-en=\"Item review\" data-i18n-zh=\"逐条查看\">Item review</summary>", codexGroupStart);
      const codexGroupFaceHtml = html.slice(codexGroupStart, codexContextStart);
      const codexItemReviewHtml = html.slice(codexItemReviewStart, html.indexOf("</article>", codexItemReviewStart));
      expect(codexGroupFaceHtml).toContain("<h3 data-i18n-en=\"Review 2 captures\" data-i18n-zh=\"查看 2 条捕获内容\">Review 2 captures</h3>");
      expect(codexGroupFaceHtml).toContain("<p data-i18n-en=\"Approve or reject this group.\" data-i18n-zh=\"批准或拒绝这个分组。\">Approve or reject this group.</p>");
      expect(codexGroupFaceHtml).toContain("<h4 data-i18n-en=\"Approval brief\" data-i18n-zh=\"确认摘要\">Approval brief</h4>");
      expect(codexGroupFaceHtml).toContain("<dt data-i18n-en=\"Change\" data-i18n-zh=\"变化\">Change</dt><dd data-i18n-en=\"Review 2 candidates\" data-i18n-zh=\"查看 2 条候选内容\">Review 2 candidates</dd>");
      expect(codexGroupFaceHtml).toContain("<dt data-i18n-en=\"Scope\" data-i18n-zh=\"范围\">Scope</dt><dd data-i18n-en=\"Normal review\" data-i18n-zh=\"正常查看\">Normal review</dd>");
      expect(codexGroupFaceHtml).toContain("<dt data-i18n-en=\"Guard\" data-i18n-zh=\"保护\">Guard</dt><dd data-i18n-en=\"Server rechecks selected group records before writing\" data-i18n-zh=\"写入前服务器会重新检查所选分组记录\">Server rechecks selected group records before writing</dd>");
      expect(codexGroupFaceHtml).toContain("<dt data-i18n-en=\"Writes\" data-i18n-zh=\"写入\">Writes</dt><dd data-i18n-en=\"Approve Group appends memory; Reject Group appends archive\" data-i18n-zh=\"批准分组会追加记忆；拒绝分组会追加归档\">Approve Group appends memory; Reject Group appends archive</dd>");
      expect(codexGroupFaceHtml).not.toContain("<h4>Confirm preview</h4>");
      expect(codexGroupFaceHtml).not.toContain("<span>Approve Group appends memory</span>");
      expect(codexGroupFaceHtml).not.toContain("<span>Reject Group appends archive</span>");
      expect(codexGroupFaceHtml).not.toContain("Codex prepared bulk review controls.");
      expect(codexGroupFaceHtml).not.toContain("Codex finished dashboard grouping.");
      expect(codexGroupFaceHtml).not.toContain("Review signal");
      expect(codexGroupFaceHtml).not.toContain("Duplicate capture text");
      expect(codexItemReviewHtml).toContain("Codex prepared bulk review controls.");
      expect(codexItemReviewHtml).toContain("Codex finished dashboard grouping.");
      const noisyGroupStart = html.indexOf(`data-capture-inbox-group="${noisyGroup?.id}"`);
      const noisyContextStart = html.indexOf("<details class=\"capture-inbox-context\"", noisyGroupStart);
      const noisyGroupFaceHtml = html.slice(noisyGroupStart, noisyContextStart);
      expect(noisyGroupFaceHtml).toContain("<p data-i18n-en=\"Archive likely noise or inspect items.\" data-i18n-zh=\"把可能的噪音归档，或先查看内容。\">Archive likely noise or inspect items.</p>");
      expect(noisyGroupFaceHtml).toContain("<div class=\"capture-inbox-review-signal\" data-capture-inbox-review-signal>");
      expect(noisyGroupFaceHtml).toContain("<strong data-i18n-en=\"Review signal\" data-i18n-zh=\"查看信号\">Review signal</strong>");
      expect(noisyGroupFaceHtml).toContain("<span>Smoke/test marker</span>");
      expect(noisyGroupFaceHtml).toContain("<span>Duplicate capture text</span>");
      expect(noisyGroupFaceHtml).toContain("<small>Looks like smoke, test, or fixture output. Duplicate capture text appears in this batch.</small>");
      expect(noisyGroupFaceHtml).not.toContain("data-dashboard-action-id=\"capture_inbox.signal");
      expect(html.indexOf("<summary data-i18n-en=\"Review context\" data-i18n-zh=\"查看上下文\">Review context</summary>")).toBeLessThan(
        html.indexOf("<dl class=\"capture-inbox-summary\" data-capture-inbox-group-summary>")
      );
      expect(html).toContain("<summary data-i18n-en=\"Item review\" data-i18n-zh=\"逐条查看\">Item review</summary>");
      expect(html).not.toContain("<summary>Group details</summary>");
      expect(html).toContain("<details class=\"capture-inbox-evidence-index\" data-dashboard-detail=\"capture-inbox-evidence-index:");
      expect(html).toContain("<summary data-i18n-en=\"Trace details\" data-i18n-zh=\"追踪详情\">Trace details</summary>");
      expect(html).not.toContain("<summary>Evidence index</summary>");
      const itemReviewStart = html.indexOf("<summary data-i18n-en=\"Item review\" data-i18n-zh=\"逐条查看\">Item review</summary>");
      const traceDetailsStart = html.indexOf("<summary data-i18n-en=\"Trace details\" data-i18n-zh=\"追踪详情\">Trace details</summary>", itemReviewStart);
      const itemsStart = html.indexOf("<div class=\"capture-inbox-items\">", itemReviewStart);
      expect(itemReviewStart).toBeGreaterThan(-1);
      expect(traceDetailsStart).toBeGreaterThan(itemReviewStart);
      expect(itemsStart).toBeGreaterThan(traceDetailsStart);
      expect(html).toContain("Smoke test marker only.");
      expect(html).toContain(`<details class="capture-inbox-item" data-capture-inbox-record="${secondCodex.record.id}">`);
      expect(html).toContain("<summary class=\"capture-inbox-item-summary\">");
      expect(html).not.toContain("<article class=\"capture-inbox-item\"");
      expect(html).not.toContain("Trust policy enabled");
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
      expect(html).toContain("default_autocapture_policy");
      expect(html).toContain("Policy archived");
      expect(html).toContain("<article class=\"supporting-evidence-summary-row\" data-supporting-evidence-summary=\"audit-reports\" data-dashboard-detail=\"supporting-operational-evidence\">");
      expect(html).toContain("<code data-dashboard-detail=\"capture-policy-audit\">capture_policy</code>");
      expect(html).not.toContain("<details class=\"panel capture-policy-audit\" data-dashboard-detail=\"capture-policy-audit\"");
      expect(html).not.toContain("Capture Policy Audit");
      expect(html).not.toContain("<small>1 review | 1 archived</small>");
      expect(html).not.toContain("<small>0 captured | 1 review | 1 archived</small>");
      expect(html).not.toContain("auto-captureds");
      expect(html).toContain("capture_policy");
      expect(html).toContain("inspect_policy_archived_record");
      expect(html).not.toContain("data-capture-policy-decision=\"rec_capture_policy_1\"");
      expect(html).toContain("data-capture-inbox-record=\"rec_capture_policy_1\"");
      expect(html).toContain("api/capture-inbox/rec_capture_policy_1/approve");
      expect(html).toContain("api/capture-inbox/rec_capture_policy_1/reject");
      expect(html).toContain("Review in Capture Inbox");
      expect(html).toContain("User action required");
      expect(html).not.toContain("data-capture-policy-decision=\"rec_capture_policy_2\"");
      expect(html).not.toContain("moryn timeline --record-id rec_capture_policy_2 --project-id moryn --before 3 --after 3");
      expect(html).not.toContain("api/capture-inbox/rec_capture_policy_2/approve");
      expect(html).not.toContain("api/capture-inbox/rec_capture_policy_2/reject");
      expect(html).toContain("smoke_test_marker");
      expect(html).toContain("Smoke test marker only.");
      expect(html).toContain("Useful handoff still needs user review.");
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
      expect(html).not.toContain("<section id=\"capture-inbox\" class=\"panel capture-inbox\" aria-label=\"Capture Inbox\">");
      expect(html).not.toContain("<h2>Capture Inbox</h2>");
      expect(html).not.toContain("<details class=\"capture-inbox-audit\" data-dashboard-detail=\"capture-inbox-audit\">");
      expect(html).toContain("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"audit-reports\" data-supporting-evidence-summary=\"audit-reports\" data-dashboard-detail=\"supporting-operational-evidence\">");
      expect(html).toContain("<code data-dashboard-detail=\"capture-policy-audit\">capture_policy</code>");
      expect(html).not.toContain("<details class=\"panel capture-policy-audit\" data-dashboard-detail=\"capture-policy-audit\"");
      expect(html).not.toContain("<article class=\"capture-policy-reference\" data-dashboard-detail=\"capture-policy:index\" data-capture-policy-reference>");
      expect(html).not.toContain("<div class=\"capture-policy-routing-brief\" aria-label=\"Capture policy routing brief\">");
      expect(html).not.toContain("<strong>No capture inbox work</strong>");
      expect(html).not.toContain("1 auto-captured handoff");
      expect(html).not.toContain("<div class=\"lifecycle-findings\">");
      expect(html).not.toContain("Autocapture policy retained low-risk handoffs without review.");
      expect(html).not.toContain("<span>Capture Policy Audit</span>");
      expect(html).not.toContain("Moryn Health Check needs attention | 1 warning");
      expect(html).not.toContain("<small>1 captured</small>");
      expect(html).not.toContain("<small>1 captured | 0 review | 0 archived</small>");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Capture Audit: manual review | no auto-canonical | 0 candidates | auto-captured 1 | policy archived 0\">");
      expect(html).not.toContain("<small>manual review | no auto-canonical | 0 candidates | auto-captured 1 | policy archived 0</small>");
      expect(html).not.toContain("<small>manual review | no auto-canonical | 0 candidates</small>");
      expect(html).not.toContain("auto-captureds");
      expect(html).not.toContain("low_risk_handoff_auto_capture");
      expect(html).not.toContain("Codex finished setup wizard polish.");
      expect(html).not.toContain("inspect_auto_captured_handoff");
      expect(html).not.toContain("moryn timeline --record-id rec_auto_capture_1 --project-id moryn --before 3 --after 3");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Routing details: Read-only evidence\">");
      expect(html).not.toContain("<span>Routing details</span>");
      expect(html).not.toContain("<small>Read-only evidence</small>");
      expect(JSON.stringify(data.capture_policy)).toContain("low_risk_handoff_auto_capture");
      expect(JSON.stringify(data.capture_policy)).toContain("Codex finished setup wizard polish.");
      expect(JSON.stringify(data.capture_policy)).toContain("inspect_auto_captured_handoff");
      expect(JSON.stringify(data.capture_policy)).toContain("moryn timeline --record-id rec_auto_capture_1 --project-id moryn --before 3 --after 3");
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
      expect(html).not.toContain("<section id=\"capture-inbox\" class=\"panel capture-inbox\" aria-label=\"Capture Inbox\">");
      expect(html).not.toContain("api/capture-inbox/rec_stale_review_handoff/approve");
      expect(html).not.toContain("api/capture-inbox/rec_stale_review_handoff/reject");
      expect(html).not.toContain("data-governance-item=\"capture_policy:review_required\"");
      expect(html).toContain("<code data-dashboard-detail=\"capture-policy-audit\">capture_policy</code>");
      expect(html).not.toContain("<strong>Capture Policy Index</strong>");
      expect(html).not.toContain("data-capture-policy-decision=\"rec_stale_review_handoff\"");
      expect(html).not.toContain("low_risk_handoff_auto_capture");
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

      const data = await buildDashboardData(storePath, { limit: 10, project_id: "moryn" });
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
      expect(html).not.toContain("<details class=\"panel clean-audit-reports\" data-dashboard-detail=\"clean-audit-reports\" aria-label=\"Clean Audit Reports\">");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary clean-audit-reports-fold\">");
      expect(html).not.toContain("<span>Clean Audit Reports</span>");
      expect(html).not.toContain("<small>Clean lifecycle and capture audits</small>");
      expect(html).not.toContain("<small>Memory Lifecycle clean | Capture Policy clean</small>");
      expect(html).not.toContain("<div class=\"clean-audit-list\">");
      const referenceLibraryIndex = html.indexOf("<article class=\"reference-library-index\" data-dashboard-detail=\"reference-library:index\" data-reference-library-index>");
      const auditReportsIndex = html.indexOf("<div class=\"reference-library-index-row\" data-reference-library-index-row=\"audit-reports\" data-supporting-evidence-summary=\"audit-reports\" data-dashboard-detail=\"supporting-operational-evidence\">");
      expect(auditReportsIndex).toBeGreaterThan(referenceLibraryIndex);
      expect(data.capture_policy.decisions_by_record_id.rec_policy_handled).toMatchObject({
        decision: "review",
        state: "canonical",
        review_required: false
      });
      expect(html).not.toContain("data-capture-policy-decision=\"rec_policy_handled\"");
      expect(html).not.toContain("Review already handled");
      const auditReportsEnd = html.indexOf("<div class=\"reference-library-index-row\"", auditReportsIndex + 1);
      const auditReportsHtml = html.slice(auditReportsIndex, auditReportsEnd);
      expect(auditReportsHtml).toContain("<strong data-i18n-en=\"Audit Reports\" data-i18n-zh=\"审计报告\">Audit Reports</strong>");
      expect(auditReportsHtml).toContain("<span data-i18n-en=\"Lifecycle checks indexed\" data-i18n-zh=\"生命周期检查已建立索引\">Lifecycle checks indexed</span>");
      expect(auditReportsHtml).not.toContain("<span>Lifecycle and capture policy evidence</span>");
      expect(auditReportsHtml).toContain("<code data-dashboard-detail=\"memory-lifecycle-audit\">memory_lifecycle</code>");
      expect(auditReportsHtml).toContain("<code data-dashboard-detail=\"capture-policy-audit\">capture_policy</code>");
      expect(html).not.toContain("<details class=\"clean-audit-report memory-lifecycle\" data-dashboard-detail=\"memory-lifecycle-audit\"");
      expect(html).not.toContain("<article class=\"memory-lifecycle-reference\" data-dashboard-detail=\"memory-lifecycle:index\" data-memory-lifecycle-reference>");
      expect(html).not.toContain("<summary>Lifecycle suggestions</summary>");
      expect(html).not.toContain("<summary>Suggested actions</summary>");
      expect(html).not.toContain("No lifecycle actions suggested.");
      expect(html).not.toContain("<strong>Lifecycle Policy</strong>");
      expect(html).not.toContain("default_memory_lifecycle_policy");
      expect(html).not.toContain("30d stale");
      expect(html).not.toContain("90d archive review");
      expect(html).not.toContain("low confidence");
      expect(html).not.toContain("<small>0 findings | 0 actions</small>");
      expect(html).not.toContain("<details class=\"clean-audit-report capture-policy-audit\" data-dashboard-detail=\"capture-policy-audit\"");
      expect(html).not.toContain("<article class=\"capture-policy-reference\" data-dashboard-detail=\"capture-policy:index\" data-capture-policy-reference>");
      expect(html).not.toContain("<details class=\"lifecycle-action-details\" data-dashboard-detail=\"capture-policy:default_autocapture_policy\">");
      expect(html).not.toContain("<span>Routing details</span>");
      expect(html).not.toContain("<summary class=\"dashboard-fold-summary\" aria-label=\"Routing details: Read-only evidence\">");
      expect(html).not.toContain("<small>Read-only evidence</small>");
      expect(html).not.toContain("data-capture-policy-decision=\"rec_policy_handled\"");
      expect(html).not.toContain("Review already handled");
      expect(html).not.toContain("<small>Read-only routing evidence</small>");
      expect(html).not.toContain("<summary>Policy decisions and read-only actions</summary>");
      expect(html).not.toContain("<small>0 captured | 0 review | 0 archived</small>");
      expect(html).not.toContain("<div class=\"clean-audit-list\">\n          \n    <details class=\"panel memory-lifecycle\"");
      expect(html).not.toContain("data-governance-item=\"capture_policy:review_required\"");
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
      expect(snapshotHtml).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
      expect(snapshotHtml).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
      expect(snapshotHtml).not.toContain("Snapshot contains this memory");
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
        expect(page).toContain("data-dashboard-detail=\"inspector:records\"");
        expect(page).not.toContain("data-dashboard-detail=\"value:rec_live_1\"");
        expect(page).toContain("captureDetailState");
        expect(page).toContain("restoreDetailState");
        expect(page).toContain("detailState");
        expect(page).toContain("main.addEventListener(\"toggle\"");
        expect(page).not.toContain("<article class=\"recent-value-reference\" data-dashboard-detail=\"recent-value:index\">");
        expect(page).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
        expect(page).toContain("<section id=\"stored-content\" class=\"stored-content memory-explorer\" data-stored-content data-memory-explorer aria-label=\"Find what Moryn saved\">");
        expect(page).toContain("<div id=\"memory-search-panel\" class=\"memory-search-panel primary-memory-search\" data-memory-search-panel data-memory-search-now=");
        expect(page).toContain("<aside class=\"memory-explorer-detail\" data-memory-explorer-detail aria-live=\"polite\">");
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
        expect(refreshedFragment).toContain("<section id=\"stored-content\" class=\"stored-content memory-explorer\" data-stored-content data-memory-explorer aria-label=\"Find what Moryn saved\">");
        expect(refreshedFragment).toContain("<div id=\"memory-search-panel\" class=\"memory-search-panel primary-memory-search\" data-memory-search-panel data-memory-search-now=");
        expect(refreshedFragment).toContain("<aside class=\"memory-explorer-detail\" data-memory-explorer-detail aria-live=\"polite\">");
        expect(refreshedFragment).toContain("Live dashboard refresh memory");
        const refreshedAuditTrailHtml = supportingEvidenceSummaryRowHtml(refreshedFragment, "store-snapshot");
        expect(refreshedAuditTrailHtml).toContain("<code data-dashboard-detail=\"recent-value\">recent_value</code>");
        expect(refreshedAuditTrailHtml).not.toContain("<span>2 recent records available</span>");
        expect(refreshedAuditTrailHtml).not.toContain("Live dashboard refresh memory");

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
        const approveBody = await approveResponse.json() as { ok: boolean; status: string; record_id: string; event_id: string };

        expect(approveResponse.status).toBe(200);
        expect(approveBody).toMatchObject({
          ok: true,
          status: "approved",
          record_id: approved.record.id
        });
        expect(approveBody.event_id).toMatch(/^evt_/);
        expect((await engine.recall({ record_ids: [approved.record.id], states: ["canonical"], project_id: "moryn" })).results[0]?.record.state).toBe("canonical");

        const rejectResponse = await fetch(new URL(`/api/capture-inbox/${rejected.record.id}/reject`, server.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason: "User rejected Capture Inbox candidate." })
        });
        const rejectBody = await rejectResponse.json() as { ok: boolean; status: string; record_id: string; event_id: string };

        expect(rejectResponse.status).toBe(200);
        expect(rejectBody).toMatchObject({
          ok: true,
          status: "rejected",
          record_id: rejected.record.id
        });
        expect(rejectBody.event_id).toMatch(/^evt_/);
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
        const approved = await approveResponse.json() as { ok: boolean; status: string; group_id: string; records_changed: number; record_ids: string[] };

        expect(approveResponse.status).toBe(200);
        expect(approved).toMatchObject({
          ok: true,
          status: "approved",
          records_changed: 2,
          record_ids: [approveTwo.record.id, approveOne.record.id]
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
        const rejected = await rejectResponse.json() as { ok: boolean; status: string; records_changed: number; record_ids: string[] };

        expect(rejectResponse.status).toBe(200);
        expect(rejected).toMatchObject({
          ok: true,
          status: "rejected",
          records_changed: 2,
          record_ids: [rejectTwo.record.id, rejectOne.record.id]
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
        const approved = await response.json() as { ok: boolean; status: string; record_id: string; event_id: string };

        expect(response.status).toBe(200);
        expect(approved).toMatchObject({
          ok: true,
          status: "approved",
          record_id: candidate.record.id
        });
        expect(approved.event_id).toMatch(/^evt_/);
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
