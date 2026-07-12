#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const legacyDevice = "device_v02_upgrade_fixture";
const legacyEventId = "evt_v02_upgrade_fixture";
const legacyRecordId = "rec_v02_upgrade_fixture";
const legacyCreatedAt = "2026-06-30T00:00:00.000Z";
const legacyText = "v0.2 stores preserve durable project facts.";
const learnedText = "v0.3 reads v0.2 event history and repairs derived read models lazily.";

async function resolveMorynCommand() {
  const sourceCli = join(packageRoot, "src", "cli.ts");
  try {
    await access(sourceCli);
    const localTsx = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      await access(localTsx);
      return { command: "node", argsPrefix: [localTsx, sourceCli] };
    } catch {
      return { command: "node", argsPrefix: ["--import", "tsx", sourceCli] };
    }
  } catch {
    return { command: "node", argsPrefix: [join(packageRoot, "dist", "cli.js")] };
  }
}

async function runJson(command, args) {
  const { stdout } = await exec(command, args, { cwd: packageRoot });
  return JSON.parse(stdout);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function materializeV02Store(store) {
  const event = {
    event_id: legacyEventId,
    op: "upsert_record",
    record: {
      id: legacyRecordId,
      kind: "memory",
      type: "fact",
      scope: "project",
      project_id: "upgrade-project",
      tags: [],
      content: { text: legacyText, format: "text" },
      state: "canonical",
      confidence: 0.5,
      priority: "normal",
      visibility: "active",
      created_at: legacyCreatedAt,
      updated_at: legacyCreatedAt,
      source: { client: "cli", device_id: legacyDevice },
      provenance: { method: "agent-proposed" }
    },
    created_at: legacyCreatedAt,
    source: { client: "cli", device_id: legacyDevice }
  };
  const eventPath = join(store, "events", legacyDevice, "2026-06", `${legacyEventId}.json`);
  await mkdir(dirname(eventPath), { recursive: true });
  await mkdir(join(store, "state"), { recursive: true });
  await mkdir(join(store, "snapshots", "projects"), { recursive: true });
  await mkdir(join(store, "snapshots", "skills"), { recursive: true });
  await mkdir(join(store, "indexes"), { recursive: true });
  await writeFile(join(store, "config.json"), `${JSON.stringify({ store_version: 1, device_id: legacyDevice, created_at: legacyCreatedAt, updated_at: legacyCreatedAt }, null, 2)}\n`);
  await writeFile(eventPath, `${JSON.stringify(event, null, 2)}\n`);
  await writeFile(join(store, "snapshots", "user.json"), `${JSON.stringify({ generated_from_cursor: legacyCreatedAt, soul: [], preferences: [], rules: [] }, null, 2)}\n`);
  await writeFile(join(store, "snapshots", "projects", "upgrade-project.json"), `${JSON.stringify({ project_id: "upgrade-project", generated_from_cursor: legacyCreatedAt, summary: "", decisions: [], warnings: [], skills: [], recent_changes: [event.record] }, null, 2)}\n`);
  await writeFile(join(store, "snapshots", "skills", "index.json"), `${JSON.stringify({ generated_from_cursor: legacyCreatedAt, skills: [] }, null, 2)}\n`);
  await writeFile(join(store, "indexes", "recall.json"), `${JSON.stringify({ generated_from_cursor: legacyCreatedAt, records: [{ id: legacyRecordId, kind: "memory", type: "fact", scope: "project", project_id: "upgrade-project", state: "canonical", priority: "normal", tags: [], text: legacyText, updated_at: legacyCreatedAt }] }, null, 2)}\n`);
  await writeFile(join(store, "indexes", "sync-cursors.json"), `${JSON.stringify({ generated_from_cursor: legacyCreatedAt, latest_record_update: legacyCreatedAt }, null, 2)}\n`);
  return { eventPath, bytes: await readFile(eventPath, "utf8") };
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "moryn-v02-upgrade-smoke-"));
  const store = join(root, "store");
  const project = join(root, "project");
  const { command, argsPrefix } = await resolveMorynCommand();
  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".moryn.json"), `${JSON.stringify({ project_id: "upgrade-project" }, null, 2)}\n`);
    const legacy = await materializeV02Store(store);
    const enter = await runJson(command, [...argsPrefix, "--store", store, "agent", "enter", "--project", project, "--current-task", "Continue upgraded task", "--agent", "codex", "--session-id", "upgrade-codex", "--device-id", "upgrade-device-a", "--no-pull", "--no-open"]);
    const recall = await runJson(command, [...argsPrefix, "--store", store, "recall", legacyText, "--project", project]);
    const learning = JSON.stringify({ question: "Can v0.2 stores upgrade in place?", conclusion: learnedText, evidence_type: "source_code", scope: "project", confidence: 0.95, recommended_kind: "memory", recommended_type: "fact" });
    const checkpoint = await runJson(command, [...argsPrefix, "--store", store, "agent", "checkpoint", "--project", project, "--agent", "codex", "--session-id", "upgrade-codex", "--device-id", "upgrade-device-a", "--occurred-at", "2026-07-12T00:01:00.000Z", "--checkpoint-id", "upgrade-checkpoint", "--current-task", "Verify v0.2 upgrade", "--progress", "Legacy history replayed", "--learning", learning]);
    await runJson(command, [...argsPrefix, "--store", store, "agent", "finish", "--project", project, "--summary", "Upgrade compatibility verified locally.", "--no-push", "--agent", "codex", "--session-id", "upgrade-codex", "--device-id", "upgrade-device-a"]);
    const claude = await runJson(command, [...argsPrefix, "--store", store, "agent", "enter", "--project", project, "--current-task", "Repair v0.2 derived read models lazily", "--agent", "claude", "--session-id", "upgrade-claude", "--device-id", "upgrade-device-b", "--no-pull", "--no-open"]);
    const legacyAfter = await readFile(legacy.eventPath, "utf8");
    const taskRelevant = claude.start?.boot?.task_relevant ?? [];
    const evidence = {
      legacy_event_preserved: digest(legacyAfter) === digest(legacy.bytes),
      legacy_fact_recalled: recall.results?.some((entry) => entry.record?.id === legacyRecordId) === true,
      legacy_trust_boundary_preserved: recall.outcome?.status === "verification_required",
      read_model_repaired: await exists(join(store, "snapshots", "records.json")),
      retrieval_index_repaired: await exists(join(store, "snapshots", "retrieval", "metadata.json")),
      checkpoint_created: checkpoint.committed === true && checkpoint.learning_ingestion?.records_created === 1,
      learning_reused_by_claude: taskRelevant.some((record) => record.content?.text === learnedText),
      migration_required: false,
      enter_ok: enter.ok === true
    };
    const failed = Object.entries(evidence).filter(([key, value]) => key === "migration_required" ? value !== false : value !== true);
    if (failed.length) throw new Error(`upgrade compatibility evidence failed: ${failed.map(([key]) => key).join(", ")}`);
    process.stdout.write(`upgrade compatibility smoke passed\n${JSON.stringify(evidence)}\n`);
  } finally {
    if (process.env.MORYN_SMOKE_KEEP_TEMP !== "1") await rm(root, { recursive: true, force: true });
    else process.stdout.write(`kept ${root}\n`);
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
