#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";

const LOG_PREFIX = "[moryn-dashboard-supervisor]";
const USAGE_EXIT_CODE = 64;
const SPAWN_FAILURE_EXIT_CODE = 127;
const MAX_CONFIGURED_DELAY_MS = 300_000;
const FORCED_STOP_WAIT_MS = 1_000;

function log(message) {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

function nonEmptyEnvironmentValue(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value.trim().length === 0) throw new Error(`${name} must not be empty`);
  return value;
}

function durationEnvironmentValue(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONFIGURED_DELAY_MS) {
    throw new Error(`${name} must be between 1 and ${MAX_CONFIGURED_DELAY_MS}`);
  }
  return value;
}

function portEnvironmentValue() {
  const raw = nonEmptyEnvironmentValue("MORYN_DASHBOARD_PORT", "8765");
  if (!/^\d+$/.test(raw)) throw new Error("MORYN_DASHBOARD_PORT must be an integer between 0 and 65535");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error("MORYN_DASHBOARD_PORT must be an integer between 0 and 65535");
  }
  return raw;
}

function readConfiguration() {
  const project = nonEmptyEnvironmentValue("MORYN_DASHBOARD_PROJECT", undefined);
  const projectId = nonEmptyEnvironmentValue("MORYN_DASHBOARD_PROJECT_ID", undefined);
  if (project !== undefined && projectId !== undefined) {
    throw new Error("set only one of MORYN_DASHBOARD_PROJECT and MORYN_DASHBOARD_PROJECT_ID");
  }

  const restartBaseMs = durationEnvironmentValue("MORYN_DASHBOARD_RESTART_BASE_MS", 250);
  const restartMaxMs = durationEnvironmentValue("MORYN_DASHBOARD_RESTART_MAX_MS", 10_000);
  if (restartMaxMs < restartBaseMs) {
    throw new Error("MORYN_DASHBOARD_RESTART_MAX_MS must be greater than or equal to the restart base");
  }

  const executable = nonEmptyEnvironmentValue("MORYN_DASHBOARD_EXECUTABLE", "moryn");
  const store = nonEmptyEnvironmentValue("MORYN_DASHBOARD_STORE", undefined);
  const host = nonEmptyEnvironmentValue("MORYN_DASHBOARD_HOST", "127.0.0.1");
  const port = portEnvironmentValue();
  const readinessHost = nonEmptyEnvironmentValue("MORYN_DASHBOARD_READINESS_HOST", undefined);
  const syncRemote = nonEmptyEnvironmentValue("MORYN_DASHBOARD_SYNC_REMOTE", undefined);

  const dashboardArguments = [
    ...(store === undefined ? [] : ["--store", store]),
    "dashboard",
    "--serve",
    "--no-open",
    "--host",
    host,
    "--port",
    port,
    ...(project === undefined ? [] : ["--project", project]),
    ...(projectId === undefined ? [] : ["--project-id", projectId]),
    ...(readinessHost === undefined ? [] : ["--readiness-host", readinessHost]),
    ...(syncRemote === undefined ? [] : ["--sync-remote", syncRemote])
  ];

  return {
    dashboardCommand: [executable, ...dashboardArguments],
    restartBaseMs,
    restartMaxMs,
    restartStableMs: durationEnvironmentValue("MORYN_DASHBOARD_RESTART_STABLE_MS", 30_000),
    stopGraceMs: durationEnvironmentValue("MORYN_DASHBOARD_STOP_GRACE_MS", 5_000)
  };
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function signalChildGroup(child, signal, label) {
  if (child === undefined || child.pid === undefined || !childIsRunning(child)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") log(`could not forward ${signal} to ${label}: ${error?.code ?? "unknown error"}`);
  }
}

function statusText(code, signal) {
  if (signal !== null) return `signal ${signal}`;
  return `exit ${code ?? "unknown"}`;
}

function exitCodeForMain(code, signal) {
  if (Number.isInteger(code) && code >= 0) return code;
  if (signal !== null) {
    const signalNumber = osConstants.signals[signal];
    if (Number.isInteger(signalNumber)) return 128 + signalNumber;
  }
  return 1;
}

function waitAtMost(promise, milliseconds) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, milliseconds);
    promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const mainCommand = process.argv.slice(2);
if (mainCommand.length === 0) {
  log("usage: moryn-dashboard-entrypoint.mjs <main-command> [args...]");
  process.exitCode = USAGE_EXIT_CODE;
} else {
  let configuration;
  try {
    configuration = readConfiguration();
  } catch (error) {
    log(`invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = USAGE_EXIT_CODE;
  }

  if (configuration !== undefined) {
    let dashboardState;
    let mainState;
    let restartTimer;
    let consecutiveDashboardFailures = 0;
    let shutdownRequested = false;
    let dashboardStopPromise;
    let finalizing = false;

    function clearDashboardRestart() {
      if (restartTimer !== undefined) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
    }

    function nextRestartDelay() {
      const exponent = Math.min(consecutiveDashboardFailures, 30);
      const delay = Math.min(configuration.restartMaxMs, configuration.restartBaseMs * 2 ** exponent);
      consecutiveDashboardFailures += 1;
      return delay;
    }

    function startDashboard() {
      if (shutdownRequested) return;

      const [executable, ...args] = configuration.dashboardCommand;
      const startedAt = Date.now();
      const child = spawn(executable, args, {
        detached: process.platform !== "win32",
        env: process.env,
        stdio: "inherit"
      });
      let resolveClose;
      const closePromise = new Promise((resolve) => {
        resolveClose = resolve;
      });
      const state = { child, closePromise, resolveClose, startedAt };
      dashboardState = state;

      child.once("spawn", () => log(`dashboard started (pid ${child.pid})`));
      child.once("error", (error) => {
        log(`dashboard failed to start: ${error.code ?? error.name}`);
      });
      child.once("close", (code, signal) => {
        state.resolveClose();
        if (dashboardState !== state) return;
        dashboardState = undefined;
        if (shutdownRequested) return;

        if (Date.now() - state.startedAt >= configuration.restartStableMs) consecutiveDashboardFailures = 0;
        const delay = nextRestartDelay();
        log(`dashboard stopped unexpectedly (${statusText(code, signal)}); restarting in ${delay} ms`);
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          startDashboard();
        }, delay);
      });
    }

    async function stopDashboard(signal) {
      clearDashboardRestart();
      if (dashboardStopPromise !== undefined) return dashboardStopPromise;

      const state = dashboardState;
      if (state === undefined) return;
      dashboardStopPromise = (async () => {
        signalChildGroup(state.child, signal, "dashboard");
        if (await waitAtMost(state.closePromise, configuration.stopGraceMs)) return;

        if (dashboardState === state && childIsRunning(state.child)) {
          log(`dashboard did not stop within ${configuration.stopGraceMs} ms; sending SIGKILL`);
          signalChildGroup(state.child, "SIGKILL", "dashboard");
          if (!(await waitAtMost(state.closePromise, FORCED_STOP_WAIT_MS))) {
            log("dashboard remained after SIGKILL; continuing with the main command exit");
            state.child.unref();
          }
        }
      })();
      return dashboardStopPromise;
    }

    async function finishFromMain(code, signal, spawnFailed) {
      if (finalizing) return;
      finalizing = true;
      shutdownRequested = true;
      clearDashboardRestart();
      await stopDashboard("SIGTERM");
      process.exitCode = spawnFailed ? SPAWN_FAILURE_EXIT_CODE : exitCodeForMain(code, signal);
    }

    function startMain() {
      const [executable, ...args] = mainCommand;
      const child = spawn(executable, args, {
        detached: process.platform !== "win32",
        env: process.env,
        stdio: "inherit"
      });
      const state = { child, spawnError: undefined };
      mainState = state;

      child.once("error", (error) => {
        state.spawnError = error;
        log(`main command failed to start: ${error.code ?? error.name}`);
      });
      child.once("close", (code, signal) => {
        if (mainState !== state) return;
        mainState = undefined;
        void finishFromMain(code, signal, state.spawnError !== undefined);
      });
    }

    function handleSignal(signal) {
      const firstSignal = !shutdownRequested;
      shutdownRequested = true;
      clearDashboardRestart();
      signalChildGroup(mainState?.child, signal, "main command");
      if (firstSignal) void stopDashboard(signal);
      else signalChildGroup(dashboardState?.child, signal, "dashboard");
    }

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));

    startDashboard();
    startMain();
  }
}
