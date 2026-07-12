#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
async function eventCount(root) {
  let count = 0;
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".json")) count += 1;
    }
  }
  await walk(join(root, "events"));
  return count;
}
function conflictEvent(client, text) {
  const timestamp = "2026-07-12T02:00:00.000Z";
  return {
    event_id: "evt_conflict_smoke",
    op: "upsert_record",
    record: {
      id: "rec_conflict_smoke", kind: "memory", type: "fact", scope: "project", project_id: "conflict-project", tags: [],
      content: { text, format: "text" }, state: "canonical", confidence: 0.9, priority: "normal", visibility: "active",
      created_at: timestamp, updated_at: timestamp, source: { client, device_id: "shared-device" }, provenance: { method: "agent-proposed" }
    },
    created_at: timestamp, source: { client, device_id: "shared-device" }
  };
}
async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-sync-conflict-"));
  const remote = join(root, "remote.git");
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const project = join(root, "project");
  const conflictRelative = join("events", "shared-device", "2026-07", "evt_conflict_smoke.json");
  const { command, argsPrefix } = await resolveMorynCommand();
  try {
    await run("git", ["init", "--bare", remote]);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "conflict-project" }, null, 2)}\n`);
    for (const store of [storeA, storeB]) {
      await runJson(command, [...argsPrefix, "--store", store, "init"]);
      await runJson(command, [...argsPrefix, "--store", store, "sync", "init", remote, "--no-open"]);
    }
    await runJson(command, [...argsPrefix, "--store", storeA, "write", "--kind", "memory", "--type", "fact", "--scope", "project", "--project-id", "conflict-project", "--state", "canonical", "--text", "Shared baseline"]);
    await runJson(command, [...argsPrefix, "--store", storeA, "sync", "--push", "--message", "baseline", "--no-open"]);
    await runJson(command, [...argsPrefix, "--store", storeB, "sync", "--pull", "--no-open"]);
    for (const [store, client, text] of [[storeA, "codex", "Device A conclusion"], [storeB, "claude", "Device B conclusion"]]) {
      const path = join(store, conflictRelative);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(conflictEvent(client, text), null, 2)}\n`);
      await run("git", ["add", conflictRelative], store);
      await run("git", ["commit", "-m", `${client} conflicting event`], store);
    }
    await run("git", ["push", "origin", "main"], storeA);
    let pullEnvelope;
    try { await runJson(command, [...argsPrefix, "--store", storeB, "sync", "--pull", "--no-open"]); }
    catch (error) { pullEnvelope = JSON.parse(error.stderr); }
    const status = await runJson(command, [...argsPrefix, "--store", storeB, "sync", "--status"]);
    const before = await eventCount(storeB);
    let finishEnvelope;
    try { await runJson(command, [...argsPrefix, "--store", storeB, "agent", "finish", "--project", project, "--summary", "This must not be written during conflict.", "--agent", "claude", "--session-id", "conflict-session", "--device-id", "device-b"]); }
    catch (error) { finishEnvelope = JSON.parse(error.stderr); }
    const after = await eventCount(storeB);
    const unmerged = (await run("git", ["ls-files", "-u", "--", conflictRelative], storeB)).trim().split("\n").filter(Boolean);
    const hint = finishEnvelope?.error?.recovery_hint;
    const evidence = {
      conflict_detected: pullEnvelope?.error?.code === "SYNC_CONFLICT" && status.sync_state === "conflict",
      safe_to_retry_sync: status.conflict?.safe_to_retry_sync,
      lifecycle_write_blocked: finishEnvelope?.error?.code === "SYNC_CONFLICT",
      event_count_unchanged: before === after,
      conflict_stages_preserved: unmerged.some((line) => /\s2\t/.test(line)) && unmerged.some((line) => /\s3\t/.test(line)),
      manual_resolution_required: hint?.retry_after?.condition === "conflict_resolved" && hint?.do_not?.includes("write_lifecycle_records") === true
    };
    const failed = Object.entries(evidence).filter(([key, value]) => key === "safe_to_retry_sync" ? value !== false : value !== true);
    if (failed.length) throw new Error(`sync conflict evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ pullEnvelope, status, finishEnvelope, unmerged }, null, 2)}`);
    process.stdout.write(`sync conflict smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally { if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
