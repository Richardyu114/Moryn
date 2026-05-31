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
  source_client: z.unknown().optional(),
  "source.client": z.unknown().optional(),
  source_session_id: z.unknown().optional(),
  "source.session_id": z.unknown().optional(),
  source_model: z.unknown().optional(),
  "source.model": z.unknown().optional(),
  source_device_id: z.unknown().optional(),
  "source.device_id": z.unknown().optional()
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

function compactUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function normalizeMcpToolArguments(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  return mcpArgumentsForAction(tool, input);
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
      inputSchema: {
        repair: coreValidatedBooleanSchema.optional()
      }
    },
    async ({ repair }) => toolResult(async () => ({ ok: true, ...await initializeStore(options.storePath, { repair: repair as boolean | undefined }) }))
  );

  server.registerTool(
    "project_init",
    {
      title: "Initialize Moryn Project Config",
      description: "Create or update a .moryn.json project config.",
      inputSchema: {
        path: coreValidatedStringSchema,
        project_id: coreValidatedStringSchema.optional(),
        tags: z.unknown().optional(),
        default_skills: z.unknown().optional(),
        sync_mode: coreValidatedSyncModeSchema.optional(),
        repair: coreValidatedBooleanSchema.optional()
      }
    },
    async ({ path, project_id, tags, default_skills, sync_mode, repair }) => toolResult(async () => ({
      ok: true,
      ...await initializeProjectConfig(path, {
        project_id,
        tags,
        default_skills,
        sync: sync_mode === undefined ? undefined : { mode: sync_mode as SyncMode },
        repair: repair as boolean | undefined
      })
    }))
  );

  server.registerTool(
    "project_list",
    {
      title: "List Moryn Projects",
      description: "Discover known project ids and recent project activity from the Moryn store.",
      inputSchema: {
        limit: coreValidatedNumberSchema.optional(),
        current_task: z.unknown().optional(),
        sync_remote: z.unknown().optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("project_list", input);
      const projectListAgent = lifecycleAgentInput(normalizedInput.agent);
      return toolResult(async () => engine.listProjects({
        limit: normalizedInput.limit,
        current_task: normalizedInput.current_task,
        sync_remote: normalizedInput.sync_remote,
        agent: projectListAgent
      }));
    }
  );

  server.registerTool(
    "selection_source_contracts",
    {
      title: "Get Moryn Selection Source Contracts",
      description: "Return stable response field-path contracts for CLI, MCP, and library hosts.",
      inputSchema: {}
    },
    async () => toolResult(async () => getSelectionSourceContracts())
  );

  server.registerTool(
    "operation_contracts",
    {
      title: "Get Moryn Operation Contracts",
      description: "Return stable CLI/MCP operation contracts, safety metadata, and required fields.",
      inputSchema: {
        index: coreValidatedBooleanSchema.optional(),
        operation: coreValidatedStringSchema.optional(),
        mcp_tool: coreValidatedStringSchema.optional(),
        cli_command: coreValidatedStringSchema.optional()
      }
    },
    async ({ index, operation, mcp_tool, cli_command }) => {
      try {
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
      inputSchema: {
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        default_skills: z.unknown().optional()
      }
    },
    async ({ project_id, project_path, sync_remote, current_task, default_skills }) => toolResult(async () => {
      const project = await resolveProjectInput("boot", { project_id, project_path });
      return engine.boot({
        project_id: project.project_id,
        default_skills: default_skills ?? project.default_skills,
        current_task: current_task as string | undefined,
        sync_remote
      });
    })
  );

  server.registerTool(
    "recall",
    {
      title: "Recall Moryn Records",
      description: "Search memory, skills, soul, session summaries, and agent notes.",
      inputSchema: {
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
        limit: coreValidatedNumberSchema.optional()
      }
    },
    async ({ record_ids, query, project_id, project_path, kinds, scopes, types, states, tags, files, limit }) => toolResult(async () => {
      const project = await resolveProjectInput("recall", { project_id, project_path });
      return engine.recall({
        record_ids,
        query,
        project_id: project.project_id,
        kinds: kinds as RecordKind[] | undefined,
        scopes: scopes as RecordScope[] | undefined,
        types,
        states: states as RecordState[] | undefined,
        tags,
        files,
        limit
      });
    }, {
      tool: "recall",
      command: commandForRecallContext({
        record_ids,
        query,
        project_id,
        project_path,
        kinds,
        scopes,
        types,
        states,
        tags,
        files,
        limit
      }),
      arguments: {
        ...(record_ids !== undefined ? { record_ids } : {}),
        ...(query !== undefined ? { query } : {}),
        ...(project_id !== undefined ? { project_id } : {}),
        ...(project_path !== undefined ? { project_path } : {}),
        ...(kinds !== undefined ? { kinds } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(types !== undefined ? { types } : {}),
        ...(states !== undefined ? { states } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(files !== undefined ? { files } : {}),
        ...(limit !== undefined ? { limit } : {})
      }
    })
  );

  server.registerTool(
    "write",
    {
      title: "Write Moryn Record",
      description: "Append a new Moryn record event.",
      inputSchema: {
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
        ...writeAliasInputSchema
      }
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
      inputSchema: {
        record_id: z.unknown(),
        patch: z.unknown(),
        reason: coreValidatedStringSchema.optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        source: z.unknown().optional()
      }
    },
    async ({ record_id, patch, reason, confirmed, source }) => toolResult(async () => engine.revise({
        record_id,
        patch,
        reason,
        confirmed: confirmed as boolean | undefined,
        source: withDefaultSource(source) as RecordSource
      }), {
        tool: "revise",
        command: commandForReviseContext({ record_id, patch, reason }),
        arguments: {
          record_id,
          patch,
          ...(reason !== undefined ? { reason } : {}),
          ...(source !== undefined ? { source } : {})
        }
      })
  );

  server.registerTool(
    "promote",
    {
      title: "Promote Moryn Record",
      description: "Change a record state by appending a promotion/state event.",
      inputSchema: {
        record_id: z.unknown(),
        target_state: coreValidatedRecordStateSchema,
        reason: coreValidatedStringSchema.optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        source: z.unknown().optional()
      }
    },
    async ({ record_id, target_state, reason, confirmed, source }) => toolResult(async () => engine.promote({
      record_id,
      target_state,
      reason,
      source: withDefaultSource(source) as RecordSource,
      confirmed: confirmed as boolean | undefined
    }), {
      tool: "promote",
      command: commandForPromoteContext({ record_id, target_state, reason }),
      arguments: {
        record_id,
        target_state,
        ...(reason !== undefined ? { reason } : {}),
        ...(source !== undefined ? { source } : {})
      }
    })
  );

  server.registerTool(
    "archive",
    {
      title: "Archive Moryn Record",
      description: "Hide a record from default boot and recall while preserving history.",
      inputSchema: {
        record_id: z.unknown(),
        reason: coreValidatedStringSchema.optional(),
        source: z.unknown().optional()
      }
    },
    async ({ record_id, reason, source }) => toolResult(async () => engine.archive({
      record_id,
      reason,
      source: withDefaultSource(source) as RecordSource
    }), {
      tool: "archive",
      command: commandForArchiveContext({ record_id, reason }),
      arguments: {
        record_id,
        ...(reason !== undefined ? { reason } : {}),
        ...(source !== undefined ? { source } : {})
      }
    })
  );

  server.registerTool(
    "quarantine",
    {
      title: "Quarantine Moryn Record",
      description: "Mark a record as sensitive or unsafe so it is excluded by default.",
      inputSchema: {
        record_id: z.unknown(),
        reason: coreValidatedStringSchema.optional(),
        source: z.unknown().optional()
      }
    },
    async ({ record_id, reason, source }) => toolResult(async () => engine.quarantine({
      record_id,
      reason,
      source: withDefaultSource(source) as RecordSource
    }), {
      tool: "quarantine",
      command: commandForQuarantineContext({ record_id, reason }),
      arguments: {
        record_id,
        ...(reason !== undefined ? { reason } : {}),
        ...(source !== undefined ? { source } : {})
      }
    })
  );

  server.registerTool(
    "link",
    {
      title: "Link Moryn Records",
      description: "Append a relationship from one record to another.",
      inputSchema: {
        record_id: z.unknown(),
        linked_record_id: z.unknown(),
        link_type: coreValidatedStringSchema,
        source: z.unknown().optional()
      }
    },
    async ({ record_id, linked_record_id, link_type, source }) => toolResult(async () => engine.link({
      record_id,
      linked_record_id,
      link_type,
      source: withDefaultSource(source) as RecordSource
    }), {
      tool: "link",
      command: commandForLinkContext({ record_id, linked_record_id, link_type }),
      arguments: {
        record_id,
        linked_record_id,
        link_type,
        ...(source !== undefined ? { source } : {})
      }
    })
  );

  server.registerTool(
    "refresh",
    {
      title: "Refresh Moryn Changes",
      description: "Return important changes since a cursor for periodic agent memory refresh.",
      inputSchema: {
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        cursor: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional()
      }
    },
    async ({ project_id, project_path, cursor, current_task, limit }) => toolResult(async () => {
      const project = await resolveProjectInput("refresh", { project_id, project_path });
      return engine.refresh({
        project_id: project.project_id,
        cursor,
        current_task: current_task as string | undefined,
        limit
      });
    })
  );

  server.registerTool(
    "agent_doctor",
    {
      title: "Diagnose Moryn Agent Setup",
      description: "Read-only setup check that tells an agent whether store, project, and sync are ready and what to call next.",
      inputSchema: {
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("agent_doctor", input);
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      return toolResult(async () => agentDoctor({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_doctor", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        agent: lifecycleAgent
      }));
    }
  );

  server.registerTool(
    "agent_enter",
    {
      title: "Enter Moryn Agent Session",
      description: "One-call agent entrypoint: diagnose setup, discover projects when needed, or start a known project session.",
      inputSchema: {
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        refresh_since: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("agent_enter", input);
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
      return toolResult(async () => agentEnter({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_enter", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        refreshSince: normalizedInput.refresh_since,
        limit: normalizedInput.limit,
        pull: coreValidatedPull,
        agent: lifecycleAgent
      }), {
        tool: "agent_enter",
        command: commandForAgentEnterContext(contextArguments),
        arguments: contextArguments
      });
    }
  );

  server.registerTool(
    "agent_guide",
    {
      title: "Guide Moryn Agent Workflow",
      description: "Return machine-readable lifecycle guidance and exact next tool arguments for agents.",
      inputSchema: {
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("agent_guide", input);
      const lifecycleAgent = lifecycleAgentInput(normalizedInput.agent);
      return toolResult(async () => agentGuide({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_guide", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        agent: lifecycleAgent
      }));
    }
  );

  server.registerTool(
    "agent_start",
    {
      title: "Start Moryn Agent Session",
      description: "Low-friction agent startup: pull sync, resolve project context, boot context, and refresh recent changes.",
      inputSchema: {
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        refresh_since: z.unknown().optional(),
        limit: coreValidatedNumberSchema.optional(),
        pull: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("agent_start", input);
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
      return toolResult(async () => agentStart({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_start", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        refreshSince: normalizedInput.refresh_since,
        limit: normalizedInput.limit,
        pull: coreValidatedPull,
        agent: lifecycleAgent
      }), {
        tool: "agent_start",
        command: commandForAgentStartContext(contextArguments),
        arguments: contextArguments
      });
    }
  );

  server.registerTool(
    "agent_finish",
    {
      title: "Finish Moryn Agent Session",
      description: "Low-friction agent handoff: write a session summary and push sync.",
      inputSchema: {
        summary: z.unknown(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        push: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("agent_finish", input);
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
      return toolResult(async () => agentFinish({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_finish", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        summary: normalizedInput.summary,
        push: coreValidatedPush,
        agent: lifecycleAgent
      }), {
        tool: "agent_finish",
        command: commandForAgentFinishContext(contextInput),
        arguments: contextArguments
      });
    }
  );

  server.registerTool(
    "agent_status",
    {
      title: "Publish Moryn Agent Status",
      description: "Low-friction in-progress update: write a project status checkpoint and push sync.",
      inputSchema: {
        status: z.unknown(),
        project_id: coreValidatedStringSchema.optional(),
        project_path: coreValidatedStringSchema.optional(),
        sync_remote: coreValidatedStringSchema.optional(),
        current_task: z.unknown().optional(),
        push: coreValidatedBooleanSchema.optional(),
        agent: coreValidatedAgentSchema.optional(),
        ...agentAliasInputSchema
      }
    },
    async (input) => {
      const normalizedInput = normalizeMcpToolArguments("agent_status", input);
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
      return toolResult(async () => agentStatus({
        storePath: options.storePath,
        ...lifecycleProjectContextInput("agent_status", { project_id: normalizedInput.project_id, project_path: normalizedInput.project_path }),
        syncRemote: normalizedInput.sync_remote as string | undefined,
        currentTask: normalizedInput.current_task as string | undefined,
        status: normalizedInput.status,
        push: coreValidatedPush,
        agent: lifecycleAgent
      }), {
        tool: "agent_status",
        command: commandForAgentStatusContext(contextInput),
        arguments: contextArguments
      });
    }
  );

  server.registerTool(
    "rebuild",
    {
      title: "Rebuild Moryn Derived Views",
      description: "Regenerate snapshots and indexes from append-only events.",
      inputSchema: {}
    },
    async () => toolResult(async () => rebuildDerivedViews(options.storePath))
  );

  server.registerTool(
    "sync_init",
    {
      title: "Initialize Moryn Git Sync",
      description: "Initialize or connect the local Moryn store to a Git remote.",
      inputSchema: {
        remote: coreValidatedStringSchema
      }
    },
    async ({ remote }) => toolResult(async () => initializeGitSync(options.storePath, remote as string))
  );

  server.registerTool(
    "sync_status",
    {
      title: "Get Moryn Git Sync Status",
      description: "Return Git sync configuration and local/remote status.",
      inputSchema: {}
    },
    async () => toolResult(async () => getGitSyncStatus(options.storePath))
  );

  server.registerTool(
    "sync_pull",
    {
      title: "Pull Moryn Git Sync",
      description: "Pull remote event history into the local Moryn store.",
      inputSchema: {}
    },
    async () => toolResult(async () => pullGitSync(options.storePath))
  );

  server.registerTool(
    "sync_push",
    {
      title: "Push Moryn Git Sync",
      description: "Commit and push local event history from the Moryn store.",
      inputSchema: {
        message: coreValidatedStringSchema.optional()
      }
    },
    async ({ message }) => toolResult(async () => pushGitSync(options.storePath, { message: message as string | undefined }))
  );

  server.registerTool(
    "list_recent",
    {
      title: "List Recent Moryn Records",
      description: "Return recently updated records.",
      inputSchema: {
        limit: coreValidatedNumberSchema.optional()
      }
    },
    async ({ limit }) => toolResult(async () => engine.listRecent(limit))
  );

  await server.connect(new StdioServerTransport());
}
