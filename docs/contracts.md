# Contracts

Moryn responses are designed for agents that need stable paths, executable
follow-up actions, and structured recovery data. This document summarizes the
public contracts. The complete machine-readable source is available at runtime.

## Operation Contracts

List operations:

```bash
moryn contracts operations --index
```

Fetch the full registry:

```bash
moryn contracts operations
```

Fetch one operation:

```bash
moryn contracts operations --operation agent_enter
moryn contracts operations --mcp-tool agent_enter
moryn contracts operations --cli-command "moryn agent enter"
```

The MCP equivalent is:

```json
{
  "tool": "operation_contracts",
  "arguments": {
    "operation": "agent_enter"
  }
}
```

Each operation contract includes:

- operation id
- category
- summary
- safety metadata
- required usage condition
- required fields
- argument metadata
- CLI interface
- MCP interface
- execution guidance for required inputs

The compact index is intended as the first lookup. It gives operation ids,
categories, summaries, readiness, CLI commands, MCP tools, and exact lookup
recipes for the full contract.

## Host Adapter Contracts

The host adapter operations make Moryn easier to adopt while preserving the
product position: one multi-agent, multi-device store for memory, skills,
session summaries, and handoff context.

```bash
moryn contracts operations --operation setup
moryn contracts operations --operation install
moryn contracts operations --operation context_pack
moryn contracts operations --operation capture_session
```

The normal CLI flow is:

```bash
moryn setup --host codex --project . --apply
moryn install --host codex --project . --apply
moryn context pack --project . --agent codex
moryn capture session --project . --agent codex --summary "handoff summary"
```

The MCP tools are `setup`, `install`, `context_pack`, and `capture_session`.
`setup` is the one-command local setup wizard. Its default mode is a dry-run:
it returns `checks_by_id.<check>`, `actions_by_id.<action>`, `next`, and
`host_config_writes: "none"` without writing anything. `setup --apply`
initializes only the Moryn-local store and optional project config, then returns
`apply_result.applied_action_ids`, `apply_result.skipped_action_ids`, and
`apply_result.host_config_writes`. It does not mutate host configuration files;
host MCP registration remains a printed/manual action. The selection-source map
is exported as `SETUP_WIZARD_SELECTION_SOURCES` and includes
`checks_by_id.<check>`, `actions_by_id.<action>`, `next`, `apply_result`, and
`warnings[]`.

MCP equivalent:

```json
{
  "tool": "setup",
  "arguments": {
    "host": "codex",
    "project_path": ".",
    "apply": true
  }
}
```

`install` returns the lower-level host adapter setup plan and host-specific MCP
registration hints.
`context_pack` returns `handoff_pack` v2 for quick agent handoff, plus boot
context, refresh changes, raw handoff inbox evidence, and
`next.actions_by_id.capture_session`. The pack includes a read-only
`handoff_pack.quality_gate` with checks by id, failed check ids, and warnings
so agents can review startup readiness without mutating memory. The pack keeps
stable evidence paths such as `sections.boot.project.important_decisions[]`,
`sections.handoff.inbox[]`, and `next.actions_by_id.capture_session`.
`capture_session` evaluates `default_autocapture_policy`, returns
`policy_decision`, and writes an autocapture `session_summary` with normalized
host provenance. Low-risk handoffs use `decision: "capture"` and remain local
handoff evidence without requiring a user click. Handoffs with decisions, risks,
blockers, credentials, permissions, or approval language use `decision:
"review"` and enter Capture Inbox as candidates. Obvious smoke/test or duplicate
captures use `decision: "archive"` and are archived with policy evidence. The
policy never makes canonical memory automatically.

The timeline read operation is available through the same registry:

```bash
moryn contracts operations --operation timeline
```

Use it after `recall` when an agent has a record id but needs nearby events,
the latest mutation for that record, or a query-derived anchor:

```bash
moryn timeline --record-id rec_... --project-id moryn --before 5 --after 5
```

The MCP equivalent is:

```json
{
  "tool": "timeline",
  "arguments": {
    "record_id": "rec_...",
    "project_id": "moryn",
    "before": 5,
    "after": 5
  }
}
```

Add `"include_private": true` only when the user explicitly wants timeline to
include records tagged `private`, `secret`, or `sensitive`. Private timeline
items preserve that opt-in in their follow-up `recall` action.

The read-only memory governance audit is also available through the registry:

```bash
moryn contracts operations --operation memory_doctor
moryn memory doctor --project . --limit 20
```

The MCP equivalent is:

```json
{
  "tool": "memory_doctor",
  "arguments": {
    "project_path": ".",
    "limit": 20
  }
}
```

`memory_doctor` returns summary counts, keyed findings, and suggested promote,
archive, or project-identity review actions. It does not mutate records; any
returned mutation action has `safe_to_run: false` and requires user authority.

The read-only memory lifecycle report is available through the same registry:

```bash
moryn contracts operations --operation memory_lifecycle
moryn memory lifecycle --project . --limit 20
```

The MCP equivalent is:

```json
{
  "tool": "memory_lifecycle",
  "arguments": {
    "project_path": ".",
    "limit": 20
  }
}
```

`memory_lifecycle` returns retained, stale, archive-candidate, and
private-retained assessments keyed by
`memory_lifecycle.assessments_by_record_id.<record_id>`, plus findings under
`memory_lifecycle.findings_by_id.<finding_id>` and suggested actions under
`memory_lifecycle.suggested_actions_by_id.<action_id>`. It does not mutate
records or events; archive suggestions remain `safe_to_run: false`.

The read-only dogfood report is available through the same registry:

```bash
moryn contracts operations --operation dogfood_report
moryn dogfood report --project . --limit 20
```

The MCP equivalent is:

```json
{
  "tool": "dogfood_report",
  "arguments": {
    "project_path": ".",
    "limit": 20
  }
}
```

`dogfood_report` returns local-store friction findings for capture review
backlog, duplicate handoff text, and failure or timeout signals, keyed by
`dogfood_report.findings_by_id.<finding_id>`, plus inspection suggestions under
`dogfood_report.suggested_actions_by_id.<action_id>`. It does not mutate records
or events; suggested actions are read-only dashboard or timeline checks.
Capture review backlog uses the same review-required policy boundary as Capture
Inbox and Health Check, so low-risk auto-captured handoffs do not create
dogfood review work.
The dashboard renders the same findings as a collapsed read-only `Dogfood
Review` issue inbox with `Issue brief`, impact, affected records, read-only next
step, evidence path, and safe inspection command. It does not add dashboard API
write endpoints.

The read-only health check is available through the same registry:

```bash
moryn contracts operations --operation health_check
moryn health check --project . --limit 20
```

The MCP equivalent is:

```json
{
  "tool": "health_check",
  "arguments": {
    "project_path": ".",
    "limit": 20
  }
}
```

`health_check` returns installation and local-store readiness checks keyed by
`health_check.checks_by_id.<check_id>`, summary stats under
`health_check.stats.<field>`, and read-only next steps under
`health_check.suggested_actions_by_id.<action_id>`. It checks store
readability, event-log replay, project context, default private boundary, and
capture review backlog. It does not mutate records or events; suggested actions
are safe inspection commands such as `moryn dashboard --serve --project-id <id>`
or `moryn project list`.
The capture review backlog is scoped to candidates whose capture policy requires
explicit review or user action; low-risk auto-captured handoffs remain audit
evidence without becoming Health Check warnings.

The read-only recall eval is available through the same registry:

```bash
moryn contracts operations --operation recall_eval
moryn eval recall --project . --cases '[{"case_id":"sync","query":"private sync","expected_record_ids":["rec_..."]}]'
```

The MCP equivalent is:

```json
{
  "tool": "recall_eval",
  "arguments": {
    "project_path": ".",
    "cases": [
      {
        "case_id": "sync",
        "query": "private sync",
        "expected_record_ids": ["rec_..."]
      }
    ]
  }
}
```

`recall_eval` runs golden queries through normal recall and returns keyed cases
under `recall_eval.cases_by_id.<case_id>`, privacy checks, ranking reasons,
provenance method, and read-only suggested recall commands. It does not mutate
records, create indexes, or bypass the private boundary.

Project identity migration is the explicit repair operation for confirmed
splits:

```bash
moryn contracts operations --operation project_migrate
moryn project migrate --from repo-e6f0166fd942 --to moryn
moryn project migrate --from repo-e6f0166fd942 --to moryn --apply --confirm
```

The default run is a dry run. The apply form is `safe_to_run: false` and writes
one auditable `revise_record` event per migrated record. MCP hosts call
`project_migrate` with `from_project_id`, `to_project_id`, and, for mutation,
`dry_run: false` plus `confirmed: true`.

The observability dashboard is also exposed through the same contract registry:

```bash
moryn contracts operations --operation dashboard
```

For human monitoring, use the CLI server mode:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765 --project-id moryn
```

Open `http://127.0.0.1:8765/` on the same machine. To view from another device
on the same LAN, bind with `--host 0.0.0.0` and open
`http://<machine-ip>:8765/`, assuming the network allows the port.

The browser refreshes from the local event store on the configured interval.
The server also exposes `/api/dashboard` for JSON inspection and `/healthz` for
lightweight health checks. In server mode, Capture Inbox review uses two narrow
local endpoints:

```text
POST /api/capture-inbox/:record_id/approve
POST /api/capture-inbox/:record_id/reject
POST /api/capture-inbox/groups/:group_id/approve
POST /api/capture-inbox/groups/:group_id/reject
```

`approve` promotes one active review candidate to
canonical memory with `source.client: "user"` and explicit confirmation.
`reject` archives one active candidate. Both endpoints replay the current store
before writing and return `409` when the record is no longer actionable. Group
endpoints require the rendered `record_ids[]` and reject stale batches when any
selected candidate changed state.

`/api/dashboard` also returns `capture_inbox.policy`, `capture_inbox.groups[]`,
`capture_inbox.autocapture_policy`, and item-level noise signals. The default
review policy is
`default_capture_review_policy` version 1: manual review, no auto-canonical
promotion, trust disabled by default, canonical memory requires explicit user
action, grouping by `project_or_scope`, `source_client`, `source_session`, and
`capture_day`, and stale batch protection for group approval/rejection. Noise
signals include stable rule ids such as `smoke_test_marker` and
`duplicate_text` so dashboard suggestions remain explainable.
`default_autocapture_policy` is the write-time policy used by
`capture_session`: low-risk captures are auto-captured for handoff evidence,
risk-marked captures are routed to review, and obvious smoke/test or duplicate
captures are policy-archived without entering the review queue. Auto-captured
and archived examples stay inspectable through
`capture_inbox.autocapture_policy`.

`/api/dashboard` also returns a Safe Action Registry under `actions[]` and
`actions_by_id.<action_id>`. It indexes the same controls rendered in HTML:
Capture Inbox record actions, Capture Inbox group actions, Capture Policy
inspect commands, and Review Queue maintenance approvals. Each entry carries
surface, kind, label, intent, target, endpoint or command, request body, safety,
and source path metadata. Rendered buttons include `data-dashboard-action-id`
with the same id. This registry is an audit and selection surface; it does not
create a background executor or add any automatic write path.
Review Queue approvals post only `plan_hash` to
`POST /api/maintenance/plans/:plan_id/approve`; the server reconstructs the
current plan before writing. Project identity repair plans append
`revise_record` events, while candidate noise cleanup plans append
`archive_record` events after explicit approval.

`/api/dashboard` also returns `governance`, a read-only normalized review queue
for existing local reports. Its contract is:

- `governance.read_only: true`
- `governance.scope: "local_dashboard"`
- `governance.summary.total_items`
- `governance.summary.needs_user_action`
- `governance.summary.safe_inspections`
- `governance.summary.hidden_private_records`
- `governance.items[]`
- `governance.items_by_id.<item_id>`
- `governance.selection_sources`

Each governance item includes `source`, `category`, `severity`, `title`,
`summary`, `record_ids`, `evidence_path`, `action_label`, optional `action_id`,
`safe_to_run`, `requires_user_confirmation`, and `writes`. Sources are limited
to `capture_policy`, `memory_doctor`, `memory_lifecycle`, `maintenance`,
`recall_eval`, and `dogfood_report`.
The hub does not create a new write endpoint: write-capable items point back to
existing explicit Capture Inbox or maintenance approval actions, while
lifecycle, memory doctor, recall eval, and dogfood entries remain inspection
guidance.

`/api/dashboard` also returns `memory_doctor`, the same read-only report shape
as `moryn memory doctor` and MCP `memory_doctor`. The dashboard uses
`memory_doctor.findings_by_id.candidate_backlog` as a compact Governance Hub
safe inspection when candidates are accumulating faster than canonical records.
Other `memory_doctor` findings and suggested actions remain available in the
raw JSON for audit. `memory_doctor` findings remain read-only dashboard
governance inspections; they do not add dashboard approval, archive, promote,
apply, background execution, or Safe Action Registry entries.

`/api/dashboard` also returns `candidate_triage`, a read-only
dashboard-derived grouping for active candidate records. It is built from the
same locally replayed visible records used by the dashboard and does not change
the `memory_doctor` CLI or MCP report shape. Its contract includes:

- `candidate_triage.read_only: true`
- `candidate_triage.generated_from.writes: "none"`
- `candidate_triage.summary.total_candidates`
- `candidate_triage.summary.shown_records`
- `candidate_triage.groups[]`
- `candidate_triage.groups_by_id.<group_id>`
- `candidate_triage.selection_sources`

Group ids are limited to `likely_noise`, `promotable`, `session_summaries`,
and `needs_inspection`. Each group carries `record_ids`, `records[]`,
`records_by_id`, `recommended_next_step`, `review_handoff`, `writes: "none"`,
and an `evidence_path` such as
`candidate_triage.groups_by_id.<group_id>`. `review_handoff` names the existing
control to use next, guidance for the group, and the read-only write boundary.
The surface does not add Approve, Archive, Promote, Apply, background
execution, or Safe Action Registry entries.

`/api/dashboard` also returns `context_pack_review`, a read-only project handoff
readiness summary rendered as the dashboard `Context Pack Review` panel. When
the dashboard is served with `--project-id <id>` or `--project <path>`,
`context_pack_review.available` is `true` and the response includes
`handoff_pack` v2 with `purpose: "agent_handoff"`, current project context,
recent decisions, open handoff threads, risks, `next.actions_by_id.capture_session`,
and `handoff_pack.quality_gate`. Its evidence paths are described by
`CONTEXT_PACK_REVIEW_SELECTION_SOURCES`, including
`context_pack_review.handoff_pack.quality_gate`,
`context_pack_review.handoff_pack.recent_decisions[]`,
`context_pack_review.handoff_pack.open_threads[]`, and
`context_pack_review.handoff_pack.risks[]`.

The dashboard review is generated from local replayed event history:
`generated_from.store` is `local_event_history`, `generated_from.writes` is
`none`, and `generated_from.sync_pull` is `false`. It does not call the host
adapter `context_pack` operation and does not expose a Context Pack approve or
apply endpoint. Without explicit project context,
`context_pack_review.available` is `false` and the unavailable message is
`Open the dashboard with --project-id or --project to review a project context
pack.` The dashboard does not infer a project from recent records.
This means the dashboard does not call the host adapter context_pack operation.

`/api/dashboard` also returns `capture_policy`, the same read-only report shape
as `moryn capture policy` and MCP `capture_policy`. It includes
`policy`, `stats`, `decisions_by_record_id`, `findings_by_id`,
`suggested_actions_by_id`, and keyed record/event evidence for autocapture
capture/review/archive decisions. Suggested actions are dashboard or timeline
inspection only. Capture decisions expose `inspect_auto_captured_handoff`
timeline commands and do not enter Capture Inbox. Review decisions reuse the
existing Capture Inbox approval and rejection endpoints, while policy-archived
decisions expose only `inspect_policy_archived_record` timeline commands. The
dashboard does not expose a separate Capture Policy apply endpoint.

`/api/dashboard` also returns `memory_lifecycle`, the same read-only report
shape as `moryn memory lifecycle` and MCP `memory_lifecycle`. The dashboard
panel shows retained, stale, archive-candidate, and private-retained counts,
the `default_memory_lifecycle_policy`, keyed findings, and suggested timeline,
recall, or archive commands. Archive suggestions remain `safe_to_run: false`;
the dashboard does not expose an Apply or Approve Lifecycle endpoint.

`/api/dashboard` also returns `recall_eval` when active visible records include
explicit `type: "recall_eval_case"` golden-case records with JSON
`content.cases[]`. The dashboard evaluates those cases through normal recall and
returns `recall_eval.generated_from.store: "local_event_history"`,
`recall_eval.generated_from.writes: "none"`, `recall_eval.case_sources[]`, and
`recall_eval.report.cases_by_id.<case_id>`. Failed cases become read-only
Governance Hub inspections with `source: "recall_eval"`, `category:
"recall_quality"`, evidence paths such as
`recall_eval.report.cases_by_id.<case_id>`, and `writes: "none"`. The dashboard
does not invent golden cases, mutate memory, create an eval index, or expose a
Recall Eval approval endpoint.

Dashboard maintenance approval uses one separate local endpoint:

```text
POST /api/maintenance/plans/:plan_id/approve
```

The first supported plan is project identity repair. `/api/dashboard` returns a
`maintenance.plans[]` entry and a `maintenance.plans_by_id.<plan_id>` index
with `plan_id`, `plan_hash`, dry-run counts, safety checks, the equivalent
`moryn project migrate --apply --confirm` command, and a `decision_card` with
issue, impact, recommended action, evidence, rollback path, and raw evidence.
Project-specific plans require `project_id`/`project_path` context; without it,
`maintenance.plans[]` is empty. If `include_private: true` is used, private
records included in the plan are counted separately and the equivalent command
contains `--include-private`.
The approve endpoint accepts only:

```json
{
  "plan_hash": "sha256:..."
}
```

The server rebuilds the current plan from the local store, compares the
submitted `plan_hash`, and applies only when it still matches. Stale approvals
return `409` with `status: "stale_plan"`. For automation or MCP hosts, the
dashboard operation still supports static snapshot generation.

The MCP equivalent is:

```json
{
  "tool": "dashboard",
  "arguments": {
    "limit": 20
  }
}
```

The MCP operation returns a local HTML snapshot path and file URL for
`state/dashboard/index.html`. MCP hosts do not start a long-running server and
do not open a browser unless `open` is set to `true`.

See `docs/dashboard.md` for the full dashboard usage and implementation
contract.

## Private Read Boundary

The private read boundary is part of the operation contracts for all read
surfaces that can return active record content or event context. Records tagged
`private`, `secret`, or `sensitive` are hidden by default from:

- `boot`
- `recall`
- `refresh`
- `timeline`
- `list_recent`
- `memory_doctor`
- `memory_lifecycle`
- `recall_eval`
- `dogfood_report`
- `dashboard`

Use CLI `--include-private` or MCP `include_private: true` only for an explicit
private-memory read. The flag is discoverable in each operation contract:

```bash
moryn contracts operations --operation recall
moryn contracts operations --operation timeline
moryn contracts operations --operation memory_doctor
moryn contracts operations --operation memory_lifecycle
moryn contracts operations --operation dogfood_report
moryn contracts operations --operation dashboard
```

## Selection Sources

Selection sources are stable response paths. They let hosts find the same field
without scanning arrays or hard-coding examples.

```bash
moryn contracts selection-sources
```

The MCP equivalent is:

```json
{
  "tool": "selection_source_contracts",
  "arguments": {}
}
```

Examples:

- `boot.records_by_id.<record_id>`
- `recall.results_by_id.<record_id>`
- `timeline.items_by_event_id.<event_id>`
- `timeline.items_by_record_id.<record_id>[]`
- `list_recent.records_by_id.<record_id>`
- `memory_doctor.findings_by_id.<finding_id>`
- `memory_doctor.suggested_actions_by_id.<action_id>`
- `refresh.changes_by_record_id.<record_id>`
- `agent_start.next.actions_by_id.<action>`
- `project_list.projects_by_id.<project_id>.next`
- `error.next_action.arguments_by_name.<argument>`

Hosts should prefer keyed paths when they already know an id. Ordered arrays
remain available for display.

## Action Templates

Lifecycle, setup, recovery, and refresh responses return executable action
templates. A template can include:

- `tool`
- `command`
- `arguments`
- `interfaces.cli`
- `interfaces.mcp`
- `required_when`
- `required_fields`
- `required_fields_by_name`
- `arguments_by_name`
- `argument_sources`
- `selection_sources`
- `workflow`
- `safety`
- `execution`

For CLI execution, prefer `interfaces.cli.exec_file` when present:

```json
{
  "executable": "moryn",
  "args": ["agent", "enter", "--project", "."]
}
```

When a shell string is necessary, use `interfaces.cli.command_line` instead of
reconstructing quoting rules.

## Required Inputs

If an action has placeholders such as `<summary>` or `<remote>`, hosts should
read `execution.required_inputs_by_field` or
`execution.required_inputs_by_argument_path`.

Required input entries describe:

- expected value type
- prompt text
- value path, such as `user_input.summary`
- MCP targets
- CLI targets
- repeatability
- alternatives, such as choosing `text` or `content`
- enum options when applicable

When `execution.ready_to_run` is false, collect required inputs or confirmation
before running the action.

## MCP Argument Aliases

Direct MCP tools accept contract-friendly aliases for common nested values.

Examples:

- `projectId` -> `project_id`
- `currentTask` -> `current_task`
- `agentClient` -> `agent.client`
- `agent_client` -> `agent.client`
- `"agent.session_id"` -> `agent.session_id`
- `contentText` -> `content.text`
- `sourceClient` -> `source.client`
- `recordId` -> `record_id`
- `targetState` -> `target_state`
- `linkedRecordId` -> `linked_record_id`

Conflicting aliases are rejected with structured `INVALID_ARGUMENT` recovery
hints instead of silently choosing one value.

## Error Envelopes

Errors use structured envelopes:

```json
{
  "error": {
    "code": "RECORD_NOT_FOUND",
    "message": "Record not found: rec_missing",
    "recommended_action": "list recent records and retry with a returned record id",
    "recovery_hint": {},
    "next_action": {}
  }
}
```

Important error families:

- `STORE_NOT_INITIALIZED`
- `INVALID_STORE_CONFIG`
- `INVALID_PROJECT_CONFIG`
- `PROJECT_CONTEXT_REQUIRED`
- `PROJECT_PATH_NOT_FOUND`
- `PROJECT_ID_NOT_FOUND`
- `PROJECT_ID_CONFLICT`
- `INVALID_ARGUMENT`
- `INVALID_RECORD`
- `SENSITIVE_CONTENT_DETECTED`
- `INDEX_STALE`
- `RECORD_NOT_FOUND`
- `SYNC_NOT_CONFIGURED`
- `SYNC_CONFLICT`
- `SYNC_REMOTE_UNAVAILABLE`
- `PERMISSION_DENIED`
- `CONFIRMATION_REQUIRED`

Recovery actions carry the same action-template shape as lifecycle actions.

## Package API

JavaScript hosts can import the registry and constants:

```ts
import {
  getOperationContracts,
  getOperationContractIndex,
  getSelectionSourceContracts,
  SELECTION_SOURCE_CONTRACTS
} from "@richardyu114/moryn";
```

Use package helpers when embedding Moryn in a JS host. Use CLI or MCP contracts
when the host is not running inside Node.js.
