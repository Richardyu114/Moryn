import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { createEngine } from "../core/engine.js";
import type { RecordKind, RecordScope, RecordSource, RecordState } from "../core/types.js";

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

export async function runMcpServer(engine: Engine): Promise<void> {
  const server = new McpServer({
    name: "memora",
    version: "0.1.0"
  });

  server.registerTool(
    "boot",
    {
      title: "Boot Memora Context",
      description: "Return a bounded context package for an agent starting work.",
      inputSchema: {
        project_id: z.string().min(1).optional()
      }
    },
    async ({ project_id }) => jsonResult(await engine.boot({ project_id }))
  );

  server.registerTool(
    "recall",
    {
      title: "Recall Memora Records",
      description: "Search memory, skills, soul, session summaries, and agent notes.",
      inputSchema: {
        query: z.string().optional(),
        project_id: z.string().min(1).optional(),
        kinds: z.array(recordKindSchema).optional(),
        limit: z.number().int().positive().max(100).optional()
      }
    },
    async ({ query, project_id, kinds, limit }) => jsonResult(await engine.recall({
      query,
      project_id,
      kinds: kinds as RecordKind[] | undefined,
      limit
    }))
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
      return jsonResult(await engine.write({
        kind: input.kind as RecordKind,
        type: input.type,
        scope: input.scope as RecordScope,
        project_id: input.project_id,
        tags: input.tags,
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
