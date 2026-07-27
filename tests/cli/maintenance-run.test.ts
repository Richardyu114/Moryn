import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliJsPath = join(process.cwd(), "dist/cli.js");

describe("maintenance run CLI", () => {
  it("runs one local pass for explicit project context and exposes no sync action", async () => {
    await withInitializedTempStore(async (storePath) => {
      const localOnly = await exec("node", [
        cliJsPath,
        "--store",
        storePath,
        "maintenance",
        "run",
        "--project-id",
        "moryn"
      ]);
      expect(JSON.parse(localOnly.stdout)).toMatchObject({
        status: "completed",
        project_id: "moryn",
        preflight_event_audit: { status: "completed" },
        maintenance: { status: "skipped", maximum_merges: 1 },
        event_audit: { status: "completed" },
        sync_preflight: { status: "clear", configured: false },
        policy: {
          execution: "one_shot",
          physical_delete: false,
          remote_publish: false,
          remote_publish_operation: "sync_push"
        }
      });
      expect(JSON.parse(localOnly.stdout)).not.toHaveProperty("sync");
    });
  });

  it("rejects CWD-derived project context and the removed --push option", async () => {
    await withInitializedTempStore(async (storePath) => {
      for (const args of [
        ["--store", storePath, "maintenance", "run"],
        ["--store", storePath, "maintenance", "run", "--project-id", "moryn", "--push"]
      ]) {
        let caught: unknown;
        try {
          await exec("node", [cliJsPath, ...args]);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        const parsed = JSON.parse((caught as { stderr: string }).stderr) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        expect(parsed).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
      }
    });
  });

  it("returns a stable recoverable error when sync status cannot be verified", async () => {
    await withInitializedTempStore(async (storePath) => {
      await exec("git", ["init"], { cwd: storePath });
      await writeFile(join(storePath, ".git", "index"), "broken-index", "utf8");

      let caught: unknown;
      try {
        await exec("node", [cliJsPath, "--store", storePath, "maintenance", "run", "--project-id", "moryn"]);
      } catch (error) {
        caught = error;
      }

      const parsed = JSON.parse((caught as { stderr: string }).stderr) as {
        ok: boolean;
        error: { code: string; recoverable: boolean; recommended_action: string };
      };
      expect(parsed).toMatchObject({
        ok: false,
        error: {
          code: "SYNC_STATUS_UNAVAILABLE",
          recoverable: true,
          recommended_action: "inspect sync status and retry maintenance after the store state is readable"
        }
      });
    });
  });
});
