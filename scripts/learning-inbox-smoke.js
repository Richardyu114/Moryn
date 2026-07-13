#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = [process.execPath, ["--import", "tsx", join(rootDir, "src", "cli.ts")]];
async function json(store, args) { return JSON.parse((await exec(cli[0], [...cli[1], "--store", store, ...args], { cwd: rootDir })).stdout); }

const root = await mkdtemp(join(tmpdir(), "moryn-learning-inbox-"));
try {
  const store = join(root, "store");
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "learning-inbox-smoke" })}\n`);
  await json(store, ["init"]);
  const learnArgs = ["learn", "--project", project, "--question", "What survives compact?", "--conclusion", "Learning Inbox survives compact until lifecycle consumption.", "--evidence-type", "source_code", "--agent", "codex", "--session-id", "codex-learning", "--device-id", "device-a", "--occurred-at", "2026-07-13T01:00:00.000Z"];
  const queued = await json(store, learnArgs);
  const duplicate = await json(store, learnArgs);
  const checkpoint = await json(store, ["agent", "checkpoint", "--project", project, "--agent", "codex", "--session-id", "codex-learning", "--device-id", "device-a", "--occurred-at", "2026-07-13T01:01:00.000Z", "--checkpoint-id", "compact-learning", "--current-task", "Protect compact learning"]);
  const recalled = await json(store, ["recall", "Learning Inbox survives compact", "--project", project]);
  const evidence = {
    queued_once: queued.created === true,
    duplicate_deduped: duplicate.created === false && duplicate.record.id === queued.record.id,
    compact_checkpoint_consumed: checkpoint.learning_inbox?.consumed === 1,
    claude_recall_ready: JSON.stringify(recalled.results_by_id ?? recalled.results ?? recalled).includes("Learning Inbox survives compact until lifecycle consumption.")
  };
  const failed = Object.entries(evidence).filter(([, value]) => value !== true);
  if (failed.length) throw new Error(`learning inbox smoke failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ evidence, queued, duplicate, checkpoint, recalled }, null, 2)}`);
  process.stdout.write(`learning inbox smoke passed\n${JSON.stringify(evidence)}\n`);
} finally {
  if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true });
}
