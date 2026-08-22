import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { version as sourceVersion } from "../src/version.js";

const exec = promisify(execFile);
const REQUIRED_SMOKES = [
  "learning_inbox_smoke",
  "finalization_assurance_smoke",
  "official_host_handoff_smoke"
] as const;
const TARGET_RELEASE = "0.5.0" as const;

type Check = { status: "passed" } | { status: "failed"; reason: string; missing?: string[]; offending?: string[] };
type PackageJsonInput = { name?: unknown; version?: unknown; files?: unknown };

export interface ReleaseReadinessInput {
  package_json: PackageJsonInput;
  source_version: string;
  readme: string;
  changelog: string;
  release_check_source: string;
  packed_files: string[];
}

export interface ReleaseReadinessResult {
  version: 1;
  status: "passed" | "failed";
  package_version: string;
  target_release: typeof TARGET_RELEASE;
  release_candidate: boolean;
  checks: {
    target_version_matches: Check;
    source_version_matches: Check;
    documented_source_version_matches: Check;
    changelog_release_notes_present: Check;
    focused_acceptance_present: Check;
    required_smokes_present: Check;
    private_paths_absent: Check;
  };
}

function passed(): Check {
  return { status: "passed" };
}
function failed(reason: string, details: { missing?: string[]; offending?: string[] } = {}): Check {
  return { status: "failed", reason, ...details };
}

export function evaluateReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadinessResult {
  const packageVersion = typeof input.package_json.version === "string" ? input.package_json.version : "unknown";
  const targetVersionMatches =
    packageVersion === TARGET_RELEASE
      ? passed()
      : failed(`package.json version must match the v${TARGET_RELEASE} release candidate`);
  const sourceVersionMatches =
    input.source_version === packageVersion ? passed() : failed("src/version.ts must match package.json version");
  const documentedSourceVersionMatches = input.readme.includes(`Current source/package version: v${packageVersion}`)
    ? passed()
    : failed("README source/package version statement does not match package.json");
  const changelogReleaseNotes = /^##\s+0\.5\.0(?:\s|$)/m.test(input.changelog)
    ? passed()
    : failed("CHANGELOG does not contain the v0.5.0 release notes");
  const focusedAcceptance =
    input.release_check_source.includes("v05_acceptance") && input.release_check_source.includes("test:v05-acceptance")
      ? passed()
      : failed("Release gate does not require the focused v0.5 acceptance suite");
  const packageFiles = Array.isArray(input.package_json.files)
    ? input.package_json.files.filter((value): value is string => typeof value === "string")
    : [];
  const missingSmokes = REQUIRED_SMOKES.filter((smoke) => {
    const fileName = `scripts/${smoke.replace(/_/g, "-")}.js`;
    return (
      !input.release_check_source.includes(smoke) ||
      !packageFiles.includes(fileName) ||
      !input.packed_files.includes(fileName)
    );
  });
  const requiredSmokes = missingSmokes.length
    ? failed("Required release smoke evidence is missing", { missing: missingSmokes })
    : passed();
  const offending = input.packed_files.filter((file) => {
    const normalized = file.replace(/^package\//, "");
    return (
      normalized === "config.json" ||
      normalized === ".moryn.json" ||
      normalized.startsWith(".moryn/") ||
      normalized.startsWith(".gemini/") ||
      normalized.startsWith(".codex/") ||
      normalized.startsWith(".superpowers/") ||
      normalized.startsWith(".worktrees/") ||
      normalized.startsWith("docs/releases/") ||
      normalized.startsWith("docs/superpowers/") ||
      normalized.startsWith("events/") ||
      normalized.startsWith("snapshots/") ||
      normalized.startsWith("indexes/") ||
      normalized.startsWith("state/") ||
      normalized.startsWith("temp/") ||
      normalized.startsWith("tmp/") ||
      normalized.endsWith(".tgz")
    );
  });
  const privatePathsAbsent = offending.length
    ? failed("Private release planning paths are present in package contents", { offending })
    : passed();
  const checks = {
    target_version_matches: targetVersionMatches,
    source_version_matches: sourceVersionMatches,
    documented_source_version_matches: documentedSourceVersionMatches,
    changelog_release_notes_present: changelogReleaseNotes,
    focused_acceptance_present: focusedAcceptance,
    required_smokes_present: requiredSmokes,
    private_paths_absent: privatePathsAbsent
  };
  const status = Object.values(checks).every((check) => check.status === "passed") ? "passed" : "failed";
  return {
    version: 1,
    status,
    package_version: packageVersion,
    target_release: TARGET_RELEASE,
    release_candidate: status === "passed",
    checks
  };
}

export async function main(): Promise<void> {
  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as PackageJsonInput;
  const [readme, changelog, releaseCheckSource, packed] = await Promise.all([
    readFile(resolve(root, "README.md"), "utf8"),
    readFile(resolve(root, "CHANGELOG.md"), "utf8"),
    readFile(resolve(root, "scripts/release-check.ts"), "utf8"),
    exec("npm", ["pack", "--dry-run", "--json"], { cwd: root })
  ]);
  const packedFiles = (JSON.parse(packed.stdout) as Array<{ files?: Array<{ path: string }> }>).flatMap(
    (entry) => entry.files?.map((file) => file.path) ?? []
  );
  const result = evaluateReleaseReadiness({
    package_json: packageJson,
    source_version: sourceVersion,
    readme,
    changelog,
    release_check_source: releaseCheckSource,
    packed_files: packedFiles
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
