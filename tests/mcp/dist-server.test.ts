import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

async function withDistMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/cli.js", "--store", storePath, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({ name: "memora-dist-test-client", version: "0.1.0" });
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

describe("built MCP stdio server", () => {
  it("serves MCP tools from dist/cli.js", async () => {
    const store = await mkdtemp(join(tmpdir(), "memora-dist-mcp-"));
    try {
      await withDistMcpClient(store, async (client) => {
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("boot");

        const write = parseTextContent(await client.callTool({
          name: "write",
          arguments: {
            kind: "memory",
            type: "decision",
            scope: "project",
            project_id: "memora",
            text: "Built MCP server works.",
            state: "canonical",
            source: { client: "dist-mcp-test" }
          }
        })) as { record: { id: string } };

        const recall = parseTextContent(await client.callTool({
          name: "recall",
          arguments: {
            record_ids: [write.record.id],
            project_id: "memora"
          }
        })) as { results: Array<{ record: { content: { text: string } } }> };

        expect(recall.results[0]?.record.content.text).toBe("Built MCP server works.");
      });
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });
});
