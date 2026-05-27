import { appendEvent, readEvents } from "./store.js";
import { replayEvents } from "./replay.js";
import { detectSensitiveContent } from "./sensitive.js";
import type { MemoraEvent, MemoraRecord, RecordKind, RecordScope, RecordSource, RecordState } from "./types.js";
import { createId } from "./id.js";

interface EngineDeps {
  storePath: string;
  now?: () => string;
  id?: (prefix: string) => string;
}

interface WriteInput {
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  tags?: string[];
  content: Record<string, unknown> & { text?: string; format?: "text" | "json" };
  state?: RecordState;
  confidence?: number;
  priority?: "low" | "normal" | "high";
  source: RecordSource;
}

interface RecallInput {
  query?: string;
  project_id?: string;
  kinds?: RecordKind[];
  limit?: number;
}

function textOf(record: MemoraRecord): string {
  return String(record.content.text ?? "");
}

function queryScore(record: MemoraRecord, query: string | undefined, projectId: string | undefined): number {
  let score = 0;
  if (projectId && record.project_id === projectId) score += 10;
  if (record.scope === "global") score += 2;
  if (record.state === "canonical") score += 8;
  if (record.state === "candidate") score += 4;
  if (record.priority === "high") score += 5;
  if (query) {
    const haystack = `${textOf(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
    for (const token of query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) score += 3;
    }
  }
  return score;
}

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? createId;

  async function currentRecords(): Promise<MemoraRecord[]> {
    return [...replayEvents(await readEvents(deps.storePath)).values()];
  }

  const engine = {
    async write(input: WriteInput) {
      const createdAt = now();
      const text = typeof input.content.text === "string" ? input.content.text : JSON.stringify(input.content);
      const sensitive = detectSensitiveContent(text);
      const state = sensitive.sensitive ? "quarantined" : (input.state ?? (input.kind === "agent_note" ? "raw" : "candidate"));
      const record: MemoraRecord = {
        id: id("rec"),
        kind: input.kind,
        type: input.type,
        scope: input.scope,
        project_id: input.project_id,
        tags: input.tags ?? [],
        content: input.content,
        state,
        confidence: input.confidence ?? 0.5,
        priority: input.priority ?? "normal",
        visibility: state === "quarantined" ? "quarantined" : state === "archived" ? "archived" : "active",
        created_at: createdAt,
        updated_at: createdAt,
        source: input.source
      };
      const event: MemoraEvent = { event_id: id("evt"), op: "upsert_record", record, created_at: createdAt, source: input.source };
      await appendEvent(deps.storePath, event);
      return {
        record,
        warning: sensitive.sensitive ? { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason } : undefined
      };
    },

    async revise(input: { record_id: string; patch: Record<string, unknown>; reason?: string; source?: RecordSource }) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "revise_record",
        record_id: input.record_id,
        patch: input.patch,
        reason: input.reason,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async promote(input: { record_id: string; target_state: RecordState; reason?: string; source?: RecordSource }) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "promote_record",
        record_id: input.record_id,
        target_state: input.target_state,
        reason: input.reason,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async recall(input: RecallInput) {
      const records = (await currentRecords())
        .filter((record) => record.state !== "archived" && record.state !== "quarantined")
        .filter((record) => !input.kinds || input.kinds.includes(record.kind))
        .map((record) => ({
          record,
          score: queryScore(record, input.query, input.project_id),
          reason: [record.project_id === input.project_id ? "same_project" : record.scope, record.state]
        }))
        .filter((result) => result.score > 0 || !input.query)
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10);
      return { results: records };
    },

    async boot(input: { project_id?: string }) {
      const recall = await engine.recall({ project_id: input.project_id, limit: 10 });
      return {
        profile: { user_preferences: [], soul: [], global_rules: [] },
        project: {
          summary: "",
          tech_stack: [],
          active_goals: [],
          important_decisions: recall.results.filter((r) => r.record.type === "decision").map((r) => r.record),
          warnings: recall.results.filter((r) => r.record.type === "warning" || r.record.type === "blocker").map((r) => r.record)
        },
        skills: recall.results.filter((r) => r.record.kind === "skill").map((r) => r.record),
        recent_changes: [],
        sync: { cursor: new Date().toISOString(), remote_has_updates: false }
      };
    },

    async listRecent(limit = 20) {
      return (await currentRecords()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
    }
  };

  return engine;
}
