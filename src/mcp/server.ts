import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentFinish, agentStart } from "../core/agent-lifecycle.js";
import { initializeStore } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";
import type { createEngine } from "../core/engine.js";
import { toErrorEnvelope } from "../core/errors.js";
import { initializeProjectConfig, resolveProjectContext } from "../core/project.js";
import type { RecordKind, RecordScope, RecordSource, RecordState } from "../core/types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../sync/git.js";

type Engine = ReturnType<typeof createEngine>;

const recordKindSchema = z.enum(["memory", "skill", "soul", "session_summary", "agent_note"]);
const recordScopeSchema = z.enum(["global", "project", "topic", "session", "artifact"]);
const recordStateSchema = z.enum(["raw", "candidate", "canonical", "archived", "quarantined"]);
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

async function toolResult(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn());
  } catch (error) {
    return {
      ...jsonResult(toErrorEnvelope(error)),
      isError: true
    };
  }
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
      inputSchema: {}
    },
    async () => toolResult(async () => ({ ok: true, ...await initializeStore(options.storePath) }))
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
        sync_mode: z.enum(["manual", "session", "interval"]).optional()
      }
    },
    async ({ path, project_id, tags, default_skills, sync_mode }) => toolResult(async () => ({
      ok: true,
      ...await initializeProjectConfig(path, {
        project_id,
        tags,
        default_skills,
        sync: sync_mode === undefined ? undefined : { mode: sync_mode }
      })
    }))
  );

  server.registerTool(
    "boot",
    {
      title: "Boot Moryn Context",
      description: "Return a bounded context package for an agent starting work.",
      inputSchema: {
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
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
        priority: z.enum(["low", "normal", "high"]).optional(),
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
      }))
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
    }))
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
    }))
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
    }))
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
    }))
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
    "agent_start",
    {
      title: "Start Moryn Agent Session",
      description: "Low-friction agent startup: pull sync, resolve project context, boot context, and refresh recent changes.",
      inputSchema: {
        project_id: nonEmptyStringSchema.optional(),
        project_path: nonEmptyStringSchema.optional(),
        current_task: nonEmptyStringSchema.optional(),
        refresh_since: nonEmptyStringSchema.optional(),
        limit: z.number().int().positive().max(100).optional(),
        pull: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ project_id, project_path, current_task, refresh_since, limit, pull, agent }) => toolResult(async () => agentStart({
      storePath: options.storePath,
      projectId: project_id,
      projectPath: project_path,
      currentTask: current_task,
      refreshSince: refresh_since,
      limit,
      pull,
      agent
    }))
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
        current_task: nonEmptyStringSchema.optional(),
        push: z.boolean().optional(),
        agent: sourceSchema.optional()
      }
    },
    async ({ summary, project_id, project_path, current_task, push, agent }) => toolResult(async () => agentFinish({
      storePath: options.storePath,
      projectId: project_id,
      projectPath: project_path,
      currentTask: current_task,
      summary,
      push,
      agent
    }))
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
