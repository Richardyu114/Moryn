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
  renderDashboardHtml,
  startDashboardServer,
  writeDashboardSnapshot
} from "../../src/observability/dashboard.js";
import { initializeGitSync } from "../../src/sync/git.js";
import { withTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);

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
      expect(html).toContain("<span class=\"health-badge warning\">Sync Pending</span>");
      expect(html).toContain("<section class=\"status-strip warning\" data-dashboard-status=\"sync_pending\">");
      expect(html).toContain("<strong>Dashboard Status</strong>");
      expect(html).toContain("<span>Sync Pending</span>");
      expect(html).toContain("Local sync changes are waiting to be pushed or pulled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("collapses Governance Hub when it only contains safe inspections", async () => {
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
      expect(html).toContain("<details id=\"governance-hub\" class=\"panel governance-hub\" data-dashboard-detail=\"governance-hub\" aria-label=\"Governance Hub\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary governance-hub-fold\">");
      expect(html).toContain("<span>Governance Hub</span>");
      expect(html).toContain("<small>0 need confirmation | 1 safe check | 0 private hidden</small>");
      expect(html).toContain("<div class=\"governance-hub-body\">");
      expect(html).toContain("<details class=\"governance-safe-group\" data-dashboard-detail=\"governance-safe-inspections\">");
      expect(html).toContain("data-governance-item=\"dogfood_report:failure_signals\"");
      expect(html).not.toContain("<section class=\"panel governance-hub\"");
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
          findings_by_id: Record<string, { summary: string; record_ids?: string[] }>;
        };
      };

      const maintenancePlan = data.maintenance.plans[0];
      const maintenanceActionId = `maintenance.plan.approve.${maintenancePlan?.plan_hash.replace(/^sha256:/, "")}`;

      expect(await readEvents(storePath)).toHaveLength(beforeEvents.length);
      expect(data.governance.summary).toMatchObject({
        total_items: 6,
        needs_user_action: 2,
        safe_inspections: 4,
        hidden_private_records: 1
      });
      expect(data.governance.sources).toMatchObject({
        capture_policy: true,
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
          "Audit trail: capture_policy.findings_by_id.review_required"
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
          "Audit trail: capture_policy.findings_by_id.auto_captured"
        ],
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
      expect(data.governance.items_by_id[`maintenance:${maintenancePlan?.plan_id}`]).toMatchObject({
        source: "maintenance",
        category: "project_identity",
        severity: "warning",
        record_ids: ["rec_governance_item_2"],
        evidence_path: `maintenance.plans_by_id.${maintenancePlan?.plan_id}`,
        action_label: "Apply Repair",
        action_id: maintenanceActionId,
        safe_to_run: false,
        requires_user_confirmation: true,
        writes: "append_only_events"
      });
      expect(data.governance.items_by_id["dogfood_report:capture_review_backlog"]).toMatchObject({
        source: "dogfood_report",
        category: "dogfood_friction",
        record_ids: ["rec_governance_item_4", "rec_governance_item_3"],
        evidence_path: "dogfood_report.findings_by_id.capture_review_backlog",
        action_label: "review_capture_inbox",
        safe_to_run: true,
        requires_user_confirmation: false,
        writes: "none"
      });
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
        record_ids: ["rec_governance_item_6"]
      });
      expect(JSON.stringify(data.governance)).not.toContain("Private Governance Hub item must stay hidden");

      const html = renderDashboardHtml(data);
      expect(html).toContain("Governance Hub");
      expect(html).toContain("<details class=\"governance-item");
      expect(html).toContain("data-dashboard-detail=\"governance:capture_policy:review_required\"");
      expect(html).toContain("<details class=\"governance-safe-group\" data-dashboard-detail=\"governance-safe-inspections\">");
      expect(html).toContain("<span>Safe Inspections</span>");
      expect(html).toContain("<small>4 read-only checks</small>");
      expect(html).toContain("<div class=\"governance-safe-list\">");
      expect(html).toContain("<summary class=\"governance-item-summary\">");
      expect(html).toContain("data-governance-evidence");
      expect(html).toContain("data-governance-review-log");
      expect(html).toContain("<h4>Review log</h4>");
      expect(html).toContain("Detected: Some captured records are waiting for a human decision.");
      expect(html).toContain("Recommended next step: Review in Capture Inbox.");
      expect(html).toContain("Write boundary: requires explicit approval before append-only memory events.");
      expect(html).toContain("Audit trail: capture_policy.findings_by_id.review_required");
      expect(html).toContain("<summary>Raw audit fields</summary>");
      expect(html).toContain("data-governance-item=\"capture_policy:review_required\"");
      expect(html).toContain("data-governance-item=\"memory_lifecycle:stale_records\"");
      expect(html).toContain("data-governance-item=\"dogfood_report:failure_signals\"");
      expect(html).toContain("governance.summary");
      expect(html).toContain("capture_policy.findings_by_id.review_required");
      expect(html).toContain("Read-only");
      expect(html).toContain("User confirmation");
      expect(html).toContain("Safe inspection");
      expect(html).not.toContain("<article class=\"governance-item");
      expect(html).toContain("data-dashboard-detail=\"debug-inspector\"");
      expect(html).toContain("data-dashboard-detail=\"inspector:records\"");
      expect(html).not.toContain("<details open data-dashboard-detail=\"inspector:records\">");
      expect(html).toContain("<details class=\"panel memory-lifecycle\" data-dashboard-detail=\"memory-lifecycle-audit\"");
      expect(html).toContain("<span>Memory Lifecycle</span>");
      expect(html).toContain("<details class=\"panel capture-policy-audit\" data-dashboard-detail=\"capture-policy-audit\"");
      expect(html).toContain("<span>Capture Policy Audit</span>");
      expect(html).not.toContain("<section class=\"panel memory-lifecycle\"");
      expect(html).not.toContain("<section class=\"panel capture-policy-audit\"");
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
        next_action_label: "No approval queue",
        target: "needs-attention"
      });
      expect(data.action_board.items_by_id.review).toMatchObject({
        label: "Review",
        value: 1,
        severity: "warning",
        summary: "1 attention item",
        detail: "Warnings and critical signals remain visible in Needs Attention.",
        next_action_label: "Review warning signals"
      });
      expect(data.action_board.items_by_id.sync).toMatchObject({
        label: "Sync",
        value: 1,
        severity: "info",
        summary: "Local Only",
        next_action_label: "Inspect sync state"
      });
      expect(data.recent_value.find((record) => record.state === "quarantined")?.summary).toBe("[quarantined]");

      const html = renderDashboardHtml(data);
      expect(html).toContain("class=\"health-badge");
      expect(html).toContain("<section class=\"status-strip");
      expect(html).toContain("<strong>Dashboard Status</strong>");
      expect(html).toContain("data-dashboard-status=\"");
      expect(html).not.toContain("<section class=\"hero\">");
      expect(html).toContain("<section class=\"action-board\" aria-label=\"Action Board\" data-action-board-nav>");
      expect(html).toContain("<h2>Action Board</h2>");
      expect(html).toContain("<button type=\"button\" class=\"action-board-item good\" data-action-board-item=\"confirm\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\">");
      expect(html).toContain("<button type=\"button\" class=\"action-board-item warning\" data-action-board-item=\"review\" data-action-board-target=\"needs-attention\" aria-controls=\"needs-attention\">");
      expect(html).toContain("<button type=\"button\" class=\"action-board-item good\" data-action-board-item=\"inspect\" data-action-board-target=\"governance-hub\" aria-controls=\"governance-hub\">");
      expect(html).toContain("<button type=\"button\" class=\"action-board-item info\" data-action-board-item=\"sync\" data-action-board-target=\"store-signals\" aria-controls=\"store-signals\">");
      expect(html).toContain("data-action-board-nav");
      expect(html).toContain("<em class=\"action-board-next\">No approval queue</em>");
      expect(html).toContain("<em class=\"action-board-next\">Review warning signals</em>");
      expect(html).toContain("<em class=\"action-board-next\">Inspect Governance Hub</em>");
      expect(html).toContain("<em class=\"action-board-next\">Inspect sync state</em>");
      expect(html).toContain("target.open = true");
      expect(html).toContain("target.closest(\"details\")");
      expect(html).toContain("target.scrollIntoView({ block: \"start\", behavior: \"smooth\" })");
      expect(html).toContain("Warnings and critical signals remain visible in Needs Attention.");
      expect(html).not.toContain("<section class=\"overview-grid\" aria-label=\"Dashboard overview\">");
      expect(html).toContain("Needs Attention");
      expect(html).toContain("<section id=\"needs-attention\" class=\"panel\" data-dashboard-section=\"needs-attention\">");
      expect(html).toContain("<details class=\"attention warning\" data-dashboard-detail=\"attention:Quarantined records hidden\">");
      expect(html).toContain("<details class=\"attention-info-group\" data-dashboard-detail=\"attention-info-checks\">");
      expect(html).toContain("<span>Info Checks</span>");
      expect(html).toContain("<small>1 info item</small>");
      expect(html).toContain("<div class=\"attention-info-list\">");
      expect(html).toContain("<details class=\"attention info\" data-dashboard-detail=\"attention:Sync is not configured\">");
      expect(html).toContain("<summary class=\"attention-summary\">");
      expect(html).toContain("<div class=\"attention-body\">");
      expect(html).not.toContain("<article class=\"attention warning\">");
      expect(html).toContain("<details class=\"panel supporting-evidence\" data-dashboard-detail=\"supporting-evidence\" aria-label=\"Supporting Evidence\">");
      expect(html).toContain("<span>Supporting Evidence</span>");
      expect(html).toContain("<small>store signals / recent value / debug inspector</small>");
      const supportingEvidenceIndex = html.indexOf("<details class=\"panel supporting-evidence\" data-dashboard-detail=\"supporting-evidence\" aria-label=\"Supporting Evidence\">");
      const storeSignalsIndex = html.indexOf("<details id=\"store-signals\" class=\"panel store-signals\" data-dashboard-detail=\"store-signals\"");
      const recentValueIndex = html.indexOf("<details class=\"panel recent-value-panel\" data-dashboard-detail=\"recent-value\">");
      const debugInspectorIndex = html.indexOf("<details class=\"panel debug-inspector\" data-dashboard-detail=\"debug-inspector\">");
      expect(storeSignalsIndex).toBeGreaterThan(supportingEvidenceIndex);
      expect(recentValueIndex).toBeGreaterThan(storeSignalsIndex);
      expect(debugInspectorIndex).toBeGreaterThan(recentValueIndex);
      expect(html).toContain("<details id=\"store-signals\" class=\"panel store-signals\" data-dashboard-detail=\"store-signals\"");
      expect(html).not.toContain("<details open class=\"panel store-signals\"");
      expect(html).toContain("<span>Store Signals</span>");
      expect(html).toContain("<small>agent activity / record quality / sync</small>");
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
      expect(html).toContain(".action-board-grid");
      expect(html).toContain(".action-board-item.warning");
      expect(html).toContain(".bar-row:nth-child(3)");
      expect(html).toContain(".value-card:nth-child(4)");
      expect(html).toContain(".dashboard-fold-summary");
      expect(html).toContain("flex-wrap: wrap");
      expect(html).toContain("min-width: 0");
      expect(html).toContain("overflow-wrap: anywhere");
      expect(html).not.toContain("Memory Quality");
      expect(html).toContain("overflow-wrap: anywhere");
      expect(html).toContain("table-layout: fixed");
      expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; visible text");
      expect(html).not.toContain("<script>alert('x')</script>");
      expect(html).not.toContain("sk-test_1234567890abcdefghijklmnopqrstuvwxyz");
    });
  });

  it("renders Recent Value as compact excerpts while keeping full JSON data", async () => {
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
      expect(html).toContain("Important compact recent value intro.");
      expect(html).toContain("data-full-summary-hidden=\"true\"");
      expect(html).toContain("Full text available through timeline/recall.");
      expect(html).not.toContain("FULL_CONTENT_SENTINEL");
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

  it("keeps extra Recent Value records in a collapsed overflow section", async () => {
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
      expect(html).toContain("<details class=\"panel recent-value-panel\" data-dashboard-detail=\"recent-value\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary recent-value-fold\">");
      expect(html).toContain("<span>Recent Value</span>");
      expect(html).toContain("<small>6 records | newest first | full details kept</small>");
      expect(html).toContain("<div class=\"recent-value-body\">");
      expect(html).toContain("data-dashboard-detail=\"recent-value-overflow\"");
      expect(html).toContain("<span>More Recent Value</span>");
      expect(html).toContain("<small>2 additional records</small>");
      expect(html).not.toContain("<details open data-dashboard-detail=\"recent-value-overflow\"");
      expect(html.match(/class="value-card(?: |")/g)).toHaveLength(6);
      expect(html.match(/class="value-card value-card-overflow"/g)).toHaveLength(2);
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
      expect(html).toContain("Memory Lifecycle");
      expect(html).toContain("default_memory_lifecycle_policy");
      expect(html).toContain("Archive candidates");
      expect(html).toContain("Stale records");
      expect(html).toContain("Read-only");
      expect(html).toContain("archive_after_review");
      expect(html).toContain(`moryn archive ${archiveCandidate.record.id}`);
      expect(html).toContain(`moryn timeline --record-id ${staleRecord.record.id} --project-id moryn`);
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

      expect(html).toContain("Review Queue");
      expect(html).toContain("<details class=\"maintenance-review-summary\" data-dashboard-detail=\"maintenance-review-queue\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary maintenance-review-fold\">");
      expect(html).toContain("<span>Review Queue</span>");
      expect(html).toContain("<small>1 plan | 1 record to move | explicit approval</small>");
      expect(html).toContain("<div class=\"maintenance-review-body\">");
      expect(html).toContain("Project identity repair");
      expect(html).toContain("data-maintenance-decision-summary");
      expect(html).toContain("Review before write");
      expect(html).toContain("Plan hash guard");
      expect(html).toContain("Why");
      expect(html).toContain("Change");
      expect(html).toContain("Safety");
      expect(html).toContain("Action");
      expect(html).toContain("Move 1 record");
      expect(html).toContain("repo-e6f0166fd942 to moryn");
      expect(html).toContain("Server re-runs the dry run and checks plan_hash before applying.");
      expect(html).toContain("data-maintenance-review-log");
      expect(html).toContain("<h4>Review log</h4>");
      expect(html).toContain("Detected: Project identity repair found records under an old project id.");
      expect(html).toContain("Proposed change: Move 1 record from repo-e6f0166fd942 to moryn.");
      expect(html).toContain("Approval gate: server re-runs the dry run and checks plan_hash before applying.");
      expect(html).toContain("Audit trail: raw plan, record ids, rollback path, and equivalent CLI command are below.");
      expect(html).toContain("Evidence, rollback, and raw plan");
      expect(html).toContain("data-maintenance-detail=\"evidence\"");
      expect(html).toContain("data-maintenance-detail=\"rollback\"");
      expect(html).toContain("data-maintenance-detail=\"raw-plan\"");
      expect(html).toContain("Evidence");
      expect(html).toContain("Rollback path");
      expect(html).toContain("Boot and recall can miss these memories");
      expect(html).toContain("Apply the repair only after confirming");
      expect(html).toContain("append-only revise_record events");
      expect(html).toContain("moryn project migrate --from moryn --to repo-e6f0166fd942 --apply --confirm");
      expect(html).toContain("repo-e6f0166fd942");
      expect(html).toContain("Apply Repair");
      expect(html).toContain("Copy command");
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
      expect(html).not.toContain("window.confirm");
      expect(html).not.toContain("Technical details");
    });
  });

  it("adds a read-only Context Pack Review panel for project handoff readiness", async () => {
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
      expect(html).toContain("<details class=\"panel context-pack-review\" data-dashboard-detail=\"context-pack-review\" data-context-pack-state=\"ready\" aria-label=\"Context Pack Review\">");
      expect(html).not.toContain("<details open class=\"panel context-pack-review\"");
      expect(html).toContain("<summary class=\"dashboard-fold-summary context-pack-review-fold\">");
      expect(html).toContain("<span>Context Pack Review</span>");
      expect(html).toContain("<small>ready | all checks passed | 1 decision | 1 thread | 1 risk</small>");
      expect(html).toContain("<div class=\"context-pack-readiness\" aria-label=\"Context Pack readiness\">");
      expect(html).toContain("<span class=\"context-pack-chip good\">Ready</span>");
      expect(html).toContain("<span class=\"context-pack-chip good\">6/6 checks</span>");
      expect(html).toContain("<span class=\"context-pack-chip info\">3 evidence items</span>");
      expect(html).toContain("<span class=\"context-pack-chip good\">Capture action visible</span>");
      expect(html).toContain("<div class=\"context-pack-review-body\">");
      expect(html).toContain("agent_handoff");
      expect(html).toContain("Read-only");
      expect(html).toContain("<details class=\"context-pack-checks-fold\" data-dashboard-detail=\"context-pack-checks\">");
      expect(html).toContain("<span>Quality Checks</span>");
      expect(html).toContain("<small>6 passed | 0 review</small>");
      expect(html).toContain("<ul class=\"context-pack-checks\">");
      expect(html).toContain("data-dashboard-detail=\"context-pack-evidence\"");
      expect(html).toContain("<span>Context Evidence</span>");
      expect(html).toContain("<small>1 decision | 1 thread | 1 risk</small>");
      expect(html).not.toContain("<details open data-dashboard-detail=\"context-pack-evidence\"");
      expect(html).toContain("Dashboard should review context pack readiness.");
      expect(html).toContain("Codex finished handoff review implementation.");
      expect(html).toContain("Do not make dashboard context review mutate memory.");
      expect(html).toContain("next.actions_by_id.capture_session");
      expect(html).not.toContain("data-context-pack-approve");
      expect(html).not.toContain("data-dashboard-action-id=\"context_pack");
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
      expect(html).toContain("Unavailable");
      expect(html).toContain("Open the dashboard with --project-id or --project");
      const contextPackSection = html.match(/<section class="panel context-pack-review"[\s\S]*?<\/section>/)?.[0] ?? "";
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
      };

      expect(data.capture_inbox.total).toBe(1);
      expect(data.action_board.items_by_id.confirm).toMatchObject({
        value: 4,
        next_action_label: "Open approval queue",
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
      expect(html).toContain("<button type=\"button\" class=\"action-board-item warning\" data-action-board-item=\"confirm\" data-action-board-target=\"capture-inbox\" aria-controls=\"capture-inbox\">");
      expect(html).toContain("<em class=\"action-board-next\">Open approval queue</em>");
      expect(html).toContain("1 candidate");
      expect(html).toContain("Codex finished Capture Inbox planning.");
      expect(html).toContain("Approve Memory");
      expect(html).toContain("Reject");
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
      expect(html).not.toContain("<details class=\"capture-policy-summary\" data-dashboard-detail=\"capture-policy-summary\">");
      expect(html).toContain("<span>Capture Audit</span>");
      expect(html).toContain("<small>manual review | no auto-canonical | 4 candidates</small>");
      expect(html).toContain("default_capture_review_policy");
      expect(html).toContain("Manual review");
      expect(html).toContain("No auto-canonical");
      expect(html).toContain("Trust disabled");
      expect(html).toContain("User action required");
      expect(html).toContain("stale batch protection");
      expect(html).toContain("smoke_test_marker");
      expect(html).toContain("duplicate_text");
      expect(html).toContain("2 groups");
      expect(html).toContain("Approve Group");
      expect(html).toContain("Reject Group");
      expect(html).toContain("Likely noise");
      expect(html).toContain("Smoke test marker only.");
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
      expect(html).toContain("Capture Policy Audit");
      expect(html).toContain("capture_policy");
      expect(html).toContain("inspect_policy_archived_record");
      expect(html).toContain("data-capture-policy-decision=\"rec_capture_policy_1\"");
      expect(html).toContain("data-capture-inbox-record=\"rec_capture_policy_1\"");
      expect(html).toContain("api/capture-inbox/rec_capture_policy_1/approve");
      expect(html).toContain("api/capture-inbox/rec_capture_policy_1/reject");
      expect(html).toContain("Review in Capture Inbox");
      expect(html).toContain("User action required");
      expect(html).toContain("data-capture-policy-decision=\"rec_capture_policy_2\"");
      expect(html).toContain("moryn timeline --record-id rec_capture_policy_2 --project-id moryn --before 3 --after 3");
      expect(html).not.toContain("api/capture-inbox/rec_capture_policy_2/approve");
      expect(html).not.toContain("api/capture-inbox/rec_capture_policy_2/reject");
      expect(html).toContain("smoke_test_marker");
      expect(html).toContain("Smoke test marker only.");
      expect(html).toContain("Useful handoff still needs user review.");
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
      expect(html).toContain("Auto-captured handoff");
      expect(html).toContain("Auto-captured 1");
      expect(html).toContain("low_risk_handoff_auto_capture");
      expect(html).toContain("Codex finished setup wizard polish.");
      expect(html).toContain("inspect_auto_captured_handoff");
      expect(html).toContain("moryn timeline --record-id rec_auto_capture_1 --project-id moryn --before 3 --after 3");
      expect(html).not.toContain("api/capture-inbox/rec_auto_capture_1/approve");
      expect(html).not.toContain("api/capture-inbox/rec_auto_capture_1/reject");
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
      expect(html).toContain("<details class=\"panel clean-audit-reports\" data-dashboard-detail=\"clean-audit-reports\" aria-label=\"Clean Audit Reports\">");
      expect(html).toContain("<summary class=\"dashboard-fold-summary clean-audit-reports-fold\">");
      expect(html).toContain("<span>Clean Audit Reports</span>");
      expect(html).toContain("<small>Memory Lifecycle clean | Capture Policy clean</small>");
      expect(html).toContain("<div class=\"clean-audit-list\">");
      expect(html).toContain("data-capture-policy-decision=\"rec_policy_handled\"");
      expect(html).toContain("Review already handled");
      expect(html).toContain("<details class=\"clean-audit-report memory-lifecycle\" data-dashboard-detail=\"memory-lifecycle-audit\"");
      expect(html).toContain("<details class=\"clean-audit-report capture-policy-audit\" data-dashboard-detail=\"capture-policy-audit\"");
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
        };

        expect(response.status).toBe(200);
        expect(applied).toMatchObject({
          ok: true,
          status: "applied",
          migrated_records: 1,
          events_written: 1
        });
        expect((await engine.recall({ record_ids: [oldRecord.record.id], project_id: "moryn" })).results[0]?.record.project_id).toBe("moryn");
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
