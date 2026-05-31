import { describe, expect, it } from "vitest";
import { toErrorEnvelope } from "../../src/core/errors.js";

const NEXT_ACTION_SELECTION_SOURCES = {
  error_next_action: "error.next_action",
  warning_next_action: "warning.next_action",
  error_cli_executable: "error.next_action.interfaces.cli.executable",
  error_cli_argv: "error.next_action.interfaces.cli.argv[]",
  error_cli_args: "error.next_action.interfaces.cli.args[]",
  error_cli_exec_file: "error.next_action.interfaces.cli.exec_file",
  error_cli_placeholder: "error.next_action.interfaces.cli.placeholders[]",
  error_cli_command_line: "error.next_action.interfaces.cli.command_line",
  warning_cli_executable: "warning.next_action.interfaces.cli.executable",
  warning_cli_argv: "warning.next_action.interfaces.cli.argv[]",
  warning_cli_args: "warning.next_action.interfaces.cli.args[]",
  warning_cli_exec_file: "warning.next_action.interfaces.cli.exec_file",
  warning_cli_placeholder: "warning.next_action.interfaces.cli.placeholders[]",
  warning_cli_command_line: "warning.next_action.interfaces.cli.command_line",
  error_required_field: "error.next_action.required_fields_by_name.<field>",
  warning_required_field: "warning.next_action.required_fields_by_name.<field>",
  error_required_input: "error.next_action.execution.required_inputs_by_field.<field>",
  warning_required_input: "warning.next_action.execution.required_inputs_by_field.<field>",
  error_required_input_argument_path: "error.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  warning_required_input_argument_path: "warning.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  error_argument: "error.next_action.arguments_by_name.<argument>",
  warning_argument: "warning.next_action.arguments_by_name.<argument>",
  error_argument_source: "error.next_action.argument_sources.<field>",
  warning_argument_source: "warning.next_action.argument_sources.<field>",
  error_workflow_phase: "error.next_action.workflow.phases_by_name.<phase>",
  warning_workflow_phase: "warning.next_action.workflow.phases_by_name.<phase>"
};

function withPhasesByName<TWorkflow extends { phases: Array<{ phase: string }> }>(workflow: TWorkflow) {
  return {
    ...workflow,
    phases_by_name: Object.fromEntries(workflow.phases.map((phase) => [phase.phase, phase]))
  };
}

function expectNextActionInterfaces(action: {
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  interfaces?: {
    cli?: { command?: string; command_line?: string; argv?: string[]; executable?: string; args?: string[]; exec_file?: { executable?: string; args?: string[] } };
    mcp?: { tool?: string; arguments?: Record<string, unknown> };
  };
}) {
  expect(action.interfaces?.cli).toEqual({
    command: action.command,
    command_line: expect.any(String),
    argv: expect.any(Array),
    executable: expect.any(String),
    args: expect.any(Array),
    exec_file: {
      executable: expect.any(String),
      args: expect.any(Array)
    },
    placeholders: expect.any(Array),
    has_placeholders: expect.any(Boolean)
  });
  expect(action.interfaces?.mcp).toEqual({
    tool: action.tool,
    arguments: action.arguments
  });
}

function expectNextActionSelectionSources(action: {
  action_source?: string;
  selection_sources?: Record<string, string>;
}) {
  expect(action.action_source).toBe("next_action");
  expect(action.selection_sources).toEqual(NEXT_ACTION_SELECTION_SOURCES);
}

function expectNextActionWorkflow(action: {
  recommended_action: string;
  tool: string;
  required_when?: string;
  required_fields: string[];
  workflow?: {
    version?: number;
    start?: string;
    continue_from?: string[];
    phases?: Array<{
      phase?: string;
      order?: number;
      action_source?: string;
      tool?: string;
      required_when?: string;
      required_fields?: string[];
    }>;
  };
}) {
  expect(action.required_when).toEqual(expect.any(String));
  expect(action.required_when).not.toHaveLength(0);
  expect(action.workflow).toEqual(withPhasesByName({
    version: 1,
    start: "next_action",
    continue_from: ["error.next_action", "warning.next_action"],
    phases: [
      {
        phase: action.recommended_action,
        order: 1,
        action_source: "next_action",
        tool: action.tool,
        required_when: action.required_when,
        required_fields: action.required_fields
      }
    ]
  }));
}

function expectNextActionSafety(action: {
  safe_to_run: boolean;
  required_fields: string[];
  tool: string;
  safety?: {
    safe_to_auto_run?: boolean;
    requires_user_confirmation?: boolean;
    requires_authored_input?: boolean;
    writes_local_config?: boolean;
    reasons?: string[];
  };
}) {
  expect(action.safety).toMatchObject({
    safe_to_auto_run: action.safe_to_run,
    requires_authored_input: action.required_fields.length > 0
  });
  expect(action.safety?.reasons).toEqual(expect.any(Array));
  expect(action.safety?.reasons?.length).toBeGreaterThan(0);
  if (["init", "project_init", "sync_init"].includes(action.tool)) {
    expect(action.safety?.writes_local_config).toBe(true);
    expect(action.safety?.requires_user_confirmation).toBe(true);
  }
}

function expectNextActionExecution(action: {
  safe_to_run: boolean;
  required_fields: string[];
  required_fields_by_name: Record<string, { argument_path?: string }>;
  selection_sources?: Record<string, string>;
  execution?: {
    ready_to_run?: boolean;
    next_step?: string;
    missing_required_fields?: string[];
    required_inputs?: Array<{ field?: string; argument_path?: string; argument_paths?: string[]; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    required_inputs_by_field?: Record<string, { field?: string; argument_path?: string; argument_paths?: string[]; selection_sources?: Record<string, string>; mcp_targets?: Array<{ argument?: string; path?: string; type?: string; required?: boolean; preferred?: boolean }>; cli_targets?: Array<{ flag?: string; flags?: string[]; positional?: string; type?: string; required?: boolean; repeatable?: boolean; preferred?: boolean }> }>;
    requires_user_confirmation?: boolean;
    reason?: string;
  };
  safety?: {
    requires_user_confirmation?: boolean;
  };
}) {
  const expectedArgumentPaths = action.required_fields.map((field) => action.required_fields_by_name[field]?.argument_path ?? field);
  const expectedSplitArgumentPaths = expectedArgumentPaths.map((argumentPath) =>
    argumentPath.split("|").map((path) => path.trim()).filter(Boolean)
  );
  expect(action.execution?.missing_required_fields).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.field)).toEqual(action.required_fields);
  expect(action.execution?.required_inputs?.map((input) => input.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.execution?.required_inputs?.map((input) => input.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(Object.keys(action.execution?.required_inputs_by_field ?? {})).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.field)).toEqual(action.required_fields);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_path)).toEqual(expectedArgumentPaths);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.argument_paths)).toEqual(expectedSplitArgumentPaths);
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.mcp_targets)).toEqual(
    action.execution?.required_inputs?.map((input) => input.mcp_targets)
  );
  expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.cli_targets)).toEqual(
    action.execution?.required_inputs?.map((input) => input.cli_targets)
  );
  const expectedRequiredInputSelectionSources = Object.fromEntries(
    Object.entries(action.selection_sources ?? {}).filter(([key]) => key.includes("required_input"))
  );
  if (action.required_fields.length > 0 && Object.keys(expectedRequiredInputSelectionSources).length > 0) {
    expect(action.execution?.required_inputs?.map((input) => input.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
    expect(action.required_fields.map((field) => action.execution?.required_inputs_by_field?.[field]?.selection_sources)).toEqual(
      action.required_fields.map(() => expectedRequiredInputSelectionSources)
    );
  }
  expect(action.execution?.requires_user_confirmation).toBe(Boolean(action.safety?.requires_user_confirmation));
  if (action.required_fields.length > 0) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "collect_required_fields"
    });
  } else if (action.safety?.requires_user_confirmation) {
    expect(action.execution).toMatchObject({
      ready_to_run: false,
      next_step: "confirm_with_user"
    });
  } else {
    expect(action.execution).toMatchObject({
      ready_to_run: action.safe_to_run,
      next_step: action.safe_to_run ? "run" : "do_not_auto_run"
    });
  }
}

describe("error envelopes", () => {
  it("classifies sensitive content failures with the documented error code", () => {
    const envelope = toErrorEnvelope(new Error("Sensitive content detected: event must be redacted before append"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SENSITIVE_CONTENT_DETECTED",
        recoverable: true,
        recommended_action: "remove or redact sensitive content before retrying",
        recovery_hint: {
          rejected_content: { sensitive: true, value_included: false },
          expected: { kind: "redacted_content", redaction_token: "[REDACTED_SECRET]" },
          retry_with: {
            action: "redact_sensitive_content_and_retry_original_write",
            argument: "content",
            value_placeholder: "<redacted content>"
          },
          do_not: ["echo_secret_value", "write_unredacted_secret", "sync_unredacted_secret"]
        }
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
        recovery_hint: {
          stale_artifacts: ["snapshots", "indexes"],
          recover_with: {
            tool: "rebuild",
            command: "moryn rebuild",
            arguments: {},
            safe_to_run: true
          },
          retry_after: {
            condition: "derived_views_rebuilt",
            action: "retry_original_read"
          },
          do_not: ["retry_original_read_before_rebuild", "edit_snapshots_or_indexes_manually", "trust_stale_derived_views"]
        },
        next_action: {
          recommended_action: "rebuild_derived_views",
          tool: "rebuild",
          command: "moryn rebuild",
          arguments: {},
          required_fields: [],
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
        recovery_hint: {
          missing_argument: { argument: "remote", placeholder: "<remote>" },
          expected: {
            kind: "git_remote",
            source: "user_input.remote"
          },
          retry_with: {
            tool: "sync_init",
            command: "moryn sync init <remote>",
            arguments: { remote: "<remote>" },
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: ["invent_git_remote", "write_sync_config_without_user_confirmation", "retry_sync_until_remote_is_configured"]
        },
        next_action: {
          recommended_action: "configure_sync_remote",
          tool: "sync_init",
          command: "moryn sync init <remote>",
          arguments: { remote: "<remote>" },
          arguments_by_name: {
            remote: {
              name: "remote",
              type: "string",
              required: true,
              cli: { positional: "remote" },
              mcp: { argument: "remote" }
            }
          },
          required_fields: ["remote"],
          argument_sources: { remote: "user_input.remote" },
          safe_to_run: false
        }
      }
    });
    expectNextActionInterfaces(envelope.error.next_action!);
    expectNextActionWorkflow(envelope.error.next_action!);
    expectNextActionSelectionSources(envelope.error.next_action!);
    expectNextActionExecution(envelope.error.next_action!);
  });

  it("points authored recovery placeholders at user input sources", () => {
    const syncSetup = toErrorEnvelope(new Error("Sync not configured"));
    expect(syncSetup.error.next_action).toMatchObject({
      arguments: { remote: "<remote>" },
      required_fields: ["remote"],
      argument_sources: { remote: "user_input.remote" }
    });
    expectNextActionSelectionSources(syncSetup.error.next_action!);

    const invalidProjectConfig = toErrorEnvelope(new Error("Invalid project config: project_id must be non-empty"));
    expect(invalidProjectConfig.error.next_action).toMatchObject({
      arguments: { path: "<path>", repair: true },
      required_fields: ["path"],
      argument_sources: { path: "user_input.path" }
    });

    const missingProjectPath = toErrorEnvelope(new Error("Project path does not exist: <path>. Run project_init for a new project, or pass the correct project_path/project_id."));
    expect(missingProjectPath.error.next_action).toMatchObject({
      arguments: { path: "<path>" },
      required_fields: ["path"],
      argument_sources: { path: "user_input.path" }
    });

    const projectIdConflict = toErrorEnvelope(new Error("Project id conflict: project_path resolves to , but project_id was other. Use the .moryn.json project_id or update the project config."));
    expect(projectIdConflict.error.next_action).toMatchObject({
      arguments: { project_id: "<project_id_from_config>" },
      required_fields: ["project_id"],
      argument_sources: { project_id: "user_input.project_id" }
    });
  });

  it("explains recovery action safety beyond safe_to_run", () => {
    const syncSetup = toErrorEnvelope(new Error("Sync not configured")).error.next_action!;
    expectNextActionSafety(syncSetup);
    expectNextActionExecution(syncSetup);
    expect(syncSetup.safety).toMatchObject({
      safe_to_auto_run: false,
      requires_user_confirmation: true,
      requires_authored_input: true,
      writes_local_config: true
    });
    expect(syncSetup.safety?.reasons).toContain("required_fields");
    expect(syncSetup.safety?.reasons).toContain("writes_local_config");

    const statusCheck = toErrorEnvelope(new Error("fatal: 'origin' does not appear to be a git repository")).error.next_action!;
    expectNextActionSafety(statusCheck);
    expectNextActionExecution(statusCheck);
    expect(statusCheck.safety).toMatchObject({
      safe_to_auto_run: true,
      requires_user_confirmation: false,
      requires_authored_input: false,
      writes_local_config: false
    });
    expect(statusCheck.safety?.reasons).toEqual(["safe_read_or_status_check"]);

    const confirmation = toErrorEnvelope(new Error("Confirmation required: canonical state requires explicit user confirmation"), {
      tool: "promote",
      command: "moryn promote rec_123 --state canonical",
      arguments: { record_id: "rec_123", target_state: "canonical" }
    }).error.next_action!;
    expect(confirmation.arguments_by_name.target_state).toMatchObject({
      name: "target_state",
      type: "string",
      required: true,
      cli: { flag: "--state" },
      mcp: { argument: "target_state" },
      allowed_values: ["raw", "candidate", "canonical", "archived", "quarantined"]
    });
    expectNextActionSafety(confirmation);
    expectNextActionExecution(confirmation);
    expect(confirmation.safety).toMatchObject({
      safe_to_auto_run: false,
      requires_user_confirmation: true,
      requires_authored_input: false,
      writes_local_config: false
    });
    expect(confirmation.safety?.reasons).toContain("requires_user_confirmation");
  });

  it("returns a safe status check action when remote sync is unavailable", () => {
    const envelope = toErrorEnvelope(new Error("fatal: 'origin' does not appear to be a git repository"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "SYNC_REMOTE_UNAVAILABLE",
        recommended_action: "continue locally and retry sync later",
        recovery_hint: {
          remote_available: false,
          local_store_usable: true,
          inspect_with: {
            tool: "sync_status",
            command: "moryn sync --status",
            arguments: {},
            safe_to_run: true
          },
          retry_after: {
            condition: "remote_reachable_or_credentials_fixed",
            action: "retry_original_sync_operation"
          },
          do_not: ["discard_local_events", "overwrite_remote_history", "retry_in_loop_without_status_check"]
        },
        next_action: {
          recommended_action: "check_sync_status_before_retrying_remote_operation",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
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
        recovery_hint: {
          conflict_detected: true,
          inspect_with: {
            tool: "sync_status",
            command: "moryn sync --status",
            arguments: {},
            safe_to_run: true
          },
          retry_after: {
            condition: "conflict_resolved",
            action: "retry_original_sync_operation"
          },
          do_not: ["write_lifecycle_records", "retry_pull_or_push_until_conflict_resolved", "auto_resolve_generated_files"]
        },
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

  it("returns a guarded recovery hint when sync credentials or permissions fail", () => {
    const envelope = toErrorEnvelope(new Error("Permission denied (publickey). Authentication failed."));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "PERMISSION_DENIED",
        recoverable: true,
        recommended_action: "check Git credentials and filesystem permissions",
        recovery_hint: {
          permission_denied: true,
          local_store_usable: true,
          expected: {
            kind: "valid_git_credentials_or_filesystem_permissions"
          },
          inspect_with: {
            tool: "sync_status",
            command: "moryn sync --status",
            arguments: {},
            safe_to_run: true
          },
          retry_after: {
            condition: "credentials_or_permissions_fixed",
            action: "retry_original_operation"
          },
          do_not: ["echo_private_key", "write_credentials_to_memory", "retry_in_loop_without_user_action"]
        },
        next_action: {
          recommended_action: "check_sync_status_before_retrying_after_permission_failure",
          tool: "sync_status",
          command: "moryn sync --status",
          arguments: {},
          required_fields: [],
          safe_to_run: true
        }
      }
    });
    expectNextActionInterfaces(envelope.error.next_action!);
    expectNextActionWorkflow(envelope.error.next_action!);
    expectNextActionSelectionSources(envelope.error.next_action!);
    expectNextActionSafety(envelope.error.next_action!);
    expectNextActionExecution(envelope.error.next_action!);
  });

  it("does not attach sync runtime recovery hints to non-sync conflict prose", () => {
    const envelope = toErrorEnvelope(new Error("Invalid argument: conflicting write content inputs"));

    expect(envelope.error.code).toBe("INVALID_ARGUMENT");
    expect(envelope.error.recovery_hint).toBeUndefined();
  });

  it("returns a machine-readable recovery action for uninitialized stores", () => {
    const envelope = toErrorEnvelope(new Error("Store not initialized"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "STORE_NOT_INITIALIZED",
        recommended_action: "run moryn init",
        recovery_hint: {
          missing_artifact: { path: "config.json", scope: "store" },
          initialize_with: {
            tool: "init",
            command: "moryn init",
            arguments: {},
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: ["write_store_files_without_user_confirmation", "assume_default_store_path"]
        },
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
        recovery_hint: {
          invalid_artifact: { path: "/home/user/.moryn/config.json", scope: "store" },
          repair_with: {
            tool: "init",
            command: "moryn init --repair",
            arguments: { repair: true },
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: ["auto_repair_store_config", "overwrite_config_without_user_confirmation"]
        },
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
        recovery_hint: {
          invalid_artifact: { path: "/workspace/moryn/.moryn.json", scope: "project" },
          repair_with: {
            tool: "project_init",
            command: "moryn project init --path /workspace/moryn --repair",
            arguments: { path: "/workspace/moryn", repair: true },
            safe_to_run: false
          },
          retry_alternative: {
            argument: "project_id",
            value_source: "user_input.project_id",
            value_placeholder: "<project_id>"
          },
          requires_user_confirmation: true,
          do_not: ["auto_repair_project_config", "invent_project_id"]
        },
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

  it("requires authored path input when invalid project config path is not absolute", () => {
    const envelope = toErrorEnvelope(new Error("Invalid project config: .moryn.json: project_id must be non-empty"));

    expect(envelope.error.recovery_hint).toMatchObject({
      invalid_artifact: { path: ".moryn.json", scope: "project" },
      repair_with: {
        tool: "project_init",
        command: "moryn project init --path <path> --repair",
        arguments: { path: "<path>", repair: true },
        safe_to_run: false
      },
      retry_alternative: {
        argument: "project_id",
        value_source: "user_input.project_id",
        value_placeholder: "<project_id>"
      },
      requires_user_confirmation: true,
      do_not: ["auto_repair_project_config", "invent_project_id"]
    });
    expect(envelope.error.next_action).toMatchObject({
      recommended_action: "repair_project_config_or_retry_with_explicit_project_id",
      tool: "project_init",
      command: "moryn project init --path <path> --repair",
      arguments: { path: "<path>", repair: true },
      required_fields: ["path"],
      argument_sources: { path: "user_input.path" },
      safe_to_run: false
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
        recovery_hint: {
          requires_user_confirmation: true,
          rejected_action: {
            tool: "promote",
            command: "moryn promote rec_123 --state canonical",
            arguments: { record_id: "rec_123", target_state: "canonical" }
          },
          ask_user: {
            prompt: "Confirm the high-risk or conflicting canonical change before retrying.",
            required: true
          },
          retry_with: {
            tool: "promote",
            command: "moryn promote rec_123 --state canonical --confirm",
            arguments: { record_id: "rec_123", target_state: "canonical", confirmed: true },
            safe_to_run: false
          },
          do_not: ["auto_confirm", "retry_without_user_confirmation", "invent_user_approval"]
        },
        next_action: {
          recommended_action: "ask_user_then_retry_with_confirmation",
          tool: "promote",
          command: "moryn promote rec_123 --state canonical --confirm",
          arguments: { record_id: "rec_123", target_state: "canonical", confirmed: true },
          safe_to_run: false
        }
      }
    });
    expectNextActionInterfaces(envelope.error.next_action!);
    expectNextActionWorkflow(envelope.error.next_action!);
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
        recovery_hint: {
          rejected_argument: { argument: "record_id", value: "rec_missing" },
          discover_with: {
            tool: "list_recent",
            command: "moryn list-recent",
            arguments: {},
            safe_to_run: true
          },
          retry_with: {
            argument: "record_id",
            value_source: "list_recent.records_by_id.<record_id>.id",
            value_placeholder: "<record_id_from_list_recent>"
          },
          fallback_value_source: "list_recent.records[].id",
          do_not: ["invent_record_id", "retry_with_same_missing_record_id"]
        },
        next_action: {
          recommended_action: "list_recent_records_and_retry_with_known_record_id",
          tool: "list_recent",
          command: "moryn list-recent",
          arguments: {},
          argument_sources: { record_id: "list_recent.records_by_id.<record_id>.id" },
          rejected_arguments: { record_id: "rec_missing" },
          required_fields_by_name: {},
          safe_to_run: true
        }
      }
    });
    expectNextActionInterfaces(envelope.error.next_action!);
    expect(envelope.error.next_action?.workflow).toEqual({
      version: 1,
      start: "next_action",
      continue_from: [
        "error.next_action",
        "warning.next_action",
        "list_recent.records_by_id.<record_id>.id",
        "list_recent.records[].id"
      ],
      phases: [
        {
          phase: "list_recent_records_and_retry_with_known_record_id",
          order: 1,
          action_source: "next_action",
          tool: "list_recent",
          required_when: "After a record id is rejected, before retrying with a replacement record id.",
          required_fields: []
        },
        {
          phase: "retry_original_tool_with_selected_record_id",
          order: 2,
          action_source: "list_recent.records_by_id.<record_id>.id",
          tool: "original_tool",
          replace_arguments: { record_id: "list_recent.records_by_id.<record_id>.id" },
          required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
          required_fields: ["record_id"]
        }
      ],
      phases_by_name: {
        list_recent_records_and_retry_with_known_record_id: {
          phase: "list_recent_records_and_retry_with_known_record_id",
          order: 1,
          action_source: "next_action",
          tool: "list_recent",
          required_when: "After a record id is rejected, before retrying with a replacement record id.",
          required_fields: []
        },
        retry_original_tool_with_selected_record_id: {
          phase: "retry_original_tool_with_selected_record_id",
          order: 2,
          action_source: "list_recent.records_by_id.<record_id>.id",
          tool: "original_tool",
          replace_arguments: { record_id: "list_recent.records_by_id.<record_id>.id" },
          required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
          required_fields: ["record_id"]
        }
      }
    });
    expect(envelope.error.next_action?.required_fields_by_name).toEqual({});
    expect(envelope.error.next_action?.argument_sources).toEqual({
      record_id: "list_recent.records_by_id.<record_id>.id"
    });
    expect(envelope.error.next_action?.workflow.phases_by_name.retry_original_tool_with_selected_record_id.required_fields).toEqual(["record_id"]);
  });

  it("uses error context to make missing-record retry workflows executable", () => {
    const envelope = toErrorEnvelope(new Error("Record not found: rec_missing"), {
      tool: "promote",
      command: "moryn promote rec_missing --state canonical",
      arguments: { record_id: "rec_missing", target_state: "canonical" }
    });

    expect(envelope.error.next_action?.workflow.phases[1]).toEqual({
      phase: "retry_original_tool_with_selected_record_id",
      order: 2,
      action_source: "list_recent.records_by_id.<record_id>.id",
      tool: "promote",
      command: "moryn promote <record_id_from_list_recent> --state canonical",
      arguments: { record_id: "<record_id_from_list_recent>", target_state: "canonical" },
      replace_arguments: { record_id: "list_recent.records_by_id.<record_id>.id" },
      required_when: "After choosing the correct record id from list_recent results, retry the original tool with that selected id.",
      required_fields: ["record_id"]
    });
    expect(envelope.error.next_action?.argument_sources).toEqual({
      record_id: "list_recent.records_by_id.<record_id>.id"
    });
  });

  it("replaces explicit recall record ids without changing the search query", () => {
    const envelope = toErrorEnvelope(new Error("Record not found: rec_missing"), {
      tool: "recall",
      command: "moryn recall rec_missing --record-id rec_missing",
      arguments: { query: "rec_missing", record_ids: ["rec_missing"] }
    });

    expect(envelope.error.next_action?.workflow.phases[1]).toMatchObject({
      tool: "recall",
      command: "moryn recall rec_missing --record-id <record_id_from_list_recent>",
      arguments: { query: "rec_missing", record_ids: ["<record_id_from_list_recent>"] },
      replace_arguments: { record_ids: "list_recent.records_by_id.<record_id>.id" },
      required_fields: ["record_ids"]
    });
    expect(envelope.error.recovery_hint).toEqual({
      rejected_argument: { argument: "record_ids", value: "rec_missing" },
      discover_with: {
        tool: "list_recent",
        command: "moryn list-recent",
        arguments: {},
        safe_to_run: true
      },
      retry_with: {
        argument: "record_ids",
        value_source: "list_recent.records_by_id.<record_id>.id",
        value_placeholder: "<record_id_from_list_recent>"
      },
      fallback_value_source: "list_recent.records[].id",
      do_not: ["invent_record_id", "retry_with_same_missing_record_id"]
    });
    expect(envelope.error.next_action?.argument_sources).toEqual({
      record_ids: "list_recent.records_by_id.<record_id>.id"
    });
  });

  it("returns a discovery action when project-scoped writes omit project context", () => {
    const envelope = toErrorEnvelope(new Error("Invalid argument: project_id is required for project scope"));

    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_ARGUMENT",
        recommended_action: "run moryn project list, then retry with a known project_id",
        recovery_hint: {
          rejected_argument: { argument: "scope", value: "project" },
          expected: { kind: "project_context", required: true },
          discover_with: {
            tool: "project_list",
            command: "moryn project list",
            arguments: {},
            safe_to_run: true
          },
          retry_with: {
            argument: "project_id",
            value_source: "project_list.projects_by_id.<project_id>.project_id",
            value_placeholder: "<project_id_from_project_list>"
          },
          fallback_value_source: "project_list.projects[].project_id",
          do_not: ["invent_project_id", "write_project_scoped_record_without_project_context"]
        },
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
    const missingPath = toErrorEnvelope(new Error("Project path does not exist: /tmp/missing. Run project_init for a new project, or pass the correct project_path/project_id."));
    expect(missingPath).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_PATH_NOT_FOUND",
        recovery_hint: {
          rejected_argument: { argument: "project_path", value: "/tmp/missing" },
          initialize_with: {
            tool: "project_init",
            command: "moryn project init --path /tmp/missing",
            arguments: { path: "/tmp/missing" },
            safe_to_run: false
          },
          retry_alternative: [
            {
              argument: "project_path",
              value_source: "user_input.path",
              value_placeholder: "<correct_project_path>"
            },
            {
              argument: "project_id",
              value_source: "user_input.project_id",
              value_placeholder: "<project_id>"
            }
          ],
          requires_user_confirmation: true,
          do_not: ["assume_missing_path_is_new_project", "invent_project_id", "auto_initialize_project_config"]
        },
        next_action: {
          recommended_action: "initialize_project_or_retry_corrected_context",
          tool: "project_init",
          command: "moryn project init --path /tmp/missing",
          arguments: { path: "/tmp/missing" },
          required_fields: [],
          safe_to_run: false
        }
      }
    });
    expectNextActionInterfaces(missingPath.error.next_action!);
    expectNextActionWorkflow(missingPath.error.next_action!);

    const unknownProjectId = toErrorEnvelope(new Error("Project id is not known in this store: morym. Run project_list and choose one of: moryn."));
    expect(unknownProjectId).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_ID_NOT_FOUND",
        recovery_hint: {
          rejected_argument: { argument: "project_id", value: "morym" },
          candidate_project_ids: ["moryn"],
          discover_with: {
            tool: "project_list",
            command: "moryn project list",
            arguments: {},
            safe_to_run: true
          },
          retry_with: {
            argument: "project_id",
            value_source: "project_list.projects_by_id.<project_id>.project_id",
            value_placeholder: "<project_id_from_project_list>"
          },
          fallback_value_source: "project_list.projects[].project_id",
          do_not: ["invent_project_id", "retry_with_same_unknown_project_id"]
        },
        next_action: {
          recommended_action: "list_projects_and_retry_with_known_project_id",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          argument_sources: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          required_fields: [],
          rejected_arguments: { project_id: "morym" },
          candidate_project_ids: ["moryn"],
          safe_to_run: true
        }
      }
    });
    expectNextActionInterfaces(unknownProjectId.error.next_action!);
    expect(unknownProjectId.error.next_action?.workflow).toEqual(withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: [
        "error.next_action",
        "warning.next_action",
        "project_list.projects_by_id.<project_id>.project_id",
        "project_list.projects[].project_id"
      ],
      phases: [
        {
          phase: "list_projects_and_retry_with_known_project_id",
          order: 1,
          action_source: "next_action",
          tool: "project_list",
          required_when: "After a project_id is rejected, before retrying with a known project id.",
          required_fields: []
        },
        {
          phase: "retry_original_tool_with_selected_project_id",
          order: 2,
          action_source: "project_list.projects_by_id.<project_id>.project_id",
          tool: "original_tool",
          replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
          required_fields: ["project_id"]
        }
      ]
    }));

    const unknownProjectIdWithContext = toErrorEnvelope(
      new Error("Project id is not known in this store: morym. Run project_list and choose one of: moryn."),
      {
        tool: "agent_start",
        command: "moryn agent start --project-id morym --current-task 'avoid typo id' --agent codex",
        arguments: { project_id: "morym", current_task: "avoid typo id", agent: { client: "codex" } }
      }
    );
    expect(unknownProjectIdWithContext.error.next_action?.workflow.phases[1]).toEqual({
      phase: "retry_original_tool_with_selected_project_id",
      order: 2,
      action_source: "project_list.projects_by_id.<project_id>.project_id",
      tool: "agent_start",
      command: "moryn agent start --project-id <project_id_from_project_list> --current-task 'avoid typo id' --agent codex",
      arguments: { project_id: "<project_id_from_project_list>", current_task: "avoid typo id", agent: { client: "codex" } },
      replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
      required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
      required_fields: ["project_id"]
    });
    expect(unknownProjectIdWithContext.error.next_action?.argument_sources).toEqual({
      project_id: "project_list.projects_by_id.<project_id>.project_id"
    });

    const projectIdConflict = toErrorEnvelope(new Error("Project id conflict: project_path resolves to moryn, but project_id was other. Use the .moryn.json project_id or update the project config."));
    expect(projectIdConflict).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_ID_CONFLICT",
        recovery_hint: {
          rejected_argument: { argument: "project_id", value: "other" },
          config_project_id: "moryn",
          retry_with: {
            tool: "agent_enter",
            command: "moryn agent enter --project-id moryn",
            arguments: { project_id: "moryn" },
            safe_to_run: false
          },
          repair_alternative: {
            tool: "project_init",
            command: "moryn project init --repair",
            arguments: { repair: true },
            safe_to_run: false
          },
          requires_user_confirmation: true,
          do_not: ["retry_with_rejected_project_id", "invent_project_id", "auto_update_project_config"]
        },
        next_action: {
          recommended_action: "retry_with_project_config_id_or_update_project_config",
          tool: "agent_enter",
          command: "moryn agent enter --project-id moryn",
          arguments: { project_id: "moryn" },
          required_fields: [],
          rejected_arguments: { project_id: "other" },
          candidate_project_ids: ["moryn"],
          safe_to_run: false
        }
      }
    });
    expectNextActionInterfaces(projectIdConflict.error.next_action!);
    expectNextActionWorkflow(projectIdConflict.error.next_action!);

    const missingContext = toErrorEnvelope(new Error("Project context required: this store already has known projects (moryn). Run project_list or agent_enter, then retry with project_path/project_id."));
    expect(missingContext).toMatchObject({
      ok: false,
      error: {
        code: "PROJECT_CONTEXT_REQUIRED",
        recovery_hint: {
          missing_argument: { argument: "project_id", placeholder: "<project_id_from_project_list>" },
          candidate_project_ids: ["moryn"],
          discover_with: {
            tool: "project_list",
            command: "moryn project list",
            arguments: {},
            safe_to_run: true
          },
          retry_with: {
            argument: "project_id",
            value_source: "project_list.projects_by_id.<project_id>.project_id",
            value_placeholder: "<project_id_from_project_list>"
          },
          fallback_value_source: "project_list.projects[].project_id",
          do_not: ["invent_project_id", "start_without_project_context"]
        },
        next_action: {
          recommended_action: "discover_projects_before_lifecycle_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          argument_sources: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
          required_fields: [],
          candidate_project_ids: ["moryn"],
          safe_to_run: true
        }
      }
    });
    expectNextActionInterfaces(missingContext.error.next_action!);
    expect(missingContext.error.next_action?.workflow.phases[1]).toEqual({
      phase: "retry_original_tool_with_selected_project_id",
      order: 2,
      action_source: "project_list.projects_by_id.<project_id>.project_id",
      tool: "original_tool",
      replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
      required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
      required_fields: ["project_id"]
    });

    const missingContextWithOriginalTool = toErrorEnvelope(
      new Error("Project context required: this store already has known projects (moryn). Run project_list or agent_enter, then retry with project_path/project_id."),
      {
        tool: "agent_status",
        command: "moryn agent status --status 'still working' --current-task 'avoid missing context' --agent codex",
        arguments: { status: "still working", current_task: "avoid missing context", agent: { client: "codex" } }
      }
    );
    expect(missingContextWithOriginalTool.error.next_action?.workflow.phases[1]).toEqual({
      phase: "retry_original_tool_with_selected_project_id",
      order: 2,
      action_source: "project_list.projects_by_id.<project_id>.project_id",
      tool: "agent_status",
      command: "moryn agent status --status 'still working' --current-task 'avoid missing context' --agent codex --project-id <project_id_from_project_list>",
      arguments: {
        status: "still working",
        current_task: "avoid missing context",
        agent: { client: "codex" },
        project_id: "<project_id_from_project_list>"
      },
      replace_arguments: { project_id: "project_list.projects_by_id.<project_id>.project_id" },
      required_when: "After choosing the correct project id from project_list results, retry the original tool with that selected project id.",
      required_fields: ["project_id"]
    });
    expect(missingContextWithOriginalTool.error.next_action?.argument_sources).toEqual({
      project_id: "project_list.projects_by_id.<project_id>.project_id"
    });
  });
});
