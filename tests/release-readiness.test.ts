import { describe, expect, it } from "vitest";
import { evaluateReleaseReadiness } from "../scripts/release-readiness.js";

const packageJson = {
  name: "@richardyu114/moryn",
  version: "0.2.0",
  files: ["dist", "README.md", "CHANGELOG.md", "scripts/learning-inbox-smoke.js", "scripts/finalization-assurance-smoke.js", "scripts/official-host-handoff-smoke.js"]
};
const readme = "> Published package: v0.2.0. The current development branch is building v0.3.";
const changelog = "# Changelog\n\n## Unreleased (v0.3 development)\n\n- Autopilot\n\n## 0.2.0\n";
const releaseCheck = 'learning_inbox_smoke finalization_assurance_smoke official_host_handoff_smoke';
const packedFiles = ["package.json", "README.md", "CHANGELOG.md", "scripts/learning-inbox-smoke.js", "scripts/finalization-assurance-smoke.js", "scripts/official-host-handoff-smoke.js"];

describe("v0.3 release readiness", () => {
  it("passes preparation while keeping every release mutation unauthorized", () => {
    const result = evaluateReleaseReadiness({ package_json: packageJson, readme, changelog, release_check_source: releaseCheck, packed_files: packedFiles });

    expect(result).toMatchObject({
      version: 1,
      status: "passed",
      package_version: "0.2.0",
      target_release: "0.3.0",
      release_authorized: false,
      checks: {
        published_version_matches: { status: "passed" },
        changelog_current_version_present: { status: "passed" },
        unreleased_v03_present: { status: "passed" },
        required_smokes_present: { status: "passed" },
        private_paths_absent: { status: "passed" }
      },
      manual_actions: {
        version_bump: { status: "not_authorized" },
        tag: { status: "not_authorized" },
        push: { status: "not_authorized" },
        publish: { status: "not_authorized" }
      }
    });
  });

  it("fails version, docs, smoke, and package privacy drift independently", () => {
    const result = evaluateReleaseReadiness({
      package_json: { ...packageJson, version: "0.2.1" },
      readme,
      changelog: "# Changelog\n\n## 0.2.0\n",
      release_check_source: "official_host_handoff_smoke",
      packed_files: [...packedFiles, "docs/releases/v0.3-roadmap.md"]
    });

    expect(result.status).toBe("failed");
    expect(result.checks).toMatchObject({
      published_version_matches: { status: "failed" },
      changelog_current_version_present: { status: "failed" },
      unreleased_v03_present: { status: "failed" },
      required_smokes_present: { status: "failed", missing: expect.arrayContaining(["learning_inbox_smoke", "finalization_assurance_smoke"]) },
      private_paths_absent: { status: "failed", offending: ["docs/releases/v0.3-roadmap.md"] }
    });
  });
});
