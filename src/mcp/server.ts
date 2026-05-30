import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getOperationContracts, getSelectionSourceContracts } from "../index.js";
import { agentDoctor, agentEnter, agentFinish, agentGuide, agentStart, agentStatus } from "../core/agent-lifecycle.js";
import { initializeStore } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";
import type { createEngine } from "../core/engine.js";
import {
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
import { SYNC_MODES, initializeProjectConfig, resolveProjectContext } from "../core/project.js";
import { RECORD_KINDS, RECORD_PRIORITIES, RECORD_SCOPES, RECORD_STATES } from "../core/schema.js";
import type { RecordKind, RecordScope, RecordSource, RecordState } from "../core/types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../sync/git.js";

type Engine = ReturnType<typeof createEngine>;

const recordKindSchema = z.enum(RECORD_KINDS);
const recordScopeSchema = z.enum(RECORD_SCOPES);
const recordStateSchema = z.enum(RECORD_STATES);
const nonEmptyStringSchema = z.string().min(1);

const sourceSchema = z.object({
  client: nonEmptyStringSchema.default("mcp"),
  session_id: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema.optional(),
  device_id: nonEmptyStringSchema.optional()
});

async function resolveProjectInput(input: { project_id?: string; project_path?: string }): Promise<{ project_id?: string; tags: string[]; default_skills: string[] }> {
  if (!input.project_id && !input.project_path) {
    return { tags: [], default_skills: [] };
  }
  const project = await resolveProjectContext({ projectPath: input.project_path, projectId: input.project_id });
  return {
    project_id: project.project_id,
    tags: project.config?.tags ?? [],
    default_skills: project.config?.default_skills ?? []
  };
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
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
        project_id: nonEmptyStringSchema.optional(),
        tags: z.array(nonEmptyStringSchema).optional(),
        default_skills: z.array(nonEmptyStringSchema).optional(),
        sync_mode: z.enum(SYNC_MODES).optional(),
        repair: z.boolean().optional()
      }
    },
    async ({ path, project_id, tags, default_skills, sync_mode, repair }) => toolResult(async () => ({
      ok: true,
      ...await initializeProjectConfig(path, {
        project_id,
        tags,
        default_skills,
        sync: sync_mode === undefined ? undefined : { mode: sync_mode },
        repair
      })
    }))
  );

  server.registerTool(
    "project_list",
    {
      title: "List Moryn Projects",
      description: "Discover known project ids and recent project activity from the Moryn store.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
        current_task: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
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
      inputSchema: {}
    },
    async () => toolResult(async () => getOperationContracts())
  );

  server.registerTool(
    "boot",
    {
      title: "Boot Moryn Context",
      description: "Return a bounded context package for an agent starting work.",
      inputSchema: {
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
        default_skills: z.array(nonEmptyStringSchema).optional()
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
        record_ids: z.array(nonEmptyStringSchema).optional(),
        query: nonEmptyStringSchema.optional(),
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        kinds: z.array(recordKindSchema).optional(),
        scopes: z.array(recordScopeSchema).optional(),
        types: z.array(nonEmptyStringSchema).optional(),
        states: z.array(recordStateSchema).optional(),
        tags: z.array(nonEmptyStringSchema).optional(),
        files: z.array(nonEmptyStringSchema).optional(),
        limit: z.number().int().positive().max(100).optional()
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
        type: nonEmptyStringSchema.optional(),
        scope: recordScopeSchema.optional(),
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        tags: z.array(nonEmptyStringSchema).optional(),
        text: nonEmptyStringSchema.optional(),
        content: z.record(z.string(), z.unknown()).optional(),
        state: recordStateSchema.optional(),
        confidence: z.number().min(0).max(1).optional(),
        priority: z.enum(RECORD_PRIORITIES).optional(),
        provenance: z.object({
          derived_from: z.array(nonEmptyStringSchema).optional(),
          reason: nonEmptyStringSchema.optional()
        }).optional(),
        confirmed: z.boolean().optional(),
        source: sourceSchema.optional()
      }
    },
    async (input) => toolResult(async () => {
      if (input.content && input.text !== undefined) {
        throw new Error("Invalid argument: use either text or content, not both");
      }
      if (!input.content && input.text === undefined) {
        throw new Error("Invalid argument: write requires text or content");
      }
      const content = input.content ?? { text: input.text ?? "", format: "text" as const };
      const project = await resolveProjectInput({ project_id: input.project_id, project_path: input.project_path });
      const type = input.type ?? (input.kind === "session_summary" ? "summary" : undefined);
      const scope = input.scope ?? (input.kind === "session_summary" ? "project" : undefined);
      if (!type) {
        throw new Error("Invalid argument: write requires type");
      }
      if (!scope) {
        throw new Error("Invalid argument: write requires scope");
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
        priority: input.priority,
        source: (input.source ?? { client: "mcp" }) as RecordSource,
        confirmed: input.confirmed,
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
        record_id: nonEmptyStringSchema,
        patch: z.record(z.string(), z.unknown()),
        reason: nonEmptyStringSchema.optional(),
        confirmed: z.boolean().optional(),
        source: sourceSchema.optional()
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
        record_id: nonEmptyStringSchema,
        target_state: recordStateSchema,
        reason: nonEmptyStringSchema.optional(),
        confirmed: z.boolean().optional(),
        source: sourceSchema.optional()
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
        record_id: nonEmptyStringSchema,
        reason: nonEmptyStringSchema.optional(),
        source: sourceSchema.optional()
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
        record_id: nonEmptyStringSchema,
        reason: nonEmptyStringSchema.optional(),
        source: sourceSchema.optional()
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
        record_id: nonEmptyStringSchema,
        linked_record_id: nonEmptyStringSchema,
        link_type: nonEmptyStringSchema,
        source: sourceSchema.optional()
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
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        cursor: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
        limit: z.number().int().positive().max(100).optional()
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
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
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
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
        refresh_since: nonEmptyStringSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
        pull: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ project_id, project_path, sync_remote, current_task, refresh_since, limit, pull, agent }) => toolResult(async () => agentEnter({
      storePath: options.storePath,
      projectId: project_id,
      projectPath: project_path,
      syncRemote: sync_remote,
      currentTask: current_task,
      refreshSince: refresh_since,
      limit,
      pull,
      agent
    }))
  );

  server.registerTool(
    "agent_guide",
    {
      title: "Guide Moryn Agent Workflow",
      description: "Return machine-readable lifecycle guidance and exact next tool arguments for agents.",
      inputSchema: {
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
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
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
        refresh_since: nonEmptyStringSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
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
        summary: nonEmptyStringSchema,
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
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
        status: nonEmptyStringSchema,
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        sync_remote: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
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
        remote: nonEmptyStringSchema
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
        message: nonEmptyStringSchema.optional()
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
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ limit }) => toolResult(async () => engine.listRecent(limit))
  );

  await server.connect(new StdioServerTransport());
}
