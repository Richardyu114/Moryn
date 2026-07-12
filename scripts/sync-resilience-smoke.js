#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const handoffText = "Remote outage handoff remains local and later reaches the second device.";
async function resolveMorynCommand() {
  const sourceCli = join(packageRoot, "src", "cli.ts");
  try {
    await access(sourceCli);
    const localTsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    try { await access(localTsx); return { command: "node", argsPrefix: [localTsx, sourceCli] }; }
    catch { return { command: "node", argsPrefix: ["--import", "tsx", sourceCli] }; }
  } catch { return { command: "node", argsPrefix: [join(packageRoot, "dist", "cli.js")] }; }
}
async function run(command, args, cwd = packageRoot) { return (await exec(command, args, { cwd })).stdout; }
async function runJson(command, args) { return JSON.parse(await run(command, args)); }
async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-sync-resilience-"));
  const remote = join(root, "remote.git");
  const unavailable = join(root, "remote.unavailable");
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const project = join(root, "project");
  const { command, argsPrefix } = await resolveMorynCommand();
  try {
    await run("git", ["init", "--bare", remote]);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "resilience-project" }, null, 2)}\n`);
    for (const store of [storeA, storeB]) {
      await runJson(command, [...argsPrefix, "--store", store, "init"]);
      await runJson(command, [...argsPrefix, "--store", store, "sync", "init", remote, "--no-open"]);
    }
    await rename(remote, unavailable);
    const finish = await runJson(command, [...argsPrefix, "--store", storeA, "agent", "finish", "--project", project, "--summary", handoffText, "--agent", "codex", "--session-id", "outage-session", "--device-id", "device-a"]);
    const localRecall = await runJson(command, [...argsPrefix, "--store", storeA, "recall", handoffText, "--project", project, "--kind", "session_summary"]);
    await rename(unavailable, remote);
    const enter = await runJson(command, [...argsPrefix, "--store", storeA, "agent", "enter", "--project", project, "--current-task", "Recover remote outage handoff", "--agent", "codex", "--session-id", "recovery-session", "--device-id", "device-a", "--no-open"]);
    await runJson(command, [...argsPrefix, "--store", storeB, "sync", "--pull", "--no-open"]);
    const remoteRecall = await runJson(command, [...argsPrefix, "--store", storeB, "recall", handoffText, "--project", project, "--kind", "session_summary"]);
    const evidence = {
      finish_local_recorded: localRecall.results?.some((entry) => entry.record?.id === finish.record?.id) === true,
      push_failed_recoverably: finish.sync?.push_error_details?.code === "SYNC_REMOTE_UNAVAILABLE",
      local_store_ahead: finish.sync?.status?.ahead > 0,
      enter_compensation_pushed: enter.start?.sync?.compensation?.decision === "pushed",
      second_device_recalled_handoff: remoteRecall.results?.some((entry) => entry.record?.id === finish.record?.id) === true
    };
    const failed = Object.entries(evidence).filter(([, value]) => value !== true);
    if (failed.length) throw new Error(`sync resilience evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ finish: finish.sync, enter: enter.start?.sync }, null, 2)}`);
    process.stdout.write(`sync resilience smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally { if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
