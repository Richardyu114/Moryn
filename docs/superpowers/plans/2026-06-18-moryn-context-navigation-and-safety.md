# Moryn Context Navigation And Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add context navigation, dashboard provenance, private safety boundaries, and clearer agent attribution so agents can start from high-signal memory and retrieve supporting evidence when needed.

**Architecture:** Keep write/replay as the source of truth. Add read-only query surfaces in the core engine, expose them through CLI/MCP/operation contracts, and let the dashboard consume the same record/event identifiers rather than inventing separate state.

**Tech Stack:** TypeScript, Vitest, Commander CLI, MCP SDK, static HTML dashboard.

---

### Task 1: Timeline / Around-Record

**Files:**
- Modify: `src/core/engine.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Modify: `src/operation-contracts.ts`
- Test: `tests/core/engine.test.ts`
- Test: `tests/cli/cli.test.ts`
- Test: `tests/mcp/server.test.ts`
- Test: `tests/smoke.test.ts`
- Docs: `README.md`, `docs/contracts.md`, `docs/agent-workflow.md`, `docs/moryn-design.md`

- [x] Add failing core tests for `engine.timeline({ record_id, before, after })` returning an anchor item, neighboring events, selection sources, and recall next actions.
- [x] Implement timeline input validation, event-to-record normalization, anchor lookup by `record_id`, `event_id`, or `query`, and chronological windows.
- [x] Add CLI command `moryn timeline` with `--record-id`, `--event-id`, `--query`, `--project-id`, `--project`, `--before`, and `--after`.
- [x] Add MCP tool `timeline` and operation contract discoverability.
- [x] Update docs with when to use timeline instead of recall.
- [x] Verify focused core, CLI, MCP, and typecheck commands.

### Task 2: Dashboard Citation And Record Links

**Files:**
- Modify: `src/observability/dashboard.ts`
- Modify: `src/core/engine.ts` if a shared citation helper is needed
- Test: `tests/observability/dashboard.test.ts`
- Docs: `docs/dashboard.md`, `docs/moryn-design.md`

- [ ] Add failing dashboard tests that visible recent values and agent activity expose record/event identifiers and stable link targets.
- [ ] Render compact source links in dashboard data/HTML for records, recent events, and health findings.
- [ ] Link dashboard source items to timeline commands/URLs where the static dashboard has enough identifier context.
- [ ] Verify dashboard tests and the live dashboard API.

### Task 3: Private Tags / Safety Boundary

**Files:**
- Modify: `src/core/engine.ts`
- Modify: `src/observability/dashboard.ts`
- Modify: `src/operation-contracts.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/core/engine.test.ts`
- Test: `tests/observability/dashboard.test.ts`
- Docs: `docs/agent-workflow.md`, `docs/moryn-design.md`, `docs/contracts.md`

- [ ] Define the default-hidden private marker contract, starting with tags such as `private`, `secret`, and `sensitive`.
- [ ] Add failing tests proving boot, default recall, refresh, and dashboard hide private-tagged active records unless explicitly requested.
- [ ] Add explicit opt-in flags/arguments for private reads.
- [ ] Update docs so future agents know private content requires explicit intent.

### Task 4: Observer Adapter

**Files:**
- Modify: `src/observability/dashboard.ts`
- Modify: `src/core/engine.ts` or create `src/core/agent-identity.ts` if reused by dashboard and lifecycle
- Test: `tests/observability/dashboard.test.ts`
- Docs: `docs/dashboard.md`, `docs/agent-install-prompt.md`, `docs/agent-workflow.md`

- [ ] Add failing tests for normalizing `codex`, `codex-cli`, `claude`, `kimi`, `gemini`, and generic `agent` sources into clear display actors.
- [ ] Implement a small observer adapter that derives display name, family, and confidence from source metadata without hard-coding dashboard-only behavior.
- [ ] Surface unknown clients as stable title-cased actor names rather than merging them into generic buckets.
- [ ] Update docs with source metadata expectations for future agents.

### Task 5: Final Verification And Sync

**Files:**
- Modify docs only if verification exposes wording gaps.

- [ ] Run targeted tests for each changed area.
- [ ] Run `npm run typecheck`, `npm run build`, and `git diff --check`.
- [ ] Commit and push code/docs.
- [ ] Write Moryn status/session summary, push Moryn sync, verify clean status.
- [ ] Rebuild or refresh the live dashboard served from the main build and check `/moryn-dashboard/api/dashboard`.
