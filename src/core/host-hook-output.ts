import type { HostHookRunResult } from "./host-hook-runner.js";

export function formatHostHookOutput(result: HostHookRunResult): unknown | undefined {
  if (result.event === "user_prompt_submit") {
    if (!result.hook_output.additional_context) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.hook_output.additional_context
      }
    };
  }
  if (result.event !== "session_start") return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.hook_output.additional_context
    }
  };
}
