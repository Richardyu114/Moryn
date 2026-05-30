import { actionExecution, actionSafety, type ActionExecution, type ActionSafety } from "./action-safety.js";
import { actionInterfaces, type ActionInterfaces } from "./action-interfaces.js";
import { withPhasesByName, withRequiredFieldsByName, type RequiredFieldMetadata } from "./workflow.js";
import { operationArgumentsByTool, type OperationArgumentMetadata } from "../operation-contracts.js";

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

export interface NextActionSelectionSources {
  error_next_action: "error.next_action";
  warning_next_action: "warning.next_action";
  error_cli_executable: "error.next_action.interfaces.cli.executable";
  error_cli_argv: "error.next_action.interfaces.cli.argv[]";
  error_cli_args: "error.next_action.interfaces.cli.args[]";
  error_cli_exec_file: "error.next_action.interfaces.cli.exec_file";
  error_cli_placeholder: "error.next_action.interfaces.cli.placeholders[]";
  error_cli_command_line: "error.next_action.interfaces.cli.command_line";
  warning_cli_executable: "warning.next_action.interfaces.cli.executable";
  warning_cli_argv: "warning.next_action.interfaces.cli.argv[]";
  warning_cli_args: "warning.next_action.interfaces.cli.args[]";
  warning_cli_exec_file: "warning.next_action.interfaces.cli.exec_file";
  warning_cli_placeholder: "warning.next_action.interfaces.cli.placeholders[]";
  warning_cli_command_line: "warning.next_action.interfaces.cli.command_line";
  error_required_field: "error.next_action.required_fields_by_name.<field>";
  warning_required_field: "warning.next_action.required_fields_by_name.<field>";
  error_required_input: "error.next_action.execution.required_inputs_by_field.<field>";
  warning_required_input: "warning.next_action.execution.required_inputs_by_field.<field>";
  error_required_input_argument_path: "error.next_action.execution.required_inputs_by_argument_path.<argument_path>";
  warning_required_input_argument_path: "warning.next_action.execution.required_inputs_by_argument_path.<argument_path>";
  error_argument: "error.next_action.arguments_by_name.<argument>";
  warning_argument: "warning.next_action.arguments_by_name.<argument>";
  error_argument_source: "error.next_action.argument_sources.<field>";
  warning_argument_source: "warning.next_action.argument_sources.<field>";
  error_workflow_phase: "error.next_action.workflow.phases_by_name.<phase>";
  warning_workflow_phase: "warning.next_action.workflow.phases_by_name.<phase>";
}

export interface MorynErrorNextAction {
  recommended_action: string;
  action_source: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  interfaces: ActionInterfaces<Record<string, unknown>>;
  required_when: string;
  required_fields: string[];
  required_fields_by_name: Record<string, RequiredFieldMetadata>;
  arguments_by_name: Record<string, OperationArgumentMetadata>;
  workflow: NextActionWorkflow;
  safety: ActionSafety;
  execution: ActionExecution;
  selection_sources: NextActionSelectionSources;
  rejected_arguments?: Record<string, unknown>;
  candidate_project_ids?: string[];
  candidate_record_id?: string;
  argument_sources?: Record<string, string>;
  safe_to_run: boolean;
}

interface NextActionWorkflow {
  version: 1;
  start: "next_action";
  continue_from: string[];
  phases: NextActionWorkflowPhase[];
  phases_by_name: Record<string, NextActionWorkflowPhase>;
}

interface NextActionWorkflowPhase {
  phase: string;
  order: number;
  action_source: string;
  tool: string;
  required_when: string;
  required_fields: string[];
  command?: string;
  arguments?: Record<string, unknown>;
  replace_arguments?: Record<string, string>;
}

export interface MorynErrorContext {
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
}

const INITIALIZE_STORE_WHEN = "Before retrying any Moryn command when the store is missing or uninitialized.";
const REPAIR_STORE_CONFIG_WHEN = "Before retrying Moryn commands when local store config is invalid.";
const REPAIR_PROJECT_CONFIG_WHEN = "Before starting lifecycle or project-scoped work when .moryn.json is invalid.";
const REBUILD_INDEX_WHEN = "After receiving INDEX_STALE, before retrying recall or derived-view reads.";
const CONFIGURE_SYNC_WHEN = "Before using sync operations when no remote has been configured.";
const CHECK_REMOTE_SYNC_WHEN = "After a remote sync failure, before retrying remote operations.";
const INSPECT_SYNC_CONFLICT_WHEN = "Before retrying lifecycle writes or sync operations after a Git conflict.";
const LIST_RECORDS_WHEN = "After a record id is rejected, before retrying with a replacement record id.";
const RETRY_WITH_SELECTED_RECORD_WHEN = "After choosing the correct record id from list_recent results, retry the original tool with that selected id.";
const LIST_RECENT_SELECTED_RECORD_ID_SOURCE = "list_recent.records_by_id.<record_id>.id";
const LIST_RECENT_ORDERED_RECORD_ID_SOURCE = "list_recent.records[].id";
const RETRY_WITH_SELECTED_PROJECT_WHEN = "After choosing the correct project id from project_list results, retry the original tool with that selected project id.";
const PROJECT_LIST_SELECTED_PROJECT_ID_SOURCE = "project_list.projects_by_id.<project_id>.project_id";
const PROJECT_LIST_ORDERED_PROJECT_ID_SOURCE = "project_list.projects[].project_id";
const DISCOVER_PROJECT_FOR_WRITE_WHEN = "Before retrying a project-scoped write when project_id was omitted.";
const RETRY_PROJECT_CONFIG_ID_WHEN = "After project_path and project_id disagree, before starting lifecycle work with corrected project identity.";
const DISCOVER_PROJECT_CONTEXT_WHEN = "When a populated store requires explicit project context and none was provided.";
const INIT_OR_CORRECT_PROJECT_WHEN = "After a project_path does not exist, before retrying with that project or a corrected path.";
const LIST_PROJECTS_FOR_ID_WHEN = "After a project_id is rejected, before retrying with a known project id.";
const CONFIRM_RETRY_WHEN = "After the user explicitly confirms the high-risk change that was rejected.";
export const PROMOTE_CANDIDATE_WHEN = "After the user explicitly confirms that the candidate should become canonical.";
export const NEXT_ACTION_SELECTION_SOURCES: NextActionSelectionSources = {
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
const USER_INPUT_ARGUMENT_SOURCES: Record<string, string> = {
  path: "user_input.path",
  project_id: "user_input.project_id",
  remote: "user_input.remote"
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendCommandOption(parts: string[], option: string, value: string | number | undefined): void {
  if (value === undefined) return;
  parts.push(option, shellQuote(String(value)));
}

function appendRepeatedCommandOption(parts: string[], option: string, values: string[] | undefined): void {
  for (const value of values ?? []) {
    appendCommandOption(parts, option, value);
  }
}

function userInputArgumentSources(requiredFields: string[]): Record<string, string> | undefined {
  const sources = Object.fromEntries(
    requiredFields
      .map((field) => [field, USER_INPUT_ARGUMENT_SOURCES[field]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  return Object.keys(sources).length > 0 ? sources : undefined;
}

function actionArgumentSources(action: object): Record<string, string> | undefined {
  return "argument_sources" in action && action.argument_sources && typeof action.argument_sources === "object"
    ? action.argument_sources as Record<string, string>
    : undefined;
}

function requiredInputSelectionSources(selectionSources: Record<string, string>): Record<string, string> | undefined {
  const sources = Object.fromEntries(Object.entries(selectionSources).filter(([key]) => key.includes("required_input")));
  return Object.keys(sources).length > 0 ? sources : undefined;
}

export function withNextActionMetadata<T extends {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  required_when: string;
  required_fields: string[];
  safe_to_run: boolean;
}>(
  action: T
): T & {
  action_source: "next_action";
  interfaces: ActionInterfaces<T["arguments"]>;
  required_fields_by_name: Record<string, RequiredFieldMetadata>;
  arguments_by_name: Record<string, OperationArgumentMetadata>;
  safety: ActionSafety;
  execution: ActionExecution;
  selection_sources: NextActionSelectionSources;
  workflow: NextActionWorkflow;
} {
  const actionWithRequiredFields = withRequiredFieldsByName(action);
  return {
    ...actionWithRequiredFields,
    action_source: "next_action",
    arguments_by_name: operationArgumentsByTool(action.tool),
    interfaces: actionInterfaces(action),
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      required_fields_by_name: actionWithRequiredFields.required_fields_by_name,
      arguments_by_name: operationArgumentsByTool(action.tool),
      argument_sources: actionArgumentSources(action),
      required_input_selection_sources: requiredInputSelectionSources({ ...NEXT_ACTION_SELECTION_SOURCES })
    }),
    selection_sources: NEXT_ACTION_SELECTION_SOURCES,
    workflow: withPhasesByName({
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
    })
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
      return "fix or repair config.json, then run moryn init";
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

function projectConfigPathFromMessage(message: string): string | undefined {
  const prefix = "Invalid project config: ";
  if (!message.startsWith(prefix)) return undefined;
  const details = message.slice(prefix.length);
  const configMarker = ".moryn.json";
  const markerIndex = details.indexOf(configMarker);
  if (markerIndex === -1) return undefined;
  return details.slice(0, markerIndex + configMarker.length);
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

function conflictingProjectIdFromMessage(message: string): { resolvedProjectId?: string; rejectedProjectId?: string } {
  const prefix = "Project id conflict: project_path resolves to ";
  if (!message.startsWith(prefix)) return {};
  const details = message.slice(prefix.length);
  const splitMarker = ", but project_id was ";
  const markerIndex = details.indexOf(splitMarker);
  if (markerIndex === -1) return {};
  const resolvedProjectId = details.slice(0, markerIndex).trim();
  const rejectedText = details.slice(markerIndex + splitMarker.length);
  const end = rejectedText.indexOf(". Use the .moryn.json project_id");
  const rejectedProjectId = (end === -1 ? rejectedText : rejectedText.slice(0, end)).trim();
  return {
    ...(resolvedProjectId ? { resolvedProjectId } : {}),
    ...(rejectedProjectId ? { rejectedProjectId } : {})
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

function replaceCommandRecordId(command: string, rejectedRecordId: string | undefined, placeholder: string): string {
  if (!rejectedRecordId) return command;
  const quotedRecordId = shellQuote(rejectedRecordId);
  if (command.includes(quotedRecordId)) return command.replace(quotedRecordId, placeholder);
  if (command.includes(rejectedRecordId)) return command.replace(rejectedRecordId, placeholder);
  return command;
}

function missingRecordArgumentKey(context: MorynErrorContext | undefined, rejectedRecordId: string | undefined): string {
  if (!context || !rejectedRecordId) return "record_id";
  const preferredKeys = ["record_id", "record_ids", "linked_record_id"];
  const preferredEntry = preferredKeys.find((key) => {
    const value = context.arguments[key];
    return value === rejectedRecordId || (Array.isArray(value) && value.includes(rejectedRecordId));
  });
  if (preferredEntry) return preferredEntry;
  const matchingEntry = Object.entries(context.arguments).find(([, value]) => {
    if (value === rejectedRecordId) return true;
    return Array.isArray(value) && value.includes(rejectedRecordId);
  });
  return matchingEntry?.[0] ?? "record_id";
}

function replaceArgumentValue(value: unknown, rejectedRecordId: string | undefined, placeholder: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => entry === rejectedRecordId ? placeholder : entry);
  }
  return placeholder;
}

function replaceCommandArgument(command: string, argumentKey: string, rejectedRecordId: string | undefined, placeholder: string): string {
  if (!rejectedRecordId) return command;
  const quotedRecordId = shellQuote(rejectedRecordId);
  const flag = argumentKey === "record_ids" ? "--record-id" : `--${argumentKey.replace(/_/g, "-")}`;
  const flaggedQuotedPattern = `${flag} ${quotedRecordId}`;
  if (command.includes(flaggedQuotedPattern)) return command.replace(flaggedQuotedPattern, `${flag} ${placeholder}`);
  const flaggedPattern = `${flag} ${rejectedRecordId}`;
  if (command.includes(flaggedPattern)) return command.replace(flaggedPattern, `${flag} ${placeholder}`);
  return replaceCommandRecordId(command, rejectedRecordId, placeholder);
}

function replaceProjectIdCommandArgument(command: string, rejectedProjectId: string | undefined, placeholder: string): string {
  if (!rejectedProjectId) return `${command} --project-id ${placeholder}`;
  const quotedProjectId = shellQuote(rejectedProjectId);
  const flaggedQuotedPattern = `--project-id ${quotedProjectId}`;
  if (command.includes(flaggedQuotedPattern)) return command.replace(flaggedQuotedPattern, `--project-id ${placeholder}`);
  const flaggedPattern = `--project-id ${rejectedProjectId}`;
  if (command.includes(flaggedPattern)) return command.replace(flaggedPattern, `--project-id ${placeholder}`);
  return `${command} --project-id ${placeholder}`;
}

function missingRecordRetryPhase(context: MorynErrorContext | undefined, rejectedRecordId: string | undefined): NextActionWorkflowPhase {
  const placeholder = "<record_id_from_list_recent>";
  const argumentKey = missingRecordArgumentKey(context, rejectedRecordId);
  return {
    phase: "retry_original_tool_with_selected_record_id",
    order: 2,
    action_source: LIST_RECENT_SELECTED_RECORD_ID_SOURCE,
    tool: context?.tool ?? "original_tool",
    ...(context ? {
      command: replaceCommandArgument(context.command, argumentKey, rejectedRecordId, placeholder),
      arguments: {
        ...context.arguments,
        [argumentKey]: replaceArgumentValue(context.arguments[argumentKey], rejectedRecordId, placeholder)
      }
    } : {}),
    replace_arguments: { [argumentKey]: LIST_RECENT_SELECTED_RECORD_ID_SOURCE },
    required_when: RETRY_WITH_SELECTED_RECORD_WHEN,
    required_fields: [argumentKey]
  };
}

function projectIdRetryPhase(context: MorynErrorContext | undefined, rejectedProjectId: string | undefined): NextActionWorkflowPhase {
  const placeholder = "<project_id_from_project_list>";
  return {
    phase: "retry_original_tool_with_selected_project_id",
    order: 2,
    action_source: PROJECT_LIST_SELECTED_PROJECT_ID_SOURCE,
    tool: context?.tool ?? "original_tool",
    ...(context ? {
      command: replaceProjectIdCommandArgument(context.command, rejectedProjectId, placeholder),
      arguments: {
        ...context.arguments,
        project_id: placeholder
      }
    } : {}),
    replace_arguments: { project_id: PROJECT_LIST_SELECTED_PROJECT_ID_SOURCE },
    required_when: RETRY_WITH_SELECTED_PROJECT_WHEN,
    required_fields: ["project_id"]
  };
}

function withProjectSelectionWorkflow(
  action: MorynErrorNextAction,
  context: MorynErrorContext | undefined,
  rejectedProjectId: string | undefined
): MorynErrorNextAction {
  const retryPhase = projectIdRetryPhase(context, rejectedProjectId);
  return {
    ...action,
    argument_sources: retryPhase.replace_arguments,
    workflow: withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: [
        "error.next_action",
        "warning.next_action",
        PROJECT_LIST_SELECTED_PROJECT_ID_SOURCE,
        PROJECT_LIST_ORDERED_PROJECT_ID_SOURCE
      ],
      phases: [
        action.workflow.phases[0]!,
        retryPhase
      ]
    })
  };
}

function confirmationNextAction(context?: MorynErrorContext): MorynErrorNextAction | undefined {
  if (!context) return undefined;
  return withNextActionMetadata({
    recommended_action: "ask_user_then_retry_with_confirmation",
    tool: context.tool,
    command: appendConfirmFlag(context.command),
    arguments: {
      ...context.arguments,
      confirmed: true
    },
    required_when: CONFIRM_RETRY_WHEN,
    required_fields: [],
    safe_to_run: false
  });
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

export function commandForRecallContext(input: {
  record_ids?: string[];
  query?: string;
  project_id?: string;
  project_path?: string;
  kinds?: string[];
  scopes?: string[];
  types?: string[];
  states?: string[];
  tags?: string[];
  files?: string[];
  limit?: number;
}): string {
  const parts = ["moryn", "recall"];
  if (input.query !== undefined) {
    parts.push(shellQuote(input.query));
  }
  appendRepeatedCommandOption(parts, "--record-id", input.record_ids);
  appendCommandOption(parts, "--project-id", input.project_id);
  appendCommandOption(parts, "--project", input.project_path);
  appendRepeatedCommandOption(parts, "--kind", input.kinds);
  appendRepeatedCommandOption(parts, "--scope", input.scopes);
  appendRepeatedCommandOption(parts, "--type", input.types);
  appendRepeatedCommandOption(parts, "--state", input.states);
  appendRepeatedCommandOption(parts, "--tag", input.tags);
  appendRepeatedCommandOption(parts, "--file", input.files);
  appendCommandOption(parts, "--limit", input.limit);
  return parts.join(" ");
}

export function commandForArchiveContext(input: { record_id: string; reason?: string }): string {
  const parts = ["moryn", "archive", shellQuote(input.record_id)];
  if (input.reason !== undefined) {
    parts.push("--reason", shellQuote(input.reason));
  }
  return parts.join(" ");
}

export function commandForQuarantineContext(input: { record_id: string; reason?: string }): string {
  const parts = ["moryn", "quarantine", shellQuote(input.record_id)];
  if (input.reason !== undefined) {
    parts.push("--reason", shellQuote(input.reason));
  }
  return parts.join(" ");
}

export function commandForLinkContext(input: { record_id: string; linked_record_id: string; link_type: string }): string {
  return [
    "moryn",
    "link",
    shellQuote(input.record_id),
    shellQuote(input.linked_record_id),
    "--type",
    shellQuote(input.link_type)
  ].join(" ");
}

export function commandForAgentStartContext(input: {
  project_id?: string;
  project_path?: string;
  sync_remote?: string;
  current_task?: string;
  refresh_since?: string;
  limit?: number;
  pull?: boolean;
  agent?: {
    client?: string;
    session_id?: string;
    model?: string;
    device_id?: string;
  };
}): string {
  const parts = ["moryn", "agent", "start"];
  appendCommandOption(parts, "--project", input.project_path);
  appendCommandOption(parts, "--project-id", input.project_id);
  appendCommandOption(parts, "--sync-remote", input.sync_remote);
  appendCommandOption(parts, "--current-task", input.current_task);
  appendCommandOption(parts, "--refresh-since", input.refresh_since);
  appendCommandOption(parts, "--limit", input.limit);
  if (input.pull === false) parts.push("--no-pull");
  appendCommandOption(parts, "--agent", input.agent?.client);
  appendCommandOption(parts, "--session-id", input.agent?.session_id);
  appendCommandOption(parts, "--model", input.agent?.model);
  appendCommandOption(parts, "--device-id", input.agent?.device_id);
  return parts.join(" ");
}

interface AgentLifecycleCommandContextInput {
  project_id?: string;
  project_path?: string;
  sync_remote?: string;
  current_task?: string;
  push?: boolean;
  agent?: {
    client?: string;
    session_id?: string;
    model?: string;
    device_id?: string;
  };
}

function appendAgentLifecycleCommandOptions(parts: string[], input: AgentLifecycleCommandContextInput): void {
  appendCommandOption(parts, "--project", input.project_path);
  appendCommandOption(parts, "--project-id", input.project_id);
  appendCommandOption(parts, "--sync-remote", input.sync_remote);
  appendCommandOption(parts, "--current-task", input.current_task);
  appendCommandOption(parts, "--agent", input.agent?.client);
  appendCommandOption(parts, "--session-id", input.agent?.session_id);
  appendCommandOption(parts, "--model", input.agent?.model);
  appendCommandOption(parts, "--device-id", input.agent?.device_id);
  if (input.push === false) parts.push("--no-push");
}

export function commandForAgentStatusContext(input: AgentLifecycleCommandContextInput & { status: string }): string {
  const parts = ["moryn", "agent", "status"];
  appendAgentLifecycleCommandOptions(parts, input);
  appendCommandOption(parts, "--status", input.status);
  return parts.join(" ");
}

export function commandForAgentFinishContext(input: AgentLifecycleCommandContextInput & { summary: string }): string {
  const parts = ["moryn", "agent", "finish"];
  appendAgentLifecycleCommandOptions(parts, input);
  appendCommandOption(parts, "--summary", input.summary);
  return parts.join(" ");
}

export function nextAction(code: string, message = "", context?: MorynErrorContext): MorynErrorNextAction | undefined {
  switch (code) {
    case "STORE_NOT_INITIALIZED":
      return withNextActionMetadata({
        recommended_action: "initialize_store",
        tool: "init",
        command: "moryn init",
        arguments: {},
        required_when: INITIALIZE_STORE_WHEN,
        required_fields: [],
        safe_to_run: false
      });
    case "CONFIRMATION_REQUIRED":
      return confirmationNextAction(context);
    case "INVALID_STORE_CONFIG":
      return withNextActionMetadata({
        recommended_action: "repair_local_store_config",
        tool: "init",
        command: "moryn init --repair",
        arguments: { repair: true },
        required_when: REPAIR_STORE_CONFIG_WHEN,
        required_fields: [],
        safe_to_run: false
      });
    case "INVALID_PROJECT_CONFIG":
      {
        const configPath = projectConfigPathFromMessage(message);
        const path = configPath?.replace(/\/\.moryn\.json$/, "") ?? "<path>";
        return withNextActionMetadata({
          recommended_action: "repair_project_config_or_retry_with_explicit_project_id",
          tool: "project_init",
          command: `moryn project init --path ${path} --repair`,
          arguments: { path, repair: true },
          required_when: REPAIR_PROJECT_CONFIG_WHEN,
          required_fields: path === "<path>" ? ["path"] : [],
          argument_sources: userInputArgumentSources(path === "<path>" ? ["path"] : []),
          safe_to_run: false
        });
      }
    case "INDEX_STALE":
      return withNextActionMetadata({
        recommended_action: "rebuild_derived_views",
        tool: "rebuild",
        command: "moryn rebuild",
        arguments: {},
        required_when: REBUILD_INDEX_WHEN,
        required_fields: [],
        safe_to_run: true
      });
    case "SYNC_NOT_CONFIGURED":
      return withNextActionMetadata({
        recommended_action: "configure_sync_remote",
        tool: "sync_init",
        command: "moryn sync init <remote>",
        arguments: { remote: "<remote>" },
        required_when: CONFIGURE_SYNC_WHEN,
        required_fields: ["remote"],
        argument_sources: userInputArgumentSources(["remote"]),
        safe_to_run: false
      });
    case "SYNC_REMOTE_UNAVAILABLE":
      return withNextActionMetadata({
        recommended_action: "check_sync_status_before_retrying_remote_operation",
        tool: "sync_status",
        command: "moryn sync --status",
        arguments: {},
        required_when: CHECK_REMOTE_SYNC_WHEN,
        required_fields: [],
        safe_to_run: true
      });
    case "SYNC_CONFLICT":
      return withNextActionMetadata({
        recommended_action: "inspect_sync_conflict_before_retrying",
        tool: "sync_status",
        command: "moryn sync --status",
        arguments: {},
        required_when: INSPECT_SYNC_CONFLICT_WHEN,
        required_fields: [],
        safe_to_run: true
      });
    case "RECORD_NOT_FOUND":
      {
        const recordId = missingRecordIdFromMessage(message);
        const retryPhase = missingRecordRetryPhase(context, recordId);
        const action = withNextActionMetadata({
          recommended_action: "list_recent_records_and_retry_with_known_record_id",
          tool: "list_recent",
          command: "moryn list-recent",
          arguments: {},
          required_when: LIST_RECORDS_WHEN,
          required_fields: [],
          ...(recordId ? { rejected_arguments: { record_id: recordId } } : {}),
          safe_to_run: true
        });
        return {
          ...action,
          argument_sources: retryPhase.replace_arguments,
          workflow: withPhasesByName({
            version: 1,
            start: "next_action",
            continue_from: [
              "error.next_action",
              "warning.next_action",
              LIST_RECENT_SELECTED_RECORD_ID_SOURCE,
              LIST_RECENT_ORDERED_RECORD_ID_SOURCE
            ],
            phases: [
              action.workflow.phases[0]!,
              retryPhase
            ]
          })
        };
      }
    case "INVALID_ARGUMENT":
      if (message === "Invalid argument: project_id is required for project scope") {
        return withNextActionMetadata({
          recommended_action: "discover_project_context_before_project_scoped_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          required_when: DISCOVER_PROJECT_FOR_WRITE_WHEN,
          required_fields: [],
          rejected_arguments: { scope: "project" },
          safe_to_run: true
        });
      }
      return undefined;
    case "PROJECT_ID_CONFLICT":
      {
        const { resolvedProjectId, rejectedProjectId } = conflictingProjectIdFromMessage(message);
        const projectId = resolvedProjectId ?? "<project_id_from_config>";
        return withNextActionMetadata({
          recommended_action: "retry_with_project_config_id_or_update_project_config",
          tool: "agent_enter",
          command: `moryn agent enter --project-id ${projectId}`,
          arguments: { project_id: projectId },
          required_when: RETRY_PROJECT_CONFIG_ID_WHEN,
          required_fields: resolvedProjectId ? [] : ["project_id"],
          argument_sources: userInputArgumentSources(resolvedProjectId ? [] : ["project_id"]),
          ...(rejectedProjectId ? { rejected_arguments: { project_id: rejectedProjectId } } : {}),
          ...(resolvedProjectId ? { candidate_project_ids: [resolvedProjectId] } : {}),
          safe_to_run: false
        });
      }
    case "PROJECT_CONTEXT_REQUIRED":
      {
        const candidateProjectIds = knownProjectIdsFromContextMessage(message);
        const action = withNextActionMetadata({
          recommended_action: "discover_projects_before_lifecycle_write",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          required_when: DISCOVER_PROJECT_CONTEXT_WHEN,
          required_fields: [],
          ...(candidateProjectIds ? { candidate_project_ids: candidateProjectIds } : {}),
          safe_to_run: true
        });
        return withProjectSelectionWorkflow(action, context, undefined);
      }
    case "PROJECT_PATH_NOT_FOUND":
      {
        const path = projectPathFromMessage(message) ?? "<path>";
        return withNextActionMetadata({
          recommended_action: "initialize_project_or_retry_corrected_context",
          tool: "project_init",
          command: `moryn project init --path ${path}`,
          arguments: { path },
          required_when: INIT_OR_CORRECT_PROJECT_WHEN,
          required_fields: path === "<path>" ? ["path"] : [],
          argument_sources: userInputArgumentSources(path === "<path>" ? ["path"] : []),
          safe_to_run: false
        });
      }
    case "PROJECT_ID_NOT_FOUND":
      {
        const { rejectedProjectId, candidateProjectIds } = unknownProjectIdFromMessage(message);
        const action = withNextActionMetadata({
          recommended_action: "list_projects_and_retry_with_known_project_id",
          tool: "project_list",
          command: "moryn project list",
          arguments: {},
          required_when: LIST_PROJECTS_FOR_ID_WHEN,
          required_fields: [],
          ...(rejectedProjectId ? { rejected_arguments: { project_id: rejectedProjectId } } : {}),
          ...(candidateProjectIds ? { candidate_project_ids: candidateProjectIds } : {}),
          safe_to_run: true
        });
        return withProjectSelectionWorkflow(action, context, rejectedProjectId);
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
