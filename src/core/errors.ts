export interface MorynErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    recommended_action: string;
    next_action?: MorynErrorNextAction;
  };
}

export interface MorynErrorNextAction {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  rejected_arguments?: Record<string, unknown>;
  candidate_project_ids?: string[];
  safe_to_run: boolean;
}

export interface MorynErrorContext {
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function errorCode(message: string): string {
  if (message.startsWith("Store not initialized") || message.includes("ENOENT")) return "STORE_NOT_INITIALIZED";
  if (message.startsWith("Confirmation required:")) return "CONFIRMATION_REQUIRED";
  if (message.startsWith("Invalid project config:")) return "INVALID_PROJECT_CONFIG";
  if (message.startsWith("Project context required:")) return "PROJECT_CONTEXT_REQUIRED";
  if (message.startsWith("Project path does not exist:")) return "PROJECT_PATH_NOT_FOUND";
  if (message.startsWith("Project id is not known in this store:")) return "PROJECT_ID_NOT_FOUND";
  if (message.startsWith("Project id conflict:")) return "PROJECT_ID_CONFLICT";
  if (message.startsWith("Invalid store config:")) return "INVALID_STORE_CONFIG";
  if (message.startsWith("Invalid argument:")) return "INVALID_ARGUMENT";
  if (message.startsWith("Invalid event:") || message.startsWith("Invalid record:") || message.startsWith("Invalid replay ")) return "INVALID_RECORD";
  if (message.startsWith("Sensitive content detected:")) return "SENSITIVE_CONTENT_DETECTED";
  if (message.startsWith("Index stale:")) return "INDEX_STALE";
  if (message.startsWith("Record not found:")) return "RECORD_NOT_FOUND";
  if (message.startsWith("Sync not configured")) return "SYNC_NOT_CONFIGURED";
  if (message.includes("Authentication failed") || message.includes("Permission denied")) return "PERMISSION_DENIED";
  if (message.toLowerCase().includes("conflict")) return "SYNC_CONFLICT";
  if (message.toLowerCase().includes("remote") || message.toLowerCase().includes("repository")) return "SYNC_REMOTE_UNAVAILABLE";
  return "INTERNAL_ERROR";
}

export function isRecoverable(code: string): boolean {
  return code !== "INTERNAL_ERROR";
}

export function recommendedAction(code: string): string {
  switch (code) {
    case "INVALID_PROJECT_CONFIG":
      return "fix .moryn.json or pass an explicit project id";
    case "PROJECT_CONTEXT_REQUIRED":
      return "run moryn project list or moryn agent enter, then retry with --project-id or --project";
    case "PROJECT_PATH_NOT_FOUND":
      return "run moryn project init --path <path> for a new project or retry with the correct --project/--project-id";
    case "PROJECT_ID_NOT_FOUND":
      return "run moryn project list or moryn agent enter, then retry with a known --project-id";
    case "PROJECT_ID_CONFLICT":
      return "pass the project id from .moryn.json or update the project config";
    case "INVALID_STORE_CONFIG":
      return "fix or remove config.json, then run moryn init";
    case "INVALID_ARGUMENT":
      return "fix the command arguments and retry";
    case "RECORD_NOT_FOUND":
      return "check the record id or call recall/list-recent to find it";
    case "STORE_NOT_INITIALIZED":
      return "run moryn init";
    case "CONFIRMATION_REQUIRED":
      return "ask the user to confirm before retrying with confirmed=true or --confirm";
    case "INVALID_RECORD":
      return "inspect the reported event or record and rebuild from valid history";
    case "SENSITIVE_CONTENT_DETECTED":
      return "remove or redact sensitive content before retrying";
    case "INDEX_STALE":
      return "run moryn rebuild";
    case "PERMISSION_DENIED":
      return "check Git credentials and filesystem permissions";
    case "SYNC_NOT_CONFIGURED":
      return "run moryn sync init <remote>";
    case "SYNC_CONFLICT":
      return "inspect Git sync state before retrying";
    case "SYNC_REMOTE_UNAVAILABLE":
      return "continue locally and retry sync later";
    default:
      return "inspect logs and retry";
  }
}

function projectPathFromMessage(message: string): string | undefined {
  const prefix = "Project path does not exist: ";
  if (!message.startsWith(prefix)) return undefined;
  const details = message.slice(prefix.length);
  const end = details.indexOf(". Run project_init");
  return end === -1 ? details : details.slice(0, end);
}

function unknownProjectIdFromMessage(message: string): { rejectedProjectId?: string; candidateProjectIds?: string[] } {
  const prefix = "Project id is not known in this store: ";
  if (!message.startsWith(prefix)) return {};
  const details = message.slice(prefix.length);
  const splitMarker = ". Run project_list and choose one of: ";
  const markerIndex = details.indexOf(splitMarker);
  if (markerIndex === -1) {
    return { rejectedProjectId: details };
  }
  const rejectedProjectId = details.slice(0, markerIndex);
  const candidateText = details.slice(markerIndex + splitMarker.length).replace(/\.$/, "");
  const candidateProjectIds = candidateText
    .split(",")
    .map((projectId) => projectId.trim())
    .filter(Boolean);
  return {
    rejectedProjectId,
    ...(candidateProjectIds.length > 0 ? { candidateProjectIds } : {})
  };
}

function knownProjectIdsFromContextMessage(message: string): string[] | undefined {
  const prefix = "Project context required: this store already has known projects (";
  if (!message.startsWith(prefix)) return undefined;
  const details = message.slice(prefix.length);
  const end = details.indexOf("). Run project_list");
  const projectText = end === -1 ? details : details.slice(0, end);
  const projectIds = projectText
    .split(",")
    .map((projectId) => projectId.trim())
    .filter(Boolean);
  return projectIds.length > 0 ? projectIds : undefined;
}

function missingRecordIdFromMessage(message: string): string | undefined {
  const prefix = "Record not found: ";
  if (!message.startsWith(prefix)) return undefined;
  const recordId = message.slice(prefix.length).trim();
  return recordId.length > 0 ? recordId : undefined;
}

function appendConfirmFlag(command: string): string {
  if (/(^|\s)--confirm(\s|$)/.test(command)) return command;
  return `${command} --confirm`;
}

function confirmationNextAction(context?: MorynErrorContext): MorynErrorNextAction | undefined {
  if (!context) return undefined;
  return {
    recommended_action: "ask_user_then_retry_with_confirmation",
    tool: context.tool,
    command: appendConfirmFlag(context.command),
    arguments: {
      ...context.arguments,
      confirmed: true
    },
    safe_to_run: false
  };
}

export function commandForPromoteContext(input: { record_id: string; target_state: string; reason?: string }): string {
  const parts = ["moryn", "promote", shellQuote(input.record_id), "--state", shellQuote(input.target_state)];
  if (input.reason !== undefined) {
    parts.push("--reason", shellQuote(input.reason));
  }
  return parts.join(" ");
}

export function commandForReviseContext(input: { record_id: string; patch: Record<string, unknown>; reason?: string }): string {
  const parts = ["moryn", "revise", shellQuote(input.record_id)];
  for (const [path, value] of Object.entries(input.patch)) {
    const assignmentValue = typeof value === "string" ? value : JSON.stringify(value);
    parts.push("--set", shellQuote(`${path}=${assignmentValue}`));
  }
  if (input.reason !== undefined) {
    parts.push("--reason", shellQuote(input.reason));
  }
  return parts.join(" ");
}

export function nextAction(code: string, message = "", context?: MorynErrorContext): MorynErrorNextAction | undefined {
  switch (code) {
    case "STORE_NOT_INITIALIZED":
      return {
        recommended_action: "initialize_store",
        tool: "init",
        command: "moryn init",
        arguments: {},
        safe_to_run: false
      };
    case "CONFIRMATION_REQUIRED":
      return confirmationNextAction(context);
    case "INDEX_STALE":
      return {
        recommended_action: "rebuild_derived_views",
        tool: "rebuild",
        command: "moryn rebuild",
        arguments: {},
        safe_to_run: true
      };
    case "SYNC_NOT_CONFIGURED":
      return {
        recommended_action: "configure_sync_remote",
        tool: "sync_init",
        command: "moryn sync init <remote>",
        arguments: { remote: "<remote>" },
        safe_to_run: false
      };
    case "RECORD_NOT_FOUND":
      {
        const recordId = missingRecordIdFromMessage(message);
        return {
          recommended_action: "list_recent_records_and_retry_with_known_record_id",
          tool: "list_recent",
          command: "moryn list-recent",
          arguments: {},
          ...(recordId ? { rejected_arguments: { record_id: recordId } } : {}),
          safe_to_run: true
        };
      }
    case "PROJECT_CONTEXT_REQUIRED":
      {
        const candidateProjectIds = knownProjectIdsFromContextMessage(message);
        return {
          recommended_action: "discover_projects_before_lifecycle_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          ...(candidateProjectIds ? { candidate_project_ids: candidateProjectIds } : {}),
          safe_to_run: true
        };
      }
    case "PROJECT_PATH_NOT_FOUND":
      {
        const path = projectPathFromMessage(message) ?? "<path>";
        return {
          recommended_action: "initialize_project_or_retry_corrected_context",
          tool: "project_init",
          command: `moryn project init --path ${path}`,
          arguments: { path },
          safe_to_run: false
        };
      }
    case "PROJECT_ID_NOT_FOUND":
      {
        const { rejectedProjectId, candidateProjectIds } = unknownProjectIdFromMessage(message);
        return {
          recommended_action: "list_projects_and_retry_with_known_project_id",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          ...(rejectedProjectId ? { rejected_arguments: { project_id: rejectedProjectId } } : {}),
          ...(candidateProjectIds ? { candidate_project_ids: candidateProjectIds } : {}),
          safe_to_run: true
        };
      }
    default:
      return undefined;
  }
}

export function toErrorEnvelope(error: unknown, context?: MorynErrorContext): MorynErrorEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(message);
  const action = nextAction(code, message, context);
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: isRecoverable(code),
      recommended_action: recommendedAction(code),
      ...(action ? { next_action: action } : {})
    }
  };
}
