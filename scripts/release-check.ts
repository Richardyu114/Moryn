import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const pretty = [command, ...args].join(" ");
  log(`$ ${pretty}`);
  const { stdout } = await exec(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env
  });
  return stdout;
}

export function assertSafePackageFiles(files: string[]): void {
  const unsafe = files.filter((file) => {
    const normalized = file.replace(/\\/g, "/").replace(/^package\//, "");
    return normalized === "config.json"
      || normalized.startsWith(".moryn/")
      || normalized.startsWith("events/")
      || normalized.startsWith("snapshots/")
      || normalized.startsWith("indexes/")
      || normalized.endsWith(".tgz");
  });

  if (unsafe.length) {
    throw new Error(`Package contains private Moryn store data: ${unsafe.join(", ")}`);
  }
}

export function assertPackageFilesComplete(files: string[]): void {
  const normalized = new Set(files.map((file) => file.replace(/\\/g, "/").replace(/^package\//, "")));
  const required = [
    "package.json",
    "LICENSE",
    "README.md",
    "dist/cli.js",
    "dist/index.js",
    "dist/mcp/server.js"
  ];
  const missing = required.filter((file) => !normalized.has(file));

  if (missing.length) {
    throw new Error(`Package is missing required package files: ${missing.join(", ")}`);
  }
}

async function assertPackageContentsAreSafe(): Promise<void> {
  const output = await run("npm", ["pack", "--dry-run", "--json"]);
  const parsed = JSON.parse(output) as Array<{ files?: Array<{ path: string }> }>;
  const files = parsed.flatMap((entry) => entry.files?.map((file) => file.path) ?? []);
  assertSafePackageFiles(files);
  assertPackageFilesComplete(files);
}

async function runPrivateGitRemoteValidation(remote: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "moryn-private-git-release-"));
  const storeA = join(root, "store-a");
  const storeB = join(root, "store-b");
  const moryn = join(process.cwd(), "dist", "cli.js");

  try {
    await run("node", [moryn, "--store", storeA, "init"]);
    await run("node", [moryn, "--store", storeB, "init"]);
    await run("node", [moryn, "--store", storeA, "sync", "init", remote]);
    await run("node", [moryn, "--store", storeB, "sync", "init", remote]);
    await run("node", [
      moryn,
      "--store",
      storeA,
      "write",
      "--kind",
      "memory",
      "--type",
      "decision",
      "--scope",
      "project",
      "--project-id",
      "moryn-release-check",
      "--state",
      "canonical",
      "--text",
      `Private Git remote release check ${new Date().toISOString()}`
    ]);
    await run("node", [moryn, "--store", storeA, "sync", "--push"]);
    await run("node", [moryn, "--store", storeB, "sync", "--pull"]);
    const recall = await run("node", [
      moryn,
      "--store",
      storeB,
      "recall",
      "Private Git remote release check",
      "--project-id",
      "moryn-release-check"
    ]);
    if (!recall.includes("Private Git remote release check")) {
      throw new Error("Private Git remote validation did not recall the pushed event");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function main(): Promise<void> {
  const skipSlowChecks = process.env.MORYN_SKIP_SLOW_CHECKS === "1";
  if (!skipSlowChecks) {
    await run("npm", ["run", "build"]);
    await run("npm", ["run", "typecheck"]);
    await run("npm", ["test"]);
  }
  await assertPackageContentsAreSafe();

  const privateRemote = process.env.MORYN_PRIVATE_GIT_REMOTE?.trim();
  if (privateRemote) {
    await runPrivateGitRemoteValidation(privateRemote);
    log("private Git remote validation passed");
  } else {
    log("private Git remote validation skipped: set MORYN_PRIVATE_GIT_REMOTE to run it");
  }

  log("release check passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
