import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { errorCode, nextAction, recommendedAction } from "../src/core/errors.js";

describe("documentation contracts", () => {
  function expectText(document: string, text: string): void {
    expect(document.replace(/\s+/g, " ")).toContain(text);
  }

  it("documents the observability dashboard server and static artifact", async () => {
    const [readme, installPrompt, workflow, contracts, roadmap, dashboard] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-install-prompt.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8"),
      readFile("docs/dashboard.md", "utf8")
    ]);

    expect(readme).toContain("moryn dashboard");
    expect(readme).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(readme).toContain("http://127.0.0.1:8765/");
    expect(readme).toContain("docs/dashboard.md");
    expect(readme).toContain("[Dashboard](docs/dashboard.md)");
    expect(readme).toContain("--no-open");
    expect(readme).toContain("state/dashboard/index.html");
    expect(installPrompt).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(installPrompt).toContain("http://127.0.0.1:8765/");
    expect(installPrompt).toContain("--host 0.0.0.0");
    expect(installPrompt).toContain("moryn dashboard --no-open");
    expect(installPrompt).toContain("[Dashboard](dashboard.md)");
    expect(workflow).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(workflow).toContain("http://127.0.0.1:8765/");
    expect(workflow).toContain("record quality");
    expect(workflow).toContain("open the static snapshot");
    expect(contracts).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(contracts).toContain("/api/dashboard");
    expect(contracts).toContain("/api/maintenance/plans/:plan_id/approve");
    expect(contracts).toContain("/api/capture-inbox/:record_id/approve");
    expect(contracts).toContain("/api/capture-inbox/:record_id/reject");
    expect(contracts).toContain("/api/capture-inbox/groups/:group_id/approve");
    expect(contracts).toContain("/api/capture-inbox/groups/:group_id/reject");
    expect(contracts).toContain("plan_hash");
    expect(contracts).toContain("/healthz");
    expect(contracts).toContain("docs/dashboard.md");
    expect(contracts).toContain("dashboard");
    expect(contracts).toContain('"tool": "dashboard"');
    expect(roadmap).toContain("[dashboard.md](dashboard.md)");
    expect(roadmap).toContain("Local dashboard server and static snapshots");
    expect(dashboard).toContain("# Moryn Dashboard");
    expect(dashboard).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(dashboard).toContain("http://127.0.0.1:8765/");
    expect(dashboard).toContain("moryn dashboard --serve --host 0.0.0.0 --port 8765");
    expect(dashboard).toContain("GET /fragment");
    expect(dashboard).toContain("GET /api/dashboard");
    expect(dashboard).toContain("actions_by_id");
    expect(dashboard).toContain("decision_summary");
    expect(dashboard).toContain("recall_eval");
    expect(dashboard).toContain("recall_eval_case");
    expect(dashboard).toContain("data-dashboard-action-id");
    expectText(dashboard, "healthy snapshots render as a lightweight `dashboard-status-line`");
    expectText(dashboard, "Sync-only pending states also use the lightweight status line");
    expectText(dashboard, "Non-healthy states that need a separate explanation, such as local-only, review, or conflict, still render the full status strip");
    expectText(dashboard, "Each overview card is also a local navigation button");
    expectText(dashboard, "Pure read-only inspections do not turn the overview headline into an urgent next action");
    expectText(dashboard, "the overview reads `All clear` while still offering an `Inspect checks` navigation button");
    expectText(dashboard, "keeps non-good overview cards visible in the main grid");
    expectText(dashboard, "groups good cards under `Reference Cards`");
    expect(dashboard).toContain("Evidence Library");
    expectText(dashboard, "Health Check, Recall Eval, Dogfood Review, Governance Hub, Context Pack Review, and Audit Trail");
    expectText(dashboard, "visible summary is content-aware");
    expectText(dashboard, "when there are findings it shows finding and reference group counts");
    expectText(dashboard, "reads `Reference evidence only`");
    expectText(dashboard, "routine read-only diagnostics such as a healthy Health Check, clean or unavailable Recall Eval, and ready or unavailable Context Pack Review are grouped under `Routine Diagnostics`");
    expectText(dashboard, "grouped first under `Read-only Findings`");
    expectText(dashboard, "read-only findings do not look like pending approval work");
    expectText(dashboard, "Routine Diagnostics and Audit Trail are grouped behind `Reference Evidence`");
    expectText(dashboard, "folded summary reads `Routine checks and audit trail`");
    expectText(dashboard, "instead of listing reference-panel counts");
    expectText(dashboard, "Empty groups are omitted");
    expectText(dashboard, "Item-level detail remains available for inspection as collapsed candidate details inside each group");
    expectText(dashboard, "When there are no warning or critical action signals");
    expectText(dashboard, "the same scroll target renders as a lightweight `needs-attention-quiet-line`");
    expectText(dashboard, "with the visible title `Info Checks`");
    expectText(dashboard, "It preserves the `id=\"needs-attention\"` scroll target and collapsed Info Checks detail for audit");
    expect(dashboard).toContain("Dogfood Review");
    expect(dashboard).toContain("Issue brief");
    expectText(dashboard, "It does not contain Capture Inbox approvals or Review Queue maintenance approvals");
    expectText(dashboard, "remain available inside the nested `Audit Trail` panel");
    expectText(dashboard, "`Clean Audit Reports`, `Store Signals`, and `Recent Value` are grouped under `Operational Evidence`");
    expectText(dashboard, "collapsed by default behind a short recent-record count");
    expectText(dashboard, "Newest-first ordering, full details, and trace commands stay inside the expanded panel");
    expectText(dashboard, "the raw `Debug Inspector` is grouped behind `Raw Inspector`");
    expectText(dashboard, "`Raw Inspector` opens with `Records, events, and sync`");
    expectText(dashboard, "shows compact inspection rows with readable source labels, title, read-only next step, and evidence path");
    expectText(dashboard, "keep plain-language `Review notes` for detection, next step, write boundary, and evidence source");
    expect(dashboard).toContain("Safe Action Registry");
    expect(dashboard).toContain("Capture Inbox");
    expectText(dashboard, "zero-count buckets are hidden from the collapsed summary");
    expectText(dashboard, "zero-value `good` targets are grouped under `Reference Checks`");
    expectText(dashboard, "Non-zero or non-good items stay in the main Action Board grid");
    expectText(dashboard, "renders a compact `Pending Decisions` panel");
    expectText(dashboard, "Visible write boundaries use user-readable labels such as `Append-only events`");
    expectText(dashboard, "It counts human decision units, not raw approve/reject buttons");
    expectText(dashboard, "Actual writes remain inside Capture Inbox and Review Queue controls");
    expect(dashboard).toContain("all clear");
    expect(dashboard).toContain("POST /api/capture-inbox/:record_id/approve");
    expect(dashboard).toContain("POST /api/capture-inbox/:record_id/reject");
    expect(dashboard).toContain("POST /api/capture-inbox/groups/:group_id/approve");
    expect(dashboard).toContain("manual review");
    expect(dashboard).toContain("No auto-canonical");
    expect(dashboard).toContain("likely noise");
    expect(dashboard).toContain("default_capture_review_policy");
    expect(dashboard).toContain("default_autocapture_policy");
    expect(dashboard).toContain("capture_inbox.autocapture_policy");
    expect(dashboard).toContain("Capture Policy Audit");
    expectText(dashboard, "also summarizes auto-captured and policy-archived counts");
    expect(dashboard).toContain("Context Pack Review");
    expect(dashboard).toContain("context_pack_review");
    expect(dashboard).toContain("handoff_pack.quality_gate");
    expect(dashboard).toContain("local_event_history");
    expect(dashboard).toContain("does not guess a project");
    expect(dashboard).toContain("does not render Approve, Apply, Promote, Archive, or Reject controls");
    expect(dashboard).toContain("moryn capture policy");
    expect(dashboard).toContain("capture_policy");
    expectText(dashboard, "folded summary uses plain routing labels such as");
    expect(dashboard).toContain("`captured`, `review`, and `archived`");
    expect(dashboard).toContain("Review in Capture Inbox");
    expect(dashboard).toContain("Auto-captured handoff");
    expect(dashboard).toContain("Approve Memory");
    expect(dashboard).toContain("Policy archived");
    expect(dashboard).toContain("inspect_auto_captured_handoff");
    expect(dashboard).toContain("inspect_policy_archived_record");
    expect(dashboard).toContain("read-only timeline command");
    expectText(dashboard, "does not turn them back into inbox items automatically");
    expect(dashboard).toContain("smoke_test_marker");
    expect(dashboard).toContain("duplicate_text");
    expect(contracts).toContain("default_capture_review_policy");
    expect(contracts).toContain("default_autocapture_policy");
    expect(contracts).toContain("moryn capture policy");
    expect(contracts).toContain("capture_policy");
    expect(contracts).toContain("actions_by_id.<action_id>");
    expect(contracts).toContain("Safe Action Registry");
    expect(contracts).toContain("recall_eval.generated_from.writes");
    expect(contracts).toContain('source: "recall_eval"');
    expect(contracts).toContain('category:\n"recall_quality"');
    expect(contracts).toContain("Recall Eval approval endpoint");
    expect(contracts).toContain("context_pack_review");
    expect(contracts).toContain("CONTEXT_PACK_REVIEW_SELECTION_SOURCES");
    expect(contracts).toContain("Open the dashboard with --project-id or --project");
    expectText(contracts, "does not call the host adapter context_pack operation");
    expectText(contracts, "does not expose a Context Pack approve or apply endpoint");
    expectText(contracts, "does not create a background executor");
    expect(contracts).toContain('decision: "capture"');
    expect(contracts).toContain("inspect_auto_captured_handoff");
    expectText(contracts, "Review decisions reuse the existing Capture Inbox");
    expectText(contracts, "policy-archived decisions expose only");
    expectText(contracts, "does not expose a separate Capture Policy apply endpoint");
    expect(contracts).toContain("policy_decision");
    expect(contracts).toContain("canonical memory requires explicit user");
    expect(dashboard).toContain("Memory Lifecycle");
    expect(dashboard).toContain("moryn memory lifecycle");
    expect(dashboard).toContain("memory_lifecycle");
    expect(dashboard).toContain("default_memory_lifecycle_policy");
    expect(dashboard).toContain("safe_to_run: false");
    expect(dashboard).toContain("does not provide an Apply or");
    expect(dashboard).toContain("memory_lifecycle");
    expect(contracts).toContain("memory_lifecycle");
    expect(contracts).toContain("does not expose an Apply or Approve Lifecycle endpoint");
    expect(dashboard).toContain("Review Queue");
    expectText(readme, "Context Pack Review");
    expect(readme).toContain("context_pack_review");
    expectText(readme, "read-only handoff readiness");
    expect(readme).toContain("auto-captured local");
    expect(dashboard).toContain("POST /api/maintenance/plans/:plan_id/approve");
    expect(dashboard).toContain("plan_hash");
    expect(dashboard).toContain("decision card");
    expect(dashboard).toContain("Decision evidence");
    expect(dashboard).toContain("Before approving");
    expect(dashboard).toContain("approval surface reads like a decision checklist instead of internal logs");
    expect(dashboard).toContain("recommended action");
    expect(dashboard).toContain("rollback path");
    expect(contracts).toContain("decision_card");
    expect(dashboard).toContain("MCP `dashboard` tool");
    expect(dashboard).toContain("does not start a long-running HTTP server");
  });

  it("documents the host adapter and autocapture path without changing Moryn positioning", async () => {
    const [readme, installPrompt, workflow, design, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-install-prompt.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/moryn-design.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8")
    ]);

    for (const document of [readme, installPrompt, workflow, design, roadmap]) {
      expect(document).toContain("multi-agent");
      expect(document).toContain("multi-device");
      expect(document).toContain("moryn install");
      expect(document).toContain("moryn context pack");
      expect(document).toContain("moryn capture session");
    }
    expect(readme).toContain("moryn install --host codex --project . --apply");
    expect(readme).toContain("moryn context pack --project . --agent codex");
    expect(readme).toContain("moryn capture session --project . --agent codex --summary");
    expect(readme).toContain("moryn capture policy --project . --limit 20");
    expect(readme).toContain("Handoff Pack v0.2");
    expect(readme).toContain("recent decisions");
    expect(workflow).toContain("handoff_pack");
    expect(workflow).toContain("recent_decisions");
    expect(workflow).toContain("open_threads");
    expect(roadmap).toContain("Handoff Pack v0.2");
    expect(installPrompt).toContain("host adapter");
    expect(installPrompt).toContain("autocapture");
    expect(workflow).toContain("Host Adapter Flow");
    expect(readme).toContain("default_autocapture_policy");
    expect(workflow).toContain("capture_policy");
    expect(workflow).toContain("default_autocapture_policy");
    expect(roadmap).toContain("default_autocapture_policy");
    expectText(readme, "Nothing becomes canonical memory without user approval");
    expect(design).toContain("Host Adapter / Autocapture Layer");
    expect(roadmap).toContain("Host adapter registry and autocapture");
  });

  it("documents the setup wizard as a local auditable one-command path", async () => {
    const [readme, installPrompt, workflow, contracts, design, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-install-prompt.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/moryn-design.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8")
    ]);

    for (const document of [readme, installPrompt, workflow, contracts, design, roadmap]) {
      expect(document).toContain("moryn setup");
      expect(document).toContain("dry-run");
      expect(document).toContain("host configuration files");
    }
    expect(readme).toContain("moryn setup --host codex --project . --apply");
    expect(installPrompt).toContain("Run `moryn setup --project . --host \"<host client name>\" --apply`.");
    expect(workflow).toContain("moryn setup --host codex --project . --apply");
    expect(contracts).toContain("moryn contracts operations --operation setup");
    expect(contracts).toContain('"tool": "setup"');
    expect(contracts).toContain("SETUP_WIZARD_SELECTION_SOURCES");
    expect(contracts).toContain("checks_by_id.<check>");
    expect(contracts).toContain("apply_result");
    expect(contracts).toContain("host_config_writes");
    expect(roadmap).toContain("Setup wizard / one-command local setup");
  });

  it("documents the product positioning guardrail and phase decision gate", async () => {
    const [readme, design, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/moryn-design.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8")
    ]);

    for (const document of [readme, design, roadmap]) {
      expect(document).toContain("user-owned");
      expect(document).toContain("auditable");
      expect(document).toContain("context store");
      expect(document).toContain("not an agent platform");
      expect(document).toContain("not a vector-memory SDK");
      expect(document).toContain("not a hosted cloud service");
    }

    expect(roadmap).toContain("Default path");
    expect(roadmap).toContain("Power path");
    expect(roadmap).toContain("Core boundary");
    expect(roadmap).toContain("Phase decision gate");
    expect(roadmap).toContain("Phase 1: Auditable Autocapture");
    expect(roadmap).toContain("Phase 2: Memory Governance");
    expect(roadmap).toContain("Phase 3: Setup Wizard");
    expect(roadmap).toContain("Phase 4: Recall Eval");
    expect(roadmap).toContain("Phase 5: Public Polish");
    expect(roadmap).toContain("Phase 6: Release Gate");
    expect(roadmap).toContain("Do not start this phase until");
  });

  it("documents the read-only memory doctor governance surface", async () => {
    const [readme, workflow, contracts] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8")
    ]);

    for (const document of [readme, workflow, contracts]) {
      expect(document).toContain("moryn memory doctor");
      expect(document).toContain("memory_doctor");
      expect(document).toContain("read-only");
      expect(document).toContain("safe_to_run: false");
    }
    expect(contracts).toContain("moryn contracts operations --operation memory_doctor");
    expect(contracts).toContain('"tool": "memory_doctor"');
    expect(contracts).toContain("memory_doctor.findings_by_id.<finding_id>");
    expect(contracts).toContain("memory_doctor.suggested_actions_by_id.<action_id>");
    for (const document of [readme, workflow, contracts]) {
      expect(document).toContain("moryn project migrate --from");
      expect(document).toContain("--apply --confirm");
      expect(document).toContain("project_migrate");
    }
    expect(contracts).toContain("moryn contracts operations --operation project_migrate");
  });

  it("documents the read-only dogfood report surface", async () => {
    const [readme, workflow, contracts, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8")
    ]);

    for (const document of [readme, workflow, contracts]) {
      expect(document).toContain("moryn dogfood report");
      expect(document).toContain("dogfood_report");
      expect(document).toContain("read-only");
      expectText(document, "failure or timeout signals");
    }
    expect(contracts).toContain("moryn contracts operations --operation dogfood_report");
    expect(contracts).toContain('"tool": "dogfood_report"');
    expect(contracts).toContain("dogfood_report.findings_by_id.<finding_id>");
    expect(contracts).toContain("dogfood_report.suggested_actions_by_id.<action_id>");
    expectText(contracts, "Dogfood Review");
    expect(contracts).toContain("Issue brief");
    expectText(contracts, "does not add dashboard API write endpoints");
    expect(roadmap).toContain("dogfood report");
  });

  it("documents the read-only health check surface", async () => {
    const [readme, workflow, contracts, dashboard, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/dashboard.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8")
    ]);

    for (const document of [readme, workflow, contracts]) {
      expect(document).toContain("moryn health check");
      expect(document).toContain("health_check");
      expect(document).toContain("read-only");
      expectText(document, "installation");
    }
    expect(contracts).toContain("moryn contracts operations --operation health_check");
    expect(contracts).toContain('"tool": "health_check"');
    expect(contracts).toContain("health_check.checks_by_id.<check_id>");
    expect(contracts).toContain("health_check.suggested_actions_by_id.<action_id>");
    expect(dashboard).toContain("Moryn Health Check");
    expect(dashboard).toContain("health_check");
    expect(roadmap).toContain("health check");
  });

  it("documents the read-only memory lifecycle surface", async () => {
    const [readme, workflow, contracts, roadmap] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8")
    ]);

    for (const document of [readme, workflow, contracts]) {
      expect(document).toContain("moryn memory lifecycle");
      expect(document).toContain("memory_lifecycle");
      expect(document).toContain("read-only");
      expect(document).toContain("safe_to_run: false");
    }
    expect(contracts).toContain("moryn contracts operations --operation memory_lifecycle");
    expect(contracts).toContain('"tool": "memory_lifecycle"');
    expect(contracts).toContain("memory_lifecycle.assessments_by_record_id.<record_id>");
    expect(contracts).toContain("memory_lifecycle.findings_by_id.<finding_id>");
    expect(contracts).toContain("memory_lifecycle.suggested_actions_by_id.<action_id>");
    expect(roadmap).toContain("memory lifecycle");
  });

  it("keeps the design spec error contract aligned with runtime envelopes", async () => {
    const design = await readFile("docs/moryn-design.md", "utf8");
    const implementedCodes = [
      "STORE_NOT_INITIALIZED",
      "CONFIRMATION_REQUIRED",
      "INVALID_PROJECT_CONFIG",
      "PROJECT_CONTEXT_REQUIRED",
      "PROJECT_PATH_NOT_FOUND",
      "PROJECT_ID_NOT_FOUND",
      "PROJECT_ID_CONFLICT",
      "INVALID_STORE_CONFIG",
      "INVALID_ARGUMENT",
      "INVALID_RECORD",
      "SENSITIVE_CONTENT_DETECTED",
      "INDEX_STALE",
      "RECORD_NOT_FOUND",
      "SYNC_NOT_CONFIGURED",
      "PERMISSION_DENIED",
      "SYNC_CONFLICT",
      "SYNC_REMOTE_UNAVAILABLE",
      "INTERNAL_ERROR"
    ];

    expect(errorCode("Remote sync is unavailable; local store is still usable.")).toBe("SYNC_REMOTE_UNAVAILABLE");
    expect(design).toContain(`"recommended_action": "${recommendedAction("SYNC_REMOTE_UNAVAILABLE")}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("SYNC_REMOTE_UNAVAILABLE")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("SYNC_REMOTE_UNAVAILABLE")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("SYNC_CONFLICT")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("SYNC_CONFLICT")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INDEX_STALE")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INDEX_STALE")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_RECORD", "Invalid replay target for event evt_missing_revision: Record not found: rec_missing")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_RECORD", "Invalid replay target for event evt_missing_revision: Record not found: rec_missing")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("SYNC_NOT_CONFIGURED")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("SYNC_NOT_CONFIGURED")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("RECORD_NOT_FOUND", "Record not found: rec_missing")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("RECORD_NOT_FOUND", "Record not found: rec_missing")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_ARGUMENT", "Invalid argument: project_id is required for project scope")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_ARGUMENT", "Invalid argument: project_id is required for project scope")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("PROJECT_ID_CONFLICT", "Project id conflict: project_path resolves to moryn, but project_id was other. Use the .moryn.json project_id or update the project config.")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("PROJECT_ID_CONFLICT", "Project id conflict: project_path resolves to moryn, but project_id was other. Use the .moryn.json project_id or update the project config.")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("STORE_NOT_INITIALIZED")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("STORE_NOT_INITIALIZED")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${recommendedAction("INVALID_STORE_CONFIG")}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_STORE_CONFIG", "Invalid store config: /home/user/.moryn/config.json: Unexpected end of JSON input")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_STORE_CONFIG", "Invalid store config: /home/user/.moryn/config.json: Unexpected end of JSON input")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_PROJECT_CONFIG", "Invalid project config: /workspace/moryn/.moryn.json: project_id must be non-empty")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_PROJECT_CONFIG", "Invalid project config: /workspace/moryn/.moryn.json: project_id must be non-empty")?.tool}"`);
    const confirmationAction = nextAction("CONFIRMATION_REQUIRED", "Confirmation required: canonical state requires explicit user confirmation", {
      tool: "promote",
      command: "moryn promote rec_123 --state canonical",
      arguments: { record_id: "rec_123", target_state: "canonical" }
    });
    expect(design).toContain(`"recommended_action": "${confirmationAction?.recommended_action}"`);
    expect(design).toContain(`"tool": "${confirmationAction?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("PROJECT_CONTEXT_REQUIRED")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("PROJECT_CONTEXT_REQUIRED")?.tool}"`);
    for (const code of implementedCodes) {
      expect(design).toContain(`- \`${code}\``);
    }
  });
});
