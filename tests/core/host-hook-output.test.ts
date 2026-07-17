import { describe, expect, it } from "vitest";
import { formatHostHookOutput } from "../../src/core/host-hook-output.js";

describe("host hook output", () => {
  it("emits PostCompact recovery context to the host", () => {
    expect(
      formatHostHookOutput({
        ok: true,
        event: "post_compact",
        action: "resume_from_checkpoint",
        degradation: { mode: "native" },
        hook_output: { additional_context: "Restored bounded checkpoint progress." }
      })
    ).toEqual({
      hookSpecificOutput: { hookEventName: "PostCompact", additionalContext: "Restored bounded checkpoint progress." }
    });
  });

  it("keeps healthy PreCompact output silent", () => {
    expect(
      formatHostHookOutput({
        ok: true,
        event: "pre_compact",
        action: "checkpoint_before_compaction",
        degradation: { mode: "native" },
        hook_output: { additional_context: "Checkpoint saved." }
      })
    ).toBeUndefined();
  });
});
