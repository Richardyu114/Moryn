import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const cliPath = join(process.cwd(), "dist", "cli.js");

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--store", storePath, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({ name: "moryn-historical-recall-test", version: "1.0.0" });
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

describe("MCP historical recall", () => {
  it("returns bounded archived evidence through the existing recall tool without writing", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const historical = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "The MCP historical release channel is cedar." },
        state: "archived",
        confidence: 0.8,
        source: { client: "codex", session_id: "session-old" }
      });
      const before = await readEvents(storePath);

      const response = await withMcpClient(storePath, (client) =>
        client.callTool({
          name: "recall",
          arguments: {
            query: "historical release channel cedar",
            project_id: "moryn",
            kinds: ["session_summary"]
          }
        })
      );
      const parsed = resultJson(response);
      const after = await readEvents(storePath);

      expect(after).toHaveLength(before.length);
      expect(parsed).toMatchObject({
        outcome: { status: "verification_required", best_record_id: historical.record.id },
        historical_recovery: {
          status: "recovered",
          matches: [{ record_id: historical.record.id, state: "archived" }],
          upgrade: { evidence_record_ids: [historical.record.id] }
        },
        next_actions_by_id: {
          capture_confirmed_learning: {
            arguments_by_name: { related_record_ids: [historical.record.id] }
          }
        }
      });
      expect(JSON.stringify(parsed).split("The MCP historical release channel is cedar.")).toHaveLength(2);
    });
  });
});
