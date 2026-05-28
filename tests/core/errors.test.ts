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
        recommended_action: "run moryn rebuild",
        next_action: {
          recommended_action: "rebuild_derived_views",
          tool: "rebuild",
          command: "moryn rebuild",
          arguments: {},
          safe_to_run: true
        }
      }
    });
  });

  it("returns a machine-readable recovery action for missing sync configuration", () => {
    const envelope = toErrorEnvelope(new Error("Sync not configured"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SYNC_NOT_CONFIGURED",
        recommended_action: "run moryn sync init <remote>",
        next_action: {
          recommended_action: "configure_sync_remote",
          tool: "sync_init",
          command: "moryn sync init <remote>",
          arguments: { remote: "<remote>" },
          safe_to_run: false
        }
      }
    });
  });

  it("returns a safe status check action when remote sync is unavailable", () => {
    const envelope = toErrorEnvelope(new Error("fatal: 'origin' does not appear to be a git repository"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SYNC_REMOTE_UNAVAILABLE",
        recommended_action: "continue locally and retry sync later",
        next_action: {
          recommended_action: "check_sync_status_before_retrying_remote_operation",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          safe_to_run: true
        }
      }
    });
  });

  it("returns a safe status check action when sync has a git conflict", () => {
    const envelope = toErrorEnvelope(new Error("CONFLICT (add/add): Merge conflict in events/device/2026-05/evt.json"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SYNC_CONFLICT",
        recommended_action: "inspect Git sync state before retrying",
        next_action: {
          recommended_action: "inspect_sync_conflict_before_retrying",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          safe_to_run: true
        }
      }
    });
  });

  it("returns a machine-readable recovery action for uninitialized stores", () => {
    const envelope = toErrorEnvelope(new Error("Store not initialized"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "STORE_NOT_INITIALIZED",
        recommended_action: "run moryn init",
        next_action: {
          recommended_action: "initialize_store",
          tool: "init",
          command: "moryn init",
          arguments: {},
          safe_to_run: false
        }
      }
    });
  });

  it("returns a guarded repair action for invalid store config", () => {
    const envelope = toErrorEnvelope(new Error("Invalid store config: /home/user/.moryn/config.json: Unexpected end of JSON input"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_STORE_CONFIG",
        recommended_action: "fix or repair config.json, then run moryn init",
        next_action: {
          recommended_action: "repair_local_store_config",
          tool: "init",
          command: "moryn init --repair",
          arguments: { repair: true },
          safe_to_run: false
        }
      }
    });
  });

  it("returns a guarded repair action for invalid project config", () => {
    const envelope = toErrorEnvelope(new Error("Invalid project config: /workspace/moryn/.moryn.json: project_id must be non-empty"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_PROJECT_CONFIG",
        recommended_action: "fix .moryn.json or pass an explicit project id",
        next_action: {
          recommended_action: "repair_project_config_or_retry_with_explicit_project_id",
          tool: "project_init",
          command: "moryn project init --path /workspace/moryn --repair",
          arguments: { path: "/workspace/moryn", repair: true },
          safe_to_run: false
        }
      }
    });
  });

  it("returns a confirmation recovery action when retry context is provided", () => {
    const envelope = toErrorEnvelope(new Error("Confirmation required: canonical state requires explicit user confirmation"), {
      tool: "promote",
      command: "moryn promote rec_123 --state canonical",
      arguments: { record_id: "rec_123", target_state: "canonical" }
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "CONFIRMATION_REQUIRED",
        recommended_action: "ask the user to confirm before retrying with confirmed=true or --confirm",
        next_action: {
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "promote",
          command: "moryn promote rec_123 --state canonical --confirm",
          arguments: { record_id: "rec_123", target_state: "canonical", confirmed: true },
          safe_to_run: false
        }
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

  it("returns a machine-readable recovery action for missing records", () => {
    const envelope = toErrorEnvelope(new Error("Record not found: rec_missing"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "RECORD_NOT_FOUND",
        recommended_action: "check the record id or call recall/list-recent to find it",
        next_action: {
          recommended_action: "list_recent_records_and_retry_with_known_record_id",
          tool: "list_recent",
          command: "moryn list-recent",
          arguments: {},
          rejected_arguments: { record_id: "rec_missing" },
          safe_to_run: true
        }
      }
    });
  });

  it("returns a discovery action when project-scoped writes omit project context", () => {
    const envelope = toErrorEnvelope(new Error("Invalid argument: project_id is required for project scope"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        recommended_action: "fix the command arguments and retry",
        next_action: {
          recommended_action: "discover_project_context_before_project_scoped_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          rejected_arguments: { scope: "project" },
          safe_to_run: true
        }
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
          command: "moryn project init --path /tmp/missing",
          arguments: { path: "/tmp/missing" },
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
          rejected_arguments: { project_id: "morym" },
          candidate_project_ids: ["moryn"],
          safe_to_run: true
        }
      }
    });

    expect(toErrorEnvelope(new Error("Project id conflict: project_path resolves to moryn, but project_id was other. Use the .moryn.json project_id or update the project config."))).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_ID_CONFLICT",
        next_action: {
          recommended_action: "retry_with_project_config_id_or_update_project_config",
          tool: "agent_enter",
          command: "moryn agent enter --project-id moryn",
          arguments: { project_id: "moryn" },
          rejected_arguments: { project_id: "other" },
          candidate_project_ids: ["moryn"],
          safe_to_run: false
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
          candidate_project_ids: ["moryn"],
          safe_to_run: true
        }
      }
    });
  });
});
