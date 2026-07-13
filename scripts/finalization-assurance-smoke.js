#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function resolveCli() {
  const sourceCli = join(packageRoot, "src", "cli.ts");
  try {
    await access(sourceCli);
    return [process.execPath, ["--import", "tsx", sourceCli]];
  } catch {
    return [process.execPath, [join(packageRoot, "dist", "cli.js")]];
  }
}
const cli = await resolveCli();
async function run(command, args, cwd = packageRoot) { return (await exec(command, args, { cwd })).stdout; }
async function json(store, args) { return JSON.parse(await run(cli[0], [...cli[1], "--store", store, ...args])); }

const root = await mkdtemp(join(tmpdir(), "moryn-finalization-assurance-"));
try {
  const remote = join(root, "remote.git");
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const projectA = join(root, "project-a");
  const projectB = join(root, "project-b");
  await run("git", ["init", "--bare", remote], root);
  for (const project of [projectA, projectB]) {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "finalization-assurance", sync: { mode: "session" } })}\n`);
  }
  for (const store of [storeA, storeB]) {
    await json(store, ["init"]);
    await json(store, ["sync", "init", remote]);
  }
  await json(storeA, ["agent", "checkpoint", "--project", projectA, "--agent", "codex", "--session-id", "abandoned", "--device-id", "device-a", "--occurred-at", "2026-07-13T02:00:00.000Z", "--checkpoint-id", "abandoned-checkpoint", "--current-task", "Protect abandoned sessions", "--progress", "Implemented finalization assurance", "--next-step", "Start a replacement session"]);
  await json(storeA, ["learn", "--project", projectA, "--question", "How are abandoned sessions sealed?", "--conclusion", "A replacement session seals the prior durable session automatically.", "--evidence-type", "source_code", "--agent", "codex", "--session-id", "abandoned", "--device-id", "device-a", "--occurred-at", "2026-07-13T02:01:00.000Z"]);
  const started = await json(storeA, ["agent", "start", "--project", projectA, "--current-task", "Continue safely", "--agent", "codex", "--session-id", "replacement", "--device-id", "device-a", "--no-pull"]);
  await json(storeB, ["sync", "--pull"]);
  const handoff = await json(storeB, ["recall", "Implemented finalization assurance", "--project", projectB]);
  const learning = await json(storeB, ["recall", "replacement session seals", "--project", projectB]);
  const evidence = {
    recovered_prior_session: started.finalization_assurance?.status === "recovered" && started.finalization_assurance?.prior_session?.session_id === "abandoned",
    learning_consumed: started.finalization_assurance?.learning_inbox?.consumed === 1,
    second_device_handoff_recall: JSON.stringify(handoff).includes("Implemented finalization assurance"),
    second_device_learning_recall: JSON.stringify(learning).includes("A replacement session seals the prior durable session automatically.")
  };
  const failed = Object.entries(evidence).filter(([, value]) => value !== true);
  if (failed.length) throw new Error(`finalization assurance smoke failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ evidence, started, handoff, learning }, null, 2)}`);
  process.stdout.write(`finalization assurance smoke passed\n${JSON.stringify(evidence)}\n`);
} finally {
  if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true });
}
