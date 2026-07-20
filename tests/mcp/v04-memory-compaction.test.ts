import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const cliPath = join(process.cwd(), "dist", "cli.js");
const identity = { project_id: "moryn", session_id: "compaction-mcp" };
const source = { client: "codex", session_id: identity.session_id, device_id: "device-a" };

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--store", storePath, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({ name: "moryn-v04-compaction-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function resultJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected MCP text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function seedReadySession(storePath: string): Promise<void> {
  const engine = createEngine({ storePath, now: () => "2026-07-20T10:00:01.000Z" });
  await engine.checkpoint({
    project_id: identity.project_id,
    source,
    occurred_at: "2026-07-20T10:00:00.000Z",
    delta: {
      session_id: identity.session_id,
      checkpoint_id: "compaction-mcp-checkpoint",
      current_task: "Expose MCP compaction tools",
      decisions: ["Keep apply explicit"],
      changed_facts: ["MCP carries sealed JSON artifacts"],
      blockers: [],
      next_steps: ["Verify restore"],
      files: ["src/mcp/server.ts"]
    }
  });
  const finalText = "MCP Memory Compaction flow is ready.";
  const preview = await engine.previewSessionFold({ ...identity, proposed_final_text: finalText });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: identity.project_id,
    content: { text: finalText, session_fold_coverage: preview.coverage },
    source
  });
}

async function seedPrivateReadySession(
  storePath: string,
  privateIdentity: { project_id: string; session_id: string },
  marker: string
): Promise<void> {
  const engine = createEngine({ storePath, now: () => "2026-07-20T10:30:01.000Z" });
  const privateSource = { client: "codex", session_id: privateIdentity.session_id, device_id: "device-private" };
  await engine.write({
    kind: "session_summary",
    type: "status",
    scope: "project",
    project_id: privateIdentity.project_id,
    tags: ["private", `session:${privateIdentity.session_id}`],
    content: { text: marker, format: "text" },
    source: privateSource
  });
  const finalText = `${marker}. Private MCP session complete.`;
  const preview = await engine.previewSessionFold({
    ...privateIdentity,
    proposed_final_text: finalText,
    include_private: true
  });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: privateIdentity.project_id,
    tags: ["private", `session:${privateIdentity.session_id}`],
    content: { text: finalText, session_fold_coverage: preview.coverage },
    source: privateSource
  });
}

describe("v0.4 Memory Compaction MCP tools", () => {
  it("normalizes aliases and runs preview, plan, guarded apply, and guarded restore", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedReadySession(storePath);
      await withMcpClient(storePath, async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
          expect.arrayContaining([
            "memory_compaction_preview",
            "memory_compaction_plan",
            "memory_compaction_apply",
            "memory_compaction_restore"
          ])
        );
        const unknown = await client.callTool({
          name: "memory_compaction_preview",
          arguments: { destructive: true }
        });
        expect(unknown.isError).toBe(true);
        expect(resultJson(unknown)).toMatchObject({
          error: { code: "INVALID_ARGUMENT", recovery_hint: { expected: { kind: "known_argument" } } }
        });

        const previewResult = await client.callTool({
          name: "memory_compaction_preview",
          arguments: { projectId: identity.project_id, sessionId: identity.session_id }
        });
        expect(previewResult.isError).not.toBe(true);
        const preview = resultJson(previewResult);
        expect(preview).toMatchObject({ status: "ready", filters: identity });

        const planResult = await client.callTool({
          name: "memory_compaction_plan",
          arguments: { preview }
        });
        expect(planResult.isError).not.toBe(true);
        const plan = resultJson(planResult);
        expect(plan).toMatchObject({ status: "ready", plan_id: preview.plan_id });

        const rejectedApply = await client.callTool({
          name: "memory_compaction_apply",
          arguments: { plan, confirm: false }
        });
        expect(rejectedApply.isError).toBe(true);
        expect(JSON.stringify(resultJson(rejectedApply))).toContain("requires explicit confirmed: true");

        const applied = await client.callTool({
          name: "memory_compaction_apply",
          arguments: { plan, confirm: true }
        });
        expect(applied.isError).not.toBe(true);
        expect(resultJson(applied)).toMatchObject({
          receipt: { status: "committed", plan_id: plan.plan_id }
        });

        const rejectedRestore = await client.callTool({
          name: "memory_compaction_restore",
          arguments: { planId: plan.plan_id, confirm: false }
        });
        expect(rejectedRestore.isError).toBe(true);
        expect(JSON.stringify(resultJson(rejectedRestore))).toContain("requires explicit confirmed: true");

        const restored = await client.callTool({
          name: "memory_compaction_restore",
          arguments: { planId: plan.plan_id, confirm: true }
        });
        expect(restored.isError).not.toBe(true);
        expect(resultJson(restored)).toMatchObject({
          receipt: {
            status: "restored",
            compaction_plan_id: plan.plan_id,
            logical_restore: true
          }
        });
      });
    });
  });

  it("returns a count-only private omission by default and honors the includePrivate alias", async () => {
    await withInitializedTempStore(async (storePath) => {
      const privateIdentity = { project_id: "moryn", session_id: "private-compaction-mcp" };
      const marker = "PRIVATE-COMPACTION-MCP-MARKER-83B1";
      await seedPrivateReadySession(storePath, privateIdentity, marker);
      await withMcpClient(storePath, async (client) => {
        const defaultResult = await client.callTool({
          name: "memory_compaction_preview",
          arguments: { projectId: privateIdentity.project_id, sessionId: privateIdentity.session_id }
        });
        expect(defaultResult.isError).not.toBe(true);
        const preview = resultJson(defaultResult);
        const serialized = JSON.stringify(preview);
        expect(serialized).not.toContain(marker);
        expect(serialized).not.toContain("final_handoff_content");
        expect(serialized).not.toContain('"claims"');
        expect(preview).toMatchObject({
          status: "review_required",
          filters: { include_private: false },
          private_access: {
            scope_complete: false,
            omitted_private_source_count: 2,
            omission_reason: "private_sources_require_explicit_include_private"
          },
          blockers: [{ code: "private_sources_omitted", record_ids: [], omitted_source_count: 2 }]
        });

        const planResult = await client.callTool({
          name: "memory_compaction_plan",
          arguments: { preview }
        });
        expect(planResult.isError).not.toBe(true);
        const plan = resultJson(planResult);
        expect(plan).toMatchObject({ status: "review_required", filters: { include_private: false } });
        const blockedApply = await client.callTool({
          name: "memory_compaction_apply",
          arguments: { plan, confirm: true }
        });
        expect(blockedApply.isError).toBe(true);
        expect(JSON.stringify(resultJson(blockedApply))).toContain("not ready");

        const authorizedResult = await client.callTool({
          name: "memory_compaction_preview",
          arguments: {
            projectId: privateIdentity.project_id,
            sessionId: privateIdentity.session_id,
            includePrivate: true
          }
        });
        expect(authorizedResult.isError).not.toBe(true);
        const authorized = resultJson(authorizedResult);
        expect(authorized).toMatchObject({
          filters: { include_private: true },
          private_access: { scope_complete: true, omitted_private_source_count: 0 },
          plans: [{ privacy: { boundary: "private" } }]
        });
        expect(JSON.stringify(authorized)).toContain(marker);
      });
    });
  });
});
