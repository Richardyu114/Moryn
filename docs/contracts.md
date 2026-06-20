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
moryn contracts operations --operation install
moryn contracts operations --operation context_pack
moryn contracts operations --operation capture_session
```

The normal CLI flow is:

```bash
moryn install --host codex --project . --apply
moryn context pack --project . --agent codex
moryn capture session --project . --agent codex --summary "handoff summary"
```

The MCP tools are `install`, `context_pack`, and `capture_session`. `install`
returns a safe setup plan and host-specific MCP registration hints.
`context_pack` returns boot context, refresh changes, handoff inbox, and
`next.actions_by_id.capture_session`. `capture_session` writes an autocapture
`session_summary` with normalized host provenance.

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

`approve` promotes one active candidate tagged `autocapture` or `review` to
canonical memory with `source.client: "user"` and explicit confirmation.
`reject` archives one active candidate. Both endpoints replay the current store
before writing and return `409` when the record is no longer actionable. Group
endpoints require the rendered `record_ids[]` and reject stale batches when any
selected candidate changed state.

`/api/dashboard` also returns `capture_inbox.policy`, `capture_inbox.groups[]`,
and item-level noise signals. The policy is manual review with no
auto-canonical promotion by default.

Dashboard maintenance approval uses one separate local endpoint:

```text
POST /api/maintenance/plans/:plan_id/approve
```

The first supported plan is project identity repair. `/api/dashboard` returns a
`maintenance.plans[]` entry with `plan_id`, `plan_hash`, dry-run counts, safety
checks, and the equivalent `moryn project migrate --apply --confirm` command.
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
- `dashboard`

Use CLI `--include-private` or MCP `include_private: true` only for an explicit
private-memory read. The flag is discoverable in each operation contract:

```bash
moryn contracts operations --operation recall
moryn contracts operations --operation timeline
moryn contracts operations --operation memory_doctor
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
