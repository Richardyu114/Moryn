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
import { OperationContractLookupConflictError, OperationContractLookupError, type OperationContractLookupOption } from "../operation-contracts.js";
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
  commandForRecallContext,
  commandForQuarantineContext,
  commandForReviseContext,
  type MorynErrorContext,
  toErrorEnvelope
} from "../core/errors.js";
import { SYNC_MODES, initializeProjectConfig, resolveProjectContext, type SyncMode } from "../core/project.js";
import { RECORD_KINDS, RECORD_PRIORITIES, RECORD_SCOPES, RECORD_STATES } from "../core/schema.js";
import type { RecordKind, RecordPriority, RecordScope, RecordSource, RecordState } from "../core/types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../sync/git.js";

type Engine = ReturnType<typeof createEngine>;

const stringSchema = z.string();
const recordKindSchema = z.union([z.enum(RECORD_KINDS), stringSchema]);
const recordScopeSchema = z.union([z.enum(RECORD_SCOPES), stringSchema]);
const recordStateSchema = z.union([z.enum(RECORD_STATES), stringSchema]);
const recordPrioritySchema = z.union([z.enum(RECORD_PRIORITIES), stringSchema]);
const syncModeSchema = z.union([z.enum(SYNC_MODES), stringSchema]);
const numberSchema = z.number();
const coreValidatedBooleanSchema = z.unknown();
const nonEmptyStringSchema = stringSchema.min(1);
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
        | { argument: "text"; value: string }
        | { argument: "content"; value: Record<string, unknown> }
      >;
      expected: { kind: "choose_one"; arguments: ["text", "content"] };
      argument_sources: Record<"text" | "content", string>;
      retry_with: Array<{ argument: "text" | "content"; value_placeholder: string }>;
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
  | { argument: "text"; value: string }
  | { argument: "content"; value: Record<string, unknown> }
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

const sourceSchema = z.object({
  client: nonEmptyStringSchema.default("mcp"),
  session_id: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  device_id: nonEmptyStringSchema.optional()
});
const coreValidatedSourceSchema = z.object({
  client: z.unknown().optional().default("mcp"),
  session_id: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  device_id: nonEmptyStringSchema.optional()
});

async function resolveProjectInput(input: { project_id?: string; project_path?: string }): Promise<{ project_id?: string; tags: string[]; default_skills: string[] }> {
  if (input.project_id === undefined && input.project_path === undefined) {
    return { tags: [], default_skills: [] };
  }
  const project = await resolveProjectContext({ projectPath: input.project_path, projectId: input.project_id });
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
        repair: z.boolean().optional()
      }
    },
    async ({ repair }) => toolResult(async () => ({ ok: true, ...await initializeStore(options.storePath, { repair }) }))
  );

  server.registerTool(
    "project_init",
    {
      title: "Initialize Moryn Project Config",
      description: "Create or update a .moryn.json project config.",
      inputSchema: {
        path: z.string().min(1),
        project_id: stringSchema.optional(),
        tags: z.array(stringSchema).optional(),
        default_skills: z.array(stringSchema).optional(),
        sync_mode: syncModeSchema.optional(),
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
        limit: numberSchema.optional(),
        current_task: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ limit, current_task, sync_remote, agent }) => toolResult(async () => engine.listProjects({
      limit,
      current_task,
      sync_remote,
      agent
    }))
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
        index: z.boolean().optional(),
        operation: stringSchema.optional(),
        mcp_tool: stringSchema.optional(),
        cli_command: stringSchema.optional()
      }
    },
    async ({ index, operation, mcp_tool, cli_command }) => {
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
        const contract = getOperationContract(operation);
        if (!contract) {
          return {
            ...jsonResult(toErrorEnvelope(new OperationContractLookupError("operation", operation))),
            isError: true
          };
        }
        return jsonResult(contract, { pretty: false });
      }
      if (mcp_tool !== undefined) {
        const contract = getOperationContractByMcpTool(mcp_tool);
        if (!contract) {
          return {
            ...jsonResult(toErrorEnvelope(new OperationContractLookupError("mcp_tool", mcp_tool))),
            isError: true
          };
        }
        return jsonResult(contract, { pretty: false });
      }
      if (cli_command !== undefined) {
        const contract = getOperationContractByCliCommand(cli_command);
        if (!contract) {
          return {
            ...jsonResult(toErrorEnvelope(new OperationContractLookupError("cli_command", cli_command))),
            isError: true
          };
        }
        return jsonResult(contract, { pretty: false });
      }
      return jsonResult(getOperationContracts(), { pretty: false });
    }
  );

  server.registerTool(
    "boot",
    {
      title: "Boot Moryn Context",
      description: "Return a bounded context package for an agent starting work.",
      inputSchema: {
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        default_skills: z.array(stringSchema).optional()
      }
    },
    async ({ project_id, project_path, current_task, default_skills }) => toolResult(async () => {
      const project = await resolveProjectInput({ project_id, project_path });
      return engine.boot({
        project_id: project.project_id,
        default_skills: default_skills ?? project.default_skills,
        current_task
      });
    })
  );

  server.registerTool(
    "recall",
    {
      title: "Recall Moryn Records",
      description: "Search memory, skills, soul, session summaries, and agent notes.",
      inputSchema: {
        record_ids: z.array(stringSchema).optional(),
        query: stringSchema.optional(),
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        kinds: z.array(recordKindSchema).optional(),
        scopes: z.array(recordScopeSchema).optional(),
        types: z.array(stringSchema).optional(),
        states: z.array(recordStateSchema).optional(),
        tags: z.array(stringSchema).optional(),
        files: z.array(stringSchema).optional(),
        limit: numberSchema.optional()
      }
    },
    async ({ record_ids, query, project_id, project_path, kinds, scopes, types, states, tags, files, limit }) => toolResult(async () => {
      const project = await resolveProjectInput({ project_id, project_path });
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
        kind: recordKindSchema,
        type: stringSchema.optional(),
        scope: recordScopeSchema.optional(),
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        tags: z.array(stringSchema).optional(),
        text: stringSchema.optional(),
        content: z.record(z.string(), z.unknown()).optional(),
        state: recordStateSchema.optional(),
        confidence: numberSchema.optional(),
        priority: recordPrioritySchema.optional(),
        provenance: z.object({
          derived_from: z.array(stringSchema).optional(),
          reason: stringSchema.optional()
        }).optional(),
        confirmed: coreValidatedBooleanSchema.optional(),
        source: coreValidatedSourceSchema.optional()
      }
    },
    async (input) => toolResult(async () => {
      if (input.content && input.text !== undefined) {
        throw writeContentChoiceError([
          { argument: "text", value: input.text },
          { argument: "content", value: input.content as Record<string, unknown> }
        ]);
      }
      if (!input.content && input.text === undefined) {
        throw writeContentChoiceError();
      }
      const content = input.content ?? { text: input.text ?? "", format: "text" as const };
      const project = await resolveProjectInput({ project_id: input.project_id, project_path: input.project_path });
      const type = input.type ?? (input.kind === "session_summary" ? "summary" : undefined);
      const scope = input.scope ?? (input.kind === "session_summary" ? "project" : undefined);
      if (!type) {
        throw writeRequiredArgumentError("type");
      }
      if (!scope) {
        throw writeRequiredArgumentError("scope");
      }
      return engine.write({
        kind: input.kind as RecordKind,
        type,
        scope: scope as RecordScope,
        project_id: project.project_id,
        tags: [...project.tags, ...(input.tags ?? [])],
        content,
        state: input.state as RecordState | undefined,
        confidence: input.confidence,
        priority: input.priority as RecordPriority | undefined,
        source: (input.source ?? { client: "mcp" }) as RecordSource,
        confirmed: input.confirmed as boolean | undefined,
        provenance: input.provenance
      });
    })
  );

  server.registerTool(
    "revise",
    {
      title: "Revise Moryn Record",
      description: "Append a logical revision event for an existing record.",
      inputSchema: {
        record_id: stringSchema,
        patch: z.record(z.string(), z.unknown()),
        reason: stringSchema.optional(),
        confirmed: z.boolean().optional(),
        source: coreValidatedSourceSchema.optional()
      }
    },
    async ({ record_id, patch, reason, confirmed, source }) => toolResult(async () => engine.revise({
        record_id,
        patch,
        reason,
        confirmed,
        source: (source ?? { client: "mcp" }) as RecordSource
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
        record_id: stringSchema,
        target_state: recordStateSchema,
        reason: stringSchema.optional(),
        confirmed: z.boolean().optional(),
        source: coreValidatedSourceSchema.optional()
      }
    },
    async ({ record_id, target_state, reason, confirmed, source }) => toolResult(async () => engine.promote({
      record_id,
      target_state: target_state as RecordState,
      reason,
      source: (source ?? { client: "mcp" }) as RecordSource,
      confirmed
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
        record_id: stringSchema,
        reason: stringSchema.optional(),
        source: coreValidatedSourceSchema.optional()
      }
    },
    async ({ record_id, reason, source }) => toolResult(async () => engine.archive({
      record_id,
      reason,
      source: (source ?? { client: "mcp" }) as RecordSource
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
        record_id: stringSchema,
        reason: stringSchema.optional(),
        source: coreValidatedSourceSchema.optional()
      }
    },
    async ({ record_id, reason, source }) => toolResult(async () => engine.quarantine({
      record_id,
      reason,
      source: (source ?? { client: "mcp" }) as RecordSource
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
        record_id: stringSchema,
        linked_record_id: stringSchema,
        link_type: stringSchema,
        source: coreValidatedSourceSchema.optional()
      }
    },
    async ({ record_id, linked_record_id, link_type, source }) => toolResult(async () => engine.link({
      record_id,
      linked_record_id,
      link_type,
      source: (source ?? { client: "mcp" }) as RecordSource
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
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        cursor: stringSchema.optional(),
        current_task: stringSchema.optional(),
        limit: numberSchema.optional()
      }
    },
    async ({ project_id, project_path, cursor, current_task, limit }) => toolResult(async () => {
      const project = await resolveProjectInput({ project_id, project_path });
      return engine.refresh({
        project_id: project.project_id,
        cursor,
        current_task,
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
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ project_id, project_path, sync_remote, current_task, agent }) => toolResult(async () => agentDoctor({
      storePath: options.storePath,
      projectId: project_id,
      projectPath: project_path,
      syncRemote: sync_remote,
      currentTask: current_task,
      agent
    }))
  );

  server.registerTool(
    "agent_enter",
    {
      title: "Enter Moryn Agent Session",
      description: "One-call agent entrypoint: diagnose setup, discover projects when needed, or start a known project session.",
      inputSchema: {
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        refresh_since: stringSchema.optional(),
        limit: numberSchema.optional(),
        pull: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ project_id, project_path, sync_remote, current_task, refresh_since, limit, pull, agent }) => {
      const contextArguments = compactUndefined({
        project_id,
        project_path,
        sync_remote,
        current_task,
        refresh_since,
        limit,
        pull,
        agent
      });
      return toolResult(async () => agentEnter({
        storePath: options.storePath,
        projectId: project_id,
        projectPath: project_path,
        syncRemote: sync_remote,
        currentTask: current_task,
        refreshSince: refresh_since,
        limit,
        pull,
        agent
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
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ project_id, project_path, sync_remote, current_task, agent }) => toolResult(async () => agentGuide({
      storePath: options.storePath,
      projectId: project_id,
      projectPath: project_path,
      syncRemote: sync_remote,
      currentTask: current_task,
      agent
    }))
  );

  server.registerTool(
    "agent_start",
    {
      title: "Start Moryn Agent Session",
      description: "Low-friction agent startup: pull sync, resolve project context, boot context, and refresh recent changes.",
      inputSchema: {
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        refresh_since: stringSchema.optional(),
        limit: numberSchema.optional(),
        pull: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ project_id, project_path, sync_remote, current_task, refresh_since, limit, pull, agent }) => {
      const contextArguments = compactUndefined({
        project_id,
        project_path,
        sync_remote,
        current_task,
        refresh_since,
        limit,
        pull,
        agent
      });
      return toolResult(async () => agentStart({
        storePath: options.storePath,
        projectId: project_id,
        projectPath: project_path,
        syncRemote: sync_remote,
        currentTask: current_task,
        refreshSince: refresh_since,
        limit,
        pull,
        agent
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
        summary: stringSchema,
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        push: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ summary, project_id, project_path, sync_remote, current_task, push, agent }) => {
      const contextInput = {
        summary,
        project_id,
        project_path,
        sync_remote,
        current_task,
        push,
        agent
      };
      const contextArguments = compactUndefined(contextInput);
      return toolResult(async () => agentFinish({
        storePath: options.storePath,
        projectId: project_id,
        projectPath: project_path,
        syncRemote: sync_remote,
        currentTask: current_task,
        summary,
        push,
        agent
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
        status: stringSchema,
        project_id: stringSchema.optional(),
        project_path: stringSchema.optional(),
        sync_remote: stringSchema.optional(),
        current_task: stringSchema.optional(),
        push: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ status, project_id, project_path, sync_remote, current_task, push, agent }) => {
      const contextInput = {
        status,
        project_id,
        project_path,
        sync_remote,
        current_task,
        push,
        agent
      };
      const contextArguments = compactUndefined(contextInput);
      return toolResult(async () => agentStatus({
        storePath: options.storePath,
        projectId: project_id,
        projectPath: project_path,
        syncRemote: sync_remote,
        currentTask: current_task,
        status,
        push,
        agent
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
        remote: stringSchema
      }
    },
    async ({ remote }) => toolResult(async () => initializeGitSync(options.storePath, remote))
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
        message: stringSchema.optional()
      }
    },
    async ({ message }) => toolResult(async () => pushGitSync(options.storePath, { message }))
  );

  server.registerTool(
    "list_recent",
    {
      title: "List Recent Moryn Records",
      description: "Return recently updated records.",
      inputSchema: {
        limit: numberSchema.optional()
      }
    },
    async ({ limit }) => toolResult(async () => engine.listRecent(limit))
  );

  await server.connect(new StdioServerTransport());
}
