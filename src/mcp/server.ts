import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mcpArgumentsForAction } from "../core/action-interfaces.js";
import { agentDoctor, agentEnter, agentFinish, agentGuide, agentStart, agentStatus } from "../core/agent-lifecycle.js";
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
  commandForQuarantineContext,
  commandForRecallContext,
  commandForReviseContext,
  commandForSetupContext,
  commandForTimelineContext,
  type MorynErrorContext,
  toErrorEnvelope
} from "../core/errors.js";
import type { HostRuntimeDescriptor } from "../core/host-integration-artifacts.js";
import { queueLearning } from "../core/learning-inbox.js";
import { LOGICAL_RELATIONSHIP_TYPES } from "../core/logical-memory.js";
import { initializeProjectConfig, resolveProjectContext, type SyncMode } from "../core/project.js";
import type {
  RecordKind,
  RecordPriority,
  RecordProvenance,
  RecordScope,
  RecordSource,
  RecordState
} from "../core/types.js";
import {
  activateClaudeSettings,
  activateCodexHooks,
  buildHostIntegrationArtifact,
  captureSession,
  contextPack,
  getOperationContract,
  getOperationContractByCliCommand,
  getOperationContractByMcpTool,
  getOperationContractIndex,
  getOperationContracts,
  getSelectionSourceContracts,
  inspectHostActivation,
  planInstall,
  setupWizard,
  version,
  writeHostIntegrationArtifact
} from "../index.js";
import { openDashboard, writeDashboardSnapshot } from "../observability/dashboard.js";
import {
  type OperationArgumentMetadata,
  OperationContractLookupConflictError,
  OperationContractLookupError,
  type OperationContractLookupOption,
  operationArgumentsByTool,
  validateOperationContractIndexArgument,
  validateOperationContractLookupArgument
} from "../operation-contracts.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../sync/git.js";

type Engine = ReturnType<typeof createEngine>;
type McpInputShape = Record<string, z.ZodType>;
type McpDashboardMetadata =
  | Awaited<ReturnType<typeof writeDashboardSnapshot>>
  | {
      generated: false;
      opened: false;
      error: string;
    };
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
type McpUnknownArgumentDoNot = "send_unknown_mcp_arguments" | "retry_with_same_unknown_argument";
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
const soulSubjectAliasInputSchema = {
  subject_kind: z.unknown().optional(),
  "subject.kind": z.unknown().optional(),
  subject_id: z.unknown().optional(),
  "subject.subject_id": z.unknown().optional(),
  display_name: z.unknown().optional(),
  "subject.display_name": z.unknown().optional()
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
      normalize: syncRemoteValue
    }
  ];
}

const explicitMcpAliasesByTool: Record<string, McpExplicitAlias[]> = {
  boot: [
    {
      alias: "session_id",
      target: "agent_session_id",
      contractArgument: "agent_session_id",
      conflictKind: "multiple_aliases",
      normalize: (value) => value
    }
  ],
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
  capture_session: syncRemoteObjectPathAliases(),
  context_pack: syncRemoteObjectPathAliases(),
  install: syncRemoteObjectPathAliases(),
  setup: syncRemoteObjectPathAliases(),
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
  return syncRemoteValue(isMcpObject(value) ? value.remote : value);
}

function syncRemoteValue(value: unknown): unknown {
  return value === false ? undefined : value;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, character: string) => character.toUpperCase());
}

function mcpCamelCaseAliasName(argument: OperationArgumentMetadata): string | undefined {
  if (!argument.mcp) return undefined;
  const alias = snakeToCamel(argument.name);
  return alias === argument.name ? undefined : alias;
}

function mcpCamelCaseAliasTarget(argument: OperationArgumentMetadata): string | undefined {
  if (!argument.mcp) return undefined;
  return argument.mcp.path ? argument.name : argument.mcp.argument;
}

function camelCaseAliasInputSchema(tool: string): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries(
    Object.values(operationArgumentsByTool(tool)).flatMap((argument) => {
      const alias = mcpCamelCaseAliasName(argument);
      return alias ? [[alias, z.unknown().optional()] as const] : [];
    })
  );
}

function explicitAliasInputSchema(tool: string): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries(
    (explicitMcpAliasesByTool[tool] ?? []).map((alias) => [alias.alias, z.unknown().optional()])
  );
}

function objectPathAliasInputSchema(tool: string): Record<string, z.ZodOptional<z.ZodUnknown>> {
  return Object.fromEntries(
    (objectPathMcpAliasesByTool[tool] ?? []).map((alias) => [alias.alias, z.unknown().optional()])
  );
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
      rejected_arguments: Array<{ argument: "text"; value: unknown } | { argument: "content"; value: unknown }>;
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

  return new McpArgumentError(`Invalid argument: write requires ${argument}`, `retry write with required ${argument}`, {
    operation_contract: "operations_by_id.write",
    missing_argument: { argument },
    expected: { kind: "required_argument", required: true },
    argument_sources: argumentSources,
    retry_with: { argument, value_placeholder: `<record ${argument}>` }
  });
}

function writeContentChoiceError(
  rejectedArguments?: Array<{ argument: "text"; value: unknown } | { argument: "content"; value: unknown }>
): McpArgumentError {
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
  | "install"
  | "setup"
  | "boot"
  | "recall"
  | "timeline"
  | "write"
  | "learn"
  | "dashboard"
  | "refresh"
  | "memory_doctor"
  | "memory_maintenance_shadow"
  | "memory_lifecycle"
  | "capture_policy"
  | "dogfood_report"
  | "health_check"
  | "recall_eval"
  | "capture_session"
  | "context_pack"
  | "agent_doctor"
  | "agent_guide"
  | "agent_enter"
  | "agent_start"
  | "agent_status"
  | "agent_finish"
  | "checkpoint"
  | "consolidate_semantic";

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

function lifecycleSoulBindingInput(input: Record<string, unknown>): {
  userSoulProfileId?: string;
  agentSoulProfileId?: string;
  soulCharBudget?: number;
  soulTokenBudget?: number;
} {
  for (const argument of ["user_profile_id", "agent_profile_id"] as const) {
    const value = input[argument];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new Error(`Invalid argument: Invalid ${argument}`);
    }
  }
  for (const argument of ["soul_char_budget", "soul_token_budget"] as const) {
    const value = input[argument];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      throw new Error(`Invalid argument: ${argument} must be a positive integer`);
    }
  }
  return {
    userSoulProfileId: input.user_profile_id as string | undefined,
    agentSoulProfileId: input.agent_profile_id as string | undefined,
    soulCharBudget: input.soul_char_budget as number | undefined,
    soulTokenBudget: input.soul_token_budget as number | undefined
  };
}

async function resolveProjectInput(
  operation: McpProjectContextOperation,
  input: { project_id?: unknown; project_path?: unknown }
): Promise<{ project_id?: string; project_path?: string; tags: string[]; default_skills: string[] }> {
  const projectInput = validateProjectContextInput(operation, input);
  if (projectInput.project_id === undefined && projectInput.project_path === undefined) {
    return { tags: [], default_skills: [] };
  }
  const project = await resolveProjectContext({
    projectPath: projectInput.project_path,
    projectId: projectInput.project_id
  });
  return {
    project_id: project.project_id,
    project_path: project.project_path,
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

function validateMcpDashboardOpen(value: unknown): asserts value is boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("Invalid argument: Invalid dashboard open; must be boolean");
  }
}

async function mcpDashboardMetadata(storePath: string, open: boolean): Promise<McpDashboardMetadata> {
  try {
    const snapshot = await writeDashboardSnapshot(storePath);
    if (!open) return snapshot;
    await openDashboard(snapshot.url);
    return { ...snapshot, opened: true };
  } catch (error) {
    return {
      generated: false,
      opened: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function withOptionalMcpDashboard<T extends object>(
  storePath: string,
  result: T,
  open: unknown
): Promise<T & { dashboard?: McpDashboardMetadata }> {
  validateMcpDashboardOpen(open);
  if (open === undefined) return result;
  return {
    ...result,
    dashboard: await mcpDashboardMetadata(storePath, open)
  };
}

function withMcpRuntime<T extends object>(result: T, runtime: HostRuntimeDescriptor | undefined) {
  if (!runtime) return result;
  const packageVersion = runtime.package_version ?? version;
  const identity = createHash("sha256")
    .update(
      JSON.stringify({ package_version: packageVersion, exec_file: runtime.exec_file, cli_entry: runtime.cli_entry })
    )
    .digest("hex");
  return {
    ...result,
    runtime: {
      transport: "mcp_stdio",
      package_version: packageVersion,
      exec_file: runtime.exec_file,
      cli_entry: runtime.cli_entry,
      identity: `moryn-runtime-sha256:${identity}`,
      restart_hint: "Restart the host MCP connection after changing the Moryn installation or build."
    }
  };
}

function compactUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeMcpToolArguments(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const ergonomicInput = normalizeAgentClientShorthand(input);
  assertKnownMcpArguments(tool, ergonomicInput);
  assertNoMcpAliasConflicts(tool, ergonomicInput);
  return mcpArgumentsForAction(
    tool,
    normalizeObjectPathMcpAliases(
      tool,
      normalizeExplicitMcpAliases(tool, normalizeMcpCamelCaseAliases(tool, ergonomicInput))
    )
  );
}

function normalizeAgentClientShorthand(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.agent !== "string") return input;
  return {
    ...input,
    agent: { client: input.agent }
  };
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
      const normalizedAliasValue = alias.normalize(aliasValue);
      if (normalizedAliasValue === undefined) continue;
      objectPathAliasInputs += 1;
      valuesByInput[displayNameForObjectPathAlias(alias.alias)] = aliasValue;
      stableValues.push(stableMcpValueKey(normalizedAliasValue));
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

function objectPathAliasConflictKind(
  tool: string,
  target: string,
  aliases: McpObjectPathAlias[],
  input: Record<string, unknown>
): McpAliasConflictKind {
  const hasCanonicalInput =
    input[target] !== undefined ||
    mcpInputAliasesForTarget(tool, target).some((inputName) => input[inputName] !== undefined);
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

function mcpAliasConflict(
  input: Record<string, unknown>,
  argument: OperationArgumentMetadata
): McpAliasConflict | undefined {
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
  if (
    parentValue !== undefined &&
    !isMcpObject(parentValue) &&
    (nestedInputValue !== undefined || flattenedValue !== undefined || camelValue !== undefined)
  ) {
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
    return isMcpObject(value) ? (value as Record<string, unknown>)[key] : undefined;
  }, input);
}

function stableMcpValueKey(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableMcpValueKey));
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableMcpValueKey(entryValue)])
    );
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
  const directMatch = canonicalCandidates.find(
    (known) => normalizeArgumentNameForSuggestion(known) === normalizedArgument
  );
  if (directMatch) return directMatch;
  return canonicalCandidates.sort((left, right) => {
    const leftScore = argumentSuggestionScore(normalizedArgument, normalizeArgumentNameForSuggestion(left));
    const rightScore = argumentSuggestionScore(normalizedArgument, normalizeArgumentNameForSuggestion(right));
    return rightScore - leftScore || left.localeCompare(right);
  })[0];
}

function mcpCanonicalArgumentCandidates(tool: string): string[] {
  return Object.values(operationArgumentsByTool(tool))
    .map((candidate) => candidate.mcp?.path ?? candidate.mcp?.argument ?? candidate.name)
    .filter(
      (candidate, index, candidates): candidate is string =>
        Boolean(candidate) && candidates.indexOf(candidate) === index
    );
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
      current[index + 1] =
        leftCharacter === right[index] ? previous[index] + 1 : Math.max(previous[index + 1] ?? 0, current[index] ?? 0);
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
  return (
    Object.values(operationArgumentsByTool(tool)).find((argument) => {
      return (
        argument.name === inputArgument ||
        argument.mcp?.argument === inputArgument ||
        argument.mcp?.path === inputArgument ||
        mcpCamelCaseAliasName(argument) === inputArgument
      );
    })?.name ?? inputArgument
  );
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

function doNotForAliasConflict(
  conflict: McpAliasConflict
): [McpAliasConflictDoNot, "retry_with_conflicting_alias_values"] {
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

function checkpointSource(value: unknown): RecordSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid argument: source must be an object");
  }
  const input = value as Record<string, unknown>;
  const known = new Set(["client", "session_id", "sessionId", "model", "device_id", "deviceId"]);
  const unknown = Object.keys(input).find((key) => !known.has(key));
  if (unknown) throw new Error(`Invalid argument: Unknown source argument: ${unknown}`);
  if (input.session_id !== undefined && input.sessionId !== undefined && input.session_id !== input.sessionId) {
    throw new Error("Invalid argument: Conflicting source.session_id aliases");
  }
  if (input.device_id !== undefined && input.deviceId !== undefined && input.device_id !== input.deviceId) {
    throw new Error("Invalid argument: Conflicting source.device_id aliases");
  }
  const required = (name: string, nested: unknown): string => {
    if (typeof nested !== "string" || !nested.trim())
      throw new Error(`Invalid argument: source.${name} must be a non-empty string`);
    return nested.trim();
  };
  const optional = (name: string, nested: unknown): string | undefined => {
    if (nested === undefined) return undefined;
    return required(name, nested);
  };
  return {
    client: required("client", input.client),
    session_id: required("session_id", input.session_id ?? input.sessionId),
    device_id: required("device_id", input.device_id ?? input.deviceId),
    model: optional("model", input.model)
  };
}

export async function runMcpServer(
  engine: Engine,
  options: { storePath: string; hostRuntime?: HostRuntimeDescriptor }
): Promise<void> {
  const server = new McpServer({
    name: "moryn",
    version
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
    async (input) =>
      toolResultWithNormalizedInput("init", input, async (normalizedInput) => ({
        ok: true,
        ...(await initializeStore(options.storePath, { repair: normalizedInput.repair as boolean | undefined }))
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
    async (input) =>
      toolResultWithNormalizedInput("project_init", input, async (normalizedInput) => ({
        ok: true,
        ...(await initializeProjectConfig(normalizedInput.path, {
          project_id: normalizedInput.project_id,
          tags: normalizedInput.tags,
          default_skills: normalizedInput.default_skills,
          sync: normalizedInput.sync_mode === undefined ? undefined : { mode: normalizedInput.sync_mode as SyncMode },
          repair: normalizedInput.repair as boolean | undefined
        }))
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
        learnings: z.array(z.unknown()).optional(),
        ...objectPathAliasInputSchema("project_list"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("project_list")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("project_list", input, async (normalizedInput) => {
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
    "project_migrate",
    {
      title: "Migrate Moryn Project Identity",
      description: "Move records from one project id to another by appending auditable revision events.",
      inputSchema: mcpInputSchema({
        from_project_id: coreValidatedStringSchema.optional(),
        to_project_id: coreValidatedStringSchema.optional(),
        dry_run: coreValidatedBooleanSchema.optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("project_migrate")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("project_migrate", input, async (normalizedInput) =>
        engine.migrateProject({
          from_project_id: normalizedInput.from_project_id,
          to_project_id: normalizedInput.to_project_id,
          dry_run: normalizedInput.dry_run,
          confirmed: normalizedInput.confirmed,
          include_private: normalizedInput.include_private,
          source: { client: "mcp" }
        })
      )
  );

  server.registerTool(
    "install",
    {
      title: "Plan Moryn Host Adapter Setup",
      description:
        "Plan and optionally run safe Moryn-local host adapter setup without mutating host configuration files.",
      inputSchema: mcpInputSchema({
        host: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: z.unknown().optional(),
        apply: coreValidatedBooleanSchema.optional(),
        ...objectPathAliasInputSchema("install"),
        ...camelCaseAliasInputSchema("install")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("install", input, async (normalizedInput) => {
        const projectPath = validateProjectContextInput("install", {
          project_path: normalizedInput.project_path
        }).project_path;
        const plan = planInstall({
          host: normalizedInput.host as string | undefined,
          projectPath,
          syncRemote: normalizedInput.sync_remote as string | undefined,
          apply: normalizedInput.apply as boolean | undefined
        });
        if (normalizedInput.apply === true) {
          await initializeStore(options.storePath);
          if (projectPath) {
            await initializeProjectConfig(projectPath, {});
          }
        }
        return plan;
      })
  );

  server.registerTool(
    "setup",
    {
      title: "Run Moryn Setup Wizard",
      description:
        "Diagnose local Moryn readiness and optionally apply safe local setup without mutating host configuration files.",
      inputSchema: mcpInputSchema({
        host: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: z.unknown().optional(),
        apply: coreValidatedBooleanSchema.optional(),
        ...objectPathAliasInputSchema("setup"),
        ...camelCaseAliasInputSchema("setup")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "setup",
        input,
        async (normalizedInput) => {
          const projectPath = validateProjectContextInput("setup", {
            project_path: normalizedInput.project_path
          }).project_path;
          return setupWizard({
            storePath: options.storePath,
            host: normalizedInput.host as string | undefined,
            projectPath,
            syncRemote: normalizedInput.sync_remote as string | undefined,
            apply: normalizedInput.apply as boolean | undefined
          });
        },
        (normalizedInput) => {
          const argumentsForContext = compactUndefined({
            host: normalizedInput.host,
            project_path: normalizedInput.project_path,
            sync_remote: normalizedInput.sync_remote,
            ...(normalizedInput.apply === true ? { apply: true } : {})
          });
          return {
            tool: "setup",
            command: commandForSetupContext(argumentsForContext),
            arguments: argumentsForContext
          };
        }
      )
  );

  server.registerTool(
    "capture_session",
    {
      title: "Capture Moryn Session Handoff",
      description: "Capture a host-normalized session handoff summary for reuse by other agents and devices.",
      inputSchema: mcpInputSchema({
        summary: coreValidatedStringSchema,
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: z.unknown().optional(),
        current_task: z.unknown().optional(),
        files: z.array(coreValidatedStringSchema).optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("capture_session"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("capture_session")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("capture_session", input, async (normalizedInput) => {
        const project = lifecycleProjectContextInput("capture_session", normalizedInput);
        return captureSession({
          storePath: options.storePath,
          projectPath: project.projectPath,
          projectId: project.projectId,
          syncRemote: normalizedInput.sync_remote as string | undefined,
          summary: normalizedInput.summary as string,
          currentTask: normalizedInput.current_task as string | undefined,
          files: normalizedInput.files as string[] | undefined,
          agent: lifecycleAgentInput(normalizedInput.agent)
        });
      })
  );

  server.registerTool(
    "context_pack",
    {
      title: "Build Moryn Host Context Pack",
      description:
        "Build a host-normalized startup context pack with Handoff Pack v0.2, read-only quality gate, boot, refresh, raw handoff evidence, and a required capture next action.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: z.unknown().optional(),
        current_task: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("context_pack"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("context_pack")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("context_pack", input, async (normalizedInput) => {
        const project = lifecycleProjectContextInput("context_pack", normalizedInput);
        return contextPack({
          storePath: options.storePath,
          projectPath: project.projectPath,
          projectId: project.projectId,
          syncRemote: normalizedInput.sync_remote as string | undefined,
          currentTask: normalizedInput.current_task as string | undefined,
          limit: normalizedInput.limit as number | undefined,
          includePrivate: normalizedInput.include_private as boolean | undefined,
          pull: normalizedInput.pull as boolean | undefined,
          agent: lifecycleAgentInput(normalizedInput.agent)
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
    async (input) =>
      toolResultWithNormalizedInput("selection_source_contracts", input, async () => getSelectionSourceContracts())
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
            ...jsonResult(
              toErrorEnvelope(
                new OperationContractLookupConflictError(lookupOptions, "index, operation, mcp_tool, or cli_command")
              )
            ),
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
    "soul_status",
    {
      title: "Inspect Moryn Soul Status",
      description:
        "Return metadata-only Soul revision, conflict, approval, compilation, synchronization, and delivery status.",
      inputSchema: mcpInputSchema({
        user_profile_id: coreValidatedStringSchema.optional(),
        agent_profile_id: coreValidatedStringSchema.optional(),
        project_id: coreValidatedStringSchema.optional(),
        allowed_distributions: z.unknown().optional(),
        char_budget: coreValidatedNumberSchema.optional(),
        token_budget: coreValidatedNumberSchema.optional(),
        ...camelCaseAliasInputSchema("soul_status")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("soul_status", input, async (normalizedInput) =>
        engine.readSoulProfileStatus({
          user_profile_id: normalizedInput.user_profile_id,
          agent_profile_id: normalizedInput.agent_profile_id,
          project_id: normalizedInput.project_id,
          allowed_distributions: normalizedInput.allowed_distributions,
          char_budget: normalizedInput.char_budget,
          token_budget: normalizedInput.token_budget
        })
      )
  );

  server.registerTool(
    "soul_draft",
    {
      title: "Create Moryn Soul Draft",
      description: "Persist an authored, unapproved Soul profile draft without leaking local-only clauses to Git.",
      inputSchema: mcpInputSchema({
        subject: z.unknown().optional(),
        ...soulSubjectAliasInputSchema,
        profile_id: coreValidatedStringSchema.optional(),
        from_revision_id: coreValidatedStringSchema.optional(),
        clauses: z.unknown().optional(),
        occurred_at: coreValidatedStringSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("soul_draft")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("soul_draft", input, async (normalizedInput) =>
        engine.createSoulProfileDraft({
          subject: normalizedInput.subject,
          profile_id: normalizedInput.profile_id,
          from_revision_id: normalizedInput.from_revision_id,
          clauses: normalizedInput.clauses,
          occurred_at: normalizedInput.occurred_at,
          source: withDefaultSource(normalizedInput.source)
        })
      )
  );

  server.registerTool(
    "soul_approve",
    {
      title: "Approve Moryn Soul Draft",
      description: "Activate one reviewed Soul draft; explicit confirm=true is required.",
      inputSchema: mcpInputSchema({
        revision_id: coreValidatedStringSchema.optional(),
        confirm: coreValidatedBooleanSchema.optional(),
        occurred_at: coreValidatedStringSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("soul_approve")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("soul_approve", input, async (normalizedInput) =>
        engine.approveSoulProfileDraft({
          revision_id: normalizedInput.revision_id,
          confirmed: normalizedInput.confirm,
          occurred_at: normalizedInput.occurred_at,
          source: withDefaultSource(normalizedInput.source)
        })
      )
  );

  server.registerTool(
    "soul_rollback",
    {
      title: "Roll Back Moryn Soul Profile",
      description:
        "Append a rollback revision copied from a prior approved revision; explicit confirm=true is required.",
      inputSchema: mcpInputSchema({
        profile_id: coreValidatedStringSchema.optional(),
        to_revision: coreValidatedStringSchema.optional(),
        confirm: coreValidatedBooleanSchema.optional(),
        occurred_at: coreValidatedStringSchema.optional(),
        source: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("soul_rollback")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("soul_rollback", input, async (normalizedInput) =>
        engine.rollbackSoulProfile({
          profile_id: normalizedInput.profile_id,
          target_revision_id: normalizedInput.to_revision,
          confirmed: normalizedInput.confirm,
          occurred_at: normalizedInput.occurred_at,
          source: withDefaultSource(normalizedInput.source)
        })
      )
  );

  server.registerTool(
    "memory_expand",
    {
      title: "Expand Moryn Memory Sources",
      description:
        "Expand one compressed memory into bounded source evidence with privacy omissions and digest verification.",
      inputSchema: mcpInputSchema({
        record_id: coreValidatedStringSchema.optional(),
        max_depth: coreValidatedNumberSchema.optional(),
        max_records: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_expand")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_expand", input, async (normalizedInput) =>
        engine.expandMemorySources({
          record_id: normalizedInput.record_id,
          max_depth: normalizedInput.max_depth,
          max_records: normalizedInput.max_records,
          include_private: normalizedInput.include_private
        })
      )
  );

  server.registerTool(
    "memory_compaction_preview",
    {
      title: "Preview Moryn Memory Compaction",
      description:
        "Read current records and preview deterministic compaction coverage, blockers, token reduction, sync impact, and undo semantics.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        session_id: coreValidatedStringSchema.optional(),
        bucket_kind: coreValidatedStringSchema.optional(),
        bucket_key: coreValidatedStringSchema.optional(),
        now: coreValidatedStringSchema.optional(),
        recent_window_days: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_compaction_preview")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_compaction_preview", input, async (normalizedInput) =>
        engine.previewMemoryCompaction({
          project_id: normalizedInput.project_id,
          session_id: normalizedInput.session_id,
          bucket_kind: normalizedInput.bucket_kind,
          bucket_key: normalizedInput.bucket_key,
          now: normalizedInput.now,
          recent_window_days: normalizedInput.recent_window_days,
          include_private: normalizedInput.include_private
        })
      )
  );

  server.registerTool(
    "memory_compaction_plan",
    {
      title: "Seal Moryn Memory Compaction Plan",
      description:
        "Validate an exact read-only compaction preview and seal it into the only artifact accepted by apply.",
      inputSchema: mcpInputSchema({
        preview: z.unknown().optional(),
        ...camelCaseAliasInputSchema("memory_compaction_plan")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_compaction_plan", input, async (normalizedInput) =>
        engine.planMemoryCompaction({ preview: normalizedInput.preview })
      )
  );

  server.registerTool(
    "memory_compaction_apply",
    {
      title: "Apply Moryn Memory Compaction",
      description:
        "Apply one reviewed sealed compaction plan through append-only transactions; explicit confirm=true is required.",
      inputSchema: mcpInputSchema({
        plan: z.unknown().optional(),
        confirm: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_compaction_apply")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_compaction_apply", input, async (normalizedInput) =>
        engine.applyMemoryCompaction({ plan: normalizedInput.plan, confirmed: normalizedInput.confirm })
      )
  );

  server.registerTool(
    "memory_compaction_restore",
    {
      title: "Restore Moryn Memory Compaction",
      description:
        "Append a logical restore for one committed compaction and archive its derived rollups; explicit confirm=true is required.",
      inputSchema: mcpInputSchema({
        plan_id: coreValidatedStringSchema.optional(),
        confirm: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_compaction_restore")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_compaction_restore", input, async (normalizedInput) =>
        engine.restoreMemoryCompaction({
          plan_id: normalizedInput.plan_id,
          confirmed: normalizedInput.confirm
        })
      )
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
        agent_session_id: coreValidatedStringSchema.optional(),
        default_skills: z.unknown().optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...objectPathAliasInputSchema("boot"),
        ...camelCaseAliasInputSchema("boot")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("boot", input, async (normalizedInput) => {
        const project = await resolveProjectInput("boot", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.boot({
          project_id: project.project_id,
          default_skills: normalizedInput.default_skills ?? project.default_skills,
          current_task: normalizedInput.current_task as string | undefined,
          agent_session_id: normalizedInput.agent_session_id,
          sync_remote: normalizedInput.sync_remote,
          include_private: normalizedInput.include_private
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
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("recall"),
        ...explicitAliasInputSchema("recall")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "recall",
        input,
        async (normalizedInput) => {
          const project = await resolveProjectInput("recall", {
            project_id: normalizedInput.project_id,
            project_path: normalizedInput.project_path
          });
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
            limit: normalizedInput.limit,
            include_private: normalizedInput.include_private
          });
        },
        (normalizedInput) => ({
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
            limit: normalizedInput.limit,
            include_private: normalizedInput.include_private
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
            ...(normalizedInput.limit !== undefined ? { limit: normalizedInput.limit } : {}),
            ...(normalizedInput.include_private !== undefined
              ? { include_private: normalizedInput.include_private }
              : {})
          }
        })
      )
  );

  server.registerTool(
    "timeline",
    {
      title: "Timeline Around Moryn Record",
      description: "Return chronological event context around a record, event, or query anchor.",
      inputSchema: mcpInputSchema({
        record_id: coreValidatedStringSchema.optional(),
        event_id: coreValidatedStringSchema.optional(),
        query: coreValidatedStringSchema.optional(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        before: coreValidatedNumberSchema.optional(),
        after: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("timeline")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "timeline",
        input,
        async (normalizedInput) => {
          const project = await resolveProjectInput("timeline", {
            project_id: normalizedInput.project_id,
            project_path: normalizedInput.project_path
          });
          return engine.timeline({
            record_id: normalizedInput.record_id,
            event_id: normalizedInput.event_id,
            query: normalizedInput.query,
            project_id: project.project_id,
            before: normalizedInput.before,
            after: normalizedInput.after,
            include_private: normalizedInput.include_private
          });
        },
        (normalizedInput) => ({
          tool: "timeline",
          command: commandForTimelineContext({
            record_id: normalizedInput.record_id,
            event_id: normalizedInput.event_id,
            query: normalizedInput.query,
            project_id: normalizedInput.project_id,
            project_path: normalizedInput.project_path,
            before: normalizedInput.before,
            after: normalizedInput.after,
            include_private: normalizedInput.include_private
          }),
          arguments: {
            ...(normalizedInput.record_id !== undefined ? { record_id: normalizedInput.record_id } : {}),
            ...(normalizedInput.event_id !== undefined ? { event_id: normalizedInput.event_id } : {}),
            ...(normalizedInput.query !== undefined ? { query: normalizedInput.query } : {}),
            ...(normalizedInput.project_id !== undefined ? { project_id: normalizedInput.project_id } : {}),
            ...(normalizedInput.project_path !== undefined ? { project_path: normalizedInput.project_path } : {}),
            ...(normalizedInput.before !== undefined ? { before: normalizedInput.before } : {}),
            ...(normalizedInput.after !== undefined ? { after: normalizedInput.after } : {}),
            ...(normalizedInput.include_private !== undefined
              ? { include_private: normalizedInput.include_private }
              : {})
          }
        })
      )
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
    async (input) =>
      toolResult(async () => {
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
        const project = await resolveProjectInput("write", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        const type = normalizedInput.type ?? (normalizedInput.kind === "session_summary" ? "summary" : undefined);
        const scope = normalizedInput.scope ?? (normalizedInput.kind === "session_summary" ? "project" : undefined);
        if (type === undefined) {
          throw writeRequiredArgumentError("type");
        }
        if (scope === undefined) {
          throw writeRequiredArgumentError("scope");
        }
        const tags =
          normalizedInput.tags === undefined || Array.isArray(normalizedInput.tags)
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
    async (input) =>
      toolResultWithNormalizedInput(
        "revise",
        input,
        async (normalizedInput) =>
          engine.revise({
            record_id: normalizedInput.record_id,
            patch: normalizedInput.patch,
            reason: normalizedInput.reason,
            confirmed: normalizedInput.confirmed as boolean | undefined,
            source: withDefaultSource(normalizedInput.source) as RecordSource
          }),
        (normalizedInput) => ({
          tool: "revise",
          command: commandForReviseContext({
            record_id: normalizedInput.record_id,
            patch: normalizedInput.patch,
            reason: normalizedInput.reason
          }),
          arguments: {
            record_id: normalizedInput.record_id,
            patch: normalizedInput.patch,
            ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
            ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
          }
        })
      )
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
    async (input) =>
      toolResultWithNormalizedInput(
        "promote",
        input,
        async (normalizedInput) =>
          engine.promote({
            record_id: normalizedInput.record_id,
            target_state: normalizedInput.target_state,
            reason: normalizedInput.reason,
            source: withDefaultSource(normalizedInput.source) as RecordSource,
            confirmed: normalizedInput.confirmed as boolean | undefined
          }),
        (normalizedInput) => ({
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
        })
      )
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
    async (input) =>
      toolResultWithNormalizedInput(
        "archive",
        input,
        async (normalizedInput) =>
          engine.archive({
            record_id: normalizedInput.record_id,
            reason: normalizedInput.reason,
            source: withDefaultSource(normalizedInput.source) as RecordSource
          }),
        (normalizedInput) => ({
          tool: "archive",
          command: commandForArchiveContext({ record_id: normalizedInput.record_id, reason: normalizedInput.reason }),
          arguments: {
            record_id: normalizedInput.record_id,
            ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
            ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
          }
        })
      )
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
    async (input) =>
      toolResultWithNormalizedInput(
        "quarantine",
        input,
        async (normalizedInput) =>
          engine.quarantine({
            record_id: normalizedInput.record_id,
            reason: normalizedInput.reason,
            source: withDefaultSource(normalizedInput.source) as RecordSource
          }),
        (normalizedInput) => ({
          tool: "quarantine",
          command: commandForQuarantineContext({
            record_id: normalizedInput.record_id,
            reason: normalizedInput.reason
          }),
          arguments: {
            record_id: normalizedInput.record_id,
            ...(normalizedInput.reason !== undefined ? { reason: normalizedInput.reason } : {}),
            ...(normalizedInput.source !== undefined ? { source: normalizedInput.source } : {})
          }
        })
      )
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
    async (input) =>
      toolResultWithNormalizedInput(
        "link",
        input,
        async (normalizedInput) =>
          engine.link({
            record_id: normalizedInput.record_id,
            linked_record_id: normalizedInput.linked_record_id,
            link_type: normalizedInput.link_type,
            source: withDefaultSource(normalizedInput.source) as RecordSource
          }),
        (normalizedInput) => ({
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
        })
      )
  );

  server.registerTool(
    "logical_link",
    {
      title: "Link Logical Memories",
      description: "Append an agent-proposed, Core-validated logical relationship between compatible active records.",
      inputSchema: mcpInputSchema({
        record_id: z.string().min(1),
        linked_record_id: z.string().min(1),
        relationship: z.enum(LOGICAL_RELATIONSHIP_TYPES),
        reason: z.string().min(1),
        source: z.unknown().optional()
      })
    },
    async (input) =>
      toolResult(() =>
        engine.logicalLink({
          record_id: input.record_id,
          linked_record_id: input.linked_record_id,
          relationship: input.relationship,
          reason: input.reason,
          source: withDefaultSource(input.source) as RecordSource
        })
      )
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
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("refresh")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("refresh", input, async (normalizedInput) => {
        const project = await resolveProjectInput("refresh", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.refresh({
          project_id: project.project_id,
          cursor: normalizedInput.cursor,
          current_task: normalizedInput.current_task as string | undefined,
          limit: normalizedInput.limit,
          include_private: normalizedInput.include_private
        });
      })
  );

  server.registerTool(
    "memory_doctor",
    {
      title: "Diagnose Moryn Memory Health",
      description:
        "Read-only memory audit for candidate backlog, promotable records, marker noise, and project-id splits.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_doctor")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_doctor", input, async (normalizedInput) => {
        const project = await resolveProjectInput("memory_doctor", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.memoryDoctor({
          project_id: project.project_id,
          limit: normalizedInput.limit,
          include_private: normalizedInput.include_private
        });
      })
  );

  server.registerTool(
    "memory_maintenance_shadow",
    {
      title: "Preview Moryn Memory Consolidation",
      description:
        "Read-only whole-working-set candidate discovery with strict before/after record and token projections.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        minimum_token_overlap: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_maintenance_shadow")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_maintenance_shadow", input, async (normalizedInput) => {
        const project = await resolveProjectInput("memory_maintenance_shadow", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.memoryMaintenanceShadow({
          project_id: project.project_id,
          candidate_limit: normalizedInput.limit,
          minimum_token_overlap: normalizedInput.minimum_token_overlap,
          include_private: normalizedInput.include_private
        });
      })
  );

  server.registerTool(
    "memory_lifecycle",
    {
      title: "Report Moryn Memory Lifecycle",
      description:
        "Read-only memory lifecycle report for stale records, archive candidates, retained records, and suggested audit actions.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        now: coreValidatedStringSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("memory_lifecycle")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("memory_lifecycle", input, async (normalizedInput) => {
        const project = await resolveProjectInput("memory_lifecycle", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.memoryLifecycle({
          project_id: project.project_id,
          limit: normalizedInput.limit as number | undefined,
          now: normalizedInput.now as string | undefined,
          include_private: normalizedInput.include_private as boolean | undefined
        });
      })
  );

  server.registerTool(
    "capture_policy",
    {
      title: "Audit Moryn Capture Policy",
      description:
        "Read-only audit of autocapture policy decisions, review candidates, policy-archived noise, and evidence.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("capture_policy")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("capture_policy", input, async (normalizedInput) => {
        const project = await resolveProjectInput("capture_policy", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.capturePolicy({
          project_id: project.project_id,
          limit: normalizedInput.limit as number | undefined,
          include_private: normalizedInput.include_private as boolean | undefined
        });
      })
  );

  server.registerTool(
    "dogfood_report",
    {
      title: "Report Moryn Dogfood Friction",
      description:
        "Read-only dogfood report for capture-review backlog, duplicate handoffs, and failure or timeout signals.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("dogfood_report")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("dogfood_report", input, async (normalizedInput) => {
        const project = await resolveProjectInput("dogfood_report", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.dogfoodReport({
          project_id: project.project_id,
          limit: normalizedInput.limit as number | undefined,
          include_private: normalizedInput.include_private as boolean | undefined
        });
      })
  );

  server.registerTool(
    "health_check",
    {
      title: "Check Moryn Health",
      description:
        "Read-only installation and store health check for setup trust, project readiness, privacy boundary, and capture review backlog.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        host: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("health_check")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("health_check", input, async (normalizedInput) => {
        const project = await resolveProjectInput("health_check", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.healthCheck({
          project_id: project.project_id,
          project_path: project.project_path,
          host: normalizedInput.host as string | undefined,
          sync_remote: normalizedInput.sync_remote as string | undefined,
          limit: normalizedInput.limit as number | undefined,
          include_private: normalizedInput.include_private as boolean | undefined
        });
      })
  );

  server.registerTool(
    "recall_eval",
    {
      title: "Evaluate Moryn Recall",
      description:
        "Read-only recall quality eval for golden queries, expected record ids, privacy checks, and ranking reasons.",
      inputSchema: mcpInputSchema({
        cases: z.unknown(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        ...camelCaseAliasInputSchema("recall_eval")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("recall_eval", input, async (normalizedInput) => {
        const project = await resolveProjectInput("recall_eval", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.recallEval({
          project_id: project.project_id,
          cases: normalizedInput.cases,
          include_private: normalizedInput.include_private as boolean | undefined
        });
      })
  );

  server.registerTool(
    "agent_doctor",
    {
      title: "Diagnose Moryn Agent Setup",
      description:
        "Read-only setup check that tells an agent whether store, project, and sync are ready and what to call next.",
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
    async (input) =>
      toolResultWithNormalizedInput("agent_doctor", input, async (normalizedInput) => {
        const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
        return withMcpRuntime(
          await agentDoctor({
            storePath: options.storePath,
            ...lifecycleProjectContextInput("agent_doctor", {
              project_id: normalizedInput.project_id,
              project_path: normalizedInput.project_path
            }),
            syncRemote: normalizedInput.sync_remote as string | undefined,
            currentTask: normalizedInput.current_task as string | undefined,
            agent: lifecycleAgent
          }),
          options.hostRuntime
        );
      })
  );

  server.registerTool(
    "agent_enter",
    {
      title: "Enter Moryn Agent Session",
      description:
        "One-call agent entrypoint: diagnose setup, discover projects when needed, or start a known project session.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        user_profile_id: coreValidatedStringSchema.optional(),
        agent_profile_id: coreValidatedStringSchema.optional(),
        soul_char_budget: coreValidatedNumberSchema.optional(),
        soul_token_budget: coreValidatedNumberSchema.optional(),
        refresh_since: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        open: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_enter"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_enter")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "agent_enter",
        input,
        async (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPull = normalizedInput.pull as boolean | undefined;
          const result = await agentEnter({
            storePath: options.storePath,
            ...lifecycleProjectContextInput("agent_enter", {
              project_id: normalizedInput.project_id,
              project_path: normalizedInput.project_path
            }),
            syncRemote: normalizedInput.sync_remote as string | undefined,
            currentTask: normalizedInput.current_task as string | undefined,
            ...lifecycleSoulBindingInput(normalizedInput),
            refreshSince: normalizedInput.refresh_since,
            limit: normalizedInput.limit,
            pull: coreValidatedPull,
            agent: lifecycleAgent,
            hostRuntime: options.hostRuntime
          });
          return withOptionalMcpDashboard(
            options.storePath,
            withMcpRuntime(result, options.hostRuntime),
            normalizedInput.open
          );
        },
        (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPull = normalizedInput.pull as boolean | undefined;
          const contextArguments = compactUndefined({
            project_id: normalizedInput.project_id,
            project_path: normalizedInput.project_path,
            sync_remote: normalizedInput.sync_remote,
            current_task: normalizedInput.current_task,
            user_profile_id: normalizedInput.user_profile_id,
            agent_profile_id: normalizedInput.agent_profile_id,
            soul_char_budget: normalizedInput.soul_char_budget,
            soul_token_budget: normalizedInput.soul_token_budget,
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
        }
      )
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
    async (input) =>
      toolResultWithNormalizedInput("agent_guide", input, async (normalizedInput) => {
        const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
        return withMcpRuntime(
          await agentGuide({
            storePath: options.storePath,
            ...lifecycleProjectContextInput("agent_guide", {
              project_id: normalizedInput.project_id,
              project_path: normalizedInput.project_path
            }),
            syncRemote: normalizedInput.sync_remote as string | undefined,
            currentTask: normalizedInput.current_task as string | undefined,
            agent: lifecycleAgent
          }),
          options.hostRuntime
        );
      })
  );

  server.registerTool(
    "agent_start",
    {
      title: "Start Moryn Agent Session",
      description:
        "Low-friction agent startup: pull sync, resolve project context, boot context, and refresh recent changes.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        user_profile_id: coreValidatedStringSchema.optional(),
        agent_profile_id: coreValidatedStringSchema.optional(),
        soul_char_budget: coreValidatedNumberSchema.optional(),
        soul_token_budget: coreValidatedNumberSchema.optional(),
        refresh_since: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        open: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_start"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_start")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "agent_start",
        input,
        async (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPull = normalizedInput.pull as boolean | undefined;
          const result = await agentStart({
            storePath: options.storePath,
            ...lifecycleProjectContextInput("agent_start", {
              project_id: normalizedInput.project_id,
              project_path: normalizedInput.project_path
            }),
            syncRemote: normalizedInput.sync_remote as string | undefined,
            currentTask: normalizedInput.current_task as string | undefined,
            ...lifecycleSoulBindingInput(normalizedInput),
            refreshSince: normalizedInput.refresh_since,
            limit: normalizedInput.limit,
            pull: coreValidatedPull,
            agent: lifecycleAgent
          });
          return withOptionalMcpDashboard(
            options.storePath,
            withMcpRuntime(result, options.hostRuntime),
            normalizedInput.open
          );
        },
        (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPull = normalizedInput.pull as boolean | undefined;
          const contextArguments = compactUndefined({
            project_id: normalizedInput.project_id,
            project_path: normalizedInput.project_path,
            sync_remote: normalizedInput.sync_remote,
            current_task: normalizedInput.current_task,
            user_profile_id: normalizedInput.user_profile_id,
            agent_profile_id: normalizedInput.agent_profile_id,
            soul_char_budget: normalizedInput.soul_char_budget,
            soul_token_budget: normalizedInput.soul_token_budget,
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
        }
      )
  );

  server.registerTool(
    "consolidate_semantic",
    {
      title: "Consolidate Semantic Memory",
      description: "Validate and persist bounded authored semantic memory relationships.",
      inputSchema: mcpInputSchema({
        proposals: z.array(z.unknown()).max(24),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional(),
        source: z.unknown().optional()
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("consolidate_semantic", input, async (normalizedInput) => {
        const project = await resolveProjectInput("consolidate_semantic", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return engine.consolidateSemanticProposals({
          proposals: normalizedInput.proposals,
          project_id: project.project_id,
          include_private: normalizedInput.include_private,
          source: withDefaultSource(normalizedInput.source) as never
        });
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
        learnings: z.array(z.unknown()).optional(),
        semantic_consolidation_proposals: z.array(z.unknown()).max(24).optional(),
        open: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_finish"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_finish")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "agent_finish",
        input,
        async (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPush = normalizedInput.push as boolean | undefined;
          const result = await agentFinish({
            storePath: options.storePath,
            ...lifecycleProjectContextInput("agent_finish", {
              project_id: normalizedInput.project_id,
              project_path: normalizedInput.project_path
            }),
            syncRemote: normalizedInput.sync_remote as string | undefined,
            currentTask: normalizedInput.current_task as string | undefined,
            summary: normalizedInput.summary,
            push: coreValidatedPush,
            agent: lifecycleAgent,
            learnings: normalizedInput.learnings as never[] | undefined,
            semanticConsolidationProposals: normalizedInput.semantic_consolidation_proposals as never[] | undefined
          });
          return withOptionalMcpDashboard(
            options.storePath,
            withMcpRuntime(result, options.hostRuntime),
            normalizedInput.open
          );
        },
        (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPush = normalizedInput.push as boolean | undefined;
          const contextInput = {
            summary: normalizedInput.summary,
            project_id: normalizedInput.project_id,
            project_path: normalizedInput.project_path,
            sync_remote: normalizedInput.sync_remote,
            current_task: normalizedInput.current_task,
            push: coreValidatedPush,
            agent: lifecycleAgent,
            learnings: normalizedInput.learnings
          };
          const contextArguments = compactUndefined(contextInput);
          return {
            tool: "agent_finish",
            command: commandForAgentFinishContext(contextInput),
            arguments: contextArguments
          };
        }
      )
  );

  server.registerTool(
    "learn",
    {
      title: "Queue Reusable Learning",
      description: "Queue one reusable Learning Delta for automatic checkpoint or finish consumption.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        question: z.unknown(),
        conclusion: z.unknown(),
        evidence_type: z.unknown(),
        scope: z.unknown().optional(),
        confidence: z.unknown().optional(),
        valid_until: z.unknown().optional(),
        recommended_kind: z.unknown().optional(),
        recommended_type: z.unknown().optional(),
        related_record_ids: z.unknown().optional(),
        current_task: z.unknown().optional(),
        source: coreValidatedSourceSchema.optional(),
        occurred_at: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("learn")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("learn", input, async (normalizedInput) => {
        const project = await resolveProjectInput("learn", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        return queueLearning(options.storePath, {
          project_id: project.project_id,
          question: normalizedInput.question,
          conclusion: normalizedInput.conclusion,
          evidence_type: normalizedInput.evidence_type,
          scope: normalizedInput.scope,
          confidence: normalizedInput.confidence,
          valid_until: normalizedInput.valid_until,
          recommended_kind: normalizedInput.recommended_kind,
          recommended_type: normalizedInput.recommended_type,
          related_record_ids: normalizedInput.related_record_ids,
          current_task: normalizedInput.current_task,
          source: withDefaultSource(normalizedInput.source) as RecordSource,
          occurred_at: (normalizedInput.occurred_at as string | undefined) ?? new Date().toISOString()
        });
      })
  );

  server.registerTool(
    "checkpoint",
    {
      title: "Checkpoint Agent Context",
      description: "Append an authored local session checkpoint for compaction recovery and long-task continuity.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        source: z
          .object({
            client: z.unknown().optional(),
            session_id: z.unknown().optional(),
            sessionId: z.unknown().optional(),
            model: z.unknown().optional(),
            device_id: z.unknown().optional(),
            deviceId: z.unknown().optional()
          })
          .passthrough(),
        occurred_at: z.unknown().optional(),
        delta: z.unknown(),
        tags: z.unknown().optional(),
        include_private: z.unknown().optional(),
        ...sourceAliasInputSchema,
        ...camelCaseAliasInputSchema("checkpoint")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("checkpoint", input, async (normalizedInput) => {
        const project = await resolveProjectInput("checkpoint", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        if (normalizedInput.include_private !== undefined && typeof normalizedInput.include_private !== "boolean")
          throw new Error("Invalid argument: include_private must be boolean");
        return engine.checkpoint({
          project_id: project.project_id ?? "",
          source: checkpointSource(normalizedInput.source),
          occurred_at: normalizedInput.occurred_at as string,
          delta: normalizedInput.delta as never,
          tags: normalizedInput.tags as string[] | undefined,
          include_private: normalizedInput.include_private as boolean | undefined
        });
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
        open: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...objectPathAliasInputSchema("agent_status"),
        ...agentAliasInputSchema,
        ...camelCaseAliasInputSchema("agent_status")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput(
        "agent_status",
        input,
        async (normalizedInput) => {
          const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
          const coreValidatedPush = normalizedInput.push as boolean | undefined;
          const result = await agentStatus({
            storePath: options.storePath,
            ...lifecycleProjectContextInput("agent_status", {
              project_id: normalizedInput.project_id,
              project_path: normalizedInput.project_path
            }),
            syncRemote: normalizedInput.sync_remote as string | undefined,
            currentTask: normalizedInput.current_task as string | undefined,
            status: normalizedInput.status,
            push: coreValidatedPush,
            agent: lifecycleAgent
          });
          return withOptionalMcpDashboard(
            options.storePath,
            withMcpRuntime(result, options.hostRuntime),
            normalizedInput.open
          );
        },
        (normalizedInput) => {
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
        }
      )
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
    "dashboard",
    {
      title: "Generate Moryn Dashboard",
      description:
        "Generate a local static HTML dashboard for sync status, records, recent events, and agent activity.",
      inputSchema: mcpInputSchema({
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        limit: coreValidatedNumberSchema.optional(),
        open: coreValidatedBooleanSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional()
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("dashboard", input, async (normalizedInput) => {
        validateMcpDashboardOpen(normalizedInput.open);
        const project = await resolveProjectInput("dashboard", {
          project_id: normalizedInput.project_id,
          project_path: normalizedInput.project_path
        });
        const snapshot = await writeDashboardSnapshot(options.storePath, {
          limit: normalizedInput.limit as number | undefined,
          include_private: normalizedInput.include_private as boolean | undefined,
          project_id: project.project_id
        });
        if (normalizedInput.open === true) {
          await openDashboard(snapshot.url);
          return { ...snapshot, opened: true };
        }
        return snapshot;
      })
  );

  server.registerTool(
    "activation_status",
    {
      title: "Inspect Host Activation",
      description: "Read-only diagnosis of generated, configured, and runtime-proven Moryn host activation.",
      inputSchema: mcpInputSchema({
        host: coreValidatedStringSchema,
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        ...objectPathAliasInputSchema("activation_status"),
        ...camelCaseAliasInputSchema("activation_status")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("activation_status", input, async (normalizedInput) => {
        const project = await resolveProjectContext({
          projectId: normalizedInput.project_id as string | undefined,
          projectPath: normalizedInput.project_path as string | undefined
        });
        return inspectHostActivation({
          store_path: options.storePath,
          project_path: project.project_path,
          project_id: project.project_id,
          host: normalizedInput.host as string,
          runtime: options.hostRuntime
        });
      })
  );

  server.registerTool(
    "activation_apply",
    {
      title: "Apply Safe Host Activation",
      description: "Safely generate and activate Moryn-owned Claude Code or Codex lifecycle hooks.",
      inputSchema: mcpInputSchema({
        host: coreValidatedStringSchema,
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        ...objectPathAliasInputSchema("activation_apply"),
        ...camelCaseAliasInputSchema("activation_apply")
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("activation_apply", input, async (normalizedInput) => {
        const project = await resolveProjectContext({
          projectId: normalizedInput.project_id as string | undefined,
          projectPath: normalizedInput.project_path as string | undefined
        });
        const host = normalizedInput.host as string;
        const normalizedHost = host === "claude-code" ? "claude" : host;
        if (normalizedHost !== "claude" && normalizedHost !== "codex")
          throw new Error(`Invalid argument: activation apply is unsupported for host: ${host}`);
        const artifact = buildHostIntegrationArtifact({
          host: normalizedHost,
          project_id: project.project_id,
          project_path: project.project_path,
          store_path: options.storePath,
          runtime: options.hostRuntime
        });
        const fragment = await writeHostIntegrationArtifact({
          host: normalizedHost,
          project_id: project.project_id,
          project_path: project.project_path,
          store_path: options.storePath,
          runtime: options.hostRuntime
        });
        const activation =
          normalizedHost === "claude"
            ? await activateClaudeSettings({ project_path: project.project_path, artifact })
            : await activateCodexHooks({ project_path: project.project_path, artifact });
        const status = await inspectHostActivation({
          store_path: options.storePath,
          project_path: project.project_path,
          project_id: project.project_id,
          host: normalizedHost,
          runtime: options.hostRuntime
        });
        return { ok: true, fragment, activation, status };
      })
  );

  server.registerTool(
    "sync_init",
    {
      title: "Initialize Moryn Git Sync",
      description: "Initialize or connect the local Moryn store to a Git remote.",
      inputSchema: mcpInputSchema({
        remote: coreValidatedStringSchema,
        open: coreValidatedBooleanSchema.optional()
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("sync_init", input, async (normalizedInput) => {
        const result = await initializeGitSync(options.storePath, normalizedInput.remote as string);
        return withOptionalMcpDashboard(options.storePath, result, normalizedInput.open);
      })
  );

  server.registerTool(
    "sync_status",
    {
      title: "Get Moryn Git Sync Status",
      description: "Return Git sync configuration and local/remote status.",
      inputSchema: mcpInputSchema({})
    },
    async (input) =>
      toolResultWithNormalizedInput("sync_status", input, async () => getGitSyncStatus(options.storePath))
  );

  server.registerTool(
    "sync_pull",
    {
      title: "Pull Moryn Git Sync",
      description: "Pull remote event history into the local Moryn store.",
      inputSchema: mcpInputSchema({
        open: coreValidatedBooleanSchema.optional()
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("sync_pull", input, async (normalizedInput) => {
        const result = await pullGitSync(options.storePath);
        return withOptionalMcpDashboard(options.storePath, result, normalizedInput.open);
      })
  );

  server.registerTool(
    "sync_push",
    {
      title: "Push Moryn Git Sync",
      description: "Commit and push local event history from the Moryn store.",
      inputSchema: mcpInputSchema({
        message: coreValidatedStringSchema.optional(),
        open: coreValidatedBooleanSchema.optional()
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("sync_push", input, async (normalizedInput) => {
        const result = await pushGitSync(options.storePath, { message: normalizedInput.message as string | undefined });
        return withOptionalMcpDashboard(options.storePath, result, normalizedInput.open);
      })
  );

  server.registerTool(
    "list_recent",
    {
      title: "List Recent Moryn Records",
      description: "Return recently updated records.",
      inputSchema: mcpInputSchema({
        limit: coreValidatedNumberSchema.optional(),
        include_private: coreValidatedBooleanSchema.optional()
      })
    },
    async (input) =>
      toolResultWithNormalizedInput("list_recent", input, async (normalizedInput) =>
        engine.listRecent({
          limit: normalizedInput.limit,
          include_private: normalizedInput.include_private
        })
      )
  );

  await server.connect(new StdioServerTransport());
}
