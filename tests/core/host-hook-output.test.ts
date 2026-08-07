import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { HostLifecycleEvent } from "../../src/core/host-capabilities.js";
import { formatHostHookOutput } from "../../src/core/host-hook-output.js";
import type { HostHookRunResult } from "../../src/core/host-hook-runner.js";

const commonOutputSchema = z
  .object({
    continue: z.boolean().optional(),
    stopReason: z.string().optional(),
    systemMessage: z.string().optional(),
    suppressOutput: z.boolean().optional()
  })
  .strict();

function contextOutputSchema(hookEventName: "SessionStart" | "UserPromptSubmit") {
  return z.union([
    z.undefined(),
    commonOutputSchema,
    commonOutputSchema
      .extend({
        hookSpecificOutput: z
          .object({
            hookEventName: z.literal(hookEventName),
            additionalContext: z.string()
          })
          .strict()
      })
      .strict()
  ]);
}

const commonOrSilentOutputSchema = z.union([z.undefined(), commonOutputSchema]);
const silentOutputSchema = z.undefined();
const HOST_OUTPUT_SCHEMAS = {
  codex: {
    session_start: contextOutputSchema("SessionStart"),
    user_prompt_submit: contextOutputSchema("UserPromptSubmit"),
    pre_compact: commonOrSilentOutputSchema,
    post_compact: commonOrSilentOutputSchema,
    stop: commonOrSilentOutputSchema,
    session_end: silentOutputSchema
  },
  claude: {
    session_start: contextOutputSchema("SessionStart"),
    user_prompt_submit: contextOutputSchema("UserPromptSubmit"),
    pre_compact: commonOrSilentOutputSchema,
    post_compact: silentOutputSchema,
    stop: commonOrSilentOutputSchema,
    session_end: commonOrSilentOutputSchema
  }
} as const;

const EVENT_ACTIONS: Record<HostLifecycleEvent, HostHookRunResult["action"]> = {
  session_start: "agent_start",
  user_prompt_submit: "recall_prompt",
  pre_compact: "checkpoint_before_compaction",
  post_compact: "resume_from_checkpoint",
  stop: "agent_status",
  session_end: "agent_finish"
};

function hookResult(event: HostLifecycleEvent): HostHookRunResult {
  return {
    ok: true,
    event,
    action: EVENT_ACTIONS[event],
    degradation: { mode: "native" },
    hook_output: { additional_context: `Context for ${event}.` }
  };
}

const candidateReview = {
  action: "review_learning_candidates",
  owner: "agent",
  candidate_pairs: [{ candidate_record_id: "rec_candidate" }]
};

describe("host hook output", () => {
  it.each(["codex", "claude"] as const)("keeps %s compaction output silent", (host) => {
    const postCompact = {
      ok: true as const,
      event: "post_compact" as const,
      action: "resume_from_checkpoint" as const,
      degradation: { mode: "native" as const },
      hook_output: { additional_context: "Restored bounded checkpoint progress." }
    };
    const preCompact = {
      ok: true as const,
      event: "pre_compact" as const,
      action: "checkpoint_before_compaction" as const,
      degradation: { mode: "native" as const },
      hook_output: { additional_context: "Checkpoint saved." }
    };

    expect(formatHostHookOutput(host, postCompact)).toBeUndefined();
    expect(formatHostHookOutput(host, preCompact)).toBeUndefined();
  });

  it.each(["codex", "claude"] as const)("emits %s SessionStart context", (host) => {
    expect(
      formatHostHookOutput(host, {
        ok: true,
        event: "session_start",
        action: "agent_start",
        degradation: { mode: "native" },
        hook_output: { additional_context: "Restored bounded startup context." }
      })
    ).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Restored bounded startup context." }
    });
  });

  it.each(["codex", "claude"] as const)("emits %s UserPromptSubmit context", (host) => {
    expect(
      formatHostHookOutput(host, {
        ok: true,
        event: "user_prompt_submit",
        action: "recall_prompt",
        degradation: { mode: "native" },
        hook_output: { additional_context: "Use the recalled release policy." }
      })
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Use the recalled release policy."
      }
    });
  });

  it.each(["codex", "claude"] as const)("matches the strict %s schema for every lifecycle event", (host) => {
    for (const event of Object.keys(EVENT_ACTIONS) as HostLifecycleEvent[]) {
      const output = formatHostHookOutput(host, hookResult(event));
      expect(HOST_OUTPUT_SCHEMAS[host][event].safeParse(output).success, `${host} ${event}`).toBe(true);
    }
  });

  it.each(["codex", "claude"] as const)("rejects %s additionalContext on side-effect-only events", (host) => {
    for (const event of ["pre_compact", "post_compact", "stop", "session_end"] as const) {
      const illegalOutput = {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: "This field is not valid for the event."
        }
      };
      expect(HOST_OUTPUT_SCHEMAS[host][event].safeParse(illegalOutput).success, `${host} ${event}`).toBe(false);
    }
  });

  it.each(["codex", "claude"] as const)("degrades %s PreCompact candidate delivery to systemMessage", (host) => {
    const result = Object.assign(hookResult("pre_compact"), { candidate_review: candidateReview });
    const output = formatHostHookOutput(host, result);

    expect(HOST_OUTPUT_SCHEMAS[host].pre_compact.safeParse(output).success).toBe(true);
    expect(output).toEqual({ systemMessage: expect.any(String) });
    expect(JSON.parse((output as { systemMessage: string }).systemMessage)).toMatchObject({
      moryn_follow_up: {
        reason: "learning_candidates_require_agent_review",
        action: candidateReview
      }
    });
    expect(output).not.toHaveProperty("hookSpecificOutput");
    expect(result.candidate_review).toBe(candidateReview);
  });

  it("uses systemMessage only for Claude SessionEnd candidate delivery", () => {
    const result: HostHookRunResult = {
      ...hookResult("session_end"),
      details: { next: { actions_by_id: { review_learning_candidates: candidateReview } } }
    };
    const claudeOutput = formatHostHookOutput("claude", result);

    expect(HOST_OUTPUT_SCHEMAS.claude.session_end.safeParse(claudeOutput).success).toBe(true);
    expect(claudeOutput).toEqual({ systemMessage: expect.any(String) });
    expect(claudeOutput).not.toHaveProperty("hookSpecificOutput");
    expect(formatHostHookOutput("codex", result)).toBeUndefined();
  });
});
