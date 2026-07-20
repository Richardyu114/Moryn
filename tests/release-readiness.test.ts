import { describe, expect, it } from "vitest";
import { evaluateReleaseReadiness } from "../scripts/release-readiness.js";

const packageJson = {
  name: "@richardyu114/moryn",
  version: "0.4.0",
  files: [
    "dist",
    "README.md",
    "CHANGELOG.md",
    "scripts/learning-inbox-smoke.js",
    "scripts/finalization-assurance-smoke.js",
    "scripts/official-host-handoff-smoke.js"
  ]
};
const readme = "> Current source/package version: v0.4.0. Distilled Memory and Portable Soul extend Context Autopilot.";
const changelog = "# Changelog\n\n## 0.4.0 - 2026-07-20\n\n- Distilled Memory and Portable Soul\n\n## 0.3.0\n";
const releaseCheck = "learning_inbox_smoke finalization_assurance_smoke official_host_handoff_smoke";
const packedFiles = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "scripts/learning-inbox-smoke.js",
  "scripts/finalization-assurance-smoke.js",
  "scripts/official-host-handoff-smoke.js"
];

describe("v0.4 release readiness", () => {
  it("passes a complete v0.4.0 release candidate", () => {
    const result = evaluateReleaseReadiness({
      package_json: packageJson,
      readme,
      changelog,
      release_check_source: releaseCheck,
      packed_files: packedFiles
    });

    expect(result).toMatchObject({
      version: 1,
      status: "passed",
      package_version: "0.4.0",
      target_release: "0.4.0",
      release_candidate: true,
      checks: {
        target_version_matches: { status: "passed" },
        documented_source_version_matches: { status: "passed" },
        changelog_release_notes_present: { status: "passed" },
        required_smokes_present: { status: "passed" },
        private_paths_absent: { status: "passed" }
      }
    });
  });

  it("fails version, docs, smoke, and package privacy drift independently", () => {
    const result = evaluateReleaseReadiness({
      package_json: { ...packageJson, version: "0.4.1" },
      readme,
      changelog: "# Changelog\n\n## 0.2.0\n",
      release_check_source: "official_host_handoff_smoke",
      packed_files: [...packedFiles, "docs/releases/v0.4-roadmap.md", ".codex/session.json"]
    });

    expect(result.status).toBe("failed");
    expect(result.release_candidate).toBe(false);
    expect(result.checks).toMatchObject({
      target_version_matches: { status: "failed" },
      documented_source_version_matches: { status: "failed" },
      changelog_release_notes_present: { status: "failed" },
      required_smokes_present: {
        status: "failed",
        missing: expect.arrayContaining(["learning_inbox_smoke", "finalization_assurance_smoke"])
      },
      private_paths_absent: {
        status: "failed",
        offending: ["docs/releases/v0.4-roadmap.md", ".codex/session.json"]
      }
    });
  });
});
