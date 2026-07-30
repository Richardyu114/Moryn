import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  dashboardServiceUnitPath,
  inspectDashboardService,
  installDashboardService,
  renderDashboardServiceUnit,
  repairDashboardService,
  restartDashboardService
} from "../../src/core/dashboard-service.js";

const runtime = {
  exec_file: "/usr/bin/node",
  exec_args: ["--enable-source-maps"],
  cli_entry: "/opt/moryn/dist/cli.js",
  platform: "linux" as const
};

describe("dashboard service", () => {
  it("renders a restartable user service with an explicit runtime and stable Dashboard arguments", () => {
    const unit = renderDashboardServiceUnit({
      store_path: "/var/lib/moryn store",
      runtime,
      host: "127.0.0.1",
      port: 18765,
      interval_ms: 2_000,
      limit: 30,
      project_id: "Moryn-349a446e"
    });

    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain('ExecStart="/usr/bin/node" "--enable-source-maps" "/opt/moryn/dist/cli.js"');
    expect(unit).toContain('"--store" "/var/lib/moryn store" "dashboard" "--serve" "--no-open"');
    expect(unit).toContain('"--port" "18765"');
    expect(unit).toContain('"--limit" "30"');
    expect(unit).toContain('"--project-id" "Moryn-349a446e"');
  });

  it("reports a missing unit without invoking systemctl", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      const exec = vi.fn();
      const status = await inspectDashboardService({ unitDirectory: root, exec });
      expect(status).toMatchObject({
        service_state: "not_installed",
        supervised: false,
        warnings: [{ code: "DASHBOARD_SERVICE_NOT_INSTALLED" }]
      });
      expect(exec).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("installs atomically, enables the unit, and returns supervised status", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      const exec = vi.fn(async (_command: string, args: readonly string[]) => ({
        stdout: args.includes("show")
          ? "LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=running\nMainPID=4321\nExecMainStatus=0\n"
          : "",
        stderr: ""
      }));
      const result = await installDashboardService(
        { store_path: join(root, "store"), runtime, port: 18765 },
        { unitDirectory: root, exec }
      );

      expect(result).toMatchObject({
        status: "completed",
        committed: true,
        unit_changed: true,
        service: { service_state: "active", supervised: true, main_pid: 4321 }
      });
      expect(exec.mock.calls.map((call) => call[1])).toEqual([
        ["--user", "daemon-reload"],
        ["--user", "enable", "--now", "moryn-dashboard.service"],
        [
          "--user",
          "show",
          "moryn-dashboard.service",
          "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStatus",
          "--no-pager"
        ]
      ]);
      expect(await readFile(dashboardServiceUnitPath({ unitDirectory: root }), "utf8")).toContain('"--port" "18765"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a durable partial receipt when systemd cannot start a written unit", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      const exec = vi.fn(async () => {
        throw new Error("user service manager unavailable");
      });
      const result = await installDashboardService(
        { store_path: join(root, "store"), runtime },
        { unitDirectory: root, exec }
      );

      expect(result).toMatchObject({
        status: "failed",
        committed: true,
        warnings: [{ code: "DASHBOARD_SERVICE_START_FAILED" }],
        service: { service_state: "unavailable", supervised: false }
      });
      expect(await readFile(dashboardServiceUnitPath({ unitDirectory: root }), "utf8")).toContain("Moryn Dashboard");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not report completion when systemd accepts the command but the service exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      const exec = vi.fn(async (_command: string, args: readonly string[]) => ({
        stdout: args.includes("show")
          ? "LoadState=loaded\nUnitFileState=enabled\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=1\n"
          : "",
        stderr: ""
      }));
      const result = await installDashboardService(
        { store_path: join(root, "store"), runtime },
        { unitDirectory: root, exec }
      );

      expect(result).toMatchObject({
        status: "failed",
        committed: true,
        warnings: [{ code: "DASHBOARD_SERVICE_START_FAILED" }],
        service: { service_state: "failed", supervised: false }
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim a restart when the unit is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      const result = await restartDashboardService({ unitDirectory: root, exec: vi.fn() });
      expect(result).toMatchObject({ status: "failed", committed: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not report an active but disabled unit as supervised", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      await installDashboardService(
        { store_path: join(root, "store"), runtime, port: 18765 },
        {
          unitDirectory: root,
          exec: vi.fn(async (_command: string, args: readonly string[]) => ({
            stdout: args.includes("show")
              ? "LoadState=loaded\nUnitFileState=disabled\nActiveState=active\nSubState=running\nMainPID=4321\nExecMainStatus=0\n"
              : "",
            stderr: ""
          }))
        }
      );

      const status = await inspectDashboardService({
        unitDirectory: root,
        exec: vi.fn(async () => ({
          stdout:
            "LoadState=loaded\nUnitFileState=disabled\nActiveState=active\nSubState=running\nMainPID=4321\nExecMainStatus=0\n",
          stderr: ""
        }))
      });
      expect(status).toMatchObject({
        service_state: "active",
        enabled: false,
        supervised: false,
        warnings: [{ code: "DASHBOARD_SERVICE_NOT_ENABLED" }]
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs the existing unit without replacing custom arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "moryn-dashboard-service-"));
    try {
      const exec = vi.fn(async (_command: string, args: readonly string[]) => ({
        stdout: args.includes("show")
          ? "LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=running\nMainPID=4321\nExecMainStatus=0\n"
          : "",
        stderr: ""
      }));
      await installDashboardService(
        {
          store_path: join(root, "store"),
          runtime,
          host: "0.0.0.0",
          port: 18765,
          limit: 30,
          project_id: "Moryn-349a446e"
        },
        { unitDirectory: root, exec }
      );
      const path = dashboardServiceUnitPath({ unitDirectory: root });
      const before = await readFile(path, "utf8");

      const repaired = await repairDashboardService({ unitDirectory: root, exec });

      expect(repaired).toMatchObject({
        status: "completed",
        action: "repaired",
        committed: true,
        unit_changed: false,
        service: { supervised: true, enabled: true }
      });
      expect(await readFile(path, "utf8")).toBe(before);
      expect(before).toContain('"--host" "0.0.0.0"');
      expect(before).toContain('"--port" "18765"');
      expect(before).toContain('"--limit" "30"');
      expect(before).toContain('"--project-id" "Moryn-349a446e"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
