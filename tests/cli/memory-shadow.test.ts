import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { readEvents } from "../../src/core/store.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliJsPath = join(process.cwd(), "dist/cli.js");

describe("memory shadow CLI", () => {
  it("returns the Engine shadow projection and leaves the store unchanged", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const input = {
        kind: "memory" as const,
        type: "decision",
        scope: "project" as const,
        project_id: "moryn",
        tags: ["maintenance"],
        content: { text: "The current memory count must decrease after consolidation." },
        state: "canonical" as const,
        confirmed: true,
        source: { client: "user" }
      };
      await engine.write(input);
      await engine.write({ ...input, source: { client: "codex" } });
      const before = await readEvents(storePath);

      const result = await exec("node", [cliJsPath, "--store", storePath, "memory", "shadow", "--project-id", "moryn"]);
      const report = JSON.parse(result.stdout) as {
        read_only: boolean;
        projection: {
          before: { current_records: number };
          guaranteed_after: { current_records: number };
        };
      };

      expect(report).toMatchObject({
        read_only: true,
        projection: {
          before: { current_records: 2 },
          guaranteed_after: { current_records: 1 }
        }
      });
      expect(await readEvents(storePath)).toEqual(before);
    });
  });
});
