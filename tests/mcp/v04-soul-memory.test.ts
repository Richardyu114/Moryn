import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { readStoreConfig } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { memoryRecordDigest } from "../../src/core/memory-expansion.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const cliPath = join(process.cwd(), "dist", "cli.js");
const secret = "MCP LOCAL SOUL SECRET";

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--store", storePath, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({ name: "moryn-v04-test", version: "1.0.0" });
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

describe("v0.4 Soul and Memory MCP tools", () => {
  it("normalizes aliases, rejects conflicts and unknown input, and runs the Soul lifecycle", async () => {
    await withInitializedTempStore(async (storePath) => {
      await withMcpClient(storePath, async (client) => {
        const unknownResult = await client.callTool({ name: "soul_status", arguments: { clause_text: true } });
        expect(unknownResult.isError).toBe(true);
        expect(resultJson(unknownResult)).toMatchObject({
          error: {
            code: "INVALID_ARGUMENT",
            recovery_hint: { expected: { kind: "known_argument" } }
          }
        });

        const conflictResult = await client.callTool({
          name: "soul_draft",
          arguments: {
            subject: { kind: "agent", subject_id: "moryn" },
            subjectId: "another-agent",
            clauses: [{ clause_key: "mission", category: "mission", text: "Be useful." }]
          }
        });
        expect(conflictResult.isError).toBe(true);
        expect(JSON.stringify(resultJson(conflictResult))).toContain("Conflicting subject.subject_id aliases");

        const draftResult = await client.callTool({
          name: "soul_draft",
          arguments: {
            subjectKind: "agent",
            subjectId: "moryn",
            clauses: [
              {
                clause_key: "mission",
                category: "mission",
                text: "Keep MCP behavior consistent.",
                distribution: "personal_sync"
              },
              {
                clause_key: "private",
                category: "collaboration",
                text: secret,
                distribution: "local_only"
              }
            ]
          }
        });
        expect(draftResult.isError).not.toBe(true);
        const draft = resultJson(draftResult) as unknown as {
          revision: { revision_id: string; profile_id: string };
        };

        const unconfirmed = await client.callTool({
          name: "soul_approve",
          arguments: { revisionId: draft.revision.revision_id, confirm: false }
        });
        expect(unconfirmed.isError).toBe(true);
        expect(JSON.stringify(resultJson(unconfirmed))).toContain("explicit user confirmation");

        const firstResult = await client.callTool({
          name: "soul_approve",
          arguments: { revisionId: draft.revision.revision_id, confirm: true }
        });
        const first = resultJson(firstResult) as unknown as {
          revision: { revision_id: string; profile_id: string };
        };
        const statusResult = await client.callTool({
          name: "soul_status",
          arguments: { agentProfileId: first.revision.profile_id }
        });
        expect(statusResult.isError).not.toBe(true);
        expect(JSON.stringify(resultJson(statusResult))).not.toContain(secret);
        expect(JSON.stringify(resultJson(statusResult))).not.toContain("Keep MCP behavior consistent.");

        const changedDraftResult = await client.callTool({
          name: "soul_draft",
          arguments: {
            fromRevisionId: first.revision.revision_id,
            clauses: [
              {
                clause_key: "mission",
                category: "mission",
                text: "Use a different MCP persona.",
                distribution: "personal_sync"
              }
            ]
          }
        });
        const changedDraft = resultJson(changedDraftResult) as unknown as { revision: { revision_id: string } };
        await client.callTool({
          name: "soul_approve",
          arguments: { revision_id: changedDraft.revision.revision_id, confirm: true }
        });
        const missingProfile = await client.callTool({
          name: "soul_rollback",
          arguments: { toRevision: first.revision.revision_id, confirm: true }
        });
        expect(missingProfile.isError).toBe(true);
        expect(JSON.stringify(resultJson(missingProfile))).toContain("profile_id");
        const rollbackResult = await client.callTool({
          name: "soul_rollback",
          arguments: {
            profileId: first.revision.profile_id,
            toRevision: first.revision.revision_id,
            confirm: true
          }
        });
        expect(rollbackResult.isError).not.toBe(true);
        expect(resultJson(rollbackResult)).toMatchObject({ approval_receipt: { action: "rollback" } });
      });
    });
  });

  it("expands current records and rejects invalid boundary types", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T12:00:00.000Z" });
      const deviceId = (await readStoreConfig(storePath)).device_id;
      const source = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "MCP source" },
        source: { client: "test", device_id: deviceId }
      });
      const rollup = await engine.write({
        kind: "session_summary",
        type: "session_rollup",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "MCP rollup",
          source_record_ids: [source.record.id],
          source_digests: [{ record_id: source.record.id, digest: memoryRecordDigest(source.record) }]
        },
        source: { client: "test", device_id: deviceId }
      });

      await withMcpClient(storePath, async (client) => {
        const expansionResult = await client.callTool({
          name: "memory_expand",
          arguments: { recordId: rollup.record.id, maxDepth: 1, maxRecords: 2 }
        });
        expect(expansionResult.isError).not.toBe(true);
        expect(resultJson(expansionResult)).toMatchObject({
          root_record_id: rollup.record.id,
          stats: { returned_records: 2, returned_source_records: 1 }
        });

        const invalidResult = await client.callTool({
          name: "memory_expand",
          arguments: { record_id: rollup.record.id, max_depth: "1" }
        });
        expect(invalidResult.isError).toBe(true);
        expect(JSON.stringify(resultJson(invalidResult))).toContain("max_depth must be an integer");
      });
    });
  });
});
