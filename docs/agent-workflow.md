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

## Host Adapter Flow

For normal host sessions, the low-friction path is:

```bash
moryn install --host codex --project . --apply
moryn context pack --project . --agent codex --current-task "current task"
moryn capture session --project . --agent codex --summary "handoff summary"
```

ASCII view:

```text
Codex / Claude / Gemini / Cursor / shell
        |
        |  moryn install
        v
Safe setup plan + MCP registration hints
        |
        |  moryn context pack
        v
boot context + refresh + handoff inbox + capture_session next action
        |
        |  work happens in the host
        v
moryn capture session
        |
        v
session_summary tagged autocapture + host:<client>
        |
        v
Next agent or device reads it through context pack / agent start / recall
```

`context pack` is intentionally a convenience wrapper around the same Moryn
core and lifecycle data. Use `agent enter`, `agent start`, `agent status`, and
`agent finish` when a host needs fuller setup diagnosis, status checkpoints,
explicit sync push behavior, or detailed lifecycle action templates.

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

Normal refresh reads exclude records tagged `private`, `secret`, or
`sensitive`. Use `--include-private` only when the user has explicitly asked
the agent to inspect private memory; returned `recall` next actions preserve
that opt-in.

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
`refresh`, and `list-recent`: records tagged `private`, `secret`, or
`sensitive` are hidden unless `--include-private` is passed or MCP
`include_private` is set to `true`. If timeline is run with private reads
enabled, its follow-up `recall` actions include the same opt-in.

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
- dashboard data and HTML

Explicit read examples:

```bash
moryn recall "credential rotation" --project . --include-private
moryn timeline --record-id rec_... --project . --include-private
moryn memory doctor --project . --include-private
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

Open `http://127.0.0.1:8765/`. For another device on the same LAN, use
`--host 0.0.0.0` and open `http://<machine-ip>:8765/`. The browser refreshes
from the current local store on the configured interval.

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

## Smoke Test

Validate the lifecycle path locally:

```bash
npm run smoke:agent-lifecycle
```

After building, force the built CLI:

```bash
npm run build
npm run smoke:agent-lifecycle -- --dist
```

Installed packages expose the direct bin:

```bash
moryn-agent-smoke
```

To test a real private remote, use a dedicated test repository:

```bash
MORYN_AGENT_LIFECYCLE_REMOTE=git@github.com:yourname/moryn-store-smoke.git npm run smoke:agent-lifecycle
```

Do not point smoke or release checks at a production Moryn data repo.
