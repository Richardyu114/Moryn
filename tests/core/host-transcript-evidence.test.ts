import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultHostTranscriptRoots, readHostTranscriptEvidence } from "../../src/core/host-transcript-evidence.js";
import { withTempStore } from "../helpers/temp-store.js";

async function writeJsonl(path: string, values: unknown[]): Promise<void> {
  await writeFile(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

describe("host transcript evidence", () => {
  it("derives official host transcript roots without exposing user options", () => {
    expect(defaultHostTranscriptRoots("codex", { CODEX_HOME: "/custom/codex" })).toEqual(["/custom/codex/sessions"]);
    expect(defaultHostTranscriptRoots("claude", {})).toEqual([expect.stringMatching(/\.claude\/projects$/)]);
  });
  it("extracts only public Codex user and assistant evidence", async () => {
    await withTempStore(async (root) => {
      const transcriptRoot = join(root, "sessions");
      const transcript = join(transcriptRoot, "session.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      await writeJsonl(transcript, [
        {
          type: "response_item",
          payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "SECRET DEVELOPER" }] }
        },
        { type: "event_msg", payload: { type: "user_message", message: "Implement compact recovery." } },
        { type: "response_item", payload: { type: "reasoning", summary: [{ text: "HIDDEN REASONING" }] } },
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "Added bounded transcript recovery; next run tests." }
        },
        { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "SECRET TOOL" } }
      ]);

      const result = await readHostTranscriptEvidence({
        host: "codex",
        transcript_path: transcript,
        allowed_roots: [transcriptRoot]
      });

      expect(result).toMatchObject({
        status: "available",
        last_user_message: "Implement compact recovery.",
        last_assistant_message: "Added bounded transcript recovery; next run tests."
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
      expect(JSON.stringify(result)).not.toContain("HIDDEN");
    });
  });

  it("extracts Claude text blocks and ignores tool content", async () => {
    await withTempStore(async (root) => {
      const transcriptRoot = join(root, "projects");
      const transcript = join(transcriptRoot, "session.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      await writeJsonl(transcript, [
        { type: "user", message: { role: "user", content: "Preserve compact state." } },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", input: { token: "SECRET TOOL" } },
              { type: "text", text: "Checkpointed the latest task progress." }
            ]
          }
        },
        { type: "last-prompt", lastPrompt: "Preserve compact state." }
      ]);

      const result = await readHostTranscriptEvidence({
        host: "claude",
        transcript_path: transcript,
        allowed_roots: [transcriptRoot]
      });

      expect(result).toMatchObject({
        status: "available",
        last_user_message: "Preserve compact state.",
        last_assistant_message: "Checkpointed the latest task progress."
      });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    });
  });

  it("protects sensitive extracted text without returning it", async () => {
    await withTempStore(async (root) => {
      const transcriptRoot = join(root, "sessions");
      const transcript = join(transcriptRoot, "session.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      await writeJsonl(transcript, [
        {
          type: "event_msg",
          payload: { type: "agent_message", message: "Use api_key=abcdefghijklmnop for deployment." }
        }
      ]);
      const result = await readHostTranscriptEvidence({
        host: "codex",
        transcript_path: transcript,
        allowed_roots: [transcriptRoot]
      });
      expect(result).toMatchObject({ status: "protected" });
      expect(result.last_assistant_message).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("abcdefghijklmnop");
    });
  });

  it("rejects paths outside allowed roots and symbolic links", async () => {
    await withTempStore(async (root) => {
      const transcriptRoot = join(root, "sessions");
      const outside = join(root, "outside.jsonl");
      const linked = join(transcriptRoot, "linked.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      await writeJsonl(outside, [{ type: "event_msg", payload: { type: "agent_message", message: "outside" } }]);
      await symlink(outside, linked);
      await expect(
        readHostTranscriptEvidence({ host: "codex", transcript_path: outside, allowed_roots: [transcriptRoot] })
      ).resolves.toMatchObject({ status: "invalid", reason: "outside_allowed_roots" });
      await expect(
        readHostTranscriptEvidence({ host: "codex", transcript_path: linked, allowed_roots: [transcriptRoot] })
      ).resolves.toMatchObject({ status: "invalid", reason: "symbolic_link" });
    });
  });

  it("bounds lines and text while tolerating malformed JSONL", async () => {
    await withTempStore(async (root) => {
      const transcriptRoot = join(root, "sessions");
      const transcript = join(transcriptRoot, "session.jsonl");
      await mkdir(transcriptRoot, { recursive: true });
      const lines = Array.from({ length: 250 }, (_, index) =>
        index === 248
          ? "{malformed"
          : JSON.stringify({
              type: "event_msg",
              payload: { type: "agent_message", message: `${index}:${"x".repeat(5000)}` }
            })
      );
      await writeFile(transcript, `${lines.join("\n")}\n`, "utf8");
      const result = await readHostTranscriptEvidence({
        host: "codex",
        transcript_path: transcript,
        allowed_roots: [transcriptRoot]
      });
      expect(result).toMatchObject({ status: "available", malformed_lines: 1, truncated: true });
      expect(result.lines_considered).toBeGreaterThan(0);
      expect(result.lines_considered).toBeLessThanOrEqual(200);
      expect(result.last_assistant_message!.length).toBe(4000);
      expect(result.last_assistant_message).toContain("249:");
    });
  });
});
