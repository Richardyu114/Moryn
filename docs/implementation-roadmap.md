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
  next step, missing fields, and keyed required-input paths, plus concrete
  `full_contract_lookup` package, CLI, and MCP calls for that operation. The
  index response carries its own compact `selection_sources` for those
  index-only fields, package users can import
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
  templates. Ambiguous lookup calls that provide more than one filter now
  return `error.recovery_hint.rejected_lookup.provided` plus
  `accepted_lookup_modes`, so agents can drop the extra lookup mode and retry
  without parsing prose.
- Done: CLI and MCP required-option, option-dependency, non-empty string, enum,
  integer/number-range, JSON-object, read-filter, project-init, sync-argument,
  store-path, event-path-component, schema-validation, write-core-field,
  write-content, write-metadata, choose-one, path-assignment, refresh cursor,
  replay-history, sensitive-content, index-stale, missing-record,
  project-selection, sync runtime, and revise-patch failures now return structured
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
  invalid boot/refresh `current_task`/`default_skills`/`cursor`, invalid or
  empty project init `projectPath`/`project_id`/`tags`/`default_skills`/
  `sync.mode`/`repair`, invalid local store `storePath`, invalid event path
  components such as `event_id`/`source.device_id`, invalid record/event schema
  paths reported as `validation_issues`, invalid replay history with bad
  `event_id`/`event_op`/`record_id`, sensitive-content rejections that omit the
  detected secret value, stale derived views that should run `moryn rebuild`
  before retrying the original read, missing record ids that should run
  `moryn list-recent`, select `list_recent.records_by_id.<record_id>.id`, and
  avoid inventing ids, unknown or missing project context that should run
  `moryn project list`, select
  `project_list.projects_by_id.<project_id>.project_id`, and avoid inventing
  project ids, sync runtime failures that should inspect `moryn sync --status`,
  preserve local events, wait for conflicts or credentials to be fixed, and
  avoid unsafe retry loops, invalid sync
  `storePath`/`remoteUrl`/`options`/`message`, empty
  placeholders such as `--text ""`, malformed `--content-json`, malformed
  `--set path=value` assignments, managed-field revise attempts, invalid revise
  patches, conflicting write content or sync operation inputs, invalid sync
  option dependencies such as `--message` without `--push`, invalid refresh
  cursors, or hallucinated flags such as invalid `--state`, `--limit`, and
  `--confidence` without parsing English error text.
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
  `selection_sources`, so hosts can hand a single `operations_by_id`,
  `operations_by_mcp_tool`, or `operations_by_cli_command` entry to an agent
  without losing the stable in-operation paths. Registry-only reverse/group/list
  lookup paths remain in the top-level selection-source registry to keep the
  aggregate payload under the host budget.
- Done: Operation contracts and runtime action templates now expose
  `execution` readiness summaries with `ready_to_run`, `next_step`,
  missing required fields, `required_inputs`, `required_inputs_by_field`, and
  confirmation requirements, so agents can choose between running, collecting
  input, asking for approval, or blocking automation without recomputing policy
  from several fields.
- Done: `execution.runbook.step_paths_by_step` indexes ordered runbook steps by
  step name, so agents can jump to later descriptors such as `call_mcp` or
  `ask_user_confirmation` without inferring array positions or duplicating step
  payloads.
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
- Done: `npm run release:check` runs build, typecheck, tests, package-content
  safety checks, and optional private Git remote validation through
  `MORYN_PRIVATE_GIT_REMOTE`.
- Done: Release checklist is documented with the private Git remote validation
  command.
- Done: MIT license is included.
- Done: npm package metadata uses scoped package `@richardyu114/moryn`.
