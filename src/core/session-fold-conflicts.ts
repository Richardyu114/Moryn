import { isPrivateMemoryBoundary } from "./sensitive.js";
import type { MorynRecord } from "./types.js";

interface SessionFoldConflictIdentity {
  project_id: string;
  session_id: string;
}

export interface SessionFoldConflictDiagnostic {
  version: 1;
  kind: "competing_session_rollups";
  identity: SessionFoldConflictIdentity;
  resolution: "needs_review";
  rollup_record_ids: string[];
  plan_ids: string[];
  source_digests: string[];
  overlapping_source_record_ids: string[];
}

interface SessionRollupEvidence {
  record: MorynRecord;
  identity: SessionFoldConflictIdentity;
  private_boundary: boolean;
  plan_id: string;
  source_digest: string;
  source_record_ids: string[];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonEmptyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const strings: string[] = [];
  for (const item of value) {
    const normalized = nonEmptyString(item);
    if (normalized) strings.push(normalized);
  }
  return uniqueSorted(strings);
}

function sessionRollupEvidence(record: MorynRecord): SessionRollupEvidence | undefined {
  if (
    record.kind !== "session_summary" ||
    record.type !== "session_rollup" ||
    record.content.session_fold_version !== 1
  ) {
    return undefined;
  }
  const projectId = nonEmptyString(record.project_id);
  const sessionId = nonEmptyString(record.content.session_id);
  const sourceSessionId = nonEmptyString(record.source.session_id);
  const planId = nonEmptyString(record.content.session_fold_plan_id);
  const sourceDigest = nonEmptyString(record.content.source_digest);
  const sourceRecordIds = nonEmptyStrings(record.content.source_record_ids);
  if (
    !projectId ||
    !sessionId ||
    !sourceSessionId ||
    sourceSessionId !== sessionId ||
    !planId ||
    !sourceDigest ||
    sourceRecordIds.length === 0
  ) {
    return undefined;
  }
  return {
    record,
    identity: { project_id: projectId, session_id: sessionId },
    private_boundary: isPrivateMemoryBoundary(record),
    plan_id: planId,
    source_digest: sourceDigest,
    source_record_ids: sourceRecordIds
  };
}

function activeSessionRollup(record: MorynRecord): SessionRollupEvidence | undefined {
  if (record.visibility !== "active" || record.state === "archived" || record.state === "quarantined") {
    return undefined;
  }
  return sessionRollupEvidence(record);
}

function identityKey(identity: SessionFoldConflictIdentity): string {
  return `${identity.project_id}\u0000${identity.session_id}`;
}

function conflictGroupKey(evidence: SessionRollupEvidence): string {
  return `${identityKey(evidence.identity)}\u0000${evidence.private_boundary ? "private" : "public"}`;
}

/**
 * Detects independently committed L1 rollups for the same project/session.
 * A deterministic Session Fold produces one record id per complete source set,
 * so multiple active ids are competing offline views that require review.
 */
export function detectSessionFoldConflicts(records: readonly MorynRecord[]): SessionFoldConflictDiagnostic[] {
  const groups = new Map<string, SessionRollupEvidence[]>();
  for (const record of records) {
    const evidence = activeSessionRollup(record);
    if (!evidence) continue;
    const key = conflictGroupKey(evidence);
    const group = groups.get(key) ?? [];
    group.push(evidence);
    groups.set(key, group);
  }

  const diagnostics: SessionFoldConflictDiagnostic[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => compareCodeUnits(left.record.id, right.record.id));
    if (new Set(ordered.map((entry) => entry.record.id)).size < 2) continue;
    const sourceUseCount = new Map<string, number>();
    for (const sourceId of ordered.flatMap((entry) => entry.source_record_ids)) {
      sourceUseCount.set(sourceId, (sourceUseCount.get(sourceId) ?? 0) + 1);
    }
    diagnostics.push({
      version: 1,
      kind: "competing_session_rollups",
      identity: ordered[0]!.identity,
      resolution: "needs_review",
      rollup_record_ids: ordered.map((entry) => entry.record.id),
      plan_ids: uniqueSorted(ordered.map((entry) => entry.plan_id)),
      source_digests: uniqueSorted(ordered.map((entry) => entry.source_digest)),
      overlapping_source_record_ids: [...sourceUseCount.entries()]
        .filter(([, count]) => count > 1)
        .map(([recordId]) => recordId)
        .sort(compareCodeUnits)
    });
  }
  return diagnostics.sort(
    (left, right) =>
      compareCodeUnits(left.identity.project_id, right.identity.project_id) ||
      compareCodeUnits(left.identity.session_id, right.identity.session_id)
  );
}

function withoutStaleProjectedConflicts(records: readonly MorynRecord[]): MorynRecord[] {
  const rollupsById = new Map<string, SessionRollupEvidence>();
  for (const record of records) {
    const evidence = sessionRollupEvidence(record);
    if (evidence) rollupsById.set(record.id, evidence);
  }
  return records.map((record) => {
    if (record.conflict?.resolution !== "needs_review") return record;
    const evidence = rollupsById.get(record.id);
    if (!evidence) return record;
    const retained = uniqueSorted(
      record.conflict.with.filter((recordId) => {
        const linked = rollupsById.get(recordId);
        return !linked || identityKey(linked.identity) !== identityKey(evidence.identity);
      })
    );
    if (retained.length === record.conflict.with.length) return record;
    if (retained.length > 0) return { ...record, conflict: { ...record.conflict, with: retained } };
    const withoutConflict = { ...record };
    delete withoutConflict.conflict;
    return withoutConflict;
  });
}

/**
 * Recomputes the deterministic read-only semantic conflict projection.
 * Derived rollup-to-rollup conflict edges are removed before current active
 * competitors are added, so archiving an old rollup cannot leave stale state.
 */
export function annotateSessionFoldConflicts(
  records: readonly MorynRecord[],
  diagnostics: readonly SessionFoldConflictDiagnostic[] = detectSessionFoldConflicts(records)
): MorynRecord[] {
  const competingById = new Map<string, string[]>();
  for (const diagnostic of diagnostics) {
    for (const recordId of diagnostic.rollup_record_ids) {
      competingById.set(
        recordId,
        diagnostic.rollup_record_ids.filter((candidate) => candidate !== recordId)
      );
    }
  }
  return withoutStaleProjectedConflicts(records).map((record) => {
    const competing = competingById.get(record.id);
    if (!competing) return record;
    return {
      ...record,
      conflict: {
        kind: "semantic",
        with: uniqueSorted([...(record.conflict?.with ?? []), ...competing]),
        resolution: "needs_review"
      }
    };
  });
}
