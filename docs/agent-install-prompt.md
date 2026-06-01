# Agent Install Prompt

Moryn is designed for agents to operate directly. Give the agent a goal and let
it choose when to call `moryn`; the user should only be interrupted for choices
that require user authority or private information.

## Copy-Paste Prompt

```text
Install and use Moryn for this machine and project.

Purpose:
- Moryn is the local-first memory, skill, and handoff layer for agents.
- You should operate it yourself through CLI or MCP.
- Do not ask me to choose Moryn commands. Learn the command surface from Moryn
  itself and decide which command is appropriate.

First, inspect the environment:
1. Run `moryn --version`.
2. If unavailable, install Moryn:
   - if the current directory is the Moryn source checkout, run `npm install`,
     `npm run build`, and `npm link`;
   - otherwise try `npm install -g @richardyu114/moryn`;
   - if the npm package is unavailable, clone
     `https://github.com/Richardyu114/Moryn.git`, build it, and link it;
   - if none of those paths are possible, ask me for a source path or install
     permission.
3. Run `moryn init` if the local store is not initialized.
4. In the current repo, run `moryn project init --project-id <repo-name>` if
   there is no project config. Infer `<repo-name>` from the Git repository or
   current directory. Ask me only if the project id is ambiguous or changing an
   existing config would be required.
5. If this host supports MCP, configure it to run `moryn mcp`. For example:
   `codex mcp add moryn -- moryn mcp` or
   `gemini mcp add moryn moryn mcp --scope project`.

Then internalize how to use it:
- Run `moryn agent guide`.
- Run `moryn contracts operations --index`.
- For a command you plan to use, inspect its contract with
  `moryn contracts operations --operation <operation_name>`.
- Prefer MCP tools when available; otherwise use the CLI.

During agent work:
- Start a session with
  `moryn agent enter --project . --current-task "<current task>" --agent "<agent name>"`.
- Use recall or boot before relying on memory.
- Write or revise memory when you discover durable facts, decisions, warnings,
  reusable procedures, or handoff context.
- Promote only material that is stable enough to become canonical shared memory.
- Use `moryn agent status` during long work when it helps future handoffs.
- End with `moryn agent finish` and a concise handoff summary.
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

For deeper command semantics, use [Agent Workflow](agent-workflow.md) and
[Contracts](contracts.md).
