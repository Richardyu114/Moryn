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
