import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "cli.js");

async function withMcpClient<T>(storePath: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, "--store", storePath, "mcp"],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const client = new Client({ name: "context-infrastructure-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseResult(result: Awaited<ReturnType<Client["callTool"]>>): any {
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("MCP result did not contain text");
  return JSON.parse(text.text);
}

async function fixtureRepository(root: string): Promise<string> {
  const repoPath = join(root, "mcp-fixture");
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), "# MCP fixture\n");
  await exec("git", ["init"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "Moryn Test"], { cwd: repoPath });
  await exec("git", ["config", "user.email", "moryn@example.invalid"], { cwd: repoPath });
  await exec("git", ["add", "README.md"], { cwd: repoPath });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repoPath });
  return repoPath;
}

describe("context infrastructure MCP", { timeout: 30_000 }, () => {
  it("exposes parity tools and executes continuity, Repo Atlas, and Sync Gate", async () => {
    await withInitializedTempStore(async (storePath) => {
      const repoPath = await fixtureRepository(storePath);
      const remote = join(storePath, "remote.git");
      await exec("git", ["init", "--bare", remote]);

      await withMcpClient(storePath, async (client) => {
        const tools = await client.listTools();
        const names = tools.tools.map(({ name }) => name);
        expect(names).toEqual(
          expect.arrayContaining([
            "continuity_negotiate",
            "continuity_transfer",
            "workspace_mapping_set",
            "workspace_mapping_list",
            "workspace_path_resolve",
            "workspace_mapping_remove",
            "repo_atlas_scan",
            "repo_atlas_read",
            "repo_atlas_view",
            "repo_atlas_claim",
            "repo_atlas_reverify",
            "sync_preflight"
          ])
        );

        const continuity = parseResult(
          await client.callTool({
            name: "continuity_negotiate",
            arguments: { host: "opencode", operations: ["checkpoint"] }
          })
        );
        expect(continuity.operations_by_name.checkpoint).toMatchObject({ mode: "mcp", tool: "checkpoint" });

        const scan = parseResult(
          await client.callTool({ name: "repo_atlas_scan", arguments: { repo_path: repoPath } })
        );
        expect(scan.observations[0].path).toBe("README.md");

        const mapping = parseResult(
          await client.callTool({
            name: "workspace_mapping_set",
            arguments: {
              project_id: "fixture",
              source_device_id: "device-remote",
              source_root: "/srv/fixture",
              local_root: repoPath
            }
          })
        );
        expect(mapping).toMatchObject({ created: true, mapping: { project_id: "fixture" } });
        const resolved = parseResult(
          await client.callTool({
            name: "workspace_path_resolve",
            arguments: {
              project_id: "fixture",
              source_device_id: "device-remote",
              source_path: "/srv/fixture/README.md"
            }
          })
        );
        expect(resolved).toMatchObject({ status: "resolved", safe_to_access: true });

        const claim = parseResult(
          await client.callTool({
            name: "repo_atlas_claim",
            arguments: {
              repo_path: repoPath,
              project_id: "fixture",
              statement: "README.md is the onboarding document",
              evidence_paths: ["README.md"]
            }
          })
        );
        expect(claim).toMatchObject({ created: true, storage: "synced" });

        const view = parseResult(
          await client.callTool({
            name: "repo_atlas_view",
            arguments: { repo_path: repoPath, lens: "onboarding" }
          })
        );
        expect(view.summary).toMatchObject({ tracked_files: 1, active_claims: 1 });

        const syncInit = await client.callTool({ name: "sync_init", arguments: { remote } });
        expect(syncInit.isError).not.toBe(true);
        const preflight = parseResult(
          await client.callTool({
            name: "sync_preflight",
            arguments: { destination: "personal_sync", mode: "enforce" }
          })
        );
        expect(preflight).toMatchObject({ decision: "allow", enforced: true, would_block: false });
      });
    });
  });
});
