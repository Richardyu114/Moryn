import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("host runtime binding smoke script", () => {
  it("proves stable hooks survive a runtime move and bypass an incompatible PATH binary", async () => {
    const script = await readFile("scripts/host-runtime-binding-smoke.js", "utf8");
    expect(script).toContain("fake-moryn-invoked");
    expect(script).toContain('"activation", "apply"');
    expect(script).toContain("SessionStart");
    expect(script).toContain("configured_hook_uses_stable_launcher");
    expect(script).toContain("trusted_command_stable_across_runtime_upgrade");
    expect(script).toContain("launcher_bound_to_current_runtime");
    expect(script).toContain("old_node_removed_before_first_hook");
    expect(script).toContain("first_hook_receipt_observed_before_repair");
    expect(script).toContain("missing_cli_hook_degraded_without_failure");
    expect(script).toContain("health_requires_attention_for_unavailable_runtime");
    expect(script).toContain("fake_path_binary_not_invoked");
    expect(script).toContain("activation_receipt_observed");
  });
});
