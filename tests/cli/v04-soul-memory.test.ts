import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readStoreConfig } from "../../src/core/config.js";
import { createEngine } from "../../src/core/engine.js";
import { memoryRecordDigest } from "../../src/core/memory-expansion.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "cli.js");
const secret = "CLI LOCAL SOUL SECRET";

async function cli(storePath: string, args: string[]): Promise<unknown> {
  const result = await exec(process.execPath, [cliPath, "--store", storePath, ...args]);
  return JSON.parse(result.stdout) as unknown;
}

async function cliFailure(storePath: string, args: string[]): Promise<Record<string, unknown>> {
  try {
    await exec(process.execPath, [cliPath, "--store", storePath, ...args]);
  } catch (error) {
    const stderr = (error as Error & { stderr?: string }).stderr;
    if (stderr) return JSON.parse(stderr) as Record<string, unknown>;
    throw error;
  }
  throw new Error("Expected CLI command to fail");
}

describe("v0.4 Soul and Memory CLI", () => {
  it("runs draft, approve, metadata-only status, derived input JSON, and rollback", async () => {
    await withInitializedTempStore(async (storePath) => {
      const firstDraft = (await cli(storePath, [
        "soul",
        "draft",
        "--subject",
        "agent",
        "--subject-id",
        "moryn",
        "--clause-json",
        JSON.stringify({
          clause_key: "mission",
          category: "mission",
          text: "Keep the CLI persona stable.",
          distribution: "personal_sync"
        }),
        "--clause-json",
        JSON.stringify({
          clause_key: "private",
          category: "collaboration",
          text: secret,
          distribution: "local_only"
        })
      ])) as { revision: { revision_id: string; profile_id: string } };

      const rejected = await cliFailure(storePath, ["soul", "approve", firstDraft.revision.revision_id]);
      expect(JSON.stringify(rejected)).toContain("explicit user confirmation");

      const first = (await cli(storePath, ["soul", "approve", firstDraft.revision.revision_id, "--confirm"])) as {
        revision: { revision_id: string; profile_id: string };
      };
      const status = await cli(storePath, ["soul", "status", "--agent-profile-id", first.revision.profile_id]);
      expect(JSON.stringify(status)).not.toContain(secret);
      expect(JSON.stringify(status)).not.toContain("Keep the CLI persona stable.");

      const changedDraft = (await cli(storePath, [
        "soul",
        "draft",
        "--input-json",
        JSON.stringify({
          from_revision_id: first.revision.revision_id,
          clauses: [
            {
              clause_key: "mission",
              category: "mission",
              text: "Use an intentionally different CLI persona.",
              distribution: "personal_sync"
            }
          ]
        })
      ])) as { revision: { revision_id: string } };
      await cli(storePath, ["soul", "approve", changedDraft.revision.revision_id, "--confirm"]);
      const rollback = (await cli(storePath, [
        "soul",
        "rollback",
        "--profile-id",
        first.revision.profile_id,
        "--to-revision",
        first.revision.revision_id,
        "--confirm"
      ])) as { approval_receipt: { action: string }; revision: { state: string } };
      expect(rollback).toMatchObject({ approval_receipt: { action: "rollback" }, revision: { state: "active" } });
    });
  });

  it("expands current memory sources with bounded CLI options", async () => {
    await withInitializedTempStore(async (storePath) => {
      const engine = createEngine({ storePath, now: () => "2026-07-20T12:00:00.000Z" });
      const deviceId = (await readStoreConfig(storePath)).device_id;
      const source = await engine.write({
        kind: "session_summary",
        type: "status",
        scope: "project",
        project_id: "moryn",
        content: { text: "CLI source" },
        source: { client: "test", device_id: deviceId }
      });
      const rollup = await engine.write({
        kind: "session_summary",
        type: "session_rollup",
        scope: "project",
        project_id: "moryn",
        content: {
          text: "CLI rollup",
          source_record_ids: [source.record.id],
          source_digests: [{ record_id: source.record.id, digest: memoryRecordDigest(source.record) }]
        },
        source: { client: "test", device_id: deviceId }
      });

      const result = (await cli(storePath, [
        "memory",
        "expand",
        rollup.record.id,
        "--max-depth",
        "1",
        "--max-records",
        "2"
      ])) as { root_record_id: string; records: Array<{ record: { id: string } }> };
      expect(result.root_record_id).toBe(rollup.record.id);
      expect(result.records.map((entry) => entry.record.id)).toEqual([rollup.record.id, source.record.id]);
    });
  });
});
