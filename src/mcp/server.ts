import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getOperationContract,
  getOperationContractByCliCommand,
  getOperationContractByMcpTool,
  getOperationContractIndex,
  getOperationContracts,
  getSelectionSourceContracts
} from "../index.js";
import {
  OperationContractLookupConflictError,
  OperationContractLookupError,
  type OperationContractLookupOption,
  operationArgumentsByTool,
  type OperationArgumentMetadata,
  validateOperationContractIndexArgument,
  validateOperationContractLookupArgument
} from "../operation-contracts.js";
import { agentDoctor, agentEnter, agentFinish, agentGuide, agentStart, agentStatus } from "../core/agent-lifecycle.js";
import { mcpArgumentsForAction } from "../core/action-interfaces.js";
import { initializeStore } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";
import type { createEngine } from "../core/engine.js";
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
  commandForReviseContext,
  type MorynErrorContext,
  toErrorEnvelope
} from "../core/errors.js";
import { SYNC_MODES, initializeProjectConfig, resolveProjectContext, type SyncMode } from "../core/project.js";
import { RECORD_KINDS, RECORD_PRIORITIES, RECORD_SCOPES, RECORD_STATES } from "../core/schema.js";
import type { RecordKind, RecordPriority, RecordProvenance, RecordScope, RecordSource, RecordState } from "../core/types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../sync/git.js";

type Engine = ReturnType<typeof createEngine>;
type McpInputShape = Record<string, z.ZodType>;
type McpAliasConflict = {
  argument: string;
  path: string;
  contractArgument: string;
  camelAlias?: string;
  aliasConflictKind?: McpAliasConflictKind;
  valuesByInput: Record<string, unknown>;
};
type McpAliasConflictKind =
  | "nested_vs_flattened"
  | "literal_path_vs_flattened"
  | "nested_vs_literal_path"
  | "parent_scalar_vs_child_alias"
  | "camelcase_vs_contract_alias"
  | "singular_vs_plural_alias"
  | "multiple_aliases";
type McpAliasConflictDoNot =
  | "provide_both_nested_and_flattened_aliases"
  | "provide_both_literal_path_and_flattened_aliases"
  | "provide_both_nested_and_literal_path_aliases"
  | "provide_parent_scalar_with_child_aliases"
  | "provide_both_camelcase_and_contract_aliases"
  | "provide_both_singular_and_plural_aliases";
type McpUnknownArgumentDoNot =
  | "send_unknown_mcp_arguments"
  | "retry_with_same_unknown_argument";
type McpExplicitAlias = {
  alias: string;
  target: string;
  contractArgument: string;
  conflictKind: McpAliasConflictKind;
  normalize: (value: unknown) => unknown;
};
type McpObjectPathAlias = {
  alias: string;
  target: string;
  contractArgument: string;
  conflictKind: McpAliasConflictKind;
  normalize: (value: unknown) => unknown;
};

const stringSchema = z.string();
const recordKindSchema = z.union([z.enum(RECORD_KINDS), stringSchema]);
const recordScopeSchema = z.union([z.enum(RECORD_SCOPES), stringSchema]);
const recordStateSchema = z.union([z.enum(RECORD_STATES), stringSchema]);
const recordPrioritySchema = z.union([z.enum(RECORD_PRIORITIES), stringSchema]);
const syncModeSchema = z.union([z.enum(SYNC_MODES), stringSchema]);
const numberSchema = z.number();
const coreValidatedNumberSchema = z.unknown();
const coreValidatedBooleanSchema = z.unknown();
const coreValidatedSyncModeSchema = z.unknown();
const coreValidatedRecordKindSchema = z.unknown();
const coreValidatedRecordScopeSchema = z.unknown();
const coreValidatedRecordStateSchema = z.unknown();
const coreValidatedRecordPrioritySchema = z.unknown();
const coreValidatedStringSchema = z.unknown();
const sourceAliasInputSchema = {
  source_client: z.unknown().optional(),
  "source.client": z.unknown().optional(),
  source_session_id: z.unknown().optional(),
  "source.session_id": z.unknown().optional(),
  source_model: z.unknown().optional(),
  "source.model": z.unknown().optional(),
  source_device_id: z.unknown().optional(),
  "source.device_id": z.unknown().optional()
} as const;
const writeAliasInputSchema = {
  content_text: z.unknown().optional(),
  content_format: z.unknown().optional(),
  "content.text": z.unknown().optional(),
  "content.format": z.unknown().optional(),
  derived_from: z.unknown().optional(),
  "provenance.derived_from": z.unknown().optional(),
  reason: z.unknown().optional(),
  "provenance.reason": z.unknown().optional(),
  provenance_method: z.unknown().optional(),
  "provenance.method": z.unknown().optional(),
  provenance_promoted_at: z.unknown().optional(),
  "provenance.promoted_at": z.unknown().optional(),
  ...sourceAliasInputSchema
} as const;
const agentAliasInputSchema = {
  agent_client: z.unknown().optional(),
  "agent.client": z.unknown().optional(),
  agent_session_id: z.unknown().optional(),
  "agent.session_id": z.unknown().optional(),
  agent_model: z.unknown().optional(),
  "agent.model": z.unknown().optional(),
  agent_device_id: z.unknown().optional(),
  "agent.device_id": z.unknown().optional()
} as const;

function recallRepeatableAlias(alias: string, target: string): McpExplicitAlias {
  return {
    alias,
    target,
    contractArgument: target,
    conflictKind: "singular_vs_plural_alias",
    normalize: repeatableAliasValue
  };
}

function syncRemoteObjectPathAliases(): McpObjectPathAlias[] {
  return [
    {
      alias: "sync",
      target: "sync_remote",
      contractArgument: "sync_remote",
      conflictKind: "nested_vs_flattened",
      normalize: syncRemoteFromSyncObject
    },
    {
      alias: "sync.remote",
      target: "sync_remote",
      contractArgument: "sync_remote",
      conflictKind: "nested_vs_literal_path",
      normalize: (value) => value
    }
  ];
}

const explicitMcpAliasesByTool: Record<string, McpExplicitAlias[]> = {
  recall: [
    recallRepeatableAlias("record_id", "record_ids"),
    recallRepeatableAlias("recordId", "record_ids"),
    recallRepeatableAlias("kind", "kinds"),
    recallRepeatableAlias("scope", "scopes"),
    recallRepeatableAlias("type", "types"),
    recallRepeatableAlias("state", "states"),
    recallRepeatableAlias("tag", "tags"),
    recallRepeatableAlias("file", "files")
  ]
};

const objectPathMcpAliasesByTool: Record<string, McpObjectPathAlias[]> = {
  agent_doctor: syncRemoteObjectPathAliases(),
  agent_enter: syncRemoteObjectPathAliases(),
  agent_finish: syncRemoteObjectPathAliases(),
  agent_guide: syncRemoteObjectPathAliases(),
  agent_start: syncRemoteObjectPathAliases(),
  agent_status: syncRemoteObjectPathAliases(),
  boot: syncRemoteObjectPathAliases(),
  project_init: [
    {
      alias: "sync",
      target: "sync_mode",
      contractArgument: "sync_mode",
      conflictKind: "nested_vs_flattened",
      normalize: syncModeFromProjectSyncObject
    },
    {
      alias: "sync.mode",
      target: "sync_mode",
      contractArgument: "sync_mode",
      conflictKind: "nested_vs_literal_path",
      normalize: (value) => value
    }
  ],
  project_list: syncRemoteObjectPathAliases()
};

function repeatableAliasValue(value: unknown): unknown {
  return Array.isArray(value) ? value : [value];
}

function syncModeFromProjectSyncObject(value: unknown): unknown {
  return isMcpObject(value) ? value.mode : value;
}

function syncRemoteFromSyncObject(value: unknown): unknown {
  return isMcpObject(value) ? value.remote : value;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function mcpCamelCaseAliasName(argument: OperationArgumentMetadata): string | undefined {
  const alias = snakeToCamel(argument.name);
  return alias === argument.name ? undefined : alias;
}

function mcpCamelCaseAliasTarget(argument: OperationArgumentMetadata): string | undefined {
  if (!argument.mcp) return undefined;
  return argument.mcp.path ? argument.name : argument.mcp.argument;
}

function camelCaseAliasInputSchema(tool: string): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries(Object.values(operationArgumentsByTool(tool)).flatMap((argument) => {
    const alias = mcpCamelCaseAliasName(argument);
    return alias ? [[alias, z.unknown().optional()] as const] : [];
  }));
}

function explicitAliasInputSchema(tool: string): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries((explicitMcpAliasesByTool[tool] ?? []).map((alias) => [alias.alias, z.unknown().optional()]));
}

function objectPathAliasInputSchema(tool: string): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries((objectPathMcpAliasesByTool[tool] ?? []).map((alias) => [alias.alias, z.unknown().optional()]));
}

function mcpInputSchema<TShape extends McpInputShape>(shape: TShape): z.ZodObject<TShape> {
  return z.object(shape).passthrough();
}

const WRITE_CONTENT_RETRY_ARGUMENTS = [
  { argument: "text", value_placeholder: "<text>" },
  { argument: "content", value_placeholder: "<content object>" }
] as const;

type McpArgumentRecoveryHint =
  | {
      operation_contract: "operations_by_id.write";
      missing_argument: { argument: "type" | "scope" };
      expected: { kind: "required_argument"; required: true };
      argument_sources: Partial<Record<"type" | "scope", string>>;
      retry_with: { argument: "type" | "scope"; value_placeholder: string };
    }
  | {
      operation_contract: "operations_by_id.write";
      missing_one_of: Array<{ argument: "text" | "content"; value_placeholder: string }>;
      expected: { kind: "choose_one"; arguments: ["text", "content"] };
      argument_sources: Record<"text" | "content", string>;
      retry_with: Array<{ argument: "text" | "content"; value_placeholder: string }>;
    }
  | {
      operation_contract: "operations_by_id.write";
      rejected_arguments: Array<
        | { argument: "text"; value: unknown }
        | { argument: "content"; value: unknown }
      >;
      expected: { kind: "choose_one"; arguments: ["text", "content"] };
      argument_sources: Record<"text" | "content", string>;
      retry_with: Array<{ argument: "text" | "content"; value_placeholder: string }>;
    }
  | {
      operation_contract: `operations_by_id.${McpProjectContextOperation}`;
      rejected_argument: { argument: "project_id"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<"project_id", string>;
      discover_with: {
        tool: "project_list";
        command: "moryn project list";
        arguments: Record<string, never>;
        safe_to_run: true;
      };
      retry_with: {
        argument: "project_id";
        value_source: "project_list.projects_by_id.<project_id>.project_id";
        value_placeholder: "<project_id_from_project_list>";
      };
      fallback_value_source: "project_list.projects[].project_id";
      do_not: ["invent_project_id", "retry_with_same_invalid_project_id"];
    }
  | {
      operation_contract: `operations_by_id.${string}`;
      conflicting_argument: {
        argument: string;
        conflict_kind: McpAliasConflictKind;
        values_by_input: Record<string, unknown>;
      };
      expected: { kind: "single_value" };
      argument_sources: Record<string, string>;
      retry_with: { argument: string; value_placeholder: string };
      do_not: [McpAliasConflictDoNot, "retry_with_conflicting_alias_values"];
    }
  | {
      operation_contract: `operations_by_id.${McpProjectContextOperation}`;
      rejected_argument: { argument: "project_path"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<"project_path", string>;
      retry_with: {
        argument: "project_path";
        value_source: "user_input.project_path";
        value_placeholder: "<project_path>";
      };
      retry_alternative: {
        argument: "project_id";
        value_source: "project_list.projects_by_id.<project_id>.project_id";
        value_placeholder: "<project_id_from_project_list>";
      };
      do_not: ["invent_project_path", "assume_numeric_project_path_is_valid"];
    }
  | {
      operation_contract: `operations_by_id.${string}`;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "known_argument" };
      argument_sources: Partial<Record<string, string>>;
      retry_with: { argument: string; value_placeholder: string };
      do_not: [McpUnknownArgumentDoNot, McpUnknownArgumentDoNot];
    }
  | {
      operation_contract: `operations_by_id.${string}`;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "no_arguments" };
      argument_sources: Record<string, never>;
      retry_with: { arguments: Record<string, never> };
      do_not: [McpUnknownArgumentDoNot, McpUnknownArgumentDoNot];
    };

class McpArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: McpArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: McpArgumentRecoveryHint) {
    super(message);
    this.name = "McpArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

class McpAliasConflictError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: McpArgumentRecoveryHint;

  constructor(tool: string, conflict: McpAliasConflict) {
    super(`Invalid argument: Conflicting ${conflict.path} aliases`);
    this.name = "McpAliasConflictError";
    this.recommended_action = `retry ${tool} with one ${conflict.path} value`;
    this.recovery_hint = {
      operation_contract: `operations_by_id.${tool}`,
      conflicting_argument: {
        argument: conflict.path,
        conflict_kind: conflictKindForAliasConflict(conflict),
        values_by_input: conflict.valuesByInput
      },
      expected: { kind: "single_value" },
      argument_sources: {
        [conflict.path]: `operations_by_id.${tool}.arguments_by_name.${conflict.contractArgument}`
      },
      retry_with: { argument: conflict.path, value_placeholder: placeholderForAliasConflict(conflict) },
      do_not: doNotForAliasConflict(conflict)
    };
  }
}

class McpUnknownArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: McpArgumentRecoveryHint;

  constructor(tool: string, argument: string, value: unknown) {
    super(`Invalid argument: Unknown argument: ${argument}`);
    this.name = "McpUnknownArgumentError";
    this.recommended_action = `retry ${tool} with only contract arguments`;
    const retryArgument = closestMcpKnownArgument(tool, argument);
    this.recovery_hint = retryArgument
      ? {
          operation_contract: `operations_by_id.${tool}`,
          rejected_argument: { argument, value },
          expected: { kind: "known_argument" },
          argument_sources: mcpUnknownArgumentSources(tool, retryArgument),
          retry_with: { argument: retryArgument, value_placeholder: placeholderForKnownArgument(retryArgument) },
          do_not: ["send_unknown_mcp_arguments", "retry_with_same_unknown_argument"]
        }
      : {
          operation_contract: `operations_by_id.${tool}`,
          rejected_argument: { argument, value },
          expected: { kind: "no_arguments" },
          argument_sources: {},
          retry_with: { arguments: {} },
          do_not: ["send_unknown_mcp_arguments", "retry_with_same_unknown_argument"]
        };
  }
}

function writeRequiredArgumentError(argument: "type" | "scope"): McpArgumentError {
  const argumentSources = {
    [argument]: `operations_by_id.write.arguments_by_name.${argument}`
  } satisfies Partial<Record<typeof argument, string>>;

  return new McpArgumentError(
    `Invalid argument: write requires ${argument}`,
    `retry write with required ${argument}`,
    {
      operation_contract: "operations_by_id.write",
      missing_argument: { argument },
      expected: { kind: "required_argument", required: true },
      argument_sources: argumentSources,
      retry_with: { argument, value_placeholder: `<record ${argument}>` }
    }
  );
}

function writeContentChoiceError(rejectedArguments?: Array<
  | { argument: "text"; value: unknown }
  | { argument: "content"; value: unknown }
>): McpArgumentError {
  return new McpArgumentError(
    rejectedArguments
      ? "Invalid argument: use either text or content, not both"
      : "Invalid argument: write requires text or content",
    "retry write with exactly one content input",
    {
      operation_contract: "operations_by_id.write",
      ...(rejectedArguments
        ? { rejected_arguments: rejectedArguments }
        : { missing_one_of: [...WRITE_CONTENT_RETRY_ARGUMENTS] }),
      expected: { kind: "choose_one", arguments: ["text", "content"] },
      argument_sources: {
        text: "operations_by_id.write.arguments_by_name.text",
        content: "operations_by_id.write.arguments_by_name.content"
      },
      retry_with: [...WRITE_CONTENT_RETRY_ARGUMENTS]
    }
  );
}

const coreValidatedAgentSchema = z.unknown();
const coreValidatedSourceSchema = z.object({
  client: z.unknown().optional().default("mcp"),
  session_id: z.unknown().optional(),
  model: z.unknown().optional(),
  device_id: z.unknown().optional()
});

function withDefaultSource(source: unknown): unknown {
  if (source === undefined) return { client: "mcp" };
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    return { client: "mcp", ...source };
  }
  return source;
}

type McpProjectContextOperation =
  | "boot"
  | "recall"
  | "write"
  | "refresh"
  | "agent_doctor"
  | "agent_guide"
  | "agent_enter"
  | "agent_start"
  | "agent_status"
  | "agent_finish";

function projectContextArgumentError(
  operation: McpProjectContextOperation,
  argument: "project_id" | "project_path",
  value: unknown
): McpArgumentError {
  if (argument === "project_id") {
    return new McpArgumentError(
      "Invalid argument: Invalid project_id",
      "retry with a non-empty project_id from project_list",
      {
        operation_contract: `operations_by_id.${operation}`,
        rejected_argument: { argument, value },
        expected: { kind: "non_empty_string", min_length: 1 },
        argument_sources: {
          project_id: `operations_by_id.${operation}.arguments_by_name.project_id`
        },
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
        do_not: ["invent_project_id", "retry_with_same_invalid_project_id"]
      }
    );
  }

  return new McpArgumentError(
    "Invalid argument: Invalid project_path",
    "retry with a non-empty project_path or select project_id from project_list",
    {
      operation_contract: `operations_by_id.${operation}`,
      rejected_argument: { argument, value },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: {
        project_path: `operations_by_id.${operation}.arguments_by_name.project_path`
      },
      retry_with: {
        argument: "project_path",
        value_source: "user_input.project_path",
        value_placeholder: "<project_path>"
      },
      retry_alternative: {
        argument: "project_id",
        value_source: "project_list.projects_by_id.<project_id>.project_id",
        value_placeholder: "<project_id_from_project_list>"
      },
      do_not: ["invent_project_path", "assume_numeric_project_path_is_valid"]
    }
  );
}

function validateProjectContextInput(
  operation: McpProjectContextOperation,
  input: { project_id?: unknown; project_path?: unknown }
): { project_id?: string; project_path?: string } {
  if (input.project_id !== undefined && (typeof input.project_id !== "string" || input.project_id.length === 0)) {
    throw projectContextArgumentError(operation, "project_id", input.project_id);
  }
  if (input.project_path !== undefined && (typeof input.project_path !== "string" || input.project_path.length === 0)) {
    throw projectContextArgumentError(operation, "project_path", input.project_path);
  }
  return {
    project_id: input.project_id,
    project_path: input.project_path
  };
}

function lifecycleProjectContextInput(
  operation: McpProjectContextOperation,
  input: { project_id?: unknown; project_path?: unknown }
): { projectId?: string; projectPath?: string } {
  const projectInput = validateProjectContextInput(operation, input);
  return {
    projectId: projectInput.project_id,
    projectPath: projectInput.project_path
  };
}

async function resolveProjectInput(
  operation: McpProjectContextOperation,
  input: { project_id?: unknown; project_path?: unknown }
): Promise<{ project_id?: string; tags: string[]; default_skills: string[] }> {
  const projectInput = validateProjectContextInput(operation, input);
  if (projectInput.project_id === undefined && projectInput.project_path === undefined) {
    return { tags: [], default_skills: [] };
  }
  const project = await resolveProjectContext({ projectPath: projectInput.project_path, projectId: projectInput.project_id });
  return {
    project_id: project.project_id,
    tags: project.config?.tags ?? [],
    default_skills: project.config?.default_skills ?? []
  };
}

function jsonResult(value: unknown, options: { pretty?: boolean } = {}) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, options.pretty === false ? undefined : 2)
      }
    ]
  };
}

async function toolResult(fn: () => Promise<unknown>, context?: MorynErrorContext) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return {
      ...jsonResult(toErrorEnvelope(error, context)),
      isError: true
    };
  }
}

async function toolResultWithNormalizedInput(
  tool: string,
  input: Record<string, unknown>,
  fn: (normalizedInput: Record<string, unknown>) => Promise<unknown>,
  context?: (normalizedInput: Record<string, unknown>) => MorynErrorContext
) {
  let normalizedInput: Record<string, unknown> | undefined;
  try {
    normalizedInput = normalizeMcpToolArguments(tool, input);
    return jsonResult(await fn(normalizedInput));
  } catch (error) {
    return {
      ...jsonResult(toErrorEnvelope(error, normalizedInput && context ? context(normalizedInput) : undefined)),
      isError: true
    };
  }
}

function compactUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeMcpToolArguments(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  assertKnownMcpArguments(tool, input);
  assertNoMcpAliasConflicts(tool, input);
  return mcpArgumentsForAction(tool, normalizeObjectPathMcpAliases(tool, normalizeExplicitMcpAliases(tool, normalizeMcpCamelCaseAliases(tool, input))));
}

function assertKnownMcpArguments(tool: string, input: Record<string, unknown>): void {
  const knownArguments = mcpKnownArguments(tool);
  for (const [argument, value] of Object.entries(input)) {
    if (knownArguments.has(argument)) continue;
    throw new McpUnknownArgumentError(tool, argument, value);
  }
}

function mcpKnownArguments(tool: string): Set<string> {
  const known = new Set<string>();
  for (const argument of Object.values(operationArgumentsByTool(tool))) {
    if (argument.mcp) known.add(argument.mcp.argument);
    if (argument.mcp?.path) {
      known.add(argument.name);
      known.add(argument.mcp.path);
    }
    const alias = mcpCamelCaseAliasName(argument);
    if (alias) known.add(alias);
  }
  for (const alias of explicitMcpAliasesByTool[tool] ?? []) {
    known.add(alias.alias);
  }
  for (const alias of objectPathMcpAliasesByTool[tool] ?? []) {
    known.add(alias.alias);
  }
  return known;
}

function normalizeMcpCamelCaseAliases(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const argument of Object.values(operationArgumentsByTool(tool))) {
    const alias = mcpCamelCaseAliasName(argument);
    const target = mcpCamelCaseAliasTarget(argument);
    if (!alias || !target || normalized[alias] === undefined) continue;
    if (normalized[target] === undefined) normalized[target] = normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

function normalizeExplicitMcpAliases(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const alias of explicitMcpAliasesByTool[tool] ?? []) {
    if (normalized[alias.alias] === undefined) continue;
    if (normalized[alias.target] === undefined) normalized[alias.target] = alias.normalize(normalized[alias.alias]);
    delete normalized[alias.alias];
  }
  return normalized;
}

function normalizeObjectPathMcpAliases(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const alias of objectPathMcpAliasesByTool[tool] ?? []) {
    if (normalized[alias.alias] === undefined) continue;
    if (normalized[alias.target] === undefined) normalized[alias.target] = alias.normalize(normalized[alias.alias]);
    delete normalized[alias.alias];
  }
  return normalized;
}

function assertNoMcpAliasConflicts(tool: string, input: Record<string, unknown>): void {
  const explicitAliasConflict = mcpExplicitAliasConflict(tool, input);
  if (explicitAliasConflict) throw new McpAliasConflictError(tool, explicitAliasConflict);
  const objectPathAliasConflict = mcpObjectPathAliasConflict(tool, input);
  if (objectPathAliasConflict) throw new McpAliasConflictError(tool, objectPathAliasConflict);
  const operationArguments = Object.values(operationArgumentsByTool(tool));
  for (const argument of operationArguments) {
    const conflict = mcpAliasConflict(input, argument);
    if (conflict) throw new McpAliasConflictError(tool, conflict);
  }
}

function mcpExplicitAliasConflict(tool: string, input: Record<string, unknown>): McpAliasConflict | undefined {
  const aliasesByTarget = new Map<string, McpExplicitAlias[]>();
  for (const alias of explicitMcpAliasesByTool[tool] ?? []) {
    aliasesByTarget.set(alias.target, [...(aliasesByTarget.get(alias.target) ?? []), alias]);
  }
  for (const [target, aliases] of aliasesByTarget) {
    const targetAliases = mcpInputAliasesForTarget(tool, target);
    const valuesByInput: Record<string, unknown> = {};
    const stableValues: string[] = [];
    for (const inputName of [target, ...targetAliases]) {
      const targetValue = input[inputName];
      if (targetValue === undefined) continue;
      valuesByInput[inputName] = targetValue;
      stableValues.push(stableMcpValueKey(targetValue));
    }
    for (const alias of aliases) {
      const aliasValue = input[alias.alias];
      if (aliasValue === undefined) continue;
      valuesByInput[alias.alias] = aliasValue;
      stableValues.push(stableMcpValueKey(alias.normalize(aliasValue)));
    }
    if (Object.keys(valuesByInput).length <= 1) continue;
    if (new Set(stableValues).size <= 1) continue;
    const alias = aliases[0]!;
    return {
      argument: target,
      path: target,
      contractArgument: alias.contractArgument,
      aliasConflictKind: alias.conflictKind,
      valuesByInput
    };
  }
  return undefined;
}

function mcpObjectPathAliasConflict(tool: string, input: Record<string, unknown>): McpAliasConflict | undefined {
  const aliasesByTarget = new Map<string, McpObjectPathAlias[]>();
  for (const alias of objectPathMcpAliasesByTool[tool] ?? []) {
    aliasesByTarget.set(alias.target, [...(aliasesByTarget.get(alias.target) ?? []), alias]);
  }
  for (const [target, aliases] of aliasesByTarget) {
    const valuesByInput: Record<string, unknown> = {};
    const stableValues: string[] = [];
    let objectPathAliasInputs = 0;
    const targetValue = input[target];
    if (targetValue !== undefined) {
      valuesByInput[target] = targetValue;
      stableValues.push(stableMcpValueKey(targetValue));
    }
    for (const inputName of mcpInputAliasesForTarget(tool, target)) {
      const targetAliasValue = input[inputName];
      if (targetAliasValue === undefined) continue;
      valuesByInput[inputName] = targetAliasValue;
      stableValues.push(stableMcpValueKey(targetAliasValue));
    }
    for (const alias of aliases) {
      const aliasValue = input[alias.alias];
      if (aliasValue === undefined) continue;
      objectPathAliasInputs += 1;
      valuesByInput[displayNameForObjectPathAlias(alias.alias)] = aliasValue;
      stableValues.push(stableMcpValueKey(alias.normalize(aliasValue)));
    }
    if (objectPathAliasInputs === 0) continue;
    if (Object.keys(valuesByInput).length <= 1) continue;
    if (new Set(stableValues).size <= 1) continue;
    const alias = aliases[0]!;
    return {
      argument: target,
      path: target,
      contractArgument: alias.contractArgument,
      aliasConflictKind: objectPathAliasConflictKind(tool, target, aliases, input),
      valuesByInput
    };
  }
  return undefined;
}

function objectPathAliasConflictKind(tool: string, target: string, aliases: McpObjectPathAlias[], input: Record<string, unknown>): McpAliasConflictKind {
  const hasCanonicalInput = input[target] !== undefined || mcpInputAliasesForTarget(tool, target).some((inputName) => input[inputName] !== undefined);
  const presentAliases = aliases.filter((alias) => input[alias.alias] !== undefined);
  const hasNestedAlias = presentAliases.some((alias) => !alias.alias.includes("."));
  const hasLiteralPathAlias = presentAliases.some((alias) => alias.alias.includes("."));
  if (hasCanonicalInput && hasLiteralPathAlias && !hasNestedAlias) return "literal_path_vs_flattened";
  if (hasCanonicalInput && hasNestedAlias && !hasLiteralPathAlias) return "nested_vs_flattened";
  if (!hasCanonicalInput && hasNestedAlias && hasLiteralPathAlias) return "nested_vs_literal_path";
  if (hasCanonicalInput && hasLiteralPathAlias) return "literal_path_vs_flattened";
  if (hasCanonicalInput && hasNestedAlias) return "nested_vs_flattened";
  if (hasNestedAlias && hasLiteralPathAlias) return "nested_vs_literal_path";
  return presentAliases[0]?.conflictKind ?? "multiple_aliases";
}

function displayNameForObjectPathAlias(alias: string): string {
  return alias.includes(".") ? JSON.stringify(alias) : alias;
}

function mcpInputAliasesForTarget(tool: string, target: string): string[] {
  return Object.values(operationArgumentsByTool(tool)).flatMap((argument) => {
    const alias = mcpCamelCaseAliasName(argument);
    return alias && mcpCamelCaseAliasTarget(argument) === target ? [alias] : [];
  });
}

function mcpAliasConflict(input: Record<string, unknown>, argument: OperationArgumentMetadata): McpAliasConflict | undefined {
  const camelAlias = mcpCamelCaseAliasName(argument);
  const camelTarget = mcpCamelCaseAliasTarget(argument);
  const camelValue = camelAlias ? input[camelAlias] : undefined;
  if (!argument.parent_argument || !argument.mcp?.path) {
    if (!camelAlias || !camelTarget || camelValue === undefined) return undefined;
    const targetValue = input[camelTarget];
    if (targetValue === undefined || stableMcpValueKey(targetValue) === stableMcpValueKey(camelValue)) return undefined;
    return {
      argument: camelTarget,
      path: camelTarget,
      contractArgument: camelTarget,
      camelAlias,
      valuesByInput: {
        [camelTarget]: targetValue,
        [camelAlias]: camelValue
      }
    };
  }
  const parentValue = input[argument.mcp.argument];
  const nestedInputValue = input[argument.mcp.path];
  const literalPathInputName = JSON.stringify(argument.mcp.path);
  const flattenedValue = input[argument.name];
  if (parentValue !== undefined && !isMcpObject(parentValue) && (nestedInputValue !== undefined || flattenedValue !== undefined || camelValue !== undefined)) {
    const valuesByInput: Record<string, unknown> = { [argument.mcp.argument]: parentValue };
    if (nestedInputValue !== undefined) valuesByInput[literalPathInputName] = nestedInputValue;
    if (flattenedValue !== undefined) valuesByInput[argument.name] = flattenedValue;
    if (camelAlias && camelValue !== undefined) valuesByInput[camelAlias] = camelValue;
    return {
      argument: argument.mcp.argument,
      path: argument.mcp.path,
      contractArgument: argument.name,
      camelAlias,
      valuesByInput
    };
  }
  const valuesByInput: Record<string, unknown> = {};
  const nestedValue = mcpPathValue(input, argument.mcp.path);
  if (nestedValue !== undefined) valuesByInput[argument.mcp.path] = nestedValue;
  if (nestedInputValue !== undefined) valuesByInput[literalPathInputName] = nestedInputValue;
  if (flattenedValue !== undefined) valuesByInput[argument.name] = flattenedValue;
  if (camelAlias && camelValue !== undefined) valuesByInput[camelAlias] = camelValue;
  if (Object.keys(valuesByInput).length <= 1) return undefined;
  const distinctValues = new Set(Object.values(valuesByInput).map(stableMcpValueKey));
  if (distinctValues.size <= 1) return undefined;
  return {
    argument: argument.mcp.argument,
    path: argument.mcp.path,
    contractArgument: argument.name,
    camelAlias,
    valuesByInput
  };
}

function isMcpObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mcpPathValue(input: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    return isMcpObject(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  }, input);
}

function stableMcpValueKey(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableMcpValueKey));
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, stableMcpValueKey(entryValue)]));
  }
  return JSON.stringify(value);
}

function placeholderForAliasConflict(conflict: McpAliasConflict): string {
  const leaf = conflict.path.split(".").at(-1);
  return leaf ? `<${leaf.replace(/_/g, " ")}>` : "<value>";
}

function closestMcpKnownArgument(tool: string, argument: string): string | undefined {
  const canonicalCandidates = mcpCanonicalArgumentCandidates(tool);
  if (canonicalCandidates.length === 0) return undefined;
  const normalizedArgument = normalizeArgumentNameForSuggestion(argument);
  const directMatch = canonicalCandidates.find((known) => normalizeArgumentNameForSuggestion(known) === normalizedArgument);
  if (directMatch) return directMatch;
  return canonicalCandidates
    .sort((left, right) => {
      const leftScore = argumentSuggestionScore(normalizedArgument, normalizeArgumentNameForSuggestion(left));
      const rightScore = argumentSuggestionScore(normalizedArgument, normalizeArgumentNameForSuggestion(right));
      return rightScore - leftScore || left.localeCompare(right);
    })[0];
}

function mcpCanonicalArgumentCandidates(tool: string): string[] {
  return Object.values(operationArgumentsByTool(tool))
    .map((candidate) => candidate.mcp?.path ?? candidate.mcp?.argument ?? candidate.name)
    .filter((candidate, index, candidates): candidate is string => Boolean(candidate) && candidates.indexOf(candidate) === index);
}

function normalizeArgumentNameForSuggestion(argument: string): string {
  return argument.replace(/[._-]/g, "").toLowerCase();
}

function argumentSuggestionScore(unknownArgument: string, knownArgument: string): number {
  if (unknownArgument === knownArgument) return Number.MAX_SAFE_INTEGER;
  const longest = Math.max(unknownArgument.length, knownArgument.length);
  if (longest === 0) return 0;
  return longestCommonSubsequenceLength(unknownArgument, knownArgument) / longest;
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

function mcpUnknownArgumentSources(tool: string, retryArgument: string): Partial<Record<string, string>> {
  if (retryArgument === "project_id") {
    return {
      project_id: `operations_by_id.${tool}.arguments_by_name.project_id`,
      project_path: `operations_by_id.${tool}.arguments_by_name.project_path`
    };
  }
  return {
    [retryArgument]: `operations_by_id.${tool}.arguments_by_name.${contractArgumentForMcpInput(tool, retryArgument)}`
  };
}

function contractArgumentForMcpInput(tool: string, inputArgument: string): string {
  const explicitAlias = (explicitMcpAliasesByTool[tool] ?? []).find((alias) => alias.alias === inputArgument);
  if (explicitAlias) return explicitAlias.contractArgument;
  return Object.values(operationArgumentsByTool(tool)).find((argument) => {
    return argument.name === inputArgument
      || argument.mcp?.argument === inputArgument
      || argument.mcp?.path === inputArgument
      || mcpCamelCaseAliasName(argument) === inputArgument;
  })?.name ?? inputArgument;
}

function placeholderForKnownArgument(argument: string): string {
  if (argument === "project_id") return "<project id>";
  if (argument === "project_path") return "<project path>";
  if (argument.endsWith("_id")) return `<${argument.replace(/_/g, " ")}>`;
  const leaf = argument.split(".").at(-1) ?? argument;
  return `<${leaf.replace(/_/g, " ")}>`;
}

function conflictKindForAliasConflict(conflict: McpAliasConflict): McpAliasConflictKind {
  if (conflict.aliasConflictKind) return conflict.aliasConflictKind;
  const inputs = new Set(Object.keys(conflict.valuesByInput));
  const hasParentScalar = conflict.argument !== conflict.path && inputs.has(conflict.argument);
  const hasNestedPath = inputs.has(conflict.path);
  const hasLiteralPath = inputs.has(JSON.stringify(conflict.path));
  const hasFlattened = inputs.has(conflict.contractArgument);
  const hasCamelCase = conflict.camelAlias ? inputs.has(conflict.camelAlias) : false;
  if (hasParentScalar) return "parent_scalar_vs_child_alias";
  if (hasCamelCase) return "camelcase_vs_contract_alias";
  if (hasNestedPath && hasLiteralPath) return "nested_vs_literal_path";
  if (hasLiteralPath && hasFlattened) return "literal_path_vs_flattened";
  if (hasNestedPath && hasFlattened) return "nested_vs_flattened";
  return "multiple_aliases";
}

function doNotForAliasConflict(conflict: McpAliasConflict): [McpAliasConflictDoNot, "retry_with_conflicting_alias_values"] {
  const doNotByKind: Record<McpAliasConflictKind, McpAliasConflictDoNot> = {
    nested_vs_flattened: "provide_both_nested_and_flattened_aliases",
    literal_path_vs_flattened: "provide_both_literal_path_and_flattened_aliases",
    nested_vs_literal_path: "provide_both_nested_and_literal_path_aliases",
    parent_scalar_vs_child_alias: "provide_parent_scalar_with_child_aliases",
    camelcase_vs_contract_alias: "provide_both_camelcase_and_contract_aliases",
    singular_vs_plural_alias: "provide_both_singular_and_plural_aliases",
    multiple_aliases: "provide_both_nested_and_flattened_aliases"
  };
  return [doNotByKind[conflictKindForAliasConflict(conflict)], "retry_with_conflicting_alias_values"];
}

function lifecycleAgentInput(agent: unknown): RecordSource | undefined {
  return agent as RecordSource | undefined;
}

export async function runMcpServer(engine: Engine, options: { storePath: string }): Promise<void> {
  const server = new McpServer({
    name: "moryn",
    version: "0.1.0"
  });

  server.registerTool(
    "init",
    {
      title: "Initialize Moryn Store",
      description: "Create or update the local Moryn store configuration and directories.",
      inputSchema: mcpInputSchema({
        repair: coreValidatedBooleanSchema.optional()
      })
    },
    async (input) => toolResultWithNormalizedInput("init", input, async (normalizedInput) => ({
      ok: true,
      ...await initializeStore(options.storePath, { repair: normalizedInput.repair as boolean | undefined })
    }))
  );

  server.registerTool(
    "project_init",
    {
      title: "Initialize Moryn Project Config",
      description: "Create or update a .moryn.json project config.",
      inputSchema: mcpInputSchema({
        path: coreValidatedStringSchema,
        project_id: coreValidatedStringSchema.optional(),
        tags: z.unknown().optional(),
        default_skills: z.unknown().optional(),
        sync_mode: coreValidatedSyncModeSchema.optional(),
        repair: coreValidatedBooleanSchema.optional(),
        ...objectPathAliasInputSchema("project_init"),
        ...camelCaseAliasInputSchema("project_init")
      })
    },
    async (input) => toolResultWithNormalizedInput("project_init", input, async (normalizedInput) => ({
      ok: true,
      ...await initializeProjectConfig(normalizedInput.path, {
        project_id: normalizedInput.project_id,
        tags: normalizedInput.tags,
        default_skills: normalizedInput.default_skills,
        sync: normalizedInput.sync_mode === undefined ? undefined : { mode: normalizedInput.sync_mode as SyncMode },
        repair: normalizedInput.repair as boolean | undefined
      })
    }))
  );

  server.registerTool(
    "project_list",
    {
      title: "List Moryn Projects",
      description: "Discover known project ids and recent project activity from the Moryn store.",
      inputSchema: mcpInputSchema({
        limit: coreValidatedNumberSchema.optional(),
        current_task: z.unknown().optional(),
        sync_remote: z.unknown().optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("project_list"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("project_list")
      })
    },
    async (input) => toolResultWithNormalizedInput("project_list", input, async (normalizedInput) => {
      const projectListAgent = lifecycleAgentInput(normalizedInput.agent);
      return engine.listProjects({
        limit: normalizedInput.limit,
        current_task: normalizedInput.current_task,
        sync_remote: normalizedInput.sync_remote,
        agent: projectListAgent
      });
    })
  );

  server.registerTool(
    "selection_source_contracts",
    {
      title: "Get Moryn Selection Source Contracts",
      description: "Return stable response field-path contracts for CLI, MCP, and library hosts.",
      inputSchema: mcpInputSchema({})
    },
    async (input) => toolResultWithNormalizedInput("selection_source_contracts", input, async () => getSelectionSourceContracts())
  );

  server.registerTool(
    "operation_contracts",
    {
      title: "Get Moryn Operation Contracts",
      description: "Return stable CLI/MCP operation contracts, safety metadata, and required fields.",
      inputSchema: mcpInputSchema({
        index: coreValidatedBooleanSchema.optional(),
        operation: coreValidatedStringSchema.optional(),
        mcp_tool: coreValidatedStringSchema.optional(),
        cli_command: coreValidatedStringSchema.optional(),
        ...camelCaseAliasInputSchema("operation_contracts")
      })
    },
    async (input) => {
      try {
        const normalizedInput = normalizeMcpToolArguments("operation_contracts", input);
        const { index, operation, mcp_tool, cli_command } = normalizedInput;
        validateOperationContractIndexArgument(index);
        validateOperationContractLookupArgument("operation", operation);
        validateOperationContractLookupArgument("mcp_tool", mcp_tool);
        validateOperationContractLookupArgument("cli_command", cli_command);
        const lookupOptions: OperationContractLookupOption[] = [
          ...(index ? [{ mode: "index" as const, option: "index" }] : []),
          ...(operation !== undefined ? [{ mode: "operation" as const, option: "operation" }] : []),
          ...(mcp_tool !== undefined ? [{ mode: "mcp_tool" as const, option: "mcp_tool" }] : []),
          ...(cli_command !== undefined ? [{ mode: "cli_command" as const, option: "cli_command" }] : [])
        ];
        if (lookupOptions.length > 1) {
          return {
            ...jsonResult(toErrorEnvelope(new OperationContractLookupConflictError(lookupOptions, "index, operation, mcp_tool, or cli_command"))),
            isError: true
          };
        }
        if (index) {
          return jsonResult(getOperationContractIndex(), { pretty: false });
        }
        if (operation !== undefined) {
          const lookup = operation;
          const contract = getOperationContract(lookup);
          if (!contract) {
            return {
              ...jsonResult(toErrorEnvelope(new OperationContractLookupError("operation", lookup))),
              isError: true
            };
          }
          return jsonResult(contract, { pretty: false });
        }
        if (mcp_tool !== undefined) {
          const lookup = mcp_tool;
          const contract = getOperationContractByMcpTool(lookup);
          if (!contract) {
            return {
              ...jsonResult(toErrorEnvelope(new OperationContractLookupError("mcp_tool", lookup))),
              isError: true
            };
          }
          return jsonResult(contract, { pretty: false });
        }
        if (cli_command !== undefined) {
          const lookup = cli_command;
          const contract = getOperationContractByCliCommand(lookup);
          if (!contract) {
            return {
              ...jsonResult(toErrorEnvelope(new OperationContractLookupError("cli_command", lookup))),
              isError: true
            };
          }
          return jsonResult(contract, { pretty: false });
        }
        return jsonResult(getOperationContracts(), { pretty: false });
      } catch (error) {
        return {
          ...jsonResult(toErrorEnvelope(error)),
          isError: true
        };
      }
    }
  );

  server.registerTool(
    "boot",
    {
      title: "Boot Moryn Context",
      description: "Return a bounded context package for an agent starting work.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        default_skills: z.unknown().optional(),
        ...objectPathAliasInputSchema("boot"),
        ...camelCaseAliasInputSchema("boot")
      })
    },
    async (input) => toolResultWithNormalizedInput("boot", input, async (normalizedInput) => {
      const project = await resolveProjectInput("boot", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path });
      return engine.boot({
        project_id: project.project_id,
        default_skills: normalizedInput.default_skills ?? project.default_skills,
        current_task: normalizedInput.current_task as string | undefined,
        sync_remote: normalizedInput.sync_remote
      });
    })
  );

  server.registerTool(
    "recall",
    {
      title: "Recall Moryn Records",
      description: "Search memory, skills, soul, session summaries, and agent notes.",
      inputSchema: mcpInputSchema({
        record_ids: z.unknown().optional(),
        query: coreValidatedStringSchema.optional(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        kinds: z.unknown().optional(),
        scopes: z.unknown().optional(),
        types: z.unknown().optional(),
        states: z.unknown().optional(),
        tags: z.unknown().optional(),
        files: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        ...camelCaseAliasInputSchema("recall"),
        ...explicitAliasInputSchema("recall")
      })
    },
    async (input) => toolResultWithNormalizedInput("recall", input, async (normalizedInput) => {
      const project = await resolveProjectInput("recall", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path });
      return engine.recall({
        record_ids: normalizedInput.record_ids,
        query: normalizedInput.query,
        project_id: project.project_id,
        kinds: normalizedInput.kinds as RecordKind[] | undefined,
        scopes: normalizedInput.scopes as RecordScope[] | undefined,
        types: normalizedInput.types,
        states: normalizedInput.states as RecordState[] | undefined,
        tags: normalizedInput.tags,
        files: normalizedInput.files,
        limit: normalizedInput.limit
      });
    }, (normalizedInput) => ({
      tool: "recall",
      command: commandForRecallContext({
        record_ids: normalizedInput.record_ids,
        query: normalizedInput.query,
        project_id: normalizedInput.project_id,
        project_path: normalizedInput.project_path,
        kinds: normalizedInput.kinds,
        scopes: normalizedInput.scopes,
        types: normalizedInput.types,
        states: normalizedInput.states,
        tags: normalizedInput.tags,
        files: normalizedInput.files,
        limit: normalizedInput.limit
      }),
      arguments: {
        ...(normalizedInput.record_ids !== undefined ? { record_ids: normalizedInput.record_ids } : {}),
        ...(normalizedInput.query !== undefined ? { query: normalizedInput.query } : {}),
        ...(normalizedInput.project_id !== undefined ? { project_id: normalizedInput.project_id } : {}),
        ...(normalizedInput.project_path !== undefined ? { project_path: normalizedInput.project_path } : {}),
        ...(normalizedInput.kinds !== undefined ? { kinds: normalizedInput.kinds } : {}),
        ...(normalizedInput.scopes !== undefined ? { scopes: normalizedInput.scopes } : {}),
        ...(normalizedInput.types !== undefined ? { types: normalizedInput.types } : {}),
        ...(normalizedInput.states !== undefined ? { states: normalizedInput.states } : {}),
        ...(normalizedInput.tags !== undefined ? { tags: normalizedInput.tags } : {}),
        ...(normalizedInput.files !== undefined ? { files: normalizedInput.files } : {}),
        ...(normalizedInput.limit !== undefined ? { limit: normalizedInput.limit } : {})
      }
    }))
  );

  server.registerTool(
    "write",
    {
      title: "Write Moryn Record",
      description: "Append a new Moryn record event.",
      inputSchema: mcpInputSchema({
        kind: coreValidatedRecordKindSchema,
        type: coreValidatedStringSchema.optional(),
        scope: coreValidatedRecordScopeSchema.optional(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        tags: z.unknown().optional(),
        text: coreValidatedStringSchema.optional(),
        content: z.unknown().optional(),
        state: coreValidatedRecordStateSchema.optional(),
        confidence: coreValidatedNumberSchema.optional(),
        priority: coreValidatedRecordPrioritySchema.optional(),
        provenance: z.unknown().optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        source: z.unknown().optional(),
        ...writeAliasInputSchema,
        ...camelCaseAliasInputSchema("write")
      })
    },
    async (input) => toolResult(async () => {
      const normalizedInput = normalizeMcpToolArguments("write", input);
      if (normalizedInput.content && normalizedInput.text !== undefined) {
        throw writeContentChoiceError([
          { argument: "text", value: normalizedInput.text },
          { argument: "content", value: normalizedInput.content as Record<string, unknown> }
        ]);
      }
      if (!normalizedInput.content && normalizedInput.text === undefined) {
        throw writeContentChoiceError();
      }
      const content = normalizedInput.content ?? { text: normalizedInput.text ?? "", format: "text" as const };
      const project = await resolveProjectInput("write", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path });
      const type = normalizedInput.type ?? (normalizedInput.kind === "session_summary" ? "summary" : undefined);
      const scope = normalizedInput.scope ?? (normalizedInput.kind === "session_summary" ? "project" : undefined);
      if (type === undefined) {
        throw writeRequiredArgumentError("type");
      }
      if (scope === undefined) {
        throw writeRequiredArgumentError("scope");
      }
      const tags = normalizedInput.tags === undefined || Array.isArray(normalizedInput.tags)
        ? [...project.tags, ...(normalizedInput.tags ?? [])]
        : normalizedInput.tags;
      return engine.write({
        kind: normalizedInput.kind as RecordKind,
        type,
        scope: scope as RecordScope,
        project_id: project.project_id,
        tags,
        content,
        state: normalizedInput.state as RecordState | undefined,
        confidence: normalizedInput.confidence,
        priority: normalizedInput.priority as RecordPriority | undefined,
        source: withDefaultSource(normalizedInput.source) as RecordSource,
        confirmed: normalizedInput.confirmed as boolean | undefined,
        provenance: normalizedInput.provenance as RecordProvenance | undefined
      });
    })
  );

  server.registerTool(
    "revise",
    {
      title: "Revise Moryn Record",
      description: "Append a logical revision event for an existing record.",
      inputSchema: mcpInputSchema({
        record_id: z.unknown().optional(),
        patch: z.unknown(),
        reason: coreValidatedStringSchema.optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("revise")
      })
    },
    async (input) => toolResultWithNormalizedInput("revise", input, async (normalizedInput) => engine.revise({
        record_id: normalizedInput.record_id,
        patch: normalizedInput.patch,
        reason: normalizedInput.reason,
        confirmed: normalizedInput.confirmed as boolean | undefined,
        source: withDefaultSource(normalizedInput.source) as RecordSource
      }), (normalizedInput) => ({
        tool: "revise",
        command: commandForReviseContext({ record_id: normalizedInput.record_id, patch: normalizedInput.patch, reason: normalizedInput.reason }),
        arguments: {
          record_id: normalizedInput.record_id,
          patch: normalizedInput.patch,
          ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
          ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
        }
      }))
  );

  server.registerTool(
    "promote",
    {
      title: "Promote Moryn Record",
      description: "Change a record state by appending a promotion/state event.",
      inputSchema: mcpInputSchema({
        record_id: z.unknown().optional(),
        target_state: coreValidatedRecordStateSchema.optional(),
        reason: coreValidatedStringSchema.optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("promote")
      })
    },
    async (input) => toolResultWithNormalizedInput("promote", input, async (normalizedInput) => engine.promote({
        record_id: normalizedInput.record_id,
        target_state: normalizedInput.target_state,
        reason: normalizedInput.reason,
        source: withDefaultSource(normalizedInput.source) as RecordSource,
        confirmed: normalizedInput.confirmed as boolean | undefined
      }), (normalizedInput) => ({
        tool: "promote",
        command: commandForPromoteContext({
          record_id: normalizedInput.record_id,
          target_state: normalizedInput.target_state,
          reason: normalizedInput.reason
        }),
        arguments: {
          record_id: normalizedInput.record_id,
          target_state: normalizedInput.target_state,
          ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
          ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
        }
      }))
  );

  server.registerTool(
    "archive",
    {
      title: "Archive Moryn Record",
      description: "Hide a record from default boot and recall while preserving history.",
      inputSchema: mcpInputSchema({
        record_id: z.unknown().optional(),
        reason: coreValidatedStringSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("archive")
      })
    },
    async (input) => toolResultWithNormalizedInput("archive", input, async (normalizedInput) => engine.archive({
        record_id: normalizedInput.record_id,
        reason: normalizedInput.reason,
        source: withDefaultSource(normalizedInput.source) as RecordSource
      }), (normalizedInput) => ({
        tool: "archive",
        command: commandForArchiveContext({ record_id: normalizedInput.record_id, reason: normalizedInput.reason }),
        arguments: {
          record_id: normalizedInput.record_id,
          ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
          ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
        }
      }))
  );

  server.registerTool(
    "quarantine",
    {
      title: "Quarantine Moryn Record",
      description: "Mark a record as sensitive or unsafe so it is excluded by default.",
      inputSchema: mcpInputSchema({
        record_id: z.unknown().optional(),
        reason: coreValidatedStringSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("quarantine")
      })
    },
    async (input) => toolResultWithNormalizedInput("quarantine", input, async (normalizedInput) => engine.quarantine({
        record_id: normalizedInput.record_id,
        reason: normalizedInput.reason,
        source: withDefaultSource(normalizedInput.source) as RecordSource
      }), (normalizedInput) => ({
        tool: "quarantine",
        command: commandForQuarantineContext({ record_id: normalizedInput.record_id, reason: normalizedInput.reason }),
        arguments: {
          record_id: normalizedInput.record_id,
          ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
          ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
        }
      }))
  );

  server.registerTool(
    "link",
    {
      title: "Link Moryn Records",
      description: "Append a relationship from one record to another.",
      inputSchema: mcpInputSchema({
        record_id: z.unknown().optional(),
        linked_record_id: z.unknown().optional(),
        link_type: coreValidatedStringSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("link")
      })
    },
    async (input) => toolResultWithNormalizedInput("link", input, async (normalizedInput) => engine.link({
        record_id: normalizedInput.record_id,
        linked_record_id: normalizedInput.linked_record_id,
        link_type: normalizedInput.link_type,
        source: withDefaultSource(normalizedInput.source) as RecordSource
      }), (normalizedInput) => ({
        tool: "link",
        command: commandForLinkContext({
          record_id: normalizedInput.record_id,
          linked_record_id: normalizedInput.linked_record_id,
          link_type: normalizedInput.link_type
        }),
        arguments: {
          record_id: normalizedInput.record_id,
          linked_record_id: normalizedInput.linked_record_id,
          link_type: normalizedInput.link_type,
          ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
        }
      }))
  );

  server.registerTool(
    "refresh",
    {
      title: "Refresh Moryn Changes",
      description: "Return important changes since a cursor for periodic agent memory refresh.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        cursor: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        ...camelCaseAliasInputSchema("refresh")
      })
    },
    async (input) => toolResultWithNormalizedInput("refresh", input, async (normalizedInput) => {
      const project = await resolveProjectInput("refresh", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path });
      return engine.refresh({
        project_id: project.project_id,
        cursor: normalizedInput.cursor,
        current_task: normalizedInput.current_task as string | undefined,
        limit: normalizedInput.limit
      });
    })
  );

  server.registerTool(
    "agent_doctor",
    {
      title: "Diagnose Moryn Agent Setup",
      description: "Read-only setup check that tells an agent whether store, project, and sync are ready and what to call next.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_doctor"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_doctor")
      })
    },
    async (input) => toolResultWithNormalizedInput("agent_doctor", input, async (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      return agentDoctor({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_doctor", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        agent: lifecycleAgent
      });
    })
  );

  server.registerTool(
    "agent_enter",
    {
      title: "Enter Moryn Agent Session",
      description: "One-call agent entrypoint: diagnose setup, discover projects when needed, or start a known project session.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        refresh_since: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_enter"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_enter")
      })
    },
    async (input) => toolResultWithNormalizedInput("agent_enter", input, async (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPull = normalizedInput.pull as boolean | undefined;
      return agentEnter({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_enter", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        refreshSince: normalizedInput.refresh_since,
        limit: normalizedInput.limit,
        pull: coreValidatedPull,
        agent: lifecycleAgent
      });
    }, (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPull = normalizedInput.pull as boolean | undefined;
      const contextArguments = compactUndefined({
        project_id: normalizedInput.project_id,
        project_path: normalizedInput.project_path,
        sync_remote: normalizedInput.sync_remote,
        current_task: normalizedInput.current_task,
        refresh_since: normalizedInput.refresh_since,
        limit: normalizedInput.limit,
        pull: coreValidatedPull,
        agent: lifecycleAgent
      });
      return {
        tool: "agent_enter",
        command: commandForAgentEnterContext(contextArguments),
        arguments: contextArguments
      };
    })
  );

  server.registerTool(
    "agent_guide",
    {
      title: "Guide Moryn Agent Workflow",
      description: "Return machine-readable lifecycle guidance and exact next tool arguments for agents.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_guide"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_guide")
      })
    },
    async (input) => toolResultWithNormalizedInput("agent_guide", input, async (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      return agentGuide({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_guide", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        agent: lifecycleAgent
      });
    })
  );

  server.registerTool(
    "agent_start",
    {
      title: "Start Moryn Agent Session",
      description: "Low-friction agent startup: pull sync, resolve project context, boot context, and refresh recent changes.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        refresh_since: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_start"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_start")
      })
    },
    async (input) => toolResultWithNormalizedInput("agent_start", input, async (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPull = normalizedInput.pull as boolean | undefined;
      return agentStart({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_start", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        refreshSince: normalizedInput.refresh_since,
        limit: normalizedInput.limit,
        pull: coreValidatedPull,
        agent: lifecycleAgent
      });
    }, (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPull = normalizedInput.pull as boolean | undefined;
      const contextArguments = compactUndefined({
        project_id: normalizedInput.project_id,
        project_path: normalizedInput.project_path,
        sync_remote: normalizedInput.sync_remote,
        current_task: normalizedInput.current_task,
        refresh_since: normalizedInput.refresh_since,
        limit: normalizedInput.limit,
        pull: coreValidatedPull,
        agent: lifecycleAgent
      });
      return {
        tool: "agent_start",
        command: commandForAgentStartContext(contextArguments),
        arguments: contextArguments
      };
    })
  );

  server.registerTool(
    "agent_finish",
    {
      title: "Finish Moryn Agent Session",
      description: "Low-friction agent handoff: write a session summary and push sync.",
      inputSchema: mcpInputSchema({
        summary: z.unknown(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        push: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_finish"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_finish")
      })
    },
    async (input) => toolResultWithNormalizedInput("agent_finish", input, async (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPush = normalizedInput.push as boolean | undefined;
      return agentFinish({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_finish", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        summary: normalizedInput.summary,
        push: coreValidatedPush,
        agent: lifecycleAgent
      });
    }, (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPush = normalizedInput.push as boolean | undefined;
      const contextInput = {
        summary: normalizedInput.summary,
        project_id: normalizedInput.project_id,
        project_path: normalizedInput.project_path,
        sync_remote: normalizedInput.sync_remote,
        current_task: normalizedInput.current_task,
        push: coreValidatedPush,
        agent: lifecycleAgent
      };
      const contextArguments = compactUndefined(contextInput);
      return {
        tool: "agent_finish",
        command: commandForAgentFinishContext(contextInput),
        arguments: contextArguments
      };
    })
  );

  server.registerTool(
    "agent_status",
    {
      title: "Publish Moryn Agent Status",
      description: "Low-friction in-progress update: write a project status checkpoint and push sync.",
      inputSchema: mcpInputSchema({
        status: z.unknown(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        push: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_status"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_status")
      })
    },
    async (input) => toolResultWithNormalizedInput("agent_status", input, async (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPush = normalizedInput.push as boolean | undefined;
      return agentStatus({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_status", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        status: normalizedInput.status,
        push: coreValidatedPush,
        agent: lifecycleAgent
      });
    }, (normalizedInput) => {
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      const coreValidatedPush = normalizedInput.push as boolean | undefined;
      const contextInput = {
        status: normalizedInput.status,
        project_id: normalizedInput.project_id,
        project_path: normalizedInput.project_path,
        sync_remote: normalizedInput.sync_remote,
        current_task: normalizedInput.current_task,
        push: coreValidatedPush,
        agent: lifecycleAgent
      };
      const contextArguments = compactUndefined(contextInput);
      return {
        tool: "agent_status",
        command: commandForAgentStatusContext(contextInput),
        arguments: contextArguments
      };
    })
  );

  server.registerTool(
    "rebuild",
    {
      title: "Rebuild Moryn Derived Views",
      description: "Regenerate snapshots and indexes from append-only events.",
      inputSchema: mcpInputSchema({})
    },
    async (input) => toolResultWithNormalizedInput("rebuild", input, async () => rebuildDerivedViews(options.storePath))
  );

  server.registerTool(
    "sync_init",
    {
      title: "Initialize Moryn Git Sync",
      description: "Initialize or connect the local Moryn store to a Git remote.",
      inputSchema: mcpInputSchema({
        remote: coreValidatedStringSchema
      })
    },
    async (input) => toolResultWithNormalizedInput("sync_init", input, async (normalizedInput) => initializeGitSync(options.storePath, normalizedInput.remote as string))
  );

  server.registerTool(
    "sync_status",
    {
      title: "Get Moryn Git Sync Status",
      description: "Return Git sync configuration and local/remote status.",
      inputSchema: mcpInputSchema({})
    },
    async (input) => toolResultWithNormalizedInput("sync_status", input, async () => getGitSyncStatus(options.storePath))
  );

  server.registerTool(
    "sync_pull",
    {
      title: "Pull Moryn Git Sync",
      description: "Pull remote event history into the local Moryn store.",
      inputSchema: mcpInputSchema({})
    },
    async (input) => toolResultWithNormalizedInput("sync_pull", input, async () => pullGitSync(options.storePath))
  );

  server.registerTool(
    "sync_push",
    {
      title: "Push Moryn Git Sync",
      description: "Commit and push local event history from the Moryn store.",
      inputSchema: mcpInputSchema({
        message: coreValidatedStringSchema.optional()
      })
    },
    async (input) => toolResultWithNormalizedInput("sync_push", input, async (normalizedInput) => pushGitSync(options.storePath, { message: normalizedInput.message as string | undefined }))
  );

  server.registerTool(
    "list_recent",
    {
      title: "List Recent Moryn Records",
      description: "Return recently updated records.",
      inputSchema: mcpInputSchema({
        limit: coreValidatedNumberSchema.optional()
      })
    },
    async (input) => toolResultWithNormalizedInput("list_recent", input, async (normalizedInput) => engine.listRecent(normalizedInput.limit))
  );

  await server.connect(new StdioServerTransport());
}
