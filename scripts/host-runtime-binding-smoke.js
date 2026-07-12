#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function resolveMorynCommand() {
  const builtCli = join(packageRoot, "dist", "cli.js");
  try { await access(builtCli); return { command: process.execPath, argsPrefix: [builtCli], cliEntry: builtCli }; }
  catch {
    const sourceCli = join(packageRoot, "src", "cli.ts");
    return { command: process.execPath, argsPrefix: ["--import", "tsx", sourceCli], cliEntry: sourceCli };
  }
}

async function run(command, args, options = {}) {
  return (await exec(command, args, { cwd: options.cwd ?? packageRoot, env: options.env ?? process.env, input: options.input })).stdout;
}

async function runJson(command, args, options = {}) {
  return JSON.parse(await run(command, args, options));
}

async function runWithInput(command, args, input, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? packageRoot, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolvePromise(Buffer.concat(stdout).toString("utf8")) : reject(new Error(`command failed (${code}): ${Buffer.concat(stderr).toString("utf8")}`)));
    child.stdin.end(input);
  });
}

function hookCommand(settings) {
  const entry = settings?.hooks?.SessionStart?.[0]?.hooks?.[0];
  if (!entry || typeof entry.command !== "string") throw new Error("generated SessionStart hook command missing");
  return entry.command;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-host-runtime-binding-"));
  const store = join(root, "store");
  const project = join(root, "project");
  const fakeBin = join(root, "fake-bin");
  const fakeMarker = join(root, "fake-moryn-invoked");
  const { command, argsPrefix, cliEntry } = await resolveMorynCommand();
  try {
    await mkdir(fakeBin, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "runtime-binding" }, null, 2)}\n`);
    const fakeMoryn = join(fakeBin, "moryn");
    await writeFile(fakeMoryn, `#!/bin/sh\nprintf invoked > '${fakeMarker}'\necho old-moryn >&2\nexit 93\n`);
    await chmod(fakeMoryn, 0o700);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };

    await runJson(command, [...argsPrefix, "--store", store, "init"], { env });
    const applied = await runJson(command, [...argsPrefix, "--store", store, "activation", "apply", "--host", "codex", "--project", project], { env });
    const settings = JSON.parse(await readFile(join(project, ".codex", "hooks.json"), "utf8"));
    const generatedCommand = hookCommand(settings);
    const payload = JSON.stringify({ session_id: "runtime-binding-session", cwd: project, hook_event_name: "SessionStart" });
    await runWithInput("/bin/sh", ["-c", generatedCommand], payload, { env });
    const status = await runJson(command, [...argsPrefix, "--store", store, "activation", "status", "--host", "codex", "--project", project], { env });
    let fakeInvoked = false;
    try { await access(fakeMarker); fakeInvoked = true; } catch {}

    const evidence = {
      configured_hook_uses_current_runtime: generatedCommand.includes(cliEntry) && !/(^|\s)moryn --store/.test(generatedCommand),
      fake_path_binary_not_invoked: !fakeInvoked,
      activation_receipt_observed: status.status === "active" && status.observed_events.includes("session_start"),
      activation_apply_configured: applied.status?.status === "configured_unverified"
    };
    const failed = Object.entries(evidence).filter(([, value]) => value !== true);
    if (failed.length) throw new Error(`host runtime binding evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ generatedCommand, status }, null, 2)}`);
    process.stdout.write(`host runtime binding smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally {
    if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
