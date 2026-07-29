#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
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

async function materializeRuntime(target, source) {
  const cliRelativePath = relative(packageRoot, source.cliEntry);
  const sourceRoot = cliRelativePath.split(sep)[0];
  if ((sourceRoot !== "dist" && sourceRoot !== "src") || cliRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`unsupported smoke runtime entry: ${source.cliEntry}`);
  }
  await mkdir(target, { recursive: true });
  await cp(join(packageRoot, sourceRoot), join(target, sourceRoot), { recursive: true });
  await writeFile(join(target, "package.json"), '{"type":"module"}\n');
  await symlink(join(packageRoot, "node_modules"), join(target, "node_modules"), "dir");
  const cliEntry = join(target, cliRelativePath);
  return {
    command: source.command,
    argsPrefix: [...source.argsPrefix.slice(0, -1), cliEntry],
    cliEntry
  };
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
  try {
    const sourceRuntime = await resolveMorynCommand();
    const oldRuntimeRoot = join(root, "runtime-old");
    const nextRuntimeRoot = join(root, "runtime-next");
    const oldNode = join(root, "node-old");
    await copyFile(process.execPath, oldNode);
    await chmod(oldNode, 0o700);
    const oldRuntime = { ...(await materializeRuntime(oldRuntimeRoot, sourceRuntime)), command: oldNode };
    const nextRuntime = await materializeRuntime(nextRuntimeRoot, sourceRuntime);
    await mkdir(fakeBin, { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "runtime-binding" }, null, 2)}\n`);
    const fakeMoryn = join(fakeBin, "moryn");
    await writeFile(fakeMoryn, `#!/bin/sh\nprintf invoked > '${fakeMarker}'\necho old-moryn >&2\nexit 93\n`);
    await chmod(fakeMoryn, 0o700);
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };

    await runJson(oldRuntime.command, [...oldRuntime.argsPrefix, "--store", store, "init"], { env });
    const applied = await runJson(oldRuntime.command, [...oldRuntime.argsPrefix, "--store", store, "activation", "apply", "--host", "codex", "--project", project], { env });
    const settings = JSON.parse(await readFile(join(project, ".codex", "hooks.json"), "utf8"));
    const generatedCommand = hookCommand(settings);
    const launcherPath = applied?.fragment?.artifact?.runtime_binding?.path;
    if (typeof launcherPath !== "string" || !resolve(launcherPath).startsWith(`${resolve(root)}${sep}`)) {
      throw new Error(`activation returned an unsafe runtime binding path: ${String(launcherPath)}`);
    }
    const unavailableMarkerPath = `${launcherPath}.unavailable`;
    await rm(oldNode);
    const payload = JSON.stringify({ session_id: "runtime-binding-session", cwd: project, hook_event_name: "SessionStart" });
    await runWithInput("/bin/sh", ["-c", generatedCommand], payload, { env });
    const receiptStatus = await runJson(nextRuntime.command, [...nextRuntime.argsPrefix, "--store", store, "activation", "status", "--host", "codex", "--project", project], { env });
    await rm(oldRuntime.cliEntry);
    await runWithInput("/bin/sh", ["-c", generatedCommand], payload, { env });
    const unavailableMarker = await readFile(unavailableMarkerPath, "utf8");
    const unavailableStatus = await runJson(nextRuntime.command, [...nextRuntime.argsPrefix, "--store", store, "activation", "status", "--host", "codex", "--project", project], { env });
    const health = await runJson(nextRuntime.command, [...nextRuntime.argsPrefix, "--store", store, "health", "check", "--project", project, "--host", "codex"], { env });
    const upgraded = await runJson(nextRuntime.command, [...nextRuntime.argsPrefix, "--store", store, "activation", "apply", "--host", "codex", "--project", project], { env });
    const upgradedSettings = JSON.parse(await readFile(join(project, ".codex", "hooks.json"), "utf8"));
    const upgradedCommand = hookCommand(upgradedSettings);
    const launcher = await readFile(launcherPath, "utf8");
    const status = await runJson(nextRuntime.command, [...nextRuntime.argsPrefix, "--store", store, "activation", "status", "--host", "codex", "--project", project], { env });
    let fakeInvoked = false;
    try { await access(fakeMarker); fakeInvoked = true; } catch {}
    let oldNodePresent = true;
    try { await access(oldNode); } catch { oldNodePresent = false; }
    let unavailableMarkerPresent = true;
    try { await access(unavailableMarkerPath); } catch { unavailableMarkerPresent = false; }

    const evidence = {
      configured_hook_uses_stable_launcher: generatedCommand.includes(`'/bin/sh' '${launcherPath}'`) && !generatedCommand.includes(oldRuntime.cliEntry) && !generatedCommand.includes(nextRuntime.cliEntry) && !/(^|\s)moryn --store/.test(generatedCommand),
      trusted_command_stable_across_runtime_upgrade: generatedCommand === upgradedCommand,
      launcher_bound_to_current_runtime: launcher.includes(nextRuntime.cliEntry) && !launcher.includes(oldRuntime.cliEntry),
      old_node_removed_before_first_hook: !oldNodePresent,
      first_hook_receipt_observed_before_repair: receiptStatus.observed_events.includes("session_start"),
      missing_cli_hook_degraded_without_failure: unavailableMarker === "reason=cli_unavailable\n" && unavailableStatus.runtime_binding_status === "unavailable",
      health_requires_attention_for_unavailable_runtime: health.status === "needs_attention",
      repair_cleared_unavailable_marker: !unavailableMarkerPresent,
      fake_path_binary_not_invoked: !fakeInvoked,
      activation_receipt_observed: status.status === "active" && status.observed_events.includes("session_start"),
      activation_apply_configured: applied.status?.status === "configured_unverified" && upgraded.status?.status === "active"
    };
    const failed = Object.entries(evidence).filter(([, value]) => value !== true);
    if (failed.length) throw new Error(`host runtime binding evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify({ generatedCommand, status }, null, 2)}`);
    process.stdout.write(`host runtime binding smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally {
    if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
