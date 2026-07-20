import {
  listSoulApprovalReceipts,
  type SoulApprovalAction,
  type SoulApprovalReceipt,
  writeSoulApprovalReceipt
} from "./soul-approval-receipts.js";
import { listSoulDeliveryReceipts, type SoulDeliveryReceipt } from "./soul-delivery-receipts.js";
import {
  type CompileEffectiveSoulInput,
  compileEffectiveSoul,
  createSoulClause,
  createSoulProfileRevision,
  type EffectiveSoul,
  type SoulClause,
  type SoulClauseInput,
  type SoulProfileRevision,
  type SoulSubject,
  selectLastKnownGoodSoulRevision,
  soulProfilePersonalSyncDigest,
  soulProfileRevisionDigest,
  stableSoulProfileId
} from "./soul-profile.js";
import {
  type ReadSoulProfileRevisionsResult,
  readSoulProfileRevisions,
  type SoulProfileLoadWarning,
  type WriteSoulProfileRevisionResult,
  writeSoulProfileRevision
} from "./soul-profile-store.js";
import type { RecordSource } from "./types.js";

export interface CreateSoulProfileDraftInput {
  source: RecordSource;
  occurred_at: string;
  subject?: SoulSubject;
  profile_id?: string;
  clauses?: readonly (SoulClause | SoulClauseInput)[];
  from_revision_id?: string;
}

export interface CreateSoulProfileDraftResult {
  created: boolean;
  revision: SoulProfileRevision;
  persistence: WriteSoulProfileRevisionResult;
}

export interface ApproveSoulProfileDraftInput {
  revision_id: string;
  confirmed?: boolean;
  source: RecordSource;
  occurred_at: string;
}

export interface RollbackSoulProfileInput {
  target_revision_id: string;
  profile_id: string;
  confirmed?: boolean;
  source: RecordSource;
  occurred_at: string;
}

export interface SoulProfileActivationResult {
  created: boolean;
  revision: SoulProfileRevision;
  persistence: WriteSoulProfileRevisionResult;
  approval_receipt: SoulApprovalReceipt;
  approval_receipt_created: boolean;
}

export interface SoulProfileRevisionStatus {
  revision_id: string;
  generation: number;
  parent_revision_ids: string[];
  state: SoulProfileRevision["state"];
  approved: boolean;
  approval_receipt_id?: string;
  approval_receipt_verified: boolean;
  is_head: boolean;
  is_effective: boolean;
  local_saved: boolean;
  personal_sync_saved: boolean;
  created_at?: string;
}

export interface SoulProfileStatusEntry {
  profile_id: string;
  subject: SoulSubject;
  revision_count: number;
  head_revision_ids: string[];
  active_revision_id?: string;
  selection_status: "active" | "using_last_known_good" | "no_active_revision";
  conflicted: boolean;
  conflicted_revision_ids: string[];
  revisions: SoulProfileRevisionStatus[];
}

export interface SoulCompilationStatus {
  status: "not_configured" | EffectiveSoul["status"];
  deliverable: boolean;
  selected_revision_ids: string[];
  source_digest: string;
  rendered_digest: string;
  budget: EffectiveSoul["budget"];
  omissions: Array<Pick<EffectiveSoul["omissions"][number], "clause_id" | "mandatory" | "reason">>;
  conflicts: Array<{
    kind: EffectiveSoul["conflicts"][number]["kind"];
    profile_id: string;
    profile_ids?: string[];
    revision_ids?: string[];
    clause_ids?: string[];
  }>;
}

export interface SoulApprovalReceiptMetadata {
  receipt_id: string;
  action: SoulApprovalAction;
  profile_id: string;
  source_revision_id: string;
  approved_revision_id: string;
  source_revision_digest: string;
  source_projection_digest: string;
  confirmed: true;
  approved_at: string;
  integrity_digest: string;
}

export interface SoulDeliveryReceiptMetadata extends SoulDeliveryReceipt {
  current_compilation: boolean;
}

export interface SoulProfileStatus {
  version: 1;
  profiles: SoulProfileStatusEntry[];
  compilation: SoulCompilationStatus;
  approval_receipts: SoulApprovalReceiptMetadata[];
  delivery: {
    host_context_prepared: boolean;
    current_receipt_ids: string[];
    receipts: SoulDeliveryReceiptMetadata[];
  };
  warnings: SoulProfileLoadWarning[];
}

export type ReadSoulProfileStatusOptions = Omit<CompileEffectiveSoulInput, "revisions">;

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
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sameSubject(left: SoulSubject, right: SoulSubject): boolean {
  return left.kind === right.kind && left.subject_id.trim() === right.subject_id.trim();
}

function revisionsForProfile(revisions: readonly SoulProfileRevision[], profileId: string): SoulProfileRevision[] {
  return revisions
    .filter((revision) => revision.profile_id === profileId)
    .sort((left, right) => left.generation - right.generation || compareCodeUnits(left.revision_id, right.revision_id));
}

function profileHeads(revisions: readonly SoulProfileRevision[]): SoulProfileRevision[] {
  const revisionIds = new Set(revisions.map((revision) => revision.revision_id));
  const referenced = new Set(
    revisions.flatMap((revision) => revision.parent_revision_ids.filter((parentId) => revisionIds.has(parentId)))
  );
  return revisions
    .filter((revision) => !referenced.has(revision.revision_id))
    .sort((left, right) => left.generation - right.generation || compareCodeUnits(left.revision_id, right.revision_id));
}

function generationAfter(parents: readonly SoulProfileRevision[]): number {
  return parents.reduce((maximum, revision) => Math.max(maximum, revision.generation), 0) + 1;
}

function uniqueRevisions(revisions: readonly SoulProfileRevision[]): SoulProfileRevision[] {
  return [...new Map(revisions.map((revision) => [revision.revision_id, revision])).values()].sort(
    (left, right) => left.generation - right.generation || compareCodeUnits(left.revision_id, right.revision_id)
  );
}

function requireRevision(
  loaded: ReadSoulProfileRevisionsResult,
  revisionId: string,
  operation: string
): SoulProfileRevision {
  const revision = loaded.stored_revisions_by_id[revisionId];
  if (!revision) throw new Error(`Cannot ${operation} Soul Profile: revision ${revisionId} was not found`);
  return revision;
}

function preserveLocalOnlyClausesForPartialParent(
  loaded: ReadSoulProfileRevisionsResult,
  parent: SoulProfileRevision,
  authoredClauses: readonly (SoulClause | SoulClauseInput)[]
): readonly (SoulClause | SoulClauseInput)[] {
  if (!loaded.partial_revision_ids.includes(parent.revision_id)) return authoredClauses;
  const localRevision = loaded.local_revision_ids
    .map((revisionId) => loaded.stored_revisions_by_id[revisionId])
    .filter(
      (revision): revision is SoulProfileRevision =>
        Boolean(revision?.profile_id === parent.profile_id) &&
        revision!.clauses.some((clause) => clause.distribution === "local_only")
    )
    .sort(
      (left, right) =>
        left.generation - right.generation ||
        compareCodeUnits(left.created_at ?? "", right.created_at ?? "") ||
        compareCodeUnits(left.revision_id, right.revision_id)
    )
    .at(-1);
  if (!localRevision) return authoredClauses;

  const normalizedAuthored = authoredClauses.map((clause) =>
    "clause_id" in clause ? clause : createSoulClause(parent.profile_id, clause)
  );
  const authoredClauseIds = new Set(normalizedAuthored.map((clause) => clause.clause_id));
  return [
    ...normalizedAuthored,
    ...localRevision.clauses.filter(
      (clause) => clause.distribution === "local_only" && !authoredClauseIds.has(clause.clause_id)
    )
  ];
}

function requireClauses(clauses: readonly (SoulClause | SoulClauseInput)[] | undefined): void {
  if (!clauses?.length) throw new Error("Cannot create Soul Profile draft: at least one clause is required");
}

function persistenceFromLoaded(
  loaded: ReadSoulProfileRevisionsResult,
  revision: SoulProfileRevision
): WriteSoulProfileRevisionResult {
  return {
    revision_id: revision.revision_id,
    profile_id: revision.profile_id,
    local_saved: loaded.local_revision_ids.includes(revision.revision_id),
    personal_sync_saved: loaded.personal_sync_revision_ids.includes(revision.revision_id),
    personal_sync_event_created: false
  };
}

export { soulProfileRevisionDigest };

export async function createSoulProfileDraft(
  storePath: string,
  input: CreateSoulProfileDraftInput
): Promise<CreateSoulProfileDraftResult> {
  const loaded = await readSoulProfileRevisions(storePath);
  let subject: SoulSubject;
  let profileId: string;
  let clauses: readonly (SoulClause | SoulClauseInput)[];
  let parents: SoulProfileRevision[];

  if (input.from_revision_id) {
    if (input.subject || input.profile_id) {
      throw new Error("Cannot derive Soul Profile draft with a different subject or profile_id");
    }
    const parent = requireRevision(loaded, input.from_revision_id, "derive");
    subject = parent.subject;
    profileId = parent.profile_id;
    clauses = preserveLocalOnlyClausesForPartialParent(loaded, parent, input.clauses ?? parent.clauses);
    parents = [parent];
  } else {
    if (!input.subject) throw new Error("Cannot create Soul Profile draft: subject is required");
    requireClauses(input.clauses);
    subject = input.subject;
    profileId = input.profile_id?.trim() || stableSoulProfileId(subject);
    clauses = input.clauses!;
    const existing = revisionsForProfile(loaded.stored_revisions, profileId);
    const mismatched = existing.find((revision) => !sameSubject(revision.subject, subject));
    if (mismatched)
      throw new Error(`Cannot create Soul Profile draft: profile ${profileId} belongs to another subject`);
    parents = profileHeads(existing);
  }
  requireClauses(clauses);

  const revision = createSoulProfileRevision({
    subject,
    profile_id: profileId,
    generation: generationAfter(parents),
    parent_revision_ids: parents.map((parent) => parent.revision_id),
    clauses,
    state: "draft",
    approved: false,
    created_at: input.occurred_at
  });
  if (
    !input.from_revision_id &&
    parents.length === 1 &&
    parents[0]!.state === "draft" &&
    !parents[0]!.approved &&
    canonicalJson(parents[0]!.clauses) === canonicalJson(revision.clauses)
  ) {
    return {
      created: false,
      revision: parents[0]!,
      persistence: persistenceFromLoaded(loaded, parents[0]!)
    };
  }
  const existing = loaded.stored_revisions_by_id[revision.revision_id];
  if (existing) {
    if (existing.state !== "draft" || existing.approved) {
      throw new Error(`Cannot create Soul Profile draft: revision identity ${revision.revision_id} is not a draft`);
    }
    return { created: false, revision: existing, persistence: persistenceFromLoaded(loaded, existing) };
  }
  const persistence = await writeSoulProfileRevision(storePath, {
    revision,
    source: input.source,
    occurred_at: input.occurred_at
  });
  return { created: true, revision, persistence };
}

function matchingActivation(
  action: SoulApprovalAction,
  sourceRevisionId: string,
  receipts: readonly SoulApprovalReceipt[],
  loaded: ReadSoulProfileRevisionsResult,
  allowedApprovedRevisionIds?: ReadonlySet<string>
): { receipt: SoulApprovalReceipt; revision: SoulProfileRevision } | undefined {
  for (const receipt of receipts) {
    if (
      receipt.action !== action ||
      receipt.source_revision_id !== sourceRevisionId ||
      (allowedApprovedRevisionIds !== undefined && !allowedApprovedRevisionIds.has(receipt.approved_revision_id))
    ) {
      continue;
    }
    const revision = loaded.revisions_by_id[receipt.approved_revision_id];
    const sourceRevision = loaded.stored_revisions_by_id[sourceRevisionId];
    if (
      revision?.state === "active" &&
      revision.approved &&
      sourceRevision &&
      loaded.verified_approval_revision_ids.includes(revision.revision_id) &&
      revision.approval_receipt_id === receipt.receipt_id &&
      soulProfileRevisionDigest(sourceRevision) === receipt.source_revision_digest &&
      soulProfilePersonalSyncDigest(sourceRevision) === receipt.source_projection_digest
    ) {
      return { receipt, revision };
    }
  }
  return undefined;
}

async function activateFromRevision(
  storePath: string,
  input: {
    action: SoulApprovalAction;
    sourceRevision: SoulProfileRevision;
    parents: SoulProfileRevision[];
    confirmed?: boolean;
    source: RecordSource;
    occurred_at: string;
  }
): Promise<SoulProfileActivationResult> {
  if (input.confirmed !== true) throw new Error("Soul Profile activation requires explicit user confirmation");
  const provisional = createSoulProfileRevision({
    subject: input.sourceRevision.subject,
    profile_id: input.sourceRevision.profile_id,
    generation: generationAfter(input.parents),
    parent_revision_ids: input.parents.map((revision) => revision.revision_id),
    clauses: input.sourceRevision.clauses,
    state: "active",
    approved: true,
    created_at: input.occurred_at
  });
  const receiptWrite = await writeSoulApprovalReceipt(storePath, {
    action: input.action,
    profile_id: provisional.profile_id,
    source_revision_id: input.sourceRevision.revision_id,
    approved_revision_id: provisional.revision_id,
    source_revision_digest: soulProfileRevisionDigest(input.sourceRevision),
    source_projection_digest: soulProfilePersonalSyncDigest(input.sourceRevision),
    confirmed: true,
    approved_at: input.occurred_at,
    source: input.source
  });
  const revision = createSoulProfileRevision({
    subject: provisional.subject,
    profile_id: provisional.profile_id,
    generation: provisional.generation,
    parent_revision_ids: provisional.parent_revision_ids,
    clauses: provisional.clauses,
    state: "active",
    approved: true,
    approval_receipt_id: receiptWrite.receipt.receipt_id,
    created_at: input.occurred_at
  });
  if (revision.revision_id !== receiptWrite.receipt.approved_revision_id) {
    throw new Error("Soul Profile activation identity changed after approval receipt creation");
  }
  const persistence = await writeSoulProfileRevision(storePath, {
    revision,
    source: input.source,
    confirmed: true,
    occurred_at: input.occurred_at
  });
  return {
    created: true,
    revision,
    persistence,
    approval_receipt: receiptWrite.receipt,
    approval_receipt_created: receiptWrite.created
  };
}

export async function approveSoulProfileDraft(
  storePath: string,
  input: ApproveSoulProfileDraftInput
): Promise<SoulProfileActivationResult> {
  if (input.confirmed !== true) throw new Error("Soul Profile activation requires explicit user confirmation");
  const loaded = await readSoulProfileRevisions(storePath);
  const draft = requireRevision(loaded, input.revision_id, "approve");
  if (draft.state !== "draft" || draft.approved) {
    throw new Error(`Cannot approve Soul Profile revision ${draft.revision_id}: revision is not an unapproved draft`);
  }
  const prior = matchingActivation("approve", draft.revision_id, await listSoulApprovalReceipts(storePath), loaded);
  if (prior) {
    return {
      created: false,
      revision: prior.revision,
      persistence: persistenceFromLoaded(loaded, prior.revision),
      approval_receipt: prior.receipt,
      approval_receipt_created: false
    };
  }
  const profile = revisionsForProfile(loaded.stored_revisions, draft.profile_id);
  return activateFromRevision(storePath, {
    action: "approve",
    sourceRevision: draft,
    parents: uniqueRevisions([...profileHeads(profile), draft]),
    confirmed: input.confirmed,
    source: input.source,
    occurred_at: input.occurred_at
  });
}

export async function rollbackSoulProfile(
  storePath: string,
  input: RollbackSoulProfileInput
): Promise<SoulProfileActivationResult> {
  if (input.confirmed !== true) throw new Error("Soul Profile rollback requires explicit user confirmation");
  if (typeof input.profile_id !== "string" || !input.profile_id.trim()) {
    throw new Error("Cannot roll back Soul Profile: profile_id is required");
  }
  const loaded = await readSoulProfileRevisions(storePath);
  const target = requireRevision(loaded, input.target_revision_id, "roll back");
  if (input.profile_id.trim() !== target.profile_id) {
    throw new Error("Cannot roll back Soul Profile: target revision belongs to another profile");
  }
  if (!target.approved || (target.state !== "active" && target.state !== "superseded")) {
    throw new Error("Cannot roll back Soul Profile: target revision was never an approved active revision");
  }
  const safeTarget = loaded.revisions_by_id[target.revision_id];
  if (!safeTarget?.approved) {
    throw new Error("Cannot roll back Soul Profile: target revision approval is not verified");
  }
  const profile = revisionsForProfile(loaded.stored_revisions, target.profile_id);
  const heads = profileHeads(profile);
  const prior = matchingActivation(
    "rollback",
    target.revision_id,
    await listSoulApprovalReceipts(storePath),
    loaded,
    new Set(heads.map((revision) => revision.revision_id))
  );
  if (prior) {
    return {
      created: false,
      revision: prior.revision,
      persistence: persistenceFromLoaded(loaded, prior.revision),
      approval_receipt: prior.receipt,
      approval_receipt_created: false
    };
  }
  if (heads.length === 1 && heads[0]?.revision_id === target.revision_id) {
    throw new Error("Cannot roll back Soul Profile: target revision is already the active head");
  }
  return activateFromRevision(storePath, {
    action: "rollback",
    sourceRevision: target,
    parents: uniqueRevisions([...heads, target]),
    confirmed: input.confirmed,
    source: input.source,
    occurred_at: input.occurred_at
  });
}

function approvalMetadata(receipt: SoulApprovalReceipt): SoulApprovalReceiptMetadata {
  return {
    receipt_id: receipt.receipt_id,
    action: receipt.action,
    profile_id: receipt.profile_id,
    source_revision_id: receipt.source_revision_id,
    approved_revision_id: receipt.approved_revision_id,
    source_revision_digest: receipt.source_revision_digest,
    source_projection_digest: receipt.source_projection_digest,
    confirmed: true,
    approved_at: receipt.approved_at,
    integrity_digest: receipt.integrity_digest
  };
}

function compilationStatus(effective: EffectiveSoul): SoulCompilationStatus {
  const configured = effective.selected_revisions.length > 0;
  return {
    status: configured ? effective.status : "not_configured",
    deliverable: configured && effective.deliverable,
    selected_revision_ids: effective.selected_revisions.map((revision) => revision.revision_id).sort(compareCodeUnits),
    source_digest: effective.source_digest,
    rendered_digest: effective.rendered_digest,
    budget: effective.budget,
    omissions: effective.omissions.map((omission) => ({
      clause_id: omission.clause_id,
      mandatory: omission.mandatory,
      reason: omission.reason
    })),
    conflicts: effective.conflicts.map((conflict) => ({
      kind: conflict.kind,
      profile_id: conflict.profile_id,
      ...(conflict.profile_ids ? { profile_ids: conflict.profile_ids } : {}),
      ...(conflict.revision_ids ? { revision_ids: conflict.revision_ids } : {}),
      ...(conflict.clause_ids ? { clause_ids: conflict.clause_ids } : {})
    }))
  };
}

function profileStatus(
  revisions: SoulProfileRevision[],
  loaded: ReadSoulProfileRevisionsResult,
  verifiedApprovalRevisionIds: ReadonlySet<string>,
  effectiveRevisionIds: Set<string>
): SoulProfileStatusEntry {
  const heads = profileHeads(revisions);
  const headIds = new Set(heads.map((revision) => revision.revision_id));
  const selection = selectLastKnownGoodSoulRevision(revisions, revisions[0]!.profile_id);
  const conflictedRevisionIds = [
    ...new Set([
      ...selection.conflicted_revision_ids,
      ...heads.filter((revision) => revision.state === "conflicted").map((revision) => revision.revision_id),
      ...(heads.length > 1 ? heads.map((revision) => revision.revision_id) : [])
    ])
  ].sort(compareCodeUnits);
  return {
    profile_id: revisions[0]!.profile_id,
    subject: revisions.at(-1)!.subject,
    revision_count: revisions.length,
    head_revision_ids: heads.map((revision) => revision.revision_id),
    ...(selection.selected_revision ? { active_revision_id: selection.selected_revision.revision_id } : {}),
    selection_status: selection.status,
    conflicted: heads.length > 1 || conflictedRevisionIds.length > 0,
    conflicted_revision_ids: conflictedRevisionIds,
    revisions: revisions.map((revision) => ({
      revision_id: revision.revision_id,
      generation: revision.generation,
      parent_revision_ids: revision.parent_revision_ids,
      state: revision.state,
      approved: revision.approved,
      ...(revision.approval_receipt_id ? { approval_receipt_id: revision.approval_receipt_id } : {}),
      approval_receipt_verified: verifiedApprovalRevisionIds.has(revision.revision_id),
      is_head: headIds.has(revision.revision_id),
      is_effective: effectiveRevisionIds.has(revision.revision_id),
      local_saved: loaded.local_revision_ids.includes(revision.revision_id),
      personal_sync_saved: loaded.personal_sync_revision_ids.includes(revision.revision_id),
      ...(revision.created_at ? { created_at: revision.created_at } : {})
    }))
  };
}

function deliveryMetadata(
  receipt: SoulDeliveryReceipt,
  effective: EffectiveSoul,
  effectiveRevisionIds: Set<string>
): SoulDeliveryReceiptMetadata {
  return {
    ...receipt,
    current_compilation:
      receipt.source_digest === effective.source_digest &&
      receipt.rendered_digest === effective.rendered_digest &&
      receipt.project_id === effective.project_id &&
      receipt.source_revision_ids.every((revisionId) => effectiveRevisionIds.has(revisionId))
  };
}

export async function readSoulProfileStatus(
  storePath: string,
  options: ReadSoulProfileStatusOptions = {}
): Promise<SoulProfileStatus> {
  const loaded = await readSoulProfileRevisions(storePath);
  const [localApprovalReceipts, deliveryReceipts] = await Promise.all([
    listSoulApprovalReceipts(storePath),
    listSoulDeliveryReceipts(storePath)
  ]);
  const approvalReceipts = [
    ...new Map(
      [...localApprovalReceipts, ...loaded.approval_attestations].map((receipt) => [receipt.receipt_id, receipt])
    ).values()
  ].sort(
    (left, right) =>
      right.approved_at.localeCompare(left.approved_at) || compareCodeUnits(left.receipt_id, right.receipt_id)
  );
  const effective = compileEffectiveSoul({ revisions: loaded.revisions, ...options });
  const effectiveRevisionIds = new Set(effective.selected_revisions.map((revision) => revision.revision_id));
  const verifiedApprovalRevisionIds = new Set(loaded.verified_approval_revision_ids);
  const profileIds = [...new Set(loaded.stored_revisions.map((revision) => revision.profile_id))].sort(
    compareCodeUnits
  );
  const deliveries = deliveryReceipts.map((receipt) => deliveryMetadata(receipt, effective, effectiveRevisionIds));
  const currentReceiptIds = deliveries
    .filter((receipt) => receipt.current_compilation)
    .map((receipt) => receipt.receipt_id)
    .sort(compareCodeUnits);
  const deliveredRevisionIds = new Set(
    deliveries.filter((receipt) => receipt.current_compilation).flatMap((receipt) => receipt.source_revision_ids)
  );
  return {
    version: 1,
    profiles: profileIds.map((profileId) =>
      profileStatus(
        revisionsForProfile(loaded.stored_revisions, profileId),
        loaded,
        verifiedApprovalRevisionIds,
        effectiveRevisionIds
      )
    ),
    compilation: compilationStatus(effective),
    approval_receipts: approvalReceipts.map(approvalMetadata),
    delivery: {
      host_context_prepared:
        effectiveRevisionIds.size > 0 &&
        [...effectiveRevisionIds].every((revisionId) => deliveredRevisionIds.has(revisionId)),
      current_receipt_ids: currentReceiptIds,
      receipts: deliveries
    },
    warnings: loaded.warnings
  };
}
