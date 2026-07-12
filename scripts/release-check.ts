import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type GateStepId = "build" | "typecheck" | "tests" | "dogfood_smoke" | "lifecycle_smoke" | "host_runtime_binding_smoke" | "transcript_compact_safety_smoke" | "official_host_handoff_smoke" | "upgrade_compat_smoke" | "sync_resilience_smoke" | "sync_conflict_smoke" | "permission_recovery_smoke" | "large_store_smoke" | "package" | "private_remote";
type GateStepMode = "required" | "skipped" | "optional_skipped";
export interface ReleaseGateStep { id: GateStepId; mode: GateStepMode }
export type V03AcceptanceArea = "autopilot" | "sync" | "working_set" | "consolidation" | "learning" | "hosts" | "dashboard" | "audit" | "reliability";
export interface V03AcceptanceEvidence {
  status: "passed" | "not_verified";
  required_evidence: GateStepId[];
  completed_evidence: GateStepId[];
  missing_evidence: GateStepId[];
}
export interface ReleaseGateResult {
  version: 1;
  status: "passed";
  completed: GateStepId[];
  skipped: GateStepId[];
  acceptance: Record<V03AcceptanceArea, V03AcceptanceEvidence>;
  acceptance_complete: boolean;
}
export interface ReleaseGateOptions {
  skip_slow_checks?: boolean;
  private_remote?: string;
  run_command?: (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;
  log?: (message: string) => void;
}

function output(message: string): void { process.stdout.write(`${message}\n`); }

async function defaultRun(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const { stdout } = await exec(command, args, { cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env });
  return stdout;
}

export function releaseGateSteps(skipSlowChecks: boolean, hasPrivateRemote: boolean): ReleaseGateStep[] {
  return [
    { id: "build", mode: skipSlowChecks ? "skipped" : "required" },
    { id: "typecheck", mode: skipSlowChecks ? "skipped" : "required" },
    { id: "tests", mode: skipSlowChecks ? "skipped" : "required" },
    { id: "dogfood_smoke", mode: "required" },
    { id: "lifecycle_smoke", mode: "required" },
    { id: "host_runtime_binding_smoke", mode: "required" },
    { id: "transcript_compact_safety_smoke", mode: "required" },
    { id: "official_host_handoff_smoke", mode: "required" },
    { id: "upgrade_compat_smoke", mode: "required" },
    { id: "sync_resilience_smoke", mode: "required" },
    { id: "sync_conflict_smoke", mode: "required" },
    { id: "permission_recovery_smoke", mode: "required" },
    { id: "large_store_smoke", mode: "required" },
    { id: "package", mode: "required" },
    { id: "private_remote", mode: hasPrivateRemote ? "required" : "optional_skipped" }
  ];
}

const V03_ACCEPTANCE_EVIDENCE: Record<V03AcceptanceArea, GateStepId[]> = {
  autopilot: ["build", "typecheck", "tests", "lifecycle_smoke", "transcript_compact_safety_smoke", "official_host_handoff_smoke"],
  sync: ["tests", "lifecycle_smoke", "official_host_handoff_smoke", "sync_resilience_smoke", "sync_conflict_smoke", "permission_recovery_smoke"],
  working_set: ["tests", "large_store_smoke"],
  consolidation: ["tests", "lifecycle_smoke", "large_store_smoke"],
  learning: ["tests", "lifecycle_smoke"],
  hosts: ["build", "tests", "lifecycle_smoke", "host_runtime_binding_smoke", "transcript_compact_safety_smoke", "official_host_handoff_smoke", "upgrade_compat_smoke", "package"],
  dashboard: ["tests", "large_store_smoke", "package"],
  audit: ["tests", "dogfood_smoke", "transcript_compact_safety_smoke", "package"],
  reliability: ["tests", "lifecycle_smoke", "host_runtime_binding_smoke", "transcript_compact_safety_smoke", "official_host_handoff_smoke", "sync_resilience_smoke", "sync_conflict_smoke", "permission_recovery_smoke", "large_store_smoke", "package"]
};

export function v03AcceptanceMatrix(completedSteps: readonly GateStepId[]): Record<V03AcceptanceArea, V03AcceptanceEvidence> {
  const completed = new Set(completedSteps);
  return Object.fromEntries(Object.entries(V03_ACCEPTANCE_EVIDENCE).map(([area, requiredEvidence]) => {
    const completedEvidence = requiredEvidence.filter((step) => completed.has(step));
    const missingEvidence = requiredEvidence.filter((step) => !completed.has(step));
    return [area, {
      status: missingEvidence.length === 0 ? "passed" : "not_verified",
      required_evidence: requiredEvidence,
      completed_evidence: completedEvidence,
      missing_evidence: missingEvidence
    }];
  })) as Record<V03AcceptanceArea, V03AcceptanceEvidence>;
}

export function assertSafePackageFiles(files: string[]): void {
  const unsafe = files.filter((file) => {
    const normalized = file.replace(/\\/g, "/").replace(/^package\//, "");
    return normalized === "config.json" || normalized === ".moryn.json" || normalized.startsWith(".moryn/") || normalized.startsWith(".gemini/") || normalized.startsWith("docs/superpowers/") || normalized === "docs/v0.2-phase-plan.md" || normalized.startsWith("events/") || normalized.startsWith("snapshots/") || normalized.startsWith("indexes/") || normalized.endsWith(".tgz");
  });
  if (unsafe.length) throw new Error(`Package contains private Moryn store data: ${unsafe.join(", ")}`);
}

export function assertPackageFilesComplete(files: string[]): void {
  const normalized = new Set(files.map((file) => file.replace(/\\/g, "/").replace(/^package\//, "")));
  const required = ["package.json", "LICENSE", "README.md", "CHANGELOG.md", "docs/agent-install-prompt.md", "docs/agent-workflow.md", "docs/contracts.md", "docs/development.md", "docs/implementation-roadmap.md", "docs/moryn-design.md", "dist/cli.js", "dist/index.js", "dist/mcp/server.js", "scripts/agent-lifecycle-smoke.js", "scripts/host-runtime-binding-smoke.js", "scripts/transcript-compact-safety-smoke.js", "scripts/official-host-handoff-smoke.js", "scripts/dogfood-demo-smoke.js", "scripts/upgrade-compat-smoke.js", "scripts/sync-resilience-smoke.js", "scripts/sync-conflict-smoke.js", "scripts/permission-recovery-smoke.js", "scripts/large-store-smoke.js"];
  const missing = required.filter((file) => !normalized.has(file));
  if (missing.length) throw new Error(`Package is missing required package files: ${missing.join(", ")}`);
}

async function validatePackage(run: NonNullable<ReleaseGateOptions["run_command"]>, log: NonNullable<ReleaseGateOptions["log"]>): Promise<void> {
  log("$ npm pack --dry-run --json");
  const parsed = JSON.parse(await run("npm", ["pack", "--dry-run", "--json"])) as Array<{ files?: Array<{ path: string }> }>;
  const files = parsed.flatMap((entry) => entry.files?.map((file) => file.path) ?? []);
  assertSafePackageFiles(files);
  assertPackageFilesComplete(files);
}

async function validatePrivateRemote(remote: string, run: NonNullable<ReleaseGateOptions["run_command"]>, log: NonNullable<ReleaseGateOptions["log"]>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "moryn-private-git-release-"));
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const moryn = join(process.cwd(), "dist", "cli.js");
  const call = async (args: string[]) => { log(`$ node ${args.join(" ")}`); return run("node", args); };
  try {
    await call([moryn, "--store", storeA, "init"]);
    await call([moryn, "--store", storeB, "init"]);
    await call([moryn, "--store", storeA, "sync", "init", remote]);
    await call([moryn, "--store", storeB, "sync", "init", remote]);
    await call([moryn, "--store", storeA, "write", "--kind", "memory", "--type", "decision", "--scope", "project", "--project-id", "moryn-release-check", "--state", "canonical", "--text", `Private Git remote release check ${new Date().toISOString()}`]);
    await call([moryn, "--store", storeA, "sync", "--push"]);
    await call([moryn, "--store", storeB, "sync", "--pull"]);
    if (!(await call([moryn, "--store", storeB, "recall", "Private Git remote release check", "--project-id", "moryn-release-check"])).includes("Private Git remote release check")) throw new Error("Private Git remote validation did not recall the pushed event");
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function runReleaseGate(options: ReleaseGateOptions = {}): Promise<ReleaseGateResult> {
  const run = options.run_command ?? defaultRun;
  const log = options.log ?? output;
  const privateRemote = options.private_remote?.trim();
  const steps = releaseGateSteps(options.skip_slow_checks === true, Boolean(privateRemote));
  const completed: GateStepId[] = [];
  const skipped: GateStepId[] = [];
  const commands: Partial<Record<GateStepId, [string, string[]]>> = {
    build: ["npm", ["run", "build"]], typecheck: ["npm", ["run", "typecheck"]], tests: ["npm", ["test"]], dogfood_smoke: ["npm", ["run", "smoke:dogfood-demo"]], lifecycle_smoke: ["npm", ["run", "smoke:agent-lifecycle"]], host_runtime_binding_smoke: ["npm", ["run", "smoke:host-runtime-binding"]], transcript_compact_safety_smoke: ["npm", ["run", "smoke:transcript-compact-safety"]], official_host_handoff_smoke: ["npm", ["run", "smoke:official-host-handoff"]], upgrade_compat_smoke: ["npm", ["run", "smoke:upgrade-compat"]], sync_resilience_smoke: ["npm", ["run", "smoke:sync-resilience"]], sync_conflict_smoke: ["npm", ["run", "smoke:sync-conflict"]], permission_recovery_smoke: ["npm", ["run", "smoke:permission-recovery"]], large_store_smoke: ["npm", ["run", "smoke:large-store"]]
  };
  for (const step of steps) {
    if (step.mode !== "required") { skipped.push(step.id); continue; }
    const command = commands[step.id];
    if (command) { log(`$ ${command[0]} ${command[1].join(" ")}`); await run(command[0], command[1]); }
    else if (step.id === "package") await validatePackage(run, log);
    else if (step.id === "private_remote" && privateRemote) await validatePrivateRemote(privateRemote, run, log);
    completed.push(step.id);
  }
  if (!privateRemote) log("private Git remote validation skipped: set MORYN_PRIVATE_GIT_REMOTE to run it");
  const acceptance = v03AcceptanceMatrix(completed);
  const acceptanceComplete = Object.values(acceptance).every((area) => area.status === "passed");
  const result: ReleaseGateResult = { version: 1, status: "passed", completed, skipped, acceptance, acceptance_complete: acceptanceComplete };
  log(JSON.stringify(result));
  return result;
}

export async function main(): Promise<void> {
  await runReleaseGate({ skip_slow_checks: process.env.MORYN_SKIP_SLOW_CHECKS === "1", private_remote: process.env.MORYN_PRIVATE_GIT_REMOTE });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
