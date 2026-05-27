# Memora

![Memora hero](assets/memora-hero.png)

Memora is a personal memory, skill, and soul layer for AI agents.

It is designed for people who use multiple AI agents across multiple projects and want those agents to share the same durable context without making memory belong to any single agent. Agents are readers and writers; the long-lived context belongs to the user, projects, topics, and artifacts.

> Status: first-version MVP implementation. Core local memory operations, Git sync, and a real stdio MCP server are implemented from the first-version design in [docs/memora-design.md](docs/memora-design.md). The roadmap is tracked in [docs/implementation-roadmap.md](docs/implementation-roadmap.md).

## What Memora Is

Memora provides a local-first shared context layer for:

- `memory`: project facts, decisions, warnings, preferences, and state.
- `skill`: reusable workflows, procedures, instructions, and command declarations.
- `soul`: long-term user identity, values, collaboration preferences, and working principles.
- `session_summary`: handoff notes from one agent session to another.
- `agent_note`: raw agent observations that can later be promoted into durable memory.

The first version is a local tool with GitHub private repo sync. The local store is the runtime source of availability. GitHub is a sync backend, not the live database.

## Why

AI agents often work in isolated sessions. One agent may learn a project constraint, debug a failure, or refine a workflow, but another agent starts later without that context.

Memora aims to make that context portable:

- Codex can write a session summary after finishing work.
- Claude or Cursor can fetch the same project's canonical decisions later.
- Skills can improve over time without being tied to one agent's prompt format.
- Long-term user preferences can be shared safely after confirmation.
- Raw agent notes can be stored without polluting default recall.

## Architecture

```mermaid
flowchart LR
  subgraph ClientLayer["Agent clients"]
    A1["Codex"]
    A2["Claude"]
    A3["Cursor"]
    A4["Scripts"]
  end

  subgraph AccessLayer["Access layer"]
    MCP["MCP server"]
    CLI["CLI: mem"]
  end

  subgraph EngineLayer["Core memory engine"]
    Engine["Validation, boot, recall, sync, promotion, safety"]
  end

  subgraph StoreLayer["Local-first store"]
    Events["Append-only events"]
    Derived["Rebuildable snapshots and indexes"]
  end

  subgraph SyncLayer["Sync backend"]
    Git["Git sync adapter"]
    GitHub["User-owned GitHub private repo"]
  end

  A1 --> MCP
  A2 --> MCP
  A3 --> MCP
  A4 --> CLI

  MCP --> Engine
  CLI --> Engine

  Engine -->|"write / revise / promote"| Events
  Events -->|"replay current state"| Engine
  Engine -->|"read / query / rebuild"| Derived
  Events -->|"derive"| Derived

  Events -->|"commit / push"| Git
  Git --> GitHub
  GitHub -->|"fetch / pull"| Git
  Git -->|"merge event history"| Events
```

## Usage

### 1. Install the CLI

From source:

```bash
git clone git@github.com:Richardyu114/Memora.git
cd Memora
npm install
npm run build
npm link
```

After npm publication:

```bash
npm install -g @richardyu114/memora
```

The CLI command is:

```bash
mem
```

### 2. Initialize the Local Store

```bash
mem init
```

This creates:

```text
~/.memora/
  config.json
  events/
  snapshots/
  indexes/
```

### 3. Connect a Private Sync Repo

```bash
mem sync init git@github.com:yourname/memora-store.git
```

The sync repo should be a user-owned private repository for Memora data. It should be separate from the Memora source code repository.

Sync commands operate on the Memora store, not the current source repo:

```bash
mem sync --status
mem sync --push
mem sync --pull
```

The default Git sync commits event files and `.gitignore`. Local `config.json`, snapshots, and indexes remain device-local or rebuildable.

### 4. Initialize a Project

Inside a project repo:

```bash
mem project init
```

This creates an optional project config:

```text
.memora.json
```

Example:

```json
{
  "project_id": "my-project",
  "tags": ["typescript", "mcp"],
  "default_skills": ["release"],
  "sync": {
    "mode": "session"
  }
}
```

You can also initialize a specific path with tags and default skill selectors:

```bash
mem project init --path /path/to/project --project-id my-project --tag typescript --tag mcp --default-skill release
```

Project-aware commands accept either an explicit project id or a project path:

```bash
mem write --kind memory --type decision --scope project --project /path/to/project --text "Use append-only events"
mem recall "append-only events" --project /path/to/project
mem boot --project /path/to/project
```

### 5. Connect Agents Through MCP

Start the Memora MCP server:

```bash
mem mcp
```

Then configure an agent host that supports MCP to run that command. The exact host config will vary, but the target command is the same:

```json
{
  "mcpServers": {
    "memora": {
      "command": "mem",
      "args": ["mcp"]
    }
  }
}
```

The current MCP server uses the official Model Context Protocol TypeScript SDK over stdio and exposes these tools:

- `init`
- `boot`
- `project_init`
- `recall`
- `write`
- `revise`
- `promote`
- `archive`
- `quarantine`
- `link`
- `refresh`
- `rebuild`
- `sync_init`
- `sync_status`
- `sync_pull`
- `sync_push`
- `list_recent`

Agents that do not support MCP can still use Memora through CLI commands.

MCP tools accept `project_id` directly. Project-aware tools also accept
`project_path`; when provided, Memora resolves `.memora.json`, applies project
tags to writes, and applies configured `default_skills` during boot.

### Agent Host Examples

Codex, Claude Desktop, Cursor, and other MCP-capable hosts should point to the same stdio command:

```json
{
  "mcpServers": {
    "memora": {
      "command": "mem",
      "args": ["mcp"]
    }
  }
}
```

Shell-based agents can use the CLI directly:

```bash
mem boot --project .
mem recall "current task" --project . --scope project --kind memory --kind skill
mem write --kind session_summary --type summary --scope project --project . --text "Finished the task summary."
mem refresh --project . --cursor <previous-cursor> --current-task "current task"
```

## Current MVP Commands

The current implementation includes these commands:

```bash
mem init
mem boot --project-id memora --current-task "fix auth"
mem write --kind memory --type decision --scope project --project-id memora --tag sync --state canonical --text "Use append-only events"
mem recall "append-only events" --project-id memora --kind memory --type decision --state canonical --tag sync
mem refresh --project-id memora --cursor 2026-05-27T00:00:00.000Z --current-task "fix auth"
mem revise rec_... --set content.text="Updated memory" --reason "Refined wording"
mem promote rec_... --state canonical --reason "User confirmed"
mem archive rec_... --reason "Superseded"
mem quarantine rec_... --reason "Needs review"
mem link rec_... rec_other... --type supersedes
mem list-recent
mem rebuild
mem sync --status
mem sync --push
mem sync --pull
mem mcp
```

## Agent Workflow

Agents should use Memora through a consistent protocol.

At task start:

```text
boot(project_path, current_task)
```

This returns a small context package: user preferences, project summary, important decisions, warnings, default skills, task-relevant trusted memories, recent important changes, and sync status.

When more context is needed:

```text
recall(query, project_id, files, kinds)
```

This returns ranked memory and skill candidates with reasons.

When the user asks to refresh memory, or during a periodic check:

```text
refresh(cursor, current_task)
```

This reports new changes as `silent`, `notice`, or `interrupt`.

When existing memory or skill needs correction:

```text
revise(record_id, patch, reason)
```

This logically updates the record while appending a new event to preserve history.

At the end of meaningful work:

```text
write(kind="session_summary", ...)
```

This records a handoff summary for future agents.

When a candidate should become durable shared context:

```text
promote(record_id, target_state="canonical")
```

This moves the record into the default recall layer.

When a record should be hidden or related to another record:

```text
archive(record_id, reason)
quarantine(record_id, reason)
link(record_id, linked_record_id, link_type)
```

Archived and quarantined records stay in history but are excluded from default boot and recall. They can still be fetched explicitly with a matching `state` filter.

## Memory Promotion Model

Memora separates recording from durable memory.

```text
raw -> candidate -> canonical
                 -> archived
                 -> quarantined
```

- `raw`: source material, usually not returned by default.
- `candidate`: potentially useful but not fully trusted.
- `canonical`: durable and returned by default in boot and recall.
- `archived`: preserved history, hidden by default.
- `quarantined`: sensitive, suspicious, or conflicting content.

This keeps agent-specific notes from polluting the shared context while still making them available as source material.

## Sync Model

Memora is local-first:

- Local reads and writes should work even when remote sync is unavailable.
- Writes append events.
- Replaying events produces the current state.
- Snapshots and indexes are derived and rebuildable.
- GitHub private repos are the first sync backend.

The default sync mode is `session`: pull at task start and push at session end or explicit sync.

## Design Spec

The full first-version design is here:

- [Memora Design Spec](docs/memora-design.md)

## License

MIT

## Release Checklist

- Package name uses the public scoped package `@richardyu114/memora` because `memora` is already occupied on npm.
- Run `npm run release:check`.
- Automated smoke tests cover `mem mcp` through the MCP SDK from both source and built `dist/cli.js`.
- Automated package smoke test installs the packed tarball and runs the installed `mem` binary.
- Test Git sync with a dedicated private user-owned test repository by setting `MEMORA_PRIVATE_GIT_REMOTE` before running the release check. The script writes a release-check event, so do not point this at a production Memora data repo.

```bash
MEMORA_PRIVATE_GIT_REMOTE=git@github.com:yourname/memora-store-release-test.git npm run release:check
```

- Publish only after confirming no private memory store data is included.
