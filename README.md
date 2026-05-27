# Memora

![Memora hero](assets/memora-hero.png)

Memora is a personal memory, skill, and soul layer for AI agents.

It is designed for people who use multiple AI agents across multiple projects and want those agents to share the same durable context without making memory belong to any single agent. Agents are readers and writers; the long-lived context belongs to the user, projects, topics, and artifacts.

> Status: early MVP implementation. Core local memory operations and a real stdio MCP server are being built from the first-version design in [docs/memora-design.md](docs/memora-design.md). The remaining work is tracked in [docs/implementation-roadmap.md](docs/implementation-roadmap.md).

## What Memora Is

Memora provides a local-first shared context layer for:

- `memory`: project facts, decisions, warnings, preferences, and state.
- `skill`: reusable workflows, procedures, instructions, and command declarations.
- `soul`: long-term user identity, values, collaboration preferences, and working principles.
- `session_summary`: handoff notes from one agent session to another.
- `agent_note`: raw agent observations that can later be promoted into durable memory.

The first version is planned as a local tool with GitHub private repo sync. The local store is the runtime source of availability. GitHub is a sync backend, not the live database.

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

## Planned Usage

### 1. Install the CLI

```bash
npm install -g memora
```

The planned CLI command is:

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
  "sync": {
    "mode": "session"
  }
}
```

You can also initialize a specific path with tags:

```bash
mem project init --path /path/to/project --project-id my-project --tag typescript --tag mcp
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

- `boot`
- `recall`
- `write`
- `revise`
- `promote`
- `list_recent`

Agents that do not support MCP can still use Memora through CLI commands.

## Current MVP Commands

The current implementation includes these commands:

```bash
mem init
mem boot --project-id memora
mem write --kind memory --type decision --scope project --project-id memora --text "Use append-only events"
mem recall "append-only events" --project-id memora
mem revise rec_... --set content.text="Updated memory" --reason "Refined wording"
mem promote rec_... --state canonical --reason "User confirmed"
mem list-recent
mem sync --status
mem mcp
```

## Agent Workflow

Agents should use Memora through a consistent protocol.

At task start:

```text
boot(project_path, current_task)
```

This returns a small context package: user preferences, project summary, important decisions, warnings, default skills, recent important changes, and sync status.

When more context is needed:

```text
recall(query, project_id, files, kinds)
```

This returns ranked memory and skill candidates with reasons.

When the user asks to refresh memory, or during a periodic check:

```text
sync(cursor, current_task)
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

Memora is planned as local-first:

- Local reads and writes should work even when remote sync is unavailable.
- Writes append events.
- Replaying events produces the current state.
- Snapshots and indexes are derived and rebuildable.
- GitHub private repos are the first sync backend.

The default sync mode is planned to be `session`: pull at task start and push at session end or explicit sync.

## Design Spec

The full first-version design is here:

- [Memora Design Spec](docs/memora-design.md)

## License

Not specified yet.
