import type { HostHookRunResult } from "./host-hook-runner.js";

function candidateReview(result: HostHookRunResult): unknown | undefined {
  if (result.event === "pre_compact" && "candidate_review" in result) return result.candidate_review;
  if (result.event === "session_end" && "details" in result) {
    const details = result.details as { next?: { actions_by_id?: { review_learning_candidates?: unknown } } };
    return details.next?.actions_by_id?.review_learning_candidates;
  }
  return undefined;
}

function followUpOutput(result: HostHookRunResult): unknown | undefined {
  const action = candidateReview(result);
  if (!action) return undefined;
  const hookEventName = result.event === "pre_compact" ? "PreCompact" : "SessionEnd";
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: JSON.stringify(
        {
          moryn_follow_up: {
            version: 1,
            reason: "learning_candidates_require_agent_review",
            action,
            instruction:
              "Execute the supplied record-id recalls before proposing a semantic relationship; no routine user confirmation is required."
          }
        },
        null,
        2
      )
    }
  };
}

export function formatHostHookOutput(result: HostHookRunResult): unknown | undefined {
  if (result.event === "post_compact") {
    if (!result.hook_output.additional_context) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "PostCompact",
        additionalContext: result.hook_output.additional_context
      }
    };
  }
  if (result.event === "user_prompt_submit") {
    if (!result.hook_output.additional_context) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.hook_output.additional_context
      }
    };
  }
  const followUp = followUpOutput(result);
  if (followUp) return followUp;
  if (result.event !== "session_start") return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.hook_output.additional_context
    }
  };
}
