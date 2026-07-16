#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

function parseArgs(argv) {
  const options = {
    keepTemp: process.env.MORYN_SMOKE_KEEP_TEMP === "1",
    useSource: process.env.MORYN_SMOKE_USE_DIST === "1" ? false : true
  };
  for (const arg of argv) {
    if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--source") options.useSource = true;
    else if (arg === "--dist") options.useSource = false;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run smoke:large-store -- [--source|--dist] [--keep-temp]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const root = await mkdtemp(join(tmpdir(), "moryn-large-store-smoke-"));
const store = join(root, "store");
const extension = options.useSource ? "ts" : "js";
const sourceRoot = options.useSource ? "src" : "dist";
const moduleUrl = (path) => pathToFileURL(join(packageRoot, sourceRoot, "core", `${path}.${extension}`)).href;
const observabilityModuleUrl = (path) => pathToFileURL(join(packageRoot, sourceRoot, "observability", `${path}.${extension}`)).href;
const smokeScript = `
  import { rm } from "node:fs/promises";
  import { execFile } from "node:child_process";
  import { createHash } from "node:crypto";
  import { join } from "node:path";
  import { performance } from "node:perf_hooks";
  import { promisify } from "node:util";
  import { initializeStore } from ${JSON.stringify(moduleUrl("config"))};
  import { rebuildDerivedViews } from ${JSON.stringify(moduleUrl("derived"))};
  import { createEngine } from ${JSON.stringify(moduleUrl("engine"))};
  import { appendEventIfAbsent, readEventFileManifest, readEvents } from ${JSON.stringify(moduleUrl("store"))};
  import { buildDashboardData, renderDashboardHtml } from ${JSON.stringify(observabilityModuleUrl("dashboard"))};
  import { initializeGitSync, pullGitSync, pushGitSync } from ${JSON.stringify(pathToFileURL(join(packageRoot, sourceRoot, "sync", `git.${extension}`)).href)};

  const exec = promisify(execFile);

  const store = ${JSON.stringify(store)};
  const projectCount = 20;
  const recordsPerProject = 100;
  const recordCount = projectCount * recordsPerProject;
  const targetProject = "project-00";
  const targetRecordId = "memory-target";
  const source = { client: "large-store-smoke", device_id: "device_large_store" };
  await initializeStore(store, { now: () => "2026-07-12T00:00:00.000Z", id: () => source.device_id });

  const writes = [];
  for (let projectIndex = 0; projectIndex < projectCount; projectIndex += 1) {
    const projectId = "project-" + String(projectIndex).padStart(2, "0");
    for (let recordIndex = 0; recordIndex < recordsPerProject; recordIndex += 1) {
      const isTarget = projectId === targetProject && recordIndex === 0;
      const id = isTarget ? targetRecordId : "memory-" + projectId + "-" + String(recordIndex).padStart(3, "0");
      const timestamp = new Date(Date.UTC(2026, 0, 1, projectIndex, recordIndex)).toISOString();
      const text = isTarget
        ? "Moryn large-store verification uses a bounded retrieval shard named cobalt-orchid."
        : "Deterministic distractor " + projectId + " record " + recordIndex + " for append-only scale verification.";
      writes.push(appendEventIfAbsent(store, {
        event_id: "evt-" + id,
        op: "upsert_record",
        record: {
          id,
          kind: "memory",
          type: isTarget ? "decision" : "note",
          scope: "project",
          project_id: projectId,
          tags: isTarget ? ["large-store", "cobalt-orchid"] : ["large-store", projectId],
          content: { text },
          state: "canonical",
          confidence: 1,
          priority: isTarget ? "high" : "normal",
          visibility: "active",
          created_at: timestamp,
          updated_at: timestamp,
          source
        },
        created_at: timestamp,
        source
      }));
      if (writes.length === 50) {
        await Promise.all(writes.splice(0));
      }
    }
  }
  if (writes.length) await Promise.all(writes);
  await rebuildDerivedViews(store);
  await rm(join(store, "snapshots", "retrieval"), { recursive: true, force: true });

  const engine = createEngine({ storePath: store, now: () => "2026-07-12T12:00:00.000Z" });
  const recallStarted = performance.now();
  const recall = await engine.recall({ project_id: targetProject, query: "cobalt-orchid bounded retrieval shard", limit: 5 });
  const recallMs = performance.now() - recallStarted;
  const bootStarted = performance.now();
  const boot = await engine.boot({ project_id: targetProject, current_task: "verify cobalt-orchid bounded retrieval shard" });
  const bootMs = performance.now() - bootStarted;

  if (recall.retrieval?.source !== "record_read_model" || recall.retrieval?.repaired !== true) {
    throw new Error("recall did not repair the intentionally missing retrieval index: " + JSON.stringify(recall.retrieval));
  }
  if (recall.retrieval.total_active_records !== recordCount || recall.retrieval.candidate_count !== recordsPerProject) {
    throw new Error("recall working set was not project-bounded: " + JSON.stringify(recall.retrieval));
  }
  if (recall.results[0]?.record.id !== targetRecordId) {
    throw new Error("recall did not find the trusted target: " + JSON.stringify(recall.results));
  }
  if (boot.retrieval?.source !== "retrieval_index" || boot.retrieval?.candidate_count !== recordsPerProject) {
    throw new Error("boot did not reuse the repaired project shard: " + JSON.stringify(boot.retrieval));
  }
  if (boot.task_relevant.length > 5 || boot.project.important_decisions.length > 5 || boot.recent_changes.length > 5) {
    throw new Error("boot injection exceeded bounded section limits");
  }
  const bootText = JSON.stringify(boot);
  if (!bootText.includes(targetRecordId) || bootText.includes("memory-project-19-099")) {
    throw new Error("boot context missed the target or leaked an unrelated project");
  }
  const eventsBefore = (await readEventFileManifest(store)).count;
  const dashboardStarted = performance.now();
  const dashboard = await buildDashboardData(store, { project_id: targetProject, limit: 10, now: "2026-07-12T12:00:00.000Z" });
  const dashboardHtml = renderDashboardHtml(dashboard);
  const dashboardMs = performance.now() - dashboardStarted;
  const eventsAfter = (await readEventFileManifest(store)).count;
  const dashboardCandidates = dashboard.health_check.retrieval_index?.candidate_count;
  const dashboardBytes = Buffer.byteLength(dashboardHtml, "utf8");
  if (eventsBefore !== recordCount || eventsAfter !== eventsBefore) {
    throw new Error("dashboard mutated append-only events: before=" + eventsBefore + " after=" + eventsAfter);
  }
  if (dashboardCandidates !== recordsPerProject) {
    throw new Error("dashboard retrieval was not project-bounded: " + JSON.stringify(dashboard.health_check.retrieval_index));
  }
  if (dashboard.quiet_dashboard.attention_needed.length !== 0) {
    throw new Error("healthy large-store dashboard created exceptional attention: " + JSON.stringify(dashboard.quiet_dashboard.attention_needed));
  }
  for (const marker of ["System Pulse", "Current Context", "Memory Flow", "data-dashboard-editorial-shell"]) {
    if (!dashboardHtml.includes(marker)) throw new Error("dashboard omitted monitoring marker: " + marker);
  }
  const budgetMs = 5000;
  // The dashboard embeds ~1.95MB of base64 serif fonts (latin + CJK subset) so
  // it renders identically offline / as a static file. That fixed overhead puts
  // an empty dashboard around ~2.2MB; the memory search list is capped at 600
  // rendered entries (see renderMemorySearch) so it no longer grows unbounded
  // with store size. Budget reflects that fixed cost plus the capped list.
  const dashboardByteBudget = 5000000;
  if (recallMs > budgetMs || bootMs > budgetMs || dashboardMs > budgetMs) {
    throw new Error("large-store hot path exceeded budget: recall=" + recallMs.toFixed(1) + "ms boot=" + bootMs.toFixed(1) + "ms dashboard=" + dashboardMs.toFixed(1) + "ms");
  }
  if (dashboardBytes > dashboardByteBudget) {
    throw new Error("large-store dashboard exceeded byte budget: " + dashboardBytes);
  }
  const remote = join(${JSON.stringify(root)}, "remote.git");
  const secondStore = join(${JSON.stringify(root)}, "second-store");
  await exec("git", ["init", "--bare", remote]);
  const firstManifest = await readEventFileManifest(store);
  const firstEventDigest = createHash("sha256").update(JSON.stringify(await readEvents(store))).digest("hex");
  await initializeGitSync(store, remote);
  const pushStarted = performance.now();
  const push = await pushGitSync(store, { message: "Large-store release smoke" });
  const pushMs = performance.now() - pushStarted;
  await initializeStore(secondStore, { now: () => "2026-07-12T00:00:00.000Z", id: () => "device_large_store_second" });
  await initializeGitSync(secondStore, remote);
  const pullStarted = performance.now();
  const pull = await pullGitSync(secondStore);
  const pullMs = performance.now() - pullStarted;
  const secondManifest = await readEventFileManifest(secondStore);
  const secondEventDigest = createHash("sha256").update(JSON.stringify(await readEvents(secondStore))).digest("hex");
  const secondEngine = createEngine({ storePath: secondStore, now: () => "2026-07-12T12:00:00.000Z" });
  const secondRecall = await secondEngine.recall({ project_id: targetProject, query: "cobalt-orchid bounded retrieval shard", limit: 5 });
  const secondBoot = await secondEngine.boot({ project_id: targetProject, current_task: "verify cobalt-orchid bounded retrieval shard" });
  const secondBootText = JSON.stringify(secondBoot);
  const eventContentMatch = firstManifest.count === secondManifest.count && firstEventDigest === secondEventDigest;
  const secondTargetRecalled = secondRecall.results[0]?.record.id === targetRecordId;
  const secondTargetBooted = secondBootText.includes(targetRecordId) && !secondBootText.includes("memory-project-19-099");
  if (push.pushed !== true || pull.pulled !== true) throw new Error("large-store Git sync did not push and pull successfully");
  if (!eventContentMatch || secondManifest.count !== recordCount) throw new Error("second-device event history did not match the first device");
  if (secondRecall.retrieval?.candidate_count !== recordsPerProject || !secondTargetRecalled) throw new Error("second-device recall was not bounded or missed the target");
  if (secondBoot.retrieval?.candidate_count !== recordsPerProject || !secondTargetBooted) throw new Error("second-device boot was not bounded or leaked unrelated context");
  const syncBudgetMs = 15000;
  if (pushMs > syncBudgetMs || pullMs > syncBudgetMs) throw new Error("large-store sync exceeded budget: push=" + pushMs.toFixed(1) + "ms pull=" + pullMs.toFixed(1) + "ms");

  process.stdout.write(JSON.stringify({
    version: 1,
    status: "passed",
    fixture: { records: recordCount, projects: projectCount, target_project_records: recordsPerProject },
    recall: { milliseconds: Math.round(recallMs), candidate_count: recall.retrieval.candidate_count, repaired: recall.retrieval.repaired },
    boot: { milliseconds: Math.round(bootMs), candidate_count: boot.retrieval.candidate_count, task_relevant: boot.task_relevant.length, recent_changes: boot.recent_changes.length },
    dashboard: { milliseconds: Math.round(dashboardMs), candidate_count: dashboardCandidates, events_before: eventsBefore, events_after: eventsAfter, html_bytes: dashboardBytes, attention_items: dashboard.quiet_dashboard.attention_needed.length },
    sync: { push_milliseconds: Math.round(pushMs), pull_milliseconds: Math.round(pullMs), first_device_events: firstManifest.count, second_device_events: secondManifest.count, event_content_match: eventContentMatch, second_device_candidate_count: secondRecall.retrieval.candidate_count, second_device_target_recalled: secondTargetRecalled, second_device_target_booted: secondTargetBooted },
    budget_ms: budgetMs,
    dashboard_byte_budget: dashboardByteBudget,
    sync_budget_ms: syncBudgetMs
  }) + "\\n");
`;

try {
  const args = options.useSource
    ? ["--import", "tsx", "--input-type=module", "--eval", smokeScript]
    : ["--input-type=module", "--eval", smokeScript];
  const { stdout } = await exec("node", args, { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 });
  process.stdout.write(stdout);
  if (options.keepTemp) process.stdout.write(`store retained at ${store}\n`);
} finally {
  if (!options.keepTemp) await rm(root, { recursive: true, force: true });
}
