# Agent Workflow

Moryn exposes a lifecycle protocol for agents that need reliable setup,
context bootstrapping, status updates, and handoffs across tools.

The short version:

1. Use `agent enter` when a session starts.
2. Use `agent status` during meaningful long-running work.
3. Use `refresh` when checking for new context without a full restart.
4. Use `agent finish` before stopping or handing off.
5. Follow returned `next` actions instead of inventing command sequences.

## Startup

Use `agent enter` as the default entrypoint:

```bash
moryn agent enter \
  --project . \
  --sync-remote git@github.com:yourname/moryn-store.git \
  --current-task "current task" \
  --agent codex
```

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
health. For live monitoring, serve it locally:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765
```

The browser refreshes from the current local store on the configured interval.
For automation or static inspection, `moryn dashboard --no-open` writes
`state/dashboard/index.html` inside the local Moryn store. The dashboard shows
sync status, record quality, record types, recent value, and agent activity. In
interactive terminals, lifecycle and sync commands open the static snapshot
automatically; pass `--no-open` for automation.

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
