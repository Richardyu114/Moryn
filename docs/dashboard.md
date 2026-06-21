# Moryn Dashboard

The Moryn dashboard is a local observability surface for checking memory, sync,
handoffs, and recent agent activity. It is implemented in the CLI as a
server-rendered HTML page with optional live refresh. It does not require a
frontend build, hosted backend, database, or external service.

Use it to answer:

- Is this local Moryn store healthy right now?
- Did sync reach the configured private remote?
- What useful records did agents recently write?
- What needs attention before another agent relies on this store?
- Where can raw records and events be inspected during debugging?

The dashboard stays local-first. It reads the current event history from the
local store and never uploads dashboard data.

## Quick Start

Serve the dashboard for the current machine:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

To let another device on the same LAN view it, bind to all local interfaces:

```bash
moryn dashboard --serve --host 0.0.0.0 --port 8765
```

Then open the serving machine's LAN address:

```text
http://<machine-ip>:8765/
```

`127.0.0.1` is local-only. `0.0.0.0` listens on external network interfaces, but
firewalls and network policy still need to allow the selected port.

## Modes

### Live Server

```bash
moryn dashboard --serve --host <host> --port <port> --interval <ms> --limit <n>
```

Defaults:

- `--host 127.0.0.1`
- `--port 8765`
- `--interval 2000`
- `--limit 20`
- private-tagged records hidden

Server endpoints:

- `GET /` serves the full dashboard shell.
- `GET /fragment` rebuilds dashboard data and returns the current body HTML.
- `GET /api/dashboard` rebuilds dashboard data and returns JSON.
- `POST /api/capture-inbox/:record_id/approve` promotes one active Capture
  Inbox candidate to canonical memory with explicit user confirmation.
- `POST /api/capture-inbox/:record_id/reject` archives one active Capture Inbox
  candidate with an append-only event.
- `POST /api/maintenance/plans/:plan_id/approve` approves one generated
  maintenance plan after the server re-runs its dry run and verifies
  `plan_hash`.
- `GET /healthz` returns a lightweight health response for deployment checks.

The browser refreshes from `fragment` on the configured interval. The refresh
URL is relative so the dashboard can also work behind a reverse proxy path such
as `/moryn-dashboard/`.

Pass `--include-private` only when the user explicitly wants private memory in
the dashboard. The same flag applies to the server shell, `/fragment`, and
`/api/dashboard`.

Pass `--project-id <id>` or `--project <path>` when you want the server to
generate project-specific Review Queue plans, Memory Lifecycle review, and
Context Pack Review. Without project context the dashboard stays store-wide:
`maintenance.plans[]` is empty and `context_pack_review.available` is `false`.

### Capture Inbox

The live dashboard includes a `Capture Inbox` when agents have written active
review candidate records. This is the v0.2.0 default review path only for
captures that need a human decision: hosts can propose memory naturally, but
low-risk handoffs can be auto-captured as local handoff evidence without making
the user click every event. The user keeps control over what becomes canonical
long-term context.

The panel starts with a `Queue summary` before the individual cards. It tells
the user how many candidates have been grouped into review groups, how many look
like normal review versus likely noise, and that the default path is to review
by group first. Item-level detail remains available for inspection, but the
first read is "which group should I approve or reject?" rather than "click every
event."

Each candidate card starts with a compact `Decision brief` so the user can tell
why it needs review and what each action does before reading trace details:

- why the candidate entered manual review
- `Approve Memory` promotes it to canonical memory with an append-only user
  event
- `Reject` archives it without deleting the local audit trail

The same card still shows:

- proposed memory text
- source agent and session
- project id
- confidence and priority
- provenance method and reason
- recall and timeline trace commands
- grouping by source, session, project, and capture day
- likely noise signals such as smoke/test output or duplicate text

The Capture Inbox also exposes a default Capture Policy:

- `default_capture_review_policy` version 1
- manual review mode
- no auto-canonical promotion
- trust policy disabled by default
- canonical memory requires explicit user action
- grouping by `project_or_scope`, `source_client`, `source_session`, and
  `capture_day`
- stale batch protection for group approval/rejection
- noise rule ids `smoke_test_marker` and `duplicate_text`

The dashboard renders active Capture Inbox candidates first, so approval and
rejection controls stay ahead of policy explanation. Capture Policy,
Autocapture Policy, auto-captured examples, policy-archived examples, and rule
ids remain available under the collapsed `Capture Audit` detail panel. The
default row keeps the manual-review and no-auto-canonical boundary visible;
expanding it shows policy ids, grouping, stale protection, rule counts, and
rule ids.

`Approve Memory` posts to:

```text
POST /api/capture-inbox/:record_id/approve
```

The server replays the current store, verifies that the record is still an
active review candidate, then appends a confirmed
`promote_record` event with `source.client: "user"`.

`Reject` posts to:

```text
POST /api/capture-inbox/:record_id/reject
```

The server performs the same current-record check and appends an
`archive_record` event. Reject does not delete the candidate or rewrite history.
If the record was already approved, rejected, archived, or no longer visible,
the server returns `409` with `status: "not_actionable"`.

The dashboard also renders Capture Inbox groups so repeated captures from the
same agent session can be reviewed together. Group actions post to:

```text
POST /api/capture-inbox/groups/:group_id/approve
POST /api/capture-inbox/groups/:group_id/reject
```

Group requests include the rendered `record_ids[]`. The server rebuilds the
current group before writing; if any selected record has already changed state,
the server returns `409` with `status: "not_actionable"`. This keeps batch
review auditable without turning it into silent automation.

Capture Inbox uses a manual review policy: **No auto-canonical**. Noise signals
can suggest archive for likely smoke/test or duplicate captures, but the user
still decides through Approve Memory, Approve Group, Reject, or Reject Group.
The rule id appears next to the signal so the suggestion stays explainable.

`moryn capture session` also applies `default_autocapture_policy` before a
capture reaches the inbox. Low-risk handoffs use `decision: "capture"` and are
retained for context packs without user review or canonical promotion.
Handoffs containing decisions, risks, blockers, credentials, permissions, or
approval language use `decision: "review"` and enter Capture Inbox as
reviewable candidates. Obvious smoke/test or duplicate captures use `decision:
"archive"` and are policy-archived immediately with append-only record
evidence, so the user does not have to click through routine noise. The
dashboard shows auto-captured and archived counts, rule ids, and recent
examples under the Autocapture Policy summary. The policy never promotes
anything to canonical memory automatically.

### Capture Policy Audit

The dashboard includes a read-only `Capture Policy Audit` detail panel built
from the same local report as `moryn capture policy` and MCP `capture_policy`.
It is collapsed by default because Governance Hub summarizes the current policy
findings first. When expanded, it shows:

- the active `default_autocapture_policy`
- how many handoffs were auto-captured without review
- how many autocaptured records currently require review
- how many were policy-archived before entering Capture Inbox
- captured counts by rule id
- archived counts by rule id
- keyed findings such as `auto_captured`, `review_required`, and
  `policy_archived`
- safe dashboard or timeline inspection actions such as
  `inspect_auto_captured_handoff` and `inspect_policy_archived_record`
- recent policy decisions with record ids, decision, rule ids, text, evidence,
  and the next action

This panel explains automatic capture/review/archive routing without adding a
second policy mutation surface. Historical decisions stay inspectable, but only
active candidate records still waiting in Capture Inbox count as
`review_required` findings or Governance Hub user actions. Decisions routed to
`capture` render
`Auto-captured handoff`, `inspect_auto_captured_handoff`, and a read-only
timeline command. Decisions routed to `review` render the same explicit Capture
Inbox user actions only while they are still actionable: `Review in Capture Inbox`,
`Approve Memory`, and `Reject`. Already handled review decisions render
read-only inspection details instead.
Decisions routed to `archive` render `Policy archived`,
`inspect_policy_archived_record`, and a read-only timeline command such as
`moryn timeline --record-id <record_id> --project-id <project_id> --before 3 --after 3`.
Auto-captured and archived decisions do not expose Approve, Reject, Promote,
Archive, or Apply buttons.

Canonical memory still requires explicit Capture Inbox user action.
Auto-captured and archived policy decisions stay inspectable and reversible
through append-only history, but the dashboard does not turn them back into
inbox items automatically.

### Memory Lifecycle

The dashboard includes a read-only `Memory Lifecycle` detail panel built from
the same local report as `moryn memory lifecycle` and MCP `memory_lifecycle`.
It is collapsed by default because Governance Hub summarizes lifecycle findings
first. When expanded, it classifies visible records as:

- retained
- stale
- archive candidates
- private-retained when `--include-private` is explicit

The panel shows the active `default_memory_lifecycle_policy`, finding counts,
private-boundary counts, and suggested inspection commands. Timeline and recall
commands are safe read-only checks. Archive suggestions are displayed as CLI
commands with `safe_to_run: false`; the dashboard does not provide an Apply or
Approve Lifecycle button and does not mutate the store while generating the
panel.

When Memory Lifecycle and Capture Policy Audit both have no current findings or
suggested actions, the dashboard groups them under a collapsed `Clean Audit
Reports` summary inside `Supporting Evidence`. The reports and their evidence
remain in the HTML and `/api/dashboard`; the grouping only reduces first-screen
noise for clean checks.

When `--project-id <id>` or `--project <path>` is provided, the lifecycle report
uses the same project scope as the CLI report: matching project records plus
global records. Private-tagged records remain hidden unless
`--include-private` is passed.

### Review Queue

The live dashboard can include a `Review Queue` for local maintenance plans. In
the first version, the only interactive plan is project identity repair:
`project_identity_split` discovered by `memory doctor` becomes a
`project_migrate` dry-run plan.

The approval card is a human-readable decision card. The queue is collapsed by
default behind a confirmation summary that shows the number of decisions to
review, records that would move, and that approval is still required. Expanding
it first shows a compact `Decision brief` so the user can decide whether the
repair is worth approving without reading raw event language:

- what the repair would relink
- why approval is explicit
- whether private records are included or skipped

The same card still includes the structured decision summary:

- why the repair exists
- what records move between project ids
- the safety boundary, including server-side dry-run and `plan_hash` checking
- the recommended action

Each plan also keeps a compact `Review log` in plain language under an
expandable `Audit trail`: what was detected, the proposed change, the explicit
approval gate, and where the audit trail lives.

Evidence, rollback, and raw plan details are kept in an expandable section so
the first screen stays readable without hiding audit data. That rollback path
section includes source and target project ids, matched record count, state
distribution, private record counts, safety checks, equivalent CLI command,
record ids, and `plan_hash`.

Approving the card posts only the current `plan_hash` to:

```text
POST /api/maintenance/plans/:plan_id/approve
```

The browser does not send arbitrary record ids or migration arguments. The
server reconstructs the current plan from the local store, re-runs the dry run,
compares the submitted `plan_hash`, and applies only when the hash still
matches. Stale approvals return `409` with `status: "stale_plan"`. `Reject` is
browser-session-only and does not write store events.

If the dashboard is served with `--include-private`, matching private-tagged
records are included in the dry run and the copied command includes
`--include-private`. Without that explicit flag, private records are counted as
skipped and stay out of the approval.

### Governance Hub

The live dashboard includes a compact `Governance Hub` when existing local
reports have review or inspection items. It is a read-only summary over:

- `capture_policy.findings_by_id`
- `memory_lifecycle.findings_by_id`
- `maintenance.plans_by_id`
- `dogfood_report.findings_by_id`

Each normalized item carries `source`, `category`, `severity`, `record_ids`,
`evidence_path`, `action_label`, optional `action_id`, `review_log`, and safety
metadata. The hub counts items that need user confirmation, safe read-only
inspections, and private records hidden by the dashboard boundary. The visible
summary only shows non-zero counts, or `All clear` when no count needs attention,
so zero-value governance states do not compete with actual review work.

Governance items render as compact expandable decision rows. When any item
requires user confirmation, Governance Hub stays directly visible. When it only
contains safe read-only inspections, the whole hub is collapsed behind a compact
summary so routine checks do not look like pending decisions. Safe read-only
inspections are grouped under a collapsed `Safe Inspections` row; expanding it
shows the same decision rows. Each row leads with a plain-language `Review log`
covering the detection, recommended next step, write boundary, and audit trail.
Raw fields such as source, category, action id, evidence path, and record ids
stay available under `Raw audit fields`. This keeps the first screen scannable
while preserving the local audit trail.

Governance Hub does not add mutation endpoints. Items that require writes point
back to existing explicit controls such as Capture Inbox approval/rejection or
Review Queue maintenance approval. Lifecycle and dogfood items stay read-only
inspection guidance unless another existing surface already exposes a confirmed
action. Private-tagged records remain hidden unless `--include-private` is
explicit.

### Static Snapshot

```bash
moryn dashboard --no-open
```

Static mode writes:

```text
state/dashboard/index.html
```

inside the local Moryn store. The snapshot is useful for automation and artifact
inspection, but it does not refresh after it is written and it is not synced to
the private Moryn remote.

Interactive lifecycle and sync commands may generate and open the same static
snapshot. Use `--no-open` in automation or when a browser should not launch.

### MCP Hosts

The MCP `dashboard` tool returns a static local snapshot path and file URL. MCP
does not start a long-running HTTP server. If a human needs live monitoring,
start server mode from the CLI.

## What It Shows

The first screen favors human-readable summaries over raw ids:

- health status
- attention items
- sync summary
- active record counts
- agent activity
- record quality distribution
- record type distribution
- Context Pack Review handoff readiness when project context is explicit
- Memory Lifecycle retained/stale/archive review
- Capture Inbox candidate approvals when autocaptured records need review
- current policy decisions that need review, using the same Capture Inbox approval
  controls
- recent valuable records, newest first
- Review Queue maintenance plans when a project identity repair is available

The top health message is rendered as a compact status strip rather than a large
hero block, so the first screen stays focused on review queues and local
attention signals.

Directly below the status strip, `Focus Brief` picks the most urgent derived
Action Board item and turns it into one next step, with compact chips for
confirm, review, and sync state. It reuses the same local scroll target as the
Action Board and does not add a new API endpoint, Safe Action Registry entry, or
memory mutation path. Its job is to answer "what should I look at first?"
before the user scans the fuller dashboard.

The first interactive section is `Action Board`, a four-card summary for:

- `Confirm`: explicit approval actions in Capture Inbox or Review Queue
- `Review`: warning or critical attention signals
- `Inspect`: safe read-only governance checks
- `Sync`: local-only, pending, or conflicting sync state

The Action Board is a derived summary only; it does not add mutation endpoints
or hide the underlying panels. Clicking an Action Board card only scrolls to the
matching local dashboard section and opens that section when it is a collapsed
detail panel. Each card also shows a short verb-first next-action label such as
`Open queue`, `Review warnings`, `Open governance`, or `Inspect sync`, so the
first screen reads as a review cockpit instead of only a count summary. When no
approval queue is rendered, the `Confirm` card points to `Needs Attention` as a
stable zero-state target. If a target sits inside another collapsed detail
panel, the dashboard opens the parent panels before scrolling.

`Needs Attention` starts with a compact focus strip that counts action signals,
non-zero warning checks, and non-zero informational checks, then shows the next
review step as a dedicated action chip. Warning and critical items remain
directly visible. Informational checks are grouped under a collapsed `Info
Checks` summary so routine status signals remain inspectable without competing
with action-oriented warnings.

Clean audit reports, raw records, events, sync details, recent value, and store
telemetry remain available in the lower `Supporting Evidence` panel. That
collapsed group summarizes the number of evidence groups instead of listing
implementation-oriented module names on the first screen. It still holds `Clean
Audit Reports`, `Store Signals`, `Recent Value`, and the raw `Debug Inspector`
together so the first screen prioritizes attention items, governance, review
actions, and context readiness without removing local evidence.

Collapsed dashboard summaries wrap their title and count labels on narrow
screens. This keeps secondary panels readable on mobile-sized windows without
removing audit data from the page or from `/api/dashboard`.

Health badge states:

- `Healthy`: sync is clean and no urgent safety signals were detected.
- `Sync Pending`: configured sync has local changes or ahead/behind remote
  state; push or pull before cross-device handoff.
- `Needs Review`: unresolved safety signals such as quarantined content need a
  look before relying on the snapshot.
- `Conflict`: sync reports a conflict.
- `Local Only`: sync is not configured.

Attention items call out conditions such as:

- sync conflict
- dirty local store
- ahead or behind remote counts
- unresolved quarantined records
- quarantined records that have active safe replacement indexes
- raw records waiting for review
- many candidate records relative to canonical records
- missing sync remote

Attention items render as compact expandable rows. The default row shows the
condition and severity so the first screen can be scanned quickly; expanding
the row shows the explanation and any safe CLI inspection or setup command.
The full `attention_items[]` payload remains available from `/api/dashboard`.

## Data And Rendering

The dashboard is implemented in `src/observability/dashboard.ts`.

Data flow:

1. Read local event history from the configured Moryn store.
2. Replay events into records.
3. Compute derived dashboard data: health, attention items, charts, recent
   records, recent events, and agent activity.
4. Render HTML on the server.
5. In live server mode, periodically replace the page body with the latest
   rendered fragment.

The JSON returned by `/api/dashboard` includes:

- `sync`
- `health`
- `attention_items`
- `charts.agent_activity`
- `charts.memory_states`
- `charts.record_types`
- `charts.sync_position`
- `totals`
- `actions`
- `actions_by_id`
- `context_pack_review`
- `governance`
- `capture_inbox`
- `capture_inbox.autocapture_policy`
- `capture_policy`
- `memory_lifecycle`
- `dogfood_report`
- `recent_value`
- `recent_records`
- `recent_events`
- `agent_activity`
- `maintenance.plans`
- `maintenance.plans_by_id`

This keeps raw data inspectable while giving the HTML renderer human-oriented
fields.

### Safe Action Registry

`/api/dashboard` includes a local Safe Action Registry under `actions[]` and
`actions_by_id.<action_id>`. It indexes the actions already visible in the
dashboard:

- Capture Inbox record approve/reject actions
- Capture Inbox group approve/reject actions
- Capture Policy read-only inspect actions
- Review Queue maintenance approval actions

Each action records its surface, label, intent, target id, endpoint or command,
request body, source path, and safety metadata. Browser buttons carry the same
id in `data-dashboard-action-id`, so a rendered control can be traced back to
the JSON action contract.

The registry is not a background executor and does not add automatic writes.
Actions that mutate the store remain explicit dashboard button presses, use
append-only events, and carry stale guards such as `active_candidate_record`,
`active_candidate_group`, or `plan_hash`. Read-only actions record
`writes: "none"`.

### Context Pack Review

When the dashboard is opened with `--project-id <id>` or `--project <path>`, it
includes a read-only `Context Pack Review` panel for handoff readiness. The panel
is built from the dashboard's replayed local event history, not by calling the
host adapter `context_pack` operation. It records:

When available, the panel is collapsed by default behind a handoff readiness
summary that shows the quality gate status, check coverage, non-zero context
evidence counts, and whether the required capture action is visible. Expanding
it shows the current goal, read-only boundary, quality checks, evidence paths,
and context evidence. When the quality gate is `ready` with no failed checks or
warnings, the summary says `all checks passed` and stays collapsed as a clean
read-only signal. If checks need review, the panel can open by default so the
problem stays visible.

- `context_pack_review.generated_from.store: "local_event_history"`
- `context_pack_review.generated_from.writes: "none"`
- `context_pack_review.generated_from.sync_pull: false`
- `context_pack_review.handoff_pack.version: 2`
- `context_pack_review.handoff_pack.purpose: "agent_handoff"`
- `context_pack_review.handoff_pack.quality_gate`
- evidence paths under `CONTEXT_PACK_REVIEW_SELECTION_SOURCES`

The review summarizes:

- current project context as `handoff_pack.current_goal`
- recent canonical project decisions as `handoff_pack.recent_decisions[]`
- recent non-status session summaries as `handoff_pack.open_threads[]`
- canonical project warnings or blockers as `handoff_pack.risks[]`
- the required end-of-session capture command through
  `next.actions_by_id.capture_session`

The HTML dashboard keeps the quality gate and next action visible while placing
individual Quality Checks plus Recent Decisions, Open Threads, and Risks under
collapsed detail sections. When expanded, the panel starts with a compact
`Handoff readiness` brief that states whether the pack is ready, the check
coverage, the available evidence summary, and the exact `moryn capture session`
command. The lower sections still expose the current goal, read-only boundary,
quality checks, evidence paths, and context evidence for audit.

The Context Evidence summary only shows non-zero counts; when there are no
decisions, open threads, or risks, it says `No handoff evidence` instead of
listing three zero counts. `/api/dashboard` still returns the full
`context_pack_review` payload with check ids, counts, and evidence paths.

If the dashboard is opened without project context, the panel renders
`Unavailable` and the JSON message is `Open the dashboard with --project-id or
--project to review a project context pack.` The dashboard does not guess a project
from recent records, because that would make handoff review ambiguous.

Context Pack Review is deliberately not an approval surface. It does not render Approve, Apply, Promote, Archive, or Reject controls, does not add entries to the Safe Action Registry, and does not mutate memory while rendering. Use Capture Inbox for canonical memory approval and `moryn capture session` for writing the next handoff summary.

`capture_policy` and `memory_lifecycle` are read-only report data. Mutation
endpoints remain limited to Capture Inbox approval/rejection and Review Queue
maintenance approval.

`governance` is a read-only de-clutter layer for the same data. It exposes
`governance.summary`, `governance.items[]`, and
`governance.items_by_id.<item_id>` so agents and users can inspect current
review pressure without expanding every low-level panel. Memory Lifecycle,
Capture Policy Audit, and the raw Debug Inspector remain available, but their
details are collapsed by default.

Long record text is rendered as compact excerpts in the HTML dashboard,
including Recent Value cards, Context Pack Review items, Capture Inbox cards,
and Debug Inspector record details. `/api/dashboard` keeps the full JSON fields,
and each card keeps timeline/recall commands so the full record remains
auditable without making the page heavy.

Recent values, recent records, recent events, and agent activity entries carry
`citation` metadata when an event or record can be traced. Record citations
include `record_id`, the latest known `event_id`, a `timeline_command`, and a
`recall_command`. Event citations anchor timeline on `event_id` and include a
recall command when the event points at a record. The HTML renderer exposes the
same provenance with `data-dashboard-citation` attributes and compact command
snippets, so a human or agent can move from a dashboard item to `moryn timeline`
or `moryn recall` without guessing ids.

`Agent Activity` uses a shared observer adapter instead of exposing every local
write path as a separate actor. Known agent hosts are grouped by family:
`codex` and `codex-cli` display as `Codex`, `claude` and `claude-code` display
as `Claude`, `kimi` and `kimi-k2` display as `Kimi`, and `gemini` displays as
`Gemini`. Generic local transport values such as `agent`, `cli`, `mcp`, and
`moryn` display as `Moryn Local`. The JSON keeps `raw_clients` on each agent
activity item so debugging can still trace the original source clients.

Agents should write a host-specific `source.client` whenever possible. For
example, Claude should use `claude`, Kimi should use `kimi`, and Gemini should
use `gemini` instead of generic values such as `agent`, `cli`, or `mcp`.
Unknown client names are still displayed automatically by title-casing the raw
value, so `openai-agent` appears as `Openai Agent`. If a host writes only a
generic local value, the dashboard cannot infer the real agent and will group it
with `Moryn Local`.

`Recent Value` sorts records by `updated_at` descending before applying the
value score tie-breaker. This keeps the newest useful writes at the top while
still preserving deterministic ordering for records with the same timestamp.
`source_label` contains the normalized readable source, while `source_detail`
preserves the raw client and session details when available.

The HTML dashboard keeps `Recent Value` collapsed by default behind a summary
with the record count and newest-first ordering. Expanding it shows the first
four records and keeps additional records under `More Recent Value`.
`/api/dashboard` still returns the full `recent_value[]` payload, and every card
keeps its timeline and recall trace commands.

Quarantined records normally count as unresolved safety signals. If an active
safe replacement index explicitly declares `content.supersedes_quarantined_record`
for the quarantined record id, the dashboard reports that condition as an info
attention item instead of forcing `Needs Review`.

## Privacy And Safety

The dashboard reads local data only. It does not add a hosted backend or remote
analytics.

Default read-boundary and redaction rules still apply:

- records tagged `private`, `secret`, or `sensitive` are hidden unless
  `--include-private` or MCP `include_private: true` is used
- quarantined records render as `[quarantined]`
- sensitive text is not shown in overview cards
- inspector tables also avoid exposing quarantined content

If you bind to `0.0.0.0`, anyone who can reach that host and port may view the
dashboard. Use local-only binding, firewall rules, SSH tunnels, Tailscale, or a
trusted reverse proxy when access should be restricted.

## Troubleshooting

If the page does not open:

- confirm the command is still running
- check that the selected port is free
- try `--port 0` to let the OS choose a free port
- use `127.0.0.1` for same-machine browser access
- use `0.0.0.0` plus the machine LAN IP for another device
- check firewall rules if accessing from another device

If the dashboard still shows local sync changes after a push:

```bash
moryn sync --status
moryn sync --push
```

If derived views look stale:

```bash
moryn rebuild
```

If a reverse proxy serves the dashboard under a path prefix, proxy all dashboard
paths to the local server. For example, `/moryn-dashboard/`, `/moryn-dashboard/fragment`,
`/moryn-dashboard/api/dashboard`, and `/moryn-dashboard/healthz` should all reach
the same local dashboard server.
