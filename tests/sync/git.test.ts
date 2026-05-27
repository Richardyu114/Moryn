import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getGitSyncStatus } from "../../src/sync/git.js";

describe("git sync adapter", () => {
  it("reports unconfigured status outside a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memora-sync-"));
    try {
      const status = await getGitSyncStatus(dir);
      expect(status.configured).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
