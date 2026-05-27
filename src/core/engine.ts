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
  record_ids?: string[];
  query?: string;
  project_id?: string;
  kinds?: RecordKind[];
  scopes?: RecordScope[];
  types?: string[];
  states?: RecordState[];
  tags?: string[];
  files?: string[];
  limit?: number;
}

interface RefreshInput {
  project_id?: string;
  cursor?: string;
  current_task?: string;
  limit?: number;
}

interface BootInput {
  project_id?: string;
  default_skills?: string[];
}

interface StateChangeInput {
  record_id: string;
  reason?: string;
  source?: RecordSource;
}

function textOf(record: MemoraRecord): string {
  return String(record.content.text ?? "");
}

function matchesAny(values: string[], filters: string[] | undefined): boolean {
  return !filters?.length || filters.some((filter) => values.includes(filter));
}

function recordProjectMatches(record: MemoraRecord, projectId: string | undefined): boolean {
  return !projectId || record.project_id === projectId || record.scope === "global";
}

function isVisibleByDefault(record: MemoraRecord): boolean {
  return record.state !== "archived" && record.state !== "quarantined";
}

function isTrustedForBoot(record: MemoraRecord): boolean {
  return record.state === "canonical";
}

function includesHiddenState(input: RecallInput): boolean {
  return input.states?.some((state) => state === "archived" || state === "quarantined") ?? false;
}

function skillMatchesSelector(record: MemoraRecord, selector: string): boolean {
  const normalized = selector.toLowerCase();
  return record.id === selector
    || record.type.toLowerCase() === normalized
    || record.tags.some((tag) => tag.toLowerCase() === normalized)
    || String(record.content.name ?? "").toLowerCase() === normalized
    || textOf(record).toLowerCase().includes(normalized);
}

function isProjectSkill(record: MemoraRecord, projectId: string | undefined): boolean {
  return record.kind === "skill"
    && Boolean(projectId)
    && (record.project_id === projectId || record.tags.includes(projectId as string));
}

function bootSkills(records: MemoraRecord[], input: BootInput): MemoraRecord[] {
  const selectors = input.default_skills ?? [];
  const selected = records.filter((record) => record.kind === "skill" && (
    isProjectSkill(record, input.project_id)
    || selectors.some((selector) => skillMatchesSelector(record, selector))
  ));
  return [...new Map(selected.map((record) => [record.id, record])).values()];
}

function reasonAndScore(record: MemoraRecord, input: RecallInput): { score: number; reason: string[] } {
  let score = 0;
  const reason: string[] = [];

  if (input.record_ids?.includes(record.id)) {
    score += 100;
    reason.push("record_id_match");
  }
  if (input.project_id && record.project_id === input.project_id) {
    score += 10;
    reason.push("same_project");
  } else if (record.scope === "global") {
    score += 4;
    reason.push("global");
  } else {
    reason.push(record.scope);
  }
  if (record.state === "canonical") {
    score += 8;
    reason.push("canonical");
  } else if (record.state === "candidate") {
    score += 4;
    reason.push("candidate");
  } else {
    reason.push(record.state);
  }
  if (record.priority === "high") {
    score += 5;
    reason.push("high_priority");
  }
  for (const tag of input.tags ?? []) {
    if (record.tags.includes(tag)) {
      score += 5;
      reason.push(`tag_match:${tag}`);
    }
  }
  for (const file of input.files ?? []) {
    const haystack = `${textOf(record)} ${record.tags.join(" ")}`.toLowerCase();
    if (haystack.includes(file.toLowerCase())) {
      score += 6;
      reason.push(`file_match:${file}`);
    }
  }
  if (input.query) {
    const haystack = `${textOf(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
    for (const token of input.query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) {
        score += 3;
        reason.push(`text_match:${token}`);
      }
    }
  }
  return { score, reason: [...new Set(reason)] };
}

function matchesQuery(result: { reason: string[] }, input: RecallInput): boolean {
  if (!input.query || input.record_ids?.length) return true;
  return result.reason.some((reason) => reason.startsWith("text_match:"));
}

function summarizeRecord(record: MemoraRecord): string {
  return textOf(record) || `${record.kind}:${record.type}`;
}

function taskTokens(task: string | undefined): string[] {
  return (task ?? "").toLowerCase().split(/\W+/).filter((token) => token.length >= 3);
}

function matchesCurrentTask(record: MemoraRecord, currentTask: string | undefined): boolean {
  const tokens = taskTokens(currentTask);
  if (!tokens.length) return false;
  const haystack = `${textOf(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function refreshImportance(record: MemoraRecord, currentTask: string | undefined): { importance: "silent" | "notice" | "interrupt"; reason?: string } {
  if (record.state === "raw" || record.kind === "session_summary" || record.kind === "agent_note") return { importance: "silent" };
  const interruptCandidate = record.type === "blocker" || record.type === "warning" || record.type === "conflict" || record.priority === "high";
  if (interruptCandidate) {
    if (!currentTask) return { importance: "interrupt" };
    if (matchesCurrentTask(record, currentTask)) return { importance: "interrupt", reason: "current_task_match" };
    return { importance: "silent" };
  }
  if (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75)) return { importance: "notice" };
  return { importance: "silent" };
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

    async archive(input: StateChangeInput) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "archive_record",
        record_id: input.record_id,
        reason: input.reason,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async quarantine(input: StateChangeInput) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "quarantine_record",
        record_id: input.record_id,
        reason: input.reason,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async link(input: { record_id: string; linked_record_id: string; link_type: string; source?: RecordSource }) {
      const event: MemoraEvent = {
        event_id: id("evt"),
        op: "link_records",
        record_id: input.record_id,
        linked_record_id: input.linked_record_id,
        link_type: input.link_type,
        created_at: now(),
        source: input.source ?? { client: "memora" }
      };
      await appendEvent(deps.storePath, event);
      return { event };
    },

    async recall(input: RecallInput) {
      const records = (await currentRecords())
        .filter((record) => includesHiddenState(input) || isVisibleByDefault(record))
        .filter((record) => recordProjectMatches(record, input.project_id))
        .filter((record) => !input.record_ids?.length || input.record_ids.includes(record.id))
        .filter((record) => !input.kinds?.length || input.kinds.includes(record.kind))
        .filter((record) => !input.scopes?.length || input.scopes.includes(record.scope))
        .filter((record) => !input.types?.length || input.types.includes(record.type))
        .filter((record) => !input.states?.length || input.states.includes(record.state))
        .filter((record) => matchesAny(record.tags, input.tags))
        .filter((record) => !input.files?.length || input.files.some((file) => `${textOf(record)} ${record.tags.join(" ")}`.toLowerCase().includes(file.toLowerCase())))
        .map((record) => ({ record, ...reasonAndScore(record, input) }))
        .filter((result) => matchesQuery(result, input))
        .filter((result) => result.score > 0 || (!input.query && !input.record_ids?.length))
        .sort((a, b) => b.score - a.score)
        .slice(0, input.limit ?? 10);
      return { results: records };
    },

    async boot(input: BootInput) {
      const visibleRecords = (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => recordProjectMatches(record, input.project_id));
      const records = visibleRecords
        .filter(isTrustedForBoot)
      const recent = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const cursor = [...visibleRecords].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_at ?? new Date().toISOString();
      return {
        profile: {
          user_preferences: records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "preference"),
          soul: records.filter((record) => record.kind === "soul"),
          global_rules: records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "rule")
        },
        project: {
          summary: "",
          tech_stack: [],
          active_goals: [],
          important_decisions: records.filter((record) => record.type === "decision" && record.project_id === input.project_id),
          warnings: records.filter((record) => (record.type === "warning" || record.type === "blocker") && record.project_id === input.project_id)
        },
        skills: bootSkills(records, input),
        recent_changes: recent.filter((record) => record.kind !== "soul").slice(0, 5),
        sync: { cursor, remote_has_updates: false }
      };
    },

    async refresh(input: RefreshInput) {
      const records = (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => recordProjectMatches(record, input.project_id))
        .filter((record) => !input.cursor || record.updated_at > input.cursor)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      const changes = records
        .map((record) => {
          const importance = refreshImportance(record, input.current_task);
          return {
            record_id: record.id,
            importance: importance.importance,
            reason: importance.reason,
            summary: summarizeRecord(record),
            recommended_action: record.state === "raw" ? "ignore unless relevant" : "call recall with record_id"
          };
        })
        .filter((change) => change.importance !== "silent")
        .slice(0, input.limit ?? 20);
      const latest = records.at(-1)?.updated_at ?? input.cursor ?? new Date().toISOString();
      return {
        cursor: latest,
        changes,
        should_interrupt: changes.some((change) => change.importance === "interrupt")
      };
    },

    async listRecent(limit = 20) {
      return (await currentRecords()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, limit);
    }
  };

  return engine;
}
