import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--import", "tsx", "src/cli.ts", "--store", storePath, "mcp"],
    cwd: process.cwd(),
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

describe("MCP stdio server", () => {
  it("exposes Memora tools over the official MCP protocol", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-mcp-"));
    try {
      await withMcpClient(store, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
          "boot",
          "list_recent",
          "promote",
          "recall",
          "refresh",
          "revise",
          "write"
        ]);

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
            cursor: "2000-01-01T00:00:00.000Z"
          }
        })) as { changes: Array<{ record_id: string; importance: string }> };

        expect(refreshResult.changes).toEqual([
          expect.objectContaining({ record_id: writeResult.record.id, importance: "notice" })
        ]);
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});
