import { createHash } from "node:crypto";
import type { MorynRecord } from "./types.js";

export interface IncomingSessionIdentity {
  project_id: string;
  host: string;
  session_id: string;
  device_id: string;
}

export type FinalizationAssuranceSelection =
  | { status: "nothing_to_finalize" }
  | {
      status: "already_finalized";
      prior_session: { host: string; session_id: string; device_id: string };
      final_record_id: string;
      evidence_record_ids: string[];
    }
  | {
      status: "eligible";
      prior_session: { host: string; session_id: string; device_id: string };
      latest_evidence_at: string;
      evidence_record_ids: string[];
      recovery_key: string;
    };

const DURABLE_EVIDENCE_TYPES = new Set(["checkpoint", "status"]);
const FINAL_RECORD_TYPES = new Set(["summary"]);

type SessionGroup = {
  identity: { host: string; session_id: string; device_id: string };
  evidence: MorynRecord[];
  finals: MorynRecord[];
  latest_at: string;
};

function recordOrder(left: MorynRecord, right: MorynRecord): number {
  return left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id);
}

function recoveryKey(input: IncomingSessionIdentity, group: SessionGroup, evidenceRecordIds: string[]): string {
  const digest = createHash("sha256").update(JSON.stringify({
    project_id: input.project_id,
    host: group.identity.host,
    session_id: group.identity.session_id,
    device_id: group.identity.device_id,
    evidence_record_ids: evidenceRecordIds
  })).digest("hex");
  return `finalize_${digest.slice(0, 32)}`;
}

export function selectPriorSessionForFinalization(records: readonly MorynRecord[], incoming: IncomingSessionIdentity): FinalizationAssuranceSelection {
  const groups = new Map<string, SessionGroup>();
  const coveringFinals = new Map<string, MorynRecord>();
  for (const record of records) {
    if (record.visibility !== "active" || record.project_id !== incoming.project_id || record.type !== "summary") continue;
    const covered = record.content.synthesis_source_record_ids;
    if (!Array.isArray(covered)) continue;
    for (const recordId of covered) {
      if (typeof recordId !== "string") continue;
      const prior = coveringFinals.get(recordId);
      if (!prior || recordOrder(prior, record) < 0) coveringFinals.set(recordId, record);
    }
  }
  for (const record of records) {
    if (record.visibility !== "active" || record.project_id !== incoming.project_id) continue;
    const sessionId = record.source.session_id;
    const deviceId = record.source.device_id;
    if (!sessionId || !deviceId || record.source.client !== incoming.host || deviceId !== incoming.device_id || sessionId === incoming.session_id) continue;
    if (!DURABLE_EVIDENCE_TYPES.has(record.type) && !FINAL_RECORD_TYPES.has(record.type)) continue;
    const key = `${record.source.client}\u0000${sessionId}\u0000${deviceId}`;
    const group = groups.get(key) ?? {
      identity: { host: record.source.client, session_id: sessionId, device_id: deviceId },
      evidence: [],
      finals: [],
      latest_at: record.updated_at
    };
    if (DURABLE_EVIDENCE_TYPES.has(record.type)) group.evidence.push(record);
    if (FINAL_RECORD_TYPES.has(record.type)) group.finals.push(record);
    if (record.updated_at > group.latest_at) group.latest_at = record.updated_at;
    groups.set(key, group);
  }

  const candidates = [...groups.values()]
    .filter((group) => group.evidence.length > 0)
    .sort((left, right) => right.latest_at.localeCompare(left.latest_at) || left.identity.session_id.localeCompare(right.identity.session_id));
  if (!candidates.length) return { status: "nothing_to_finalize" };
  const candidate = candidates.find((group) => {
    const final = [...group.finals].sort(recordOrder).at(-1);
    return group.evidence.some((record) => {
      const coveredFinal = coveringFinals.get(record.id);
      return (!final || record.updated_at > final.updated_at) && !coveredFinal;
    });
  }) ?? candidates[0]!;
  const evidence = [...candidate.evidence].sort(recordOrder);
  const latestEvidence = evidence.at(-1)!;
  const final = [...candidate.finals].sort(recordOrder).at(-1);
  const uncoveredEvidence = evidence.filter((record) => (!final || record.updated_at > final.updated_at) && !coveringFinals.has(record.id));
  const evidenceRecordIds = uncoveredEvidence.map((record) => record.id);
  const coveringFinal = evidence.map((record) => coveringFinals.get(record.id)).filter((record): record is MorynRecord => Boolean(record)).sort(recordOrder).at(-1);
  if ((final || coveringFinal) && evidenceRecordIds.length === 0) {
    return {
      status: "already_finalized",
      prior_session: candidate.identity,
      final_record_id: (coveringFinal ?? final)!.id,
      evidence_record_ids: evidence.map((record) => record.id)
    };
  }
  return {
    status: "eligible",
    prior_session: candidate.identity,
    latest_evidence_at: latestEvidence.updated_at,
    evidence_record_ids: evidenceRecordIds,
    recovery_key: recoveryKey(incoming, candidate, evidenceRecordIds)
  };
}
