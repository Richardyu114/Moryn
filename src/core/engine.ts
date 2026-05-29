import { appendEvent, readEvents } from "./store.js";
import { rebuildDerivedViews } from "./derived.js";
import { applyRecordPatch, replayEvents } from "./replay.js";
import { isoDateTimeSchema, isValidPatchPath, recordKindSchema, recordPrioritySchema, recordScopeSchema, recordSourceSchema, recordStateSchema, parseRecord } from "./schema.js";
import { detectSensitiveContent, redactSensitiveContent, sensitiveScanText } from "./sensitive.js";
import type { MorynEvent, MorynRecord, RecordKind, RecordProvenance, RecordScope, RecordSource, RecordState } from "./types.js";
import { commandForPromoteContext, PROMOTE_CANDIDATE_WHEN, withNextActionMetadata, type MorynErrorNextAction } from "./errors.js";
import { createId } from "./id.js";
import { displayRecordText, searchableContentText, searchableRecordText } from "./content-text.js";
import { actionSafety } from "./action-safety.js";
import { withPhasesByName } from "./workflow.js";

interface EngineDeps {
  storePath: string;
  now?: () => string;
  id?: (prefix: string) => string;
  syncStatus?: () => Promise<{ behind?: number; remote_has_updates?: boolean }>;
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
  confirmed?: boolean;
  provenance?: RecordProvenance;
}

export interface EngineWarning {
  code: string;
  reason?: string;
  next_action?: MorynErrorNextAction;
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
  current_task?: string;
}

interface ListProjectsInput {
  limit?: number;
  current_task?: string;
  sync_remote?: string;
  agent?: RecordSource;
}

const START_LISTED_PROJECT_WHEN = "After choosing this project from project_list results.";
const RECALL_REFRESH_CHANGE_WHEN = "After refresh reports this change and the agent needs the full record content.";
const WRITE_CANDIDATE_RECORD_ID_SOURCE = "write.record.id";

function withActionInterfaces<T extends { tool: string; command: string; arguments: unknown }>(action: T) {
  return {
    ...action,
    interfaces: {
      cli: {
        command: action.command
      },
      mcp: {
        tool: action.tool,
        arguments: action.arguments
      }
    }
  };
}

function withProjectListNextMetadata<T extends {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
}>(
  action: T
) {
  return {
    ...withActionInterfaces(action),
    safety: actionSafety(action),
    workflow: withPhasesByName({
      version: 1,
      start: "next",
      continue_from: ["project_list.projects_by_id.<project_id>.next", "project_list.projects[].next"],
      phases: [
        {
          phase: action.recommended_action,
          order: 1,
          action_source: "project_list.projects_by_id.<project_id>.next",
          tool: action.tool,
          required_when: action.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

function withRefreshChangeNextActionMetadata<T extends {
  recommended_action: string;
  tool: string;
  command: string;
  arguments: Record<string, unknown>;
  safe_to_run: boolean;
  required_when: string;
  required_fields: string[];
}>(
  action: T
) {
  return {
    ...withActionInterfaces(action),
    safety: actionSafety(action),
    workflow: withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: ["refresh.changes_by_record_id.<record_id>.next_action", "refresh.changes[].next_action"],
      phases: [
        {
          phase: action.recommended_action,
          order: 1,
          action_source: "refresh.changes_by_record_id.<record_id>.next_action",
          tool: action.tool,
          required_when: action.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

interface StateChangeInput {
  record_id: string;
  reason?: string;
  source?: RecordSource;
}

interface RevisionInput {
  record_id: string;
  patch: Record<string, unknown>;
  reason?: string;
  source?: RecordSource;
  confirmed?: boolean;
}

interface PromoteInput {
  record_id: string;
  target_state: RecordState;
  reason?: string;
  source?: RecordSource;
  confirmed?: boolean;
}

interface LinkInput {
  record_id: string;
  linked_record_id: string;
  link_type: string;
  source?: RecordSource;
}

function textOf(record: MorynRecord): string {
  return displayRecordText(record);
}

function searchableText(record: MorynRecord): string {
  return searchableRecordText(record);
}

function validateLimit(limit: number | undefined, fallback: number): number {
  const resolved = limit ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 100) {
    throw new Error("Invalid argument: Invalid limit; must be an integer between 1 and 100");
  }
  return resolved;
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateRecordId(recordId: unknown, name = "record_id"): void {
  if (typeof recordId !== "string" || !recordId.length) throw new Error(`Invalid argument: Invalid ${name}`);
}

function validateOptionalReason(reason: unknown): void {
  if (reason !== undefined && (typeof reason !== "string" || !reason.length)) throw new Error("Invalid argument: Invalid reason");
}

function validateOptionalSource(source: unknown): void {
  if (source !== undefined && !recordSourceSchema.safeParse(source).success) throw new Error("Invalid argument: Invalid source.client");
}

function validateOptionalConfirmed(confirmed: unknown): void {
  if (confirmed !== undefined && typeof confirmed !== "boolean") throw new Error("Invalid argument: Invalid confirmed");
}

function validateOptionalString(value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.length)) throw new Error(`Invalid argument: Invalid ${name}`);
}

function validateOptionalStringArray(value: unknown, name: string): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0))) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateOptionalEnumArray<T extends string>(value: unknown, name: string, schema: { safeParse: (value: unknown) => { success: boolean } }): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every((item): item is T => schema.safeParse(item).success))) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function validateWriteInput(input: WriteInput): void {
  assertPlainObject(input, "write input");
  if (!recordKindSchema.safeParse(input.kind).success) throw new Error("Invalid argument: Invalid kind");
  if (typeof input.type !== "string" || !input.type.length) throw new Error("Invalid argument: Invalid type");
  if (!recordScopeSchema.safeParse(input.scope).success) throw new Error("Invalid argument: Invalid scope");
  if (input.project_id !== undefined && (typeof input.project_id !== "string" || !input.project_id.length)) {
    throw new Error("Invalid argument: Invalid project_id");
  }
  if (input.scope === "project" && input.project_id === undefined) {
    throw new Error("Invalid argument: project_id is required for project scope");
  }
  if (input.tags !== undefined && (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string" && tag.length > 0))) {
    throw new Error("Invalid argument: Invalid tags");
  }
  if (typeof input.content !== "object" || input.content === null || Array.isArray(input.content) || Object.keys(input.content).length === 0) {
    throw new Error("Invalid argument: Invalid content");
  }
  if (input.content.text !== undefined && (typeof input.content.text !== "string" || !input.content.text.length)) {
    throw new Error("Invalid argument: Invalid content.text");
  }
  if (input.content.format !== undefined && input.content.format !== "text" && input.content.format !== "json") {
    throw new Error("Invalid argument: Invalid content.format");
  }
  if (input.state !== undefined && !recordStateSchema.safeParse(input.state).success) throw new Error("Invalid argument: Invalid state");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("Invalid argument: Invalid confidence");
  }
  if (input.priority !== undefined && !recordPrioritySchema.safeParse(input.priority).success) throw new Error("Invalid argument: Invalid priority");
  if (!recordSourceSchema.safeParse(input.source).success) throw new Error("Invalid argument: Invalid source.client");
  validateOptionalConfirmed(input.confirmed);
  if (input.provenance !== undefined) {
    if (typeof input.provenance !== "object" || input.provenance === null || Array.isArray(input.provenance)) {
      throw new Error("Invalid argument: Invalid provenance");
    }
    if (input.provenance.derived_from !== undefined && (!Array.isArray(input.provenance.derived_from) || !input.provenance.derived_from.every((recordId) => typeof recordId === "string" && recordId.length > 0))) {
      throw new Error("Invalid argument: Invalid provenance.derived_from");
    }
    if (input.provenance.reason !== undefined && (typeof input.provenance.reason !== "string" || !input.provenance.reason.length)) {
      throw new Error("Invalid argument: Invalid provenance.reason");
    }
    if (
      input.provenance.method !== undefined
      && input.provenance.method !== "agent-proposed"
      && input.provenance.method !== "rule-promoted"
      && input.provenance.method !== "user-confirmed"
    ) {
      throw new Error("Invalid argument: Invalid provenance.method");
    }
    if (
      input.provenance.promoted_at !== undefined
      && !isoDateTimeSchema.safeParse(input.provenance.promoted_at).success
    ) {
      throw new Error("Invalid argument: Invalid provenance.promoted_at");
    }
  }
}

function validateRevisionInput(input: RevisionInput): void {
  assertPlainObject(input, "revise input");
  validateRecordId(input.record_id);
  if (
    typeof input.patch !== "object" ||
    input.patch === null ||
    Array.isArray(input.patch) ||
    Object.keys(input.patch).length === 0
  ) {
    throw new Error("Invalid argument: Invalid patch");
  }
  if (!Object.keys(input.patch).every(isValidPatchPath)) {
    throw new Error("Invalid argument: Invalid patch");
  }
  validateOptionalReason(input.reason);
  validateOptionalSource(input.source);
  validateOptionalConfirmed(input.confirmed);
}

function validatePromoteInput(input: PromoteInput): void {
  assertPlainObject(input, "promote input");
  validateRecordId(input.record_id);
  if (!recordStateSchema.safeParse(input.target_state).success) throw new Error("Invalid argument: Invalid target_state");
  validateOptionalReason(input.reason);
  validateOptionalSource(input.source);
  validateOptionalConfirmed(input.confirmed);
}

function validateStateChangeInput(input: StateChangeInput, name: string): void {
  assertPlainObject(input, name);
  validateRecordId(input.record_id);
  validateOptionalReason(input.reason);
  validateOptionalSource(input.source);
}

function validateLinkInput(input: LinkInput): void {
  assertPlainObject(input, "link input");
  validateRecordId(input.record_id);
  validateRecordId(input.linked_record_id, "linked_record_id");
  if (typeof input.link_type !== "string" || !input.link_type.length) throw new Error("Invalid argument: Invalid link_type");
  validateOptionalSource(input.source);
}

function validateRecallInput(input: RecallInput): void {
  assertPlainObject(input, "recall input");
  validateOptionalStringArray(input.record_ids, "record_ids");
  validateOptionalString(input.query, "query");
  validateOptionalString(input.project_id, "project_id");
  validateOptionalEnumArray<RecordKind>(input.kinds, "kinds", recordKindSchema);
  validateOptionalEnumArray<RecordScope>(input.scopes, "scopes", recordScopeSchema);
  validateOptionalStringArray(input.types, "types");
  validateOptionalEnumArray<RecordState>(input.states, "states", recordStateSchema);
  validateOptionalStringArray(input.tags, "tags");
  validateOptionalStringArray(input.files, "files");
}

function validateBootInput(input: BootInput): void {
  assertPlainObject(input, "boot input");
  validateOptionalString(input.project_id, "project_id");
  validateOptionalStringArray(input.default_skills, "default_skills");
  validateOptionalString(input.current_task, "current_task");
}

function validateRefreshInput(input: RefreshInput): void {
  assertPlainObject(input, "refresh input");
  validateOptionalString(input.project_id, "project_id");
  validateOptionalString(input.cursor, "cursor");
  if (input.cursor !== undefined && !isoDateTimeSchema.safeParse(input.cursor).success) {
    throw new Error("Invalid argument: Invalid cursor");
  }
  validateOptionalString(input.current_task, "current_task");
}

function validateListProjectsInput(input: ListProjectsInput): void {
  assertPlainObject(input, "list projects input");
  validateOptionalString(input.current_task, "current_task");
  validateOptionalString(input.sync_remote, "sync_remote");
  validateOptionalSource(input.agent);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendCommandOption(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined) return;
  parts.push(name, shellQuote(value));
}

function projectStartArguments(projectId: string, input: ListProjectsInput): {
  project_id: string;
  sync_remote?: string;
  current_task?: string;
  agent?: RecordSource;
} {
  return {
    project_id: projectId,
    sync_remote: input.sync_remote,
    current_task: input.current_task,
    agent: input.agent
  };
}

function projectStartCommand(projectId: string, input: ListProjectsInput): string {
  const parts = ["moryn", "agent", "start"];
  appendCommandOption(parts, "--project-id", projectId);
  appendCommandOption(parts, "--sync-remote", input.sync_remote);
  appendCommandOption(parts, "--current-task", input.current_task);
  appendCommandOption(parts, "--agent", input.agent?.client);
  appendCommandOption(parts, "--session-id", input.agent?.session_id);
  appendCommandOption(parts, "--model", input.agent?.model);
  appendCommandOption(parts, "--device-id", input.agent?.device_id);
  return parts.join(" ");
}

function recallRecordCommand(recordId: string, projectId: string | undefined): string {
  const parts = ["moryn", "recall"];
  appendCommandOption(parts, "--record-id", recordId);
  appendCommandOption(parts, "--project-id", projectId);
  return parts.join(" ");
}

function refreshChangeNextAction(record: MorynRecord, input: RefreshInput) {
  return withRefreshChangeNextActionMetadata({
    recommended_action: "call_recall_with_record_id",
    tool: "recall",
    safe_to_run: true,
    required_when: RECALL_REFRESH_CHANGE_WHEN,
    required_fields: [],
    command: recallRecordCommand(record.id, input.project_id),
    arguments: {
      record_ids: [record.id],
      ...(input.project_id ? { project_id: input.project_id } : {})
    }
  });
}

function matchesAny(values: string[], filters: string[] | undefined): boolean {
  return !filters?.length || filters.some((filter) => values.includes(filter));
}

function recordProjectMatches(record: MorynRecord, projectId: string | undefined): boolean {
  return !projectId || record.project_id === projectId || record.scope === "global";
}

function recordBootContextMatches(record: MorynRecord, projectId: string | undefined): boolean {
  return record.scope === "global" || (Boolean(projectId) && record.project_id === projectId);
}

function recordProjectMatchesRecall(record: MorynRecord, input: RecallInput): boolean {
  return Boolean(input.record_ids?.length) || recordProjectMatches(record, input.project_id);
}

function isVisibleByDefault(record: MorynRecord): boolean {
  return record.state !== "archived" && record.state !== "quarantined";
}

function isTrustedForBoot(record: MorynRecord): boolean {
  return record.state === "canonical";
}

function includesHiddenState(input: RecallInput): boolean {
  return input.states?.some((state) => state === "archived" || state === "quarantined") ?? false;
}

function includesRawState(input: RecallInput): boolean {
  return input.states?.includes("raw") ?? false;
}

function isVisibleInDefaultRecall(record: MorynRecord): boolean {
  return isVisibleByDefault(record) && record.state !== "raw";
}

function skillMatchesSelector(record: MorynRecord, selector: string): boolean {
  const normalized = selector.toLowerCase();
  return record.id === selector
    || record.type.toLowerCase() === normalized
    || record.tags.some((tag) => tag.toLowerCase() === normalized)
    || String(record.content.name ?? "").toLowerCase() === normalized
    || searchableText(record).toLowerCase().includes(normalized);
}

function isProjectSkill(record: MorynRecord, projectId: string | undefined): boolean {
  return record.kind === "skill"
    && Boolean(projectId)
    && (record.project_id === projectId || record.tags.includes(projectId as string));
}

function bootSkills(records: MorynRecord[], input: BootInput): MorynRecord[] {
  const selectors = input.default_skills ?? [];
  const selected = records.filter((record) => record.kind === "skill" && (
    isProjectSkill(record, input.project_id)
    || selectors.some((selector) => skillMatchesSelector(record, selector))
  ));
  return [...new Map(selected.map((record) => [record.id, record])).values()];
}

function projectMemory(records: MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return records.filter((record) => record.kind === "memory" && record.scope === "project" && record.project_id === projectId);
}

function projectScopedRecords(records: MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return records.filter((record) => record.scope === "project" && record.project_id === projectId);
}

function boundedBootTexts(records: MorynRecord[], limit = 5): string[] {
  const texts: string[] = [];
  for (const record of boundedBootRecords(records, records.length)) {
    const text = textOf(record);
    if (text && !texts.includes(text)) texts.push(text);
    if (texts.length >= limit) break;
  }
  return texts;
}

function isImportantBootRecent(record: MorynRecord): boolean {
  if (record.kind === "session_summary") return record.state !== "raw";
  return (record.kind === "memory" || record.kind === "skill")
    && (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75));
}

function bootPriorityScore(record: MorynRecord): number {
  return (record.priority === "high" ? 100 : 0) + recallSourceTrust(record).score;
}

function boundedBootRecords(records: MorynRecord[], limit = 5): MorynRecord[] {
  return [...records]
    .sort((a, b) => (bootPriorityScore(b) - bootPriorityScore(a)) || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

function recordsById(records: MorynRecord[]): Record<string, MorynRecord> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

function recallTypePriority(type: string): { score: number; reason: string } | undefined {
  const normalized = type.toLowerCase();
  if (normalized === "blocker" || normalized === "warning" || normalized === "conflict") return { score: 4, reason: `type_priority:${normalized}` };
  if (normalized === "decision") return { score: 3, reason: "type_priority:decision" };
  if (normalized === "preference") return { score: 2, reason: "type_priority:preference" };
  if (normalized === "summary" || normalized === "project_summary") return { score: 1, reason: "type_priority:summary" };
  return undefined;
}

function recallSourceTrust(record: MorynRecord): { score: number; reason: string } {
  const method = record.provenance?.method ?? provenanceMethod(record.source);
  if (method === "user-confirmed") return { score: 3, reason: "source_trust:user-confirmed" };
  if (method === "rule-promoted") return { score: 2, reason: "source_trust:rule-promoted" };
  return { score: 1, reason: "source_trust:agent-proposed" };
}

function reasonAndScore(record: MorynRecord, input: RecallInput): { score: number; reason: string[] } {
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
    const highConfidence = record.confidence >= 0.75;
    score += highConfidence ? 6 : 4;
    reason.push(highConfidence ? "high_confidence_candidate" : "candidate");
  } else {
    reason.push(record.state);
  }
  if (record.priority === "high") {
    score += 5;
    reason.push("high_priority");
  }
  const typePriority = recallTypePriority(record.type);
  if (typePriority) {
    score += typePriority.score;
    reason.push(typePriority.reason);
  }
  const sourceTrust = recallSourceTrust(record);
  score += sourceTrust.score;
  reason.push(sourceTrust.reason);
  for (const tag of input.tags ?? []) {
    if (record.tags.includes(tag)) {
      score += 5;
      reason.push(`tag_match:${tag}`);
    }
  }
  for (const file of input.files ?? []) {
    const haystack = `${searchableText(record)} ${record.tags.join(" ")}`.toLowerCase();
    if (haystack.includes(file.toLowerCase())) {
      score += 6;
      reason.push(`file_match:${file}`);
    }
  }
  if (input.query) {
    const haystack = `${searchableText(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
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

function summarizeRecord(record: MorynRecord): string {
  return textOf(record) || `${record.kind}:${record.type}`;
}

function projectActivity(record: MorynRecord) {
  const currentTask = typeof record.content.current_task === "string" ? record.content.current_task : undefined;
  return {
    record_id: record.id,
    kind: record.kind,
    type: record.type,
    text: summarizeRecord(record),
    current_task: currentTask,
    updated_at: record.updated_at,
    agent: record.source
  };
}

function projectSummary(records: MorynRecord[]): string {
  const summary = [...records]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .find((record) => record.type === "summary" || record.type === "project_summary");
  return summary ? textOf(summary) : "";
}

function taskTokens(task: string | undefined): string[] {
  const stopWords = new Set(["add", "build", "check", "debug", "fix", "for", "from", "implement", "make", "path", "project", "the", "this", "use", "with"]);
  return (task ?? "")
    .toLowerCase()
    .split(/\W+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !stopWords.has(token));
}

function matchesCurrentTask(record: MorynRecord, currentTask: string | undefined): boolean {
  const tokens = taskTokens(currentTask);
  if (!tokens.length) return false;
  const haystack = `${searchableText(record)} ${record.tags.join(" ")} ${record.type}`.toLowerCase();
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  return matches >= Math.min(2, tokens.length);
}

function nextMutationTimestamp(record: MorynRecord, candidate: string): string {
  const candidateTime = Date.parse(candidate);
  const previousTime = Date.parse(record.updated_at);
  if (Number.isFinite(candidateTime) && candidateTime > previousTime) return new Date(candidateTime).toISOString();
  return new Date(previousTime + 1).toISOString();
}

function refreshImportance(record: MorynRecord, currentTask: string | undefined): { importance: "silent" | "notice" | "interrupt"; reason?: string } {
  if (record.state === "raw" || record.kind === "agent_note") return { importance: "silent" };
  if (record.kind === "session_summary") return { importance: "notice" };
  const interruptCandidate = record.type === "blocker" || record.type === "warning" || record.type === "conflict" || record.priority === "high";
  if (interruptCandidate) {
    if (!currentTask) return { importance: "interrupt" };
    if (matchesCurrentTask(record, currentTask)) return { importance: "interrupt", reason: "current_task_match" };
    return { importance: "silent" };
  }
  if (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75)) return { importance: "notice" };
  return { importance: "silent" };
}

function isSensitiveKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[.[\]_-]+/)
    .filter(Boolean)
    .map((segment) => segment.toUpperCase());
  const joinedSegments = segments.join("_");
  if (
    segments.includes("AUTHORIZATION")
    || segments.includes("COOKIE")
    || joinedSegments.endsWith("AUTH_HEADER")
    || joinedSegments.endsWith("SET_COOKIE")
  ) {
    return true;
  }
  return /(?:API[_-]?KEY|DATABASE_URL|REDIS_URL|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)/i.test(key);
}

function redactSensitiveValue(value: unknown, keyPath?: string): unknown {
  if (typeof value === "string") {
    return keyPath && isSensitiveKey(keyPath) ? "[REDACTED_SECRET]" : redactSensitiveContent(value);
  }
  if (Array.isArray(value)) return value.map((item, index) => redactSensitiveValue(item, keyPath ? `${keyPath}.${index}` : String(index)));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      return [key, redactSensitiveValue(nested, nextPath)];
    }));
  }
  return value;
}

function redactSensitiveRecordContent<T extends Record<string, unknown>>(content: T): T {
  return redactSensitiveValue(content) as T;
}

function redactSensitivePatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([path, value]) => [path, redactSensitiveValue(value, path)]));
}

const managedRevisionFields = new Set([
  "id",
  "kind",
  "scope",
  "state",
  "visibility",
  "created_at",
  "updated_at",
  "source",
  "provenance",
  "conflict",
  "links"
]);

function assertRevisionPatchIsSafe(patch: Record<string, unknown>): void {
  const managed = Object.keys(patch).find((path) => managedRevisionFields.has(path.split(".")[0] as string));
  if (managed) {
    throw new Error(`Invalid argument: revise cannot modify managed field ${managed}`);
  }
}

function isUserConfirmed(source: RecordSource, confirmed?: boolean): boolean {
  return confirmed === true || source.client === "user";
}

function provenanceMethod(source: RecordSource, confirmed?: boolean): "agent-proposed" | "rule-promoted" | "user-confirmed" {
  if (isUserConfirmed(source, confirmed)) return "user-confirmed";
  if (source.client === "moryn") return "rule-promoted";
  return "agent-proposed";
}

function promoteCandidateNextAction(recordId: string): MorynErrorNextAction {
  const reason = "User confirmed";
  const action = withNextActionMetadata({
    recommended_action: "ask_user_then_promote_candidate",
    tool: "promote",
    command: `${commandForPromoteContext({ record_id: recordId, target_state: "canonical", reason })} --confirm`,
    candidate_record_id: recordId,
    arguments: {
      record_id: recordId,
      target_state: "canonical",
      reason,
      confirmed: true
    },
    argument_sources: {
      record_id: WRITE_CANDIDATE_RECORD_ID_SOURCE
    },
    required_when: PROMOTE_CANDIDATE_WHEN,
    required_fields: [],
    safe_to_run: false
  });
  return {
    ...action,
    workflow: withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: ["error.next_action", "warning.next_action", WRITE_CANDIDATE_RECORD_ID_SOURCE],
      phases: [
        {
          ...action.workflow.phases[0]!,
          action_source: WRITE_CANDIDATE_RECORD_ID_SOURCE,
          required_fields: ["record_id"],
          replace_arguments: { record_id: WRITE_CANDIDATE_RECORD_ID_SOURCE }
        }
      ]
    })
  };
}

function requiresCanonicalConfirmation(input: { kind: RecordKind; type: string; scope: RecordScope }): boolean {
  if (input.kind === "soul") return true;
  if (input.kind === "skill" && input.scope === "global") return true;
  const type = input.type.toLowerCase();
  if (input.kind === "memory" && input.scope === "global" && type === "preference") return true;
  return type === "security_rule"
    || type === "deployment_rule"
    || type === "permission_rule"
    || type === "credential_rule"
    || (type === "rule" && input.scope === "global");
}

function textFromContent(content: Record<string, unknown> & { text?: string }): string {
  return searchableContentText(content).trim().toLowerCase();
}

function tagOverlap(left: string[], right: string[]): boolean {
  const genericProjectTags = new Set(["javascript", "mcp", "node", "nodejs", "python", "typescript"]);
  const rightTags = new Set(right.filter((tag) => !genericProjectTags.has(tag.toLowerCase())));
  return left.some((tag) => rightTags.has(tag) && !genericProjectTags.has(tag.toLowerCase()));
}

function subjectTokens(content: Record<string, unknown> & { text?: string }): string[] {
  const stopWords = new Set(["about", "after", "agent", "before", "from", "into", "only", "source", "that", "the", "this", "truth", "with"]);
  return textFromContent(content)
    .split(/\W+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !stopWords.has(token));
}

function subjectOverlap(left: Record<string, unknown> & { text?: string }, right: Record<string, unknown> & { text?: string }): boolean {
  const rightTokens = new Set(subjectTokens(right));
  const matches = subjectTokens(left).filter((token) => rightTokens.has(token));
  return new Set(matches).size >= 2;
}

function semanticConflicts(records: MorynRecord[], input: {
  id?: string;
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  project_id?: string;
  tags?: string[];
  content: Record<string, unknown> & { text?: string };
}): MorynRecord[] {
  if (input.kind !== "memory") return [];
  const inputText = textFromContent(input.content);
  if (!inputText) return [];
  return records.filter((record) => record.state === "canonical")
    .filter((record) => record.id !== input.id)
    .filter((record) => record.kind === input.kind)
    .filter((record) => record.type === input.type)
    .filter((record) => record.scope === input.scope)
    .filter((record) => record.project_id === input.project_id)
    .filter((record) => tagOverlap(record.tags, input.tags ?? []) || subjectOverlap(record.content, input.content))
    .filter((record) => textFromContent(record.content) !== inputText);
}

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? createId;

  async function currentRecords(): Promise<MorynRecord[]> {
    return [...replayEvents(await readEvents(deps.storePath)).values()];
  }

  async function requireRecord(recordId: string): Promise<MorynRecord> {
    const record = replayEvents(await readEvents(deps.storePath)).get(recordId);
    if (!record) {
      throw new Error(`Record not found: ${recordId}`);
    }
    return record;
  }

  async function remoteHasUpdates(): Promise<boolean> {
    if (!deps.syncStatus) return false;
    try {
      const status = await deps.syncStatus();
      return Boolean(status.remote_has_updates || (status.behind ?? 0) > 0);
    } catch {
      return false;
    }
  }

  async function appendEventAndRebuild(event: MorynEvent): Promise<void> {
    await appendEvent(deps.storePath, event);
    await rebuildDerivedViews(deps.storePath);
  }

  const engine = {
    async write(input: WriteInput) {
      validateWriteInput(input);
      const createdAt = now();
      const sensitive = detectSensitiveContent(sensitiveScanText(input.content));
      const conflicts = sensitive.sensitive ? [] : semanticConflicts(await currentRecords(), input);
      const needsConflictConfirmation = input.state === "canonical" && conflicts.length > 0 && !isUserConfirmed(input.source, input.confirmed);
      const needsConfirmation = input.state === "canonical"
        && (requiresCanonicalConfirmation(input) || conflicts.length > 0)
        && !isUserConfirmed(input.source, input.confirmed);
      const state = sensitive.sensitive
        ? "quarantined"
        : needsConfirmation
          ? "candidate"
          : (input.state ?? (input.kind === "agent_note" ? "raw" : "candidate"));
      const content = sensitive.sensitive ? redactSensitiveRecordContent(input.content) : input.content;
      const record: MorynRecord = {
        id: id("rec"),
        kind: input.kind,
        type: input.type,
        scope: input.scope,
        project_id: input.project_id,
        tags: input.tags ?? [],
        content,
        state,
        confidence: input.confidence ?? 0.5,
        priority: input.priority ?? "normal",
        visibility: state === "quarantined" ? "quarantined" : state === "archived" ? "archived" : "active",
        created_at: createdAt,
        updated_at: createdAt,
        source: input.source,
        provenance: {
          ...(input.provenance ?? {}),
          method: input.provenance?.method ?? provenanceMethod(input.source, input.confirmed)
        },
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined
      };
      const event: MorynEvent = { event_id: id("evt"), op: "upsert_record", record, created_at: createdAt, source: input.source };
      await appendEventAndRebuild(event);
      const warning: EngineWarning | undefined = sensitive.sensitive
        ? { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason }
        : needsConfirmation
          ? {
              code: "CONFIRMATION_REQUIRED",
              reason: needsConflictConfirmation
                ? "conflicting canonical memory requires explicit user confirmation"
                : "canonical state requires explicit user confirmation",
              next_action: promoteCandidateNextAction(record.id)
            }
          : undefined;
      return {
        record,
        warning
      };
    },

    async revise(input: RevisionInput) {
      validateRevisionInput(input);
      const record = await requireRecord(input.record_id);
      assertRevisionPatchIsSafe(input.patch);
      const createdAt = nextMutationTimestamp(record, now());
      const source = input.source ?? { client: "moryn" };
      const patched = applyRecordPatch(record, input.patch);
      try {
        parseRecord(patched);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid argument: Invalid patch; ${message}`);
      }
      const sensitive = detectSensitiveContent(sensitiveScanText(patched.content));
      const conflicts = !sensitive.sensitive && patched.state === "canonical"
        ? semanticConflicts(await currentRecords(), patched)
        : [];
      if (conflicts.length > 0 && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: conflicting canonical memory requires explicit user confirmation");
      }
      const patch = sensitive.sensitive ? redactSensitivePatch(input.patch) : input.patch;
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "revise_record",
        record_id: input.record_id,
        patch,
        reason: input.reason,
        confirmed: input.confirmed,
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined,
        created_at: createdAt,
        source
      };
      await appendEvent(deps.storePath, event);
      if (!sensitive.sensitive) {
        await rebuildDerivedViews(deps.storePath);
        return { event };
      }

      const revisedRecord = { ...record, updated_at: createdAt };
      const quarantineCreatedAt = nextMutationTimestamp(revisedRecord, now());
      const quarantineEvent: MorynEvent = {
        event_id: id("evt"),
        op: "quarantine_record",
        record_id: input.record_id,
        reason: "SENSITIVE_CONTENT_DETECTED",
        created_at: quarantineCreatedAt,
        source
      };
      await appendEvent(deps.storePath, quarantineEvent);
      await rebuildDerivedViews(deps.storePath);
      return {
        event,
        quarantine_event: quarantineEvent,
        warning: { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason }
      };
    },

    async promote(input: PromoteInput) {
      validatePromoteInput(input);
      const record = await requireRecord(input.record_id);
      const source = input.source ?? { client: "moryn" };
      const conflicts = input.target_state === "canonical" ? semanticConflicts(await currentRecords(), record) : [];
      if (input.target_state === "canonical"
        && requiresCanonicalConfirmation(record)
        && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: canonical state requires explicit user confirmation");
      }
      if (input.target_state === "canonical"
        && conflicts.length > 0
        && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: conflicting canonical memory requires explicit user confirmation");
      }
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "promote_record",
        record_id: input.record_id,
        target_state: input.target_state,
        reason: input.reason,
        confirmed: input.confirmed,
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined,
        created_at: createdAt,
        source
      };
      await appendEventAndRebuild(event);
      return { event };
    },

    async archive(input: StateChangeInput) {
      validateStateChangeInput(input, "archive input");
      const record = await requireRecord(input.record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "archive_record",
        record_id: input.record_id,
        reason: input.reason,
        created_at: createdAt,
        source: input.source ?? { client: "moryn" }
      };
      await appendEventAndRebuild(event);
      return { event };
    },

    async quarantine(input: StateChangeInput) {
      validateStateChangeInput(input, "quarantine input");
      const record = await requireRecord(input.record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "quarantine_record",
        record_id: input.record_id,
        reason: input.reason,
        created_at: createdAt,
        source: input.source ?? { client: "moryn" }
      };
      await appendEventAndRebuild(event);
      return { event };
    },

    async link(input: LinkInput) {
      validateLinkInput(input);
      const record = await requireRecord(input.record_id);
      await requireRecord(input.linked_record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: id("evt"),
        op: "link_records",
        record_id: input.record_id,
        linked_record_id: input.linked_record_id,
        link_type: input.link_type,
        created_at: createdAt,
        source: input.source ?? { client: "moryn" }
      };
      await appendEventAndRebuild(event);
      return { event };
    },

    async recall(input: RecallInput) {
      validateRecallInput(input);
      for (const recordId of input.record_ids ?? []) {
        await requireRecord(recordId);
      }
      const limit = validateLimit(input.limit, 10);
      const records = (await currentRecords())
        .filter((record) => includesHiddenState(input) || includesRawState(input) || isVisibleInDefaultRecall(record))
        .filter((record) => recordProjectMatchesRecall(record, input))
        .filter((record) => !input.record_ids?.length || input.record_ids.includes(record.id))
        .filter((record) => !input.kinds?.length || input.kinds.includes(record.kind))
        .filter((record) => !input.scopes?.length || input.scopes.includes(record.scope))
        .filter((record) => !input.types?.length || input.types.includes(record.type))
        .filter((record) => !input.states?.length || input.states.includes(record.state))
        .filter((record) => matchesAny(record.tags, input.tags))
        .filter((record) => !input.files?.length || input.files.some((file) => `${searchableText(record)} ${record.tags.join(" ")}`.toLowerCase().includes(file.toLowerCase())))
        .map((record) => ({ record, ...reasonAndScore(record, input) }))
        .filter((result) => matchesQuery(result, input))
        .filter((result) => result.score > 0 || (!input.query && !input.record_ids?.length))
        .sort((a, b) => (b.score - a.score) || b.record.updated_at.localeCompare(a.record.updated_at) || a.record.id.localeCompare(b.record.id))
        .slice(0, limit);
      return {
        results: records,
        results_by_id: Object.fromEntries(records.map((result) => [result.record.id, result]))
      };
    },

    async boot(input: BootInput) {
      validateBootInput(input);
      const visibleRecords = (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => recordBootContextMatches(record, input.project_id));
      const records = visibleRecords
        .filter(isTrustedForBoot)
      const recent = [...visibleRecords]
        .filter(isImportantBootRecent)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const projectMemoryRecords = projectMemory(records, input.project_id);
      const trustedProjectRecords = projectScopedRecords(records, input.project_id);
      const taskRelevant = input.current_task
        ? boundedBootRecords(records
          .filter((record) => record.kind === "memory" && record.scope === "project")
          .filter((record) => matchesCurrentTask(record, input.current_task)))
        : [];
      const userPreferences = boundedBootRecords(records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "preference"));
      const soul = boundedBootRecords(records.filter((record) => record.kind === "soul"));
      const globalRules = boundedBootRecords(records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "rule"));
      const importantDecisions = boundedBootRecords(trustedProjectRecords.filter((record) => record.type === "decision"));
      const warnings = boundedBootRecords(trustedProjectRecords.filter((record) => record.type === "warning" || record.type === "blocker"));
      const skills = boundedBootRecords(bootSkills(records, input));
      const recentChanges = recent.filter((record) => record.kind !== "soul").slice(0, 5);
      const cursor = [...visibleRecords].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_at ?? new Date().toISOString();
      const remoteUpdates = await remoteHasUpdates();
      return {
        profile: {
          user_preferences: userPreferences,
          soul,
          global_rules: globalRules
        },
        project: {
          summary: projectSummary(projectMemoryRecords),
          tech_stack: boundedBootTexts(projectMemoryRecords.filter((record) => record.type === "tech_stack")),
          active_goals: boundedBootTexts(projectMemoryRecords.filter((record) => record.type === "active_goal" || record.type === "goal")),
          important_decisions: importantDecisions,
          warnings
        },
        skills,
        task_relevant: taskRelevant,
        recent_changes: recentChanges,
        records_by_id: recordsById([
          ...userPreferences,
          ...soul,
          ...globalRules,
          ...importantDecisions,
          ...warnings,
          ...skills,
          ...taskRelevant,
          ...recentChanges
        ]),
        sync: { cursor, remote_has_updates: remoteUpdates }
      };
    },

    async refresh(input: RefreshInput) {
      validateRefreshInput(input);
      const limit = validateLimit(input.limit, 20);
      const records = (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => recordBootContextMatches(record, input.project_id))
        .filter((record) => !input.cursor || record.updated_at > input.cursor)
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      const allChanges = records.map((record) => {
        const importance = refreshImportance(record, input.current_task);
        return {
          record,
          change: {
            record_id: record.id,
            importance: importance.importance,
            reason: importance.reason,
            summary: summarizeRecord(record),
            recommended_action: record.state === "raw" ? "ignore unless relevant" : "call recall with record_id",
            ...(record.state === "raw" ? {} : { next_action: refreshChangeNextAction(record, input) })
          }
        };
      });
      const reportableChanges = allChanges.filter((change) => change.change.importance !== "silent");
      const changes = reportableChanges.slice(0, limit);
      const latest = (reportableChanges.length > changes.length ? changes.at(-1)?.record.updated_at : records.at(-1)?.updated_at)
        ?? input.cursor
        ?? new Date().toISOString();
      return {
        cursor: latest,
        changes: changes.map((change) => change.change),
        changes_by_record_id: Object.fromEntries(changes.map((change) => [change.change.record_id, change.change])),
        should_interrupt: changes.some((change) => change.change.importance === "interrupt")
      };
    },

    async listRecent(limit = 20) {
      const records = (await currentRecords()).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, validateLimit(limit, 20));
      return {
        records,
        records_by_id: recordsById(records)
      };
    },

    async listProjects(input: ListProjectsInput = {}) {
      validateListProjectsInput(input);
      const limit = validateLimit(input.limit, 20);
      const byProject = new Map<string, MorynRecord[]>();

      for (const record of (await currentRecords()).filter(isVisibleByDefault)) {
        if (record.scope !== "project" || !record.project_id) continue;
        byProject.set(record.project_id, [...(byProject.get(record.project_id) ?? []), record]);
      }

      const projects = [...byProject.entries()]
        .map(([projectId, records]) => {
          const sorted = [...records].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
          const latest = sorted[0] as MorynRecord;
          const tags = [...new Set(records.flatMap((record) => record.tags))].sort();
          return {
            project_id: projectId,
            records: records.length,
            tags,
            latest_activity: projectActivity(latest),
            next: withProjectListNextMetadata({
              recommended_action: "call_agent_start",
              tool: "agent_start",
              safe_to_run: true,
              required_when: START_LISTED_PROJECT_WHEN,
              required_fields: [],
              command: projectStartCommand(projectId, input),
              arguments: projectStartArguments(projectId, input)
            })
          };
        })
        .sort((a, b) => b.latest_activity.updated_at.localeCompare(a.latest_activity.updated_at) || a.project_id.localeCompare(b.project_id))
        .slice(0, limit);

      return {
        projects,
        projects_by_id: Object.fromEntries(projects.map((project) => [project.project_id, project]))
      };
    }
  };

  return engine;
}
