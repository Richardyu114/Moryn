import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createEngine } from "../../src/core/engine.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const exec = promisify(execFile);
const cliPath = join(process.cwd(), "dist", "cli.js");
const identity = { project_id: "moryn", session_id: "compaction-cli" };
const source = { client: "codex", session_id: identity.session_id, device_id: "device-a" };

async function cli(storePath: string, args: string[]): Promise<unknown> {
  const result = await exec(process.execPath, [cliPath, "--store", storePath, ...args], {
    maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(result.stdout) as unknown;
}

async function cliFailure(storePath: string, args: string[]): Promise<Record<string, unknown>> {
  try {
    await exec(process.execPath, [cliPath, "--store", storePath, ...args], { maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    const stderr = (error as Error & { stderr?: string }).stderr;
    if (stderr) return JSON.parse(stderr) as Record<string, unknown>;
    throw error;
  }
  throw new Error("Expected CLI command to fail");
}

async function seedReadySession(storePath: string): Promise<void> {
  const engine = createEngine({ storePath, now: () => "2026-07-20T09:00:01.000Z" });
  await engine.checkpoint({
    project_id: identity.project_id,
    source,
    occurred_at: "2026-07-20T09:00:00.000Z",
    delta: {
      session_id: identity.session_id,
      checkpoint_id: "compaction-cli-checkpoint",
      current_task: "Expose CLI compaction",
      decisions: ["Seal the exact preview"],
      changed_facts: ["CLI accepts JSON artifacts"],
      blockers: [],
      next_steps: ["Confirm apply"],
      files: ["src/cli.ts"]
    }
  });
  const finalText = "CLI Memory Compaction flow is ready.";
  const preview = await engine.previewSessionFold({ ...identity, proposed_final_text: finalText });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: identity.project_id,
    content: { text: finalText, session_fold_coverage: preview.coverage },
    source
  });
}

async function seedPrivateReadySession(
  storePath: string,
  privateIdentity: { project_id: string; session_id: string },
  marker: string
): Promise<void> {
  const engine = createEngine({ storePath, now: () => "2026-07-20T09:30:01.000Z" });
  const privateSource = { client: "codex", session_id: privateIdentity.session_id, device_id: "device-private" };
  await engine.write({
    kind: "session_summary",
    type: "status",
    scope: "project",
    project_id: privateIdentity.project_id,
    tags: ["private", `session:${privateIdentity.session_id}`],
    content: { text: marker, format: "text" },
    source: privateSource
  });
  const finalText = `${marker}. Private CLI session complete.`;
  const preview = await engine.previewSessionFold({
    ...privateIdentity,
    proposed_final_text: finalText,
    include_private: true
  });
  await engine.write({
    kind: "session_summary",
    type: "summary",
    scope: "project",
    project_id: privateIdentity.project_id,
    tags: ["private", `session:${privateIdentity.session_id}`],
    content: { text: finalText, session_fold_coverage: preview.coverage },
    source: privateSource
  });
}

describe("v0.4 Memory Compaction CLI", { timeout: 30_000 }, () => {
  it("runs preview, plan, guarded apply, and guarded restore", async () => {
    await withInitializedTempStore(async (storePath) => {
      await seedReadySession(storePath);
      const preview = (await cli(storePath, [
        "memory",
        "compact",
        "preview",
        "--project-id",
        identity.project_id,
        "--session-id",
        identity.session_id
      ])) as { status: string; preview_id: string; plan_id: string };
      expect(preview).toMatchObject({
        status: "ready",
        preview_id: expect.stringMatching(/^memory_compaction_preview_/u),
        plan_id: expect.stringMatching(/^memory_compaction_/u)
      });

      const plan = (await cli(storePath, ["memory", "compact", "plan", "--preview-json", JSON.stringify(preview)])) as {
        status: string;
        plan_id: string;
      };
      expect(plan).toMatchObject({ status: "ready", plan_id: preview.plan_id });

      const rejectedApply = await cliFailure(storePath, [
        "memory",
        "compact",
        "apply",
        "--plan-json",
        JSON.stringify(plan)
      ]);
      expect(JSON.stringify(rejectedApply)).toContain("requires explicit confirmed: true");

      const applied = (await cli(storePath, [
        "memory",
        "compact",
        "apply",
        "--plan-json",
        JSON.stringify(plan),
        "--confirm"
      ])) as { receipt: { status: string; plan_id: string } };
      expect(applied.receipt).toMatchObject({ status: "committed", plan_id: plan.plan_id });

      const rejectedRestore = await cliFailure(storePath, ["memory", "compact", "restore", plan.plan_id]);
      expect(JSON.stringify(rejectedRestore)).toContain("requires explicit confirmed: true");
      const restored = (await cli(storePath, ["memory", "compact", "restore", plan.plan_id, "--confirm"])) as {
        receipt: { status: string; compaction_plan_id: string; logical_restore: boolean };
      };
      expect(restored.receipt).toMatchObject({
        status: "restored",
        compaction_plan_id: plan.plan_id,
        logical_restore: true
      });
    });
  });

  it("keeps private content out of default JSON and requires --include-private to expose it", async () => {
    await withInitializedTempStore(async (storePath) => {
      const privateIdentity = { project_id: "moryn", session_id: "private-compaction-cli" };
      const marker = "PRIVATE-COMPACTION-CLI-MARKER-A614";
      await seedPrivateReadySession(storePath, privateIdentity, marker);
      const common = [
        "memory",
        "compact",
        "preview",
        "--project-id",
        privateIdentity.project_id,
        "--session-id",
        privateIdentity.session_id
      ];
      const preview = (await cli(storePath, common)) as Record<string, unknown>;
      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain("final_handoff_content");
      expect(serialized).not.toContain('"claims"');
      expect(preview).toMatchObject({
        status: "review_required",
        filters: { include_private: false },
        private_access: { scope_complete: false, omitted_private_source_count: 2 },
        blockers: [{ code: "private_sources_omitted", record_ids: [], omitted_source_count: 2 }]
      });

      const authorized = (await cli(storePath, [...common, "--include-private"])) as Record<string, unknown>;
      expect(authorized).toMatchObject({
        filters: { include_private: true },
        private_access: { scope_complete: true, omitted_private_source_count: 0 },
        plans: [{ privacy: { boundary: "private" } }]
      });
      expect(JSON.stringify(authorized)).toContain(marker);
    });
  });
});
