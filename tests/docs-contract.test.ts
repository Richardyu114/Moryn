import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { errorCode, nextAction, recommendedAction } from "../src/core/errors.js";

describe("documentation contracts", () => {
  function expectText(document: string, text: string): void {
    expect(document.replace(/\s+/g, " ")).toContain(text);
  }

  it("keeps deployment-private addresses out of public docs", async () => {
    const docs = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-install-prompt.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/dashboard.md", "utf8")
    ]);
    const joinedDocs = docs.join("\n");

    expect(joinedDocs).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)(?!0\.0\.0\.0)\d{1,3}(?:\.\d{1,3}){3}\b/);
    expect(joinedDocs).not.toMatch(/git@github\.com:(?!yourname\b)(?!user\b)[^/]+\/[^`\s"]*-store\.git/);
  });

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
    expect(readme).toContain("deployment-specific dashboard URL");
    expect(readme).toContain("<dashboard-url>");
    expect(readme).toContain("127.0.0.1:8765` is the internal");
    expect(readme).toContain("docs/dashboard.md");
    expect(readme).toContain("[Dashboard](docs/dashboard.md)");
    expect(readme).toContain("--no-open");
    expect(readme).toContain("state/dashboard/index.html");
    expect(installPrompt).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(installPrompt).toContain("deployment-specific dashboard URL");
    expect(installPrompt).toContain("<dashboard-url>");
    expect(installPrompt).toContain("not the address to report to the human");
    expect(installPrompt).toContain("moryn dashboard --no-open");
    expect(installPrompt).toContain("[Dashboard](dashboard.md)");
    expect(workflow).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(workflow).toContain("deployment-specific dashboard URL");
    expect(workflow).toContain("<dashboard-url>");
    expectText(workflow, "not the address to give the human");
    expect(workflow).toContain("record quality");
    expect(workflow).toContain("open the static snapshot");
    expect(contracts).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(contracts).toContain("deployment-specific dashboard URL");
    expect(contracts).toContain("<dashboard-url>");
    expectText(contracts, "not the address to report to the human");
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
    expect(dashboard).toContain("deployment-specific URL");
    expect(dashboard).toContain("<dashboard-url>");
    expect(dashboard).toContain("canonical human-facing URL");
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
    expectText(dashboard, "The header keeps first-screen metadata quiet");
    expectText(dashboard, "it shows `Local memory` and a short");
    expectText(dashboard, "`Updated HH:MM UTC` timestamp");
    expectText(dashboard, "The full store path stays in the `store-path` title attribute");
    expectText(dashboard, "the full timestamp stays in the `time` element's `datetime` and title attributes");
    expectText(dashboard, "`/api/dashboard.store.path` plus `/api/dashboard.generated_at` remain the");
    expectText(dashboard, "machine-readable audit source");
    expectText(dashboard, "language toggle defaults to English and can switch the visible dashboard copy to Chinese");
    expectText(dashboard, "moryn.dashboard.language");
    expectText(dashboard, "language switch covers first-screen diagnostic labels inside");
    expectText(dashboard, "`Background checks` and compact `More details` from the source markup");
    expectText(dashboard, "plain labels such as `Saved details`, `Check details`, `Detail links`, and");
    expectText(dashboard, "`Routes and checks`");
    expectText(dashboard, "Older internal labels such as `Info Checks`, `Routine");
    expectText(dashboard, "status checks`, `Info Details`, `Raw records waiting for review`, and `Many");
    expectText(dashboard, "candidate records` should not appear as visible dashboard copy");
    expectText(dashboard, "Memory Search controls, query shortcut");
    expectText(dashboard, "chips, and result-count feedback also follow the language toggle");
    expectText(dashboard, "Clicking a Memory Search result-mix chip applies that status or event filter");
    expectText(dashboard, "while keeping the search local and read-only");
    expectText(dashboard, "Search results open the same read-only");
    expectText(dashboard, "detail pane with full text, source, status, and timeline/recall commands");
    expectText(dashboard, "Memory Search result type labels, event target labels, and memory-state metadata follow the language toggle");
    expectText(dashboard, "First-screen action labels, health badges, current-answer cards, and derived overview cards also follow the language toggle");
    expectText(dashboard, "Derived overview-card count and status snippets such as `saved items`, `safe check available`, and `Clean` also carry Chinese display text");
    expectText(dashboard, "Relative-time labels such as `2d ago` also carry Chinese display text");
    expectText(dashboard, "Source names, exact timestamps, event operation names, and record ids stay literal");
    expectText(dashboard, "saved memory text and event evidence stay in their original wording");
    expectText(dashboard, "The visible receipt labels, decision sentence, write-boundary summary, changed count, and trace status follow the dashboard language toggle");
    expectText(dashboard, "Record ids, event ids, decision context, and read-only trace commands");
    expectText(dashboard, "stay literal inside the collapsed `Trace details` fold");
    expectText(dashboard, "black high-contrast surface");
    expectText(dashboard, "visible status colors and chart cards before any evidence folds");
    expectText(dashboard, "soft glass surfaces, restrained glow, and stable grid");
    expectText(dashboard, "Status colors act as narrow");
    expectText(dashboard, "signals rather than full-card color washes");
    expectText(dashboard, "The first screen is arranged around three plain questions");
    expectText(dashboard, "Do I need to act? -> the `Current answers` action card plus a visible");
    expectText(dashboard, "visible `Needs your decision` panel only when approval is waiting");
    expectText(dashboard, "What is stored? -> the `Current answers` memory card, `At a glance` chart");
    expectText(dashboard, "`Find what Moryn saved`, and `What Moryn stores`");
    expectText(dashboard, "Is sync healthy? -> the `Current answers` shared-copy card, `This device`");
    expectText(dashboard, "and the sync rail");
    expectText(dashboard, "Those answer cards reuse the dashboard's local navigation");
    expectText(dashboard, "the action card opens the current next step");
    expectText(dashboard, "the memory card opens `Find what");
    expectText(dashboard, "Moryn saved`, and the sync card opens `Store Signals`");
    expectText(dashboard, "The memory card also shows a compact `Ready to use` / `Saved, not organized` / `Session notes` mix bar");
    expectText(dashboard, "so the first screen shows whether saved content is already long-term memory before the user opens search");
    expectText(dashboard, "A short `Why this is here`");
    expectText(dashboard, "only rows with confirm buttons can change long-term memory");
    expectText(dashboard, "a fixed-height status ticker repeats the");
    expectText(dashboard, "latest write, latest source, shared-copy state, and saved-for-later items");
    expectText(dashboard, "without");
    expectText(dashboard, "resizing the first screen");
    expectText(dashboard, "The `Current answers`, `Needs your decision`, `Saved for later`, `At a glance`, and");
    expectText(dashboard, "`Find what Moryn saved` rows are visible");
    expectText(dashboard, "above `More details` in the live non-private dashboard");
    expectText(dashboard, "It starts with a compact recent-activity summary for");
    expectText(dashboard, "visible writes, ready-to-use items, saved-but-not-organized items, and the most active source");
    expectText(dashboard, "then shows the memory-state chart, content mix, seven-day saved-content trend");
    expectText(dashboard, "shared-copy rail, and source activity bars");
    expectText(dashboard, "The summary numbers are also read-only shortcuts");
    expectText(dashboard, "`Recent");
    expectText(dashboard, "writes` opens all saved content");
    expectText(dashboard, "`Ready to use` filters to memory Moryn can use now");
    expectText(dashboard, "`Saved, not organized` filters to saved-but-not-final items");
    expectText(dashboard, "`Top source` opens saved");
    expectText(dashboard, "content search filtered to that source");
    expectText(dashboard, "`Needs your decision` routes users to the owning approval rows only when a real");
    expectText(dashboard, "If the state is only `Saved, not organized`, the visible saved-later panel");
    expectText(dashboard, "opens `Find what Moryn saved`, expands saved previews, and keeps search visible");
    expectText(dashboard, "Approve and reject buttons stay on the owning row beside the");
    expectText(dashboard, "clickable memory state meter, content-type bars, shared-copy state, and recent source activity");
    expectText(dashboard, "Clicking a memory state filters");
    expectText(dashboard, "`Find what Moryn saved` to the matching saved items");
    expectText(dashboard, "This saved-content area combines recent");
    expectText(dashboard, "a detail pane with full text, source, and status");
    expectText(dashboard, "defaults to the first visible item");
    expectText(dashboard, "Filtering updates the detail pane to the first matching visible");
    expectText(dashboard, "Visible `Find what Moryn saved` previews render in the live dashboard when private");
    expectText(dashboard, "visible preview chooses representative saved");
    expectText(dashboard, "items across states before filling the rest by recency");
    expectText(dashboard, "does not hide recently saved, long-term, temporary, or set-aside memory");
    expectText(dashboard, "Static snapshots and `--include-private` fragments");
    expectText(dashboard, "keep saved text out of the visible HTML");
    expectText(dashboard, "Collapsed sections are for audit evidence, raw trace details, and optional checks");
    expectText(dashboard, "should not be required to understand the current dashboard state");
    expectText(dashboard, "`Shared copy` is the user-facing name for Git sync state");
    expectText(dashboard, "The main action summary is labeled `Do I need to act?` in the visible UI");
    expectText(dashboard, "Ordinary saved content does not become a user decision");
    expectText(dashboard, "when the only state is `Saved, not organized`, `Session notes`, or");
    expectText(dashboard, "the headline stays `No action needed`");
    expectText(dashboard, "opens `Find what Moryn saved`");
    expectText(dashboard, "That click expands hidden saved previews and highlights the section");
    expectText(dashboard, "The memory-state chart is also a local navigation control");
    expectText(dashboard, "opens `Find what Moryn saved` and filters the visible previews by that state");
    expectText(dashboard, "The saved-content filter bar can switch back to `All`");
    expectText(dashboard, "Its search controls filter across recent records and events by keyword, memory state, and source");
    expectText(dashboard, "The search panel also shows a live result mix for `Ready to use`,");
    expectText(dashboard, "`Saved, not organized`, `Session notes`, `Kept for history`, and `Events`");
    expectText(dashboard, "those counts follow typed queries, shortcut chips, and source/status filters");
    expectText(dashboard, "Search shortcut chips write readable local queries into the same input");
    expectText(dashboard, "`source:Codex`, `state:remembered`, `state:to-organize`, `type:event`");
    expectText(dashboard, "and `recent:7d`; users can also type those query terms directly");
    expectText(dashboard, "The read-only detail pane opens with the first visible saved item");
    expectText(dashboard, "follows the first matching item after filtering");
    expectText(dashboard, "the detail pane repeats the plain-language `Why saved`");
    expectText(dashboard, "`Next step` guidance from the card");
    expectText(dashboard, "client-side and read-only");
    expectText(dashboard, "The preview cards are representative rather than strictly newest-first");
    expectText(dashboard, "shows available `Saved, not organized`, `Ready to use`, `Session notes`, and");
    expectText(dashboard, "`Kept for history` examples before filling the remaining preview slots by recency");
    expectText(dashboard, "The full");
    expectText(dashboard, "newest-first list remains in `/api/dashboard.recent_value[]`");
    expectText(dashboard, "Each saved-content card now carries three read-only explanation cards");
    expectText(dashboard, "why it was saved, current status, and next step");
    expectText(dashboard, "The why-saved");
    expectText(dashboard, "line uses the stored provenance reason when available");
    expectText(dashboard, "Next-step values remain `Ready to use`, `Can be");
    expectText(dashboard, "organized`, `Keep for context`, or `Kept for history`");
    expectText(dashboard, "exposes only `Open details`");
    expectText(dashboard, "remember,");
    expectText(dashboard, "dismiss, archive, or approval writes appear only beside the real confirmation");
    expectText(dashboard, "rows that already have server endpoints");
    expectText(dashboard, "Candidate Triage stays a technical/audit route unless it has an explicit promotion approval");
    expectText(dashboard, "`All clear` now means there are no confirmations, visible warnings, sync tasks, or saved items waiting for later organization");
    expectText(dashboard, "Directly below the action summary, `What Moryn stores` shows the user-facing memory inventory");
    expectText(dashboard, "ready to use <- canonical records");
    expectText(dashboard, "saved, not organized <- candidate records");
    expectText(dashboard, "Each inventory state card is clickable");
    expectText(dashboard, "applies the matching read-only filter");
    expectText(dashboard, "session notes <- raw records");
    expectText(dashboard, "kept for history <- archived or quarantined records");
    expectText(dashboard, "`Saved, not organized` means the item is already saved and searchable");
    expectText(dashboard, "it is not a user decision by itself");
    expectText(dashboard, "`Recent status` shows the last write time, latest source, shared-copy state, and the number of `saved for later` items");
    expectText(dashboard, "Its last-write relative time follows the language toggle");
    expectText(dashboard, "exact timestamp stays in the `time` title and `datetime` attributes");
    expectText(dashboard, "healthy snapshots render as a lightweight `dashboard-status-line`");
    expectText(dashboard, "unless the first-screen action summary already owns the zero-state");
    expectText(dashboard, "Non-healthy states that need a separate explanation, such as local-only, review, or conflict, still render the full status strip");
    expectText(dashboard, "When a high-priority action owns the first screen, the four derived cards for current health, next action, context, and sync");
    expectText(dashboard, "All-clear and saved-for-later pages skip duplicate shortcut grids, work lanes, and safety chips on the first screen");
    expectText(dashboard, "compact `More details` fold");
    expectText(dashboard, "`/api/dashboard.attention_items` remains the audit source for routine checks");
    expectText(dashboard, "`/api/dashboard.action_board` remains the audit source for the complete shortcut list");
    expectText(dashboard, "visible background-check labels and item descriptions carry English and Chinese display text");
    expectText(dashboard, "does not expose raw status templates such as routine-check counts, temporary-note counts, or candidate-record cleanup wording");
    expectText(dashboard, "Each background overview card is also a local navigation button");
    expectText(dashboard, "its visible label is `Other status` with `Ready if needed`");
    expectText(dashboard, "When `Pending Decisions` is rendered, the visible HTML skips the `Other status` group and the stable `dashboard-overview-quiet-cards` route");
    expectText(dashboard, "the overview cards remain in `/api/dashboard.dashboard_overview.cards` and `cards_by_id` for audit tooling");
    expectText(dashboard, "If sync is also pending, Pending Decisions still owns the Overview headline and primary action");
    expectText(dashboard, "sync remains visible through the health badge, Store Signals, and `/api/dashboard.dashboard_overview.cards`");
    expectText(dashboard, "When sync is the active warning, the sync details promote into a compact current-task section");
    expectText(dashboard, "`data-dashboard-promoted-store-signals`");
    expectText(dashboard, "a `Sync Action` brief, and a quiet `Sync action ready` label");
    expectText(dashboard, "visible first-screen copy refers to the remote as the `Shared copy`");
    expectText(dashboard, "Store Signals keeps `Sync Action` in the foreground, moves `Sync Position` behind a collapsed `Sync details` fold");
    expectText(dashboard, "leaves Agent Activity, Record Quality, Record Types, and Activity Trend in `/api/dashboard.charts`");
    expectText(dashboard, "When sync is the only active warning and no explicit approval is waiting");
    expectText(dashboard, "the promoted `Store Signals` section moves directly after the Overview");
    expectText(dashboard, "skips the extra open `details` wrapper");
    expectText(dashboard, "so the current task is not repeated by another visible heading, navigation row, or routine reference panel");
    expectText(dashboard, "The promoted section omits `Telemetry Context`");
    expectText(dashboard, "The Reference Library still keeps the Audit route and raw evidence, but it does not render a second `store-signals` panel");
    expectText(dashboard, "the read-only evidence layer renders as a compact `More details` strip");
    expectText(dashboard, "`data-dashboard-background-reference`");
    expectText(dashboard, "keeping the stable `data-dashboard-detail=\"evidence-library\"` route");
    expectText(dashboard, "uses the quiet `Extra context` label");
    expectText(dashboard, "Candidate Triage without promotion drafts stays under the background Audit route instead of `Review Notes`");
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
    expectText(dashboard, "fold non-blocking routes under `Other paths`");
    expectText(dashboard, "a Health warning keeps `Health` visible while `Decide`, `Context`, and `Evidence` stay available as quiet background lanes");
    expectText(dashboard, "In all-clear states, the visible HTML skips `Dashboard Work Lanes` and");
    expectText(dashboard, "`Other paths` entirely");
    expectText(dashboard, "the first screen moves from Overview directly to the compact `More details` fold");
    expectText(dashboard, "The same Decide, Context, Health, Evidence, and safe inspection routes remain available");
    expectText(dashboard, "the stable `data-dashboard-detail=\"evidence-library\"` route, and");
    expectText(dashboard, "`/api/dashboard.action_board` for agents and audit");
    expectText(dashboard, "When `Pending Decisions` is rendered, Work Lanes keep the active decision lane visible and skip `Other paths` and `dashboard-work-lanes-background` in the HTML");
    expectText(dashboard, "the same routes remain available through `/api/dashboard.action_board`, `Page Shortcuts`, and the underlying panels");
    expectText(dashboard, "`Action Board` is rendered as `Page Shortcuts` in the UI while keeping the stable `data-dashboard-detail=\"action-board\"` route when two or more active shortcut cards need navigation");
    expectText(dashboard, "shortcut cards need navigation below explicit review and action surfaces");
    expectText(dashboard, "`Page Shortcuts` opens with `Optional section links`");
    expectText(dashboard, "The collapsed `Page Shortcuts` summary does not repeat active counts");
    expectText(dashboard, "Counts remain in the expanded shortcut cards and `/api/dashboard.action_board`");
    expectText(dashboard, "Review Queue plan cards open with an `Approval brief`");
    expectText(dashboard, "`Change`, `Scope`, `Guard`, and `Writes`");
    expectText(dashboard, "The brief says the server rechecks the plan hash before writing");
    expectText(dashboard, "raw `plan_hash`, equivalent CLI command, rollback path, and record ids stay inside `Decision details`");
    expect(dashboard).toContain("Evidence Library");
    expectText(dashboard, "Health Check, Recall Eval, Dogfood Notes, Governance Hub, Context Pack Review, and Audit Trail");
    expectText(dashboard, "visible summary is content-aware");
    expectText(dashboard, "when there are findings it reads `Reference material`");
    expectText(dashboard, "while the accessible summary keeps `Read-only reference material`");
    expectText(dashboard, "reads `Reference evidence only`");
    expectText(dashboard, "When the first screen is quiet, sync-only, or saved-for-later, the same read-only material uses the lighter `More details` shell");
    expectText(dashboard, "Expanding it reveals a `Saved details` face with `Read-only details available` and `Optional context`");
    expectText(dashboard, "Compact route chips move into the collapsed `Detail links` fold");
    expectText(dashboard, "human labels such as `Product notes`, `Saved notes`, and `History`");
    expectText(dashboard, "stable `data-reference-library-route` attributes still keep");
    expectText(dashboard, "The long `/api/dashboard` pointer is shortened inside that fold in compact mode");
    expectText(dashboard, "`Full evidence stays in /api/dashboard.`");
    expectText(dashboard, "does not render prose about every API evidence family");
    expectText(dashboard, "The compact rows also use quiet summaries such as `Saved notes indexed`");
    expectText(dashboard, "`Safety checks indexed`, `Product notes indexed`, `Cleanup checks indexed`");
    expectText(dashboard, "`Shared copy indexed`, and `History indexed`");
    expectText(dashboard, "review-focus text, or raw-store language");
    expectText(dashboard, "Those counts and focus hints remain in `/api/dashboard`");
    expectText(dashboard, "Compact row evidence chips use");
    expectText(dashboard, "`Health check`, `Saved notes`,");
    expectText(dashboard, "`Product notes`, and `Recent records`");
    expectText(dashboard, "`data-dashboard-detail` attributes keep the");
    expectText(dashboard, "When review-oriented findings exist, the expanded library can still start with a compact `Evidence index` bar");
    expectText(dashboard, "empty routes are omitted instead of rendering \"nothing here\" buttons");
    expectText(dashboard, "single wrapping rail");
    expectText(dashboard, "does not become another card grid or prose panel");
    expectText(dashboard, "When `Pending Decisions` is rendered, the visible summary reads");
    expectText(dashboard, "`Audit evidence only`");
    expectText(dashboard, "the visible HTML skips the `Evidence index` route bar");
    expectText(dashboard, "the accessible summary still names `Read-only reference material`");
    expectText(dashboard, "the Evidence Library still keeps any necessary `Review Notes`, background reference groups, and the underlying `/api/dashboard` data");
    expectText(dashboard, "The route bar renders local buttons that reuse the existing `data-action-board-target` behavior");
    expectText(dashboard, "`Findings` opens `Review Notes`");
    expectText(dashboard, "`Diagnostics` opens `Routine Diagnostics`, and `Audit` opens `Audit Trail`");
    expectText(dashboard, "route buttons keep only the route label and current status visible");
    expectText(dashboard, "longer route hints stay in accessible labels");
    expectText(dashboard, "The route bar is navigation copy only");
    expectText(dashboard, "does not render Approve, Reject, Promote, Archive, or Apply controls");
    expectText(dashboard, "the collapsed `Reference routes` fold contains routine read-only diagnostics");
    expectText(dashboard, "as a `Diagnostics Index` row in the normal shell, or `Diagnostics`");
    expectText(dashboard, "inside compact `More details`");
    expectText(dashboard, "uses the stable visible summary `Routine checks indexed` instead of listing each diagnostic module name");
    expectText(dashboard, "stable `data-dashboard-detail` chips for `health-check`,");
    expectText(dashboard, "those chips carry accessible summaries");
    expectText(dashboard, "It does not render the nested `Diagnostic Reports` section");
    expectText(dashboard, "full details remain in `/api/dashboard.health_check`, `/api/dashboard.recall_eval`, and `/api/dashboard.context_pack_review`");
    expectText(dashboard, "Governance Hub items that require user confirmation");
    expectText(dashboard, "grouped first under the stable `Review Notes` group");
    expectText(dashboard, "visible row reads `Review Notes` with `Reference notes`");
    expectText(dashboard, "`Review Notes` is collapsed by default inside `Evidence Library`");
    expectText(dashboard, "or expose child panel counts");
    expectText(dashboard, "read-only findings do not look like pending approval work");
    expectText(dashboard, "When review-oriented panels force the grouped evidence layout, Routine Diagnostics and Audit Trail can still appear behind `Routine Reference`");
    expectText(dashboard, "the same audit material appears as `Audit Reports`, `Store Snapshot`, and `Raw Store` rows in the normal");
    expectText(dashboard, "inside compact `More details`, the same stable rows are labeled `Cleanup Checks`, `Shared Copy`, and `History`");
    expectText(dashboard, "stable `data-dashboard-detail` targets such as `supporting-evidence`,");
    expectText(dashboard, "Empty audit report rows are omitted");
    expectText(dashboard, "Item-level detail remains available for inspection as collapsed candidate details inside each group");
    expectText(dashboard, "`Background checks` detail opens with `Routine checks`");
    expectText(dashboard, "instead of repeating the focus-strip count");
    expectText(dashboard, "When warning or critical action signals exist, the `needs-attention` scroll target renders as `Action Signals`");
    expectText(dashboard, "`Action Signals` opens with `Warnings and critical checks`");
    expectText(dashboard, "the section preserves `id=\"needs-attention\"` and `data-dashboard-detail=\"needs-attention\"`");
    expectText(dashboard, "When there are no warning or critical action signals but the Overview is not all-clear");
    expectText(dashboard, "the same scroll target renders as a quiet `needs-attention-quiet-line` anchor");
    expectText(dashboard, "It contains only the collapsed `Background checks` detail");
    expectText(dashboard, "Quiet `Background checks` opens first to a nested `Check details` fold");
    expectText(dashboard, "the individual informational rows stay inside that nested fold");
    expectText(dashboard, "does not render the focus strip or a separate quiet summary");
    expectText(dashboard, "When `Pending Decisions` is rendered, when all-clear Overview already owns the quiet zero-state");
    expectText(dashboard, "or when active sync work such as `sync_pending` or `conflict` already owns the Overview and Health lane");
    expectText(dashboard, "the visible HTML skips the quiet `Background checks` anchor entirely");
    expectText(dashboard, "`/api/dashboard.attention_items` still keeps the info checks and sync signals for agents and audit tooling");
    expect(dashboard).toContain("Dogfood Notes");
    expectText(dashboard, "it lives in the background Audit route instead of `Review Notes` because it has no approval or write action");
    expectText(dashboard, "folded row reads `Read-only note` or `Read-only notes`");
    expectText(dashboard, "The status chip reads `Note` even when the underlying finding severity is warning");
    expectText(dashboard, "instead of repeating finding and safe-step counts");
    expectText(dashboard, "Expanding Dogfood Notes renders a single `Dogfood Notes Index` card");
    expectText(dashboard, "The dashboard HTML does not render per-finding cards, `data-dogfood-review-item` rows, `Note Details`, impact briefs, evidence paths, affected record ids, or safe timeline commands there");
    expectText(dashboard, "Full impact notes, affected records, evidence, and safe dashboard or timeline commands remain in");
    expectText(dashboard, "`/api/dashboard.dogfood_report.findings_by_id` and");
    expectText(dashboard, "`/api/dashboard.dogfood_report.suggested_actions_by_id`");
    expectText(dashboard, "It does not contain Capture Inbox approvals or Review Queue maintenance approvals");
    expectText(dashboard, "The visible HTML keeps a stable `memory_lifecycle` chip with `data-dashboard-detail=\"memory-lifecycle-audit\"`");
    expectText(dashboard, "the active `default_memory_lifecycle_policy`, record assessments, findings, suggested actions, and safe timeline/recall commands remain in");
    expectText(dashboard, "`/api/dashboard.memory_lifecycle`");
    expectText(dashboard, "The visible HTML keeps a stable `capture_policy` chip with `data-dashboard-detail=\"capture-policy-audit\"`");
    expectText(dashboard, "keyed findings, decisions, rule ids, evidence paths, suggested inspect actions, and timeline commands remain in");
    expectText(dashboard, "`/api/dashboard.capture_policy`");
    expectText(dashboard, "Audit reports, raw records, events, sync details, recent value, and store telemetry remain available through `/api/dashboard`");
    expectText(dashboard, "The collapsed `Audit Trail` row reads `Optional trace data`");
    expectText(dashboard, "the Evidence index `Audit` route also reads `Optional trace data`");
    expectText(dashboard, "`Audit Reports`, whose visible summary is `Lifecycle checks indexed`, with");
    expectText(dashboard, "route `supporting-operational-evidence` and chips for");
    expectText(dashboard, "`memory_lifecycle` and `capture_policy`");
    expectText(dashboard, "`Store Snapshot`, whose visible summary is `Store signals indexed`, with");
    expectText(dashboard, "route `supporting-operational-snapshots` and chips for");
    expectText(dashboard, "`sync` and `recent_value`");
    expectText(dashboard, "`Raw Store`, whose visible summary is `Raw evidence indexed`, with route");
    expectText(dashboard, "`debug-inspector` and chips for");
    expectText(dashboard, "`recent_records`, `recent_events`, and `sync`");
    expectText(dashboard, "The dashboard HTML does not render nested `Audit Reports`, `Audit Evidence`");
    expectText(dashboard, "`Store Signals`, `Recent Value`, `Raw Store Reference`, `Raw Store Inspector`");
    expectText(dashboard, "inside Audit Trail");
    expectText(dashboard, "The stable `memory-lifecycle-audit`, `capture-policy-audit`, `store-signals`");
    expectText(dashboard, "`recent-value`, `debug-inspector`, and `inspector:*` routes remain as index-chip targets");
    expectText(dashboard, "The HTML dashboard represents `Recent Value` with the `recent_value` chip inside");
    expectText(dashboard, "Audit Trail's `Store Snapshot` row");
    expectText(dashboard, "Newest-first ordering, full details, record ids, and trace commands stay in the `/api/dashboard.recent_value[]` payload");
    expectText(dashboard, "The HTML does not inline Recent Value summaries, record ids, or per-card trace commands");
    expectText(dashboard, "timeline and recall commands stay in `/api/dashboard.recent_value[].citation`");
    expectText(dashboard, "Expanding that safe-only hub renders a single `Governance Index` card");
    expectText(dashboard, "It does not render `Reference Checks`, `governance-safe-inspections`, per-inspection rows, or `Reference audit` in the visible safe-only HTML");
    expectText(dashboard, "`memory_doctor.findings_by_id.candidate_backlog` appears as a `Memory Doctor` safe inspection");
    expectText(dashboard, "does not add dashboard approval, archive, promote, apply, or background execution controls");
    expectText(dashboard, "`candidate_triage` groups active candidate records into `likely_noise`, `promotable`, `session_summaries`, and `needs_inspection`");
    expectText(dashboard, "Candidate Triage without promotion drafts stays under the background Audit route instead of `Review Notes`");
    expectText(dashboard, "If promotion drafts are waiting, `Candidate Triage` is grouped under `Review Notes`");
    expectText(dashboard, "folded row reads `Read-only backlog`");
    expectText(dashboard, "Candidate group folded rows without promotion drafts use purpose labels instead of `Archive review`, `Handoff review`, or `Inspection review`");
    expectText(dashboard, "Read-only backlog group faces use purpose labels such as `Likely noise`, `Handoff evidence`, and `Needs inspection` with short next-step hints");
    expectText(dashboard, "The specific review handoff label remains inside the nested `Review path` fold");
    expectText(dashboard, "If promotion drafts are waiting, `Candidate Triage` is grouped under `Review Notes`, the folded row shows the draft count");
    expectText(dashboard, "those approvals also appear in `Pending Decisions` as a `Candidate Triage` route");
    expectText(dashboard, "Expanding a read-only `Candidate Backlog` panel shows a compact `Candidate Backlog Index` reference");
    expectText(dashboard, "mapped to `/api/dashboard.candidate_triage`");
    expectText(dashboard, "plus one visible `review_focus` line softened for the read-only UI");
    expectText(dashboard, "`Audit focus: Likely noise - Inspect likely noise before archive`");
    expectText(dashboard, "That focus is read-only routing guidance, not a write action");
    expectText(dashboard, "the raw `Start with ...` summary");
    expectText(dashboard, "`/api/dashboard.candidate_triage.review_focus`");
    expectText(dashboard, "The dashboard HTML does not render read-only candidate group cards");
    expectText(dashboard, "per-group `candidate-triage:<group_id>` routes");
    expectText(dashboard, "record counts per group, sample rows, hidden-record folds, evidence paths, or trace commands");
    expectText(dashboard, "Full candidate bodies, record order, evidence paths, recall commands, and timeline commands stay in `/api/dashboard.candidate_triage`");
    expectText(dashboard, "When the existing Review Queue has a `candidate_noise_archive` cleanup plan");
    expectText(dashboard, "the read-only `Candidate Backlog` panel still stays an index reference instead of showing a cleanup navigation button");
    expectText(dashboard, "Archive still happens only through the explicit Review Queue `Archive Noise` approval with the normal `plan_hash` guard");
    expectText(dashboard, "Expanding a promotion-ready `Candidate Triage` panel still shows candidate and group counts plus review-first next steps");
    expectText(dashboard, "shown-record counts stay in `/api/dashboard` and the nested `Record samples` summaries");
    expectText(dashboard, "Each candidate group keeps its next review surface behind a compact `Review path` fold");
    expectText(dashboard, "Folded `Review path` rows show only the next review label");
    expectText(dashboard, "the existing-control route stays in the accessible summary label and expanded fields");
    expectText(dashboard, "The expanded fold points to an existing control such as Capture Inbox, Memory Doctor, timeline, or recall");
    expectText(dashboard, "states that review comes first and approval only happens through draft rows");
    expectText(dashboard, "Candidate group description text stays behind a collapsed `Group context` row nested inside `Audit notes`");
    expectText(dashboard, "expanded groups lead with review path, audit notes, promotion drafts when present, and samples instead of prose");
    expectText(dashboard, "the full recommended next step and record count stay in the accessible group summary, `Audit notes`, `Group context`, and the nested `Review path` fold");
    expectText(dashboard, "Candidate group internals sit behind a `Triage details` fold");
    expectText(dashboard, "the group face does not expose context, review path, audit boundary, or samples by default");
    expectText(dashboard, "`Audit notes` groups the collapsed `Group context` and `Audit boundary` rows");
    expectText(dashboard, "group write-boundary and evidence fields stay behind the nested `Audit boundary` row whose folded");
    expectText(dashboard, "Promotable groups may include a collapsed `Promotion draft` row");
    expectText(dashboard, "Draft rows open with the same `Approval brief` pattern used by Capture Inbox and Review Queue");
    expectText(dashboard, "`Change`, `Scope`, `Guard`, and `Writes`");
    expectText(dashboard, "exact `moryn promote ... --confirm` command");
    expectText(dashboard, "`candidate_triage.groups_by_id.promotable.promotion_drafts_by_id.<record_id>` source path");
    expectText(dashboard, "source path stay behind a nested `Draft evidence` fold");
    expectText(dashboard, "The only Candidate Triage write control is the draft-row `Approve Memory` action, and pending draft approvals are routed through `Pending Decisions`");
    expectText(dashboard, "server re-checks that the record is still an active promotable candidate before appending the confirmed promotion event");
    expectText(dashboard, "stale draft approvals return `not_actionable`");
    expectText(dashboard, "Record ids, recall commands, and timeline commands stay behind a nested `Record samples` fold inside each group");
    expectText(dashboard, "`Record samples` renders only the first three full records per group and summarizes the remaining records as API index evidence");
    expectText(dashboard, "`Record samples` folded rows show only the visible sample count as `trace ready`");
    expectText(dashboard, "the candidate group name and shown/total count stay in the accessible summary label");
    expectText(dashboard, "Sample rows use the short visible label `Sample`");
    expectText(dashboard, "their visible secondary text reads `Trace ready`");
    expectText(dashboard, "kind/source/time wording and record id stay in the accessible row label");
    expectText(dashboard, "Overflow rows read `More samples` with a short `hidden, indexed` count");
    expectText(dashboard, "their visible count says only how many more records are indexed");
    expectText(dashboard, "The group-specific hidden-record count, record-index cue, and exact `candidate_triage.groups_by_id.<group_id>.records_by_id` path stay behind a group-specific `Hidden record index` fold");
    expectText(dashboard, "expanded guidance tells reviewers to open that index instead of naming API/Raw Store on the row face");
    expectText(dashboard, "Visible sample bodies label candidate text as `Content`");
    expectText(dashboard, "full candidate text remains inside the expanded sample body only for visible samples");
    expectText(dashboard, "To avoid flooding");
    expectText(dashboard, "`candidate_triage.groups_by_id.<group_id>.records[]` keeps only the visible sample records");
    expectText(dashboard, "`candidate_triage.groups_by_id.<group_id>.record_ids[]`");
    expectText(dashboard, "`candidate_triage.groups_by_id.<group_id>.records_by_id.<record_id>` is a lightweight index");
    expectText(dashboard, "The top-level `candidate_triage.groups[]` list is summary-only");
    expectText(dashboard, "expanded group details, visible records, and record indexes live under `candidate_triage.groups_by_id.<group_id>`");
    expectText(dashboard, "`Candidate Triage` keeps group review read-only and does not add Archive, Promote Selected, Apply, or background execution controls");
    expectText(dashboard, "the only write control is the explicit draft-row `Approve Memory` path described above");
    expectText(dashboard, "keep plain-language `Review notes` for detection, next step, write boundary, and evidence source");
    expectText(contracts, "`/api/dashboard` also returns `memory_doctor`, the same read-only report shape as `moryn memory doctor`");
    expectText(contracts, "`/api/dashboard` also returns `candidate_triage`, a read-only dashboard-derived grouping for active candidate records");
    expectText(contracts, "`candidate_triage.review_focus` points to the first group the dashboard recommends inspecting");
    expectText(contracts, "The field is read-only guidance for humans and agents");
    expect(contracts).toContain("candidate_triage.groups_by_id.<group_id>");
    expectText(contracts, "Candidate Triage promotion draft approvals");
    expectText(contracts, "decision_summary.summary.candidate_triage_promotions");
    expectText(contracts, "routes through the dashboard `Pending Decisions` panel");
    expect(contracts).toContain("memory_doctor.findings_by_id.candidate_backlog");
    expectText(contracts, "`memory_doctor` findings remain read-only dashboard governance inspections");
    expect(dashboard).toContain("Safe Action Registry");
    expect(dashboard).toContain("Capture Inbox");
    expectText(dashboard, "Capture Inbox group metadata such as Source, Project, Items, and Captured is folded behind `Review context`");
    expectText(dashboard, "The `Capture Inbox` heading uses the stable `Manual approval` status instead of repeating candidate and group counts");
    expectText(dashboard, "Counts stay in `Queue summary`, Pending Decisions, and `/api/dashboard.capture_inbox`");
    expectText(dashboard, "Group card faces use `Review N captures` plus `Approve or reject this group.` instead of rendering capture text on the first row");
    expectText(dashboard, "a compact `Review signal` strip with human labels such as `Smoke/test marker` and `Duplicate capture text`");
    expectText(dashboard, "does not add an automatic merge, archive, approve, or background execution path");
    expectText(dashboard, "Group id, record ids, rules, and noise evidence stay behind a `Trace details` fold inside `Item review`");
    expectText(dashboard, "`Item review` opens to the trace details and collapsed candidate rows instead of raw group internals");
    expectText(dashboard, "Group cards and candidate detail rows start with a compact `Approval brief`");
    expectText(dashboard, "using the same `Change`, `Scope`, `Guard`, and `Writes` rows as Review Queue");
    expectText(dashboard, "server rechecks active candidate records before writing");
    expectText(dashboard, "append-only approve/reject boundary visible before trace details");
    expectText(dashboard, "Queue summary uses one guidance line: review groups first, open item details only when needed, and canonical memory still requires approval");
    expectText(dashboard, "visible first-screen copy refers to the remote as the `Shared copy`");
    expectText(dashboard, "Sync-only pending warnings do not open the `Action Signals` / Needs Attention review path");
    expectText(dashboard, "When sync is the only active warning, Work Lanes are skipped in the visible HTML so the Overview action lands directly on the promoted Store Signals current-task section");
    expectText(dashboard, "The same sync route remains in `/api/dashboard.action_board.items_by_id.sync`");
    expectText(dashboard, "If sync is the only warning signal, the Sync shortcut owns `Inspect sync` and the Review shortcut stays quiet with `Open info checks`");
    expectText(dashboard, "When there are no warning or critical signals, the quiet review shortcut also reads `Open info checks` instead of `Review warnings`");
    expectText(dashboard, "The visible panel is a route summary grouped by owning confirmation surface");
    expectText(dashboard, "show how many explicit approvals are waiting there, provide one navigation button");
    expectText(dashboard, "`Append-only, guarded in owning surface`");
    expectText(dashboard, "It does not repeat candidate group titles, maintenance plan titles, next action labels");
    expectText(dashboard, "write labels, active guard labels, full safety notes");
    expectText(dashboard, "The JSON contract keeps those per-decision audit fields in `items[]`");
    expectText(dashboard, "The collapsed `Page Shortcuts` summary still stays count-free");
    expectText(dashboard, "the non-zero sync count remains visible on the expanded shortcut card and in `/api/dashboard.action_board`");
    expectText(dashboard, "When exactly one active shortcut exists, such as sync-only pending work, the visible HTML skips `Page Shortcuts` and `data-action-board-nav`");
    expectText(dashboard, "`/api/dashboard.action_board` still keeps the complete shortcut list for agents and audit tooling");
    expectText(dashboard, "All-clear Overview states skip the visible `Background Shortcuts` strip and `data-dashboard-background-shortcuts` route entirely");
    expectText(dashboard, "the first screen moves from `Other paths` to compact `More details` without another generic navigation fold");
    expectText(dashboard, "`/api/dashboard.action_board` still keeps the complete shortcut list, including zero-state Review, Inspect, Confirm, and Sync entries");
    expectText(dashboard, "When no active shortcut exists outside all-clear mode, read-only shortcut targets render under a single compact `Background Shortcuts` strip");
    expectText(dashboard, "`data-dashboard-background-shortcuts`");
    expectText(dashboard, "while keeping the stable `data-dashboard-detail=\"action-board\"` route");
    expectText(dashboard, "Its list carries the `action-board-quiet-targets` route directly");
    expectText(dashboard, "without a nested `Page Shortcuts` -> `Quiet Shortcuts` directory");
    expectText(dashboard, "non-zero or non-good items stay in the main Action Board grid");
    expectText(dashboard, "When any active shortcut is visible in `Page Shortcuts`, the HTML skips `Quiet Shortcuts` and `action-board-quiet-targets` entirely");
    expectText(dashboard, "The same quiet shortcut items remain in `/api/dashboard.action_board.items` and `items_by_id`");
    expectText(dashboard, "When `Pending Decisions` is already rendered, the visible HTML skips `Page Shortcuts` and the stable `data-dashboard-detail=\"action-board\"` route");
    expectText(dashboard, "`/api/dashboard.action_board` still keeps every shortcut item for agents and audit tooling");
    expectText(dashboard, "When `items[].hint` repeats the visible next-action label");
    expectText(dashboard, "instead of rendering duplicate footer text");
    expectText(dashboard, "Read-only diagnostic detail lives in the collapsed evidence layer");
    expectText(dashboard, "The visible full title is still `Reference Library`, while the stable route remains `data-dashboard-detail=\"evidence-library\"`");
    expectText(dashboard, "row reads `Reference checks`");
    expectText(dashboard, "When it only contains safe read-only inspections, Governance Hub moves to the background Audit route");
    expectText(dashboard, "instead of repeating a safe-check count");
    expectText(dashboard, "renders a single `Governance Index` card");
    expectText(dashboard, "`1 read-only check indexed`");
    expectText(dashboard, "It does not render `Reference Checks`, `governance-safe-inspections`, per-inspection rows, or `Reference audit` in the visible safe-only HTML");
    expectText(dashboard, "Full governance items, evidence paths, review logs, safe inspection commands, and report titles remain in `/api/dashboard.governance.items_by_id`");
    expectText(dashboard, "When non-safe governance items are present, safe read-only checks can still appear as supporting `Safe Inspections` rows alongside the decision rows");
    expectText(dashboard, "mixed case, safe inspection rows stay short");
    expectText(dashboard, "evidence source are grouped once behind a `Reference audit` fold");
    expectText(dashboard, "rather than repeated user approval work");
    expectText(dashboard, "Governance Hub and Reference Library labels");
    expectText(dashboard, "follow the dashboard language toggle");
    expectText(dashboard, "The expanded safe-only Governance Hub heading reads `API-backed governance");
    expectText(dashboard, "its visible card reads `Governance Index` instead of exposing");
    expectText(dashboard, "The JSON contract still keeps `governance.summary` for agents and audit tooling");
    expectText(dashboard, "renders a compact `Pending Decisions` panel");
    expectText(dashboard, "The visible panel is a route summary grouped by owning confirmation surface");
    expectText(dashboard, "show how many explicit approvals are waiting there, provide one navigation button");
    expectText(dashboard, "`Append-only, guarded in owning surface`");
    expectText(dashboard, "It does not repeat candidate group titles, maintenance plan titles, next action labels");
    expectText(dashboard, "write labels, active guard labels, full safety notes");
    expectText(dashboard, "The JSON contract keeps those per-decision audit fields in `items[]`");
    expectText(dashboard, "It counts human decision units, not raw approve/reject buttons");
    expectText(dashboard, "Actual writes remain inside Capture Inbox, Review Queue, and Candidate Triage controls");
    expectText(dashboard, "After a dashboard approval or rejection succeeds, the browser renders one compact `Action receipt` in the global receipt anchor");
    expectText(dashboard, "The clicked card keeps only a short saved-and-refreshing status");
    expectText(dashboard, "does not briefly duplicate the full receipt inside the queue item");
    expectText(dashboard, "The receipt is restored after dashboard fragment refreshes");
    expectText(dashboard, "The visible receipt headline reads `Store updated`");
    expectText(dashboard, "three compact summary chips: `Write boundary`, `Changed`, and `Trace`");
    expectText(dashboard, "`Write boundary` reads `Append-only events`");
    expectText(dashboard, "`Changed` uses record-oriented language such as `1 record updated`");
    expectText(dashboard, "`Trace` reads `Timeline ready` when event ids are returned");
    expectText(dashboard, "read-only trace commands such as `moryn timeline --event-id <event_id>`");
    expectText(dashboard, "`moryn recall --record-id <record_id>` stay literal inside the collapsed");
    expectText(dashboard, "`Trace details` fold");
    expect(dashboard).toContain("All clear");
    expect(dashboard).toContain("POST /api/capture-inbox/:record_id/approve");
    expect(dashboard).toContain("POST /api/capture-inbox/:record_id/reject");
    expect(dashboard).toContain("POST /api/capture-inbox/groups/:group_id/approve");
    expect(dashboard).toContain("manual review");
    expect(dashboard).toContain("No auto-canonical");
    expect(dashboard).toContain("likely noise");
    expect(dashboard).toContain("default_capture_review_policy");
    expect(dashboard).toContain("default_autocapture_policy");
    expect(dashboard).toContain("capture_inbox.autocapture_policy");
    expectText(dashboard, "Audit Trail no longer renders a full `Capture Policy Audit` panel");
    expectText(dashboard, "The visible Capture Policy summary keeps only the manual-review and no-auto-canonical boundary visible");
    expectText(dashboard, "policy ids, auto-captured examples, policy-archived examples, rule ids, and full counts stay in `/api/dashboard.capture_policy`");
    expectText(dashboard, "Candidate, auto-captured, and policy-archived counts stay in the accessible label");
    expect(dashboard).toContain("Context Pack Review");
    expect(dashboard).toContain("context_pack_review");
    expect(dashboard).toContain("handoff_pack.quality_gate");
    expect(dashboard).toContain("local_event_history");
    expectText(dashboard, "folded row reads `Ready handoff context`");
    expectText(dashboard, "instead of repeating the quality and evidence counts");
    expectText(dashboard, "instead of repeating the quality and evidence counts or readiness chips");
    expectText(dashboard, "ready handoff brief says `Quality checks passed.` instead of repeating `6 passed | 0 review`");
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
    expectText(dashboard, "The visible HTML keeps a stable `capture_policy` chip with `data-dashboard-detail=\"capture-policy-audit\"`");
    expectText(dashboard, "Governance Hub summarizes policy findings that need attention");
    expectText(dashboard, "Capture Inbox renders the only approval controls for active review candidates");
    expect(dashboard).toContain("Approve Memory");
    expectText(dashboard, "Historical decisions stay inspectable through JSON and timeline commands");
    expectText(dashboard, "Decisions routed to `capture` or `archive` remain read-only evidence");
    expect(dashboard).toContain("inspect_auto_captured_handoff");
    expect(dashboard).toContain("inspect_policy_archived_record");
    expectText(dashboard, "They do not expose Approve, Reject, Promote, Archive, or Apply buttons");
    expectText(dashboard, "Canonical memory still requires explicit Capture Inbox user action");
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
    expectText(contracts, "Review approvals reuse the existing Capture Inbox");
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
    expectText(dashboard, "Review Queue plan cards open with an `Approval brief`");
    expectText(dashboard, "The brief uses `Change`, `Scope`, `Guard`, and `Writes` rows");
    expectText(dashboard, "The brief says the server rechecks the plan hash before writing");
    expectText(dashboard, "private-record scope remains a short sentence below the rows");
    expect(dashboard).toContain("does not repeat the full issue sentence or render a");
    expect(dashboard).toContain("second decision-summary fold");
    expectText(dashboard, "the title, the short approval brief, and explicit controls");
    expectText(dashboard, "It does not add separate safety badges beside the card title");
    expectText(dashboard, "`Guard` and `Writes` in the approval brief are the visible write-boundary explanation");
    expectText(dashboard, "The raw `plan_hash`, equivalent CLI command, rollback path, and record ids stay inside `Decision details`");
    expectText(dashboard, "The structured reasoning lives in that single fold");
    expect(dashboard).toContain("one expandable `Decision details` fold instead of several");
    expect(dashboard).toContain("folded summary reads `Context and evidence`");
    expect(dashboard).toContain("uses a compact `Approval context` block");
    expectText(dashboard, "`Why`, `Change`, `Guard`, and `Trace` rows");
    expectText(dashboard, "why the plan exists, the user-facing change, the server-side guard, and where the audit details live");
    expectText(dashboard, "does not render a second `Confirm notes` or `Approval checklist` layer");
    expectText(dashboard, "approval surface reads like a decision card instead of internal logs");
    expect(dashboard).toContain("Evidence, rollback, and raw plan details stay inside a nested `Evidence trace`");
    expect(dashboard).toContain("fold under `Decision details`");
    expect(dashboard).toContain("first expanded decision view stays readable without hiding audit data");
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
    expect(roadmap).toContain("v0.2.0 Acceptance Matrix");
    expect(roadmap).toContain("setup -> context pack -> capture -> review -> approve -> sync");
    expect(roadmap).toContain("No silent canonical writes");
    expect(roadmap).toContain("Dashboard first screen answers whether the user needs to act");
    expect(roadmap).toContain("Default copy is English with a Chinese language switch");
    expect(roadmap).toContain("Evidence remains in `/api/dashboard`");
    expect(roadmap).toContain("npm run smoke:dogfood-demo");
    expect(roadmap).toContain("npm run release:check");
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
    expectText(dashboard, "The expanded Health Check starts with an `Install Trust` summary before `Readiness Actions`");
    expectText(dashboard, "`Install Trust` reports whether the setup path is safe to inspect, how many safe checks are available, how many manual inputs remain, and that the dashboard does not write host configuration");
    expectText(dashboard, "Readiness commands remain outside the `Install Trust` summary");
    expectText(dashboard, "The visible readiness row is labeled `Setup Commands` while keeping the stable `health-check-readiness-actions` route");
    expectText(dashboard, "Its folded summary uses `safe checks` and `manual input` instead of the shorter internal `safe` and `need input` counters");
    expectText(dashboard, "Its groups read `Safe checks` and `Manual input`");
    expectText(dashboard, "Safe-check commands stay in `/api/dashboard.health_check.suggested_actions[]`");
    expectText(dashboard, "manual-input actions keep a `CLI command` fold");
    expectText(dashboard, "Full check rows stay inside the nested `Check Details` fold");
    expectText(dashboard, "`Check Details` summarizes pass, info, warning, and failed counts before listing individual checks");
    expectText(dashboard, "Safe-check rows stay readable before they read as command transcripts");
    expectText(dashboard, "commands remain available in `/api/dashboard.health_check.suggested_actions[]`");
    expectText(dashboard, "`capture_session` stays explicit because it needs the user-authored session summary");
    expectText(dashboard, "Capture Inbox backlog only counts candidates whose capture policy requires explicit review or user action");
    expectText(dashboard, "Older autocapture review metadata is rechecked against the current autocapture policy before it appears as active Capture Inbox, Health Check, or Dogfood review work");
    expectText(dashboard, "explicit durable decisions and preferences still require review");
    expectText(dashboard, "When there are no active Capture Inbox candidates, the main `Capture Inbox` panel is not rendered");
    expectText(dashboard, "auto-captured and policy-archived handoff evidence stays in `/api/dashboard.capture_policy` and the stable `capture_policy` Audit Trail");
    expectText(dashboard, "it does not render a second visible policy history panel");
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
