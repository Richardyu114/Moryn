# Moryn Implementation Roadmap

This roadmap tracks the active v0.4 development line, currently focused on
Distilled Memory and Portable Soul, alongside the published v0.3 Context
Autopilot foundation, the v0.2 compatibility baseline, and the current product
boundaries. The source package version is
`0.4.0-dev.0`; v0.4 has not been tagged or published and remains open to
additional scope.
Detailed protocol design lives in [moryn-design.md](moryn-design.md). Agent
usage details live in [agent-workflow.md](agent-workflow.md). Machine-readable
contracts are summarized in [contracts.md](contracts.md). Dashboard usage lives
in [dashboard.md](dashboard.md). Public docs keep the product truth in
README.md, docs/moryn-design.md, docs/agent-workflow.md, docs/dashboard.md, and
docs/contracts.md. Temporary development plans are not part of the public
package.

## v0.4 development: Distilled Memory and Portable Soul

The v0.4 goal is not to retain more text. It is to keep the smallest useful,
truthful working context while accumulated evidence remains inspectable, and to
make user/agent identity portable without leaking local-only persona data.

```text
raw evidence (L0, hot/warm)
        | Session Fold: verified session coverage
        v
session rollup (L1, warm) + archived/cold source evidence
        | Episode Rollup: day/task/project epoch
        v
episode rollup (L1/L2, warm) + cold covered session rollups
        | semantic consolidation remains approval/conflict aware
        v
durable knowledge (L2)        identity and boundaries (L3)
        |                              |
        +------ token-bounded working set ------> boot / recall / host

Every rollup retains source IDs + source digests + coverage evidence.
Explicit expansion walks back toward immediate sources and leaf evidence.
```

Memory uses three independent axes. Conflating them would make compression
unsafe:

| Axis | Values | Question answered |
| --- | --- | --- |
| Abstraction | L0 evidence, L1 episodic, L2 semantic/procedural, L3 identity | What role does this memory play? |
| Trust | raw, candidate, canonical, quarantined, legacy unknown | How much should a caller rely on it? |
| Retention | hot, warm, cold, purged, plus pinned/`never_forget` | Should it enter the active working set? |

Cold means reversible archive, not deletion. Purged is a logical retention
state only: Moryn must never claim that content already committed to Git has
been physically erased from repository history.

### Memory Distillation delivery plan

1. **Bounded read model.** Infer conservative L0–L3/trust/retention views for
   legacy records, exclude cold/purged records from default retrieval, and
   enforce total and per-layer token budgets. L3, pinned, and `never_forget`
   records are mandatory; their overflow is reported rather than hidden.
2. **Session Fold.** Fold a completed session only when the final/learning
   evidence covers every eligible source. Write and read back the rollup before
   appending archive events. Mixed privacy, protected content, conflicts,
   quarantine, unique evidence, stale plans, or incomplete coverage require
   review.
3. **Episode Rollup.** Combine verified session rollups by day, task, or project
   epoch. Derive from leaf evidence to avoid summary-of-summary drift. Recent or
   unfinished sources stay warm; only old, fully covered sources become cold.
4. **Unified maintenance transaction.** Expose deterministic
   `preview -> plan -> apply -> receipt` phases with before/after record and
   token counts, coverage/privacy/sync impact, partial-resume guards, and
   append-only logical restore. Automatic physical purge is out of scope.
5. **Source expansion.** Let a caller explicitly expand any rollup under depth,
   record-count, privacy, cycle, and digest bounds. Expansion reports missing,
   changed, conflicted, or quarantined evidence instead of presenting a false
   complete history.

The compression safety floor is non-negotiable: identity, preferences, rules,
security constraints, unresolved conflicts, quarantined memory, unique
evidence, private boundaries, and unverified coverage are never silently
merged, archived, or dropped.

### Portable Soul hook-preparation plan

Moryn distinguishes **User Soul** (stable user identity, values, boundaries,
and collaboration preferences) from **Agent Persona** (the selected agent's
mission, style, and operating behavior). Profiles and clauses have stable IDs;
every draft, approval, supersession, conflict, and rollback creates a new
revision.

```text
local_saved
   -> personal_sync_saved (portable projection persisted locally)
   -> remote_pushed (personal_sync clauses only)
   -> remote_pulled_and_verified
   -> effective_compiled (user + agent + project scope + budget)
   -> host_context_prepared (SessionStart / PostCompact hook output)

host_context_prepared proves only that hook output was prepared. It does not
prove stdout transport, Host acknowledgment, or model obedience.
```

- Clauses are global or project-scoped and independently marked `local_only`
  or `personal_sync`. Local-only payloads live only under ignored `state/`
  files. A `personal_sync` event may carry only portable clauses and a
  metadata-only, integrity-checked approval attestation; status, receipts, and
  the dashboard never expose `local_only` clause text.
- Remote stages are evidence-backed rather than inferred. `remote_pushed`
  requires a successful push whose updated `origin/main` equals the inspected
  HEAD containing the exact projection event. `remote_pulled_and_verified`
  requires a completed pull or existing-remote initialization, derived rebuild,
  an exact remote/local Git blob match, valid projection integrity, and (for an
  approved revision) a portable approval chain verified without local overlays.
  The ignored `state/soul-sync/` receipts use modes `0700`/`0600`, hash the
  remote identity, and expose only metadata receipt IDs through status and the
  Dashboard.
- Activation requires explicit approval. Rollback is append-only and creates a
  new active revision. Concurrent active heads become a visible conflict, while
  compilation may use the last known good approved head.
- Effective Soul uses deterministic precedence and character/token budgets.
  Boundary and identity clauses are protected; mandatory overflow blocks
  hook-context preparation instead of silently omitting them.
- Codex and Claude Code hooks prepare the compiled Soul context at session start
  and after compaction without overwriting user-owned `AGENTS.md`, `CLAUDE.md`,
  or host configuration. Compilation and hook-preparation receipts use
  restrictive local file permissions.

### v0.4 release acceptance

| Area | Acceptance | Required evidence |
| --- | --- | --- |
| Memory model | Legacy and v2 metadata produce deterministic layer/trust/retention views; malformed metadata fails conservatively. | Retention, lifecycle, record-read-model tests. |
| Working set | Total/per-layer token budgets are hard for normal records; mandatory overflow and omitted records are explicit. | Read-model, retrieval-index, boot/recall, large-store tests. |
| Session/Episode compaction | Coverage and digest checks gate rollups; exact rollup publication/readback precedes source archival; per-event receipts distinguish confirmed, best-effort, and existing-readback durability; replay and retry are idempotent. Identical offline plans converge after Git sync, while divergent plans remain as an explicit review-required conflict. | Fold/rollup unit and transaction tests, compaction Git concurrency E2E, conflict-projection tests, and lifecycle tests. |
| Restore/expansion | Restore appends state changes and expansion remains bounded, cycle-safe, privacy-safe, and digest-aware. | Coordinator and expansion tests. |
| Semantic consolidation | Relationship-only proposals remain the default. An explicit structured merge uses exact source values, field/value lineage, trust/privacy checks, stable identities, source-digest CAS, and resumable source-hiding order. | Structured-merge planner and Engine transaction tests. |
| Portable Soul | Draft, approve, conflict fallback, distribution filtering, rollback, compilation, and metadata-only status preserve revision truth. Exact Git event blobs and projection digests gate push proof; pulled approved revisions additionally require a portable approval chain. | Soul profile/store/management tests, two-store portability E2E, and exact Git receipt E2E. |
| Hook preparation | Codex/Claude SessionStart and PostCompact prepare the selected revision for hook output, without claiming stdout transport, Host acknowledgment, or model obedience. | Host context, receipt, adapter, hook, and lifecycle tests. |
| Interfaces | Engine, CLI, MCP, operation contracts, public exports, and dashboard expose consistent fields and safety language. | CLI/MCP/contracts/package/dashboard tests. |
| Compatibility | v0.2/v0.3 stores open without event rewrites; derived artifacts rebuild lazily. | Upgrade smoke and package smoke. |
| Release | Build, typecheck, lint, full tests, pack audit, smokes, diff check, and privacy audit pass. | `npm run release:check` plus final repository audit. |

`npm run test:v04-acceptance` is the focused automated evidence gate. Its
script builds the current TypeScript sources before running the fixtures, so
child-process lease tests cannot load a stale `dist/` implementation. Its
deterministic fixtures currently establish all of the following; these numbers
are test-fixture measurements, not production telemetry:

- active session-summary reduction is `80%`, canonical preservation is `100%`,
  Recall@5 decline is `0`, protected-fact loss is `0`, and privacy leakage is
  `0`; automatic Episode Rollup also refuses a partial public day summary when
  the same bucket contains omitted private evidence;
- the store lease recovers an ownerless recovery gate and a terminated owner,
  never steals from a live owner merely because its timestamp looks stale, and
  drains nested work before release; the Git transaction fixture also proves a
  concurrent append cannot enter a blocked push and remains pending for the
  next push;
- identical dual-device Session Fold plans converge to one logical rollup with
  one event set, while divergent plans produce symmetric
  `semantic/needs_review` projections, a deterministic
  `session_fold_conflicts` diagnostic, and a `review_required` planner result
  instead of a third rollup; derived records, retrieval shards, legacy recall,
  and Engine recall preserve the same conflict annotation;
- structured semantic merge fixtures cover stable source/evidence lineage,
  trust/privacy and unsafe-field boundaries, dependency mutation, exact event
  and relationship-projection readback, partial-transaction recovery,
  same-plan retry convergence inside one local store/state-lease domain,
  quarantined recovery across the upsert-to-claim
  process-interruption window, and rejection or isolation of competing local
  candidate plans;
- Portable Soul fixtures prove cross-device Effective Soul/hook digest
  portability. `remote_pushed` requires the exact pushed Git event blob and
  projection digest, while `remote_pulled_and_verified` for an approved
  revision additionally requires the portable approval chain. Rejected pushes
  produce no push proof, and missing attestations produce no false
  pulled-and-verified proof.

These gates cover logical archive/cold/restore behavior. Physical purge remains
out of scope for v0.4: no acceptance result claims that Git history or previously
synchronized bytes were erased.

The v0.4 release-gate JSON extends the existing evidence matrix with
`memory_distillation` and `portable_soul`. `acceptance_complete: true` is only
reported when all eleven areas have their required evidence in the same run.
The external product roadmap is durably recorded in moryn-store as
`rec_3eba4797c53f4dff9e7897a0cf76a199`.

## v0.3.0 Context Autopilot

The v0.3.0 lifecycle provides simple, stable, low-intervention context
continuity for Codex and Claude Code:

```text
enter -> recall/recover -> work -> checkpoint -> compact/resume -> finish
  |           |            |          |               |             |
pull      bounded pack   learnings   durable delta   restored      handoff
safe      and gaps       captured    and optional    context       and push
```

Agents operate Moryn on the normal path. Users monitor the dashboard and step
in only for credentials, irreconcilable sync conflicts, privacy boundaries,
materially conflicting memory, ambiguous project identity, or high-impact
cross-project changes.

| Area | v0.3.0 acceptance | Required evidence |
| --- | --- | --- |
| Autopilot | Start, repeated checkpoint/compaction, resume, finish, and abnormal-exit recovery preserve the latest task state without duplicate logical records. Compact safety reads only a bounded tail of host-authored public transcript messages when the host does not supply a PreCompact summary; reasoning, developer/system instructions, tools, raw paths, and sensitive text remain excluded. | `npm run smoke:agent-lifecycle`, `npm run smoke:transcript-compact-safety`, `npm run smoke:official-host-handoff`, lifecycle tests. |
| Recall and learning | User prompts consult trusted local knowledge first; gaps remain explicit and reliable project learnings become reusable across agents and devices under deterministic policy. | Prompt-recall tests and lifecycle smoke `recall_explore_learn` receipt. |
| Working set | Recall, boot, and dashboard use bounded project-relevant candidates as append-only history grows. | `npm run smoke:large-store`. |
| Consolidation | Exact duplicates fold automatically; semantic proposals retain evidence; protected differences and conflicts are not silently merged. | Consolidation tests and lifecycle smoke receipt. |
| Sync | Enter pulls safely, checkpoint protects locally before optional push, finish pushes when safe, and failures retain executable recovery actions. | Lifecycle, resilience, conflict, permission, and large-store sync smokes. |
| Hosts | Codex and Claude Code use native lifecycle artifacts including prompt recall and pre/post-compaction recovery. Official host hooks bind to the Moryn runtime that activated them through a stable device-local launcher outside the project checkout; its runtime binding updates atomically using exact absolute Node and CLI paths, so runtime drift repairs without changing the trusted command or invoking a PATH-global Moryn. A shared 30-second Host timeout contains a 20-second cancellable operation budget and 25-second process watchdog; timed-out remote work leaves durable local evidence for later sync. The generated official commands complete a Codex -> Claude Code -> second-device Codex journey without bypassing the adapter layer. | Host artifact tests, deadline/process-group tests, cross-host lifecycle smoke, `npm run smoke:host-runtime-binding`, and `npm run smoke:official-host-handoff`. |
| Dashboard | The first screen is quiet and read-only; routine sync and maintenance stay subordinate while genuine user decisions remain visible. | Dashboard tests, real-store rendering, large-store dashboard smoke. |
| Release | Build, typecheck, full tests, package smoke, lifecycle, resilience, conflict, permission, upgrade, and large-store checks pass. | `npm run release:check`. |

The v0.3 release-gate JSON includes all nine acceptance areas and the exact
evidence completed or missing for each one. `acceptance_complete: true` means
every area's required evidence completed in that run. Fast or skipped-check
runs report `not_verified` instead of implying full acceptance.

The v0.3.0 release keeps the v0.2 disk and explicit-handoff contracts as
compatibility paths. Existing stores open in place without rewriting event
history; verified derived read artifacts repair lazily when needed.

## Current Implementation Status

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
- Native Autopilot lifecycle artifacts for Codex and Claude Code, plus
  compatibility adapters for Gemini, Cursor, and shell hosts.
- Setup wizard / one-command local setup through `moryn setup`, with dry-run
  checks by default and `--apply` limited to Moryn-local store/project config.
- Read-only `health_check` / `moryn health check` report for installation
  trust, store replay, project context, privacy boundary, and capture backlog.
- Local dashboard server and static snapshots for sync, records, recent events,
  and agent activity.
- Operation contracts and selection-source contracts for agent hosts.
- Package smoke tests and lifecycle smoke tests.

## v0.2.0 Compatibility Baseline

The published v0.2.0 path remains supported as a compatibility and explicit
handoff workflow. Its historical release narrative was:

```text
setup -> context pack -> capture -> dashboard review -> approve -> sync
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
| Approval | No unvalidated canonical writes. Reliable low-risk project Learning Deltas may become canonical through the v0.3 state policy; Capture Inbox, Review Queue, Candidate Triage, sensitive, conflicting, cross-project, and high-impact changes retain explicit approval controls with append-only evidence. | Learning state-policy tests, Safe Action Registry, stale guards, timeline evidence. |
| Sync | Private Git sync can report clean/pending/conflict, push local events, pull remote events, and leave generated views local-only. | Sync adapter tests, lifecycle tests, live `moryn sync --status`. |
| Dashboard | Dashboard first screen answers whether the user needs to act, what Moryn stores, recently saved content, and shared-copy state. Default copy is English with a Chinese language switch; read-only evidence stays folded under `More details` while `/api/dashboard` keeps the full machine-readable trail. | `tests/observability/dashboard.test.ts`, live `/api/dashboard`, browser fragment smoke. |
| Audit | Evidence remains in `/api/dashboard`; visible HTML may collapse or index evidence, but should not delete the machine-readable trail. | Docs contract, dashboard JSON smoke, release check. |
| Release gate | Typecheck, build, focused dashboard tests, docs-contract, `npm run smoke:dogfood-demo`, `npm run release:check`, diff check, package contents, dashboard restart, and clean Moryn store sync all pass. | Terminal verification and final commit summary. |

Two rules cut across every row:

- No canonical writes without deterministic scope, confidence, conflict, safety, and provenance validation.
- Evidence remains in `/api/dashboard` even when the visible UI gets quieter.

Release work follows the same implementation loop as feature work:

```text
write failing focused test
  -> implement the smallest behavior or docs change
  -> run focused verification
  -> run the release gate commands
  -> commit on main
  -> push
  -> record durable progress in moryn-store
  -> restart the dashboard when dashboard UI, API, or served docs changed
```

Additional release checks:

- Blocked setup and health checks return executable next actions, not
  prose-only troubleshooting.
- Recall quality can be measured read-only with `moryn eval recall` /
  `recall_eval`.
- `npm pack --dry-run --json` must exclude private store data, generated
  dashboard snapshots, tarballs, local-only scratch plans, and temporary
  development plans.

The final v0.2.0 release gate is:

```bash
npm run typecheck
npm test
npm run release:check
npm run smoke:dogfood-demo
npm run smoke:agent-lifecycle
npm pack --dry-run --json
git diff --check
```

Final v0.2.0 Definition of Done: the default dogfood path works end to end;
saved content is searchable without becoming a forced decision; long-term
memory writes are explicit, append-only, and auditable; setup is dry-run safe
and package-installed smoke tested; recall quality can be measured read-only;
public docs explain Moryn as a user-owned, auditable context store and handoff
layer; dashboard health and moryn-store sync are clean.

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
  installed Codex or Claude Code Autopilot
  -> enter / prompt recall / checkpoint / compact-resume / finish
  -> automatic, bounded, recoverable

Compatibility path
  moryn setup / context pack / capture session
  -> explicit transfer or unsupported-host fallback

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
- For the v0.2 autocapture path, keep automatic canonical promotion out of
  scope unless the user explicitly confirms it. The v0.3 Learning Delta path
  is governed separately by deterministic scope, confidence, conflict, safety,
  and provenance policy.
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
- Verify that private/secret/sensitive tags and legacy content privacy markers
  stay hidden by default.

Current semantic-maintenance slice:

- [x] Discover deterministic exact and semantic-overlap candidates across the
  whole current logical working set, bounded by project, privacy, threshold,
  and result limit.
- [x] Expose read-only Shadow Mode through Engine, CLI, MCP, contracts, and the
  dashboard with actual-before, guaranteed-after, and possible-after counts.
- [x] Require guaranteed consolidation to strictly reduce both current logical
  records and estimated working-set tokens; blocked candidates do not count as
  reductions.
- [x] Author a derived semantic record from evidence, prove protected-term and
  coverage preservation, and calculate its real token size.
- [x] Run at most one cumulative semantic proposal automatically at
  `agent_finish` after topic, conflict, privacy, source-digest, coverage, real
  token, and strict current-count gates pass. The receipt verifies observed
  before/after values and retains append-only source history.
- [ ] Decide from dogfood whether a periodic scheduler adds value beyond the
  lifecycle hook. Do not add a background daemon merely to create activity.

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
