#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = {
    remote: process.env.MORYN_AGENT_LIFECYCLE_REMOTE?.trim() || process.env.MORYN_PRIVATE_GIT_REMOTE?.trim() || undefined,
    keepTemp: process.env.MORYN_SMOKE_KEEP_TEMP === "1",
    useSource: process.env.MORYN_SMOKE_USE_DIST === "1" ? false : true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      const remote = argv[index + 1]?.trim();
      if (!remote) throw new Error("--remote requires a Git remote path or URL");
      options.remote = remote;
      index += 1;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--source") {
      options.useSource = true;
    } else if (arg === "--dist") {
      options.useSource = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run smoke:agent-lifecycle -- [--remote <git-remote>] [--source|--dist] [--keep-temp]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function run(command, args, options = {}) {
  const { stdout } = await exec(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env
  });
  return stdout;
}

async function runJson(command, args, options = {}) {
  return JSON.parse(await run(command, args, options));
}

function requireAction(actions, action, tool) {
  const found = actions.find((candidate) => candidate.action === action && candidate.tool === tool);
  if (!found) throw new Error(`Missing next action ${action} for ${tool}`);
  return found;
}

function requireChange(output, summary) {
  if (!output.refresh.changes.some((change) => change.summary.includes(summary))) {
    throw new Error(`Expected refresh changes to include: ${summary}`);
  }
}

function requireRecentChange(output, summary) {
  if (!output.boot.recent_changes.some((record) => record.content?.text?.includes(summary))) {
    throw new Error(`Expected boot recent_changes to include: ${summary}`);
  }
}

function learningRecordId(projectId, learning) {
  const canonical = JSON.stringify({ project_id: projectId, conclusion: learning.conclusion, scope: learning.scope, recommended_kind: learning.recommended_kind, recommended_type: learning.recommended_type });
  return `rec_learning_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

async function resolveMorynCommand(useSource) {
  if (useSource) {
    const sourceCli = join(packageRoot, "src", "cli.ts");
    try {
      await access(sourceCli);
    } catch {
      return resolveMorynCommand(false);
    }

    const localTsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      await access(localTsx);
      return { command: "node", argsPrefix: [localTsx, sourceCli] };
    } catch {
      return { command: "node", argsPrefix: ["--import", "tsx", sourceCli] };
    }
  }

  const distCli = join(packageRoot, "dist", "cli.js");
  return { command: "node", argsPrefix: [distCli] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-smoke-"));
  const storeCodex = join(root, "store-codex");
  const storeClaude = join(root, "store-claude");
  const storeCodexSecond = join(root, "store-codex-second");
  const project = join(root, "project");
  const remote = options.remote ?? join(root, "remote.git");
  const { command, argsPrefix } = await resolveMorynCommand(options.useSource ?? false);

  try {
    if (!options.remote) {
      await run("git", ["init", "--bare", remote]);
    }

    await run(command, [...argsPrefix, "project", "init", "--path", project, "--project-id", "moryn-smoke", "--tag", "typescript"]);

    const statusSummary = "Codex smoke status reached Gemini";
    const status = await runJson(command, [
      ...argsPrefix,
      "--store",
      storeCodex,
      "agent",
      "status",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "codex",
      "--session-id",
      "codex-smoke",
      "--current-task",
      "verify cross device lifecycle smoke",
      "--status",
      statusSummary
    ]);

    if (status.sync.push?.pushed !== true) throw new Error("Codex status did not push to sync remote");
    const statusFinish = requireAction(status.next.actions, "finish_session", "agent_finish");
    const statusRefresh = requireAction(status.next.actions, "refresh_context", "agent_start");
    if (statusRefresh.arguments.refresh_since !== status.record.updated_at) {
      throw new Error("Status refresh_context cursor does not match status record timestamp");
    }
    if (!statusFinish.required_fields.includes("summary")) {
      throw new Error("Status finish_session action must require summary");
    }

    const target = await runJson(command, [...argsPrefix, "--store", storeCodex, "write", "--kind", "memory", "--type", "fact", "--scope", "project", "--project", project, "--text", "Agents pull memory on project enter.", "--state", "canonical", "--confirm"]);
    const protectedTarget = await runJson(command, [...argsPrefix, "--store", storeCodex, "write", "--kind", "memory", "--type", "fact", "--scope", "project", "--project", project, "--text", "Retry 3 times."]);
    const semanticLearning = { question: "When do agents pull?", conclusion: "Agents pull memories when entering a project.", evidence_type: "source_code", scope: "project", confidence: 0.99, recommended_kind: "memory", recommended_type: "fact", related_record_ids: [] };
    const protectedLearning = { question: "How many retries?", conclusion: "Retry 4 times.", evidence_type: "source_code", scope: "project", confidence: 0.99, recommended_kind: "memory", recommended_type: "fact", related_record_ids: [] };
    const semanticProposal = { proposal_id: "smoke-semantic", source_record_id: learningRecordId("moryn-smoke", semanticLearning), target_record_id: target.record.id, relationship: "duplicate_of", confidence: 0.99, rationale: "Equivalent enter behavior.", semantic_equivalence: "equivalent", material_differences: [], evidence_record_ids: [] };
    const protectedProposal = { proposal_id: "smoke-protected", source_record_id: learningRecordId("moryn-smoke", protectedLearning), target_record_id: protectedTarget.record.id, relationship: "duplicate_of", confidence: 0.99, rationale: "Protected retry difference.", semantic_equivalence: "equivalent", material_differences: [{ field: "retry count", before: "3", after: "4", significance: "minor" }], evidence_record_ids: [] };
    const unresolvedInvestigation = { resolution_id: "smoke-release-policy", question: "What is the release rollback policy?", recall_status: "knowledge_gap", recalled_record_ids: [], evidence: [{ type: "source_code", reference: "src/release.ts", summary: "Signed tag validation exists" }], status: "unresolved", next_step: "Run the rollback integration smoke" };
    const preCompactPayload = JSON.stringify({ hook_event_name: "PreCompact", session_id: "codex-smoke", cwd: project, trigger: "auto", compact_summary: "Checkpoint smoke persisted with semantic consolidation." });
    const checkpointArgs = [
      ...argsPrefix,
      "--store",
      storeCodex,
      "host",
      "hook",
      "--host",
      "codex",
      "--project",
      project,
      "--device-id",
      "device-codex-smoke",
      "--occurred-at",
      "2026-07-11T10:30:00.000Z",
      "--current-task",
      "verify checkpoint lifecycle smoke",
      "--input-json",
      preCompactPayload,
      "--learning",
      JSON.stringify(semanticLearning),
      "--learning",
      JSON.stringify(protectedLearning),
      "--knowledge-investigation",
      JSON.stringify(unresolvedInvestigation),
      "--semantic-consolidation-proposal",
      JSON.stringify(semanticProposal),
      "--semantic-consolidation-proposal",
      JSON.stringify(protectedProposal),
      "--no-pull",
      "--no-push"
    ];
    const checkpoint = await runJson(command, checkpointArgs);
    const checkpointReplay = await runJson(command, checkpointArgs);
    if (checkpoint.checkpoint?.idempotent_replay !== false || checkpointReplay.checkpoint?.idempotent_replay !== true) {
      throw new Error("Checkpoint smoke did not preserve idempotent replay semantics");
    }
    if (checkpoint.checkpoint.record.id !== checkpointReplay.checkpoint.record.id) {
      throw new Error("Checkpoint replay returned a different record id");
    }
    if (checkpoint.checkpoint.recovery_pack?.knowledge_investigations?.[0]?.next_step !== unresolvedInvestigation.next_step) throw new Error("PreCompact did not preserve unresolved knowledge investigation");
    if (checkpoint.checkpoint.semantic_consolidation?.proposals_accepted !== 1 || checkpoint.checkpoint.semantic_consolidation?.rejected_by_reason?.protected_signal_difference !== 1) throw new Error("PreCompact semantic receipt did not contain one accepted and one protected rejection");
    await runJson(command, [...argsPrefix, "--store", storeCodex, "sync", "--push", "--message", "codex precompact semantic"]);
    await runJson(command, [...argsPrefix, "--store", storeClaude, "init"]);
    await runJson(command, [...argsPrefix, "--store", storeClaude, "sync", "init", remote]);
    const claudeRestore = await runJson(command, [
      ...argsPrefix,
      "--store",
      storeClaude,
      "host",
      "hook",
      "--host",
      "claude",
      "--project",
      project,
      "--device-id",
      "device-claude-smoke",
      "--occurred-at",
      "2026-07-11T10:35:00.000Z",
      "--current-task",
      "continue cross device lifecycle smoke",
      "--input-json",
      JSON.stringify({ hook_event_name: "PostCompact", session_id: "codex-smoke", cwd: project })
    ]);
    if (!claudeRestore.hook_output?.additional_context?.includes("Checkpoint smoke persisted with semantic consolidation")) throw new Error("Claude PostCompact did not restore the Codex checkpoint");
    if (!claudeRestore.hook_output?.additional_context?.includes(unresolvedInvestigation.next_step)) throw new Error("Claude PostCompact did not restore the unresolved knowledge next step");
    const finishSummary = "Claude smoke finish reached second Codex";
    const finish = await runJson(command, [
      ...argsPrefix,
      "--store",
      storeClaude,
      "host",
      "hook",
      "--host",
      "claude",
      "--project",
      project,
      "--device-id",
      "device-claude-smoke",
      "--occurred-at",
      "2026-07-11T10:40:00.000Z",
      "--current-task",
      "continue cross device lifecycle smoke",
      "--input-json",
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "claude-smoke", cwd: project, compact_summary: finishSummary })
    ]);
    if (finish.details?.sync?.push?.pushed !== true) throw new Error("Claude finish did not push to sync remote");
    await runJson(command, [...argsPrefix, "--store", storeCodexSecond, "init"]);
    await runJson(command, [...argsPrefix, "--store", storeCodexSecond, "sync", "init", remote]);
    const codexStart = await runJson(command, [
      ...argsPrefix,
      "--store",
      storeCodexSecond,
      "agent",
      "start",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "codex",
      "--session-id",
      "codex-smoke-second",
      "--current-task",
      "verify Claude handoff",
      "--refresh-since",
      status.record.updated_at
    ]);

    if (codexStart.sync.pull?.pulled !== true) throw new Error("Second Codex did not pull Claude handoff");
    requireChange(codexStart, finishSummary);

    log(`agent lifecycle smoke passed (${options.remote ? "remote" : "local"} Git remote)`);
    log(statusSummary);
    log(finishSummary);
    log(JSON.stringify({
      checkpoint_record_id: checkpoint.checkpoint.record.id,
      checkpoint_idempotent_replay: checkpointReplay.checkpoint.idempotent_replay,
      semantic_links_created: checkpoint.checkpoint.semantic_consolidation.links_created,
      protected_rejections: checkpoint.checkpoint.semantic_consolidation.rejected_by_reason.protected_signal_difference,
      unresolved_knowledge_next_step: unresolvedInvestigation.next_step
    }));
  } finally {
    if (options.keepTemp) {
      log(`kept smoke directory: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1]
  ? await realpath(process.argv[1]).catch(() => resolve(process.argv[1]))
  : undefined;

if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
