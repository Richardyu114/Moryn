import { createHash } from "node:crypto";
import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord } from "./types.js";

export const SOUL_PROFILE_SCHEMA_VERSION = 1 as const;

export const SOUL_CLAUSE_CATEGORIES = [
  "identity",
  "mission",
  "value",
  "boundary",
  "collaboration",
  "communication",
  "decision_style"
] as const;

export const SOUL_DISTRIBUTIONS = ["local_only", "personal_sync"] as const;

export type SoulClauseCategory = (typeof SOUL_CLAUSE_CATEGORIES)[number];
export type SoulDistribution = (typeof SOUL_DISTRIBUTIONS)[number];
export type SoulRevisionState = "draft" | "active" | "superseded" | "conflicted";

export type SoulSubject =
  | { kind: "user"; subject_id: string; display_name?: string }
  | { kind: "agent"; subject_id: string; display_name?: string };

export type SoulScope = { kind: "global" } | { kind: "project"; project_id: string };

export interface SoulClause {
  clause_id: string;
  clause_key: string;
  category: SoulClauseCategory;
  text: string;
  scope: SoulScope;
  distribution: SoulDistribution;
  priority: number;
  mandatory: boolean;
  overrides_clause_id?: string;
  provenance_record_ids: string[];
}

export interface SoulProfileRevision {
  schema_version: typeof SOUL_PROFILE_SCHEMA_VERSION;
  profile_id: string;
  revision_id: string;
  subject: SoulSubject;
  generation: number;
  parent_revision_ids: string[];
  clauses: SoulClause[];
  state: SoulRevisionState;
  approved: boolean;
  approval_receipt_id?: string;
  created_at?: string;
}

export interface SoulClauseInput {
  clause_key: string;
  category: SoulClauseCategory;
  text: string;
  scope?: SoulScope;
  distribution?: SoulDistribution;
  priority?: number;
  mandatory?: boolean;
  overrides_clause_id?: string;
  provenance_record_ids?: readonly string[];
}

export interface CreateSoulProfileRevisionInput {
  subject: SoulSubject;
  profile_id?: string;
  generation: number;
  parent_revision_ids?: readonly string[];
  clauses: readonly (SoulClause | SoulClauseInput)[];
  state?: SoulRevisionState;
  approved?: boolean;
  approval_receipt_id?: string;
  created_at?: string;
}

export interface LegacySoulRecordOptions {
  subject?: SoulSubject;
  profile_id?: string;
  generation?: number;
  default_distribution?: SoulDistribution;
}

export type SoulRevisionSelectionStatus = "active" | "using_last_known_good" | "no_active_revision";

export interface SoulRevisionSelection {
  profile_id: string;
  status: SoulRevisionSelectionStatus;
  selected_revision?: SoulProfileRevision;
  conflicted_revision_ids: string[];
  ignored_revision_ids: Array<{
    revision_id: string;
    reason: "draft" | "superseded" | "conflicted" | "unapproved" | "ambiguous_active_head";
  }>;
}

export type SoulOmissionReason =
  | "scope_mismatch"
  | "distribution_filtered"
  | "overridden"
  | "protected_clause_override"
  | "char_budget"
  | "token_budget"
  | "char_and_token_budget"
  | "mandatory_budget_exceeded";

export interface SoulOmission {
  clause_id: string;
  clause_key: string;
  mandatory: boolean;
  reason: SoulOmissionReason;
  detail?: string;
}

export interface SoulCompileConflict {
  kind:
    | "revision_conflict"
    | "ambiguous_active_head"
    | "ambiguous_profile_binding"
    | "profile_binding_not_found"
    | "profile_subject_mismatch"
    | "protected_clause_override";
  profile_id: string;
  profile_ids?: string[];
  revision_ids?: string[];
  clause_ids?: string[];
  detail: string;
}

export interface EffectiveSoulClause extends SoulClause {
  profile_id: string;
  revision_id: string;
  subject_kind: SoulSubject["kind"];
  subject_id: string;
  precedence: number;
}

export interface CompileEffectiveSoulInput {
  revisions: readonly SoulProfileRevision[];
  user_profile_id?: string;
  agent_profile_id?: string;
  project_id?: string;
  allowed_distributions?: readonly SoulDistribution[];
  char_budget?: number;
  token_budget?: number;
}

export interface SelectedSoulRevision {
  profile_id: string;
  revision_id: string;
  subject: SoulSubject;
  generation: number;
  state: SoulRevisionState;
}

export interface EffectiveSoulRevisionSelection extends Omit<SoulRevisionSelection, "selected_revision"> {
  /** Metadata-only projection. Clause payloads are exposed only after scope and distribution filtering. */
  selected_revision?: SelectedSoulRevision;
}

export interface EffectiveSoul {
  version: 1;
  status: "ready" | "ready_with_omissions" | "blocked";
  deliverable: boolean;
  project_id?: string;
  /** Digest-safe metadata only; clause payloads live in the filtered `clauses` projection. */
  selected_revisions: SelectedSoulRevision[];
  selections_by_profile_id: Record<string, EffectiveSoulRevisionSelection>;
  clauses: EffectiveSoulClause[];
  clauses_by_id: Record<string, EffectiveSoulClause>;
  omissions: SoulOmission[];
  conflicts: SoulCompileConflict[];
  budget: {
    char_limit: number;
    token_limit: number;
    chars_used: number;
    tokens_used: number;
    mandatory_exceeds_budget: boolean;
  };
  rendered: string;
  source_digest: string;
  rendered_digest: string;
}

const DEFAULT_CHAR_BUDGET = 4_000;
const DEFAULT_TOKEN_BUDGET = 1_000;
const PROTECTED_CATEGORIES = new Set<SoulClauseCategory>(["boundary", "identity"]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return typeof value === "string" ? value.trim() : value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, 24)}`;
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Invalid Soul Profile: ${name} must be a non-empty string`);
  return normalized;
}

function normalizeSubject(subject: SoulSubject): SoulSubject {
  const subjectId = requireNonEmpty(subject.subject_id, "subject.subject_id");
  const displayName = subject.display_name?.trim();
  return {
    kind: subject.kind,
    subject_id: subjectId,
    ...(displayName ? { display_name: displayName } : {})
  };
}

function normalizeScope(scope: SoulScope | undefined): SoulScope {
  if (!scope || scope.kind === "global") return { kind: "global" };
  return { kind: "project", project_id: requireNonEmpty(scope.project_id, "scope.project_id") };
}

function scopeIdentity(scope: SoulScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.project_id}`;
}

function normalizePriority(priority: number | undefined): number {
  const normalized = priority ?? 50;
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 100)
    throw new Error("Invalid Soul Profile: clause priority must be an integer between 0 and 100");
  return normalized;
}

function isClause(value: SoulClause | SoulClauseInput): value is SoulClause {
  return "clause_id" in value;
}

export function stableSoulProfileId(subject: SoulSubject): string {
  const normalized = normalizeSubject(subject);
  return stableId("soul_profile", { kind: normalized.kind, subject_id: normalized.subject_id });
}

export function stableSoulClauseId(
  profileId: string,
  clauseKey: string,
  scope: SoulScope = { kind: "global" }
): string {
  const normalizedScope = normalizeScope(scope);
  return stableId("soul_clause", {
    profile_id: requireNonEmpty(profileId, "profile_id"),
    clause_key: requireNonEmpty(clauseKey, "clause_key"),
    scope: scopeIdentity(normalizedScope)
  });
}

export function createSoulClause(profileId: string, input: SoulClauseInput): SoulClause {
  if (!SOUL_CLAUSE_CATEGORIES.includes(input.category))
    throw new Error(`Invalid Soul Profile: unsupported clause category: ${String(input.category)}`);
  if (input.distribution !== undefined && !SOUL_DISTRIBUTIONS.includes(input.distribution))
    throw new Error(`Invalid Soul Profile: unsupported distribution: ${String(input.distribution)}`);
  const scope = normalizeScope(input.scope);
  const clauseKey = requireNonEmpty(input.clause_key, "clause_key");
  const mandatory = PROTECTED_CATEGORIES.has(input.category) || input.mandatory === true;
  const provenanceRecordIds = [...new Set(input.provenance_record_ids ?? [])]
    .map((recordId) => requireNonEmpty(recordId, "provenance_record_ids[]"))
    .sort(compareCodeUnits);
  return {
    clause_id: stableSoulClauseId(profileId, clauseKey, scope),
    clause_key: clauseKey,
    category: input.category,
    text: requireNonEmpty(input.text, "clause.text"),
    scope,
    distribution: input.distribution ?? "personal_sync",
    priority: normalizePriority(input.priority),
    mandatory,
    ...(input.overrides_clause_id
      ? { overrides_clause_id: requireNonEmpty(input.overrides_clause_id, "overrides_clause_id") }
      : {}),
    provenance_record_ids: provenanceRecordIds
  };
}

function normalizeExistingClause(profileId: string, clause: SoulClause): SoulClause {
  const normalized = createSoulClause(profileId, clause);
  if (clause.clause_id !== normalized.clause_id)
    throw new Error(`Invalid Soul Profile: unstable clause_id for ${clause.clause_key}`);
  return normalized;
}

function revisionIdentity(input: {
  profile_id: string;
  subject: SoulSubject;
  generation: number;
  parent_revision_ids: string[];
  clauses: SoulClause[];
}): unknown {
  return {
    schema_version: SOUL_PROFILE_SCHEMA_VERSION,
    profile_id: input.profile_id,
    subject: { kind: input.subject.kind, subject_id: input.subject.subject_id },
    generation: input.generation,
    parent_revision_ids: [...input.parent_revision_ids].sort(compareCodeUnits),
    clauses: [...input.clauses]
      .sort((left, right) => compareCodeUnits(left.clause_id, right.clause_id))
      .map((clause) => ({
        clause_id: clause.clause_id,
        clause_key: clause.clause_key,
        category: clause.category,
        text: clause.text,
        scope: clause.scope,
        distribution: clause.distribution,
        priority: clause.priority,
        mandatory: clause.mandatory,
        overrides_clause_id: clause.overrides_clause_id,
        provenance_record_ids: clause.provenance_record_ids
      }))
  };
}

function revisionDigestIdentity(revision: SoulProfileRevision, clauses: readonly SoulClause[]): unknown {
  return {
    schema_version: revision.schema_version,
    profile_id: revision.profile_id,
    revision_id: revision.revision_id,
    subject: { kind: revision.subject.kind, subject_id: revision.subject.subject_id },
    generation: revision.generation,
    parent_revision_ids: revision.parent_revision_ids,
    clauses
  };
}

/** Full semantic digest used by local approval evidence. */
export function soulProfileRevisionDigest(revision: SoulProfileRevision): string {
  return sha256(canonicalJson(revisionDigestIdentity(revision, revision.clauses)));
}

/** Digest that a device holding only the portable projection can independently verify. */
export function soulProfilePersonalSyncDigest(revision: SoulProfileRevision): string {
  return sha256(
    canonicalJson(
      revisionDigestIdentity(
        revision,
        revision.clauses.filter((clause) => clause.distribution === "personal_sync")
      )
    )
  );
}

export function stableSoulRevisionId(input: Omit<SoulProfileRevision, "revision_id" | "state" | "approved">): string {
  return stableId("soul_revision", revisionIdentity(input));
}

export function createSoulProfileRevision(input: CreateSoulProfileRevisionInput): SoulProfileRevision {
  const subject = normalizeSubject(input.subject);
  const profileId = input.profile_id?.trim() || stableSoulProfileId(subject);
  if (profileId !== stableSoulProfileId(subject) && !input.profile_id)
    throw new Error("Invalid Soul Profile: profile_id could not be derived");
  if (!Number.isInteger(input.generation) || input.generation < 1)
    throw new Error("Invalid Soul Profile: generation must be a positive integer");
  const clauses = input.clauses
    .map((clause) =>
      isClause(clause) ? normalizeExistingClause(profileId, clause) : createSoulClause(profileId, clause)
    )
    .sort((left, right) => compareCodeUnits(left.clause_id, right.clause_id));
  if (new Set(clauses.map((clause) => clause.clause_id)).size !== clauses.length)
    throw new Error("Invalid Soul Profile: duplicate clause identity in one revision");
  const parentRevisionIds = [...new Set(input.parent_revision_ids ?? [])]
    .map((revisionId) => requireNonEmpty(revisionId, "parent_revision_ids[]"))
    .sort(compareCodeUnits);
  const identity = {
    schema_version: SOUL_PROFILE_SCHEMA_VERSION,
    profile_id: requireNonEmpty(profileId, "profile_id"),
    subject,
    generation: input.generation,
    parent_revision_ids: parentRevisionIds,
    clauses
  };
  return {
    ...identity,
    revision_id: stableId("soul_revision", revisionIdentity(identity)),
    state: input.state ?? "draft",
    approved: input.approved === true,
    ...(input.approval_receipt_id
      ? { approval_receipt_id: requireNonEmpty(input.approval_receipt_id, "approval_receipt_id") }
      : {}),
    ...(input.created_at ? { created_at: input.created_at } : {})
  };
}

function legacyCategory(record: MorynRecord): SoulClauseCategory {
  const contentCategory = record.content.category;
  if (typeof contentCategory === "string" && SOUL_CLAUSE_CATEGORIES.includes(contentCategory as SoulClauseCategory))
    return contentCategory as SoulClauseCategory;
  const normalized = record.type.trim().toLowerCase();
  if (SOUL_CLAUSE_CATEGORIES.includes(normalized as SoulClauseCategory)) return normalized as SoulClauseCategory;
  if (normalized === "preference" || normalized === "principle") return "collaboration";
  if (normalized === "persona" || normalized === "role") return "identity";
  return "collaboration";
}

function legacyText(record: MorynRecord): string {
  if (typeof record.content.text === "string" && record.content.text.trim()) return record.content.text.trim();
  const withoutFormat = Object.fromEntries(Object.entries(record.content).filter(([key]) => key !== "format"));
  return canonicalJson(withoutFormat);
}

function legacyDistribution(record: MorynRecord, fallback: SoulDistribution): SoulDistribution {
  return isPrivateMemoryBoundary(record) ? "local_only" : fallback;
}

/**
 * Converts one v0.3 `kind=soul` record into a single-clause v1 revision.
 * Non-soul records return undefined so callers can map over a mixed store safely.
 */
export function parseLegacySoulRecord(
  record: MorynRecord,
  options: LegacySoulRecordOptions = {}
): SoulProfileRevision | undefined {
  if (record.kind !== "soul") return undefined;
  if (record.scope !== "global" && record.scope !== "project")
    throw new Error(`Invalid legacy Soul record: unsupported scope ${record.scope}`);
  if (record.scope === "project" && !record.project_id)
    throw new Error("Invalid legacy Soul record: project scope requires project_id");
  const subject = options.subject ?? { kind: "user", subject_id: "default" };
  const state: SoulRevisionState =
    record.state === "canonical"
      ? "active"
      : record.state === "archived"
        ? "superseded"
        : record.state === "quarantined"
          ? "conflicted"
          : "draft";
  return createSoulProfileRevision({
    subject,
    profile_id: options.profile_id,
    generation: options.generation ?? 1,
    clauses: [
      {
        clause_key: `legacy:${record.id}`,
        category: legacyCategory(record),
        text: legacyText(record),
        scope: record.scope === "global" ? { kind: "global" } : { kind: "project", project_id: record.project_id! },
        distribution: legacyDistribution(record, options.default_distribution ?? "personal_sync"),
        priority: record.priority === "high" ? 90 : record.priority === "low" ? 10 : 50,
        provenance_record_ids: [record.id]
      }
    ],
    state,
    approved: record.state === "canonical",
    ...(record.state === "canonical" ? { approval_receipt_id: `legacy-canonical:${record.id}` } : {}),
    created_at: record.updated_at
  });
}

/**
 * Aggregates a mixed v0.3 record set into at most one revision per lifecycle
 * state. In particular, every canonical legacy clause shares one active head,
 * avoiding an ambiguous generation-1 head for each old record.
 */
export function parseLegacySoulRecords(
  records: readonly MorynRecord[],
  options: LegacySoulRecordOptions = {}
): SoulProfileRevision[] {
  const parsed = records
    .map((record) => parseLegacySoulRecord(record, options))
    .filter((revision): revision is SoulProfileRevision => Boolean(revision));
  const groups = new Map<SoulRevisionState, SoulProfileRevision[]>();
  for (const revision of parsed) {
    groups.set(revision.state, [...(groups.get(revision.state) ?? []), revision]);
  }
  const stateOrder: SoulRevisionState[] = ["superseded", "active", "draft", "conflicted"];
  return stateOrder.flatMap((state) => {
    const revisions = groups.get(state);
    if (!revisions?.length) return [];
    const clauses = revisions
      .flatMap((revision) => revision.clauses)
      .sort((left, right) => compareCodeUnits(left.clause_id, right.clause_id));
    const recordIds = clauses.flatMap((clause) => clause.provenance_record_ids).sort(compareCodeUnits);
    const generation = options.generation ?? (state === "draft" || state === "conflicted" ? 2 : 1);
    const createdAt = revisions
      .map((revision) => revision.created_at)
      .filter((value): value is string => Boolean(value))
      .sort(compareCodeUnits)
      .at(-1);
    return [
      createSoulProfileRevision({
        subject: revisions[0]!.subject,
        profile_id: revisions[0]!.profile_id,
        generation,
        clauses,
        state,
        approved: state === "active",
        ...(state === "active"
          ? { approval_receipt_id: `legacy-canonical-bundle:${sha256(recordIds.join("\u0000")).slice(0, 24)}` }
          : {}),
        ...(createdAt ? { created_at: createdAt } : {})
      })
    ];
  });
}

function revisionOrder(left: SoulProfileRevision, right: SoulProfileRevision): number {
  return right.generation - left.generation || compareCodeUnits(right.revision_id, left.revision_id);
}

function revisionAncestors(
  revisionId: string,
  revisionsById: ReadonlyMap<string, SoulProfileRevision>
): Map<string, number> {
  const distances = new Map<string, number>([[revisionId, 0]]);
  const pending = [revisionId];
  for (let index = 0; index < pending.length; index += 1) {
    const currentId = pending[index]!;
    const currentDistance = distances.get(currentId)!;
    const current = revisionsById.get(currentId);
    if (!current) continue;
    for (const parentId of current.parent_revision_ids) {
      if (!revisionsById.has(parentId)) continue;
      const distance = currentDistance + 1;
      const previous = distances.get(parentId);
      if (previous !== undefined && previous <= distance) continue;
      distances.set(parentId, distance);
      pending.push(parentId);
    }
  }
  return distances;
}

function approvedActiveHeads(
  revisions: readonly SoulProfileRevision[],
  ancestorsByRevisionId: ReadonlyMap<string, ReadonlyMap<string, number>>
): SoulProfileRevision[] {
  const active = revisions.filter((revision) => revision.state === "active" && revision.approved);
  const heads = active.filter(
    (candidate) =>
      !active.some(
        (other) =>
          other.revision_id !== candidate.revision_id &&
          ancestorsByRevisionId.get(other.revision_id)?.has(candidate.revision_id)
      )
  );
  // A malformed cycle has no graph head. Preserve every participant so callers
  // fail closed as an ambiguous set rather than silently selecting by generation.
  return (heads.length ? heads : active).sort(revisionOrder);
}

function nearestCommonApprovedAncestor(
  tips: readonly SoulProfileRevision[],
  revisions: readonly SoulProfileRevision[],
  ancestorsByRevisionId: ReadonlyMap<string, ReadonlyMap<string, number>>,
  excludedRevisionIds: ReadonlySet<string> = new Set()
): SoulProfileRevision | undefined {
  if (!tips.length) return undefined;
  const distances = tips.map((tip) => ancestorsByRevisionId.get(tip.revision_id) ?? new Map([[tip.revision_id, 0]]));
  const candidates = revisions.filter(
    (revision) =>
      revision.approved &&
      (revision.state === "active" || revision.state === "superseded") &&
      !excludedRevisionIds.has(revision.revision_id) &&
      distances.every((distance) => distance.has(revision.revision_id))
  );
  return candidates.sort((left, right) => {
    const leftDistances = distances.map((distance) => distance.get(left.revision_id)!);
    const rightDistances = distances.map((distance) => distance.get(right.revision_id)!);
    return (
      Math.max(...leftDistances) - Math.max(...rightDistances) ||
      leftDistances.reduce((total, distance) => total + distance, 0) -
        rightDistances.reduce((total, distance) => total + distance, 0) ||
      right.generation - left.generation ||
      compareCodeUnits(left.revision_id, right.revision_id)
    );
  })[0];
}

export function selectLastKnownGoodSoulRevision(
  revisions: readonly SoulProfileRevision[],
  profileId: string
): SoulRevisionSelection {
  const relevant = revisions.filter((revision) => revision.profile_id === profileId).sort(revisionOrder);
  const revisionsById = new Map(relevant.map((revision) => [revision.revision_id, revision]));
  const ancestorsByRevisionId = new Map(
    relevant.map((revision) => [revision.revision_id, revisionAncestors(revision.revision_id, revisionsById)])
  );
  const ignored: SoulRevisionSelection["ignored_revision_ids"] = [];
  for (const revision of relevant) {
    if (!revision.approved) {
      ignored.push({ revision_id: revision.revision_id, reason: "unapproved" });
    } else if (revision.state === "draft") {
      ignored.push({ revision_id: revision.revision_id, reason: "draft" });
    } else if (revision.state === "superseded") {
      ignored.push({ revision_id: revision.revision_id, reason: "superseded" });
    } else if (revision.state === "conflicted") {
      ignored.push({ revision_id: revision.revision_id, reason: "conflicted" });
    }
  }
  const activeHeads = approvedActiveHeads(relevant, ancestorsByRevisionId);
  const unresolvedExplicitConflicts = relevant.filter(
    (revision) =>
      revision.state === "conflicted" &&
      !activeHeads.some((head) => ancestorsByRevisionId.get(head.revision_id)?.has(revision.revision_id))
  );
  const hasAmbiguousActiveHeads = activeHeads.length > 1;
  if (hasAmbiguousActiveHeads) {
    for (const head of activeHeads) {
      ignored.push({ revision_id: head.revision_id, reason: "ambiguous_active_head" });
    }
  }

  const conflictedRevisionIds = [
    ...new Set([
      ...unresolvedExplicitConflicts.map((revision) => revision.revision_id),
      ...(hasAmbiguousActiveHeads ? activeHeads.map((revision) => revision.revision_id) : [])
    ])
  ].sort(compareCodeUnits);
  const hasConflict = conflictedRevisionIds.length > 0;
  let selected: SoulProfileRevision | undefined;
  if (!hasConflict && activeHeads.length === 1) {
    selected = activeHeads[0];
  } else if (hasConflict) {
    const competingTips = [...activeHeads, ...unresolvedExplicitConflicts];
    selected = nearestCommonApprovedAncestor(
      competingTips,
      relevant,
      ancestorsByRevisionId,
      hasAmbiguousActiveHeads ? new Set(activeHeads.map((revision) => revision.revision_id)) : undefined
    );
  }
  if (!selected) {
    return {
      profile_id: profileId,
      status: "no_active_revision",
      conflicted_revision_ids: conflictedRevisionIds,
      ignored_revision_ids: ignored.sort((left, right) => compareCodeUnits(left.revision_id, right.revision_id))
    };
  }
  return {
    profile_id: profileId,
    status: hasConflict ? "using_last_known_good" : "active",
    selected_revision: selected,
    conflicted_revision_ids: conflictedRevisionIds,
    ignored_revision_ids: ignored
      .filter((item) => item.revision_id !== selected.revision_id)
      .sort((left, right) => compareCodeUnits(left.revision_id, right.revision_id))
  };
}

function profileIdsForSubject(revisions: readonly SoulProfileRevision[], kind: SoulSubject["kind"]): string[] {
  return [
    ...new Set(revisions.filter((revision) => revision.subject.kind === kind).map((revision) => revision.profile_id))
  ].sort(compareCodeUnits);
}

function resolveBoundProfileId(
  revisions: readonly SoulProfileRevision[],
  kind: SoulSubject["kind"],
  explicit: string | undefined
): { profile_id?: string; conflicts: SoulCompileConflict[] } {
  if (explicit) {
    const matching = revisions.filter((revision) => revision.profile_id === explicit);
    if (!matching.length) {
      return {
        conflicts: [
          {
            kind: "profile_binding_not_found",
            profile_id: explicit,
            detail: `The explicit ${kind} profile binding does not match a known Soul profile.`
          }
        ]
      };
    }
    if (matching.some((revision) => revision.subject.kind !== kind)) {
      const actualKinds = [...new Set(matching.map((revision) => revision.subject.kind))].sort(compareCodeUnits);
      return {
        conflicts: [
          {
            kind: "profile_subject_mismatch",
            profile_id: explicit,
            detail: `The explicit ${kind} profile binding resolves to subject kind${actualKinds.length > 1 ? "s" : ""} ${actualKinds.join(", ")}.`
          }
        ]
      };
    }
    return { profile_id: explicit, conflicts: [] };
  }
  const ids = profileIdsForSubject(revisions, kind);
  if (ids.length === 1) return { profile_id: ids[0], conflicts: [] };
  if (ids.length === 0) return { conflicts: [] };
  return {
    conflicts: [
      {
        kind: "ambiguous_profile_binding",
        profile_id: `unbound:${kind}`,
        profile_ids: ids,
        detail: `Multiple ${kind === "user" ? "user Soul" : "Agent Soul"} profiles are available; provide ${kind}_profile_id before delivery.`
      }
    ]
  };
}

function precedence(clause: SoulClause, subjectKind: SoulSubject["kind"]): number {
  if (subjectKind === "user" && PROTECTED_CATEGORIES.has(clause.category) && clause.scope.kind === "global") return 700;
  if (subjectKind === "user" && PROTECTED_CATEGORIES.has(clause.category)) return 600;
  if (subjectKind === "user" && clause.scope.kind === "project") return 500;
  if (subjectKind === "user") return 400;
  if (clause.scope.kind === "project") return 300;
  return 200;
}

function effectiveClause(revision: SoulProfileRevision, clause: SoulClause): EffectiveSoulClause {
  return {
    ...clause,
    profile_id: revision.profile_id,
    revision_id: revision.revision_id,
    subject_kind: revision.subject.kind,
    subject_id: revision.subject.subject_id,
    precedence: precedence(clause, revision.subject.kind)
  };
}

function clauseOrder(left: EffectiveSoulClause, right: EffectiveSoulClause): number {
  return (
    Number(right.mandatory) - Number(left.mandatory) ||
    right.precedence - left.precedence ||
    right.priority - left.priority ||
    compareCodeUnits(left.clause_key, right.clause_key) ||
    compareCodeUnits(left.clause_id, right.clause_id)
  );
}

function renderClauses(clauses: readonly EffectiveSoulClause[]): string {
  const lines = clauses.map((clause) => {
    const scope = clause.scope.kind === "global" ? "global" : `project:${clause.scope.project_id}`;
    return `- [${clause.subject_kind}/${clause.category}/${scope}] ${clause.text}`;
  });
  return ["Moryn Effective Soul v1", ...lines].join("\n");
}

/** A deterministic tokenizer estimate, not a model-specific tokenizer. */
export function estimateSoulTokens(text: string): number {
  const units = text.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|[^\s]/gu
  );
  return (units ?? []).reduce((total, unit) => {
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u.test(unit)) return total + 1;
    if (/^[\p{L}\p{N}_]+$/u.test(unit)) return total + Math.max(1, Math.ceil([...unit].length / 4));
    return total + 1;
  }, 0);
}

function requireBudget(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < 1)
    throw new Error(`Invalid Soul Profile: ${name} must be a positive integer`);
  return normalized;
}

function omissionReason(charsExceeded: boolean, tokensExceeded: boolean): SoulOmissionReason {
  if (charsExceeded && tokensExceeded) return "char_and_token_budget";
  return charsExceeded ? "char_budget" : "token_budget";
}

function sourceDigest(revisions: readonly SoulProfileRevision[]): string {
  return sha256(
    canonicalJson(
      [...revisions]
        .sort((left, right) => compareCodeUnits(left.profile_id, right.profile_id))
        .map((revision) => revisionIdentity(revision))
    )
  );
}

function revisionConflicts(selection: SoulRevisionSelection): SoulCompileConflict[] {
  if (!selection.conflicted_revision_ids.length) return [];
  const ambiguous = selection.ignored_revision_ids
    .filter((ignored) => ignored.reason === "ambiguous_active_head")
    .map((ignored) => ignored.revision_id);
  return [
    {
      kind: ambiguous.length ? "ambiguous_active_head" : "revision_conflict",
      profile_id: selection.profile_id,
      revision_ids: selection.conflicted_revision_ids,
      detail: ambiguous.length
        ? selection.selected_revision
          ? "Multiple approved active heads were found; the compiler retained their nearest common approved ancestor."
          : "Multiple approved active heads were found, but they have no common approved ancestor."
        : selection.selected_revision
          ? "A conflicted revision was ignored; the compiler retained the nearest common approved ancestor."
          : "A conflicted revision was found, but no common approved ancestor is available."
    }
  ];
}

function selectedRevisionMetadata(revision: SoulProfileRevision): SelectedSoulRevision {
  return {
    profile_id: revision.profile_id,
    revision_id: revision.revision_id,
    subject: revision.subject,
    generation: revision.generation,
    state: revision.state
  };
}

function effectiveSelection(selection: SoulRevisionSelection): EffectiveSoulRevisionSelection {
  return {
    profile_id: selection.profile_id,
    status: selection.status,
    ...(selection.selected_revision
      ? { selected_revision: selectedRevisionMetadata(selection.selected_revision) }
      : {}),
    conflicted_revision_ids: selection.conflicted_revision_ids,
    ignored_revision_ids: selection.ignored_revision_ids
  };
}

function composeByPrecedence(
  clauses: readonly EffectiveSoulClause[],
  omissions: SoulOmission[],
  conflicts: SoulCompileConflict[]
): EffectiveSoulClause[] {
  const byId = new Map(clauses.map((clause) => [clause.clause_id, clause]));
  const rejected = new Set<string>();
  for (const clause of clauses) {
    if (!clause.overrides_clause_id) continue;
    const target = byId.get(clause.overrides_clause_id);
    if (!target?.mandatory || target.text === clause.text) continue;
    rejected.add(clause.clause_id);
    omissions.push({
      clause_id: clause.clause_id,
      clause_key: clause.clause_key,
      mandatory: clause.mandatory,
      reason: "protected_clause_override",
      detail: `Cannot override mandatory ${target.category} clause ${target.clause_id}.`
    });
    conflicts.push({
      kind: "protected_clause_override",
      profile_id: clause.profile_id,
      clause_ids: [clause.clause_id, target.clause_id],
      detail: `Clause ${clause.clause_id} attempted to override protected clause ${target.clause_id}.`
    });
  }
  const groups = new Map<string, EffectiveSoulClause[]>();
  for (const clause of clauses.filter((candidate) => !rejected.has(candidate.clause_id))) {
    groups.set(clause.clause_key, [...(groups.get(clause.clause_key) ?? []), clause]);
  }
  const composed: EffectiveSoulClause[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort(clauseOrder);
    const protectedClause = ordered.find((clause) => clause.mandatory && PROTECTED_CATEGORIES.has(clause.category));
    const winner = protectedClause ?? ordered[0]!;
    composed.push(winner);
    for (const clause of ordered) {
      if (clause.clause_id === winner.clause_id) continue;
      const protectedOverride = Boolean(protectedClause && clause.text !== protectedClause.text);
      omissions.push({
        clause_id: clause.clause_id,
        clause_key: clause.clause_key,
        mandatory: clause.mandatory,
        reason: protectedOverride ? "protected_clause_override" : "overridden",
        detail: protectedOverride
          ? `The effective Soul retained protected clause ${protectedClause!.clause_id}.`
          : `Higher-precedence clause ${winner.clause_id} was selected.`
      });
      if (protectedOverride) {
        conflicts.push({
          kind: "protected_clause_override",
          profile_id: clause.profile_id,
          clause_ids: [clause.clause_id, protectedClause!.clause_id],
          detail: `Lower-precedence clause ${clause.clause_id} cannot weaken protected clause ${protectedClause!.clause_id}.`
        });
      }
    }
  }
  return composed.sort(clauseOrder);
}

export function compileEffectiveSoul(input: CompileEffectiveSoulInput): EffectiveSoul {
  const charLimit = requireBudget(input.char_budget, DEFAULT_CHAR_BUDGET, "char_budget");
  const tokenLimit = requireBudget(input.token_budget, DEFAULT_TOKEN_BUDGET, "token_budget");
  const allowedDistributions = new Set(input.allowed_distributions ?? SOUL_DISTRIBUTIONS);
  const userBinding = resolveBoundProfileId(input.revisions, "user", input.user_profile_id);
  const agentBinding = resolveBoundProfileId(input.revisions, "agent", input.agent_profile_id);
  const bindingConflicts: SoulCompileConflict[] = [...userBinding.conflicts, ...agentBinding.conflicts];
  const boundProfileIds = [
    ...new Set([userBinding.profile_id, agentBinding.profile_id].filter((value): value is string => Boolean(value)))
  ];
  const selections = boundProfileIds.map((profileId) => selectLastKnownGoodSoulRevision(input.revisions, profileId));
  const selectionsByProfileId = Object.fromEntries(
    selections.map((selection) => [selection.profile_id, effectiveSelection(selection)])
  );
  const selectedRevisionPayloads = selections
    .map((selection) => selection.selected_revision)
    .filter((revision): revision is SoulProfileRevision => Boolean(revision))
    .sort((left, right) => compareCodeUnits(left.profile_id, right.profile_id));
  const selectedRevisions: SelectedSoulRevision[] = selectedRevisionPayloads.map(selectedRevisionMetadata);
  const omissions: SoulOmission[] = [];
  const conflicts = [...bindingConflicts, ...selections.flatMap(revisionConflicts)];
  const applicable: EffectiveSoulClause[] = [];
  for (const revision of selectedRevisionPayloads) {
    for (const clause of revision.clauses) {
      if (clause.scope.kind === "project" && clause.scope.project_id !== input.project_id) {
        omissions.push({
          clause_id: clause.clause_id,
          clause_key: clause.clause_key,
          mandatory: clause.mandatory,
          reason: "scope_mismatch"
        });
        continue;
      }
      if (!allowedDistributions.has(clause.distribution)) {
        omissions.push({
          clause_id: clause.clause_id,
          clause_key: clause.clause_key,
          mandatory: clause.mandatory,
          reason: "distribution_filtered"
        });
        continue;
      }
      applicable.push(effectiveClause(revision, clause));
    }
  }
  const composed = composeByPrecedence(applicable, omissions, conflicts);
  const mandatory = composed.filter((clause) => clause.mandatory);
  const optional = composed.filter((clause) => !clause.mandatory);
  const mandatoryRendered = renderClauses(mandatory);
  const mandatoryChars = [...mandatoryRendered].length;
  const mandatoryTokens = estimateSoulTokens(mandatoryRendered);
  const mandatoryExceedsBudget = mandatoryChars > charLimit || mandatoryTokens > tokenLimit;
  let included = [...mandatory];
  if (mandatoryExceedsBudget) {
    for (const clause of optional) {
      omissions.push({
        clause_id: clause.clause_id,
        clause_key: clause.clause_key,
        mandatory: false,
        reason: "mandatory_budget_exceeded",
        detail: "Optional clause was withheld because mandatory clauses already exceed the delivery budget."
      });
    }
  } else {
    for (const clause of optional) {
      const candidate = [...included, clause].sort(clauseOrder);
      const renderedCandidate = renderClauses(candidate);
      const charsExceeded = [...renderedCandidate].length > charLimit;
      const tokensExceeded = estimateSoulTokens(renderedCandidate) > tokenLimit;
      if (charsExceeded || tokensExceeded) {
        omissions.push({
          clause_id: clause.clause_id,
          clause_key: clause.clause_key,
          mandatory: false,
          reason: omissionReason(charsExceeded, tokensExceeded)
        });
      } else {
        included = candidate;
      }
    }
  }
  included.sort(clauseOrder);
  omissions.sort(
    (left, right) => compareCodeUnits(left.clause_id, right.clause_id) || compareCodeUnits(left.reason, right.reason)
  );
  conflicts.sort(
    (left, right) =>
      compareCodeUnits(left.profile_id, right.profile_id) ||
      compareCodeUnits(left.kind, right.kind) ||
      compareCodeUnits(left.detail, right.detail)
  );
  const rendered = renderClauses(included);
  const unresolvedRevisionConflict = selections.some(
    (selection) => selection.conflicted_revision_ids.length > 0 && !selection.selected_revision
  );
  const deliverable = !mandatoryExceedsBudget && bindingConflicts.length === 0 && !unresolvedRevisionConflict;
  const status = !deliverable ? "blocked" : omissions.length || conflicts.length ? "ready_with_omissions" : "ready";
  return {
    version: 1,
    status,
    deliverable,
    ...(input.project_id ? { project_id: input.project_id } : {}),
    selected_revisions: selectedRevisions,
    selections_by_profile_id: selectionsByProfileId,
    clauses: included,
    clauses_by_id: Object.fromEntries(included.map((clause) => [clause.clause_id, clause])),
    omissions,
    conflicts,
    budget: {
      char_limit: charLimit,
      token_limit: tokenLimit,
      chars_used: [...rendered].length,
      tokens_used: estimateSoulTokens(rendered),
      mandatory_exceeds_budget: mandatoryExceedsBudget
    },
    rendered,
    source_digest: sourceDigest(selectedRevisionPayloads),
    rendered_digest: sha256(rendered)
  };
}
