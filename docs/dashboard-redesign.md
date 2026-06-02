# Moryn Dashboard Design

## Purpose

Redesign the Moryn dashboard from a raw static operations report into a human-first local monitoring surface, then expose it through a local HTTP server for realtime monitoring. The dashboard should help a user quickly answer:

- Is Moryn healthy right now?
- Did sync reach the remote?
- What useful work did agents recently do?
- What requires my attention?
- Where can I inspect raw records and events when debugging?

The dashboard keeps the local-first posture. It does not add a hosted backend, editing UI, or authentication. Server mode binds to a caller-selected host and port, serves the current local store, and refreshes from local event history on demand.

## Audience

Use a mixed audience model:

- Primary: human users checking whether their agent memory and handoffs are healthy.
- Secondary: developers debugging sync, record state, project identity, or MCP/CLI lifecycle behavior.

The default view must favor meaningful summaries over raw ids. Debug details remain available in an inspector section.

## Product Direction

Use the "Neutral Intelligence + Debug Inspector" approach.

The first screen presents a concise operational overview:

- health status
- attention items
- sync summary
- agent activity
- record quality
- record type distribution
- recent valuable records

Raw tables and JSON-like details move into a lower "Inspector" area. This prevents event ids, record ids, session ids, and long text from dominating the page.

## Information Architecture

### Header

The header shows:

- `Moryn Dashboard`
- generated time in relative and exact form
- store path in a truncated copyable field
- overall health badge

Health badge states:

- `Healthy`: sync clean, no conflicts, no quarantined records in the recent window, no project identity warning.
- `Needs Review`: dirty store, ahead/behind counts, quarantined records, or notable candidate buildup.
- `Conflict`: sync conflict or unrecoverable dashboard data error.
- `Local Only`: sync not configured.

### Overview Strip

Use four compact metric panels:

- Sync: clean, dirty, conflict, not configured.
- Remote: branch plus ahead/behind counts.
- Records: total active records and hidden/quarantined count.
- Agents: active clients and latest activity.

Each panel should include a short human label, not only raw values. Example: `Clean`, `2 local changes`, `56 active records`, `Codex 6m ago`.

### Needs Attention

Show only actionable or unusual conditions:

- sync conflict
- dirty store
- ahead or behind counts
- quarantined records
- recent raw records
- many candidate records relative to canonical records
- missing sync remote
- project identity mismatch when detectable from store/project context

If there are no attention items, show a quiet empty state: `No issues detected in the current snapshot.`

Each attention item includes:

- severity: info, warning, critical
- title
- short explanation
- relevant command or next action when available

### Visual Sections

Add lightweight graphics rendered with HTML/CSS and inline SVG only; no frontend build pipeline.

Required graphics:

- Agent activity bar chart: one horizontal bar per client, based on recent events and records.
- Record quality distribution: stacked bar for canonical, candidate, raw, quarantined, archived.
- Record type distribution: one bar per record kind (`memory`, `skill`, `soul`, `session_summary`, `agent_note`).
- Sync position indicator: clean/dirty/conflict plus ahead/behind visual markers.
- Recent activity timeline: readable event cards grouped by time.

These graphics must remain legible on mobile. They should not depend on JavaScript to render.

### Recent Value

Replace the raw recent records table as the primary section with readable record cards:

- record kind/type as a compact label
- human summary text capped to 2-3 lines
- state badge
- source agent
- relative time
- project or scope context

Ranking should favor high-value records:

- canonical memories
- warnings and decisions
- session summaries
- recent statuses from agents
- quarantined metadata without secret text

Raw event-only noise should not appear here unless it affects health.

### Inspector

Keep a lower debug section with tabs or stacked subsections:

- Records
- Events
- Sync
- Agents

The inspector can still use tables, but tables must be resilient:

- fixed table layout
- max column widths
- wrapped text for summaries
- ellipsis for ids and source labels
- monospace ids in copyable/truncated cells
- horizontal scroll only inside the inspector container, never at page level
- expandable details via `<details>` for long text and full metadata

## Visual Design

Use a restrained "Neutral Intelligence" palette that reads like a productized local observability tool, not a beige report page or colorful marketing surface.

Use a neutral professional palette:

- canvas: `#f6f7f8`
- surface: `#ffffff`
- secondary surface: `#fafbfc`
- primary text: `#15191e`
- muted text: `#66717d`
- border: `#d9dee3`
- info signal: `#315f9f`
- good signal: `#21715e`
- warning signal: `#9b6a20`
- critical signal: `#b0453c`
- secondary signal: `#65579d`

Avoid large pastel backgrounds, decorative blobs, and oversized marketing composition. Color should carry signal, not decorate empty space.

Use subtle depth:

- thin borders
- slight surface contrast
- compact spacing
- 6-8px radius
- no nested cards

Typography:

- dense, readable system sans
- no viewport-scaled font sizes
- headings sized for dashboard panels, not hero marketing
- letter spacing `0`

## Content Rules

Human-readable text must be derived from records and sync state:

- Use relative time plus exact timestamp in `title` or secondary text.
- Convert ISO-only timestamps out of primary labels.
- Shorten source labels to client name first, with session id in details.
- Do not show raw event ids in overview sections.
- Never render quarantined text.
- Prefer "Codex wrote a status checkpoint" over `upsert_record`.
- Prefer "Remote clean on main" over raw sync JSON.

When text is too long:

- truncate summary text to 2-3 lines in cards
- place full text in expandable details
- wrap long words with `overflow-wrap: anywhere`
- keep page-level horizontal overflow at zero

## Data Model Changes

Extend dashboard data with derived, human-oriented fields while preserving current raw arrays.

Add:

- `health`: status, label, explanation, generated_at
- `attention_items`: severity, title, description, action_label, action_command
- `charts.agent_activity`: client, events, records, latest_at, weight
- `charts.memory_states`: state, count, percent
- `charts.record_types`: kind, label, count, percent
- `charts.sync_position`: configured, state, ahead, behind, dirty, conflict
- `recent_value`: ranked record summaries with display title, summary, source label, relative time, exact time, state, kind, type

Keep:

- `recent_records`
- `recent_events`
- `agent_activity`
- `sync`
- `totals`

This keeps API compatibility while making the renderer human-first.

## Rendering Approach

Keep static snapshot generation for compatibility and add server mode for live monitoring.

Use:

- inline CSS
- CSS-rendered charts
- semantic HTML sections
- `<details>` for expandable debug data
- no external assets
- minimal inline JavaScript only in server mode, used to periodically fetch the latest rendered dashboard body and replace the page content

Server mode:

- `moryn dashboard --serve --host <host> --port <port> --interval <ms>`
- `GET /` serves the full HTML shell.
- `GET /fragment` rebuilds the dashboard from current local events and returns the current body HTML.
- `GET /api/dashboard` rebuilds the dashboard from current local events and returns the current data shape as JSON.
- The browser refreshes from `/fragment` on the configured interval.
- The server response includes the bound URL so CLI callers can open or share it.

Static mode:

- `moryn dashboard --no-open` writes `state/dashboard/index.html`.
- Static snapshots stay useful for automation and artifact inspection, but the default human monitoring flow is server mode.

## Error Handling

Dashboard generation should not fail the primary CLI operation after sync/lifecycle success. If a dashboard section cannot be computed:

- show the rest of the dashboard
- add a critical attention item for the failed section
- include the raw error in the inspector only

Redaction rules override display quality. Sensitive or quarantined content must stay hidden even in inspector tables.

## Testing

Add or update tests for:

- health classification: clean, dirty, conflict, local-only
- attention item generation for ahead/behind, conflict, quarantined records, and not-configured sync
- recent value ranking
- redaction in overview and inspector
- HTML escaping
- no raw secret text in rendered HTML
- no page-level overflow-prone markup for table cells, verified by expected classes and CSS rules
- chart sections render from data

Manual verification:

- generate dashboard from current local store
- serve it through Caddy or local HTTP
- inspect desktop width and narrow mobile width
- verify no text pushes the page horizontally
- verify overview answers health and recent-value questions without opening inspector

## Acceptance Criteria

- First viewport communicates health, sync state, recent agent activity, and attention items without reading raw tables.
- Long ids, sessions, and record text no longer overflow the page.
- At least three graphical summaries are present: agent activity, memory state distribution, sync position or activity timeline.
- Recent records are shown as human-readable value cards before raw tables.
- Raw records/events remain inspectable in a lower debug area.
- Quarantined content remains redacted everywhere.
- The dashboard stays a static local artifact for this redesign.
