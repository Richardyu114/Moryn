# Context Infrastructure

Moryn provides three complementary context controls:

- **Agent Continuity Protocol** normalizes lifecycle behavior across agent hosts.
- **Repo Atlas** separates mechanical repository observations from authored architecture claims.
- **Sync Gate** evaluates pending event bytes against an explicit destination before publication.

These controls keep Moryn local-first. They do not require a hosted memory service, a vector database, or ownership of the agent runtime.

## Agent Continuity Protocol

**moryn.agent-continuity.v1** maps seven lifecycle operations to the strongest declared transport available:

| Operation | Purpose | Moryn operation |
| --- | --- | --- |
| enter | discover or enter a workspace | agent_enter |
| start | load current project context | agent_start |
| checkpoint | preserve bounded progress | checkpoint |
| finish | finalize a session | agent_finish |
| handoff | publish a resumable summary | agent_finish |
| abort | preserve an interrupted state | agent_status |
| recover | reload after compaction or interruption | agent_start |

The negotiated route is one of **native_hook**, **mcp**, **cli**, or **unavailable**. A missing hook is therefore visible; it is never reported as a successful capture.

~~~bash
moryn continuity negotiate --host codex
moryn continuity negotiate --host opencode --no-native-hooks
moryn continuity transfer \
  --project-id my-project \
  --source-host codex \
  --target-host opencode
~~~

The transfer plan keeps one workspace identity and orders four steps: source checkpoint, source handoff, target enter, and target recovery. Its conformance receipt contains route and capability digests, not task or transcript content.

### OpenCode

OpenCode uses the same protocol through MCP. Moryn does not currently install an OpenCode lifecycle plugin, so it does not claim OpenCode session events are configured. Add a local stdio server to **opencode.json**:

~~~json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "moryn": {
      "type": "local",
      "command": ["moryn", "mcp"],
      "enabled": true
    }
  }
}
~~~

OpenCode's V2 configuration nests entries under **mcp.servers**; use the shape documented by the installed OpenCode version. See the official [OpenCode MCP documentation](https://opencode.ai/docs/mcp-servers/).

## Repo Atlas

Repo Atlas has three layers:

~~~text
Git-tracked files
       |
       v
observations (mechanical, local, rebuildable)
       |
       v
claims (authored, evidence-bound, append-only)
       |
       v
lenses (derived for the current task)
~~~

A scan stores file paths, SHA-256 digests, sizes, line counts, language/role classification, and bounded **package.json** metadata. It does not persist source text or the repository's absolute path. The snapshot lives in ignored local state.

~~~bash
moryn repo-atlas scan --repo .
moryn repo-atlas claim --repo . \
  --project-id my-project \
  --statement "src/server.ts owns the request boundary" \
  --evidence src/server.ts \
  --evidence tests/server.test.ts \
  --agent codex
moryn repo-atlas view --repo . --lens request_path --query "authentication"
~~~

Claims bind to exact observation IDs and digests. A later scan marks a claim **stale** when supporting files change or disappear; it does not silently rewrite the statement. The available lenses are:

- **onboarding:** manifests, entrypoints, source roots, and active claims.
- **request_path:** paths and claims matching a bounded task query.
- **release_impact:** changed paths and stale claims since the previous snapshot.

Claim distribution is explicit: **local_only**, **personal_sync**, **trusted_team**, or **public_export**.

## Sync Gate

Sync Gate evaluates pending synchronized events against a destination:

| Destination | Intended boundary |
| --- | --- |
| personal_sync | a private remote controlled by one user |
| trusted_team | a bounded team trust domain |
| public_export | an explicitly public artifact |

~~~bash
moryn sync preflight --destination personal_sync --mode shadow
moryn sync preflight --destination trusted_team --mode enforce
moryn sync preflight --destination public_export --mode enforce
~~~

**shadow** reports what policy would do. **enforce** reports the blocking decision used by publication paths. **moryn sync --push** enforces the personal-sync policy before staging or committing.

New **local_only** payloads are routed to the ignored local event journal and are merged only when Moryn builds local read models. They do not enter the Git publication tree. Historical bytes that were already published are not rewritten or claimed to be erased.

The preflight receipt is content-free. It includes policy version, destination, event-set digest, decision counts, finding codes, and event/record IDs. It excludes record bodies and matched secret text.

## MCP parity

Every command above has a matching MCP tool:

~~~text
continuity_negotiate    continuity_transfer
repo_atlas_scan         repo_atlas_read
repo_atlas_view         repo_atlas_claim
sync_preflight
~~~

Use **moryn contracts operations --operation OPERATION** to inspect exact arguments and safety metadata.
