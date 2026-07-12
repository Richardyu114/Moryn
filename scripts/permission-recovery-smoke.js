#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const handoffText = "Permission failure handoff remains local and syncs after access repair.";
async function resolveMorynCommand() {
  const sourceCli = join(packageRoot, "src", "cli.ts");
  try {
    await access(sourceCli);
    const localTsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    try { await access(localTsx); return { command: "node", argsPrefix: [localTsx, sourceCli] }; }
    catch { return { command: "node", argsPrefix: ["--import", "tsx", sourceCli] }; }
  } catch { return { command: "node", argsPrefix: [join(packageRoot, "dist", "cli.js")] }; }
}
async function run(command, args, options = {}) { return (await exec(command, args, { cwd: options.cwd ?? packageRoot, env: options.env ?? process.env })).stdout; }
async function runJson(command, args, options = {}) { return JSON.parse(await run(command, args, options)); }
async function eventText(root) {
  const values = [];
  async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const child = join(path, entry.name); if (entry.isDirectory()) await walk(child); else if (entry.name.endsWith(".json")) values.push(await readFile(child, "utf8")); } }
  await walk(join(root, "events")); return values.join("\n");
}
async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-permission-recovery-"));
  const remote = join(root, "remote.git");
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const project = join(root, "project");
  const denySsh = join(root, "deny-ssh.sh");
  const fakeCredentialMarker = "SHOULD_NOT_ENTER_MORYN_EVENTS";
  const { command, argsPrefix } = await resolveMorynCommand();
  try {
    await run("git", ["init", "--bare", remote]);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "permission-project" }, null, 2)}\n`);
    await writeFile(denySsh, `#!/bin/sh\necho 'git@example.invalid: Permission denied (publickey).' >&2\nexit 255\n`);
    await chmod(denySsh, 0o700);
    for (const store of [storeA, storeB]) {
      await runJson(command, [...argsPrefix, "--store", store, "init"]);
      await runJson(command, [...argsPrefix, "--store", store, "sync", "init", remote, "--no-open"]);
    }
    await run("git", ["remote", "set-url", "origin", "ssh://git@example.invalid/moryn-store.git"], { cwd: storeA });
    const deniedEnv = { ...process.env, GIT_SSH_COMMAND: `${denySsh} ${fakeCredentialMarker}`, GIT_TERMINAL_PROMPT: "0" };
    const finish = await runJson(command, [...argsPrefix, "--store", storeA, "agent", "finish", "--project", project, "--summary", handoffText, "--agent", "codex", "--session-id", "permission-session", "--device-id", "device-a"], { env: deniedEnv });
    const localRecall = await runJson(command, [...argsPrefix, "--store", storeA, "recall", handoffText, "--project", project, "--kind", "session_summary"]);
    await run("git", ["remote", "set-url", "origin", remote], { cwd: storeA });
    const enter = await runJson(command, [...argsPrefix, "--store", storeA, "agent", "enter", "--project", project, "--current-task", "Resume after Git permission repair", "--agent", "codex", "--session-id", "permission-recovery", "--device-id", "device-a", "--no-open"]);
    await runJson(command, [...argsPrefix, "--store", storeB, "sync", "--pull", "--no-open"]);
    const remoteRecall = await runJson(command, [...argsPrefix, "--store", storeB, "recall", handoffText, "--project", project, "--kind", "session_summary"]);
    const hint = finish.sync?.push_error_details?.recovery_hint;
    const allEvents = await eventText(storeA);
    const evidence = {
      permission_denied_classified: finish.sync?.push_error_details?.code === "PERMISSION_DENIED" && hint?.permission_denied === true && hint?.local_store_usable === true,
      local_handoff_preserved: localRecall.results?.some((entry) => entry.record?.id === finish.record?.id) === true && finish.sync?.status?.ahead > 0,
      credential_guardrails_present: hint?.do_not?.includes("echo_private_key") === true && hint?.do_not?.includes("write_credentials_to_memory") === true && hint?.do_not?.includes("retry_in_loop_without_user_action") === true,
      repair_then_compensated: enter.start?.sync?.compensation?.decision === "pushed",
      second_device_recalled_handoff: remoteRecall.results?.some((entry) => entry.record?.id === finish.record?.id) === true,
      credentials_absent_from_events: !allEvents.includes(fakeCredentialMarker) && !allEvents.includes("publickey")
    };
    const failed = Object.entries(evidence).filter(([, value]) => value !== true);
    if (failed.length) throw new Error(`permission recovery evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ finish: finish.sync, enter: enter.start?.sync }, null, 2)}`);
    process.stdout.write(`permission recovery smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally { if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
