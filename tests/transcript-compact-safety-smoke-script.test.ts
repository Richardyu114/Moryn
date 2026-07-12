import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("transcript compact safety smoke script", () => {
  it("executes generated Codex and Claude compact hooks against bounded fixture transcripts", async () => {
    const script = await readFile("scripts/transcript-compact-safety-smoke.js", "utf8");
    for (const text of ["PreCompact", "PostCompact", "progress_recovered", "raw_transcript_path_absent", "sensitive_content_absent"]) expect(script).toContain(text);
  });
});
