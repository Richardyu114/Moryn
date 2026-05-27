import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { readEvents } from "../../src/core/store.js";
import { initializeProjectConfig } from "../../src/core/project.js";

const exec = promisify(execFile);
const repoRoot = process.cwd();
const tsxLoader = join(repoRoot, "node_modules/tsx/dist/loader.mjs");
const cliPath = join(repoRoot, "src/cli.ts");

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>, cwd = repoRoot): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", tsxLoader, cliPath, "--store", storePath, "mcp"],
    cwd,
    stderr: "pipe"
  });
  const client = new Client({ name: "memora-test-client", version: "0.1.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseTextContent(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const first = "content" in result ? result.content[0] : undefined;
  if (!first || first.type !== "text") {
    throw new Error("Expected a text MCP tool response");
  }
  return JSON.parse(first.text);
}

async function expectInvalidMcpArguments(action: () => Promise<Awaited<ReturnType<Client["callTool"]>>>, expectedMessage: RegExp): Promise<void> {
  const result = await action();
  expect("isError" in result ? result.isError : false).toBe(true);
  const first = "content" in result ? result.content[0] : undefined;
  expect(first?.type).toBe("text");
  if (!first || first.type !== "text") {
    throw new Error("Expected a text MCP validation error");
  }
  expect(first.text).toMatch(expectedMessage);
}

describe("MCP stdio server", () => {
  it("exposes Memora tools over the official MCP protocol", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-"));
    try {
      await withMcpClient(store, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "archive",
          "boot",
          "init",
          "link",
          "list_recent",
          "project_init",
          "promote",
          "quarantine",
          "rebuild",
          "recall",
          "refresh",
          "revise",
          "sync_init",
          "sync_pull",
          "sync_push",
          "sync_status",
          "write"
        ]);

        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const writeResult = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Use real MCP tools.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const recallResult = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { query: "real MCP", project_id: "memora", limit: 5 }
        })) as { results: Array<{ record: { id: string; content: { text: string } } }> };

        expect(recallResult.results[0]?.record.id).toBe(writeResult.record.id);
        expect(recallResult.results[0]?.record.content.text).toBe("Use real MCP tools.");

        parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: writeResult.record.id,
            patch: { "content.text": "Use official MCP tools." },
            reason: "Prefer official protocol wording",
            source: { client: "mcp-test" }
          }
        }));

        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: writeResult.record.id,
            target_state: "canonical",
            reason: "Verified through MCP",
            source: { client: "mcp-test" }
          }
        }));

        const recentResult = parseTextContent(await client.callTool({
          name: "list_recent",
          arguments: { limit: 1 }
        })) as Array<{ id: string; state: string; content: { text: string } }>;

        expect(recentResult[0]?.id).toBe(writeResult.record.id);
        expect(recentResult[0]?.state).toBe("canonical");
        expect(recentResult[0]?.content.text).toBe("Use official MCP tools.");

        const refreshResult = parseTextContent(await client.callTool({
          name: "refresh",
          arguments: {
            project_id: "memora",
            cursor: "2000-01-01T00:00:00.000Z",
            current_task: "real MCP"
          }
        })) as { changes: Array<{ record_id: string; importance: string }> };

        expect(refreshResult.changes).toEqual([
          expect.objectContaining({ record_id: writeResult.record.id, importance: "notice" })
        ]);

        const oldResult = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Old MCP decision.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        parseTextContent(await client.callTool({
          name: "link",
          arguments: {
            record_id: writeResult.record.id,
            linked_record_id: oldResult.record.id,
            link_type: "supersedes",
            source: { client: "mcp-test" }
          }
        }));
        parseTextContent(await client.callTool({
          name: "archive",
          arguments: {
            record_id: oldResult.record.id,
            reason: "Superseded through MCP",
            source: { client: "mcp-test" }
          }
        }));

        const archivedRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [oldResult.record.id],
            states: ["archived"],
            project_id: "memora"
          }
        })) as { results: Array<{ record: { state: string } }> };
        const linkedRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [writeResult.record.id],
            project_id: "memora"
          }
        })) as { results: Array<{ record: { links?: Array<{ record_id: string; link_type: string }> } }> };

        expect(archivedRecall.results[0]?.record.state).toBe("archived");
        expect(linkedRecall.results[0]?.record.links).toEqual([
          expect.objectContaining({ record_id: oldResult.record.id, link_type: "supersedes" })
        ]);

        parseTextContent(await client.callTool({
          name: "quarantine",
          arguments: {
            record_id: writeResult.record.id,
            reason: "Manual review through MCP",
            source: { client: "mcp-test" }
          }
        }));
        const quarantinedRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [writeResult.record.id],
            states: ["quarantined"],
            project_id: "memora"
          }
        })) as { results: Array<{ record: { state: string } }> };

        expect(quarantinedRecall.results[0]?.record.state).toBe("quarantined");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("exposes rebuild and Git sync operations over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mcp-sync-"));
    const remote = join(root, "remote.git");
    const storeA = join(root, "store-a");
    const storeB = join(root, "store-b");
    try {
      await exec("git", ["init", "--bare", remote]);
      await withMcpClient(storeA, async (agentA) => {
        await withMcpClient(storeB, async (agentB) => {
          expect((parseTextContent(await agentA.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);
          expect((parseTextContent(await agentB.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

          const initA = parseTextContent(await agentA.callTool({
            name: "sync_init",
            arguments: { remote }
          })) as { ok: boolean };
          const initB = parseTextContent(await agentB.callTool({
            name: "sync_init",
            arguments: { remote }
          })) as { ok: boolean };

          expect(initA.ok).toBe(true);
          expect(initB.ok).toBe(true);

          parseTextContent(await agentA.callTool({
            name: "write",
            arguments: {
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "memora",
              text: "MCP sync shares events.",
              state: "canonical",
              source: { client: "mcp-sync-test", device_id: "device_a" }
            }
          }));

          const push = parseTextContent(await agentA.callTool({
            name: "sync_push",
            arguments: { message: "sync from mcp agent a" }
          })) as { ok: boolean; pushed?: boolean };
          expect(push.ok).toBe(true);
          expect(push.pushed).toBe(true);

          const pull = parseTextContent(await agentB.callTool({
            name: "sync_pull",
            arguments: {}
          })) as { ok: boolean; pulled?: boolean };
          expect(pull.ok).toBe(true);
          expect(pull.pulled).toBe(true);

          const rebuild = parseTextContent(await agentB.callTool({
            name: "rebuild",
            arguments: {}
          })) as { ok: boolean; records: number };
          expect(rebuild.ok).toBe(true);
          expect(rebuild.records).toBe(1);

          const recallIndex = JSON.parse(await readFile(join(storeB, "indexes", "recall.json"), "utf8")) as { records: Array<{ text: string }> };
          expect(recallIndex.records.map((record) => record.text)).toContain("MCP sync shares events.");

          const status = parseTextContent(await agentB.callTool({
            name: "sync_status",
            arguments: {}
          })) as { configured: boolean; remote?: string };
          expect(status.configured).toBe(true);
          expect(status.remote).toBe(remote);
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  it("resolves project paths and project config through MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mcp-project-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, {
        project_id: "memora",
        tags: ["typescript"],
        default_skills: ["release"]
      });

      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const skill = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "skill",
            type: "procedure",
            scope: "global",
            tags: ["release"],
            text: "Release skill from project config.",
            state: "canonical",
            source: { client: "user" }
          }
        })) as { record: { id: string } };
        const decision = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_path: project,
            text: "MCP project path resolves config.",
            state: "canonical",
            source: { client: "mcp-project-test" }
          }
        })) as { record: { id: string; project_id?: string; tags: string[] } };

        expect(decision.record.project_id).toBe("memora");
        expect(decision.record.tags).toContain("typescript");

        const boot = parseTextContent(await client.callTool({
          name: "boot",
          arguments: {
            project_path: project,
            current_task: "resolve config"
          }
        })) as { skills: Array<{ id: string }>; project: { important_decisions: Array<{ id: string }> }; task_relevant: Array<{ id: string }> };
        expect(boot.skills.map((record) => record.id)).toEqual([skill.record.id]);
        expect(boot.project.important_decisions.map((record) => record.id)).toEqual([decision.record.id]);
        expect(boot.task_relevant.map((record) => record.id)).toEqual([decision.record.id]);

        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { query: "project path", project_path: project }
        })) as { results: Array<{ record: { id: string; project_id?: string } }> };
        expect(recall.results[0]?.record.id).toBe(decision.record.id);
        expect(recall.results[0]?.record.project_id).toBe("memora");

        const otherProject = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "other",
            text: "MCP retrieves this exact record across project context.",
            state: "canonical",
            source: { client: "mcp-project-test" }
          }
        })) as { record: { id: string } };
        const exactRecall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [otherProject.record.id], project_path: project }
        })) as { results: Array<{ record: { id: string; content: { text: string } } }> };
        expect(exactRecall.results[0]?.record.id).toBe(otherProject.record.id);
        expect(exactRecall.results[0]?.record.content.text).toBe("MCP retrieves this exact record across project context.");
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("initializes project config over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mcp-project-init-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await withMcpClient(store, async (client) => {
        const init = parseTextContent(await client.callTool({
          name: "project_init",
          arguments: {
            path: project,
            project_id: "memora",
            tags: ["typescript", "mcp"],
            default_skills: ["release"],
            sync_mode: "interval"
          }
        })) as { ok: boolean; config: { project_id: string; tags: string[]; default_skills: string[]; sync: { mode: string } } };

        expect(init.ok).toBe(true);
        expect(init.config).toMatchObject({
          project_id: "memora",
          tags: ["typescript", "mcp"],
          default_skills: ["release"],
          sync: { mode: "interval" }
        });
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not apply ambient project config when only project_id is provided over MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mcp-explicit-project-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await initializeProjectConfig(project, {
        project_id: "ambient",
        tags: ["ambient-tag"],
        default_skills: ["ambient-skill"]
      });

      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "explicit",
            text: "Explicit MCP project id should stand alone."
          }
        })) as { record: { project_id?: string; tags: string[] } };

        expect(write.record.project_id).toBe("explicit");
        expect(write.record.tags).toEqual([]);
      }, project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors from MCP tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mcp-error-"));
    const store = join(root, "store");
    const project = join(root, "project");
    try {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".memora.json"), "{\"project_id\":\"\"}\n", "utf8");

      await withMcpClient(store, async (client) => {
        const result = parseTextContent(await client.callTool({
          name: "boot",
          arguments: { project_path: project }
        })) as { ok: boolean; error: { code: string; recoverable: boolean } };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("INVALID_PROJECT_CONFIG");
        expect(result.error.recoverable).toBe(true);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors for missing record mutations over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-missing-record-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const result = parseTextContent(await client.callTool({
          name: "archive",
          arguments: {
            record_id: "rec_missing",
            reason: "Should fail"
          }
        })) as { ok: boolean; error: { code: string; recoverable: boolean; recommended_action: string } };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("RECORD_NOT_FOUND");
        expect(result.error.recoverable).toBe(true);
        expect(result.error.recommended_action).toBe("check the record id or call recall/list-recent to find it");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors for managed-field revisions over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-managed-revision-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Use promote for MCP state transitions.",
            state: "candidate",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const result = parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: write.record.id,
            patch: { state: "canonical" },
            reason: "Bypass promotion",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };

        expect(result.ok).toBe(false);
        expect(result.error.code).toBe("INVALID_ARGUMENT");
        expect(result.error.message).toContain("managed field state");
        expect(result.error.recommended_action).toBe("fix the command arguments and retry");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns structured JSON errors for invalid revision patches over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-invalid-revision-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Keep MCP revision patches valid.",
            state: "candidate",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        for (const patch of [
          { "content.text": "" },
          {},
          { "": "Invalid patch path" },
          { ".content.text": "Invalid patch path" },
          { "content..text": "Invalid patch path" },
          { "content.text.": "Invalid patch path" }
        ]) {
          const result = parseTextContent(await client.callTool({
            name: "revise",
            arguments: {
              record_id: write.record.id,
              patch,
              reason: "Invalid revision patch",
              source: { client: "mcp-test" }
            }
          })) as { ok: boolean; error: { code: string; message: string; recommended_action: string } };

          expect(result.ok).toBe(false);
          expect(result.error.code).toBe("INVALID_ARGUMENT");
          expect(result.error.message).toContain("Invalid patch");
          expect(result.error.recommended_action).toBe("fix the command arguments and retry");
        }
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit MCP confirmation for high-risk canonical changes", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-confirm-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "soul",
            type: "preference",
            scope: "global",
            text: "Prefer terse answers.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string; state: string }; warning?: { code: string } };
        expect(write.record.state).toBe("candidate");
        expect(write.warning?.code).toBe("CONFIRMATION_REQUIRED");

        const rejected = parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: write.record.id,
            target_state: "canonical",
            reason: "Agent inferred this preference",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; recommended_action: string } };
        expect(rejected.ok).toBe(false);
        expect(rejected.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(rejected.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");

        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: write.record.id,
            target_state: "canonical",
            reason: "User confirmed",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        }));
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [write.record.id] }
        })) as { results: Array<{ record: { state: string } }> };
        expect(recall.results[0]?.record.state).toBe("canonical");

        const confirmedWrite = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "skill",
            type: "procedure",
            scope: "global",
            text: "Global release checklist.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { state: string }; warning?: unknown };
        expect(confirmedWrite.record.state).toBe("canonical");
        expect(confirmedWrite.warning).toBeUndefined();
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("writes provenance over MCP", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-provenance-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Use provenance metadata.",
            state: "candidate",
            provenance: {
              derived_from: ["rec_source"],
              reason: "Derived from handoff summary."
            },
            source: { client: "mcp-test" }
          }
        })) as { record: { provenance?: { derived_from?: string[]; reason?: string; method?: string } } };

        expect(write.record.provenance).toEqual({
          derived_from: ["rec_source"],
          reason: "Derived from handoff summary.",
          method: "agent-proposed"
        });
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("uses MCP as the default source for mutation events", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-default-source-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const target = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "MCP mutation source target.",
            state: "candidate"
          }
        })) as { record: { id: string } };
        const linked = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "MCP mutation source linked record.",
            state: "candidate"
          }
        })) as { record: { id: string } };

        parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: target.record.id,
            patch: { "content.text": "MCP mutation source revised target." },
            reason: "Default MCP source"
          }
        }));
        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: target.record.id,
            target_state: "canonical",
            reason: "Default MCP source"
          }
        }));
        parseTextContent(await client.callTool({
          name: "link",
          arguments: {
            record_id: target.record.id,
            linked_record_id: linked.record.id,
            link_type: "related"
          }
        }));
        parseTextContent(await client.callTool({
          name: "archive",
          arguments: {
            record_id: linked.record.id,
            reason: "Default MCP source"
          }
        }));
        parseTextContent(await client.callTool({
          name: "quarantine",
          arguments: {
            record_id: target.record.id,
            reason: "Default MCP source"
          }
        }));

        const events = await readEvents(store);
        const mutationClients = events
          .filter((event) => event.op !== "upsert_record")
          .map((event) => event.source.client);
        expect(mutationClients).toEqual(["mcp", "mcp", "mcp", "mcp", "mcp"]);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("rejects ambiguous MCP write content inputs", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-content-input-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const both = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Plain text",
            content: { text: "Structured text", format: "json" },
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(both.ok).toBe(false);
        expect(both.error.code).toBe("INVALID_ARGUMENT");
        expect(both.error.message).toContain("either text or content");

        const neither = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(neither.ok).toBe(false);
        expect(neither.error.code).toBe("INVALID_ARGUMENT");
        expect(neither.error.message).toContain("text or content");

        const emptyContent = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            content: {},
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(emptyContent.ok).toBe(false);
        expect(emptyContent.error.code).toBe("INVALID_ARGUMENT");
        expect(emptyContent.error.message).toContain("Invalid content");

        const emptyStructuredText = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            content: { text: "", format: "json" },
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(emptyStructuredText.ok).toBe(false);
        expect(emptyStructuredText.error.code).toBe("INVALID_ARGUMENT");
        expect(emptyStructuredText.error.message).toContain("Invalid content.text");

        const missingProject = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            text: "Project records need an explicit project context.",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; message: string } };
        expect(missingProject.ok).toBe(false);
        expect(missingProject.error.code).toBe("INVALID_ARGUMENT");
        expect(missingProject.error.message).toContain("project_id is required for project scope");
        expect(await readEvents(store)).toHaveLength(0);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("rejects empty optional MCP string inputs at the schema boundary", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-empty-input-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "write",
            arguments: {
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "memora",
              text: "",
              source: { client: "mcp-test" }
            }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "write",
            arguments: {
              kind: "memory",
              type: "decision",
              scope: "project",
              project_id: "memora",
              text: "Valid text",
              tags: [""],
              source: { client: "mcp-test" }
            }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "recall",
            arguments: { project_id: "memora", query: "" }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "refresh",
            arguments: { project_id: "memora", cursor: "" }
          }),
          /Invalid arguments/
        );
        await expectInvalidMcpArguments(
          () => client.callTool({
            name: "promote",
            arguments: { record_id: "rec_missing", target_state: "canonical", reason: "" }
          }),
          /Invalid arguments/
        );
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("marks conflicting MCP canonical writes as candidates", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-conflict-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const existing = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            tags: ["sync"],
            text: "Use append-only JSON events.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const conflicting = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            tags: ["sync"],
            text: "Use SQLite as the source of truth.",
            state: "canonical",
            source: { client: "mcp-test" }
          }
        })) as {
          record: { state: string; conflict?: { with: string[]; resolution: string } };
          warning?: { code: string };
        };

        expect(conflicting.record.state).toBe("candidate");
        expect(conflicting.warning?.code).toBe("CONFIRMATION_REQUIRED");
        expect(conflicting.record.conflict?.with).toEqual([existing.record.id]);
        expect(conflicting.record.conflict?.resolution).toBe("needs_review");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit MCP confirmation for conflicting canonical promotion", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-promote-conflict-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const candidate = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            tags: ["sync"],
            text: "Use SQLite as the source of truth.",
            state: "candidate",
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };
        const existing = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            tags: ["sync"],
            text: "Use append-only JSON events.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const rejected = parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: candidate.record.id,
            target_state: "canonical",
            reason: "Agent inferred this replacement",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; recommended_action: string } };
        expect(rejected.ok).toBe(false);
        expect(rejected.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(rejected.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");

        parseTextContent(await client.callTool({
          name: "promote",
          arguments: {
            record_id: candidate.record.id,
            target_state: "canonical",
            reason: "User confirmed",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        }));
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [candidate.record.id] }
        })) as { results: Array<{ record: { state: string; conflict?: { with: string[]; resolution: string } } }> };
        expect(recall.results[0]?.record.state).toBe("canonical");
        expect(recall.results[0]?.record.conflict?.with).toEqual([existing.record.id]);
        expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("requires explicit MCP confirmation for conflicting canonical revisions", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-revise-conflict-"));
    try {
      await withMcpClient(store, async (client) => {
        expect((parseTextContent(await client.callTool({ name: "init", arguments: {} })) as { ok: boolean }).ok).toBe(true);

        const existing = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            tags: ["sync"],
            text: "Use append-only JSON events.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };
        const target = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "warning",
            scope: "project",
            project_id: "memora",
            tags: ["sync"],
            text: "Use private Git remotes.",
            state: "canonical",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        })) as { record: { id: string } };

        const rejected = parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: target.record.id,
            patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
            reason: "Agent inferred this replacement",
            source: { client: "mcp-test" }
          }
        })) as { ok: boolean; error: { code: string; recommended_action: string } };
        expect(rejected.ok).toBe(false);
        expect(rejected.error.code).toBe("CONFIRMATION_REQUIRED");
        expect(rejected.error.recommended_action).toBe("ask the user to confirm before retrying with confirmed=true or --confirm");

        parseTextContent(await client.callTool({
          name: "revise",
          arguments: {
            record_id: target.record.id,
            patch: { type: "decision", "content.text": "Use SQLite as the source of truth." },
            reason: "User confirmed",
            confirmed: true,
            source: { client: "mcp-test" }
          }
        }));
        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: { record_ids: [target.record.id] }
        })) as { results: Array<{ record: { type: string; content: { text: string }; conflict?: { with: string[]; resolution: string } } }> };
        expect(recall.results[0]?.record.type).toBe("decision");
        expect(recall.results[0]?.record.content.text).toBe("Use SQLite as the source of truth.");
        expect(recall.results[0]?.record.conflict?.with).toEqual([existing.record.id]);
        expect(recall.results[0]?.record.conflict?.resolution).toBe("needs_review");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});
