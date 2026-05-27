# Memora Implementation Roadmap

This roadmap tracks the remaining work from the approved design to a usable
personal memory layer for multiple AI agents. The project should keep moving in
small, verified commits on `main`.

## Current Baseline

The repository currently has an early local MVP:

- TypeScript package and `mem` CLI.
- Append-only JSON event store.
- Record kinds for memory, skill, soul, session summary, and agent note.
- Logical revise/promote replay model.
- Basic recall, boot, list recent, and sensitive-content quarantine.
- Minimal Git status check.
- A placeholder stdio JSON server for agent access.

## Completion Criteria

Memora is functionally complete for the first product version when:

1. Agents can connect through a real MCP stdio server.
2. CLI and MCP expose the same core operations.
3. Local store configuration is initialized and validated.
4. Project identity resolves from explicit input, `.memora.json`, Git remote,
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

Replace the placeholder JSON-line server with the official Model Context
Protocol TypeScript SDK over stdio.

Deliverables:

- `mem mcp` starts a real MCP server.
- Tools: `boot`, `recall`, `write`, `revise`, `promote`, `list_recent`.
- Tool schemas validate inputs.
- MCP tests use an SDK client over stdio.
- README shows a working MCP host command.

## Phase 2: Store and Project Configuration

Make local setup predictable across machines and projects.

Deliverables:

- `mem init` writes `config.json` with device id and store version.
- `mem project init` writes `.memora.json`.
- CLI accepts `--project <path>` and resolves project identity consistently.
- Project config can add default tags, skills, and sync mode.
- Event validation happens on read and write.

## Phase 3: Recall, Boot, and Refresh Semantics

Turn raw records into useful bounded context packages.

Deliverables:

- Recall filters: record id, kind, type, state, scope, tags, project, and text.
- Ranking reasons are explicit and stable.
- Boot separates profile, project decisions, warnings, skills, recent changes,
  and sync status.
- `mem refresh` reports changes since a cursor as `silent`, `notice`, or
  `interrupt`.
- Agents can request explicit refresh through CLI or MCP.

## Phase 4: Git Sync

Implement private-repo sync as the first cross-device backend.

Deliverables:

- `mem sync init <repo-url>` creates or connects the store Git repo.
- `mem sync --pull` fetches and merges remote event history.
- `mem sync --push` commits local event files and pushes.
- `mem sync --status` reports configured remote, branch, dirty state, ahead,
  behind, and last sync.
- Generated snapshots/indexes are excluded from sync by default.
- Sync failures do not block local read/write.

## Phase 5: Derived Views

Add rebuildable snapshots and indexes for performance and correctness.

Deliverables:

- `mem rebuild` regenerates snapshots and recall indexes from events.
- Snapshots include user profile, project summaries, and skill index.
- Indexes are deterministic and safe to delete.
- Tests prove event replay is the source of truth.

## Phase 6: Cross-Agent Workflow Hardening

Make the intended product loop reliable in real use.

Deliverables:

- End-to-end tests simulate two agents sharing one store.
- Candidate promotion workflow prevents raw notes from polluting boot.
- Skill revisions keep canonical skill identity while preserving history.
- README includes Codex, Claude, Cursor, and shell-agent usage examples where
  practical.
- Release checklist and package metadata are ready for npm publication.

