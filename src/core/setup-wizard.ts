import { readStoreConfig, initializeStore } from "./config.js";
import { readProjectConfig, initializeProjectConfig } from "./project.js";
import { normalizeHostId, planInstall, type HostAdapterId, type InstallPlanAction } from "./host-adapters.js";

export type SetupWizardCheckId = "store" | "project" | "sync" | "host_adapter";
export type SetupWizardCheckStatus = "ready" | "missing" | "manual" | "skipped";
export type SetupWizardMode = "dry_run" | "apply";
export type SetupWizardStatus = "ready" | "needs_setup";

export type SetupWizardCheck = {
  id: SetupWizardCheckId;
  status: SetupWizardCheckStatus;
  message: string;
};

export type SetupWizardApplyResult = {
  applied_action_ids: Array<"initialize_store" | "initialize_project">;
  skipped_action_ids: string[];
  host_config_writes: "none";
};

export type SetupWizardPlan = {
  ok: true;
  mode: SetupWizardMode;
  status: SetupWizardStatus;
  generated_from: {
    store: "local_filesystem";
    writes: "none" | "moryn_local_setup";
    host_config_writes: "none";
  };
  host: HostAdapterId | "all";
  project_path?: string;
  sync_remote?: string;
  checks: SetupWizardCheck[];
  checks_by_id: Record<SetupWizardCheckId, SetupWizardCheck>;
  actions: InstallPlanAction[];
  actions_by_id: Record<string, InstallPlanAction>;
  warnings: string[];
  next: {
    recommended_action: "apply_setup" | "run_context_pack";
    command: string;
    safe_to_run: boolean;
  };
  apply_result?: SetupWizardApplyResult;
  selection_sources: typeof SETUP_WIZARD_SELECTION_SOURCES;
};

export type SetupWizardInput = {
  storePath: string;
  host?: string;
  projectPath?: string;
  syncRemote?: string;
  apply?: boolean;
};

export const SETUP_WIZARD_SELECTION_SOURCES = {
  setup: "setup",
  check: "checks_by_id.<check>",
  ordered_check: "checks[]",
  action: "actions_by_id.<action>",
  ordered_action: "actions[]",
  next: "next",
  apply_result: "apply_result",
  warning: "warnings[]"
} as const;

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function storeCheck(storePath: string): Promise<SetupWizardCheck> {
  try {
    await readStoreConfig(storePath);
    return {
      id: "store",
      status: "ready",
      message: "Local Moryn store is initialized."
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        id: "store",
        status: "missing",
        message: "Local Moryn store is missing; run moryn init or apply setup."
      };
    }
    throw error;
  }
}

async function projectCheck(projectPath?: string): Promise<SetupWizardCheck> {
  if (!projectPath) {
    return {
      id: "project",
      status: "skipped",
      message: "No project path was supplied."
    };
  }

  const config = await readProjectConfig(projectPath);
  return config
    ? {
        id: "project",
        status: "ready",
        message: "Project has a Moryn config."
      }
    : {
        id: "project",
        status: "missing",
        message: "Project has no .moryn.json; apply setup or run moryn project init."
      };
}

function syncCheck(syncRemote?: string): SetupWizardCheck {
  return syncRemote
    ? {
        id: "sync",
        status: "manual",
        message: "Sync remote was supplied; setup includes it in generated commands but does not initialize Git sync automatically."
      }
    : {
        id: "sync",
        status: "skipped",
        message: "No sync remote was supplied."
      };
}

function hostAdapterCheck(host?: string): SetupWizardCheck {
  const normalized = host ? normalizeHostId(host) : "all";
  return {
    id: "host_adapter",
    status: "manual",
    message: normalized === "all"
      ? "Host MCP registration is printed for each adapter and must be applied outside Moryn."
      : `Host MCP registration for ${normalized} is printed and must be applied outside Moryn.`
  };
}

function checksById(checks: SetupWizardCheck[]): Record<SetupWizardCheckId, SetupWizardCheck> {
  return Object.fromEntries(checks.map((check) => [check.id, check])) as Record<SetupWizardCheckId, SetupWizardCheck>;
}

function setupStatus(checks: SetupWizardCheck[]): SetupWizardStatus {
  return checks.some((check) => check.status === "missing") ? "needs_setup" : "ready";
}

function setupCommand(input: SetupWizardInput): string {
  const hostArg = input.host ? ` --host ${quoteCli(input.host)}` : "";
  const projectArg = input.projectPath ? ` --project ${quoteCli(input.projectPath)}` : "";
  const syncArg = input.syncRemote ? ` --sync-remote ${quoteCli(input.syncRemote)}` : "";
  return `moryn setup --apply${hostArg}${projectArg}${syncArg}`;
}

function uniqueActions(actions: InstallPlanAction[]): InstallPlanAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.action)) return false;
    seen.add(action.action);
    return true;
  });
}

async function applySetup(input: SetupWizardInput, actions: InstallPlanAction[]): Promise<SetupWizardApplyResult> {
  const appliedActionIds: SetupWizardApplyResult["applied_action_ids"] = [];
  await initializeStore(input.storePath);
  appliedActionIds.push("initialize_store");
  if (input.projectPath) {
    await initializeProjectConfig(input.projectPath, {});
    appliedActionIds.push("initialize_project");
  }
  const applied = new Set<string>(appliedActionIds);
  return {
    applied_action_ids: appliedActionIds,
    skipped_action_ids: uniqueActions(actions).map((action) => action.action).filter((action) => !applied.has(action)),
    host_config_writes: "none"
  };
}

export async function setupWizard(input: SetupWizardInput): Promise<SetupWizardPlan> {
  const installPlan = planInstall({
    host: input.host,
    projectPath: input.projectPath,
    syncRemote: input.syncRemote,
    apply: input.apply
  });
  const applyResult = input.apply ? await applySetup(input, installPlan.actions) : undefined;
  const checks = [
    await storeCheck(input.storePath),
    await projectCheck(input.projectPath),
    syncCheck(input.syncRemote),
    hostAdapterCheck(input.host)
  ];
  const status = setupStatus(checks);
  const actions = installPlan.actions;
  const next = input.apply || status === "ready"
    ? {
        recommended_action: "run_context_pack" as const,
        command: installPlan.next.command,
        safe_to_run: true
      }
    : {
        recommended_action: "apply_setup" as const,
        command: setupCommand(input),
        safe_to_run: false
      };

  return {
    ok: true,
    mode: input.apply ? "apply" : "dry_run",
    status,
    generated_from: {
      store: "local_filesystem",
      writes: input.apply ? "moryn_local_setup" : "none",
      host_config_writes: "none"
    },
    host: installPlan.host,
    project_path: input.projectPath,
    sync_remote: input.syncRemote,
    checks,
    checks_by_id: checksById(checks),
    actions,
    actions_by_id: installPlan.actions_by_id,
    warnings: [
      "Setup never mutates host configuration files.",
      ...installPlan.warnings
    ],
    next,
    ...(applyResult ? { apply_result: applyResult } : {}),
    selection_sources: SETUP_WIZARD_SELECTION_SOURCES
  };
}

function quoteCli(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
