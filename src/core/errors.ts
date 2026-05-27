export interface MemoraErrorEnvelope {
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
  if (message.startsWith("Invalid project config:")) return "INVALID_PROJECT_CONFIG";
  if (message.startsWith("Invalid store config:")) return "INVALID_STORE_CONFIG";
  if (message.startsWith("Invalid event:") || message.startsWith("Invalid record:")) return "INVALID_RECORD";
  if (message.startsWith("Record not found:")) return "RECORD_NOT_FOUND";
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
      return "fix .memora.json or pass an explicit project id";
    case "INVALID_STORE_CONFIG":
      return "fix or remove config.json, then run mem init";
    case "RECORD_NOT_FOUND":
      return "check the record id or call recall/list-recent to find it";
    case "STORE_NOT_INITIALIZED":
      return "run mem init";
    case "INVALID_RECORD":
      return "inspect the reported event or record and rebuild from valid history";
    case "PERMISSION_DENIED":
      return "check Git credentials and filesystem permissions";
    case "SYNC_CONFLICT":
      return "inspect Git sync state before retrying";
    case "SYNC_REMOTE_UNAVAILABLE":
      return "continue locally and retry sync later";
    default:
      return "inspect logs and retry";
  }
}

export function toErrorEnvelope(error: unknown): MemoraErrorEnvelope {
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
