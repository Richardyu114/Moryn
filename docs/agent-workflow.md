# Agent Workflow

Moryn exposes a lifecycle protocol for agents that need reliable setup,
context bootstrapping, status updates, and handoffs across tools. The store is
multi-agent and multi-device: host identity is provenance, while memory,
skills, session summaries, and handoff context belong to the user-owned Moryn
store.

The short version:

1. Use `agent enter` when a session starts.
2. Use `agent status` during meaningful long-running work.
3. Use `refresh` when checking for new context without a full restart.
4. Use `timeline` when a recalled record needs surrounding event context.
5. Use `memory doctor` when memory quality or project identity looks stale.
6. Use `agent finish` before stopping or handing off.
7. Follow returned `next` actions instead of inventing command sequences.

Official Codex and Claude Code sessions use the Autopilot lifecycle by default:

```text
install -> enter/recover -> work/checkpoint -> compact/resume -> finish/sync
```

Installed hooks protect compaction and turn/session boundaries. `context pack`
and `capture session` remain useful explicit transfer and compatibility tools,
especially for hosts without official lifecycle integration; they are not a
routine user-operated approval loop for Codex or Claude Code.

## Host Adapter Flow

For unsupported hosts or an explicit manual transfer, the compatibility path is:

```bash
moryn setup --host codex --project .
moryn setup --host codex --project . --apply
moryn install --host codex --project . --apply
moryn context pack --project . --agent codex --current-task "current task"
moryn capture session --project . --agent codex --summary "handoff summary"
```

ASCII view:

```text
Codex / Claude / Gemini / Cursor / shell
        |
        |  moryn setup
        v
dry-run by default; --apply writes only Moryn-local store/project config
        |
        |  moryn install
        v
Host adapter plan + MCP registration hints
        |
        |  moryn context pack
        v
Handoff Pack v0.2 + quality gate + evidence + capture_session
        |
        |  work happens in the host
        v
moryn capture session
        |
        v
session_summary tagged autocapture + host:<client>
        |
        v
default_autocapture_policy archives obvious noise or duplicate captures
        |
        v
Capture policy retains low-risk handoff evidence or routes exceptional review
```

`context pack` is intentionally a convenience wrapper around the same Moryn
core and lifecycle data. Its top-level `handoff_pack` v2 is the fast path for
agent handoff: `current_goal`, `recent_decisions`, `open_threads`, `risks`,
`user_preferences`, `important_files`, and `next_actions`. Its read-only
`quality_gate` marks the pack `ready` or `needs_review` using stable checks for
current goal, recent decisions, open threads, risks, evidence paths, and the
required `capture_session` action. Each item points back to raw evidence in
`sections.boot`, `sections.refresh`, `sections.handoff`, or `next`. Use
`agent enter`, `agent start`, `agent status`, and `agent finish` when a host
needs fuller setup diagnosis, status checkpoints, explicit sync push behavior,
or detailed lifecycle action templates.

`moryn setup` is the auditable one-command setup wizard. The default dry-run
lists `checks_by_id`, `planned_writes_by_id` with exact local paths, planned
local actions, and the next command without writing anything. Run setup once
without `--apply` first so the agent or user can inspect checks and planned
local writes before any file changes. Each planned write points back to its
action source so blocked setup can be recovered without guessing from prose.
`--apply` initializes the local Moryn store and optional project config only.
Host activation is handled separately by `moryn install --apply`, or
automatically once by `agent enter` when the selected host is safely
repairable. The host configuration files are changed only under the documented
host-specific safety rules. Claude Code hooks are merged into
`.claude/settings.local.json`.
Codex hooks are merged automatically with Moryn-owned entries into
`.codex/hooks.json`; `.codex/config.toml` remains untouched. Both paths use
content-addressed backups and atomic replacement while preserving unrelated
host settings. Codex requires one exceptional host-side step: use `/hooks` once
to review and trust the project hooks. Moryn never bypasses that trust check.

Codex `Stop` is turn-scoped, so Moryn records it as a status rather than a final
handoff. During the active-session window it appears only as coordination
context. After the active-session window expires, the latest status without a
newer final summary is recovered into the next agent's handoff inbox. This
preserves an interrupted Codex session without turning every completed turn
into a noisy final handoff.

When a turn has no durable checkpoint or authored summary, Moryn records the
activation receipt but skips the empty status write. This keeps hook health
auditable without filling the event store and Git history with repeated
minimal-fallback summaries.

High-frequency Codex Stop receipts are coalesced to one receipt per session and
UTC hour. Session start, compaction, resume, and final-session boundary receipts
retain exact event timing because they are lower-frequency lifecycle evidence.

Automatic Stop status writes are also logically coalesced. If the latest status
for the same project, host, session, and device has the same bounded synthesis
fingerprint, Moryn reuses that status instead of appending another event. A
changed task, checkpoint evidence, decision, blocker, learning, or next step
creates a new status. Remote sync cadence remains independent, so an unchanged
Stop can still perform a due push without growing append-only history.

Official `SessionEnd` delivery is idempotent at the logical handoff layer. If
the latest final summary for the same project, host, session, and device has the
same complete synthesis fingerprint, Moryn reuses it instead of appending a
second inbox item. The fingerprint includes host-authored summary text, so a
changed final summary remains a new handoff. Explicit push can still synchronize
an unchanged replay without creating another summary event.

SessionEnd idempotency covers the complete authored payload, not summary text
alone. Normalized Learning Deltas and semantic consolidation proposals are part
of the persisted payload fingerprint. New knowledge or a new proposal therefore
runs the finish ingestion path even when the visible summary is unchanged.
Legacy summaries without this fingerprint are handled conservatively and do
not suppress a new finish.

## Startup

Use `agent enter` as the default entrypoint:

```bash
moryn agent enter \
  --project . \
  --sync-remote git@github.com:yourname/moryn-store.git \
  --current-task "current task" \
  --agent codex
```

Use a stable host-specific value for `--agent`. Codex should use `codex`,
Claude should use `claude`, Kimi should use `kimi`, and Gemini should use
`gemini`. The same identity should be used as `source.client` on direct write,
revise, promote, archive, quarantine, and link calls. Avoid generic values such
as `agent`, `cli`, or `mcp` when the real host is known; those values are useful
only as local transport fallbacks and show up as `Moryn Local` in dashboard
agent activity. Host variants such as `codex-cli`, `claude-code`, and `kimi-k2`
are normalized to their agent family.

`agent enter` first runs setup diagnosis. If the target project is known, it
starts the session by pulling sync, booting context, refreshing recent changes,
and returning handoff data. If project context is unclear but the store contains
known projects, it returns project discovery results with executable
`agent_start` actions for each project.

For Claude Code, `agent enter` also performs at most one automatic activation
repair when the inspector proves the change is reversible and Moryn-owned. An
invalid, symlinked, non-regular, or otherwise unsafe settings target is never
overwritten; startup continues with degraded activation evidence instead of
blocking recall and recovery. Codex activation stays read-only until a real hook
receipt proves the runtime integration is active.

Before host compaction, lifecycle hooks checkpoint durable learning, current
progress, and unresolved knowledge investigations with explicit next steps.
After compaction, Moryn restores that recovery context. Agents should also call
the same checkpoint path proactively when context pressure is visible rather
than waiting for the host to discard conversation state.

When `agent enter` starts a known project, read `startup_overview` first. It is
the compact startup path for agents: readiness status, project id, the primary
next step, explicit write boundary, and evidence pointers back to
`start.boot`, `start.refresh`, `start.handoff`, and `next.actions_by_id`. Use
those evidence sources when you need details; do not manually reconstruct a
startup sequence from lower-level calls.

Routine recovered context is marked `available`, not `review`, and does not
turn startup into a user approval step. The primary lifecycle action is owned
by the agent. `requires_authored_input` means the agent must compose the
lifecycle summary; it does not mean the user must supply it. `needs_attention`
is reserved for genuine warning or interrupt evidence that the agent must
inspect before continuing, with user intervention requested only when the
underlying exceptional condition actually requires a human decision.

Routine `agent_status` and `agent_finish` actions use
`agent_authored.status` and `agent_authored.summary`. A missing field keeps the
action in `collect_required_fields` while the agent composes concise semantic
text. Once the agent has composed the required field, it can run the returned
lifecycle action without routine user approval. This ownership does not bypass
project identity checks, sync-conflict recovery, privacy boundaries, or any
separate action that explicitly requires user confirmation.

For read-only setup checks, call:

```bash
moryn agent doctor --project . --sync-remote git@github.com:yourname/moryn-store.git
```

`agent doctor` reports store readiness, project identity, sync readiness, and
the next safe action. It avoids lifecycle writes when sync is conflicted or
project identity is ambiguous.

## Project Discovery

When no project is known:

```bash
moryn agent enter \
  --sync-remote git@github.com:yourname/moryn-store.git \
  --current-task "current task" \
  --agent codex
```

The response can include `project_list` results and `projects_by_id`, keyed by
project id. Automation should choose from returned project ids rather than
guessing a new one. Once selected, run the returned `agent_start` action or pass
the chosen project id explicitly.

## Boot Context

`agent start` returns a bounded context package:

```bash
moryn agent start \
  --project . \
  --sync-remote git@github.com:yourname/moryn-store.git \
  --current-task "current task" \
  --agent codex
```

The direct `agent start` response also includes `startup_overview`. It is
read-first and has no mutation side effects. Follow its `primary_next_step` and
`signals` before diving into the larger boot, refresh, or handoff payloads.

The response includes:

- boot context for profile, project decisions, warnings, skills, task-relevant
  records, and recent changes
- refresh results since an optional cursor
- handoff inbox from prior sessions
- active sessions from other agents
- machine-readable next actions for status, finish, and refresh

Boot and handoff responses include keyed mirrors such as `records_by_id`,
`skills_by_id`, `recent_changes_by_id`, `handoff.inbox_by_record_id`, and
`handoff.active_sessions_by_record_id` so hosts do not need to scan arrays.

## Status Updates

For long-running work, write an in-progress status checkpoint:

```bash
moryn agent status \
  --project . \
  --sync-remote git@github.com:yourname/moryn-store.git \
  --current-task "current task" \
  --agent codex \
  --status "Currently tracing the failing release check."
```

Status records let another agent see active work before the final handoff. They
expire after a bounded window so stale sessions do not appear active forever.

## Refresh

Use `refresh` to inspect changes since a cursor:

```bash
moryn refresh \
  --project . \
  --cursor 2026-05-27T00:00:00.000Z \
  --current-task "current task"
```

Changes are classified as `silent`, `notice`, or `interrupt`. Reportable
changes include safe `recall` next actions for retrieving full records.

Normal refresh reads exclude the shared private boundary: records tagged
`private`, `secret`, or `sensitive`, plus legacy records marked by
`content.privacy: "private"` or `content.distribution: "local_only"`. Use
`--include-private` only when the user has explicitly asked the agent to inspect
private memory; returned `recall` next actions preserve that opt-in.

## Autonomous Knowledge Loop

Codex and Claude Code use the same default protocol when durable project or
user knowledge is uncertain:

1. Call `moryn recall "<question>" --project .` before broad external
   exploration.
2. Follow the returned `next_actions` in order. A trusted match can be used
   with its record id as evidence. A verification-required result must be
   checked. A knowledge gap moves exploration to project files, local tools,
   web sources when needed, or the user when needed.
3. Queue only a supported, reusable conclusion with the one-call `learn`
   operation. Unsupported inference, unresolved conflict, transient text, and
   secrets are not canonicalized.
4. Before host compaction, write resolved Learning Deltas and preserve every
   unresolved material question with evidence and an exact next step.

A prompt recall miss does not write a store record by itself. The Codex and
Claude Code `UserPromptSubmit` hook returns a bounded `learning_bridge` only for
`knowledge_gap` or `verification_required`. The bridge references
`current_user_prompt` instead of echoing prompt text into hook output.
`learning_bridge.queue_learning` points to the one-call `learn` operation and
contains the resolved project plus current host, session, and device identity.
After research or user dialogue supports a reusable conclusion, the agent fills
only `question`, `conclusion`, and `evidence_type`. Moryn consumes queued
learning automatically at the next checkpoint or finish, then applies learning
policy, exact deduplication, and semantic consolidation. If the question
remains unresolved, the agent preserves a `knowledge_investigation` at the next
checkpoint instead of creating speculative memory.

```bash
moryn learn \
  --project . \
  --question "How is rollback protected?" \
  --conclusion "Production rollback requires a signed release tag." \
  --evidence-type source_code
```

Finalization Assurance seals a prior same-host session when durable checkpoint
or status evidence exists without a final handoff. It runs during the next
startup, reuses the normal finish pipeline, consumes pending Learning Inbox
items, and remains replay-safe. Codex Stop remains an in-progress status signal;
it is not treated as session completion. Claude Code SessionEnd continues to
create the normal final handoff immediately.

An unresolved investigation can be checkpointed without creating memory:

```bash
moryn agent checkpoint \
  --project . \
  --agent codex \
  --session-id "$SESSION_ID" \
  --device-id "$MORYN_DEVICE_ID" \
  --occurred-at 2026-07-12T00:00:00.000Z \
  --checkpoint-id precompact-rollback \
  --knowledge-investigation '{"resolution_id":"rollback-policy","question":"What is the rollback policy?","recall_status":"knowledge_gap","recalled_record_ids":[],"evidence":[{"type":"source_code","reference":"src/release.ts","summary":"Signed tags are validated"}],"status":"unresolved","next_step":"Run the rollback integration test"}'
```

Post-compact startup restores this investigation through
`boot.checkpoint_recovery_pack.knowledge_investigations`. Resolved conclusions
use the existing `--learning` flag instead, so learning policy, idempotency,
privacy boundaries, and exact or semantic consolidation remain authoritative.
Moryn supplies the workflow and durable state; it does not perform web or
repository research itself.

Learning ingestion folds high-confidence duplicates automatically. When a new
learning may instead revise, supersede, or conflict with existing knowledge,
`semantic_candidates` returns at most three candidates per new record and
twelve candidates per ingestion. Candidate feedback contains record ids,
scores, and signals, but not record text, so the normal receipt stays bounded
and does not expose private content by accident.

Checkpoint and finish also run bounded exact-duplicate maintenance for active
public `memory`, `skill`, and `soul` records owned by the current project. It
uses the complete logical fingerprint, skips private, already-hidden, and
conflicted records, and appends only deterministic `duplicate_of` links. It
never archives or deletes source records and does not mutate global or
operational session records. The `exact_duplicate_consolidation` receipt makes
the boundary, created links, and any best-effort failure explicit; maintenance
failure does not invalidate the durable checkpoint or handoff.

Agents recall candidate records before proposing `duplicate_of`, `revises`,
`supersedes`, or `conflicts_with`. A similarity score alone is not a semantic
relationship assertion. If no candidate is convincing, the agent continues
without creating maintenance work for the user; exceptional ambiguity can
remain visible through the existing read-only diagnostics.

When the recalled records expose compatible structured fields, the same
proposal may opt into `structured_merge`. Agents name dispositions, source
record IDs, and evidence IDs; they never author a merged value. Moryn copies
exact retained/replacement values or deterministically unions exact array
members, records field/value lineage, and keeps the result candidate unless the
canonical safety gates pass. Differing values cannot use `retain`: they require
an evidence-backed `replace`, an exact-value `union`, or an explicit
evidence-backed `obsolete`. A conflict always remains two records plus a
`conflicts_with` relationship.
Without an explicit `structured_merge.version: 1` plan, the proposal remains
relationship-only and can append only its validated logical link.

Checkpoint and finish lifecycle results promote unresolved candidates into an
agent-owned `review_learning_candidates` workflow. Codex and Claude Code
follow the supplied record-id recalls without routine user confirmation, then
submit only a relationship supported by the recalled evidence or continue
with no relationship. When automatic consolidation or an accepted proposal
already resolves a pair, the workflow stays absent. Official PreCompact hooks
return the same bounded workflow without injecting either record's text into
hook context.

Official side-effect hooks remain silent when no agent follow-up exists.
PreCompact and Claude SessionEnd conditionally inject the bounded workflow into
host output only when candidate review is required. This context is addressed
to the running agent, not the user: it contains executable record-id recalls,
keeps the normal dashboard quiet, and does not create a routine confirmation
or notification step.

## Timeline Context

Use `timeline` when a single recalled record is not enough to understand why it
exists or what happened nearby:

```bash
moryn timeline \
  --record-id rec_... \
  --project . \
  --before 5 \
  --after 5
```

Timeline accepts exactly one anchor: `--record-id`, `--event-id`, or `--query`.
It returns ordered items plus keyed maps by event id and record id. Each item
with a record includes a safe `recall` next action; agents should follow that
action when full content is needed instead of reconstructing arguments.

Timeline follows the same private read boundary as `recall`, `boot`,
`refresh`, and `list-recent`: private tags and legacy
`content.privacy: "private"` / `content.distribution: "local_only"` markers are
hidden unless `--include-private` is passed or MCP `include_private` is set to
`true`. If timeline is run with private reads enabled, its follow-up `recall`
actions include the same opt-in.

## Memory Governance

Use `memory doctor` for a read-only audit before promoting or archiving memory:

```bash
moryn memory doctor \
  --project . \
  --limit 20
```

The result reports candidate backlog, high-confidence candidates ready for user
promotion review, likely smoke/e2e marker noise, and related records under
other project ids. It returns keyed `findings_by_id` and
`suggested_actions_by_id`; mutation suggestions remain `safe_to_run: false`
until the user confirms promotion or archive. MCP hosts call `memory_doctor`.

Use `memory lifecycle` when the store has grown and you need a read-only retain
or archive review:

```bash
moryn memory lifecycle \
  --project . \
  --limit 20
```

The report classifies records as retained, stale, archive candidates, or
private-retained when private reads are explicit. It returns keyed
`assessments_by_record_id`, `findings_by_id`, `suggested_actions_by_id`, and
`records_by_id`. Archive suggestions stay `safe_to_run: false`; inspection
actions use timeline or recall. MCP hosts call `memory_lifecycle`.

Use `dogfood report` when improving Moryn itself or auditing recent friction in
local agent work:

```bash
moryn dogfood report \
  --project . \
  --limit 20
```

The result is read-only. It reports capture review backlog, duplicate handoff
text, and failure or timeout signals, with keyed `findings_by_id`,
`suggested_actions_by_id`, `records_by_id`, and `events_by_id`. Suggested
actions stay inspection-oriented, such as dashboard review or timeline lookup.
Capture review backlog follows the same review-required policy boundary as
Capture Inbox, so low-risk auto-captured handoffs stay as audit evidence rather
than dogfood review work. Older autocapture review metadata is rechecked against
the current autocapture policy before it becomes active review work; explicit
durable decisions and preferences still require review.
MCP hosts call `dogfood_report`.

Use `health check` for installation trust after setup, before dogfooding a new
host, or whenever store readiness is uncertain:

```bash
moryn health check \
  --project . \
  --limit 20
```

The result is read-only. It reports store readability, event-log replay,
project context, hidden private records, capture review backlog, and MCP runtime
freshness with keyed `checks_by_id` and `suggested_actions_by_id`. Agents should
restart the MCP host when MCP tool output disagrees with the CLI or dashboard after
upgrading, rebuilding, or linking a local checkout. Suggested actions are safe
inspection steps such as opening the dashboard or listing known projects. MCP
hosts call `health_check`.

Use `recall eval` when recall quality needs evidence from golden queries before
changing memory or ranking behavior:

```bash
moryn eval recall \
  --project . \
  --cases '[{"case_id":"sync","query":"private sync","expected_record_ids":["rec_..."]}]'
```

The result is read-only. It reports pass/fail cases, matched, missing, and
hidden expected record ids, ranking reasons, provenance method, privacy leaks,
and suggested recall commands for failed cases. Missing ids mean normal recall
could not find an expected record. Hidden ids mean the record exists but normal
recall filters kept it out because of state, privacy, project, kind, tag, file,
or explicit scope filters. Hidden cases use the
`inspect_hidden_expected_records` suggestion so agents can inspect ids and
filter reasons without exposing hidden text by default. It uses normal recall
with no embedding index and does not mutate memory. MCP hosts call
`recall_eval`.

If the project identity finding points at an obvious old id and a chosen
canonical id, run the repair as a dry run first:

```bash
moryn project migrate --from repo-e6f0166fd942 --to moryn
```

Apply only after user confirmation:

```bash
moryn project migrate --from repo-e6f0166fd942 --to moryn --apply --confirm
```

The migration appends `revise_record` events rather than editing history in
place. Private records stay out of the default migration unless the user
explicitly asks for `--include-private`. MCP hosts call `project_migrate`.

For browser-mediated approval, serve the dashboard with the intended project
context and ask the user to review the local `Review Queue`:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765 --project-id moryn
```

The Review Queue shows the generated project migration as a decision card:
issue, impact, recommended action, evidence, rollback path, and raw evidence
with safety checks and `plan_hash`. If the user clicks `Approve Repair`, the
dashboard server re-runs the dry run and applies only when the hash still
matches. Agents must not invent approval or send `confirmed: true` unless the
user approved the specific plan. Serve with `--include-private` only when the
user explicitly asked private memories to be included in the review and
repair.

For autocaptured session handoffs, use `moryn capture session` and let
`default_autocapture_policy` choose the route. Low-risk handoffs are
auto-captured as local handoff evidence for context packs without a user click.
When the agent knows which files changed or mattered, pass repeated
`--file <path>` flags; Moryn stores those paths as capture evidence for recall
and audit without making the handoff long-term memory.
Decision, risk, blocker, permission, credential, or approval handoffs enter the
dashboard `Capture Inbox`. `Approve Memory` promotes a current review candidate
to canonical memory with user confirmation. `Reject` archives the candidate.
Both actions append events and preserve the audit trail. Obvious smoke/test or
duplicate captures may be policy-archived before they enter the inbox, but the
dashboard still shows auto-captured and policy-archived counts, rule ids, and
recent examples.

When an agent needs to explain automatic capture routing without changing
memory, call `moryn capture policy --project . --limit 20` or MCP
`capture_policy`. The report is read-only: it returns the active policy,
`decisions_by_record_id`, `findings_by_id`, safe inspection actions, and record
or event evidence. It must not be treated as approval to promote, reject,
archive, or canonicalize memory.

## Private Read Boundary

Private markers are tag-based. The first-version contract treats `private`,
`secret`, and `sensitive` tags as default-hidden active records. They remain in
the store and can be synced, but normal agent reads do not surface them.

Default-hidden read surfaces:

- `boot`
- `recall`
- `refresh`
- `timeline`
- `list-recent`
- `memory doctor`
- `memory lifecycle`
- dashboard data and HTML

Explicit read examples:

```bash
moryn recall "credential rotation" --project . --include-private
moryn timeline --record-id rec_... --project . --include-private
moryn memory doctor --project . --include-private
moryn memory lifecycle --project . --include-private
moryn dashboard --serve --include-private
```

MCP hosts use `include_private: true`. Agents should not enable this flag as a
general startup default; require explicit user intent for the specific read.

## Finish Handoff

At the end of meaningful work:

```bash
moryn agent finish \
  --project . \
  --sync-remote git@github.com:yourname/moryn-store.git \
  --agent codex \
  --summary "Finished the release check cleanup and left follow-up notes."
```

`agent finish` writes a `session_summary` handoff and pushes when sync is
configured. The next agent can see it through `agent start` or `agent enter`.

## Observability Dashboard

Use the dashboard when a human or agent needs a quick local view of store
health. For live monitoring on the same machine, serve it locally:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765
```

Open the deployment-specific dashboard URL, for example `<dashboard-url>`, in a
shared Moryn environment. `127.0.0.1:8765` is the internal server bind target
behind that route, not the address to give the human. The browser refreshes from
the current local store on the configured interval.

For automation or static inspection, `moryn dashboard --no-open` writes
`state/dashboard/index.html` inside the local Moryn store. The dashboard shows
sync status, record quality, record types, recent value, and agent activity. In
interactive terminals, lifecycle and sync commands open the static snapshot
automatically; pass `--no-open` for automation. See `docs/dashboard.md` for
endpoints, access modes, and troubleshooting.

## Recovery Actions

Moryn error and warning envelopes include machine-readable recovery actions.
Common examples:

- uninitialized store: run `init` after user confirmation
- invalid project config: repair with `project init --repair` after approval
- missing record: run `list-recent`, select a real id, and retry
- missing project context: run `project list`, select a known project id, and retry
- sync conflict: run read-only `sync --status` and resolve the Git conflict
- confirmation required: ask the user, then retry with `--confirm`

Agents should execute returned `next_action` or `next.actions_by_id` templates
instead of composing new commands from prose.

## Safety Flags

Action templates include safety metadata:

- `safe_to_run`
- `required_when`
- `required_fields`
- `safety.safe_to_auto_run`
- `safety.requires_user_confirmation`
- `safety.requires_authored_input`
- `safety.writes_local_config`
- `execution.ready_to_run`
- `execution.next_step`

Hosts should treat `execution.ready_to_run` as the immediate run gate. A
read-only action can be safe, while a write that needs authored content should
remain blocked until the content is supplied.

## Smoke Tests

Validate the v0.2 default dogfood path locally:

```bash
npm run smoke:dogfood-demo
```

This uses a temporary local store to run setup, context pack, low-risk
autocapture, review-routed handoff, and dashboard snapshot checks without
touching user data. A passing public demo includes the summary:

```text
setup applied -> context pack ready -> low-risk handoff auto-captured -> review handoff routed to Capture Inbox -> dashboard snapshot generated
```

Validate the lifecycle path locally:

```bash
npm run smoke:agent-lifecycle
```

Validate an existing v0.2 store upgrading in place:

```bash
npm run smoke:upgrade-compat
```

This fixture writes the frozen v0.2 store contract directly. The current CLI
must enter and recall without an explicit migration or rebuild, preserve the
legacy event byte-for-byte, lazily create verified record/retrieval indexes,
and make a newly learned project fact available to a later Claude Code boot
pack. Legacy low-trust provenance remains subject to the current verification
boundary rather than becoming trusted merely because it predates v0.3.

Validate temporary remote failure recovery:

```bash
npm run smoke:sync-resilience
```

The smoke removes a configured local bare remote before `agent finish`, proves
the handoff remains committed and searchable in the local store, restores the
same remote, and requires the next `agent enter` to push the pending continuity
event before another device pulls it. Connectivity recovery is autonomous; a
real conflict or missing credentials still requires the documented exceptional
user action.

Validate the conflict guard boundary:

```bash
npm run smoke:sync-conflict
```

This creates a real add/add conflict at one append-only event path. Moryn must
report the conflict as unsafe to retry, preserve both Git stages, and reject
`agent finish` before another lifecycle event is authored. The agent may inspect
`moryn sync --status`, but it must not auto-resolve generated files or continue
writing until the user has chosen and completed the Git conflict resolution.

Validate authentication and permission recovery:

```bash
npm run smoke:permission-recovery
```

This forces `Permission denied (publickey)` without using real credentials.
`agent finish` must still commit the handoff locally, classify the failure as
`PERMISSION_DENIED`, and explicitly forbid echoing private keys, writing
credentials into memory, or retrying in a loop. Once the user repairs the Git
credential or permission outside Moryn, the next `agent enter` compensates the
pending handoff automatically and another device can pull it.

After building, force the built CLI:

```bash
npm run build
npm run smoke:agent-lifecycle -- --dist
```

Installed packages expose the direct bin:

```bash
moryn-agent-smoke
moryn-upgrade-smoke
moryn-resilience-smoke
moryn-conflict-smoke
moryn-permission-smoke
```

Package smoke also installs the packed artifact with `--omit=dev` and runs the
installed `moryn setup`, `moryn health check`, and `moryn context pack` commands,
so setup trust is checked outside the source checkout and without dev
dependencies.

To test a real private remote, use a dedicated test repository:

```bash
MORYN_AGENT_LIFECYCLE_REMOTE=git@github.com:yourname/moryn-store-smoke.git npm run smoke:agent-lifecycle
```

Do not point smoke or release checks at a production Moryn data repo.

## Checkpoint Before Compaction

Long-running agents should write a local checkpoint before host context
compaction. The checkpoint is an authored Context Delta: it records only the
progress, decisions, changed facts, blockers, next steps, files, candidate
memory or skill, and learnings added since the previous checkpoint.

```bash
moryn agent checkpoint \
  --project . \
  --agent codex \
  --session-id session-123 \
  --device-id device-a \
  --occurred-at 2026-07-11T10:30:00.000Z \
  --checkpoint-id compact-2 \
  --current-task "Implement checkpoint recovery" \
  --progress "Added the checkpoint contract" \
  --next-step "Resume after compaction"
```

The direct command is local-first and does not implicitly push the sync remote.
Official host `PreCompact` hooks also write locally first, then automatically
push a newly created checkpoint when project sync mode is `session` or
`interval`. Manual mode and an explicit no-push override remain local-only. A
repeated hook reuses the same project, source identity, `occurred_at`, checkpoint
id, tags, and semantic delta; identical retries return the existing checkpoint
without another automatic push. Reusing the same idempotency key with different
authored content returns a collision error. Remote failure never blocks
compaction: the checkpoint stays locally protected and the hook result marks
remote synchronization as pending.

Official `PostCompact` hooks delegate to the normal agent-start sync policy:
`session` and `interval` projects attempt a safe pull before building recovery
context, while `manual` projects and explicit `pull: false` remain local-only.
If the remote is unavailable, PostCompact reports the existing pull error
evidence and still restores any locally available checkpoint.

When no Git remote has been configured, official lifecycle hooks stay quietly
local-only: they do not repeatedly attempt pull or push, and local checkpoints,
turn statuses, recovery, and handoffs continue normally. This is distinct from
a configured remote that is offline or rejected, which remains visible as sync
degradation. Explicit `pull: true` or `push: true` requests still attempt sync
and return the normal configuration error so setup can be diagnosed.

`committed: true` means the event was atomically published. `durability` reports
`confirmed`, `best_effort`, or `failed` separately from derived-view refresh
status. After compaction, use `moryn boot --project . --session-id session-123`
or the normal agent start flow to receive the bounded checkpoint recovery pack.

## Verified Current-State Reads

Moryn keeps append-only event files as the authoritative history. To prevent a
large store from forcing every recall, boot, context pack, activation check, and
health check to parse and replay the full history, derived rebuilds also write a
complete `snapshots/records.json` read model.

The snapshot is trusted only when its event-file manifest matches the current
local event set. Missing, corrupt, incompatible, or stale snapshots fall back to
an authoritative event replay and are repaired automatically. Git sync pull
refreshes the snapshot before returning. A successful repair remains internal to
the agent and does not create a user review task; `health check` exposes bounded
`record_read_model` evidence for diagnostics.

This optimization does not delete events, compact Git history, weaken private
record filtering, or change logical duplicate and semantic consolidation rules.
Timeline and raw audit operations continue to read append-only events directly.

Checkpoint and finish also verify local event integrity before the lifecycle
moves on. A complete derived-view rebuild emits a local integrity proof for the
exact event-file manifest and records snapshot it just schema-checked and
replayed. The normal lifecycle path verifies that proof, the current event-file
metadata manifest, and the snapshot file fingerprint;
missing, stale, or damaged proof falls back to schema-checking every event,
replaying references and state changes, and comparing the full record
projection. A derived snapshot is repaired only when readback proves the
repair. The returned
`automatic_event_audit` receipt is metadata-only: status, counts, snapshot
health, and a stable generic failure code. It contains no memory text, private
content, raw parser error, or path. Healthy checks stay quiet. A failed check
does not undo the local checkpoint or handoff, but finish skips automatic push
so an unverified event store is not propagated. Git push repeats the gate under
the store lease after any remote rebase and immediately before upload, ensuring
the pushed event generation is the one that passed. This runs at lifecycle
boundaries and push only; it is not a background daemon and never edits memory
records.

The fast proof assumes event mutations use Moryn's leased writers or Git sync,
which invalidate the proof before changing authoritative files. Ordinary
out-of-band file changes are also detected by the metadata manifest. This is an
operational corruption guard, not a cryptographic defense against a same-user
actor deliberately changing bytes while preserving filesystem metadata.

## v0.4 Distilled Memory Workflow

Treat abstraction, trust, and retention as separate decisions:

- L0-L3 says whether a record is evidence, episodic, semantic/procedural, or
  identity memory;
- raw/candidate/canonical/quarantined says how much the record is trusted;
- hot/warm/cold/purged says whether it belongs in the active working set.

Do not promote a record merely because it is hot, lower trust merely because it
is cold, or describe an archived/cold record as deleted. Pinned,
never-forget, Soul, identity, conflict, security, permission, and unique evidence
remain protected across these axes.

The normal Session Fold workflow is automatic:

1. Write structured checkpoints during the session and an authored final
   handoff through `agent_finish`.
2. Moryn previews exact coverage and source digests.
3. If the session is closed and fully covered with no privacy or safety blocker,
   `agent_finish` may apply the fold and return a committed receipt.
4. If coverage is missing, a source changed, or protected/conflicting content is
   present, the result stays `review_required` or `failed`; preserve the sources
   and inspect the reason instead of archiving them manually.

Episode Rollup uses the same lineage rule at L1 and preserves leaf-evidence
digests. The Dashboard may show ready/deferred/review previews, but it never
applies them. Before automatic Episode apply, Moryn durably publishes the exact
integrity-bound plan under local `state/` storage. A later `agent_finish` retries
that plan before making a replacement plan for the same bucket, so an interrupted
append-only transaction resumes idempotently. A stale or unreadable recovery plan
fails closed for its bucket and remains an explicit exception. Private recovery
plans are stored separately and are neither read nor resumed without renewed
`include_private: true` authorization; the default result exposes only their
count. Manual unified maintenance uses the exact reviewed artifacts:

```bash
moryn memory compact preview --project-id <project_id>
moryn memory compact plan --preview-json '<preview-json>'
moryn memory compact apply --plan-json '<plan-json>' --confirm
moryn memory compact restore <plan_id> --confirm
```

Preview defaults to the public boundary. If the selected project, session, or
episode bucket contains private-classified compaction sources (including legacy
Episode `content.privacy: "private"` and `content.distribution: "local_only"`
markers), the result exposes only their count and a generic omission reason, sets
`private_access.scope_complete: false`, and remains non-applicable. Use
`--include-private` (MCP/Engine `include_private: true`) only after explicit
authorization; that choice is sealed into the preview and plan digest.

The corresponding MCP tools are `memory_compaction_preview`,
`memory_compaction_plan`, `memory_compaction_apply`, and
`memory_compaction_restore`. Preview and plan are non-mutating; unified apply and
restore reject requests without explicit `confirm: true`. This confirmation rule
does not disable the separate `agent_finish` path above: finalization may still
apply a safe, fully covered Session Fold automatically. No v0.4 command performs
physical purge.

Compaction means “append a rollup, then append source archive/cold events, then
commit a receipt.” It never includes purge. A logical restore appends new source
state and derived-rollup archive events while the receipt and history remain
available. It does not rewrite Git history. If content once entered synchronized
Git history, do not claim that cold, archive, or logical purge classification
erased it.

When a concise rollup is insufficient, expand its sources explicitly:

```bash
moryn memory expand <record_id> --max-depth 2 --max-records 100
```

MCP hosts use `memory_expand`; embedded hosts use `expandMemorySources`.
Expansion is read-only and reports digest mismatch, missing sources, cycles, and
limit omissions. Use `--include-private` or MCP `include_private: true` only when
the user explicitly authorizes private evidence. A private omission is not a
reason to guess the missing content.

## v0.4 Portable Soul Workflow

Use versioned profiles for User Soul and Agent Persona rather than writing a new
legacy `kind=soul` blob. Start with metadata-only inspection:

```bash
moryn soul status --project-id <project_id>
```

The corresponding MCP tool is `soul_status`. Status returns profile/revision
heads, conflicts, approval verification, persistence, compilation, and
hook-preparation metadata without clause text.

Create a draft only from authored clauses or a known parent revision:

```bash
moryn soul draft --subject user --subject-id default --clause-json '<clause-json>'
```

The MCP equivalent is `soul_draft`. Set each clause distribution deliberately:

- `local_only` keeps the full clause under ignored local state; it does not enter
  normal Git sync, Dashboard JSON/HTML, or `soul_status`;
- `personal_sync` writes a filtered append-only projection that can travel with
  normal sync.

Do not interpret `personal_sync_saved` as proof that another device has pulled
and verified the revision. Local save, remote push, remote pull, Effective Soul
compilation, and hook-output preparation are distinct states.

After the user reviews the exact draft, activation requires explicit
confirmation:

```bash
moryn soul approve <revision_id> --confirm
```

Use MCP `soul_approve` with `confirm: true`. Agents must not auto-approve identity,
boundary, values, or collaboration clauses. Competing active heads stay in
conflict; use the reported last-known-good revision while the user resolves the
heads.

Rollback is also an append-only, confirmation-gated activation:

```bash
moryn soul rollback \
  --profile-id <profile_id> \
  --to-revision <revision_id> \
  --confirm
```

The MCP equivalent is `soul_rollback`. Rollback creates a new active revision
and receipt; it does not mutate or delete the intervening revisions.

Projects that have more than one User or Agent profile can keep their normal
binding and delivery budget in `.moryn.json`:

```json
{
  "project_id": "moryn",
  "sync": { "mode": "session" },
  "soul": {
    "user_profile_id": "soul_profile_...",
    "agent_profile_id": "soul_profile_...",
    "char_budget": 4096,
    "token_budget": 1024
  }
}
```

Both profile ids are optional; each binds the corresponding subject kind and
prevents ambiguous profile selection. The budgets are optional positive
integers applied to Effective Soul compilation. Omitted bindings use normal
automatic selection, and omitted budgets use the compiler defaults. Keep only
profile metadata here—never put clause text or secrets in project config.

`agent start`, `agent enter`, and automatic `SessionStart`/`PostCompact` hooks
use this config whenever project context resolves through that directory.
Explicit lifecycle arguments take precedence for that call:

| `.moryn.json` | CLI override | MCP argument |
| --- | --- | --- |
| `soul.user_profile_id` | `--user-profile-id` | `user_profile_id` |
| `soul.agent_profile_id` | `--agent-profile-id` | `agent_profile_id` |
| `soul.char_budget` | `--soul-char-budget` | `soul_char_budget` |
| `soul.token_budget` | `--soul-token-budget` | `soul_token_budget` |

An explicit override is call-local: it neither rewrites `.moryn.json` nor
changes approval state. Project-config bindings are fallbacks, so a host can
select a different approved persona or tighter budget for one session without
changing the project's normal binding.

Effective Soul compilation applies subject binding, project scope,
distribution, protected-clause precedence, and character/token budgets. If a
mandatory clause does not fit, hook-context preparation is blocked rather than
truncated. Official Codex and Claude hooks prepare deliverable Soul context at
session start and after compaction.

Compilation and hook-preparation receipts contain revision ids, digests,
omissions, conflicts, host, and event metadata rather than clause bodies.
`host_context_prepared` uses proof scope
`hook_output_prepared_not_host_acknowledged_or_obedience`: it proves only that
Moryn prepared bounded context for hook output. It does not prove stdout
transport, Host acknowledgment, or model obedience. Continue to enforce
explicit user instructions and safety boundaries. Moryn does not overwrite
`AGENTS.md`, `CLAUDE.md`, or other user-managed host configuration to
synchronize Soul.
