import { appendEvent, readEvents } from "./store.js";
import { rebuildDerivedViews } from "./derived.js";
import { applyRecordPatch, replayEvents } from "./replay.js";
import { PROVENANCE_METHODS, RECORD_KINDS, RECORD_PRIORITIES, RECORD_SCOPES, RECORD_STATES, isoDateTimeSchema, isValidPatchPath, recordKindSchema, recordPrioritySchema, recordScopeSchema, recordSourceSchema, recordStateSchema, parseRecord } from "./schema.js";
import { detectSensitiveContent, redactSensitiveContent, sensitiveScanText } from "./sensitive.js";
import type { MorynEvent, MorynRecord, RecordKind, RecordPriority, RecordProvenance, RecordScope, RecordSource, RecordState } from "./types.js";
import { commandForPromoteContext, InvalidRefreshCursorError, PROMOTE_CANDIDATE_WHEN, withNextActionMetadata, type MorynErrorNextAction } from "./errors.js";
import { createId } from "./id.js";
import { displayRecordText, searchableContentText, searchableRecordText } from "./content-text.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import { actionInterfaces, type ActionInterfaces } from "./action-interfaces.js";
import { withPhasesByName, withRequiredFieldsByName, type RequiredFieldMetadata } from "./workflow.js";
import { operationArgumentsByTool } from "../operation-contracts.js";

interface EngineDeps {
  storePath: string;
  now?: () => string;
  id?: (prefix: string) => string;
  syncStatus?: () => Promise<{ behind?: number; remote_has_updates?: boolean }>;
}

interface WriteInput {
  kind: unknown;
  type: unknown;
  scope: unknown;
  project_id?: string;
  tags?: unknown;
  content: unknown;
  state?: unknown;
  confidence?: unknown;
  priority?: unknown;
  source: RecordSource;
  confirmed?: boolean;
  provenance?: unknown;
}

type ValidatedWriteInput = WriteInput & {
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  state?: RecordState;
  priority?: RecordPriority;
};

export interface EngineWarning {
  code: string;
  reason?: string;
  next_action?: MorynErrorNextAction;
}

interface RecallInput {
  record_ids?: unknown;
  query?: unknown;
  project_id?: string;
  kinds?: unknown;
  scopes?: unknown;
  types?: unknown;
  states?: unknown;
  tags?: unknown;
  files?: unknown;
  limit?: unknown;
}

interface RefreshInput {
  project_id?: string;
  cursor?: unknown;
  current_task?: unknown;
  limit?: unknown;
}

type ValidatedRefreshInput = RefreshInput & { cursor?: string; current_task?: string };

interface BootInput {
  project_id?: string;
  default_skills?: unknown;
  current_task?: unknown;
  sync_remote?: unknown;
}

type ValidatedBootInput = BootInput & { default_skills?: string[]; current_task?: string; sync_remote?: string };

interface ListProjectsInput {
  limit?: unknown;
  current_task?: unknown;
  sync_remote?: unknown;
  agent?: unknown;
}

type ProjectListAgent = Partial<RecordSource>;

type ValidatedListProjectsInput = ListProjectsInput & {
  current_task?: string;
  sync_remote?: string;
  agent?: ProjectListAgent;
};

const START_LISTED_PROJECT_WHEN = "After choosing this project from project_list results.";
const RECALL_REFRESH_CHANGE_WHEN = "After refresh reports this change and the agent needs the full record content.";
const WRITE_CANDIDATE_RECORD_ID_SOURCE = "write.record.id";
const WRITE_OPERATION_CONTRACT_SOURCE = "operations_by_id.write";
const WRITE_KIND_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.kind";
const WRITE_TYPE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.type";
const WRITE_SCOPE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.scope";
const WRITE_PROJECT_ID_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.project_id";
const WRITE_CONTENT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content";
const WRITE_CONTENT_TEXT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content_text";
const WRITE_CONTENT_FORMAT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content_format";
const WRITE_TAGS_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.tags";
const WRITE_STATE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.state";
const WRITE_CONFIDENCE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.confidence";
const WRITE_PRIORITY_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.priority";
const WRITE_CONFIRMED_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.confirmed";
const WRITE_SOURCE_CLIENT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_client";
const WRITE_SOURCE_SESSION_ID_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_session_id";
const WRITE_SOURCE_MODEL_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_model";
const WRITE_SOURCE_DEVICE_ID_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_device_id";
const WRITE_PROVENANCE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.provenance";
const WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.derived_from";
const WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.reason";
const WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.provenance_method";
const WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.provenance_promoted_at";

export const WRITE_SELECTION_SOURCES = {
  record: "record",
  record_id: "record.id",
  warning_next_action: "warning.next_action"
};

export const MUTATION_EVENT_SELECTION_SOURCES = {
  event: "event",
  event_id: "event.event_id",
  record_id: "event.record_id"
};

export const LINK_EVENT_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  linked_record_id: "event.linked_record_id"
};

export const SENSITIVE_REVISE_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  quarantine_event: "quarantine_event",
  quarantine_event_id: "quarantine_event.event_id"
};

export const PROJECT_LIST_SELECTION_SOURCES = {
  project: "projects_by_id.<project_id>",
  project_id: "projects_by_id.<project_id>.project_id",
  next_action: "projects_by_id.<project_id>.next"
};

export const PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES = {
  project: "project_list.projects_by_id.<project_id>",
  project_id: "project_list.projects_by_id.<project_id>.project_id",
  next_action: "project_list.projects_by_id.<project_id>.next",
  ordered_next_action: "project_list.projects[].next",
  cli_executable: "project_list.projects_by_id.<project_id>.next.interfaces.cli.executable",
  cli_argv: "project_list.projects_by_id.<project_id>.next.interfaces.cli.argv[]",
  cli_args: "project_list.projects_by_id.<project_id>.next.interfaces.cli.args[]",
  cli_exec_file: "project_list.projects_by_id.<project_id>.next.interfaces.cli.exec_file",
  cli_placeholder: "project_list.projects_by_id.<project_id>.next.interfaces.cli.placeholders[]",
  cli_command_line: "project_list.projects_by_id.<project_id>.next.interfaces.cli.command_line",
  ordered_cli_executable: "project_list.projects[].next.interfaces.cli.executable",
  ordered_cli_argv: "project_list.projects[].next.interfaces.cli.argv[]",
  ordered_cli_args: "project_list.projects[].next.interfaces.cli.args[]",
  ordered_cli_exec_file: "project_list.projects[].next.interfaces.cli.exec_file",
  ordered_cli_placeholder: "project_list.projects[].next.interfaces.cli.placeholders[]",
  ordered_cli_command_line: "project_list.projects[].next.interfaces.cli.command_line",
  argument: "project_list.projects_by_id.<project_id>.next.arguments_by_name.<argument>",
  ordered_argument: "project_list.projects[].next.arguments_by_name.<argument>",
  required_field: "project_list.projects_by_id.<project_id>.next.required_fields_by_name.<field>",
  ordered_required_field: "project_list.projects[].next.required_fields_by_name.<field>",
  required_input: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_field.<field>",
  ordered_required_input: "project_list.projects[].next.execution.required_inputs_by_field.<field>",
  required_input_argument_path: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path: "project_list.projects[].next.execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "project_list.projects_by_id.<project_id>.next.argument_sources.<field>",
  ordered_argument_source: "project_list.projects[].next.argument_sources.<field>"
};

export const LIST_RECENT_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id"
};

export const RECALL_SELECTION_SOURCES = {
  result: "results_by_id.<record_id>",
  record: "results_by_id.<record_id>.record",
  record_id: "results_by_id.<record_id>.record.id"
};

export const BOOT_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  user_preference: "profile.user_preferences_by_id.<record_id>",
  soul: "profile.soul_by_id.<record_id>",
  global_rule: "profile.global_rules_by_id.<record_id>",
  important_decision: "project.important_decisions_by_id.<record_id>",
  warning: "project.warnings_by_id.<record_id>",
  skill: "skills_by_id.<record_id>",
  task_relevant: "task_relevant_by_id.<record_id>",
  recent_change: "recent_changes_by_id.<record_id>"
};

export const REFRESH_SELECTION_SOURCES = {
  change: "changes_by_record_id.<record_id>",
  record_id: "changes_by_record_id.<record_id>.record_id",
  next_action: "changes_by_record_id.<record_id>.next_action"
};

export const REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES = {
  change: "refresh.changes_by_record_id.<record_id>",
  record_id: "refresh.changes_by_record_id.<record_id>.record_id",
  next_action: "refresh.changes_by_record_id.<record_id>.next_action",
  ordered_next_action: "refresh.changes[].next_action",
  cli_executable: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.executable",
  cli_argv: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
  cli_args: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
  cli_exec_file: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
  cli_placeholder: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
  cli_command_line: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
  ordered_cli_executable: "refresh.changes[].next_action.interfaces.cli.executable",
  ordered_cli_argv: "refresh.changes[].next_action.interfaces.cli.argv[]",
  ordered_cli_args: "refresh.changes[].next_action.interfaces.cli.args[]",
  ordered_cli_exec_file: "refresh.changes[].next_action.interfaces.cli.exec_file",
  ordered_cli_placeholder: "refresh.changes[].next_action.interfaces.cli.placeholders[]",
  ordered_cli_command_line: "refresh.changes[].next_action.interfaces.cli.command_line",
  argument: "refresh.changes_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
  ordered_argument: "refresh.changes[].next_action.arguments_by_name.<argument>",
  required_field: "refresh.changes_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
  ordered_required_field: "refresh.changes[].next_action.required_fields_by_name.<field>",
  required_input: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
  ordered_required_input: "refresh.changes[].next_action.execution.required_inputs_by_field.<field>",
  required_input_argument_path: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path: "refresh.changes[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>",
  ordered_argument_source: "refresh.changes[].next_action.argument_sources.<field>"
};

function withActionInterfaces<T extends { tool: string; command: string; arguments: unknown; required_fields: string[] }>(
  action: T
): T & {
  required_fields_by_name: Record<string, RequiredFieldMetadata>;
  arguments_by_name: ReturnType<typeof operationArgumentsByTool>;
  interfaces: ActionInterfaces<T["arguments"] & Record<string, unknown>>;
} {
  const actionWithRequiredFields = withRequiredFieldsByName({
    ...action,
    arguments: action.arguments as Record<string, unknown>
  });
  return {
    ...actionWithRequiredFields,
    arguments: action.arguments,
    arguments_by_name: operationArgumentsByTool(action.tool),
    interfaces: actionInterfaces({
      tool: action.tool,
      command: action.command,
      arguments: action.arguments as T["arguments"] & Record<string, unknown>
    })
  };
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

function withProjectListNextMetadata<T extends {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
}>(
  action: T
) {
  const actionWithInterfaces = withActionInterfaces(action);
  const projectId = typeof action.arguments.project_id === "string" ? action.arguments.project_id : "<project_id>";
  return {
    ...actionWithInterfaces,
    action_source: `project_list.projects_by_id.${projectId}.next`,
    selection_sources: PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      required_fields_by_name: actionWithInterfaces.required_fields_by_name,
      arguments_by_name: actionWithInterfaces.arguments_by_name,
      argument_sources: actionArgumentSources(action),
      required_input_selection_sources: requiredInputSelectionSources(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES)
    }),
    workflow: withPhasesByName({
      version: 1,
      start: "next",
      continue_from: ["project_list.projects_by_id.<project_id>.next", "project_list.projects[].next"],
      phases: [
        {
          phase: action.recommended_action,
          order: 1,
          action_source: "project_list.projects_by_id.<project_id>.next",
          tool: action.tool,
          required_when: action.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

function withRefreshChangeNextActionMetadata<T extends {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
}>(
  action: T
) {
  const actionWithInterfaces = withActionInterfaces(action);
  const recordIds = action.arguments.record_ids;
  const recordId = Array.isArray(recordIds) && typeof recordIds[0] === "string" ? recordIds[0] : "<record_id>";
  return {
    ...actionWithInterfaces,
    action_source: `refresh.changes_by_record_id.${recordId}.next_action`,
    selection_sources: REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      required_fields_by_name: actionWithInterfaces.required_fields_by_name,
      arguments_by_name: actionWithInterfaces.arguments_by_name,
      argument_sources: actionArgumentSources(action),
      required_input_selection_sources: requiredInputSelectionSources(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES)
    }),
    workflow: withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: ["refresh.changes_by_record_id.<record_id>.next_action", "refresh.changes[].next_action"],
      phases: [
        {
          phase: action.recommended_action,
          order: 1,
          action_source: "refresh.changes_by_record_id.<record_id>.next_action",
          tool: action.tool,
          required_when: action.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

interface StateChangeInput {
  record_id: unknown;
  reason?: unknown;
  source?: RecordSource;
}

interface RevisionInput {
  record_id: unknown;
  patch: unknown;
  reason?: unknown;
  source?: RecordSource;
  confirmed?: boolean;
}

interface PromoteInput {
  record_id: unknown;
  target_state: unknown;
  reason?: unknown;
  source?: RecordSource;
  confirmed?: boolean;
}

interface LinkInput {
  record_id: unknown;
  linked_record_id: unknown;
  link_type: unknown;
  source?: RecordSource;
}

type ValidatedStateChangeInput = StateChangeInput & { record_id: string; reason?: string };
type ValidatedRevisionInput = RevisionInput & { record_id: string; reason?: string };
type ValidatedPromoteInput = PromoteInput & { record_id: string; target_state: RecordState; reason?: string };
type ValidatedLinkInput = LinkInput & { record_id: string; linked_record_id: string; link_type: string };

type ReadOperation = "recall" | "boot" | "refresh" | "list_recent" | "project_list";
type ReadOperationContractSource = `operations_by_id.${ReadOperation}`;
type ReadArgumentSource = `operations_by_id.${ReadOperation}.arguments_by_name.${string}`;
type AgentIdentityField = "client" | "session_id" | "model" | "device_id";
type AgentIdentityArgument = `agent.${AgentIdentityField}`;

type MutationOperation = "revise" | "promote" | "archive" | "quarantine" | "link";
type MutationOperationContractSource = `operations_by_id.${MutationOperation}`;
type SourceIdentityField = "client" | "session_id" | "model" | "device_id";
type SourceIdentityArgument = `source.${SourceIdentityField}`;
type MutationArgumentName = "record_id" | "linked_record_id" | "reason" | SourceIdentityArgument | "link_type" | "confirmed" | "target_state";
type MutationArgumentSource = `operations_by_id.${MutationOperation}.arguments_by_name.${string}`;

const SOURCE_IDENTITY_FIELDS = {
  client: {
    argument: "source.client",
    contractArgument: "source_client",
    placeholder: "<client>"
  },
  session_id: {
    argument: "source.session_id",
    contractArgument: "source_session_id",
    placeholder: "<source session id>"
  },
  model: {
    argument: "source.model",
    contractArgument: "source_model",
    placeholder: "<source model>"
  },
  device_id: {
    argument: "source.device_id",
    contractArgument: "source_device_id",
    placeholder: "<source device id>"
  }
} as const satisfies Record<SourceIdentityField, {
  argument: SourceIdentityArgument;
  contractArgument: string;
  placeholder: string;
}>;

const AGENT_IDENTITY_FIELDS = {
  client: {
    argument: "agent.client",
    contractArgument: "agent_client",
    placeholder: "<agent client>"
  },
  session_id: {
    argument: "agent.session_id",
    contractArgument: "agent_session_id",
    placeholder: "<agent session id>"
  },
  model: {
    argument: "agent.model",
    contractArgument: "agent_model",
    placeholder: "<agent model>"
  },
  device_id: {
    argument: "agent.device_id",
    contractArgument: "agent_device_id",
    placeholder: "<agent device id>"
  }
} as const satisfies Record<AgentIdentityField, {
  argument: AgentIdentityArgument;
  contractArgument: string;
  placeholder: string;
}>;

function textOf(record: MorynRecord): string {
  return displayRecordText(record);
}

function searchableText(record: MorynRecord): string {
  return searchableRecordText(record);
}

function validateLimit(limit: unknown, fallback: number, operation: ReadOperation): number {
  const resolved = limit ?? fallback;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < 1 || resolved > 100) {
    throw invalidReadLimitError(operation, resolved);
  }
  return resolved;
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

type MutationArgumentRecoveryHint =
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: "record_id" | "linked_record_id" | "reason" | SourceIdentityArgument | "link_type"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Partial<Record<MutationArgumentName, MutationArgumentSource>>;
      retry_with: { argument: "record_id" | "linked_record_id" | "reason" | SourceIdentityArgument | "link_type"; value_placeholder: string };
    }
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: "confirmed"; value: unknown };
      expected: { kind: "boolean" };
      argument_sources: { confirmed: MutationArgumentSource };
      retry_with: { argument: "confirmed"; value_placeholder: true };
    }
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: "target_state"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { target_state: MutationArgumentSource };
      retry_with: { argument: "target_state"; value_placeholder: "canonical" };
    }
  | {
      rejected_argument: { argument: SourceIdentityArgument; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
    }
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: `source.${string}`; value: unknown };
      expected: { kind: "known_object_field"; allowed_fields: SourceIdentityField[] };
      argument_sources: Partial<Record<SourceIdentityArgument, MutationArgumentSource>>;
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"];
    };

class MutationArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: MutationArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: MutationArgumentRecoveryHint) {
    super(message);
    this.name = "MutationArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function mutationOperationContractSource(operation: MutationOperation): MutationOperationContractSource {
  return `operations_by_id.${operation}`;
}

function mutationArgumentSource(operation: MutationOperation, argument: MutationArgumentName): MutationArgumentSource {
  const argumentName = argument.startsWith("source.")
    ? SOURCE_IDENTITY_FIELDS[argument.slice("source.".length) as SourceIdentityField].contractArgument
    : argument;
  return `operations_by_id.${operation}.arguments_by_name.${argumentName}`;
}

function invalidMutationStringError(
  operation: MutationOperation,
  argument: "record_id" | "linked_record_id" | "reason" | "link_type",
  value: unknown
): MutationArgumentError {
  const action = argument === "link_type"
    ? "retry link with a non-empty link_type"
    : argument === "reason"
      ? "retry mutation with a non-empty reason"
      : `retry mutation with a valid ${argument}`;
  return new MutationArgumentError(
    `Invalid argument: Invalid ${argument}`,
    action,
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument, value },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { [argument]: mutationArgumentSource(operation, argument) },
      retry_with: { argument, value_placeholder: `<${argument}>` }
    }
  );
}

function invalidMutationConfirmedError(operation: MutationOperation, confirmed: unknown): MutationArgumentError {
  return new MutationArgumentError(
    "Invalid argument: Invalid confirmed",
    "retry mutation with a boolean confirmed value",
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: "confirmed", value: confirmed },
      expected: { kind: "boolean" },
      argument_sources: { confirmed: mutationArgumentSource(operation, "confirmed") },
      retry_with: { argument: "confirmed", value_placeholder: true }
    }
  );
}

function invalidMutationTargetStateError(operation: MutationOperation, targetState: unknown): MutationArgumentError {
  return new MutationArgumentError(
    "Invalid argument: Invalid target_state",
    "retry mutation with a supported target_state",
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: "target_state", value: targetState },
      expected: { kind: "allowed_values", allowed_values: [...RECORD_STATES] },
      argument_sources: { target_state: mutationArgumentSource(operation, "target_state") },
      retry_with: { argument: "target_state", value_placeholder: "canonical" }
    }
  );
}

function sourceIdentityValue(source: unknown, field: SourceIdentityField): unknown {
  return typeof source === "object" && source !== null && field in source
    ? (source as Partial<Record<SourceIdentityField, unknown>>)[field]
    : undefined;
}

function invalidSourceIdentityError(
  operation: MutationOperation,
  source: unknown,
  field: SourceIdentityField,
  recommendedAction: string
): MutationArgumentError {
  const metadata = SOURCE_IDENTITY_FIELDS[field];
  const action = field === "client" ? recommendedAction : "retry mutation with valid source metadata";
  return new MutationArgumentError(
    `Invalid argument: Invalid ${metadata.argument}`,
    action,
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: metadata.argument, value: sourceIdentityValue(source, field) },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { [metadata.argument]: mutationArgumentSource(operation, metadata.argument) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
    }
  );
}

function invalidSourceUnknownFieldError(
  operation: MutationOperation,
  source: Record<string, unknown>,
  field: string
): MutationArgumentError {
  const retryField = closestIdentityField(field);
  const metadata = SOURCE_IDENTITY_FIELDS[retryField];
  return new MutationArgumentError(
    `Invalid argument: Unknown source.${field}`,
    "retry mutation with supported source metadata fields",
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: `source.${field}`, value: source[field] },
      expected: { kind: "known_object_field", allowed_fields: Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[] },
      argument_sources: { [metadata.argument]: mutationArgumentSource(operation, metadata.argument) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder },
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"]
    }
  );
}

function invalidGenericSourceIdentityError(
  source: unknown,
  field: SourceIdentityField,
  recommendedAction: string
): MutationArgumentError {
  const metadata = SOURCE_IDENTITY_FIELDS[field];
  const action = field === "client" ? recommendedAction : "retry with valid source metadata";
  return new MutationArgumentError(
    `Invalid argument: Invalid ${metadata.argument}`,
    action,
    {
      rejected_argument: { argument: metadata.argument, value: sourceIdentityValue(source, field) },
      expected: { kind: "non_empty_string", min_length: 1 },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
    }
  );
}

function closestIdentityField(field: string): SourceIdentityField {
  const normalized = normalizeIdentityFieldName(field);
  return (Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[])
    .sort((left, right) => {
      const leftScore = identityFieldSuggestionScore(normalized, normalizeIdentityFieldName(left));
      const rightScore = identityFieldSuggestionScore(normalized, normalizeIdentityFieldName(right));
      return rightScore - leftScore || left.localeCompare(right);
    })[0] ?? "client";
}

function normalizeIdentityFieldName(field: string): string {
  return field.replace(/[._-]/g, "").toLowerCase();
}

function identityFieldSuggestionScore(unknownField: string, knownField: string): number {
  if (unknownField === knownField) return Number.MAX_SAFE_INTEGER;
  const longest = Math.max(unknownField.length, knownField.length);
  if (longest === 0) return 0;
  return longestCommonSubsequenceLength(unknownField, knownField) / longest;
}

function longestCommonSubsequenceLength(left: string, right: string): number {
  const previous = Array(right.length + 1).fill(0) as number[];
  const current = Array(right.length + 1).fill(0) as number[];
  for (const leftCharacter of left) {
    for (let index = 0; index < right.length; index += 1) {
      current[index + 1] = leftCharacter === right[index]
        ? previous[index] + 1
        : Math.max(previous[index + 1] ?? 0, current[index] ?? 0);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }
  return previous[right.length] ?? 0;
}

type ReadArgumentRecoveryHint =
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: string };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "array_of_non_empty_strings" };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: string[] };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "array_of_allowed_values"; allowed_values: string[] };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: string[] };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: "limit"; value: unknown };
      expected: { kind: "integer_range"; min: 1; max: 100; integer: true };
      argument_sources: { limit: ReadArgumentSource };
      retry_with: { argument: "limit"; value_placeholder: 10 };
    }
  | {
      operation_contract: "operations_by_id.project_list";
      rejected_argument: { argument: AgentIdentityArgument; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<AgentIdentityArgument, ReadArgumentSource>;
      retry_with: { argument: AgentIdentityArgument; value_placeholder: string };
    };

class ReadArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: ReadArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: ReadArgumentRecoveryHint) {
    super(message);
    this.name = "ReadArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function readOperationContractSource(operation: ReadOperation): ReadOperationContractSource {
  return `operations_by_id.${operation}`;
}

function readArgumentSource(operation: ReadOperation, argument: string): ReadArgumentSource {
  return `operations_by_id.${operation}.arguments_by_name.${argument}`;
}

function invalidReadLimitError(operation: ReadOperation, limit: unknown): ReadArgumentError {
  return new ReadArgumentError(
    "Invalid argument: Invalid limit; must be an integer between 1 and 100",
    "retry read with a limit between 1 and 100",
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument: "limit", value: limit },
      expected: { kind: "integer_range", min: 1, max: 100, integer: true },
      argument_sources: { limit: readArgumentSource(operation, "limit") },
      retry_with: { argument: "limit", value_placeholder: 10 }
    }
  );
}

function readPlaceholder(name: string): string {
  return `<${name}>`;
}

function invalidReadStringError(operation: ReadOperation, name: string, value: unknown): ReadArgumentError {
  return new ReadArgumentError(
    `Invalid argument: Invalid ${name}`,
    `retry read with a non-empty ${name}`,
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument: name, value },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { [name]: readArgumentSource(operation, name) },
      retry_with: { argument: name, value_placeholder: readPlaceholder(name) }
    }
  );
}

function invalidReadStringArrayError(operation: ReadOperation, name: string, value: unknown): ReadArgumentError {
  const singular = name.endsWith("s") ? name.slice(0, -1) : name;
  return new ReadArgumentError(
    `Invalid argument: Invalid ${name}`,
    `retry read with ${name} as non-empty strings`,
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument: name, value },
      expected: { kind: "array_of_non_empty_strings" },
      argument_sources: { [name]: readArgumentSource(operation, name) },
      retry_with: { argument: name, value_placeholder: [readPlaceholder(singular)] }
    }
  );
}

function invalidReadEnumArrayError<T extends string>(
  operation: ReadOperation,
  name: string,
  value: unknown,
  allowedValues: readonly T[],
  placeholder: T
): ReadArgumentError {
  return new ReadArgumentError(
    `Invalid argument: Invalid ${name}`,
    `retry read with supported ${name}`,
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument: name, value },
      expected: { kind: "array_of_allowed_values", allowed_values: [...allowedValues] },
      argument_sources: { [name]: readArgumentSource(operation, name) },
      retry_with: { argument: name, value_placeholder: [placeholder] }
    }
  );
}

function agentIdentityValue(agent: unknown, field: AgentIdentityField): unknown {
  return typeof agent === "object" && agent !== null && field in agent
    ? (agent as Partial<Record<AgentIdentityField, unknown>>)[field]
    : undefined;
}

function invalidProjectListAgentIdentityError(agent: unknown, field: AgentIdentityField): ReadArgumentError {
  const metadata = AGENT_IDENTITY_FIELDS[field];
  return new ReadArgumentError(
    `Invalid argument: Invalid ${metadata.argument}`,
    field === "client"
      ? "retry project_list with a valid agent client"
      : "retry project_list with valid agent identity metadata",
    {
      operation_contract: "operations_by_id.project_list",
      rejected_argument: { argument: metadata.argument, value: agentIdentityValue(agent, field) },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: {
        [metadata.argument]: readArgumentSource("project_list", metadata.contractArgument)
      },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
    }
  );
}

function validateProjectListAgent(agent: unknown): void {
  if (agent === undefined) return;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
    throw invalidProjectListAgentIdentityError(agent, "client");
  }
  const rawAgent = agent as Partial<Record<AgentIdentityField, unknown>>;
  for (const field of Object.keys(AGENT_IDENTITY_FIELDS) as AgentIdentityField[]) {
    const value = rawAgent[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw invalidProjectListAgentIdentityError(agent, field);
    }
  }
}

function validateRecordId(
  operation: MutationOperation,
  recordId: unknown,
  name: "record_id" | "linked_record_id" = "record_id"
): void {
  if (typeof recordId !== "string" || !recordId.length) {
    throw invalidMutationStringError(operation, name, recordId);
  }
}

function validateOptionalReason(operation: MutationOperation, reason: unknown): void {
  if (reason !== undefined && (typeof reason !== "string" || !reason.length)) {
    throw invalidMutationStringError(operation, "reason", reason);
  }
}

function validateOptionalSource(
  source: unknown,
  operation?: MutationOperation,
  recommendedAction = "retry with a valid source client"
): void {
  if (source === undefined) return;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    if (operation === undefined) {
      throw invalidGenericSourceIdentityError(source, "client", recommendedAction);
    }
    throw invalidSourceIdentityError(operation, source, "client", recommendedAction);
  }
  const rawSource = source as Partial<Record<SourceIdentityField, unknown>>;
  for (const field of Object.keys(source)) {
    if (!(field in SOURCE_IDENTITY_FIELDS) && operation !== undefined) {
      throw invalidSourceUnknownFieldError(operation, source as Record<string, unknown>, field);
    }
  }
  for (const field of Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[]) {
    const value = rawSource[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      if (operation === undefined) {
        throw invalidGenericSourceIdentityError(source, field, recommendedAction);
      }
      throw invalidSourceIdentityError(operation, source, field, recommendedAction);
    }
  }
  if (rawSource.client === undefined) {
    if (operation === undefined) {
      throw invalidGenericSourceIdentityError(source, "client", recommendedAction);
    }
    throw invalidSourceIdentityError(operation, source, "client", recommendedAction);
  }
}

function validateOptionalConfirmed(operation: MutationOperation, confirmed: unknown): void {
  if (confirmed !== undefined && typeof confirmed !== "boolean") throw invalidMutationConfirmedError(operation, confirmed);
}

function validateOptionalString(operation: ReadOperation, value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.length)) {
    throw invalidReadStringError(operation, name, value);
  }
}

function validateOptionalStringArray(operation: ReadOperation, value: unknown, name: string): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0))) {
    throw invalidReadStringArrayError(operation, name, value);
  }
}

function validateOptionalEnumArray<T extends string>(
  operation: ReadOperation,
  value: unknown,
  name: string,
  schema: { safeParse: (value: unknown) => { success: boolean } },
  allowedValues: readonly T[],
  placeholder: T
): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every((item): item is T => schema.safeParse(item).success))) {
    throw invalidReadEnumArrayError(operation, name, value, allowedValues, placeholder);
  }
}

type WriteContentRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "content"; value: unknown };
      expected: { kind: "content_object" | "non_empty_content_object"; required: true };
      argument_sources: { content: typeof WRITE_CONTENT_ARGUMENT_SOURCE };
      retry_with: { argument: "content"; value_placeholder: { text: "<text>"; format: "text" } };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "content.text"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: { "content.text": typeof WRITE_CONTENT_TEXT_ARGUMENT_SOURCE };
      retry_with: { argument: "content.text"; value_placeholder: "<non-empty text>" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "content.format"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: ["text", "json"] };
      argument_sources: { "content.format": typeof WRITE_CONTENT_FORMAT_ARGUMENT_SOURCE };
      retry_with: { argument: "content.format"; value_placeholder: "text" };
    };

class WriteContentError extends Error {
  readonly recommended_action = "retry write with valid content";
  readonly recovery_hint: WriteContentRecoveryHint;

  constructor(message: string, recoveryHint: WriteContentRecoveryHint) {
    super(message);
    this.name = "WriteContentError";
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteContentError(content: unknown, expectedKind: "content_object" | "non_empty_content_object"): WriteContentError {
  return new WriteContentError(
    "Invalid argument: Invalid content",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "content", value: content },
      expected: { kind: expectedKind, required: true },
      argument_sources: { content: WRITE_CONTENT_ARGUMENT_SOURCE },
      retry_with: { argument: "content", value_placeholder: { text: "<text>", format: "text" } }
    }
  );
}

function invalidWriteContentTextError(text: unknown): WriteContentError {
  return new WriteContentError(
    "Invalid argument: Invalid content.text",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "content.text", value: text },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { "content.text": WRITE_CONTENT_TEXT_ARGUMENT_SOURCE },
      retry_with: { argument: "content.text", value_placeholder: "<non-empty text>" }
    }
  );
}

function invalidWriteContentFormatError(format: unknown): WriteContentError {
  return new WriteContentError(
    "Invalid argument: Invalid content.format",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "content.format", value: format },
      expected: { kind: "allowed_values", allowed_values: ["text", "json"] },
      argument_sources: { "content.format": WRITE_CONTENT_FORMAT_ARGUMENT_SOURCE },
      retry_with: { argument: "content.format", value_placeholder: "text" }
    }
  );
}

type WriteCoreFieldRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "kind"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { kind: typeof WRITE_KIND_ARGUMENT_SOURCE };
      retry_with: { argument: "kind"; value_placeholder: "memory" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "scope"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { scope: typeof WRITE_SCOPE_ARGUMENT_SOURCE };
      retry_with: { argument: "scope"; value_placeholder: "project" };
    }
  | {
      rejected_argument: { argument: "type" | "project_id"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      argument_sources: Partial<{
        type: typeof WRITE_TYPE_ARGUMENT_SOURCE;
        project_id: typeof WRITE_PROJECT_ID_ARGUMENT_SOURCE;
      }>;
      retry_with: { argument: "type" | "project_id"; value_placeholder: string };
    };

class WriteCoreFieldError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteCoreFieldRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: WriteCoreFieldRecoveryHint) {
    super(message);
    this.name = "WriteCoreFieldError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteKindError(kind: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError(
    "Invalid argument: Invalid kind",
    "retry write with a supported kind",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "kind", value: kind },
      expected: { kind: "allowed_values", allowed_values: [...RECORD_KINDS] },
      argument_sources: { kind: WRITE_KIND_ARGUMENT_SOURCE },
      retry_with: { argument: "kind", value_placeholder: "memory" }
    }
  );
}

function invalidWriteTypeError(type: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError(
    "Invalid argument: Invalid type",
    "retry write with a non-empty type",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "type", value: type },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { type: WRITE_TYPE_ARGUMENT_SOURCE },
      retry_with: { argument: "type", value_placeholder: "<record type>" }
    }
  );
}

function invalidWriteScopeError(scope: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError(
    "Invalid argument: Invalid scope",
    "retry write with a supported scope",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "scope", value: scope },
      expected: { kind: "allowed_values", allowed_values: [...RECORD_SCOPES] },
      argument_sources: { scope: WRITE_SCOPE_ARGUMENT_SOURCE },
      retry_with: { argument: "scope", value_placeholder: "project" }
    }
  );
}

function invalidWriteProjectIdError(projectId: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError(
    "Invalid argument: Invalid project_id",
    "retry write with a valid project_id",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "project_id", value: projectId },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { project_id: WRITE_PROJECT_ID_ARGUMENT_SOURCE },
      retry_with: { argument: "project_id", value_placeholder: "<project_id>" }
    }
  );
}

type WriteTagsRecoveryHint = {
  operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
  rejected_argument: { argument: "tags"; value: unknown };
  expected: { kind: "array_of_non_empty_strings" };
  argument_sources: { tags: typeof WRITE_TAGS_ARGUMENT_SOURCE };
  retry_with: { argument: "tags"; value_placeholder: ["<tag>"] };
};

class WriteTagsError extends Error {
  readonly recommended_action = "retry write with valid tags";
  readonly recovery_hint: WriteTagsRecoveryHint;

  constructor(tags: unknown) {
    super("Invalid argument: Invalid tags");
    this.name = "WriteTagsError";
    this.recovery_hint = {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "tags", value: tags },
      expected: { kind: "array_of_non_empty_strings" },
      argument_sources: { tags: WRITE_TAGS_ARGUMENT_SOURCE },
      retry_with: { argument: "tags", value_placeholder: ["<tag>"] }
    };
  }
}

type WriteSourceArgumentSource =
  | typeof WRITE_SOURCE_CLIENT_ARGUMENT_SOURCE
  | typeof WRITE_SOURCE_SESSION_ID_ARGUMENT_SOURCE
  | typeof WRITE_SOURCE_MODEL_ARGUMENT_SOURCE
  | typeof WRITE_SOURCE_DEVICE_ID_ARGUMENT_SOURCE;

type WriteSourceRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: SourceIdentityArgument; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Partial<Record<SourceIdentityArgument, WriteSourceArgumentSource>>;
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: `source.${string}`; value: unknown };
      expected: { kind: "known_object_field"; allowed_fields: SourceIdentityField[] };
      argument_sources: Partial<Record<SourceIdentityArgument, WriteSourceArgumentSource>>;
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"];
    };

class WriteSourceError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteSourceRecoveryHint;

  constructor(source: unknown, field: SourceIdentityField) {
    const metadata = SOURCE_IDENTITY_FIELDS[field];
    super(`Invalid argument: Invalid ${metadata.argument}`);
    this.name = "WriteSourceError";
    this.recommended_action = field === "client"
      ? "retry write with a valid source client"
      : "retry write with valid source metadata";
    this.recovery_hint = {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: metadata.argument, value: sourceIdentityValue(source, field) },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { [metadata.argument]: writeSourceArgumentSource(field) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
    };
  }
}

class WriteUnknownSourceFieldError extends Error {
  readonly recommended_action = "retry write with supported source metadata fields";
  readonly recovery_hint: WriteSourceRecoveryHint;

  constructor(source: Record<string, unknown>, field: string) {
    const retryField = closestIdentityField(field);
    const metadata = SOURCE_IDENTITY_FIELDS[retryField];
    super(`Invalid argument: Unknown source.${field}`);
    this.name = "WriteUnknownSourceFieldError";
    this.recovery_hint = {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: `source.${field}`, value: source[field] },
      expected: { kind: "known_object_field", allowed_fields: Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[] },
      argument_sources: { [metadata.argument]: writeSourceArgumentSource(retryField) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder },
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"]
    };
  }
}

function writeSourceArgumentSource(field: SourceIdentityField): WriteSourceArgumentSource {
  switch (field) {
    case "client":
      return WRITE_SOURCE_CLIENT_ARGUMENT_SOURCE;
    case "session_id":
      return WRITE_SOURCE_SESSION_ID_ARGUMENT_SOURCE;
    case "model":
      return WRITE_SOURCE_MODEL_ARGUMENT_SOURCE;
    case "device_id":
      return WRITE_SOURCE_DEVICE_ID_ARGUMENT_SOURCE;
  }
}

type WriteMetadataRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "state"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { state: typeof WRITE_STATE_ARGUMENT_SOURCE };
      retry_with: { argument: "state"; value_placeholder: "candidate" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "priority"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { priority: typeof WRITE_PRIORITY_ARGUMENT_SOURCE };
      retry_with: { argument: "priority"; value_placeholder: "normal" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "confidence"; value: unknown };
      expected: { kind: "number_range"; min: 0; max: 1; inclusive: true };
      argument_sources: { confidence: typeof WRITE_CONFIDENCE_ARGUMENT_SOURCE };
      retry_with: { argument: "confidence"; value_placeholder: 0.5 };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "confirmed"; value: unknown };
      expected: { kind: "boolean" };
      argument_sources: { confirmed: typeof WRITE_CONFIRMED_ARGUMENT_SOURCE };
      retry_with: { argument: "confirmed"; value_placeholder: true };
    };

class WriteMetadataError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteMetadataRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: WriteMetadataRecoveryHint) {
    super(message);
    this.name = "WriteMetadataError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteStateError(state: unknown): WriteMetadataError {
  return new WriteMetadataError(
    "Invalid argument: Invalid state",
    "retry write with a supported state",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "state", value: state },
      expected: { kind: "allowed_values", allowed_values: [...RECORD_STATES] },
      argument_sources: { state: WRITE_STATE_ARGUMENT_SOURCE },
      retry_with: { argument: "state", value_placeholder: "candidate" }
    }
  );
}

function invalidWriteConfidenceError(confidence: unknown): WriteMetadataError {
  return new WriteMetadataError(
    "Invalid argument: Invalid confidence",
    "retry write with confidence between 0 and 1",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "confidence", value: confidence },
      expected: { kind: "number_range", min: 0, max: 1, inclusive: true },
      argument_sources: { confidence: WRITE_CONFIDENCE_ARGUMENT_SOURCE },
      retry_with: { argument: "confidence", value_placeholder: 0.5 }
    }
  );
}

function invalidWritePriorityError(priority: unknown): WriteMetadataError {
  return new WriteMetadataError(
    "Invalid argument: Invalid priority",
    "retry write with a supported priority",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "priority", value: priority },
      expected: { kind: "allowed_values", allowed_values: [...RECORD_PRIORITIES] },
      argument_sources: { priority: WRITE_PRIORITY_ARGUMENT_SOURCE },
      retry_with: { argument: "priority", value_placeholder: "normal" }
    }
  );
}

function invalidWriteConfirmedError(confirmed: unknown): WriteMetadataError {
  return new WriteMetadataError(
    "Invalid argument: Invalid confirmed",
    "retry write with a boolean confirmed value",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "confirmed", value: confirmed },
      expected: { kind: "boolean" },
      argument_sources: { confirmed: WRITE_CONFIRMED_ARGUMENT_SOURCE },
      retry_with: { argument: "confirmed", value_placeholder: true }
    }
  );
}

type WriteProvenanceRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance"; value: unknown };
      expected: { kind: "object"; required: false };
      argument_sources: { provenance: typeof WRITE_PROVENANCE_ARGUMENT_SOURCE };
      retry_with: {
        argument: "provenance";
        value_placeholder: { derived_from: ["<record_id>"]; reason: "<reason>" };
      };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.derived_from"; value: unknown };
      expected: { kind: "array_of_non_empty_strings" };
      argument_sources: {
        "provenance.derived_from": typeof WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE;
      };
      retry_with: { argument: "provenance.derived_from"; value_placeholder: ["<record_id>"] };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.reason"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: { "provenance.reason": typeof WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE };
      retry_with: { argument: "provenance.reason"; value_placeholder: "<reason>" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.method"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { "provenance.method": typeof WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE };
      retry_with: { argument: "provenance.method"; value_placeholder: "agent-proposed" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.promoted_at"; value: unknown };
      expected: { kind: "iso_datetime"; format: "RFC3339 timestamp with timezone" };
      argument_sources: {
        "provenance.promoted_at": typeof WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE;
      };
      retry_with: { argument: "provenance.promoted_at"; value_placeholder: "<ISO datetime>" };
    };

class WriteProvenanceError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteProvenanceRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: WriteProvenanceRecoveryHint) {
    super(message);
    this.name = "WriteProvenanceError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteProvenanceError(provenance: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance",
    "retry write with a valid provenance object",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance", value: provenance },
      expected: { kind: "object", required: false },
      argument_sources: { provenance: WRITE_PROVENANCE_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance", value_placeholder: { derived_from: ["<record_id>"], reason: "<reason>" } }
    }
  );
}

function invalidWriteProvenanceDerivedFromError(derivedFrom: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.derived_from",
    "retry write with valid provenance source record ids",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.derived_from", value: derivedFrom },
      expected: { kind: "array_of_non_empty_strings" },
      argument_sources: { "provenance.derived_from": WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.derived_from", value_placeholder: ["<record_id>"] }
    }
  );
}

function invalidWriteProvenanceReasonError(reason: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.reason",
    "retry write with a non-empty provenance reason",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.reason", value: reason },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { "provenance.reason": WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.reason", value_placeholder: "<reason>" }
    }
  );
}

function invalidWriteProvenanceMethodError(method: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.method",
    "retry write with a supported provenance method",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.method", value: method },
      expected: { kind: "allowed_values", allowed_values: [...PROVENANCE_METHODS] },
      argument_sources: { "provenance.method": WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.method", value_placeholder: "agent-proposed" }
    }
  );
}

function invalidWriteProvenancePromotedAtError(promotedAt: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.promoted_at",
    "retry write with a valid provenance timestamp",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.promoted_at", value: promotedAt },
      expected: { kind: "iso_datetime", format: "RFC3339 timestamp with timezone" },
      argument_sources: { "provenance.promoted_at": WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.promoted_at", value_placeholder: "<ISO datetime>" }
    }
  );
}

function validateWriteInput(input: WriteInput): void {
  assertPlainObject(input, "write input");
  if (!recordKindSchema.safeParse(input.kind).success) throw invalidWriteKindError(input.kind);
  if (typeof input.type !== "string" || !input.type.length) throw invalidWriteTypeError(input.type);
  if (!recordScopeSchema.safeParse(input.scope).success) throw invalidWriteScopeError(input.scope);
  if (input.project_id !== undefined && (typeof input.project_id !== "string" || !input.project_id.length)) {
    throw invalidWriteProjectIdError(input.project_id);
  }
  if (input.scope === "project" && input.project_id === undefined) {
    throw new Error("Invalid argument: project_id is required for project scope");
  }
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string" && tag.length > 0))) {
    throw new WriteTagsError(input.tags);
  }
  if (typeof input.content !== "object" || input.content === null || Array.isArray(input.content)) {
    throw invalidWriteContentError(input.content, "content_object");
  }
  const content = input.content as Record<string, unknown> & { text?: unknown; format?: unknown };
  if (Object.keys(content).length === 0) {
    throw invalidWriteContentError(content, "non_empty_content_object");
  }
  if (content.text !== undefined && (typeof content.text !== "string" || !content.text.length)) {
    throw invalidWriteContentTextError(content.text);
  }
  if (content.format !== undefined && content.format !== "text" && content.format !== "json") {
    throw invalidWriteContentFormatError(content.format);
  }
  if (input.state !== undefined && !recordStateSchema.safeParse(input.state).success) throw invalidWriteStateError(input.state);
  if (input.confidence !== undefined && (typeof input.confidence !== "number" || !Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw invalidWriteConfidenceError(input.confidence);
  }
  if (input.priority !== undefined && !recordPrioritySchema.safeParse(input.priority).success) throw invalidWritePriorityError(input.priority);
  if (typeof input.source === "object" && input.source !== null && !Array.isArray(input.source)) {
    const sourceRecord = input.source as unknown as Record<string, unknown>;
    const unknownField = Object.keys(sourceRecord).find((field) => !(field in SOURCE_IDENTITY_FIELDS));
    if (unknownField !== undefined) {
      throw new WriteUnknownSourceFieldError(sourceRecord, unknownField);
    }
  }
  try {
    validateOptionalSource(input.source);
  } catch (error) {
    if (error instanceof MutationArgumentError) {
      if (error.recovery_hint.expected.kind === "known_object_field" && typeof input.source === "object" && input.source !== null && !Array.isArray(input.source)) {
        const field = error.recovery_hint.rejected_argument.argument.slice("source.".length);
        throw new WriteUnknownSourceFieldError(input.source as unknown as Record<string, unknown>, field);
      }
      const argument = error.recovery_hint.rejected_argument.argument;
      const field = argument.slice("source.".length) as SourceIdentityField;
      throw new WriteSourceError(input.source, field);
    }
    throw error;
  }
  if (input.confirmed !== undefined && typeof input.confirmed !== "boolean") throw invalidWriteConfirmedError(input.confirmed);
  if (input.provenance !== undefined) {
    if (typeof input.provenance !== "object" || input.provenance === null || Array.isArray(input.provenance)) {
      throw invalidWriteProvenanceError(input.provenance);
    }
    const provenance = input.provenance as Partial<RecordProvenance>;
    if (provenance.derived_from !== undefined && (!Array.isArray(provenance.derived_from) || !provenance.derived_from.every((recordId) => typeof recordId === "string" && recordId.length > 0))) {
      throw invalidWriteProvenanceDerivedFromError(provenance.derived_from);
    }
    if (provenance.reason !== undefined && (typeof provenance.reason !== "string" || !provenance.reason.length)) {
      throw invalidWriteProvenanceReasonError(provenance.reason);
    }
    if (
      provenance.method !== undefined
      && provenance.method !== "agent-proposed"
      && provenance.method !== "rule-promoted"
      && provenance.method !== "user-confirmed"
    ) {
      throw invalidWriteProvenanceMethodError(provenance.method);
    }
    if (
      provenance.promoted_at !== undefined
      && !isoDateTimeSchema.safeParse(provenance.promoted_at).success
    ) {
      throw invalidWriteProvenancePromotedAtError(provenance.promoted_at);
    }
  }
}

function validateRevisionInput(input: RevisionInput): void {
  assertPlainObject(input, "revise input");
  validateRecordId("revise", input.record_id);
  if (typeof input.patch !== "object" || input.patch === null || Array.isArray(input.patch)) {
    throw invalidRevisionPatchShapeError(input.patch, "patch_object");
  }
  const patch = input.patch as Record<string, unknown>;
  if (Object.keys(patch).length === 0) {
    throw emptyRevisionPatchError(patch);
  }
  const invalidPath = Object.keys(patch).find((path) => !isValidPatchPath(path));
  if (invalidPath !== undefined) {
    throw invalidRevisionPatchPathError(invalidPath, patch[invalidPath]);
  }
  validateOptionalReason("revise", input.reason);
  validateOptionalSource(input.source, "revise", "retry mutation with a valid source client");
  validateOptionalConfirmed("revise", input.confirmed);
}

function validatePromoteInput(input: PromoteInput): void {
  assertPlainObject(input, "promote input");
  validateRecordId("promote", input.record_id);
  if (!recordStateSchema.safeParse(input.target_state).success) {
    throw invalidMutationTargetStateError("promote", input.target_state);
  }
  validateOptionalReason("promote", input.reason);
  validateOptionalSource(input.source, "promote", "retry mutation with a valid source client");
  validateOptionalConfirmed("promote", input.confirmed);
}

function validateStateChangeInput(input: StateChangeInput, name: string, operation: "archive" | "quarantine"): void {
  assertPlainObject(input, name);
  validateRecordId(operation, input.record_id);
  validateOptionalReason(operation, input.reason);
  validateOptionalSource(input.source, operation, "retry mutation with a valid source client");
}

function validateLinkInput(input: LinkInput): void {
  assertPlainObject(input, "link input");
  validateRecordId("link", input.record_id);
  validateRecordId("link", input.linked_record_id, "linked_record_id");
  if (typeof input.link_type !== "string" || !input.link_type.length) {
    throw invalidMutationStringError("link", "link_type", input.link_type);
  }
  validateOptionalSource(input.source, "link", "retry mutation with a valid source client");
}

function validateRecallInput(input: RecallInput): void {
  assertPlainObject(input, "recall input");
  validateOptionalStringArray("recall", input.record_ids, "record_ids");
  validateOptionalString("recall", input.query, "query");
  validateOptionalString("recall", input.project_id, "project_id");
  validateOptionalEnumArray<RecordKind>("recall", input.kinds, "kinds", recordKindSchema, RECORD_KINDS, "memory");
  validateOptionalEnumArray<RecordScope>("recall", input.scopes, "scopes", recordScopeSchema, RECORD_SCOPES, "project");
  validateOptionalStringArray("recall", input.types, "types");
  validateOptionalEnumArray<RecordState>("recall", input.states, "states", recordStateSchema, RECORD_STATES, "canonical");
  validateOptionalStringArray("recall", input.tags, "tags");
  validateOptionalStringArray("recall", input.files, "files");
}

function validateBootInput(input: BootInput): void {
  assertPlainObject(input, "boot input");
  validateOptionalString("boot", input.project_id, "project_id");
  validateOptionalStringArray("boot", input.default_skills, "default_skills");
  validateOptionalString("boot", input.current_task, "current_task");
  validateOptionalString("boot", input.sync_remote, "sync_remote");
}

function validateRefreshInput(input: RefreshInput): void {
  assertPlainObject(input, "refresh input");
  validateOptionalString("refresh", input.project_id, "project_id");
  validateOptionalString("refresh", input.cursor, "cursor");
  const cursor = input.cursor;
  if (typeof cursor === "string" && !isoDateTimeSchema.safeParse(cursor).success) {
    throw new InvalidRefreshCursorError(cursor);
  }
  validateOptionalString("refresh", input.current_task, "current_task");
}

function validateListProjectsInput(input: ListProjectsInput): void {
  assertPlainObject(input, "list projects input");
  validateOptionalString("project_list", input.current_task, "current_task");
  validateOptionalString("project_list", input.sync_remote, "sync_remote");
  validateProjectListAgent(input.agent);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendCommandOption(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined) return;
  parts.push(name, shellQuote(value));
}

function projectStartArguments(projectId: string, input: ValidatedListProjectsInput): {
  project_id: string;
  sync_remote?: string;
  current_task?: string;
  agent?: ProjectListAgent;
} {
  return {
    project_id: projectId,
    sync_remote: input.sync_remote,
    current_task: input.current_task,
    agent: input.agent
  };
}

function projectStartCommand(projectId: string, input: ValidatedListProjectsInput): string {
  const parts = ["moryn", "agent", "start"];
  appendCommandOption(parts, "--project-id", projectId);
  appendCommandOption(parts, "--sync-remote", input.sync_remote);
  appendCommandOption(parts, "--current-task", input.current_task);
  appendCommandOption(parts, "--agent", input.agent?.client);
  appendCommandOption(parts, "--session-id", input.agent?.session_id);
  appendCommandOption(parts, "--model", input.agent?.model);
  appendCommandOption(parts, "--device-id", input.agent?.device_id);
  return parts.join(" ");
}

function recallRecordCommand(recordId: string, projectId: string | undefined): string {
  const parts = ["moryn", "recall"];
  appendCommandOption(parts, "--record-id", recordId);
  appendCommandOption(parts, "--project-id", projectId);
  return parts.join(" ");
}

function refreshChangeNextAction(record: MorynRecord, input: RefreshInput) {
  return withRefreshChangeNextActionMetadata({
    recommended_action: "call_recall_with_record_id",
    tool: "recall",
    safe_to_run: true,
    required_when: RECALL_REFRESH_CHANGE_WHEN,
    required_fields: [],
    command: recallRecordCommand(record.id, input.project_id),
    arguments: {
      record_ids: [record.id],
      ...(input.project_id ? { project_id: input.project_id } : {})
    },
    argument_sources: {
      record_ids: "refresh.changes_by_record_id.<record_id>.record_id"
    }
  });
}

function matchesAny(values: string[], filters: string[] | undefined): boolean {
  return !filters?.length || filters.some((filter) => values.includes(filter));
}

function recordProjectMatches(record: MorynRecord, projectId: string | undefined): boolean {
  return !projectId || record.project_id === projectId || record.scope === "global";
}

function recordBootContextMatches(record: MorynRecord, projectId: string | undefined): boolean {
  return record.scope === "global" || (Boolean(projectId) && record.project_id === projectId);
}

function recordProjectMatchesRecall(record: MorynRecord, input: ValidatedRecallInput): boolean {
  return Boolean(input.record_ids?.length) || recordProjectMatches(record, input.project_id);
}

function isVisibleByDefault(record: MorynRecord): boolean {
  return record.state !== "archived" && record.state !== "quarantined";
}

function isTrustedForBoot(record: MorynRecord): boolean {
  return record.state === "canonical";
}

function includesHiddenState(input: ValidatedRecallInput): boolean {
  return input.states?.some((state) => state === "archived" || state === "quarantined") ?? false;
}

function includesRawState(input: ValidatedRecallInput): boolean {
  return input.states?.includes("raw") ?? false;
}

function isVisibleInDefaultRecall(record: MorynRecord): boolean {
  return isVisibleByDefault(record) && record.state !== "raw";
}

function skillMatchesSelector(record: MorynRecord, selector: string): boolean {
  const normalized = selector.toLowerCase();
  return record.id === selector
    || record.type.toLowerCase() === normalized
    || record.tags.some((tag) => tag.toLowerCase() === normalized)
    || String(record.content.name ?? "").toLowerCase() === normalized
    || searchableText(record).toLowerCase().includes(normalized);
}

function isProjectSkill(record: MorynRecord, projectId: string | undefined): boolean {
  return record.kind === "skill"
    && Boolean(projectId)
    && (record.project_id === projectId || record.tags.includes(projectId as string));
}

function bootSkills(records: MorynRecord[], input: ValidatedBootInput): MorynRecord[] {
  const selectors = input.default_skills ?? [];
  const selected = records.filter((record) => record.kind === "skill" && (
    isProjectSkill(record, input.project_id)
    || selectors.some((selector) => skillMatchesSelector(record, selector))
  ));
  return [...new Map(selected.map((record) => [record.id, record])).values()];
}

function projectMemory(records: MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return records.filter((record) => record.kind === "memory" && record.scope === "project" && record.project_id === projectId);
}

function projectScopedRecords(records: MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return records.filter((record) => record.scope === "project" && record.project_id === projectId);
}

function boundedBootTexts(records: MorynRecord[], limit = 5): string[] {
  const texts: string[] = [];
  for (const record of boundedBootRecords(records, records.length)) {
    const text = textOf(record);
    if (text && !texts.includes(text)) texts.push(text);
    if (texts.length >= limit) break;
  }
  return texts;
}

function isImportantBootRecent(record: MorynRecord): boolean {
  if (record.kind === "session_summary") return record.state !== "raw";
  return (record.kind === "memory" || record.kind === "skill")
    && (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75));
}

function bootPriorityScore(record: MorynRecord): number {
  return (record.priority === "high" ? 100 : 0) + recallSourceTrust(record).score;
}

function boundedBootRecords(records: MorynRecord[], limit = 5): MorynRecord[] {
  return [...records]
    .sort((a, b) => (bootPriorityScore(b) - bootPriorityScore(a)) || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function recordsById(records: MorynRecord[]): Record<string, MorynRecord> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

function recallTypePriority(type: string): { score: number; reason: string } | undefined {
  const normalized = type.toLowerCase();
  if (normalized === "blocker" || normalized === "warning" || normalized === "conflict") return { score: 4, reason: `type_priority:${normalized}` };
  if (normalized === "decision") return { score: 3, reason: "type_priority:decision" };
  if (normalized === "preference") return { score: 2, reason: "type_priority:preference" };
  if (normalized === "summary" || normalized === "project_summary") return { score: 1, reason: "type_priority:summary" };
  return undefined;
}

function recallSourceTrust(record: MorynRecord): { score: number; reason: string } {
  const method = record.provenance?.method ?? provenanceMethod(record.source);
  if (method === "user-confirmed") return { score: 3, reason: "source_trust:user-confirmed" };
  if (method === "rule-promoted") return { score: 2, reason: "source_trust:rule-promoted" };
  return { score: 1, reason: "source_trust:agent-proposed" };
}

type ValidatedRecallInput = RecallInput & {
  record_ids?: string[];
  query?: string;
  kinds?: RecordKind[];
  scopes?: RecordScope[];
  types?: string[];
  states?: RecordState[];
  tags?: string[];
  files?: string[];
};

function reasonAndScore(record: MorynRecord, input: ValidatedRecallInput): { score: number; reason: string[] } {
  let score = 0;
  const reason: string[] = [];

  if (input.record_ids?.includes(record.id)) {
    score += 100;
    reason.push("record_id_match");
  }
  if (input.project_id && record.project_id === input.project_id) {
    score += 10;
    reason.push("same_project");
  } else if (record.scope === "global") {
    score += 4;
    reason.push("global");
  } else {
    reason.push(record.scope);
  }
  if (record.state === "canonical") {
    score += 8;
    reason.push("canonical");
  } else if (record.state === "candidate") {
    const highConfidence = record.confidence >= 0.75;
    score += highConfidence ? 6 : 4;
    reason.push(highConfidence ? "high_confidence_candidate" : "candidate");
  } else {
    reason.push(record.state);
  }
  if (record.priority === "high") {
    score += 5;
    reason.push("high_priority");
  }
  const typePriority = recallTypePriority(record.type);
  if (typePriority) {
    score += typePriority.score;
    reason.push(typePriority.reason);
  }
  const sourceTrust = recallSourceTrust(record);
  score += sourceTrust.score;
  reason.push(sourceTrust.reason);
  for (const tag of input.tags ?? []) {
    if (record.tags.includes(tag)) {
      score += 5;
      reason.push(`tag_match:${tag}`);
    }
  }
  for (const file of input.files ?? []) {
    const haystack = `${searchableText(record)} ${record.tags.join(" ")}`.toLowerCase();
    if (haystack.includes(file.toLowerCase())) {
      score += 6;
      reason.push(`file_match:${file}`);
    }
  }
  if (input.query) {
    const haystack = `${searchableText(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
    for (const token of input.query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) {
        score += 3;
        reason.push(`text_match:${token}`);
      }
    }
  }
  return { score, reason: [...new Set(reason)] };
}

function matchesQuery(result: { reason: string[] }, input: ValidatedRecallInput): boolean {
  if (!input.query || input.record_ids?.length) return true;
  return result.reason.some((reason) => reason.startsWith("text_match:"));
}

function summarizeRecord(record: MorynRecord): string {
  return textOf(record) || `${record.kind}:${record.type}`;
}

function projectActivity(record: MorynRecord) {
  const currentTask = typeof record.content.current_task === "string" ? record.content.current_task : undefined;
  return {
    record_id: record.id,
    kind: record.kind,
    type: record.type,
    text: summarizeRecord(record),
    current_task: currentTask,
    updated_at: record.updated_at,
    agent: record.source
  };
}

function projectSummary(records: MorynRecord[]): string {
  const summary = [...records]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .find((record) => record.type === "summary" || record.type === "project_summary");
  return summary ? textOf(summary) : "";
}

function taskTokens(task: string | undefined): string[] {
  const stopWords = new Set(["add", "build", "check", "debug", "fix", "for", "from", "implement", "make", "path", "project", "the", "this", "use", "with"]);
  return (task ?? "")
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !stopWords.has(token));
}

function matchesCurrentTask(record: MorynRecord, currentTask: string | undefined): boolean {
  const tokens = taskTokens(currentTask);
  if (!tokens.length) return false;
  const haystack = `${searchableText(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  return matches >= Math.min(2, tokens.length);
}

function nextMutationTimestamp(record: MorynRecord, candidate: string): string {
  const candidateTime = Date.parse(candidate);
  const previousTime = Date.parse(record.updated_at);
  if (Number.isFinite(candidateTime) && candidateTime > previousTime) return new Date(candidateTime).toISOString();
  return new Date(previousTime + 1).toISOString();
}

function refreshImportance(record: MorynRecord, currentTask: string | undefined): { importance: "silent" | "notice" | "interrupt"; reason?: string } {
  if (record.state === "raw" || record.kind === "agent_note") return { importance: "silent" };
  if (record.kind === "session_summary") return { importance: "notice" };
  const interruptCandidate = record.type === "blocker" || record.type === "warning" || record.type === "conflict" || record.priority === "high";
  if (interruptCandidate) {
    if (!currentTask) return { importance: "interrupt" };
    if (matchesCurrentTask(record, currentTask)) return { importance: "interrupt", reason: "current_task_match" };
    return { importance: "silent" };
  }
  if (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75)) return { importance: "notice" };
  return { importance: "silent" };
}

function isSensitiveKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[.[\]_-]+/)
    .filter(Boolean)
    .map((segment) => segment.toUpperCase());
  const joinedSegments = segments.join("_");
  if (
    segments.includes("AUTHORIZATION")
    || segments.includes("COOKIE")
    || joinedSegments.endsWith("AUTH_HEADER")
    || joinedSegments.endsWith("SET_COOKIE")
  ) {
    return true;
  }
  return /(?:API[_-]?KEY|DATABASE_URL|REDIS_URL|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)/i.test(key);
}

function redactSensitiveValue(value: unknown, keyPath?: string): unknown {
  if (typeof value === "string") {
    return keyPath && isSensitiveKey(keyPath) ? "[REDACTED_SECRET]" : redactSensitiveContent(value);
  }
  if (Array.isArray(value)) return value.map((item, index) => redactSensitiveValue(item, keyPath ? `${keyPath}.${index}` : String(index)));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      return [key, redactSensitiveValue(nested, nextPath)];
    }));
  }
  return value;
}

function redactSensitiveRecordContent<T extends Record<string, unknown>>(content: T): T {
  return redactSensitiveValue(content) as T;
}

function redactSensitivePatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([path, value]) => [path, redactSensitiveValue(value, path)]));
}

const managedRevisionFields = new Set([
  "id",
  "kind",
  "scope",
  "state",
  "visibility",
  "created_at",
  "updated_at",
  "source",
  "provenance",
  "conflict",
  "links"
]);

const MANAGED_REVISION_FIELDS = [...managedRevisionFields];

type RevisionPatchRecoveryHint =
  | {
      rejected_patch: { patch: unknown };
      expected: { kind: "patch_object" | "non_empty_patch" | "valid_record_after_patch" };
      retry_with: { patch_placeholder: Record<string, string> };
    }
  | {
      rejected_patch: { path: string; value: unknown };
      expected: { kind: "valid_patch_path"; format: "dot-separated record field path" };
      retry_with: { patch_path_placeholder: "content.text" };
    }
  | {
      rejected_patch: { path: string; value: unknown };
      expected: { kind: "user_editable_patch"; managed_fields: string[] };
      retry_with: { remove_patch_path: string; use_operation?: "promote"; operation_arguments?: Record<string, unknown> };
    };

class RevisionPatchError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: RevisionPatchRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: RevisionPatchRecoveryHint) {
    super(message);
    this.name = "RevisionPatchError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidRevisionPatchShapeError(patch: unknown, expectedKind: "patch_object"): RevisionPatchError {
  return new RevisionPatchError(
    "Invalid argument: Invalid patch",
    "retry revise with a valid patch",
    {
      rejected_patch: { patch },
      expected: { kind: expectedKind },
      retry_with: { patch_placeholder: { "content.text": "<updated text>" } }
    }
  );
}

function emptyRevisionPatchError(patch: Record<string, unknown>): RevisionPatchError {
  return new RevisionPatchError(
    "Invalid argument: Invalid patch",
    "retry revise with a valid patch",
    {
      rejected_patch: { patch },
      expected: { kind: "non_empty_patch" },
      retry_with: { patch_placeholder: { "content.text": "<updated text>" } }
    }
  );
}

function invalidRevisionPatchPathError(path: string, value: unknown): RevisionPatchError {
  return new RevisionPatchError(
    "Invalid argument: Invalid patch",
    "retry revise with a valid patch",
    {
      rejected_patch: { path, value },
      expected: { kind: "valid_patch_path", format: "dot-separated record field path" },
      retry_with: { patch_path_placeholder: "content.text" }
    }
  );
}

function invalidRevisionRecordPatchError(patch: Record<string, unknown>, detail?: string): RevisionPatchError {
  return new RevisionPatchError(
    `Invalid argument: Invalid patch${detail ? `; ${detail}` : ""}`,
    "retry revise with a valid patch",
    {
      rejected_patch: { patch },
      expected: { kind: "valid_record_after_patch" },
      retry_with: { patch_placeholder: { "content.text": "<non-empty text>" } }
    }
  );
}

function managedRevisionFieldError(path: string, value: unknown, recordId: string): RevisionPatchError {
  const managedField = path.split(".")[0] as string;
  return new RevisionPatchError(
    `Invalid argument: revise cannot modify managed field ${managedField}`,
    "retry revise without managed fields",
    {
      rejected_patch: { path, value },
      expected: { kind: "user_editable_patch", managed_fields: MANAGED_REVISION_FIELDS },
      retry_with: {
        remove_patch_path: path,
        ...(managedField === "state"
          ? {
              use_operation: "promote" as const,
              operation_arguments: { record_id: recordId, target_state: value, confirmed: true }
            }
          : {})
      }
    }
  );
}

function isUserConfirmed(source: RecordSource, confirmed?: boolean): boolean {
  return confirmed === true || source.client === "user";
}

function provenanceMethod(source: RecordSource, confirmed?: boolean): "agent-proposed" | "rule-promoted" | "user-confirmed" {
  if (isUserConfirmed(source, confirmed)) return "user-confirmed";
  if (source.client === "moryn") return "rule-promoted";
  return "agent-proposed";
}

function promoteCandidateNextAction(recordId: string): MorynErrorNextAction {
  const reason = "User confirmed";
  const action = withNextActionMetadata({
    recommended_action: "ask_user_then_promote_candidate",
    tool: "promote",
    command: `${commandForPromoteContext({ record_id: recordId, target_state: "canonical", reason })} --confirm`,
    candidate_record_id: recordId,
    arguments: {
      record_id: recordId,
      target_state: "canonical",
      reason,
      confirmed: true
    },
    argument_sources: {
      record_id: WRITE_CANDIDATE_RECORD_ID_SOURCE
    },
    required_when: PROMOTE_CANDIDATE_WHEN,
    required_fields: [],
    safe_to_run: false
  });
  return {
    ...action,
    workflow: withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: ["error.next_action", "warning.next_action", WRITE_CANDIDATE_RECORD_ID_SOURCE],
      phases: [
        {
          ...action.workflow.phases[0]!,
          action_source: WRITE_CANDIDATE_RECORD_ID_SOURCE,
          required_fields: ["record_id"],
          replace_arguments: { record_id: WRITE_CANDIDATE_RECORD_ID_SOURCE }
        }
      ]
    })
  };
}

function requiresCanonicalConfirmation(input: { kind: RecordKind; type: string; scope: RecordScope }): boolean {
  if (input.kind === "soul") return true;
  if (input.kind === "skill" && input.scope === "global") return true;
  const type = input.type.toLowerCase();
  if (input.kind === "memory" && input.scope === "global" && type === "preference") return true;
  return type === "security_rule"
    || type === "deployment_rule"
    || type === "permission_rule"
    || type === "credential_rule"
    || (type === "rule" && input.scope === "global");
}

function textFromContent(content: Record<string, unknown> & { text?: string }): string {
  return searchableContentText(content).trim().toLowerCase();
}

function tagOverlap(left: string[], right: string[]): boolean {
  const genericProjectTags = new Set(["javascript", "mcp", "node", "nodejs", "python", "typescript"]);
  const rightTags = new Set(right.filter((tag) => !genericProjectTags.has(tag.toLowerCase())));
  return left.some((tag) => rightTags.has(tag) && !genericProjectTags.has(tag.toLowerCase()));
}

function subjectTokens(content: Record<string, unknown> & { text?: string }): string[] {
  const stopWords = new Set(["about", "after", "agent", "before", "from", "into", "only", "source", "that", "the", "this", "truth", "with"]);
  return textFromContent(content)
    .split(/\W+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !stopWords.has(token));
}

function subjectOverlap(left: Record<string, unknown> & { text?: string }, right: Record<string, unknown> & { text?: string }): boolean {
  const rightTokens = new Set(subjectTokens(right));
  const matches = subjectTokens(left).filter((token) => rightTokens.has(token));
  return new Set(matches).size >= 2;
}

function semanticConflicts(records: MorynRecord[], input: {
  id?: string;
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  tags?: string[];
  content: Record<string, unknown> & { text?: string };
}): MorynRecord[] {
  if (input.kind !== "memory") return [];
  const inputText = textFromContent(input.content);
  if (!inputText) return [];
  return records.filter((record) => record.state === "canonical")
    .filter((record) => record.id !== input.id)
    .filter((record) => record.kind === input.kind)
    .filter((record) => record.type === input.type)
    .filter((record) => record.scope === input.scope)
    .filter((record) => record.project_id === input.project_id)
    .filter((record) => tagOverlap(record.tags, input.tags ?? []) || subjectOverlap(record.content, input.content))
    .filter((record) => textFromContent(record.content) !== inputText);
}

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? createId;

  async function currentRecords(): Promise<MorynRecord[]> {
    return [...replayEvents(await readEvents(deps.storePath)).values()];
  }

  async function requireRecord(recordId: string): Promise<MorynRecord> {
    const record = replayEvents(await readEvents(deps.storePath)).get(recordId);
    if (!record) {
      throw new Error(`Record not found: ${recordId}`);
    }
    return record;
  }

  async function remoteHasUpdates(): Promise<boolean> {
    if (!deps.syncStatus) return false;
    try {
      const status = await deps.syncStatus();
      return Boolean(status.remote_has_updates || (status.behind ?? 0) > 0);
    } catch {
      return false;
    }
  }

  async function appendEventAndRebuild(event: MorynEvent): Promise<void> {
    await appendEvent(deps.storePath, event);
    await rebuildDerivedViews(deps.storePath);
  }

  const engine = {
    async write(input: WriteInput) {
      validateWriteInput(input);
      const writeInput = input as ValidatedWriteInput;
      const createdAt = now();
      const tags = Array.isArray(writeInput.tags) ? writeInput.tags : [];
      const inputContent = input.content as Record<string, unknown> & { text?: string; format?: "text" | "json" };
      const sensitive = detectSensitiveContent(sensitiveScanText(inputContent));
      const conflicts = sensitive.sensitive ? [] : semanticConflicts(await currentRecords(), { ...writeInput, tags, content: inputContent });
      const needsConflictConfirmation = writeInput.state === "canonical" && conflicts.length > 0 && !isUserConfirmed(writeInput.source, writeInput.confirmed);
      const needsConfirmation = writeInput.state === "canonical"
        && (requiresCanonicalConfirmation(writeInput) || conflicts.length > 0)
        && !isUserConfirmed(writeInput.source, writeInput.confirmed);
      const state = sensitive.sensitive
        ? "quarantined"
        : needsConfirmation
          ? "candidate"
          : (writeInput.state ?? (writeInput.kind === "agent_note" ? "raw" : "candidate"));
      const content = sensitive.sensitive ? redactSensitiveRecordContent(inputContent) : inputContent;
      const confidence = typeof writeInput.confidence === "number" ? writeInput.confidence : 0.5;
      const provenance = writeInput.provenance as RecordProvenance | undefined;
      const record: MorynRecord = {
        id: id("rec"),
        kind: writeInput.kind,
        type: writeInput.type,
        scope: writeInput.scope,
        project_id: writeInput.project_id,
        tags,
        content,
        state,
        confidence,
        priority: writeInput.priority ?? "normal",
        visibility: state === "quarantined" ? "quarantined" : state === "archived" ? "archived" : "active",
        created_at: createdAt,
        updated_at: createdAt,
        source: writeInput.source,
        provenance: {
          ...(provenance ?? {}),
          method: provenance?.method ?? provenanceMethod(writeInput.source, writeInput.confirmed)
        },
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined
      };
      const event: MorynEvent = { event_id: id("evt"), op: "upsert_record", record, created_at: createdAt, source: writeInput.source };
      await appendEventAndRebuild(event);
      const warning: EngineWarning | undefined = sensitive.sensitive
        ? { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason }
        : needsConfirmation
          ? {
              code: "CONFIRMATION_REQUIRED",
              reason: needsConflictConfirmation
                ? "conflicting canonical memory requires explicit user confirmation"
                : "canonical state requires explicit user confirmation",
              next_action: promoteCandidateNextAction(record.id)
            }
          : undefined;
      return {
        record,
        selection_sources: WRITE_SELECTION_SOURCES,
        warning
      };
    },

    async revise(input: RevisionInput) {
      validateRevisionInput(input);
      const revisionInput = input as ValidatedRevisionInput;
      const patch = input.patch as Record<string, unknown>;
      const record = await requireRecord(revisionInput.record_id);
      const managedPath = Object.keys(patch).find((path) => managedRevisionFields.has(path.split(".")[0] as string));
      if (managedPath !== undefined) {
        throw managedRevisionFieldError(managedPath, patch[managedPath], revisionInput.record_id);
      }
      const createdAt = nextMutationTimestamp(record, now());
      const source = input.source ?? { client: "moryn" };
      const patched = applyRecordPatch(record, patch);
      try {
        parseRecord(patched);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw invalidRevisionRecordPatchError(patch, message);
      }
      const sensitive = detectSensitiveContent(sensitiveScanText(patched.content));
      const conflicts = !sensitive.sensitive && patched.state === "canonical"
        ? semanticConflicts(await currentRecords(), patched)
        : [];
      if (conflicts.length > 0 && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: conflicting canonical memory requires explicit user confirmation");
      }
      const eventPatch = sensitive.sensitive ? redactSensitivePatch(patch) : patch;
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "revise_record",
        record_id: revisionInput.record_id,
        patch: eventPatch,
        reason: revisionInput.reason,
        confirmed: input.confirmed,
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined,
        created_at: createdAt,
        source
      };
      await appendEvent(deps.storePath, event);
      if (!sensitive.sensitive) {
        await rebuildDerivedViews(deps.storePath);
        return { event, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
      }

      const revisedRecord = { ...record, updated_at: createdAt };
      const quarantineCreatedAt = nextMutationTimestamp(revisedRecord, now());
      const quarantineEvent: MorynEvent = {
        event_id: id("evt"),
        op: "quarantine_record",
        record_id: revisionInput.record_id,
        reason: "SENSITIVE_CONTENT_DETECTED",
        created_at: quarantineCreatedAt,
        source
      };
      await appendEvent(deps.storePath, quarantineEvent);
      await rebuildDerivedViews(deps.storePath);
      return {
        event,
        quarantine_event: quarantineEvent,
        selection_sources: SENSITIVE_REVISE_SELECTION_SOURCES,
        warning: { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason }
      };
    },

    async promote(input: PromoteInput) {
      validatePromoteInput(input);
      const promoteInput = input as ValidatedPromoteInput;
      const record = await requireRecord(promoteInput.record_id);
      const source = input.source ?? { client: "moryn" };
      const conflicts = promoteInput.target_state === "canonical" ? semanticConflicts(await currentRecords(), record) : [];
      if (promoteInput.target_state === "canonical"
        && requiresCanonicalConfirmation(record)
        && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: canonical state requires explicit user confirmation");
      }
      if (promoteInput.target_state === "canonical"
        && conflicts.length > 0
        && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: conflicting canonical memory requires explicit user confirmation");
      }
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "promote_record",
        record_id: promoteInput.record_id,
        target_state: promoteInput.target_state,
        reason: promoteInput.reason,
        confirmed: input.confirmed,
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined,
        created_at: createdAt,
        source
      };
      await appendEventAndRebuild(event);
      return { event, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
    },

    async archive(input: StateChangeInput) {
      validateStateChangeInput(input, "archive input", "archive");
      const stateInput = input as ValidatedStateChangeInput;
      const record = await requireRecord(stateInput.record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "archive_record",
        record_id: stateInput.record_id,
        reason: stateInput.reason,
        created_at: createdAt,
        source: input.source ?? { client: "moryn" }
      };
      await appendEventAndRebuild(event);
      return { event, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
    },

    async quarantine(input: StateChangeInput) {
      validateStateChangeInput(input, "quarantine input", "quarantine");
      const stateInput = input as ValidatedStateChangeInput;
      const record = await requireRecord(stateInput.record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "quarantine_record",
        record_id: stateInput.record_id,
        reason: stateInput.reason,
        created_at: createdAt,
        source: input.source ?? { client: "moryn" }
      };
      await appendEventAndRebuild(event);
      return { event, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
    },

    async link(input: LinkInput) {
      validateLinkInput(input);
      const linkInput = input as ValidatedLinkInput;
      const record = await requireRecord(linkInput.record_id);
      await requireRecord(linkInput.linked_record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "link_records",
        record_id: linkInput.record_id,
        linked_record_id: linkInput.linked_record_id,
        link_type: linkInput.link_type,
        created_at: createdAt,
        source: input.source ?? { client: "moryn" }
      };
      await appendEventAndRebuild(event);
      return { event, selection_sources: LINK_EVENT_SELECTION_SOURCES };
    },

    async recall(input: RecallInput) {
      validateRecallInput(input);
      const recallInput = {
        ...input,
        record_ids: Array.isArray(input.record_ids) ? input.record_ids : undefined,
        kinds: Array.isArray(input.kinds) ? input.kinds : undefined,
        scopes: Array.isArray(input.scopes) ? input.scopes : undefined,
        types: Array.isArray(input.types) ? input.types : undefined,
        states: Array.isArray(input.states) ? input.states : undefined,
        tags: Array.isArray(input.tags) ? input.tags : undefined,
        files: Array.isArray(input.files) ? input.files : undefined
      } as ValidatedRecallInput;
      for (const recordId of recallInput.record_ids ?? []) {
        await requireRecord(recordId);
      }
      const limit = validateLimit(recallInput.limit, 10, "recall");
      const records = (await currentRecords())
        .filter((record) => includesHiddenState(recallInput) || includesRawState(recallInput) || isVisibleInDefaultRecall(record))
        .filter((record) => recordProjectMatchesRecall(record, recallInput))
        .filter((record) => !recallInput.record_ids?.length || recallInput.record_ids.includes(record.id))
        .filter((record) => !recallInput.kinds?.length || recallInput.kinds.includes(record.kind))
        .filter((record) => !recallInput.scopes?.length || recallInput.scopes.includes(record.scope))
        .filter((record) => !recallInput.types?.length || recallInput.types.includes(record.type))
        .filter((record) => !recallInput.states?.length || recallInput.states.includes(record.state))
        .filter((record) => matchesAny(record.tags, recallInput.tags))
        .filter((record) => !recallInput.files?.length || recallInput.files.some((file) => `${searchableText(record)} ${record.tags.join(" ")}`.toLowerCase().includes(file.toLowerCase())))
        .map((record) => ({ record, ...reasonAndScore(record, recallInput) }))
        .filter((result) => matchesQuery(result, recallInput))
        .filter((result) => result.score > 0 || (!recallInput.query && !recallInput.record_ids?.length))
        .sort((a, b) => (b.score - a.score) || b.record.updated_at.localeCompare(a.record.updated_at) || a.record.id.localeCompare(b.record.id))
        .slice(0, limit);
      return {
        results: records,
        selection_sources: RECALL_SELECTION_SOURCES,
        results_by_id: Object.fromEntries(records.map((result) => [result.record.id, result]))
      };
    },

    async boot(input: BootInput) {
      validateBootInput(input);
      const bootInput = {
        ...input,
        default_skills: Array.isArray(input.default_skills) ? input.default_skills : undefined
      } as ValidatedBootInput;
      const visibleRecords = (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => recordBootContextMatches(record, bootInput.project_id));
      const records = visibleRecords
        .filter(isTrustedForBoot)
      const recent = [...visibleRecords]
        .filter(isImportantBootRecent)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const projectMemoryRecords = projectMemory(records, bootInput.project_id);
      const trustedProjectRecords = projectScopedRecords(records, bootInput.project_id);
      const taskRelevant = bootInput.current_task
        ? boundedBootRecords(records
          .filter((record) => record.kind === "memory" && record.scope === "project")
          .filter((record) => matchesCurrentTask(record, bootInput.current_task)))
        : [];
      const userPreferences = boundedBootRecords(records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "preference"));
      const soul = boundedBootRecords(records.filter((record) => record.kind === "soul"));
      const globalRules = boundedBootRecords(records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "rule"));
      const importantDecisions = boundedBootRecords(trustedProjectRecords.filter((record) => record.type === "decision"));
      const warnings = boundedBootRecords(trustedProjectRecords.filter((record) => record.type === "warning" || record.type === "blocker"));
      const skills = boundedBootRecords(bootSkills(records, bootInput));
      const recentChanges = recent.filter((record) => record.kind !== "soul").slice(0, 5);
      const cursor = [...visibleRecords].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_at ?? new Date().toISOString();
      const remoteUpdates = await remoteHasUpdates();
      return {
        profile: {
          user_preferences: userPreferences,
          user_preferences_by_id: recordsById(userPreferences),
          soul,
          soul_by_id: recordsById(soul),
          global_rules_by_id: recordsById(globalRules),
          global_rules: globalRules
        },
        project: {
          summary: projectSummary(projectMemoryRecords),
          tech_stack: boundedBootTexts(projectMemoryRecords.filter((record) => record.type === "tech_stack")),
          active_goals: boundedBootTexts(projectMemoryRecords.filter((record) => record.type === "active_goal" || record.type === "goal")),
          important_decisions: importantDecisions,
          important_decisions_by_id: recordsById(importantDecisions),
          warnings,
          warnings_by_id: recordsById(warnings)
        },
        skills,
        skills_by_id: recordsById(skills),
        task_relevant: taskRelevant,
        task_relevant_by_id: recordsById(taskRelevant),
        recent_changes: recentChanges,
        recent_changes_by_id: recordsById(recentChanges),
        selection_sources: BOOT_SELECTION_SOURCES,
        records_by_id: recordsById([
          ...userPreferences,
          ...soul,
          ...globalRules,
          ...importantDecisions,
          ...warnings,
          ...skills,
          ...taskRelevant,
          ...recentChanges
        ]),
        sync: { cursor, remote_has_updates: remoteUpdates }
      };
    },

    async refresh(input: RefreshInput) {
      validateRefreshInput(input);
      const refreshInput = input as ValidatedRefreshInput;
      const limit = validateLimit(input.limit, 20, "refresh");
      const records = (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => recordBootContextMatches(record, input.project_id))
        .filter((record) => !refreshInput.cursor || record.updated_at > refreshInput.cursor)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      const allChanges = records.map((record) => {
        const importance = refreshImportance(record, refreshInput.current_task);
        return {
          record,
          change: {
            record_id: record.id,
            importance: importance.importance,
            reason: importance.reason,
            summary: summarizeRecord(record),
            recommended_action: record.state === "raw" ? "ignore unless relevant" : "call recall with record_id",
            ...(record.state === "raw" ? {} : { next_action: refreshChangeNextAction(record, input) })
          }
        };
      });
      const reportableChanges = allChanges.filter((change) => change.change.importance !== "silent");
      const changes = reportableChanges.slice(0, limit);
      const latest = (reportableChanges.length > changes.length ? changes.at(-1)?.record.updated_at : records.at(-1)?.updated_at)
        ?? refreshInput.cursor
        ?? new Date().toISOString();
      return {
        cursor: latest,
        changes: changes.map((change) => change.change),
        selection_sources: REFRESH_SELECTION_SOURCES,
        changes_by_record_id: Object.fromEntries(changes.map((change) => [change.change.record_id, change.change])),
        should_interrupt: changes.some((change) => change.change.importance === "interrupt")
      };
    },

    async listRecent(limit: unknown = 20) {
      const records = (await currentRecords()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, validateLimit(limit, 20, "list_recent"));
      return {
        records,
        selection_sources: LIST_RECENT_SELECTION_SOURCES,
        records_by_id: recordsById(records)
      };
    },

    async listProjects(input: ListProjectsInput = {}) {
      validateListProjectsInput(input);
      const limit = validateLimit(input.limit, 20, "project_list");
      const listProjectsInput = input as ValidatedListProjectsInput;
      const byProject = new Map<string, MorynRecord[]>();

      for (const record of (await currentRecords()).filter(isVisibleByDefault)) {
        if (record.scope !== "project" || !record.project_id) continue;
        byProject.set(record.project_id, [...(byProject.get(record.project_id) ?? []), record]);
      }

      const projects = [...byProject.entries()]
        .map(([projectId, records]) => {
          const sorted = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
          const latest = sorted[0] as MorynRecord;
          const tags = [...new Set(records.flatMap((record) => record.tags))].sort();
          return {
            project_id: projectId,
            records: records.length,
            tags,
            latest_activity: projectActivity(latest),
            next: withProjectListNextMetadata({
              recommended_action: "call_agent_start",
              tool: "agent_start",
              safe_to_run: true,
              required_when: START_LISTED_PROJECT_WHEN,
              required_fields: [],
              command: projectStartCommand(projectId, listProjectsInput),
              arguments: projectStartArguments(projectId, listProjectsInput)
            })
          };
        })
        .sort((a, b) => b.latest_activity.updated_at.localeCompare(a.latest_activity.updated_at) || a.project_id.localeCompare(b.project_id))
        .slice(0, limit);

      return {
        projects,
        selection_sources: PROJECT_LIST_SELECTION_SOURCES,
        projects_by_id: Object.fromEntries(projects.map((project) => [project.project_id, project]))
      };
    }
  };

  return engine;
}
