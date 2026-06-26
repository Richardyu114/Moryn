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
    expect(readme).toContain("--readiness-host");
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
    expect(dashboard).toContain("--readiness-host <host>");
    expect(dashboard).toContain("server bind address");
    expect(dashboard).toContain("http://127.0.0.1:8765/");
    expect(dashboard).toContain("moryn dashboard --serve --host 0.0.0.0 --port 8765");
    expect(dashboard).toContain("GET /fragment");
    expect(dashboard).toContain("GET /api/dashboard");
    expectText(dashboard, "Concurrent `GET /`, `GET /fragment`, and `GET /api/dashboard` requests share the same in-flight dashboard data build");
    expectText(dashboard, "After that build settles, the next read request rebuilds from the local store again");
    expect(dashboard).toContain("actions_by_id");
    expect(dashboard).toContain("decision_summary");
    expect(dashboard).toContain("recall_eval");
    expect(dashboard).toContain("recall_eval_case");
    expectText(dashboard, "folded `Recall Eval` row reads `No recall eval cases yet`");
    expectText(dashboard, "expanded panel still shows the read-only unavailable reason and zero-case stats");
    expect(dashboard).toContain("data-dashboard-action-id");
    expectText(dashboard, "healthy snapshots render as a lightweight `dashboard-status-line`");
    expectText(dashboard, "Sync pending states skip the extra status line");
    expectText(dashboard, "Non-healthy states that need a separate explanation, such as local-only, review, or conflict, still render the full status strip");
    expectText(dashboard, "first-screen Overview to the headline, primary action, read-only boundary, and a collapsed `Background Status` fold");
    expectText(dashboard, "Each background overview card is also a local navigation button");
    expectText(dashboard, "Pure read-only inspections do not turn the overview headline into an urgent next action");
    expectText(dashboard, "the overview reads `All clear` while still offering an `Inspect checks` navigation button");
    expectText(dashboard, "keeps background cards under `Background Status` while keeping the stable `dashboard-overview-quiet-cards` route");
    expectText(dashboard, "`Background Status` opens with `Signals ready`");
    expectText(dashboard, "while the accessible summary keeps `Healthy signals kept for context`");
    expectText(dashboard, "When `Pending Decisions` is rendered, the visible HTML skips `Background Status` and the stable `dashboard-overview-quiet-cards` route");
    expectText(dashboard, "the overview cards remain in `/api/dashboard.dashboard_overview.cards` and `cards_by_id` for audit tooling");
    expectText(dashboard, "If sync is also pending, Pending Decisions still owns the Overview headline and primary action");
    expectText(dashboard, "sync remains visible through the health badge, Store Signals, and `/api/dashboard.dashboard_overview.cards`");
    expectText(dashboard, "`Dashboard Work Lanes` groups the first screen into");
    expectText(dashboard, "Decide -> Pending Decisions, Capture Inbox, or Review Queue confirmation");
    expectText(dashboard, "Context -> Context Pack Review handoff readiness");
    expectText(dashboard, "Health -> Needs Attention or Store Signals when sync is the active issue");
    expectText(dashboard, "Evidence -> Evidence Library and Audit Trail");
    expectText(dashboard, "The lanes are navigation only");
    expectText(dashboard, "do not render Approve, Reject, Promote, Archive, or Apply controls");
    expectText(dashboard, "do not add `data-dashboard-action-id`");
    expectText(dashboard, "Lane clicks resolve either an element `id` or a matching `data-dashboard-detail` target");
    expectText(dashboard, "routes such as `context-pack-review` and `evidence-library` open the collapsed detail panel before scrolling");
    expectText(dashboard, "When warning or critical signals exist, the Work Lanes keep only those blocking lanes visible on the first screen");
    expectText(dashboard, "fold non-blocking routes under `Background Lanes`");
    expectText(dashboard, "a Health warning keeps `Health` visible while `Decide`, `Context`, and `Evidence` stay available as quiet background lanes");
    expectText(dashboard, "In all-clear states, the row keeps the read-only `Evidence` lane visible and folds quiet `Decide`, `Context`, and `Health` lanes under `Background Lanes`");
    expectText(dashboard, "`Background Lanes` opens with `Quiet lanes ready`");
    expectText(dashboard, "while the accessible summary keeps the lane names, such as `Decide, Context, and Health are quiet`");
    expectText(dashboard, "When `Pending Decisions` is rendered, Work Lanes keep the active decision lane visible and skip `Background Lanes` and `dashboard-work-lanes-background` in the HTML");
    expectText(dashboard, "the same routes remain available through `/api/dashboard.action_board`, `Page Shortcuts`, and the underlying panels");
    expectText(dashboard, "`Action Board` is rendered as `Page Shortcuts` in the UI while keeping the stable `data-dashboard-detail=\"action-board\"` route");
    expectText(dashboard, "navigator below explicit review and action surfaces rather than another primary first-screen card grid");
    expectText(dashboard, "`Page Shortcuts` opens with `Optional section links`");
    expectText(dashboard, "The collapsed `Page Shortcuts` summary does not repeat active counts");
    expectText(dashboard, "Counts remain in the expanded shortcut cards and `/api/dashboard.action_board`");
    expect(dashboard).toContain("Evidence Library");
    expectText(dashboard, "Health Check, Recall Eval, Dogfood Notes, Governance Hub, Context Pack Review, and Audit Trail");
    expectText(dashboard, "visible summary is content-aware");
    expectText(dashboard, "when there are findings it reads `Reference material`");
    expectText(dashboard, "while the accessible summary keeps `Read-only reference material`");
    expectText(dashboard, "reads `Reference evidence only`");
    expectText(dashboard, "starts with a compact `Evidence index` bar for `Findings`, `Diagnostics`, and `Audit`");
    expectText(dashboard, "single wrapping rail");
    expectText(dashboard, "does not become another card grid or prose panel");
    expectText(dashboard, "When `Pending Decisions` is rendered, the visible HTML skips the `Evidence index` route bar");
    expectText(dashboard, "the Evidence Library still keeps `Reference Findings`, `Reference Evidence`, and the underlying `/api/dashboard` data");
    expectText(dashboard, "The route bar renders local buttons that reuse the existing `data-action-board-target` behavior");
    expectText(dashboard, "`Findings` opens `Reference Findings` when read-only notes exist and otherwise stays on `Evidence Library`");
    expectText(dashboard, "`Diagnostics` opens `Routine Diagnostics`, and `Audit` opens `Audit Trail`");
    expectText(dashboard, "route buttons keep only the route label and current status visible");
    expectText(dashboard, "longer route hints stay in accessible labels");
    expectText(dashboard, "The route bar is navigation copy only");
    expectText(dashboard, "does not render Approve, Reject, Promote, Archive, or Apply controls");
    expectText(dashboard, "routine read-only diagnostics such as a healthy Health Check, clean or unavailable Recall Eval, and ready or unavailable Context Pack Review are grouped under `Routine Diagnostics`");
    expectText(dashboard, "`Routine Diagnostics` opens with `Checks ready`");
    expectText(dashboard, "while the accessible summary keeps `Healthy checks and handoff readiness`");
    expectText(dashboard, "Expanding it shows lightweight Health Check, Recall Eval, and Context Pack Review summary rows first");
    expectText(dashboard, "the full reports stay in the nested `Full diagnostic details` section");
    expectText(dashboard, "grouped first under the stable `Reference Findings` route");
    expectText(dashboard, "visible row reads `Read-only Notes` with `Read-only notes`");
    expectText(dashboard, "`Read-only Notes` is collapsed by default inside `Evidence Library`");
    expectText(dashboard, "or expose child panel counts");
    expectText(dashboard, "read-only findings do not look like pending approval work");
    expectText(dashboard, "Routine Diagnostics and Audit Trail are grouped behind `Reference Evidence`");
    expectText(dashboard, "folded summary reads `Routine evidence`");
    expectText(dashboard, "while the accessible summary keeps `Routine checks and audit trail`");
    expectText(dashboard, "Expanding `Audit Trail` shows lightweight Audit Evidence, Store Snapshot, and Raw Store Reference rows first");
    expectText(dashboard, "the original evidence groups stay inside the nested `Full audit details` section");
    expectText(dashboard, "instead of listing reference-panel counts");
    expectText(dashboard, "Empty groups are omitted");
    expectText(dashboard, "Item-level detail remains available for inspection as collapsed candidate details inside each group");
    expectText(dashboard, "`Info Checks` detail opens with `Routine status checks`");
    expectText(dashboard, "instead of repeating the focus-strip count");
    expectText(dashboard, "When warning or critical action signals exist, the `needs-attention` scroll target renders as `Action Signals`");
    expectText(dashboard, "`Action Signals` opens with `Warnings and critical checks`");
    expectText(dashboard, "the section preserves `id=\"needs-attention\"` and `data-dashboard-detail=\"needs-attention\"`");
    expectText(dashboard, "When there are no warning or critical action signals");
    expectText(dashboard, "the same scroll target renders as a quiet `needs-attention-quiet-line` anchor");
    expectText(dashboard, "It contains only the collapsed `Info Checks` detail");
    expectText(dashboard, "does not render the focus strip or a separate quiet summary");
    expectText(dashboard, "When `Pending Decisions` is rendered and no warning or critical action signal exists, the visible HTML skips the quiet `Info Checks` anchor");
    expectText(dashboard, "`/api/dashboard.attention_items` still keeps the info checks for agents and audit tooling");
    expect(dashboard).toContain("Dogfood Notes");
    expect(dashboard).toContain("Issue brief");
    expectText(dashboard, "folded row reads `Read-only note` or `Read-only notes`");
    expectText(dashboard, "The status chip reads `Note` even when the underlying finding severity is warning");
    expectText(dashboard, "instead of repeating finding and safe-step counts");
    expectText(dashboard, "Each finding card keeps impact, evidence, and the safe command inside a `Note Details` fold");
    expectText(dashboard, "the visible card face only shows category, summary, and read-only status");
    expectText(dashboard, "It does not contain Capture Inbox approvals or Review Queue maintenance approvals");
    expectText(dashboard, "remain available inside the nested `Audit Trail` panel");
    expectText(dashboard, "folded row reads `Clean lifecycle and capture audits`");
    expectText(dashboard, "instead of listing the two clean child modules");
    expectText(dashboard, "`Memory Lifecycle` folded row reads `No lifecycle work`");
    expectText(dashboard, "instead of repeating `0 findings | 0 actions`");
    expectText(dashboard, "child suggestions fold reads `Lifecycle suggestions` instead of a generic `Suggested actions` row");
    expectText(dashboard, "`Capture Policy Audit` row follows the same rule");
    expectText(dashboard, "clean reports read `No capture policy work`");
    expectText(dashboard, "non-zero summaries omit empty buckets such as `0 captured`");
    expectText(dashboard, "the outer folded row reads `Policy Decision History`");
    expectText(dashboard, "while keeping the stable `capture-policy-audit` route");
    expectText(dashboard, "with `Routing evidence` while keeping the stable `capture-policy-audit` route");
    expectText(dashboard, "keeps `Read-only routing evidence` in the accessible summary");
    expectText(dashboard, "`Clean Audit Reports`, `Store Signals`, and `Recent Value` are grouped under `Audit Evidence`");
    expectText(dashboard, "the collapsed `Audit Trail` row reads `Optional trace data`");
    expectText(dashboard, "the Evidence index `Audit` route also reads `Optional trace data`");
    expectText(dashboard, "row reads `Clean audits and store signals`");
    expectText(dashboard, "instead of listing child panel counts");
    expectText(dashboard, "`Audit Evidence` is collapsed by default inside `Audit Trail`");
    expectText(dashboard, "`Store Signals` and `Recent Value` are nested under a collapsed `Store Snapshot` row");
    expectText(dashboard, "`Store Snapshot` row reads `Store context` instead of listing child module names");
    expectText(dashboard, "collapsed by default behind a short recent-record count");
    expectText(dashboard, "Newest-first ordering, full details, and trace commands stay inside the expanded panel");
    expectText(dashboard, "Recent Value card footers include short record-id context beside the readable source label");
    expectText(dashboard, "timeline and recall trace commands under a `Trace commands` fold whose visible summary reads `Audit commands`");
    expectText(dashboard, "while its accessible label keeps kind/type and short record-id context instead of a generic `Details` row");
    expectText(dashboard, "the raw inspector is grouped behind `Raw Store Reference`");
    expectText(dashboard, "`Raw Store Reference` opens with `Optional raw records`");
    expectText(dashboard, "`Raw Store Inspector` opens with `Optional raw inspection`");
    expectText(dashboard, "child folds are labeled `Record Index`, `Event Timeline`, and `Sync Snapshot`");
    expectText(dashboard, "`Record Index` and `Event Timeline` render only the first ten rows each and summarize overflow as `/api/dashboard` evidence");
    expectText(dashboard, "`Record Index` record rows use short record-id summaries and a `Details` hint");
    expectText(dashboard, "while the accessible label and table columns keep kind, type, source, and record-id context");
    expectText(dashboard, "still shows the concrete safe-check count");
    expectText(dashboard, "compact inspection rows with readable source labels, title, and read-only next step");
    expectText(dashboard, "`memory_doctor.findings_by_id.candidate_backlog` appears as a `Memory Doctor` safe inspection");
    expectText(dashboard, "does not add dashboard approval, archive, promote, apply, or background execution controls");
    expectText(dashboard, "`candidate_triage` groups active candidate records into `likely_noise`, `promotable`, `session_summaries`, and `needs_inspection`");
    expectText(dashboard, "`Candidate Triage` is grouped under `Reference Findings` in the Evidence Library");
    expectText(dashboard, "its folded row reads `Read-only candidate backlog` instead of repeating a candidate count");
    expectText(dashboard, "Expanding the panel shows candidate and group counts plus read-only next steps");
    expectText(dashboard, "shown-record counts stay in `/api/dashboard` and the nested `Record samples` summaries");
    expectText(dashboard, "Each candidate group keeps its next review surface behind a compact `Review path` fold");
    expectText(dashboard, "Folded `Review path` rows show only the next review label");
    expectText(dashboard, "the existing-control route stays in the accessible summary label and expanded fields");
    expectText(dashboard, "The expanded fold points to an existing control such as Capture Inbox, Memory Doctor, timeline, or recall");
    expectText(dashboard, "Candidate group description text stays behind a collapsed `Group context` row");
    expectText(dashboard, "expanded groups lead with review path, audit boundary, and samples instead of prose");
    expectText(dashboard, "Candidate group folded rows keep the visible next-step hint to `Review path ready`");
    expectText(dashboard, "the full recommended next step stays in the accessible group summary and the nested `Review path` fold");
    expectText(dashboard, "group write-boundary and evidence fields move behind a collapsed `Audit boundary` row whose folded");
    expectText(dashboard, "Record ids, recall commands, and timeline commands stay behind a nested `Record samples` fold inside each group");
    expectText(dashboard, "`Record samples` renders only the first three full records per group and summarizes the remaining records as API index evidence");
    expectText(dashboard, "`Record samples` folded rows show only the visible sample count as `trace ready`");
    expectText(dashboard, "the candidate group name and shown/total count stay in the accessible summary label");
    expectText(dashboard, "Sample rows use the short visible label `Sample`");
    expectText(dashboard, "their visible secondary text reads `Trace ready`");
    expectText(dashboard, "kind/source/time wording and record id stay in the accessible row label");
    expectText(dashboard, "Overflow rows read `More samples` with a short `hidden, indexed` count");
    expectText(dashboard, "the group-specific hidden-record count, API/Raw Store cue, and exact `candidate_triage.groups_by_id.<group_id>.records_by_id` path is kept behind a group-specific `API evidence path` fold");
    expectText(dashboard, "Full candidate text remains inside the expanded sample body only for visible samples");
    expectText(dashboard, "To avoid flooding");
    expectText(dashboard, "`candidate_triage.groups_by_id.<group_id>.records[]` keeps only the visible sample records");
    expectText(dashboard, "`candidate_triage.groups_by_id.<group_id>.record_ids[]`");
    expectText(dashboard, "`candidate_triage.groups_by_id.<group_id>.records_by_id.<record_id>` is a lightweight index");
    expectText(dashboard, "The top-level `candidate_triage.groups[]` list is summary-only");
    expectText(dashboard, "expanded group details, visible records, and record indexes live under `candidate_triage.groups_by_id.<group_id>`");
    expectText(dashboard, "`Candidate Triage` stays read-only and does not add Approve, Archive, Promote, Apply, or background execution controls");
    expectText(dashboard, "keep plain-language `Review notes` for detection, next step, write boundary, and evidence source");
    expectText(contracts, "`/api/dashboard` also returns `memory_doctor`, the same read-only report shape as `moryn memory doctor`");
    expectText(contracts, "`/api/dashboard` also returns `candidate_triage`, a read-only dashboard-derived grouping for active candidate records");
    expect(contracts).toContain("candidate_triage.groups_by_id.<group_id>");
    expect(contracts).toContain("memory_doctor.findings_by_id.candidate_backlog");
    expectText(contracts, "`memory_doctor` findings remain read-only dashboard governance inspections");
    expect(dashboard).toContain("Safe Action Registry");
    expect(dashboard).toContain("Capture Inbox");
    expectText(dashboard, "Capture Inbox group metadata such as Source, Project, Items, and Captured is folded behind `Review context`");
    expectText(dashboard, "Group cards and candidate detail rows start with a compact `Confirm preview` chip row");
    expectText(dashboard, "candidate count or review reason plus the append-only approve/reject boundary");
    expectText(dashboard, "Queue summary uses one guidance line: review groups first, open item details only when needed, and canonical memory still requires approval");
    expectText(dashboard, "Sync pending states skip the extra status line because the header badge, Overview or Health lane, Store Signals, and Sync shortcut already show the same pending state");
    expectText(dashboard, "Sync-only pending warnings do not open the `Action Signals` / Needs Attention review path");
    expectText(dashboard, "If sync is the only warning signal, the Sync shortcut owns `Inspect sync` and the Review shortcut stays quiet with `Open info checks`");
    expectText(dashboard, "When there are no warning or critical signals, the quiet review shortcut also reads `Open info checks` instead of `Review warnings`");
    expectText(dashboard, "The visible panel is a route summary grouped by owning confirmation surface");
    expectText(dashboard, "show how many explicit approvals are waiting there, keep the shared route chips");
    expectText(dashboard, "It does not repeat candidate group titles, maintenance plan titles, full safety notes");
    expectText(dashboard, "The JSON contract keeps those per-decision audit fields in `items[]`");
    expectText(dashboard, "The collapsed `Page Shortcuts` summary still stays count-free");
    expectText(dashboard, "the non-zero sync count remains visible on the expanded shortcut card and in `/api/dashboard.action_board`");
    expectText(dashboard, "zero-value `good` targets are grouped under `Quiet Shortcuts` while keeping the stable `action-board-quiet-targets` route");
    expectText(dashboard, "`Quiet Shortcuts` opens with `Background section links`");
    expectText(dashboard, "Non-zero or non-good items stay in the main Action Board grid");
    expectText(dashboard, "When `Pending Decisions` is already rendered, the visible HTML skips `Page Shortcuts` and the stable `data-dashboard-detail=\"action-board\"` route");
    expectText(dashboard, "`/api/dashboard.action_board` still keeps every shortcut item for agents and audit tooling");
    expectText(dashboard, "When `items[].hint` repeats the visible next-action label");
    expectText(dashboard, "instead of rendering duplicate footer text");
    expectText(dashboard, "The visible Evidence Library title is `Read-only Evidence`, while the stable route remains `data-dashboard-detail=\"evidence-library\"`");
    expectText(dashboard, "row reads `Reference checks`");
    expectText(dashboard, "instead of repeating a safe-check count");
    expectText(dashboard, "`Reference Checks` row whose summary reads `Read-only, no writes`");
    expectText(dashboard, "while keeping the stable `governance-safe-inspections` route");
    expectText(dashboard, "Safe inspection rows keep detection, next step, write boundary, and evidence source behind a `Review notes` fold");
    expectText(dashboard, "Safe inspection rows use short display titles while full report titles remain in `/api/dashboard` and source panels");
    expectText(dashboard, "The expanded Governance Hub heading reads `Read-only inspection index` instead of exposing `governance.summary` as visible UI copy");
    expectText(dashboard, "The JSON contract still keeps `governance.summary` for agents and audit tooling");
    expectText(dashboard, "renders a compact `Pending Decisions` panel");
    expectText(dashboard, "The visible panel is a route summary grouped by owning confirmation surface");
    expectText(dashboard, "keep the shared route chips `Append-only events`, `approval required`, and `Audit evidence`");
    expectText(dashboard, "It does not repeat candidate group titles, maintenance plan titles, full safety notes");
    expectText(dashboard, "The JSON contract keeps those per-decision audit fields in `items[]`");
    expectText(dashboard, "It counts human decision units, not raw approve/reject buttons");
    expectText(dashboard, "Actual writes remain inside Capture Inbox and Review Queue controls");
    expectText(dashboard, "After a dashboard approval or rejection succeeds, the browser renders a compact `Action receipt`");
    expectText(dashboard, "The receipt is restored after dashboard fragment refreshes");
    expectText(dashboard, "Outcome, Decision, Write boundary, Write targets, Decision context, Records, Events, Audit status, and Audit next");
    expectText(dashboard, "`Write boundary` reads `Append-only events`");
    expectText(dashboard, "`Audit status` reads `Traceable by timeline` when event ids are returned");
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
    expectText(dashboard, "default row keeps only the manual-review and no-auto-canonical boundary visible");
    expectText(dashboard, "candidate, auto-captured, and policy-archived counts stay in the accessible label and expanded audit detail");
    expect(dashboard).toContain("Context Pack Review");
    expect(dashboard).toContain("context_pack_review");
    expect(dashboard).toContain("handoff_pack.quality_gate");
    expect(dashboard).toContain("local_event_history");
    expectText(dashboard, "folded row reads `Ready handoff context`");
    expectText(dashboard, "instead of repeating the quality and evidence counts");
    expectText(dashboard, "instead of repeating the quality and evidence counts or readiness chips");
    expectText(dashboard, "Ready handoff context | no handoff evidence");
    expectText(dashboard, "Expanding it shows readiness chips");
    expectText(dashboard, "`Quality Checks` child row reads `All quality checks passed`");
    expectText(dashboard, "instead of repeating `passed | 0 review`");
    expectText(dashboard, "detailed check list still carries each check, source, and count");
    expectText(dashboard, "Quality check coverage, context evidence counts, and required capture-action visibility remain visible in expanded readiness chips");
    expectText(dashboard, "`Context Evidence` folded row reads `Handoff evidence available`");
    expectText(dashboard, "expanded readiness brief still shows concrete decision, thread, and risk counts");
    expect(dashboard).toContain("does not guess a project");
    expect(dashboard).toContain("does not render Approve, Apply, Promote, Archive, or Reject controls");
    expect(dashboard).toContain("moryn capture policy");
    expect(dashboard).toContain("capture_policy");
    expectText(dashboard, "folded summary uses plain routing labels such as");
    expect(dashboard).toContain("`captured`, `review`, and `archived`");
    expectText(dashboard, "read-only routing-only reports open with a compact `Routing brief`");
    expectText(dashboard, "keyed findings, suggested inspect actions, and decision cards stay inside `Policy Decision History`");
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
    expect(dashboard).toContain("short confirmation summary that reads `Approval required`");
    expectText(dashboard, "Counts remain in Pending Decisions, the expanded decision card, and `/api/dashboard.maintenance.plans`");
    expect(dashboard).toContain("compact `Confirm preview` chip row");
    expect(dashboard).toContain("proposed change, target, `plan_hash` gate, and private-record scope");
    expect(dashboard).toContain("without reading raw event language or an outcome table");
    expect(dashboard).toContain("The structured decision summary is folded behind `Decision summary`");
    expectText(dashboard, "The folded row uses the same dashboard fold styling as other panels and summarizes `Why, change, safety, action`");
    expect(dashboard).toContain("one expandable `Audit details` fold instead of several");
    expect(dashboard).toContain("A compact `Approval checklist` fold");
    expect(dashboard).toContain("Before approving");
    expect(dashboard).toContain("approval surface reads like a decision checklist instead of internal logs");
    expect(dashboard).toContain("Evidence, rollback, and raw plan details stay inside the same `Audit details`");
    expect(dashboard).toContain("The `Copy command` button lives inside");
    expect(dashboard).toContain("keeping the visible action bar focused on `Reject` and the explicit");
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
    expect(readme).toContain("npm run smoke:dogfood-demo");
    expect(readme).toContain("low-risk autocapture");
    expect(workflow).toContain("npm run smoke:dogfood-demo");
    expect(workflow).toContain("dashboard snapshot checks");
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
    const [readme, workflow, contracts, roadmap, dashboard] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8"),
      readFile("docs/dashboard.md", "utf8")
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
    expectText(contracts, "Capture review backlog uses the same review-required policy boundary as Capture Inbox and Health Check");
    expectText(dashboard, "Dogfood capture review backlog uses the same review-required policy boundary as Capture Inbox and Health Check");
    expectText(contracts, "Older autocapture review metadata is rechecked against the current autocapture policy before it creates active review work");
    expectText(contracts, "explicit durable decisions and preferences still require review");
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
    expect(readme).toContain("moryn health check --project . --host codex --sync-remote <remote> --limit 20");
    expect(contracts).toContain('"tool": "health_check"');
    expect(contracts).toContain("health_check.checks_by_id.<check_id>");
    expect(contracts).toContain("health_check.suggested_actions_by_id.<action_id>");
    expectText(contracts, "`moryn health check --host codex --sync-remote <remote>` keeps setup review read-only");
    expectText(contracts, "`health_check.setup_readiness` records the selected host adapter, dashboard command, install command, context pack command, capture command, and optional sync remote");
    expect(dashboard).toContain("Moryn Health Check");
    expect(dashboard).toContain("health_check");
    expectText(dashboard, "plain-language summary such as `Healthy local store` or `needs attention | 1 warning`");
    expectText(dashboard, "Zero-count buckets are omitted from the folded row");
    expectText(dashboard, "/api/dashboard.health_check.summary` still includes the complete warning and failing counts");
    expectText(dashboard, "`health_check.setup_readiness` summarizes the selected host adapter, dashboard command, install plan command, context pack command, capture command, and optional sync remote");
    expectText(dashboard, "Readiness suggestions such as `open_dashboard`, `review_install_plan`, and `run_context_pack` are safe-to-run inspection or startup commands");
    expectText(dashboard, "The folded Health Check brief shows only status plus safe and needs-input counts");
    expectText(dashboard, "concrete readiness commands stay inside the expanded `Readiness Actions` details, grouped under `Safe to run` and `Needs input`");
    expectText(dashboard, "Full check rows stay inside the nested `Check Details` fold");
    expectText(dashboard, "`Check Details` summarizes pass, info, warning, and failed counts before listing individual checks");
    expectText(dashboard, "Each readiness action row keeps the command inside its own nested `Command` fold");
    expectText(dashboard, "the expanded list reads as an action review surface before it reads as a CLI transcript");
    expectText(dashboard, "`capture_session` stays explicit because it needs the user-authored session summary");
    expectText(dashboard, "Capture Inbox backlog only counts candidates whose capture policy requires explicit review or user action");
    expectText(dashboard, "Older autocapture review metadata is rechecked against the current autocapture policy before it appears as active Capture Inbox, Health Check, or Dogfood review work");
    expectText(dashboard, "explicit durable decisions and preferences still require review");
    expectText(dashboard, "When there are no active Capture Inbox candidates, the main `Capture Inbox` panel is not rendered");
    expectText(dashboard, "auto-captured and policy-archived handoff evidence stays under the stable `capture-policy-audit` route inside the evidence path");
    expectText(dashboard, "the visible folded title reads `Policy Decision History` with `Routing evidence`");
    expectText(dashboard, "`MCP runtime freshness` is an informational check");
    expectText(dashboard, "restart the MCP host when MCP tool output disagrees with the CLI or dashboard after an upgrade, rebuild, or local link change");
    expectText(contracts, "The capture review backlog is scoped to candidates whose capture policy requires explicit review or user action");
    expectText(contracts, "Older autocapture review metadata is rechecked against the current autocapture policy before it becomes a Health Check warning");
    expectText(contracts, "`health_check.checks_by_id.mcp_runtime` is informational");
    expectText(workflow, "restart the MCP host when MCP tool output disagrees with the CLI or dashboard after upgrading, rebuilding, or linking a local checkout");
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
