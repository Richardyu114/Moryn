import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const cliPath = join(process.cwd(), "dist", "cli.js");

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--store", storePath, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({ name: "moryn-memory-feedback-test", version: "1.0.0" });
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

describe("MCP memory feedback", () => {
  it("records a final outcome through the public tool", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const written = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "The dashboard uses the release workflow." },
        state: "candidate",
        source: { client: "test" }
      });
      const response = await withMcpClient(storePath, (client) =>
        client.callTool({
          name: "memory_feedback",
          arguments: {
            recordId: written.record.id,
            outcome: "rejected",
            occurredAt: "2026-07-30T00:01:00.000Z",
            idempotencyKey: "mcp-interaction-1"
          }
        })
      );

      expect(resultJson(response)).toMatchObject({
        event: { op: "record_feedback", record_id: written.record.id, outcome: "rejected" },
        usage: { recall_count: 1, useful_count: 0, rejected_count: 1 },
        selection_sources: { outcome: "event.outcome", usage: "usage" }
      });
    });
  });
});
