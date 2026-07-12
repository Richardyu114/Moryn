#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function cliCommand() {
  const built = join(packageRoot, "dist", "cli.js");
  try { await access(built); return { command: process.execPath, args: [built] }; }
  catch { return { command: process.execPath, args: ["--import", "tsx", join(packageRoot, "src", "cli.ts")] }; }
}
async function run(command, args, options = {}) { return (await exec(command, args, { cwd: options.cwd ?? packageRoot, env: options.env ?? process.env })).stdout; }
async function runJson(command, args, options = {}) { return JSON.parse(await run(command, args, options)); }
async function runShellJson(commandLine, payload, env) {
  const stdout = await new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", ["-c", commandLine], { env, stdio: ["pipe", "pipe", "pipe"] });
    const output = []; const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk)); child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolvePromise(Buffer.concat(output).toString("utf8")) : reject(new Error(Buffer.concat(errors).toString("utf8"))));
    child.stdin.end(JSON.stringify(payload));
  });
  return stdout.trim() ? JSON.parse(stdout) : {};
}
function hookCommand(settings, event) { return settings.hooks[event][0].hooks[0].command; }

async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-transcript-compact-"));
  const store = join(root, "store");
  const project = join(root, "project");
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const codexTranscript = join(codexHome, "sessions", "session.jsonl");
  const claudeTranscript = join(home, ".claude", "projects", "fixture", "session.jsonl");
  const { command, args } = await cliCommand();
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  try {
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await mkdir(dirname(claudeTranscript), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "compact-safety" }, null, 2)}\n`);
    await writeFile(codexTranscript, `${JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "sensitive_content_absent hidden reasoning" }] } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Codex completed bounded transcript recovery; next verify resume." } })}\n`);
    await writeFile(claudeTranscript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", input: { secret: "sensitive_content_absent" } }, { type: "text", text: "Claude completed compact checkpoint recovery; next verify handoff." }] } })}\n`);
    await runJson(command, [...args, "--store", store, "init"], { env });
    const evidence = {};
    for (const host of ["codex", "claude"]) {
      await runJson(command, [...args, "--store", store, "activation", "apply", "--host", host, "--project", project], { env });
      const settingsPath = join(project, host === "codex" ? ".codex/hooks.json" : ".claude/settings.local.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      const sessionId = `${host}-compact-session`;
      const transcriptPath = host === "codex" ? codexTranscript : claudeTranscript;
      await runShellJson(hookCommand(settings, "PreCompact"), { session_id: sessionId, cwd: project, hook_event_name: "PreCompact", trigger: "auto", transcript_path: transcriptPath }, env);
      const post = await runShellJson(hookCommand(settings, "PostCompact"), { session_id: sessionId, cwd: project, hook_event_name: "PostCompact", transcript_path: transcriptPath }, env);
      const context = post.hookSpecificOutput?.additionalContext ?? "";
      evidence[`${host}_progress_recovered`] = context.includes(host === "codex" ? "Codex completed bounded transcript recovery" : "Claude completed compact checkpoint recovery");
      evidence[`${host}_precompact_saved`] = context.includes("checkpoint_recovery_pack") && context.includes("checkpoint_count");
      evidence[`${host}_bounded`] = context.length < 20000;
      evidence[`${host}_raw_transcript_path_absent`] = !context.includes(transcriptPath);
      evidence[`${host}_sensitive_content_absent`] = !context.includes("sensitive_content_absent");
    }
    const failed = Object.entries(evidence).filter(([, value]) => value !== true);
    if (failed.length) throw new Error(`transcript compact safety evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify(evidence, null, 2)}\nroot=${root}`);
    process.stdout.write(`transcript compact safety smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally { if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true }); }
}
main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
