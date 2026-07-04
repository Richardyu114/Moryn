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
```

`npm run release:check` runs build, typecheck, tests, package-content checks,
and optional private Git remote validation.
`npm run smoke:dogfood-demo` validates the v0.2 default path on a temporary
local store: setup, context pack, low-risk autocapture, review-routed handoff,
and dashboard snapshot evidence.

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
5. Inspect `npm pack --dry-run --json`.
6. Confirm no private memory store data is included.
7. Confirm README, CHANGELOG, and docs describe the current public interface.
8. Publish only to the official npm registry:

   ```bash
   npm publish --dry-run --access public --registry https://registry.npmjs.org
   npm publish --access public --registry https://registry.npmjs.org
   ```

9. If npm requires two-factor auth for publishing, use a granular access token
   with publish permission and bypass-2FA enabled, or publish from a session
   that can satisfy the account's configured 2FA policy.
10. After publishing, verify the public package and both bins:

   ```bash
   npm view @richardyu114/moryn version --registry https://registry.npmjs.org
   npm install -g @richardyu114/moryn --registry https://registry.npmjs.org
   moryn --version
   moryn-agent-smoke --dist
   ```
