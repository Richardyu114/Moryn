import type { HostHookRunResult } from "./host-hook-runner.js";

export function formatHostHookOutput(result: HostHookRunResult): unknown | undefined {
  if (result.event !== "session_start") return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.hook_output.additional_context
    }
  };
}
