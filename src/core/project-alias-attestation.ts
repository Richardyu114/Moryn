import { createHash, randomUUID } from "node:crypto";
import { replayEvents } from "./replay.js";
import { withStoreStateLease } from "./state-lease.js";
import { appendEvent, readEvents } from "./store.js";
import type { MorynEvent, MorynRecord, RecordSource } from "./types.js";

export const PROJECT_ALIAS_ATTESTATION_TYPE = "project_identity_alias_attestation";

export interface ProjectAliasAttestation {
  version: 1;
  from_project_id: string;
  to_project_id: string;
  confirmed_at: string;
}

export interface RecordProjectAliasAttestationInput {
  from_project_id: string;
  to_project_id: string;
  confirmed_at: string;
  source: RecordSource;
}

export interface ProjectAliasAttestationConflict {
  code: "source_already_mapped" | "alias_chain_or_cycle";
  conflicting_directions: string[];
}

function aliasDigest(fromProjectId: string, toProjectId: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ from_project_id: fromProjectId, to_project_id: toProjectId }))
    .digest("hex");
}

export function projectAliasAttestationIdentity(fromProjectId: string, toProjectId: string): { record_id: string } {
  const digest = aliasDigest(fromProjectId, toProjectId).slice(0, 32);
  return {
    record_id: `rec_project_alias_${digest}`
  };
}

export function isProjectAliasAttestationControlRecord(record: Pick<MorynRecord, "type" | "tags">): boolean {
  return record.type === PROJECT_ALIAS_ATTESTATION_TYPE && record.tags.includes("project-alias-attestation");
}

export function readProjectAliasAttestationDeclaration(record: MorynRecord): ProjectAliasAttestation | undefined {
  if (
    record.kind !== "agent_note" ||
    record.type !== PROJECT_ALIAS_ATTESTATION_TYPE ||
    record.provenance?.method !== "user-confirmed" ||
    record.conflict?.resolution === "needs_review" ||
    record.links?.some((link) => link.link_type === "conflicts_with")
  ) {
    return undefined;
  }
  const version = record.content.project_alias_attestation_version;
  const fromProjectId = record.content.from_project_id;
  const toProjectId = record.content.to_project_id;
  const confirmedAt = record.content.confirmed_at;
  if (
    version !== 1 ||
    typeof fromProjectId !== "string" ||
    !fromProjectId ||
    typeof toProjectId !== "string" ||
    !toProjectId ||
    fromProjectId === toProjectId ||
    typeof confirmedAt !== "string" ||
    !confirmedAt ||
    !Number.isFinite(Date.parse(confirmedAt)) ||
    record.scope !== "project" ||
    record.project_id !== toProjectId ||
    record.id !== projectAliasAttestationIdentity(fromProjectId, toProjectId).record_id
  ) {
    return undefined;
  }
  return {
    version: 1,
    from_project_id: fromProjectId,
    to_project_id: toProjectId,
    confirmed_at: confirmedAt
  };
}

export function readProjectAliasAttestation(record: MorynRecord): ProjectAliasAttestation | undefined {
  if (record.state !== "canonical" || record.visibility !== "active") return undefined;
  return readProjectAliasAttestationDeclaration(record);
}

export function projectAliasAttestationKey(fromProjectId: string, toProjectId: string): string {
  return `${fromProjectId}\u0000${toProjectId}`;
}

export function activeProjectAliasAttestations(records: readonly MorynRecord[]): Map<string, ProjectAliasAttestation> {
  const attestations = records.flatMap((record) => {
    const attestation = readProjectAliasAttestation(record);
    return attestation ? [attestation] : [];
  });
  const targetsBySource = new Map<string, Set<string>>();
  for (const attestation of attestations) {
    const targets = targetsBySource.get(attestation.from_project_id) ?? new Set<string>();
    targets.add(attestation.to_project_id);
    targetsBySource.set(attestation.from_project_id, targets);
  }
  const ambiguousSources = new Set(
    [...targetsBySource].filter(([, targets]) => targets.size > 1).map(([source]) => source)
  );
  const sourceIds = new Set(attestations.map((attestation) => attestation.from_project_id));
  const targetIds = new Set(attestations.map((attestation) => attestation.to_project_id));
  const chainOrCycleNodes = new Set([...sourceIds].filter((source) => targetIds.has(source)));
  const safeAttestations = attestations.filter(
    (attestation) =>
      !ambiguousSources.has(attestation.from_project_id) &&
      !chainOrCycleNodes.has(attestation.from_project_id) &&
      !chainOrCycleNodes.has(attestation.to_project_id)
  );
  return new Map(
    safeAttestations.map((attestation) => [
      projectAliasAttestationKey(attestation.from_project_id, attestation.to_project_id),
      attestation
    ])
  );
}

function direction(attestation: ProjectAliasAttestation): string {
  return `${attestation.from_project_id} -> ${attestation.to_project_id}`;
}

export function projectAliasAttestationConflict(
  records: readonly MorynRecord[],
  fromProjectId: string,
  toProjectId: string
): ProjectAliasAttestationConflict | undefined {
  const active = records.flatMap((record) => {
    const attestation = readProjectAliasAttestation(record);
    return attestation ? [attestation] : [];
  });
  const differentDirections = active.filter(
    (attestation) => attestation.from_project_id !== fromProjectId || attestation.to_project_id !== toProjectId
  );
  const sourceConflicts = differentDirections.filter((attestation) => attestation.from_project_id === fromProjectId);
  if (sourceConflicts.length > 0) {
    return {
      code: "source_already_mapped",
      conflicting_directions: sourceConflicts.map(direction).sort()
    };
  }
  const topologyConflicts = differentDirections.filter(
    (attestation) => attestation.from_project_id === toProjectId || attestation.to_project_id === fromProjectId
  );
  if (topologyConflicts.length > 0) {
    return {
      code: "alias_chain_or_cycle",
      conflicting_directions: topologyConflicts.map(direction).sort()
    };
  }
  return undefined;
}

export async function recordProjectAliasAttestation(
  storePath: string,
  input: RecordProjectAliasAttestationInput
): Promise<{ created: boolean; record: MorynRecord; event: Extract<MorynEvent, { op: "upsert_record" }> }> {
  if (!input.from_project_id || !input.to_project_id || input.from_project_id === input.to_project_id) {
    throw new Error("Project alias attestation requires distinct non-empty project ids");
  }
  if (!input.confirmed_at) throw new Error("Project alias attestation requires confirmed_at");

  return withStoreStateLease(storePath, async () => {
    const identity = projectAliasAttestationIdentity(input.from_project_id, input.to_project_id);
    const events = await readEvents(storePath);
    const current = replayEvents(events).get(identity.record_id);
    if (current) {
      const declaration = readProjectAliasAttestationDeclaration(current);
      const existingEvent = events.find(
        (event): event is Extract<MorynEvent, { op: "upsert_record" }> =>
          event.op === "upsert_record" && event.record.id === identity.record_id
      );
      if (
        !declaration ||
        declaration.from_project_id !== input.from_project_id ||
        declaration.to_project_id !== input.to_project_id ||
        !existingEvent
      ) {
        throw new Error(`Project alias attestation collision or corruption: ${identity.record_id}`);
      }
      return { created: false, record: current, event: existingEvent };
    }

    const record: MorynRecord = {
      id: identity.record_id,
      kind: "agent_note",
      type: PROJECT_ALIAS_ATTESTATION_TYPE,
      scope: "project",
      project_id: input.to_project_id,
      tags: ["moryn-control", "project-alias-attestation"],
      content: {
        format: "json",
        text: `Approved project alias: ${input.from_project_id} -> ${input.to_project_id}`,
        project_alias_attestation_version: 1,
        from_project_id: input.from_project_id,
        to_project_id: input.to_project_id,
        confirmed_at: input.confirmed_at
      },
      state: "canonical",
      confidence: 1,
      priority: "low",
      visibility: "active",
      created_at: input.confirmed_at,
      updated_at: input.confirmed_at,
      source: input.source,
      provenance: {
        method: "user-confirmed",
        reason: "User approved this directional project identity alias",
        promoted_at: input.confirmed_at
      }
    };
    const event: Extract<MorynEvent, { op: "upsert_record" }> = {
      event_id: `evt_project_alias_${randomUUID().replaceAll("-", "")}`,
      op: "upsert_record",
      record,
      created_at: input.confirmed_at,
      source: input.source
    };
    await appendEvent(storePath, event);
    return { created: true, record, event };
  });
}
