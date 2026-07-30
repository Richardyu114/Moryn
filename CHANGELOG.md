# Changelog

## 0.4.0-dev.0 - Unreleased

Moryn v0.4 remains in active development. The current development line makes
accumulated memory bounded and auditable, and makes agent/user
identity portable without treating private persona text as ordinary synced
memory.

### Added

- A three-axis memory model: L0–L3 abstraction layers, independent trust state,
  and hot/warm/cold/purged retention, including pinned and `never_forget`
  safety floors.
- Deterministic record/token working-set budgets with explicit mandatory
  overflow reporting; cold and purged records stay outside normal retrieval.
- Session Fold and Episode Rollup preview/plan/apply transactions with coverage
  attestations, source digests, rollup-first publication/readback, per-event
  durability attestations, private receipts,
  stale/partial-resume guards, and append-only logical restore.
- Automatic Episode Rollup planning for complete public project/day buckets,
  plus deterministic Session Fold conflict projection for converged and
  divergent offline rollups.
- Opt-in structured semantic merge with exact field/value lineage,
  source/evidence digest guards, quarantined pre-claim publication,
  deterministic activation/promotion, and resumable same-plan retries.
- Proof-gated semantic maintenance drafts with deterministic lossless text-unit
  union, complete source coverage, final-record token projection, and at most
  one automatic public project merge per `agent_finish`.
- Bounded source expansion from a rollup to immediate sources and leaf evidence,
  including cycle, digest, privacy, conflict, and quarantine reporting.
- Versioned User Soul and Agent Persona profiles with global/project clauses,
  `local_only` and `personal_sync` distribution, explicit approval, conflict
  fallback, rollback, deterministic Effective Soul budgets, and metadata-only
  status.
- Codex and Claude Code Soul context preparation at session start and after
  compaction. `host_context_prepared` and proof scope
  `hook_output_prepared_not_host_acknowledged_or_obedience` mean only that
  bounded hook output was prepared; they do not prove stdout transport, Host
  acknowledgment, or model obedience.
- Read-only Dashboard Memory Maintenance and Soul Studio projections, plus CLI,
  MCP, operation-contract, and public TypeScript surfaces for v0.4 workflows.
- A content-bearing Dashboard memory-status projection that separates current,
  historical, quarantined, pending-learning, and organized-old-version content,
  plus an allowlisted Collaboration Preferences view for selected
  `personal_sync` Soul text.
- Cross-process store-state leases around append, derived-view, compaction, and
  Git transactions. Soul Git receipts bind exact pushed/pulled commits, event
  blobs, projection digests, and the effective fetch or push remote identity.
- Stable device-local launchers for official Codex and Claude Code hooks, with
  bounded stdin, absolute operation deadlines, process-group termination, and
  a final host-safe watchdog so missing runtimes or stuck remote helpers do not
  become recurring user-visible Hook failures. Native Windows retains the
  prior direct absolute runtime command instead of receiving an unusable POSIX
  launcher.
- Automation-safe status and reconcile APIs, opaque composite refresh cursors,
  project-scoped recent-record reads, mutation idempotency receipts, normalized
  CLI/MCP outcomes, bounded cancellation propagation, durable Hook timeout
  receipts, and a supervised systemd user service for the Dashboard.

### Changed

- Dashboard Overview, charts, saved-content search, learning status, and
  organization status now share the current-project-plus-global scope. Learning
  Inbox candidates no longer count as absorbed conclusions, compaction is shown
  as concrete old/current text instead of a percentage, and search reports its
  total scope and lifecycle breakdown.
- Collaboration Preferences is a first-class Dashboard view. It renders only
  selected portable text; `local_only`, private, and other-project Soul content
  remains excluded even when ordinary private records are explicitly enabled.
- Memory Shadow now distinguishes authored merge proofs from similarity-only
  candidates and reports observed record/token decreases without exposing the
  synthesized text in CLI, MCP, or Dashboard receipts.
- Host activation now treats missing, stale, unsafe, or unavailable runtime
  launchers as actionable health failures. Applying activation also replaces
  historical or mis-scoped official Moryn Hook identities in the same
  project-local host file while preserving non-Moryn user hooks in a
  content-addressed, device-private backup outside Git worktrees. Runtime
  launcher identities now include a collision-resistant project digest and a
  full canonical project/Store scope, while remaining stable across runtime
  upgrades.
- Setup and install apply only Moryn-local configuration by default; host file
  changes now require the separate explicit `activate_host` permission. Slow
  optional lifecycle work is reported as deferred after the local write is
  durable instead of turning a committed mutation into an ambiguous failure.
- MCP deadline responses preserve a mutation's committed result, external
  cancellation remains distinguishable from deadline expiry through child
  process cleanup, and automation does not recommend blindly replaying a
  committed mutation that had no idempotency key.
- Missing-record recovery keeps an explicit project scope when available and
  otherwise requests an explicit all-projects recent-record search. Explicit
  private-read authorization is preserved, and discovery no longer falls back
  silently to the global-only default scope.

### Safety and compatibility

- Archive/cold is reversible. Physical purge is not part of automatic
  compaction, and Moryn does not claim that an event can be removed from Git
  history once synchronized.
- Identity, rules, safety boundaries, conflicts, quarantined records, unique
  evidence, private boundaries, and unverified coverage are never silently
  compressed or discarded.
- Local full Soul payloads and local transaction/approval/hook-preparation
  receipt copies remain under ignored `state/` paths with restrictive
  permissions. A synchronized `personal_sync` event contains only portable
  clauses plus a metadata-only, integrity-checked approval attestation; it never
  contains `local_only` clause text.
- Git sync fails closed before checkout, rebase, or push when local or remote
  reachable history has ever contained `config.json`, `.moryn/`, `snapshots/`,
  `indexes/`, or `state/`; deleting those paths only from the tip is not a
  privacy-history rewrite.
- Git sync treats those local-only paths case-insensitively and rejects commit
  trees containing symlinks or gitlinks before materializing them. Derived
  project snapshots hash unsafe filesystem identifiers instead of using them as
  paths.
- Project config and Codex/Claude activation writes reject path escapes,
  symlinked targets, and symlinked parent or backup directories; generated
  files are replaced atomically inside the real project root. New host-config
  backups live outside checkouts with `0700` directories and `0600` files;
  legacy project-local backup directories are permission-hardened and
  Git-ignored on activation. Already tracked legacy backups still require
  explicit index and, if secret-bearing, history remediation.
- Sensitive host compact summaries and assistant fallbacks are never persisted
  as plain session evidence. Deadline-aware Git helpers terminate their full
  POSIX process group, and lease cleanup runs outside an expired operation
  budget without hiding a simultaneous work failure.
- New sensitive revisions persist explicit redaction evidence instead of
  inferring it from user-authored placeholder text, while legacy partial
  revisions are re-evaluated against their event-time record content. Literal
  `[REDACTED...]` documentation no longer triggers accidental quarantine.
- Production dependency resolutions include the current `body-parser`, Hono,
  and `fast-uri` security fixes. Until the MCP SDK accepts Hono's safe 2.x
  adapter range directly, the root development install applies a scoped
  `@hono/node-server` 2.0.11 override and verifies it with a real Streamable
  HTTP initialization request.
- Existing v0.2/v0.3 event history opens in place. Retention metadata is
  additive, legacy memory receives conservative defaults, and derived indexes
  rebuild lazily.

## 0.3.0 - 2026-07-18

Moryn v0.3 changes the default Codex and Claude Code path from a user-operated
capture queue to a local-first Context Autopilot lifecycle:

```text
install -> enter/recover -> work/checkpoint -> compact/resume -> finish/sync
```

### Added

- Official Codex and Claude Code lifecycle hooks with runtime-bound activation,
  compaction checkpoints, post-compaction restore, and cross-host handoff.
- Learning Inbox and the one-call `learn` operation. Supported conclusions are
  queued once, consumed automatically by checkpoint or finish, deduplicated,
  consolidated, and made reusable across agents and devices.
- Finalization Assurance, which seals an unfinalized prior Codex session on the
  next same-host startup when durable checkpoint or status evidence exists.
- Bounded context packs, explicit knowledge-gap outcomes, logical-memory
  relationships, agent-authored semantic consolidation, and large-store
  capacity evidence.
- Machine-readable nine-area v0.3 acceptance evidence and dedicated host,
  compact-safety, Learning Inbox, finalization, upgrade, sync, permission,
  conflict, and large-store smokes.

### Changed

- The dashboard is a quiet read-only monitoring surface. Healthy operation does
  not create a routine approval queue; exceptional attention remains visible
  with technical evidence behind progressive disclosure.
- Maintenance decisions name the exact operation and record count, explain why
  review is needed, show representative affected content and privacy scope, and
  provide a browser-session-only `Not now` action that does not write the store.
- Startup pull, finish push, abnormal-exit compensation, and offline recovery
  are local-first and preserve replayable provenance.
- Codex `Stop` remains an in-progress status signal. Claude `SessionEnd` creates
  the final handoff, while abandoned Codex sessions are recovered later by
  Finalization Assurance instead of being finalized prematurely.

### Compatibility

- Existing v0.2 stores open in place without a migration wizard or rewritten
  event history. New verified read artifacts are repaired lazily.
- The v0.2 Handoff Pack and explicit lifecycle commands remain available for
  compatibility hosts and manual recovery workflows.

## 0.2.0

Moryn v0.2.0 closes the first public release path around one default flow:

```text
setup -> context pack -> capture -> dashboard review -> approve -> sync
```

The release keeps Moryn focused as a local-first, user-owned, auditable context
store and handoff layer. It is not an agent platform, not a vector-memory SDK,
and not a hosted cloud service.

### Added

- `moryn setup` dry-run and safe `--apply` local setup path.
- Handoff Pack v0.2 through `moryn context pack`, including quality-gate
  evidence and required capture action.
- Auditable autocapture policy for low-risk handoffs, review-routed handoffs,
  and policy-archived smoke or duplicate captures.
- Dashboard review surfaces for Capture Inbox, Review Queue, Candidate Triage,
  visible saved-content search, recently saved content, and Shared copy status.
- Read-only `moryn eval recall` / `recall_eval` reports for golden queries,
  expected record ids, privacy checks, ranking reasons, and safe follow-up
  inspection actions.
- Dogfood demo and agent lifecycle smoke commands for the v0.2 default path.

### Changed

- Public docs now present the default path first and keep advanced governance
  surfaces optional.
- The dashboard first screen answers whether the user needs to act, what Moryn
  stores, what was recently saved, and whether the Shared copy is current.
- Release checks reject private store data, local-only scratch plans, temporary
  development plans, generated dashboard snapshots, and tarballs from package
  contents.

### Safety

- No silent canonical memory writes. Long-term memory changes require explicit
  Capture Inbox, Review Queue, or Candidate Triage approval.
- Evidence remains append-only and available through `/api/dashboard` even when
  the visible dashboard folds routine technical details.
- Private, secret, and sensitive records stay out of default recall, boot,
  lifecycle reports, and dashboard reads unless explicitly requested.
