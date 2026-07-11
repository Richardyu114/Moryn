#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { Command, CommanderError } from "commander";
import {
  getOperationContract,
  getOperationContractByCliCommand,
  getOperationContractByMcpTool,
  getOperationContractIndex,
  getOperationContracts,
  getSelectionSourceContracts,
  captureSession,
  contextPack,
  planInstall,
  setupWizard,
  version
} from "./index.js";
import {
  OperationContractLookupConflictError,
  OperationContractLookupError,
  type OperationArgumentMetadata,
  type OperationContract,
  type OperationContractLookupOption
} from "./operation-contracts.js";
import { agentDoctor, agentEnter, agentFinish, agentGuide, agentStart, agentStatus } from "./core/agent-lifecycle.js";
import { commandLineForCliInterface } from "./core/cli-command-line.js";
import { initializeStore } from "./core/config.js";
import type { ContextDeltaInput, LearningDeltaInput } from "./core/context-delta.js";
import { LOGICAL_RELATIONSHIP_TYPES, type LogicalRelationshipType } from "./core/logical-memory.js";
import { rebuildDerivedViews } from "./core/derived.js";
import { createEngine } from "./core/engine.js";
import {
  commandForAgentEnterContext,
  commandForAgentFinishContext,
  commandForAgentStartContext,
  commandForAgentStatusContext,
  commandForArchiveContext,
  commandForLinkContext,
  commandForPromoteContext,
  commandForRecallContext,
  commandForQuarantineContext,
  commandForRefreshContext,
  commandForReviseContext,
  commandForTimelineContext,
  type MorynErrorEnvelope,
  type MorynErrorContext,
  toErrorEnvelope
} from "./core/errors.js";
import { PROJECT_SYNC_MODE_INPUTS, initializeProjectConfig, resolveProjectContext, type SyncMode } from "./core/project.js";
import {
  RECORD_KINDS,
  RECORD_PRIORITIES,
  RECORD_SCOPES,
  RECORD_STATES,
  isValidPatchPath
} from "./core/schema.js";
import { runMcpServer } from "./mcp/server.js";
import {
  openDashboard,
  startDashboardServer,
  writeDashboardSnapshot,
  type DashboardServerHandle,
  type DashboardSnapshot
} from "./observability/dashboard.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "./sync/git.js";
import type { RecallEvalCaseInput } from "./core/recall-eval.js";

const program = new Command();
const recordKinds = RECORD_KINDS;
const recordScopes = RECORD_SCOPES;
const recordStates = RECORD_STATES;
const recordPriorities = RECORD_PRIORITIES;
const projectSyncModeInputs = PROJECT_SYNC_MODE_INPUTS;

const CLI_ARGUMENT_RECOVERY_ACTION_PREFIX = "retry with a valid" as const;
const CLI_UNKNOWN_INPUT_RECOVERY_ACTION = "retry with a known CLI command or option from operation contracts" as const;
const WRITE_OPERATION_CONTRACT_SOURCE = "operations_by_id.write";
const RECALL_OPERATION_CONTRACT_SOURCE = "operations_by_id.recall";
const AGENT_STATUS_OPERATION_CONTRACT_SOURCE = "operations_by_id.agent_status";
const AGENT_FINISH_OPERATION_CONTRACT_SOURCE = "operations_by_id.agent_finish";
const REVISE_OPERATION_CONTRACT_SOURCE = "operations_by_id.revise";
const PROMOTE_OPERATION_CONTRACT_SOURCE = "operations_by_id.promote";
const LINK_OPERATION_CONTRACT_SOURCE = "operations_by_id.link";
const WRITE_TEXT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.text";
const WRITE_CONTENT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content";
const RECALL_FILTER_OPTIONS = ["--record-id", "--kind", "--scope", "--type", "--state", "--tag", "--file"] as const;
const CLI_GLOBAL_OPTIONS = [
  { option: "--store", value_placeholder: "<path>", position: "before_command" },
  { option: "--help", position: "before_command" },
  { option: "-h", position: "before_command" },
  { option: "--version", position: "before_command" },
  { option: "-V", position: "before_command" }
] as const;
type CliLimitOperation = "recall" | "refresh" | "timeline" | "list_recent" | "project_list" | "memory_doctor" | "memory_lifecycle" | "capture_policy" | "dogfood_report" | "health_check" | "recall_eval" | "agent_enter" | "agent_start" | "context_pack" | "dashboard";
type CliLimitOperationContractSource = `operations_by_id.${CliLimitOperation}`;
type CliLimitArgumentSource = `operations_by_id.${CliLimitOperation}.arguments_by_name.limit`;
type CliEnumOperation = "write" | "recall" | "promote" | "project_init";
type CliEnumOperationContractSource = `operations_by_id.${CliEnumOperation}`;
type CliEnumArgumentSource = `operations_by_id.${CliEnumOperation}.arguments_by_name.${string}`;
type CliEnumSource = {
  operation: CliEnumOperation;
  argument: string;
};
type CliWriteArgumentSource = `operations_by_id.write.arguments_by_name.${string}`;
type CliWriteSource = {
  operation: "write";
  argument: string;
};
type CliRequiredOperation =
  | "write"
  | "revise"
  | "promote"
  | "archive"
  | "quarantine"
  | "link"
  | "capture_session"
  | "agent_status"
  | "agent_finish"
  | "checkpoint"
  | "project_migrate"
  | "sync_init";
type CliRequiredArgumentSource = `operations_by_id.${CliRequiredOperation}.arguments_by_name.${string}`;
type CliRequiredSource = {
  operation: CliRequiredOperation;
  argument: string;
};
type CliRequiredPositionalSource = CliRequiredSource & {
  positional: string;
};
type CliParserOperation =
  | "install"
  | "setup"
  | "capture_session"
  | "context_pack"
  | "write"
  | "boot"
  | "recall"
  | "timeline"
  | "refresh"
  | "memory_doctor"
  | "memory_lifecycle"
  | "capture_policy"
  | "dogfood_report"
  | "health_check"
  | "recall_eval"
  | "sync_push"
  | "revise"
  | "promote"
  | "archive"
  | "quarantine"
  | "link"
  | "operation_contracts"
  | "agent_guide"
  | "agent_enter"
  | "agent_doctor"
  | "agent_start"
  | "agent_status"
  | "agent_finish"
  | "checkpoint"
  | "project_init"
  | "project_list"
  | "project_migrate"
  | "sync_init"
  | "dashboard";
type CliParserArgumentSource = `operations_by_id.${CliParserOperation}.arguments_by_name.${string}`;
type CliParserSource = {
  operation: CliParserOperation;
  argument: string;
};
type CliSyncOperation = "sync_status" | "sync_push" | "sync_pull";
type CliSyncOperationContractSource = `operations_by_id.${CliSyncOperation}`;
type CliOperationContractSource = `operations_by_id.${string}`;
type CliArgumentContractSource = `operations_by_id.${string}.arguments_by_name.${string}`;
type CliRecallFilterOption = typeof RECALL_FILTER_OPTIONS[number];
type CliRecallFilterArgument = "record_ids" | "kinds" | "scopes" | "types" | "states" | "tags" | "files";
type CliAgentLifecycleCommandPath = ["agent", "status"] | ["agent", "finish"];
type CliAgentLifecycleOption = "--status" | "--summary";
type CliAgentLifecycleArgument = "status" | "summary";
type CliAgentLifecycleMcpRetry =
  | { tool: "agent_status"; arguments: { status: string } }
  | { tool: "agent_finish"; arguments: { summary: string } };
type CliMutationPositionalCommandPath = ["revise"] | ["promote"] | ["link"];
type CliMutationPositionalOption = "--set" | "--state" | "--type";
type CliMutationPositionalArgument = "patch" | "target_state" | "link_type";
type CliMutationPositionalMcpRetry =
  | { tool: "revise"; arguments: { record_id: string; patch: Record<string, unknown> } }
  | { tool: "promote"; arguments: { record_id: string; target_state: string } }
  | { tool: "link"; arguments: { record_id: string; linked_record_id: string; link_type: string } };
type CliRecallFilterPositionalMapping = {
  value: string;
  option: CliRecallFilterOption;
  argument: CliRecallFilterArgument;
  argument_source: CliArgumentContractSource;
};
type CliAgentLifecyclePositionalMapping = {
  value: string;
  option: CliAgentLifecycleOption;
  argument: CliAgentLifecycleArgument;
  argument_source: CliArgumentContractSource;
};
type CliMutationPositionalMapping = {
  value: string;
  option: CliMutationPositionalOption;
  argument: CliMutationPositionalArgument;
  argument_source: CliArgumentContractSource;
};
type CliUnknownOptionSuggestion =
  | {
      option: string;
      argument: string;
      argument_source: CliArgumentContractSource;
      retry_with: { option: string; value_placeholder?: string };
    }
  | {
      option: string;
      scope: "global";
      retry_with: { option: string; value_placeholder?: string; position: "before_command" };
    };

type CliArgumentRecoveryHint =
  | {
      rejected_command: { command: string; command_path: string[] };
      suggested_commands: Array<{
        command: string;
        operation: string;
        operation_source: CliOperationContractSource;
        retry_with: {
          cli: string;
          args: string[];
          mcp: { tool: string; arguments: Record<string, unknown> };
        };
      }>;
      index_lookup: {
        command: "moryn contracts operations --index";
        args: ["contracts", "operations", "--index"];
        mcp: { tool: "operation_contracts"; arguments: { index: true } };
      };
      do_not: ["retry_unknown_command", "invent_command_names"];
    }
  | {
      operation_contract?: CliOperationContractSource;
      rejected_option: { option: string; command_path: string[] };
      suggested_options: CliUnknownOptionSuggestion[];
      command?: string;
      do_not: ["retry_unknown_option", "invent_cli_flags"];
    }
  | {
      operation_contract: CliOperationContractSource;
      rejected_arguments: { extra_positionals: string[]; command_path: string[] };
      expected: {
        kind: "no_extra_positionals";
        accepted_cli_arguments: string[];
        accepted_options: string[];
      };
      command: string;
      retry_with: { remove_positionals: string[]; args: string[] };
      do_not: ["retry_extra_positionals", "invent_positional_arguments"];
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_arguments: { positional_values: string[]; command_path: ["write"] };
      expected: {
        kind: "required_options";
        required_options: ["--kind", "--type", "--scope"];
        content_options: ["--text", "--content-json"];
      };
      positional_mapping: Array<{
        value: string;
        option: "--kind" | "--type" | "--scope" | "--text";
        argument: "kind" | "type" | "scope" | "text";
        argument_source: CliArgumentContractSource;
      }>;
      retry_with: {
        args: string[];
        cli: string;
        mcp: { tool: "write"; arguments: { kind: string; type: string; scope: string; text: string } };
      };
      do_not: ["retry_write_positional_values", "invent_positional_arguments"];
    }
  | {
      operation_contract: typeof RECALL_OPERATION_CONTRACT_SOURCE;
      rejected_arguments: { positional_values: string[]; command_path: ["recall"] };
      expected: {
        kind: "query_or_filter_options";
        accepted_positionals: ["query"];
        filter_options: typeof RECALL_FILTER_OPTIONS;
      };
      positional_mapping: CliRecallFilterPositionalMapping[];
      retry_with: {
        args: string[];
        cli: string;
        mcp: { tool: "recall"; arguments: Partial<Record<CliRecallFilterArgument, string[]>> };
      };
      do_not: ["retry_recall_filter_positionals", "invent_positional_arguments"];
    }
  | {
      operation_contract: typeof AGENT_STATUS_OPERATION_CONTRACT_SOURCE | typeof AGENT_FINISH_OPERATION_CONTRACT_SOURCE;
      rejected_arguments: { positional_values: string[]; command_path: CliAgentLifecycleCommandPath };
      expected: {
        kind: "required_option";
        required_option: CliAgentLifecycleOption;
      };
      positional_mapping: CliAgentLifecyclePositionalMapping[];
      retry_with: {
        args: string[];
        cli: string;
        mcp: CliAgentLifecycleMcpRetry;
      };
      do_not: ["retry_agent_lifecycle_positional_values", "invent_positional_arguments"];
    }
  | {
      operation_contract: typeof REVISE_OPERATION_CONTRACT_SOURCE | typeof PROMOTE_OPERATION_CONTRACT_SOURCE | typeof LINK_OPERATION_CONTRACT_SOURCE;
      rejected_arguments: { positional_values: string[]; command_path: CliMutationPositionalCommandPath };
      expected: {
        kind: "required_option";
        required_option: CliMutationPositionalOption;
      };
      positional_mapping: CliMutationPositionalMapping[];
      retry_with: {
        args: string[];
        cli: string;
        mcp: CliMutationPositionalMcpRetry;
      };
      do_not: ["retry_mutation_positional_values", "invent_positional_arguments"];
    }
  | {
      operation_contract: CliLimitOperationContractSource;
      rejected_argument: { option: string; value: string };
      expected: { kind: "integer_range"; min: number; max: number; integer: true };
      argument_sources: { limit: CliLimitArgumentSource };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "integer_range"; min: number; max: number; integer: true };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { option: string; value: string };
      expected: { kind: "number_range"; min: number; max: number; inclusive: true };
      argument_sources: Record<string, CliWriteArgumentSource>;
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "number_range"; min: number; max: number; inclusive: true };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      operation_contract: CliEnumOperationContractSource;
      rejected_argument: { option: string; value: string };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: Record<string, CliEnumArgumentSource>;
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      operation_contract: `operations_by_id.${CliRequiredOperation}`;
      missing_argument: { option: string; placeholder: string };
      expected: { kind: "required_option"; required: true };
      argument_sources: Record<string, CliRequiredArgumentSource>;
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      missing_argument: { option: string; placeholder: string };
      expected: { kind: "required_option"; required: true };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      operation_contract: `operations_by_id.${CliRequiredOperation}`;
      missing_argument: { positional: string; placeholder: string };
      expected: { kind: "required_positional"; required: true };
      argument_sources: Record<string, CliRequiredArgumentSource>;
      retry_with: { positional: string; value_placeholder: string };
    }
  | {
      missing_argument: { positional: string; placeholder: string };
      expected: { kind: "required_positional"; required: true };
      retry_with: { positional: string; value_placeholder: string };
    }
  | {
      operation_contract: `operations_by_id.${CliParserOperation}`;
      rejected_argument: { option: string; value: string };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<string, CliParserArgumentSource>;
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      operation_contract: `operations_by_id.${CliParserOperation}`;
      rejected_argument: { positional: string; value: string };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<string, CliParserArgumentSource>;
      retry_with: { positional: string; value_placeholder: string };
    }
  | {
      rejected_argument: { positional: string; value: string };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { positional: string; value_placeholder: string };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { option: "--content-json"; value: string };
      expected: { kind: "valid_json_object" | "json_object" };
      argument_sources: { "--content-json": typeof WRITE_CONTENT_ARGUMENT_SOURCE };
      retry_with: { option: "--content-json"; value_placeholder: "<json object>" };
    }
  | {
      operation_contract: "operations_by_id.recall_eval";
      rejected_argument: { option: "--cases"; value: string };
      expected: { kind: "json_array" };
      argument_sources: { cases: "operations_by_id.recall_eval.arguments_by_name.cases" };
      retry_with: { option: "--cases"; value_placeholder: string };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      missing_one_of: Array<{ option: "--text" | "--content-json"; value_placeholder: string }>;
      expected: { kind: "choose_one"; options: ["--text", "--content-json"] };
      argument_sources: {
        "--text": typeof WRITE_TEXT_ARGUMENT_SOURCE;
        "--content-json": typeof WRITE_CONTENT_ARGUMENT_SOURCE;
      };
      retry_with: Array<{ option: "--text" | "--content-json"; value_placeholder: string }>;
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_arguments: Array<{ option: "--text" | "--content-json"; value: string }>;
      expected: { kind: "choose_one"; options: ["--text", "--content-json"] };
      argument_sources: {
        "--text": typeof WRITE_TEXT_ARGUMENT_SOURCE;
        "--content-json": typeof WRITE_CONTENT_ARGUMENT_SOURCE;
      };
      retry_with: Array<{ option: "--text" | "--content-json"; value_placeholder: string }>;
    }
  | {
      operation_contracts: Record<"--status" | "--push" | "--pull", CliSyncOperationContractSource>;
      rejected_arguments: Array<{ option: "--status" | "--push" | "--pull"; value: true; operation_contract: CliSyncOperationContractSource }>;
      expected: { kind: "choose_one"; options: ["--status", "--push", "--pull"] };
      retry_with: Array<{ option: "--status" | "--push" | "--pull"; operation_contract: CliSyncOperationContractSource }>;
    }
  | {
      operation_contract: "operations_by_id.sync_push";
      rejected_argument: { option: "--message"; value: string };
      expected: { kind: "requires_option"; option: "--message"; requires: "--push" };
      argument_sources: { message: "operations_by_id.sync_push.arguments_by_name.message" };
      retry_with: { required_option: "--push"; operation_contract: "operations_by_id.sync_push"; option: "--message"; value_placeholder: "<message>" };
    }
  | {
      operation_contract: "operations_by_id.revise";
      rejected_argument: { option: "--set"; value: string };
      expected: {
        kind: "path_assignment";
        key_path: "dot-separated patch path";
        separator: "=";
        value: "JSON scalar/object/array or string";
      };
      argument_sources: { patch: "operations_by_id.revise.arguments_by_name.patch" };
      retry_with: { option: "--set"; value_placeholder: "<path>=<json-or-string>" };
    }
  | {
      rejected_argument: { option: "--set"; value: string };
      expected: {
        kind: "path_assignment";
        key_path: "dot-separated patch path";
        separator: "=";
        value: "JSON scalar/object/array or string";
      };
      retry_with: { option: "--set"; value_placeholder: "<path>=<json-or-string>" };
    };

class CliArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: CliArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: CliArgumentRecoveryHint) {
    super(message);
    this.name = "CliArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function storePath(): string {
  return parseNonEmptyString(program.opts<{ store?: string }>().store, "--store") ?? join(homedir(), ".moryn");
}

function printJson(value: unknown, options: { pretty?: boolean } = {}): void {
  process.stdout.write(`${JSON.stringify(value, null, options.pretty === false ? undefined : 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cliOptionForCoreArgument(argument: string, context?: MorynErrorContext): string | undefined {
  if (argument === "path" && context?.tool === "project_init") {
    return "--path";
  }
  if (argument === "scope") {
    return "--scope";
  }
  if (argument === "project_id") {
    return "--project-id";
  }
  if (argument === "project_path") {
    return "--project";
  }
  if (argument === "cursor") {
    return context?.arguments.refresh_since !== undefined ? "--refresh-since" : "--cursor";
  }
  if (argument === "refresh_since") {
    return "--refresh-since";
  }
  if (argument === "sync_remote") {
    return "--sync-remote";
  }
  return undefined;
}

function cliArgumentObjectToOption(value: Record<string, unknown>, context?: MorynErrorContext): Record<string, unknown> {
  if (value.cli_preserve_argument === true) {
    const { cli_preserve_argument: _preserve, ...rest } = value;
    return rest;
  }
  if (typeof value.argument !== "string") return value;
  const option = cliOptionForCoreArgument(value.argument, context);
  if (!option) return value;
  const { argument: _argument, ...rest } = value;
  return { option, ...rest };
}

function cliRecoveryHintValue(value: unknown, context?: MorynErrorContext): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => cliRecoveryHintValue(entry, context));
  }
  if (!isRecord(value)) {
    return value;
  }
  const converted = cliArgumentObjectToOption(value, context);
  return Object.fromEntries(
    Object.entries(converted).map(([key, entry]) => [key, cliRecoveryHintValue(entry, context)])
  );
}

function cliRecoveryHint(recoveryHint: unknown, context?: MorynErrorContext): unknown {
  if (!isRecord(recoveryHint)) {
    return recoveryHint;
  }
  return cliRecoveryHintValue(recoveryHint, context);
}

function cliErrorEnvelope(error: unknown, context?: MorynErrorContext): MorynErrorEnvelope {
  const envelope = toErrorEnvelope(error, context);
  if (envelope.error.recovery_hint === undefined) return envelope;
  return {
    ...envelope,
    error: {
      ...envelope.error,
      recovery_hint: cliRecoveryHint(envelope.error.recovery_hint, context)
    }
  };
}

function printError(error: unknown, context?: MorynErrorContext): void {
  process.stderr.write(`${JSON.stringify(cliErrorEnvelope(error, context), null, 2)}\n`);
}

function cliRequiredOptionError(message: string, args = process.argv.slice(2)): CliArgumentError | undefined {
  const match = /^required option '([^ ]+) ([^']+)' not specified$/.exec(message);
  if (!match) return undefined;
  const [, option, placeholder] = match;
  if (!option || !placeholder) return undefined;
  const positionalWriteHint = naturalWritePositionalCliArgumentError(message, args);
  if (positionalWriteHint !== undefined) return positionalWriteHint;
  const positionalAgentLifecycleHint = naturalAgentLifecyclePositionalCliArgumentError(message, args, option);
  if (positionalAgentLifecycleHint !== undefined) return positionalAgentLifecycleHint;
  const positionalMutationHint = naturalMutationRequiredOptionPositionalCliArgumentError(message, args, option);
  if (positionalMutationHint !== undefined) return positionalMutationHint;
  return requiredCliOptionError(option, placeholder, message, requiredCliOptionSource(option, args));
}

function cliRequiredArgumentError(message: string, args = process.argv.slice(2)): CliArgumentError | undefined {
  const match = /^missing required argument '([^']+)'$/.exec(message);
  if (!match) return undefined;
  const [, positional] = match;
  if (!positional) return undefined;
  return requiredCliPositionalArgumentError(positional, `<${positional}>`, message, requiredCliPositionalArgumentSource(positional, args));
}

function naturalWritePositionalCliArgumentError(message: string, args = process.argv.slice(2)): CliArgumentError | undefined {
  if (cliCommandPath(args).join(" ") !== "write") return undefined;
  const positionalValues = cliCommandPositionals(args, "write");
  if (positionalValues.length < 3) return undefined;
  const [kind, type, scope, ...textParts] = positionalValues;
  if (!kind || !type || !scope || textParts.length === 0) return undefined;
  const text = textParts.join(" ");
  const retryArgs = ["write", "--kind", kind, "--type", type, "--scope", scope, "--text", text];
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry write with required CLI options instead of positional values",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_arguments: {
        positional_values: positionalValues,
        command_path: ["write"]
      },
      expected: {
        kind: "required_options",
        required_options: ["--kind", "--type", "--scope"],
        content_options: ["--text", "--content-json"]
      },
      positional_mapping: [
        naturalWritePositionalMapping(kind, "--kind", "kind"),
        naturalWritePositionalMapping(type, "--type", "type"),
        naturalWritePositionalMapping(scope, "--scope", "scope"),
        naturalWritePositionalMapping(text, "--text", "text")
      ],
      retry_with: {
        args: retryArgs,
        cli: commandLineForCliInterface("moryn", retryArgs),
        mcp: { tool: "write", arguments: { kind, type, scope, text } }
      },
      do_not: ["retry_write_positional_values", "invent_positional_arguments"]
    }
  );
}

function naturalWritePositionalMapping(
  value: string,
  option: "--kind" | "--type" | "--scope" | "--text",
  argument: "kind" | "type" | "scope" | "text"
) {
  return {
    value,
    option,
    argument,
    argument_source: `operations_by_id.write.arguments_by_name.${argument}` as const,
    cli_preserve_argument: true
  };
}

function naturalAgentLifecyclePositionalCliArgumentError(
  message: string,
  args: readonly string[],
  missingOption: string
): CliArgumentError | undefined {
  const commandPath = cliCommandPath([...args]);
  if (commandPath[0] === "agent" && commandPath[1] === "status" && missingOption === "--status") {
    const positionalValues = cliPositionalsAfterCommandPath(args, ["agent", "status"]);
    if (positionalValues.length === 0) return undefined;
    const status = positionalValues.join(" ");
    const retryArgs = ["agent", "status", "--status", status];
    return new CliArgumentError(
      `Invalid argument: ${message}`,
      "retry agent status with --status instead of positional text",
      {
        operation_contract: AGENT_STATUS_OPERATION_CONTRACT_SOURCE,
        rejected_arguments: { positional_values: positionalValues, command_path: ["agent", "status"] },
        expected: { kind: "required_option", required_option: "--status" },
        positional_mapping: [
          naturalAgentLifecyclePositionalMapping(status, "--status", "status", "agent_status")
        ],
        retry_with: {
          args: retryArgs,
          cli: commandLineForCliInterface("moryn", retryArgs),
          mcp: { tool: "agent_status", arguments: { status } }
        },
        do_not: ["retry_agent_lifecycle_positional_values", "invent_positional_arguments"]
      }
    );
  }
  if (commandPath[0] === "agent" && commandPath[1] === "finish" && missingOption === "--summary") {
    const positionalValues = cliPositionalsAfterCommandPath(args, ["agent", "finish"]);
    if (positionalValues.length === 0) return undefined;
    const summary = positionalValues.join(" ");
    const retryArgs = ["agent", "finish", "--summary", summary];
    return new CliArgumentError(
      `Invalid argument: ${message}`,
      "retry agent finish with --summary instead of positional text",
      {
        operation_contract: AGENT_FINISH_OPERATION_CONTRACT_SOURCE,
        rejected_arguments: { positional_values: positionalValues, command_path: ["agent", "finish"] },
        expected: { kind: "required_option", required_option: "--summary" },
        positional_mapping: [
          naturalAgentLifecyclePositionalMapping(summary, "--summary", "summary", "agent_finish")
        ],
        retry_with: {
          args: retryArgs,
          cli: commandLineForCliInterface("moryn", retryArgs),
          mcp: { tool: "agent_finish", arguments: { summary } }
        },
        do_not: ["retry_agent_lifecycle_positional_values", "invent_positional_arguments"]
      }
    );
  }
  return undefined;
}

function naturalAgentLifecyclePositionalMapping(
  value: string,
  option: CliAgentLifecycleOption,
  argument: CliAgentLifecycleArgument,
  operation: "agent_status" | "agent_finish"
): CliAgentLifecyclePositionalMapping {
  return {
    value,
    option,
    argument,
    argument_source: `operations_by_id.${operation}.arguments_by_name.${argument}` as const
  };
}

function naturalMutationRequiredOptionPositionalCliArgumentError(
  message: string,
  args: readonly string[],
  missingOption: string
): CliArgumentError | undefined {
  const commandPath = cliCommandPath([...args]);
  if (commandPath[0] === "promote" && missingOption === "--state") {
    const positionalValues = cliPositionalsAfterCommandPath(args, ["promote"]);
    const [recordId, state] = positionalValues;
    if (!recordId || !state) return undefined;
    return naturalPromotePositionalCliArgumentError(message, recordId, state, [state]);
  }
  if (commandPath[0] === "link" && missingOption === "--type") {
    const positionalValues = cliPositionalsAfterCommandPath(args, ["link"]);
    const [recordId, linkedRecordId, linkType] = positionalValues;
    if (!recordId || !linkedRecordId || !linkType) return undefined;
    return naturalLinkPositionalCliArgumentError(message, recordId, linkedRecordId, linkType, [linkType]);
  }
  return undefined;
}

function naturalMutationExtraPositionalsCliArgumentError(
  message: string,
  args: readonly string[],
  commandPath: readonly string[],
  extraPositionals: readonly string[]
): CliArgumentError | undefined {
  if (commandPath.length === 1 && commandPath[0] === "revise") {
    const positionalValues = cliPositionalsAfterCommandPath(args, ["revise"]);
    const [recordId] = positionalValues;
    if (!recordId || extraPositionals.length === 0) return undefined;
    const patch = patchFromAssignments(extraPositionals);
    if (patch === undefined) return undefined;
    const retryArgs = ["revise", recordId, ...extraPositionals.flatMap((assignment) => ["--set", assignment])];
    return new CliArgumentError(
      `Invalid argument: ${message}`,
      "retry revise with --set instead of positional patch assignments",
      {
        operation_contract: REVISE_OPERATION_CONTRACT_SOURCE,
        rejected_arguments: { positional_values: [...extraPositionals], command_path: ["revise"] },
        expected: { kind: "required_option", required_option: "--set" },
        positional_mapping: extraPositionals.map((assignment) =>
          naturalMutationPositionalMapping(assignment, "--set", "patch", "revise")
        ),
        retry_with: {
          args: retryArgs,
          cli: commandLineForCliInterface("moryn", retryArgs),
          mcp: { tool: "revise", arguments: { record_id: recordId, patch } }
        },
        do_not: ["retry_mutation_positional_values", "invent_positional_arguments"]
      }
    );
  }
  return undefined;
}

function naturalPromotePositionalCliArgumentError(
  message: string,
  recordId: string,
  state: string,
  positionalValues: string[]
): CliArgumentError {
  const retryArgs = ["promote", recordId, "--state", state];
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry promote with --state instead of positional state",
    {
      operation_contract: PROMOTE_OPERATION_CONTRACT_SOURCE,
      rejected_arguments: { positional_values: positionalValues, command_path: ["promote"] },
      expected: { kind: "required_option", required_option: "--state" },
      positional_mapping: [
        naturalMutationPositionalMapping(state, "--state", "target_state", "promote")
      ],
      retry_with: {
        args: retryArgs,
        cli: commandLineForCliInterface("moryn", retryArgs),
        mcp: { tool: "promote", arguments: { record_id: recordId, target_state: state } }
      },
      do_not: ["retry_mutation_positional_values", "invent_positional_arguments"]
    }
  );
}

function naturalLinkPositionalCliArgumentError(
  message: string,
  recordId: string,
  linkedRecordId: string,
  linkType: string,
  positionalValues: string[]
): CliArgumentError {
  const retryArgs = ["link", recordId, linkedRecordId, "--type", linkType];
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry link with --type instead of positional link type",
    {
      operation_contract: LINK_OPERATION_CONTRACT_SOURCE,
      rejected_arguments: { positional_values: positionalValues, command_path: ["link"] },
      expected: { kind: "required_option", required_option: "--type" },
      positional_mapping: [
        naturalMutationPositionalMapping(linkType, "--type", "link_type", "link")
      ],
      retry_with: {
        args: retryArgs,
        cli: commandLineForCliInterface("moryn", retryArgs),
        mcp: { tool: "link", arguments: { record_id: recordId, linked_record_id: linkedRecordId, link_type: linkType } }
      },
      do_not: ["retry_mutation_positional_values", "invent_positional_arguments"]
    }
  );
}

function naturalMutationPositionalMapping(
  value: string,
  option: CliMutationPositionalOption,
  argument: CliMutationPositionalArgument,
  operation: "revise" | "promote" | "link"
): CliMutationPositionalMapping {
  return {
    value,
    option,
    argument,
    argument_source: `operations_by_id.${operation}.arguments_by_name.${argument}` as const
  };
}

function cliUnknownCommandError(message: string, args = process.argv.slice(2)): CliArgumentError | undefined {
  const match = /^unknown command '([^']+)'/.exec(message);
  if (!match) return undefined;
  const [, rejectedCommand] = match;
  if (!rejectedCommand) return undefined;
  const preferredCommand = cliCommanderSuggestedCommand(message);
  const commandPath = cliCommandPath(args, { rejectedCommand });
  const rejectedCommandPath = commandPath.length > 0 ? commandPath : [rejectedCommand];
  const suggestions = cliUnknownCommandSuggestions(rejectedCommandPath.join(" "), preferredCommand);
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    CLI_UNKNOWN_INPUT_RECOVERY_ACTION,
    {
      rejected_command: {
        command: rejectedCommandPath.join(" "),
        command_path: rejectedCommandPath
      },
      suggested_commands: suggestions,
      index_lookup: {
        command: "moryn contracts operations --index",
        args: ["contracts", "operations", "--index"],
        mcp: { tool: "operation_contracts", arguments: { index: true } }
      },
      do_not: ["retry_unknown_command", "invent_command_names"]
    }
  );
}

function cliTooManyArgumentsCommandError(message: string, args = process.argv.slice(2)): CliArgumentError | undefined {
  const match = /^too many arguments for '([^']+)'/.exec(message);
  if (!match) return undefined;
  const commandPath = cliCommandPath(args);
  const extraPositionalsHint = cliExtraPositionalsError(message, args, commandPath);
  if (extraPositionalsHint !== undefined) return extraPositionalsHint;
  if (commandPath.length < 2 || !cliCommandGroupTokens().has(commandPath[0]!)) return undefined;
  const suggestions = cliUnknownCommandSuggestions(commandPath.join(" "), undefined, { commandGroup: commandPath[0] });
  if (suggestions.length === 0) return undefined;
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    CLI_UNKNOWN_INPUT_RECOVERY_ACTION,
    {
      rejected_command: {
        command: commandPath.join(" "),
        command_path: commandPath
      },
      suggested_commands: suggestions,
      index_lookup: {
        command: "moryn contracts operations --index",
        args: ["contracts", "operations", "--index"],
        mcp: { tool: "operation_contracts", arguments: { index: true } }
      },
      do_not: ["retry_unknown_command", "invent_command_names"]
    }
  );
}

function cliExtraPositionalsError(message: string, args: string[], commandPath = cliCommandPath(args)): CliArgumentError | undefined {
  const operation = cliOperationsForCommandPath(commandPath)[0];
  if (operation === undefined) return undefined;
  const extraPositionals = cliExtraPositionals(args, operation);
  if (extraPositionals.length === 0) return undefined;
  const positionalRecallHint = naturalRecallFilterPositionalCliArgumentError(message, args, commandPath);
  if (positionalRecallHint !== undefined) return positionalRecallHint;
  const positionalMutationHint = naturalMutationExtraPositionalsCliArgumentError(message, args, commandPath, extraPositionals);
  if (positionalMutationHint !== undefined) return positionalMutationHint;
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry without extra positional arguments",
    {
      operation_contract: `operations_by_id.${operation.operation}` as const,
      rejected_arguments: { extra_positionals: extraPositionals, command_path: commandPath },
      expected: {
        kind: "no_extra_positionals",
        accepted_cli_arguments: cliCommandTokens(operation),
        accepted_options: cliOperationOptions(operation)
      },
      command: operation.interfaces.cli.command,
      retry_with: { remove_positionals: extraPositionals, args: cliCommandTokens(operation) },
      do_not: ["retry_extra_positionals", "invent_positional_arguments"]
    }
  );
}

function naturalRecallFilterPositionalCliArgumentError(
  message: string,
  args: string[],
  commandPath: readonly string[]
): CliArgumentError | undefined {
  if (commandPath.length !== 1 || commandPath[0] !== "recall") return undefined;
  const positionalValues = cliCommandPositionals(args, "recall");
  if (positionalValues.length < 2) return undefined;
  const positionalMapping = naturalRecallFilterPositionalMappings(positionalValues);
  if (positionalMapping === undefined) return undefined;
  const retryArgs = ["recall", ...positionalMapping.flatMap((mapping) => [mapping.option, mapping.value])];
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry recall with explicit filter options instead of positional values",
    {
      operation_contract: RECALL_OPERATION_CONTRACT_SOURCE,
      rejected_arguments: { positional_values: positionalValues, command_path: ["recall"] },
      expected: {
        kind: "query_or_filter_options",
        accepted_positionals: ["query"],
        filter_options: RECALL_FILTER_OPTIONS
      },
      positional_mapping: positionalMapping,
      retry_with: {
        args: retryArgs,
        cli: commandLineForCliInterface("moryn", retryArgs),
        mcp: { tool: "recall", arguments: recallFilterMcpArguments(positionalMapping) }
      },
      do_not: ["retry_recall_filter_positionals", "invent_positional_arguments"]
    }
  );
}

function naturalRecallFilterPositionalMappings(positionalValues: readonly string[]): CliRecallFilterPositionalMapping[] | undefined {
  const [kind, ...filters] = positionalValues;
  if (!kind || filters.length === 0 || !(recordKinds as readonly string[]).includes(kind)) return undefined;
  const mappings: CliRecallFilterPositionalMapping[] = [
    naturalRecallFilterPositionalMapping(kind, "--kind", "kinds")
  ];
  for (const value of filters) {
    if ((recordScopes as readonly string[]).includes(value)) {
      mappings.push(naturalRecallFilterPositionalMapping(value, "--scope", "scopes"));
      continue;
    }
    if ((recordStates as readonly string[]).includes(value)) {
      mappings.push(naturalRecallFilterPositionalMapping(value, "--state", "states"));
      continue;
    }
    mappings.push(naturalRecallFilterPositionalMapping(value, "--type", "types"));
  }
  return mappings;
}

function naturalRecallFilterPositionalMapping(
  value: string,
  option: CliRecallFilterOption,
  argument: CliRecallFilterArgument
): CliRecallFilterPositionalMapping {
  return {
    value,
    option,
    argument,
    argument_source: `operations_by_id.recall.arguments_by_name.${argument}` as const
  };
}

function recallFilterMcpArguments(
  positionalMapping: readonly CliRecallFilterPositionalMapping[]
): Partial<Record<CliRecallFilterArgument, string[]>> {
  const args: Partial<Record<CliRecallFilterArgument, string[]>> = {};
  for (const mapping of positionalMapping) {
    args[mapping.argument] = [...(args[mapping.argument] ?? []), mapping.value];
  }
  return args;
}

function cliCommanderSuggestedCommand(message: string): string | undefined {
  const match = /\(Did you mean ([^)]+)\?\)/.exec(message);
  return match?.[1];
}

function cliUnknownOptionError(message: string, args = process.argv.slice(2)): CliArgumentError | undefined {
  const match = /^unknown option '([^']+)'/.exec(message);
  if (!match) return undefined;
  const [, rejectedOption] = match;
  if (!rejectedOption) return undefined;
  const preferredOption = cliCommanderSuggestedOption(message);
  const skipRejectedOptionValue = cliOptionSuggestionNeedsValue(rejectedOption, preferredOption);
  const commandPath = cliCommandPath(args, { rejectedOption, skipRejectedOptionValue });
  const matchingOperations = cliOperationsForCommandPath(commandPath);
  const { suggestions, operation } = cliUnknownOptionSuggestions(rejectedOption, matchingOperations, preferredOption);
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    CLI_UNKNOWN_INPUT_RECOVERY_ACTION,
    {
      ...(operation !== undefined ? { operation_contract: `operations_by_id.${operation.operation}` as const } : {}),
      rejected_option: {
        option: rejectedOption,
        command_path: commandPath
      },
      suggested_options: suggestions,
      ...(operation !== undefined ? { command: operation.interfaces.cli.command } : {}),
      do_not: ["retry_unknown_option", "invent_cli_flags"]
    }
  );
}

function cliCommanderSuggestedOption(message: string): string | undefined {
  const match = /\(Did you mean ([^)]+)\?\)/.exec(message);
  return match?.[1];
}

function requiredCliOptionSource(option: string, args = process.argv.slice(2)): CliRequiredSource | undefined {
  const commandPath = cliCommandPath(args);
  if (commandPath[0] === "write") {
    if (option === "--kind") return { operation: "write", argument: "kind" };
    if (option === "--type") return { operation: "write", argument: "type" };
    if (option === "--scope") return { operation: "write", argument: "scope" };
  }
  if (commandPath[0] === "revise" && option === "--set") return { operation: "revise", argument: "patch" };
  if (commandPath[0] === "promote" && option === "--state") return { operation: "promote", argument: "target_state" };
  if (commandPath[0] === "link" && option === "--type") return { operation: "link", argument: "link_type" };
  if (commandPath[0] === "agent" && commandPath[1] === "status" && option === "--status") {
    return { operation: "agent_status", argument: "status" };
  }
  if (commandPath[0] === "agent" && commandPath[1] === "finish" && option === "--summary") {
    return { operation: "agent_finish", argument: "summary" };
  }
  if (commandPath[0] === "capture" && commandPath[1] === "session" && option === "--summary") {
    return { operation: "capture_session", argument: "summary" };
  }
  return undefined;
}

function requiredCliPositionalArgumentSource(positional: string, args = process.argv.slice(2)): CliRequiredPositionalSource | undefined {
  const commandPath = cliCommandPath(args);
  if (commandPath[0] === "revise" && positional === "record-id") {
    return { operation: "revise", argument: "record_id", positional };
  }
  if (commandPath[0] === "promote" && positional === "record-id") {
    return { operation: "promote", argument: "record_id", positional };
  }
  if (commandPath[0] === "archive" && positional === "record-id") {
    return { operation: "archive", argument: "record_id", positional };
  }
  if (commandPath[0] === "quarantine" && positional === "record-id") {
    return { operation: "quarantine", argument: "record_id", positional };
  }
  if (commandPath[0] === "link") {
    if (positional === "record-id") return { operation: "link", argument: "record_id", positional };
    if (positional === "linked-record-id") return { operation: "link", argument: "linked_record_id", positional };
  }
  if (commandPath[0] === "sync" && commandPath[1] === "init" && positional === "remote") {
    return { operation: "sync_init", argument: "remote", positional };
  }
  return undefined;
}

function cliCommandPath(
  args: string[],
  options: { rejectedCommand?: string; rejectedOption?: string; skipRejectedOptionValue?: boolean } = {}
): string[] {
  const path: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--store") {
      index += 1;
      continue;
    }
    if (arg === "--pretty" || arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") {
      continue;
    }
    if (arg?.startsWith("--store=")) {
      continue;
    }
    if (arg === options.rejectedOption && options.skipRejectedOptionValue === true && args[index + 1] && !args[index + 1]!.startsWith("-")) {
      index += 1;
      continue;
    }
    if (!arg || arg.startsWith("-")) {
      continue;
    }
    path.push(arg);
    if (path.length === 1 && arg === options.rejectedCommand && args[index + 1] && !args[index + 1]!.startsWith("-")) {
      continue;
    }
    if (cliCommandGroupTokens().has(path[0]!)) {
      if (path.length >= 2) break;
      continue;
    }
    break;
  }
  return path;
}

function cliCommandGroupTokens(): Set<string> {
  return new Set(cliOperationContracts().flatMap((operation) => {
    const tokens = cliCommandTokens(operation);
    return tokens.length > 1 ? [tokens[0]!] : [];
  }));
}

function cliOperationContracts(): readonly OperationContract[] {
  return getOperationContracts().operations;
}

function cliCommandTokens(operation: OperationContract): string[] {
  const tokens: string[] = [];
  for (const arg of operation.interfaces.cli.args) {
    if (arg.startsWith("-") || /^<[^<>]+>$/.test(arg)) break;
    tokens.push(arg);
  }
  return tokens;
}

function cliOperationsForCommandPath(commandPath: readonly string[]): OperationContract[] {
  if (commandPath.length === 0) return [];
  return cliOperationContracts().filter((operation) => {
    const tokens = cliCommandTokens(operation);
    return tokens.length === commandPath.length && tokens.every((token, index) => token === commandPath[index]);
  });
}

function cliCommandPositionals(args: readonly string[], command: string): string[] {
  const positionals: string[] = [];
  let inCommand = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--store") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--store=") || arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") {
      continue;
    }
    if (!inCommand) {
      if (arg === command) inCommand = true;
      continue;
    }
    if (arg.startsWith("-")) {
      if (args[index + 1] && !args[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function cliPositionalsAfterCommandPath(args: readonly string[], commandPath: readonly string[]): string[] {
  const positionals: string[] = [];
  let commandIndex = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--store") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--store=") || arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") {
      continue;
    }
    if (commandIndex < commandPath.length) {
      if (arg === commandPath[commandIndex]) {
        commandIndex += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      if (args[index + 1] && !args[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function cliExtraPositionals(args: readonly string[], operation: OperationContract): string[] {
  const commandTokens = cliCommandTokens(operation);
  const acceptedPositionals = new Set(
    Object.values(operation.arguments_by_name).flatMap((argument) => argument.cli?.positional !== undefined ? [argument.cli.positional] : [])
  );
  const extras: string[] = [];
  let commandIndex = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--store") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--store=") || arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V") {
      continue;
    }
    if (arg.startsWith("-")) {
      if (!isBooleanCliOption(operation, arg) && args[index + 1] && !args[index + 1]!.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    if (commandIndex < commandTokens.length && arg === commandTokens[commandIndex]) {
      commandIndex += 1;
      continue;
    }
    if (acceptedPositionals.size > 0) {
      acceptedPositionals.delete(acceptedPositionals.values().next().value as string);
      continue;
    }
    extras.push(arg);
  }
  return extras;
}

function cliOperationOptions(operation: OperationContract): string[] {
  const options: string[] = [];
  for (const argument of Object.values(operation.arguments_by_name)) {
    if (argument.cli?.flag !== undefined) options.push(argument.cli.flag);
    if (argument.cli?.negative_flag !== undefined) options.push(argument.cli.negative_flag);
    for (const flag of argument.cli?.flags ?? []) options.push(flag);
  }
  return [...new Set(options)];
}

function isBooleanCliOption(operation: OperationContract, option: string): boolean {
  return Object.values(operation.arguments_by_name).some((argument) =>
    argument.type === "boolean" && (
      argument.cli?.flag === option
      || argument.cli?.negative_flag === option
      || argument.cli?.flags?.includes(option)
    )
  );
}

function cliUnknownCommandSuggestions(query: string, preferredCommand?: string, filter?: { commandGroup?: string }): Array<{
  command: string;
  operation: string;
  operation_source: CliOperationContractSource;
  retry_with: {
    cli: string;
    args: string[];
    mcp: { tool: string; arguments: Record<string, unknown> };
  };
}> {
  const seenCommands = new Set<string>();
  return cliOperationContracts()
    .flatMap((operation, order) => {
      const command = cliCommandTokens(operation).join(" ");
      if (!command || seenCommands.has(command)) return [];
      if (filter?.commandGroup !== undefined && !command.startsWith(`${filter.commandGroup} `)) return [];
      seenCommands.add(command);
      const preferredCandidate = preferredCommand === undefined
        ? undefined
        : [preferredCommand, ...query.split(/\s+/u).slice(1)].join(" ");
      return [{
        operation,
        command,
        order,
        score: command === preferredCandidate ? Number.NEGATIVE_INFINITY : cliSuggestionScore(query, command)
      }];
    })
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, 1)
    .map(({ operation, command }) => ({
      command,
      operation: operation.operation,
      operation_source: `operations_by_id.${operation.operation}` as const,
      retry_with: {
        cli: operation.interfaces.cli.command,
        args: [...operation.interfaces.cli.args],
        mcp: {
          tool: operation.interfaces.mcp.tool,
          arguments: operation.interfaces.mcp.arguments
        }
      }
    }));
}

function cliUnknownOptionSuggestions(
  query: string,
  commandOperations: readonly OperationContract[],
  preferredOption?: string
): {
  suggestions: CliUnknownOptionSuggestion[];
  operation?: OperationContract;
} {
  const operations = commandOperations.length > 0 ? commandOperations : cliOperationContracts();
  const candidates = [
    ...cliGlobalOptionCandidates(),
    ...cliOptionCandidates(operations)
  ].map((candidate, order) => ({
    ...candidate,
    order,
    score: candidate.option === preferredOption ? Number.NEGATIVE_INFINITY : cliSuggestionScore(query, candidate.option)
  })).sort((left, right) => left.score - right.score || left.directness - right.directness || left.order - right.order);
  const selected = [];
  const seenOptions = new Set<string>();
  for (const candidate of candidates) {
    if (seenOptions.has(candidate.option)) continue;
    seenOptions.add(candidate.option);
    selected.push(candidate);
    if (selected.length >= 1) break;
  }
  const firstSelected = selected[0];
  const operation = firstSelected?.kind === "operation" ? firstSelected.operation : undefined;
  return {
    suggestions: selected.map((candidate) => {
      if (candidate.kind === "global") {
        return {
          option: candidate.option,
          scope: "global",
          retry_with: {
            option: candidate.option,
            ...(candidate.value_placeholder !== undefined ? { value_placeholder: candidate.value_placeholder } : {}),
            position: candidate.position
          }
        };
      }
      const valuePlaceholder = cliOptionValuePlaceholder(candidate.argument, candidate.metadata, candidate.option);
      return {
        option: candidate.option,
        argument: candidate.argument,
        argument_source: `operations_by_id.${candidate.operation.operation}.arguments_by_name.${candidate.argument}` as const,
        retry_with: {
          option: candidate.option,
          ...(valuePlaceholder !== undefined ? { value_placeholder: valuePlaceholder } : {})
        }
      };
    }),
    ...(operation !== undefined ? { operation } : {})
  };
}

function cliOptionSuggestionNeedsValue(query: string, preferredOption?: string): boolean {
  const candidates = [
    ...cliGlobalOptionCandidates(),
    ...cliOptionCandidates(cliOperationContracts())
  ].map((candidate, order) => ({
    ...candidate,
    order,
    score: candidate.option === preferredOption ? Number.NEGATIVE_INFINITY : cliSuggestionScore(query, candidate.option)
  })).sort((left, right) => left.score - right.score || left.directness - right.directness || left.order - right.order);
  const candidate = candidates[0];
  if (candidate === undefined) return false;
  if (candidate.kind === "global") return candidate.value_placeholder !== undefined;
  return cliOptionValuePlaceholder(candidate.argument, candidate.metadata, candidate.option) !== undefined;
}

function cliGlobalOptionCandidates(): Array<{
  kind: "global";
  option: string;
  value_placeholder?: string;
  position: "before_command";
  directness: number;
}> {
  return CLI_GLOBAL_OPTIONS.map((option) => ({
    kind: "global" as const,
    option: option.option,
    ...("value_placeholder" in option ? { value_placeholder: option.value_placeholder } : {}),
    position: option.position,
    directness: 0
  }));
}

function cliOptionCandidates(operations: readonly OperationContract[]): Array<{
  kind: "operation";
  operation: OperationContract;
  option: string;
  argument: string;
  metadata: OperationArgumentMetadata;
  directness: number;
}> {
  const candidates: Array<{
    kind: "operation";
    operation: OperationContract;
    option: string;
    argument: string;
    metadata: OperationArgumentMetadata;
    directness: number;
  }> = [];
  for (const operation of operations) {
    for (const [argument, metadata] of Object.entries(operation.arguments_by_name)) {
      if (metadata.cli?.flag !== undefined) {
        candidates.push({ kind: "operation", operation, option: metadata.cli.flag, argument, metadata, directness: 1 });
      }
      if (metadata.cli?.negative_flag !== undefined) {
        candidates.push({ kind: "operation", operation, option: metadata.cli.negative_flag, argument, metadata, directness: 1 });
      }
      for (const option of metadata.cli?.flags ?? []) {
        candidates.push({ kind: "operation", operation, option, argument, metadata, directness: 2 });
      }
    }
  }
  return candidates;
}

function cliOptionValuePlaceholder(argument: string, metadata: OperationArgumentMetadata, option: string): string | undefined {
  if (metadata.type === "boolean") return undefined;
  if (metadata.type === "number") return "<number>";
  if (metadata.type === "object" || option.endsWith("-json")) return "<json object>";
  if (metadata.allowed_values !== undefined) return `<${argument} from allowed_values>`;
  return `<${argument}>`;
}

function cliSuggestionScore(query: string, candidate: string): number {
  const normalizedQuery = normalizeCliSuggestionValue(query);
  const normalizedCandidate = normalizeCliSuggestionValue(candidate);
  let score = cliLevenshteinDistance(normalizedQuery, normalizedCandidate);
  if (normalizedCandidate.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedCandidate)) {
    score -= 8;
  } else if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
    score -= 4;
  }
  const queryTokens = new Set(normalizedQuery.split(/[\s_-]+/u).filter(Boolean));
  for (const token of normalizedCandidate.split(/[\s_-]+/u)) {
    if (token && queryTokens.has(token)) score -= 3;
  }
  return score;
}

function normalizeCliSuggestionValue(value: string): string {
  return value.trim().toLowerCase();
}

function cliLevenshteinDistance(left: string, right: string): number {
  const distances = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0) as number[]);
  for (let index = 0; index <= left.length; index += 1) distances[index][0] = index;
  for (let index = 0; index <= right.length; index += 1) distances[0][index] = index;
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      distances[leftIndex][rightIndex] = Math.min(
        distances[leftIndex - 1][rightIndex] + 1,
        distances[leftIndex][rightIndex - 1] + 1,
        distances[leftIndex - 1][rightIndex - 1] + substitutionCost
      );
    }
  }
  return distances[left.length][right.length];
}

function requiredCliOptionError(option: string, placeholder: string, message?: string, source = requiredCliOptionSource(option)): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: ${message ?? `required option '${option} ${placeholder}' not specified`}`,
    `retry with required ${option}`,
    {
      ...(source !== undefined ? { operation_contract: `operations_by_id.${source.operation}` as const } : {}),
      missing_argument: { option, placeholder },
      expected: { kind: "required_option", required: true },
      ...(source !== undefined
        ? { argument_sources: { [source.argument]: `operations_by_id.${source.operation}.arguments_by_name.${source.argument}` as const } }
        : {}),
      retry_with: { option, value_placeholder: placeholder }
    }
  );
}

function requiredCliPositionalArgumentError(
  positional: string,
  placeholder: string,
  message?: string,
  source = requiredCliPositionalArgumentSource(positional)
): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: ${message ?? `missing required argument '${positional}'`}`,
    `retry with required <${positional}>`,
    {
      ...(source !== undefined ? { operation_contract: `operations_by_id.${source.operation}` as const } : {}),
      missing_argument: { positional, placeholder },
      expected: { kind: "required_positional", required: true },
      ...(source !== undefined
        ? { argument_sources: { [source.argument]: `operations_by_id.${source.operation}.arguments_by_name.${source.argument}` as const } }
        : {}),
      retry_with: { positional, value_placeholder: placeholder }
    }
  );
}

function cliParserArgumentSource(option: string): CliParserSource | undefined {
  if (option === "--text") return { operation: "write", argument: "text" };
  if (option === "--tag") return { operation: "write", argument: "tags" };
  if (option === "--derived-from") return { operation: "write", argument: "derived_from" };
  if (option === "--cursor") return { operation: "refresh", argument: "cursor" };
  if (option === "--message") return { operation: "sync_push", argument: "message" };
  if (option === "--host") return { operation: "install", argument: "host" };
  const commandPath = cliCommandPath(process.argv.slice(2));
  if (commandPath[0] === "capture" && commandPath[1] === "session") {
    if (option === "--summary") return { operation: "capture_session", argument: "summary" };
    if (option === "--project") return { operation: "capture_session", argument: "project_path" };
    if (option === "--project-id") return { operation: "capture_session", argument: "project_id" };
    if (option === "--sync-remote") return { operation: "capture_session", argument: "sync_remote" };
    if (option === "--current-task") return { operation: "capture_session", argument: "current_task" };
    if (option === "--file") return { operation: "capture_session", argument: "files" };
    if (option === "--agent") return { operation: "capture_session", argument: "agent_client" };
    if (option === "--session-id") return { operation: "capture_session", argument: "agent_session_id" };
    if (option === "--model") return { operation: "capture_session", argument: "agent_model" };
    if (option === "--device-id") return { operation: "capture_session", argument: "agent_device_id" };
  }
  if (commandPath[0] === "capture" && commandPath[1] === "policy") {
    if (option === "--project") return { operation: "capture_policy", argument: "project_path" };
    if (option === "--project-id") return { operation: "capture_policy", argument: "project_id" };
    if (option === "--limit") return { operation: "capture_policy", argument: "limit" };
  }
  if (commandPath[0] === "context" && commandPath[1] === "pack") {
    if (option === "--project") return { operation: "context_pack", argument: "project_path" };
    if (option === "--project-id") return { operation: "context_pack", argument: "project_id" };
    if (option === "--sync-remote") return { operation: "context_pack", argument: "sync_remote" };
    if (option === "--current-task") return { operation: "context_pack", argument: "current_task" };
    if (option === "--limit") return { operation: "context_pack", argument: "limit" };
    if (option === "--agent") return { operation: "context_pack", argument: "agent_client" };
    if (option === "--session-id") return { operation: "context_pack", argument: "agent_session_id" };
    if (option === "--model") return { operation: "context_pack", argument: "agent_model" };
    if (option === "--device-id") return { operation: "context_pack", argument: "agent_device_id" };
  }
  if (commandPath[0] === "memory" && commandPath[1] === "doctor") {
    if (option === "--project") return { operation: "memory_doctor", argument: "project_path" };
    if (option === "--project-id") return { operation: "memory_doctor", argument: "project_id" };
    if (option === "--limit") return { operation: "memory_doctor", argument: "limit" };
  }
  if (commandPath[0] === "memory" && commandPath[1] === "lifecycle") {
    if (option === "--project") return { operation: "memory_lifecycle", argument: "project_path" };
    if (option === "--project-id") return { operation: "memory_lifecycle", argument: "project_id" };
    if (option === "--limit") return { operation: "memory_lifecycle", argument: "limit" };
    if (option === "--now") return { operation: "memory_lifecycle", argument: "now" };
  }
  if (commandPath[0] === "dogfood" && commandPath[1] === "report") {
    if (option === "--project") return { operation: "dogfood_report", argument: "project_path" };
    if (option === "--project-id") return { operation: "dogfood_report", argument: "project_id" };
    if (option === "--limit") return { operation: "dogfood_report", argument: "limit" };
  }
  if (commandPath[0] === "project" && commandPath[1] === "migrate") {
    if (option === "--from") return { operation: "project_migrate", argument: "from_project_id" };
    if (option === "--to") return { operation: "project_migrate", argument: "to_project_id" };
    if (option === "--dry-run") return { operation: "project_migrate", argument: "dry_run" };
    if (option === "--apply") return { operation: "project_migrate", argument: "dry_run" };
    if (option === "--confirm") return { operation: "project_migrate", argument: "confirmed" };
    if (option === "--include-private") return { operation: "project_migrate", argument: "include_private" };
  }
  if (commandPath[0] === "contracts" && commandPath[1] === "operations") {
    if (option === "--operation") return { operation: "operation_contracts", argument: "operation" };
    if (option === "--mcp-tool") return { operation: "operation_contracts", argument: "mcp_tool" };
    if (option === "--cli-command") return { operation: "operation_contracts", argument: "cli_command" };
  }
  return undefined;
}

function cliValuePlaceholderForOption(option: string, source?: CliParserSource): string {
  if (source?.operation === "operation_contracts") return `<${source.argument}>`;
  return `<non-empty ${option.replace(/^--/, "")}>`;
}

function nonEmptyCliArgumentError(option: string, source = cliParserArgumentSource(option)): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: Invalid ${option}; must not be empty`,
    `retry with a non-empty ${option} value`,
    {
      ...(source !== undefined ? { operation_contract: `operations_by_id.${source.operation}` as const } : {}),
      rejected_argument: { option, value: "" },
      expected: { kind: "non_empty_string", min_length: 1 },
      ...(source !== undefined
        ? { argument_sources: { [source.argument]: `operations_by_id.${source.operation}.arguments_by_name.${source.argument}` as const } }
        : {}),
      retry_with: { option, value_placeholder: cliValuePlaceholderForOption(option, source) }
    }
  );
}

function nonEmptyCliPositionalArgumentError(positional: string, source?: CliParserSource): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: Invalid ${positional}; must not be empty`,
    `retry with a non-empty <${positional}> value`,
    {
      ...(source !== undefined ? { operation_contract: `operations_by_id.${source.operation}` as const } : {}),
      rejected_argument: { positional, value: "" },
      expected: { kind: "non_empty_string", min_length: 1 },
      ...(source !== undefined
        ? { argument_sources: { [source.argument]: `operations_by_id.${source.operation}.arguments_by_name.${source.argument}` as const } }
        : {}),
      retry_with: { positional, value_placeholder: `<non-empty ${positional}>` }
    }
  );
}

function contentJsonCliArgumentError(value: string, expectedKind: "valid_json_object" | "json_object", detail?: string): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: Invalid --content-json${detail ? `; ${detail}` : ""}`,
    "retry with a valid --content-json JSON object",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { option: "--content-json", value },
      expected: { kind: expectedKind },
      argument_sources: { "--content-json": WRITE_CONTENT_ARGUMENT_SOURCE },
      retry_with: { option: "--content-json", value_placeholder: "<json object>" }
    }
  );
}

const WRITE_CONTENT_RETRY_OPTIONS = [
  { option: "--text", value_placeholder: "<text>" },
  { option: "--content-json", value_placeholder: "<json object>" }
] as const;

function writeContentChoiceCliArgumentError(
  message: string,
  rejectedArguments?: Array<{ option: "--text" | "--content-json"; value: string }>
): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry with exactly one write content input",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      ...(rejectedArguments
        ? { rejected_arguments: rejectedArguments }
        : { missing_one_of: [...WRITE_CONTENT_RETRY_OPTIONS] }),
      expected: { kind: "choose_one", options: ["--text", "--content-json"] },
      argument_sources: {
        "--text": WRITE_TEXT_ARGUMENT_SOURCE,
        "--content-json": WRITE_CONTENT_ARGUMENT_SOURCE
      },
      retry_with: [...WRITE_CONTENT_RETRY_OPTIONS]
    }
  );
}

function setAssignmentCliArgumentError(assignment: string): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: Invalid --set assignment: ${assignment}`,
    "retry with a valid --set path assignment",
    {
      operation_contract: "operations_by_id.revise",
      rejected_argument: { option: "--set", value: assignment },
      expected: {
        kind: "path_assignment",
        key_path: "dot-separated patch path",
        separator: "=",
        value: "JSON scalar/object/array or string"
      },
      argument_sources: {
        patch: "operations_by_id.revise.arguments_by_name.patch"
      },
      retry_with: { option: "--set", value_placeholder: "<path>=<json-or-string>" }
    }
  );
}

const SYNC_OPERATION_CONTRACTS = {
  "--status": "operations_by_id.sync_status",
  "--push": "operations_by_id.sync_push",
  "--pull": "operations_by_id.sync_pull"
} as const;

const SYNC_OPERATION_RETRY_OPTIONS = [
  { option: "--status", operation_contract: SYNC_OPERATION_CONTRACTS["--status"] },
  { option: "--push", operation_contract: SYNC_OPERATION_CONTRACTS["--push"] },
  { option: "--pull", operation_contract: SYNC_OPERATION_CONTRACTS["--pull"] }
] as const;

type SyncOperationArgument = { option: "--status" | "--push" | "--pull"; value: true; operation_contract: CliSyncOperationContractSource };

function syncOperationChoiceCliArgumentError(rejectedArguments: SyncOperationArgument[]): CliArgumentError {
  return new CliArgumentError(
    "Invalid argument: choose only one sync operation",
    "retry with exactly one sync operation",
    {
      operation_contracts: SYNC_OPERATION_CONTRACTS,
      rejected_arguments: rejectedArguments,
      expected: { kind: "choose_one", options: ["--status", "--push", "--pull"] },
      retry_with: [...SYNC_OPERATION_RETRY_OPTIONS]
    }
  );
}

function syncMessageRequiresPushCliArgumentError(message: string): CliArgumentError {
  return new CliArgumentError(
    "Invalid argument: --message requires --push",
    "retry with --push when using --message",
    {
      operation_contract: "operations_by_id.sync_push",
      rejected_argument: { option: "--message", value: message },
      expected: { kind: "requires_option", option: "--message", requires: "--push" },
      argument_sources: {
        message: "operations_by_id.sync_push.arguments_by_name.message"
      },
      retry_with: {
        required_option: "--push",
        operation_contract: "operations_by_id.sync_push",
        option: "--message",
        value_placeholder: "<message>"
      }
    }
  );
}

function createCliEngine() {
  const path = storePath();
  return createEngine({
    storePath: path,
    syncStatus: () => getGitSyncStatus(path)
  });
}

async function resolveOptionalProject(options: { project?: string; projectId?: string }, operation: CliParserOperation): Promise<string | undefined> {
  const projectPath = parseNonEmptyCliString(options.project, "--project", { operation, argument: "project_path" });
  const projectId = parseNonEmptyCliString(options.projectId, "--project-id", { operation, argument: "project_id" });
  if (!projectPath && !projectId) return undefined;
  return (await resolveProjectContext({ projectPath, projectId })).project_id;
}

async function resolveProjectOptions(options: { project?: string; projectId?: string }, operation: CliParserOperation): Promise<{ project_id?: string; default_skills?: string[] }> {
  const projectPath = parseNonEmptyCliString(options.project, "--project", { operation, argument: "project_path" });
  const projectId = parseNonEmptyCliString(options.projectId, "--project-id", { operation, argument: "project_id" });
  if (!projectPath && !projectId) return {};
  const project = await resolveProjectContext({ projectPath, projectId });
  return {
    project_id: project.project_id,
    default_skills: project.config?.default_skills
  };
}

function parseAssignmentValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function patchFromAssignments(assignments: readonly string[]): Record<string, unknown> | undefined {
  const entries: Array<[string, unknown]> = [];
  for (const assignment of assignments) {
    const [key, ...rest] = assignment.split("=");
    if (!key || !isValidPatchPath(key) || !rest.length) return undefined;
    entries.push([key, parseAssignmentValue(rest.join("="))]);
  }
  return Object.fromEntries(entries);
}

function parseAssignments(assignments: string[]): Record<string, unknown> {
  const patch = patchFromAssignments(assignments);
  if (patch === undefined) {
    for (const assignment of assignments) {
      const [key, ...rest] = assignment.split("=");
      if (!key || !isValidPatchPath(key) || !rest.length) {
        throw setAssignmentCliArgumentError(assignment);
      }
    }
  }
  return patch ?? Object.fromEntries(assignments.map((assignment) => {
    const [key, ...rest] = assignment.split("=");
    if (!key || !rest.length) {
      throw setAssignmentCliArgumentError(assignment);
    }
    return [key, parseAssignmentValue(rest.join("="))];
  }));
}

function parseContentJson(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw contentJsonCliArgumentError(value, "valid_json_object", message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw contentJsonCliArgumentError(value, "json_object", "expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseRecallEvalCases(value: string | undefined): RecallEvalCaseInput[] {
  const raw = parseNonEmptyCliString(value, "--cases", { operation: "recall_eval", argument: "cases" });
  if (raw === undefined) {
    throw new CliArgumentError(
      "Invalid argument: Missing required option --cases",
      "retry recall eval with --cases JSON",
      {
        operation_contract: "operations_by_id.recall_eval",
        rejected_argument: { option: "--cases", value: "" },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: { cases: "operations_by_id.recall_eval.arguments_by_name.cases" },
        retry_with: { option: "--cases", value_placeholder: "<json cases array>" }
      }
    );
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    return parsed as RecallEvalCaseInput[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliArgumentError(
      `Invalid argument: Invalid --cases JSON: ${message}`,
      "retry recall eval with a JSON array of golden cases",
      {
        operation_contract: "operations_by_id.recall_eval",
        rejected_argument: { option: "--cases", value: raw },
        expected: { kind: "json_array" },
        argument_sources: { cases: "operations_by_id.recall_eval.arguments_by_name.cases" },
        retry_with: { option: "--cases", value_placeholder: "[{\"case_id\":\"<id>\",\"query\":\"<query>\",\"expected_record_ids\":[\"<record_id>\"]}]" }
      }
    );
  }
}

function parseLimit(value: string, operation?: CliLimitOperation, option = "--limit"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new CliArgumentError(
      `Invalid argument: Invalid ${option}; must be an integer between 1 and 100`,
      `${CLI_ARGUMENT_RECOVERY_ACTION_PREFIX} ${option} value`,
      {
        ...(operation !== undefined ? { operation_contract: `operations_by_id.${operation}` as const } : {}),
        rejected_argument: { option, value },
        expected: { kind: "integer_range", min: 1, max: 100, integer: true },
        ...(operation !== undefined ? { argument_sources: { limit: `operations_by_id.${operation}.arguments_by_name.limit` as const } } : {}),
        retry_with: { option, value_placeholder: "<integer 1-100>" }
      }
    );
  }
  return parsed;
}

function parseTimelineWindow(value: string, option: "--before" | "--after"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 50) {
    const argument = option.slice(2);
    throw new CliArgumentError(
      `Invalid argument: Invalid ${option}; must be an integer between 0 and 50`,
      `${CLI_ARGUMENT_RECOVERY_ACTION_PREFIX} ${option} value`,
      {
        operation_contract: "operations_by_id.timeline",
        rejected_argument: { option, value },
        expected: { kind: "integer_range", min: 0, max: 50, integer: true },
        argument_sources: { [argument]: `operations_by_id.timeline.arguments_by_name.${argument}` },
        retry_with: { option, value_placeholder: "<integer 0-50>" }
      }
    );
  }
  return parsed;
}

function parseConfidence(value: string | undefined, option = "--confidence", source?: CliWriteSource): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CliArgumentError(
      `Invalid argument: Invalid ${option}; must be a number between 0 and 1`,
      `${CLI_ARGUMENT_RECOVERY_ACTION_PREFIX} ${option} value`,
      {
        ...(source !== undefined ? { operation_contract: WRITE_OPERATION_CONTRACT_SOURCE } : {}),
        rejected_argument: { option, value },
        expected: { kind: "number_range", min: 0, max: 1, inclusive: true },
        ...(source !== undefined ? { argument_sources: { [source.argument]: `operations_by_id.write.arguments_by_name.${source.argument}` as const } } : {}),
        retry_with: { option, value_placeholder: "<number 0-1>" }
      }
    );
  }
  return parsed;
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], option: string, source?: CliEnumSource): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new CliArgumentError(
      `Invalid argument: Invalid ${option}; expected one of ${allowed.join(", ")}`,
      `retry with a supported ${option} value`,
      {
        ...(source !== undefined ? { operation_contract: `operations_by_id.${source.operation}` as const } : {}),
        rejected_argument: { option, value },
        expected: { kind: "allowed_values", allowed_values: [...allowed] },
        ...(source !== undefined
          ? { argument_sources: { [source.argument]: `operations_by_id.${source.operation}.arguments_by_name.${source.argument}` as const } }
          : {}),
        retry_with: { option, value_placeholder: `<${option.slice(2)} from allowed_values>` }
      }
    );
  }
  return value as T;
}

function parseEnumList<T extends string>(values: string[], allowed: readonly T[], option: string, source?: CliEnumSource): T[] {
  return values.map((value) => parseEnum(value, allowed, option, source) as T);
}

function parseProjectSyncMode(value: string | undefined): SyncMode | undefined {
  const parsed = parseEnum(value, projectSyncModeInputs, "--sync-mode", { operation: "project_init", argument: "sync_mode" });
  return parsed === "auto" ? "interval" : parsed;
}

function parseNonEmptyString(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw nonEmptyCliArgumentError(option);
  }
  return value;
}

function parseNonEmptyCliString(value: string | undefined, option: string, source?: CliParserSource): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw nonEmptyCliArgumentError(option, source);
  }
  return value;
}

function parseNonEmptyCliPositional(value: string, positional: string, source?: CliParserSource): string {
  if (value.length === 0) {
    throw nonEmptyCliPositionalArgumentError(positional, source);
  }
  return value;
}

function collectNonEmptyOption(option: string, source?: CliParserSource) {
  return (value: string, previous: string[] = []): string[] => {
    if (value.length === 0) {
      throw nonEmptyCliArgumentError(option, source);
    }
    return [...previous, value];
  };
}

function validateSyncOperationOptions(options: { status?: boolean; push?: boolean; pull?: boolean; message?: string }): void {
  const selected: SyncOperationArgument[] = [
    ...(options.status ? [{ option: "--status" as const, value: true as const, operation_contract: SYNC_OPERATION_CONTRACTS["--status"] }] : []),
    ...(options.push ? [{ option: "--push" as const, value: true as const, operation_contract: SYNC_OPERATION_CONTRACTS["--push"] }] : []),
    ...(options.pull ? [{ option: "--pull" as const, value: true as const, operation_contract: SYNC_OPERATION_CONTRACTS["--pull"] }] : [])
  ];
  if (selected.length > 1) {
    throw syncOperationChoiceCliArgumentError(selected);
  }
  if (options.message !== undefined && !options.push) {
    throw syncMessageRequiresPushCliArgumentError(options.message);
  }
}

function parseBooleanDefault(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : Boolean(value);
}

function parseCheckpointJson(value: string, option: "--delta" | "--learning"): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid argument: Invalid ${option} JSON: ${message}`);
  }
}

type DashboardCliOptions = {
  open?: boolean;
  limit?: string;
  serve?: boolean;
  host?: string;
  readinessHost?: string;
  syncRemote?: string;
  port?: string;
  interval?: string;
  includePrivate?: boolean;
  project?: string;
  projectId?: string;
};

type DashboardCliMetadata =
  | DashboardSnapshot
  | (Omit<DashboardServerHandle, "close"> & {
      opened: boolean;
    })
  | {
      generated: false;
      opened: false;
      error: string;
    };

function dashboardOpenRequested(options: DashboardCliOptions): boolean {
  if (options.open !== undefined) return options.open;
  return Boolean(process.stdout.isTTY) && process.env.CI !== "true";
}

function parseDashboardPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Invalid argument: Invalid dashboard port; must be an integer between 0 and 65535");
  }
  return port;
}

function parseDashboardInterval(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const interval = Number(value);
  if (!Number.isInteger(interval) || interval < 250 || interval > 60000) {
    throw new Error("Invalid argument: Invalid dashboard interval; must be an integer between 250 and 60000");
  }
  return interval;
}

async function dashboardMetadata(options: DashboardCliOptions = {}): Promise<DashboardCliMetadata> {
  try {
    const limit = options.limit === undefined ? undefined : parseLimit(options.limit, "dashboard");
    const projectId = await resolveOptionalProject(options, "dashboard");
    if (options.serve) {
      const server = await startDashboardServer(storePath(), {
        host: options.host,
        port: parseDashboardPort(options.port),
        refreshIntervalMs: parseDashboardInterval(options.interval),
        limit,
        include_private: options.includePrivate,
        project_id: projectId,
        readiness_host: parseNonEmptyString(options.readinessHost, "--readiness-host"),
        sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote")
      });
      const shouldOpen = dashboardOpenRequested(options);
      if (shouldOpen) await openDashboard(server.url);
      return {
        serving: server.serving,
        host: server.host,
        port: server.port,
        url: server.url,
        refresh_interval_ms: server.refresh_interval_ms,
        opened: shouldOpen
      };
    }
    const snapshot = await writeDashboardSnapshot(storePath(), {
      limit,
      include_private: options.includePrivate,
      project_id: projectId,
      readiness_host: parseNonEmptyString(options.readinessHost, "--readiness-host"),
      sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote")
    });
    const shouldOpen = dashboardOpenRequested(options);
    if (!shouldOpen) return snapshot;
    await openDashboard(snapshot.url);
    return { ...snapshot, opened: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      generated: false,
      opened: false,
      error: message
    };
  }
}

async function withDashboard<T extends object>(result: T, options: DashboardCliOptions = {}): Promise<T & { dashboard: DashboardCliMetadata }> {
  return {
    ...result,
    dashboard: await dashboardMetadata(options)
  };
}

function agentOptionSource(operation: CliParserOperation | undefined, argument: string): CliParserSource | undefined {
  return operation === undefined ? undefined : { operation, argument };
}

function parseAgentOptions(options: { agent?: string; sessionId?: string; model?: string; deviceId?: string }, operation?: CliParserOperation) {
  return {
    client: parseNonEmptyCliString(options.agent, "--agent", agentOptionSource(operation, "agent_client")) ?? "cli",
    session_id: parseNonEmptyCliString(options.sessionId, "--session-id", agentOptionSource(operation, "agent_session_id")),
    model: parseNonEmptyCliString(options.model, "--model", agentOptionSource(operation, "agent_model")),
    device_id: parseNonEmptyCliString(options.deviceId, "--device-id", agentOptionSource(operation, "agent_device_id"))
  };
}

function hasAgentOptions(options: { agent?: string; sessionId?: string; model?: string; deviceId?: string }): boolean {
  return options.agent !== undefined || options.sessionId !== undefined || options.model !== undefined || options.deviceId !== undefined;
}

function lifecycleStringSource(operation: CliParserOperation, argument: string): CliParserSource {
  return { operation, argument };
}

function compactUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

program
  .name("moryn")
  .description("Moryn CLI")
  .version(version)
  .configureOutput({
    outputError: () => {}
  })
  .exitOverride()
  .option("--store <path>", "Override Moryn store path");

program.command("init")
  .option("--repair", "Replace an invalid local config.json after explicit confirmation")
  .action(async (options) => {
    printJson({ ok: true, ...await initializeStore(storePath(), { repair: options.repair }) });
  });

program.command("install")
  .option("--host <host>", "Agent host to prepare: claude, codex, gemini, cursor, or shell")
  .option("--project <path>", "Project path to attach to Moryn")
  .option("--sync-remote <remote>", "User-owned Git remote to include in generated commands")
  .option("--apply", "Run safe Moryn-local setup; never mutates host configuration files")
  .action(async (options) => {
    const host = parseNonEmptyString(options.host, "--host");
    const projectPath = parseNonEmptyString(options.project, "--project");
    const syncRemote = parseNonEmptyString(options.syncRemote, "--sync-remote");
    const plan = planInstall({
      host,
      projectPath,
      syncRemote,
      apply: Boolean(options.apply)
    });
    if (options.apply) {
      await initializeStore(storePath());
      if (projectPath) {
        await initializeProjectConfig(projectPath, {});
      }
    }
    printJson(plan);
  });

program.command("setup")
  .option("--host <host>", "Agent host to prepare: claude, codex, gemini, cursor, or shell")
  .option("--project <path>", "Project path to attach to Moryn")
  .option("--sync-remote <remote>", "User-owned Git remote to include in generated commands")
  .option("--apply", "Run safe Moryn-local setup; never mutates host configuration files")
  .action(async (options) => {
    const host = parseNonEmptyString(options.host, "--host");
    const projectPath = parseNonEmptyString(options.project, "--project");
    const syncRemote = parseNonEmptyString(options.syncRemote, "--sync-remote");
    const contextArguments = compactUndefined({
      host,
      project_path: projectPath,
      sync_remote: syncRemote,
      ...(options.apply ? { apply: true } : {})
    });
    const context = {
      tool: "setup",
      command: commandLineForCliInterface("moryn", [
        "setup",
        ...(host ? ["--host", host] : []),
        ...(projectPath ? ["--project", projectPath] : []),
        ...(syncRemote ? ["--sync-remote", syncRemote] : []),
        ...(options.apply ? ["--apply"] : [])
      ]),
      arguments: contextArguments
    };
    try {
      printJson(await setupWizard({
        storePath: storePath(),
        host,
        projectPath,
        syncRemote,
        apply: Boolean(options.apply)
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

const capture = program.command("capture");

capture.command("session")
  .requiredOption("--summary <text>", "Session handoff summary to capture")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>")
  .option("--current-task <task>")
  .option("--file <path>", "Touched file path", collectNonEmptyOption("--file", { operation: "capture_session", argument: "files" }), [])
  .option("--agent <client>", "Agent host/client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const summary = parseNonEmptyString(options.summary, "--summary")!;
    const result = await captureSession({
      storePath: storePath(),
      projectPath: parseNonEmptyString(options.project, "--project"),
      projectId: parseNonEmptyString(options.projectId, "--project-id"),
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      summary,
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      files: options.file,
      agent: parseAgentOptions(options)
    });
    printJson(result);
  });

capture.command("policy")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--limit <n>", "Decision/action limit", "20")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "capture_policy");
    printJson(await engine.capturePolicy({
      project_id: projectId,
      limit: parseLimit(options.limit, "capture_policy"),
      include_private: options.includePrivate
    }));
  });

const context = program.command("context");

context.command("pack")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>")
  .option("--current-task <task>")
  .option("--limit <n>", "Refresh change limit", "20")
  .option("--no-pull", "Do not pull sync before building the context pack")
  .option("--include-private", "Reserved for explicit private context requests")
  .option("--agent <client>", "Agent host/client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const pull = parseBooleanDefault(options.pull, true);
    const result = await contextPack({
      storePath: storePath(),
      projectPath: parseNonEmptyString(options.project, "--project"),
      projectId: parseNonEmptyString(options.projectId, "--project-id"),
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      limit: parseLimit(options.limit, "context_pack"),
      includePrivate: Boolean(options.includePrivate),
      pull,
      agent: parseAgentOptions(options)
    });
    printJson(result);
  });

program.command("write")
  .requiredOption("--kind <kind>")
  .option("--type <type>")
  .option("--scope <scope>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--tag <tag>", "Record tag", collectNonEmptyOption("--tag"), [])
  .option("--state <state>")
  .option("--confidence <n>", "Record confidence")
  .option("--priority <priority>")
  .option("--derived-from <id>", "Source record id for provenance", collectNonEmptyOption("--derived-from"), [])
  .option("--reason <reason>", "Provenance reason")
  .option("--confirm", "Confirm a high-risk canonical write")
  .option("--text <text>")
  .option("--content-json <json>", "Structured JSON object content")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "write");
    const projectPath = parseNonEmptyCliString(options.project, "--project", { operation: "write", argument: "project_path" });
    const optionProjectId = parseNonEmptyCliString(options.projectId, "--project-id", { operation: "write", argument: "project_id" });
    const project = projectPath ? await resolveProjectContext({ projectPath, projectId: optionProjectId }) : undefined;
    const type = options.type ?? (options.kind === "session_summary" ? "summary" : undefined);
    const scope = options.scope ?? (options.kind === "session_summary" ? "project" : undefined);
    if (!type) throw requiredCliOptionError("--type", "<type>", undefined, { operation: "write", argument: "type" });
    if (!scope) throw requiredCliOptionError("--scope", "<scope>", undefined, { operation: "write", argument: "scope" });
    const content = parseContentJson(options.contentJson);
    const text = parseNonEmptyString(options.text, "--text");
    const reason = parseNonEmptyCliString(options.reason, "--reason", { operation: "write", argument: "reason" });
    if (content && text !== undefined) {
      throw writeContentChoiceCliArgumentError(
        "use either --text or --content-json, not both",
        [
          { option: "--text", value: text },
          { option: "--content-json", value: options.contentJson }
        ]
      );
    }
    if (!content && text === undefined) {
      throw writeContentChoiceCliArgumentError("required option '--text <text>' or '--content-json <json>' not specified");
    }
    const result = await engine.write({
      kind: parseEnum(options.kind, recordKinds, "--kind", { operation: "write", argument: "kind" })!,
      type,
      scope: parseEnum(scope, recordScopes, "--scope", { operation: "write", argument: "scope" })!,
      project_id: projectId,
      tags: [...(project?.config?.tags ?? []), ...options.tag],
      content: content ?? { text, format: "text" },
      state: parseEnum(options.state, recordStates, "--state", { operation: "write", argument: "state" }),
      confidence: parseConfidence(options.confidence, "--confidence", { operation: "write", argument: "confidence" }),
      priority: parseEnum(options.priority, recordPriorities, "--priority", { operation: "write", argument: "priority" }),
      source: { client: "cli" },
      confirmed: options.confirm,
      provenance: reason || options.derivedFrom.length
        ? { reason, derived_from: options.derivedFrom }
        : undefined
    });
    printJson(result);
  });

program.command("recall")
  .argument("[query]", "Search query")
  .option("--record-id <id>", "Record id", collectNonEmptyOption("--record-id", { operation: "recall", argument: "record_ids" }), [])
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--kind <kind>", "Record kind", collectNonEmptyOption("--kind", { operation: "recall", argument: "kinds" }), [])
  .option("--scope <scope>", "Record scope", collectNonEmptyOption("--scope", { operation: "recall", argument: "scopes" }), [])
  .option("--type <type>", "Record type", collectNonEmptyOption("--type", { operation: "recall", argument: "types" }), [])
  .option("--state <state>", "Record state", collectNonEmptyOption("--state", { operation: "recall", argument: "states" }), [])
  .option("--tag <tag>", "Record tag", collectNonEmptyOption("--tag", { operation: "recall", argument: "tags" }), [])
  .option("--file <path>", "Related file path", collectNonEmptyOption("--file", { operation: "recall", argument: "files" }), [])
  .option("--limit <n>", "Result limit", "10")
  .option("--include-private", "Include private-tagged records")
  .action(async (query, options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "recall");
    const limit = parseLimit(options.limit, "recall");
    const recallInput = {
      record_ids: options.recordId,
      query: query === undefined
        ? undefined
        : parseNonEmptyCliPositional(query, "query", { operation: "recall", argument: "query" }),
      project_id: projectId,
      kinds: parseEnumList(options.kind, recordKinds, "--kind", { operation: "recall", argument: "kinds" }),
      scopes: parseEnumList(options.scope, recordScopes, "--scope", { operation: "recall", argument: "scopes" }),
      types: options.type,
      states: parseEnumList(options.state, recordStates, "--state", { operation: "recall", argument: "states" }),
      tags: options.tag,
      files: options.file,
      limit,
      include_private: options.includePrivate
    };
    const contextArguments = {
      ...(options.recordId.length ? { record_ids: options.recordId } : {}),
      ...(recallInput.query !== undefined ? { query: recallInput.query } : {}),
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      ...(recallInput.kinds.length ? { kinds: recallInput.kinds } : {}),
      ...(recallInput.scopes.length ? { scopes: recallInput.scopes } : {}),
      ...(options.type.length ? { types: options.type } : {}),
      ...(recallInput.states.length ? { states: recallInput.states } : {}),
      ...(options.tag.length ? { tags: options.tag } : {}),
      ...(options.file.length ? { files: options.file } : {}),
      ...(options.limit !== "10" ? { limit } : {}),
      ...(options.includePrivate ? { include_private: true } : {})
    };
    const context = {
      tool: "recall",
      command: commandForRecallContext(contextArguments),
      arguments: contextArguments
    };
    try {
      printJson(await engine.recall(recallInput));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("timeline")
  .option("--record-id <id>")
  .option("--event-id <id>")
  .option("--query <query>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--before <n>", "Events before the anchor", "5")
  .option("--after <n>", "Events after the anchor", "5")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "timeline");
    const recordId = parseNonEmptyCliString(options.recordId, "--record-id", { operation: "timeline", argument: "record_id" });
    const eventId = parseNonEmptyCliString(options.eventId, "--event-id", { operation: "timeline", argument: "event_id" });
    const query = parseNonEmptyCliString(options.query, "--query", { operation: "timeline", argument: "query" });
    const before = parseTimelineWindow(options.before, "--before");
    const after = parseTimelineWindow(options.after, "--after");
    const contextArguments = compactUndefined({
      record_id: recordId,
      event_id: eventId,
      query,
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      ...(options.project !== undefined ? { project_path: options.project } : {}),
      ...(options.before !== "5" ? { before } : {}),
      ...(options.after !== "5" ? { after } : {}),
      ...(options.includePrivate ? { include_private: true } : {})
    });
    const context = {
      tool: "timeline",
      command: commandForTimelineContext(contextArguments),
      arguments: contextArguments
    };
    try {
      printJson(await engine.timeline({
        record_id: recordId,
        event_id: eventId,
        query,
        project_id: projectId,
        before,
        after,
        include_private: options.includePrivate
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("boot")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--current-task <task>")
  .option("--session-id <id>")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const project = await resolveProjectOptions(options, "boot");
    printJson(await engine.boot({
      project_id: project.project_id,
      default_skills: project.default_skills,
      current_task: parseNonEmptyCliString(options.currentTask, "--current-task", { operation: "boot", argument: "current_task" }),
      agent_session_id: parseNonEmptyCliString(options.sessionId, "--session-id", { operation: "boot", argument: "agent_session_id" }),
      include_private: options.includePrivate
    }));
  });

program.command("revise")
  .argument("<record-id>")
  .requiredOption("--set <assignment>", "Patch assignment, repeatable", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--reason <reason>")
  .option("--confirm", "Confirm a high-risk or conflicting canonical revision")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const parsedRecordId = parseNonEmptyCliPositional(recordId, "record-id", { operation: "revise", argument: "record_id" });
    if (!options.set.length) {
      throw requiredCliOptionError("--set", "<assignment>", "required option '--set <assignment>' not specified", { operation: "revise", argument: "patch" });
    }
    const patch = parseAssignments(options.set);
    const reason = parseNonEmptyCliString(options.reason, "--reason", { operation: "revise", argument: "reason" });
    const context = {
      tool: "revise",
      command: commandForReviseContext({ record_id: parsedRecordId, patch, reason }),
      arguments: {
        record_id: parsedRecordId,
        patch,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.revise({
        record_id: parsedRecordId,
        patch,
        reason,
        source: { client: "cli" },
        confirmed: options.confirm
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("promote")
  .argument("<record-id>")
  .requiredOption("--state <state>")
  .option("--reason <reason>")
  .option("--confirm", "Confirm a high-risk canonical promotion")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const parsedRecordId = parseNonEmptyCliPositional(recordId, "record-id", { operation: "promote", argument: "record_id" });
    const targetState = parseEnum(options.state, recordStates, "--state", { operation: "promote", argument: "target_state" })!;
    const reason = parseNonEmptyCliString(options.reason, "--reason", { operation: "promote", argument: "reason" });
    const context = {
      tool: "promote",
      command: commandForPromoteContext({ record_id: parsedRecordId, target_state: targetState, reason }),
      arguments: {
        record_id: parsedRecordId,
        target_state: targetState,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.promote({
        record_id: parsedRecordId,
        target_state: targetState,
        reason,
        source: { client: "cli" },
        confirmed: options.confirm
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("archive")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const parsedRecordId = parseNonEmptyCliPositional(recordId, "record-id", { operation: "archive", argument: "record_id" });
    const reason = parseNonEmptyCliString(options.reason, "--reason", { operation: "archive", argument: "reason" });
    const context = {
      tool: "archive",
      command: commandForArchiveContext({ record_id: parsedRecordId, reason }),
      arguments: {
        record_id: parsedRecordId,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.archive({ record_id: parsedRecordId, reason, source: { client: "cli" } }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("quarantine")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const parsedRecordId = parseNonEmptyCliPositional(recordId, "record-id", { operation: "quarantine", argument: "record_id" });
    const reason = parseNonEmptyCliString(options.reason, "--reason", { operation: "quarantine", argument: "reason" });
    const context = {
      tool: "quarantine",
      command: commandForQuarantineContext({ record_id: parsedRecordId, reason }),
      arguments: {
        record_id: parsedRecordId,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.quarantine({ record_id: parsedRecordId, reason, source: { client: "cli" } }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("link")
  .argument("<record-id>")
  .argument("<linked-record-id>")
  .requiredOption("--type <type>")
  .action(async (recordId, linkedRecordId, options) => {
    const engine = createCliEngine();
    const parsedRecordId = parseNonEmptyCliPositional(recordId, "record-id", { operation: "link", argument: "record_id" });
    const parsedLinkedRecordId = parseNonEmptyCliPositional(linkedRecordId, "linked-record-id", { operation: "link", argument: "linked_record_id" });
    const linkType = parseNonEmptyCliString(options.type, "--type", { operation: "link", argument: "link_type" })!;
    const context = {
      tool: "link",
      command: commandForLinkContext({ record_id: parsedRecordId, linked_record_id: parsedLinkedRecordId, link_type: linkType }),
      arguments: {
        record_id: parsedRecordId,
        linked_record_id: parsedLinkedRecordId,
        link_type: linkType
      }
    };
    try {
      printJson(await engine.link({
        record_id: parsedRecordId,
        linked_record_id: parsedLinkedRecordId,
        link_type: linkType,
        source: { client: "cli" }
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("logical-link")
  .argument("<record-id>")
  .argument("<linked-record-id>")
  .requiredOption("--relationship <relationship>")
  .requiredOption("--reason <reason>")
  .action(async (recordId, linkedRecordId, options) => {
    const engine = createCliEngine();
    try {
      const relationship = parseEnum(options.relationship, LOGICAL_RELATIONSHIP_TYPES, "--relationship") as LogicalRelationshipType;
      printJson(await engine.logicalLink({
        record_id: parseNonEmptyCliPositional(recordId, "record-id"),
        linked_record_id: parseNonEmptyCliPositional(linkedRecordId, "linked-record-id"),
        relationship,
        reason: parseNonEmptyCliString(options.reason, "--reason")!,
        source: { client: "cli" }
      }));
    } catch (error) {
      printError(error);
      process.exitCode = 1;
    }
  });

program.command("list-recent")
  .option("--limit <n>", "Result limit", "20")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    printJson(await engine.listRecent({
      limit: parseLimit(options.limit, "list_recent"),
      include_private: options.includePrivate
    }));
  });

const memory = program.command("memory");

memory.command("doctor")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--limit <n>", "Finding/action limit", "20")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "memory_doctor");
    printJson(await engine.memoryDoctor({
      project_id: projectId,
      limit: parseLimit(options.limit, "memory_doctor"),
      include_private: options.includePrivate
    }));
  });

memory.command("lifecycle")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--limit <n>", "Assessment/action limit", "20")
  .option("--now <iso>", "Use an explicit report timestamp")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "memory_lifecycle");
    printJson(await engine.memoryLifecycle({
      project_id: projectId,
      limit: parseLimit(options.limit, "memory_lifecycle"),
      now: parseNonEmptyCliString(options.now, "--now", { operation: "memory_lifecycle", argument: "now" }),
      include_private: options.includePrivate
    }));
  });

const dogfood = program.command("dogfood");

dogfood.command("report")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--limit <n>", "Finding/action limit", "20")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "dogfood_report");
    printJson(await engine.dogfoodReport({
      project_id: projectId,
      limit: parseLimit(options.limit, "dogfood_report"),
      include_private: options.includePrivate
    }));
  });

const health = program.command("health");

health.command("check")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--host <host>", "Host adapter to include in setup readiness commands")
  .option("--sync-remote <remote>", "Shared Git remote to include in readiness commands")
  .option("--limit <n>", "Check/action limit", "20")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "health_check");
    printJson(await engine.healthCheck({
      project_id: projectId,
      host: parseNonEmptyString(options.host, "--host"),
      sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      limit: parseLimit(options.limit, "health_check"),
      include_private: options.includePrivate
    }));
  });

const evalCommand = program.command("eval");

evalCommand.command("recall")
  .requiredOption("--cases <json>", "JSON array of golden recall cases")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "recall_eval");
    printJson(await engine.recallEval({
      project_id: projectId,
      cases: parseRecallEvalCases(options.cases),
      include_private: options.includePrivate
    }));
  });

program.command("refresh")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--cursor <cursor>")
  .option("--current-task <task>")
  .option("--limit <n>", "Change limit", "20")
  .option("--include-private", "Include private-tagged records")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options, "refresh");
    const cursor = parseNonEmptyString(options.cursor, "--cursor");
    const currentTask = parseNonEmptyCliString(options.currentTask, "--current-task", { operation: "refresh", argument: "current_task" });
    const limit = parseLimit(options.limit, "refresh");
    const contextArguments = compactUndefined({
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      cursor,
      current_task: currentTask,
      ...(options.limit !== "20" ? { limit } : {}),
      ...(options.includePrivate ? { include_private: true } : {})
    });
    const context = {
      tool: "refresh",
      command: commandForRefreshContext(contextArguments),
      arguments: contextArguments
    };
    try {
      printJson(await engine.refresh({
        project_id: projectId,
        cursor,
        current_task: currentTask,
        limit,
        include_private: options.includePrivate
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("rebuild").action(async () => {
  printJson(await rebuildDerivedViews(storePath()));
});

program.command("dashboard")
  .option("--project <path>", "Resolve dashboard project context from a project path")
  .option("--project-id <id>", "Use an explicit dashboard project id")
  .option("--open", "Open the generated dashboard in the default browser")
  .option("--no-open", "Do not open the generated dashboard")
  .option("--serve", "Serve the dashboard over local HTTP with live refresh")
  .option("--host <host>", "Dashboard server bind host", "127.0.0.1")
  .option("--readiness-host <host>", "Host adapter to include in Health Check setup readiness commands")
  .option("--sync-remote <remote>", "Shared Git remote to include in Health Check readiness commands")
  .option("--port <port>", "Dashboard server port; use 0 to choose a free port", "8765")
  .option("--interval <ms>", "Dashboard browser refresh interval in milliseconds", "2000")
  .option("--limit <n>", "Recent record and event limit", "20")
  .option("--include-private", "Include private-tagged records in dashboard data")
  .action(async (options) => {
    const limit = parseLimit(options.limit, "dashboard");
    const dashboard = await dashboardMetadata({
      open: options.open,
      limit: String(limit),
      serve: options.serve,
      host: options.host,
      readinessHost: options.readinessHost,
      syncRemote: options.syncRemote,
      port: options.port,
      interval: options.interval,
      includePrivate: options.includePrivate,
      project: options.project,
      projectId: options.projectId
    });
    if ("generated" in dashboard && dashboard.generated === false) {
      throw new Error(dashboard.error);
    }
    printJson(dashboard);
  });

const contracts = program.command("contracts");

contracts.command("selection-sources")
  .description("Print stable selection-source field-path contracts.")
  .action(() => {
    printJson(getSelectionSourceContracts());
  });

contracts.command("operations")
  .description("Print stable CLI and MCP operation contracts.")
  .option("--index", "Print a compact operation lookup index")
  .option("--operation <id>", "Print one operation contract by id")
  .option("--mcp-tool <tool>", "Print one operation contract by MCP tool name")
  .option("--cli-command <command>", "Print one operation contract by display CLI command")
  .action((options: { index?: boolean; operation?: string; mcpTool?: string; cliCommand?: string }) => {
    const operation = parseNonEmptyString(options.operation, "--operation");
    const mcpTool = parseNonEmptyString(options.mcpTool, "--mcp-tool");
    const cliCommand = parseNonEmptyString(options.cliCommand, "--cli-command");
    const lookupOptions: OperationContractLookupOption[] = [
      ...(options.index ? [{ mode: "index" as const, option: "--index" }] : []),
      ...(operation ? [{ mode: "operation" as const, option: "--operation" }] : []),
      ...(mcpTool ? [{ mode: "mcp_tool" as const, option: "--mcp-tool" }] : []),
      ...(cliCommand ? [{ mode: "cli_command" as const, option: "--cli-command" }] : [])
    ];
    if (lookupOptions.length > 1) {
      throw new OperationContractLookupConflictError(lookupOptions, "--index, --operation, --mcp-tool, or --cli-command");
    }
    if (options.index) {
      printJson(getOperationContractIndex(), { pretty: false });
      return;
    }
    if (operation) {
      const contract = getOperationContract(operation);
      if (!contract) throw new OperationContractLookupError("operation", operation);
      printJson(contract, { pretty: false });
      return;
    }
    if (mcpTool) {
      const contract = getOperationContractByMcpTool(mcpTool);
      if (!contract) throw new OperationContractLookupError("mcp_tool", mcpTool);
      printJson(contract, { pretty: false });
      return;
    }
    if (cliCommand) {
      const contract = getOperationContractByCliCommand(cliCommand);
      if (!contract) throw new OperationContractLookupError("cli_command", cliCommand);
      printJson(contract, { pretty: false });
      return;
    }
    printJson(getOperationContracts(), { pretty: false });
  });

program.command("mcp").action(async () => {
  const path = storePath();
  const engine = createEngine({
    storePath: path,
    syncStatus: () => getGitSyncStatus(path)
  });
  await runMcpServer(engine, { storePath: path });
});

const agent = program.command("agent");

agent.command("checkpoint")
  .option("--project-id <id>")
  .option("--project <path>")
  .requiredOption("--agent <client>")
  .requiredOption("--session-id <id>")
  .option("--model <model>")
  .requiredOption("--device-id <id>")
  .requiredOption("--occurred-at <timestamp>")
  .option("--delta <json>")
  .option("--checkpoint-id <id>")
  .option("--current-task <task>")
  .option("--progress <text>", "Progress item", collectNonEmptyOption("--progress"))
  .option("--decision <text>", "Decision item", collectNonEmptyOption("--decision"))
  .option("--changed-fact <text>", "Changed project fact", collectNonEmptyOption("--changed-fact"))
  .option("--blocker <text>", "Current blocker", collectNonEmptyOption("--blocker"))
  .option("--next-step <text>", "Next step", collectNonEmptyOption("--next-step"))
  .option("--file <path>", "Touched file", collectNonEmptyOption("--file"))
  .option("--candidate-memory <text>", "Candidate memory", collectNonEmptyOption("--candidate-memory"))
  .option("--candidate-skill <text>", "Candidate skill", collectNonEmptyOption("--candidate-skill"))
  .option("--learning <json>", "Learning Delta JSON", collectNonEmptyOption("--learning"))
  .option("--tag <tag>", "Checkpoint tag", collectNonEmptyOption("--tag"))
  .option("--include-private")
  .action(async (options) => {
    const operation = "checkpoint";
    const project = await resolveProjectOptions(options, operation);
    const semanticFlags = ["checkpointId", "currentTask", "progress", "decision", "changedFact", "blocker", "nextStep", "file", "candidateMemory", "candidateSkill", "learning"];
    if (options.delta !== undefined && semanticFlags.some((flag) => options[flag] !== undefined)) {
      throw new Error("Invalid argument: --delta cannot be combined with checkpoint semantic flags");
    }
    const sessionId = parseNonEmptyCliString(options.sessionId, "--session-id", { operation, argument: "source_session_id" })!;
    const delta = options.delta !== undefined
      ? parseCheckpointJson(options.delta, "--delta") as ContextDeltaInput
      : {
          session_id: sessionId,
          checkpoint_id: options.checkpointId,
          current_task: options.currentTask,
          progress: options.progress ?? [], decisions: options.decision ?? [], changed_facts: options.changedFact ?? [], blockers: options.blocker ?? [],
          next_steps: options.nextStep ?? [], files: options.file ?? [], candidate_memories: options.candidateMemory ?? [], candidate_skills: options.candidateSkill ?? [],
          learnings: (options.learning ?? []).map((value: string) => parseCheckpointJson(value, "--learning") as LearningDeltaInput)
        };
    const result = await createCliEngine().checkpoint({
      project_id: project.project_id ?? "",
      source: {
        client: parseNonEmptyCliString(options.agent, "--agent", { operation, argument: "source_client" })!,
        session_id: sessionId,
        model: parseNonEmptyCliString(options.model, "--model", { operation, argument: "source_model" }),
        device_id: parseNonEmptyCliString(options.deviceId, "--device-id", { operation, argument: "source_device_id" })!
      },
      occurred_at: parseNonEmptyCliString(options.occurredAt, "--occurred-at", { operation, argument: "occurred_at" })!,
      delta,
      tags: options.tag ?? [],
      include_private: Boolean(options.includePrivate)
    });
    printJson(result);
  });

agent.command("guide")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Shared Git remote for cross-device handoff")
  .option("--current-task <task>")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const operation = "agent_guide";
    printJson(agentGuide({
      storePath: storePath(),
      projectPath: parseNonEmptyCliString(options.project, "--project", lifecycleStringSource(operation, "project_path")),
      projectId: parseNonEmptyCliString(options.projectId, "--project-id", lifecycleStringSource(operation, "project_id")),
      syncRemote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      currentTask: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      agent: parseAgentOptions(options, operation)
    }));
  });

agent.command("enter")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before startup")
  .option("--current-task <task>")
  .option("--refresh-since <cursor>")
  .option("--limit <n>", "Refresh change or project discovery limit", "20")
  .option("--no-pull", "Do not pull sync before boot when starting a known project")
  .option("--open", "Open the generated dashboard after startup")
  .option("--no-open", "Do not open the generated dashboard after startup")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const operation = "agent_enter";
    const pull = parseBooleanDefault(options.pull, true);
    const agentOptions = parseAgentOptions(options, operation);
    const contextArguments = compactUndefined({
      project_id: parseNonEmptyCliString(options.projectId, "--project-id", lifecycleStringSource(operation, "project_id")),
      project_path: parseNonEmptyCliString(options.project, "--project", lifecycleStringSource(operation, "project_path")),
      sync_remote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      current_task: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      refresh_since: parseNonEmptyCliString(options.refreshSince, "--refresh-since", lifecycleStringSource(operation, "refresh_since")),
      ...(options.limit !== "20" ? { limit: parseLimit(options.limit, "agent_enter") } : {}),
      ...(pull === false ? { pull } : {}),
      agent: agentOptions
    });
    const context = {
      tool: "agent_enter",
      command: commandForAgentEnterContext(contextArguments),
      arguments: contextArguments
    };
    try {
      const result = await agentEnter({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
        currentTask: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
        refreshSince: parseNonEmptyCliString(options.refreshSince, "--refresh-since", lifecycleStringSource(operation, "refresh_since")),
        limit: parseLimit(options.limit, "agent_enter"),
        pull,
        agent: agentOptions
      });
      printJson(await withDashboard(result, { open: options.open }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

agent.command("doctor")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Expected Git sync remote for cross-device handoff")
  .option("--current-task <task>")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const operation = "agent_doctor";
    printJson(await agentDoctor({
      storePath: storePath(),
      projectPath: parseNonEmptyCliString(options.project, "--project", lifecycleStringSource(operation, "project_path")),
      projectId: parseNonEmptyCliString(options.projectId, "--project-id", lifecycleStringSource(operation, "project_id")),
      syncRemote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      currentTask: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      agent: parseAgentOptions(options, operation)
    }));
  });

agent.command("start")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before startup")
  .option("--current-task <task>")
  .option("--refresh-since <cursor>")
  .option("--limit <n>", "Refresh change limit", "20")
  .option("--no-pull", "Do not pull sync before boot")
  .option("--open", "Open the generated dashboard after startup")
  .option("--no-open", "Do not open the generated dashboard after startup")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const operation = "agent_start";
    const pull = parseBooleanDefault(options.pull, true);
    const agentOptions = parseAgentOptions(options, operation);
    const contextArguments = compactUndefined({
      project_id: parseNonEmptyCliString(options.projectId, "--project-id", lifecycleStringSource(operation, "project_id")),
      project_path: parseNonEmptyCliString(options.project, "--project", lifecycleStringSource(operation, "project_path")),
      sync_remote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      current_task: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      refresh_since: parseNonEmptyCliString(options.refreshSince, "--refresh-since", lifecycleStringSource(operation, "refresh_since")),
      ...(options.limit !== "20" ? { limit: parseLimit(options.limit, "agent_start") } : {}),
      ...(pull === false ? { pull } : {}),
      agent: agentOptions
    });
    const context = {
      tool: "agent_start",
      command: commandForAgentStartContext(contextArguments),
      arguments: contextArguments
    };
    try {
      const result = await agentStart({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
        currentTask: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
        refreshSince: parseNonEmptyCliString(options.refreshSince, "--refresh-since", lifecycleStringSource(operation, "refresh_since")),
        limit: parseLimit(options.limit, "agent_start"),
        pull,
        agent: agentOptions
      });
      printJson(await withDashboard(result, { open: options.open }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

agent.command("status")
  .requiredOption("--status <text>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before publishing status")
  .option("--current-task <task>")
  .option("--no-push", "Do not push sync after writing the status")
  .option("--open", "Open the generated dashboard after publishing status")
  .option("--no-open", "Do not open the generated dashboard after publishing status")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    const operation = "agent_status";
    const push = parseBooleanDefault(options.push, true);
    const agentOptions = parseAgentOptions(options, operation);
    const status = parseNonEmptyCliString(options.status, "--status", lifecycleStringSource(operation, "status"))!;
    const contextInput = {
      project_id: parseNonEmptyCliString(options.projectId, "--project-id", lifecycleStringSource(operation, "project_id")),
      project_path: parseNonEmptyCliString(options.project, "--project", lifecycleStringSource(operation, "project_path")),
      sync_remote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      current_task: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      status,
      ...(push === false ? { push } : {}),
      agent: agentOptions
    };
    const contextArguments = compactUndefined(contextInput);
    const context = {
      tool: "agent_status",
      command: commandForAgentStatusContext(contextInput),
      arguments: contextArguments
    };
    try {
      const result = await agentStatus({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
        currentTask: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
        status,
        push,
        agent: agentOptions
      });
      printJson(await withDashboard(result, { open: options.open }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

agent.command("finish")
  .requiredOption("--summary <text>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before handoff")
  .option("--current-task <task>")
  .option("--no-push", "Do not push sync after writing the handoff")
  .option("--open", "Open the generated dashboard after publishing handoff")
  .option("--no-open", "Do not open the generated dashboard after publishing handoff")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .option("--learning <json>", "Learning Delta JSON", collectNonEmptyOption("--learning"))
  .action(async (options) => {
    const operation = "agent_finish";
    const push = parseBooleanDefault(options.push, true);
    const agentOptions = parseAgentOptions(options, operation);
    const summary = parseNonEmptyCliString(options.summary, "--summary", lifecycleStringSource(operation, "summary"))!;
    const learnings = (options.learning ?? []).map((value: string) => parseCheckpointJson(value, "--learning") as LearningDeltaInput);
    const contextInput = {
      project_id: parseNonEmptyCliString(options.projectId, "--project-id", lifecycleStringSource(operation, "project_id")),
      project_path: parseNonEmptyCliString(options.project, "--project", lifecycleStringSource(operation, "project_path")),
      sync_remote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      current_task: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      summary,
      ...(push === false ? { push } : {}),
      agent: agentOptions,
      ...(learnings.length ? { learnings } : {})
    };
    const contextArguments = compactUndefined(contextInput);
    const context = {
      tool: "agent_finish",
      command: commandForAgentFinishContext(contextInput),
      arguments: contextArguments
    };
    try {
      const result = await agentFinish({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
        currentTask: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
        summary,
        push,
        agent: agentOptions,
        learnings
      });
      printJson(await withDashboard(result, { open: options.open }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

const project = program.command("project");

project.command("init")
  .option("--path <path>", "Project path", process.cwd())
  .option("--project-id <id>")
  .option("--tag <tag>", "Project tag", collectNonEmptyOption("--tag", { operation: "project_init", argument: "tags" }), [])
  .option("--default-skill <selector>", "Default skill selector", collectNonEmptyOption("--default-skill", { operation: "project_init", argument: "default_skills" }), [])
  .option("--sync-mode <mode>", "Sync mode")
  .option("--repair", "Replace an invalid existing .moryn.json after explicit confirmation")
  .action(async (options) => {
    const projectPath = parseNonEmptyCliString(options.path, "--path", { operation: "project_init", argument: "path" })!;
    const projectId = parseNonEmptyCliString(options.projectId, "--project-id", { operation: "project_init", argument: "project_id" });
    const syncMode = parseProjectSyncMode(options.syncMode);
    const contextArguments = compactUndefined({
      path: projectPath,
      project_id: projectId,
      tags: options.tag.length ? options.tag : undefined,
      default_skills: options.defaultSkill.length ? options.defaultSkill : undefined,
      sync_mode: syncMode,
      repair: options.repair
    });
    const context = {
      tool: "project_init",
      command: "moryn project init --path <path>",
      arguments: contextArguments
    };
    try {
      printJson({
        ok: true,
        ...await initializeProjectConfig(projectPath, {
          project_id: projectId,
          tags: options.tag.length ? options.tag : undefined,
          default_skills: options.defaultSkill.length ? options.defaultSkill : undefined,
          sync: syncMode === undefined ? undefined : { mode: syncMode },
          repair: options.repair
        })
      });
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

project.command("list")
  .option("--limit <n>", "Project limit", "20")
  .option("--current-task <task>", "Current task to prefill in each agent_start next action")
  .option("--sync-remote <remote>", "Shared Git remote to prefill in each agent_start next action")
  .option("--agent <client>", "Agent client name to prefill in each agent_start next action")
  .option("--session-id <id>", "Agent session id to prefill in each agent_start next action")
  .option("--model <model>", "Agent model to prefill in each agent_start next action")
  .option("--device-id <id>", "Agent device id to prefill in each agent_start next action")
  .action(async (options) => {
    const engine = createCliEngine();
    const operation = "project_list";
    const agentOptions = hasAgentOptions(options) ? parseAgentOptions(options, operation) : undefined;
    printJson(await engine.listProjects({
      limit: parseLimit(options.limit, "project_list"),
      current_task: parseNonEmptyCliString(options.currentTask, "--current-task", lifecycleStringSource(operation, "current_task")),
      sync_remote: parseNonEmptyCliString(options.syncRemote, "--sync-remote", lifecycleStringSource(operation, "sync_remote")),
      agent: agentOptions
    }));
  });

project.command("migrate")
  .option("--from <project-id>", "Project id to migrate records from")
  .option("--to <project-id>", "Project id to migrate records to")
  .option("--dry-run", "Preview matching records without writing events", true)
  .option("--apply", "Append migration events")
  .option("--confirm", "Confirm project id migration")
  .option("--include-private", "Include private-tagged records in migration")
  .action(async (options) => {
    const engine = createCliEngine();
    const fromProjectId = parseNonEmptyCliString(options.from, "--from", { operation: "project_migrate", argument: "from_project_id" });
    const toProjectId = parseNonEmptyCliString(options.to, "--to", { operation: "project_migrate", argument: "to_project_id" });
    if (fromProjectId === undefined) throw requiredCliOptionError("--from", "<from_project_id>", undefined, { operation: "project_migrate", argument: "from_project_id" });
    if (toProjectId === undefined) throw requiredCliOptionError("--to", "<to_project_id>", undefined, { operation: "project_migrate", argument: "to_project_id" });
    printJson(await engine.migrateProject({
      from_project_id: fromProjectId,
      to_project_id: toProjectId,
      dry_run: options.apply ? false : options.dryRun,
      confirmed: options.confirm,
      include_private: options.includePrivate,
      source: { client: "cli" }
    }));
  });

const sync = program.command("sync");

sync.command("init")
  .argument("<remote>")
  .option("--open", "Open the generated dashboard after sync initialization")
  .option("--no-open", "Do not open the generated dashboard after sync initialization")
  .action(async (remote, options) => {
    const syncRemote = parseNonEmptyCliPositional(remote, "remote", { operation: "sync_init", argument: "remote" });
    printJson(await withDashboard(await initializeGitSync(storePath(), syncRemote), { open: options.open }));
  });

sync
  .option("--status", "Show sync status")
  .option("--push", "Commit and push local events")
  .option("--pull", "Pull remote events")
  .option("--message <message>", "Commit message for --push")
  .option("--open", "Open the generated dashboard after sync")
  .option("--no-open", "Do not open the generated dashboard after sync")
  .action(async (options) => {
    validateSyncOperationOptions(options);
    if (options.push) {
      printJson(await withDashboard(
        await pushGitSync(storePath(), { message: parseNonEmptyString(options.message, "--message") }),
        { open: options.open }
      ));
      return;
    }
    if (options.pull) {
      printJson(await withDashboard(await pullGitSync(storePath()), { open: options.open }));
      return;
    }
    printJson(await getGitSyncStatus(storePath()));
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
    return;
  }

  if (error instanceof CommanderError) {
    const message = error.message.startsWith("error: ") ? error.message.slice("error: ".length) : error.message;
    printError(
      cliRequiredOptionError(message)
        ?? cliRequiredArgumentError(message)
        ?? cliUnknownCommandError(message)
        ?? cliTooManyArgumentsCommandError(message)
        ?? cliUnknownOptionError(message)
        ?? new Error(`Invalid argument: ${message}`)
    );
    process.exitCode = error.exitCode;
    return;
  }

  printError(error);
  process.exitCode = 1;
});
