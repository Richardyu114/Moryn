import { describe, expect, it } from "vitest";
import { runHostHook } from "../../src/core/host-hook-runner.js";
import { withInitializedTempStore } from "../helpers/temp-store.js";

const base = {
  host: "codex" as const,
  session_id: "session-a",
  device_id: "device-a",
  cwd: "/repo",
  occurred_at: "2026-07-11T00:00:00.000Z"
};

describe("host hook runner", () => {
  it("starts a session and returns host-injectable context", async () => {
    await withInitializedTempStore(async (storePath) => {
      const result = await runHostHook({ storePath, hook: { ...base, event: "session_start", trigger: "startup" }, project_id: "moryn", current_task: "Implement hooks", pull: false });
      expect(result).toMatchObject({ ok: true, event: "session_start", action: "agent_start", degradation: { mode: "native" } });
      expect(result.hook_output.additional_context).toContain("Implement hooks");
    });
  });

  it("checkpoints idempotently before compact and restores after compact", async () => {
    await withInitializedTempStore(async (storePath) => {
      const preCompact = { ...base, event: "pre_compact" as const, trigger: "auto", compact_summary: "Implemented parser; next run tests." };
      const first = await runHostHook({ storePath, hook: preCompact, project_id: "moryn", current_task: "Implement hooks", pull: false });
      const replay = await runHostHook({ storePath, hook: preCompact, project_id: "moryn", current_task: "Implement hooks", pull: false });
      const restored = await runHostHook({ storePath, hook: { ...base, event: "post_compact" }, project_id: "moryn", current_task: "Implement hooks", pull: false });
      expect(first).toMatchObject({ action: "checkpoint_before_compaction", checkpoint: { idempotent_replay: false } });
      expect(replay).toMatchObject({ checkpoint: { idempotent_replay: true } });
      expect(restored).toMatchObject({ action: "resume_from_checkpoint" });
      expect(restored.hook_output.additional_context).toContain("Implemented parser; next run tests.");
    });
  });

  it("writes stop status and Claude session-end handoff without requiring sync success", async () => {
    await withInitializedTempStore(async (storePath) => {
      const stopped = await runHostHook({ storePath, hook: { ...base, event: "stop", compact_summary: "Tests passing." }, project_id: "moryn", current_task: "Implement hooks", push: false });
      const ended = await runHostHook({ storePath, hook: { ...base, host: "claude", event: "session_end", compact_summary: "Hooks complete." }, project_id: "moryn", current_task: "Implement hooks", push: false });
      expect(stopped).toMatchObject({ action: "agent_status", degradation: { mode: "native" } });
      expect(ended).toMatchObject({ action: "agent_finish", degradation: { mode: "native" } });
    });
  });
});
