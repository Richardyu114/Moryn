import { homedir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHostConfigBackupStorage } from "../../src/core/host-config-backups.js";
import { buildHostIntegrationArtifact } from "../../src/core/host-integration-artifacts.js";
import { withTempStore } from "../helpers/temp-store.js";

describe("host config backup storage", () => {
  it("keeps the runtime-less fallback outside the default Store", async () => {
    await withTempStore(async (projectPath) => {
      const artifact = buildHostIntegrationArtifact({
        host: "codex",
        project_id: "moryn",
        project_path: projectPath,
        store_path: join(homedir(), ".moryn")
      });

      const storage = await resolveHostConfigBackupStorage({ project_path: projectPath, artifact });
      const relationToDefaultStore = relative(join(homedir(), ".moryn"), storage.path);
      expect(
        relationToDefaultStore === "" || (!relationToDefaultStore.startsWith("..") && relationToDefaultStore)
      ).toBe(false);
      expect(storage.path).toMatch(/\.moryn-host-config-backups-(?:\d+|[a-f0-9]{16})/);
    });
  });
});
