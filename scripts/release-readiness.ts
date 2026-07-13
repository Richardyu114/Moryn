import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const REQUIRED_SMOKES = ["learning_inbox_smoke", "finalization_assurance_smoke", "official_host_handoff_smoke"] as const;

type Check = { status: "passed" } | { status: "failed"; reason: string; missing?: string[]; offending?: string[] };
type PackageJsonInput = { name?: unknown; version?: unknown; files?: unknown };

export interface ReleaseReadinessInput {
  package_json: PackageJsonInput;
  readme: string;
  changelog: string;
  release_check_source: string;
  packed_files: string[];
}

export interface ReleaseReadinessResult {
  version: 1;
  status: "passed" | "failed";
  package_version: string;
  target_release: "0.3.0";
  release_authorized: false;
  checks: {
    published_version_matches: Check;
    changelog_current_version_present: Check;
    unreleased_v03_present: Check;
    required_smokes_present: Check;
    private_paths_absent: Check;
  };
  manual_actions: Record<"version_bump" | "tag" | "push" | "publish", { status: "not_authorized"; requires: "explicit_user_approval" }>;
}

function passed(): Check { return { status: "passed" }; }
function failed(reason: string, details: { missing?: string[]; offending?: string[] } = {}): Check { return { status: "failed", reason, ...details }; }

export function evaluateReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadinessResult {
  const packageVersion = typeof input.package_json.version === "string" ? input.package_json.version : "unknown";
  const publishedVersionMatches = input.readme.includes(`Published package: v${packageVersion}`)
    ? passed()
    : failed("README published-version statement does not match package.json");
  const changelogCurrentVersion = input.changelog.includes(`## ${packageVersion}`)
    ? passed()
    : failed("CHANGELOG does not contain the current package version");
  const unreleasedV03 = /##\s+Unreleased\s*\(v0\.3 development\)/i.test(input.changelog)
    ? passed()
    : failed("CHANGELOG does not contain an unreleased v0.3 development section");
  const packageFiles = Array.isArray(input.package_json.files) ? input.package_json.files.filter((value): value is string => typeof value === "string") : [];
  const missingSmokes = REQUIRED_SMOKES.filter((smoke) => {
    const fileName = `scripts/${smoke.replace(/_/g, "-")}.js`;
    return !input.release_check_source.includes(smoke) || !packageFiles.includes(fileName) || !input.packed_files.includes(fileName);
  });
  const requiredSmokes = missingSmokes.length ? failed("Required v0.3 smoke evidence is missing", { missing: missingSmokes }) : passed();
  const offending = input.packed_files.filter((file) => file.replace(/^package\//, "").startsWith("docs/releases/"));
  const privatePathsAbsent = offending.length ? failed("Private release planning paths are present in package contents", { offending }) : passed();
  const checks = {
    published_version_matches: publishedVersionMatches,
    changelog_current_version_present: changelogCurrentVersion,
    unreleased_v03_present: unreleasedV03,
    required_smokes_present: requiredSmokes,
    private_paths_absent: privatePathsAbsent
  };
  return {
    version: 1,
    status: Object.values(checks).every((check) => check.status === "passed") ? "passed" : "failed",
    package_version: packageVersion,
    target_release: "0.3.0",
    release_authorized: false,
    checks,
    manual_actions: {
      version_bump: { status: "not_authorized", requires: "explicit_user_approval" },
      tag: { status: "not_authorized", requires: "explicit_user_approval" },
      push: { status: "not_authorized", requires: "explicit_user_approval" },
      publish: { status: "not_authorized", requires: "explicit_user_approval" }
    }
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
  const packedFiles = (JSON.parse(packed.stdout) as Array<{ files?: Array<{ path: string }> }>).flatMap((entry) => entry.files?.map((file) => file.path) ?? []);
  const result = evaluateReleaseReadiness({ package_json: packageJson, readme, changelog, release_check_source: releaseCheckSource, packed_files: packedFiles });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
