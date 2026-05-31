# Moryn Implementation Roadmap

This roadmap tracks the remaining work from the approved design to a usable
personal memory layer for multiple AI agents. The project should keep moving in
small, verified commits on `main`.

## Current Baseline

The repository currently has the first-version local MVP:

- TypeScript package and `moryn` CLI.
- Append-only JSON event store.
- Record kinds for memory, skill, soul, session summary, and agent note.
- Logical revise, promote, archive, quarantine, and link replay model.
- Recall, boot, refresh, list recent, and sensitive-content quarantine.
- Git init, status, pull, and push for a user-owned store repo.
- A real stdio MCP server using the official MCP TypeScript SDK.

## Completion Criteria

Moryn is functionally complete for the first product version when:

1. Agents can connect through a real MCP stdio server.
2. CLI and MCP expose the same core operations.
3. Local store configuration is initialized and validated.
4. Project identity resolves from explicit input, `.moryn.json`, Git remote,
   Git root, and path fallback.
5. Boot returns a useful bounded context package for a project/task.
6. Recall supports project, kind, type, tag, state, text query, and record-id
   filters with explainable ranking.
7. Writes, revisions, promotions, archives, quarantines, and record links are
   append-only and replayable.
8. Sync can initialize a user-owned Git repo, pull, commit local events, push,
   and report changes since a cursor.
9. Periodic refresh can be driven by agents or scripts without corrupting
   local state.
10. Snapshots and indexes are rebuildable from events.
11. Sensitive records stay out of default boot and recall.
12. README includes real installation and agent-connection instructions.
13. The test suite covers core, CLI, MCP, sync, project config, and end-to-end
   cross-agent workflows.

## Phase 1: Real Agent Access

Use the official Model Context Protocol TypeScript SDK over stdio for real
agent access.

Deliverables:

- `moryn mcp` starts a real MCP server.
- Tools: `init`, `project_init`, `boot`, `recall`, `write`, `revise`,
  `promote`, `archive`, `quarantine`, `link`, `refresh`, `rebuild`,
  `sync_init`, `sync_status`, `sync_pull`, `sync_push`, `list_recent`.
- Tool schemas validate inputs.
- MCP tests use an SDK client over stdio.
- Built `dist/cli.js` is covered by an MCP stdio smoke test.
- README shows a working MCP host command.

## Phase 2: Store and Project Configuration

Make local setup predictable across machines and projects.

Deliverables:

- Done: `moryn init` writes `config.json` with device id and store version.
- Done: `moryn project init` writes `.moryn.json`.
- Done: Successful `init` and `project_init` responses expose config artifact
  paths and `selection_sources`, so agents can verify setup without guessing
  local config locations or key fields.
- Done: CLI accepts `--project <path>` and resolves project identity consistently.
- Done: Project config can add default tags and sync mode.
- Done: CLI, MCP, and operation contracts all accept legacy project
  `sync_mode: "auto"` as an alias for `interval`, so agents do not see
  contradictory allowed values across interfaces.
- Done: Operation-contract CLI targets and assignments can carry
  interface-specific `required_when`, and `project_init.path` now explains that
  the CLI defaults `--path` to the current directory while MCP still requires
  `path`.
- Done: CLI `project init` updates preserve existing tags, default skills, and
  sync mode when those inputs are omitted, so an agent rerun does not silently
  clear project defaults.
- Done: Project config default skills are applied to boot context.
- Done: Event validation happens on read and write.

## Phase 3: Recall, Boot, and Refresh Semantics

Turn raw records into useful bounded context packages.

Deliverables:

- Done: Recall filters: record id, kind, type, state, tags, files, project, and text.
- Done: Ranking reasons are explicit and stable.
- Done: Boot separates profile, project decisions, warnings, skills, recent changes,
  and sync status.
- Done: Boot responses expose `records_by_id`, so agents can dereference
  returned boot records without scanning nested arrays.
- Done: Boot sections expose section-local by-id mirrors
  (`profile.*_by_id`, `project.*_by_id`, `skills_by_id`,
  `task_relevant_by_id`, and `recent_changes_by_id`) plus named
  `selection_sources`, so agents can dereference a known boot record in its
  semantic section without scanning every boot array.
- Done: `list_recent` responses expose ordered `records` plus `records_by_id`,
  so missing-record recovery can point agents at a keyed replacement id source.
- Done: `moryn refresh` reports changes since a cursor as `silent`, `notice`, or
  `interrupt`.
- Done: Reportable non-raw refresh changes now include safe `recall`
  `next_action` metadata with CLI/MCP interfaces, safety, and workflow fields.
- Done: Core response `selection_sources` maps are exported from the package
  entrypoint, so library hosts can reuse canonical field-path contracts instead
  of copying strings from docs or runtime examples.
- Done: Refresh change `next_action` templates expose action-local
  `selection_sources`, so agents that receive only the nested action still see
  the stable keyed change, record-id, keyed next-action, and ordered fallback
  paths.
- Done: Missing-record recovery now exposes both a compact `recovery_hint` and
  a two-step workflow: run safe `list_recent`, select the returned record id
  from `records_by_id`, and retry the original CLI/MCP tool instead of guessing
  a mutation shape or retrying the hallucinated id.
- Done: `current_task` narrows refresh interrupts to related blockers, warnings,
  conflicts, and high-priority changes.
- Done: Agents can request explicit refresh through CLI or MCP.
- Done: Explicit scope filtering is supported in core, CLI, and MCP recall.
- Done: Recall responses now expose `results_by_id`, so agents can consume a
  known returned record id without scanning the ranked `results[]` array.
- Done: Text queries require a text/tag/type match instead of returning unrelated
  same-project records.

## Phase 4: Git Sync

Implement private-repo sync as the first cross-device backend.

Deliverables:

- Done: `moryn sync init <repo-url>` creates or connects the store Git repo.
- Done: `moryn sync --pull` fetches and merges remote event history.
- Done: `moryn sync --pull` rebases local event commits when remote history has
  moved ahead.
- Done: `moryn sync --push` commits local event files and pushes.
- Done: Successful `sync_init`, `sync_pull`, and `sync_push` responses expose
  `selection_sources` for operation result flags, so hosts can read sync
  outcomes without guessing which fields are present.
- Done: `moryn sync --status` reports configured remote, branch, dirty state, ahead,
  behind, and last sync.
- Done: `moryn sync --status` reports structured conflict diagnostics after a
  failed pull or push so agents do not infer recovery from a dirty worktree.
- Done: Sync conflict diagnostics expose `conflict.files_by_path`, so agents can
  inspect a known conflicted event path without scanning `conflict.files[]`.
- Done: `sync_status` responses expose top-level `selection_sources` for status,
  remote, divergence, last-sync, error, and conflict-file paths, so recovery
  hosts can inspect sync state without guessing JSON fields.
- Done: Agent lifecycle entrypoints, status checkpoints, and finish handoffs
  stop before lifecycle writes when sync is conflicted and return a structured
  `sync_status` recovery action.
- Done: Agent lifecycle partial sync failures include structured
  `*_error_details` recovery contracts alongside legacy error strings.
- Done: `agent_start.handoff.inbox[]` and `handoff.active_sessions[]` now expose
  safe `recall` `next_action` metadata, so agents can inspect full handoff or
  status records without guessing CLI/MCP arguments.
- Done: `agent_start.handoff.inbox_by_record_id` and
  `handoff.active_sessions_by_record_id` now mirror handoff arrays with keyed
  workflow sources, so agents can recall a known handoff record without scanning
  arrays.
- Done: `agent_start.handoff.next_action` now mirrors the prioritized active
  session or inbox recall action, so top-level handoff recommendations are
  directly executable.
- Done: Handoff entry `next_action` templates now expose action-local
  `selection_sources`, so selected recall actions keep their keyed entry,
  record-id, keyed next-action, and ordered fallback paths when passed around
  independently.
- Done: Refresh responses now expose `changes_by_record_id` and keyed
  `next_action` workflow sources, so agents can recall a known changed record
  without scanning `changes[]`.
- Done: `agent_doctor` returns an explicit readiness summary so agents do not
  infer startup safety from raw checks.
- Done: `agent_doctor` exposes `checks_by_name` and
  `readiness.blocking_checks_by_name`, so agents can inspect setup blockers by
  check name without scanning `checks[]`.
- Done: Generated snapshots/indexes are excluded from sync by default.
- Done: Local `config.json` is excluded from sync to avoid device identity conflicts.
- Done: Post-pull snapshot/index rebuild runs after successful pull.

## Phase 5: Derived Views

Add rebuildable snapshots and indexes for performance and correctness.

Deliverables:

- Done: `moryn rebuild` regenerates snapshots and recall indexes from events.
- Done: Snapshots include user profile, project summaries, and skill index.
- Done: Indexes are deterministic and safe to delete.
- Done: Rebuild success responses expose regenerated artifact paths and
  `selection_sources`, so agents can inspect snapshots and indexes without
  guessing file locations.
- Done: Tests prove event replay is the source of truth.

## Phase 6: Cross-Agent Workflow Hardening

Make the intended product loop reliable in real use.

Deliverables:

- Done: End-to-end tests simulate two agents sharing one store.
- Done: Candidate promotion workflow prevents raw notes from polluting boot.
- Done: Skill revisions keep canonical skill identity while preserving history.
- Done: README includes Codex, Claude, Cursor, and shell-agent usage examples where
  practical.
- Done: Packed-package smoke test installs the generated tarball and runs the
  `moryn` binary from `node_modules/.bin`.
- Done: `npm run smoke:agent-lifecycle` validates two independent agent stores
  exchanging status, finish, start, refresh, and `next.actions` over Git sync.
- Done: Lifecycle `next.actions` and guide templates expose action-level
  `safe_to_run` metadata so agents can distinguish automatic refresh/start
  helpers from status/finish writes that need authored content.
- Done: `agent_doctor.readiness` mirrors the selected next action's safety,
  required usage condition, required fields, transport interfaces, and
  `workflow` plus arguments, argument sources, and selection sources so agents
  can start or recover without recombining nested objects.
- Done: `agent_doctor.readiness.blocking_checks_by_name` mirrors blocking
  warning checks by name, so recovery hosts can inspect the exact blocker behind
  `blocking_checks[]` without array matching.
- Done: `agent_doctor.next.selection_sources` names keyed alternate action
  paths when `next.actions_by_id` is present, so hosts do not infer doctor
  candidate-action paths from other lifecycle responses.
- Done: Structured `error.next_action` and warning `next_action` payloads expose
  `selection_sources` for their error/warning containers, keyed required
  fields, keyed argument metadata, keyed argument sources, and keyed workflow
  phases, so recovery hosts do not infer where failure-recovery metadata lives.
- Done: Lifecycle and recovery `selection_sources` maps are exported from the
  package entrypoint, so host integrations can reuse canonical guide, doctor,
  handoff, lifecycle, discovery, and error-action field paths instead of
  copying strings from response examples.
- Done: The package entrypoint exports a grouped `SELECTION_SOURCE_CONTRACTS`
  registry, so hosts can enumerate setup, core, sync, lifecycle, and recovery
  field-path maps without knowing every individual constant name.
- Done: The CLI command `moryn contracts selection-sources`, MCP tool
  `selection_source_contracts`, and package helper `getSelectionSourceContracts`
  expose the same self-describing registry response, so non-JS agents can
  discover field-path contracts without copying docs or importing constants.
- Done: The CLI command `moryn contracts operations`, MCP tool
  `operation_contracts`, and package helper `getOperationContracts` expose a
  static operation directory with CLI/MCP interfaces, safety metadata,
  required usage conditions, required fields, keyed required-field metadata,
  full keyed argument metadata, enum allowed values, argument sources, and
  reverse lookup maps keyed by MCP tool and CLI command, so agents can discover
  how to call Moryn without hallucinating command names, placeholders, optional
  arguments, defaults, enum values, operation ids, or argument shapes.
- Done: `moryn contracts operations --index`, `operation_contracts` with
  `{"index":true}`, and package helper `getOperationContractIndex()` expose a
  compact first-pass operation index with ids, categories, summaries, readiness,
  MCP tools, CLI commands, and exact next lookup recipes, so agents can discover
  which single operation contract to fetch without loading the full static
  directory. Each entry carries an `execution_hint` with the ready-to-run guard,
  next step, missing fields, keyed required-input paths, and value-path reverse
  lookup hints for collected `user_input.*` values, plus concrete
  `operation_source` full-registry paths and `full_contract_lookup` package,
  CLI, and MCP calls for that operation. It also exposes
  `operation_source_lookup`, a compact recipe for turning a tool or display
  command into an operation id and then the concrete full-contract path without
  inventing paths. The index response carries its own compact
  `selection_sources` for those index-only fields including `operation_source`,
  `operation_source_lookup`, and the value-path hint, package users can import
  `OPERATION_CONTRACT_INDEX_SELECTION_SOURCES`, and `operation_contracts`
  declares `index` in `arguments_by_name` and `interfaces.mcp.arguments` so the
  first-pass filter is machine-discoverable.
- Done: `moryn contracts operations --operation <id>`,
  `moryn contracts operations --mcp-tool <tool>`,
  `moryn contracts operations --cli-command <command>`, `operation_contracts`
  with one of `operation`, `mcp_tool`, or `cli_command`, and package helpers
  `getOperationContract(<id>)`, `getOperationContractByMcpTool(<tool>)`, and
  `getOperationContractByCliCommand(<command>)` return a single operation
  contract with its canonical source path, matched lookup source, and
  selection-source registry. The static `operation_contracts` contract also
  declares those lookup inputs in `arguments_by_name` and
  `interfaces.mcp.arguments`, so agents can discover the compact filters before
  loading the full operation directory into context. Unknown operation ids, MCP
  tools, or CLI commands now return `error.recovery_hint` with the rejected
  lookup, available operation ids, compact index lookup calls, and retry
  templates that include package helper, CLI, and MCP forms, including
  `retry_with_lookup_modes` for all three single-operation lookup modes.
  Ambiguous lookup calls that provide more than one filter now return
  `error.recovery_hint.rejected_lookup.provided` plus `accepted_lookup_modes`
  with the same package, CLI, and MCP retry forms, so agents can drop the extra
  lookup mode and retry without parsing prose.
- Done: Single-operation package helpers now reject malformed lookup arguments,
  including numeric values and empty strings, with exported
  `OperationContractLookupArgumentError` recovery fields while preserving
  `undefined` for well-formed but unknown lookup strings.
- Done: CLI and MCP required-option, option-dependency, non-empty string, enum,
  integer/number-range, JSON-object, read-filter, project-init, sync-argument,
  store-path, event-path-component, schema-validation, write-core-field,
  write-content, write-metadata, choose-one, path-assignment, refresh cursor,
  replay-history, sensitive-content, index-stale, missing-record, store
  initialization, store/project config repair, project-selection,
  confirmation-required, sync runtime, and revise-patch failures now return structured
  `error.recovery_hint` metadata with `missing_argument`, `missing_one_of`,
  `rejected_argument`, `rejected_arguments`, `rejected_patch`,
  machine-readable `expected` rules, `discover_with`, and `retry_with`, so
  agents can recover from invalid or omitted write `kind`/`type`/`scope`/
  `project_id`, missing MCP write `type`/`scope`, omitted project context for
  project-scoped writes, empty or malformed write `content`, invalid write
  `tags`/`source.client`, `state`/`priority`/`confidence`/`confirmed`, invalid
  `provenance.*`, invalid mutation `record_id`/`target_state`/`reason`/
  `source.client`/`confirmed`/`link_type`, invalid read filters such as
  `query`/`record_ids`/`kinds`/`scopes`/`states`/`tags`/`files`/`limit`,
  and MCP empty-string, unknown enum-like, numeric range, nested
  `source.client`, or contract-backed boolean values without parsing SDK
  validation prose, because common MCP string, enum-like, numeric range,
  selected nested source-client fields, and selected boolean fields such as
  write/project-init/selected mutation confirmations now reach the Moryn
  operation validator before returning a tool error,
  invalid boot/refresh `current_task`/`default_skills`/`cursor`, invalid or
  empty project init `projectPath`/`project_id`/`tags`/`default_skills`/
  `sync.mode`/`repair`, invalid local store `storePath`, invalid event path
  components such as `event_id`/`source.device_id`, invalid record/event schema
  paths reported as `validation_issues`, invalid replay history with bad
  `event_id`/`event_op`/`record_id` and replay-only safe rebuild next actions,
  sensitive-content rejections that omit the
  detected secret value, stale derived views that should run `moryn rebuild`
  before retrying the original read and should not be trusted or manually
  edited before rebuild, missing record ids that should run
  `moryn list-recent`, select `list_recent.records_by_id.<record_id>.id`, and
  avoid inventing ids, uninitialized or invalid store/project config that
  should run `moryn init` or `moryn project init --repair` only after user
  confirmation and avoid assumed store paths, automatic config repair, or
  invented project ids, missing project paths that should not be silently
  treated as new projects, project id conflicts that should use the
  `.moryn.json` id or an explicitly approved config repair instead of retrying
  the rejected id, unknown or missing project context that should run `moryn
  project list`, select `project_list.projects_by_id.<project_id>.project_id`,
  use `project_list.projects[].project_id` as the ordered fallback, and avoid
  inventing project ids or writing project-scoped records without context,
  high-risk confirmation failures that should ask the user before
  retrying with `confirmed: true` or `--confirm` and should never auto-confirm,
  sync runtime failures that should expose safe `sync_status` next actions,
  preserve local events, collect user-authored remotes before `moryn sync init`,
  wait for conflicts or credentials to be fixed, and avoid invented remotes or unsafe
  retry loops, invalid sync
  `storePath`/`remoteUrl`/`options`/`message`, empty
  placeholders such as `--text ""`, malformed `--content-json`, malformed
  `--set path=value` assignments, managed-field revise attempts, invalid revise
  patches, conflicting write content or sync operation inputs, invalid sync
  option dependencies such as `--message` without `--push`, invalid refresh
  cursors, or hallucinated flags such as invalid `--state`, `--limit`, and
  `--confidence` without parsing English error text. Core write field failures
  and MCP/CLI write content argument failures also point at
  `operation_contract: "operations_by_id.write"` and expose `argument_sources`
  for `kind`, `type`, `scope`, `project_id`, `tags`, `state`, `priority`,
  `confidence`, `confirmed`, `source.client`, `provenance`,
  `provenance.derived_from`, `provenance.reason`, `provenance.method`,
  `provenance.promoted_at`, `text`, `content`, `content.text`,
  `content.format`, `--text`, and `--content-json`; the write contract now
  includes `content_text`, `content_format`, `source_client`, `provenance`,
  `provenance_method`, and `provenance_promoted_at` metadata, so agents can
  fetch the relevant fields before retrying, and MCP write calls now preserve
  `provenance.method`/`provenance.promoted_at` instead of dropping them before
  core validation.
- Done: Core mutation argument failures for `revise`, `promote`, `archive`,
  `quarantine`, and `link` now expose the matching
  `operation_contract: "operations_by_id.<operation>"` and `argument_sources`
  for invalid `record_id`, `linked_record_id`, `reason`, `source.client`,
  `link_type`, `confirmed`, or `target_state` values; the mutation contracts
  include nested `source_client` metadata so MCP callers can repair
  `source.client` payloads without guessing object paths.
- Done: Core read argument failures for `recall`, `boot`, `refresh`,
  `list_recent`, and `project_list` now expose the matching operation contract
  plus `argument_sources` for invalid filters, cursors, tasks, project ids, and
  limits; RFC3339 refresh cursor errors also point at
  `operations_by_id.refresh.arguments_by_name.cursor`.
- Done: CLI `--limit` parser failures for read and lifecycle startup commands
  now expose the matching operation contract and
  `operations_by_id.<operation>.arguments_by_name.limit` source before the core
  engine runs.
- Done: CLI enum parser failures for write, recall, promote, and project init
  options now expose the matching operation contract and
  `operations_by_id.<operation>.arguments_by_name.<argument>` source for the
  rejected enum value.
- Done: CLI write `--confidence` range failures and missing
  `--kind`/`--type`/`--scope` parser failures now point agents at
  `operations_by_id.write.arguments_by_name.<argument>` before write validation
  runs.
- Done: CLI required-option parser failures for `revise --set`,
  `promote --state`, `link --type`, `agent status --status`, and
  `agent finish --summary` now expose the matching operation contract and
  argument source before command action logic runs.
- Done: CLI missing positional argument parser failures for mutation record ids,
  linked record ids, and `sync init <remote>` now expose matching operation
  contracts and argument sources instead of generic command-argument advice.
- Done: CLI non-empty string failures for write text/tags/provenance, refresh
  cursors, and sync push messages, plus malformed `revise --set` assignments,
  now expose operation contract and argument source hints before lower-level
  validation runs.
- Done: CLI empty `write --reason` failures now expose
  `operations_by_id.write.arguments_by_name.reason`, matching the write
  provenance contract instead of a generic non-empty-string hint.
- Done: CLI empty `--reason` failures for `revise`, `promote`, `archive`, and
  `quarantine` now expose the matching
  `operations_by_id.<operation>.arguments_by_name.reason` source before record
  lookup runs.
- Done: CLI empty `boot --current-task` and `refresh --current-task` failures
  now expose the matching operation-specific `current_task` argument source
  before boot or refresh logic runs.
- Done: CLI empty `recall ""` query failures now expose positional `query`
  recovery backed by `operations_by_id.recall.arguments_by_name.query` instead
  of a generic non-empty-string hint.
- Done: CLI empty recall filter failures for repeatable fields such as
  `--record-id`, `--tag`, and `--file` now expose the matching
  `operations_by_id.recall.arguments_by_name.*` sources instead of generic or
  write-operation hints.
- Done: CLI empty `--project-id` and `--project` failures for `write`,
  `recall`, `boot`, and `refresh` now expose operation-specific project
  selector sources before project-context resolution runs.
- Done: `project_init` setup argument failures for path/project id/tags/default
  skills/sync mode/repair now expose `operations_by_id.project_init` recovery
  hints and argument sources; MCP `path`, `project_id`, and `sync_mode` shape
  failures pass through core validation instead of host-side schema text, and
  CLI renders the retry field as `--path`.
- Done: CLI empty `project init --tag` and `project init --default-skill`
  failures now expose project-init `tags`/`default_skills` sources instead of
  generic or write-operation hints.
- Done: `init` repair argument failures now expose `operations_by_id.init`
  recovery hints and `arguments_by_name.repair`; MCP `repair` failures pass
  through core validation instead of host-side schema text, preventing string
  truthy values from repairing local store config.
- Done: `operation_contracts.index` MCP failures now expose
  `operations_by_id.operation_contracts` recovery hints and
  `arguments_by_name.index`, so contract discovery itself remains recoverable
  when an agent sends a non-boolean index value.
- Done: `operation_contracts.operation`, `operation_contracts.mcp_tool`, and
  `operation_contracts.cli_command` MCP lookup shape failures now pass through
  core validation, including numeric values and empty strings, so agents get the
  matching `operations_by_id.operation_contracts.arguments_by_name.*` source
  instead of host-side schema text or a misleading unknown-lookup error.
- Done: Empty CLI contract lookup flags (`--operation`, `--mcp-tool`, and
  `--cli-command`) now return the same
  `operations_by_id.operation_contracts.arguments_by_name.*` recovery sources
  instead of generic non-empty string hints.
- Done: Lifecycle MCP `pull`/`push` boolean failures for `agent_enter`,
  `agent_start`, `agent_finish`, and `agent_status` now pass through core
  validation and expose operation contract argument sources instead of
  host-side schema text.
- Done: MCP `limit` failures for recall, refresh, project list, list recent,
  and lifecycle startup now pass through core validation, including non-number
  values, and expose the relevant operation contract `arguments_by_name.limit`
  source instead of host-side schema text.
- Done: MCP write `confidence` failures now pass through core validation,
  including non-number values, and expose
  `operations_by_id.write.arguments_by_name.confidence` instead of host-side
  schema text.
- Done: MCP write `kind`, `type`, `scope`, `text`, `state`, and `priority`
  shape failures now pass through core validation, including numeric values,
  and expose the matching write argument source instead of host-side schema
  text.
- Done: MCP write `content` shape failures now pass through core validation,
  including single-string content values, and expose
  `operations_by_id.write.arguments_by_name.content` instead of host-side schema
  text.
- Done: MCP write `source` shape failures now pass through core validation,
  including single-string source values, and expose
  `operations_by_id.write.arguments_by_name.source_client` instead of host-side
  schema text.
- Done: MCP write `tags` shape failures now pass through core validation,
  including single-string tag values, and expose
  `operations_by_id.write.arguments_by_name.tags` instead of host-side schema
  text.
- Done: MCP write `provenance` failures now pass through core validation,
  including non-object values and malformed `provenance.derived_from` source
  ids, and expose the write contract argument sources instead of host-side
  schema text.
- Done: MCP mutation `source` shape failures now pass through core validation,
  including single-string source values for `revise`, `promote`, `archive`,
  `quarantine`, and `link`, and expose mutation `source_client` argument
  sources instead of host-side schema text.
- Done: MCP mutation `reason` shape failures now pass through core validation,
  including numeric values for `revise`, `promote`, `archive`, and
  `quarantine`, and expose the matching
  `operations_by_id.<operation>.arguments_by_name.reason` sources instead of
  host-side schema text.
- Done: MCP `revise.patch` shape failures now pass through core validation,
  including single-string patch values, and expose `rejected_patch` recovery
  hints instead of host-side schema text.
- Done: MCP `recall.tags`, `recall.record_ids`, `recall.files`,
  `recall.kinds`, `recall.scopes`, `recall.types`, and `recall.states` shape
  failures now pass through core validation, including single-string tag,
  record id, file, kind, scope, type, and state values, and expose
  `operations_by_id.recall.arguments_by_name.tags`,
  `operations_by_id.recall.arguments_by_name.record_ids`, and
  `operations_by_id.recall.arguments_by_name.files` plus the matching
  `kinds`/`scopes`/`types`/`states` argument sources instead of host-side
  schema text.
- Done: MCP `boot.default_skills` shape failures now pass through core
  validation, including single-string skill selector values, and expose
  `operations_by_id.boot.arguments_by_name.default_skills` instead of host-side
  schema text.
- Done: MCP `boot.current_task` and `refresh.current_task` shape failures now
  pass through core validation, including numeric values, and expose
  `operations_by_id.boot.arguments_by_name.current_task` or
  `operations_by_id.refresh.arguments_by_name.current_task` instead of
  host-side schema text.
- Done: MCP `boot.sync_remote` shape failures now pass through core validation,
  including numeric values, and expose
  `operations_by_id.boot.arguments_by_name.sync_remote` instead of host-side
  schema text.
- Done: MCP `project_init.path`, `project_init.project_id`,
  `project_init.sync_mode`, `project_init.tags`, and
  `project_init.default_skills` shape failures now pass through core
  validation, including numeric path/project/sync-mode values and
  single-string tag or skill selector values, and expose the matching
  `operations_by_id.project_init.arguments_by_name.*` sources instead of
  host-side schema text.
- Done: Lifecycle CLI non-empty string failures for project/task/sync/agent
  fields, `agent_status --status`, `agent_finish --summary`, and `project list`
  prefill fields now expose operation contract and argument source hints; empty
  explicit agent prefill values are rejected instead of silently ignored.
- Done: MCP agent lifecycle identity metadata and top-level `agent` shape
  failures now pass through core validation, including single-string agent
  values, and return structured recovery hints pointing at `agent_client`,
  `agent_session_id`, `agent_model`, or `agent_device_id` operation contract
  arguments.
- Done: MCP `project_list` agent prefill identity metadata failures now pass
  through core validation, including top-level single-string agent values, and
  return structured recovery hints pointing at `agent_client`,
  `agent_session_id`, `agent_model`, or `agent_device_id` operation contract
  arguments instead of host-side MCP schema text.
- Done: MCP `project_list.current_task` and `project_list.sync_remote` shape
  failures now pass through core validation, including numeric values, and
  expose the matching `operations_by_id.project_list.arguments_by_name.*`
  sources instead of host-side schema text.
- Done: MCP `recall.query` shape failures now pass through core validation,
  including numeric values, and expose
  `operations_by_id.recall.arguments_by_name.query` instead of host-side schema
  text.
- Done: MCP `agent_status.status` and `agent_finish.summary` shape failures
  now pass through lifecycle validation, including numeric values, and expose
  the matching lifecycle `operations_by_id.<operation>.arguments_by_name.*`
  sources instead of host-side schema text or write `content.text` hints.
- Done: MCP lifecycle `current_task` shape failures for `agent_doctor`,
  `agent_guide`, `agent_enter`, `agent_start`, `agent_status`, and
  `agent_finish` now pass through lifecycle validation, including numeric
  values, and expose the matching
  `operations_by_id.<operation>.arguments_by_name.current_task` source instead
  of host-side schema text or lower-level boot/refresh/write hints.
- Done: MCP lifecycle `sync_remote` shape failures for `agent_doctor`,
  `agent_guide`, `agent_enter`, `agent_start`, `agent_status`, and
  `agent_finish` now pass through lifecycle validation, including numeric
  values, and expose the matching
  `operations_by_id.<operation>.arguments_by_name.sync_remote` source instead
  of host-side schema text.
- Done: MCP project selector shape failures for `boot`, `recall`, `write`,
  `refresh`, and lifecycle tools now pass through shared project-context
  validation, including numeric `project_id`/`project_path` values, and expose
  operation-specific argument sources plus project-list retry guidance instead
  of host-side schema text.
- Done: MCP `agent_start.refresh_since` and `agent_enter.refresh_since` shape
  failures now pass through refresh validation, including numeric values, and
  preserve `refresh_since` as the retry argument while pointing at the refresh
  cursor contract.
- Done: MCP `refresh.cursor` shape failures now pass through core validation,
  including numeric values, and expose
  `operations_by_id.refresh.arguments_by_name.cursor` instead of host-side
  schema text.
- Done: MCP write and mutation `source.session_id`, `source.model`, and
  `source.device_id` failures now pass through core validation and return
  structured recovery hints pointing at `source_session_id`, `source_model`, or
  `source_device_id` operation contract arguments.
- Done: MCP mutation `record_id` shape failures for `revise`, `promote`,
  `archive`, `quarantine`, and `link`, plus `link.linked_record_id`, now pass
  through core validation, including numeric values, and expose the matching
  `operations_by_id.<operation>.arguments_by_name.*` sources instead of
  host-side schema text.
- Done: MCP mutation `promote.target_state` and `link.link_type` shape failures
  now pass through core validation, including numeric values, and expose the
  matching operation contract sources for state enum and link-type retries.
- Done: CLI sync parser failures for conflicting `--status`/`--push`/`--pull`
  flags now return operation contracts for each selectable sync operation, and
  `--message` without `--push` points at
  `operations_by_id.sync_push.arguments_by_name.message`.
- Done: CLI empty `sync init ""` remotes now expose positional `remote`
  recovery backed by `operations_by_id.sync_init.arguments_by_name.remote`
  before Git remote initialization runs.
- Done: MCP `sync_init.remote` and `sync_push.message` shape failures now pass
  through sync validation, including numeric values, and expose
  `operations_by_id.sync_init.arguments_by_name.remote` or
  `operations_by_id.sync_push.arguments_by_name.message` instead of host-side
  schema text.
- Done: Static operation CLI interfaces expose explicit `executable` plus
  `args` fields alongside display command strings and compatibility `argv`
  arrays, with selection sources for each CLI execution field, so programmatic
  hosts can call `execFile(executable, args)` without shell splitting or quote
  reconstruction.
- Done: Runtime action templates now expose explicit CLI `executable` plus
  `args` fields and selection sources for lifecycle, guide, doctor,
  project-list, refresh, handoff, error, and warning next actions, so agents can
  execute returned recommendations without parsing command strings or guessing
  whether the action is a Moryn subcommand or a direct package bin.
- Done: Each static operation contract now repeats operation-local
  `selection_sources`, so hosts can hand a single `operations_by_id` entry or
  single-operation lookup response to an agent without losing stable
  in-operation paths. Default full-directory reverse and category indexes carry
  lightweight `{ operation, operation_source }` references back to
  `operations_by_id.<operation>` to keep the aggregate payload under the host
  budget.
- Done: Operation contracts and runtime action templates now expose
  `execution` readiness summaries with `ready_to_run`, `next_step`,
  missing required fields, `required_inputs`, `required_inputs_by_field`, and
  confirmation requirements, so agents can choose between running, collecting
  input, asking for approval, or blocking automation without recomputing policy
  from several fields.
- Done: Required-input CLI targets and assignments now preserve
  interface-specific `required_when`, so hosts can explain defaults or
  CLI-only conditions without weakening MCP required fields.
- Done: `execution.runbook.step_paths_by_step` indexes ordered runbook steps by
  step name, so agents can jump to later descriptors such as `call_mcp` or
  `ask_user_confirmation` without inferring array positions or duplicating step
  payloads. The collect step also names
  `execution.required_input_paths_by_value_path`, so hosts can jump from a
  collected `user_input.*` value path back to the canonical required-input entry.
- Done: `execution.required_inputs[]` joins required field names to argument
  paths, split alternative argument paths, argument sources, placeholders,
  required-input selection sources, MCP target argument/path/type hints, CLI
  flag/positional/repeatable/default hints, alternatives, and enum allowed values, while
  `execution.required_inputs_by_field` mirrors those entries by field name, so
  hosts can collect user input and fill MCP arguments or shell commands without
  joining `required_fields_by_name`, `arguments_by_name`, `argument_sources`,
  and operation metadata or parsing `text|content` strings.
- Done: `execution.required_input_paths_by_value_path` maps collected value
  paths, including multi-flag object subpaths, to canonical
  `execution.required_inputs_by_field.<field>` entries. The full registry path
  is exposed in the top-level operation selection sources, while operation-local
  selection sources omit registry-only lookup paths and the repeated long key to
  stay under the 1 MB host payload budget.
- Done: Structured `error.next_action` and warning `next_action` payloads expose
  `required_fields` so recovery commands no longer rely on agents parsing
  placeholders from prose.
- Done: Structured `error.next_action` and warning `next_action` payloads expose
  `interfaces.cli.command` plus `interfaces.mcp.tool` and
  `interfaces.mcp.arguments`, so failure recovery uses the same explicit
  execution contract as normal action templates.
- Done: Structured `error.next_action` and warning `next_action` payloads expose
  `required_when` and a single-step `workflow`, so recovery branches tell agents
  when to run the suggested action instead of relying on action-name guessing.
- Done: High-risk canonical write warnings expose `candidate_record_id`,
  `argument_sources.record_id`, and a `write.record.id` workflow replacement
  source, so agents can promote the created candidate without repeating the
  write or rediscovering the record id.
- Done: Successful write and mutation responses expose top-level
  `selection_sources` for returned records, events, affected record ids, linked
  record ids, and sensitive-revision quarantine events, so agents can feed the
  next mutation from stable paths instead of guessing nested result fields.
- Done: Lifecycle, guide, setup, project-discovery, error-recovery, and
  warning-recovery action templates expose `safety` metadata that explains
  `safe_to_run` with user-confirmation, authored-input, and local-config-write
  flags, so hosts can distinguish agent-authored writes from actions that need
  explicit user approval.
- Done: Lifecycle actions and guide templates mirror required field placeholders
  in `arguments` (`<status>`, `<summary>`, `<current_task>`, `<remote>`) so MCP
  agents can replace JSON fields instead of parsing command strings.
- Done: Lifecycle, guide, setup, and project-discovery actions now include
  `interfaces.cli.command` plus `interfaces.mcp.tool` and
  `interfaces.mcp.arguments`, making the intended execution transport explicit
  for CLI and MCP hosts.
- Done: `project_list.projects[].next` now exposes complete `agent_start`
  action metadata, including `safe_to_run`, `required_when`, `required_fields`,
  `safety`, and single-step `workflow`, so agents can start a selected project
  without inferring safety or timing from the command string.
- Done: Direct `project_list` responses now expose `projects_by_id` and keyed
  workflow sources, so agents can select a known project id without scanning
  the ordered project array.
- Done: Each `project_list.projects[].next` action now exposes action-local
  `selection_sources`, so selected start actions keep their keyed project,
  project-id, keyed next-action, action argument metadata, and ordered fallback
  paths when passed around independently.
- Done: Runtime lifecycle, refresh, handoff, doctor, guide, and project
  discovery action selection-source maps now include local
  `arguments_by_name.<argument>` paths, so agents can find parameter metadata
  from the selected action instead of guessing from operation names.
- Done: The same action-local selection-source maps now include
  `required_fields_by_name.<field>`,
  `execution.required_inputs_by_field.<field>`, and
  `argument_sources.<field>` paths, so agents can find authored-input
  requirements, call-ready fill targets, and existing argument provenance
  without parsing command strings.
- Done: Unknown-project and missing-context recovery workflows now add a
  `retry_original_tool_with_selected_project_id` phase sourced from
  `project_list.projects_by_id`; direct `agent_start`, `agent_status`, and
  `agent_finish` wrappers pass their original tool context into that phase, so
  agents can retry lifecycle calls without reconstructing arguments from prose.
- Done: Lifecycle `next.actions` now include `required_when` usage conditions
  so agents can choose follow-up actions without relying on array order or
  action-name guessing.
- Done: Runtime lifecycle responses now expose `next.actions_by_id` and keyed
  workflow sources, so agents can call known follow-up actions without scanning
  arrays.
- Done: Runtime lifecycle follow-up actions now include action-local
  `selection_sources` for the keyed `next.actions_by_id.<action>` template,
  action id field, and ordered `next.actions[]` fallback, so selected actions
  remain self-describing when passed around independently.
- Done: `agent_enter` project discovery now exposes `next.actions_by_project_id`
  and keyed workflow sources, so agents can choose a known project without
  relying on array order.
- Done: `agent_guide.startup` and top-level `next` now expose the same action
  metadata (`safe_to_run`, `required_when`, `required_fields`, arguments, and
  single-step `workflow`) so agents can call the recommended entrypoint without
  recombining fields.
- Done: `agent_guide.startup` and top-level `next` now include action-local
  `selection_sources` for `startup`, `next`, and
  `workflow.phases_by_name.start_or_resume`, so selected entrypoint actions
  stay self-describing outside the full guide response.
- Done: `agent_guide.guardrails[]` now exposes stable machine-readable
  anti-hallucination constraints, including forbidden behaviors, required
  behavior, and replacement actions for startup and project-discovery mistakes.
- Done: `agent_guide.guardrails_by_id` mirrors guardrails by id, so hosts can
  read a known anti-hallucination rule without scanning `guardrails[]`.
- Done: `agent_guide.workflow` now exposes the ordered startup and lifecycle
  decision track so agents know to call `startup`, prefer returned
  `agent_enter.next.actions`, and use static templates only for status,
  finish, or refresh phases.
- Done: `agent_guide.lifecycle[]` and discovered-project lifecycle templates
  now carry single-step `workflow` metadata, so hosts can execute an individual
  lifecycle template without guessing from `step` names or list order.
- Done: `agent_guide.lifecycle_by_step` and discovered-project
  `lifecycle_by_step` mirror lifecycle templates by step name, so hosts can
  choose status, finish, or refresh without scanning `lifecycle[]`.
- Done: `agent_guide.lifecycle[]` and discovered-project lifecycle templates
  now include action-local `selection_sources`, so selected static lifecycle
  steps retain their keyed step, step-id, required-input, and ordered fallback
  paths when passed around independently.
- Done: `agent_guide.selection_sources` names the stable startup, lifecycle
  action, rule, and guardrail lookup paths so hosts do not infer guide paths
  from prose.
- Done: `agent_enter.next.workflow` now exposes ordered runtime tracks for
  `start_session` and `discover_projects`, including valid follow-up response
  sources and required fields derived from returned actions.
- Done: Direct `agent_start`, `agent_status`, and `agent_finish` responses now
  include `next.workflow` derived from their `next.actions`, so every lifecycle
  entrypoint is self-describing for follow-up actions.
- Done: Setup and recovery `next` actions from `agent_doctor` and
  `agent_enter.needs_setup` now include top-level `required_when`,
  `required_fields`, and single-step `next.workflow` metadata for
  `project_init`, `project_list`, and `sync_status`.
- Done: Empty CLI agent identity flags now return concrete
  `agent_client`/`agent_session_id`/`agent_model`/`agent_device_id` argument
  sources instead of the aggregate `agent` source, so retry logic can repair the
  exact malformed lifecycle or project-list field.
- Done: Generated action CLI interfaces now fall back from nested MCP paths to
  flattened contract argument names, so hosts can pass
  `agent_client`/`agent_session_id` and still get `--agent`/`--session-id`
  without rebuilding nested objects.
- Done: Generated action MCP interfaces now normalize flattened nested contract
  fields back into tool JSON, so hosts can pass `agent_client` once and receive
  executable `interfaces.mcp.arguments.agent.client` without rebuilding nested
  objects.
- Done: Empty CLI `link --type` values now return a CLI-shaped `--type`
  recovery hint backed by `operations_by_id.link.arguments_by_name.link_type`,
  so shell agents can retry the exact flag instead of translating a lower-level
  `link_type` JSON argument error.
- Done: Empty CLI `project init --project-id` values now fail at the CLI
  boundary with a `--project-id` recovery hint backed by
  `operations_by_id.project_init.arguments_by_name.project_id`, so agents do not
  need to translate a lower-level `project_id` argument error.
- Done: Empty CLI `project init --path` values now fail at the CLI boundary
  with a `--path` recovery hint backed by
  `operations_by_id.project_init.arguments_by_name.path`, so agents do not need
  to translate a lower-level `projectPath` argument error.
- Done: Empty CLI mutation positionals now fail at the CLI boundary with
  `record-id`/`linked-record-id` recovery hints backed by the matching mutation
  `arguments_by_name` source, so agents do not need to translate lower-level
  `record_id` or `linked_record_id` argument errors.
- Done: Empty CLI `recall` query positionals now use the same positional
  recovery channel, so agents do not see a pseudo-option named `query`.
- Done: Empty CLI `sync init` remote positionals now use the same positional
  recovery channel, so agents do not see a pseudo-option named `remote`.
- Done: `npm run release:check` runs build, typecheck, tests, package-content
  safety checks, and optional private Git remote validation through
  `MORYN_PRIVATE_GIT_REMOTE`.
- Done: Release checklist is documented with the private Git remote validation
  command.
- Done: MIT license is included.
- Done: npm package metadata uses scoped package `@richardyu114/moryn`.
