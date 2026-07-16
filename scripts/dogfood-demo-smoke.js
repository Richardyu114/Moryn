#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");

function log(message) {
  process.stdout.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = {
    keepTemp: process.env.MORYN_SMOKE_KEEP_TEMP === "1",
    useSource: process.env.MORYN_SMOKE_USE_DIST === "1" ? false : true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--source") {
      options.useSource = true;
    } else if (arg === "--dist") {
      options.useSource = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: npm run smoke:dogfood-demo -- [--source|--dist] [--keep-temp]\n");
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

  return { command: "node", argsPrefix: [join(packageRoot, "dist", "cli.js")] };
}

function requireMatch(value, expected, message) {
  if (value !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${String(value)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "moryn-dogfood-demo-smoke-"));
  const store = join(root, "store");
  const project = join(root, "project");
  const sourceEngine = join(packageRoot, "src", "core", "engine.ts");
  let useSource = options.useSource ?? false;
  if (useSource) {
    try {
      await access(sourceEngine);
    } catch {
      useSource = false;
    }
  }
  const { command, argsPrefix } = await resolveMorynCommand(useSource);

  try {
    const setup = await runJson(command, [
      ...argsPrefix,
      "--store",
      store,
      "setup",
      "--host",
      "codex",
      "--project",
      project,
      "--apply"
    ]);
    requireMatch(setup.status, "ready", "setup status");
    log("setup applied");

    const firstPack = await runJson(command, [
      ...argsPrefix,
      "--store",
      store,
      "context",
      "pack",
      "--project",
      project,
      "--agent",
      "codex",
      "--session-id",
      "dogfood-start",
      "--current-task",
      "dogfood v0.2 handoff path",
      "--no-pull"
    ]);
    requireMatch(firstPack.handoff_pack?.quality_gate?.status, "ready", "context pack quality gate");
    if (firstPack.next?.required_end_action_id !== "capture_session") {
      throw new Error("context pack did not require capture_session next action");
    }
    log("context pack ready");

    const lowRisk = await runJson(command, [
      ...argsPrefix,
      "--store",
      store,
      "capture",
      "session",
      "--project",
      project,
      "--agent",
      "codex",
      "--session-id",
      "dogfood-low-risk",
      "--current-task",
      "dogfood v0.2 handoff path",
      "--summary",
      "Finished the dogfood walkthrough and left handoff notes."
    ]);
    requireMatch(lowRisk.policy_decision?.decision, "capture", "low-risk capture decision");
    requireMatch(lowRisk.policy_decision?.dashboard_surface, "handoff", "low-risk dashboard surface");
    requireMatch(lowRisk.policy_decision?.user_action_required, false, "low-risk user action");
    log("low-risk handoff auto-captured");

    const review = await runJson(command, [
      ...argsPrefix,
      "--store",
      store,
      "capture",
      "session",
      "--project",
      project,
      "--agent",
      "codex",
      "--session-id",
      "dogfood-review",
      "--current-task",
      "decide release risk and approval path",
      "--summary",
      "Decision: require approval before promoting this durable release note."
    ]);
    requireMatch(review.policy_decision?.decision, "review", "review capture decision");
    requireMatch(review.policy_decision?.dashboard_surface, "capture_inbox", "review dashboard surface");
    requireMatch(review.policy_decision?.user_action_required, true, "review user action");
    log("review handoff routed to Capture Inbox");

    const coreExtension = useSource ? "ts" : "js";
    const coreRoot = useSource ? "src" : "dist";
    const duplicateScript = `
      import { createEngine } from ${JSON.stringify(pathToFileURL(join(packageRoot, coreRoot, "core", `engine.${coreExtension}`)).href)};
      import { buildWorkingSetReport } from ${JSON.stringify(pathToFileURL(join(packageRoot, coreRoot, "core", `working-set-report.${coreExtension}`)).href)};
      let duplicateId = 0;
      const engine = createEngine({ storePath: ${JSON.stringify(store)}, id: (prefix) => prefix + "_dogfood_" + (++duplicateId) });
      const base = { kind: "memory", type: "decision", scope: "project", project_id: "moryn", source: { client: "dogfood-smoke" } };
      const canonical = await engine.write({ ...base, content: { text: "Use autonomous sync for healthy lifecycle paths." }, state: "canonical", confirmed: true });
      const paraphrases = [
        "Healthy lifecycle paths use autonomous synchronization.",
        "Autonomous sync supports healthy lifecycle flows.",
        "For healthy lifecycle operation, use autonomous synchronization.",
        "Use automatic synchronization across healthy lifecycle paths.",
        "Healthy agent lifecycle flows rely on autonomous sync."
      ];
      for (let index = 0; index < 100; index += 1) {
        const duplicate = await engine.write({ ...base, content: { text: paraphrases[index % paraphrases.length] } });
        const receipt = await engine.consolidateSemanticProposals({ proposals: [{ proposal_id: "dogfood-semantic-" + index, source_record_id: duplicate.record.id, target_record_id: canonical.record.id, relationship: "duplicate_of", confidence: 0.99, rationale: "Agent-authored paraphrase equivalence.", semantic_equivalence: "equivalent", material_differences: [], evidence_record_ids: [] }], project_id: "moryn", source: { client: "dogfood-smoke", session_id: "semantic-capacity" } });
        if (receipt.proposals_accepted !== 1) throw new Error("semantic proposal was not accepted at index " + index + ": " + JSON.stringify(receipt));
      }
      process.stdout.write(JSON.stringify(await buildWorkingSetReport(${JSON.stringify(store)}, { project_id: "moryn" })));
    `;
    const duplicateArgs = useSource
      ? ["--import", "tsx", "--input-type=module", "--eval", duplicateScript]
      : ["--input-type=module", "--eval", duplicateScript];
    const workingSet = JSON.parse(await run("node", duplicateArgs, { cwd: packageRoot }));
    requireMatch(workingSet.hidden_duplicate_records, 100, "hidden duplicate records");
    if (workingSet.active_logical_records > 4 || workingSet.default_boot_records > 5) {
      throw new Error(`logical working set was not bounded: active=${workingSet.active_logical_records}, boot=${workingSet.default_boot_records}`);
    }
    requireMatch(workingSet.semantic_equivalent_links, 100, "semantic equivalent links");
    log("100 paraphrased semantic proposals consolidated to a bounded working set");

    const dashboard = await runJson(command, [
      ...argsPrefix,
      "--store",
      store,
      "dashboard",
      "--project",
      project,
      "--no-open",
      "--limit",
      "10"
    ]);
    if (dashboard.generated !== true || !dashboard.path) {
      throw new Error("dashboard snapshot was not generated");
    }

    const dashboardHtml = await readFile(dashboard.path, "utf8");
    if (!dashboardHtml.includes("Capture Inbox") || !dashboardHtml.includes("Review Queue") || !dashboardHtml.includes("Decision: require approval")) {
      throw new Error("dashboard snapshot did not expose the review path");
    }
    if (!dashboardHtml.includes("Read-only details")) {
      throw new Error("dashboard snapshot did not keep evidence in the read-only layer");
    }
    if (!dashboardHtml.includes('data-quiet-flow-summary')
      || !dashboardHtml.includes('data-dashboard-detail="quiet-flow-details"')
      || !dashboardHtml.includes("events")
      || !dashboardHtml.includes("Reduced")) {
      throw new Error("dashboard snapshot did not expose logical working-set capacity telemetry");
    }
    log("dashboard snapshot generated");

    const finalPack = await runJson(command, [
      ...argsPrefix,
      "--store",
      store,
      "context",
      "pack",
      "--project",
      project,
      "--agent",
      "codex",
      "--session-id",
      "dogfood-resume",
      "--current-task",
      "resume after dogfood demo",
      "--no-pull"
    ]);
    if (!JSON.stringify(finalPack).includes("Finished the dogfood walkthrough")) {
      throw new Error("final context pack did not retain the low-risk handoff");
    }

    if (Object.keys(finalPack.boot?.records_by_id ?? finalPack.records_by_id ?? {}).length > 5) {
      throw new Error("final context pack exceeded the bounded default boot record limit");
    }

    log("setup applied -> context pack ready -> low-risk handoff auto-captured -> review handoff routed to Capture Inbox -> dashboard snapshot generated");
    log("dogfood demo smoke passed");
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
