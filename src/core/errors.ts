export interface MorynErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    recommended_action: string;
  };
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

export function toErrorEnvelope(error: unknown): MorynErrorEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(message);
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: isRecoverable(code),
      recommended_action: recommendedAction(code)
    }
  };
}
