import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "cli.js");

async function cli(storePath: string, args: string[]): Promise<unknown> {
  const result = await exec(process.execPath, [cliPath, "--store", storePath, ...args], {
    maxBuffer: 8 * 1024 * 1024
  });
  return JSON.parse(result.stdout) as unknown;
}

async function fixtureRepository(root: string): Promise<string> {
  const repoPath = join(root, "fixture-repo");
  await mkdir(join(repoPath, "src"), { recursive: true });
  await writeFile(
    join(repoPath, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "vitest" }, dependencies: { zod: "^4.0.0" } })
  );
  await writeFile(join(repoPath, "src", "index.ts"), "export const answer = 42;\n");
  await exec("git", ["init"], { cwd: repoPath });
  await exec("git", ["config", "user.name", "Moryn Test"], { cwd: repoPath });
  await exec("git", ["config", "user.email", "moryn@example.invalid"], { cwd: repoPath });
  await exec("git", ["add", "package.json", "src/index.ts"], { cwd: repoPath });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repoPath });
  return repoPath;
}

describe("context infrastructure CLI", { timeout: 30_000 }, () => {
  it("negotiates OpenCode continuity and cross-host transfer", async () => {
    await withInitializedTempStore(async (storePath) => {
      const negotiation = (await cli(storePath, [
        "continuity",
        "negotiate",
        "--host",
        "opencode",
        "--operation",
        "checkpoint"
      ])) as any;
      expect(negotiation.operations_by_name.checkpoint).toMatchObject({ mode: "mcp", tool: "checkpoint" });
      expect(negotiation.receipt.content_included).toBe(false);

      const transfer = (await cli(storePath, [
        "continuity",
        "transfer",
        "--project-id",
        "fixture",
        "--source-host",
        "codex",
        "--target-host",
        "opencode",
        "--no-source-native-hooks"
      ])) as any;
      expect(transfer.ready).toBe(true);
      expect(transfer.sequence.map((step: any) => step.route.mode)).toEqual(["mcp", "mcp", "mcp", "mcp"]);
    });
  });

  it("scans, claims, and derives a Repo Atlas view", async () => {
    await withInitializedTempStore(async (storePath) => {
      const repoPath = await fixtureRepository(storePath);
      const scan = (await cli(storePath, ["repo-atlas", "scan", "--repo", repoPath])) as any;
      expect(scan.observations.map((observation: any) => observation.path)).toEqual(["package.json", "src/index.ts"]);
      expect(JSON.stringify(scan)).not.toContain(repoPath);

      const claim = (await cli(storePath, [
        "repo-atlas",
        "claim",
        "--repo",
        repoPath,
        "--project-id",
        "fixture",
        "--statement",
        "src/index.ts is the public entrypoint",
        "--evidence",
        "src/index.ts",
        "--agent",
        "codex"
      ])) as any;
      expect(claim).toMatchObject({ created: true, storage: "synced" });

      const view = (await cli(storePath, ["repo-atlas", "view", "--repo", repoPath, "--lens", "onboarding"])) as any;
      expect(view.summary).toMatchObject({ tracked_files: 2, active_claims: 1, stale_claims: 0 });
      expect(view.claims[0].statement).toBe("src/index.ts is the public entrypoint");
    });
  });

  it("previews an enforced personal sync without publishing", async () => {
    await withInitializedTempStore(async (storePath) => {
      const remote = join(storePath, "remote.git");
      await exec("git", ["init", "--bare", remote]);
      await cli(storePath, ["sync", "init", remote, "--no-open"]);

      const preflight = (await cli(storePath, [
        "sync",
        "preflight",
        "--destination",
        "personal_sync",
        "--mode",
        "enforce"
      ])) as any;
      expect(preflight).toMatchObject({
        mode: "enforce",
        enforced: true,
        decision: "allow",
        would_block: false
      });
      expect(preflight.receipt_id).toMatch(/^sync_gate_/u);
    });
  });
});
