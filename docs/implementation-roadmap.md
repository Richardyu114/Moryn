# Moryn Implementation Roadmap

This roadmap tracks the public first-version status and the next cleanup work.
Detailed protocol design lives in [moryn-design.md](moryn-design.md). Agent
usage details live in [agent-workflow.md](agent-workflow.md). Machine-readable
contracts are summarized in [contracts.md](contracts.md).

## Current Status

Moryn has reached a first-version MVP:

- TypeScript package and `moryn` CLI.
- Real stdio MCP server using the official MCP TypeScript SDK.
- Append-only event store with replayable revisions, promotions, archives,
  quarantines, and links.
- Record kinds for memory, skill, soul, session summary, and agent note.
- Recall, boot, refresh, list-recent, rebuild, and sensitive-content handling.
- Project identity from explicit input, `.moryn.json`, Git remote, Git root, and
  path fallback.
- Private Git sync with init, status, pull, push, conflict diagnostics, and
  rebuild after pull.
- Agent lifecycle commands for setup diagnosis, session start, status,
  handoff, and workflow guidance.
- Operation contracts and selection-source contracts for agent hosts.
- Package smoke tests and lifecycle smoke tests.

## First-Version Completion Criteria

- [x] Agents can connect through a real MCP stdio server.
- [x] CLI and MCP expose the same core operations.
- [x] Local store configuration is initialized and validated.
- [x] Project identity resolves from explicit input, `.moryn.json`, Git remote,
  Git root, and path fallback.
- [x] Boot returns a bounded context package for a project and task.
- [x] Recall supports project, kind, type, tag, state, text query, file, and
  record-id filters with ranking reasons.
- [x] Writes, revisions, promotions, archives, quarantines, and links are
  append-only and replayable.
- [x] Sync can initialize a user-owned Git repo, pull, commit local events,
  push, report status, and expose conflict diagnostics.
- [x] Periodic refresh can be driven by agents or scripts.
- [x] Snapshots and indexes are rebuildable from events.
- [x] Sensitive records stay out of default boot and recall.
- [x] README includes real installation and agent-connection instructions.
- [x] Tests cover core, CLI, MCP, sync, project config, package smoke, and
  cross-agent workflows.

## Completed Milestones

### Local Store and Core Engine

- Store initialization and validation.
- Append-only event writes and replay.
- Record state transitions for raw, candidate, canonical, archived, and
  quarantined records.
- Structured content support.
- Sensitive-content detection and redaction.
- Rebuildable derived snapshots and indexes.

### Recall, Boot, and Refresh

- Filtered recall with stable ranking reasons.
- Default exclusion of raw, archived, and quarantined records.
- Boot sections for profile, project context, skills, task-relevant records,
  recent changes, warnings, and sync state.
- Keyed mirrors such as `records_by_id`, `results_by_id`, and
  `changes_by_record_id`.
- Refresh importance levels and safe follow-up recall actions.

### Project Setup

- `.moryn.json` project config.
- Default project tags and skill selectors.
- Project identity resolution across explicit input, project config, Git
  remote, Git root, and path fallback.
- Project discovery for known project ids.

### Git Sync

- Sync init, status, pull, and push.
- Local-only config and generated views excluded from sync.
- Post-pull rebuild.
- Structured conflict diagnostics and safe sync recovery actions.

### Agent Lifecycle

- `agent guide`, `agent enter`, `agent doctor`, `agent start`,
  `agent status`, and `agent finish`.
- Handoff inbox and active-session detection.
- Project discovery instead of guessed project ids.
- Sync-conflict guardrails before lifecycle writes.
- Runtime `next` actions with safety metadata and execution readiness.

### Contracts and Recovery

- Static operation contracts for CLI, MCP, and package hosts.
- Compact operation index.
- Selection-source contract registry.
- Structured error and warning recovery actions.
- MCP aliases for contract-friendly and camelCase argument names.
- Unknown argument and malformed input recovery hints.

### Packaging

- Scoped package metadata: `@richardyu114/moryn`.
- MIT license.
- Packed-package smoke test.
- Release check for build, typecheck, tests, package safety, and optional
  private Git remote validation.

## Current Polish Focus

- Keep README short and public-facing.
- Keep local tool configuration out of the repository root.
- Keep implementation history concise and useful.
- Avoid shipping private memory store data or generated tarballs.
- Document large source files as refactor candidates without destabilizing the
  first-version MVP.

## Next Engineering Work

These are not required for the first MVP, but they are good next steps:

- Split `src/core/engine.ts` into smaller recall, boot, refresh, and mutation
  modules.
- Split `src/core/agent-lifecycle.ts` into diagnosis, action building, and
  lifecycle write modules.
- Split `src/mcp/server.ts` into schema, normalization, and tool-registration
  modules.
- Split large CLI and MCP test suites by command group.
- Add generated reference docs for the operation contract registry.
- Add a hosted docs site or docs index if the public API grows further.

## Out of Scope for First Version

- Hosted cloud storage.
- Multi-user server authorization.
- Browser UI.
- Non-Git sync backends.
- Full encryption or secret-management replacement.
- Semantic embeddings or remote vector search.
