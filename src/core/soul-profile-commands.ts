import {
  SOUL_CLAUSE_CATEGORIES,
  SOUL_DISTRIBUTIONS,
  type SoulClauseInput,
  type SoulDistribution,
  type SoulSubject
} from "./soul-profile.js";
import type {
  ApproveSoulProfileDraftInput,
  CreateSoulProfileDraftInput,
  ReadSoulProfileStatusOptions,
  RollbackSoulProfileInput
} from "./soul-profile-management.js";
import type { RecordSource } from "./types.js";

const SOURCE_FIELDS = ["client", "session_id", "model", "device_id"] as const;
const SUBJECT_FIELDS = ["kind", "subject_id", "display_name"] as const;
const CLAUSE_FIELDS = [
  "clause_key",
  "category",
  "text",
  "scope",
  "distribution",
  "priority",
  "mandatory",
  "overrides_clause_id",
  "provenance_record_ids"
] as const;
const SCOPE_FIELDS = ["kind", "project_id"] as const;

export interface SoulCommandDefaults {
  source: RecordSource;
  occurred_at: string;
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid argument: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownFields(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unknown = Object.keys(value).find((field) => !allowed.includes(field));
  if (unknown) throw new Error(`Invalid argument: Unknown ${name}.${unknown}`);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid argument: ${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : nonEmptyString(value, name);
}

function canonicalTimestamp(value: unknown, name: string): string {
  const timestamp = nonEmptyString(value, name);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new Error(`Invalid argument: ${name} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function source(value: unknown, fallback: RecordSource): RecordSource {
  const input = value === undefined ? fallback : value;
  const object = plainObject(input, "source");
  knownFields(object, SOURCE_FIELDS, "source");
  return {
    client: nonEmptyString(object.client, "source.client"),
    ...(object.session_id === undefined ? {} : { session_id: nonEmptyString(object.session_id, "source.session_id") }),
    ...(object.model === undefined ? {} : { model: nonEmptyString(object.model, "source.model") }),
    ...(object.device_id === undefined ? {} : { device_id: nonEmptyString(object.device_id, "source.device_id") })
  };
}

function subject(value: unknown): SoulSubject {
  const object = plainObject(value, "subject");
  knownFields(object, SUBJECT_FIELDS, "subject");
  if (object.kind !== "user" && object.kind !== "agent") {
    throw new Error("Invalid argument: subject.kind must be user or agent");
  }
  return {
    kind: object.kind,
    subject_id: nonEmptyString(object.subject_id, "subject.subject_id"),
    ...(object.display_name === undefined
      ? {}
      : { display_name: nonEmptyString(object.display_name, "subject.display_name") })
  };
}

function scope(value: unknown, clauseIndex: number): SoulClauseInput["scope"] {
  if (value === undefined) return undefined;
  const name = `clauses[${clauseIndex}].scope`;
  const object = plainObject(value, name);
  knownFields(object, SCOPE_FIELDS, name);
  if (object.kind === "global") {
    if (object.project_id !== undefined) {
      throw new Error(`Invalid argument: ${name}.project_id is only valid for project scope`);
    }
    return { kind: "global" };
  }
  if (object.kind !== "project") {
    throw new Error(`Invalid argument: ${name}.kind must be global or project`);
  }
  return { kind: "project", project_id: nonEmptyString(object.project_id, `${name}.project_id`) };
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`Invalid argument: ${name} must be an array`);
  return value.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
}

function clause(value: unknown, index: number): SoulClauseInput {
  const name = `clauses[${index}]`;
  const object = plainObject(value, name);
  knownFields(object, CLAUSE_FIELDS, name);
  if (!SOUL_CLAUSE_CATEGORIES.includes(object.category as (typeof SOUL_CLAUSE_CATEGORIES)[number])) {
    throw new Error(`Invalid argument: ${name}.category is not supported`);
  }
  if (object.distribution !== undefined && !SOUL_DISTRIBUTIONS.includes(object.distribution as SoulDistribution)) {
    throw new Error(`Invalid argument: ${name}.distribution is not supported`);
  }
  if (
    object.priority !== undefined &&
    (!Number.isInteger(object.priority) || (object.priority as number) < 0 || (object.priority as number) > 100)
  ) {
    throw new Error(`Invalid argument: ${name}.priority must be an integer between 0 and 100`);
  }
  if (object.mandatory !== undefined && typeof object.mandatory !== "boolean") {
    throw new Error(`Invalid argument: ${name}.mandatory must be a boolean`);
  }
  return {
    clause_key: nonEmptyString(object.clause_key, `${name}.clause_key`),
    category: object.category as SoulClauseInput["category"],
    text: nonEmptyString(object.text, `${name}.text`),
    ...(object.scope === undefined ? {} : { scope: scope(object.scope, index) }),
    ...(object.distribution === undefined ? {} : { distribution: object.distribution as SoulDistribution }),
    ...(object.priority === undefined ? {} : { priority: object.priority as number }),
    ...(object.mandatory === undefined ? {} : { mandatory: object.mandatory as boolean }),
    ...(object.overrides_clause_id === undefined
      ? {}
      : { overrides_clause_id: nonEmptyString(object.overrides_clause_id, `${name}.overrides_clause_id`) }),
    ...(object.provenance_record_ids === undefined
      ? {}
      : { provenance_record_ids: stringList(object.provenance_record_ids, `${name}.provenance_record_ids`) })
  };
}

function clauses(value: unknown): SoulClauseInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Invalid argument: clauses must be an array");
  if (value.length === 0) throw new Error("Invalid argument: clauses must not be empty");
  return value.map(clause);
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Invalid argument: ${name} must be a positive integer`);
  }
  return value as number;
}

function distributions(value: unknown): SoulDistribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Invalid argument: allowed_distributions must be a non-empty array");
  }
  return value.map((item, index) => {
    if (!SOUL_DISTRIBUTIONS.includes(item as SoulDistribution)) {
      throw new Error(`Invalid argument: allowed_distributions[${index}] is not supported`);
    }
    return item as SoulDistribution;
  });
}

export function normalizeSoulDraftCommand(value: unknown, defaults: SoulCommandDefaults): CreateSoulProfileDraftInput {
  const object = plainObject(value, "Soul draft input");
  knownFields(
    object,
    ["subject", "profile_id", "clauses", "from_revision_id", "source", "occurred_at"],
    "Soul draft input"
  );
  const fromRevisionId = optionalString(object.from_revision_id, "from_revision_id");
  if (fromRevisionId && (object.subject !== undefined || object.profile_id !== undefined)) {
    throw new Error("Invalid argument: from_revision_id cannot be combined with subject or profile_id");
  }
  if (!fromRevisionId && object.subject === undefined) {
    throw new Error("Invalid argument: subject is required when from_revision_id is not provided");
  }
  const normalizedClauses = clauses(object.clauses);
  if (!fromRevisionId && normalizedClauses === undefined) {
    throw new Error("Invalid argument: clauses are required when from_revision_id is not provided");
  }
  return {
    ...(object.subject === undefined ? {} : { subject: subject(object.subject) }),
    ...(object.profile_id === undefined ? {} : { profile_id: nonEmptyString(object.profile_id, "profile_id") }),
    ...(normalizedClauses === undefined ? {} : { clauses: normalizedClauses }),
    ...(fromRevisionId === undefined ? {} : { from_revision_id: fromRevisionId }),
    source: source(object.source, defaults.source),
    occurred_at: canonicalTimestamp(object.occurred_at ?? defaults.occurred_at, "occurred_at")
  };
}

export function normalizeSoulApprovalCommand(
  value: unknown,
  defaults: SoulCommandDefaults
): ApproveSoulProfileDraftInput {
  const object = plainObject(value, "Soul approval input");
  knownFields(object, ["revision_id", "confirmed", "source", "occurred_at"], "Soul approval input");
  if (object.confirmed !== true) {
    throw new Error("Soul Profile activation requires explicit user confirmation");
  }
  return {
    revision_id: nonEmptyString(object.revision_id, "revision_id"),
    confirmed: true,
    source: source(object.source, defaults.source),
    occurred_at: canonicalTimestamp(object.occurred_at ?? defaults.occurred_at, "occurred_at")
  };
}

export function normalizeSoulRollbackCommand(value: unknown, defaults: SoulCommandDefaults): RollbackSoulProfileInput {
  const object = plainObject(value, "Soul rollback input");
  knownFields(
    object,
    ["target_revision_id", "profile_id", "confirmed", "source", "occurred_at"],
    "Soul rollback input"
  );
  if (object.confirmed !== true) {
    throw new Error("Soul Profile rollback requires explicit user confirmation");
  }
  return {
    target_revision_id: nonEmptyString(object.target_revision_id, "target_revision_id"),
    profile_id: nonEmptyString(object.profile_id, "profile_id"),
    confirmed: true,
    source: source(object.source, defaults.source),
    occurred_at: canonicalTimestamp(object.occurred_at ?? defaults.occurred_at, "occurred_at")
  };
}

export function normalizeSoulStatusCommand(value: unknown = {}): ReadSoulProfileStatusOptions {
  const object = plainObject(value, "Soul status input");
  knownFields(
    object,
    ["user_profile_id", "agent_profile_id", "project_id", "allowed_distributions", "char_budget", "token_budget"],
    "Soul status input"
  );
  return {
    ...(object.user_profile_id === undefined
      ? {}
      : { user_profile_id: nonEmptyString(object.user_profile_id, "user_profile_id") }),
    ...(object.agent_profile_id === undefined
      ? {}
      : { agent_profile_id: nonEmptyString(object.agent_profile_id, "agent_profile_id") }),
    ...(object.project_id === undefined ? {} : { project_id: nonEmptyString(object.project_id, "project_id") }),
    ...(object.allowed_distributions === undefined
      ? {}
      : { allowed_distributions: distributions(object.allowed_distributions) }),
    ...(object.char_budget === undefined ? {} : { char_budget: positiveInteger(object.char_budget, "char_budget") }),
    ...(object.token_budget === undefined ? {} : { token_budget: positiveInteger(object.token_budget, "token_budget") })
  };
}
