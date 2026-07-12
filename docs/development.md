# Development

This document covers local development, release checks, package contents, and
public-repo hygiene for Moryn.

## Requirements

- Node.js 20 or newer
- npm
- Git

Install dependencies:

```bash
npm install
```

## Scripts

```bash
npm run build
npm run typecheck
npm test
npm run release:check
npm run smoke:dogfood-demo
npm run smoke:agent-lifecycle
npm run smoke:upgrade-compat
npm run smoke:sync-resilience
npm run smoke:sync-conflict
npm run smoke:permission-recovery
```

`npm run release:check` is the authoritative local release gate. It runs build,
typecheck, the full test suite, dogfood, cross-host lifecycle, v0.2 in-place
upgrade, sync-resilience, real-conflict guard, and permission-recovery smokes, package-content checks, and optional private Git remote
validation. Its final line is machine-readable JSON listing completed and
skipped checks.
`npm run smoke:dogfood-demo` validates the v0.2 default path on a temporary
local store: setup, context pack, low-risk autocapture, review-routed handoff,
and dashboard snapshot evidence.
`npm run smoke:agent-lifecycle` also validates the v0.3 checkpoint path on a
temporary store: authored local checkpoint, idempotent replay, bounded boot
recovery by session id, and the existing cross-store Git handoff flow.
`npm run smoke:upgrade-compat` materializes the frozen v0.2 disk contract
directly, opens it with the current CLI without an explicit migration or
rebuild, verifies the legacy event remains byte-identical, repairs verified
record and retrieval indexes lazily, and proves a new Codex learning is
available to a later Claude Code boot pack.
`npm run smoke:sync-resilience` makes a configured local Git remote temporarily
unavailable during `agent finish`. It verifies the handoff is committed and
searchable locally, the push failure is recoverable, the store remains ahead,
and the next `agent enter` compensates automatically before a second device
pulls and recalls the handoff.
`npm run smoke:sync-conflict` creates a real add/add conflict in the append-only
event tree. It requires sync status to report `safe_to_retry_sync: false`,
blocks `agent finish` before any new event is written, preserves both Git index
stages, and returns an explicit manual conflict-resolution boundary.
`npm run smoke:permission-recovery` uses a deterministic SSH wrapper to return
`Permission denied (publickey)`. It proves the handoff is still committed and
searchable locally, credentials are never copied into events, the response
forbids exposing keys or retry loops, and a later `agent enter` publishes the
pending handoff automatically after the external Git access is repaired.

To validate with a real remote, use a dedicated test repository:

```bash
MORYN_PRIVATE_GIT_REMOTE=git@github.com:yourname/moryn-store-release-test.git npm run release:check
```

The check writes a release-test event. Do not use a production Moryn data repo.

## Source Layout

```text
src/
  cli.ts                    CLI commands and CLI recovery envelopes
  mcp/server.ts             MCP stdio server and MCP argument normalization
  operation-contracts.ts    Static operation contract registry
  core/
    engine.ts               Record write, recall, boot, refresh, mutations
    agent-lifecycle.ts      Agent enter/start/status/finish/doctor/guide
    action-interfaces.ts    CLI/MCP action rendering
    action-safety.ts        Execution readiness and runbook metadata
    config.ts               Local store config
    project.ts              Project identity and .moryn.json config
    store.ts                Append-only event files
    replay.ts               Event replay
    derived.ts              Rebuildable snapshots and indexes
    errors.ts               Error envelopes and recovery actions
    sensitive.ts            Sensitive-content detection/redaction
    schema.ts               Runtime validation
    types.ts                Shared types
  sync/git.ts               Private Git sync adapter
```

The largest files are currently `src/core/engine.ts`,
`src/core/agent-lifecycle.ts`, `src/mcp/server.ts`, `tests/cli/cli.test.ts`,
and `tests/mcp/server.test.ts`. They are stable and heavily covered, but they
are clear future refactor candidates. This public-polish pass intentionally
does not split them because broad structural moves would create avoidable risk.

Recommended future splits:

- move recall/boot/refresh helpers out of `engine.ts`
- move lifecycle response builders out of `agent-lifecycle.ts`
- move MCP alias normalization and tool registration into separate modules
- split CLI and MCP tests by command group

## Local Files

Do not commit local runtime or host configuration:

- `.moryn.json`
- `.moryn/`
- `.gemini/`
- `.worktrees/`
- `dist/`
- `coverage/`
- `*.tgz`

Project config examples belong in docs, not in the repository root.

## Package Contents

The npm package includes:

- `dist`
- `README.md`
- `docs`
- `assets`
- `scripts/agent-lifecycle-smoke.js`
- `scripts/dogfood-demo-smoke.js`

The release check rejects private Moryn store data such as `.moryn/`,
`events/`, `snapshots/`, `indexes/`, `config.json`, or packed tarballs.

Inspect package contents with:

```bash
npm pack --dry-run --json
```

## Documentation Policy

README should stay short and user-facing:

- what Moryn is
- copy-paste agent install prompt
- short manual install
- MCP setup
- links to deeper docs

Long protocol details belong in:

- `docs/agent-install-prompt.md`
- `docs/agent-workflow.md`
- `docs/contracts.md`
- `docs/moryn-design.md`

Implementation history and future work belong in:

- `docs/implementation-roadmap.md`

## Release Checklist

Before publishing:

1. Confirm `package.json`, `package-lock.json`, `src/index.ts`, and
   `CHANGELOG.md` describe the same release version.
2. Run `npm run release:check`.
3. Run `npm run smoke:dogfood-demo`.
4. Run `npm run smoke:agent-lifecycle`.
5. Run `npm run smoke:upgrade-compat`.
6. Run `npm run smoke:sync-resilience`.
7. Run `npm run smoke:sync-conflict`.
8. Run `npm run smoke:permission-recovery`.
9. Inspect `npm pack --dry-run --json`.
10. Confirm no private memory store data is included.
11. Confirm README, CHANGELOG, and docs describe the current public interface.
12. Publish only to the official npm registry:

   ```bash
   npm publish --dry-run --access public --registry https://registry.npmjs.org
   npm publish --access public --registry https://registry.npmjs.org
   ```

13. If npm requires two-factor auth for publishing, use a granular access token
   with publish permission and bypass-2FA enabled, or publish from a session
   that can satisfy the account's configured 2FA policy.
14. After publishing, verify the public package and release bins:

   ```bash
   npm view @richardyu114/moryn version --registry https://registry.npmjs.org
   npm install -g @richardyu114/moryn --registry https://registry.npmjs.org
   moryn --version
   moryn-agent-smoke --dist
   ```

## Logical Working-Set Capacity

`buildWorkingSetReport(storePath, options)` is a read-only capacity diagnostic for store growth. It reports visible event and record counts, active logical records, hidden duplicate/superseded/revised records, conflicts, cycles, the number of records selected by default boot, and the logical compaction ratio.

Private-tagged records are excluded by default. Pass `include_private: true` only inside an explicitly authorized private read path. The dashboard uses this report for the quiet Memory Flow summary; it does not create approval queues or maintenance actions.

The dogfood smoke writes 100 duplicate records, links them to one canonical record, and verifies that the active logical set and default boot context remain bounded:

```bash
npm run smoke:dogfood-demo
```

## Semantic Consolidation Acceptance

Before releasing the semantic consolidation lifecycle, run the focused Phase 7
suite plus both source-mode smoke scripts:

```bash
npx vitest run \
  tests/core/context-delta.test.ts \
  tests/core/semantic-consolidation-candidates.test.ts \
  tests/core/semantic-consolidation.test.ts \
  tests/core/semantic-consolidation-engine.test.ts \
  tests/core/checkpoint.test.ts \
  tests/e2e/agent-lifecycle.test.ts \
  tests/observability/dashboard.test.ts \
  tests/core/working-set-report.test.ts
npm run smoke:dogfood-demo
npm run smoke:agent-lifecycle
```

The dogfood smoke creates one hundred paraphrased candidate records, submits
bounded agent-authored `duplicate_of` proposals, and requires the active logical
working set and default boot set to remain bounded. The lifecycle smoke verifies
Codex `PreCompact` capture, one accepted semantic link, one protected-signal
rejection, Claude Code `PostCompact` restore and finish/push, and a second Codex
device pull. These paths are automatic and must not introduce routine dashboard
approval work.
