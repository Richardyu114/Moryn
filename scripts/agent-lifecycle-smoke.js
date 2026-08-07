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
    const codexEnter = await runJson(command, [...argsPrefix, "--store", storeCodex, "agent", "enter", "--project", project, "--agent", "codex", "--session-id", "codex-enter", "--current-task", "verify autonomous lifecycle activation", "--no-pull"]);
    if (codexEnter.activation?.attempted_repair !== true || codexEnter.activation?.repair_succeeded !== true) throw new Error("Codex agent enter did not self-heal lifecycle activation");
    if (codexEnter.start?.activation_status?.status !== "configured_unverified") throw new Error("Codex agent enter did not report configured lifecycle hooks");
    if (codexEnter.start?.activation_status?.suggested_actions?.[0]?.id !== "trust_codex_hooks") throw new Error("Codex agent enter did not surface the one-time hook trust action");
    const claudeInstall = await runJson(command, [
      ...argsPrefix,
      "--store",
      storeClaude,
      "install",
      "--host",
      "claude",
      "--project",
      project,
      "--apply",
      "--activate-host"
    ]);
    if (claudeInstall.activation_status?.status !== "configured_unverified") throw new Error("Claude install did not safely activate lifecycle hooks");
    const claudeActivationId = claudeInstall.integration_artifact?.artifact?.activation_id;
    if (typeof claudeActivationId !== "string") throw new Error("Claude install did not return an activation id");

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
      "--device-id",
      "device-codex-smoke",
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

    const semanticLearning = { question: "When do agents pull?", conclusion: "Agents pull memories when entering a project.", evidence_type: "source_code", scope: "project", confidence: 0.99, recommended_kind: "memory", recommended_type: "fact", related_record_ids: [] };
    const protectedLearning = { question: "How many retries?", conclusion: "Retry 4 times.", evidence_type: "source_code", scope: "project", confidence: 0.99, recommended_kind: "memory", recommended_type: "fact", related_record_ids: [] };
    const promptLearning = { question: "What protects release marker ZXQ-731 before context compaction?", conclusion: "A durable Moryn checkpoint protects release marker ZXQ-731 before context compaction.", evidence_type: "source_code", scope: "project", confidence: 0.99, recommended_kind: "memory", recommended_type: "fact", related_record_ids: [] };
    const initialPromptEventsBefore = (await runJson(command, [...argsPrefix, "--store", storeCodex, "health", "check", "--project", project, "--host", "codex"])).stats.total_events;
    const initialPromptRecall = await runJson(command, [
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
      "2026-07-11T10:20:00.000Z",
      "--input-json",
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "codex-smoke", cwd: project, prompt: promptLearning.question }),
      "--no-pull",
      "--no-push"
    ]);
    const initialPromptEventsAfter = (await runJson(command, [...argsPrefix, "--store", storeCodex, "health", "check", "--project", project, "--host", "codex"])).stats.total_events;
    if (initialPromptRecall.prompt_recall?.outcome?.status !== "knowledge_gap") {
      throw new Error(
        `Initial Codex prompt recall did not expose a knowledge gap: ${JSON.stringify(initialPromptRecall.prompt_recall ?? null)}`
      );
    }
    if (initialPromptEventsAfter !== initialPromptEventsBefore) throw new Error("Initial Codex prompt recall mutated the event store");

    const target = await runJson(command, [...argsPrefix, "--store", storeCodex, "write", "--kind", "memory", "--type", "fact", "--scope", "project", "--project", project, "--text", "Agents pull memory on project enter.", "--state", "canonical", "--confirm"]);
    const protectedTarget = await runJson(command, [...argsPrefix, "--store", storeCodex, "write", "--kind", "memory", "--type", "fact", "--scope", "project", "--project", project, "--text", "Retry 3 times."]);
    const semanticProposal = { proposal_id: "smoke-semantic", source_record_id: learningRecordId("moryn-smoke", semanticLearning), target_record_id: target.record.id, relationship: "duplicate_of", confidence: 0.99, rationale: "Equivalent enter behavior.", semantic_equivalence: "equivalent", material_differences: [], evidence_record_ids: [] };
    const protectedProposal = { proposal_id: "smoke-protected", source_record_id: learningRecordId("moryn-smoke", protectedLearning), target_record_id: protectedTarget.record.id, relationship: "duplicate_of", confidence: 0.99, rationale: "Protected retry difference.", semantic_equivalence: "equivalent", material_differences: [{ field: "retry count", before: "3", after: "4", significance: "minor" }], evidence_record_ids: [] };
    const unresolvedInvestigation = { resolution_id: "smoke-release-policy", question: "What is the release rollback policy?", recall_status: "knowledge_gap", recalled_record_ids: [], evidence: [{ type: "source_code", reference: "src/release.ts", summary: "Signed tag validation exists" }], status: "unresolved", next_step: "Run the rollback integration smoke" };
    const advancedInvestigation = { ...unresolvedInvestigation, evidence: [...unresolvedInvestigation.evidence, { type: "source_code", reference: "tests/release.ts", summary: "Rollback fixture is ready" }], next_step: "Verify rollback behavior in the release candidate" };
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
      "--learning",
      JSON.stringify(promptLearning),
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
    const compensatedStart = await runJson(command, [
      ...argsPrefix,
      "--store",
      storeCodex,
      "agent",
      "start",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "codex",
      "--session-id",
      "codex-smoke",
      "--device-id",
      "device-codex-smoke",
      "--current-task",
      "verify checkpoint lifecycle smoke"
    ]);
    if (compensatedStart.sync?.compensation?.decision !== "pushed") throw new Error("Agent start did not compensate the unpushed checkpoint");
    const recoveryPack = compensatedStart.boot?.checkpoint_recovery_pack;
    const resumeAction = compensatedStart.next?.actions_by_id?.resume_from_checkpoint;
    if (recoveryPack?.available !== true || recoveryPack?.source_record_ids?.[0] !== checkpoint.checkpoint.record.id) throw new Error("Abnormal-exit start did not expose the durable checkpoint recovery pack");
    if (resumeAction?.execution?.ready_to_run !== true) throw new Error("Abnormal-exit start did not expose a ready resume action");
    const recoveryRecall = await runJson(command, [...argsPrefix, "--store", storeCodex, "recall", "--project", "moryn-smoke", "--record-id", checkpoint.checkpoint.record.id, "--include-private"]);
    const checkpointRecordsAfterRecovery = recoveryRecall.results?.filter((entry) => entry.record?.id === checkpoint.checkpoint.record.id).length ?? 0;
    if (checkpointRecordsAfterRecovery !== 1) throw new Error("Abnormal-exit recovery duplicated or lost the checkpoint record");
    const secondCheckpoint = await runJson(command, [
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
      "2026-07-11T10:33:00.000Z",
      "--current-task",
      "verify repeated checkpoint lifecycle smoke",
      "--input-json",
      JSON.stringify({ hook_event_name: "PreCompact", session_id: "codex-smoke", cwd: project, trigger: "auto", compact_summary: "Second checkpoint advanced rollback verification." }),
      "--knowledge-investigation",
      JSON.stringify(advancedInvestigation)
    ]);
    if (secondCheckpoint.checkpoint?.idempotent_replay !== false) throw new Error("Second PreCompact did not create a distinct checkpoint");
    if (secondCheckpoint.checkpoint_sync?.deferred?.reason !== "host_hook_local_fast_path") throw new Error("Second PreCompact did not defer remote sync outside the host hook");
    const secondCheckpointPush = await runJson(command, [...argsPrefix, "--store", storeCodex, "sync", "--push", "--message", "publish second lifecycle checkpoint"]);
    if (secondCheckpointPush.pushed !== true) throw new Error("Explicit sync did not push the latest checkpoint");
    await runJson(command, [...argsPrefix, "--store", storeClaude, "init"]);
    await runJson(command, [...argsPrefix, "--store", storeClaude, "sync", "init", remote]);
    const claudeCheckpointPull = await runJson(command, [...argsPrefix, "--store", storeClaude, "sync", "--pull"]);
    if (claudeCheckpointPull.ok !== true) throw new Error("Explicit Claude sync did not pull the Codex checkpoint");
    const claudeLegacyPostCompact = await runJson(command, [
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
      "--activation-id",
      claudeActivationId,
      "--occurred-at",
      "2026-07-11T10:35:00.000Z",
      "--current-task",
      "continue cross device lifecycle smoke",
      "--input-json",
      JSON.stringify({ hook_event_name: "PostCompact", session_id: "codex-smoke", cwd: project })
    ]);
    if (claudeLegacyPostCompact.action !== "defer_to_session_start" || claudeLegacyPostCompact.hook_output?.additional_context !== "") throw new Error("Legacy Claude PostCompact was not a silent compatibility no-op");
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
      "--activation-id",
      claudeActivationId,
      "--occurred-at",
      "2026-07-11T10:35:01.000Z",
      "--current-task",
      "continue cross device lifecycle smoke",
      "--input-json",
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "codex-smoke", cwd: project, source: "compact" }),
      "--no-pull",
      "--no-push"
    ]);
    if (!claudeRestore.hook_output?.additional_context?.includes("Checkpoint smoke persisted with semantic consolidation")) throw new Error("Claude compact SessionStart did not restore the Codex checkpoint");
    if (!claudeRestore.hook_output?.additional_context?.includes(advancedInvestigation.next_step)) throw new Error("Claude compact SessionStart did not restore the latest unresolved knowledge next step");
    if (claudeRestore.activation_receipt?.created !== true) throw new Error("Claude compact SessionStart did not record activation receipt evidence");
    const claudeRecoveryPack = claudeRestore.details?.boot?.checkpoint_recovery_pack;
    if (claudeRecoveryPack?.checkpoint_count !== 2 || claudeRecoveryPack?.latest_checkpoint_id !== secondCheckpoint.checkpoint.record.content.checkpoint.checkpoint_id) throw new Error("Claude compact SessionStart did not select the latest of two checkpoints");
    if (!claudeRecoveryPack.progress?.includes("Second checkpoint advanced rollback verification.")) throw new Error("Claude compact SessionStart did not restore second-checkpoint progress");
    const secondPromptEventsBefore = (await runJson(command, [...argsPrefix, "--store", storeClaude, "health", "check", "--project", project, "--host", "claude"])).stats.total_events;
    const secondDevicePromptRecall = await runJson(command, [
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
      "--activation-id",
      claudeActivationId,
      "--occurred-at",
      "2026-07-11T10:37:00.000Z",
      "--input-json",
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "codex-smoke", cwd: project, prompt: promptLearning.question }),
      "--no-pull",
      "--no-push"
    ]);
    const secondPromptEventsAfter = (await runJson(command, [...argsPrefix, "--store", storeClaude, "health", "check", "--project", project, "--host", "claude"])).stats.total_events;
    if (secondDevicePromptRecall.prompt_recall?.outcome?.status !== "trusted_match") throw new Error(`Second-device Claude prompt recall did not find trusted learned knowledge: ${JSON.stringify(secondDevicePromptRecall.prompt_recall)}`);
    if (!secondDevicePromptRecall.hook_output?.additional_context?.includes(promptLearning.conclusion)) throw new Error("Second-device Claude prompt recall did not inject the learned conclusion");
    if (secondPromptEventsAfter !== secondPromptEventsBefore) throw new Error("Second-device Claude prompt recall mutated the event store");
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
      "--activation-id",
      claudeActivationId,
      "--occurred-at",
      "2026-07-11T10:40:00.000Z",
      "--current-task",
      "continue cross device lifecycle smoke",
      "--input-json",
      JSON.stringify({ hook_event_name: "SessionEnd", session_id: "codex-smoke", cwd: project })
    ]);
    if (finish.deferred_work?.[0]?.reason !== "host_hook_local_fast_path" || finish.details?.sync?.push !== undefined) throw new Error("Claude SessionEnd did not keep remote sync outside the host hook");
    if (finish.details?.record?.content?.synthesis_mode !== "evidence_synthesized") throw new Error("Claude finish did not synthesize from checkpoint evidence");
    const finishSummary = finish.details.record.content.text;
    const claudeHandoffPush = await runJson(command, [...argsPrefix, "--store", storeClaude, "sync", "--push", "--message", "publish Claude lifecycle handoff"]);
    if (claudeHandoffPush.pushed !== true) throw new Error("Explicit sync did not push the Claude handoff");
    await runJson(command, [...argsPrefix, "--store", storeCodexSecond, "init"]);
    await runJson(command, [...argsPrefix, "--store", storeCodexSecond, "sync", "init", remote]);
    const codexHandoffPull = await runJson(command, [...argsPrefix, "--store", storeCodexSecond, "sync", "--pull"]);
    if (codexHandoffPull.ok !== true) throw new Error("Explicit second-Codex sync did not pull the Claude handoff");
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
      status.record.updated_at,
      "--no-pull"
    ]);

    if (codexStart.sync.pull !== undefined) throw new Error("Second Codex agent start unexpectedly performed a remote pull");
    requireChange(codexStart, finishSummary);
    const readModelHealth = await runJson(command, [...argsPrefix, "--store", storeCodexSecond, "health", "check", "--project", project, "--host", "codex"]);
    if (readModelHealth.record_read_model?.status !== "fresh" || readModelHealth.record_read_model?.source !== "read_model") throw new Error("Second Codex did not use a fresh verified record read model");

    const claudeContext = claudeRestore.hook_output.additional_context;
    const crossHostHandoff = {
      codex_status_pushed: status.sync.push.pushed === true,
      claude_checkpoint_pulled: claudeCheckpointPull.ok === true,
      claude_handoff_pushed: claudeHandoffPush.pushed === true,
      second_codex_handoff_pulled: codexHandoffPull.ok === true,
      second_codex_handoff_visible: codexStart.refresh.changes.some((change) => change.summary.includes(finishSummary))
    };
    const checkpointCompactionRecovery = {
      checkpoint_created: checkpoint.checkpoint.idempotent_replay === false,
      idempotent_replay: checkpointReplay.checkpoint.idempotent_replay === true,
      second_checkpoint_created: secondCheckpoint.checkpoint.idempotent_replay === false,
      second_checkpoint_pushed: secondCheckpointPush.pushed === true,
      legacy_postcompact_silent: claudeLegacyPostCompact.action === "defer_to_session_start" && claudeLegacyPostCompact.hook_output.additional_context === "",
      compact_session_start_restored: claudeRestore.action === "agent_start",
      recovery_pack_available: recoveryPack.available === true,
      resume_action_ready: resumeAction.execution.ready_to_run === true,
      claude_checkpoint_restored: claudeContext.includes("Checkpoint smoke persisted with semantic consolidation"),
      claude_checkpoint_count: claudeRecoveryPack.checkpoint_count,
      claude_latest_checkpoint_restored: claudeRecoveryPack.latest_checkpoint_id === secondCheckpoint.checkpoint.record.content.checkpoint.checkpoint_id && claudeContext.includes("Second checkpoint advanced rollback verification."),
      claude_latest_investigation_restored: claudeContext.includes(advancedInvestigation.next_step)
    };
    const semanticConsolidation = {
      proposals_accepted: checkpoint.checkpoint.semantic_consolidation.proposals_accepted,
      links_created: checkpoint.checkpoint.semantic_consolidation.links_created,
      protected_rejections: checkpoint.checkpoint.semantic_consolidation.rejected_by_reason.protected_signal_difference
    };
    const recallExploreLearn = {
      initial_prompt_status: initialPromptRecall.prompt_recall.outcome.status,
      initial_prompt_read_only: initialPromptEventsAfter === initialPromptEventsBefore,
      learning_records_created: checkpoint.checkpoint.recovery_pack.learnings.length,
      unresolved_investigations_preserved: checkpoint.checkpoint.recovery_pack.knowledge_investigations.length,
      second_device_prompt_status: secondDevicePromptRecall.prompt_recall.outcome.status,
      second_device_prompt_record_count: secondDevicePromptRecall.prompt_recall.record_count,
      second_device_prompt_read_only: secondPromptEventsAfter === secondPromptEventsBefore,
      second_device_learning_restored: [semanticLearning, protectedLearning].every((learning) => claudeContext.includes(learning.conclusion)),
      second_device_investigation_restored: claudeContext.includes(advancedInvestigation.next_step)
    };
    const boundedVerifiedReads = {
      source: readModelHealth.record_read_model.source,
      status: readModelHealth.record_read_model.status,
      project_id: readModelHealth.project_id
    };
    const abnormalExit = {
      compensation: compensatedStart.sync.compensation.decision,
      recovery_pack_available: recoveryPack.available,
      resume_action_ready: resumeAction.execution.ready_to_run,
      second_device_checkpoint_restored: claudeContext.includes("Checkpoint smoke persisted with semantic consolidation"),
      second_device_investigation_restored: claudeContext.includes(advancedInvestigation.next_step),
      checkpoint_records_after_recovery: checkpointRecordsAfterRecovery
    };
    const acceptance = {
      cross_host_handoff: Object.values(crossHostHandoff).every((value) => value === true),
      checkpoint_compaction_recovery: checkpointCompactionRecovery.checkpoint_created && checkpointCompactionRecovery.idempotent_replay && checkpointCompactionRecovery.second_checkpoint_created && checkpointCompactionRecovery.second_checkpoint_pushed && checkpointCompactionRecovery.legacy_postcompact_silent && checkpointCompactionRecovery.compact_session_start_restored && checkpointCompactionRecovery.recovery_pack_available && checkpointCompactionRecovery.resume_action_ready && checkpointCompactionRecovery.claude_checkpoint_restored && checkpointCompactionRecovery.claude_checkpoint_count === 2 && checkpointCompactionRecovery.claude_latest_checkpoint_restored && checkpointCompactionRecovery.claude_latest_investigation_restored,
      semantic_consolidation: semanticConsolidation.proposals_accepted === 1 && semanticConsolidation.links_created === 1 && semanticConsolidation.protected_rejections === 1,
      recall_explore_learn: recallExploreLearn.initial_prompt_status === "knowledge_gap" && recallExploreLearn.initial_prompt_read_only && recallExploreLearn.learning_records_created === 3 && recallExploreLearn.unresolved_investigations_preserved === 1 && recallExploreLearn.second_device_prompt_status === "trusted_match" && recallExploreLearn.second_device_prompt_record_count === 1 && recallExploreLearn.second_device_prompt_read_only && recallExploreLearn.second_device_learning_restored && recallExploreLearn.second_device_investigation_restored,
      bounded_verified_reads: boundedVerifiedReads.source === "read_model" && boundedVerifiedReads.status === "fresh" && boundedVerifiedReads.project_id === "moryn-smoke",
      abnormal_exit_recovery: abnormalExit.compensation === "pushed" && abnormalExit.recovery_pack_available && abnormalExit.resume_action_ready && abnormalExit.second_device_checkpoint_restored && abnormalExit.second_device_investigation_restored && abnormalExit.checkpoint_records_after_recovery === 1
    };
    if (!Object.values(acceptance).every((value) => value === true)) throw new Error(`Lifecycle acceptance evidence incomplete: ${JSON.stringify(acceptance)}`);

    log(`agent lifecycle smoke passed (${options.remote ? "remote" : "local"} Git remote)`);
    log(statusSummary);
    log(finishSummary);
    log(JSON.stringify({
      checkpoint_record_id: checkpoint.checkpoint.record.id,
      checkpoint_idempotent_replay: checkpointReplay.checkpoint.idempotent_replay,
      semantic_links_created: checkpoint.checkpoint.semantic_consolidation.links_created,
      protected_rejections: checkpoint.checkpoint.semantic_consolidation.rejected_by_reason.protected_signal_difference,
      unresolved_knowledge_next_step: advancedInvestigation.next_step,
      claude_activation_status: claudeInstall.activation_status.status,
      claude_activation_receipt_created: claudeRestore.activation_receipt.created,
      codex_activation_status: codexEnter.start.activation_status.status,
      codex_enter_self_healed: codexEnter.activation.repair_succeeded,
      record_read_model_status: readModelHealth.record_read_model.status,
      session_synthesis_mode: finish.details.record.content.synthesis_mode,
      abnormal_exit_compensation: compensatedStart.sync.compensation.decision,
      cross_host_handoff: crossHostHandoff,
      checkpoint_compaction_recovery: checkpointCompactionRecovery,
      semantic_consolidation: semanticConsolidation,
      recall_explore_learn: recallExploreLearn,
      bounded_verified_reads: boundedVerifiedReads,
      abnormal_exit: abnormalExit,
      acceptance
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
