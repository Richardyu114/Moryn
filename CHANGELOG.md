# Changelog

## Unreleased (v0.3 development)

Moryn v0.3 is under release preparation and is not yet the published npm
version. The development branch changes the default Codex and Claude Code path
from a user-operated capture queue to a local-first Context Autopilot lifecycle:

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
- Startup pull, finish push, abnormal-exit compensation, and offline recovery
  are local-first and preserve replayable provenance.
- Codex `Stop` remains an in-progress status signal. Claude `SessionEnd` creates
  the final handoff, while abandoned Codex sessions are recovered later by
  Finalization Assurance instead of being finalized prematurely.

### Compatibility

- Existing v0.2 stores open in place without a migration wizard or rewritten
  event history. New verified read artifacts are repaired lazily.
- The public package remains `0.2.0` until version bump, tag, push, and publish
  receive explicit release approval.

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
