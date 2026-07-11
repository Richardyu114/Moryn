import { createHash } from "node:crypto";
import { searchableRecordText } from "./content-text.js";
import type { SemanticConsolidationProposal } from "./context-delta.js";
import { buildActiveLogicalMemoryView, compareLogicalMemoryTargets } from "./logical-memory.js";
import { isPrivateTags } from "./sensitive.js";
import type { MorynRecord } from "./types.js";

export type SemanticConsolidationValidationReason =
  | "accepted"
  | "missing_record"
  | "below_confidence_threshold"
  | "material_difference"
  | "protected_signal_difference"
  | "missing_evidence"
  | "private_boundary"
  | "inactive_record"
  | "incompatible_domain"
  | "existing_relationship"
  | "contradictory_relationship"
  | "replacement_cycle"
  | "protected_replacement_requires_user_evidence";

export interface SemanticConsolidationValidationOptions {
  include_private?: boolean;
}

export interface SemanticConsolidationValidationResult {
  status: "accepted" | "rejected" | "idempotent";
  reason: SemanticConsolidationValidationReason;
  source_record_id: string;
  target_record_id: string;
  relationship: SemanticConsolidationProposal["relationship"];
  proposal_digest: string;
}

export type SemanticConsolidationProposalResult = Omit<SemanticConsolidationValidationResult, "status" | "reason"> & {
  status: "accepted" | "rejected" | "idempotent" | "failed";
  reason: SemanticConsolidationValidationReason | "persistence_failed";
  event_id?: string;
};

export interface SemanticConsolidationReceipt {
  proposals_received: number;
  proposals_accepted: number;
  proposals_rejected: number;
  links_created: number;
  idempotent_replays: number;
  accepted_by_relationship: Partial<Record<SemanticConsolidationProposal["relationship"], number>>;
  rejected_by_reason: Record<string, number>;
  proposal_results: SemanticConsolidationProposalResult[];
  selection_sources: typeof SEMANTIC_CONSOLIDATION_RECEIPT_SELECTION_SOURCES;
}

export const SEMANTIC_CONSOLIDATION_RECEIPT_SELECTION_SOURCES = {
  proposal_result: "proposal_results[]",
  proposal_status: "proposal_results[].status",
  proposal_reason: "proposal_results[].reason",
  proposal_event_id: "proposal_results[].event_id",
  accepted_relationship_count: "accepted_by_relationship.<relationship>",
  rejected_reason_count: "rejected_by_reason.<reason>"
} as const;

const thresholds: Record<SemanticConsolidationProposal["relationship"], number> = {
  duplicate_of: 0.98,
  revises: 0.97,
  supersedes: 0.99,
  conflicts_with: 0.95
};

const protectedTermPatterns = [
  /\b(?:not|never|must|should|may|cannot|can't|forbid(?:den)?|禁止|必须|不应|不能)\b/iu,
  /\b(?:permission|security|credential|token|password|private|public|secret|destructive|delete|push|publish)\b/iu,
  /\b(?:pending|completed|complete|failed|passed|success|blocked|resolved)\b/iu,
  /\b(?:prefer(?:s|red|ring)?|preference|principle)\b/iu
];

const versionPattern = /\bv?\d+(?:\.\d+){1,3}(?:[-+][\p{L}\p{N}.-]+)?\b/giu;
const datePattern = /\b\d{4}-\d{2}-\d{2}(?:t\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?z?)?\b/giu;
const numberPattern = /\b\d+(?:\.\d+)?%?\b/gu;
const pathPattern = /(?:^|\s)(?:\.?\.?\/|[\p{L}\p{N}_.-]+\/)[\p{L}\p{N}_./-]+/gu;
const commandPattern = /\b(?:npm|pnpm|yarn|git|moryn|node|npx|python|cargo|go)\s+[\p{L}\p{N}:@._/-]+/giu;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonicalValue(nested)]));
  }
  return typeof value === "string" ? value.trim() : value;
}

export function semanticConsolidationProposalDigest(proposal: SemanticConsolidationProposal): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(proposal))).digest("hex");
}

function result(
  proposal: SemanticConsolidationProposal,
  status: SemanticConsolidationValidationResult["status"],
  reason: SemanticConsolidationValidationReason,
  sourceRecordId = proposal.source_record_id,
  targetRecordId = proposal.target_record_id
): SemanticConsolidationValidationResult {
  return {
    status,
    reason,
    source_record_id: sourceRecordId,
    target_record_id: targetRecordId,
    relationship: proposal.relationship,
    proposal_digest: semanticConsolidationProposalDigest(proposal)
  };
}

function active(record: MorynRecord): boolean {
  return record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined";
}

function sameDomain(left: MorynRecord, right: MorynRecord): boolean {
  return left.kind === right.kind && left.type === right.type && left.scope === right.scope && left.project_id === right.project_id;
}

function extracted(pattern: RegExp, value: string): string[] {
  return [...value.toLocaleLowerCase().matchAll(pattern)].map((match) => match[0].trim()).sort();
}

function differs(pattern: RegExp, before: string, after: string): boolean {
  return JSON.stringify(extracted(pattern, before)) !== JSON.stringify(extracted(pattern, after));
}

function protectedTerms(value: string): string[] {
  return protectedTermPatterns.flatMap((pattern) => {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return extracted(globalPattern, value);
  }).sort();
}

function protectedTermDifference(before: string, after: string): boolean {
  if (JSON.stringify(protectedTerms(before)) !== JSON.stringify(protectedTerms(after))) return true;
  if (/\b(?:prefer(?:s|red|ring)?|preference|principle)\b/iu.test(`${before} ${after}`)) {
    return before.trim().toLocaleLowerCase() !== after.trim().toLocaleLowerCase();
  }
  return false;
}

function protectedSignalDifference(source: MorynRecord, target: MorynRecord, proposal: SemanticConsolidationProposal): boolean {
  const pairs = proposal.material_differences.map((difference) => ({ before: difference.before ?? "", after: difference.after ?? "" }));
  pairs.push({ before: searchableRecordText(target), after: searchableRecordText(source) });
  return pairs.some(({ before, after }) => {
    if (differs(versionPattern, before, after) || differs(datePattern, before, after) || differs(numberPattern, before, after) || differs(pathPattern, before, after) || differs(commandPattern, before, after)) return true;
    return protectedTermDifference(before, after);
  });
}

function protectedReplacement(source: MorynRecord, target: MorynRecord, proposal: SemanticConsolidationProposal): boolean {
  const text = `${searchableRecordText(source)} ${searchableRecordText(target)} ${proposal.material_differences.map((difference) => `${difference.field} ${difference.before ?? ""} ${difference.after ?? ""}`).join(" ")}`;
  return /\b(?:permission|security|credential|token|password|private|secret|destructive|delete|push|publish|preference|principle)\b/iu.test(text);
}

function hasExistingRelationship(source: MorynRecord, target: MorynRecord, relationship: string): boolean {
  return source.links?.some((link) => link.record_id === target.id && link.link_type === relationship) === true
    || (relationship === "conflicts_with" && target.links?.some((link) => link.record_id === source.id && link.link_type === relationship) === true);
}

function hasContradictoryDirection(source: MorynRecord, target: MorynRecord, relationship: string): boolean {
  if (relationship === "conflicts_with") return false;
  return target.links?.some((link) => link.record_id === source.id && link.link_type === relationship) === true;
}

function wouldCreateReplacementCycle(records: readonly MorynRecord[], source: MorynRecord, target: MorynRecord): boolean {
  const edges = new Map<string, Set<string>>();
  const add = (from: string, to: string) => edges.set(from, new Set([...(edges.get(from) ?? []), to]));
  for (const record of records) {
    for (const link of record.links ?? []) {
      if (link.link_type === "duplicate_of") add(record.id, link.record_id);
      if (link.link_type === "revises" || link.link_type === "supersedes") add(link.record_id, record.id);
    }
  }
  add(target.id, source.id);
  const stack = [source.id];
  const visited = new Set<string>();
  while (stack.length) {
    const current = stack.pop() as string;
    if (current === target.id) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(edges.get(current) ?? []));
  }
  return false;
}

export function validateSemanticConsolidationProposal(
  records: readonly MorynRecord[],
  proposal: SemanticConsolidationProposal,
  options: SemanticConsolidationValidationOptions = {}
): SemanticConsolidationValidationResult {
  let source = records.find((record) => record.id === proposal.source_record_id);
  let target = records.find((record) => record.id === proposal.target_record_id);
  if (!source || !target) return result(proposal, "rejected", "missing_record");
  if (!active(source) || !active(target)) return result(proposal, "rejected", "inactive_record");
  if (!sameDomain(source, target)) return result(proposal, "rejected", "incompatible_domain");
  const sourcePrivate = isPrivateTags(source.tags);
  const targetPrivate = isPrivateTags(target.tags);
  if (sourcePrivate !== targetPrivate || ((sourcePrivate || targetPrivate) && options.include_private !== true)) return result(proposal, "rejected", "private_boundary");
  if (hasExistingRelationship(source, target, proposal.relationship)) return result(proposal, "idempotent", "existing_relationship", source.id, target.id);
  if (proposal.relationship === "duplicate_of" && compareLogicalMemoryTargets(source, target) < 0) {
    [source, target] = [target, source];
  }
  if (hasExistingRelationship(source, target, proposal.relationship)) return result(proposal, "idempotent", "existing_relationship", source.id, target.id);
  if (hasContradictoryDirection(source, target, proposal.relationship)) return result(proposal, "rejected", "contradictory_relationship", source.id, target.id);
  if ((proposal.relationship === "revises" || proposal.relationship === "supersedes") && wouldCreateReplacementCycle(records, source, target)) {
    return result(proposal, "rejected", "replacement_cycle", source.id, target.id);
  }
  const logicalView = buildActiveLogicalMemoryView([...records]);
  if (logicalView.hidden_by_record_id[source.id] || logicalView.hidden_by_record_id[target.id]) return result(proposal, "rejected", "inactive_record", source.id, target.id);
  if (proposal.confidence < thresholds[proposal.relationship]) return result(proposal, "rejected", "below_confidence_threshold", source.id, target.id);
  const evidence = proposal.evidence_record_ids.map((recordId) => records.find((record) => record.id === recordId));
  if (evidence.some((record) => !record)) return result(proposal, "rejected", "missing_evidence", source.id, target.id);
  if ((proposal.relationship === "revises" || proposal.relationship === "supersedes") && evidence.length === 0) return result(proposal, "rejected", "missing_evidence", source.id, target.id);
  const hasMaterialDifference = proposal.material_differences.some((difference) => difference.significance === "material");
  if (proposal.relationship === "duplicate_of" && hasMaterialDifference) return result(proposal, "rejected", "material_difference", source.id, target.id);
  if (proposal.relationship === "revises" && hasMaterialDifference) return result(proposal, "rejected", "material_difference", source.id, target.id);
  if ((proposal.relationship === "supersedes" || proposal.relationship === "conflicts_with") && !hasMaterialDifference) return result(proposal, "rejected", "material_difference", source.id, target.id);
  const hasProtectedDifference = protectedSignalDifference(source, target, proposal);
  if ((proposal.relationship === "duplicate_of" || proposal.relationship === "revises") && hasProtectedDifference) return result(proposal, "rejected", "protected_signal_difference", source.id, target.id);
  if (proposal.relationship === "supersedes" && protectedReplacement(source, target, proposal) && !evidence.some((record) => record?.provenance?.method === "user-confirmed")) {
    return result(proposal, "rejected", "protected_replacement_requires_user_evidence", source.id, target.id);
  }
  return result(proposal, "accepted", "accepted", source.id, target.id);
}
