import { resolve } from "node:path";
import { activateClaudeSettings } from "./claude-activation.js";
import { activateCodexHooks } from "./codex-activation.js";
import { initializeStore } from "./config.js";
import type { HostActivationStatus } from "./host-activation.js";
import { getHostAdapters, type HostAdapterId } from "./host-adapter-registry.js";
import { type HostRuntimeDescriptor, writeHostIntegrationArtifact } from "./host-integration-artifacts.js";
import { initializeProjectConfig, readProjectConfig } from "./project.js";
import { type SetupWizardPlan, setupWizard } from "./setup-wizard.js";

export type AutomationCheckStatus = "ready" | "missing" | "drift" | "blocked" | "manual" | "skipped";
export type AutomationStatus = "ready" | "needs_reconcile" | "needs_attention";

export interface AutomationCheck {
  status: AutomationCheckStatus;
  message: string;
}

export interface CompactHostActivationStatus {
  host: "claude" | "codex";
  status: HostActivationStatus["status"];
  healthy: boolean;
  repairable_automatically: boolean;
  runtime_binding_status: HostActivationStatus["runtime_binding_status"];
  target_path: string;
  suggested_action?: {
    id: string;
    command: string;
    safe_to_run: boolean;
  };
}

export interface AutomationStatusInput {
  storePath: string;
  projectPath?: string;
  host?: string;
  hostRuntime?: HostRuntimeDescriptor;
}

export interface AutomationStatusResult {
  ok: true;
  operation: "automation_status";
  status: AutomationStatus;
  ready: boolean;
  store_path: string;
  project_path?: string;
  project_id?: string;
  host?: HostAdapterId;
  checks: {
    store: AutomationCheck;
    project: AutomationCheck;
    host_activation: AutomationCheck;
  };
  host_activation?: CompactHostActivationStatus;
  next: {
    recommended_action: "none" | "reconcile" | "manual_review";
    command?: string;
    safe_to_run: boolean;
  };
  selection_sources: typeof AUTOMATION_STATUS_SELECTION_SOURCES;
}

export interface AutomationReconcileInput extends AutomationStatusInput {
  apply?: boolean;
  activateHost?: boolean;
}

export interface AutomationReconcileDependencies {
  initializeStore?: typeof initializeStore;
  initializeProjectConfig?: typeof initializeProjectConfig;
  writeHostIntegrationArtifact?: typeof writeHostIntegrationArtifact;
  activateClaudeSettings?: typeof activateClaudeSettings;
  activateCodexHooks?: typeof activateCodexHooks;
}

export type AutomationChangeId = "store_config" | "project_config" | "host_activation";
export type AutomationChangeStatus = "planned" | "applied" | "blocked";

export interface AutomationChange {
  status: AutomationChangeStatus;
  writes: "moryn_store" | "project_config" | "host_config";
  path: string;
  reason: string;
  requires_apply: true;
}

export interface AutomationReconcileResult {
  ok: true;
  operation: "automation_reconcile";
  mode: "dry_run" | "apply";
  status: "ready" | "changes_planned" | "reconciled" | "needs_attention";
  changed: boolean;
  committed: boolean;
  host_activation_requested: boolean;
  host_config_writes: "none" | "planned" | "applied";
  store_path: string;
  project_path?: string;
  project_id?: string;
  host?: HostAdapterId;
  changes: Partial<Record<AutomationChangeId, AutomationChange>>;
  checks: AutomationStatusResult["checks"];
  host_activation?: CompactHostActivationStatus;
  next: {
    recommended_action: "none" | "apply_changes" | "review_status";
    command?: string;
    safe_to_run: boolean;
  };
  selection_sources: typeof AUTOMATION_RECONCILE_SELECTION_SOURCES;
}

export const AUTOMATION_STATUS_SELECTION_SOURCES = {
  check: "checks.<check_id>",
  host_activation: "host_activation",
  next: "next"
} as const;

export const AUTOMATION_RECONCILE_SELECTION_SOURCES = {
  change: "changes.<change_id>",
  check: "checks.<check_id>",
  host_activation: "host_activation",
  next: "next"
} as const;

type NormalizedAutomationInput = AutomationStatusInput & {
  projectPath?: string;
  host?: HostAdapterId;
};

interface AutomationInspection {
  input: NormalizedAutomationInput;
  setup: SetupWizardPlan;
  activation?: HostActivationStatus;
  result: AutomationStatusResult;
}

class AutomationReconcilePartialCommitError extends Error {
  readonly code = "AUTOMATION_RECONCILE_PARTIALLY_COMMITTED";
  readonly committed = true;
  readonly recommended_action = "run automation status before retrying reconciliation";
  readonly recovery_hint: {
    applied_changes: AutomationChangeId[];
    partially_applied_changes: AutomationChangeId[];
    cause_recovery_hint?: unknown;
  };

  constructor(appliedChanges: AutomationChangeId[], partiallyAppliedChanges: AutomationChangeId[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Automation reconcile partially committed: ${reason}`);
    this.name = "AutomationReconcilePartialCommitError";
    const causeRecord = typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;
    this.recovery_hint = {
      applied_changes: appliedChanges,
      partially_applied_changes: partiallyAppliedChanges,
      ...(causeRecord?.recovery_hint !== undefined ? { cause_recovery_hint: causeRecord.recovery_hint } : {})
    };
  }
}

class HostActivationPartialCommitError extends Error {
  readonly committed = true;
  readonly recovery_hint: { applied_steps: string[]; applied_paths: string[] };

  constructor(appliedSteps: string[], appliedPaths: string[], cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Host activation partially committed: ${reason}`);
    this.name = "HostActivationPartialCommitError";
    this.recovery_hint = { applied_steps: appliedSteps, applied_paths: appliedPaths };
  }
}

function quoteCli(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function validateOptionalBoolean(value: unknown, argument: "apply" | "activate_host"): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`Invalid argument: ${argument} must be a boolean`);
  }
}

function assertAutomationInput(input: unknown): asserts input is AutomationStatusInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid argument: automation input must be an object");
  }
}

function normalizeHost(host: string | undefined): HostAdapterId | undefined {
  if (host === undefined) return undefined;
  if (typeof host !== "string" || host.trim().length === 0) {
    throw new Error("Invalid argument: host must be a non-empty string");
  }
  const key = host.trim().toLowerCase();
  const adapter = getHostAdapters().find((candidate) => candidate.id === key || candidate.aliases.includes(key));
  if (!adapter) throw new Error(`Invalid argument: unsupported automation host: ${host}`);
  return adapter.id;
}

function normalizeInput(input: AutomationStatusInput): NormalizedAutomationInput {
  assertAutomationInput(input);
  if (typeof input.storePath !== "string" || input.storePath.trim().length === 0) {
    throw new Error("Invalid argument: storePath must be a non-empty string");
  }
  if (
    input.projectPath !== undefined &&
    (typeof input.projectPath !== "string" || input.projectPath.trim().length === 0)
  ) {
    throw new Error("Invalid argument: project_path must be a non-empty string");
  }
  const host = normalizeHost(input.host);
  const projectPath = input.projectPath === undefined ? undefined : resolve(input.projectPath);
  if (host && !projectPath) {
    throw new Error("Invalid argument: host requires project_path for automation inspection");
  }
  return { ...input, projectPath, host };
}

function setupCheck(status: AutomationCheckStatus, message: string): AutomationCheck {
  return { status, message };
}

function compactActivation(status: HostActivationStatus): CompactHostActivationStatus {
  const suggested = status.suggested_actions[0];
  return {
    host: status.host,
    status: status.status,
    healthy: status.healthy,
    repairable_automatically: status.repairable_automatically,
    runtime_binding_status: status.runtime_binding_status,
    target_path: status.target_path,
    ...(suggested
      ? {
          suggested_action: {
            id: suggested.id,
            command: suggested.command,
            safe_to_run: suggested.safe_to_run
          }
        }
      : {})
  };
}

function reconcileCommand(input: NormalizedAutomationInput, apply = false, activateHost = false): string {
  const project = input.projectPath ? ` --project ${quoteCli(input.projectPath)}` : "";
  const host = input.host ? ` --host ${input.host}` : "";
  const applyFlag = apply ? " --apply" : "";
  const activateFlag = activateHost ? " --activate-host" : "";
  return `moryn automation reconcile${project}${host}${applyFlag}${activateFlag}`;
}

function statusCommand(input: NormalizedAutomationInput): string {
  const project = input.projectPath ? ` --project ${quoteCli(input.projectPath)}` : "";
  const host = input.host ? ` --host ${input.host}` : "";
  return `moryn automation status${project}${host}`;
}

function overallStatus(checks: AutomationStatusResult["checks"]): AutomationStatus {
  const statuses = Object.values(checks).map((check) => check.status);
  if (statuses.some((status) => status === "blocked" || status === "manual")) return "needs_attention";
  if (statuses.some((status) => status === "missing" || status === "drift")) return "needs_reconcile";
  return "ready";
}

async function inspectAutomation(input: AutomationStatusInput): Promise<AutomationInspection> {
  const normalized = normalizeInput(input);
  const setup = await setupWizard({
    storePath: normalized.storePath,
    projectPath: normalized.projectPath,
    host: normalized.host,
    hostRuntime: normalized.hostRuntime
  });
  const projectConfig = normalized.projectPath ? await readProjectConfig(normalized.projectPath) : undefined;
  const store = setup.checks_by_id.store;
  const project = setup.checks_by_id.project;
  let activationCheck: AutomationCheck;
  let activation: HostActivationStatus | undefined;

  if (!normalized.host) {
    activationCheck = setupCheck("skipped", "Host activation was not requested for inspection.");
  } else if (normalized.host !== "claude" && normalized.host !== "codex") {
    activationCheck = setupCheck(
      "manual",
      `${normalized.host} lifecycle integration requires host-managed configuration.`
    );
  } else if (project.status === "missing") {
    activationCheck = setupCheck("missing", "Project config must exist before host activation can be inspected.");
  } else if (store.status === "missing") {
    activationCheck = setupCheck("missing", "The Moryn store must exist before host activation can be inspected.");
  } else if (!setup.activation_status) {
    activationCheck = setupCheck("blocked", "Host activation inspection did not return usable evidence.");
  } else {
    activation = setup.activation_status;
    activationCheck = activation.healthy
      ? setupCheck("ready", `${activation.host} activation is ${activation.status}.`)
      : activation.repairable_automatically
        ? setupCheck("drift", `${activation.host} activation is ${activation.status} and can be reconciled explicitly.`)
        : setupCheck("blocked", `${activation.host} activation is ${activation.status} and requires manual review.`);
  }

  const checks: AutomationStatusResult["checks"] = {
    store: setupCheck(store.status, store.message),
    project: setupCheck(project.status, project.message),
    host_activation: activationCheck
  };
  const status = overallStatus(checks);
  const result: AutomationStatusResult = {
    ok: true,
    operation: "automation_status",
    status,
    ready: status === "ready",
    store_path: normalized.storePath,
    ...(normalized.projectPath ? { project_path: normalized.projectPath } : {}),
    ...(projectConfig?.project_id ? { project_id: projectConfig.project_id } : {}),
    ...(normalized.host ? { host: normalized.host } : {}),
    checks,
    ...(activation ? { host_activation: compactActivation(activation) } : {}),
    next:
      status === "ready"
        ? { recommended_action: "none", safe_to_run: true }
        : status === "needs_reconcile"
          ? {
              recommended_action: "reconcile",
              command: reconcileCommand(normalized, false, checks.host_activation.status === "drift"),
              safe_to_run: true
            }
          : { recommended_action: "manual_review", safe_to_run: false },
    selection_sources: AUTOMATION_STATUS_SELECTION_SOURCES
  };
  return { input: normalized, setup, activation, result };
}

export async function automationStatus(input: AutomationStatusInput): Promise<AutomationStatusResult> {
  return (await inspectAutomation(input)).result;
}

function localChanges(inspection: AutomationInspection): Partial<Record<AutomationChangeId, AutomationChange>> {
  return Object.fromEntries(
    inspection.setup.planned_writes.map((write) => [
      write.id,
      {
        status: "planned",
        writes: write.id === "store_config" ? "moryn_store" : "project_config",
        path: write.path,
        reason: write.reason,
        requires_apply: true
      } satisfies AutomationChange
    ])
  );
}

function plannedHostChange(inspection: AutomationInspection): AutomationChange | undefined {
  const host = inspection.input.host;
  const projectPath = inspection.input.projectPath;
  if (!host || !projectPath || (host !== "claude" && host !== "codex")) return undefined;
  const check = inspection.result.checks.host_activation;
  if (check.status === "ready" || check.status === "skipped" || check.status === "manual") return undefined;
  if (check.status === "blocked") {
    return {
      status: "blocked",
      writes: "host_config",
      path: inspection.activation?.target_path ?? projectPath,
      reason: check.message,
      requires_apply: true
    };
  }
  return {
    status: "planned",
    writes: "host_config",
    path: inspection.activation?.target_path ?? projectPath,
    reason: `Reconcile Moryn-owned ${host} lifecycle configuration after explicit host activation approval.`,
    requires_apply: true
  };
}

async function applyHostActivation(
  inspection: AutomationInspection,
  deps: AutomationReconcileDependencies
): Promise<AutomationChange | undefined> {
  const host = inspection.input.host;
  const projectPath = inspection.input.projectPath;
  if (!host || !projectPath || (host !== "claude" && host !== "codex")) return undefined;
  if (inspection.result.checks.host_activation.status === "ready") return undefined;
  if (!inspection.activation?.repairable_automatically) return plannedHostChange(inspection);
  const config = await readProjectConfig(projectPath);
  if (!config?.project_id) {
    return {
      status: "blocked",
      writes: "host_config",
      path: projectPath,
      reason: "Project config is missing project_id after local reconciliation.",
      requires_apply: true
    };
  }
  const fragment = await (deps.writeHostIntegrationArtifact ?? writeHostIntegrationArtifact)({
    host,
    project_id: config.project_id,
    project_path: projectPath,
    store_path: inspection.input.storePath,
    runtime: inspection.input.hostRuntime
  });
  const appliedSteps = [
    ...(fragment.runtime_binding?.created || fragment.runtime_binding?.updated ? ["runtime_binding"] : []),
    ...(fragment.created || fragment.updated ? ["integration_artifact"] : [])
  ];
  const appliedPaths = [
    ...(fragment.runtime_binding?.created || fragment.runtime_binding?.updated ? [fragment.runtime_binding.path] : []),
    ...(fragment.created || fragment.updated ? [fragment.path] : [])
  ];
  let activation: { target_path: string };
  try {
    activation =
      host === "claude"
        ? await (deps.activateClaudeSettings ?? activateClaudeSettings)({
            project_path: projectPath,
            artifact: fragment.artifact
          })
        : await (deps.activateCodexHooks ?? activateCodexHooks)({
            project_path: projectPath,
            artifact: fragment.artifact
          });
  } catch (error) {
    if (appliedSteps.length) throw new HostActivationPartialCommitError(appliedSteps, appliedPaths, error);
    throw error;
  }
  return {
    status: "applied",
    writes: "host_config",
    path: activation.target_path,
    reason: `Reconciled Moryn-owned ${host} lifecycle configuration.`,
    requires_apply: true
  };
}

function reconcileNext(
  input: NormalizedAutomationInput,
  mode: "dry_run" | "apply",
  changes: AutomationChange[],
  ready: boolean
) {
  const planned = changes.some((change) => change.status === "planned");
  const blocked = changes.some((change) => change.status === "blocked");
  if (blocked) {
    return {
      recommended_action: "review_status" as const,
      command: statusCommand(input),
      safe_to_run: true
    };
  }
  if (mode === "dry_run" && planned) {
    return {
      recommended_action: "apply_changes" as const,
      command: reconcileCommand(
        input,
        true,
        changes.some((change) => change.writes === "host_config")
      ),
      safe_to_run: false
    };
  }
  if (!ready) {
    return {
      recommended_action: "review_status" as const,
      command: statusCommand(input),
      safe_to_run: true
    };
  }
  return { recommended_action: "none" as const, safe_to_run: true };
}

export async function automationReconcile(
  input: AutomationReconcileInput,
  deps: AutomationReconcileDependencies = {}
): Promise<AutomationReconcileResult> {
  assertAutomationInput(input);
  validateOptionalBoolean(input.apply, "apply");
  validateOptionalBoolean(input.activateHost, "activate_host");
  if (input.activateHost && (!input.host || !input.projectPath)) {
    throw new Error("Invalid argument: activate_host requires host and project_path");
  }
  const initial = await inspectAutomation(input);
  if (input.activateHost && initial.input.host !== "claude" && initial.input.host !== "codex") {
    throw new Error("Invalid argument: activate_host supports only claude or codex");
  }

  const mode = input.apply === true ? "apply" : "dry_run";
  const changes = localChanges(initial);
  if (input.activateHost) {
    const hostChange = plannedHostChange(initial);
    if (hostChange) changes.host_activation = hostChange;
  }

  if (mode === "dry_run") {
    const values = Object.values(changes);
    const planned = values.some((change) => change.status === "planned");
    return {
      ok: true,
      operation: "automation_reconcile",
      mode,
      status: planned ? "changes_planned" : initial.result.ready ? "ready" : "needs_attention",
      changed: false,
      committed: false,
      host_activation_requested: input.activateHost === true,
      host_config_writes: changes.host_activation?.status === "planned" ? "planned" : "none",
      store_path: initial.result.store_path,
      ...(initial.result.project_path ? { project_path: initial.result.project_path } : {}),
      ...(initial.result.project_id ? { project_id: initial.result.project_id } : {}),
      ...(initial.result.host ? { host: initial.result.host } : {}),
      changes,
      checks: initial.result.checks,
      ...(initial.result.host_activation ? { host_activation: initial.result.host_activation } : {}),
      next: reconcileNext(initial.input, mode, values, initial.result.ready),
      selection_sources: AUTOMATION_RECONCILE_SELECTION_SOURCES
    };
  }

  let final: AutomationInspection;
  try {
    if (changes.store_config?.status === "planned") {
      await (deps.initializeStore ?? initializeStore)(initial.input.storePath);
      changes.store_config = { ...changes.store_config, status: "applied" };
    }
    if (changes.project_config?.status === "planned" && initial.input.projectPath) {
      await (deps.initializeProjectConfig ?? initializeProjectConfig)(initial.input.projectPath, {});
      changes.project_config = { ...changes.project_config, status: "applied" };
    }
    if (input.activateHost) {
      const afterLocal = await inspectAutomation(initial.input);
      const hostChange = await applyHostActivation(afterLocal, deps);
      if (hostChange) changes.host_activation = hostChange;
      else delete changes.host_activation;
    }
    final = await inspectAutomation(initial.input);
  } catch (error) {
    const appliedChanges = Object.entries(changes)
      .filter((entry): entry is [AutomationChangeId, AutomationChange] => entry[1]?.status === "applied")
      .map(([changeId]) => changeId);
    const errorRecord = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
    const partiallyAppliedChanges: AutomationChangeId[] =
      errorRecord?.committed === true && changes.host_activation ? ["host_activation"] : [];
    if (appliedChanges.length || partiallyAppliedChanges.length) {
      throw new AutomationReconcilePartialCommitError(appliedChanges, partiallyAppliedChanges, error);
    }
    throw error;
  }
  const values = Object.values(changes);
  const applied = values.some((change) => change.status === "applied");
  const blocked = values.some((change) => change.status === "blocked");
  return {
    ok: true,
    operation: "automation_reconcile",
    mode,
    status: final.result.ready ? (applied ? "reconciled" : "ready") : "needs_attention",
    changed: applied,
    committed: applied,
    host_activation_requested: input.activateHost === true,
    host_config_writes: changes.host_activation?.status === "applied" ? "applied" : "none",
    store_path: final.result.store_path,
    ...(final.result.project_path ? { project_path: final.result.project_path } : {}),
    ...(final.result.project_id ? { project_id: final.result.project_id } : {}),
    ...(final.result.host ? { host: final.result.host } : {}),
    changes,
    checks: final.result.checks,
    ...(final.result.host_activation ? { host_activation: final.result.host_activation } : {}),
    next: blocked
      ? reconcileNext(final.input, mode, values, final.result.ready)
      : final.result.ready
        ? { recommended_action: "none", safe_to_run: true }
        : {
            recommended_action: "review_status",
            command: statusCommand(final.input),
            safe_to_run: true
          },
    selection_sources: AUTOMATION_RECONCILE_SELECTION_SOURCES
  };
}
