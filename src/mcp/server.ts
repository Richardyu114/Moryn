import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initializeStore } from "../core/config.js";
import { rebuildDerivedViews } from "../core/derived.js";
import type { createEngine } from "../core/engine.js";
import { initializeProjectConfig, resolveProjectContext } from "../core/project.js";
import type { RecordKind, RecordScope, RecordSource, RecordState } from "../core/types.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "../sync/git.js";

type Engine = ReturnType<typeof createEngine>;

const recordKindSchema = z.enum(["memory", "skill", "soul", "session_summary", "agent_note"]);
const recordScopeSchema = z.enum(["global", "project", "topic", "session", "artifact"]);
const recordStateSchema = z.enum(["raw", "candidate", "canonical", "archived", "quarantined"]);

const sourceSchema = z.object({
  client: z.string().min(1).default("mcp"),
  session_id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  device_id: z.string().min(1).optional()
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

export async function runMcpServer(engine: Engine, options: { storePath: string }): Promise<void> {
  const server = new McpServer({
    name: "memora",
    version: "0.1.0"
  });

  server.registerTool(
    "init",
    {
      title: "Initialize Memora Store",
      description: "Create or update the local Memora store configuration and directories.",
      inputSchema: {}
    },
    async () => jsonResult({ ok: true, ...await initializeStore(options.storePath) })
  );

  server.registerTool(
    "project_init",
    {
      title: "Initialize Memora Project Config",
      description: "Create or update a .memora.json project config.",
      inputSchema: {
        path: z.string().min(1),
        project_id: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).optional(),
        default_skills: z.array(z.string().min(1)).optional(),
        sync_mode: z.enum(["manual", "session", "auto"]).optional()
      }
    },
    async ({ path, project_id, tags, default_skills, sync_mode }) => jsonResult({
      ok: true,
      ...await initializeProjectConfig(path, {
        project_id,
        tags,
        default_skills,
        sync: { mode: sync_mode ?? "session" }
      })
    })
  );

  server.registerTool(
    "boot",
    {
      title: "Boot Memora Context",
      description: "Return a bounded context package for an agent starting work.",
      inputSchema: {
        project_id: z.string().min(1).optional(),
        project_path: z.string().min(1).optional(),
        default_skills: z.array(z.string().min(1)).optional()
      }
    },
    async ({ project_id, project_path, default_skills }) => {
      const project = await resolveProjectInput({ project_id, project_path });
      return jsonResult(await engine.boot({
        project_id: project.project_id,
        default_skills: default_skills ?? project.default_skills
      }));
    }
  );

  server.registerTool(
    "recall",
    {
      title: "Recall Memora Records",
      description: "Search memory, skills, soul, session summaries, and agent notes.",
      inputSchema: {
        record_ids: z.array(z.string().min(1)).optional(),
        query: z.string().optional(),
        project_id: z.string().min(1).optional(),
        project_path: z.string().min(1).optional(),
        kinds: z.array(recordKindSchema).optional(),
        scopes: z.array(recordScopeSchema).optional(),
        types: z.array(z.string().min(1)).optional(),
        states: z.array(recordStateSchema).optional(),
        tags: z.array(z.string().min(1)).optional(),
        files: z.array(z.string().min(1)).optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ record_ids, query, project_id, project_path, kinds, scopes, types, states, tags, files, limit }) => {
      const project = await resolveProjectInput({ project_id, project_path });
      return jsonResult(await engine.recall({
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
      }));
    }
  );

  server.registerTool(
    "write",
    {
      title: "Write Memora Record",
      description: "Append a new Memora record event.",
      inputSchema: {
        kind: recordKindSchema,
        type: z.string().min(1),
        scope: recordScopeSchema,
        project_id: z.string().min(1).optional(),
        project_path: z.string().min(1).optional(),
        tags: z.array(z.string()).optional(),
        text: z.string().optional(),
        content: z.record(z.string(), z.unknown()).optional(),
        state: recordStateSchema.optional(),
        confidence: z.number().min(0).max(1).optional(),
        priority: z.enum(["low", "normal", "high"]).optional(),
        source: sourceSchema.optional()
      }
    },
    async (input) => {
      const content = input.content ?? { text: input.text ?? "", format: "text" as const };
      const project = await resolveProjectInput({ project_id: input.project_id, project_path: input.project_path });
      return jsonResult(await engine.write({
        kind: input.kind as RecordKind,
        type: input.type,
        scope: input.scope as RecordScope,
        project_id: project.project_id,
        tags: [...project.tags, ...(input.tags ?? [])],
        content,
        state: input.state as RecordState | undefined,
        confidence: input.confidence,
        priority: input.priority,
        source: (input.source ?? { client: "mcp" }) as RecordSource
      }));
    }
  );

  server.registerTool(
    "revise",
    {
      title: "Revise Memora Record",
      description: "Append a logical revision event for an existing record.",
      inputSchema: {
        record_id: z.string().min(1),
        patch: z.record(z.string(), z.unknown()),
        reason: z.string().optional(),
        source: sourceSchema.optional()
      }
    },
    async ({ record_id, patch, reason, source }) => jsonResult(await engine.revise({
      record_id,
      patch,
      reason,
      source: source as RecordSource | undefined
    }))
  );

  server.registerTool(
    "promote",
    {
      title: "Promote Memora Record",
      description: "Change a record state by appending a promotion/state event.",
      inputSchema: {
        record_id: z.string().min(1),
        target_state: recordStateSchema,
        reason: z.string().optional(),
        source: sourceSchema.optional()
      }
    },
    async ({ record_id, target_state, reason, source }) => jsonResult(await engine.promote({
      record_id,
      target_state: target_state as RecordState,
      reason,
      source: source as RecordSource | undefined
    }))
  );

  server.registerTool(
    "archive",
    {
      title: "Archive Memora Record",
      description: "Hide a record from default boot and recall while preserving history.",
      inputSchema: {
        record_id: z.string().min(1),
        reason: z.string().optional(),
        source: sourceSchema.optional()
      }
    },
    async ({ record_id, reason, source }) => jsonResult(await engine.archive({
      record_id,
      reason,
      source: source as RecordSource | undefined
    }))
  );

  server.registerTool(
    "quarantine",
    {
      title: "Quarantine Memora Record",
      description: "Mark a record as sensitive or unsafe so it is excluded by default.",
      inputSchema: {
        record_id: z.string().min(1),
        reason: z.string().optional(),
        source: sourceSchema.optional()
      }
    },
    async ({ record_id, reason, source }) => jsonResult(await engine.quarantine({
      record_id,
      reason,
      source: source as RecordSource | undefined
    }))
  );

  server.registerTool(
    "link",
    {
      title: "Link Memora Records",
      description: "Append a relationship from one record to another.",
      inputSchema: {
        record_id: z.string().min(1),
        linked_record_id: z.string().min(1),
        link_type: z.string().min(1),
        source: sourceSchema.optional()
      }
    },
    async ({ record_id, linked_record_id, link_type, source }) => jsonResult(await engine.link({
      record_id,
      linked_record_id,
      link_type,
      source: source as RecordSource | undefined
    }))
  );

  server.registerTool(
    "refresh",
    {
      title: "Refresh Memora Changes",
      description: "Return important changes since a cursor for periodic agent memory refresh.",
      inputSchema: {
        project_id: z.string().min(1).optional(),
        project_path: z.string().min(1).optional(),
        cursor: z.string().optional(),
        current_task: z.string().optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ project_id, project_path, cursor, current_task, limit }) => {
      const project = await resolveProjectInput({ project_id, project_path });
      return jsonResult(await engine.refresh({
        project_id: project.project_id,
        cursor,
        current_task,
        limit
      }));
    }
  );

  server.registerTool(
    "rebuild",
    {
      title: "Rebuild Memora Derived Views",
      description: "Regenerate snapshots and indexes from append-only events.",
      inputSchema: {}
    },
    async () => jsonResult(await rebuildDerivedViews(options.storePath))
  );

  server.registerTool(
    "sync_init",
    {
      title: "Initialize Memora Git Sync",
      description: "Initialize or connect the local Memora store to a Git remote.",
      inputSchema: {
        remote: z.string().min(1)
      }
    },
    async ({ remote }) => jsonResult(await initializeGitSync(options.storePath, remote))
  );

  server.registerTool(
    "sync_status",
    {
      title: "Get Memora Git Sync Status",
      description: "Return Git sync configuration and local/remote status.",
      inputSchema: {}
    },
    async () => jsonResult(await getGitSyncStatus(options.storePath))
  );

  server.registerTool(
    "sync_pull",
    {
      title: "Pull Memora Git Sync",
      description: "Pull remote event history into the local Memora store.",
      inputSchema: {}
    },
    async () => jsonResult(await pullGitSync(options.storePath))
  );

  server.registerTool(
    "sync_push",
    {
      title: "Push Memora Git Sync",
      description: "Commit and push local event history from the Memora store.",
      inputSchema: {
        message: z.string().min(1).optional()
      }
    },
    async ({ message }) => jsonResult(await pushGitSync(options.storePath, { message }))
  );

  server.registerTool(
    "list_recent",
    {
      title: "List Recent Memora Records",
      description: "Return recently updated records.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ limit }) => jsonResult(await engine.listRecent(limit))
  );

  await server.connect(new StdioServerTransport());
}
