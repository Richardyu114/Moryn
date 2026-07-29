#!/usr/bin/env node

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const eventLog = process.env.TEST_SUPERVISOR_EVENT_LOG;
const arguments_ = process.argv.slice(2);

function record(event) {
  if (eventLog === undefined) return;
  appendFileSync(eventLog, `${JSON.stringify({ ...event, pid: process.pid, at: Date.now() })}\n`);
}

function keepAlive() {
  setInterval(() => {}, 1_000);
}

function runDashboard() {
  let stopping = false;
  let crashTimer;
  const stopDelay = Number(process.env.TEST_DASHBOARD_STOP_DELAY_MS ?? "5");
  const ignoreSignals = process.env.TEST_DASHBOARD_IGNORE_SIGNALS === "1";

  const handleSignal = (signal) => {
    record({ role: "dashboard", event: "signal", signal });
    if (ignoreSignals || stopping) return;
    stopping = true;
    if (crashTimer !== undefined) clearTimeout(crashTimer);
    setTimeout(() => {
      record({ role: "dashboard", event: "graceful_exit" });
      process.exit(0);
    }, stopDelay);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
  record({ role: "dashboard", event: "start", argv: arguments_ });

  const crashLimit = Number(process.env.TEST_DASHBOARD_CRASHES ?? "0");
  const crashCountPath = process.env.TEST_DASHBOARD_CRASH_COUNT_PATH;
  let attempt = 1;
  if (crashCountPath !== undefined) {
    try {
      attempt = Number(readFileSync(crashCountPath, "utf8")) + 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    writeFileSync(crashCountPath, String(attempt));
  }

  if (attempt <= crashLimit) {
    crashTimer = setTimeout(() => {
      record({ role: "dashboard", event: "crash", attempt });
      process.exit(23);
    }, Number(process.env.TEST_DASHBOARD_CRASH_AFTER_MS ?? "5"));
  }
  keepAlive();
}

function runMain() {
  const mode = arguments_[0];
  const exitCode = Number(arguments_[1] ?? "0");
  const delay = Number(arguments_[2] ?? "20");

  if (mode === "main-exit") {
    record({ role: "main", event: "start" });
    setTimeout(() => {
      record({ role: "main", event: "exit", code: exitCode });
      process.exit(exitCode);
    }, delay);
    return;
  }

  if (mode === "main-signal") {
    let stopping = false;
    const handleSignal = (signal) => {
      record({ role: "main", event: "signal", signal });
      if (stopping) return;
      stopping = true;
      setTimeout(() => {
        record({ role: "main", event: "exit", code: exitCode });
        process.exit(exitCode);
      }, delay);
    };
    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));
    record({ role: "main", event: "start" });
    keepAlive();
    return;
  }

  record({ role: "main", event: "invalid_mode", mode });
  process.exit(2);
}

if (arguments_.includes("dashboard") && arguments_.includes("--serve")) runDashboard();
else runMain();
