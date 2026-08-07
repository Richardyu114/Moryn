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
  try {
    await access(built);
    return { command: process.execPath, args: [built] };
  } catch {
    return { command: process.execPath, args: ["--import", "tsx", join(packageRoot, "src", "cli.ts")] };
  }
}

async function run(command, args, options = {}) {
  return (await exec(command, args, { cwd: options.cwd ?? packageRoot, env: options.env ?? process.env })).stdout;
}

async function runJson(command, args, options = {}) {
  return JSON.parse(await run(command, args, options));
}

async function runShellJson(commandLine, payload, env) {
  const stdout = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("/bin/sh", ["-c", commandLine], { env, stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const stderr = Buffer.concat(errors).toString("utf8");
      if (code === 0) resolvePromise(Buffer.concat(output).toString("utf8"));
      else rejectPromise(new Error(`generated hook failed (${code}): ${stderr}`));
    });
    child.stdin.end(JSON.stringify(payload));
  });
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function hookCommand(settings, event) {
  const command = settings.hooks?.[event]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string" || !command.trim()) throw new Error(`Missing generated ${event} hook command`);
  if (!command.includes("--host-output") || !command.includes("--command-digest")) throw new Error(`Generated ${event} command is not a bound Moryn host command`);
  return command;
}

function additionalContext(output) {
  return output.hookSpecificOutput?.additionalContext ?? "";
}

async function initializeSyncedStore(command, args, store, remote, env) {
  await runJson(command, [...args, "--store", store, "init"], { env });
  await runJson(command, [...args, "--store", store, "sync", "init", remote], { env });
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-official-host-handoff-"));
  const projectCodex = join(root, "project-codex");
  const projectClaude = join(root, "project-claude");
  const projectSecondCodex = join(root, "project-second-codex");
  const remote = join(root, "remote.git");
  const storeCodex = join(root, "store-codex");
  const storeClaude = join(root, "store-claude");
  const storeSecondCodex = join(root, "store-second-codex");
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const codexTranscript = join(codexHome, "sessions", "official-handoff.jsonl");
  const claudeTranscript = join(home, ".claude", "projects", "official-handoff", "session.jsonl");
  const hiddenMarker = "official_private_tool_payload_absent";
  const codexProgress = "Codex prepared the official cross-host checkpoint; next Claude must restore it.";
  const claudeHandoff = "Claude restored the Codex checkpoint and completed the official cross-host handoff.";
  const sessionId = "official-host-handoff-session";
  const { command, args } = await cliCommand();
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, MORYN_DEVICE_ID: "device-codex-primary" };

  try {
    await mkdir(join(codexHome, "sessions"), { recursive: true });
    await mkdir(dirname(claudeTranscript), { recursive: true });
    for (const project of [projectCodex, projectClaude, projectSecondCodex]) {
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "official-host-handoff" }, null, 2)}\n`);
    }
    await writeFile(codexTranscript, `${JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: hiddenMarker }] } })}\n${JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: codexProgress } })}\n`);
    await writeFile(claudeTranscript, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", input: { marker: hiddenMarker } }, { type: "text", text: claudeHandoff }] } })}\n`);
    await run("git", ["init", "--bare", remote], { env });

    await initializeSyncedStore(command, args, storeCodex, remote, env);
    await runJson(command, [...args, "--store", storeCodex, "activation", "apply", "--host", "codex", "--project", projectCodex], { env });
    const codexSettings = JSON.parse(await readFile(join(projectCodex, ".codex", "hooks.json"), "utf8"));
    const codexSessionStart = await runShellJson(hookCommand(codexSettings, "SessionStart"), { hook_event_name: "SessionStart", session_id: sessionId, cwd: projectCodex, source: "startup" }, env);
    const codexPrompt = await runShellJson(hookCommand(codexSettings, "UserPromptSubmit"), { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: projectCodex, prompt: "What is the official host handoff invariant?" }, env);
    const codexPreCompact = await runShellJson(hookCommand(codexSettings, "PreCompact"), { hook_event_name: "PreCompact", session_id: sessionId, cwd: projectCodex, trigger: "auto", transcript_path: codexTranscript }, env);
    const codexCheckpointPush = await runJson(command, [...args, "--store", storeCodex, "sync", "--push", "--message", "publish official Codex checkpoint"], { env });

    const claudeEnv = { ...env, MORYN_DEVICE_ID: "device-claude-secondary" };
    await initializeSyncedStore(command, args, storeClaude, remote, claudeEnv);
    const claudeCheckpointPull = await runJson(command, [...args, "--store", storeClaude, "sync", "--pull"], { env: claudeEnv });
    await runJson(command, [...args, "--store", storeClaude, "activation", "apply", "--host", "claude", "--project", projectClaude], { env: claudeEnv });
    const claudeSettings = JSON.parse(await readFile(join(projectClaude, ".claude", "settings.local.json"), "utf8"));
    const claudeSessionStartCommand = hookCommand(claudeSettings, "SessionStart");
    const claudePostCompact = await runShellJson(claudeSessionStartCommand, { hook_event_name: "PostCompact", session_id: sessionId, cwd: projectClaude, transcript_path: claudeTranscript }, claudeEnv);
    const claudeSessionStart = await runShellJson(claudeSessionStartCommand, { hook_event_name: "SessionStart", session_id: sessionId, cwd: projectClaude, source: "compact", transcript_path: claudeTranscript }, claudeEnv);
    const claudeSessionEnd = await runShellJson(hookCommand(claudeSettings, "SessionEnd"), { hook_event_name: "SessionEnd", session_id: sessionId, cwd: projectClaude, reason: "completed", transcript_path: claudeTranscript, last_assistant_message: claudeHandoff }, claudeEnv);
    const claudeHandoffPush = await runJson(command, [...args, "--store", storeClaude, "sync", "--push", "--message", "publish official Claude handoff"], { env: claudeEnv });

    const secondCodexEnv = { ...env, MORYN_DEVICE_ID: "device-codex-second" };
    await initializeSyncedStore(command, args, storeSecondCodex, remote, secondCodexEnv);
    const secondCodexHandoffPull = await runJson(command, [...args, "--store", storeSecondCodex, "sync", "--pull"], { env: secondCodexEnv });
    await runJson(command, [...args, "--store", storeSecondCodex, "activation", "apply", "--host", "codex", "--project", projectSecondCodex], { env: secondCodexEnv });
    const secondCodexSettings = JSON.parse(await readFile(join(projectSecondCodex, ".codex", "hooks.json"), "utf8"));
    const secondCodexSessionStart = await runShellJson(hookCommand(secondCodexSettings, "SessionStart"), { hook_event_name: "SessionStart", session_id: "official-host-handoff-second-device", cwd: projectSecondCodex, source: "startup" }, secondCodexEnv);

    const codexStartContext = additionalContext(codexSessionStart);
    const codexPromptContext = additionalContext(codexPrompt);
    const claudeStartContext = additionalContext(claudeSessionStart);
    const secondCodexContext = additionalContext(secondCodexSessionStart);
    const allContext = [codexStartContext, codexPromptContext, claudeStartContext, secondCodexContext].join("\n");
    const claudeHandoffRecall = await runJson(command, [...args, "--store", storeSecondCodex, "recall", codexProgress, "--project", projectSecondCodex, "--kind", "session_summary"], { env: secondCodexEnv });
    const claudeSummary = claudeHandoffRecall.results?.find((result) => result.record?.type === "summary" && result.record?.source?.client === "claude")?.record;
    const activationHealth = await Promise.all([
      runJson(command, [...args, "--store", storeCodex, "activation", "status", "--host", "codex", "--project", projectCodex], { env }),
      runJson(command, [...args, "--store", storeClaude, "activation", "status", "--host", "claude", "--project", projectClaude], { env: claudeEnv }),
      runJson(command, [...args, "--store", storeSecondCodex, "activation", "status", "--host", "codex", "--project", projectSecondCodex], { env: secondCodexEnv })
    ]);
    const syncHealth = await Promise.all([
      runJson(command, [...args, "--store", storeCodex, "sync", "--status"], { env }),
      runJson(command, [...args, "--store", storeClaude, "sync", "--status"], { env: claudeEnv }),
      runJson(command, [...args, "--store", storeSecondCodex, "sync", "--status"], { env: secondCodexEnv })
    ]);

    const evidence = {
      codex_generated_session_start: codexSessionStart.hookSpecificOutput?.hookEventName === "SessionStart",
      codex_generated_prompt_gap: codexPrompt.hookSpecificOutput?.hookEventName === "UserPromptSubmit" && codexPromptContext.includes("knowledge_gap"),
      codex_generated_precompact: Object.keys(codexPreCompact).length === 0,
      codex_checkpoint_explicitly_pushed: codexCheckpointPush.pushed === true,
      claude_generated_session_start: claudeSessionStart.hookSpecificOutput?.hookEventName === "SessionStart" && claudeStartContext.includes(codexProgress),
      claude_compact_session_start: claudeSessionStart.hookSpecificOutput?.hookEventName === "SessionStart",
      claude_postcompact_not_registered: claudeSettings.hooks?.PostCompact === undefined,
      claude_legacy_postcompact_silent: Object.keys(claudePostCompact).length === 0,
      claude_checkpoint_explicitly_pulled: claudeCheckpointPull.ok === true,
      claude_generated_session_end: Object.keys(claudeSessionEnd).length === 0,
      claude_handoff_explicitly_pushed: claudeHandoffPush.pushed === true,
      second_codex_generated_session_start: secondCodexSessionStart.hookSpecificOutput?.hookEventName === "SessionStart",
      second_codex_handoff_explicitly_pulled: secondCodexHandoffPull.ok === true,
      checkpoint_restored: claudeStartContext.includes(codexProgress) && claudeStartContext.includes("checkpoint_recovery_pack"),
      handoff_visible_on_second_device: secondCodexContext.includes('"handoff_context"') && secondCodexContext.includes('"status": "available"') && claudeSummary?.content?.text?.includes(codexProgress) === true,
      activation_receipts_current: activationHealth.every((status) => status.status === "active"),
      sync_transitions_recorded: syncHealth.map((status) => status.last_sync?.operation).join(",") === "push,push,pull" && syncHealth.every((status) => status.ahead === 0 && status.sync_state !== "conflict"),
      bounded_context: [codexStartContext, codexPromptContext, claudeStartContext, secondCodexContext].every((context) => context.length < 20000),
      private_transcript_content_absent: !allContext.includes(hiddenMarker) && !allContext.includes(codexTranscript) && !allContext.includes(claudeTranscript)
    };
    const failed = Object.entries(evidence).filter(([, value]) => value !== true);
    if (failed.length) throw new Error(`official host handoff evidence failed: ${failed.map(([key]) => key).join(", ")}\n${JSON.stringify(evidence, null, 2)}\nroot=${root}`);
    process.stdout.write(`official host handoff smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally {
    if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
