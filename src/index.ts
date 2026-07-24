import {
  DISCOVER_PROJECT_SELECTION_SOURCES,
  DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
  DOCTOR_SELECTION_SOURCES,
  GUIDE_ENTRYPOINT_SELECTION_SOURCES,
  GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
  GUIDE_SELECTION_SOURCES,
  HANDOFF_SELECTION_SOURCES,
  LIFECYCLE_ACTION_SELECTION_SOURCES,
  LIFECYCLE_NEXT_SELECTION_SOURCES
} from "./core/agent-lifecycle.js";
import { DEFAULT_AUTOCAPTURE_POLICY } from "./core/autocapture-policy.js";
import { CAPTURE_POLICY_SELECTION_SOURCES } from "./core/capture-policy-report.js";
import { STORE_INIT_SELECTION_SOURCES } from "./core/config.js";
import { REBUILD_SELECTION_SOURCES } from "./core/derived.js";
import { DOGFOOD_REPORT_SELECTION_SOURCES } from "./core/dogfood-report.js";
import { HEALTH_CHECK_SELECTION_SOURCES } from "./core/health-check.js";
import { MEMORY_LIFECYCLE_SELECTION_SOURCES } from "./core/memory-lifecycle.js";
import { WORKING_SET_REPORT_SELECTION_SOURCES } from "./core/working-set-report.js";

export type {
  AutomaticEventAuditDependencies,
  AutomaticEventAuditFailureCode,
  AutomaticEventAuditFailureStage,
  AutomaticEventAuditReceipt,
  AutomaticEventAuditSnapshotStatus
} from "./core/automatic-event-audit.js";
export { runAutomaticEventAudit } from "./core/automatic-event-audit.js";
export type {
  CheckpointInput,
  CheckpointRecoveryPackInput,
  CheckpointResult,
  RecoveryPack
} from "./core/checkpoint.js";
export { buildCheckpointRecoveryPack, CHECKPOINT_SELECTION_SOURCES } from "./core/checkpoint.js";
export type {
  ContextDelta,
  ContextDeltaInput,
  LearningDelta,
  LearningDeltaInput,
  SemanticConsolidationDifference,
  SemanticConsolidationDifferenceInput,
  SemanticConsolidationProposal,
  SemanticConsolidationProposalInput,
  StructuredSemanticMerge,
  StructuredSemanticMergeField,
  StructuredSemanticMergeInput
} from "./core/context-delta.js";
export {
  contextDeltaSchema,
  learningDeltaSchema,
  semanticConsolidationDifferenceSchema,
  semanticConsolidationProposalSchema,
  structuredSemanticMergeSchema,
  validateContextDelta
} from "./core/context-delta.js";
export { createEngine } from "./core/engine.js";
export type {
  AutomaticExactDuplicateConsolidationResult,
  ExactDuplicateConsolidationGroup,
  ExactDuplicateConsolidationReceipt
} from "./core/exact-duplicate-consolidation.js";
export { AUTOMATIC_EXACT_DUPLICATE_RECORD_KINDS } from "./core/exact-duplicate-consolidation.js";
export type { FinalizationAssuranceSelection, IncomingSessionIdentity } from "./core/finalization-assurance.js";
export { selectPriorSessionForFinalization } from "./core/finalization-assurance.js";
export type { WorkingSetReportOptions, WorkingSetSummaryOptions } from "./core/working-set-report.js";
export { buildWorkingSetReport, summarizeWorkingSet } from "./core/working-set-report.js";

import { CHECKPOINT_SELECTION_SOURCES } from "./core/checkpoint.js";

export type {
  ActivationHost,
  ActivationReceipt,
  ActivationReceiptEvent,
  ActivationReceiptInput
} from "./core/activation-receipts.js";
export { activationReceiptIdentity, recordActivationReceipt } from "./core/activation-receipts.js";
export type { AutomaticEpisodeRollupRecoveryPlan } from "./core/automatic-episode-rollup-recovery.js";
export {
  countPrivateAutomaticEpisodeRollupRecoveryPlans,
  readAutomaticEpisodeRollupRecoveryPlans
} from "./core/automatic-episode-rollup-recovery.js";
export type { ClaudeActivationResult, ClaudeSettingsMergeResult } from "./core/claude-activation.js";
export { activateClaudeSettings, mergeClaudeSettings } from "./core/claude-activation.js";
export { activateCodexHooks, mergeCodexHooks } from "./core/codex-activation.js";
export type { KnowledgeInvestigation, KnowledgeInvestigationInput } from "./core/context-delta.js";
export { knowledgeInvestigationEvidenceSchema, knowledgeInvestigationSchema } from "./core/context-delta.js";
export type {
  EpisodeBucketKind,
  EpisodeClaim,
  EpisodeClaimKind,
  EpisodeColdCandidate,
  EpisodeLeafEvidence,
  EpisodePrivacyBoundary,
  EpisodeRollupContent,
  EpisodeRollupCoverage,
  EpisodeRollupDeferredCode,
  EpisodeRollupDeferredReason,
  EpisodeRollupIdentity,
  EpisodeRollupPlan,
  EpisodeRollupPlanningPolicy,
  EpisodeRollupRecord,
  EpisodeRollupReviewCode,
  EpisodeRollupReviewReason,
  EpisodeRollupStatus,
  EpisodeSourceDigest,
  EpisodeWarmCandidate,
  PlanEpisodeRollupsOptions
} from "./core/episode-rollup.js";
export { EPISODE_BUCKET_KINDS, planEpisodeRollup, planEpisodeRollups } from "./core/episode-rollup.js";
export type { EpisodeRollupApplyResult, EpisodeRollupReceipt } from "./core/episode-rollup-transaction.js";
export { applyEpisodeRollupPlan, readEpisodeRollupReceipt } from "./core/episode-rollup-transaction.js";
export type { EventDurabilityAttestation } from "./core/event-durability-attestation.js";
export type { ActivationStatus, ActivationSuggestedAction, HostActivationStatus } from "./core/host-activation.js";
export { inspectHostActivation } from "./core/host-activation.js";
export {
  captureSession,
  contextPack,
  getHostAdapter,
  getHostAdapters,
  normalizeHostId,
  planInstall
} from "./core/host-adapters.js";
export type { HostCapabilities, HostLifecycleEvent } from "./core/host-capabilities.js";
export { getHostCapabilities, negotiateHostLifecycle } from "./core/host-capabilities.js";
export type { HostHookRunResult, RunHostHookInput } from "./core/host-hook-runner.js";
export { runHostHook } from "./core/host-hook-runner.js";
export type { NormalizedHostHookEvent } from "./core/host-hooks.js";
export { normalizeHostHookEvent } from "./core/host-hooks.js";
export type { HostIntegrationArtifact, HostRuntimeDescriptor } from "./core/host-integration-artifacts.js";
export {
  activationId,
  buildHostIntegrationArtifact,
  writeHostIntegrationArtifact
} from "./core/host-integration-artifacts.js";
export type {
  KnowledgeProtocol,
  KnowledgeProtocolHost,
  KnowledgeProtocolPhase,
  KnowledgeProtocolPhaseId,
  KnowledgeProtocolRule
} from "./core/knowledge-protocol.js";
export { KNOWLEDGE_PROTOCOL_SELECTION_SOURCES, knowledgeProtocolForHost } from "./core/knowledge-protocol.js";
export { learningRecordIdentity, normalizeLearningRecord } from "./core/learning-ingestion.js";
export type { LearningPolicyReason, LearningStatePolicyResult } from "./core/learning-policy.js";
export { learningStatePolicy } from "./core/learning-policy.js";
export type {
  LogicalRelationshipInput,
  LogicalRelationshipType,
  ValidatedLogicalRelationship
} from "./core/logical-memory.js";
export {
  buildActiveLogicalMemoryView,
  compareLogicalMemoryTargets,
  EXACT_DUPLICATE_LINK_REASON,
  LOGICAL_RELATIONSHIP_TYPES,
  logicalMemoryFingerprint,
  validateLogicalRelationship
} from "./core/logical-memory.js";
export type {
  EpisodeRollupCompactionEntry,
  MemoryCompactionArtifactBody,
  MemoryCompactionBlocker,
  MemoryCompactionCoverageSummary,
  MemoryCompactionEntryMetrics,
  MemoryCompactionEntryStatus,
  MemoryCompactionEnvelopeMetrics,
  MemoryCompactionFilters,
  MemoryCompactionKind,
  MemoryCompactionPlanEntry,
  MemoryCompactionPlanEnvelope,
  MemoryCompactionPlanStatus,
  MemoryCompactionPreview,
  MemoryCompactionPreviewOptions,
  MemoryCompactionPrivacySummary,
  MemoryCompactionPrivateAccessSummary,
  MemoryCompactionSourceBeforeState,
  MemoryCompactionSyncImpact,
  MemoryCompactionTokenMetrics,
  MemoryCompactionUndoSemantics,
  SessionFoldCompactionEntry
} from "./core/memory-compaction.js";
export {
  assertMemoryCompactionPlanEnvelope,
  assertMemoryCompactionPreview,
  planMemoryCompaction,
  previewMemoryCompaction
} from "./core/memory-compaction.js";
export type {
  ApplyMemoryCompactionInput,
  MemoryCompactionApplyResult,
  MemoryCompactionChildApplySummary,
  MemoryCompactionChildReceiptReference,
  MemoryCompactionDerivedRecordReceipt,
  MemoryCompactionReceipt,
  MemoryCompactionSourceTransitionReceipt
} from "./core/memory-compaction-receipts.js";
export {
  applyMemoryCompactionPlan,
  readMemoryCompactionReceipt
} from "./core/memory-compaction-receipts.js";
export type {
  MemoryCompactionRestoreReceipt,
  MemoryCompactionRestoreResult,
  RestoreMemoryCompactionInput
} from "./core/memory-compaction-restore.js";
export {
  readMemoryCompactionRestoreReceipt,
  restoreMemoryCompactionPlan
} from "./core/memory-compaction-restore.js";
export type {
  MemoryExpansionEdge,
  MemoryExpansionInput,
  MemoryExpansionOmission,
  MemoryExpansionOmissionReason,
  MemoryExpansionRecord,
  MemoryExpansionRelation,
  MemoryExpansionResult,
  MemoryExpansionVerification
} from "./core/memory-expansion.js";
export { expandMemorySources, MEMORY_EXPANSION_SELECTION_SOURCES } from "./core/memory-expansion.js";
export type {
  AutomaticRetentionBlocker,
  MemoryLayer,
  MemoryLayerAxisV2,
  MemoryLayerName,
  MemoryLineageViewV2,
  MemoryRetentionAxisV2,
  MemoryRetentionMetadataV2,
  MemoryRetentionPolicyViewV2,
  MemoryRetentionReadModelV2,
  MemoryRetentionReason,
  MemoryRetentionSafetyV2,
  MemoryRetentionTier,
  MemoryRetentionViewOptions,
  MemoryRetentionViewV2,
  MemoryRetentionWarning,
  MemoryRetentionWarningCode,
  MemoryTrustAxisV2,
  MemoryTrustState,
  MemoryUsageViewV2,
  MemoryValidityStatus,
  MemoryValidityViewV2,
  NormalizedMemoryRetentionMetadataV2,
  ParsedMemoryRetentionMetadataV2,
  ProtectedMemorySignal,
  RetentionWindowStatus
} from "./core/memory-retention.js";
export {
  buildMemoryRetentionReadModel,
  buildMemoryRetentionView,
  DEFAULT_MEMORY_RETENTION_POLICY_IDS,
  inferMemoryLayer,
  MEMORY_LAYERS,
  MEMORY_RETENTION_METADATA_KEY,
  MEMORY_RETENTION_TIERS,
  MEMORY_TRUST_STATES,
  parseMemoryRetentionMetadata,
  protectedMemorySignals
} from "./core/memory-retention.js";
export type { RecallActionContract, RecallNextAction, RecallNextActionId } from "./core/recall-actions.js";
export { buildRecallNextActions, RECALL_ACTION_SELECTION_SOURCES } from "./core/recall-actions.js";
export type { RecallOutcome, RecallOutcomeStatus, RecallTrust } from "./core/recall-outcome.js";
export { assessRecallOutcome, queryTokenCoverage } from "./core/recall-outcome.js";
export type {
  CurrentRecordReadResult,
  EventManifest,
  ExcludedMemoryWorkingSetEntry,
  MemoryWorkingSetEntry,
  MemoryWorkingSetExclusionReason,
  MemoryWorkingSetSelection,
  MemoryWorkingSetSelectionCounts,
  MemoryWorkingSetSelectionOptions,
  MemoryWorkingSetTokenReport,
  ReadCurrentRecordsOptions,
  RecordReadFallbackReason,
  RecordReadModelV1
} from "./core/record-read-model.js";
export {
  buildRecordReadModel,
  DEFAULT_MEMORY_WORKING_SET_LAYER_TOKEN_BUDGETS,
  DEFAULT_MEMORY_WORKING_SET_OPTIONS,
  DEFAULT_MEMORY_WORKING_SET_TOTAL_TOKEN_BUDGET,
  estimateMemoryRecordTokens,
  eventManifest,
  readCurrentRecords,
  selectMemoryWorkingSet
} from "./core/record-read-model.js";
export type {
  BuiltRetrievalIndex,
  RetrievalCandidateReadResult,
  RetrievalIndexMetadataV1,
  RetrievalIndexShardV1
} from "./core/retrieval-index.js";
export {
  buildRetrievalIndex,
  readRetrievalCandidates,
  retrievalProjectShardName,
  writeRetrievalIndex
} from "./core/retrieval-index.js";
export type {
  SemanticConsolidationProposalResult,
  SemanticConsolidationReceipt,
  SemanticConsolidationValidationOptions,
  SemanticConsolidationValidationReason,
  SemanticConsolidationValidationResult
} from "./core/semantic-consolidation.js";
export {
  SEMANTIC_CONSOLIDATION_RECEIPT_SELECTION_SOURCES,
  semanticConsolidationProposalDigest,
  validateSemanticConsolidationProposal
} from "./core/semantic-consolidation.js";
export type {
  SemanticConsolidationCandidate,
  SemanticConsolidationCandidateOptions
} from "./core/semantic-consolidation-candidates.js";
export {
  retrieveSemanticConsolidationCandidates,
  SEMANTIC_CONSOLIDATION_CANDIDATE_SELECTION_SOURCES
} from "./core/semantic-consolidation-candidates.js";
export type {
  PlanSessionFoldsOptions,
  SessionFoldCandidate,
  SessionFoldCoverage,
  SessionFoldCoverageAttestation,
  SessionFoldCoverageBlocker,
  SessionFoldCoverageMethod,
  SessionFoldCoveredSource,
  SessionFoldHotFinalHandoff,
  SessionFoldIdentity,
  SessionFoldPlan,
  SessionFoldPrivacyBoundary,
  SessionFoldReviewReason,
  SessionFoldReviewReasonCode,
  SessionFoldRollupContent,
  SessionFoldRollupRecord,
  SessionFoldSourceDigest,
  SessionFoldUncoveredSource
} from "./core/session-fold.js";
export {
  buildSessionFoldCoverageAttestation,
  planSessionFold,
  planSessionFolds
} from "./core/session-fold.js";
export type { SessionFoldApplyResult, SessionFoldReceipt } from "./core/session-fold-transaction.js";
export { applySessionFoldPlan, readSessionFoldReceipt } from "./core/session-fold-transaction.js";
export type { SessionSynthesis } from "./core/session-synthesis.js";
export { synthesizeSession } from "./core/session-synthesis.js";
export type {
  SoulApprovalAction,
  SoulApprovalReceipt,
  SoulApprovalReceiptInput
} from "./core/soul-approval-receipts.js";
export {
  listSoulApprovalReceipts,
  parseSoulApprovalReceipt,
  readSoulApprovalReceipt,
  soulApprovalReceiptIdentity
} from "./core/soul-approval-receipts.js";
export type { SoulCompilationReceipt } from "./core/soul-compilation-receipts.js";
export { readSoulCompilationReceipt } from "./core/soul-compilation-receipts.js";
export type {
  SoulDeliveryEvent,
  SoulDeliveryHost,
  SoulDeliveryReceipt,
  SoulDeliveryReceiptInput
} from "./core/soul-delivery-receipts.js";
export {
  listSoulDeliveryReceipts,
  readSoulDeliveryReceipt,
  SOUL_DELIVERY_PROOF_SCOPE,
  soulDeliveryReceiptIdentity
} from "./core/soul-delivery-receipts.js";
export type {
  DeliverEffectiveSoulInput,
  DeliverEffectiveSoulResult,
  SoulHostContext
} from "./core/soul-host-delivery.js";
export { buildSoulHostContext, deliverEffectiveSoul } from "./core/soul-host-delivery.js";
export type {
  CompileEffectiveSoulInput,
  CreateSoulProfileRevisionInput,
  EffectiveSoul,
  EffectiveSoulClause,
  EffectiveSoulRevisionSelection,
  LegacySoulRecordOptions,
  SelectedSoulRevision,
  SoulClause,
  SoulClauseCategory,
  SoulClauseInput,
  SoulCompileConflict,
  SoulDistribution,
  SoulOmission,
  SoulOmissionReason,
  SoulProfileRevision,
  SoulRevisionSelection,
  SoulRevisionSelectionStatus,
  SoulRevisionState,
  SoulScope,
  SoulSubject
} from "./core/soul-profile.js";
export {
  compileEffectiveSoul,
  createSoulClause,
  createSoulProfileRevision,
  estimateSoulTokens,
  parseLegacySoulRecord,
  parseLegacySoulRecords,
  SOUL_CLAUSE_CATEGORIES,
  SOUL_DISTRIBUTIONS,
  SOUL_PROFILE_SCHEMA_VERSION,
  selectLastKnownGoodSoulRevision,
  soulProfilePersonalSyncDigest,
  soulProfileRevisionDigest,
  stableSoulClauseId,
  stableSoulProfileId,
  stableSoulRevisionId
} from "./core/soul-profile.js";
export type {
  ApproveSoulProfileDraftInput,
  CreateSoulProfileDraftInput,
  CreateSoulProfileDraftResult,
  ReadSoulProfileStatusOptions,
  RollbackSoulProfileInput,
  SoulApprovalReceiptMetadata,
  SoulCompilationStatus,
  SoulDeliveryReceiptMetadata,
  SoulProfileActivationResult,
  SoulProfileRevisionStatus,
  SoulProfileStatus,
  SoulProfileStatusEntry
} from "./core/soul-profile-management.js";
export {
  approveSoulProfileDraft,
  createSoulProfileDraft,
  readSoulProfileStatus,
  rollbackSoulProfile
} from "./core/soul-profile-management.js";
export type {
  ReadSoulProfileRevisionsOptions,
  ReadSoulProfileRevisionsResult,
  SoulProfileLoadWarning,
  SoulProfileProjectionEnvelope,
  WriteSoulProfileRevisionInput,
  WriteSoulProfileRevisionResult
} from "./core/soul-profile-store.js";
export {
  parseSoulProfileProjection,
  readSoulProfileRevisions,
  SOUL_PROFILE_RECORD_TYPE
} from "./core/soul-profile-store.js";
export type {
  SoulSyncApprovalVerification,
  SoulSyncReceipt,
  SoulSyncReceiptInput,
  SoulSyncReceiptOperation,
  SoulSyncReceiptStage
} from "./core/soul-sync-receipts.js";
export {
  listSoulSyncReceipts,
  parseSoulSyncReceipt,
  readSoulSyncReceipt,
  soulRemoteIdentityDigest,
  soulSyncReceiptIdentity
} from "./core/soul-sync-receipts.js";
export type {
  StructuredSemanticMergeFieldLineage,
  StructuredSemanticMergeMetadata,
  StructuredSemanticMergePlan,
  StructuredSemanticMergePlanningOptions,
  StructuredSemanticMergePlanningResult,
  StructuredSemanticMergeRejectionReason,
  StructuredSemanticMergeValueLineage
} from "./core/structured-semantic-merge.js";
export {
  canonicalStructuredSemanticMergeValue,
  planStructuredSemanticMerge,
  STRUCTURED_SEMANTIC_MERGE_ACTIVATION_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_ACTIVATION_REASON,
  STRUCTURED_SEMANTIC_MERGE_CLAIM_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_CONTENT_KEY,
  STRUCTURED_SEMANTIC_MERGE_DEVICE_ID,
  STRUCTURED_SEMANTIC_MERGE_HIDE_REASON,
  STRUCTURED_SEMANTIC_MERGE_PROMOTION_OFFSET_MS,
  STRUCTURED_SEMANTIC_MERGE_PROMOTION_REASON,
  STRUCTURED_SEMANTIC_MERGE_RELATIONSHIP_OFFSET_MS,
  structuredSemanticMergeDependenciesMatch,
  structuredSemanticMergeDigest,
  structuredSemanticMergeEvidenceMatches,
  structuredSemanticMergeInitialRecordMatches,
  structuredSemanticMergeProvisionalRecordMatches,
  structuredSemanticMergeRecordMatches,
  structuredSemanticMergeSourceDigest,
  structuredSemanticMergeSourcesMatch,
  structuredSemanticMergeTimestamp
} from "./core/structured-semantic-merge.js";
export type { SyncCompensationAssessment, SyncCompensationReceipt } from "./core/sync-compensation.js";
export {
  assessSyncCompensation,
  readSyncCompensationReceipt,
  writeSyncCompensationReceipt
} from "./core/sync-compensation.js";

import {
  CAPTURE_SESSION_SELECTION_SOURCES,
  HANDOFF_PACK_SELECTION_SOURCES,
  HANDOFF_QUALITY_GATE_SELECTION_SOURCES
} from "./core/host-adapters.js";

export { setupWizard } from "./core/setup-wizard.js";

import {
  BOOT_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MEMORY_DOCTOR_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  PROJECT_MIGRATE_SELECTION_SOURCES,
  RECALL_EVAL_SELECTION_SOURCES,
  RECALL_SELECTION_SOURCES,
  REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
  REFRESH_SELECTION_SOURCES,
  SENSITIVE_REVISE_SELECTION_SOURCES,
  TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES,
  TIMELINE_SELECTION_SOURCES,
  WRITE_SELECTION_SOURCES
} from "./core/engine.js";
import { NEXT_ACTION_SELECTION_SOURCES } from "./core/errors.js";
import { SETUP_WIZARD_SELECTION_SOURCES } from "./core/setup-wizard.js";

export {
  getOperationContract,
  getOperationContractByCliCommand,
  getOperationContractByMcpTool,
  getOperationContractIndex,
  getOperationContracts,
  OPERATION_CONTRACT_INDEX_SELECTION_SOURCES,
  OPERATION_CONTRACTS,
  OPERATION_CONTRACTS_SELECTION_SOURCES,
  OperationContractLookupArgumentError,
  OperationContractLookupError
} from "./operation-contracts.js";

import { PROJECT_INIT_SELECTION_SOURCES } from "./core/project.js";

export { parseRecord } from "./core/schema.js";

import { CONTEXT_PACK_REVIEW_SELECTION_SOURCES, DASHBOARD_SELECTION_SOURCES } from "./observability/dashboard.js";

export {
  buildDashboardData,
  renderDashboardFragment,
  renderDashboardHtml,
  renderDashboardServerHtml,
  startDashboardServer,
  writeDashboardSnapshot
} from "./observability/dashboard.js";

import { SYNC_RESULT_SELECTION_SOURCES, SYNC_STATUS_SELECTION_SOURCES } from "./sync/git.js";

export type { LearningInboxRecord, QueueLearningInput } from "./core/learning-inbox.js";
export {
  consumeLearningInbox,
  learningInboxForLifecycle,
  learningInboxIdentity,
  pendingLearningInbox,
  queueLearning
} from "./core/learning-inbox.js";
export type { MorynRecord } from "./core/types.js";

export const version = "0.4.0-dev.0";

export {
  BOOT_SELECTION_SOURCES,
  CAPTURE_POLICY_SELECTION_SOURCES,
  CAPTURE_SESSION_SELECTION_SOURCES,
  CONTEXT_PACK_REVIEW_SELECTION_SOURCES,
  DASHBOARD_SELECTION_SOURCES,
  DEFAULT_AUTOCAPTURE_POLICY,
  DISCOVER_PROJECT_SELECTION_SOURCES,
  DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
  DOCTOR_SELECTION_SOURCES,
  DOGFOOD_REPORT_SELECTION_SOURCES,
  GUIDE_ENTRYPOINT_SELECTION_SOURCES,
  GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
  GUIDE_SELECTION_SOURCES,
  HANDOFF_PACK_SELECTION_SOURCES,
  HANDOFF_QUALITY_GATE_SELECTION_SOURCES,
  HANDOFF_SELECTION_SOURCES,
  HEALTH_CHECK_SELECTION_SOURCES,
  LIFECYCLE_ACTION_SELECTION_SOURCES,
  LIFECYCLE_NEXT_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MEMORY_DOCTOR_SELECTION_SOURCES,
  MEMORY_LIFECYCLE_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_INIT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  PROJECT_MIGRATE_SELECTION_SOURCES,
  REBUILD_SELECTION_SOURCES,
  RECALL_EVAL_SELECTION_SOURCES,
  RECALL_SELECTION_SOURCES,
  REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
  REFRESH_SELECTION_SOURCES,
  SENSITIVE_REVISE_SELECTION_SOURCES,
  SETUP_WIZARD_SELECTION_SOURCES,
  STORE_INIT_SELECTION_SOURCES,
  SYNC_RESULT_SELECTION_SOURCES,
  SYNC_STATUS_SELECTION_SOURCES,
  TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES,
  TIMELINE_SELECTION_SOURCES,
  WORKING_SET_REPORT_SELECTION_SOURCES,
  WRITE_SELECTION_SOURCES
};

export const SELECTION_SOURCE_CONTRACTS = {
  setup: {
    setup_wizard: SETUP_WIZARD_SELECTION_SOURCES,
    store_init: STORE_INIT_SELECTION_SOURCES,
    project_init: PROJECT_INIT_SELECTION_SOURCES,
    rebuild: REBUILD_SELECTION_SOURCES
  },
  core: {
    checkpoint: CHECKPOINT_SELECTION_SOURCES,
    write: WRITE_SELECTION_SOURCES,
    mutation_event: MUTATION_EVENT_SELECTION_SOURCES,
    link_event: LINK_EVENT_SELECTION_SOURCES,
    sensitive_revise: SENSITIVE_REVISE_SELECTION_SOURCES,
    recall: RECALL_SELECTION_SOURCES,
    timeline: TIMELINE_SELECTION_SOURCES,
    timeline_item_next_action: TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES,
    boot: BOOT_SELECTION_SOURCES,
    refresh: REFRESH_SELECTION_SOURCES,
    refresh_change_next_action: REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
    list_recent: LIST_RECENT_SELECTION_SOURCES,
    project_list: PROJECT_LIST_SELECTION_SOURCES,
    project_list_next_action: PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
    project_migrate: PROJECT_MIGRATE_SELECTION_SOURCES,
    memory_doctor: MEMORY_DOCTOR_SELECTION_SOURCES,
    memory_lifecycle: MEMORY_LIFECYCLE_SELECTION_SOURCES,
    working_set_report: WORKING_SET_REPORT_SELECTION_SOURCES,
    capture_policy: CAPTURE_POLICY_SELECTION_SOURCES,
    dogfood_report: DOGFOOD_REPORT_SELECTION_SOURCES,
    health_check: HEALTH_CHECK_SELECTION_SOURCES,
    recall_eval: RECALL_EVAL_SELECTION_SOURCES
  },
  sync: {
    status: SYNC_STATUS_SELECTION_SOURCES,
    result: SYNC_RESULT_SELECTION_SOURCES
  },
  observability: {
    dashboard: DASHBOARD_SELECTION_SOURCES,
    context_pack_review: CONTEXT_PACK_REVIEW_SELECTION_SOURCES
  },
  lifecycle: {
    guide: GUIDE_SELECTION_SOURCES,
    guide_lifecycle_step: GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
    guide_entrypoint: GUIDE_ENTRYPOINT_SELECTION_SOURCES,
    lifecycle_next: LIFECYCLE_NEXT_SELECTION_SOURCES,
    lifecycle_action: LIFECYCLE_ACTION_SELECTION_SOURCES,
    discover_project: DISCOVER_PROJECT_SELECTION_SOURCES,
    discovered_lifecycle_step: DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
    handoff: HANDOFF_SELECTION_SOURCES,
    handoff_pack: HANDOFF_PACK_SELECTION_SOURCES,
    handoff_quality_gate: HANDOFF_QUALITY_GATE_SELECTION_SOURCES,
    capture_session: CAPTURE_SESSION_SELECTION_SOURCES,
    doctor: DOCTOR_SELECTION_SOURCES
  },
  recovery: {
    next_action: NEXT_ACTION_SELECTION_SOURCES
  }
} as const;

export const SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES = {
  contracts: "contracts",
  group: "contracts.<group>",
  contract: "contracts.<group>.<contract>",
  field: "contracts.<group>.<contract>.<field>"
} as const;

export function getSelectionSourceContracts() {
  return {
    contracts: SELECTION_SOURCE_CONTRACTS,
    selection_sources: SELECTION_SOURCE_CONTRACTS_SELECTION_SOURCES
  };
}
