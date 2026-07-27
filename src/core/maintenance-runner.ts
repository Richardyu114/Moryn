import { assertGitEventHistoryAppendOnly, type GitSyncStatus, getGitSyncStatus } from "../sync/git.js";
import { type AutomaticEventAuditReceipt, runAutomaticEventAudit } from "./automatic-event-audit.js";
import {
  AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES,
  type AutomaticSemanticMaintenanceResult,
  runAutomaticSemanticMaintenance
} from "./automatic-semantic-maintenance.js";
import { createEngine } from "./engine.js";
import type { RecordSource } from "./types.js";

export interface MaintenanceRunInput {
  store_path: string;
  project_id: string;
  source: RecordSource;
}

export interface MaintenanceRunEngine {
  applyAutomaticSemanticMaintenance(input: {
    project_id: string;
    source: RecordSource;
  }): Promise<AutomaticSemanticMaintenanceResult>;
}

export interface MaintenanceRunDependencies {
  create_engine?: (options: { storePath: string }) => MaintenanceRunEngine;
  get_git_sync_status?: (storePath: string) => Promise<GitSyncStatus>;
  assert_git_event_history_append_only?: (storePath: string) => Promise<void>;
  run_automatic_event_audit?: (storePath: string) => Promise<AutomaticEventAuditReceipt>;
}

export type MaintenanceRunBlockCode = "SYNC_CONFLICT" | "SYNC_STATUS_UNAVAILABLE";

export class MaintenanceRunBlockedError extends Error {
  readonly code: MaintenanceRunBlockCode;
  readonly recommended_action: string;

  constructor(code: MaintenanceRunBlockCode, message: string, recommendedAction: string) {
    super(message);
    this.name = "MaintenanceRunBlockedError";
    this.code = code;
    this.recommended_action = recommendedAction;
  }
}

export interface MaintenanceRunSyncPreflight {
  status: "clear";
  configured: boolean;
  sync_state?: "clean" | "dirty";
}

export interface MaintenanceRunReceipt {
  status: "completed" | "failed";
  project_id: string;
  sync_preflight: MaintenanceRunSyncPreflight;
  maintenance: AutomaticSemanticMaintenanceResult;
  preflight_event_audit: AutomaticEventAuditReceipt;
  event_audit: AutomaticEventAuditReceipt;
  policy: {
    execution: "one_shot";
    working_set: "public_project";
    allowed_record_kinds: ["memory", "skill"];
    maximum_merges: 1;
    source_history_retained: true;
    physical_delete: false;
    remote_publish: false;
    remote_publish_operation: "sync_push";
    excludes: ["private", "global", "high_priority", "soul", "unresolved_conflict", "user_confirmation_required"];
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Maintenance run requires ${name}`);
  return value.trim();
}

function auditFailure(): AutomaticEventAuditReceipt {
  return {
    status: "failed",
    failure_stage: "read_events",
    code: "EVENT_READ_FAILED",
    reason: "The event integrity audit unexpectedly failed to run.",
    event_count: 0,
    record_count: 0,
    snapshot_status: "not_checked"
  };
}

function maintenanceBlockedByAudit(projectId: string): AutomaticSemanticMaintenanceResult {
  return {
    status: "failed",
    project_id: projectId,
    maximum_merges: AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES,
    drafts_ready: 0,
    merges_attempted: 0,
    merges_committed: 0,
    before: { current_records: 0, estimated_tokens: 0 },
    after: { current_records: 0, estimated_tokens: 0 },
    committed: [],
    failures: [{ reason: "Preflight event integrity verification failed." }],
    proof: {
      strict_record_decrease_required: true,
      strict_token_decrease_required: true,
      strict_record_decrease_observed: false,
      strict_token_decrease_observed: false,
      source_history_retained: true,
      physical_delete: false
    }
  };
}

async function auditEvents(
  storePath: string,
  runAudit: (path: string) => Promise<AutomaticEventAuditReceipt>
): Promise<AutomaticEventAuditReceipt> {
  try {
    return await runAudit(storePath);
  } catch {
    return auditFailure();
  }
}

function policy(): MaintenanceRunReceipt["policy"] {
  return {
    execution: "one_shot",
    working_set: "public_project",
    allowed_record_kinds: ["memory", "skill"],
    maximum_merges: AUTOMATIC_SEMANTIC_MAINTENANCE_MAX_MERGES,
    source_history_retained: true,
    physical_delete: false,
    remote_publish: false,
    remote_publish_operation: "sync_push",
    excludes: ["private", "global", "high_priority", "soul", "unresolved_conflict", "user_confirmation_required"]
  };
}

function syncStatusUnavailable(): MaintenanceRunBlockedError {
  return new MaintenanceRunBlockedError(
    "SYNC_STATUS_UNAVAILABLE",
    "Maintenance run blocked because store sync status could not be verified safely.",
    "inspect sync status and retry maintenance after the store state is readable"
  );
}

async function verifySyncPreflight(
  storePath: string,
  readSyncStatus: (path: string) => Promise<GitSyncStatus>
): Promise<MaintenanceRunSyncPreflight> {
  let syncStatus: GitSyncStatus;
  try {
    syncStatus = await readSyncStatus(storePath);
  } catch {
    throw syncStatusUnavailable();
  }
  if (syncStatus.conflict || syncStatus.sync_state === "conflict") {
    throw new MaintenanceRunBlockedError(
      "SYNC_CONFLICT",
      "Maintenance run blocked because the store has an unresolved sync conflict.",
      "resolve the sync conflict before retrying maintenance"
    );
  }
  if (syncStatus.error && !(syncStatus.configured === false && syncStatus.error === "Not a git repository")) {
    throw syncStatusUnavailable();
  }
  if (syncStatus.remote && syncStatus.remote_observation?.reachable !== true) {
    throw new MaintenanceRunBlockedError(
      "SYNC_STATUS_UNAVAILABLE",
      "Maintenance run blocked because the configured shared copy could not be verified.",
      "check sync status and retry maintenance after the shared copy is reachable"
    );
  }
  if (syncStatus.remote && (syncStatus.behind ?? 0) > 0) {
    throw new MaintenanceRunBlockedError(
      "SYNC_STATUS_UNAVAILABLE",
      "Maintenance run blocked because the shared copy has newer changes that are not present locally.",
      "pull the shared changes and retry maintenance after the local store is current"
    );
  }
  return {
    status: "clear",
    configured: syncStatus.configured,
    ...(syncStatus.sync_state === "clean" || syncStatus.sync_state === "dirty"
      ? { sync_state: syncStatus.sync_state }
      : {})
  };
}

/**
 * Runs one bounded, proof-gated maintenance pass and always verifies the event
 * store afterwards. Remote publication remains a separate sync_push operation.
 */
export async function runMaintenanceOnce(
  input: MaintenanceRunInput,
  dependencies: MaintenanceRunDependencies = {}
): Promise<MaintenanceRunReceipt> {
  const storePath = requiredString(input?.store_path, "store_path");
  const projectId = requiredString(input?.project_id, "project_id");
  const sourceClient = requiredString(input?.source?.client, "source.client");
  const source = { ...input.source, client: sourceClient };
  const syncPreflight = await verifySyncPreflight(storePath, dependencies.get_git_sync_status ?? getGitSyncStatus);
  await (dependencies.assert_git_event_history_append_only ?? assertGitEventHistoryAppendOnly)(storePath);
  const runAudit = dependencies.run_automatic_event_audit ?? runAutomaticEventAudit;
  const preflightEventAudit = await auditEvents(storePath, runAudit);
  if (preflightEventAudit.status === "failed") {
    return {
      status: "failed",
      project_id: projectId,
      sync_preflight: syncPreflight,
      maintenance: maintenanceBlockedByAudit(projectId),
      preflight_event_audit: preflightEventAudit,
      event_audit: preflightEventAudit,
      policy: policy()
    };
  }
  const engine = (dependencies.create_engine ?? createEngine)({ storePath });
  const maintenance = await runAutomaticSemanticMaintenance(engine, {
    project_id: projectId,
    source
  });
  const eventAudit = await auditEvents(storePath, runAudit);

  return {
    status: maintenance.status === "failed" || eventAudit.status === "failed" ? "failed" : "completed",
    project_id: projectId,
    sync_preflight: syncPreflight,
    maintenance,
    preflight_event_audit: preflightEventAudit,
    event_audit: eventAudit,
    policy: policy()
  };
}
