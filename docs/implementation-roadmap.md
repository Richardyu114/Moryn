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
- Done: `moryn refresh` reports changes since a cursor as `silent`, `notice`, or
  `interrupt`.
- Done: `current_task` narrows refresh interrupts to related blockers, warnings,
  conflicts, and high-priority changes.
- Done: Agents can request explicit refresh through CLI or MCP.
- Done: Explicit scope filtering is supported in core, CLI, and MCP recall.
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
- Done: `moryn sync --status` reports configured remote, branch, dirty state, ahead,
  behind, and last sync.
- Done: `moryn sync --status` reports structured conflict diagnostics after a
  failed pull or push so agents do not infer recovery from a dirty worktree.
- Done: Agent lifecycle entrypoints, status checkpoints, and finish handoffs
  stop before lifecycle writes when sync is conflicted and return a structured
  `sync_status` recovery action.
- Done: Agent lifecycle partial sync failures include structured
  `*_error_details` recovery contracts alongside legacy error strings.
- Done: `agent_doctor` returns an explicit readiness summary so agents do not
  infer startup safety from raw checks.
- Done: Generated snapshots/indexes are excluded from sync by default.
- Done: Local `config.json` is excluded from sync to avoid device identity conflicts.
- Done: Post-pull snapshot/index rebuild runs after successful pull.

## Phase 5: Derived Views

Add rebuildable snapshots and indexes for performance and correctness.

Deliverables:

- Done: `moryn rebuild` regenerates snapshots and recall indexes from events.
- Done: Snapshots include user profile, project summaries, and skill index.
- Done: Indexes are deterministic and safe to delete.
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
  required fields, and arguments so agents can start or recover without
  recombining nested objects.
- Done: Structured `error.next_action` and warning `next_action` payloads expose
  `required_fields` so recovery commands no longer rely on agents parsing
  placeholders from prose.
- Done: Lifecycle actions and guide templates mirror required field placeholders
  in `arguments` (`<status>`, `<summary>`, `<current_task>`, `<remote>`) so MCP
  agents can replace JSON fields instead of parsing command strings.
- Done: Lifecycle `next.actions` now include `required_when` usage conditions
  so agents can choose follow-up actions without relying on array order or
  action-name guessing.
- Done: `agent_guide.startup` and top-level `next` now expose the same action
  metadata (`safe_to_run`, `required_when`, `required_fields`, arguments) so
  agents can call the recommended entrypoint without recombining fields.
- Done: `agent_guide.guardrails[]` now exposes stable machine-readable
  anti-hallucination constraints, including forbidden behaviors, required
  behavior, and replacement actions for startup and project-discovery mistakes.
- Done: `agent_guide.workflow` now exposes the ordered startup and lifecycle
  decision track so agents know to call `startup`, prefer returned
  `agent_enter.next.actions`, and use static templates only for status,
  finish, or refresh phases.
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
