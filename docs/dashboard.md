# Moryn Dashboard

The Moryn dashboard is a local observability surface for checking memory, sync,
handoffs, and recent agent activity. It is implemented in the CLI as a
server-rendered HTML page with optional live refresh. It does not require a
frontend build, hosted backend, database, or external service.

Use it to answer:

- Is this local Moryn store healthy right now?
- Did sync reach the configured private remote?
- What useful records did agents recently write?
- What needs attention before another agent relies on this store?
- Where can raw records and events be inspected during debugging?

The dashboard stays local-first. It reads the current event history from the
local store and never uploads dashboard data.

## Quick Start

Serve the dashboard for the current machine:

```bash
moryn dashboard --serve --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

To let another device on the same LAN view it, bind to all local interfaces:

```bash
moryn dashboard --serve --host 0.0.0.0 --port 8765
```

Then open the serving machine's LAN address:

```text
http://<machine-ip>:8765/
```

`127.0.0.1` is local-only. `0.0.0.0` listens on external network interfaces, but
firewalls and network policy still need to allow the selected port.

## Modes

### Live Server

```bash
moryn dashboard --serve --host <host> --port <port> --interval <ms> --limit <n>
```

Defaults:

- `--host 127.0.0.1`
- `--port 8765`
- `--interval 2000`
- `--limit 20`

Server endpoints:

- `GET /` serves the full dashboard shell.
- `GET /fragment` rebuilds dashboard data and returns the current body HTML.
- `GET /api/dashboard` rebuilds dashboard data and returns JSON.
- `GET /healthz` returns a lightweight health response for deployment checks.

The browser refreshes from `fragment` on the configured interval. The refresh
URL is relative so the dashboard can also work behind a reverse proxy path such
as `/moryn-dashboard/`.

### Static Snapshot

```bash
moryn dashboard --no-open
```

Static mode writes:

```text
state/dashboard/index.html
```

inside the local Moryn store. The snapshot is useful for automation and artifact
inspection, but it does not refresh after it is written and it is not synced to
the private Moryn remote.

Interactive lifecycle and sync commands may generate and open the same static
snapshot. Use `--no-open` in automation or when a browser should not launch.

### MCP Hosts

The MCP `dashboard` tool returns a static local snapshot path and file URL. MCP
does not start a long-running HTTP server. If a human needs live monitoring,
start server mode from the CLI.

## What It Shows

The first screen favors human-readable summaries over raw ids:

- health status
- attention items
- sync summary
- active record counts
- agent activity
- record quality distribution
- record type distribution
- recent valuable records, newest first

Raw records, events, and sync details remain available in the lower Debug
Inspector.

Health badge states:

- `Healthy`: sync is clean and no urgent safety signals were detected.
- `Needs Review`: local changes, ahead/behind remote state, unresolved
  quarantined content, or candidate buildup needs a look.
- `Conflict`: sync reports a conflict.
- `Local Only`: sync is not configured.

Attention items call out conditions such as:

- sync conflict
- dirty local store
- ahead or behind remote counts
- unresolved quarantined records
- quarantined records that have active safe replacement indexes
- raw records waiting for review
- many candidate records relative to canonical records
- missing sync remote

## Data And Rendering

The dashboard is implemented in `src/observability/dashboard.ts`.

Data flow:

1. Read local event history from the configured Moryn store.
2. Replay events into records.
3. Compute derived dashboard data: health, attention items, charts, recent
   records, recent events, and agent activity.
4. Render HTML on the server.
5. In live server mode, periodically replace the page body with the latest
   rendered fragment.

The JSON returned by `/api/dashboard` includes:

- `sync`
- `health`
- `attention_items`
- `charts.agent_activity`
- `charts.memory_states`
- `charts.record_types`
- `charts.sync_position`
- `totals`
- `recent_value`
- `recent_records`
- `recent_events`
- `agent_activity`

This keeps raw data inspectable while giving the HTML renderer human-oriented
fields.

`Agent Activity` uses readable display groups instead of exposing every local
write path as a separate actor. Local Moryn write paths such as `codex`,
`codex-cli`, `cli`, `agent`, and `mcp` are grouped as `Codex / Moryn Local`.
Other clients, such as `gemini`, keep their own display group. The JSON keeps
`raw_clients` on each agent activity item so debugging can still trace the
original source clients.

Agents should write a host-specific `source.client` whenever possible. For
example, Claude should use `claude`, Kimi should use `kimi`, and Gemini should
use `gemini` instead of generic values such as `agent`, `cli`, or `mcp`.
Unknown client names are still displayed automatically by title-casing the raw
value, so `claude-code` appears as `Claude Code`. If a host writes only a
generic local value, the dashboard cannot infer the real agent and will group it
with the local Moryn write paths.

`Recent Value` sorts records by `updated_at` descending before applying the
value score tie-breaker. This keeps the newest useful writes at the top while
still preserving deterministic ordering for records with the same timestamp.
`source_label` contains the normalized readable source, while `source_detail`
preserves the raw client and session details when available.

Quarantined records normally count as unresolved safety signals. If an active
safe replacement index explicitly declares `content.supersedes_quarantined_record`
for the quarantined record id, the dashboard reports that condition as an info
attention item instead of forcing `Needs Review`.

## Privacy And Safety

The dashboard reads local data only. It does not add a hosted backend or remote
analytics.

Redaction rules still apply:

- quarantined records render as `[quarantined]`
- sensitive text is not shown in overview cards
- inspector tables also avoid exposing quarantined content

If you bind to `0.0.0.0`, anyone who can reach that host and port may view the
dashboard. Use local-only binding, firewall rules, SSH tunnels, Tailscale, or a
trusted reverse proxy when access should be restricted.

## Troubleshooting

If the page does not open:

- confirm the command is still running
- check that the selected port is free
- try `--port 0` to let the OS choose a free port
- use `127.0.0.1` for same-machine browser access
- use `0.0.0.0` plus the machine LAN IP for another device
- check firewall rules if accessing from another device

If the dashboard still shows local sync changes after a push:

```bash
moryn sync --status
moryn sync --push
```

If derived views look stale:

```bash
moryn rebuild
```

If a reverse proxy serves the dashboard under a path prefix, proxy all dashboard
paths to the local server. For example, `/moryn-dashboard/`, `/moryn-dashboard/fragment`,
`/moryn-dashboard/api/dashboard`, and `/moryn-dashboard/healthz` should all reach
the same local dashboard server.
