import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { errorCode, nextAction, recommendedAction } from "../src/core/errors.js";

describe("documentation contracts", () => {
  it("keeps the design spec error contract aligned with runtime envelopes", async () => {
    const design = await readFile("docs/moryn-design.md", "utf8");
    const implementedCodes = [
      "STORE_NOT_INITIALIZED",
      "CONFIRMATION_REQUIRED",
      "INVALID_PROJECT_CONFIG",
      "PROJECT_CONTEXT_REQUIRED",
      "PROJECT_PATH_NOT_FOUND",
      "PROJECT_ID_NOT_FOUND",
      "PROJECT_ID_CONFLICT",
      "INVALID_STORE_CONFIG",
      "INVALID_ARGUMENT",
      "INVALID_RECORD",
      "SENSITIVE_CONTENT_DETECTED",
      "INDEX_STALE",
      "RECORD_NOT_FOUND",
      "SYNC_NOT_CONFIGURED",
      "PERMISSION_DENIED",
      "SYNC_CONFLICT",
      "SYNC_REMOTE_UNAVAILABLE",
      "INTERNAL_ERROR"
    ];

    expect(errorCode("Remote sync is unavailable; local store is still usable.")).toBe("SYNC_REMOTE_UNAVAILABLE");
    expect(design).toContain(`"recommended_action": "${recommendedAction("SYNC_REMOTE_UNAVAILABLE")}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("SYNC_REMOTE_UNAVAILABLE")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("SYNC_REMOTE_UNAVAILABLE")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INDEX_STALE")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INDEX_STALE")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("SYNC_NOT_CONFIGURED")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("SYNC_NOT_CONFIGURED")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("RECORD_NOT_FOUND", "Record not found: rec_missing")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("RECORD_NOT_FOUND", "Record not found: rec_missing")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_ARGUMENT", "Invalid argument: project_id is required for project scope")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_ARGUMENT", "Invalid argument: project_id is required for project scope")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("PROJECT_ID_CONFLICT", "Project id conflict: project_path resolves to moryn, but project_id was other. Use the .moryn.json project_id or update the project config.")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("PROJECT_ID_CONFLICT", "Project id conflict: project_path resolves to moryn, but project_id was other. Use the .moryn.json project_id or update the project config.")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("STORE_NOT_INITIALIZED")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("STORE_NOT_INITIALIZED")?.tool}"`);
    const confirmationAction = nextAction("CONFIRMATION_REQUIRED", "Confirmation required: canonical state requires explicit user confirmation", {
      tool: "promote",
      command: "moryn promote rec_123 --state canonical",
      arguments: { record_id: "rec_123", target_state: "canonical" }
    });
    expect(design).toContain(`"recommended_action": "${confirmationAction?.recommended_action}"`);
    expect(design).toContain(`"tool": "${confirmationAction?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("PROJECT_CONTEXT_REQUIRED")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("PROJECT_CONTEXT_REQUIRED")?.tool}"`);
    for (const code of implementedCodes) {
      expect(design).toContain(`- \`${code}\``);
    }
  });
});
