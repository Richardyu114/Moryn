import { createHash } from "node:crypto";
import { operationArgumentsByTool } from "../operation-contracts.js";
import { type ActionInterfaces, actionInterfaces } from "./action-interfaces.js";
import { actionExecution, actionSafety } from "./action-safety.js";
import { discoverAutomaticDuplicateProposal } from "./automatic-consolidation.js";
import { runAutomaticEventAudit } from "./automatic-event-audit.js";
import {
  AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES,
  type AutomaticSemanticMaintenanceInput,
  type AutomaticSemanticMaintenanceResult,
  runAutomaticSemanticMaintenance
} from "./automatic-semantic-maintenance.js";
import { type CapturePolicyInput, diagnoseCapturePolicy } from "./capture-policy-report.js";
import {
  buildCheckpointRecoveryPack,
  CHECKPOINT_SELECTION_SOURCES,
  type CheckpointInput,
  type CheckpointResult,
  checkpointIdentity,
  checkpointPayloadDigest,
  checkpointSummary,
  matchesCheckpoint,
  matchesCheckpointPayload,
  normalizeCheckpointInput,
  parseCheckpointContent
} from "./checkpoint.js";
import { displayRecordText, searchableContentText, searchableRecordText } from "./content-text.js";
import {
  type LearningDelta,
  learningDeltaSchema,
  type SemanticConsolidationProposal,
  semanticConsolidationProposalSchema
} from "./context-delta.js";
import { rebuildDerivedViews } from "./derived.js";
import { type DogfoodReportInput, diagnoseDogfood } from "./dogfood-report.js";
import { EPISODE_BUCKET_KINDS } from "./episode-rollup.js";
import {
  commandForPromoteContext,
  InvalidRefreshCursorError,
  type MorynErrorNextAction,
  PROMOTE_CANDIDATE_WHEN,
  withNextActionMetadata
} from "./errors.js";
import {
  type ExactDuplicateConsolidationInput,
  runAutomaticExactDuplicateConsolidation
} from "./exact-duplicate-consolidation.js";
import { diagnoseHealthCheck, HEALTH_CHECK_SELECTION_SOURCES, type HealthCheckInput } from "./health-check.js";
import {
  HISTORICAL_RECALL_SELECTION_SOURCES,
  type HistoricalRecallRecovery,
  recoverHistoricalRecall,
  unavailableHistoricalRecall
} from "./historical-recall.js";
import { inspectHostActivation } from "./host-activation.js";
import { normalizeHostId } from "./host-adapter-registry.js";
import type { HostRuntimeDescriptor } from "./host-integration-artifacts.js";
import { createId } from "./id.js";
import {
  assertIdempotentEventMatch,
  derivedIdempotencyKey,
  mutationIdempotency,
  PartialMutationCommitError,
  validateIdempotencyKey
} from "./idempotency.js";
import { buildLearningCandidateReviewWorkflow, unresolvedLearningCandidates } from "./learning-candidate-review.js";
import { consumeLearningInbox, isLearningInboxRecord, learningInboxForLifecycle } from "./learning-inbox.js";
import { learningRecordIdentity, normalizeLearningRecord } from "./learning-ingestion.js";
import { learningStatePolicy } from "./learning-policy.js";
import {
  buildActiveLogicalMemoryView,
  compareLogicalMemoryTargets,
  EXACT_DUPLICATE_LINK_REASON,
  type LogicalRelationshipType,
  logicalMemoryFingerprint,
  validateLogicalRelationship
} from "./logical-memory.js";
import {
  assertMemoryCompactionPlanEnvelope,
  previewMemoryCompaction as buildMemoryCompactionPreview,
  type MemoryCompactionPreview,
  type MemoryCompactionPreviewOptions,
  planMemoryCompaction as sealMemoryCompactionPlan
} from "./memory-compaction.js";
import {
  applyMemoryCompactionPlan as commitMemoryCompactionPlan,
  readMemoryCompactionReceipt
} from "./memory-compaction-receipts.js";
import { restoreMemoryCompactionPlan as restoreCommittedMemoryCompactionPlan } from "./memory-compaction-restore.js";
import { diagnoseMemory, MEMORY_DOCTOR_SELECTION_SOURCES } from "./memory-doctor.js";
import { expandMemorySources as buildMemorySourceExpansion } from "./memory-expansion.js";
import { normalizeMemoryExpansionCommand } from "./memory-expansion-command.js";
import { applyRecordFeedback } from "./memory-feedback.js";
import { diagnoseMemoryLifecycle, type MemoryLifecycleInput } from "./memory-lifecycle.js";
import { buildMemoryRetentionView } from "./memory-retention.js";
import { isProjectAliasAttestationControlRecord } from "./project-alias-attestation.js";
import {
  buildRecallMemoryExpandAction,
  buildRecallNextActions,
  RECALL_ACTION_SELECTION_SOURCES
} from "./recall-actions.js";
import { evaluateRecall, RECALL_EVAL_SELECTION_SOURCES, type RecallEvalInput } from "./recall-eval.js";
import { assessRecallOutcome, queryRecordMatch } from "./recall-outcome.js";
import {
  type CurrentRecordReadResult,
  DEFAULT_MEMORY_WORKING_SET_OPTIONS,
  readCurrentRecords,
  selectMemoryWorkingSet
} from "./record-read-model.js";
import { applyRecordPatch, replayEvents } from "./replay.js";
import {
  type ReadRetrievalCandidatesInput,
  type RetrievalCandidateReadResult,
  readRetrievalCandidates
} from "./retrieval-index.js";
import {
  isoDateTimeSchema,
  isValidPatchPath,
  PROVENANCE_METHODS,
  parseRecord,
  RECORD_KINDS,
  RECORD_PRIORITIES,
  RECORD_SCOPES,
  RECORD_STATES,
  recordKindSchema,
  recordPrioritySchema,
  recordScopeSchema,
  recordStateSchema
} from "./schema.js";
import {
  SEMANTIC_CONSOLIDATION_RECEIPT_SELECTION_SOURCES,
  type SemanticConsolidationProposalResult,
  type SemanticConsolidationReceipt,
  type SemanticConsolidationValidationResult,
  semanticConsolidationProposalDigest,
  validateSemanticConsolidationProposal
} from "./semantic-consolidation.js";
import {
  retrieveSemanticConsolidationCandidates,
  type SemanticConsolidationCandidate
} from "./semantic-consolidation-candidates.js";
import { authorSemanticMaintenanceMergeDraft } from "./semantic-maintenance-draft.js";
import {
  buildSemanticMaintenanceShadowReport,
  DEFAULT_SEMANTIC_SHADOW_CANDIDATE_LIMIT,
  DEFAULT_SEMANTIC_SHADOW_MINIMUM_TOKEN_OVERLAP
} from "./semantic-maintenance-shadow.js";
import {
  detectSensitiveContent,
  isPrivateMemoryBoundary,
  redactSensitiveContent,
  sensitiveScanText
} from "./sensitive.js";
import {
  buildSessionFoldCoverageAttestation,
  planSessionFold as buildSessionFoldPlan,
  type SessionFoldIdentity,
  type SessionFoldPlan
} from "./session-fold.js";
import { applySessionFoldPlan } from "./session-fold-transaction.js";
import { compileEffectiveSoul } from "./soul-profile.js";
import {
  normalizeSoulApprovalCommand,
  normalizeSoulDraftCommand,
  normalizeSoulRollbackCommand,
  normalizeSoulStatusCommand
} from "./soul-profile-commands.js";
import {
  readSoulProfileStatus as buildSoulProfileStatus,
  approveSoulProfileDraft as persistApprovedSoulProfileDraft,
  createSoulProfileDraft as persistSoulProfileDraft,
  rollbackSoulProfile as persistSoulProfileRollback
} from "./soul-profile-management.js";
import { readSoulProfileRevisions, SOUL_PROFILE_RECORD_TYPE } from "./soul-profile-store.js";
import { withStoreStateLease } from "./state-lease.js";
import { type AppendEventIfAbsentResult, appendEvent, appendEventIfAbsent, readEvents } from "./store.js";
import { createStringKeyedRecord, stringKeyedRecordFromEntries } from "./string-keyed-record.js";
import {
  planStructuredSemanticMerge,
  STRUCTURED_SEMANTIC_MERGE_ACTIVATION_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_ACTIVATION_REASON,
  STRUCTURED_SEMANTIC_MERGE_CLAIM_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_DEVICE_ID,
  STRUCTURED_SEMANTIC_MERGE_HIDE_REASON,
  STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON,
  STRUCTURED_SEMANTIC_MERGE_RELATIONSHIP_OFFSET_MS,
  type StructuredSemanticMergePlan,
  structuredSemanticMergeDependenciesMatch,
  structuredSemanticMergeDigest,
  structuredSemanticMergeInitialRecordMatches,
  structuredSemanticMergeProvisionalRecordMatches,
  structuredSemanticMergeRecordMatches,
  structuredSemanticMergeTimestamp
} from "./structured-semantic-merge.js";
import { readSyncCompensationReceipt } from "./sync-compensation.js";
import {
  type MorynEvent,
  type MorynRecord,
  RECORD_FEEDBACK_OUTCOMES,
  type RecordFeedbackOutcome,
  type RecordKind,
  type RecordPriority,
  type RecordProvenance,
  type RecordScope,
  type RecordSource,
  type RecordState
} from "./types.js";
import { type RequiredFieldMetadata, withPhasesByName, withRequiredFieldsByName } from "./workflow.js";

interface EngineDeps {
  storePath: string;
  hostRuntime?: HostRuntimeDescriptor;
  now?: () => string;
  id?: (prefix: string) => string;
  syncStatus?: () => Promise<{ behind?: number; remote_has_updates?: boolean }>;
  rebuild?: (storePath: string) => Promise<unknown>;
  runAutomaticEventAudit?: typeof runAutomaticEventAudit;
  appendEventIfAbsent?: (storePath: string, event: MorynEvent) => Promise<AppendEventIfAbsentResult>;
  readCurrentRecords?: (storePath: string) => Promise<CurrentRecordReadResult>;
  readRetrievalCandidates?: (
    storePath: string,
    input: ReadRetrievalCandidatesInput
  ) => Promise<RetrievalCandidateReadResult>;
}

interface WriteInput {
  kind: unknown;
  type: unknown;
  scope: unknown;
  project_id?: string;
  tags?: unknown;
  content: unknown;
  state?: unknown;
  confidence?: unknown;
  priority?: unknown;
  source: RecordSource;
  confirmed?: boolean;
  provenance?: unknown;
  idempotency_key?: unknown;
}

type ValidatedWriteInput = WriteInput & {
  kind: RecordKind;
  type: string;
  scope: RecordScope;
  state?: RecordState;
  priority?: RecordPriority;
  idempotency_key?: string;
};

export interface EngineWarning {
  code: string;
  reason?: string;
  next_action?: MorynErrorNextAction;
}

interface RecallInput {
  record_ids?: unknown;
  query?: unknown;
  project_id?: string;
  kinds?: unknown;
  scopes?: unknown;
  types?: unknown;
  states?: unknown;
  tags?: unknown;
  files?: unknown;
  limit?: unknown;
  include_private?: unknown;
}

export interface RecordFeedbackInput {
  record_id: unknown;
  outcome: unknown;
  occurred_at?: unknown;
  source?: RecordSource;
  idempotency_key: unknown;
}

interface RefreshInput {
  project_id?: string;
  cursor?: unknown;
  current_task?: unknown;
  limit?: unknown;
  include_private?: unknown;
}

type ValidatedRefreshInput = RefreshInput & { cursor?: string; current_task?: string; include_private?: boolean };

interface RefreshCursorPosition {
  updated_at: string;
  record_id: string;
}

interface ParsedRefreshCursor {
  position: RefreshCursorPosition;
  legacy_iso: boolean;
}

interface TimelineInput {
  record_id?: unknown;
  event_id?: unknown;
  query?: unknown;
  project_id?: string;
  before?: unknown;
  after?: unknown;
  include_private?: unknown;
}

type TimelineAnchorSource = "record_id" | "event_id" | "query";
type TimelineRelative = "before" | "anchor" | "after";

type ValidatedTimelineInput = TimelineInput & {
  record_id?: string;
  event_id?: string;
  query?: string;
  before: number;
  after: number;
  include_private?: boolean;
};

interface BootInput {
  project_id?: string;
  agent_session_id?: unknown;
  user_profile_id?: unknown;
  agent_profile_id?: unknown;
  soul_char_budget?: unknown;
  soul_token_budget?: unknown;
  default_skills?: unknown;
  current_task?: unknown;
  sync_remote?: unknown;
  include_private?: unknown;
}

type ValidatedBootInput = BootInput & {
  agent_session_id?: string;
  user_profile_id?: string;
  agent_profile_id?: string;
  soul_char_budget?: number;
  soul_token_budget?: number;
  default_skills?: string[];
  current_task?: string;
  sync_remote?: string;
  include_private?: boolean;
};

interface ListRecentInput {
  limit?: unknown;
  project_id?: unknown;
  all_projects?: unknown;
  include_private?: unknown;
}

type ValidatedListRecentInput = ListRecentInput & {
  project_id?: string;
  all_projects: boolean;
  include_private?: boolean;
};

interface ListProjectsInput {
  limit?: unknown;
  current_task?: unknown;
  sync_remote?: unknown;
  agent?: unknown;
}

interface MemoryDoctorInput {
  project_id?: string;
  limit?: unknown;
  include_private?: unknown;
}

interface MemoryMaintenanceShadowInput {
  project_id?: string;
  candidate_limit?: unknown;
  minimum_token_overlap?: unknown;
  include_private?: unknown;
}

interface IngestLearningsInput {
  project_id?: string;
  learnings: unknown;
  occurred_at: unknown;
  source: RecordSource;
  origin_record_id?: string;
}

interface SessionFoldPreviewInput extends SessionFoldIdentity {
  proposed_final_text?: unknown;
  include_private?: unknown;
}

interface ApplySessionFoldInput {
  plan: SessionFoldPlan;
  include_private?: unknown;
}

type SessionFoldPlanInput = SessionFoldIdentity & { include_private?: unknown };

interface ConsolidateSemanticProposalsInput {
  proposals: unknown;
  project_id?: string;
  include_private?: unknown;
  source?: RecordSource;
  occurred_at?: string;
}

interface ConsolidateLearningProposalsInput extends ConsolidateSemanticProposalsInput {
  source_record_ids: string[];
}

type ValidatedMemoryDoctorInput = MemoryDoctorInput & {
  include_private?: boolean;
};

type ValidatedMemoryMaintenanceShadowInput = MemoryMaintenanceShadowInput & {
  candidate_limit: number;
  minimum_token_overlap: number;
  include_private: boolean;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const REFRESH_CURSOR_PREFIX = "moryn-refresh:v1:";

function encodeRefreshCursor(position: RefreshCursorPosition): string {
  const payload = JSON.stringify({ updated_at: position.updated_at, record_id: position.record_id });
  return `${REFRESH_CURSOR_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

function parseRefreshCursor(value: string): ParsedRefreshCursor {
  if (isoDateTimeSchema.safeParse(value).success) {
    return { position: { updated_at: value, record_id: "" }, legacy_iso: true };
  }
  if (!value.startsWith(REFRESH_CURSOR_PREFIX)) throw new InvalidRefreshCursorError(value);
  const encoded = value.slice(REFRESH_CURSOR_PREFIX.length);
  try {
    if (!encoded || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) {
      throw new Error("non-canonical refresh cursor encoding");
    }
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid refresh cursor payload");
    }
    const position = payload as Record<string, unknown>;
    if (
      Object.keys(position).length !== 2 ||
      typeof position.updated_at !== "string" ||
      !isoDateTimeSchema.safeParse(position.updated_at).success ||
      typeof position.record_id !== "string"
    ) {
      throw new Error("invalid refresh cursor position");
    }
    const parsed = { updated_at: position.updated_at, record_id: position.record_id };
    if (encodeRefreshCursor(parsed) !== value) throw new Error("non-canonical refresh cursor payload");
    return { position: parsed, legacy_iso: false };
  } catch {
    throw new InvalidRefreshCursorError(value);
  }
}

function compareRefreshPositions(left: RefreshCursorPosition, right: RefreshCursorPosition): number {
  return compareCodeUnits(left.updated_at, right.updated_at) || compareCodeUnits(left.record_id, right.record_id);
}

function refreshPosition(record: MorynRecord): RefreshCursorPosition {
  return { updated_at: record.updated_at, record_id: record.id };
}

function duplicateLinkEventId(recordId: string, targetRecordId: string): string {
  return `evt_duplicate_${logicalMemoryFingerprint({
    id: recordId,
    kind: "agent_note",
    type: "duplicate-link",
    scope: "artifact",
    tags: [],
    content: { text: `${recordId}\u0000${targetRecordId}` },
    state: "raw",
    confidence: 0,
    priority: "low",
    visibility: "active",
    created_at: "",
    updated_at: "",
    source: { client: "moryn" }
  }).slice(0, 32)}`;
}

function exactDuplicateLinkTimestamp(record: MorynRecord, target: MorynRecord): string {
  const latestEndpoint = record.updated_at >= target.updated_at ? record : target;
  return new Date(Date.parse(latestEndpoint.updated_at) + 1).toISOString();
}

function semanticConsolidationEventId(sourceRecordId: string, targetRecordId: string, relationship: string): string {
  return `evt_semantic_consolidation_${createHash("sha256").update(JSON.stringify({ sourceRecordId, targetRecordId, relationship })).digest("hex")}`;
}

function structuredSemanticMergeEventId(
  operation: "activate" | "claim" | "hide" | "promote" | "support" | "upsert",
  identity: unknown
): string {
  return `evt_structured_semantic_merge_${operation}_${structuredSemanticMergeDigest({ operation, identity })}`;
}

function structuredSemanticMergeEventSourceMatches(source: RecordSource): boolean {
  return (
    source.client === "moryn" &&
    source.device_id === STRUCTURED_SEMANTIC_MERGE_DEVICE_ID &&
    source.session_id === undefined &&
    source.model === undefined
  );
}

function structuredSemanticMergeRelationshipProjected(
  records: readonly MorynRecord[],
  event: Extract<MorynEvent, { op: "link_records" }>
): boolean {
  return Boolean(
    records
      .find((record) => record.id === event.record_id)
      ?.links?.some(
        (link) =>
          link.record_id === event.linked_record_id &&
          link.link_type === event.link_type &&
          link.reason === event.reason &&
          link.created_at === event.created_at
      )
  );
}

function structuredSemanticMergeRelationshipEventMatches(
  actual: MorynEvent,
  expected: Extract<MorynEvent, { op: "link_records" }>
): actual is Extract<MorynEvent, { op: "link_records" }> {
  return (
    actual.event_id === expected.event_id &&
    actual.op === "link_records" &&
    actual.record_id === expected.record_id &&
    actual.linked_record_id === expected.linked_record_id &&
    actual.link_type === expected.link_type &&
    actual.reason === expected.reason &&
    actual.created_at === expected.created_at &&
    structuredSemanticMergeEventSourceMatches(actual.source)
  );
}

function structuredSemanticMergePromotionEventMatches(actual: MorynEvent, expected: MorynEvent): boolean {
  return (
    expected.op === "promote_record" &&
    actual.event_id === expected.event_id &&
    actual.op === "promote_record" &&
    actual.record_id === expected.record_id &&
    actual.target_state === expected.target_state &&
    actual.reason === expected.reason &&
    actual.confirmed === expected.confirmed &&
    actual.conflict === expected.conflict &&
    actual.created_at === expected.created_at &&
    structuredSemanticMergeEventSourceMatches(actual.source)
  );
}

function structuredSemanticMergePersistedRecordMatches(
  record: MorynRecord,
  plan: StructuredSemanticMergePlan
): boolean {
  return (
    structuredSemanticMergeProvisionalRecordMatches(record, plan) || structuredSemanticMergeRecordMatches(record, plan)
  );
}

function structuredSemanticMergeReceiptState(record: MorynRecord | undefined): "candidate" | "canonical" | undefined {
  return record?.state === "candidate" || record?.state === "canonical" ? record.state : undefined;
}

function semanticConsolidationReceipt(
  proposalResults: SemanticConsolidationProposalResult[]
): SemanticConsolidationReceipt {
  const acceptedByRelationship: SemanticConsolidationReceipt["accepted_by_relationship"] = {};
  const rejectedByReason: Record<string, number> = {};
  let proposalsAccepted = 0;
  let proposalsRejected = 0;
  let linksCreated = 0;
  let idempotentReplays = 0;
  for (const item of proposalResults) {
    linksCreated += item.links_created ?? (item.status === "accepted" ? 1 : 0);
    if (item.status === "accepted") {
      proposalsAccepted += 1;
      acceptedByRelationship[item.relationship] = (acceptedByRelationship[item.relationship] ?? 0) + 1;
    } else if (item.status === "idempotent") {
      idempotentReplays += 1;
    } else {
      proposalsRejected += 1;
      rejectedByReason[item.reason] = (rejectedByReason[item.reason] ?? 0) + 1;
    }
  }
  return {
    proposals_received: proposalResults.length,
    proposals_accepted: proposalsAccepted,
    proposals_rejected: proposalsRejected,
    links_created: linksCreated,
    idempotent_replays: idempotentReplays,
    accepted_by_relationship: acceptedByRelationship,
    rejected_by_reason: rejectedByReason,
    proposal_results: proposalResults,
    selection_sources: SEMANTIC_CONSOLIDATION_RECEIPT_SELECTION_SOURCES
  };
}

type ValidatedMemoryLifecycleInput = MemoryLifecycleInput & {
  include_private?: boolean;
  now?: string;
};

type ValidatedCapturePolicyInput = CapturePolicyInput & {
  include_private?: boolean;
};

type ValidatedDogfoodReportInput = DogfoodReportInput & {
  include_private?: boolean;
};

type ValidatedHealthCheckInput = HealthCheckInput & {
  include_private?: boolean;
};

type ValidatedRecallEvalInput = RecallEvalInput & {
  include_private?: boolean;
};

type ProjectListAgent = Partial<RecordSource>;

type ValidatedListProjectsInput = ListProjectsInput & {
  current_task?: string;
  sync_remote?: string;
  agent?: ProjectListAgent;
};

const START_LISTED_PROJECT_WHEN = "After choosing this project from project_list results.";
const RECALL_REFRESH_CHANGE_WHEN = "After refresh reports this change and the agent needs the full record content.";
const WRITE_CANDIDATE_RECORD_ID_SOURCE = "write.record.id";
const WRITE_OPERATION_CONTRACT_SOURCE = "operations_by_id.write";
const WRITE_KIND_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.kind";
const WRITE_TYPE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.type";
const WRITE_SCOPE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.scope";
const WRITE_PROJECT_ID_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.project_id";
const WRITE_CONTENT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content";
const WRITE_CONTENT_TEXT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content_text";
const WRITE_CONTENT_FORMAT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.content_format";
const WRITE_TAGS_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.tags";
const WRITE_STATE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.state";
const WRITE_CONFIDENCE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.confidence";
const WRITE_PRIORITY_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.priority";
const WRITE_CONFIRMED_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.confirmed";
const WRITE_SOURCE_CLIENT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_client";
const WRITE_SOURCE_SESSION_ID_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_session_id";
const WRITE_SOURCE_MODEL_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_model";
const WRITE_SOURCE_DEVICE_ID_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.source_device_id";
const WRITE_PROVENANCE_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.provenance";
const WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.derived_from";
const WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.reason";
const WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.provenance_method";
const WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE = "operations_by_id.write.arguments_by_name.provenance_promoted_at";

type WriteProvenanceField = "derived_from" | "reason" | "method" | "promoted_at";
type WriteProvenanceArgument = `provenance.${WriteProvenanceField}`;
type WriteProvenanceArgumentSource =
  | typeof WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE
  | typeof WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE
  | typeof WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE
  | typeof WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE;

const WRITE_PROVENANCE_FIELDS: Record<
  WriteProvenanceField,
  {
    argument: WriteProvenanceArgument;
    source: WriteProvenanceArgumentSource;
    placeholder: unknown;
  }
> = {
  derived_from: {
    argument: "provenance.derived_from",
    source: WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE,
    placeholder: ["<record_id>"]
  },
  reason: {
    argument: "provenance.reason",
    source: WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE,
    placeholder: "<reason>"
  },
  method: {
    argument: "provenance.method",
    source: WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE,
    placeholder: "agent-proposed"
  },
  promoted_at: {
    argument: "provenance.promoted_at",
    source: WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE,
    placeholder: "<ISO datetime>"
  }
};

export const WRITE_SELECTION_SOURCES = {
  record: "record",
  record_id: "record.id",
  warning_next_action: "warning.next_action"
};

export const MUTATION_EVENT_SELECTION_SOURCES = {
  event: "event",
  event_id: "event.event_id",
  record_id: "event.record_id"
};

export const RECORD_FEEDBACK_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  outcome: "event.outcome",
  usage: "usage"
};

export const LINK_EVENT_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  linked_record_id: "event.linked_record_id"
};

export const SENSITIVE_REVISE_SELECTION_SOURCES = {
  ...MUTATION_EVENT_SELECTION_SOURCES,
  quarantine_event: "quarantine_event",
  quarantine_event_id: "quarantine_event.event_id"
};

export const PROJECT_LIST_SELECTION_SOURCES = {
  project: "projects_by_id.<project_id>",
  project_id: "projects_by_id.<project_id>.project_id",
  next_action: "projects_by_id.<project_id>.next"
};

export const PROJECT_MIGRATE_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  event: "events_by_record_id.<record_id>",
  event_id: "events_by_record_id.<record_id>.event_id"
};

export const PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES = {
  project: "project_list.projects_by_id.<project_id>",
  project_id: "project_list.projects_by_id.<project_id>.project_id",
  next_action: "project_list.projects_by_id.<project_id>.next",
  ordered_next_action: "project_list.projects[].next",
  cli_executable: "project_list.projects_by_id.<project_id>.next.interfaces.cli.executable",
  cli_argv: "project_list.projects_by_id.<project_id>.next.interfaces.cli.argv[]",
  cli_args: "project_list.projects_by_id.<project_id>.next.interfaces.cli.args[]",
  cli_exec_file: "project_list.projects_by_id.<project_id>.next.interfaces.cli.exec_file",
  cli_placeholder: "project_list.projects_by_id.<project_id>.next.interfaces.cli.placeholders[]",
  cli_command_line: "project_list.projects_by_id.<project_id>.next.interfaces.cli.command_line",
  ordered_cli_executable: "project_list.projects[].next.interfaces.cli.executable",
  ordered_cli_argv: "project_list.projects[].next.interfaces.cli.argv[]",
  ordered_cli_args: "project_list.projects[].next.interfaces.cli.args[]",
  ordered_cli_exec_file: "project_list.projects[].next.interfaces.cli.exec_file",
  ordered_cli_placeholder: "project_list.projects[].next.interfaces.cli.placeholders[]",
  ordered_cli_command_line: "project_list.projects[].next.interfaces.cli.command_line",
  argument: "project_list.projects_by_id.<project_id>.next.arguments_by_name.<argument>",
  ordered_argument: "project_list.projects[].next.arguments_by_name.<argument>",
  required_field: "project_list.projects_by_id.<project_id>.next.required_fields_by_name.<field>",
  ordered_required_field: "project_list.projects[].next.required_fields_by_name.<field>",
  required_input: "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_field.<field>",
  ordered_required_input: "project_list.projects[].next.execution.required_inputs_by_field.<field>",
  required_input_argument_path:
    "project_list.projects_by_id.<project_id>.next.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path:
    "project_list.projects[].next.execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "project_list.projects_by_id.<project_id>.next.argument_sources.<field>",
  ordered_argument_source: "project_list.projects[].next.argument_sources.<field>"
};

export const LIST_RECENT_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id"
};

export { HEALTH_CHECK_SELECTION_SOURCES, MEMORY_DOCTOR_SELECTION_SOURCES };

export const RECALL_SELECTION_SOURCES = {
  result: "results_by_id.<record_id>",
  record: "results_by_id.<record_id>.record",
  record_id: "results_by_id.<record_id>.record.id",
  result_next_action: "results_by_id.<record_id>.next_action",
  historical_match: HISTORICAL_RECALL_SELECTION_SOURCES.match,
  historical_record_id: HISTORICAL_RECALL_SELECTION_SOURCES.record_id,
  historical_full_record: HISTORICAL_RECALL_SELECTION_SOURCES.full_record,
  historical_excerpt: HISTORICAL_RECALL_SELECTION_SOURCES.excerpt,
  outcome_best_result_source: "outcome.best_result_source",
  outcome_best_result_path: "outcome.best_result_path",
  memory_working_set: "memory_working_set",
  next_action: RECALL_ACTION_SELECTION_SOURCES.action,
  ordered_next_action: RECALL_ACTION_SELECTION_SOURCES.ordered_action,
  next_action_argument: RECALL_ACTION_SELECTION_SOURCES.argument
};

export { RECALL_EVAL_SELECTION_SOURCES };

export const BOOT_SELECTION_SOURCES = {
  record: "records_by_id.<record_id>",
  record_id: "records_by_id.<record_id>.id",
  user_preference: "profile.user_preferences_by_id.<record_id>",
  soul: "profile.soul_by_id.<record_id>",
  effective_soul: "profile.effective_soul",
  effective_soul_clause: "profile.effective_soul.clauses_by_id.<clause_id>",
  soul_profile_status: "profile.soul_profile_status",
  memory_working_set: "memory_working_set",
  global_rule: "profile.global_rules_by_id.<record_id>",
  important_decision: "project.important_decisions_by_id.<record_id>",
  warning: "project.warnings_by_id.<record_id>",
  skill: "skills_by_id.<record_id>",
  task_relevant: "task_relevant_by_id.<record_id>",
  recent_change: "recent_changes_by_id.<record_id>",
  active_checkpoint: "active_checkpoint",
  checkpoint_recovery_pack: "checkpoint_recovery_pack"
};

export const REFRESH_SELECTION_SOURCES = {
  change: "changes_by_record_id.<record_id>",
  record_id: "changes_by_record_id.<record_id>.record_id",
  next_action: "changes_by_record_id.<record_id>.next_action"
};

export const REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES = {
  change: "refresh.changes_by_record_id.<record_id>",
  record_id: "refresh.changes_by_record_id.<record_id>.record_id",
  next_action: "refresh.changes_by_record_id.<record_id>.next_action",
  ordered_next_action: "refresh.changes[].next_action",
  cli_executable: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.executable",
  cli_argv: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.argv[]",
  cli_args: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.args[]",
  cli_exec_file: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.exec_file",
  cli_placeholder: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.placeholders[]",
  cli_command_line: "refresh.changes_by_record_id.<record_id>.next_action.interfaces.cli.command_line",
  ordered_cli_executable: "refresh.changes[].next_action.interfaces.cli.executable",
  ordered_cli_argv: "refresh.changes[].next_action.interfaces.cli.argv[]",
  ordered_cli_args: "refresh.changes[].next_action.interfaces.cli.args[]",
  ordered_cli_exec_file: "refresh.changes[].next_action.interfaces.cli.exec_file",
  ordered_cli_placeholder: "refresh.changes[].next_action.interfaces.cli.placeholders[]",
  ordered_cli_command_line: "refresh.changes[].next_action.interfaces.cli.command_line",
  argument: "refresh.changes_by_record_id.<record_id>.next_action.arguments_by_name.<argument>",
  ordered_argument: "refresh.changes[].next_action.arguments_by_name.<argument>",
  required_field: "refresh.changes_by_record_id.<record_id>.next_action.required_fields_by_name.<field>",
  ordered_required_field: "refresh.changes[].next_action.required_fields_by_name.<field>",
  required_input: "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_field.<field>",
  ordered_required_input: "refresh.changes[].next_action.execution.required_inputs_by_field.<field>",
  required_input_argument_path:
    "refresh.changes_by_record_id.<record_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path:
    "refresh.changes[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "refresh.changes_by_record_id.<record_id>.next_action.argument_sources.<field>",
  ordered_argument_source: "refresh.changes[].next_action.argument_sources.<field>"
};

export const TIMELINE_SELECTION_SOURCES = {
  anchor: "anchor",
  anchor_event_id: "anchor.event_id",
  anchor_record_id: "anchor.record_id",
  item: "items_by_event_id.<event_id>",
  item_event_id: "items_by_event_id.<event_id>.event_id",
  item_record_id: "items_by_event_id.<event_id>.record_id",
  item_next_action: "items_by_event_id.<event_id>.next_action",
  record_item: "items_by_record_id.<record_id>[]",
  ordered_item: "items[]",
  ordered_next_action: "items[].next_action"
};

export const TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES = {
  item: "timeline.items_by_event_id.<event_id>",
  record_id: "timeline.items_by_event_id.<event_id>.record_id",
  next_action: "timeline.items_by_event_id.<event_id>.next_action",
  ordered_next_action: "timeline.items[].next_action",
  cli_executable: "timeline.items_by_event_id.<event_id>.next_action.interfaces.cli.executable",
  cli_argv: "timeline.items_by_event_id.<event_id>.next_action.interfaces.cli.argv[]",
  cli_args: "timeline.items_by_event_id.<event_id>.next_action.interfaces.cli.args[]",
  cli_exec_file: "timeline.items_by_event_id.<event_id>.next_action.interfaces.cli.exec_file",
  cli_placeholder: "timeline.items_by_event_id.<event_id>.next_action.interfaces.cli.placeholders[]",
  cli_command_line: "timeline.items_by_event_id.<event_id>.next_action.interfaces.cli.command_line",
  ordered_cli_executable: "timeline.items[].next_action.interfaces.cli.executable",
  ordered_cli_argv: "timeline.items[].next_action.interfaces.cli.argv[]",
  ordered_cli_args: "timeline.items[].next_action.interfaces.cli.args[]",
  ordered_cli_exec_file: "timeline.items[].next_action.interfaces.cli.exec_file",
  ordered_cli_placeholder: "timeline.items[].next_action.interfaces.cli.placeholders[]",
  ordered_cli_command_line: "timeline.items[].next_action.interfaces.cli.command_line",
  argument: "timeline.items_by_event_id.<event_id>.next_action.arguments_by_name.<argument>",
  ordered_argument: "timeline.items[].next_action.arguments_by_name.<argument>",
  required_field: "timeline.items_by_event_id.<event_id>.next_action.required_fields_by_name.<field>",
  ordered_required_field: "timeline.items[].next_action.required_fields_by_name.<field>",
  required_input: "timeline.items_by_event_id.<event_id>.next_action.execution.required_inputs_by_field.<field>",
  ordered_required_input: "timeline.items[].next_action.execution.required_inputs_by_field.<field>",
  required_input_argument_path:
    "timeline.items_by_event_id.<event_id>.next_action.execution.required_inputs_by_argument_path.<argument_path>",
  ordered_required_input_argument_path:
    "timeline.items[].next_action.execution.required_inputs_by_argument_path.<argument_path>",
  argument_source: "timeline.items_by_event_id.<event_id>.next_action.argument_sources.<field>",
  ordered_argument_source: "timeline.items[].next_action.argument_sources.<field>"
};

function withActionInterfaces<
  T extends { tool: string; command: string; arguments: unknown; required_fields: string[] }
>(
  action: T
): T & {
  required_fields_by_name: Record<string, RequiredFieldMetadata>;
  arguments_by_name: ReturnType<typeof operationArgumentsByTool>;
  interfaces: ActionInterfaces<T["arguments"] & Record<string, unknown>>;
} {
  const actionWithRequiredFields = withRequiredFieldsByName({
    ...action,
    arguments: action.arguments as Record<string, unknown>
  });
  return {
    ...actionWithRequiredFields,
    arguments: action.arguments,
    arguments_by_name: operationArgumentsByTool(action.tool),
    interfaces: actionInterfaces({
      tool: action.tool,
      command: action.command,
      arguments: action.arguments as T["arguments"] & Record<string, unknown>
    })
  };
}

function actionArgumentSources(action: object): Record<string, string> | undefined {
  return "argument_sources" in action && action.argument_sources && typeof action.argument_sources === "object"
    ? (action.argument_sources as Record<string, string>)
    : undefined;
}

function requiredInputSelectionSources(selectionSources: Record<string, string>): Record<string, string> | undefined {
  const sources = Object.fromEntries(
    Object.entries(selectionSources).filter(([key]) => key.includes("required_input"))
  );
  return Object.keys(sources).length > 0 ? sources : undefined;
}

function withProjectListNextMetadata<
  T extends {
    recommended_action: string;
    tool: string;
    command: string;
    arguments: Record<string, unknown>;
    safe_to_run: boolean;
    required_when: string;
    required_fields: string[];
  }
>(action: T) {
  const actionWithInterfaces = withActionInterfaces(action);
  const projectId = typeof action.arguments.project_id === "string" ? action.arguments.project_id : "<project_id>";
  return {
    ...actionWithInterfaces,
    action_source: `project_list.projects_by_id.${projectId}.next`,
    selection_sources: PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      required_fields_by_name: actionWithInterfaces.required_fields_by_name,
      arguments_by_name: actionWithInterfaces.arguments_by_name,
      argument_sources: actionArgumentSources(action),
      required_input_selection_sources: requiredInputSelectionSources(PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES)
    }),
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

function withRefreshChangeNextActionMetadata<
  T extends {
    recommended_action: string;
    tool: string;
    command: string;
    arguments: Record<string, unknown>;
    safe_to_run: boolean;
    required_when: string;
    required_fields: string[];
  }
>(action: T) {
  const actionWithInterfaces = withActionInterfaces(action);
  const recordIds = action.arguments.record_ids;
  const recordId = Array.isArray(recordIds) && typeof recordIds[0] === "string" ? recordIds[0] : "<record_id>";
  return {
    ...actionWithInterfaces,
    action_source: `refresh.changes_by_record_id.${recordId}.next_action`,
    selection_sources: REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      required_fields_by_name: actionWithInterfaces.required_fields_by_name,
      arguments_by_name: actionWithInterfaces.arguments_by_name,
      argument_sources: actionArgumentSources(action),
      required_input_selection_sources: requiredInputSelectionSources(REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES)
    }),
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

function withTimelineItemNextActionMetadata<
  T extends {
    recommended_action: string;
    tool: string;
    command: string;
    arguments: Record<string, unknown>;
    safe_to_run: boolean;
    required_when: string;
    required_fields: string[];
  }
>(action: T) {
  const actionWithInterfaces = withActionInterfaces(action);
  const recordIds = action.arguments.record_ids;
  const recordId = Array.isArray(recordIds) && typeof recordIds[0] === "string" ? recordIds[0] : "<record_id>";
  return {
    ...actionWithInterfaces,
    action_source: `timeline.items_by_record_id.${recordId}.next_action`,
    selection_sources: TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES,
    safety: actionSafety(action),
    execution: actionExecution({
      ...action,
      required_fields_by_name: actionWithInterfaces.required_fields_by_name,
      arguments_by_name: actionWithInterfaces.arguments_by_name,
      argument_sources: actionArgumentSources(action),
      required_input_selection_sources: requiredInputSelectionSources(TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES)
    }),
    workflow: withPhasesByName({
      version: 1,
      start: "next_action",
      continue_from: ["timeline.items_by_event_id.<event_id>.next_action", "timeline.items[].next_action"],
      phases: [
        {
          phase: action.recommended_action,
          order: 1,
          action_source: "timeline.items_by_event_id.<event_id>.next_action",
          tool: action.tool,
          required_when: action.required_when,
          required_fields: action.required_fields
        }
      ]
    })
  };
}

interface StateChangeInput {
  record_id: unknown;
  reason?: unknown;
  source?: RecordSource;
  idempotency_key?: unknown;
}

interface RevisionInput {
  record_id: unknown;
  patch: unknown;
  reason?: unknown;
  source?: RecordSource;
  confirmed?: boolean;
  idempotency_key?: unknown;
}

interface PromoteInput {
  record_id: unknown;
  target_state: unknown;
  reason?: unknown;
  source?: RecordSource;
  confirmed?: boolean;
  idempotency_key?: unknown;
}

interface LinkInput {
  record_id: unknown;
  linked_record_id: unknown;
  link_type: unknown;
  source?: RecordSource;
  idempotency_key?: unknown;
}

interface LogicalLinkInput {
  record_id: unknown;
  linked_record_id: unknown;
  relationship: unknown;
  reason: unknown;
  source?: RecordSource;
  idempotency_key?: unknown;
}

interface ProjectMigrateInput {
  from_project_id?: unknown;
  to_project_id?: unknown;
  dry_run?: unknown;
  confirmed?: unknown;
  include_private?: unknown;
  source?: RecordSource;
}

type ValidatedStateChangeInput = StateChangeInput & { record_id: string; reason?: string; idempotency_key?: string };
type ValidatedRevisionInput = RevisionInput & { record_id: string; reason?: string; idempotency_key?: string };
type ValidatedPromoteInput = PromoteInput & {
  record_id: string;
  target_state: RecordState;
  reason?: string;
  idempotency_key?: string;
};
type ValidatedRecordFeedbackInput = RecordFeedbackInput & {
  record_id: string;
  outcome: RecordFeedbackOutcome;
  occurred_at?: string;
  idempotency_key: string;
};
type ValidatedLinkInput = LinkInput & {
  record_id: string;
  linked_record_id: string;
  link_type: string;
  idempotency_key?: string;
};
type ValidatedProjectMigrateInput = ProjectMigrateInput & {
  from_project_id: string;
  to_project_id: string;
  dry_run: boolean;
  confirmed?: boolean;
  include_private: boolean;
};

type ReadOperation =
  | "recall"
  | "boot"
  | "refresh"
  | "timeline"
  | "list_recent"
  | "project_list"
  | "memory_doctor"
  | "memory_maintenance_shadow"
  | "memory_lifecycle"
  | "capture_policy"
  | "dogfood_report"
  | "health_check"
  | "recall_eval";
type ReadOperationContractSource = `operations_by_id.${ReadOperation}`;
type ReadArgumentSource = `operations_by_id.${ReadOperation}.arguments_by_name.${string}`;
type AgentIdentityField = "client" | "session_id" | "model" | "device_id";
type AgentIdentityArgument = `agent.${AgentIdentityField}`;

type MutationOperation = "revise" | "promote" | "archive" | "quarantine" | "link" | "memory_feedback";
type MutationOperationContractSource = `operations_by_id.${MutationOperation}`;
type SourceIdentityField = "client" | "session_id" | "model" | "device_id";
type SourceIdentityArgument = `source.${SourceIdentityField}`;
type MutationArgumentName =
  | "record_id"
  | "linked_record_id"
  | "reason"
  | SourceIdentityArgument
  | "link_type"
  | "confirmed"
  | "target_state";
type MutationArgumentSource = `operations_by_id.${MutationOperation}.arguments_by_name.${string}`;

const SOURCE_IDENTITY_FIELDS = {
  client: {
    argument: "source.client",
    contractArgument: "source_client",
    placeholder: "<client>"
  },
  session_id: {
    argument: "source.session_id",
    contractArgument: "source_session_id",
    placeholder: "<source session id>"
  },
  model: {
    argument: "source.model",
    contractArgument: "source_model",
    placeholder: "<source model>"
  },
  device_id: {
    argument: "source.device_id",
    contractArgument: "source_device_id",
    placeholder: "<source device id>"
  }
} as const satisfies Record<
  SourceIdentityField,
  {
    argument: SourceIdentityArgument;
    contractArgument: string;
    placeholder: string;
  }
>;

const AGENT_IDENTITY_FIELDS = {
  client: {
    argument: "agent.client",
    contractArgument: "agent_client",
    placeholder: "<agent client>"
  },
  session_id: {
    argument: "agent.session_id",
    contractArgument: "agent_session_id",
    placeholder: "<agent session id>"
  },
  model: {
    argument: "agent.model",
    contractArgument: "agent_model",
    placeholder: "<agent model>"
  },
  device_id: {
    argument: "agent.device_id",
    contractArgument: "agent_device_id",
    placeholder: "<agent device id>"
  }
} as const satisfies Record<
  AgentIdentityField,
  {
    argument: AgentIdentityArgument;
    contractArgument: string;
    placeholder: string;
  }
>;

function textOf(record: MorynRecord): string {
  return displayRecordText(record);
}

function searchableText(record: MorynRecord): string {
  return searchableRecordText(record);
}

const COMPACT_CONTENT_OMIT_KEYS = new Set([
  "content",
  "content_hex",
  "content_base64",
  "artifact_content",
  "artifacts",
  "file_index"
]);

const COMPACT_CONTENT_KEEP_KEYS = new Set([
  "format",
  "text",
  "summary",
  "name",
  "label",
  "purpose",
  "path",
  "directory",
  "install_path",
  "content_encoding",
  "path_encoding",
  "sha256",
  "bytes",
  "size",
  "restore",
  "restore_instruction",
  "restore_instructions",
  "install_note",
  "artifact_records",
  "restore_order",
  "current_notion_page_url",
  "schema_version"
]);

function isLargeString(value: unknown): boolean {
  return typeof value === "string" && value.length > 1200;
}

function shouldCompactContent(record: MorynRecord): boolean {
  if (record.tags.some((tag) => ["full-content", "portable-install", "encoded-bundle", "hex-encoded"].includes(tag)))
    return true;
  if (/(?:full_content|bundle|artifact)/i.test(record.type)) return true;
  return Object.entries(record.content).some(
    ([key, value]) => COMPACT_CONTENT_OMIT_KEYS.has(key) || isLargeString(value)
  );
}

function compactSummaryText(record: MorynRecord, limit = 500): string {
  const values: string[] = [];
  for (const key of ["text", "summary", "name", "label", "purpose", "path", "directory", "install_path", "sha256"]) {
    const value = record.content[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  if (!values.length) values.push(`${record.kind}:${record.type}`);
  const text = [...new Set(values)].join(" ");
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function compactContent(record: MorynRecord): MorynRecord["content"] {
  if (!shouldCompactContent(record)) return record.content;
  const omittedFields: string[] = [];
  const content: MorynRecord["content"] = {};

  for (const [key, value] of Object.entries(record.content)) {
    if (COMPACT_CONTENT_OMIT_KEYS.has(key) || isLargeString(value)) {
      omittedFields.push(key);
      continue;
    }
    if (COMPACT_CONTENT_KEEP_KEYS.has(key)) {
      content[key] = value;
    }
  }

  const summary = compactSummaryText(record);
  if (!content.text && summary) content.text = summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
  content.omitted_fields = omittedFields;
  content.retrieve = {
    record_id: record.id,
    command: recallRecordCommand(record.id, record.project_id)
  };
  return content;
}

function compactRecord(record: MorynRecord): MorynRecord {
  const content = compactContent(record);
  if (content === record.content) return record;
  return { ...record, content };
}

function compactRecords(records: MorynRecord[]): MorynRecord[] {
  return records.map(compactRecord);
}

function validateLimit(limit: unknown, fallback: number, operation: ReadOperation): number {
  const resolved = limit ?? fallback;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < 1 || resolved > 100) {
    throw invalidReadLimitError(operation, resolved);
  }
  return resolved;
}

function validateReadNumberRange(
  value: unknown,
  fallback: number | undefined,
  operation: ReadOperation,
  argument: string,
  minimum: number,
  maximum: number,
  integer: boolean
): number | undefined {
  const resolved = value ?? fallback;
  if (resolved === undefined) return undefined;
  if (
    typeof resolved !== "number" ||
    !Number.isFinite(resolved) ||
    resolved < minimum ||
    resolved > maximum ||
    (integer && !Number.isSafeInteger(resolved))
  ) {
    throw invalidReadNumberRangeError(operation, argument, resolved, minimum, maximum, integer);
  }
  return resolved;
}

function validateTimelineWindow(value: unknown, fallback: number, argument: "before" | "after"): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < 0 || resolved > 50) {
    throw invalidReadWindowError("timeline", argument, resolved);
  }
  return resolved;
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid argument: Invalid ${name}`);
  }
}

function assertOnlyInputKeys(input: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`Invalid argument: Unknown ${name}.${unknown}`);
}

function normalizeMemoryCompactionPreviewInput(input: unknown): MemoryCompactionPreviewOptions {
  assertPlainObject(input, "memory compaction preview input");
  assertOnlyInputKeys(
    input,
    ["project_id", "session_id", "bucket_kind", "bucket_key", "now", "recent_window_days", "include_private"],
    "memory compaction preview input"
  );
  for (const key of ["project_id", "session_id", "bucket_key"] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`Invalid argument: ${key} must be a non-empty string`);
    }
  }
  if (
    input.bucket_kind !== undefined &&
    (typeof input.bucket_kind !== "string" ||
      !EPISODE_BUCKET_KINDS.includes(input.bucket_kind as (typeof EPISODE_BUCKET_KINDS)[number]))
  ) {
    throw new Error(`Invalid argument: bucket_kind must be one of ${EPISODE_BUCKET_KINDS.join(", ")}`);
  }
  if (
    input.now !== undefined &&
    (typeof input.now !== "string" ||
      !Number.isFinite(Date.parse(input.now)) ||
      new Date(input.now).toISOString() !== input.now)
  ) {
    throw new Error("Invalid argument: now must be a canonical ISO timestamp");
  }
  if (
    input.recent_window_days !== undefined &&
    (typeof input.recent_window_days !== "number" ||
      !Number.isInteger(input.recent_window_days) ||
      input.recent_window_days < 0 ||
      input.recent_window_days > 3650)
  ) {
    throw new Error("Invalid argument: recent_window_days must be an integer from 0 through 3650");
  }
  if (input.include_private !== undefined && typeof input.include_private !== "boolean") {
    throw new Error("Invalid argument: include_private must be a boolean");
  }
  return {
    ...(typeof input.project_id === "string" ? { project_id: input.project_id.trim() } : {}),
    ...(typeof input.session_id === "string" ? { session_id: input.session_id.trim() } : {}),
    ...(typeof input.bucket_kind === "string"
      ? { bucket_kind: input.bucket_kind as (typeof EPISODE_BUCKET_KINDS)[number] }
      : {}),
    ...(typeof input.bucket_key === "string" ? { bucket_key: input.bucket_key.trim() } : {}),
    ...(typeof input.now === "string" ? { now: input.now } : {}),
    ...(typeof input.recent_window_days === "number" ? { recent_window_days: input.recent_window_days } : {}),
    include_private: input.include_private === true
  };
}

type MutationArgumentRecoveryHint =
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: {
        argument: "record_id" | "linked_record_id" | "reason" | SourceIdentityArgument | "link_type";
        value: unknown;
      };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Partial<Record<MutationArgumentName, MutationArgumentSource>>;
      retry_with: {
        argument: "record_id" | "linked_record_id" | "reason" | SourceIdentityArgument | "link_type";
        value_placeholder: string;
      };
    }
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: "confirmed"; value: unknown };
      expected: { kind: "boolean" };
      argument_sources: { confirmed: MutationArgumentSource };
      retry_with: { argument: "confirmed"; value_placeholder: true };
    }
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: "target_state"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { target_state: MutationArgumentSource };
      retry_with: { argument: "target_state"; value_placeholder: "canonical" };
    }
  | {
      rejected_argument: { argument: SourceIdentityArgument; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
    }
  | {
      operation_contract: MutationOperationContractSource;
      rejected_argument: { argument: `source.${string}`; value: unknown };
      expected: { kind: "known_object_field"; allowed_fields: SourceIdentityField[] };
      argument_sources: Partial<Record<SourceIdentityArgument, MutationArgumentSource>>;
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"];
    };

class MutationArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: MutationArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: MutationArgumentRecoveryHint) {
    super(message);
    this.name = "MutationArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function mutationOperationContractSource(operation: MutationOperation): MutationOperationContractSource {
  return `operations_by_id.${operation}`;
}

function mutationArgumentSource(operation: MutationOperation, argument: MutationArgumentName): MutationArgumentSource {
  const argumentName = argument.startsWith("source.")
    ? SOURCE_IDENTITY_FIELDS[argument.slice("source.".length) as SourceIdentityField].contractArgument
    : argument;
  return `operations_by_id.${operation}.arguments_by_name.${argumentName}`;
}

function invalidMutationStringError(
  operation: MutationOperation,
  argument: "record_id" | "linked_record_id" | "reason" | "link_type",
  value: unknown
): MutationArgumentError {
  const action =
    argument === "link_type"
      ? "retry link with a non-empty link_type"
      : argument === "reason"
        ? "retry mutation with a non-empty reason"
        : `retry mutation with a valid ${argument}`;
  return new MutationArgumentError(`Invalid argument: Invalid ${argument}`, action, {
    operation_contract: mutationOperationContractSource(operation),
    rejected_argument: { argument, value },
    expected: { kind: "non_empty_string", min_length: 1 },
    argument_sources: { [argument]: mutationArgumentSource(operation, argument) },
    retry_with: { argument, value_placeholder: `<${argument}>` }
  });
}

function invalidMutationConfirmedError(operation: MutationOperation, confirmed: unknown): MutationArgumentError {
  return new MutationArgumentError(
    "Invalid argument: Invalid confirmed",
    "retry mutation with a boolean confirmed value",
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: "confirmed", value: confirmed },
      expected: { kind: "boolean" },
      argument_sources: { confirmed: mutationArgumentSource(operation, "confirmed") },
      retry_with: { argument: "confirmed", value_placeholder: true }
    }
  );
}

function invalidMutationTargetStateError(operation: MutationOperation, targetState: unknown): MutationArgumentError {
  return new MutationArgumentError(
    "Invalid argument: Invalid target_state",
    "retry mutation with a supported target_state",
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: "target_state", value: targetState },
      expected: { kind: "allowed_values", allowed_values: [...RECORD_STATES] },
      argument_sources: { target_state: mutationArgumentSource(operation, "target_state") },
      retry_with: { argument: "target_state", value_placeholder: "canonical" }
    }
  );
}

function sourceIdentityValue(source: unknown, field: SourceIdentityField): unknown {
  return typeof source === "object" && source !== null && field in source
    ? (source as Partial<Record<SourceIdentityField, unknown>>)[field]
    : undefined;
}

function invalidSourceIdentityError(
  operation: MutationOperation,
  source: unknown,
  field: SourceIdentityField,
  recommendedAction: string
): MutationArgumentError {
  const metadata = SOURCE_IDENTITY_FIELDS[field];
  const action = field === "client" ? recommendedAction : "retry mutation with valid source metadata";
  return new MutationArgumentError(`Invalid argument: Invalid ${metadata.argument}`, action, {
    operation_contract: mutationOperationContractSource(operation),
    rejected_argument: { argument: metadata.argument, value: sourceIdentityValue(source, field) },
    expected: { kind: "non_empty_string", min_length: 1 },
    argument_sources: { [metadata.argument]: mutationArgumentSource(operation, metadata.argument) },
    retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
  });
}

function invalidSourceUnknownFieldError(
  operation: MutationOperation,
  source: Record<string, unknown>,
  field: string
): MutationArgumentError {
  const retryField = closestIdentityField(field);
  const metadata = SOURCE_IDENTITY_FIELDS[retryField];
  return new MutationArgumentError(
    `Invalid argument: Unknown source.${field}`,
    "retry mutation with supported source metadata fields",
    {
      operation_contract: mutationOperationContractSource(operation),
      rejected_argument: { argument: `source.${field}`, value: source[field] },
      expected: {
        kind: "known_object_field",
        allowed_fields: Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[]
      },
      argument_sources: { [metadata.argument]: mutationArgumentSource(operation, metadata.argument) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder },
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"]
    }
  );
}

function invalidGenericSourceIdentityError(
  source: unknown,
  field: SourceIdentityField,
  recommendedAction: string
): MutationArgumentError {
  const metadata = SOURCE_IDENTITY_FIELDS[field];
  const action = field === "client" ? recommendedAction : "retry with valid source metadata";
  return new MutationArgumentError(`Invalid argument: Invalid ${metadata.argument}`, action, {
    rejected_argument: { argument: metadata.argument, value: sourceIdentityValue(source, field) },
    expected: { kind: "non_empty_string", min_length: 1 },
    retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
  });
}

function closestIdentityField(field: string): SourceIdentityField {
  const normalized = normalizeIdentityFieldName(field);
  return (
    (Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[]).sort((left, right) => {
      const leftScore = identityFieldSuggestionScore(normalized, normalizeIdentityFieldName(left));
      const rightScore = identityFieldSuggestionScore(normalized, normalizeIdentityFieldName(right));
      return rightScore - leftScore || left.localeCompare(right);
    })[0] ?? "client"
  );
}

function normalizeIdentityFieldName(field: string): string {
  return field.replace(/[._-]/g, "").toLowerCase();
}

function identityFieldSuggestionScore(unknownField: string, knownField: string): number {
  if (unknownField === knownField) return Number.MAX_SAFE_INTEGER;
  const longest = Math.max(unknownField.length, knownField.length);
  if (longest === 0) return 0;
  return longestCommonSubsequenceLength(unknownField, knownField) / longest;
}

function longestCommonSubsequenceLength(left: string, right: string): number {
  const previous = Array(right.length + 1).fill(0) as number[];
  const current = Array(right.length + 1).fill(0) as number[];
  for (const leftCharacter of left) {
    for (let index = 0; index < right.length; index += 1) {
      current[index + 1] =
        leftCharacter === right[index] ? previous[index] + 1 : Math.max(previous[index + 1] ?? 0, current[index] ?? 0);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }
  return previous[right.length] ?? 0;
}

type ReadArgumentRecoveryHint =
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: string };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "array_of_non_empty_strings" };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: string[] };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "array_of_allowed_values"; allowed_values: string[] };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: string[] };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: "limit"; value: unknown };
      expected: { kind: "integer_range"; min: 1; max: 100; integer: true };
      argument_sources: { limit: ReadArgumentSource };
      retry_with: { argument: "limit"; value_placeholder: 10 };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: "before" | "after"; value: unknown };
      expected: { kind: "integer_range"; min: 0; max: 50; integer: true };
      argument_sources: Partial<Record<"before" | "after", ReadArgumentSource>>;
      retry_with: { argument: "before" | "after"; value_placeholder: 5 };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: "include_private" | "all_projects"; value: unknown };
      expected: { kind: "boolean" };
      argument_sources: Partial<Record<"include_private" | "all_projects", ReadArgumentSource>>;
      retry_with: { argument: "include_private" | "all_projects"; value_placeholder: true };
    }
  | {
      operation_contract: ReadOperationContractSource;
      rejected_argument: { argument: string; value: unknown };
      expected: { kind: "number_range" | "integer_range"; min: number; max: number; integer: boolean };
      argument_sources: Record<string, ReadArgumentSource>;
      retry_with: { argument: string; value_placeholder: number };
    }
  | {
      operation_contract: "operations_by_id.timeline";
      rejected_argument: { argument: "anchor"; value: string[] };
      expected: { kind: "one_of"; allowed_arguments: ["record_id", "event_id", "query"] };
      argument_sources: Record<"record_id" | "event_id" | "query", ReadArgumentSource>;
      retry_with: { argument: "record_id"; value_placeholder: "<record_id>" };
    }
  | {
      operation_contract: "operations_by_id.project_list";
      rejected_argument: { argument: AgentIdentityArgument; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Record<AgentIdentityArgument, ReadArgumentSource>;
      retry_with: { argument: AgentIdentityArgument; value_placeholder: string };
    }
  | {
      operation_contract: "operations_by_id.project_list";
      rejected_argument: { argument: `agent.${string}`; value: unknown };
      expected: { kind: "known_object_field"; allowed_fields: AgentIdentityField[] };
      argument_sources: Partial<Record<AgentIdentityArgument, ReadArgumentSource>>;
      retry_with: { argument: AgentIdentityArgument; value_placeholder: string };
      do_not: ["send_unknown_agent_fields", "retry_with_same_unknown_field"];
    };

class ReadArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: ReadArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: ReadArgumentRecoveryHint) {
    super(message);
    this.name = "ReadArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function readOperationContractSource(operation: ReadOperation): ReadOperationContractSource {
  return `operations_by_id.${operation}`;
}

function readArgumentSource(operation: ReadOperation, argument: string): ReadArgumentSource {
  return `operations_by_id.${operation}.arguments_by_name.${argument}`;
}

function invalidReadLimitError(operation: ReadOperation, limit: unknown): ReadArgumentError {
  return new ReadArgumentError(
    "Invalid argument: Invalid limit; must be an integer between 1 and 100",
    "retry read with a limit between 1 and 100",
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument: "limit", value: limit },
      expected: { kind: "integer_range", min: 1, max: 100, integer: true },
      argument_sources: { limit: readArgumentSource(operation, "limit") },
      retry_with: { argument: "limit", value_placeholder: 10 }
    }
  );
}

function invalidReadWindowError(
  operation: ReadOperation,
  argument: "before" | "after",
  value: unknown
): ReadArgumentError {
  return new ReadArgumentError(
    `Invalid argument: Invalid ${argument}; must be an integer between 0 and 50`,
    "retry read with a timeline window between 0 and 50",
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument, value },
      expected: { kind: "integer_range", min: 0, max: 50, integer: true },
      argument_sources: { [argument]: readArgumentSource(operation, argument) },
      retry_with: { argument, value_placeholder: argument === "before" ? 5 : 5 }
    }
  );
}

function invalidReadNumberRangeError(
  operation: ReadOperation,
  argument: string,
  value: unknown,
  minimum: number,
  maximum: number,
  integer: boolean
): ReadArgumentError {
  const range = `${minimum} and ${maximum}`;
  return new ReadArgumentError(
    `Invalid argument: Invalid ${argument}; must be ${integer ? "an integer" : "a number"} between ${range}`,
    `retry read with a valid ${argument} value`,
    {
      operation_contract: readOperationContractSource(operation),
      rejected_argument: { argument, value },
      expected: {
        kind: integer ? "integer_range" : "number_range",
        min: minimum,
        max: maximum,
        integer
      },
      argument_sources: { [argument]: readArgumentSource(operation, argument) },
      retry_with: { argument, value_placeholder: minimum }
    }
  );
}

function invalidReadBooleanError(
  operation: ReadOperation,
  argument: "include_private" | "all_projects",
  value: unknown
): ReadArgumentError {
  return new ReadArgumentError(`Invalid argument: Invalid ${argument}`, `retry read with a boolean ${argument} value`, {
    operation_contract: readOperationContractSource(operation),
    rejected_argument: { argument, value },
    expected: { kind: "boolean" },
    argument_sources: { [argument]: readArgumentSource(operation, argument) },
    retry_with: { argument, value_placeholder: true }
  });
}

function invalidReadAnchorError(input: TimelineInput): ReadArgumentError {
  const provided = [
    input.record_id !== undefined ? "record_id" : undefined,
    input.event_id !== undefined ? "event_id" : undefined,
    input.query !== undefined ? "query" : undefined
  ].filter((value): value is string => Boolean(value));
  return new ReadArgumentError(
    "Invalid argument: timeline requires exactly one anchor",
    "retry timeline with exactly one of record_id, event_id, or query",
    {
      operation_contract: "operations_by_id.timeline",
      rejected_argument: { argument: "anchor", value: provided },
      expected: { kind: "one_of", allowed_arguments: ["record_id", "event_id", "query"] },
      argument_sources: {
        record_id: "operations_by_id.timeline.arguments_by_name.record_id",
        event_id: "operations_by_id.timeline.arguments_by_name.event_id",
        query: "operations_by_id.timeline.arguments_by_name.query"
      },
      retry_with: { argument: "record_id", value_placeholder: "<record_id>" }
    }
  );
}

function readPlaceholder(name: string): string {
  return `<${name}>`;
}

function invalidReadStringError(operation: ReadOperation, name: string, value: unknown): ReadArgumentError {
  return new ReadArgumentError(`Invalid argument: Invalid ${name}`, `retry read with a non-empty ${name}`, {
    operation_contract: readOperationContractSource(operation),
    rejected_argument: { argument: name, value },
    expected: { kind: "non_empty_string", min_length: 1 },
    argument_sources: { [name]: readArgumentSource(operation, name) },
    retry_with: { argument: name, value_placeholder: readPlaceholder(name) }
  });
}

function invalidReadStringArrayError(operation: ReadOperation, name: string, value: unknown): ReadArgumentError {
  const singular = name.endsWith("s") ? name.slice(0, -1) : name;
  return new ReadArgumentError(`Invalid argument: Invalid ${name}`, `retry read with ${name} as non-empty strings`, {
    operation_contract: readOperationContractSource(operation),
    rejected_argument: { argument: name, value },
    expected: { kind: "array_of_non_empty_strings" },
    argument_sources: { [name]: readArgumentSource(operation, name) },
    retry_with: { argument: name, value_placeholder: [readPlaceholder(singular)] }
  });
}

function invalidReadEnumArrayError<T extends string>(
  operation: ReadOperation,
  name: string,
  value: unknown,
  allowedValues: readonly T[],
  placeholder: T
): ReadArgumentError {
  return new ReadArgumentError(`Invalid argument: Invalid ${name}`, `retry read with supported ${name}`, {
    operation_contract: readOperationContractSource(operation),
    rejected_argument: { argument: name, value },
    expected: { kind: "array_of_allowed_values", allowed_values: [...allowedValues] },
    argument_sources: { [name]: readArgumentSource(operation, name) },
    retry_with: { argument: name, value_placeholder: [placeholder] }
  });
}

function agentIdentityValue(agent: unknown, field: AgentIdentityField): unknown {
  return typeof agent === "object" && agent !== null && field in agent
    ? (agent as Partial<Record<AgentIdentityField, unknown>>)[field]
    : undefined;
}

function invalidProjectListAgentIdentityError(agent: unknown, field: AgentIdentityField): ReadArgumentError {
  const metadata = AGENT_IDENTITY_FIELDS[field];
  return new ReadArgumentError(
    `Invalid argument: Invalid ${metadata.argument}`,
    field === "client"
      ? "retry project_list with a valid agent client"
      : "retry project_list with valid agent identity metadata",
    {
      operation_contract: "operations_by_id.project_list",
      rejected_argument: { argument: metadata.argument, value: agentIdentityValue(agent, field) },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: {
        [metadata.argument]: readArgumentSource("project_list", metadata.contractArgument)
      },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
    }
  );
}

function invalidProjectListAgentUnknownFieldError(agent: Record<string, unknown>, field: string): ReadArgumentError {
  const retryField = closestIdentityField(field);
  const metadata = AGENT_IDENTITY_FIELDS[retryField];
  const argument = `agent.${field}` as `agent.${string}`;
  return new ReadArgumentError(
    `Invalid argument: Unknown agent.${field}`,
    "retry project_list with supported agent identity fields",
    {
      operation_contract: "operations_by_id.project_list",
      rejected_argument: { argument, value: agent[field] },
      expected: {
        kind: "known_object_field",
        allowed_fields: Object.keys(AGENT_IDENTITY_FIELDS) as AgentIdentityField[]
      },
      argument_sources: {
        [metadata.argument]: readArgumentSource("project_list", metadata.contractArgument)
      },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder },
      do_not: ["send_unknown_agent_fields", "retry_with_same_unknown_field"]
    }
  );
}

function validateProjectListAgent(agent: unknown): void {
  if (agent === undefined) return;
  if (typeof agent !== "object" || agent === null || Array.isArray(agent)) {
    throw invalidProjectListAgentIdentityError(agent, "client");
  }
  const rawAgent = agent as Partial<Record<AgentIdentityField, unknown>>;
  for (const field of Object.keys(agent)) {
    if (!(field in AGENT_IDENTITY_FIELDS)) {
      throw invalidProjectListAgentUnknownFieldError(agent as Record<string, unknown>, field);
    }
  }
  for (const field of Object.keys(AGENT_IDENTITY_FIELDS) as AgentIdentityField[]) {
    const value = rawAgent[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw invalidProjectListAgentIdentityError(agent, field);
    }
  }
}

function validateRecordId(
  operation: MutationOperation,
  recordId: unknown,
  name: "record_id" | "linked_record_id" = "record_id"
): void {
  if (typeof recordId !== "string" || !recordId.length) {
    throw invalidMutationStringError(operation, name, recordId);
  }
}

function validateOptionalReason(operation: MutationOperation, reason: unknown): void {
  if (reason !== undefined && (typeof reason !== "string" || !reason.length)) {
    throw invalidMutationStringError(operation, "reason", reason);
  }
}

function validateOptionalSource(
  source: unknown,
  operation?: MutationOperation,
  recommendedAction = "retry with a valid source client"
): void {
  if (source === undefined) return;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    if (operation === undefined) {
      throw invalidGenericSourceIdentityError(source, "client", recommendedAction);
    }
    throw invalidSourceIdentityError(operation, source, "client", recommendedAction);
  }
  const rawSource = source as Partial<Record<SourceIdentityField, unknown>>;
  for (const field of Object.keys(source)) {
    if (!(field in SOURCE_IDENTITY_FIELDS) && operation !== undefined) {
      throw invalidSourceUnknownFieldError(operation, source as Record<string, unknown>, field);
    }
  }
  for (const field of Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[]) {
    const value = rawSource[field];
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      if (operation === undefined) {
        throw invalidGenericSourceIdentityError(source, field, recommendedAction);
      }
      throw invalidSourceIdentityError(operation, source, field, recommendedAction);
    }
  }
  if (rawSource.client === undefined) {
    if (operation === undefined) {
      throw invalidGenericSourceIdentityError(source, "client", recommendedAction);
    }
    throw invalidSourceIdentityError(operation, source, "client", recommendedAction);
  }
}

function validateOptionalConfirmed(operation: MutationOperation, confirmed: unknown): void {
  if (confirmed !== undefined && typeof confirmed !== "boolean")
    throw invalidMutationConfirmedError(operation, confirmed);
}

function validateOptionalString(operation: ReadOperation, value: unknown, name: string): void {
  if (value !== undefined && (typeof value !== "string" || !value.length)) {
    throw invalidReadStringError(operation, name, value);
  }
}

function validateOptionalStringArray(operation: ReadOperation, value: unknown, name: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0))
  ) {
    throw invalidReadStringArrayError(operation, name, value);
  }
}

function validateOptionalBoolean(
  operation: ReadOperation,
  value: unknown,
  name: "include_private" | "all_projects"
): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw invalidReadBooleanError(operation, name, value);
  }
}

function validateOptionalEnumArray<T extends string>(
  operation: ReadOperation,
  value: unknown,
  name: string,
  schema: { safeParse: (value: unknown) => { success: boolean } },
  allowedValues: readonly T[],
  placeholder: T
): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) || !value.every((item): item is T => schema.safeParse(item).success))
  ) {
    throw invalidReadEnumArrayError(operation, name, value, allowedValues, placeholder);
  }
}

type WriteContentRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "content"; value: unknown };
      expected: { kind: "content_object" | "non_empty_content_object"; required: true };
      argument_sources: { content: typeof WRITE_CONTENT_ARGUMENT_SOURCE };
      retry_with: { argument: "content"; value_placeholder: { text: "<text>"; format: "text" } };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "content.text"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: { "content.text": typeof WRITE_CONTENT_TEXT_ARGUMENT_SOURCE };
      retry_with: { argument: "content.text"; value_placeholder: "<non-empty text>" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "content.format"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: ["text", "json"] };
      argument_sources: { "content.format": typeof WRITE_CONTENT_FORMAT_ARGUMENT_SOURCE };
      retry_with: { argument: "content.format"; value_placeholder: "text" };
    };

class WriteContentError extends Error {
  readonly recommended_action = "retry write with valid content";
  readonly recovery_hint: WriteContentRecoveryHint;

  constructor(message: string, recoveryHint: WriteContentRecoveryHint) {
    super(message);
    this.name = "WriteContentError";
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteContentError(
  content: unknown,
  expectedKind: "content_object" | "non_empty_content_object"
): WriteContentError {
  return new WriteContentError("Invalid argument: Invalid content", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "content", value: content },
    expected: { kind: expectedKind, required: true },
    argument_sources: { content: WRITE_CONTENT_ARGUMENT_SOURCE },
    retry_with: { argument: "content", value_placeholder: { text: "<text>", format: "text" } }
  });
}

function invalidWriteContentTextError(text: unknown): WriteContentError {
  return new WriteContentError("Invalid argument: Invalid content.text", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "content.text", value: text },
    expected: { kind: "non_empty_string", min_length: 1 },
    argument_sources: { "content.text": WRITE_CONTENT_TEXT_ARGUMENT_SOURCE },
    retry_with: { argument: "content.text", value_placeholder: "<non-empty text>" }
  });
}

function invalidWriteContentFormatError(format: unknown): WriteContentError {
  return new WriteContentError("Invalid argument: Invalid content.format", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "content.format", value: format },
    expected: { kind: "allowed_values", allowed_values: ["text", "json"] },
    argument_sources: { "content.format": WRITE_CONTENT_FORMAT_ARGUMENT_SOURCE },
    retry_with: { argument: "content.format", value_placeholder: "text" }
  });
}

type WriteCoreFieldRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "kind"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { kind: typeof WRITE_KIND_ARGUMENT_SOURCE };
      retry_with: { argument: "kind"; value_placeholder: "memory" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "scope"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { scope: typeof WRITE_SCOPE_ARGUMENT_SOURCE };
      retry_with: { argument: "scope"; value_placeholder: "project" };
    }
  | {
      rejected_argument: { argument: "type" | "project_id"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      argument_sources: Partial<{
        type: typeof WRITE_TYPE_ARGUMENT_SOURCE;
        project_id: typeof WRITE_PROJECT_ID_ARGUMENT_SOURCE;
      }>;
      retry_with: { argument: "type" | "project_id"; value_placeholder: string };
    };

class WriteCoreFieldError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteCoreFieldRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: WriteCoreFieldRecoveryHint) {
    super(message);
    this.name = "WriteCoreFieldError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteKindError(kind: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError("Invalid argument: Invalid kind", "retry write with a supported kind", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "kind", value: kind },
    expected: { kind: "allowed_values", allowed_values: [...RECORD_KINDS] },
    argument_sources: { kind: WRITE_KIND_ARGUMENT_SOURCE },
    retry_with: { argument: "kind", value_placeholder: "memory" }
  });
}

function invalidWriteTypeError(type: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError("Invalid argument: Invalid type", "retry write with a non-empty type", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "type", value: type },
    expected: { kind: "non_empty_string", min_length: 1 },
    argument_sources: { type: WRITE_TYPE_ARGUMENT_SOURCE },
    retry_with: { argument: "type", value_placeholder: "<record type>" }
  });
}

function invalidWriteScopeError(scope: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError("Invalid argument: Invalid scope", "retry write with a supported scope", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "scope", value: scope },
    expected: { kind: "allowed_values", allowed_values: [...RECORD_SCOPES] },
    argument_sources: { scope: WRITE_SCOPE_ARGUMENT_SOURCE },
    retry_with: { argument: "scope", value_placeholder: "project" }
  });
}

function invalidWriteProjectIdError(projectId: unknown): WriteCoreFieldError {
  return new WriteCoreFieldError("Invalid argument: Invalid project_id", "retry write with a valid project_id", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "project_id", value: projectId },
    expected: { kind: "non_empty_string", min_length: 1 },
    argument_sources: { project_id: WRITE_PROJECT_ID_ARGUMENT_SOURCE },
    retry_with: { argument: "project_id", value_placeholder: "<project_id>" }
  });
}

type WriteTagsRecoveryHint = {
  operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
  rejected_argument: { argument: "tags"; value: unknown };
  expected: { kind: "array_of_non_empty_strings" };
  argument_sources: { tags: typeof WRITE_TAGS_ARGUMENT_SOURCE };
  retry_with: { argument: "tags"; value_placeholder: ["<tag>"] };
};

class WriteTagsError extends Error {
  readonly recommended_action = "retry write with valid tags";
  readonly recovery_hint: WriteTagsRecoveryHint;

  constructor(tags: unknown) {
    super("Invalid argument: Invalid tags");
    this.name = "WriteTagsError";
    this.recovery_hint = {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "tags", value: tags },
      expected: { kind: "array_of_non_empty_strings" },
      argument_sources: { tags: WRITE_TAGS_ARGUMENT_SOURCE },
      retry_with: { argument: "tags", value_placeholder: ["<tag>"] }
    };
  }
}

type WriteSourceArgumentSource =
  | typeof WRITE_SOURCE_CLIENT_ARGUMENT_SOURCE
  | typeof WRITE_SOURCE_SESSION_ID_ARGUMENT_SOURCE
  | typeof WRITE_SOURCE_MODEL_ARGUMENT_SOURCE
  | typeof WRITE_SOURCE_DEVICE_ID_ARGUMENT_SOURCE;

type WriteSourceRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: SourceIdentityArgument; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: Partial<Record<SourceIdentityArgument, WriteSourceArgumentSource>>;
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: `source.${string}`; value: unknown };
      expected: { kind: "known_object_field"; allowed_fields: SourceIdentityField[] };
      argument_sources: Partial<Record<SourceIdentityArgument, WriteSourceArgumentSource>>;
      retry_with: { argument: SourceIdentityArgument; value_placeholder: string };
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"];
    };

class WriteSourceError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteSourceRecoveryHint;

  constructor(source: unknown, field: SourceIdentityField) {
    const metadata = SOURCE_IDENTITY_FIELDS[field];
    super(`Invalid argument: Invalid ${metadata.argument}`);
    this.name = "WriteSourceError";
    this.recommended_action =
      field === "client" ? "retry write with a valid source client" : "retry write with valid source metadata";
    this.recovery_hint = {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: metadata.argument, value: sourceIdentityValue(source, field) },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { [metadata.argument]: writeSourceArgumentSource(field) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder }
    };
  }
}

class WriteUnknownSourceFieldError extends Error {
  readonly recommended_action = "retry write with supported source metadata fields";
  readonly recovery_hint: WriteSourceRecoveryHint;

  constructor(source: Record<string, unknown>, field: string) {
    const retryField = closestIdentityField(field);
    const metadata = SOURCE_IDENTITY_FIELDS[retryField];
    super(`Invalid argument: Unknown source.${field}`);
    this.name = "WriteUnknownSourceFieldError";
    this.recovery_hint = {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: `source.${field}`, value: source[field] },
      expected: {
        kind: "known_object_field",
        allowed_fields: Object.keys(SOURCE_IDENTITY_FIELDS) as SourceIdentityField[]
      },
      argument_sources: { [metadata.argument]: writeSourceArgumentSource(retryField) },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder },
      do_not: ["send_unknown_source_fields", "retry_with_same_unknown_field"]
    };
  }
}

function writeSourceArgumentSource(field: SourceIdentityField): WriteSourceArgumentSource {
  switch (field) {
    case "client":
      return WRITE_SOURCE_CLIENT_ARGUMENT_SOURCE;
    case "session_id":
      return WRITE_SOURCE_SESSION_ID_ARGUMENT_SOURCE;
    case "model":
      return WRITE_SOURCE_MODEL_ARGUMENT_SOURCE;
    case "device_id":
      return WRITE_SOURCE_DEVICE_ID_ARGUMENT_SOURCE;
  }
}

type WriteMetadataRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "state"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { state: typeof WRITE_STATE_ARGUMENT_SOURCE };
      retry_with: { argument: "state"; value_placeholder: "candidate" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "priority"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { priority: typeof WRITE_PRIORITY_ARGUMENT_SOURCE };
      retry_with: { argument: "priority"; value_placeholder: "normal" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "confidence"; value: unknown };
      expected: { kind: "number_range"; min: 0; max: 1; inclusive: true };
      argument_sources: { confidence: typeof WRITE_CONFIDENCE_ARGUMENT_SOURCE };
      retry_with: { argument: "confidence"; value_placeholder: 0.5 };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "confirmed"; value: unknown };
      expected: { kind: "boolean" };
      argument_sources: { confirmed: typeof WRITE_CONFIRMED_ARGUMENT_SOURCE };
      retry_with: { argument: "confirmed"; value_placeholder: true };
    };

class WriteMetadataError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteMetadataRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: WriteMetadataRecoveryHint) {
    super(message);
    this.name = "WriteMetadataError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteStateError(state: unknown): WriteMetadataError {
  return new WriteMetadataError("Invalid argument: Invalid state", "retry write with a supported state", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "state", value: state },
    expected: { kind: "allowed_values", allowed_values: [...RECORD_STATES] },
    argument_sources: { state: WRITE_STATE_ARGUMENT_SOURCE },
    retry_with: { argument: "state", value_placeholder: "candidate" }
  });
}

function invalidWriteConfidenceError(confidence: unknown): WriteMetadataError {
  return new WriteMetadataError("Invalid argument: Invalid confidence", "retry write with confidence between 0 and 1", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "confidence", value: confidence },
    expected: { kind: "number_range", min: 0, max: 1, inclusive: true },
    argument_sources: { confidence: WRITE_CONFIDENCE_ARGUMENT_SOURCE },
    retry_with: { argument: "confidence", value_placeholder: 0.5 }
  });
}

function invalidWritePriorityError(priority: unknown): WriteMetadataError {
  return new WriteMetadataError("Invalid argument: Invalid priority", "retry write with a supported priority", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "priority", value: priority },
    expected: { kind: "allowed_values", allowed_values: [...RECORD_PRIORITIES] },
    argument_sources: { priority: WRITE_PRIORITY_ARGUMENT_SOURCE },
    retry_with: { argument: "priority", value_placeholder: "normal" }
  });
}

function invalidWriteConfirmedError(confirmed: unknown): WriteMetadataError {
  return new WriteMetadataError("Invalid argument: Invalid confirmed", "retry write with a boolean confirmed value", {
    operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
    rejected_argument: { argument: "confirmed", value: confirmed },
    expected: { kind: "boolean" },
    argument_sources: { confirmed: WRITE_CONFIRMED_ARGUMENT_SOURCE },
    retry_with: { argument: "confirmed", value_placeholder: true }
  });
}

type WriteProvenanceRecoveryHint =
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance"; value: unknown };
      expected: { kind: "object"; required: false };
      argument_sources: { provenance: typeof WRITE_PROVENANCE_ARGUMENT_SOURCE };
      retry_with: {
        argument: "provenance";
        value_placeholder: { derived_from: ["<record_id>"]; reason: "<reason>" };
      };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.derived_from"; value: unknown };
      expected: { kind: "array_of_non_empty_strings" };
      argument_sources: {
        "provenance.derived_from": typeof WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE;
      };
      retry_with: { argument: "provenance.derived_from"; value_placeholder: ["<record_id>"] };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.reason"; value: unknown };
      expected: { kind: "non_empty_string"; min_length: 1 };
      argument_sources: { "provenance.reason": typeof WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE };
      retry_with: { argument: "provenance.reason"; value_placeholder: "<reason>" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.method"; value: unknown };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      argument_sources: { "provenance.method": typeof WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE };
      retry_with: { argument: "provenance.method"; value_placeholder: "agent-proposed" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: "provenance.promoted_at"; value: unknown };
      expected: { kind: "iso_datetime"; format: "RFC3339 timestamp with timezone" };
      argument_sources: {
        "provenance.promoted_at": typeof WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE;
      };
      retry_with: { argument: "provenance.promoted_at"; value_placeholder: "<ISO datetime>" };
    }
  | {
      operation_contract: typeof WRITE_OPERATION_CONTRACT_SOURCE;
      rejected_argument: { argument: `provenance.${string}`; value: unknown };
      expected: { kind: "known_object_field"; allowed_fields: WriteProvenanceField[] };
      argument_sources: Partial<Record<WriteProvenanceArgument, WriteProvenanceArgumentSource>>;
      retry_with: { argument: WriteProvenanceArgument; value_placeholder: unknown };
      do_not: ["send_unknown_provenance_fields", "retry_with_same_unknown_field"];
    };

class WriteProvenanceError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: WriteProvenanceRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: WriteProvenanceRecoveryHint) {
    super(message);
    this.name = "WriteProvenanceError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidWriteProvenanceError(provenance: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance",
    "retry write with a valid provenance object",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance", value: provenance },
      expected: { kind: "object", required: false },
      argument_sources: { provenance: WRITE_PROVENANCE_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance", value_placeholder: { derived_from: ["<record_id>"], reason: "<reason>" } }
    }
  );
}

function invalidWriteProvenanceDerivedFromError(derivedFrom: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.derived_from",
    "retry write with valid provenance source record ids",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.derived_from", value: derivedFrom },
      expected: { kind: "array_of_non_empty_strings" },
      argument_sources: { "provenance.derived_from": WRITE_PROVENANCE_DERIVED_FROM_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.derived_from", value_placeholder: ["<record_id>"] }
    }
  );
}

function invalidWriteProvenanceReasonError(reason: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.reason",
    "retry write with a non-empty provenance reason",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.reason", value: reason },
      expected: { kind: "non_empty_string", min_length: 1 },
      argument_sources: { "provenance.reason": WRITE_PROVENANCE_REASON_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.reason", value_placeholder: "<reason>" }
    }
  );
}

function invalidWriteProvenanceMethodError(method: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.method",
    "retry write with a supported provenance method",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.method", value: method },
      expected: { kind: "allowed_values", allowed_values: [...PROVENANCE_METHODS] },
      argument_sources: { "provenance.method": WRITE_PROVENANCE_METHOD_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.method", value_placeholder: "agent-proposed" }
    }
  );
}

function invalidWriteProvenancePromotedAtError(promotedAt: unknown): WriteProvenanceError {
  return new WriteProvenanceError(
    "Invalid argument: Invalid provenance.promoted_at",
    "retry write with a valid provenance timestamp",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: "provenance.promoted_at", value: promotedAt },
      expected: { kind: "iso_datetime", format: "RFC3339 timestamp with timezone" },
      argument_sources: { "provenance.promoted_at": WRITE_PROVENANCE_PROMOTED_AT_ARGUMENT_SOURCE },
      retry_with: { argument: "provenance.promoted_at", value_placeholder: "<ISO datetime>" }
    }
  );
}

function invalidWriteProvenanceUnknownFieldError(
  provenance: Record<string, unknown>,
  field: string
): WriteProvenanceError {
  const retryField = closestWriteProvenanceField(field);
  const metadata = WRITE_PROVENANCE_FIELDS[retryField];
  return new WriteProvenanceError(
    `Invalid argument: Unknown provenance.${field}`,
    "retry write with supported provenance fields",
    {
      operation_contract: WRITE_OPERATION_CONTRACT_SOURCE,
      rejected_argument: { argument: `provenance.${field}`, value: provenance[field] },
      expected: {
        kind: "known_object_field",
        allowed_fields: Object.keys(WRITE_PROVENANCE_FIELDS) as WriteProvenanceField[]
      },
      argument_sources: { [metadata.argument]: metadata.source },
      retry_with: { argument: metadata.argument, value_placeholder: metadata.placeholder },
      do_not: ["send_unknown_provenance_fields", "retry_with_same_unknown_field"]
    }
  );
}

function closestWriteProvenanceField(field: string): WriteProvenanceField {
  const normalized = normalizeWriteProvenanceFieldName(field);
  return (
    (Object.keys(WRITE_PROVENANCE_FIELDS) as WriteProvenanceField[]).sort((left, right) => {
      const leftScore = writeProvenanceFieldSuggestionScore(normalized, normalizeWriteProvenanceFieldName(left));
      const rightScore = writeProvenanceFieldSuggestionScore(normalized, normalizeWriteProvenanceFieldName(right));
      return rightScore - leftScore || left.localeCompare(right);
    })[0] ?? "derived_from"
  );
}

function normalizeWriteProvenanceFieldName(field: string): string {
  return field.replace(/[._-]/g, "").toLowerCase();
}

function writeProvenanceFieldSuggestionScore(unknownField: string, knownField: string): number {
  if (unknownField === knownField) return Number.MAX_SAFE_INTEGER;
  const longest = Math.max(unknownField.length, knownField.length);
  if (longest === 0) return 0;
  return longestCommonSubsequenceLength(unknownField, knownField) / longest;
}

function validateWriteInput(input: WriteInput): void {
  assertPlainObject(input, "write input");
  if (!recordKindSchema.safeParse(input.kind).success) throw invalidWriteKindError(input.kind);
  if (typeof input.type !== "string" || !input.type.length) throw invalidWriteTypeError(input.type);
  if (!recordScopeSchema.safeParse(input.scope).success) throw invalidWriteScopeError(input.scope);
  if (input.project_id !== undefined && (typeof input.project_id !== "string" || !input.project_id.length)) {
    throw invalidWriteProjectIdError(input.project_id);
  }
  if (input.scope === "project" && input.project_id === undefined) {
    throw new Error("Invalid argument: project_id is required for project scope");
  }
  if (
    input.tags !== undefined &&
    (!Array.isArray(input.tags) || !input.tags.every((tag) => typeof tag === "string" && tag.length > 0))
  ) {
    throw new WriteTagsError(input.tags);
  }
  if (typeof input.content !== "object" || input.content === null || Array.isArray(input.content)) {
    throw invalidWriteContentError(input.content, "content_object");
  }
  const content = input.content as Record<string, unknown> & { text?: unknown; format?: unknown };
  if (Object.keys(content).length === 0) {
    throw invalidWriteContentError(content, "non_empty_content_object");
  }
  if (content.text !== undefined && (typeof content.text !== "string" || !content.text.length)) {
    throw invalidWriteContentTextError(content.text);
  }
  if (content.format !== undefined && content.format !== "text" && content.format !== "json") {
    throw invalidWriteContentFormatError(content.format);
  }
  if (input.state !== undefined && !recordStateSchema.safeParse(input.state).success)
    throw invalidWriteStateError(input.state);
  if (
    input.confidence !== undefined &&
    (typeof input.confidence !== "number" ||
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1)
  ) {
    throw invalidWriteConfidenceError(input.confidence);
  }
  if (input.priority !== undefined && !recordPrioritySchema.safeParse(input.priority).success)
    throw invalidWritePriorityError(input.priority);
  if (typeof input.source === "object" && input.source !== null && !Array.isArray(input.source)) {
    const sourceRecord = input.source as unknown as Record<string, unknown>;
    const unknownField = Object.keys(sourceRecord).find((field) => !(field in SOURCE_IDENTITY_FIELDS));
    if (unknownField !== undefined) {
      throw new WriteUnknownSourceFieldError(sourceRecord, unknownField);
    }
  }
  try {
    validateOptionalSource(input.source);
  } catch (error) {
    if (error instanceof MutationArgumentError) {
      if (
        error.recovery_hint.expected.kind === "known_object_field" &&
        typeof input.source === "object" &&
        input.source !== null &&
        !Array.isArray(input.source)
      ) {
        const field = error.recovery_hint.rejected_argument.argument.slice("source.".length);
        throw new WriteUnknownSourceFieldError(input.source as unknown as Record<string, unknown>, field);
      }
      const argument = error.recovery_hint.rejected_argument.argument;
      const field = argument.slice("source.".length) as SourceIdentityField;
      throw new WriteSourceError(input.source, field);
    }
    throw error;
  }
  if (input.confirmed !== undefined && typeof input.confirmed !== "boolean")
    throw invalidWriteConfirmedError(input.confirmed);
  if (input.provenance !== undefined) {
    if (typeof input.provenance !== "object" || input.provenance === null || Array.isArray(input.provenance)) {
      throw invalidWriteProvenanceError(input.provenance);
    }
    const provenance = input.provenance as Partial<RecordProvenance>;
    const provenanceRecord = input.provenance as Record<string, unknown>;
    const unknownField = Object.keys(provenanceRecord).find((field) => !(field in WRITE_PROVENANCE_FIELDS));
    if (unknownField !== undefined) {
      throw invalidWriteProvenanceUnknownFieldError(provenanceRecord, unknownField);
    }
    if (
      provenance.derived_from !== undefined &&
      (!Array.isArray(provenance.derived_from) ||
        !provenance.derived_from.every((recordId) => typeof recordId === "string" && recordId.length > 0))
    ) {
      throw invalidWriteProvenanceDerivedFromError(provenance.derived_from);
    }
    if (provenance.reason !== undefined && (typeof provenance.reason !== "string" || !provenance.reason.length)) {
      throw invalidWriteProvenanceReasonError(provenance.reason);
    }
    if (
      provenance.method !== undefined &&
      provenance.method !== "agent-proposed" &&
      provenance.method !== "rule-promoted" &&
      provenance.method !== "user-confirmed"
    ) {
      throw invalidWriteProvenanceMethodError(provenance.method);
    }
    if (provenance.promoted_at !== undefined && !isoDateTimeSchema.safeParse(provenance.promoted_at).success) {
      throw invalidWriteProvenancePromotedAtError(provenance.promoted_at);
    }
  }
  validateIdempotencyKey(input.idempotency_key, "write");
}

function validateRevisionInput(input: RevisionInput): void {
  assertPlainObject(input, "revise input");
  validateRecordId("revise", input.record_id);
  if (typeof input.patch !== "object" || input.patch === null || Array.isArray(input.patch)) {
    throw invalidRevisionPatchShapeError(input.patch, "patch_object");
  }
  const patch = input.patch as Record<string, unknown>;
  if (Object.keys(patch).length === 0) {
    throw emptyRevisionPatchError(patch);
  }
  const invalidPath = Object.keys(patch).find((path) => !isValidPatchPath(path));
  if (invalidPath !== undefined) {
    throw invalidRevisionPatchPathError(invalidPath, patch[invalidPath]);
  }
  validateOptionalReason("revise", input.reason);
  validateOptionalSource(input.source, "revise", "retry mutation with a valid source client");
  validateOptionalConfirmed("revise", input.confirmed);
  validateIdempotencyKey(input.idempotency_key, "revise");
}

function validatePromoteInput(input: PromoteInput): void {
  assertPlainObject(input, "promote input");
  validateRecordId("promote", input.record_id);
  if (!recordStateSchema.safeParse(input.target_state).success) {
    throw invalidMutationTargetStateError("promote", input.target_state);
  }
  validateOptionalReason("promote", input.reason);
  validateOptionalSource(input.source, "promote", "retry mutation with a valid source client");
  validateOptionalConfirmed("promote", input.confirmed);
  validateIdempotencyKey(input.idempotency_key, "promote");
}

function validateStateChangeInput(input: StateChangeInput, name: string, operation: "archive" | "quarantine"): void {
  assertPlainObject(input, name);
  validateRecordId(operation, input.record_id);
  validateOptionalReason(operation, input.reason);
  validateOptionalSource(input.source, operation, "retry mutation with a valid source client");
  validateIdempotencyKey(input.idempotency_key, operation);
}

function validateLinkInput(input: LinkInput): void {
  assertPlainObject(input, "link input");
  validateRecordId("link", input.record_id);
  validateRecordId("link", input.linked_record_id, "linked_record_id");
  if (typeof input.link_type !== "string" || !input.link_type.length) {
    throw invalidMutationStringError("link", "link_type", input.link_type);
  }
  validateOptionalSource(input.source, "link", "retry mutation with a valid source client");
  validateIdempotencyKey(input.idempotency_key, "link");
}

function validateRecallInput(input: RecallInput): void {
  assertPlainObject(input, "recall input");
  validateOptionalStringArray("recall", input.record_ids, "record_ids");
  validateOptionalString("recall", input.query, "query");
  validateOptionalString("recall", input.project_id, "project_id");
  validateOptionalEnumArray<RecordKind>("recall", input.kinds, "kinds", recordKindSchema, RECORD_KINDS, "memory");
  validateOptionalEnumArray<RecordScope>("recall", input.scopes, "scopes", recordScopeSchema, RECORD_SCOPES, "project");
  validateOptionalStringArray("recall", input.types, "types");
  validateOptionalEnumArray<RecordState>(
    "recall",
    input.states,
    "states",
    recordStateSchema,
    RECORD_STATES,
    "canonical"
  );
  validateOptionalStringArray("recall", input.tags, "tags");
  validateOptionalStringArray("recall", input.files, "files");
  validateOptionalBoolean("recall", input.include_private, "include_private");
}

function validateRecordFeedbackInput(input: RecordFeedbackInput): asserts input is ValidatedRecordFeedbackInput {
  assertPlainObject(input, "memory feedback input");
  validateRecordId("memory_feedback", input.record_id);
  if (!RECORD_FEEDBACK_OUTCOMES.includes(input.outcome as RecordFeedbackOutcome)) {
    throw new Error(`Invalid argument: memory feedback outcome must use ${RECORD_FEEDBACK_OUTCOMES.join(", ")}`);
  }
  if (input.occurred_at !== undefined && !isoDateTimeSchema.safeParse(input.occurred_at).success) {
    throw new Error("Invalid argument: memory feedback occurred_at must be an ISO timestamp");
  }
  validateOptionalSource(input.source, "memory_feedback", "retry memory_feedback with a valid source client");
  validateIdempotencyKey(input.idempotency_key, "memory_feedback");
  if (input.idempotency_key === undefined) {
    throw new Error("Invalid argument: memory feedback requires idempotency_key");
  }
}

function validateBootInput(input: BootInput): void {
  assertPlainObject(input, "boot input");
  validateOptionalString("boot", input.project_id, "project_id");
  validateOptionalString("boot", input.agent_session_id, "agent_session_id");
  validateOptionalString("boot", input.user_profile_id, "user_profile_id");
  validateOptionalString("boot", input.agent_profile_id, "agent_profile_id");
  for (const [argument, value] of [
    ["soul_char_budget", input.soul_char_budget],
    ["soul_token_budget", input.soul_token_budget]
  ] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1)) {
      throw new Error(`Invalid argument: ${argument} must be a positive integer`);
    }
  }
  validateOptionalStringArray("boot", input.default_skills, "default_skills");
  validateOptionalString("boot", input.current_task, "current_task");
  validateOptionalString("boot", input.sync_remote, "sync_remote");
  validateOptionalBoolean("boot", input.include_private, "include_private");
}

function validateRefreshInput(input: RefreshInput): void {
  assertPlainObject(input, "refresh input");
  validateOptionalString("refresh", input.project_id, "project_id");
  validateOptionalString("refresh", input.cursor, "cursor");
  const cursor = input.cursor;
  if (typeof cursor === "string") parseRefreshCursor(cursor);
  validateOptionalString("refresh", input.current_task, "current_task");
  validateOptionalBoolean("refresh", input.include_private, "include_private");
}

function validateTimelineInput(input: TimelineInput): void {
  assertPlainObject(input, "timeline input");
  validateOptionalString("timeline", input.record_id, "record_id");
  validateOptionalString("timeline", input.event_id, "event_id");
  validateOptionalString("timeline", input.query, "query");
  validateOptionalString("timeline", input.project_id, "project_id");
  const anchorCount = [input.record_id, input.event_id, input.query].filter((value) => value !== undefined).length;
  if (anchorCount !== 1) {
    throw invalidReadAnchorError(input);
  }
  validateOptionalBoolean("timeline", input.include_private, "include_private");
}

function validateListRecentInput(input: ListRecentInput): void {
  assertPlainObject(input, "list_recent input");
  validateOptionalString("list_recent", input.project_id, "project_id");
  validateOptionalBoolean("list_recent", input.all_projects, "all_projects");
  validateOptionalBoolean("list_recent", input.include_private, "include_private");
  if (input.project_id !== undefined && input.all_projects === true) {
    throw new Error("Invalid argument: list_recent project_id cannot be combined with all_projects=true");
  }
}

function validateListProjectsInput(input: ListProjectsInput): void {
  assertPlainObject(input, "list projects input");
  validateOptionalString("project_list", input.current_task, "current_task");
  validateOptionalString("project_list", input.sync_remote, "sync_remote");
  validateProjectListAgent(input.agent);
}

function validateMemoryDoctorInput(input: MemoryDoctorInput): void {
  assertPlainObject(input, "memory doctor input");
  validateOptionalString("memory_doctor", input.project_id, "project_id");
  validateOptionalBoolean("memory_doctor", input.include_private, "include_private");
}

function validateMemoryMaintenanceShadowInput(
  input: MemoryMaintenanceShadowInput
): ValidatedMemoryMaintenanceShadowInput {
  assertPlainObject(input, "memory maintenance shadow input");
  validateOptionalString("memory_maintenance_shadow", input.project_id, "project_id");
  validateOptionalBoolean("memory_maintenance_shadow", input.include_private, "include_private");
  return {
    ...input,
    candidate_limit: validateLimit(
      input.candidate_limit,
      DEFAULT_SEMANTIC_SHADOW_CANDIDATE_LIMIT,
      "memory_maintenance_shadow"
    ),
    minimum_token_overlap: validateReadNumberRange(
      input.minimum_token_overlap,
      DEFAULT_SEMANTIC_SHADOW_MINIMUM_TOKEN_OVERLAP,
      "memory_maintenance_shadow",
      "minimum_token_overlap",
      0,
      1,
      false
    ) as number,
    include_private: input.include_private === true
  };
}

function validateMemoryLifecycleInput(input: MemoryLifecycleInput): void {
  assertPlainObject(input, "memory lifecycle input");
  validateOptionalString("memory_lifecycle", input.project_id, "project_id");
  validateOptionalString("memory_lifecycle", input.now, "now");
  if (typeof input.now === "string" && !isoDateTimeSchema.safeParse(input.now).success) {
    throw invalidReadStringError("memory_lifecycle", "now", input.now);
  }
  validateOptionalBoolean("memory_lifecycle", input.include_private, "include_private");
}

function normalizeSessionFoldIdentity(
  input: SessionFoldIdentity,
  operation: "plan_session_fold" | "preview_session_fold"
): SessionFoldIdentity {
  assertPlainObject(input, `${operation} input`);
  if (typeof input.project_id !== "string" || !input.project_id.trim()) {
    throw new Error("Invalid argument: project_id must be a non-empty string");
  }
  if (typeof input.session_id !== "string" || !input.session_id.trim()) {
    throw new Error("Invalid argument: session_id must be a non-empty string");
  }
  return { project_id: input.project_id.trim(), session_id: input.session_id.trim() };
}

function validateSessionFoldPreviewInput(
  input: SessionFoldPreviewInput
): SessionFoldIdentity & { include_private: boolean } {
  const identity = normalizeSessionFoldIdentity(input, "preview_session_fold");
  if (
    input.proposed_final_text !== undefined &&
    (typeof input.proposed_final_text !== "string" || !input.proposed_final_text.trim())
  ) {
    throw new Error("Invalid argument: proposed_final_text must be a non-empty string");
  }
  if (input.include_private !== undefined && typeof input.include_private !== "boolean") {
    throw new Error("Invalid argument: include_private must be a boolean");
  }
  return { ...identity, include_private: input.include_private === true };
}

function normalizeSessionFoldPlanInput(
  input: SessionFoldPlanInput
): SessionFoldIdentity & { include_private: boolean } {
  const identity = normalizeSessionFoldIdentity(input, "plan_session_fold");
  if (input.include_private !== undefined && typeof input.include_private !== "boolean") {
    throw new Error("Invalid argument: include_private must be a boolean");
  }
  return { ...identity, include_private: input.include_private === true };
}

function sessionFoldBoundaryRecords(records: readonly MorynRecord[], identity: SessionFoldIdentity): MorynRecord[] {
  return records.filter(
    (record) =>
      record.project_id === identity.project_id &&
      record.source.session_id === identity.session_id &&
      record.kind === "session_summary" &&
      ["status", "checkpoint", "summary"].includes(record.type) &&
      record.visibility !== "archived" &&
      record.state !== "archived"
  );
}

function recordsForSessionFoldRead(
  records: readonly MorynRecord[],
  identity: SessionFoldIdentity,
  includePrivate: boolean
): MorynRecord[] {
  const scoped = sessionFoldBoundaryRecords(records, identity);
  const omittedPrivateCount = scoped.filter(isPrivateMemoryBoundary).length;
  if (!includePrivate && omittedPrivateCount > 0) {
    throw new Error(
      `Private Session Fold sources require explicit include_private: true (${omittedPrivateCount} source${omittedPrivateCount === 1 ? "" : "s"} omitted)`
    );
  }
  return includePrivate ? [...records] : records.filter((record) => !isPrivateMemoryBoundary(record));
}

function validateCapturePolicyInput(input: CapturePolicyInput): void {
  assertPlainObject(input, "capture policy input");
  validateOptionalString("capture_policy", input.project_id, "project_id");
  validateOptionalBoolean("capture_policy", input.include_private, "include_private");
}

function validateDogfoodReportInput(input: DogfoodReportInput): void {
  assertPlainObject(input, "dogfood report input");
  validateOptionalString("dogfood_report", input.project_id, "project_id");
  validateOptionalBoolean("dogfood_report", input.include_private, "include_private");
}

function validateHealthCheckInput(input: HealthCheckInput): void {
  assertPlainObject(input, "health check input");
  validateOptionalString("health_check", input.project_id, "project_id");
  validateOptionalString("health_check", input.project_path, "project_path");
  validateOptionalString("health_check", input.host, "host");
  validateOptionalString("health_check", input.sync_remote, "sync_remote");
  validateOptionalBoolean("health_check", input.include_private, "include_private");
}

function validateRecallEvalInput(input: RecallEvalInput): void {
  assertPlainObject(input, "recall eval input");
  validateOptionalString("recall_eval", input.project_id, "project_id");
  validateOptionalBoolean("recall_eval", input.include_private, "include_private");
}

function validateProjectMigrateInput(input: ProjectMigrateInput): void {
  assertPlainObject(input, "project migrate input");
  if (typeof input.from_project_id !== "string" || !input.from_project_id.length) {
    throw new Error("Invalid argument: Invalid from_project_id");
  }
  if (typeof input.to_project_id !== "string" || !input.to_project_id.length) {
    throw new Error("Invalid argument: Invalid to_project_id");
  }
  if (input.from_project_id === input.to_project_id) {
    throw new Error("Invalid argument: from_project_id and to_project_id must differ");
  }
  if (input.dry_run !== undefined && typeof input.dry_run !== "boolean") {
    throw new Error("Invalid argument: Invalid dry_run");
  }
  if (input.confirmed !== undefined && typeof input.confirmed !== "boolean") {
    throw new Error("Invalid argument: Invalid confirmed");
  }
  if (input.include_private !== undefined && typeof input.include_private !== "boolean") {
    throw new Error("Invalid argument: Invalid include_private");
  }
  validateOptionalSource(input.source, undefined, "retry project_migrate with a valid source client");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appendCommandOption(parts: string[], name: string, value: string | undefined): void {
  if (value === undefined) return;
  parts.push(name, shellQuote(value));
}

function projectStartArguments(
  projectId: string,
  input: ValidatedListProjectsInput
): {
  project_id: string;
  sync_remote?: string;
  current_task?: string;
  agent?: ProjectListAgent;
} {
  return {
    project_id: projectId,
    sync_remote: input.sync_remote,
    current_task: input.current_task,
    agent: input.agent
  };
}

function projectStartCommand(projectId: string, input: ValidatedListProjectsInput): string {
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

function recallRecordCommand(recordId: string, projectId: string | undefined, includePrivate?: boolean): string {
  const parts = ["moryn", "recall"];
  appendCommandOption(parts, "--record-id", recordId);
  appendCommandOption(parts, "--project-id", projectId);
  if (includePrivate === true) parts.push("--include-private");
  return parts.join(" ");
}

function refreshChangeNextAction(record: MorynRecord, input: RefreshInput) {
  return withRefreshChangeNextActionMetadata({
    recommended_action: "call_recall_with_record_id",
    tool: "recall",
    safe_to_run: true,
    required_when: RECALL_REFRESH_CHANGE_WHEN,
    required_fields: [],
    command: recallRecordCommand(record.id, input.project_id, input.include_private === true),
    arguments: {
      record_ids: [record.id],
      ...(input.project_id ? { project_id: input.project_id } : {}),
      ...(input.include_private === true ? { include_private: true } : {})
    },
    argument_sources: {
      record_ids: "refresh.changes_by_record_id.<record_id>.record_id"
    }
  });
}

function timelineItemNextAction(recordId: string, input: TimelineInput) {
  return withTimelineItemNextActionMetadata({
    recommended_action: "call_recall_with_record_id",
    tool: "recall",
    safe_to_run: true,
    required_when: "After timeline reports this item and the agent needs the full record content.",
    required_fields: [],
    command: recallRecordCommand(recordId, input.project_id, input.include_private === true),
    arguments: {
      record_ids: [recordId],
      ...(input.project_id ? { project_id: input.project_id } : {}),
      ...(input.include_private === true ? { include_private: true } : {})
    },
    argument_sources: {
      record_ids: "timeline.items_by_event_id.<event_id>.record_id"
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

function recordProjectMatchesRecall(record: MorynRecord, input: ValidatedRecallInput): boolean {
  return Boolean(input.record_ids?.length) || recordProjectMatches(record, input.project_id);
}

function isVisibleByDefault(record: MorynRecord): boolean {
  return record.state !== "archived" && record.state !== "quarantined";
}

function isPrivateRecord(record: MorynRecord): boolean {
  return isPrivateMemoryBoundary(record);
}

function isAllowedByPrivateBoundary(record: MorynRecord, includePrivate: boolean | undefined): boolean {
  return includePrivate === true || !isPrivateRecord(record);
}

function isManagedSoulProfileRecord(record: MorynRecord): boolean {
  return record.kind === "soul" && record.type === SOUL_PROFILE_RECORD_TYPE;
}

function defaultMemoryWorkingSet(records: readonly MorynRecord[]) {
  const selection = selectMemoryWorkingSet(records, DEFAULT_MEMORY_WORKING_SET_OPTIONS);
  return {
    records: selection.selected.map((entry) => entry.record),
    report: {
      version: 1 as const,
      policy_id: "default_active_memory_v04" as const,
      counts: selection.counts,
      tokens: selection.tokens
    }
  };
}

function boundedRetrievalEvidence(
  retrieval: RetrievalCandidateReadResult,
  records: readonly MorynRecord[],
  workingSet: ReturnType<typeof defaultMemoryWorkingSet>["report"]
) {
  const { records: _candidateRecords, ...evidence } = retrieval;
  void _candidateRecords;
  return {
    ...evidence,
    unbounded_candidate_count: retrieval.candidate_count,
    candidate_count: records.length,
    working_set: workingSet
  };
}

function isTrustedForBoot(record: MorynRecord): boolean {
  return record.state === "canonical";
}

function includesHiddenState(input: ValidatedRecallInput): boolean {
  return input.states?.some((state) => state === "archived" || state === "quarantined") ?? false;
}

function includesRawState(input: ValidatedRecallInput): boolean {
  return input.states?.includes("raw") ?? false;
}

function isVisibleInDefaultRecall(record: MorynRecord): boolean {
  return isVisibleByDefault(record) && record.state !== "raw" && !isLearningInboxRecord(record);
}

function skillMatchesSelector(record: MorynRecord, selector: string): boolean {
  const normalized = selector.toLowerCase();
  return (
    record.id === selector ||
    record.type.toLowerCase() === normalized ||
    record.tags.some((tag) => tag.toLowerCase() === normalized) ||
    String(record.content.name ?? "").toLowerCase() === normalized ||
    searchableText(record).toLowerCase().includes(normalized)
  );
}

function isProjectSkill(record: MorynRecord, projectId: string | undefined): boolean {
  return (
    record.kind === "skill" &&
    Boolean(projectId) &&
    (record.project_id === projectId || record.tags.includes(projectId as string))
  );
}

function bootSkills(records: MorynRecord[], input: ValidatedBootInput): MorynRecord[] {
  const selectors = input.default_skills ?? [];
  const selected = records.filter(
    (record) =>
      record.kind === "skill" &&
      (isProjectSkill(record, input.project_id) || selectors.some((selector) => skillMatchesSelector(record, selector)))
  );
  return [...new Map(selected.map((record) => [record.id, record])).values()];
}

function projectMemory(records: MorynRecord[], projectId: string | undefined): MorynRecord[] {
  return records.filter(
    (record) => record.kind === "memory" && record.scope === "project" && record.project_id === projectId
  );
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
  return (
    (record.kind === "memory" || record.kind === "skill") &&
    (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75))
  );
}

function bootPriorityScore(record: MorynRecord): number {
  return (record.priority === "high" ? 100 : 0) + recallSourceTrust(record).score;
}

function boundedBootRecords(records: MorynRecord[], limit = 5): MorynRecord[] {
  return [...records]
    .sort(
      (a, b) =>
        bootPriorityScore(b) - bootPriorityScore(a) ||
        b.updated_at.localeCompare(a.updated_at) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, limit);
}

function recordsById(records: MorynRecord[]): Record<string, MorynRecord> {
  return Object.fromEntries(records.map((record) => [record.id, record]));
}

function recallTypePriority(type: string): { score: number; reason: string } | undefined {
  const normalized = type.toLowerCase();
  if (normalized === "session_rollup" || normalized === "episode_rollup")
    return { score: 2, reason: `type_priority:${normalized}` };
  if (normalized === "blocker" || normalized === "warning" || normalized === "conflict")
    return { score: 4, reason: `type_priority:${normalized}` };
  if (normalized === "decision") return { score: 3, reason: "type_priority:decision" };
  if (normalized === "preference") return { score: 2, reason: "type_priority:preference" };
  if (normalized === "summary" || normalized === "project_summary")
    return { score: 1, reason: "type_priority:summary" };
  return undefined;
}

function recallRollupType(type: string): "session_rollup" | "episode_rollup" | undefined {
  const normalized = type.toLowerCase();
  return normalized === "session_rollup" || normalized === "episode_rollup" ? normalized : undefined;
}

function recallSourceTrust(record: MorynRecord): { score: number; reason: string } {
  const method = record.provenance?.method ?? provenanceMethod(record.source);
  if (method === "user-confirmed") return { score: 3, reason: "source_trust:user-confirmed" };
  if (method === "rule-promoted") return { score: 2, reason: "source_trust:rule-promoted" };
  return { score: 1, reason: "source_trust:agent-proposed" };
}

type ValidatedRecallInput = RecallInput & {
  record_ids?: string[];
  query?: string;
  kinds?: RecordKind[];
  scopes?: RecordScope[];
  types?: string[];
  states?: RecordState[];
  tags?: string[];
  files?: string[];
  include_private?: boolean;
};

function reasonAndScore(record: MorynRecord, input: ValidatedRecallInput): { score: number; reason: string[] } {
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
    const match = queryRecordMatch(input.query, record);
    const scoredTokens = match.matched_tokens.slice(0, 16);
    score += scoredTokens.length * 3;
    reason.push(...scoredTokens.map((token) => `text_match:${token}`));
    if (match.reliable_match_anchor) reason.push("text_anchor");
  }
  return { score, reason: [...new Set(reason)] };
}

function matchesQuery(result: { reason: string[] }, input: ValidatedRecallInput): boolean {
  if (!input.query || input.record_ids?.length) return true;
  return result.reason.includes("text_anchor");
}

function sameRecallManifest(
  left: { count: number; digest: string },
  right: { count: number; digest: string }
): boolean {
  return left.count === right.count && left.digest === right.digest;
}

function shouldRecoverHistoricalRecall(outcome: ReturnType<typeof assessRecallOutcome> | undefined): boolean {
  return Boolean(
    outcome?.status === "knowledge_gap" || (outcome?.status === "verification_required" && outcome.coverage < 0.75)
  );
}

function activeRecallSelection(input: {
  recall: ValidatedRecallInput;
  available_records: MorynRecord[];
  retrieval?: RetrievalCandidateReadResult;
  limit: number;
  now: string;
}) {
  const eligibleRecords = input.available_records
    .filter(
      (record) =>
        includesHiddenState(input.recall) || includesRawState(input.recall) || isVisibleInDefaultRecall(record)
    )
    .filter((record) => isAllowedByPrivateBoundary(record, input.recall.include_private))
    .filter((record) => recordProjectMatchesRecall(record, input.recall))
    .filter(
      (record) =>
        !isManagedSoulProfileRecord(record) ||
        input.recall.record_ids?.includes(record.id) ||
        input.recall.types?.includes(SOUL_PROFILE_RECORD_TYPE)
    );
  const bounded =
    !input.recall.record_ids?.length && !includesHiddenState(input.recall)
      ? defaultMemoryWorkingSet(eligibleRecords)
      : undefined;
  const logicalRecords = bounded?.records ?? eligibleRecords;
  const retrievalEvidence = input.retrieval
    ? boundedRetrievalEvidence(
        input.retrieval,
        logicalRecords,
        bounded?.report ?? defaultMemoryWorkingSet(logicalRecords).report
      )
    : undefined;
  const rankedRecords = logicalRecords
    .filter((record) => !input.recall.record_ids?.length || input.recall.record_ids.includes(record.id))
    .filter((record) => !input.recall.kinds?.length || input.recall.kinds.includes(record.kind))
    .filter((record) => !input.recall.scopes?.length || input.recall.scopes.includes(record.scope))
    .filter((record) => !input.recall.types?.length || input.recall.types.includes(record.type))
    .filter((record) => !input.recall.states?.length || input.recall.states.includes(record.state))
    .filter((record) => matchesAny(record.tags, input.recall.tags))
    .filter(
      (record) =>
        !input.recall.files?.length ||
        input.recall.files.some((file) =>
          `${searchableText(record)} ${record.tags.join(" ")}`.toLowerCase().includes(file.toLowerCase())
        )
    )
    .map((record) => {
      const result = { record, ...reasonAndScore(record, input.recall) };
      return recallRollupType(record.type)
        ? {
            ...result,
            next_action: buildRecallMemoryExpandAction(record.id, input.recall.include_private)
          }
        : result;
    })
    .filter((result) => matchesQuery(result, input.recall))
    .filter((result) => result.score > 0 || (!input.recall.query && !input.recall.record_ids?.length))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.record.updated_at.localeCompare(left.record.updated_at) ||
        left.record.id.localeCompare(right.record.id)
    )
    .slice(0, input.limit);
  const outcome = input.recall.query
    ? assessRecallOutcome({ query: input.recall.query, results: rankedRecords, now: input.now })
    : undefined;
  return { bounded, logicalRecords, outcome, rankedRecords, retrievalEvidence };
}

function recordIdFromEvent(event: MorynEvent): string {
  return event.op === "upsert_record" ? event.record.id : event.record_id;
}

function eventProjectMatches(
  event: MorynEvent,
  records: Map<string, MorynRecord>,
  projectId: string | undefined
): boolean {
  if (!projectId) return true;
  const record = event.op === "upsert_record" ? event.record : records.get(event.record_id);
  if (!record) return true;
  return recordProjectMatches(record, projectId);
}

function eventAllowedByPrivateBoundary(
  event: MorynEvent,
  records: Map<string, MorynRecord>,
  includePrivate: boolean | undefined
): boolean {
  const record = event.op === "upsert_record" ? event.record : records.get(event.record_id);
  return !record || isAllowedByPrivateBoundary(record, includePrivate);
}

function sortedTimelineEvents(
  events: MorynEvent[],
  records: Map<string, MorynRecord>,
  input: ValidatedTimelineInput
): MorynEvent[] {
  return events
    .filter((event) => eventProjectMatches(event, records, input.project_id))
    .filter((event) => eventAllowedByPrivateBoundary(event, records, input.include_private))
    .sort(
      (left, right) => left.created_at.localeCompare(right.created_at) || left.event_id.localeCompare(right.event_id)
    );
}

function latestEventIndexForRecord(events: MorynEvent[], recordId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (recordIdFromEvent(events[index]!) === recordId) return index;
  }
  return -1;
}

function timelineQueryAnchor(
  records: MorynRecord[],
  events: MorynEvent[],
  input: ValidatedTimelineInput
): { index: number; record_id: string } | undefined {
  if (!input.query) return undefined;
  const recallInput = { query: input.query, project_id: input.project_id } as ValidatedRecallInput;
  const match = records
    .filter(isVisibleInDefaultRecall)
    .filter((record) => isAllowedByPrivateBoundary(record, input.include_private))
    .filter((record) => recordProjectMatches(record, input.project_id))
    .map((record) => ({ record, ...reasonAndScore(record, recallInput) }))
    .filter((result) => matchesQuery(result, recallInput))
    .filter((result) => result.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.record.updated_at.localeCompare(a.record.updated_at) ||
        a.record.id.localeCompare(b.record.id)
    )[0];
  if (!match) return undefined;
  const index = latestEventIndexForRecord(events, match.record.id);
  return index >= 0 ? { index, record_id: match.record.id } : undefined;
}

function timelineAnchor(
  events: MorynEvent[],
  records: MorynRecord[],
  input: ValidatedTimelineInput
): {
  index: number;
  source: TimelineAnchorSource;
  event_id: string;
  record_id: string;
} {
  if (input.event_id) {
    const index = events.findIndex((event) => event.event_id === input.event_id);
    if (index < 0) throw new Error(`Event not found: ${input.event_id}`);
    const event = events[index]!;
    return { index, source: "event_id", event_id: event.event_id, record_id: recordIdFromEvent(event) };
  }

  if (input.record_id) {
    const index = latestEventIndexForRecord(events, input.record_id);
    if (index < 0) throw new Error(`Record not found: ${input.record_id}`);
    const event = events[index]!;
    return { index, source: "record_id", event_id: event.event_id, record_id: input.record_id };
  }

  const queryAnchor = timelineQueryAnchor(records, events, input);
  if (!queryAnchor) throw new Error(`Timeline anchor not found for query: ${input.query ?? ""}`);
  const event = events[queryAnchor.index]!;
  return { index: queryAnchor.index, source: "query", event_id: event.event_id, record_id: queryAnchor.record_id };
}

function timelineRelative(index: number, anchorIndex: number): TimelineRelative {
  if (index < anchorIndex) return "before";
  if (index > anchorIndex) return "after";
  return "anchor";
}

function summarizeRecord(record: MorynRecord): string {
  if (shouldCompactContent(record)) return compactSummaryText(record);
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
  const stopWords = new Set([
    "add",
    "build",
    "check",
    "debug",
    "fix",
    "for",
    "from",
    "implement",
    "make",
    "path",
    "project",
    "the",
    "this",
    "use",
    "with"
  ]);
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

function nextRelationshipTimestamp(source: MorynRecord, target: MorynRecord, candidate: string): string {
  const latestEndpoint = source.updated_at >= target.updated_at ? source : target;
  return nextMutationTimestamp(latestEndpoint, candidate);
}

function refreshImportance(
  record: MorynRecord,
  currentTask: string | undefined
): { importance: "silent" | "notice" | "interrupt"; reason?: string } {
  if (record.state === "raw" || record.kind === "agent_note") return { importance: "silent" };
  if (record.kind === "session_summary") return { importance: "notice" };
  const interruptCandidate =
    record.type === "blocker" || record.type === "warning" || record.type === "conflict" || record.priority === "high";
  if (interruptCandidate) {
    if (!currentTask) return { importance: "interrupt" };
    if (matchesCurrentTask(record, currentTask)) return { importance: "interrupt", reason: "current_task_match" };
    return { importance: "silent" };
  }
  if (record.state === "canonical" || (record.state === "candidate" && record.confidence >= 0.75))
    return { importance: "notice" };
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
    segments.includes("AUTHORIZATION") ||
    segments.includes("COOKIE") ||
    joinedSegments.endsWith("AUTH_HEADER") ||
    joinedSegments.endsWith("SET_COOKIE")
  ) {
    return true;
  }
  return /(?:API[_-]?KEY|DATABASE_URL|REDIS_URL|SECRET|TOKEN|PASSWORD|PRIVATE[_-]?KEY)/i.test(key);
}

function redactSensitiveValue(value: unknown, keyPath?: string): unknown {
  if (typeof value === "string") {
    return keyPath && isSensitiveKey(keyPath) ? "[REDACTED_SECRET]" : redactSensitiveContent(value);
  }
  if (Array.isArray(value))
    return value.map((item, index) => redactSensitiveValue(item, keyPath ? `${keyPath}.${index}` : String(index)));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        const nextPath = keyPath ? `${keyPath}.${key}` : key;
        return [key, redactSensitiveValue(nested, nextPath)];
      })
    );
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
  "links",
  "memory_usage"
]);

const MANAGED_REVISION_FIELDS = [...managedRevisionFields];

type RevisionPatchRecoveryHint =
  | {
      rejected_patch: { patch: unknown };
      expected: { kind: "patch_object" | "non_empty_patch" | "valid_record_after_patch" };
      retry_with: { patch_placeholder: Record<string, string> };
    }
  | {
      rejected_patch: { path: string; value: unknown };
      expected: { kind: "valid_patch_path"; format: "dot-separated record field path" };
      retry_with: { patch_path_placeholder: "content.text" };
    }
  | {
      rejected_patch: { path: string; value: unknown };
      expected: { kind: "user_editable_patch"; managed_fields: string[] };
      retry_with: {
        remove_patch_path: string;
        use_operation?: "promote";
        operation_arguments?: Record<string, unknown>;
      };
    };

class RevisionPatchError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: RevisionPatchRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: RevisionPatchRecoveryHint) {
    super(message);
    this.name = "RevisionPatchError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function invalidRevisionPatchShapeError(patch: unknown, expectedKind: "patch_object"): RevisionPatchError {
  return new RevisionPatchError("Invalid argument: Invalid patch", "retry revise with a valid patch", {
    rejected_patch: { patch },
    expected: { kind: expectedKind },
    retry_with: { patch_placeholder: { "content.text": "<updated text>" } }
  });
}

function emptyRevisionPatchError(patch: Record<string, unknown>): RevisionPatchError {
  return new RevisionPatchError("Invalid argument: Invalid patch", "retry revise with a valid patch", {
    rejected_patch: { patch },
    expected: { kind: "non_empty_patch" },
    retry_with: { patch_placeholder: { "content.text": "<updated text>" } }
  });
}

function invalidRevisionPatchPathError(path: string, value: unknown): RevisionPatchError {
  return new RevisionPatchError("Invalid argument: Invalid patch", "retry revise with a valid patch", {
    rejected_patch: { path, value },
    expected: { kind: "valid_patch_path", format: "dot-separated record field path" },
    retry_with: { patch_path_placeholder: "content.text" }
  });
}

function invalidRevisionRecordPatchError(patch: Record<string, unknown>, detail?: string): RevisionPatchError {
  return new RevisionPatchError(
    `Invalid argument: Invalid patch${detail ? `; ${detail}` : ""}`,
    "retry revise with a valid patch",
    {
      rejected_patch: { patch },
      expected: { kind: "valid_record_after_patch" },
      retry_with: { patch_placeholder: { "content.text": "<non-empty text>" } }
    }
  );
}

function managedRevisionFieldError(path: string, value: unknown, recordId: string): RevisionPatchError {
  const managedField = path.split(".")[0] as string;
  return new RevisionPatchError(
    `Invalid argument: revise cannot modify managed field ${managedField}`,
    "retry revise without managed fields",
    {
      rejected_patch: { path, value },
      expected: { kind: "user_editable_patch", managed_fields: MANAGED_REVISION_FIELDS },
      retry_with: {
        remove_patch_path: path,
        ...(managedField === "state"
          ? {
              use_operation: "promote" as const,
              operation_arguments: { record_id: recordId, target_state: value, confirmed: true }
            }
          : {})
      }
    }
  );
}

function isUserConfirmed(source: RecordSource, confirmed?: boolean): boolean {
  return confirmed === true || source.client === "user";
}

function provenanceMethod(
  source: RecordSource,
  confirmed?: boolean
): "agent-proposed" | "rule-promoted" | "user-confirmed" {
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
  return (
    type === "security_rule" ||
    type === "deployment_rule" ||
    type === "permission_rule" ||
    type === "credential_rule" ||
    (type === "rule" && input.scope === "global")
  );
}

function textFromContent(content: Record<string, unknown> & { text?: string }): string {
  return searchableContentText(content).trim().toLowerCase();
}

function tagOverlap(left: string[], right: string[]): boolean {
  const ignoredTags = new Set([
    "javascript",
    "learning",
    "mcp",
    "node",
    "nodejs",
    "python",
    "time-bounded",
    "typescript"
  ]);
  const isSemanticTag = (tag: string) => {
    const normalized = tag.toLowerCase();
    return !ignoredTags.has(normalized) && !normalized.startsWith("evidence:") && !normalized.startsWith("policy:");
  };
  const rightTags = new Set(right.filter(isSemanticTag).map((tag) => tag.toLowerCase()));
  return left.some((tag) => isSemanticTag(tag) && rightTags.has(tag.toLowerCase()));
}

function subjectTokens(content: Record<string, unknown> & { text?: string }): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "agent",
    "before",
    "from",
    "into",
    "only",
    "source",
    "that",
    "the",
    "this",
    "truth",
    "with"
  ]);
  return textFromContent(content)
    .split(/\W+/)
    .filter((token) => token.length >= 4)
    .filter((token) => !stopWords.has(token));
}

function subjectOverlap(
  left: Record<string, unknown> & { text?: string },
  right: Record<string, unknown> & { text?: string }
): boolean {
  const rightTokens = new Set(subjectTokens(right));
  const matches = subjectTokens(left).filter((token) => rightTokens.has(token));
  return new Set(matches).size >= 2;
}

function semanticConflicts(
  records: MorynRecord[],
  input: {
    id?: string;
    kind: RecordKind;
    type: string;
    scope: RecordScope;
    project_id?: string;
    tags?: string[];
    content: Record<string, unknown> & { text?: string };
  }
): MorynRecord[] {
  if (input.kind !== "memory") return [];
  const inputText = textFromContent(input.content);
  if (!inputText) return [];
  return records
    .filter((record) => record.state === "canonical")
    .filter((record) => record.id !== input.id)
    .filter((record) => record.kind === input.kind)
    .filter((record) => record.type === input.type)
    .filter((record) => record.scope === input.scope)
    .filter((record) => record.project_id === input.project_id)
    .filter((record) => tagOverlap(record.tags, input.tags ?? []) || subjectOverlap(record.content, input.content))
    .filter((record) => textFromContent(record.content) !== inputText);
}

const CLAIM_NEGATION_TOKENS = new Set([
  "deny",
  "denied",
  "disable",
  "disabled",
  "forbid",
  "forbidden",
  "never",
  "no",
  "not",
  "without"
]);
const CLAIM_VALUE_TOKENS = new Set([
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve"
]);
const CLAIM_EXCLUSIVE_TOKEN_GROUPS = [
  ["allow", "allowed", "deny", "denied", "forbid", "forbidden"],
  ["enable", "enabled", "disable", "disabled"],
  ["true", "false"],
  ["required", "optional"],
  ["always", "never"],
  ["before", "after"]
] as const;

function claimTokens(content: Record<string, unknown> & { text?: string }): Set<string> {
  return new Set(textFromContent(content).match(/[\p{L}\p{N}_-]+/gu) ?? []);
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function explicitClaimConflict(
  left: Record<string, unknown> & { text?: string },
  right: Record<string, unknown> & { text?: string }
): boolean {
  const leftTokens = claimTokens(left);
  const rightTokens = claimTokens(right);
  const leftNegated = [...leftTokens].some((token) => CLAIM_NEGATION_TOKENS.has(token));
  const rightNegated = [...rightTokens].some((token) => CLAIM_NEGATION_TOKENS.has(token));
  if (leftNegated !== rightNegated) return true;

  const valueTokens = (tokens: ReadonlySet<string>) =>
    new Set([...tokens].filter((token) => CLAIM_VALUE_TOKENS.has(token) || /^\d+(?:[._-]\d+)*$/.test(token)));
  const leftValues = valueTokens(leftTokens);
  const rightValues = valueTokens(rightTokens);
  if (leftValues.size > 0 && rightValues.size > 0 && !sameStringSet(leftValues, rightValues)) return true;

  return CLAIM_EXCLUSIVE_TOKEN_GROUPS.some((group) => {
    const leftValues = new Set(group.filter((token) => leftTokens.has(token)));
    const rightValues = new Set(group.filter((token) => rightTokens.has(token)));
    return leftValues.size > 0 && rightValues.size > 0 && !sameStringSet(leftValues, rightValues);
  });
}

function learningSemanticConflicts(records: MorynRecord[], input: MorynRecord): MorynRecord[] {
  return semanticConflicts(records, input).filter((record) => explicitClaimConflict(record.content, input.content));
}

function learningPolicyAgnosticFingerprint(record: MorynRecord): string {
  return logicalMemoryFingerprint({
    ...record,
    tags: record.tags.filter((tag) => !tag.startsWith("policy:"))
  });
}

export function createEngine(deps: EngineDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const id = deps.id ?? createId;
  const checkpointRebuild = deps.rebuild ?? rebuildDerivedViews;
  const appendIdempotentEvent = deps.appendEventIfAbsent ?? appendEventIfAbsent;
  const readRecords = deps.readCurrentRecords ?? readCurrentRecords;
  const readCandidates = deps.readRetrievalCandidates ?? readRetrievalCandidates;

  async function currentRecords(): Promise<MorynRecord[]> {
    return (await readRecords(deps.storePath)).records;
  }

  async function requireRecord(recordId: string): Promise<MorynRecord> {
    const record = (await currentRecords()).find((candidate) => candidate.id === recordId);
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

  async function existingIdempotentMutation(
    identity: ReturnType<typeof mutationIdempotency>,
    operation: string,
    allowedOps: MorynEvent["op"][]
  ): Promise<MorynEvent | undefined> {
    if (!identity.event_id || !identity.metadata) return undefined;
    const existing = (await readEvents(deps.storePath)).find((event) => event.event_id === identity.event_id);
    if (!existing) return undefined;
    assertIdempotentEventMatch(existing, { ...existing, idempotency: identity.metadata }, operation);
    if (!allowedOps.includes(existing.op)) {
      throw new Error(`Idempotency collision: ${operation} event operation does not match`);
    }
    return existing;
  }

  async function revisionContentWasSensitiveWhenCommitted(
    revision: Extract<MorynEvent, { op: "revise_record" }>,
    patch: Record<string, unknown>
  ): Promise<boolean> {
    const events = await readEvents(deps.storePath);
    const revisionIndex = events.findIndex((event) => event.event_id === revision.event_id);
    if (revisionIndex < 0) return detectSensitiveContent(sensitiveScanText(patch)).sensitive;
    const recordBeforeRevision = replayEvents(events.slice(0, revisionIndex)).get(revision.record_id);
    if (!recordBeforeRevision) return detectSensitiveContent(sensitiveScanText(patch)).sensitive;
    const patchedAtRevision = applyRecordPatch(recordBeforeRevision, patch);
    return detectSensitiveContent(sensitiveScanText(patchedAtRevision.content)).sensitive;
  }

  async function commitMutationEvents(
    events: MorynEvent[],
    operation: string,
    partialRecovery: "same_key" | "same_request" = "same_key"
  ) {
    const appendResults: AppendEventIfAbsentResult[] = [];
    for (const event of events) {
      let appended: AppendEventIfAbsentResult;
      try {
        appended = event.idempotency
          ? await appendIdempotentEvent(deps.storePath, event)
          : {
              created: true,
              event,
              path: await appendEvent(deps.storePath, event),
              durability: "best_effort" as const
            };
      } catch (error) {
        if (appendResults.length > 0) {
          throw new PartialMutationCommitError(
            operation,
            appendResults.map((result) => result.event.event_id),
            error,
            partialRecovery
          );
        }
        throw error;
      }
      assertIdempotentEventMatch(appended.event, event, operation);
      if (appended.event.op !== event.op) {
        throw new Error(`Idempotency collision: ${operation} event operation does not match`);
      }
      appendResults.push(appended);
    }
    let derivedViewsRefreshed = true;
    const warnings: Array<{ code: string; reason: string }> = appendResults.flatMap((result) => result.warnings ?? []);
    try {
      await checkpointRebuild(deps.storePath);
    } catch (error) {
      derivedViewsRefreshed = false;
      warnings.push({
        code: "DERIVED_VIEW_REBUILD_FAILED",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
    const durability = appendResults.some((result) => result.durability === "failed")
      ? "failed"
      : appendResults.some((result) => result.durability === "best_effort")
        ? "best_effort"
        : "confirmed";
    return {
      events: appendResults.map((result) => result.event),
      committed: true as const,
      idempotent_replay: appendResults.every((result) => !result.created),
      replayed_event_ids: appendResults.filter((result) => !result.created).map((result) => result.event.event_id),
      durability,
      durability_by_event_id: Object.fromEntries(
        appendResults.map((result) => [result.event.event_id, result.durability])
      ),
      derived_views_refreshed: derivedViewsRefreshed,
      ...(warnings.length ? { warnings } : {})
    };
  }

  async function commitMutationEvent(event: MorynEvent, operation: string) {
    const receipt = await commitMutationEvents([event], operation);
    return { ...receipt, event: receipt.events[0] as MorynEvent };
  }

  async function persistStructuredSemanticMergeWithLease(
    proposal: SemanticConsolidationProposal,
    validation: SemanticConsolidationValidationResult,
    plan: StructuredSemanticMergePlan
  ): Promise<SemanticConsolidationProposalResult> {
    const eventSource: RecordSource = {
      client: "moryn",
      device_id: STRUCTURED_SEMANTIC_MERGE_DEVICE_ID
    };
    const upsertEventId = structuredSemanticMergeEventId("upsert", {
      merged_record_id: plan.initial_record.id,
      merge_digest: plan.merge_digest
    });
    const claimEvent: Extract<MorynEvent, { op: "link_records" }> = {
      event_id: structuredSemanticMergeEventId("claim", { claim_digest: plan.claim_digest }),
      op: "link_records",
      record_id: plan.initial_record.id,
      linked_record_id: plan.source_record_ids[0]!,
      link_type: "supports",
      reason: "Claims this exact source snapshot for one deterministic structured semantic merge.",
      created_at: structuredSemanticMergeTimestamp(plan, STRUCTURED_SEMANTIC_MERGE_CLAIM_OFFSET_MS),
      source: eventSource
    };
    const activationEvent: MorynEvent = {
      event_id: structuredSemanticMergeEventId("activate", {
        merged_record_id: plan.initial_record.id,
        merge_digest: plan.merge_digest
      }),
      op: "promote_record",
      record_id: plan.initial_record.id,
      target_state: "candidate",
      reason: STRUCTURED_SEMANTIC_MERGE_ACTIVATION_REASON,
      confirmed: false,
      created_at: structuredSemanticMergeTimestamp(plan, STRUCTURED_SEMANTIC_MERGE_ACTIVATION_OFFSET_MS),
      source: eventSource
    };
    let persistence: "created" | "existing" | undefined;
    let linksCreated = 0;
    let anyCreated = false;
    const expectedRelationshipEvents: Extract<MorynEvent, { op: "link_records" }>[] = [];

    const failed = (
      reason: Extract<
        SemanticConsolidationProposalResult["reason"],
        | "persistence_failed"
        | "structured_merge_source_changed"
        | "structured_merge_concurrent_conflict"
        | "structured_merge_readback_failed"
      >,
      state?: "candidate" | "canonical"
    ): SemanticConsolidationProposalResult => ({
      ...validation,
      status: "failed",
      reason,
      event_id: upsertEventId,
      links_created: linksCreated,
      merged_record_id: plan.initial_record.id,
      ...(state ? { merged_record_state: state } : {}),
      ...(persistence ? { merged_record_persistence: persistence } : {})
    });

    const appendRelationship = async (event: Extract<MorynEvent, { op: "link_records" }>) => {
      const appended = await appendIdempotentEvent(deps.storePath, event);
      if (!structuredSemanticMergeRelationshipEventMatches(appended.event, event)) {
        return { status: "collision", created: false, event: appended.event } as const;
      }
      if (!structuredSemanticMergeRelationshipProjected(await currentRecords(), event)) {
        return { status: "readback_failed", created: false, event: appended.event } as const;
      }
      expectedRelationshipEvents.push(event);
      if (appended.created) {
        linksCreated += 1;
        anyCreated = true;
      }
      return { status: "ok", created: appended.created, event: appended.event } as const;
    };

    try {
      if (!structuredSemanticMergeDependenciesMatch(await currentRecords(), plan)) {
        return failed("structured_merge_source_changed");
      }
      const existingClaim = (await readEvents(deps.storePath)).find((event) => event.event_id === claimEvent.event_id);
      if (existingClaim && !structuredSemanticMergeRelationshipEventMatches(existingClaim, claimEvent)) {
        return failed("structured_merge_concurrent_conflict");
      }
      const upsert: MorynEvent = {
        event_id: upsertEventId,
        op: "upsert_record",
        record: plan.initial_record,
        created_at: plan.initial_record.created_at,
        source: eventSource
      };
      const appendedUpsert = await appendIdempotentEvent(deps.storePath, upsert);
      if (
        appendedUpsert.event.event_id !== upsert.event_id ||
        appendedUpsert.event.op !== "upsert_record" ||
        appendedUpsert.event.created_at !== upsert.created_at ||
        !structuredSemanticMergeEventSourceMatches(appendedUpsert.event.source) ||
        !structuredSemanticMergeInitialRecordMatches(appendedUpsert.event.record, plan)
      ) {
        return failed("structured_merge_concurrent_conflict");
      }
      persistence = appendedUpsert.created ? "created" : "existing";
      anyCreated ||= appendedUpsert.created;

      let records = await currentRecords();
      let merged = records.find((record) => record.id === plan.initial_record.id);
      if (!merged || !structuredSemanticMergePersistedRecordMatches(merged, plan)) {
        return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
      }
      if (!structuredSemanticMergeDependenciesMatch(records, plan)) {
        return failed("structured_merge_source_changed", structuredSemanticMergeReceiptState(merged));
      }

      const claim = await appendRelationship(claimEvent);
      if (claim.status === "collision") {
        return failed("structured_merge_concurrent_conflict", structuredSemanticMergeReceiptState(merged));
      }
      if (claim.status === "readback_failed") {
        return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
      }

      records = await currentRecords();
      merged = records.find((record) => record.id === plan.initial_record.id);
      if (!merged || !structuredSemanticMergePersistedRecordMatches(merged, plan)) {
        return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
      }
      if (!structuredSemanticMergeDependenciesMatch(records, plan)) {
        return failed("structured_merge_source_changed", structuredSemanticMergeReceiptState(merged));
      }

      const activated = await appendIdempotentEvent(deps.storePath, activationEvent);
      if (!structuredSemanticMergePromotionEventMatches(activated.event, activationEvent)) {
        return failed("structured_merge_concurrent_conflict", structuredSemanticMergeReceiptState(merged));
      }
      anyCreated ||= activated.created;

      records = await currentRecords();
      merged = records.find((record) => record.id === plan.initial_record.id);
      if (!merged || !structuredSemanticMergeRecordMatches(merged, plan)) {
        return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
      }
      if (!structuredSemanticMergeDependenciesMatch(records, plan)) {
        return failed("structured_merge_source_changed", structuredSemanticMergeReceiptState(merged));
      }

      if (plan.final_state === "canonical") {
        const promoteEvent: MorynEvent = {
          event_id: structuredSemanticMergeEventId("promote", {
            merged_record_id: plan.initial_record.id,
            merge_digest: plan.merge_digest
          }),
          op: "promote_record",
          record_id: plan.initial_record.id,
          target_state: "canonical",
          reason: STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON,
          confirmed: false,
          created_at: structuredSemanticMergeTimestamp(plan, STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS),
          source: eventSource
        };
        const promoted = await appendIdempotentEvent(deps.storePath, promoteEvent);
        if (!structuredSemanticMergePromotionEventMatches(promoted.event, promoteEvent)) {
          return failed("structured_merge_concurrent_conflict", "candidate");
        }
        anyCreated ||= promoted.created;
      }

      records = await currentRecords();
      merged = records.find((record) => record.id === plan.initial_record.id);
      if (
        !merged ||
        !structuredSemanticMergeRecordMatches(merged, plan) ||
        (plan.final_state === "canonical" && merged.state !== "canonical")
      ) {
        return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
      }
      if (!structuredSemanticMergeDependenciesMatch(records, plan)) {
        return failed("structured_merge_source_changed", structuredSemanticMergeReceiptState(merged));
      }

      const relationshipState = merged.state === "canonical" ? "canonical" : plan.final_state;
      const remainingRelationships = plan.source_record_ids.flatMap((sourceRecordId) => {
        if (relationshipState === "candidate" && sourceRecordId === claimEvent.linked_record_id) return [];
        const relationship = relationshipState === "candidate" ? "supports" : proposal.relationship;
        const recordId =
          relationshipState === "canonical" && relationship === "duplicate_of"
            ? sourceRecordId
            : plan.initial_record.id;
        const linkedRecordId =
          relationshipState === "canonical" && relationship === "duplicate_of"
            ? plan.initial_record.id
            : sourceRecordId;
        return [{ sourceRecordId, relationship, recordId, linkedRecordId }];
      });

      for (const [relationshipIndex, relationship] of remainingRelationships.entries()) {
        records = await currentRecords();
        merged = records.find((record) => record.id === plan.initial_record.id);
        const sourceRecord = records.find((record) => record.id === relationship.sourceRecordId);
        if (!merged || !structuredSemanticMergeRecordMatches(merged, plan)) {
          return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
        }
        if (!sourceRecord || !structuredSemanticMergeDependenciesMatch(records, plan)) {
          return failed("structured_merge_source_changed", structuredSemanticMergeReceiptState(merged));
        }
        const relationEvent: Extract<MorynEvent, { op: "link_records" }> = {
          event_id: structuredSemanticMergeEventId(relationshipState === "canonical" ? "hide" : "support", {
            merged_record_id: plan.initial_record.id,
            source_record_id: sourceRecord.id,
            relationship: relationship.relationship
          }),
          op: "link_records",
          record_id: relationship.recordId,
          linked_record_id: relationship.linkedRecordId,
          link_type: relationship.relationship,
          reason:
            relationshipState === "canonical"
              ? STRUCTURED_SEMANTIC_MERGE_HIDE_REASON
              : "Candidate merge retains a non-hiding source relationship pending canonical trust.",
          created_at: structuredSemanticMergeTimestamp(
            plan,
            STRUCTURED_SEMANTIC_MERGE_RELATIONSHIP_OFFSET_MS + relationshipIndex
          ),
          source: eventSource
        };
        const appended = await appendRelationship(relationEvent);
        if (appended.status === "collision") {
          return failed("structured_merge_concurrent_conflict", structuredSemanticMergeReceiptState(merged));
        }
        if (appended.status === "readback_failed") {
          return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(merged));
        }
      }

      if (anyCreated) await rebuildDerivedViews(deps.storePath);
      const finalRecords = await currentRecords();
      const readback = finalRecords.find((record) => record.id === plan.initial_record.id);
      if (
        !readback ||
        !structuredSemanticMergeRecordMatches(readback, plan) ||
        expectedRelationshipEvents.some((event) => !structuredSemanticMergeRelationshipProjected(finalRecords, event))
      ) {
        return failed("structured_merge_readback_failed", structuredSemanticMergeReceiptState(readback));
      }
      const status = anyCreated ? "accepted" : "idempotent";
      return {
        ...validation,
        status,
        reason: status === "accepted" ? "accepted" : "existing_relationship",
        event_id: upsertEventId,
        links_created: linksCreated,
        merged_record_id: plan.initial_record.id,
        merged_record_state: readback.state === "canonical" ? "canonical" : "candidate",
        merged_record_persistence: persistence
      };
    } catch {
      let state: "candidate" | "canonical" | undefined;
      try {
        const record = (await currentRecords()).find((candidate) => candidate.id === plan.initial_record.id);
        state = structuredSemanticMergeReceiptState(record);
      } catch {}
      return failed("persistence_failed", state);
    }
  }

  async function consolidateStructuredSemanticProposal(
    proposal: SemanticConsolidationProposal,
    input: ConsolidateSemanticProposalsInput
  ): Promise<SemanticConsolidationProposalResult> {
    return withStoreStateLease(deps.storePath, async () => {
      const records = await currentRecords();
      const planning = planStructuredSemanticMerge(records, proposal, {
        include_private: input.include_private === true
      });
      const validation = validateSemanticConsolidationProposal(records, proposal, {
        include_private: input.include_private === true,
        ...(planning.status === "ready" ? { structured_merge_record_id: planning.plan.initial_record.id } : {})
      });
      if (input.project_id) {
        const sourceRecord = records.find((record) => record.id === validation.source_record_id);
        const targetRecord = records.find((record) => record.id === validation.target_record_id);
        if (
          (sourceRecord?.scope === "project" && sourceRecord.project_id !== input.project_id) ||
          (targetRecord?.scope === "project" && targetRecord.project_id !== input.project_id)
        ) {
          return { ...validation, status: "rejected", reason: "incompatible_domain" };
        }
      }
      if (validation.status === "rejected") return validation;
      if (planning.status === "rejected") {
        return { ...validation, status: "rejected", reason: planning.reason };
      }
      return persistStructuredSemanticMergeWithLease(proposal, validation, planning.plan);
    });
  }

  const engine = {
    async createSoulProfileDraft(input: unknown) {
      return persistSoulProfileDraft(
        deps.storePath,
        normalizeSoulDraftCommand(input, { source: { client: "moryn" }, occurred_at: now() })
      );
    },

    async approveSoulProfileDraft(input: unknown) {
      return persistApprovedSoulProfileDraft(
        deps.storePath,
        normalizeSoulApprovalCommand(input, { source: { client: "moryn" }, occurred_at: now() })
      );
    },

    async rollbackSoulProfile(input: unknown) {
      return persistSoulProfileRollback(
        deps.storePath,
        normalizeSoulRollbackCommand(input, { source: { client: "moryn" }, occurred_at: now() })
      );
    },

    async readSoulProfileStatus(input: unknown = {}) {
      return buildSoulProfileStatus(deps.storePath, normalizeSoulStatusCommand(input));
    },

    async expandMemorySources(input: unknown) {
      const normalized = normalizeMemoryExpansionCommand(input);
      return buildMemorySourceExpansion({ records: await currentRecords(), ...normalized });
    },

    async previewMemoryCompaction(input: unknown = {}) {
      return buildMemoryCompactionPreview(await currentRecords(), normalizeMemoryCompactionPreviewInput(input));
    },

    async planMemoryCompaction(input: unknown) {
      assertPlainObject(input, "memory compaction plan input");
      assertOnlyInputKeys(input, ["preview"], "memory compaction plan input");
      return sealMemoryCompactionPlan(input.preview as MemoryCompactionPreview);
    },

    async applyMemoryCompaction(input: unknown) {
      assertPlainObject(input, "memory compaction apply input");
      assertOnlyInputKeys(input, ["plan", "confirmed"], "memory compaction apply input");
      assertMemoryCompactionPlanEnvelope(input.plan);
      const submittedPlan = input.plan;
      const existingReceipt = await readMemoryCompactionReceipt(deps.storePath, submittedPlan.plan_id);
      if (!existingReceipt) {
        const currentPreview = buildMemoryCompactionPreview(await currentRecords(), {
          ...submittedPlan.filters,
          now: submittedPlan.planning_time
        });
        const currentPlan = sealMemoryCompactionPlan(currentPreview);
        if (
          currentPlan.plan_id !== submittedPlan.plan_id ||
          currentPlan.envelope_digest !== submittedPlan.envelope_digest
        ) {
          throw new Error(
            "Memory Compaction plan no longer matches the current authorized privacy scope; generate and review a new preview"
          );
        }
      }
      return commitMemoryCompactionPlan(deps.storePath, {
        plan: submittedPlan,
        confirmed: input.confirmed as boolean
      });
    },

    async restoreMemoryCompaction(input: unknown) {
      assertPlainObject(input, "memory compaction restore input");
      assertOnlyInputKeys(input, ["plan_id", "confirmed"], "memory compaction restore input");
      return restoreCommittedMemoryCompactionPlan(deps.storePath, {
        plan_id: input.plan_id as string,
        confirmed: input.confirmed as boolean
      });
    },

    async previewSessionFold(input: SessionFoldPreviewInput) {
      const { include_private: includePrivate, ...identity } = validateSessionFoldPreviewInput(input);
      const records = recordsForSessionFoldRead(await currentRecords(), identity, includePrivate);
      const plan = buildSessionFoldPlan(records, identity);
      const proposedFinalText =
        typeof input.proposed_final_text === "string" ? input.proposed_final_text.trim() : undefined;
      return {
        plan,
        ...(proposedFinalText
          ? { coverage: buildSessionFoldCoverageAttestation(records, identity, proposedFinalText) }
          : {})
      };
    },

    async planSessionFold(input: SessionFoldPlanInput) {
      const { include_private: includePrivate, ...identity } = normalizeSessionFoldPlanInput(input);
      const records = recordsForSessionFoldRead(await currentRecords(), identity, includePrivate);
      return buildSessionFoldPlan(records, identity);
    },

    async applySessionFold(input: ApplySessionFoldInput) {
      assertPlainObject(input, "apply_session_fold input");
      if (!input.plan || typeof input.plan !== "object" || Array.isArray(input.plan)) {
        throw new Error("Invalid argument: plan must be a Session Fold plan");
      }
      if (input.include_private !== undefined && typeof input.include_private !== "boolean") {
        throw new Error("Invalid argument: include_private must be a boolean");
      }
      if (input.plan.privacy_boundary !== "public" && input.include_private !== true) {
        throw new Error("Private Session Fold apply requires explicit include_private: true");
      }
      return applySessionFoldPlan(deps.storePath, input.plan, {
        append_event: appendIdempotentEvent,
        rebuild: async (storePath) => {
          await checkpointRebuild(storePath);
        }
      });
    },

    async ingestLearnings(input: IngestLearningsInput) {
      if (!Array.isArray(input.learnings)) throw new Error("Invalid argument: learnings must be an array");
      if (
        typeof input.occurred_at !== "string" ||
        !Number.isFinite(Date.parse(input.occurred_at)) ||
        new Date(Date.parse(input.occurred_at)).toISOString() !== input.occurred_at
      ) {
        throw new Error("Invalid argument: occurred_at must be a canonical ISO timestamp");
      }
      const occurredAt = input.occurred_at;
      const learnings = input.learnings.map((learning) => learningDeltaSchema.parse(learning)) as LearningDelta[];
      const dispositions = [];
      const ingestedRecordIds: string[] = [];
      let createdCount = 0;
      let evidenceLinksCreated = 0;
      for (const learning of learnings) {
        if (learning.scope === "project" && !input.project_id)
          throw new Error("Invalid argument: project learning requires project_id");
        const identity = learningRecordIdentity({ project_id: input.project_id, learning });
        const persisted = await withStoreStateLease(deps.storePath, async () => {
          const basePolicy = learningStatePolicy(learning, { now: occurredAt });
          const baseRecord = normalizeLearningRecord({
            project_id: input.project_id,
            learning,
            source: input.source,
            occurred_at: occurredAt,
            policy: basePolicy
          });
          const existing = (await readEvents(deps.storePath)).find((event) => event.event_id === identity.event_id);
          if (existing) {
            if (
              existing.op !== "upsert_record" ||
              (existing.record.state !== "candidate" && existing.record.state !== "canonical") ||
              learningPolicyAgnosticFingerprint(existing.record) !== learningPolicyAgnosticFingerprint(baseRecord)
            ) {
              throw new Error(`Learning idempotency collision: ${identity.event_id}`);
            }
            return { event: existing, created: false, policy: basePolicy };
          }

          const conflicts =
            basePolicy.state === "canonical" ? learningSemanticConflicts(await currentRecords(), baseRecord) : [];
          const policy = conflicts.length
            ? {
                state: "candidate" as const,
                requires_confirmation: true,
                reason: "semantic_conflict_requires_confirmation" as const
              }
            : basePolicy;
          const normalized = normalizeLearningRecord({
            project_id: input.project_id,
            learning,
            source: input.source,
            occurred_at: occurredAt,
            policy
          });
          const record: MorynRecord = conflicts.length
            ? {
                ...normalized,
                conflict: {
                  kind: "semantic",
                  with: [...new Set(conflicts.map((candidate) => candidate.id))].sort(),
                  resolution: "needs_review"
                }
              }
            : normalized;
          const event: MorynEvent = {
            event_id: identity.event_id,
            op: "upsert_record",
            record,
            created_at: occurredAt,
            source: input.source
          };
          const appended = await appendIdempotentEvent(deps.storePath, event);
          const committedEvent = appended.event;
          if (
            committedEvent.op !== "upsert_record" ||
            (committedEvent.record.state !== "candidate" && committedEvent.record.state !== "canonical") ||
            learningPolicyAgnosticFingerprint(committedEvent.record) !== learningPolicyAgnosticFingerprint(record)
          ) {
            throw new Error(`Learning idempotency collision: ${identity.event_id}`);
          }
          return { event: committedEvent, created: appended.created, policy };
        });
        const { event: learningEvent, created, policy } = persisted;
        const learningState = learningEvent.record.state;
        if (learningState !== "candidate" && learningState !== "canonical") {
          throw new Error(`Learning idempotency collision: ${identity.event_id}`);
        }
        if (created) createdCount += 1;
        if (input.origin_record_id) {
          const originRecord = await requireRecord(input.origin_record_id);
          const evidenceBaseTimestamp =
            originRecord.updated_at > learningEvent.record.updated_at
              ? originRecord.updated_at
              : learningEvent.record.updated_at;
          const evidenceEvent: MorynEvent = {
            event_id: duplicateLinkEventId(input.origin_record_id, learningEvent.record.id),
            op: "link_records",
            record_id: input.origin_record_id,
            linked_record_id: learningEvent.record.id,
            link_type: "supports",
            reason: `Learning evidence: ${learning.evidence_type}`,
            created_at: nextMutationTimestamp(
              { ...learningEvent.record, updated_at: evidenceBaseTimestamp },
              occurredAt
            ),
            source: input.source
          };
          const evidenceAppended = await appendIdempotentEvent(deps.storePath, evidenceEvent);
          if (evidenceAppended.created) evidenceLinksCreated += 1;
        }
        dispositions.push({
          record_id: learningEvent.record.id,
          created,
          state: learningState,
          requires_confirmation:
            learningState === "candidate" &&
            (policy.requires_confirmation || learningEvent.record.conflict !== undefined),
          policy_reason:
            learningEvent.record.tags.find((tag) => tag.startsWith("policy:"))?.slice("policy:".length) ?? policy.reason
        });
        ingestedRecordIds.push(learningEvent.record.id);
      }
      if (createdCount > 0 || evidenceLinksCreated > 0) await rebuildDerivedViews(deps.storePath);
      const records = await currentRecords();
      const discoveredProposals = ingestedRecordIds
        .map((recordId) => discoverAutomaticDuplicateProposal(records, recordId))
        .filter((proposal): proposal is SemanticConsolidationProposal => proposal !== undefined);
      const proposals = [
        ...new Map(
          discoveredProposals.map((proposal) => [
            `${proposal.source_record_id}\u0000${proposal.target_record_id}\u0000${proposal.relationship}`,
            proposal
          ])
        ).values()
      ];
      const automaticConsolidation = proposals.length
        ? await engine.consolidateSemanticProposals({
            proposals,
            project_id: input.project_id,
            source: input.source,
            occurred_at: occurredAt
          })
        : semanticConsolidationReceipt([]);
      const semanticCandidates = await (async () => {
        try {
          const activeRecords = await currentRecords();
          const result = retrieveSemanticConsolidationCandidates(activeRecords, {
            source_record_ids: ingestedRecordIds,
            include_private: false,
            per_source_limit: 3,
            total_limit: 12
          });
          const candidates = result.candidates.filter(
            (candidate) =>
              candidate.token_overlap >= 0.35 ||
              candidate.signals.includes("shared_file") ||
              candidate.signals.includes("shared_provenance")
          );
          return {
            candidates,
            candidates_by_source_record_id: stringKeyedRecordFromEntries(
              ingestedRecordIds.map(
                (recordId) =>
                  [recordId, candidates.filter((candidate) => candidate.source_record_id === recordId)] as const
              )
            ),
            next_action: {
              action: "recall_then_propose_semantic_relationship" as const,
              recall_tool: "recall" as const,
              proposal_tool: "consolidate_semantic" as const,
              relationships: ["duplicate_of", "revises", "supersedes", "conflicts_with"] as const,
              instruction:
                "Recall candidate records before proposing a semantic relationship; do not infer equivalence from score alone."
            },
            selection_sources: result.selection_sources
          };
        } catch (error) {
          return {
            candidates: [],
            candidates_by_source_record_id: stringKeyedRecordFromEntries<SemanticConsolidationCandidate[]>(
              ingestedRecordIds.map((recordId) => [recordId, []])
            ),
            next_action: {
              action: "none" as const,
              reason: "candidate_discovery_failed" as const
            },
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })();
      return {
        learnings_received: learnings.length,
        records_created: createdCount,
        evidence_links_created: evidenceLinksCreated,
        dispositions,
        automatic_consolidation: automaticConsolidation,
        semantic_candidates: semanticCandidates
      };
    },

    async checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
      const normalized = normalizeCheckpointInput(input);
      const identity = checkpointIdentity(normalized);
      const outcome = await (async () => {
        const source = normalized.source;
        const createdAt = normalized.occurred_at;
        const record: MorynRecord = {
          id: identity.record_id,
          kind: "session_summary",
          type: "checkpoint",
          scope: "project",
          project_id: normalized.project_id,
          tags: normalized.tags,
          content: {
            format: "json",
            text: checkpointSummary(normalized.delta),
            checkpoint_version: 1,
            checkpoint_payload_digest: checkpointPayloadDigest(normalized),
            checkpoint: normalized.delta
          },
          state: "candidate",
          confidence: 0.5,
          priority: "normal",
          visibility: "active",
          created_at: createdAt,
          updated_at: createdAt,
          source,
          provenance: { method: "agent-proposed" }
        };
        const event: MorynEvent = {
          event_id: identity.event_id,
          op: "upsert_record",
          record,
          created_at: createdAt,
          source
        };
        const appended = await appendEventIfAbsent(deps.storePath, event);
        if (
          appended.event.op !== "upsert_record" ||
          !matchesCheckpoint(appended.event.record, normalized) ||
          !matchesCheckpointPayload(appended.event.record, normalized) ||
          appended.event.record.id !== identity.record_id
        ) {
          throw new Error(`Checkpoint idempotency collision: ${identity.event_id}`);
        }
        return {
          record: appended.event.record,
          idempotent_replay: !appended.created,
          durability: appended.durability,
          append_warnings: appended.warnings ?? []
        };
      })();
      const warnings: NonNullable<CheckpointResult["warnings"]> = [...outcome.append_warnings];
      const inboxRecords = await learningInboxForLifecycle(deps.storePath, {
        project_id: normalized.project_id,
        session_id: normalized.source.session_id,
        consumed_by_record_id: outcome.record.id
      });
      const combinedLearnings = [
        ...new Map(
          [...normalized.delta.learnings, ...inboxRecords.map((record) => record.content.learning_delta)].map(
            (learning) => [learningRecordIdentity({ project_id: normalized.project_id, learning }).record_id, learning]
          )
        ).values()
      ];
      const learningIngestion = await engine.ingestLearnings({
        project_id: normalized.project_id,
        learnings: combinedLearnings,
        occurred_at: normalized.occurred_at,
        source: normalized.source,
        origin_record_id: outcome.record.id
      });
      const semanticConsolidation = await engine.consolidateLearningProposals({
        proposals: normalized.delta.semantic_consolidation_proposals,
        source_record_ids: learningIngestion.dispositions.map((disposition) => disposition.record_id),
        project_id: normalized.project_id,
        include_private: normalized.include_private,
        source: normalized.source,
        occurred_at: normalized.occurred_at
      });
      const exactDuplicateConsolidation = await runAutomaticExactDuplicateConsolidation(engine, {
        project_id: normalized.project_id,
        source: normalized.source
      });
      const automaticSemanticMaintenance = outcome.idempotent_replay
        ? undefined
        : await runAutomaticSemanticMaintenance(engine, {
            project_id: normalized.project_id,
            source: normalized.source
          });
      const candidateReview = buildLearningCandidateReviewWorkflow(
        normalized.project_id,
        unresolvedLearningCandidates(learningIngestion.semantic_candidates.candidates, semanticConsolidation)
      );
      const learningIngestionResult = {
        ...learningIngestion,
        ...(candidateReview ? { candidate_review: candidateReview } : {})
      };
      const inboxConsumption = await consumeLearningInbox(deps.storePath, {
        inbox_records: inboxRecords,
        consumed_at: new Date(Date.parse(normalized.occurred_at) + 1).toISOString(),
        consumed_by_record_id: outcome.record.id,
        produced_record_ids: learningIngestion.dispositions.map((disposition) => disposition.record_id),
        source: normalized.source
      });
      const learningInbox = { selected: inboxRecords.length, ...inboxConsumption };
      const recoveryPack = buildCheckpointRecoveryPack([...replayEvents(await readEvents(deps.storePath)).values()], {
        project_id: normalized.project_id,
        session_id: normalized.delta.session_id,
        include_private: normalized.include_private
      });
      let derivedViewsRefreshed = true;
      try {
        await checkpointRebuild(deps.storePath);
      } catch (error) {
        derivedViewsRefreshed = false;
        warnings.push({
          code: "DERIVED_VIEW_REBUILD_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      const automaticEventAudit = await (deps.runAutomaticEventAudit ?? runAutomaticEventAudit)(deps.storePath);
      return {
        record: outcome.record,
        idempotent_replay: outcome.idempotent_replay,
        committed: true,
        durability: outcome.durability,
        derived_views_refreshed: derivedViewsRefreshed,
        ...(warnings.length ? { warnings } : {}),
        recovery_pack: recoveryPack,
        learning_ingestion: learningIngestionResult,
        learning_inbox: learningInbox,
        exact_duplicate_consolidation: exactDuplicateConsolidation,
        ...(automaticSemanticMaintenance ? { automatic_semantic_maintenance: automaticSemanticMaintenance } : {}),
        semantic_consolidation: semanticConsolidation,
        automatic_event_audit: automaticEventAudit,
        selection_sources: CHECKPOINT_SELECTION_SOURCES
      };
    },

    async recordFeedback(input: RecordFeedbackInput) {
      validateRecordFeedbackInput(input);
      const source = input.source ?? { client: "moryn" };
      const identity = mutationIdempotency("memory_feedback", input.idempotency_key, {
        record_id: input.record_id,
        outcome: input.outcome,
        occurred_at: input.occurred_at ?? null,
        source
      });
      const existing = await existingIdempotentMutation(identity, "memory_feedback", ["record_feedback"]);
      if (existing) {
        const receipt = await commitMutationEvent(existing, "memory_feedback");
        if (receipt.event.op !== "record_feedback") {
          throw new Error("Committed memory feedback event is not a record_feedback event");
        }
        const record = await requireRecord(receipt.event.record_id);
        return {
          ...receipt,
          usage: buildMemoryRetentionView(record).usage,
          selection_sources: RECORD_FEEDBACK_SELECTION_SOURCES
        };
      }

      const record = await requireRecord(input.record_id);
      const event: Extract<MorynEvent, { op: "record_feedback" }> = {
        event_id: identity.event_id!,
        op: "record_feedback",
        record_id: input.record_id,
        outcome: input.outcome,
        created_at: nextMutationTimestamp(record, input.occurred_at ?? now()),
        source,
        idempotency: identity.metadata!
      };
      applyRecordFeedback(record, event);
      const receipt = await commitMutationEvent(event, "memory_feedback");
      if (receipt.event.op !== "record_feedback") {
        throw new Error("Committed memory feedback event is not a record_feedback event");
      }
      const projected = await requireRecord(event.record_id);
      return {
        ...receipt,
        usage: buildMemoryRetentionView(projected).usage,
        selection_sources: RECORD_FEEDBACK_SELECTION_SOURCES
      };
    },

    async write(input: WriteInput) {
      validateWriteInput(input);
      const writeInput = input as ValidatedWriteInput;
      const createdAt = now();
      const tags = Array.isArray(writeInput.tags) ? writeInput.tags : [];
      const inputContent = input.content as Record<string, unknown> & { text?: string; format?: "text" | "json" };
      const identity = mutationIdempotency("write", writeInput.idempotency_key, {
        kind: writeInput.kind,
        type: writeInput.type,
        scope: writeInput.scope,
        project_id: writeInput.project_id,
        tags,
        content: inputContent,
        state: writeInput.state,
        confidence: writeInput.confidence,
        priority: writeInput.priority,
        source: writeInput.source,
        confirmed: writeInput.confirmed,
        provenance: writeInput.provenance
      });
      const existingWrite = await existingIdempotentMutation(identity, "write", ["upsert_record"]);
      if (existingWrite) {
        const receipt = await commitMutationEvent(existingWrite, "write");
        if (receipt.event.op !== "upsert_record") throw new Error("Committed write event is not an upsert_record");
        const replayWarning: EngineWarning | undefined =
          receipt.event.record.state === "quarantined"
            ? { code: "SENSITIVE_CONTENT_DETECTED", reason: "sensitive content was redacted" }
            : writeInput.state === "canonical" && receipt.event.record.state === "candidate"
              ? {
                  code: "CONFIRMATION_REQUIRED",
                  reason: receipt.event.record.conflict
                    ? "conflicting canonical memory requires explicit user confirmation"
                    : "canonical state requires explicit user confirmation",
                  next_action: promoteCandidateNextAction(receipt.event.record.id)
                }
              : undefined;
        return {
          record: receipt.event.record,
          ...receipt,
          selection_sources: WRITE_SELECTION_SOURCES,
          warning: replayWarning
        };
      }
      const sensitive = detectSensitiveContent(sensitiveScanText(inputContent));
      const conflicts = sensitive.sensitive
        ? []
        : semanticConflicts(await currentRecords(), {
            ...writeInput,
            id: identity.record_id,
            tags,
            content: inputContent
          });
      const needsConflictConfirmation =
        writeInput.state === "canonical" &&
        conflicts.length > 0 &&
        !isUserConfirmed(writeInput.source, writeInput.confirmed);
      const needsConfirmation =
        writeInput.state === "canonical" &&
        (requiresCanonicalConfirmation(writeInput) || conflicts.length > 0) &&
        !isUserConfirmed(writeInput.source, writeInput.confirmed);
      const state = sensitive.sensitive
        ? "quarantined"
        : needsConfirmation
          ? "candidate"
          : (writeInput.state ?? (writeInput.kind === "agent_note" ? "raw" : "candidate"));
      const content = sensitive.sensitive ? redactSensitiveRecordContent(inputContent) : inputContent;
      const confidence = typeof writeInput.confidence === "number" ? writeInput.confidence : 0.5;
      const provenance = writeInput.provenance as RecordProvenance | undefined;
      const record: MorynRecord = {
        id: identity.record_id ?? id("rec"),
        kind: writeInput.kind,
        type: writeInput.type,
        scope: writeInput.scope,
        project_id: writeInput.project_id,
        tags,
        content,
        state,
        confidence,
        priority: writeInput.priority ?? "normal",
        visibility: state === "quarantined" ? "quarantined" : state === "archived" ? "archived" : "active",
        created_at: createdAt,
        updated_at: createdAt,
        source: writeInput.source,
        provenance: {
          ...(provenance ?? {}),
          method: provenance?.method ?? provenanceMethod(writeInput.source, writeInput.confirmed)
        },
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined
      };
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "upsert_record",
        record,
        created_at: createdAt,
        source: writeInput.source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      const receipt = await commitMutationEvent(event, "write");
      if (receipt.event.op !== "upsert_record") throw new Error("Committed write event is not an upsert_record");
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
        record: receipt.event.record,
        ...receipt,
        selection_sources: WRITE_SELECTION_SOURCES,
        warning
      };
    },

    async consolidateExactDuplicates(input: ExactDuplicateConsolidationInput = {}) {
      if (input.include_private !== undefined && typeof input.include_private !== "boolean") {
        throw new Error("Invalid argument: consolidate exact duplicates include_private must be a boolean");
      }
      if (
        input.record_kinds !== undefined &&
        (!Array.isArray(input.record_kinds) ||
          input.record_kinds.some((kind) => !RECORD_KINDS.includes(kind as (typeof RECORD_KINDS)[number])))
      ) {
        throw new Error(
          `Invalid argument: consolidate exact duplicates record_kinds must use ${RECORD_KINDS.join(", ")}`
        );
      }
      if (input.active_logical_only !== undefined && typeof input.active_logical_only !== "boolean") {
        throw new Error("Invalid argument: consolidate exact duplicates active_logical_only must be a boolean");
      }
      if (input.skip_conflicted !== undefined && typeof input.skip_conflicted !== "boolean") {
        throw new Error("Invalid argument: consolidate exact duplicates skip_conflicted must be a boolean");
      }
      if (input.exclude_global !== undefined && typeof input.exclude_global !== "boolean") {
        throw new Error("Invalid argument: consolidate exact duplicates exclude_global must be a boolean");
      }
      const includePrivate = input.include_private === true;
      const allRecords = await currentRecords();
      const logicalView = buildActiveLogicalMemoryView(allRecords);
      const activeLogicalRecordIds = input.active_logical_only
        ? new Set(logicalView.active_records.map((record) => record.id))
        : undefined;
      const conflictedRecordIds = input.skip_conflicted ? new Set(logicalView.conflict_record_ids) : undefined;
      const recordKinds = input.record_kinds ? new Set(input.record_kinds) : undefined;
      const records = allRecords
        .filter(
          (record) => record.visibility === "active" && record.state !== "archived" && record.state !== "quarantined"
        )
        .filter((record) => !input.project_id || record.project_id === input.project_id)
        .filter((record) => !input.exclude_global || record.scope !== "global")
        .filter((record) => includePrivate || !isPrivateRecord(record))
        .filter((record) => !recordKinds || recordKinds.has(record.kind))
        .filter((record) => !activeLogicalRecordIds || activeLogicalRecordIds.has(record.id))
        .filter(
          (record) =>
            !conflictedRecordIds ||
            (!conflictedRecordIds.has(record.id) && record.conflict?.resolution !== "needs_review")
        );
      const recordsByFingerprint = new Map<string, MorynRecord[]>();
      for (const record of records) {
        const fingerprint = logicalMemoryFingerprint(record);
        recordsByFingerprint.set(fingerprint, [...(recordsByFingerprint.get(fingerprint) ?? []), record]);
      }
      const groups = [...recordsByFingerprint.values()]
        .filter((group) => group.length > 1)
        .map((group) => {
          const ordered = [...group].sort(compareLogicalMemoryTargets);
          const target = ordered[0] as MorynRecord;
          const duplicates = ordered.slice(1).sort((left, right) => compareCodeUnits(left.id, right.id));
          return { target, duplicates };
        })
        .sort((left, right) => compareCodeUnits(left.target.id, right.target.id));
      let linksCreated = 0;
      let linksExisting = 0;
      const source = input.source ?? { client: "moryn" };
      for (const group of groups) {
        for (const duplicate of group.duplicates) {
          const exists =
            duplicate.links?.some((link) => link.link_type === "duplicate_of" && link.record_id === group.target.id) ??
            false;
          if (exists) {
            linksExisting += 1;
            continue;
          }
          const event: MorynEvent = {
            event_id: duplicateLinkEventId(duplicate.id, group.target.id),
            op: "link_records",
            record_id: duplicate.id,
            linked_record_id: group.target.id,
            link_type: "duplicate_of",
            reason: EXACT_DUPLICATE_LINK_REASON,
            created_at: exactDuplicateLinkTimestamp(duplicate, group.target),
            source
          };
          const appended = await appendIdempotentEvent(deps.storePath, event);
          if (appended.created) linksCreated += 1;
          else linksExisting += 1;
        }
      }
      if (linksCreated > 0) await rebuildDerivedViews(deps.storePath);
      return {
        groups_found: groups.length,
        links_created: linksCreated,
        links_existing: linksExisting,
        groups: groups.map((group) => ({
          target_record_id: group.target.id,
          duplicate_record_ids: group.duplicates.map((record) => record.id)
        }))
      };
    },

    async consolidateSemanticProposals(
      input: ConsolidateSemanticProposalsInput
    ): Promise<SemanticConsolidationReceipt> {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid argument: semantic consolidation input must be an object");
      if (!Array.isArray(input.proposals))
        throw new Error("Invalid argument: semantic consolidation proposals must be an array");
      if (input.proposals.length > 24)
        throw new Error("Invalid argument: semantic consolidation proposals must contain at most 24 items");
      if (input.include_private !== undefined && typeof input.include_private !== "boolean")
        throw new Error("Invalid argument: semantic consolidation include_private must be a boolean");
      const proposals = input.proposals.map((proposal) =>
        semanticConsolidationProposalSchema.parse(proposal)
      ) as SemanticConsolidationProposal[];
      const proposalResults: SemanticConsolidationProposalResult[] = [];
      let legacyLinksCreated = 0;
      const source = input.source ?? { client: "moryn" };

      for (const proposal of proposals) {
        if (proposal.structured_merge && proposal.relationship !== "conflicts_with") {
          proposalResults.push(await consolidateStructuredSemanticProposal(proposal, input));
          continue;
        }
        const records = await currentRecords();
        const validation = validateSemanticConsolidationProposal(records, proposal, {
          include_private: input.include_private === true
        });
        if (input.project_id) {
          const sourceRecord = records.find((record) => record.id === validation.source_record_id);
          const targetRecord = records.find((record) => record.id === validation.target_record_id);
          if (
            (sourceRecord?.scope === "project" && sourceRecord.project_id !== input.project_id) ||
            (targetRecord?.scope === "project" && targetRecord.project_id !== input.project_id)
          ) {
            proposalResults.push({ ...validation, status: "rejected", reason: "incompatible_domain" });
            continue;
          }
        }
        if (validation.status === "rejected") {
          proposalResults.push(validation);
          continue;
        }
        const eventId = semanticConsolidationEventId(
          validation.source_record_id,
          validation.target_record_id,
          validation.relationship
        );
        if (validation.status === "idempotent") {
          proposalResults.push({ ...validation, event_id: eventId });
          continue;
        }
        const sourceRecord = records.find((record) => record.id === validation.source_record_id);
        const targetRecord = records.find((record) => record.id === validation.target_record_id);
        if (!sourceRecord || !targetRecord) {
          proposalResults.push({ ...validation, status: "rejected", reason: "missing_record" });
          continue;
        }
        const event: MorynEvent = {
          event_id: eventId,
          op: "link_records",
          record_id: validation.source_record_id,
          linked_record_id: validation.target_record_id,
          link_type: validation.relationship,
          reason: proposal.rationale,
          created_at: nextRelationshipTimestamp(sourceRecord, targetRecord, input.occurred_at ?? now()),
          source
        };
        try {
          const appended = await appendIdempotentEvent(deps.storePath, event);
          if (
            appended.event.op !== "link_records" ||
            appended.event.record_id !== event.record_id ||
            appended.event.linked_record_id !== event.linked_record_id ||
            appended.event.link_type !== event.link_type
          ) {
            throw new Error("semantic consolidation idempotency collision");
          }
          if (appended.created) {
            legacyLinksCreated += 1;
            proposalResults.push({ ...validation, event_id: eventId });
          } else {
            proposalResults.push({
              ...validation,
              status: "idempotent",
              reason: "existing_relationship",
              event_id: eventId
            });
          }
        } catch {
          proposalResults.push({ ...validation, status: "failed", reason: "persistence_failed", event_id: eventId });
        }
      }
      if (legacyLinksCreated > 0) await rebuildDerivedViews(deps.storePath);
      return semanticConsolidationReceipt(proposalResults);
    },

    async consolidateLearningProposals(
      input: ConsolidateLearningProposalsInput
    ): Promise<SemanticConsolidationReceipt> {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid argument: learning consolidation input must be an object");
      if (!Array.isArray(input.proposals))
        throw new Error("Invalid argument: semantic consolidation proposals must be an array");
      if (
        !Array.isArray(input.source_record_ids) ||
        input.source_record_ids.some((recordId) => typeof recordId !== "string" || !recordId.trim())
      )
        throw new Error("Invalid argument: semantic consolidation source_record_ids must be non-empty strings");
      const proposals = input.proposals.map((proposal) =>
        semanticConsolidationProposalSchema.parse(proposal)
      ) as SemanticConsolidationProposal[];
      if (!proposals.length) return semanticConsolidationReceipt([]);
      try {
        const sourceRecordIds = [...new Set(input.source_record_ids.map((recordId) => recordId.trim()))];
        const records = await currentRecords();
        const recordsById = new Map(records.map((record) => [record.id, record]));
        const candidates = retrieveSemanticConsolidationCandidates(records, {
          source_record_ids: sourceRecordIds,
          include_private: input.include_private === true,
          per_source_limit: 8,
          total_limit: 24
        });
        const allowedTargetsBySource = new Map(
          Object.entries(candidates.candidates_by_source_record_id).map(([sourceRecordId, items]) => [
            sourceRecordId,
            new Set(items.map((item) => item.record_id))
          ])
        );
        const bounded: SemanticConsolidationProposal[] = [];
        const rejected: SemanticConsolidationProposalResult[] = [];
        for (const proposal of proposals) {
          const existingLink = recordsById
            .get(proposal.source_record_id)
            ?.links?.some(
              (link) => link.record_id === proposal.target_record_id && link.link_type === proposal.relationship
            );
          if (
            !sourceRecordIds.includes(proposal.source_record_id) ||
            (!existingLink && !allowedTargetsBySource.get(proposal.source_record_id)?.has(proposal.target_record_id))
          ) {
            rejected.push({
              status: "rejected",
              reason: "candidate_not_bounded",
              source_record_id: proposal.source_record_id,
              target_record_id: proposal.target_record_id,
              relationship: proposal.relationship,
              proposal_digest: semanticConsolidationProposalDigest(proposal)
            });
          } else {
            bounded.push(proposal);
          }
        }
        const persisted = bounded.length
          ? await engine.consolidateSemanticProposals({
              proposals: bounded,
              project_id: input.project_id,
              include_private: input.include_private,
              source: input.source,
              occurred_at: input.occurred_at
            })
          : semanticConsolidationReceipt([]);
        return semanticConsolidationReceipt([...persisted.proposal_results, ...rejected]);
      } catch {
        return semanticConsolidationReceipt(
          proposals.map((proposal) => ({
            status: "failed",
            reason: "pipeline_failed",
            source_record_id: proposal.source_record_id,
            target_record_id: proposal.target_record_id,
            relationship: proposal.relationship,
            proposal_digest: semanticConsolidationProposalDigest(proposal)
          }))
        );
      }
    },

    async revise(input: RevisionInput) {
      validateRevisionInput(input);
      const revisionInput = input as ValidatedRevisionInput;
      const patch = input.patch as Record<string, unknown>;
      const managedPath = Object.keys(patch).find((path) => managedRevisionFields.has(path.split(".")[0] as string));
      if (managedPath !== undefined) {
        throw managedRevisionFieldError(managedPath, patch[managedPath], revisionInput.record_id);
      }
      const source = input.source ?? { client: "moryn" };
      const request = {
        record_id: revisionInput.record_id,
        patch,
        reason: revisionInput.reason,
        confirmed: input.confirmed,
        source
      };
      const sensitiveIdempotencyKey =
        revisionInput.idempotency_key ?? derivedIdempotencyKey("sensitive_revise", request);
      let identity = mutationIdempotency("revise", sensitiveIdempotencyKey, request);
      let quarantineIdentity = mutationIdempotency("revise_quarantine", sensitiveIdempotencyKey, request);
      const replayCommittedRevision = async () => {
        const existingRevision = await existingIdempotentMutation(identity, "revise", ["revise_record"]);
        if (!existingRevision) return undefined;
        if (existingRevision.op !== "revise_record") throw new Error("Committed revise event is not a revise_record");
        const existingQuarantine = await existingIdempotentMutation(quarantineIdentity, "revise", [
          "quarantine_record"
        ]);
        const legacySensitiveReplay =
          !existingQuarantine &&
          existingRevision.redaction === undefined &&
          (await revisionContentWasSensitiveWhenCommitted(existingRevision, patch));
        const sensitiveReplay =
          Boolean(existingQuarantine) ||
          existingRevision.redaction?.kind === "sensitive_content" ||
          legacySensitiveReplay;
        if (!sensitiveReplay) {
          const receipt = await commitMutationEvent(existingRevision, "revise");
          return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
        }
        const quarantineEvent: MorynEvent =
          existingQuarantine ??
          ({
            event_id: quarantineIdentity.event_id!,
            op: "quarantine_record",
            record_id: revisionInput.record_id,
            reason: "SENSITIVE_CONTENT_DETECTED",
            created_at: new Date(Date.parse(existingRevision.created_at) + 1).toISOString(),
            source: existingRevision.source,
            idempotency: quarantineIdentity.metadata!
          } satisfies MorynEvent);
        const receipt = await commitMutationEvents(
          [existingRevision, quarantineEvent],
          "revise",
          revisionInput.idempotency_key === undefined ? "same_request" : "same_key"
        );
        return {
          ...receipt,
          event: receipt.events[0],
          quarantine_event: receipt.events[1],
          selection_sources: SENSITIVE_REVISE_SELECTION_SOURCES,
          warning: { code: "SENSITIVE_CONTENT_DETECTED", reason: "sensitive content was redacted" }
        };
      };
      const existingReceipt = await replayCommittedRevision();
      if (existingReceipt) return existingReceipt;
      const record = await requireRecord(revisionInput.record_id);
      if (isProjectAliasAttestationControlRecord(record)) {
        throw new Error("Invalid argument: project alias attestation records cannot be revised");
      }
      const createdAt = nextMutationTimestamp(record, now());
      const patched = applyRecordPatch(record, patch);
      try {
        parseRecord(patched);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw invalidRevisionRecordPatchError(patch, message);
      }
      const sensitive = detectSensitiveContent(sensitiveScanText(patched.content));
      if (!sensitive.sensitive && revisionInput.idempotency_key === undefined) {
        identity = mutationIdempotency("revise", undefined, request);
        quarantineIdentity = mutationIdempotency("revise_quarantine", undefined, request);
      }
      const conflicts =
        !sensitive.sensitive && patched.state === "canonical" ? semanticConflicts(await currentRecords(), patched) : [];
      if (conflicts.length > 0 && !isUserConfirmed(source, input.confirmed)) {
        throw new Error("Confirmation required: conflicting canonical memory requires explicit user confirmation");
      }
      const eventPatch = sensitive.sensitive ? redactSensitivePatch(patch) : patch;
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "revise_record",
        record_id: revisionInput.record_id,
        patch: eventPatch,
        reason: revisionInput.reason,
        confirmed: input.confirmed,
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined,
        ...(sensitive.sensitive ? { redaction: { kind: "sensitive_content" as const, applied: true as const } } : {}),
        created_at: createdAt,
        source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      if (!sensitive.sensitive) {
        const receipt = await commitMutationEvent(event, "revise");
        return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
      }

      const revisedRecord = { ...record, updated_at: createdAt };
      const quarantineCreatedAt = nextMutationTimestamp(revisedRecord, now());
      const quarantineEvent: MorynEvent = {
        event_id: quarantineIdentity.event_id ?? id("evt"),
        op: "quarantine_record",
        record_id: revisionInput.record_id,
        reason: "SENSITIVE_CONTENT_DETECTED",
        created_at: quarantineCreatedAt,
        source,
        ...(quarantineIdentity.metadata ? { idempotency: quarantineIdentity.metadata } : {})
      };
      const receipt = await commitMutationEvents(
        [event, quarantineEvent],
        "revise",
        revisionInput.idempotency_key === undefined ? "same_request" : "same_key"
      );
      return {
        ...receipt,
        event: receipt.events[0],
        quarantine_event: receipt.events[1],
        selection_sources: SENSITIVE_REVISE_SELECTION_SOURCES,
        warning: { code: "SENSITIVE_CONTENT_DETECTED", reason: sensitive.reason }
      };
    },

    async promote(input: PromoteInput) {
      validatePromoteInput(input);
      const promoteInput = input as ValidatedPromoteInput;
      const source = input.source ?? { client: "moryn" };
      const identity = mutationIdempotency("promote", promoteInput.idempotency_key, {
        record_id: promoteInput.record_id,
        target_state: promoteInput.target_state,
        reason: promoteInput.reason,
        confirmed: input.confirmed,
        source
      });
      const existingPromotion = await existingIdempotentMutation(identity, "promote", ["promote_record"]);
      if (existingPromotion) {
        const receipt = await commitMutationEvent(existingPromotion, "promote");
        return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
      }
      const record = await requireRecord(promoteInput.record_id);
      if (isProjectAliasAttestationControlRecord(record) && promoteInput.target_state !== "canonical") {
        throw new Error("Invalid argument: project alias attestations can only be promoted to canonical");
      }
      const conflicts =
        promoteInput.target_state === "canonical" ? semanticConflicts(await currentRecords(), record) : [];
      if (
        promoteInput.target_state === "canonical" &&
        requiresCanonicalConfirmation(record) &&
        !isUserConfirmed(source, input.confirmed)
      ) {
        throw new Error("Confirmation required: canonical state requires explicit user confirmation");
      }
      if (
        promoteInput.target_state === "canonical" &&
        conflicts.length > 0 &&
        !isUserConfirmed(source, input.confirmed)
      ) {
        throw new Error("Confirmation required: conflicting canonical memory requires explicit user confirmation");
      }
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "promote_record",
        record_id: promoteInput.record_id,
        target_state: promoteInput.target_state,
        reason: promoteInput.reason,
        confirmed: input.confirmed,
        conflict: conflicts.length
          ? { kind: "semantic", with: conflicts.map((record) => record.id), resolution: "needs_review" }
          : undefined,
        created_at: createdAt,
        source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      const receipt = await commitMutationEvent(event, "promote");
      return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
    },

    async archive(input: StateChangeInput) {
      validateStateChangeInput(input, "archive input", "archive");
      const stateInput = input as ValidatedStateChangeInput;
      const source = input.source ?? { client: "moryn" };
      const identity = mutationIdempotency("archive", stateInput.idempotency_key, {
        record_id: stateInput.record_id,
        reason: stateInput.reason,
        source
      });
      const existingArchive = await existingIdempotentMutation(identity, "archive", ["archive_record"]);
      if (existingArchive) {
        const receipt = await commitMutationEvent(existingArchive, "archive");
        return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
      }
      const record = await requireRecord(stateInput.record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "archive_record",
        record_id: stateInput.record_id,
        reason: stateInput.reason,
        created_at: createdAt,
        source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      const receipt = await commitMutationEvent(event, "archive");
      return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
    },

    async quarantine(input: StateChangeInput) {
      validateStateChangeInput(input, "quarantine input", "quarantine");
      const stateInput = input as ValidatedStateChangeInput;
      const source = input.source ?? { client: "moryn" };
      const identity = mutationIdempotency("quarantine", stateInput.idempotency_key, {
        record_id: stateInput.record_id,
        reason: stateInput.reason,
        source
      });
      const existingQuarantine = await existingIdempotentMutation(identity, "quarantine", ["quarantine_record"]);
      if (existingQuarantine) {
        const receipt = await commitMutationEvent(existingQuarantine, "quarantine");
        return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
      }
      const record = await requireRecord(stateInput.record_id);
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "quarantine_record",
        record_id: stateInput.record_id,
        reason: stateInput.reason,
        created_at: createdAt,
        source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      const receipt = await commitMutationEvent(event, "quarantine");
      return { ...receipt, selection_sources: MUTATION_EVENT_SELECTION_SOURCES };
    },

    async link(input: LinkInput) {
      validateLinkInput(input);
      const linkInput = input as ValidatedLinkInput;
      const source = input.source ?? { client: "moryn" };
      const identity = mutationIdempotency("link", linkInput.idempotency_key, {
        record_id: linkInput.record_id,
        linked_record_id: linkInput.linked_record_id,
        link_type: linkInput.link_type,
        source
      });
      const existingLink = await existingIdempotentMutation(identity, "link", ["link_records"]);
      if (existingLink) {
        const receipt = await commitMutationEvent(existingLink, "link");
        return { ...receipt, selection_sources: LINK_EVENT_SELECTION_SOURCES };
      }
      const record = await requireRecord(linkInput.record_id);
      const linkedRecord = await requireRecord(linkInput.linked_record_id);
      if (isProjectAliasAttestationControlRecord(record) || isProjectAliasAttestationControlRecord(linkedRecord)) {
        throw new Error("Invalid argument: project alias attestation records cannot be linked");
      }
      const createdAt = nextMutationTimestamp(record, now());
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "link_records",
        record_id: linkInput.record_id,
        linked_record_id: linkInput.linked_record_id,
        link_type: linkInput.link_type,
        created_at: createdAt,
        source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      const receipt = await commitMutationEvent(event, "link");
      return { ...receipt, selection_sources: LINK_EVENT_SELECTION_SOURCES };
    },

    async logicalLink(input: LogicalLinkInput) {
      validateIdempotencyKey(input.idempotency_key, "logical_link");
      const source = input.source ?? { client: "moryn" };
      const identity = mutationIdempotency("logical_link", input.idempotency_key as string | undefined, {
        record_id: input.record_id,
        linked_record_id: input.linked_record_id,
        relationship: input.relationship,
        reason: input.reason,
        source
      });
      const existingLogicalLink = await existingIdempotentMutation(identity, "logical_link", ["link_records"]);
      if (existingLogicalLink) {
        if (existingLogicalLink.op !== "link_records") {
          throw new Error("Committed logical link event is not a link_records event");
        }
        const receipt = await commitMutationEvent(existingLogicalLink, "logical_link");
        return {
          ...receipt,
          relationship: existingLogicalLink.link_type as LogicalRelationshipType,
          direction: existingLogicalLink.link_type === "conflicts_with" ? "symmetric" : "directed",
          reason: existingLogicalLink.reason,
          selection_sources: LINK_EVENT_SELECTION_SOURCES
        };
      }
      const records = await currentRecords();
      const requestedRecords = records.filter(
        (record) => record.id === input.record_id || record.id === input.linked_record_id
      );
      if (requestedRecords.some(isProjectAliasAttestationControlRecord)) {
        throw new Error("Invalid argument: project alias attestation records cannot be linked");
      }
      const validated = validateLogicalRelationship(records, {
        record_id: input.record_id as string,
        linked_record_id: input.linked_record_id as string,
        relationship: input.relationship as LogicalRelationshipType,
        reason: input.reason as string
      });
      const createdAt = nextMutationTimestamp(validated.record, now());
      const event: MorynEvent = {
        event_id: identity.event_id ?? id("evt"),
        op: "link_records",
        record_id: validated.record.id,
        linked_record_id: validated.linked_record.id,
        link_type: validated.relationship,
        reason: validated.reason,
        created_at: createdAt,
        source,
        ...(identity.metadata ? { idempotency: identity.metadata } : {})
      };
      const receipt = await commitMutationEvent(event, "logical_link");
      return {
        ...receipt,
        relationship: validated.relationship,
        direction: validated.direction,
        reason: validated.reason,
        selection_sources: LINK_EVENT_SELECTION_SOURCES
      };
    },

    async recall(input: RecallInput) {
      validateRecallInput(input);
      const recallInput = {
        ...input,
        record_ids: Array.isArray(input.record_ids) ? input.record_ids : undefined,
        kinds: Array.isArray(input.kinds) ? input.kinds : undefined,
        scopes: Array.isArray(input.scopes) ? input.scopes : undefined,
        types: Array.isArray(input.types) ? input.types : undefined,
        states: Array.isArray(input.states) ? input.states : undefined,
        tags: Array.isArray(input.tags) ? input.tags : undefined,
        files: Array.isArray(input.files) ? input.files : undefined,
        include_private: input.include_private === true
      } as ValidatedRecallInput;
      for (const recordId of recallInput.record_ids ?? []) {
        await requireRecord(recordId);
      }
      const limit = validateLimit(recallInput.limit, 10, "recall");
      const useRetrievalIndex = Boolean(
        recallInput.project_id && !recallInput.record_ids?.length && !includesHiddenState(recallInput)
      );
      let retrieval = useRetrievalIndex
        ? await readCandidates(deps.storePath, {
            project_id: recallInput.project_id!,
            read_current_records: readRecords
          })
        : undefined;
      const current = retrieval ? undefined : await readRecords(deps.storePath);
      const availableRecords =
        retrieval?.records ??
        (recallInput.record_ids?.length || includesHiddenState(recallInput)
          ? current!.records
          : buildActiveLogicalMemoryView(current!.records).active_records);
      const recallTime = now();
      let active = activeRecallSelection({
        recall: recallInput,
        available_records: availableRecords,
        retrieval,
        limit,
        now: recallTime
      });
      const shouldRecoverHistory = Boolean(
        recallInput.query &&
          shouldRecoverHistoricalRecall(active.outcome) &&
          !recallInput.record_ids?.length &&
          !recallInput.states?.length
      );
      let historicalRecords: CurrentRecordReadResult | undefined;
      let historicalRecovery: HistoricalRecallRecovery | undefined;
      if (shouldRecoverHistory) {
        let historicalTrigger =
          active.outcome?.status === "verification_required"
            ? ("active_working_set_verification_required" as const)
            : ("active_working_set_knowledge_gap" as const);
        const historicalMaxRecords = Math.min(limit, 3);
        try {
          historicalRecords = current ?? (await readRecords(deps.storePath));
          if (retrieval && !sameRecallManifest(retrieval.event_manifest, historicalRecords.event_manifest)) {
            const refreshedRetrieval = await readCandidates(deps.storePath, {
              project_id: recallInput.project_id!,
              read_current_records: readRecords
            });
            if (!sameRecallManifest(refreshedRetrieval.event_manifest, historicalRecords.event_manifest)) {
              throw new Error("Recall snapshots changed during bounded historical recovery");
            }
            retrieval = refreshedRetrieval;
            active = activeRecallSelection({
              recall: recallInput,
              available_records: refreshedRetrieval.records,
              retrieval,
              limit,
              now: recallTime
            });
            historicalTrigger =
              active.outcome?.status === "verification_required"
                ? "active_working_set_verification_required"
                : "active_working_set_knowledge_gap";
          }
          if (shouldRecoverHistoricalRecall(active.outcome)) {
            historicalRecovery = recoverHistoricalRecall({
              records: historicalRecords.records,
              active_working_set_record_ids: active.logicalRecords.map((record) => record.id),
              query: recallInput.query!,
              project_id: recallInput.project_id,
              kinds: recallInput.kinds,
              scopes: recallInput.scopes,
              types: recallInput.types,
              tags: recallInput.tags,
              files: recallInput.files,
              include_private: recallInput.include_private,
              trigger: historicalTrigger,
              max_records: historicalMaxRecords,
              now: recallTime,
              excluded_record_ids: historicalRecords.records
                .filter(
                  (record) =>
                    isManagedSoulProfileRecord(record) && !recallInput.types?.includes(SOUL_PROFILE_RECORD_TYPE)
                )
                .map((record) => record.id)
            });
          }
        } catch {
          historicalRecords = undefined;
          historicalRecovery = unavailableHistoricalRecall({
            include_private: recallInput.include_private,
            trigger: historicalTrigger,
            max_records: historicalMaxRecords
          });
        }
      }
      const { bounded, outcome: activeOutcome, rankedRecords, retrievalEvidence } = active;
      const recoveredBest = historicalRecovery?.matches[0];
      const historicalIsBest = Boolean(
        recoveredBest &&
          (activeOutcome?.status === "knowledge_gap" ||
            (!recoveredBest.stale && recoveredBest.coverage > (activeOutcome?.coverage ?? 0)))
      );
      const outcome =
        historicalIsBest && recoveredBest
          ? {
              status: "verification_required" as const,
              best_record_id: recoveredBest.record_id,
              best_score: recoveredBest.score,
              coverage: recoveredBest.coverage,
              trust: "limited" as const,
              stale: recoveredBest.stale,
              recommended_action: "verify_then_use_or_learn" as const,
              best_result_source: "historical_recovery" as const,
              best_result_path: `historical_recovery.matches_by_record_id.${recoveredBest.record_id}`
            }
          : activeOutcome
            ? {
                ...activeOutcome,
                best_result_source: activeOutcome.best_record_id ? ("results" as const) : ("none" as const),
                ...(activeOutcome.best_record_id
                  ? { best_result_path: `results_by_id.${activeOutcome.best_record_id}` }
                  : {})
              }
            : undefined;
      const records = activeOutcome?.status === "knowledge_gap" ? [] : rankedRecords;
      const recoveryExpansionRoot =
        historicalIsBest && recoveredBest
          ? recoveredBest.covered_by_record_ids
              .map((recordId) => historicalRecords?.records.find((record) => record.id === recordId))
              .find((record) => record && recallRollupType(record.type))?.id
          : undefined;
      const expandableRecordId =
        records.find((result) => recallRollupType(result.record.type))?.record.id ?? recoveryExpansionRoot;
      const actionContract = outcome
        ? buildRecallNextActions({
            query: recallInput.query ?? "",
            outcome,
            include_private: recallInput.include_private,
            expandable_record_id: expandableRecordId,
            historical_recovery_record_ids: historicalIsBest
              ? historicalRecovery?.upgrade.evidence_record_ids
              : undefined
          })
        : undefined;
      return {
        results: records,
        ...(retrievalEvidence ? { retrieval: retrievalEvidence } : {}),
        ...(bounded ? { memory_working_set: bounded.report } : {}),
        ...(historicalRecovery ? { historical_recovery: historicalRecovery } : {}),
        ...(outcome ? { outcome } : {}),
        ...(actionContract ? actionContract : {}),
        selection_sources: RECALL_SELECTION_SOURCES,
        results_by_id: Object.fromEntries(records.map((result) => [result.record.id, result]))
      };
    },

    async timeline(input: TimelineInput) {
      validateTimelineInput(input);
      const timelineInput = {
        ...input,
        before: validateTimelineWindow(input.before, 5, "before"),
        after: validateTimelineWindow(input.after, 5, "after"),
        include_private: input.include_private === true
      } as ValidatedTimelineInput;
      const events = await readEvents(deps.storePath);
      const recordsMap = replayEvents(events);
      const records = [...recordsMap.values()].filter((record) =>
        isAllowedByPrivateBoundary(record, timelineInput.include_private)
      );
      const orderedEvents = sortedTimelineEvents(events, recordsMap, timelineInput);
      const anchor = timelineAnchor(orderedEvents, records, timelineInput);
      const start = Math.max(0, anchor.index - timelineInput.before);
      const end = Math.min(orderedEvents.length, anchor.index + timelineInput.after + 1);
      const items = orderedEvents.slice(start, end).map((event, offset) => {
        const index = start + offset;
        const recordId = recordIdFromEvent(event);
        const record = event.op === "upsert_record" ? event.record : recordsMap.get(recordId);
        return {
          event_id: event.event_id,
          op: event.op,
          relative: timelineRelative(index, anchor.index),
          created_at: event.created_at,
          record_id: recordId,
          source: event.source,
          summary: record ? summarizeRecord(record) : event.op,
          ...(record
            ? { record: compactRecord(record), next_action: timelineItemNextAction(recordId, timelineInput) }
            : {})
        };
      });
      const itemsByRecordId = createStringKeyedRecord<typeof items>();
      for (const item of items) {
        itemsByRecordId[item.record_id] = [...(itemsByRecordId[item.record_id] ?? []), item];
      }
      return {
        anchor: {
          event_id: anchor.event_id,
          record_id: anchor.record_id,
          source: anchor.source
        },
        items,
        selection_sources: TIMELINE_SELECTION_SOURCES,
        items_by_event_id: stringKeyedRecordFromEntries(items.map((item) => [item.event_id, item] as const)),
        items_by_record_id: itemsByRecordId
      };
    },

    async boot(input: BootInput) {
      validateBootInput(input);
      const bootInput = {
        ...input,
        default_skills: Array.isArray(input.default_skills) ? input.default_skills : undefined,
        include_private: input.include_private === true
      } as ValidatedBootInput;
      const soulProfiles = await readSoulProfileRevisions(deps.storePath, {
        include_legacy_private: bootInput.include_private
      });
      const effectiveSoul = compileEffectiveSoul({
        revisions: soulProfiles.revisions,
        user_profile_id: bootInput.user_profile_id,
        agent_profile_id: bootInput.agent_profile_id,
        project_id: bootInput.project_id,
        char_budget: bootInput.soul_char_budget,
        token_budget: bootInput.soul_token_budget
      });
      const retrieval = bootInput.project_id
        ? await readCandidates(deps.storePath, { project_id: bootInput.project_id, read_current_records: readRecords })
        : undefined;
      const current = retrieval ? undefined : await readRecords(deps.storePath);
      const allCurrentRecords = retrieval?.records ?? current!.records;
      const activeCurrentRecords = retrieval?.records ?? buildActiveLogicalMemoryView(allCurrentRecords).active_records;
      const workingSetEligibleRecords = activeCurrentRecords
        .filter((record) => isVisibleByDefault(record) && !isLearningInboxRecord(record))
        .filter((record) => isAllowedByPrivateBoundary(record, bootInput.include_private))
        .filter((record) => recordBootContextMatches(record, bootInput.project_id))
        .filter((record) => !isManagedSoulProfileRecord(record));
      const memoryWorkingSet = defaultMemoryWorkingSet(workingSetEligibleRecords);
      const visibleRecords = memoryWorkingSet.records;
      const retrievalEvidence = retrieval
        ? boundedRetrievalEvidence(retrieval, visibleRecords, memoryWorkingSet.report)
        : undefined;
      const records = visibleRecords.filter(isTrustedForBoot);
      const recent = [...visibleRecords]
        .filter(isImportantBootRecent)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      const projectMemoryRecords = projectMemory(records, bootInput.project_id);
      const trustedProjectRecords = projectScopedRecords(records, bootInput.project_id);
      const taskRelevant = bootInput.current_task
        ? boundedBootRecords(
            records
              .filter((record) => record.kind === "memory" && record.scope === "project")
              .filter((record) => matchesCurrentTask(record, bootInput.current_task))
          )
        : [];
      const compactTaskRelevant = compactRecords(taskRelevant);
      const userPreferences = compactRecords(
        boundedBootRecords(
          records.filter(
            (record) => record.kind === "memory" && record.scope === "global" && record.type === "preference"
          )
        )
      );
      const soul = compactRecords(
        boundedBootRecords(
          records.filter((record) => record.kind === "soul" && record.type !== SOUL_PROFILE_RECORD_TYPE)
        )
      );
      const globalRules = compactRecords(
        boundedBootRecords(
          records.filter((record) => record.kind === "memory" && record.scope === "global" && record.type === "rule")
        )
      );
      const importantDecisions = compactRecords(
        boundedBootRecords(trustedProjectRecords.filter((record) => record.type === "decision"))
      );
      const warnings = compactRecords(
        boundedBootRecords(
          trustedProjectRecords.filter((record) => record.type === "warning" || record.type === "blocker")
        )
      );
      const skills = compactRecords(boundedBootRecords(bootSkills(records, bootInput)));
      const recentChanges = compactRecords(recent.filter((record) => record.kind !== "soul").slice(0, 5));
      const cursor =
        [...visibleRecords].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.updated_at ??
        new Date().toISOString();
      const remoteUpdates = await remoteHasUpdates();
      const checkpointRecoveryPack =
        bootInput.project_id && bootInput.agent_session_id
          ? buildCheckpointRecoveryPack(allCurrentRecords, {
              project_id: bootInput.project_id,
              session_id: bootInput.agent_session_id,
              include_private: bootInput.include_private
            })
          : undefined;
      const currentRecordsById = new Map(allCurrentRecords.map((record) => [record.id, record]));
      const activeCheckpoint = checkpointRecoveryPack?.source_record_ids
        .map((recordId) => currentRecordsById.get(recordId))
        .filter((record): record is MorynRecord => Boolean(record))
        .filter((record) => bootInput.include_private || !isPrivateRecord(record))
        .filter((record) => Boolean(parseCheckpointContent(record.content)))
        .at(-1);
      return {
        ...(retrievalEvidence ? { retrieval: retrievalEvidence } : {}),
        memory_working_set: memoryWorkingSet.report,
        profile: {
          user_preferences: userPreferences,
          user_preferences_by_id: recordsById(userPreferences),
          soul,
          soul_by_id: recordsById(soul),
          effective_soul: effectiveSoul,
          soul_profile_status: {
            local_saved_revision_ids: soulProfiles.local_revision_ids,
            personal_sync_revision_ids: soulProfiles.personal_sync_revision_ids,
            legacy_record_ids: soulProfiles.legacy_record_ids,
            warnings: soulProfiles.warnings
          },
          global_rules_by_id: recordsById(globalRules),
          global_rules: globalRules
        },
        project: {
          summary: projectSummary(projectMemoryRecords),
          tech_stack: boundedBootTexts(projectMemoryRecords.filter((record) => record.type === "tech_stack")),
          active_goals: boundedBootTexts(
            projectMemoryRecords.filter((record) => record.type === "active_goal" || record.type === "goal")
          ),
          important_decisions: importantDecisions,
          important_decisions_by_id: recordsById(importantDecisions),
          warnings,
          warnings_by_id: recordsById(warnings)
        },
        skills,
        skills_by_id: recordsById(skills),
        task_relevant: compactTaskRelevant,
        task_relevant_by_id: recordsById(compactTaskRelevant),
        recent_changes: recentChanges,
        recent_changes_by_id: recordsById(recentChanges),
        ...(bootInput.agent_session_id
          ? { active_checkpoint: activeCheckpoint, checkpoint_recovery_pack: checkpointRecoveryPack }
          : {}),
        selection_sources: BOOT_SELECTION_SOURCES,
        records_by_id: recordsById([
          ...userPreferences,
          ...soul,
          ...globalRules,
          ...importantDecisions,
          ...warnings,
          ...skills,
          ...compactTaskRelevant,
          ...recentChanges
        ]),
        sync: { cursor, remote_has_updates: remoteUpdates }
      };
    },

    async refresh(input: RefreshInput) {
      validateRefreshInput(input);
      const refreshInput = { ...input, include_private: input.include_private === true } as ValidatedRefreshInput;
      const parsedCursor = refreshInput.cursor ? parseRefreshCursor(refreshInput.cursor) : undefined;
      const limit = validateLimit(input.limit, 20, "refresh");
      const records = buildActiveLogicalMemoryView((await currentRecords()).filter(isVisibleByDefault))
        .active_records.filter((record) => isAllowedByPrivateBoundary(record, refreshInput.include_private))
        .filter((record) => recordBootContextMatches(record, input.project_id))
        .filter((record) => {
          if (!parsedCursor) return true;
          if (parsedCursor.legacy_iso) return record.updated_at >= parsedCursor.position.updated_at;
          return compareRefreshPositions(refreshPosition(record), parsedCursor.position) > 0;
        })
        .sort((left, right) => compareRefreshPositions(refreshPosition(left), refreshPosition(right)));
      const allChanges = records.map((record) => {
        const importance = refreshImportance(record, refreshInput.current_task);
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
      const hasMore = reportableChanges.length > changes.length;
      const cursorRecord = hasMore ? changes.at(-1)?.record : records.at(-1);
      const cursorPosition =
        (cursorRecord ? refreshPosition(cursorRecord) : undefined) ??
        parsedCursor?.position ??
        ({ updated_at: new Date().toISOString(), record_id: "" } satisfies RefreshCursorPosition);
      return {
        cursor: encodeRefreshCursor(cursorPosition),
        has_more: hasMore,
        changes: changes.map((change) => change.change),
        selection_sources: REFRESH_SELECTION_SOURCES,
        changes_by_record_id: Object.fromEntries(changes.map((change) => [change.change.record_id, change.change])),
        should_interrupt: changes.some((change) => change.change.importance === "interrupt")
      };
    },

    async listRecent(input: unknown = 20) {
      const structuredInput = typeof input === "object" && input !== null && !Array.isArray(input);
      const listRecentInput = structuredInput ? (input as ListRecentInput) : { limit: input, all_projects: true };
      validateListRecentInput(listRecentInput);
      const resolvedInput = {
        ...listRecentInput,
        all_projects: listRecentInput.all_projects === true,
        include_private: listRecentInput.include_private === true
      } as ValidatedListRecentInput;
      const records = compactRecords(
        buildActiveLogicalMemoryView((await currentRecords()).filter(isVisibleByDefault))
          .active_records.filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private))
          .filter((record) => resolvedInput.all_projects || recordBootContextMatches(record, resolvedInput.project_id))
          .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || compareCodeUnits(left.id, right.id))
          .slice(0, validateLimit(resolvedInput.limit, 20, "list_recent"))
      );
      return {
        records,
        selection_sources: LIST_RECENT_SELECTION_SOURCES,
        records_by_id: recordsById(records)
      };
    },

    async memoryDoctor(input: MemoryDoctorInput = {}) {
      validateMemoryDoctorInput(input);
      const resolvedInput = {
        ...input,
        include_private: input.include_private === true
      } as ValidatedMemoryDoctorInput;
      const limit = validateLimit(resolvedInput.limit, 20, "memory_doctor");
      const allRecords = await currentRecords();
      const records = allRecords.filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private));
      return diagnoseMemory({
        records,
        project_id: resolvedInput.project_id,
        limit,
        include_private: resolvedInput.include_private,
        excluded_private_records: allRecords.length - records.length
      });
    },

    async memoryMaintenanceShadow(input: MemoryMaintenanceShadowInput = {}) {
      const resolvedInput = validateMemoryMaintenanceShadowInput(input);
      return buildSemanticMaintenanceShadowReport(await currentRecords(), {
        project_id: resolvedInput.project_id,
        include_global: true,
        include_private: resolvedInput.include_private,
        candidate_limit: resolvedInput.candidate_limit,
        minimum_token_overlap: resolvedInput.minimum_token_overlap
      });
    },

    async applyAutomaticSemanticMaintenance(
      input: AutomaticSemanticMaintenanceInput
    ): Promise<AutomaticSemanticMaintenanceResult> {
      const projectId = typeof input?.project_id === "string" ? input.project_id.trim() : "";
      if (!projectId) throw new Error("Automatic semantic maintenance requires project_id");
      if (!input.source || typeof input.source.client !== "string" || !input.source.client.trim())
        throw new Error("Automatic semantic maintenance requires source.client");
      const beforeRecords = await currentRecords();
      const beforeReport = buildSemanticMaintenanceShadowReport(beforeRecords, {
        project_id: projectId,
        include_global: true,
        include_private: false
      });
      const authored = beforeReport.candidates
        .filter((candidate) => candidate.action === "auto_merge_lossless" && candidate.auto_apply_safe)
        .map((candidate) => authorSemanticMaintenanceMergeDraft(beforeRecords, candidate, { project_id: projectId }))
        .filter((draft) => draft.status === "ready" && draft.proposal && draft.plan && draft.projected_record);
      const selected = [] as typeof authored;
      const reserved = new Set<string>();
      for (const draft of authored) {
        if (selected.length >= AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES) break;
        if (draft.source_record_ids.some((recordId) => reserved.has(recordId))) continue;
        draft.source_record_ids.forEach((recordId) => {
          reserved.add(recordId);
        });
        selected.push(draft);
      }
      const committed: AutomaticSemanticMaintenanceResult["committed"] = [];
      const failures: AutomaticSemanticMaintenanceResult["failures"] = [];
      for (const draft of selected) {
        const result = await consolidateStructuredSemanticProposal(draft.proposal!, {
          proposals: [draft.proposal!],
          project_id: projectId,
          include_private: false,
          source: input.source
        });
        if (result.status === "accepted" || result.status === "idempotent") {
          committed.push({
            draft_id: draft.draft_id,
            merged_record_id: draft.merged_record_id!,
            source_record_ids: draft.source_record_ids,
            projected_record_reduction: 1,
            projected_token_reduction: draft.proof.projection.estimated_token_reduction,
            result
          });
        } else {
          failures.push({ draft_id: draft.draft_id, reason: result.reason });
        }
      }
      const afterReport = buildSemanticMaintenanceShadowReport(await currentRecords(), {
        project_id: projectId,
        include_global: true,
        include_private: false
      });
      const before = beforeReport.projection.before;
      const after = afterReport.projection.before;
      const strictRecordDecreaseObserved = committed.length > 0 && after.current_records < before.current_records;
      const strictTokenDecreaseObserved = committed.length > 0 && after.estimated_tokens < before.estimated_tokens;
      if (committed.length > 0 && (!strictRecordDecreaseObserved || !strictTokenDecreaseObserved)) {
        failures.push({ reason: "automatic semantic maintenance postcondition failed" });
      }
      const status =
        committed.length === 0
          ? failures.length > 0
            ? "failed"
            : "skipped"
          : failures.length > 0
            ? "failed"
            : "committed";
      return {
        status,
        project_id: projectId,
        maximum_merges: AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES,
        drafts_ready: authored.length,
        merges_attempted: selected.length,
        merges_committed: committed.length,
        before,
        after,
        committed,
        failures,
        proof: {
          strict_record_decrease_required: true,
          strict_token_decrease_required: true,
          strict_record_decrease_observed: strictRecordDecreaseObserved,
          strict_token_decrease_observed: strictTokenDecreaseObserved,
          source_history_retained: true,
          physical_delete: false
        }
      };
    },

    async memoryLifecycle(input: MemoryLifecycleInput = {}) {
      validateMemoryLifecycleInput(input);
      const resolvedInput = {
        ...input,
        include_private: input.include_private === true,
        now: input.now ?? now()
      } as ValidatedMemoryLifecycleInput;
      const limit = validateLimit(resolvedInput.limit, 20, "memory_lifecycle");
      const allRecords = await currentRecords();
      const records = allRecords
        .filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private))
        .filter((record) => recordProjectMatches(record, resolvedInput.project_id));
      return diagnoseMemoryLifecycle({
        records,
        project_id: resolvedInput.project_id,
        limit,
        include_private: resolvedInput.include_private,
        now: resolvedInput.now,
        private_record_ids: allRecords.filter(isPrivateRecord).map((record) => record.id),
        excluded_private_records:
          allRecords.length -
          allRecords.filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private)).length
      });
    },

    async capturePolicy(input: CapturePolicyInput = {}) {
      validateCapturePolicyInput(input);
      const resolvedInput = {
        ...input,
        include_private: input.include_private === true
      } as ValidatedCapturePolicyInput;
      const limit = validateLimit(resolvedInput.limit, 20, "capture_policy");
      const events = await readEvents(deps.storePath);
      const allRecords = [...replayEvents(events).values()];
      const records = allRecords
        .filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private))
        .filter((record) => !resolvedInput.project_id || record.project_id === resolvedInput.project_id);
      return diagnoseCapturePolicy({
        records,
        events,
        project_id: resolvedInput.project_id,
        limit,
        include_private: resolvedInput.include_private,
        excluded_private_records:
          allRecords.length -
          allRecords.filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private)).length
      });
    },

    async dogfoodReport(input: DogfoodReportInput = {}) {
      validateDogfoodReportInput(input);
      const resolvedInput = {
        ...input,
        include_private: input.include_private === true
      } as ValidatedDogfoodReportInput;
      const limit = validateLimit(resolvedInput.limit, 20, "dogfood_report");
      const events = await readEvents(deps.storePath);
      const allRecords = [...replayEvents(events).values()];
      const records = allRecords
        .filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private))
        .filter((record) => !resolvedInput.project_id || record.project_id === resolvedInput.project_id);
      return diagnoseDogfood({
        records,
        events,
        project_id: resolvedInput.project_id,
        limit,
        include_private: resolvedInput.include_private,
        excluded_private_records:
          allRecords.length -
          allRecords.filter((record) => isAllowedByPrivateBoundary(record, resolvedInput.include_private)).length
      });
    },

    async healthCheck(input: HealthCheckInput = {}) {
      validateHealthCheckInput(input);
      const resolvedInput = {
        ...input,
        include_private: input.include_private === true
      } as ValidatedHealthCheckInput;
      const limit = validateLimit(resolvedInput.limit, 20, "health_check");
      const events = await readEvents(deps.storePath);
      const recordReadModel = await readRecords(deps.storePath);
      const retrievalIndex = resolvedInput.project_id
        ? await readCandidates(deps.storePath, {
            project_id: resolvedInput.project_id,
            read_current_records: readRecords
          })
        : undefined;
      const allRecords = recordReadModel.records;
      const visibleRecords = allRecords.filter((record) =>
        isAllowedByPrivateBoundary(record, resolvedInput.include_private)
      );
      const normalizedHost = resolvedInput.host ? normalizeHostId(resolvedInput.host) : undefined;
      let activationStatus: Awaited<ReturnType<typeof inspectHostActivation>> | undefined;
      let activationInspectionError: string | undefined;
      if (
        resolvedInput.project_id &&
        resolvedInput.project_path &&
        (normalizedHost === "codex" || normalizedHost === "claude")
      ) {
        try {
          activationStatus = await inspectHostActivation({
            store_path: deps.storePath,
            project_path: resolvedInput.project_path,
            project_id: resolvedInput.project_id,
            host: normalizedHost,
            runtime: deps.hostRuntime
          });
        } catch (error) {
          activationInspectionError = error instanceof Error ? error.message : String(error);
        }
      }
      const latestSyncCompensation = await readSyncCompensationReceipt(deps.storePath);
      const syncCompensation =
        latestSyncCompensation &&
        (!resolvedInput.project_id || latestSyncCompensation.project_id === resolvedInput.project_id)
          ? latestSyncCompensation
          : undefined;
      return diagnoseHealthCheck({
        records: visibleRecords,
        events,
        project_id: resolvedInput.project_id,
        project_path: resolvedInput.project_path,
        host: resolvedInput.host,
        sync_remote: resolvedInput.sync_remote,
        limit,
        include_private: resolvedInput.include_private,
        excluded_private_records: allRecords.length - visibleRecords.length,
        record_read_model: recordReadModel,
        ...(retrievalIndex ? { retrieval_index: retrievalIndex } : {}),
        ...(syncCompensation ? { sync_compensation: syncCompensation } : {}),
        ...(activationStatus ? { activation_status: activationStatus } : {}),
        ...(activationInspectionError ? { activation_inspection_error: activationInspectionError } : {})
      });
    },

    async recallEval(input: RecallEvalInput = {}) {
      validateRecallEvalInput(input);
      const resolvedInput = {
        ...input,
        include_private: input.include_private === true
      } as ValidatedRecallEvalInput;
      return evaluateRecall(
        resolvedInput,
        (recallInput) => this.recall(recallInput),
        async (recordIds) => {
          const records = await currentRecords();
          const recordsById = new Map(records.map((record) => [record.id, record]));
          return Object.fromEntries(recordIds.map((recordId) => [recordId, recordsById.get(recordId)]));
        }
      );
    },

    async migrateProject(input: ProjectMigrateInput = {}) {
      validateProjectMigrateInput(input);
      const resolvedInput = {
        ...input,
        dry_run: input.dry_run !== false,
        include_private: input.include_private === true
      } as ValidatedProjectMigrateInput;
      const allRecords = await currentRecords();
      const matchingRecords = allRecords
        .filter((record) => record.project_id === resolvedInput.from_project_id)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
      const records = matchingRecords.filter((record) =>
        isAllowedByPrivateBoundary(record, resolvedInput.include_private)
      );
      const skippedPrivateRecords = matchingRecords.length - records.length;
      const compactedRecords = compactRecords(records);
      const base = {
        dry_run: resolvedInput.dry_run,
        from_project_id: resolvedInput.from_project_id,
        to_project_id: resolvedInput.to_project_id,
        matched_records: records.length,
        migrated_records: 0,
        skipped_private_records: skippedPrivateRecords,
        records: compactedRecords,
        records_by_id: recordsById(compactedRecords),
        events: [] as MorynEvent[],
        events_by_record_id: {} as Record<string, MorynEvent>,
        selection_sources: PROJECT_MIGRATE_SELECTION_SOURCES
      };
      if (resolvedInput.dry_run) return base;
      if (resolvedInput.confirmed !== true) {
        throw new Error("Confirmation required: project migration requires explicit confirmation");
      }

      const source = resolvedInput.source ?? { client: "moryn" };
      const events: Array<Extract<MorynEvent, { op: "revise_record" }>> = records.map((record) => ({
        event_id: id("evt"),
        op: "revise_record",
        record_id: record.id,
        patch: { project_id: resolvedInput.to_project_id },
        reason: `Project identity migration: ${resolvedInput.from_project_id} -> ${resolvedInput.to_project_id}`,
        confirmed: resolvedInput.confirmed,
        created_at: nextMutationTimestamp(record, now()),
        source
      }));
      for (const event of events) {
        await appendEvent(deps.storePath, event);
      }
      if (events.length > 0) {
        await rebuildDerivedViews(deps.storePath);
      }
      return {
        ...base,
        dry_run: false,
        migrated_records: events.length,
        events,
        events_by_record_id: Object.fromEntries(events.map((event) => [event.record_id, event]))
      };
    },

    async listProjects(input: ListProjectsInput = {}) {
      validateListProjectsInput(input);
      const limit = validateLimit(input.limit, 20, "project_list");
      const listProjectsInput = input as ValidatedListProjectsInput;
      const byProject = new Map<string, MorynRecord[]>();

      for (const record of (await currentRecords())
        .filter(isVisibleByDefault)
        .filter((record) => isAllowedByPrivateBoundary(record, false))) {
        if (record.scope !== "project" || !record.project_id) continue;
        byProject.set(record.project_id, [...(byProject.get(record.project_id) ?? []), record]);
      }

      const projects = [...byProject.entries()]
        .map(([projectId, records]) => {
          const sorted = [...records].sort(
            (a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id)
          );
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
              command: projectStartCommand(projectId, listProjectsInput),
              arguments: projectStartArguments(projectId, listProjectsInput)
            })
          };
        })
        .sort(
          (a, b) =>
            b.latest_activity.updated_at.localeCompare(a.latest_activity.updated_at) ||
            a.project_id.localeCompare(b.project_id)
        )
        .slice(0, limit);

      return {
        projects,
        selection_sources: PROJECT_LIST_SELECTION_SOURCES,
        projects_by_id: Object.fromEntries(projects.map((project) => [project.project_id, project]))
      };
    }
  };

  return engine;
}
