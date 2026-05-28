import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";

describe("error envelopes", () => {
  it("classifies sensitive content failures with the documented error code", () => {
    const envelope = toErrorEnvelope(new Error("Sensitive content detected: event must be redacted before append"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SENSITIVE_CONTENT_DETECTED",
        recoverable: true,
        recommended_action: "remove or redact sensitive content before retrying"
      }
    });
  });

  it("classifies stale index failures with the documented error code", () => {
    const envelope = toErrorEnvelope(new Error("Index stale: rebuild derived views before retrying"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INDEX_STALE",
        recoverable: true,
        recommended_action: "run moryn rebuild"
      }
    });
  });

  it("classifies invalid replay failures as invalid record history", () => {
    const envelope = toErrorEnvelope(new Error("Invalid replay target for event evt_missing_revision: Record not found: rec_missing"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_RECORD",
        recoverable: true,
        recommended_action: "inspect the reported event or record and rebuild from valid history"
      }
    });
  });

  it("returns machine-readable recovery actions for project context failures", () => {
    expect(toErrorEnvelope(new Error("Project path does not exist: /tmp/missing. Run project_init for a new project, or pass the correct project_path/project_id."))).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_PATH_NOT_FOUND",
        next_action: {
          recommended_action: "initialize_project_or_retry_corrected_context",
          tool: "project_init",
          command: "moryn project init --path <path>",
          arguments: { path: "<path>" },
          safe_to_run: false
        }
      }
    });

    expect(toErrorEnvelope(new Error("Project id is not known in this store: morym. Run project_list and choose one of: moryn."))).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_ID_NOT_FOUND",
        next_action: {
          recommended_action: "list_projects_and_retry_with_known_project_id",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          safe_to_run: true
        }
      }
    });

    expect(toErrorEnvelope(new Error("Project context required: this store already has known projects (moryn). Run project_list or agent_enter, then retry with project_path/project_id."))).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_CONTEXT_REQUIRED",
        next_action: {
          recommended_action: "discover_projects_before_lifecycle_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          safe_to_run: true
        }
      }
    });
  });
});
