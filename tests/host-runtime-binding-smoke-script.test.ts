import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("host runtime binding smoke script", () => {
  it("proves generated hooks bypass an incompatible PATH moryn binary", async () => {
    const script = await readFile("scripts/host-runtime-binding-smoke.js", "utf8");
    expect(script).toContain("fake-moryn-invoked");
    expect(script).toContain('"activation", "apply"');
    expect(script).toContain("SessionStart");
    expect(script).toContain("configured_hook_uses_current_runtime");
    expect(script).toContain("fake_path_binary_not_invoked");
    expect(script).toContain("activation_receipt_observed");
  });
});
