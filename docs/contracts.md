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

The observability dashboard is also exposed through the same contract registry:

```bash
moryn contracts operations --operation dashboard
```

For human monitoring, use the CLI server mode:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765
```

The browser refreshes from the local event store on the configured interval. For
automation or MCP hosts, the dashboard operation still supports static snapshot
generation.

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
- `list_recent.records_by_id.<record_id>`
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
