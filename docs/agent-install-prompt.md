# Agent Install Prompt

Moryn is designed for agents to operate directly across a multi-agent,
multi-device store. Give the agent a goal and let it choose when to call
`moryn`; the user should only be interrupted for choices that require user
authority or private information.

## Copy-Paste Prompt

```text
Install and use Moryn for this machine and project.

Purpose:
- Moryn is the local-first, multi-agent, multi-device memory, skill, and
  handoff layer for agents.
- You should operate it yourself through CLI or MCP.
- Do not ask me to choose Moryn commands. Learn the command surface from Moryn
  itself and decide which command is appropriate.

First, inspect the environment:
1. Run `moryn --version`.
2. If unavailable, install Moryn:
   - if the current directory is the Moryn source checkout, run `npm install`,
     `npm run build`, and `npm link`;
   - otherwise run `npm install -g @richardyu114/moryn@0.5.0` and verify
     `moryn --version` reports `0.5.0`;
   - if npm is unavailable, clone `https://github.com/Richardyu114/Moryn.git`,
     build it, and link it;
   - if none of those paths are possible, ask me for a source path or install
     permission.
3. Run `moryn setup --project . --host "<host client name>"`.
   This local setup wizard is a dry-run unless `--apply` is present. It prints
   readiness checks, planned local writes, and safe MCP, context, and
   autocapture commands without changing files.
4. Then run `moryn setup --project . --host "<host client name>" --apply` only after the dry-run looks right.
   The apply form initializes only Moryn-local state and project config. Then run
   `moryn install --host "<host client name>" --project . --apply` for host
   activation. Existing host configuration files are changed only under the host-specific
   safety policy: Claude Code activation safely merges Moryn-owned hooks into
   `.claude/settings.local.json`; Codex activation safely merges Moryn-owned
   hooks into `.codex/hooks.json` while leaving `.codex/config.toml` untouched.
   For Codex, use `/hooks` once to review and trust the project hooks. Do not
   bypass the host trust check.
5. If `moryn setup` reports missing project context, run
   `moryn project init --path . --project-id <repo-name>`. Infer
   `<repo-name>` from the Git repository or current directory. Ask me only if
   the project id is ambiguous or changing an existing config would be required.
6. If this host supports MCP, configure it to run `moryn mcp`. For example:
   `codex mcp add moryn -- moryn mcp` or
   `gemini mcp add moryn moryn mcp --scope project`.

Then internalize how to use it:
- Run `moryn agent guide`.
- Run `moryn contracts operations --index`.
- For a command you plan to use, inspect its contract with
  `moryn contracts operations --operation <operation_name>`.
- Prefer MCP tools when available; otherwise use the CLI.

During agent work:
- For Codex and Claude Code, the normal path is the installed Autopilot lifecycle:
  enter/recover, work and checkpoint, compact/resume, then finish/sync.
- Start the logical session with
  `moryn agent enter --project . --current-task "<current task>" --agent "<host client name>"`.
- Let `agent enter` diagnose activation and perform one safe Claude repair when
  possible. Continue working with degraded evidence when repair is unsafe; do
  not ask the user to intervene for routine activation.
- Use your actual host/client name for `--agent` and Moryn `source.client`
  metadata, for example `codex`, `claude`, `kimi`, or `gemini`. Do not use
  generic values such as `agent`, `cli`, or `mcp` when the real host identity is
  known.
- Use recall or boot before relying on memory.
- Write or revise memory when you discover durable facts, decisions, warnings,
  reusable procedures, or handoff context.
- Promote only material that is stable enough to become canonical shared memory.
- Use `moryn agent status` during long work when it helps future handoffs.
- Do not require automatic Stop hooks to append the same synthesized status on
  every turn. Moryn coalesces unchanged local status evidence and writes a new
  status only when durable state changes. Publish pending events later through
  the Dashboard sync action or an explicit `moryn sync` command.
- Before host compaction or when context pressure is visible, checkpoint current
  progress, durable learning, and unresolved knowledge investigations so the
  next compacted context can restore them.
- Treat official `PreCompact` hooks as local durability boundaries. They save a
  checkpoint without fetching, pulling, or pushing a remote. Replayed hooks stay
  idempotent, and pending Git evidence remains available for a later explicit
  sync.
- Restore compacted context through the following `SessionStart` event with
  `source=compact`. Generated integrations do not install a `PostCompact`
  handler; treat an older Moryn-owned `PostCompact` handler as a silent no-op.
- Keep automatic `SessionStart`, `PreCompact`, `Stop`, and `SessionEnd` hooks on
  the local fast path whether or not a sync remote is configured. Do not invent
  or contact a remote from a hook. Use the Dashboard sync action or an explicit
  `moryn sync` command for remote merge and publication.
- End with `moryn agent finish` and a concise handoff summary.
- Use `moryn context pack` and `moryn capture session` as explicit fallback,
  transfer, or unsupported-host tools rather than replacing the installed
  Codex/Claude lifecycle on every normal session.
- Repeated official `SessionEnd` delivery should reuse an unchanged final
  handoff instead of creating duplicate inbox entries. A changed summary remains
  a new local handoff. Publish it separately through the Dashboard sync action
  or an explicit `moryn sync` command.
- Treat SessionEnd as unchanged only when its summary, Learning Deltas, and
  semantic consolidation proposals are all equivalent. Never skip newly
  authored knowledge merely because the visible handoff summary is unchanged.
- Use `moryn dashboard --serve --host 127.0.0.1 --port 8765` when a human needs
  live browser monitoring of sync state, records, recent events, or agent
  activity.
- Tell the human to open the deployment-specific dashboard URL, for example
  `<dashboard-url>`, in a shared Moryn environment. Treat `127.0.0.1:8765` as
  the internal server bind target, not the address to report to the human.
- Use `moryn dashboard --no-open` when automation needs a static HTML snapshot
  without launching a browser.
- If derived views look stale, run `moryn refresh` or `moryn rebuild`.

Sync:
- If I provide a private sync remote, initialize or use it.
- If I do not provide one, stay local-first. Do not block work on sync setup.
- Never use the source code repository as the Moryn data store.

Only ask me for:
- a private sync remote URL;
- credentials or permissions you do not already have;
- confirmation before overwriting or repairing existing config;
- an ambiguous project id;
- resolving sync conflicts;
- storing sensitive information;
- promoting high-risk canonical memory.

Never store secrets. Quarantine or avoid sensitive content.
When setup is complete, summarize what you configured and keep future Moryn
details internal unless I ask.
```

## User Decision Boundaries

The agent can usually decide command usage on its own. It should ask the user
only when the next step depends on user-owned information or authority:

- which private Git remote to use for sync;
- whether to change an existing project identity;
- whether to repair, overwrite, or remove local configuration;
- whether sensitive content may be stored at all;
- how to resolve a sync conflict;
- whether a high-risk fact should become canonical memory.

Routine command selection should stay internal to the agent.

## Agent Identity

Use stable, host-specific client names in lifecycle and write metadata. This
lets the dashboard, handoff inbox, and future agents distinguish who wrote each
record. Good values include `codex`, `claude`, `kimi`, and `gemini`; variants
such as `claude-code`, `kimi-k2`, and `codex-cli` are recognized as the same
agent families. Generic transport names such as `agent`, `cli`, or `mcp`
should be used only when the actual host is unknown.

## Host Setup Notes

MCP is optional but preferred when the host supports it.

```bash
codex mcp add moryn -- moryn mcp
gemini mcp add moryn moryn mcp --scope project
```

Generic MCP config:

```json
{
  "mcpServers": {
    "moryn": {
      "command": "moryn",
      "args": ["mcp"]
    }
  }
}
```

The host adapter and autocapture path is the low-friction entrypoint; the
`moryn install` plan remains available when a host wants MCP registration hints
without the broader setup wizard. The `agent enter` / `agent finish` lifecycle
remains the fuller protocol when a host needs diagnosis, status, sync push
behavior, or explicit workflow actions. This local-only automatic hook policy
does not change the default pull/push semantics of direct `agent start`,
`agent status`, or `agent finish` calls.

For deeper command semantics, use [Agent Workflow](agent-workflow.md),
[Contracts](contracts.md), and [Dashboard](dashboard.md).
