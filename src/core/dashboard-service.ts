import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HostRuntimeDescriptor } from "./host-integration-artifacts.js";
import { execOperationChildProcess } from "./operation-deadline.js";

export const DASHBOARD_SERVICE_NAME = "moryn-dashboard.service";

export interface DashboardServiceConfig {
  store_path: string;
  runtime: HostRuntimeDescriptor;
  host?: string;
  port?: number;
  interval_ms?: number;
  limit?: number;
  project_path?: string;
  project_id?: string;
  include_private?: boolean;
  readiness_host?: string;
  sync_remote?: string;
}

export type DashboardServiceState = "active" | "inactive" | "failed" | "not_installed" | "unavailable";

export interface DashboardServiceStatus {
  service: typeof DASHBOARD_SERVICE_NAME;
  manager: "systemd_user";
  unit_path: string;
  service_state: DashboardServiceState;
  supervised: boolean;
  enabled: boolean;
  load_state?: string;
  unit_file_state?: string;
  active_state?: string;
  sub_state?: string;
  main_pid?: number;
  exec_main_status?: number;
  warnings?: Array<{ code: string; reason: string }>;
  next_action?: { command: string; safe_to_run: boolean };
}

interface DashboardServiceDeps {
  unitDirectory?: string;
  cwd?: string;
  exec?: typeof execOperationChildProcess;
}

function unitDirectory(deps: DashboardServiceDeps): string {
  return deps.unitDirectory ?? join(homedir(), ".config", "systemd", "user");
}

export function dashboardServiceUnitPath(deps: DashboardServiceDeps = {}): string {
  return join(unitDirectory(deps), DASHBOARD_SERVICE_NAME);
}

function validateText(value: string, field: string): string {
  if (!value.trim() || [...value].some((character) => (character.codePointAt(0) ?? 0) < 0x20)) {
    throw new Error(`Invalid argument: ${field} must be a non-empty string without control characters`);
  }
  return value;
}

function validatePort(value: number | undefined): number {
  const port = value ?? 8765;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid argument: dashboard service port must be an integer between 1 and 65535");
  }
  return port;
}

function validateInterval(value: number | undefined): number {
  const interval = value ?? 2_000;
  if (!Number.isInteger(interval) || interval < 250 || interval > 60_000) {
    throw new Error("Invalid argument: dashboard service interval_ms must be an integer between 250 and 60000");
  }
  return interval;
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Invalid argument: dashboard service limit must be an integer between 1 and 100");
  }
  return limit;
}

function systemdArgument(value: string): string {
  validateText(value, "dashboard service argument");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function dashboardServiceArguments(input: DashboardServiceConfig): string[] {
  const host = validateText(input.host ?? "127.0.0.1", "dashboard service host");
  const args = [
    ...(input.runtime.exec_args ?? []),
    validateText(input.runtime.cli_entry, "dashboard service cli_entry"),
    "--store",
    resolve(validateText(input.store_path, "dashboard service store_path")),
    "dashboard",
    "--serve",
    "--no-open",
    "--host",
    host,
    "--port",
    String(validatePort(input.port)),
    "--interval",
    String(validateInterval(input.interval_ms)),
    "--limit",
    String(validateLimit(input.limit))
  ];
  if (input.project_path) args.push("--project", resolve(validateText(input.project_path, "project_path")));
  if (input.project_id) args.push("--project-id", validateText(input.project_id, "project_id"));
  if (input.include_private) args.push("--include-private");
  if (input.readiness_host) args.push("--readiness-host", validateText(input.readiness_host, "readiness_host"));
  if (input.sync_remote) args.push("--sync-remote", validateText(input.sync_remote, "sync_remote"));
  return args;
}

export function renderDashboardServiceUnit(input: DashboardServiceConfig): string {
  if ((input.runtime.platform ?? process.platform) !== "linux") {
    throw new Error("Dashboard service supervision currently requires Linux systemd user services");
  }
  const executable = validateText(input.runtime.exec_file, "dashboard service exec_file");
  const command = [executable, ...dashboardServiceArguments(input)].map(systemdArgument).join(" ");
  const workingDirectory = resolve(input.project_path ?? dirname(input.runtime.cli_entry));
  return [
    "[Unit]",
    "Description=Moryn Dashboard",
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${systemdArgument(workingDirectory)}`,
    `ExecStart=${command}`,
    "Restart=on-failure",
    "RestartSec=2",
    "TimeoutStopSec=15",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

async function unitExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeUnit(path: string, content: string): Promise<{ changed: boolean }> {
  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing === content) return { changed: false };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { changed: true };
}

function parseSystemctlShow(output: string): Record<string, string> {
  return Object.fromEntries(
    output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
}

function numericProperty(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function inspectDashboardService(deps: DashboardServiceDeps = {}): Promise<DashboardServiceStatus> {
  const unitPath = dashboardServiceUnitPath(deps);
  const base = {
    service: DASHBOARD_SERVICE_NAME as typeof DASHBOARD_SERVICE_NAME,
    manager: "systemd_user" as const,
    unit_path: unitPath
  };
  if (!(await unitExists(unitPath))) {
    return {
      ...base,
      service_state: "not_installed",
      supervised: false,
      enabled: false,
      warnings: [{ code: "DASHBOARD_SERVICE_NOT_INSTALLED", reason: "Dashboard user service is not installed" }],
      next_action: { command: "moryn dashboard service install", safe_to_run: false }
    };
  }
  try {
    const result = await (deps.exec ?? execOperationChildProcess)(
      "systemctl",
      [
        "--user",
        "show",
        DASHBOARD_SERVICE_NAME,
        "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStatus",
        "--no-pager"
      ],
      { cwd: deps.cwd ?? process.cwd(), timeoutMs: 10_000 }
    );
    const properties = parseSystemctlShow(result.stdout);
    const activeState = properties.ActiveState;
    const enabled = properties.UnitFileState === "enabled";
    const serviceState: DashboardServiceState =
      activeState === "active" ? "active" : activeState === "failed" ? "failed" : "inactive";
    const supervised = serviceState === "active" && enabled;
    return {
      ...base,
      service_state: serviceState,
      supervised,
      enabled,
      load_state: properties.LoadState,
      unit_file_state: properties.UnitFileState,
      active_state: activeState,
      sub_state: properties.SubState,
      main_pid: numericProperty(properties.MainPID),
      exec_main_status: numericProperty(properties.ExecMainStatus),
      ...(supervised
        ? {}
        : {
            warnings: [
              serviceState === "active"
                ? {
                    code: "DASHBOARD_SERVICE_NOT_ENABLED",
                    reason: `Dashboard service is active but UnitFileState is ${properties.UnitFileState ?? "unknown"}`
                  }
                : { code: "DASHBOARD_SERVICE_INACTIVE", reason: `Dashboard service is ${serviceState}` }
            ],
            next_action: { command: "moryn dashboard service repair", safe_to_run: false }
          })
    };
  } catch (error) {
    return {
      ...base,
      service_state: "unavailable",
      supervised: false,
      enabled: false,
      warnings: [
        {
          code: "DASHBOARD_SERVICE_MANAGER_UNAVAILABLE",
          reason: error instanceof Error ? error.message : String(error)
        }
      ],
      next_action: { command: "moryn dashboard service repair", safe_to_run: false }
    };
  }
}

async function configureDashboardService(
  action: "installed" | "repaired",
  input: DashboardServiceConfig,
  deps: DashboardServiceDeps = {}
) {
  const path = dashboardServiceUnitPath(deps);
  const written = await writeUnit(path, renderDashboardServiceUnit(input));
  const exec = deps.exec ?? execOperationChildProcess;
  try {
    await exec("systemctl", ["--user", "daemon-reload"], {
      cwd: deps.cwd ?? process.cwd(),
      timeoutMs: 10_000
    });
    await exec("systemctl", ["--user", "enable", "--now", DASHBOARD_SERVICE_NAME], {
      cwd: deps.cwd ?? process.cwd(),
      timeoutMs: 20_000
    });
    const service = await inspectDashboardService(deps);
    if (!service.supervised) {
      return {
        status: "failed" as const,
        action,
        committed: true,
        unit_changed: written.changed,
        warnings: [
          {
            code: "DASHBOARD_SERVICE_START_FAILED",
            reason: `Dashboard service is not supervised; state is ${service.service_state}, unit file is ${service.unit_file_state ?? "unknown"}`
          }
        ],
        next_action: { command: "moryn dashboard service repair", safe_to_run: false },
        service
      };
    }
    return {
      status: "completed" as const,
      action,
      committed: true,
      unit_changed: written.changed,
      service
    };
  } catch (error) {
    return {
      status: "failed" as const,
      action,
      committed: true,
      unit_changed: written.changed,
      warnings: [
        {
          code: "DASHBOARD_SERVICE_START_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        }
      ],
      next_action: { command: "moryn dashboard service repair", safe_to_run: false },
      service: await inspectDashboardService(deps)
    };
  }
}

export function installDashboardService(input: DashboardServiceConfig, deps: DashboardServiceDeps = {}) {
  return configureDashboardService("installed", input, deps);
}

export async function repairDashboardService(deps: DashboardServiceDeps = {}) {
  const path = dashboardServiceUnitPath(deps);
  if (!(await unitExists(path))) {
    return {
      status: "failed" as const,
      action: "repaired" as const,
      committed: false,
      unit_changed: false,
      warnings: [{ code: "DASHBOARD_SERVICE_NOT_INSTALLED", reason: "Dashboard user service is not installed" }],
      next_action: { command: "moryn dashboard service install", safe_to_run: false },
      service: await inspectDashboardService(deps)
    };
  }
  const exec = deps.exec ?? execOperationChildProcess;
  let enabled = false;
  try {
    await exec("systemctl", ["--user", "daemon-reload"], {
      cwd: deps.cwd ?? process.cwd(),
      timeoutMs: 10_000
    });
    await exec("systemctl", ["--user", "enable", "--now", DASHBOARD_SERVICE_NAME], {
      cwd: deps.cwd ?? process.cwd(),
      timeoutMs: 20_000
    });
    enabled = true;
    const service = await inspectDashboardService(deps);
    if (!service.supervised) {
      return {
        status: "failed" as const,
        action: "repaired" as const,
        committed: true,
        unit_changed: false,
        warnings: [
          {
            code: "DASHBOARD_SERVICE_START_FAILED",
            reason: `Dashboard service is not supervised; state is ${service.service_state}, unit file is ${service.unit_file_state ?? "unknown"}`
          }
        ],
        next_action: { command: "moryn dashboard service repair", safe_to_run: false },
        service
      };
    }
    return {
      status: "completed" as const,
      action: "repaired" as const,
      committed: true,
      unit_changed: false,
      service
    };
  } catch (error) {
    return {
      status: "failed" as const,
      action: "repaired" as const,
      committed: enabled,
      unit_changed: false,
      warnings: [
        {
          code: "DASHBOARD_SERVICE_START_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        }
      ],
      next_action: { command: "moryn dashboard service repair", safe_to_run: false },
      service: await inspectDashboardService(deps)
    };
  }
}

export async function restartDashboardService(deps: DashboardServiceDeps = {}) {
  const path = dashboardServiceUnitPath(deps);
  if (!(await unitExists(path))) {
    return {
      status: "failed" as const,
      committed: false,
      warnings: [{ code: "DASHBOARD_SERVICE_NOT_INSTALLED", reason: "Dashboard user service is not installed" }],
      next_action: { command: "moryn dashboard service install", safe_to_run: false },
      service: await inspectDashboardService(deps)
    };
  }
  try {
    await (deps.exec ?? execOperationChildProcess)("systemctl", ["--user", "restart", DASHBOARD_SERVICE_NAME], {
      cwd: deps.cwd ?? process.cwd(),
      timeoutMs: 20_000
    });
    const service = await inspectDashboardService(deps);
    if (!service.supervised) {
      return {
        status: "failed" as const,
        committed: false,
        warnings: [
          {
            code: "DASHBOARD_SERVICE_RESTART_FAILED",
            reason: `Dashboard service is not supervised; state is ${service.service_state}, unit file is ${service.unit_file_state ?? "unknown"}`
          }
        ],
        next_action: { command: "moryn dashboard service repair", safe_to_run: false },
        service
      };
    }
    return { status: "completed" as const, committed: true, service };
  } catch (error) {
    return {
      status: "failed" as const,
      committed: false,
      warnings: [
        {
          code: "DASHBOARD_SERVICE_RESTART_FAILED",
          reason: error instanceof Error ? error.message : String(error)
        }
      ],
      next_action: { command: "moryn dashboard service repair", safe_to_run: false },
      service: await inspectDashboardService(deps)
    };
  }
}
