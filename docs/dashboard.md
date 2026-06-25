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

If active visible records include `type: "recall_eval_case"` with JSON
`content.cases[]`, the dashboard also runs those stored golden cases through
normal recall and exposes the read-only result under `recall_eval`. Failed cases
appear as safe Governance Hub inspections. The dashboard does not invent golden
queries, write eval records, create an index, or add approval endpoints for
Recall Eval. When there are no active stored cases, the folded `Recall Eval`
row reads `No recall eval cases yet`; the expanded panel still shows the
read-only unavailable reason and zero-case stats.

### Capture Inbox

The live dashboard includes a `Capture Inbox` when agents have written active
review candidate records. This is the v0.2.0 default review path only for
captures that need a human decision: hosts can propose memory naturally, but
low-risk handoffs can be auto-captured as local handoff evidence without making
the user click every event. The user keeps control over what becomes canonical
long-term context.

The panel starts with a `Queue summary` before the individual cards. It tells
the user how many candidates have been grouped into review groups and how many
look like normal review versus likely noise. Queue summary uses one guidance
line: review groups first, open item details only when needed, and canonical
memory still requires approval. Item-level detail remains available for
inspection as collapsed candidate details inside each group, but the first read
is "which group should I approve or reject?" rather than "click every event."
Group cards keep Approve Group and Reject Group on the visible path; individual
Approve Memory and Reject buttons stay available only after opening a candidate
detail row.
Capture Inbox group metadata such as Source, Project, Items, and Captured is
folded behind `Review context`, so the first group card stays focused on the
source, short summary, noise signal, and explicit group actions.

Each candidate detail row starts with a compact `Decision brief` so the user can
tell why it needs review and what each action does before reading trace details:

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
default row keeps the manual-review and no-auto-canonical boundary visible and
also summarizes auto-captured and policy-archived counts, so users can see which
captures did not require a click. Expanding it shows policy ids, grouping,
stale protection, rule counts, and rule ids.

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
findings first. Its folded summary uses plain routing labels such as
`captured`, `review`, and `archived` instead of internal field names. When
expanded, it shows:

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
Reports` summary inside `Audit Trail`. Its folded row reads `Clean lifecycle
and capture audits` instead of listing the two clean child modules. The reports
and their evidence remain in the expanded HTML and `/api/dashboard`; the
grouping only reduces first-screen noise for clean checks. The nested `Memory
Lifecycle` folded row reads `No lifecycle work` when there are no findings or
actions instead of repeating `0 findings | 0 actions`; its child suggestions
fold reads `Lifecycle suggestions` instead of a generic `Suggested actions` row.
The nested `Capture Policy Audit` row follows the same rule: clean reports read
`No capture policy work`, and non-zero summaries omit empty buckets such as
`0 captured`. `Policy Decision History` opens with `Read-only routing evidence`
so historical capture, review, and archive decisions read as audit history
instead of another action queue.

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

The structured decision summary is folded behind `Decision summary`, so the
first expanded queue view stays focused on the short brief and explicit controls.
Opening it still shows:

- why the repair exists
- what records move between project ids
- the safety boundary, including server-side dry-run and `plan_hash` checking
- the recommended action

Each plan also keeps expandable `Decision evidence`. The first thing inside it
is a structured `Why this repair is proposed` record, not a raw event stream:
detected condition, why it matters, proposed change, safety gate, approval
writes, and where to audit or roll back. A compact `Before approving` checklist
remains below that record with
plain-language Issue, Proposed change, Safety gate, and Audit path rows, so the
approval surface reads like a decision checklist instead of internal logs.

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
- `memory_doctor.findings_by_id`
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
summary whose row reads `Read-only governance checks` instead of repeating a
safe-check count. Safe read-only inspections are grouped under a collapsed `Safe
Inspections` row whose summary reads `Read-only checks ready`, so the nested row
explains its purpose instead of repeating the Governance Hub count; expanding it
still shows the concrete safe-check count plus compact inspection rows with
readable source labels, title, read-only next step, and evidence path.
Safe inspection rows keep raw evidence paths behind an `Evidence path` fold, so
the first visible row reads as guidance while the exact selection source remains
available for audit.
Safe inspection rows use short display titles while full report titles remain
in `/api/dashboard` and source panels.
`memory_doctor.findings_by_id.candidate_backlog` appears as a `Memory Doctor`
safe inspection when candidate records are accumulating faster than canonical
records. It points back to the raw memory doctor evidence and does not add
dashboard approval, archive, promote, apply, or background execution controls.
When backlog exists, `candidate_triage` groups active candidate records into
`likely_noise`, `promotable`, `session_summaries`, and `needs_inspection`. The
visible `Candidate Triage` panel stays collapsed by default inside Evidence
Library rather than the main review path. `Candidate Triage` is grouped under
`Read-only Findings` in the Evidence Library, and its folded row reads
`Read-only candidate backlog` instead of repeating a candidate count. Expanding
the panel shows candidate and group counts plus read-only next steps;
shown-record counts stay in `/api/dashboard` and the nested `Record samples`
summaries. Each candidate group starts with a compact `Review handoff` that
points to an existing control such as Capture Inbox, Memory Doctor, timeline,
or recall. It explains the next review surface and repeats that Candidate
Triage is read-only before record ids appear. The group write-boundary and
evidence fields move behind a collapsed `Audit boundary` row, so the expanded
group starts with the review handoff instead of raw audit fields. Record ids,
recall commands, and timeline commands stay behind a nested `Record samples`
fold inside each group.
`Record samples` renders only the first five full records per group and
summarizes the remaining records as API evidence, so large backlogs stay
inspectable without flooding the page. `Record samples` rows use short sample
labels plus record ids in their folded summaries, so repeated source/type rows
stay distinguishable. Overflow rows read `More samples` with `Full
group available in API and Raw Store`, while the exact
`candidate_triage.groups_by_id.<group_id>.records[]` path is kept behind `API
evidence path`. Full candidate text remains inside the expanded sample body and
`/api/dashboard`.
`Candidate Triage` stays read-only and does not
add Approve, Archive, Promote, Apply, or background execution controls; it is a
decision-prep surface for existing review policies, not a new mutation path.
Items that need confirmation still lead with a compact `Finding
summary` for records affected, safe next step, write boundary, and evidence
source, then keep plain-language `Review notes` for detection, next step, write
boundary, and evidence source. Raw fields such as source, category, action id,
evidence path, and record ids stay available under `Raw audit fields`, while
safe inspection detail remains in source panels such as Dogfood Review, Recall
Eval, and the raw `/api/dashboard` payload. This keeps dogfood friction readable
without forcing users to parse raw audit data first.

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

The top health message stays below the header, but healthy snapshots render as a
lightweight `dashboard-status-line` instead of a full status panel. Sync-only
pending states also use the lightweight status line because the Overview already
names the action as `Review sync changes`. Non-healthy states that need a
separate explanation, such as local-only, review, or conflict, still render the
full status strip because they need first-screen attention.

Directly below the health message, `Dashboard Overview` is the first-screen
summary. It picks the most urgent derived Action Board item, keeps non-good
overview cards visible in the main grid, and groups good cards under `Reference
Cards` so an all-clear dashboard does not spend the first screen on green
checks. The four derived cards for current health, next action, context, and
sync still point back to source paths such as `health`,
`action_board.items_by_id.review`, `context_pack_review`, or
`action_board.items_by_id.sync`. The visible card footer uses a human navigation
label such as `Review health`, `Open context`, or `Inspect sync`, while the
internal source path stays available in `cards[].source` and
`data-dashboard-overview-source` for audit tooling. Each overview card is also a
local navigation button that reuses the same scroll targets as the Action Board.
It does not add a new API endpoint, Safe Action Registry entry, or memory
mutation path. Its job is to answer "what should I look at first?" while keeping
the detailed panels folded underneath.
Pure read-only inspections do not turn the overview headline into an urgent
next action. If there are no confirmations, warnings, or sync actions, the
overview reads `All clear` while still offering an `Inspect checks` navigation
button to the Governance Hub. If pending sync is the only action signal, the
overview relies on its headline and primary button, then groups good cards under
`Background Status` while keeping the stable `dashboard-overview-quiet-cards`
route. The `Health`, `Next`, `Context`, and `Sync` cards remain preserved in
`/api/dashboard.dashboard_overview.cards` without repeating the same warning on
the first screen. `Background Status` opens with `Healthy signals kept for
context` so the folded row reads as supporting context instead of another count
to process.

`/api/dashboard.dashboard_overview` returns the same derived shape. It is
read-only and includes `evidence_sources` so agents can use the compact summary
without losing the audit trail to the underlying dashboard data.

Directly below the Overview, `Dashboard Work Lanes` groups the first screen into
four stable local navigation routes:

```text
Decide   -> Pending Decisions, Capture Inbox, or Review Queue confirmation
Context  -> Context Pack Review handoff readiness
Health   -> Needs Attention or Store Signals when sync is the active issue
Evidence -> Evidence Library and Audit Trail
```

Each lane is a button with a plain state, a short next step, and an existing
`data-action-board-target`. The lanes are navigation only: they do not render
Approve, Reject, Promote, Archive, or Apply controls, do not add
`data-dashboard-action-id`, and do not create a new API payload. They make the
dashboard easier to scan when many panels are present while preserving the
existing Action Board, detail panels, and audit trail underneath.
Lane clicks resolve either an element `id` or a matching `data-dashboard-detail`
target, so routes such as `context-pack-review` and `evidence-library` open the
collapsed detail panel before scrolling.

`Action Board` is rendered as `Page Shortcuts` in the UI while keeping the
stable `data-dashboard-detail="action-board"` route: a secondary, collapsed
navigator below the first-screen Work Lanes rather than another primary card
grid. `Page Shortcuts` opens with `Optional section links`; the previous
active-count summary remains as a quiet `action-board-activity` value such as
`1 review / 1 sync`, `1 sync issue`, or `all clear`; zero-count buckets are
hidden from the collapsed summary activity value. Expanding it still reveals
the four scroll targets for:

- `Confirm`: explicit decision units in Capture Inbox or Review Queue
- `Review`: warning or critical attention signals
- `Inspect`: safe read-only governance checks
- `Sync`: local-only, pending, or conflicting sync state

The Action Board is a derived summary only; it does not add mutation endpoints
or hide the underlying panels. Clicking an Action Board card only scrolls to the
matching local dashboard section and opens that section when it is a collapsed
detail panel. Each card also shows a short verb-first next-action label such as
`Review decisions`, `Review warnings`, `Open governance`, or `Inspect sync`, so
the first screen reads as a review cockpit instead of only a count summary. If
sync is the only warning signal, the review action uses `Review sync changes`
instead of the generic `Review warnings` label, and the collapsed Action Board
summary reads `1 sync issue` instead of duplicating the same condition as
`1 review / 1 sync`.
When no approval queue is rendered, the `Confirm` card points to `Needs
Attention` as a stable zero-state target. If a target sits inside another
collapsed detail panel, the dashboard opens the parent panels before scrolling.
When the Action Board is expanded, zero-value `good` targets are grouped under
`Quiet Shortcuts` while keeping the stable `action-board-quiet-targets` route
instead of occupying the primary grid. Non-zero or non-good items stay in the
main Action Board grid, except pure read-only `Inspect` signals: safe
inspections remain under `Quiet Shortcuts` even when their count is non-zero.
Quiet shortcuts keep the same `data-action-board-target` navigation controls,
so users and agents can still open Needs Attention, Governance Hub, or Store
Signals for audit without making empty checks or optional inspections look like
active work.
`Quiet Shortcuts` opens with `Background section links` to keep that supporting
role visible before expansion.

When explicit approvals exist, the dashboard renders a compact `Pending
Decisions` panel directly below the Action Board. `/api/dashboard.decision_summary`
returns the same read-only shape. It counts human decision units, not raw
approve/reject buttons: one Capture Inbox group is one decision, and one Review
Queue maintenance plan is one decision. Each item shows the plain-language
decision, write boundary, and navigation target. Pending Decisions keeps machine
evidence paths behind an `Evidence source` fold, such as
`capture_inbox.groups[]` or `maintenance.plans[]`. Visible write boundaries use
user-readable labels such as `Append-only events`, while the JSON contract keeps
machine-readable fields such as `writes: "append_only_events"`. It references
existing Safe Action Registry ids through `primary_action_id` and
`secondary_action_id`, but it does not add a new endpoint, background executor,
or second approval path. Actual writes remain inside Capture Inbox and Review
Queue controls.

Action Board cards keep full explanations in `items[].detail` for agents and
audit readers, but the visible card footer uses the shorter `items[].hint`.
This keeps the folded dashboard compact while preserving the machine-readable
reason behind each navigation target. When `items[].hint` repeats the visible
next-action label, the card shows that phrase once as the action chip instead of
rendering duplicate footer text.

When warning or critical action signals exist, the `needs-attention` scroll
target renders as `Action Signals`. `Action Signals` opens with `Warnings and
critical checks`, then shows a compact focus strip; the section preserves
`id="needs-attention"` and `data-dashboard-detail="needs-attention"` so existing
overview, Work Lane, and Page Shortcuts routes keep working. The strip
counts action signals, non-zero warning checks, and non-zero informational
checks, then shows the next review step as a dedicated action chip. Warning and
critical items remain directly visible. Informational checks are grouped under a
collapsed `Info Checks` summary so routine status signals remain inspectable
without competing with action-oriented warnings. The collapsed `Info Checks`
detail opens with `Routine status checks` so the row explains its purpose
instead of repeating the focus-strip count. When there are no warning or
critical action signals, the same scroll target renders as a lightweight
`needs-attention-quiet-line` with the visible title `Info Checks` and a summary
such as `No action needed | 1 info check`. It preserves the `id="needs-attention"`
scroll target and collapsed Info Checks detail for audit without making routine
informational checks look like user work.

Read-only diagnostic detail lives in the collapsed evidence layer. The visible
Evidence Library title is `Read-only Evidence`, while the stable route remains
`data-dashboard-detail="evidence-library"`. Its visible summary is
content-aware: when there are findings it reads `Read-only findings and
reference evidence`, and when there is only routine/background material it
reads `Reference evidence only`. It does not list every child module on the
first screen. When expanded, it starts with an `Evidence map` brief for
`Findings`, `Diagnostics`, and `Audit` so users can choose a route before
reading nested panels. The brief renders local route buttons that reuse the
existing `data-action-board-target` behavior: `Findings` opens `Read-only
Findings` when findings exist and otherwise stays on `Evidence Library`,
`Diagnostics` opens `Routine Diagnostics`, and `Audit` opens `Audit Trail`.
The brief is navigation copy only: it does not render Approve, Reject, Promote,
Archive, or Apply controls and does not add `data-dashboard-action-id`. Health
Check, Recall Eval, Dogfood Review, Governance Hub, Context Pack Review, and
Audit Trail stay nested under that evidence layer so the main path stays
focused on action and review. The library is still fully local and auditable:
each child panel keeps its `data-dashboard-detail` target, so Action Board
buttons can open the parent library before scrolling to `governance-hub`,
`context-pack-review`, or `store-signals`.

Inside Evidence Library, routine read-only diagnostics such as a healthy Health
Check, clean or unavailable Recall Eval, and ready or unavailable Context Pack
Review are grouped under `Routine Diagnostics`. `Routine Diagnostics` opens
with `Healthy checks and handoff readiness` so the folded row explains why these
checks are quiet. Findings-oriented panels such as Dogfood Review, Governance
Hub, or non-routine Health/Recall/Context checks
are grouped first under `Read-only Findings`, whose row reads `Findings to
inspect`. `Read-only Findings` is collapsed by default inside `Evidence
Library`, so read-only findings do not look like pending approval work or expose
child panel counts. Routine Diagnostics and Audit Trail are
grouped behind `Reference Evidence`, whose folded summary reads `Routine checks
and audit trail` instead of listing reference-panel counts. Empty groups are
omitted, so the library does not add a placeholder when there is only background
evidence.
The routine and background groups still keep the original child
`data-dashboard-detail` targets, so local navigation can open the parent group
before scrolling to the requested diagnostic.

`Dogfood Review` is a read-only issue inbox for `dogfood_report.findings_by_id`.
It renders only when the local report has findings. Its folded row reads
`Read-only dogfood finding` or `Read-only dogfood findings` instead of repeating
finding and safe-step counts. Each card leads with an `Issue brief` for impact,
affected records, read-only next step, and evidence path, followed by the safe
dashboard or timeline command already returned by
`dogfood_report.suggested_actions_by_id`. It does not add buttons, background
execution, or a second mutation path.

It does not contain Capture Inbox approvals or Review Queue maintenance
approvals. Those explicit confirmation surfaces stay on the main path, outside
the evidence layer. The library also does not add endpoints, Safe Action
Registry entries, or memory mutation paths.

Clean audit reports, raw records, events, sync details, recent value, and store
telemetry remain available inside the nested `Audit Trail` panel. That
collapsed group uses the purpose label `Audit logs and raw signals` instead of
listing implementation-oriented module names or collapsed-state counters on the
first screen. Inside Audit Trail, `Clean Audit Reports`, `Store
Signals`, and `Recent Value` are grouped under `Audit Evidence`, whose row
reads `Clean audits and store signals` instead of listing child panel counts.
`Audit Evidence` is collapsed by default inside `Audit Trail`,
and `Store Signals` and `Recent Value` are nested under a collapsed
`Store Snapshot` row, while the raw `Debug Inspector` is grouped behind
`Raw Store`. This keeps
common audit evidence closer to the user while keeping record/event/sync
internals available without placing them at the same level. Nested evidence
summaries also use purpose labels: `Store Signals` opens with `Operational
health signals`, `Raw Store` opens with `Records, events, and sync`, and
`Debug Inspector` opens with `Raw store inspection`. Its child folds are labeled
`Record Index`, `Event Timeline`, and `Sync Snapshot` instead of generic
`Records`, `Events`, and `Sync`. `Record Index` and `Event Timeline` render
only the first ten rows each and summarize overflow as `/api/dashboard`
evidence. `Record Index` record rows use short kind/type/source summaries in
their folded row instead of raw record text, while their expanded bodies still
keep agent activity, record quality, records, events, and sync detail
inspectable.

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
- local sync changes that have not been pushed
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
- `decision_summary`
- `context_pack_review`
- `governance`
- `recall_eval`
- `capture_inbox`
- `capture_inbox.autocapture_policy`
- `capture_policy`
- `memory_doctor`
- `candidate_triage`
- `health_check`
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

### Moryn Health Check

The HTML dashboard includes a compact read-only `Moryn Health Check` panel near
the top of the page. It is separate from the dashboard status badge: the badge
summarizes current sync/dashboard state, while `health_check` reports local
installation and store readiness. The panel stays collapsed by default behind a
plain-language summary such as `Healthy local store` or
`needs attention | 1 warning`. Zero-count buckets are omitted from the folded
row, while `/api/dashboard.health_check.summary` still includes the complete
warning and failing counts for audit and tooling.

`/api/dashboard.health_check` is the same read-only shape as `moryn health
check` and MCP `health_check`. It checks store readability, event-log replay,
project context, default private boundary, and Capture Inbox backlog. Suggested
actions are safe inspection commands only, such as opening the dashboard or
listing known projects. The panel does not add Apply, Approve, repair, retry,
or background execution controls.

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

After a dashboard approval or rejection succeeds, the browser renders a compact
`Action receipt` before refreshing the body. The receipt is restored after
dashboard fragment refreshes, so the last explicit action remains visible
instead of disappearing when the queue updates. It uses readable rows for
Outcome, Write targets, Decision context, Records, Events, and Audit next,
including read-only trace commands such as
`moryn timeline --event-id <event_id>` and
`moryn recall --record-id <record_id>`. It is a visibility layer only: it does
not add background execution, retry writes, or a second mutation path.

### Context Pack Review

When the dashboard is opened with `--project-id <id>` or `--project <path>`, it
includes a read-only `Context Pack Review` panel for handoff readiness. The panel
is built from the dashboard's replayed local event history, not by calling the
host adapter `context_pack` operation. It records:

When available, the panel is collapsed by default behind a handoff readiness
summary. When the quality gate is `ready` with no failed checks or warnings, the
folded row reads `Ready handoff context` instead of repeating the quality and
evidence counts or readiness chips. If no decisions, threads, or risks are
present, the folded row keeps the useful exception as `Ready handoff context |
no handoff evidence`. Expanding it shows readiness chips, the current goal,
read-only boundary, quality checks, evidence paths, and context evidence. If
checks need review, the panel can open by default so the problem stays visible.
Inside the expanded panel, the `Quality Checks` child row reads
`All quality checks passed` when there is no review work instead of repeating
`passed | 0 review`; the detailed check list still carries each check, source,
and count for audit.

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

Quality check coverage, context evidence counts, and required capture-action
visibility remain visible in expanded readiness chips and the handoff brief. The
`Context Evidence` folded row reads `Handoff evidence available` when evidence
exists, so the collapsed cockpit stays action-oriented instead of repeating
decision, thread, and risk counts. When there are no decisions, open threads, or
risks, it says `No handoff evidence` instead of listing three zero counts. The
expanded readiness brief still shows concrete decision, thread, and risk counts,
and `/api/dashboard` still returns the full `context_pack_review` payload with
check ids, counts, and evidence paths.

If the dashboard is opened without project context, the panel renders
`Unavailable` and the JSON message is `Open the dashboard with --project-id or
--project to review a project context pack.` The dashboard does not guess a project
from recent records, because that would make handoff review ambiguous.

Context Pack Review is deliberately not an approval surface. It does not render Approve, Apply, Promote, Archive, or Reject controls, does not add entries to the Safe Action Registry, and does not mutate memory while rendering. Use Capture Inbox for canonical memory approval and `moryn capture session` for writing the next handoff summary.

`capture_policy`, `memory_lifecycle`, and `recall_eval` are read-only report
data. Mutation endpoints remain limited to Capture Inbox approval/rejection and
Review Queue maintenance approval.

`governance` is a read-only de-clutter layer for the same data. It exposes
`governance.summary`, `governance.items[]`, and
`governance.items_by_id.<item_id>` so agents and users can inspect current
review pressure without expanding every low-level panel. Recall Eval misses use
`source: "recall_eval"` and `category: "recall_quality"` with evidence paths
such as `recall_eval.report.cases_by_id.<case_id>`, safe-to-run inspection
metadata, and `writes: "none"`. Memory Lifecycle, Capture Policy Audit, Recall
Eval, and the raw Debug Inspector remain available, but their details are
collapsed by default.

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

The HTML dashboard keeps `Recent Value` collapsed by default behind a short
recent-record count. Newest-first ordering, full details, and trace commands
stay inside the expanded panel and `/api/dashboard` payload. Expanding it shows
the first four records and keeps additional records under `More Recent Value`.
Every card keeps its timeline and recall trace commands under a `Trace commands`
fold with kind/type context instead of a generic `Details` row.

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
