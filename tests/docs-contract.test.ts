import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { errorCode, nextAction, recommendedAction } from "../src/core/errors.js";

describe("documentation contracts", () => {
  it("documents the observability dashboard server and static artifact", async () => {
    const [readme, installPrompt, workflow, contracts, roadmap, dashboard] = await Promise.all([
      readFile("README.md", "utf8"),
      readFile("docs/agent-install-prompt.md", "utf8"),
      readFile("docs/agent-workflow.md", "utf8"),
      readFile("docs/contracts.md", "utf8"),
      readFile("docs/implementation-roadmap.md", "utf8"),
      readFile("docs/dashboard.md", "utf8")
    ]);

    expect(readme).toContain("moryn dashboard");
    expect(readme).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(readme).toContain("http://127.0.0.1:8765/");
    expect(readme).toContain("docs/dashboard.md");
    expect(readme).toContain("[Dashboard](docs/dashboard.md)");
    expect(readme).toContain("--no-open");
    expect(readme).toContain("state/dashboard/index.html");
    expect(installPrompt).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(installPrompt).toContain("http://127.0.0.1:8765/");
    expect(installPrompt).toContain("--host 0.0.0.0");
    expect(installPrompt).toContain("moryn dashboard --no-open");
    expect(installPrompt).toContain("[Dashboard](dashboard.md)");
    expect(workflow).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(workflow).toContain("http://127.0.0.1:8765/");
    expect(workflow).toContain("record quality");
    expect(workflow).toContain("open the static snapshot");
    expect(contracts).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(contracts).toContain("/api/dashboard");
    expect(contracts).toContain("/healthz");
    expect(contracts).toContain("docs/dashboard.md");
    expect(contracts).toContain("dashboard");
    expect(contracts).toContain('"tool": "dashboard"');
    expect(roadmap).toContain("[dashboard.md](dashboard.md)");
    expect(roadmap).toContain("Local dashboard server and static snapshots");
    expect(dashboard).toContain("# Moryn Dashboard");
    expect(dashboard).toContain("moryn dashboard --serve --host 127.0.0.1 --port 8765");
    expect(dashboard).toContain("http://127.0.0.1:8765/");
    expect(dashboard).toContain("moryn dashboard --serve --host 0.0.0.0 --port 8765");
    expect(dashboard).toContain("GET /fragment");
    expect(dashboard).toContain("GET /api/dashboard");
    expect(dashboard).toContain("MCP `dashboard` tool");
    expect(dashboard).toContain("does not start a long-running HTTP server");
  });

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
    expect(design).toContain(`"recommended_action": "${nextAction("SYNC_CONFLICT")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("SYNC_CONFLICT")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INDEX_STALE")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INDEX_STALE")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_RECORD", "Invalid replay target for event evt_missing_revision: Record not found: rec_missing")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_RECORD", "Invalid replay target for event evt_missing_revision: Record not found: rec_missing")?.tool}"`);
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
    expect(design).toContain(`"recommended_action": "${recommendedAction("INVALID_STORE_CONFIG")}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_STORE_CONFIG", "Invalid store config: /home/user/.moryn/config.json: Unexpected end of JSON input")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_STORE_CONFIG", "Invalid store config: /home/user/.moryn/config.json: Unexpected end of JSON input")?.tool}"`);
    expect(design).toContain(`"recommended_action": "${nextAction("INVALID_PROJECT_CONFIG", "Invalid project config: /workspace/moryn/.moryn.json: project_id must be non-empty")?.recommended_action}"`);
    expect(design).toContain(`"tool": "${nextAction("INVALID_PROJECT_CONFIG", "Invalid project config: /workspace/moryn/.moryn.json: project_id must be non-empty")?.tool}"`);
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
