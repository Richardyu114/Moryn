# Memora MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first runnable Memora MVP: a TypeScript CLI and core engine that can initialize a local store, append/replay events, write/revise/promote records, generate boot context, recall relevant records, list recent records, and expose a minimal MCP-compatible stdio server.

**Architecture:** Implement a small TypeScript package with a framework-light core engine and thin adapters for CLI and MCP. The source of truth is append-only JSON event files under `~/.memora` or an explicit test/store path; snapshots and indexes are derived in memory for the MVP. Git sync starts as local Git command integration for configured repos, with full remote workflows kept minimal.

**Tech Stack:** Node.js 24, TypeScript, Vitest, Commander, Zod, tsx, npm.

---

## File Structure

- Create `package.json`: npm scripts, binary command, dependencies, package metadata.
- Create `tsconfig.json`: strict ESM TypeScript build config.
- Create `vitest.config.ts`: test config.
- Create `src/index.ts`: public exports.
- Create `src/cli.ts`: `mem` command entrypoint using Commander.
- Create `src/mcp/server.ts`: minimal newline-delimited JSON stdio server exposing Memora operations.
- Create `src/core/types.ts`: record, event, state, scope, and API input/output types.
- Create `src/core/schema.ts`: Zod schemas and validation helpers.
- Create `src/core/id.ts`: deterministic ID helpers for tests and production ID generation.
- Create `src/core/project.ts`: project identity resolver.
- Create `src/core/store.ts`: filesystem event store.
- Create `src/core/replay.ts`: replay event history into current records.
- Create `src/core/engine.ts`: boot, recall, write, revise, promote, list recent, sync check.
- Create `src/core/sensitive.ts`: simple secret detection.
- Create `src/sync/git.ts`: minimal Git sync adapter.
- Create `tests/helpers/temp-store.ts`: temporary store helper.
- Create `tests/core/*.test.ts`: core tests.
- Create `tests/cli/*.test.ts`: CLI smoke tests.
- Create `tests/mcp/*.test.ts`: MCP stdio smoke tests.
- Modify `README.md`: replace design-stage wording with MVP usage once commands exist.

## MVP Scope

This plan implements:

- `mem init`
- `mem boot --project <path>`
- `mem write`
- `mem recall`
- `mem revise`
- `mem promote`
- `mem list-recent`
- `mem sync --status`
- `mem mcp`

This plan intentionally does not implement:

- Hosted sync.
- Embedding search.
- Full GitHub auth management.
- Team permissions.
- Web UI.

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/cli.ts`
- Create: `tests/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";

describe("package smoke test", () => {
  it("exports a version string", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run the smoke test and verify it fails**

Run:

```bash
npm test -- tests/smoke.test.ts
```

Expected: command fails because `package.json` and test tooling do not exist yet.

- [ ] **Step 3: Add package tooling**

Create `package.json`:

```json
{
  "name": "memora",
  "version": "0.1.0",
  "description": "A personal memory, skill, and soul layer for AI agents.",
  "type": "module",
  "bin": {
    "mem": "./dist/cli.js"
  },
  "files": [
    "dist",
    "README.md",
    "docs",
    "assets"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "commander": "^14.0.2",
    "zod": "^4.1.13"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "tsx": "^4.21.0",
    "typescript": "^5.9.3",
    "vitest": "^4.0.14"
  },
  "engines": {
    "node": ">=20"
  },
  "license": "UNLICENSED"
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000
  }
});
```

Create `src/index.ts`:

```ts
export const version = "0.1.0";
```

Create `src/cli.ts`:

```ts
#!/usr/bin/env node

import { Command } from "commander";
import { version } from "./index.js";

const program = new Command();

program
  .name("mem")
  .description("Memora CLI")
  .version(version);

program.parse();
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` and `node_modules/` are created.

- [ ] **Step 5: Run smoke test and typecheck**

Run:

```bash
npm test -- tests/smoke.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit scaffold**

Run:

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src/index.ts src/cli.ts tests/smoke.test.ts
git commit -m "chore: scaffold TypeScript package"
```

## Task 2: Record Schemas and Validation

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/schema.ts`
- Create: `tests/core/schema.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/core/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRecord } from "../../src/core/schema.js";

describe("record schema", () => {
  it("accepts a valid memory record", () => {
    const record = parseRecord({
      id: "rec_test",
      kind: "memory",
      type: "decision",
      scope: "project",
      project_id: "memora",
      tags: ["sync"],
      content: { text: "Use append-only events.", format: "text" },
      state: "canonical",
      confidence: 0.9,
      priority: "normal",
      visibility: "active",
      created_at: "2026-05-27T00:00:00.000Z",
      updated_at: "2026-05-27T00:00:00.000Z",
      source: { client: "codex", session_id: "sess_1", model: "gpt-5" }
    });

    expect(record.kind).toBe("memory");
  });

  it("rejects invalid state values", () => {
    expect(() =>
      parseRecord({
        id: "rec_test",
        kind: "memory",
        type: "decision",
        scope: "project",
        content: { text: "Bad state", format: "text" },
        state: "published",
        source: { client: "codex" }
      })
    ).toThrow(/Invalid record/);
  });
});
```

- [ ] **Step 2: Run schema tests and verify they fail**

Run:

```bash
npm test -- tests/core/schema.test.ts
```

Expected: fail because `src/core/schema.ts` does not exist.

- [ ] **Step 3: Implement record types**

Create `src/core/types.ts`:

```ts
export type RecordKind = "memory" | "skill" | "soul" | "session_summary" | "agent_note";
export type RecordState = "raw" | "candidate" | "canonical" | "archived" | "quarantined";
export type RecordScope = "global" | "project" | "topic" | "session" | "artifact";
export type RecordPriority = "low" | "normal" | "high";
export type RecordVisibility = "active" | "archived" | "quarantined";

export interface RecordContent {
  text?: string;
  format?: "text" | "json";
  [key: string]: unknown;
}

export interface RecordSource {
  client: string;
  session_id?: string;
  model?: string;
  device_id?: string;
}

export interface RecordProvenance {
  derived_from?: string[];
  reason?: string;
}

export interface MemoraRecord {
  id: string;
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  tags: string[];
  content: RecordContent;
  state: RecordState;
  confidence: number;
  priority: RecordPriority;
  visibility: RecordVisibility;
  created_at: string;
  updated_at: string;
  source: RecordSource;
  provenance?: RecordProvenance;
}
```

- [ ] **Step 4: Implement schemas**

Create `src/core/schema.ts`:

```ts
import { z } from "zod";

export const recordKindSchema = z.enum(["memory", "skill", "soul", "session_summary", "agent_note"]);
export const recordStateSchema = z.enum(["raw", "candidate", "canonical", "archived", "quarantined"]);
export const recordScopeSchema = z.enum(["global", "project", "topic", "session", "artifact"]);
export const recordPrioritySchema = z.enum(["low", "normal", "high"]);
export const recordVisibilitySchema = z.enum(["active", "archived", "quarantined"]);

export const recordSourceSchema = z.object({
  client: z.string().min(1),
  session_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  device_id: z.string().min(1).optional()
});

export const recordSchema = z.object({
  id: z.string().min(1),
  kind: recordKindSchema,
  type: z.string().min(1),
  scope: recordScopeSchema,
  project_id: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]),
  content: z.record(z.string(), z.unknown()).and(z.object({
    text: z.string().optional(),
    format: z.enum(["text", "json"]).optional()
  })),
  state: recordStateSchema,
  confidence: z.number().min(0).max(1).default(0.5),
  priority: recordPrioritySchema.default("normal"),
  visibility: recordVisibilitySchema.default("active"),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  source: recordSourceSchema,
  provenance: z.object({
    derived_from: z.array(z.string()).optional(),
    reason: z.string().optional()
  }).optional()
});

export type ParsedRecord = z.infer<typeof recordSchema>;

export function parseRecord(input: unknown): ParsedRecord {
  const result = recordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid record: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
```

Modify `src/index.ts`:

```ts
export const version = "0.1.0";
export { parseRecord } from "./core/schema.js";
export type { MemoraRecord } from "./core/types.js";
```

- [ ] **Step 5: Run schema tests and typecheck**

Run:

```bash
npm test -- tests/core/schema.test.ts
npm run typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit schema work**

Run:

```bash
git add src/core/types.ts src/core/schema.ts src/index.ts tests/core/schema.test.ts
git commit -m "feat: add record schema validation"
```

## Task 3: Event Store and Replay

**Files:**
- Create: `src/core/id.ts`
- Create: `src/core/store.ts`
- Create: `src/core/replay.ts`
- Create: `tests/helpers/temp-store.ts`
- Create: `tests/core/store.test.ts`
- Create: `tests/core/replay.test.ts`
- Modify: `src/core/types.ts`

- [ ] **Step 1: Write failing event store tests**

Create `tests/helpers/temp-store.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withTempStore<T>(fn: (storePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memora-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

Create `tests/core/store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../../src/core/store.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("event store", () => {
  it("appends events under device and month partitions", async () => {
    await withTempStore(async (storePath) => {
      await appendEvent(storePath, {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test", device_id: "device_a" },
        record: {
          id: "rec_1",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "A", format: "text" },
          state: "canonical",
          confidence: 1,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      });

      const events = await readEvents(storePath);
      expect(events).toHaveLength(1);
      expect(events[0]?.event_id).toBe("evt_1");
    });
  });
});
```

Create `tests/core/replay.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { replayEvents } from "../../src/core/replay.js";

describe("event replay", () => {
  it("applies upsert, revise, and promote events", () => {
    const records = replayEvents([
      {
        event_id: "evt_1",
        op: "upsert_record",
        created_at: "2026-05-27T00:00:00.000Z",
        source: { client: "test" },
        record: {
          id: "rec_1",
          kind: "memory",
          type: "decision",
          scope: "project",
          tags: [],
          content: { text: "Old", format: "text" },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: "2026-05-27T00:00:00.000Z",
          updated_at: "2026-05-27T00:00:00.000Z",
          source: { client: "test" }
        }
      },
      {
        event_id: "evt_2",
        op: "revise_record",
        record_id: "rec_1",
        patch: { "content.text": "New", confidence: 0.9 },
        reason: "Refined",
        created_at: "2026-05-27T00:01:00.000Z",
        source: { client: "test" }
      },
      {
        event_id: "evt_3",
        op: "promote_record",
        record_id: "rec_1",
        target_state: "canonical",
        reason: "Confirmed",
        created_at: "2026-05-27T00:02:00.000Z",
        source: { client: "test" }
      }
    ]);

    const record = records.get("rec_1");
    expect(record?.content.text).toBe("New");
    expect(record?.confidence).toBe(0.9);
    expect(record?.state).toBe("canonical");
  });
});
```

- [ ] **Step 2: Run event tests and verify they fail**

Run:

```bash
npm test -- tests/core/store.test.ts tests/core/replay.test.ts
```

Expected: fail because store and replay modules do not exist.

- [ ] **Step 3: Add event types**

Modify `src/core/types.ts` by appending:

```ts
export type MemoraEvent =
  | {
      event_id: string;
      op: "upsert_record";
      record: MemoraRecord;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "revise_record";
      record_id: string;
      patch: Record<string, unknown>;
      reason?: string;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "promote_record" | "archive_record" | "quarantine_record";
      record_id: string;
      target_state?: RecordState;
      reason?: string;
      created_at: string;
      source: RecordSource;
    }
  | {
      event_id: string;
      op: "link_records";
      record_id: string;
      linked_record_id: string;
      link_type: string;
      created_at: string;
      source: RecordSource;
    };
```

- [ ] **Step 4: Implement ID helper**

Create `src/core/id.ts`:

```ts
import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}
```

- [ ] **Step 5: Implement event store**

Create `src/core/store.ts`:

```ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoraEvent } from "./types.js";

function monthFromIso(iso: string): string {
  return iso.slice(0, 7);
}

function deviceFromEvent(event: MemoraEvent): string {
  return event.source.device_id ?? "device_default";
}

function eventPath(storePath: string, event: MemoraEvent): string {
  return join(storePath, "events", deviceFromEvent(event), monthFromIso(event.created_at), `${event.event_id}.json`);
}

export async function appendEvent(storePath: string, event: MemoraEvent): Promise<string> {
  const path = eventPath(storePath, event);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  return path;
}

async function walkJsonFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(path);
    }
  }
  return files;
}

export async function readEvents(storePath: string): Promise<MemoraEvent[]> {
  const files = await walkJsonFiles(join(storePath, "events"));
  const events = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8")) as MemoraEvent));
  return events.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.event_id.localeCompare(b.event_id));
}
```

- [ ] **Step 6: Implement replay**

Create `src/core/replay.ts`:

```ts
import type { MemoraEvent, MemoraRecord, RecordState } from "./types.js";

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const existing = cursor[part];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

export function replayEvents(events: MemoraEvent[]): Map<string, MemoraRecord> {
  const records = new Map<string, MemoraRecord>();

  for (const event of events) {
    if (event.op === "upsert_record") {
      records.set(event.record.id, structuredClone(event.record));
      continue;
    }

    if (event.op === "revise_record") {
      const record = records.get(event.record_id);
      if (!record) continue;
      const next = structuredClone(record) as unknown as Record<string, unknown>;
      for (const [path, value] of Object.entries(event.patch)) {
        setPath(next, path, value);
      }
      next.updated_at = event.created_at;
      records.set(event.record_id, next as unknown as MemoraRecord);
      continue;
    }

    if (event.op === "promote_record" || event.op === "archive_record" || event.op === "quarantine_record") {
      const record = records.get(event.record_id);
      if (!record) continue;
      const state = event.target_state ?? (event.op === "archive_record" ? "archived" : "quarantined");
      records.set(event.record_id, {
        ...record,
        state: state as RecordState,
        visibility: state === "canonical" || state === "candidate" || state === "raw" ? "active" : state,
        updated_at: event.created_at
      });
    }
  }

  return records;
}
```

- [ ] **Step 7: Run event tests and typecheck**

Run:

```bash
npm test -- tests/core/store.test.ts tests/core/replay.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 8: Commit event store**

Run:

```bash
git add src/core/id.ts src/core/store.ts src/core/replay.ts src/core/types.ts tests/helpers/temp-store.ts tests/core/store.test.ts tests/core/replay.test.ts
git commit -m "feat: add event store and replay"
```

## Task 4: Core Engine Operations

**Files:**
- Create: `src/core/engine.ts`
- Create: `src/core/sensitive.ts`
- Create: `tests/core/engine.test.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write failing engine tests**

Create `tests/core/engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("core engine", () => {
  it("writes, recalls, revises, and promotes records", async () => {
    await withTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_1` });

      const written = await engine.write({
        kind: "memory",
        type: "decision",
        scope: "project",
        project_id: "memora",
        tags: ["sync"],
        content: { text: "Use GitHub sync.", format: "text" },
        state: "candidate",
        source: { client: "test" }
      });

      await engine.revise({ record_id: written.record.id, patch: { "content.text": "Use private GitHub sync." }, reason: "Clarify privacy" });
      await engine.promote({ record_id: written.record.id, target_state: "canonical", reason: "User confirmed" });

      const recall = await engine.recall({ query: "github sync", project_id: "memora", limit: 5 });
      expect(recall.results[0]?.record.content.text).toBe("Use private GitHub sync.");
      expect(recall.results[0]?.record.state).toBe("canonical");
    });
  });

  it("quarantines sensitive content on write", async () => {
    await withTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-05-27T00:00:00.000Z", id: (prefix) => `${prefix}_1` });

      const written = await engine.write({
        kind: "agent_note",
        type: "note",
        scope: "project",
        project_id: "memora",
        content: { text: "API_KEY=sk-1234567890abcdef", format: "text" },
        source: { client: "test" }
      });

      expect(written.record.state).toBe("quarantined");
      expect(written.warning?.code).toBe("SENSITIVE_CONTENT_DETECTED");
    });
  });
});
```

- [ ] **Step 2: Run engine tests and verify they fail**

Run:

```bash
npm test -- tests/core/engine.test.ts
```

Expected: fail because `src/core/engine.ts` does not exist.

- [ ] **Step 3: Implement sensitive content detection**

Create `src/core/sensitive.ts`:

```ts
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/,
  /api[_-]?key\s*=\s*["']?[A-Za-z0-9_-]{10,}/i,
  /password\s*=\s*["']?[^"'\s]{8,}/i,
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/
];

export interface SensitiveCheckResult {
  sensitive: boolean;
  reason?: string;
}

export function detectSensitiveContent(text: string): SensitiveCheckResult {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return { sensitive: true, reason: pattern.source };
    }
  }
  return { sensitive: false };
}
```

- [ ] **Step 4: Implement core engine**

Create `src/core/engine.ts`:

```ts
import { appendEvent, readEvents } from "./store.js";
import { replayEvents } from "./replay.js";
import { detectSensitiveContent } from "./sensitive.js";
import type { MemoraEvent, MemoraRecord, RecordKind, RecordScope, RecordSource, RecordState } from "./types.js";
import { createId } from "./id.js";

interface EngineDeps {
  storePath: string;
  now?: () => string;
  id?: (prefix: string) => string;
}

interface WriteInput {
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  tags?: string[];
  content: Record<string, unknown> & { text?: string; format?: "text" | "json" };
  state?: RecordState;
  confidence?: number;
  priority?: "low" | "normal" | "high";
  source: RecordSource;
}

interface RecallInput {
  query?: string;
  project_id?: string;
  kinds?: RecordKind[];
  limit?: number;
}

function textOf(record: MemoraRecord): string {
  return String(record.content.text ?? "");
}

function queryScore(record: MemoraRecord, query: string | undefined, projectId: string | undefined): number {
  let score = 0;
  if (projectId && record.project_id === projectId) score += 10;
  if (record.scope === "global") score += 2;
  if (record.state === "canonical") score += 8;
  if (record.state === "candidate") score += 4;
  if (record.priority === "high") score += 5;
  if (query) {
    const haystack = `${textOf(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
    for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) score += 3;
    }
  }
  return score;
}

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? createId;

  async function currentRecords(): Promise<MemoraRecord[]> {
    return [...replayEvents(await readEvents(deps.storePath)).values()];
  }

  return {
    async write(input: WriteInput) {
      const createdAt = now();
      const text = typeof input.content.text === "string" ? input.content.text : JSON.stringify(input.content);
      const sensitive = detectSensitiveContent(text);
      const state = sensitive.sensitive ? "quarantined" : (input.state ?? (input.kind === "agent_note" ? "raw" : "candidate"));
      const record: MemoraRecord = {
        id: id("rec"),
        kind: input.kind,
        type: input.type,
        scope: input.scope,
        project_id: input.project_id,
        tags: input.tags ?? [],
        content: input.content,
        state,
        confidence: input.confidence ?? 0.5,
        priority: input.priority ?? "normal",
        visibility: state === "quarantined" ? "quarantined" : state === "archived" ? "archived" : "active",
        created_at: createdAt,
        updated_at: createdAt,
        source: input.source
      };
      const event: MemoraEvent = { event_id: id("evt"), op: "upsert_record", record, created_at: createdAt, source: input.source };
      await appendEvent(deps.storePath, event);
      return {
        record,
        warning: sensitive.sensitive ? { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason } : undefined
      };
    },

    async revise(input: { record_id: string; patch: Record<string, unknown>; reason?: string; source?: RecordSource }) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "revise_record",
        record_id: input.record_id,
        patch: input.patch,
        reason: input.reason,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async promote(input: { record_id: string; target_state: RecordState; reason?: string; source?: RecordSource }) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "promote_record",
        record_id: input.record_id,
        target_state: input.target_state,
        reason: input.reason,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async recall(input: RecallInput) {
      const records = (await currentRecords())
        .filter((record) => record.state !== "archived" && record.state !== "quarantined")
        .filter((record) => !input.kinds || input.kinds.includes(record.kind))
        .map((record) => ({
          record,
          score: queryScore(record, input.query, input.project_id),
          reason: [record.project_id === input.project_id ? "same_project" : record.scope, record.state]
        }))
        .filter((result) => result.score > 0 || !input.query)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10);
      return { results: records };
    },

    async boot(input: { project_id?: string }) {
      const recall = await this.recall({ project_id: input.project_id, limit: 10 });
      return {
        profile: { user_preferences: [], soul: [], global_rules: [] },
        project: {
          summary: "",
          tech_stack: [],
          active_goals: [],
          important_decisions: recall.results.filter((r) => r.record.type === "decision").map((r) => r.record),
          warnings: recall.results.filter((r) => r.record.type === "warning" || r.record.type === "blocker").map((r) => r.record)
        },
        skills: recall.results.filter((r) => r.record.kind === "skill").map((r) => r.record),
        recent_changes: [],
        sync: { cursor: new Date().toISOString(), remote_has_updates: false }
      };
    },

    async listRecent(limit = 20) {
      return (await currentRecords()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
    }
  };
}
```

Modify `src/index.ts`:

```ts
export const version = "0.1.0";
export { createEngine } from "./core/engine.js";
export { parseRecord } from "./core/schema.js";
export type { MemoraRecord } from "./core/types.js";
```

- [ ] **Step 5: Run engine tests and typecheck**

Run:

```bash
npm test -- tests/core/engine.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 6: Commit engine**

Run:

```bash
git add src/core/engine.ts src/core/sensitive.ts src/index.ts tests/core/engine.test.ts
git commit -m "feat: add core memory engine"
```

## Task 5: CLI Commands

**Files:**
- Modify: `src/cli.ts`
- Create: `src/core/project.ts`
- Create: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing CLI smoke tests**

Create `tests/cli/cli.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "memora-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mem CLI", () => {
  it("initializes a store and writes a record", async () => {
    await withTempDir(async (dir) => {
      await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "init"]);
      const write = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "memora", "--text", "Use events"]);
      expect(write.stdout).toContain("rec_");
      const recall = await exec("node", ["--import", "tsx", "src/cli.ts", "--store", dir, "recall", "events", "--project-id", "memora"]);
      expect(recall.stdout).toContain("Use events");
    });
  });
});
```

- [ ] **Step 2: Run CLI tests and verify they fail**

Run:

```bash
npm test -- tests/cli/cli.test.ts
```

Expected: fail because CLI commands are not implemented.

- [ ] **Step 3: Implement project helper**

Create `src/core/project.ts`:

```ts
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export function projectIdFromPath(projectPath: string): string {
  const resolved = resolve(projectPath);
  const name = basename(resolved) || "project";
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `${name}-${hash}`;
}
```

- [ ] **Step 4: Implement CLI**

Replace `src/cli.ts` with:

```ts
#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Command } from "commander";
import { version } from "./index.js";
import { createEngine } from "./core/engine.js";

const program = new Command();

function storePath(): string {
  return program.opts<{ store?: string }>().store ?? join(homedir(), ".memora");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

program
  .name("mem")
  .description("Memora CLI")
  .version(version)
  .option("--store <path>", "Override Memora store path");

program.command("init").action(async () => {
  const path = storePath();
  await mkdir(join(path, "events"), { recursive: true });
  await mkdir(join(path, "snapshots"), { recursive: true });
  await mkdir(join(path, "indexes"), { recursive: true });
  printJson({ ok: true, store: path });
});

program.command("write")
  .requiredOption("--kind <kind>")
  .requiredOption("--type <type>")
  .requiredOption("--scope <scope>")
  .option("--project-id <id>")
  .requiredOption("--text <text>")
  .action(async (options) => {
    const engine = createEngine({ storePath: storePath() });
    const result = await engine.write({
      kind: options.kind,
      type: options.type,
      scope: options.scope,
      project_id: options.projectId,
      content: { text: options.text, format: "text" },
      source: { client: "cli" }
    });
    printJson(result);
  });

program.command("recall")
  .argument("[query]", "Search query")
  .option("--project-id <id>")
  .option("--limit <n>", "Result limit", "10")
  .action(async (query, options) => {
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.recall({ query, project_id: options.projectId, limit: Number(options.limit) }));
  });

program.command("boot")
  .option("--project-id <id>")
  .action(async (options) => {
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.boot({ project_id: options.projectId }));
  });

program.command("revise")
  .argument("<record-id>")
  .requiredOption("--set <assignment>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const [key, ...rest] = String(options.set).split("=");
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.revise({ record_id: recordId, patch: { [key]: rest.join("=") }, reason: options.reason, source: { client: "cli" } }));
  });

program.command("promote")
  .argument("<record-id>")
  .requiredOption("--state <state>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.promote({ record_id: recordId, target_state: options.state, reason: options.reason, source: { client: "cli" } }));
  });

program.command("list-recent")
  .option("--limit <n>", "Result limit", "20")
  .action(async (options) => {
    const engine = createEngine({ storePath: storePath() });
    printJson(await engine.listRecent(Number(options.limit)));
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run CLI tests and all tests**

Run:

```bash
npm test -- tests/cli/cli.test.ts
npm test
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit CLI**

Run:

```bash
git add src/cli.ts src/core/project.ts tests/cli/cli.test.ts
git commit -m "feat: add Memora CLI commands"
```

## Task 6: Minimal MCP Stdio Server

**Files:**
- Create: `src/mcp/server.ts`
- Create: `tests/mcp/server.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing MCP smoke test**

Create `tests/mcp/server.test.ts`:

```ts
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("MCP stdio server", () => {
  it("handles newline-delimited boot requests", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-"));
    try {
      const child = spawn("node", ["--import", "tsx", "src/cli.ts", "--store", store, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
      const output = new Promise<string>((resolve) => {
        child.stdout.on("data", (chunk) => resolve(String(chunk)));
      });
      child.stdin.write(`${JSON.stringify({ id: 1, method: "boot", params: { project_id: "memora" } })}\n`);
      const line = await output;
      child.kill();
      expect(line).toContain("\"id\":1");
      expect(line).toContain("\"profile\"");
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run MCP test and verify it fails**

Run:

```bash
npm test -- tests/mcp/server.test.ts
```

Expected: fail because `mem mcp` is not implemented.

- [ ] **Step 3: Implement minimal server**

Create `src/mcp/server.ts`:

```ts
import { createInterface } from "node:readline/promises";
import type { createEngine } from "../core/engine.js";

type Engine = ReturnType<typeof createEngine>;

interface RpcRequest {
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export async function runMcpServer(engine: Engine): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as RpcRequest;
    try {
      let result: unknown;
      if (request.method === "boot") result = await engine.boot({ project_id: request.params?.project_id as string | undefined });
      else if (request.method === "recall") result = await engine.recall(request.params ?? {});
      else if (request.method === "list_recent") result = await engine.listRecent(Number(request.params?.limit ?? 20));
      else throw new Error(`Unknown method: ${request.method}`);
      process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ id: request.id, error: { message } })}\n`);
    }
  }
}
```

Modify `src/cli.ts` by importing and adding command:

```ts
import { runMcpServer } from "./mcp/server.js";
```

Add before `program.parseAsync()`:

```ts
program.command("mcp").action(async () => {
  const engine = createEngine({ storePath: storePath() });
  await runMcpServer(engine);
});
```

- [ ] **Step 4: Run MCP test and typecheck**

Run:

```bash
npm test -- tests/mcp/server.test.ts
npm run typecheck
```

Expected: pass.

- [ ] **Step 5: Commit MCP skeleton**

Run:

```bash
git add src/mcp/server.ts src/cli.ts tests/mcp/server.test.ts
git commit -m "feat: add minimal MCP stdio server"
```

## Task 7: Sync Status and Git Adapter Skeleton

**Files:**
- Create: `src/sync/git.ts`
- Create: `tests/sync/git.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write failing sync adapter test**

Create `tests/sync/git.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGitSyncStatus } from "../../src/sync/git.js";

describe("git sync adapter", () => {
  it("reports unconfigured status outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memora-sync-"));
    try {
      const status = await getGitSyncStatus(dir);
      expect(status.configured).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run sync test and verify it fails**

Run:

```bash
npm test -- tests/sync/git.test.ts
```

Expected: fail because `src/sync/git.ts` does not exist.

- [ ] **Step 3: Implement sync adapter status**

Create `src/sync/git.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitSyncStatus {
  configured: boolean;
  branch?: string;
  remote?: string;
  error?: string;
}

export async function getGitSyncStatus(cwd: string): Promise<GitSyncStatus> {
  try {
    const [{ stdout: branch }, { stdout: remote }] = await Promise.all([
      exec("git", ["branch", "--show-current"], { cwd }),
      exec("git", ["remote", "get-url", "origin"], { cwd })
    ]);
    return { configured: true, branch: branch.trim(), remote: remote.trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: false, error: message };
  }
}
```

- [ ] **Step 4: Add CLI sync status command**

Modify `src/cli.ts` with import:

```ts
import { getGitSyncStatus } from "./sync/git.js";
```

Add command:

```ts
program.command("sync")
  .option("--status", "Show sync status")
  .action(async () => {
    printJson(await getGitSyncStatus(process.cwd()));
  });
```

- [ ] **Step 5: Run sync test and full verification**

Run:

```bash
npm test -- tests/sync/git.test.ts
npm test
npm run typecheck
npm run build
```

Expected: all pass.

- [ ] **Step 6: Commit sync skeleton**

Run:

```bash
git add src/sync/git.ts src/cli.ts tests/sync/git.test.ts
git commit -m "feat: add git sync status skeleton"
```

## Task 8: README Update and Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README command status**

Modify README's status block to:

```md
> Status: early MVP implementation. Core local memory operations are being built from the first-version design in [docs/memora-design.md](docs/memora-design.md).
```

Add a short "Current MVP Commands" section after Planned Usage:

```md
## Current MVP Commands

The first implementation targets these commands:

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
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git status --short --branch
```

Expected: tests, typecheck, and build pass. Git status shows only README changes.

- [ ] **Step 3: Commit README update**

Run:

```bash
git add README.md
git commit -m "docs: update README with MVP commands"
```

## Task 9: Merge Preparation

**Files:**
- No file changes expected.

- [ ] **Step 1: Run final verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git status --short --branch
git log --oneline --decorate -10
```

Expected: all checks pass, worktree is clean, and branch is ahead of `main` with task commits.

- [ ] **Step 2: Push feature branch**

Run:

```bash
git push -u origin feature/mvp-core
```

Expected: feature branch pushed.

- [ ] **Step 3: Report implementation summary**

Report:

- Branch name.
- Worktree path.
- Commands that passed.
- Any known limitations.
- Whether to open a PR or merge to main.

## Self-Review

Spec coverage:

- Local-first store: Tasks 3 and 4.
- Record model and states: Tasks 2, 3, and 4.
- Event append/replay and revision: Tasks 3 and 4.
- Boot, recall, write, revise, promote, list recent: Tasks 4 and 5.
- MCP access: Task 6.
- CLI access: Task 5.
- Git sync adapter: Task 7 implements status skeleton only, matching MVP constraints.
- README usage: Task 8.

Deferred by design:

- Full GitHub pull/push automation.
- Embeddings.
- Hosted backend.
- Team permissions.
- Web UI.

Placeholder scan:

- This plan avoids empty markers and unspecified implementation steps.
- Each code-producing task includes concrete file paths and code.

Type consistency:

- Record state names match the spec.
- CLI command names match the README plan.
- `revise_record` is used consistently in event model, engine, and CLI.
