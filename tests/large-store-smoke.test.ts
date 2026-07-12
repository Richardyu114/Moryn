import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);

describe("large-store smoke", () => {
  it("proves the project dashboard stays read-only, bounded, and compact", async () => {
    const { stdout } = await exec("node", ["scripts/large-store-smoke.js", "--source"], {
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024
    });
    const evidence = JSON.parse(stdout.trim()) as {
      dashboard?: {
        milliseconds: number;
        candidate_count: number;
        events_before: number;
        events_after: number;
        html_bytes: number;
        attention_items: number;
      };
    };

    expect(evidence.dashboard).toMatchObject({
      candidate_count: 100,
      events_before: 2000,
      events_after: 2000,
      attention_items: 0
    });
    expect(evidence.dashboard!.milliseconds).toBeLessThanOrEqual(5000);
    expect(evidence.dashboard!.html_bytes).toBeLessThanOrEqual(1_000_000);
  }, 30_000);
});
