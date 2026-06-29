# Moryn Implementation Roadmap

This roadmap tracks the public first-version status and the next cleanup work.
Detailed protocol design lives in [moryn-design.md](moryn-design.md). Agent
usage details live in [agent-workflow.md](agent-workflow.md). Machine-readable
contracts are summarized in [contracts.md](contracts.md). Dashboard usage lives
in [dashboard.md](dashboard.md). The executable v0.2 phase plan lives in
[v0.2-phase-plan.md](v0.2-phase-plan.md).

## Current Status

Moryn has reached a first-version MVP for a multi-agent, multi-device memory
store:

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
- Host adapter registry and autocapture path for Codex, Claude, Gemini,
  Cursor, and shell hosts through `moryn install`, `moryn context pack`, and
  `moryn capture session`.
- Setup wizard / one-command local setup through `moryn setup`, with dry-run
  checks by default and `--apply` limited to Moryn-local store/project config.
- Read-only `health_check` / `moryn health check` report for installation
  trust, store replay, project context, privacy boundary, and capture backlog.
- Local dashboard server and static snapshots for sync, records, recent events,
  and agent activity.
- Operation contracts and selection-source contracts for agent hosts.
- Package smoke tests and lifecycle smoke tests.

## v0.2.0 Acceptance Matrix

v0.2.0 is release-ready only when the default dogfood path is simple and the
power surfaces stay optional. The release narrative is:

```text
setup -> context pack -> capture -> review -> approve -> sync
  |          |             |          |          |       |
local     useful      automatic   grouped    explicit  portable
dry-run   handoff     evidence    decision   append    user-owned
```

| Area | Acceptance | Evidence |
| --- | --- | --- |
| Setup | `moryn setup` stays dry-run by default; `--apply` writes only Moryn-local store/project config. | `tests/cli/cli.test.ts`, `tests/mcp/server.test.ts`, docs contract. |
| Context pack | `moryn context pack` returns Handoff Pack v0.2 with quality gate, evidence paths, and required capture action. | CLI/MCP tests, `npm run smoke:dogfood-demo`. |
| Capture | Low-risk handoffs auto-capture as local evidence; risky or durable handoffs enter Capture Inbox. | Capture policy tests and dashboard smoke evidence. |
| Review | Capture Inbox groups decisions by source/session/project/day; Review Queue and Candidate Triage use the same approval brief language. | Dashboard tests and `/api/dashboard.decision_summary`. |
| Approval | No silent canonical writes. Canonical memory changes only happen through explicit Capture Inbox, Review Queue, or Candidate Triage approval controls with append-only events. | Safe Action Registry, stale guards, timeline evidence. |
| Sync | Private Git sync can report clean/pending/conflict, push local events, pull remote events, and leave generated views local-only. | Sync adapter tests, lifecycle tests, live `moryn sync --status`. |
| Dashboard | Dashboard first screen answers whether the user needs to act, what Moryn remembers, recent local state, and shared-copy state. Default copy is English with a Chinese language switch; read-only evidence stays folded under `More details` while `/api/dashboard` keeps the full machine-readable trail. | `tests/observability/dashboard.test.ts`, live `/api/dashboard`, browser fragment smoke. |
| Audit | Evidence remains in `/api/dashboard`; visible HTML may collapse or index evidence, but should not delete the machine-readable trail. | Docs contract, dashboard JSON smoke, release check. |
| Release gate | Typecheck, build, focused dashboard tests, docs-contract, `npm run smoke:dogfood-demo`, `npm run release:check`, diff check, package contents, dashboard restart, and clean Moryn store sync all pass. | Terminal verification and final commit summary. |

Two rules cut across every row:

- No silent canonical writes.
- Evidence remains in `/api/dashboard` even when the visible UI gets quieter.

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
- [x] Host adapter setup planning, startup context packs, and session
  autocapture work through CLI and MCP.
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
- `moryn setup` one-command local setup wizard with no dry-run writes and no
  host configuration file mutation.

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

### Host adapter registry and autocapture

- Host descriptors for Codex, Claude, Gemini, Cursor, and shell agents.
- `moryn setup` readiness checks and safe local apply path before host adapter
  use.
- `moryn install` safe setup planning with host-specific MCP registration
  hints.
- `moryn context pack` startup context that bundles Handoff Pack v0.2, boot
  context, refresh changes, raw handoff evidence, a read-only quality gate, and
  a required capture next action.
- `moryn capture session` session-summary autocapture with normalized
  `source.client` and `host:<client>` tags.
- `default_autocapture_policy` auto-captures low-risk handoffs, routes risky or
  durable handoffs to Capture Inbox, and policy-archives obvious smoke/test or
  duplicate captures.
- Read-only `capture_policy` / `moryn capture policy` audit report for
  explaining capture/review/archive decisions without adding another mutation
  path.
- Read-only `health_check` / `moryn health check` report for checking local
  installation and store readiness without adding a repair executor.
- CLI and MCP exposure for install, context pack, capture session, and capture
  policy audit.

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

- Make agent and dashboard startup overview-first: compact read-only summaries
  should point to evidence sources instead of forcing agents or users to scan
  every detailed panel first.
- Keep README short and public-facing.
- Keep local tool configuration out of the repository root.
- Keep implementation history concise and useful.
- Avoid shipping private memory store data or generated tarballs.
- Document large source files as refactor candidates without destabilizing the
  first-version MVP.

## Product Positioning Guardrail

Moryn is a local-first, user-owned, auditable context store and handoff layer
for agents. It is not an agent platform, not a vector-memory SDK, and
not a hosted cloud service. Agents remain clients of the store; the durable
context belongs to the user and can move across agents, devices, and projects.

```text
Default path
  moryn setup / context pack / capture / recall
  -> fast, boring, hard to misuse

Power path
  review / timeline / memory doctor / memory lifecycle / dogfood report / eval / sync repair / dashboard
  -> optional, auditable, useful when the user needs governance

Core boundary
  append-only events / recall / state transitions / sync / project identity
  privacy boundary / lifecycle handoff
  -> stable substrate, not a growing agent runtime
```

Phase decision gate: before starting any larger phase, check whether the work
strengthens automatic-but-auditable capture, memory governance, installation
trust, recall quality, public clarity, or sync reliability without making the
default path heavier. If a phase mostly expands Moryn toward a general agent
runtime, hosted service, vector database, or broad RAG product, defer it.

```text
Candidate phase
      |
      v
Does it reinforce the user-owned context store?
      | yes
      v
Can it stay optional or keep the daily path simple?
      | yes
      v
Can it be verified with contracts, tests, docs, and dogfood?
      | yes
      v
Implement in a focused slice

Any "no" -> defer, redesign, or keep as documentation only
```

### Phase 1: Auditable Autocapture

Do not start this phase until the host-specific capture path can stay
reviewable by default. The goal is better capture reliability, not background
memory writes that silently become canonical.

- Build only if it produces raw or candidate capture records with source,
  project, task, summary, touched files, and risk tags.
- Keep automatic canonical promotion out of scope unless the user explicitly
  confirms it.
- Prefer host adapter hints and reversible local hooks over opaque background
  services.
- Verify with CLI, MCP, package smoke, and dashboard/private-boundary tests.

### Phase 2: Memory Governance

Do not start this phase until there are enough candidate, conflict, stale, or
duplicate records in dogfood data to justify a new surface. The goal is trust,
not another dashboard tab.

- Start with review inbox, memory doctor, and memory lifecycle output before
  adding broad editing workflows.
- Preserve old records through archive, revise, link, or supersede metadata
  instead of destructive merge.
- Keep machine-readable actions for promote, archive, quarantine, revise, and
  timeline follow-up.
- Verify that private, secret, and sensitive records stay hidden by default.

### Phase 3: Setup Wizard

Do not start this phase until normal agent install still requires too much
manual command selection. The goal is a safe one-command path, not host config
magic.

- [x] `moryn setup` returns a dry-run setup plan with store, project, sync, and
  host-adapter checks.
- [x] `moryn setup --apply` initializes only Moryn-local store/project config
  and leaves host configuration files manual.
- [x] CLI, MCP, operation contracts, and selection-source contracts expose the
  setup wizard.
- Dry-run must list every planned local change.
- Apply must only perform approved Moryn-local or documented host setup.
- Any host mutation needs a rollback receipt and a smoke test.
- Failure output must include executable next actions rather than prose-only
  troubleshooting.

### Phase 4: Recall Eval

Do not start this phase until recall quality is difficult to judge from normal
ranking reasons and dogfood queries. The goal is measurable recall quality, not
turning Moryn into a vector-memory SDK.

- [x] Minimal read-only `recall_eval` / `moryn eval recall` path for golden
  queries, expected record ids, privacy checks, ranking reasons, provenance
  method, and read-only follow-up recall commands.
- Start with golden queries, expected record ids, privacy checks, freshness,
  conflict detection, and provenance coverage.
- Optional semantic or embedding indexes must be plugins, not required core.
- Reports should recommend memory hygiene actions such as revise, archive,
  promote, or add tags.

### Phase 5: Public Polish

Do not start this phase until the product story or onboarding causes confusion.
The goal is clearer adoption, not marketing bulk.

- Keep README short and show one multi-agent handoff demo.
- Add examples only when they are runnable and covered by smoke-style checks.
- Compare with adjacent tools by positioning, not by claiming feature parity.
- Preserve the phrase: user-owned, auditable context store and handoff layer.

### Phase 6: Release Gate

Do not start this phase as a separate feature. It is the checklist that closes
any release-worthy slice.

- Run typecheck, tests, build, release check, lifecycle smoke, and diff check.
- Confirm package contents exclude local-only docs and memory-store data.
- Confirm public docs describe any new command and its contracts.
- Confirm Moryn store sync is clean after durable memory writes.

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
