import type { HostAdapterId } from "./host-adapter-registry.js";
import type { HostHookRunResult } from "./host-hook-runner.js";

function candidateReview(result: HostHookRunResult): unknown | undefined {
  if (result.event === "pre_compact" && "candidate_review" in result) return result.candidate_review;
  if (result.event === "session_end" && "details" in result) {
    const details = result.details as { next?: { actions_by_id?: { review_learning_candidates?: unknown } } };
    return details.next?.actions_by_id?.review_learning_candidates;
  }
  return undefined;
}

function candidateReviewSystemMessage(action: unknown): string {
  return JSON.stringify({
    moryn_follow_up: {
      version: 1,
      reason: "learning_candidates_require_agent_review",
      action,
      instruction:
        "Recall the supplied record ids before proposing a semantic relationship; no routine user confirmation is required."
    }
  });
}

export function formatHostHookOutput(host: HostAdapterId, result: HostHookRunResult): unknown | undefined {
  if (host !== "codex" && host !== "claude") return undefined;
  if (result.event === "user_prompt_submit") {
    if (!result.hook_output.additional_context) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: result.hook_output.additional_context
      }
    };
  }
  const action = candidateReview(result);
  if (action && (result.event === "pre_compact" || (host === "claude" && result.event === "session_end"))) {
    return { systemMessage: candidateReviewSystemMessage(action) };
  }
  if (result.event !== "session_start") return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.hook_output.additional_context
    }
  };
}
