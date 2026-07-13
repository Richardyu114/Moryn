import { actionExecution, actionSafety, type ActionExecution, type ActionSafety } from "./core/action-safety.js";
import { commandLineForCliInterface } from "./core/cli-command-line.js";
import { PROJECT_SYNC_MODE_INPUTS } from "./core/project.js";
import {
  PROVENANCE_METHODS,
  RECORD_KINDS,
  RECORD_PRIORITIES,
  RECORD_SCOPES,
  RECORD_STATES
} from "./core/schema.js";
import { requiredFieldsByName, type RequiredFieldMetadata } from "./core/workflow.js";

type OperationCategory = "setup" | "core" | "sync" | "lifecycle" | "contracts" | "maintenance" | "observability";

type OperationInterfaces = {
  cli: {
    command: string;
    command_line: string;
    argv: string[];
    executable: string;
    args: string[];
    exec_file: {
      executable: string;
      args: string[];
    };
    placeholders: string[];
    has_placeholders: boolean;
  };
  mcp: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

type OperationInterfacesInput = {
  cli: {
    command: string;
    argv: string[];
  };
  mcp: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

export type OperationContract = {
  operation: string;
  category: OperationCategory;
  summary: string;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
  required_fields_by_name: Record<string, OperationRequiredFieldMetadata>;
  arguments_by_name: Record<string, OperationArgumentMetadata>;
  argument_sources?: Record<string, string>;
  interfaces: OperationInterfaces;
  safety: ActionSafety;
  execution: ActionExecution;
  selection_sources: Record<string, string>;
};

type OperationRequiredFieldMetadata = RequiredFieldMetadata & {
  alternatives?: string[];
  allowed_values?: readonly string[];
};

export type OperationArgumentType = "string" | "string[]" | "number" | "boolean" | "object";

export type OperationArgumentMetadata = {
  name: string;
  type: OperationArgumentType;
  required: boolean;
  cli?: {
    flag?: string;
    flags?: readonly string[];
    positional?: string;
    repeatable?: boolean;
    default?: unknown;
    negative_flag?: string;
    required_when?: string;
  };
  mcp?: {
    argument: string;
    path?: string;
  };
  default?: unknown;
  allowed_values?: readonly string[];
  alternatives?: readonly string[];
  parent_argument?: string;
};

type OperationArgumentMetadataInput = Omit<OperationArgumentMetadata, "name"> & {
  name?: string;
};

type OperationContractInput = Omit<OperationContract, "required_fields_by_name" | "arguments_by_name" | "interfaces" | "safety" | "execution" | "selection_sources"> & {
  required_fields_by_name?: Record<string, OperationRequiredFieldMetadata>;
  arguments_by_name?: Record<string, OperationArgumentMetadataInput>;
  interfaces: OperationInterfacesInput;
};

export type SingleOperationContractResponse = {
  operation: OperationContract;
  operation_source: string;
  matched_source: string;
  selection_sources: typeof OPERATION_CONTRACTS_SELECTION_SOURCES;
};

export type OperationContractReference = {
  operation: string;
  operation_source: string;
};

export type OperationContractLookupKind = "operation" | "mcp_tool" | "cli_command";
export type OperationContractLookupMode = "index" | OperationContractLookupKind;
export type OperationContractLookupOption = {
  mode: OperationContractLookupMode;
  option: string;
};

export type OperationContractLookupRecoveryHint = {
  rejected_lookup: {
    kind: OperationContractLookupKind;
    value: string;
  };
  suggested_matches: OperationContractLookupSuggestion[];
  recommended_action: typeof OPERATION_CONTRACT_LOOKUP_RECOVERY_ACTION;
  available_operations: string[];
  available_mcp_tools: string[];
  available_cli_commands: string[];
  index_lookup: {
    package_helper: "getOperationContractIndex()";
    cli: {
      command: "moryn contracts operations --index";
      args: ["contracts", "operations", "--index"];
    };
    mcp: {
      tool: "operation_contracts";
      arguments: { index: true };
    };
  };
  retry_with_operation: {
    package_helper: "getOperationContract('<operation>')";
    cli: "moryn contracts operations --operation <operation>";
    mcp: {
      tool: "operation_contracts";
      arguments: { operation: "<operation>" };
    };
  };
  retry_with_lookup_modes: Omit<OperationContractLookupConflictRecoveryHint["accepted_lookup_modes"], "index">;
  selection_sources: typeof OPERATION_CONTRACT_INDEX_SELECTION_SOURCES;
};

export type OperationContractLookupSuggestion = {
  value: string;
  operation: string;
  operation_source: string;
  retry_with: {
    package_helper: string;
    cli: string;
    mcp: {
      tool: "operation_contracts";
      arguments:
        | { operation: string }
        | { mcp_tool: string }
        | { cli_command: string };
    };
  };
};

export type OperationContractLookupConflictRecoveryHint = {
  rejected_lookup: {
    kind: "multiple_lookup_options";
    provided: OperationContractLookupOption[];
  };
  recommended_action: typeof OPERATION_CONTRACT_LOOKUP_CONFLICT_ACTION;
  accepted_lookup_modes: {
    index: {
      package_helper: "getOperationContractIndex()";
      cli: {
        command: "moryn contracts operations --index";
        args: ["contracts", "operations", "--index"];
      };
      mcp: {
        tool: "operation_contracts";
        arguments: { index: true };
      };
    };
    operation: {
      package_helper: "getOperationContract('<operation>')";
      cli: "moryn contracts operations --operation <operation>";
      mcp: {
        tool: "operation_contracts";
        arguments: { operation: "<operation>" };
      };
    };
    mcp_tool: {
      package_helper: "getOperationContractByMcpTool('<tool>')";
      cli: "moryn contracts operations --mcp-tool <tool>";
      mcp: {
        tool: "operation_contracts";
        arguments: { mcp_tool: "<mcp_tool>" };
      };
    };
    cli_command: {
      package_helper: "getOperationContractByCliCommand('<command>')";
      cli: "moryn contracts operations --cli-command <command>";
      mcp: {
        tool: "operation_contracts";
        arguments: { cli_command: "<cli_command>" };
      };
    };
  };
  selection_sources: typeof OPERATION_CONTRACT_INDEX_SELECTION_SOURCES;
};

export type OperationContractIndexArgumentRecoveryHint = {
  operation_contract: "operations_by_id.operation_contracts";
  rejected_argument: { argument: "index"; value: unknown };
  expected: { kind: "boolean" };
  argument_sources: { index: "operations_by_id.operation_contracts.arguments_by_name.index" };
  retry_with: { argument: "index"; value_placeholder: true };
};

export type OperationContractLookupArgumentRecoveryHint = {
  operation_contract: "operations_by_id.operation_contracts";
  rejected_argument: { argument: OperationContractLookupKind; value: unknown };
  expected: { kind: "non_empty_string"; min_length: 1 };
  argument_sources: Partial<Record<OperationContractLookupKind, string>>;
  retry_with: { argument: OperationContractLookupKind; value_placeholder: string };
};

export const OPERATION_CONTRACT_LOOKUP_RECOVERY_ACTION =
  "fetch the compact operation index and retry with a known operation id, MCP tool, or CLI command" as const;

export const OPERATION_CONTRACT_LOOKUP_CONFLICT_ACTION =
  "choose exactly one operation contract lookup mode and retry" as const;

export class OperationContractLookupError extends Error {
  readonly recommended_action = OPERATION_CONTRACT_LOOKUP_RECOVERY_ACTION;
  readonly recovery_hint: OperationContractLookupRecoveryHint;

  constructor(kind: OperationContractLookupKind, value: string) {
    super(`Invalid argument: Unknown ${operationLookupKindLabel(kind)}: ${value}`);
    this.name = "OperationContractLookupError";
    this.recovery_hint = operationContractLookupRecoveryHint(kind, value);
  }
}

export class OperationContractLookupConflictError extends Error {
  readonly recommended_action = OPERATION_CONTRACT_LOOKUP_CONFLICT_ACTION;
  readonly recovery_hint: OperationContractLookupConflictRecoveryHint;

  constructor(provided: OperationContractLookupOption[], optionsLabel: string) {
    super(`Invalid argument: Use only one operation contract lookup option: ${optionsLabel}`);
    this.name = "OperationContractLookupConflictError";
    this.recovery_hint = operationContractLookupConflictRecoveryHint(provided);
  }
}

export class OperationContractIndexArgumentError extends Error {
  readonly recommended_action = "retry operation_contracts with a boolean index value";
  readonly recovery_hint: OperationContractIndexArgumentRecoveryHint;

  constructor(value: unknown) {
    super("Invalid argument: Invalid index");
    this.name = "OperationContractIndexArgumentError";
    this.recovery_hint = {
      operation_contract: "operations_by_id.operation_contracts",
      rejected_argument: { argument: "index", value },
      expected: { kind: "boolean" },
      argument_sources: {
        index: "operations_by_id.operation_contracts.arguments_by_name.index"
      },
      retry_with: { argument: "index", value_placeholder: true }
    };
  }
}

export class OperationContractLookupArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: OperationContractLookupArgumentRecoveryHint;

  constructor(kind: OperationContractLookupKind, value: unknown) {
    super(`Invalid argument: Invalid ${kind}`);
    this.name = "OperationContractLookupArgumentError";
    this.recommended_action = `retry operation_contracts with a non-empty ${kind} value`;
    this.recovery_hint = {
      operation_contract: "operations_by_id.operation_contracts",
      rejected_argument: { argument: kind, value },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: {
        [kind]: `operations_by_id.operation_contracts.arguments_by_name.${kind}`
      },
      retry_with: { argument: kind, value_placeholder: `<${kind}>` }
    };
  }
}

export function validateOperationContractIndexArgument(index: unknown): asserts index is boolean | undefined {
  if (index !== undefined && typeof index !== "boolean") {
    throw new OperationContractIndexArgumentError(index);
  }
}

export function validateOperationContractLookupArgument(kind: OperationContractLookupKind, value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new OperationContractLookupArgumentError(kind, value);
  }
}

function validateRequiredOperationContractLookupArgument(kind: OperationContractLookupKind, value: unknown): asserts value is string {
  validateOperationContractLookupArgument(kind, value);
  if (value === undefined) {
    throw new OperationContractLookupArgumentError(kind, value);
  }
}

export type OperationContractIndexEntry = {
  operation: string;
  operation_source: string;
  category: OperationCategory;
  summary?: string;
  safe_to_run: boolean;
  ready_to_run: boolean;
  next_step: string;
  mcp_tool: string;
  cli_command: string;
  required_fields: string[];
  missing_required_fields: string[];
  execution_hint?: {
    guard: "execution.ready_to_run";
    ready_to_run: boolean;
    next_step: ActionExecution["next_step"];
    required_fields: string[];
    missing_required_fields: string[];
    required_input_sources?: {
      by_field: "execution.required_inputs_by_field.<field>";
      by_argument_path: "execution.required_inputs_by_argument_path.<argument_path>";
      by_value_path: "execution.required_input_paths_by_value_path.<value_path>";
    };
  };
  full_contract_lookup: {
    package_helper: string;
    cli: {
      command: string;
      executable: "moryn";
      args: string[];
      exec_file?: {
        executable: "moryn";
        args: string[];
      };
    };
    mcp: {
      tool: "operation_contracts";
      arguments: { operation: string };
    };
  };
};

export type OperationContractIndexResponse = {
  recommended_entrypoint: string;
  index_use: string;
  next_lookup: {
    package_helpers: {
      by_operation: string;
      by_mcp_tool: string;
      by_cli_command: string;
    };
    cli: {
      by_operation: string;
      by_mcp_tool: string;
      by_cli_command: string;
    };
    mcp: {
      tool: string;
      by_operation_arguments: { operation: string };
      by_mcp_tool_arguments: { mcp_tool: string };
      by_cli_command_arguments: { cli_command: string };
    };
  };
  operations: Array<Pick<OperationContractIndexEntry, "operation" | "mcp_tool" | "cli_command" | "next_step">>;
  operations_by_id: Record<string, OperationContractIndexEntry>;
  operations_by_mcp_tool: Record<string, string>;
  operations_by_cli_command: Record<string, string>;
  operation_source_lookup: {
    by_mcp_tool: {
      operation_id: "operations_by_mcp_tool.<tool>";
      operation_source: "operations_by_id.<operation>.operation_source";
    };
    by_cli_command: {
      operation_id: "operations_by_cli_command.<command>";
      operation_source: "operations_by_id.<operation>.operation_source";
    };
  };
  selection_sources: typeof OPERATION_CONTRACT_INDEX_SELECTION_SOURCES;
};

export const OPERATION_CONTRACTS_SELECTION_SOURCES = {
  operation: "operations_by_id.<operation>",
  operation_id: "operations_by_id.<operation>.operation",
  category: "operations_by_category.<category>",
  category_operation: "operations_by_category.<category>.<operation>",
  mcp_tool_operation: "operations_by_mcp_tool.<tool>",
  cli_command_operation: "operations_by_cli_command.<command>",
  required_field: "operations_by_id.<operation>.required_fields_by_name.<field>",
  allowed_value: "operations_by_id.<operation>.required_fields_by_name.<field>.allowed_values[]",
  required_input: "operations_by_id.<operation>.execution.required_inputs_by_field.<field>",
  required_input_argument_path: "operations_by_id.<operation>.execution.required_inputs_by_argument_path.<argument_path>",
  required_input_path_by_value_path: "operations_by_id.<operation>.execution.required_input_paths_by_value_path.<value_path>",
  argument: "operations_by_id.<operation>.arguments_by_name.<argument>",
  argument_allowed_value: "operations_by_id.<operation>.arguments_by_name.<argument>.allowed_values[]",
  argument_source: "operations_by_id.<operation>.argument_sources.<field>",
  cli_command: "operations_by_id.<operation>.interfaces.cli.command",
  cli_command_line: "operations_by_id.<operation>.interfaces.cli.command_line",
  cli_argv: "operations_by_id.<operation>.interfaces.cli.argv[]",
  cli_executable: "operations_by_id.<operation>.interfaces.cli.executable",
  cli_args: "operations_by_id.<operation>.interfaces.cli.args[]",
  cli_exec_file: "operations_by_id.<operation>.interfaces.cli.exec_file",
  cli_placeholder: "operations_by_id.<operation>.interfaces.cli.placeholders[]",
  mcp_tool: "operations_by_id.<operation>.interfaces.mcp.tool",
  ordered_operation: "operations[]"
} as const;

export const OPERATION_CONTRACT_INDEX_SELECTION_SOURCES = {
  operation: OPERATION_CONTRACTS_SELECTION_SOURCES.operation,
  operation_source: "operations_by_id.<operation>.operation_source",
  mcp_tool_operation: OPERATION_CONTRACTS_SELECTION_SOURCES.mcp_tool_operation,
  cli_command_operation: OPERATION_CONTRACTS_SELECTION_SOURCES.cli_command_operation,
  operation_source_lookup: "operation_source_lookup",
  ordered_operation: OPERATION_CONTRACTS_SELECTION_SOURCES.ordered_operation,
  execution_hint: "operations_by_id.<operation>.execution_hint",
  execution_hint_required_input_by_value_path: "operations_by_id.<operation>.execution_hint.required_input_sources.by_value_path",
  full_contract_lookup: "operations_by_id.<operation>.full_contract_lookup",
  full_contract_lookup_cli: "operations_by_id.<operation>.full_contract_lookup.cli",
  full_contract_lookup_mcp: "operations_by_id.<operation>.full_contract_lookup.mcp"
} as const;

function operationLookupKindLabel(kind: OperationContractLookupKind): string {
  switch (kind) {
    case "mcp_tool":
      return "MCP tool";
    case "cli_command":
      return "CLI command";
    default:
      return "operation";
  }
}

function operationContractLookupRecoveryHint(kind: OperationContractLookupKind, value: string): OperationContractLookupRecoveryHint {
  return {
    rejected_lookup: { kind, value },
    suggested_matches: operationContractLookupSuggestions(kind, value),
    recommended_action: OPERATION_CONTRACT_LOOKUP_RECOVERY_ACTION,
    available_operations: OPERATION_CONTRACTS.map((operation) => operation.operation),
    available_mcp_tools: OPERATION_CONTRACTS.map((operation) => operation.interfaces.mcp.tool),
    available_cli_commands: OPERATION_CONTRACTS.map((operation) => operation.interfaces.cli.command),
    index_lookup: {
      package_helper: "getOperationContractIndex()",
      cli: {
        command: "moryn contracts operations --index",
        args: ["contracts", "operations", "--index"]
      },
      mcp: {
        tool: "operation_contracts",
        arguments: { index: true }
      }
    },
    retry_with_operation: {
      package_helper: "getOperationContract('<operation>')",
      cli: "moryn contracts operations --operation <operation>",
      mcp: {
        tool: "operation_contracts",
        arguments: { operation: "<operation>" }
      }
    },
    retry_with_lookup_modes: {
      operation: {
        package_helper: "getOperationContract('<operation>')",
        cli: "moryn contracts operations --operation <operation>",
        mcp: {
          tool: "operation_contracts",
          arguments: { operation: "<operation>" }
        }
      },
      mcp_tool: {
        package_helper: "getOperationContractByMcpTool('<tool>')",
        cli: "moryn contracts operations --mcp-tool <tool>",
        mcp: {
          tool: "operation_contracts",
          arguments: { mcp_tool: "<mcp_tool>" }
        }
      },
      cli_command: {
        package_helper: "getOperationContractByCliCommand('<command>')",
        cli: "moryn contracts operations --cli-command <command>",
        mcp: {
          tool: "operation_contracts",
          arguments: { cli_command: "<cli_command>" }
        }
      }
    },
    selection_sources: OPERATION_CONTRACT_INDEX_SELECTION_SOURCES
  };
}

function operationContractLookupSuggestions(kind: OperationContractLookupKind, value: string): OperationContractLookupSuggestion[] {
  return OPERATION_CONTRACTS
    .map((operation, index) => ({
      operation,
      index,
      score: operationContractLookupSuggestionScore(value, lookupValueForOperation(kind, operation))
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, 3)
    .map(({ operation }) => operationContractLookupSuggestion(kind, operation));
}

function lookupValueForOperation(kind: OperationContractLookupKind, operation: OperationContract): string {
  if (kind === "mcp_tool") return operation.interfaces.mcp.tool;
  if (kind === "cli_command") return operation.interfaces.cli.command;
  return operation.operation;
}

function operationContractLookupSuggestion(kind: OperationContractLookupKind, operation: OperationContract): OperationContractLookupSuggestion {
  const value = lookupValueForOperation(kind, operation);
  return {
    value,
    operation: operation.operation,
    operation_source: `operations_by_id.${operation.operation}`,
    retry_with: operationContractLookupSuggestionRetry(kind, value)
  };
}

function operationContractLookupSuggestionRetry(kind: OperationContractLookupKind, value: string): OperationContractLookupSuggestion["retry_with"] {
  if (kind === "mcp_tool") {
    return {
      package_helper: `getOperationContractByMcpTool('${value}')`,
      cli: `moryn contracts operations --mcp-tool ${value}`,
      mcp: {
        tool: "operation_contracts",
        arguments: { mcp_tool: value }
      }
    };
  }
  if (kind === "cli_command") {
    return {
      package_helper: `getOperationContractByCliCommand('${value}')`,
      cli: `moryn contracts operations --cli-command ${JSON.stringify(value)}`,
      mcp: {
        tool: "operation_contracts",
        arguments: { cli_command: value }
      }
    };
  }
  return {
    package_helper: `getOperationContract('${value}')`,
    cli: `moryn contracts operations --operation ${value}`,
    mcp: {
      tool: "operation_contracts",
      arguments: { operation: value }
    }
  };
}

function operationContractLookupSuggestionScore(query: string, candidate: string): number {
  const normalizedQuery = normalizeLookupValue(query);
  const normalizedCandidate = normalizeLookupValue(candidate);
  const comparableQuery = comparableLookupValue(query);
  const comparableCandidate = comparableLookupValue(candidate);
  let score = Math.min(
    levenshteinDistance(normalizedQuery, normalizedCandidate),
    levenshteinDistance(comparableQuery, comparableCandidate) + tokenLookupDistance(comparableQuery, comparableCandidate)
  );
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

function normalizeLookupValue(value: string): string {
  return value.trim().toLowerCase();
}

function comparableLookupValue(value: string): string {
  return normalizeLookupValue(value)
    .replace(/<[^>]*>/gu, " ")
    .replace(/--[a-z0-9_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function tokenLookupDistance(query: string, candidate: string): number {
  const queryTokens = query.split(/[\s_-]+/u).filter(Boolean);
  const candidateTokens = candidate.split(/[\s_-]+/u).filter(Boolean);
  return queryTokens.reduce((total, queryToken) => {
    const bestTokenDistance = candidateTokens.reduce(
      (best, candidateToken) => Math.min(best, levenshteinDistance(queryToken, candidateToken)),
      Number.POSITIVE_INFINITY
    );
    return total + (Number.isFinite(bestTokenDistance) ? bestTokenDistance : queryToken.length);
  }, Math.max(0, candidateTokens.length - queryTokens.length));
}

function levenshteinDistance(left: string, right: string): number {
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

function operationContractLookupConflictRecoveryHint(provided: OperationContractLookupOption[]): OperationContractLookupConflictRecoveryHint {
  return {
    rejected_lookup: {
      kind: "multiple_lookup_options",
      provided
    },
    recommended_action: OPERATION_CONTRACT_LOOKUP_CONFLICT_ACTION,
    accepted_lookup_modes: {
      index: {
        package_helper: "getOperationContractIndex()",
        cli: {
          command: "moryn contracts operations --index",
          args: ["contracts", "operations", "--index"]
        },
        mcp: {
          tool: "operation_contracts",
          arguments: { index: true }
        }
      },
      operation: {
        package_helper: "getOperationContract('<operation>')",
        cli: "moryn contracts operations --operation <operation>",
        mcp: {
          tool: "operation_contracts",
          arguments: { operation: "<operation>" }
        }
      },
      mcp_tool: {
        package_helper: "getOperationContractByMcpTool('<tool>')",
        cli: "moryn contracts operations --mcp-tool <tool>",
        mcp: {
          tool: "operation_contracts",
          arguments: { mcp_tool: "<mcp_tool>" }
        }
      },
      cli_command: {
        package_helper: "getOperationContractByCliCommand('<command>')",
        cli: "moryn contracts operations --cli-command <command>",
        mcp: {
          tool: "operation_contracts",
          arguments: { cli_command: "<cli_command>" }
        }
      }
    },
    selection_sources: OPERATION_CONTRACT_INDEX_SELECTION_SOURCES
  };
}

const OPERATION_LOCAL_SELECTION_SOURCES = Object.fromEntries(
  Object.entries(OPERATION_CONTRACTS_SELECTION_SOURCES).filter(([key]) => ![
    "category",
    "category_operation",
    "mcp_tool_operation",
    "cli_command_operation",
    "required_input_path_by_value_path",
    "ordered_operation"
  ].includes(key))
) as Omit<typeof OPERATION_CONTRACTS_SELECTION_SOURCES, "required_input_path_by_value_path">;

function userInputSources(fields: readonly string[]): Record<string, string> | undefined {
  return fields.length ? Object.fromEntries(fields.map((field) => [field, `user_input.${field}`])) : undefined;
}

const sourceClientArgument = {
  type: "string",
  required: false,
  mcp: { argument: "source", path: "source.client" },
  parent_argument: "source"
} satisfies OperationArgumentMetadataInput;

const sourceIdentityArguments = {
  source_client: sourceClientArgument,
  source_session_id: {
    type: "string",
    required: false,
    mcp: { argument: "source", path: "source.session_id" },
    parent_argument: "source"
  },
  source_model: {
    type: "string",
    required: false,
    mcp: { argument: "source", path: "source.model" },
    parent_argument: "source"
  },
  source_device_id: {
    type: "string",
    required: false,
    mcp: { argument: "source", path: "source.device_id" },
    parent_argument: "source"
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

function operationRequiredFieldsByName(input: OperationContractInput): Record<string, OperationRequiredFieldMetadata> {
  return {
    ...requiredFieldsByName(input.required_fields, input.interfaces.mcp.arguments),
    ...input.required_fields_by_name
  };
}

function operationArgumentsByName(input: OperationContractInput): Record<string, OperationArgumentMetadata> {
  return Object.fromEntries(Object.entries(input.arguments_by_name ?? {}).map(([name, metadata]) => [
    name,
    { ...metadata, name }
  ]));
}

function requiredInputSelectionSources(selectionSources: Record<string, string>): Record<string, string> | undefined {
  const sources = Object.fromEntries(Object.entries(selectionSources).filter(([key]) =>
    key === "required_input" || key === "required_input_argument_path"
  ));
  return Object.keys(sources).length > 0 ? sources : undefined;
}

function cliPlaceholders(argv: readonly string[]): string[] {
  return Array.from(new Set(argv.flatMap((arg) => {
    const match = /^<([^<>]+)>$/.exec(arg);
    return match ? [match[1]!] : [];
  })));
}

function operationContract(input: OperationContractInput): OperationContract {
  const required_fields_by_name = operationRequiredFieldsByName(input);
  const arguments_by_name = operationArgumentsByName(input);
  const placeholders = cliPlaceholders(input.interfaces.cli.argv);
  const interfaces = {
    ...input.interfaces,
    cli: {
      ...input.interfaces.cli,
      executable: "moryn",
      args: input.interfaces.cli.argv,
      exec_file: {
        executable: "moryn",
        args: input.interfaces.cli.argv
      },
      placeholders,
      has_placeholders: placeholders.length > 0,
      command_line: commandLineForCliInterface("moryn", input.interfaces.cli.argv)
    }
  };
  return {
    ...input,
    interfaces,
    required_fields_by_name,
    arguments_by_name,
    ...(input.argument_sources ? { argument_sources: input.argument_sources } : {}),
    safety: actionSafety({
      tool: interfaces.mcp.tool,
      safe_to_run: input.safe_to_run,
      required_fields: input.required_fields
    }),
    execution: actionExecution({
      tool: interfaces.mcp.tool,
      safe_to_run: input.safe_to_run,
      required_fields: input.required_fields,
      required_fields_by_name,
      arguments_by_name,
      argument_sources: input.argument_sources,
      required_input_selection_sources: requiredInputSelectionSources(OPERATION_CONTRACTS_SELECTION_SOURCES)
    }),
    selection_sources: OPERATION_LOCAL_SELECTION_SOURCES
  };
}

const agentSourceArgument = {
  agent: {
    type: "object",
    required: false,
    cli: { flags: ["--agent", "--session-id", "--model", "--device-id"] },
    mcp: { argument: "agent" }
  },
  agent_client: {
    type: "string",
    required: false,
    cli: { flag: "--agent" },
    mcp: { argument: "agent", path: "agent.client" },
    parent_argument: "agent"
  },
  agent_session_id: {
    type: "string",
    required: false,
    cli: { flag: "--session-id" },
    mcp: { argument: "agent", path: "agent.session_id" },
    parent_argument: "agent"
  },
  agent_model: {
    type: "string",
    required: false,
    cli: { flag: "--model" },
    mcp: { argument: "agent", path: "agent.model" },
    parent_argument: "agent"
  },
  agent_device_id: {
    type: "string",
    required: false,
    cli: { flag: "--device-id" },
    mcp: { argument: "agent", path: "agent.device_id" },
    parent_argument: "agent"
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const projectContextArguments = {
  project_id: {
    type: "string",
    required: false,
    cli: { flag: "--project-id" },
    mcp: { argument: "project_id" }
  },
  project_path: {
    type: "string",
    required: false,
    cli: { flag: "--project" },
    mcp: { argument: "project_path" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const privateReadArgument = {
  include_private: {
    type: "boolean",
    required: false,
    default: false,
    cli: { flag: "--include-private" },
    mcp: { argument: "include_private" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const lifecycleContextArguments = {
  ...projectContextArguments,
  sync_remote: {
    type: "string",
    required: false,
    cli: { flag: "--sync-remote" },
    mcp: { argument: "sync_remote" }
  },
  current_task: {
    type: "string",
    required: false,
    cli: { flag: "--current-task" },
    mcp: { argument: "current_task" }
  },
  ...agentSourceArgument
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const startSessionArguments = {
  ...lifecycleContextArguments,
  refresh_since: {
    type: "string",
    required: false,
    cli: { flag: "--refresh-since" },
    mcp: { argument: "refresh_since" }
  },
  limit: {
    type: "number",
    required: false,
    default: 20,
    cli: { flag: "--limit", default: 20 },
    mcp: { argument: "limit" }
  },
  pull: {
    type: "boolean",
    required: false,
    default: true,
    cli: { negative_flag: "--no-pull" },
    mcp: { argument: "pull" }
  },
  open: {
    type: "boolean",
    required: false,
    cli: { flag: "--open", negative_flag: "--no-open" },
    mcp: { argument: "open" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const publishSessionArguments = {
  ...lifecycleContextArguments,
  push: {
    type: "boolean",
    required: false,
    default: true,
    cli: { negative_flag: "--no-push" },
    mcp: { argument: "push" }
  },
  open: {
    type: "boolean",
    required: false,
    cli: { flag: "--open", negative_flag: "--no-open" },
    mcp: { argument: "open" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const checkpointSourceArguments = {
  source: {
    type: "object",
    required: true,
    cli: { flags: ["--agent", "--session-id", "--model", "--device-id"] },
    mcp: { argument: "source" }
  },
  source_client: {
    type: "string",
    required: true,
    cli: { flag: "--agent" },
    mcp: { argument: "source", path: "source.client" },
    parent_argument: "source"
  },
  source_session_id: {
    type: "string",
    required: true,
    cli: { flag: "--session-id" },
    mcp: { argument: "source", path: "source.session_id" },
    parent_argument: "source"
  },
  source_model: {
    type: "string",
    required: false,
    cli: { flag: "--model" },
    mcp: { argument: "source", path: "source.model" },
    parent_argument: "source"
  },
  source_device_id: {
    type: "string",
    required: true,
    cli: { flag: "--device-id" },
    mcp: { argument: "source", path: "source.device_id" },
    parent_argument: "source"
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const hostAdapterIds = ["claude", "codex", "gemini", "cursor", "shell"] as const;

const installArguments = {
  host: {
    type: "string",
    required: false,
    cli: { flag: "--host" },
    mcp: { argument: "host" },
    allowed_values: hostAdapterIds
  },
  project_path: {
    type: "string",
    required: false,
    cli: { flag: "--project" },
    mcp: { argument: "project_path" }
  },
  sync_remote: {
    type: "string",
    required: false,
    cli: { flag: "--sync-remote" },
    mcp: { argument: "sync_remote" }
  },
  apply: {
    type: "boolean",
    required: false,
    default: false,
    cli: { flag: "--apply", default: false },
    mcp: { argument: "apply" }
  }
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const setupArguments = installArguments;

const captureSessionArguments = {
  summary: {
    type: "string",
    required: true,
    cli: { flag: "--summary" },
    mcp: { argument: "summary" }
  },
  files: {
    type: "string[]",
    required: false,
    cli: { flag: "--file", repeatable: true },
    mcp: { argument: "files" }
  },
  ...lifecycleContextArguments
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const contextPackArguments = {
  ...lifecycleContextArguments,
  limit: {
    type: "number",
    required: false,
    default: 20,
    cli: { flag: "--limit", default: 20 },
    mcp: { argument: "limit" }
  },
  pull: {
    type: "boolean",
    required: false,
    default: true,
    cli: { negative_flag: "--no-pull" },
    mcp: { argument: "pull" }
  },
  ...privateReadArgument
} as const satisfies Record<string, OperationArgumentMetadataInput>;

const dashboardArguments = {
  ...projectContextArguments,
  open: {
    type: "boolean",
    required: false,
    cli: { flag: "--open", negative_flag: "--no-open" },
    mcp: { argument: "open" }
  },
  serve: {
    type: "boolean",
    required: false,
    default: false,
    cli: { flag: "--serve", default: false }
  },
  host: {
    type: "string",
    required: false,
    default: "127.0.0.1",
    cli: { flag: "--host", default: "127.0.0.1" }
  },
  readiness_host: {
    type: "string",
    required: false,
    cli: { flag: "--readiness-host" }
  },
  sync_remote: {
    type: "string",
    required: false,
    cli: { flag: "--sync-remote" }
  },
  port: {
    type: "number",
    required: false,
    default: 8765,
    cli: { flag: "--port", default: 8765 }
  },
  interval: {
    type: "number",
    required: false,
    default: 2000,
    cli: { flag: "--interval", default: 2000 }
  },
  limit: {
    type: "number",
    required: false,
    default: 20,
    cli: { flag: "--limit", default: 20 },
    mcp: { argument: "limit" }
  },
  ...privateReadArgument
} as const satisfies Record<string, OperationArgumentMetadataInput>;

export const OPERATION_CONTRACTS = [
  operationContract({
    operation: "agent_enter",
    category: "lifecycle",
    summary: "Recommended startup entrypoint; diagnoses setup, discovers projects, or starts a known project session.",
    safe_to_run: true,
    required_when: "At the start of an agent turn, or whenever store/project/sync context is uncertain.",
    required_fields: [],
    arguments_by_name: startSessionArguments,
    interfaces: {
      cli: { command: "moryn agent enter", argv: ["agent", "enter"] },
      mcp: { tool: "agent_enter", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_guide",
    category: "lifecycle",
    summary: "Return static lifecycle guidance, guardrails, workflow, CLI commands, and MCP arguments.",
    safe_to_run: true,
    required_when: "When an agent host needs the lifecycle contract before choosing runtime actions.",
    required_fields: [],
    arguments_by_name: lifecycleContextArguments,
    interfaces: {
      cli: { command: "moryn agent guide", argv: ["agent", "guide"] },
      mcp: { tool: "agent_guide", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_doctor",
    category: "lifecycle",
    summary: "Diagnose store, project, and sync readiness and return the next safe setup/start action.",
    safe_to_run: true,
    required_when: "When setup may be missing or broken and the agent needs a read-only readiness check.",
    required_fields: [],
    arguments_by_name: lifecycleContextArguments,
    interfaces: {
      cli: { command: "moryn agent doctor", argv: ["agent", "doctor"] },
      mcp: { tool: "agent_doctor", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_start",
    category: "lifecycle",
    summary: "Resolve project context, pull sync when appropriate, boot context, refresh changes, and return next actions.",
    safe_to_run: true,
    required_when: "After project context is known, or when following agent_enter/agent_guide startup actions.",
    required_fields: [],
    arguments_by_name: startSessionArguments,
    interfaces: {
      cli: { command: "moryn agent start", argv: ["agent", "start"] },
      mcp: { tool: "agent_start", arguments: {} }
    }
  }),
  operationContract({
    operation: "agent_status",
    category: "lifecycle",
    summary: "Write an in-progress project status checkpoint for handoff and coordination.",
    safe_to_run: false,
    required_when: "During meaningful long-running work, before interruption, or when another agent may need coordination.",
    required_fields: ["status"],
    argument_sources: userInputSources(["status"]),
    arguments_by_name: {
      status: {
        type: "string",
        required: true,
        cli: { flag: "--status" },
        mcp: { argument: "status" }
      },
      ...publishSessionArguments
    },
    interfaces: {
      cli: { command: "moryn agent status --status <status>", argv: ["agent", "status", "--status", "<status>"] },
      mcp: { tool: "agent_status", arguments: { status: "<status>" } }
    }
  }),
  operationContract({
    operation: "consolidate_semantic",
    category: "maintenance",
    summary: "Validate and persist authored semantic memory relationships without exposing record content.",
    safe_to_run: false,
    required_when: "Only when an agent has bounded candidate records and an authored semantic proposal.",
    required_fields: ["proposals"],
    argument_sources: userInputSources(["proposals"]),
    arguments_by_name: {
      ...projectContextArguments,
      proposals: { type: "object", required: true, cli: { flag: "--proposal-json", repeatable: true }, mcp: { argument: "proposals" } },
      include_private: { type: "boolean", required: false, default: false, cli: { flag: "--include-private" }, mcp: { argument: "include_private" } },
      source: { type: "object", required: false, mcp: { argument: "source" } }
    },
    interfaces: { cli: { command: "moryn consolidate semantic --proposal-json <proposal>", argv: ["consolidate", "semantic", "--proposal-json", "<proposal>"] }, mcp: { tool: "consolidate_semantic", arguments: { proposals: ["<proposal>"] } } }
  }),
  operationContract({
    operation: "checkpoint",
    category: "lifecycle",
    summary: "Append an authored local session checkpoint for compaction recovery and long-task continuity.",
    safe_to_run: true,
    required_when: "Before host compaction, or after more than 30 minutes of active work without a recent checkpoint.",
    required_fields: ["occurred_at", "delta"],
    argument_sources: userInputSources(["occurred_at", "delta"]),
    arguments_by_name: {
      ...projectContextArguments,
      ...checkpointSourceArguments,
      occurred_at: {
        type: "string",
        required: true,
        cli: { flag: "--occurred-at" },
        mcp: { argument: "occurred_at" }
      },
      delta: {
        type: "object",
        required: true,
        cli: { flag: "--delta" },
        mcp: { argument: "delta" }
      },
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      include_private: {
        type: "boolean",
        required: false,
        default: false,
        cli: { flag: "--include-private" },
        mcp: { argument: "include_private" }
      },
      current_task: {
        type: "string",
        required: false,
        mcp: { argument: "delta", path: "current_task" },
        parent_argument: "delta"
      },
      knowledge_investigations: {
        type: "object",
        required: false,
        cli: { flag: "--knowledge-investigation", repeatable: true },
        mcp: { argument: "delta", path: "knowledge_investigations" },
        parent_argument: "delta"
      }
    },
    interfaces: {
      cli: { command: "moryn agent checkpoint --occurred-at <occurred_at> --delta <json>", argv: ["agent", "checkpoint", "--occurred-at", "<occurred_at>", "--delta", "<json>"] },
      mcp: { tool: "checkpoint", arguments: { occurred_at: "<occurred_at>", delta: "<json>" } }
    }
  }),
  operationContract({
    operation: "learn",
    category: "lifecycle",
    summary: "Queue one reusable Learning Delta for automatic checkpoint or finish consumption.",
    safe_to_run: false,
    required_when: "After an agent resolves a knowledge gap that should survive compaction and become reusable memory.",
    required_fields: ["question", "conclusion", "evidence_type"],
    argument_sources: userInputSources(["question", "conclusion", "evidence_type"]),
    arguments_by_name: {
      ...projectContextArguments,
      question: { type: "string", required: true, cli: { flag: "--question" }, mcp: { argument: "question" } },
      conclusion: { type: "string", required: true, cli: { flag: "--conclusion" }, mcp: { argument: "conclusion" } },
      evidence_type: { type: "string", required: true, cli: { flag: "--evidence-type" }, mcp: { argument: "evidence_type" } },
      scope: { type: "string", required: false, default: "project", cli: { flag: "--scope", default: "project" }, mcp: { argument: "scope" } },
      confidence: { type: "number", required: false, default: 0.8, cli: { flag: "--confidence", default: 0.8 }, mcp: { argument: "confidence" } },
      valid_until: { type: "string", required: false, cli: { flag: "--valid-until" }, mcp: { argument: "valid_until" } },
      recommended_kind: { type: "string", required: false, default: "memory", cli: { flag: "--recommended-kind", default: "memory" }, mcp: { argument: "recommended_kind" } },
      recommended_type: { type: "string", required: false, default: "fact", cli: { flag: "--recommended-type", default: "fact" }, mcp: { argument: "recommended_type" } },
      related_record_ids: { type: "string", required: false, cli: { flag: "--related-record-id", repeatable: true }, mcp: { argument: "related_record_ids" } },
      current_task: { type: "string", required: false, cli: { flag: "--current-task" }, mcp: { argument: "current_task" } },
      ...checkpointSourceArguments,
      occurred_at: { type: "string", required: false, cli: { flag: "--occurred-at" }, mcp: { argument: "occurred_at" } }
    },
    interfaces: {
      cli: { command: "moryn learn --question <question> --conclusion <conclusion> --evidence-type <evidence_type>", argv: ["learn", "--question", "<question>", "--conclusion", "<conclusion>", "--evidence-type", "<evidence_type>"] },
      mcp: { tool: "learn", arguments: { question: "<question>", conclusion: "<conclusion>", evidence_type: "<evidence_type>" } }
    }
  }),
  operationContract({
    operation: "agent_finish",
    category: "lifecycle",
    summary: "Write a final session summary and push sync when appropriate.",
    safe_to_run: false,
    required_when: "At the end of meaningful work, before stopping, or before handing off to another agent.",
    required_fields: ["summary"],
    argument_sources: userInputSources(["summary"]),
    arguments_by_name: {
      summary: {
        type: "string",
        required: true,
        cli: { flag: "--summary" },
        mcp: { argument: "summary" }
      },
      learnings: {
        type: "object",
        required: false,
        cli: { flag: "--learning", repeatable: true },
        mcp: { argument: "learnings" }
      },
      semantic_consolidation_proposals: { type: "object", required: false, cli: { flag: "--semantic-consolidation-proposal", repeatable: true }, mcp: { argument: "semantic_consolidation_proposals" } },
      ...publishSessionArguments
    },
    interfaces: {
      cli: { command: "moryn agent finish --summary <summary>", argv: ["agent", "finish", "--summary", "<summary>"] },
      mcp: { tool: "agent_finish", arguments: { summary: "<summary>" } }
    }
  }),
  operationContract({
    operation: "context_pack",
    category: "lifecycle",
    summary: "Build a host-normalized startup context pack with Handoff Pack v0.2, read-only quality gate, boot, refresh, raw handoff evidence, and a required capture next action.",
    safe_to_run: true,
    required_when: "At the start of a host session when an agent wants the simplest Moryn entrypoint.",
    required_fields: [],
    arguments_by_name: contextPackArguments,
    interfaces: {
      cli: { command: "moryn context pack", argv: ["context", "pack"] },
      mcp: { tool: "context_pack", arguments: {} }
    }
  }),
  operationContract({
    operation: "capture_session",
    category: "lifecycle",
    summary: "Capture a host-normalized session handoff summary, evaluate default_autocapture_policy, and keep canonical promotion under user control.",
    safe_to_run: false,
    required_when: "Before ending a host session or handing work to another agent/device; policy may auto-capture low-risk handoffs, route risky handoffs to Capture Inbox, or archive obvious noise.",
    required_fields: ["summary"],
    argument_sources: userInputSources(["summary"]),
    arguments_by_name: captureSessionArguments,
    interfaces: {
      cli: { command: "moryn capture session --summary <summary>", argv: ["capture", "session", "--summary", "<summary>"] },
      mcp: { tool: "capture_session", arguments: { summary: "<summary>" } }
    }
  }),
  operationContract({
    operation: "selection_source_contracts",
    category: "contracts",
    summary: "Return stable response field-path contracts grouped by setup, core, sync, lifecycle, and recovery.",
    safe_to_run: true,
    required_when: "When an agent needs canonical JSON paths instead of guessing response field names.",
    required_fields: [],
    interfaces: {
      cli: { command: "moryn contracts selection-sources", argv: ["contracts", "selection-sources"] },
      mcp: { tool: "selection_source_contracts", arguments: {} }
    }
  }),
  operationContract({
    operation: "operation_contracts",
    category: "contracts",
    summary: "Return this operation registry with CLI/MCP interfaces, safety, and required fields.",
    safe_to_run: true,
    required_when: "When an agent needs to discover available Moryn operations without reading docs.",
    required_fields: [],
    arguments_by_name: {
      index: {
        type: "boolean",
        required: false,
        cli: { flag: "--index" },
        mcp: { argument: "index" }
      },
      operation: {
        type: "string",
        required: false,
        cli: { flag: "--operation" },
        mcp: { argument: "operation" }
      },
      mcp_tool: {
        type: "string",
        required: false,
        cli: { flag: "--mcp-tool" },
        mcp: { argument: "mcp_tool" }
      },
      cli_command: {
        type: "string",
        required: false,
        cli: { flag: "--cli-command" },
        mcp: { argument: "cli_command" }
      }
    },
    interfaces: {
      cli: { command: "moryn contracts operations", argv: ["contracts", "operations"] },
      mcp: {
        tool: "operation_contracts",
        arguments: {
          index: true,
          operation: "<operation>",
          mcp_tool: "<tool>",
          cli_command: "<command>"
        }
      }
    }
  }),
  operationContract({
    operation: "init",
    category: "setup",
    summary: "Create or update the local Moryn store configuration and directories.",
    safe_to_run: false,
    required_when: "When the store is missing and the user wants to initialize local memory.",
    required_fields: [],
    arguments_by_name: {
      repair: {
        type: "boolean",
        required: false,
        cli: { flag: "--repair" },
        mcp: { argument: "repair" }
      }
    },
    interfaces: {
      cli: { command: "moryn init", argv: ["init"] },
      mcp: { tool: "init", arguments: {} }
    }
  }),
  operationContract({
    operation: "install",
    category: "setup",
    summary: "Plan and optionally run safe Moryn-local host adapter setup without mutating host configuration files.",
    safe_to_run: true,
    required_when: "When a host needs an adoption plan for Moryn MCP registration, context packs, and session capture.",
    required_fields: [],
    arguments_by_name: installArguments,
    interfaces: {
      cli: { command: "moryn install", argv: ["install"] },
      mcp: { tool: "install", arguments: {} }
    }
  }),
  operationContract({
    operation: "setup",
    category: "setup",
    summary: "Diagnose local Moryn readiness and optionally apply safe local setup in one audited plan.",
    safe_to_run: false,
    required_when: "When a user or agent wants one setup entrypoint instead of choosing init, project init, install, and context commands manually.",
    required_fields: [],
    arguments_by_name: setupArguments,
    interfaces: {
      cli: { command: "moryn setup", argv: ["setup"] },
      mcp: { tool: "setup", arguments: {} }
    }
  }),
  operationContract({
    operation: "project_init",
    category: "setup",
    summary: "Create or update a .moryn.json project config.",
    safe_to_run: false,
    required_when: "When a project path has no Moryn config or the project config needs explicit repair.",
    required_fields: ["path"],
    argument_sources: userInputSources(["path"]),
    arguments_by_name: {
      path: {
        type: "string",
        required: true,
        cli: {
          flag: "--path",
          default: ".",
          required_when: "Required in CLI only when initializing a path other than the current directory."
        },
        mcp: { argument: "path" }
      },
      project_id: {
        type: "string",
        required: false,
        cli: { flag: "--project-id" },
        mcp: { argument: "project_id" }
      },
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      default_skills: {
        type: "string[]",
        required: false,
        cli: { flag: "--default-skill", repeatable: true },
        mcp: { argument: "default_skills" }
      },
      sync_mode: {
        type: "string",
        required: false,
        cli: { flag: "--sync-mode" },
        mcp: { argument: "sync_mode" },
        allowed_values: PROJECT_SYNC_MODE_INPUTS
      },
      repair: {
        type: "boolean",
        required: false,
        cli: { flag: "--repair" },
        mcp: { argument: "repair" }
      }
    },
    required_fields_by_name: {
      sync_mode: {
        name: "sync_mode",
        argument_path: "sync_mode",
        allowed_values: PROJECT_SYNC_MODE_INPUTS
      }
    },
    interfaces: {
      cli: { command: "moryn project init --path <path>", argv: ["project", "init", "--path", "<path>"] },
      mcp: { tool: "project_init", arguments: { path: "<path>" } }
    }
  }),
  operationContract({
    operation: "project_list",
    category: "setup",
    summary: "List known projects and project-specific start actions from the Moryn store.",
    safe_to_run: true,
    required_when: "When project context is unclear and the store may already know one or more projects.",
    required_fields: [],
    arguments_by_name: {
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      current_task: {
        type: "string",
        required: false,
        cli: { flag: "--current-task" },
        mcp: { argument: "current_task" }
      },
      sync_remote: {
        type: "string",
        required: false,
        cli: { flag: "--sync-remote" },
        mcp: { argument: "sync_remote" }
      },
      ...agentSourceArgument
    },
    interfaces: {
      cli: { command: "moryn project list", argv: ["project", "list"] },
      mcp: { tool: "project_list", arguments: {} }
    }
  }),
  operationContract({
    operation: "project_migrate",
    category: "maintenance",
    summary: "Move records from one project id to another by appending auditable revision events.",
    safe_to_run: false,
    required_when: "After memory_doctor or project_list reveals split project identity and the user has chosen the canonical project id.",
    required_fields: ["from_project_id", "to_project_id"],
    argument_sources: userInputSources(["from_project_id", "to_project_id"]),
    arguments_by_name: {
      from_project_id: {
        type: "string",
        required: true,
        cli: { flag: "--from" },
        mcp: { argument: "from_project_id" }
      },
      to_project_id: {
        type: "string",
        required: true,
        cli: { flag: "--to" },
        mcp: { argument: "to_project_id" }
      },
      dry_run: {
        type: "boolean",
        required: false,
        default: true,
        cli: { flag: "--dry-run", default: true },
        mcp: { argument: "dry_run" }
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      include_private: {
        type: "boolean",
        required: false,
        cli: { flag: "--include-private" },
        mcp: { argument: "include_private" }
      }
    },
    interfaces: {
      cli: {
        command: "moryn project migrate --from <from_project_id> --to <to_project_id>",
        argv: ["project", "migrate", "--from", "<from_project_id>", "--to", "<to_project_id>"]
      },
      mcp: {
        tool: "project_migrate",
        arguments: {
          from_project_id: "<from_project_id>",
          to_project_id: "<to_project_id>"
        }
      }
    }
  }),
  operationContract({
    operation: "boot",
    category: "core",
    summary: "Return bounded memory, skill, project, and task context for a known project.",
    safe_to_run: true,
    required_when: "When an agent needs context and already knows the target project.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      current_task: {
        type: "string",
        required: false,
        cli: { flag: "--current-task" },
        mcp: { argument: "current_task" }
      },
      agent_session_id: {
        type: "string",
        required: false,
        cli: { flag: "--session-id" },
        mcp: { argument: "agent_session_id" }
      },
      default_skills: {
        type: "string[]",
        required: false,
        mcp: { argument: "default_skills" }
      },
      sync_remote: {
        type: "string",
        required: false,
        mcp: { argument: "sync_remote" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn boot", argv: ["boot"] },
      mcp: { tool: "boot", arguments: {} }
    }
  }),
  operationContract({
    operation: "recall",
    category: "core",
    summary: "Search or fetch records by query, record id, project, kind, scope, state, tag, type, or file.",
    safe_to_run: true,
    required_when: "When an agent needs specific memory records or the full content behind a returned record id.",
    required_fields: [],
    arguments_by_name: {
      query: {
        type: "string",
        required: false,
        cli: { positional: "query" },
        mcp: { argument: "query" }
      },
      record_ids: {
        type: "string[]",
        required: false,
        cli: { flag: "--record-id", repeatable: true },
        mcp: { argument: "record_ids" }
      },
      ...projectContextArguments,
      kinds: {
        type: "string[]",
        required: false,
        cli: { flag: "--kind", repeatable: true },
        mcp: { argument: "kinds" },
        allowed_values: RECORD_KINDS
      },
      scopes: {
        type: "string[]",
        required: false,
        cli: { flag: "--scope", repeatable: true },
        mcp: { argument: "scopes" },
        allowed_values: RECORD_SCOPES
      },
      types: {
        type: "string[]",
        required: false,
        cli: { flag: "--type", repeatable: true },
        mcp: { argument: "types" }
      },
      states: {
        type: "string[]",
        required: false,
        cli: { flag: "--state", repeatable: true },
        mcp: { argument: "states" },
        allowed_values: RECORD_STATES
      },
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      files: {
        type: "string[]",
        required: false,
        cli: { flag: "--file", repeatable: true },
        mcp: { argument: "files" }
      },
      limit: {
        type: "number",
        required: false,
        default: 10,
        cli: { flag: "--limit", default: 10 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn recall", argv: ["recall"] },
      mcp: { tool: "recall", arguments: {} }
    }
  }),
  operationContract({
    operation: "timeline",
    category: "core",
    summary: "Return chronological event context around a record, event, or query anchor.",
    safe_to_run: true,
    required_when: "When recall returns an isolated record and the agent needs nearby events or the record's recent mutation context.",
    required_fields: [],
    arguments_by_name: {
      record_id: {
        type: "string",
        required: false,
        cli: { flag: "--record-id" },
        mcp: { argument: "record_id" },
        alternatives: ["event_id", "query"]
      },
      event_id: {
        type: "string",
        required: false,
        cli: { flag: "--event-id" },
        mcp: { argument: "event_id" },
        alternatives: ["record_id", "query"]
      },
      query: {
        type: "string",
        required: false,
        cli: { flag: "--query" },
        mcp: { argument: "query" },
        alternatives: ["record_id", "event_id"]
      },
      ...projectContextArguments,
      before: {
        type: "number",
        required: false,
        default: 5,
        cli: { flag: "--before", default: 5 },
        mcp: { argument: "before" }
      },
      after: {
        type: "number",
        required: false,
        default: 5,
        cli: { flag: "--after", default: 5 },
        mcp: { argument: "after" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn timeline", argv: ["timeline"] },
      mcp: { tool: "timeline", arguments: {} }
    }
  }),
  operationContract({
    operation: "write",
    category: "core",
    summary: "Append a new memory, skill, soul, session summary, or agent note record.",
    safe_to_run: false,
    required_when: "When the agent has authored record content and the target kind/type/scope are known.",
    required_fields: ["kind", "type", "scope", "text_or_content"],
    argument_sources: userInputSources(["kind", "type", "scope", "text_or_content"]),
    arguments_by_name: {
      kind: {
        type: "string",
        required: true,
        cli: { flag: "--kind" },
        mcp: { argument: "kind" },
        allowed_values: RECORD_KINDS
      },
      type: {
        type: "string",
        required: true,
        cli: { flag: "--type" },
        mcp: { argument: "type" }
      },
      scope: {
        type: "string",
        required: true,
        cli: { flag: "--scope" },
        mcp: { argument: "scope" },
        allowed_values: RECORD_SCOPES
      },
      text: {
        type: "string",
        required: false,
        cli: { flag: "--text" },
        mcp: { argument: "text" },
        alternatives: ["content"]
      },
      content: {
        type: "object",
        required: false,
        cli: { flag: "--content-json" },
        mcp: { argument: "content" },
        alternatives: ["text"]
      },
      content_text: {
        type: "string",
        required: false,
        cli: { flag: "--content-json" },
        mcp: { argument: "content", path: "content.text" },
        parent_argument: "content"
      },
      content_format: {
        type: "string",
        required: false,
        default: "text",
        cli: { flag: "--content-json" },
        mcp: { argument: "content", path: "content.format" },
        allowed_values: ["text", "json"],
        parent_argument: "content"
      },
      ...projectContextArguments,
      tags: {
        type: "string[]",
        required: false,
        cli: { flag: "--tag", repeatable: true },
        mcp: { argument: "tags" }
      },
      state: {
        type: "string",
        required: false,
        cli: { flag: "--state" },
        mcp: { argument: "state" },
        allowed_values: RECORD_STATES
      },
      confidence: {
        type: "number",
        required: false,
        cli: { flag: "--confidence" },
        mcp: { argument: "confidence" }
      },
      priority: {
        type: "string",
        required: false,
        cli: { flag: "--priority" },
        mcp: { argument: "priority" },
        allowed_values: RECORD_PRIORITIES
      },
      provenance: {
        type: "object",
        required: false,
        mcp: { argument: "provenance" }
      },
      derived_from: {
        type: "string[]",
        required: false,
        cli: { flag: "--derived-from", repeatable: true },
        mcp: { argument: "provenance", path: "provenance.derived_from" },
        parent_argument: "provenance"
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "provenance", path: "provenance.reason" },
        parent_argument: "provenance"
      },
      provenance_method: {
        type: "string",
        required: false,
        mcp: { argument: "provenance", path: "provenance.method" },
        allowed_values: PROVENANCE_METHODS,
        parent_argument: "provenance"
      },
      provenance_promoted_at: {
        type: "string",
        required: false,
        mcp: { argument: "provenance", path: "provenance.promoted_at" },
        parent_argument: "provenance"
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      },
      ...sourceIdentityArguments
    },
    required_fields_by_name: {
      kind: {
        name: "kind",
        argument_path: "kind",
        value: "<kind>",
        placeholder: "<kind>",
        allowed_values: RECORD_KINDS
      },
      scope: {
        name: "scope",
        argument_path: "scope",
        value: "<scope>",
        placeholder: "<scope>",
        allowed_values: RECORD_SCOPES
      },
      priority: {
        name: "priority",
        argument_path: "priority",
        allowed_values: RECORD_PRIORITIES
      },
      text_or_content: {
        name: "text_or_content",
        argument_path: "text|content",
        placeholder: "<text_or_content>",
        alternatives: ["text", "content"]
      }
    },
    interfaces: {
      cli: {
        command: "moryn write --kind <kind> --type <type> --scope <scope> --text <text>",
        argv: ["write", "--kind", "<kind>", "--type", "<type>", "--scope", "<scope>", "--text", "<text>"]
      },
      mcp: { tool: "write", arguments: { kind: "<kind>", type: "<type>", scope: "<scope>", text: "<text>" } }
    }
  }),
  operationContract({
    operation: "revise",
    category: "core",
    summary: "Append a logical patch event for an existing record.",
    safe_to_run: false,
    required_when: "When an existing record needs a targeted patch and the patch is already known.",
    required_fields: ["record_id", "patch"],
    argument_sources: userInputSources(["record_id", "patch"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      patch: {
        type: "object",
        required: true,
        cli: { flag: "--set", repeatable: true },
        mcp: { argument: "patch" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      },
      ...sourceIdentityArguments
    },
    interfaces: {
      cli: { command: "moryn revise <record_id> --set <path=value>", argv: ["revise", "<record_id>", "--set", "<path=value>"] },
      mcp: { tool: "revise", arguments: { record_id: "<record_id>", patch: { "<path>": "<value>" } } }
    }
  }),
  operationContract({
    operation: "promote",
    category: "core",
    summary: "Change a record state by appending a promotion/state event.",
    safe_to_run: false,
    required_when: "When a candidate, archived, or quarantined record should move to a target state.",
    required_fields: ["record_id", "target_state"],
    argument_sources: userInputSources(["record_id", "target_state"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      target_state: {
        type: "string",
        required: true,
        cli: { flag: "--state" },
        mcp: { argument: "target_state" },
        allowed_values: RECORD_STATES
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      confirmed: {
        type: "boolean",
        required: false,
        cli: { flag: "--confirm" },
        mcp: { argument: "confirmed" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      },
      ...sourceIdentityArguments
    },
    required_fields_by_name: {
      target_state: {
        name: "target_state",
        argument_path: "target_state",
        value: "<state>",
        placeholder: "<state>",
        allowed_values: RECORD_STATES
      }
    },
    interfaces: {
      cli: { command: "moryn promote <record_id> --state <state>", argv: ["promote", "<record_id>", "--state", "<state>"] },
      mcp: { tool: "promote", arguments: { record_id: "<record_id>", target_state: "<state>" } }
    }
  }),
  operationContract({
    operation: "archive",
    category: "core",
    summary: "Hide a record from default boot and recall while preserving history.",
    safe_to_run: false,
    required_when: "When a record should be removed from normal retrieval without deleting history.",
    required_fields: ["record_id"],
    argument_sources: userInputSources(["record_id"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      },
      ...sourceIdentityArguments
    },
    interfaces: {
      cli: { command: "moryn archive <record_id>", argv: ["archive", "<record_id>"] },
      mcp: { tool: "archive", arguments: { record_id: "<record_id>" } }
    }
  }),
  operationContract({
    operation: "quarantine",
    category: "core",
    summary: "Mark a record as sensitive or unsafe so it is excluded by default.",
    safe_to_run: false,
    required_when: "When a record should stop appearing in normal agent context because it is unsafe or sensitive.",
    required_fields: ["record_id"],
    argument_sources: userInputSources(["record_id"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      reason: {
        type: "string",
        required: false,
        cli: { flag: "--reason" },
        mcp: { argument: "reason" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      },
      ...sourceIdentityArguments
    },
    interfaces: {
      cli: { command: "moryn quarantine <record_id>", argv: ["quarantine", "<record_id>"] },
      mcp: { tool: "quarantine", arguments: { record_id: "<record_id>" } }
    }
  }),
  operationContract({
    operation: "link",
    category: "core",
    summary: "Append a relationship from one record to another.",
    safe_to_run: false,
    required_when: "When two existing records should be connected by a known relationship type.",
    required_fields: ["record_id", "linked_record_id", "link_type"],
    argument_sources: userInputSources(["record_id", "linked_record_id", "link_type"]),
    arguments_by_name: {
      record_id: {
        type: "string",
        required: true,
        cli: { positional: "record-id" },
        mcp: { argument: "record_id" }
      },
      linked_record_id: {
        type: "string",
        required: true,
        cli: { positional: "linked-record-id" },
        mcp: { argument: "linked_record_id" }
      },
      link_type: {
        type: "string",
        required: true,
        cli: { flag: "--type" },
        mcp: { argument: "link_type" }
      },
      source: {
        type: "object",
        required: false,
        mcp: { argument: "source" }
      },
      ...sourceIdentityArguments
    },
    interfaces: {
      cli: {
        command: "moryn link <record_id> <linked_record_id> --type <type>",
        argv: ["link", "<record_id>", "<linked_record_id>", "--type", "<type>"]
      },
      mcp: { tool: "link", arguments: { record_id: "<record_id>", linked_record_id: "<linked_record_id>", link_type: "<type>" } }
    }
  }),
  operationContract({
    operation: "list_recent",
    category: "core",
    summary: "Return recently updated records.",
    safe_to_run: true,
    required_when: "When an agent needs a quick recent-record index or a fallback after a missing record id.",
    required_fields: [],
    arguments_by_name: {
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn list-recent", argv: ["list-recent"] },
      mcp: { tool: "list_recent", arguments: {} }
    }
  }),
  operationContract({
    operation: "memory_doctor",
    category: "core",
    summary: "Read-only memory health check that surfaces candidate backlog, promotable records, marker noise, and project-id splits.",
    safe_to_run: true,
    required_when: "When an agent or user wants to audit memory quality before promoting, archiving, or repairing project identity.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn memory doctor", argv: ["memory", "doctor"] },
      mcp: { tool: "memory_doctor", arguments: {} }
    }
  }),
  operationContract({
    operation: "memory_lifecycle",
    category: "core",
    summary: "Read-only memory lifecycle report that classifies retained, stale, and archive-candidate records with auditable follow-up actions.",
    safe_to_run: true,
    required_when: "When memory has accumulated and an agent or user needs to decide what to retain, inspect, or archive without mutating records.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      now: {
        type: "string",
        required: false,
        cli: { flag: "--now" },
        mcp: { argument: "now" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn memory lifecycle", argv: ["memory", "lifecycle"] },
      mcp: { tool: "memory_lifecycle", arguments: {} }
    }
  }),
  operationContract({
    operation: "capture_policy",
    category: "core",
    summary: "Read-only Capture Policy Audit that explains autocapture capture, review, and archive decisions with rule evidence.",
    safe_to_run: true,
    required_when: "When an agent or user needs to inspect why autocaptured handoffs were auto-captured, entered Capture Inbox, or were policy-archived before review.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn capture policy", argv: ["capture", "policy"] },
      mcp: { tool: "capture_policy", arguments: {} }
    }
  }),
  operationContract({
    operation: "dogfood_report",
    category: "core",
    summary: "Read-only dogfood report that surfaces capture-review backlog, duplicate handoffs, and failure or timeout signals from the local store.",
    safe_to_run: true,
    required_when: "When improving Moryn itself or auditing friction from recent local agent work before adding automation.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn dogfood report", argv: ["dogfood", "report"] },
      mcp: { tool: "dogfood_report", arguments: {} }
    }
  }),
  operationContract({
    operation: "activation_status",
    category: "core",
    summary: "Inspect generated, configured, and runtime-proven host activation without mutation.",
    safe_to_run: true,
    required_when: "After install, before trusting host hooks, or when lifecycle automation appears inactive.",
    required_fields: ["host"],
    argument_sources: userInputSources(["host"]),
    arguments_by_name: { ...projectContextArguments, host: installArguments.host },
    interfaces: { cli: { command: "moryn activation status --host <host> --project <path>", argv: ["activation", "status", "--host", "<host>", "--project", "<path>"] }, mcp: { tool: "activation_status", arguments: { host: "<host>" } } }
  }),
  operationContract({
    operation: "activation_apply",
    category: "lifecycle",
    summary: "Generate and safely activate Moryn-owned Claude Code or Codex lifecycle hooks.",
    safe_to_run: false,
    required_when: "When Claude or Codex activation diagnosis says the local project hook configuration is safely repairable.",
    required_fields: ["host"],
    argument_sources: userInputSources(["host"]),
    arguments_by_name: { ...projectContextArguments, host: installArguments.host },
    interfaces: { cli: { command: "moryn activation apply --host <claude|codex> --project <path>", argv: ["activation", "apply", "--host", "<claude|codex>", "--project", "<path>"] }, mcp: { tool: "activation_apply", arguments: { host: "<claude|codex>" } } }
  }),
  operationContract({
    operation: "health_check",
    category: "core",
    summary: "Read-only installation and store health check for setup trust, project readiness, privacy boundary, and capture review backlog.",
    safe_to_run: true,
    required_when: "After install, before dogfooding a new host, or whenever a user needs one compact readiness report without mutating memory.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      host: installArguments.host,
      sync_remote: installArguments.sync_remote,
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn health check", argv: ["health", "check"] },
      mcp: { tool: "health_check", arguments: {} }
    }
  }),
  operationContract({
    operation: "recall_eval",
    category: "core",
    summary: "Read-only recall quality eval for golden queries, expected record ids, privacy checks, ranking reasons, and follow-up actions.",
    safe_to_run: true,
    required_when: "When recall quality needs measurable evidence from golden queries before changing memory, ranking, or release readiness.",
    required_fields: ["cases"],
    arguments_by_name: {
      cases: {
        type: "object",
        required: true,
        cli: { flag: "--cases" },
        mcp: { argument: "cases" }
      },
      ...projectContextArguments,
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn eval recall --cases <json>", argv: ["eval", "recall", "--cases", "<json>"] },
      mcp: { tool: "recall_eval", arguments: { cases: [] } }
    }
  }),
  operationContract({
    operation: "refresh",
    category: "core",
    summary: "Return important changes since a cursor for periodic memory refresh.",
    safe_to_run: true,
    required_when: "When an agent has a refresh cursor and needs changes without a full boot.",
    required_fields: [],
    arguments_by_name: {
      ...projectContextArguments,
      cursor: {
        type: "string",
        required: false,
        cli: { flag: "--cursor" },
        mcp: { argument: "cursor" }
      },
      current_task: {
        type: "string",
        required: false,
        cli: { flag: "--current-task" },
        mcp: { argument: "current_task" }
      },
      limit: {
        type: "number",
        required: false,
        default: 20,
        cli: { flag: "--limit", default: 20 },
        mcp: { argument: "limit" }
      },
      ...privateReadArgument
    },
    interfaces: {
      cli: { command: "moryn refresh", argv: ["refresh"] },
      mcp: { tool: "refresh", arguments: {} }
    }
  }),
  operationContract({
    operation: "sync_init",
    category: "sync",
    summary: "Initialize or connect the local Moryn store to a Git remote.",
    safe_to_run: false,
    required_when: "When cross-device sync is needed and the target remote is known.",
    required_fields: ["remote"],
    argument_sources: userInputSources(["remote"]),
    arguments_by_name: {
      remote: {
        type: "string",
        required: true,
        cli: { positional: "remote" },
        mcp: { argument: "remote" }
      },
      open: dashboardArguments.open
    },
    interfaces: {
      cli: { command: "moryn sync init <remote>", argv: ["sync", "init", "<remote>"] },
      mcp: { tool: "sync_init", arguments: { remote: "<remote>" } }
    }
  }),
  operationContract({
    operation: "sync_status",
    category: "sync",
    summary: "Return Git sync configuration and local/remote status.",
    safe_to_run: true,
    required_when: "Before retrying sync operations after a conflict, or when sync readiness is unclear.",
    required_fields: [],
    arguments_by_name: {},
    interfaces: {
      cli: { command: "moryn sync --status", argv: ["sync", "--status"] },
      mcp: { tool: "sync_status", arguments: {} }
    }
  }),
  operationContract({
    operation: "sync_pull",
    category: "sync",
    summary: "Pull remote event history into the local Moryn store.",
    safe_to_run: false,
    required_when: "When the user wants a direct pull instead of using agent_start/agent_enter lifecycle sync.",
    required_fields: [],
    arguments_by_name: {
      open: dashboardArguments.open
    },
    interfaces: {
      cli: { command: "moryn sync --pull", argv: ["sync", "--pull"] },
      mcp: { tool: "sync_pull", arguments: {} }
    }
  }),
  operationContract({
    operation: "sync_push",
    category: "sync",
    summary: "Commit and push local event history from the Moryn store.",
    safe_to_run: false,
    required_when: "When the user wants a direct push instead of using lifecycle status/finish sync.",
    required_fields: [],
    arguments_by_name: {
      message: {
        type: "string",
        required: false,
        cli: { flag: "--message" },
        mcp: { argument: "message" }
      },
      open: dashboardArguments.open
    },
    interfaces: {
      cli: { command: "moryn sync --push", argv: ["sync", "--push"] },
      mcp: { tool: "sync_push", arguments: {} }
    }
  }),
  operationContract({
    operation: "dashboard",
    category: "observability",
    summary: "Generate or serve a local HTML dashboard showing sync state, records, events, and agent activity.",
    safe_to_run: true,
    required_when: "When the user or agent needs to inspect what Moryn has synced or recently stored; use --serve for live browser monitoring.",
    required_fields: [],
    arguments_by_name: dashboardArguments,
    interfaces: {
      cli: { command: "moryn dashboard", argv: ["dashboard"] },
      mcp: { tool: "dashboard", arguments: {} }
    }
  }),
  operationContract({
    operation: "rebuild",
    category: "maintenance",
    summary: "Regenerate snapshots and indexes from append-only events.",
    safe_to_run: true,
    required_when: "When derived views may be stale or after manual event-store recovery.",
    required_fields: [],
    arguments_by_name: {},
    interfaces: {
      cli: { command: "moryn rebuild", argv: ["rebuild"] },
      mcp: { tool: "rebuild", arguments: {} }
    }
  })
] as const satisfies readonly OperationContract[];

function operationsById(operations: readonly OperationContract[]): Record<string, OperationContract> {
  return Object.fromEntries(operations.map((operation) => [operation.operation, operation]));
}

const OPERATION_CONTRACTS_BY_ID = operationsById(OPERATION_CONTRACTS);

const OPERATION_CONTRACTS_BY_TOOL = Object.fromEntries(
  OPERATION_CONTRACTS.map((operation) => [operation.interfaces.mcp.tool, operation])
) as Record<string, OperationContract>;

const OPERATION_CONTRACTS_BY_CLI_COMMAND = Object.fromEntries(
  OPERATION_CONTRACTS.map((operation) => [operation.interfaces.cli.command, operation])
) as Record<string, OperationContract>;

export function operationArgumentsByTool(tool: string): Record<string, OperationArgumentMetadata> {
  return OPERATION_CONTRACTS_BY_TOOL[tool]?.arguments_by_name ?? {};
}

export function operationCliArgvByTool(tool: string): readonly string[] {
  return OPERATION_CONTRACTS_BY_TOOL[tool]?.interfaces.cli.argv ?? tool.split("_");
}

function singleOperationContractResponse(contract: OperationContract, matchedSource: string): SingleOperationContractResponse {
  return {
    operation: contract,
    operation_source: `operations_by_id.${contract.operation}`,
    matched_source: matchedSource,
    selection_sources: OPERATION_CONTRACTS_SELECTION_SOURCES
  };
}

function operationContractLookup(operation: string, options: { includeExecFile?: boolean } = {}): OperationContractIndexEntry["full_contract_lookup"] {
  const args = ["contracts", "operations", "--operation", operation];
  return {
    package_helper: `getOperationContract('${operation}')`,
    cli: {
      command: commandLineForCliInterface("moryn", args),
      executable: "moryn",
      args,
      ...(options.includeExecFile ? { exec_file: {
        executable: "moryn",
        args
      } } : {})
    },
    mcp: {
      tool: "operation_contracts",
      arguments: { operation }
    }
  };
}

function operationContractIndexEntry(operation: OperationContract): OperationContractIndexEntry {
  const includeDetailedInputHint = !operation.safe_to_run || operation.safety.requires_user_confirmation;
  const includeExecutionHint = includeDetailedInputHint && (operation.execution.required_inputs.length > 0 || !operation.execution.ready_to_run);
  return {
    operation: operation.operation,
    operation_source: `operations_by_id.${operation.operation}`,
    category: operation.category,
    safe_to_run: operation.safe_to_run,
    ready_to_run: operation.execution.ready_to_run,
    next_step: operation.execution.next_step,
    mcp_tool: operation.interfaces.mcp.tool,
    cli_command: operation.interfaces.cli.command,
    required_fields: operation.required_fields,
    missing_required_fields: operation.execution.missing_required_fields,
    ...(includeDetailedInputHint && operation.execution.required_inputs.length > 0 ? { summary: operation.summary } : {}),
    ...(includeExecutionHint ? { execution_hint: {
      guard: "execution.ready_to_run",
      ready_to_run: operation.execution.ready_to_run,
      next_step: operation.execution.next_step,
      required_fields: operation.required_fields,
      missing_required_fields: operation.execution.missing_required_fields,
      ...(operation.execution.required_inputs.length > 0 ? {
        required_input_sources: {
          by_field: "execution.required_inputs_by_field.<field>",
          by_argument_path: "execution.required_inputs_by_argument_path.<argument_path>",
          by_value_path: "execution.required_input_paths_by_value_path.<value_path>"
        }
      } : {})
    } } : {}),
    full_contract_lookup: operationContractLookup(operation.operation, {
      includeExecFile: operation.operation === "agent_finish"
    })
  };
}

function operationsByMcpToolId(operations: readonly OperationContract[]): Record<string, string> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.mcp.tool, operation.operation]));
}

function operationsByCliCommandId(operations: readonly OperationContract[]): Record<string, string> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.cli.command, operation.operation]));
}

export function getOperationContractIndex(): OperationContractIndexResponse {
  const operationEntries = OPERATION_CONTRACTS.map(operationContractIndexEntry);
  const operations = operationEntries.map(({ operation, mcp_tool, cli_command, next_step }) => ({ operation, mcp_tool, cli_command, next_step }));
  return {
    recommended_entrypoint: "agent_enter",
    index_use: "Use an operation id, MCP tool, or CLI command from this compact index to fetch one operation contract.",
    next_lookup: {
      package_helpers: {
        by_operation: "getOperationContract(operation)",
        by_mcp_tool: "getOperationContractByMcpTool(tool)",
        by_cli_command: "getOperationContractByCliCommand(command)"
      },
      cli: {
        by_operation: "moryn contracts operations --operation <operation>",
        by_mcp_tool: "moryn contracts operations --mcp-tool <tool>",
        by_cli_command: "moryn contracts operations --cli-command <command>"
      },
      mcp: {
        tool: "operation_contracts",
        by_operation_arguments: { operation: "<operation>" },
        by_mcp_tool_arguments: { mcp_tool: "<tool>" },
        by_cli_command_arguments: { cli_command: "<command>" }
      }
    },
    operations,
    operations_by_id: Object.fromEntries(operationEntries.map((operation) => [operation.operation, operation])),
    operations_by_mcp_tool: operationsByMcpToolId(OPERATION_CONTRACTS),
    operations_by_cli_command: operationsByCliCommandId(OPERATION_CONTRACTS),
    operation_source_lookup: {
      by_mcp_tool: {
        operation_id: "operations_by_mcp_tool.<tool>",
        operation_source: "operations_by_id.<operation>.operation_source"
      },
      by_cli_command: {
        operation_id: "operations_by_cli_command.<command>",
        operation_source: "operations_by_id.<operation>.operation_source"
      }
    },
    selection_sources: OPERATION_CONTRACT_INDEX_SELECTION_SOURCES
  };
}

export function getOperationContract(operation: string): SingleOperationContractResponse | undefined {
  validateRequiredOperationContractLookupArgument("operation", operation);
  const contract = OPERATION_CONTRACTS_BY_ID[operation];
  if (!contract) return undefined;
  return singleOperationContractResponse(contract, `operations_by_id.${operation}`);
}

export function getOperationContractByMcpTool(tool: string): SingleOperationContractResponse | undefined {
  validateRequiredOperationContractLookupArgument("mcp_tool", tool);
  const contract = OPERATION_CONTRACTS_BY_TOOL[tool];
  if (!contract) return undefined;
  return singleOperationContractResponse(contract, `operations_by_mcp_tool.${tool}`);
}

export function getOperationContractByCliCommand(command: string): SingleOperationContractResponse | undefined {
  validateRequiredOperationContractLookupArgument("cli_command", command);
  const contract = OPERATION_CONTRACTS_BY_CLI_COMMAND[command];
  if (!contract) return undefined;
  return singleOperationContractResponse(contract, `operations_by_cli_command.${command}`);
}

function operationContractReference(operation: OperationContract): OperationContractReference {
  return {
    operation: operation.operation,
    operation_source: `operations_by_id.${operation.operation}`
  };
}

function operationContractReferences(operations: readonly OperationContract[]): OperationContractReference[] {
  return operations.map(operationContractReference);
}

function operationsByCategory(operations: readonly OperationContract[]): Record<string, Record<string, OperationContractReference>> {
  const categories: Record<string, Record<string, OperationContractReference>> = {};
  for (const operation of operations) {
    categories[operation.category] ??= {};
    categories[operation.category][operation.operation] = operationContractReference(operation);
  }
  return categories;
}

function operationsByMcpTool(operations: readonly OperationContract[]): Record<string, OperationContractReference> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.mcp.tool, operationContractReference(operation)]));
}

function operationsByCliCommand(operations: readonly OperationContract[]): Record<string, OperationContractReference> {
  return Object.fromEntries(operations.map((operation) => [operation.interfaces.cli.command, operationContractReference(operation)]));
}

export function getOperationContracts() {
  return {
    recommended_entrypoint: "agent_enter",
    operations: OPERATION_CONTRACTS,
    operations_by_id: OPERATION_CONTRACTS_BY_ID,
    operations_by_category: operationsByCategory(OPERATION_CONTRACTS),
    operations_by_mcp_tool: operationsByMcpTool(OPERATION_CONTRACTS),
    operations_by_cli_command: operationsByCliCommand(OPERATION_CONTRACTS),
    selection_sources: OPERATION_CONTRACTS_SELECTION_SOURCES
  };
}
