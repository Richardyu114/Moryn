import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "cli.js");

describe("CLI memory feedback", () => {
  it("records a final outcome through the public command", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath });
      const written = await engine.write({
        kind: "memory",
        type: "fact",
        scope: "project",
        project_id: "moryn",
        content: { text: "The dashboard uses the release workflow." },
        state: "candidate",
        source: { client: "test" }
      });
      const { stdout } = await exec(process.execPath, [
        cliPath,
        "--store",
        storePath,
        "memory",
        "feedback",
        written.record.id,
        "--outcome",
        "verified",
        "--occurred-at",
        "2026-07-30T00:01:00.000Z",
        "--idempotency-key",
        "cli-interaction-1"
      ]);

      expect(JSON.parse(stdout)).toMatchObject({
        event: { op: "record_feedback", record_id: written.record.id, outcome: "verified" },
        usage: { recall_count: 1, useful_count: 1, rejected_count: 0 },
        selection_sources: { outcome: "event.outcome", usage: "usage" }
      });
    });
  });
});
