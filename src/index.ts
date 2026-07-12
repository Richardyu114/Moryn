import {
  DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
  DISCOVER_PROJECT_SELECTION_SOURCES,
  DOCTOR_SELECTION_SOURCES,
  GUIDE_ENTRYPOINT_SELECTION_SOURCES,
  GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
  GUIDE_SELECTION_SOURCES,
  HANDOFF_SELECTION_SOURCES,
  LIFECYCLE_ACTION_SELECTION_SOURCES,
  LIFECYCLE_NEXT_SELECTION_SOURCES
} from "./core/agent-lifecycle.js";
import { STORE_INIT_SELECTION_SOURCES } from "./core/config.js";
import { DEFAULT_AUTOCAPTURE_POLICY } from "./core/autocapture-policy.js";
import { REBUILD_SELECTION_SOURCES } from "./core/derived.js";
import { CAPTURE_POLICY_SELECTION_SOURCES } from "./core/capture-policy-report.js";
import { DOGFOOD_REPORT_SELECTION_SOURCES } from "./core/dogfood-report.js";
import { HEALTH_CHECK_SELECTION_SOURCES } from "./core/health-check.js";
import { MEMORY_LIFECYCLE_SELECTION_SOURCES } from "./core/memory-lifecycle.js";
import { WORKING_SET_REPORT_SELECTION_SOURCES } from "./core/working-set-report.js";
export { createEngine } from "./core/engine.js";
export { buildWorkingSetReport, summarizeWorkingSet } from "./core/working-set-report.js";
export type { WorkingSetReportOptions, WorkingSetSummaryOptions } from "./core/working-set-report.js";
export { contextDeltaSchema, learningDeltaSchema, semanticConsolidationDifferenceSchema, semanticConsolidationProposalSchema, validateContextDelta } from "./core/context-delta.js";
export type { ContextDelta, ContextDeltaInput, LearningDelta, LearningDeltaInput, SemanticConsolidationDifference, SemanticConsolidationDifferenceInput, SemanticConsolidationProposal, SemanticConsolidationProposalInput } from "./core/context-delta.js";
export { buildCheckpointRecoveryPack, CHECKPOINT_SELECTION_SOURCES } from "./core/checkpoint.js";
export type { CheckpointInput, CheckpointRecoveryPackInput, CheckpointResult, RecoveryPack } from "./core/checkpoint.js";
import { CHECKPOINT_SELECTION_SOURCES } from "./core/checkpoint.js";
export { buildActiveLogicalMemoryView, compareLogicalMemoryTargets, logicalMemoryFingerprint, LOGICAL_RELATIONSHIP_TYPES, validateLogicalRelationship } from "./core/logical-memory.js";
export { SEMANTIC_CONSOLIDATION_RECEIPT_SELECTION_SOURCES, semanticConsolidationProposalDigest, validateSemanticConsolidationProposal } from "./core/semantic-consolidation.js";
export type { SemanticConsolidationProposalResult, SemanticConsolidationReceipt, SemanticConsolidationValidationOptions, SemanticConsolidationValidationReason, SemanticConsolidationValidationResult } from "./core/semantic-consolidation.js";
export { retrieveSemanticConsolidationCandidates, SEMANTIC_CONSOLIDATION_CANDIDATE_SELECTION_SOURCES } from "./core/semantic-consolidation-candidates.js";
export type { SemanticConsolidationCandidate, SemanticConsolidationCandidateOptions } from "./core/semantic-consolidation-candidates.js";
export { assessRecallOutcome, queryTokenCoverage } from "./core/recall-outcome.js";
export type { RecallOutcome, RecallOutcomeStatus, RecallTrust } from "./core/recall-outcome.js";
export { buildRecallNextActions, RECALL_ACTION_SELECTION_SOURCES } from "./core/recall-actions.js";
export type { RecallActionContract, RecallNextAction, RecallNextActionId } from "./core/recall-actions.js";
export { knowledgeProtocolForHost, KNOWLEDGE_PROTOCOL_SELECTION_SOURCES } from "./core/knowledge-protocol.js";
export type { KnowledgeProtocol, KnowledgeProtocolHost, KnowledgeProtocolPhase, KnowledgeProtocolPhaseId, KnowledgeProtocolRule } from "./core/knowledge-protocol.js";
export { knowledgeInvestigationEvidenceSchema, knowledgeInvestigationSchema } from "./core/context-delta.js";
export type { KnowledgeInvestigation, KnowledgeInvestigationInput } from "./core/context-delta.js";
export { learningStatePolicy } from "./core/learning-policy.js";
export type { LearningPolicyReason, LearningStatePolicyResult } from "./core/learning-policy.js";
export { learningRecordIdentity, normalizeLearningRecord } from "./core/learning-ingestion.js";
export type { LogicalRelationshipInput, LogicalRelationshipType, ValidatedLogicalRelationship } from "./core/logical-memory.js";
export { captureSession, contextPack, getHostAdapter, getHostAdapters, normalizeHostId, planInstall } from "./core/host-adapters.js";
export { getHostCapabilities, negotiateHostLifecycle } from "./core/host-capabilities.js";
export type { HostCapabilities, HostLifecycleEvent } from "./core/host-capabilities.js";
export { normalizeHostHookEvent } from "./core/host-hooks.js";
export type { NormalizedHostHookEvent } from "./core/host-hooks.js";
export { runHostHook } from "./core/host-hook-runner.js";
export { synthesizeSession } from "./core/session-synthesis.js";
export type { SessionSynthesis } from "./core/session-synthesis.js";
export type { HostHookRunResult, RunHostHookInput } from "./core/host-hook-runner.js";
export { activationId, buildHostIntegrationArtifact, writeHostIntegrationArtifact } from "./core/host-integration-artifacts.js";
export type { HostIntegrationArtifact } from "./core/host-integration-artifacts.js";
export { activateClaudeSettings, mergeClaudeSettings } from "./core/claude-activation.js";
export type { ClaudeActivationResult, ClaudeSettingsMergeResult } from "./core/claude-activation.js";
export { activationReceiptIdentity, recordActivationReceipt } from "./core/activation-receipts.js";
export type { ActivationHost, ActivationReceipt, ActivationReceiptEvent, ActivationReceiptInput } from "./core/activation-receipts.js";
export { inspectHostActivation } from "./core/host-activation.js";
export type { ActivationStatus, ActivationSuggestedAction, HostActivationStatus } from "./core/host-activation.js";
export { buildRecordReadModel, eventManifest, readCurrentRecords } from "./core/record-read-model.js";
export type { CurrentRecordReadResult, EventManifest, RecordReadFallbackReason, RecordReadModelV1 } from "./core/record-read-model.js";
export { buildRetrievalIndex, readRetrievalCandidates, retrievalProjectShardName, writeRetrievalIndex } from "./core/retrieval-index.js";
export type { BuiltRetrievalIndex, RetrievalCandidateReadResult, RetrievalIndexMetadataV1, RetrievalIndexShardV1 } from "./core/retrieval-index.js";
export { assessSyncCompensation, readSyncCompensationReceipt, writeSyncCompensationReceipt } from "./core/sync-compensation.js";
export type { SyncCompensationAssessment, SyncCompensationReceipt } from "./core/sync-compensation.js";
import { CAPTURE_SESSION_SELECTION_SOURCES, HANDOFF_PACK_SELECTION_SOURCES, HANDOFF_QUALITY_GATE_SELECTION_SOURCES } from "./core/host-adapters.js";
export { setupWizard } from "./core/setup-wizard.js";
import { SETUP_WIZARD_SELECTION_SOURCES } from "./core/setup-wizard.js";
import {
  BOOT_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  PROJECT_MIGRATE_SELECTION_SOURCES,
  MEMORY_DOCTOR_SELECTION_SOURCES,
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
export {
  OperationContractLookupArgumentError,
  OperationContractLookupError,
  OPERATION_CONTRACTS,
  OPERATION_CONTRACT_INDEX_SELECTION_SOURCES,
  OPERATION_CONTRACTS_SELECTION_SOURCES,
  getOperationContract,
  getOperationContractByCliCommand,
  getOperationContractByMcpTool,
  getOperationContractIndex,
  getOperationContracts
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
export type { MorynRecord } from "./core/types.js";

export const version = "0.2.0";

export {
  DISCOVERED_LIFECYCLE_STEP_SELECTION_SOURCES,
  DISCOVER_PROJECT_SELECTION_SOURCES,
  DOCTOR_SELECTION_SOURCES,
  GUIDE_ENTRYPOINT_SELECTION_SOURCES,
  GUIDE_LIFECYCLE_STEP_SELECTION_SOURCES,
  GUIDE_SELECTION_SOURCES,
  HANDOFF_SELECTION_SOURCES,
  LIFECYCLE_ACTION_SELECTION_SOURCES,
  LIFECYCLE_NEXT_SELECTION_SOURCES,
  STORE_INIT_SELECTION_SOURCES,
  REBUILD_SELECTION_SOURCES,
  BOOT_SELECTION_SOURCES,
  LINK_EVENT_SELECTION_SOURCES,
  LIST_RECENT_SELECTION_SOURCES,
  MUTATION_EVENT_SELECTION_SOURCES,
  PROJECT_LIST_NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_LIST_SELECTION_SOURCES,
  PROJECT_MIGRATE_SELECTION_SOURCES,
  MEMORY_DOCTOR_SELECTION_SOURCES,
  RECALL_EVAL_SELECTION_SOURCES,
  RECALL_SELECTION_SOURCES,
  REFRESH_CHANGE_NEXT_ACTION_SELECTION_SOURCES,
  REFRESH_SELECTION_SOURCES,
  SENSITIVE_REVISE_SELECTION_SOURCES,
  TIMELINE_ITEM_NEXT_ACTION_SELECTION_SOURCES,
  TIMELINE_SELECTION_SOURCES,
  WRITE_SELECTION_SOURCES,
  NEXT_ACTION_SELECTION_SOURCES,
  PROJECT_INIT_SELECTION_SOURCES,
  DASHBOARD_SELECTION_SOURCES,
  CONTEXT_PACK_REVIEW_SELECTION_SOURCES,
  SYNC_RESULT_SELECTION_SOURCES,
  SYNC_STATUS_SELECTION_SOURCES,
  HANDOFF_PACK_SELECTION_SOURCES,
  HANDOFF_QUALITY_GATE_SELECTION_SOURCES,
  CAPTURE_SESSION_SELECTION_SOURCES,
  DEFAULT_AUTOCAPTURE_POLICY,
  CAPTURE_POLICY_SELECTION_SOURCES,
  DOGFOOD_REPORT_SELECTION_SOURCES,
  HEALTH_CHECK_SELECTION_SOURCES,
  MEMORY_LIFECYCLE_SELECTION_SOURCES,
  WORKING_SET_REPORT_SELECTION_SOURCES,
  SETUP_WIZARD_SELECTION_SOURCES
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
