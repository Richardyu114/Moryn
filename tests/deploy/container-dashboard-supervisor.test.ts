import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

interface SupervisorEvent {
  role: "dashboard" | "main";
  event: string;
  pid: number;
  at: number;
  argv?: string[];
  signal?: string;
  code?: number;
  attempt?: number;
}

interface TestContext {
  directory: string;
  eventLog: string;
  crashCount: string;
}

interface SupervisorRun {
  child: ChildProcess;
  close: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stderr: () => string;
}

const entrypoint = resolve("deploy/container/moryn-dashboard-entrypoint.mjs");
const processFixture = resolve("tests/fixtures/container-supervisor-process.mjs");
const activeRuns = new Set<SupervisorRun>();
const contexts = new Set<TestContext>();
const supervisorEnvironmentKeys = [
  "MORYN_DASHBOARD_EXECUTABLE",
  "MORYN_DASHBOARD_STORE",
  "MORYN_DASHBOARD_HOST",
  "MORYN_DASHBOARD_PORT",
  "MORYN_DASHBOARD_PROJECT",
  "MORYN_DASHBOARD_PROJECT_ID",
  "MORYN_DASHBOARD_READINESS_HOST",
  "MORYN_DASHBOARD_SYNC_REMOTE",
  "MORYN_DASHBOARD_RESTART_BASE_MS",
  "MORYN_DASHBOARD_RESTART_MAX_MS",
  "MORYN_DASHBOARD_RESTART_STABLE_MS",
  "MORYN_DASHBOARD_STOP_GRACE_MS",
  "TEST_DASHBOARD_CRASHES",
  "TEST_DASHBOARD_CRASH_COUNT_PATH",
  "TEST_DASHBOARD_CRASH_AFTER_MS",
  "TEST_DASHBOARD_STOP_DELAY_MS",
  "TEST_DASHBOARD_IGNORE_SIGNALS",
  "TEST_SUPERVISOR_EVENT_LOG"
];

async function testContext(): Promise<TestContext> {
  const directory = await mkdtemp(join(tmpdir(), "moryn-dashboard-supervisor-"));
  const context = {
    directory,
    eventLog: join(directory, "events.jsonl"),
    crashCount: join(directory, "dashboard-crashes")
  };
  contexts.add(context);
  return context;
}

function runSupervisor(
  context: TestContext,
  mainArguments: string[],
  environment: Record<string, string> = {}
): SupervisorRun {
  const childEnvironment = { ...process.env };
  for (const key of supervisorEnvironmentKeys) delete childEnvironment[key];
  Object.assign(childEnvironment, {
    MORYN_DASHBOARD_EXECUTABLE: processFixture,
    MORYN_DASHBOARD_RESTART_BASE_MS: "20",
    MORYN_DASHBOARD_RESTART_MAX_MS: "80",
    MORYN_DASHBOARD_RESTART_STABLE_MS: "1000",
    MORYN_DASHBOARD_STOP_GRACE_MS: "1000",
    TEST_SUPERVISOR_EVENT_LOG: context.eventLog,
    ...environment
  });

  const child = spawn(process.execPath, [entrypoint, ...mainArguments], {
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout?.resume();
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const run = { child, close, stderr: () => stderr };
  activeRuns.add(run);
  void close.then(() => activeRuns.delete(run));
  return run;
}

async function events(context: TestContext): Promise<SupervisorEvent[]> {
  let contents: string;
  try {
    contents = await readFile(context.eventLog, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return contents
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SupervisorEvent);
}

async function waitForEvent(
  context: TestContext,
  predicate: (event: SupervisorEvent) => boolean
): Promise<SupervisorEvent> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const match = (await events(context)).find(predicate);
    if (match !== undefined) return match;
    await delay(10);
  }
  throw new Error("timed out waiting for supervisor fixture event");
}

afterEach(async () => {
  for (const run of activeRuns) {
    if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
  }
  for (const context of contexts) {
    for (const event of await events(context)) {
      if (event.pid <= 1) continue;
      try {
        process.kill(-event.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(context.directory, { force: true, recursive: true });
  }
  activeRuns.clear();
  contexts.clear();
});

describe("opt-in container Dashboard supervisor", () => {
  it("uses the configured Moryn command, stops the Dashboard, and returns the main command status", async () => {
    const context = await testContext();
    const store = join(context.directory, "store");
    const run = runSupervisor(context, [process.execPath, processFixture, "main-exit", "7", "120"], {
      MORYN_DASHBOARD_STORE: store,
      MORYN_DASHBOARD_HOST: "0.0.0.0",
      MORYN_DASHBOARD_PORT: "18765",
      MORYN_DASHBOARD_PROJECT: "/workspace",
      MORYN_DASHBOARD_READINESS_HOST: "codex",
      MORYN_DASHBOARD_SYNC_REMOTE: "origin"
    });

    await expect(run.close).resolves.toEqual({ code: 7, signal: null });
    const recorded = await events(context);
    expect(recorded.find((event) => event.role === "dashboard" && event.event === "start")?.argv).toEqual([
      "--store",
      store,
      "dashboard",
      "--serve",
      "--no-open",
      "--host",
      "0.0.0.0",
      "--port",
      "18765",
      "--project",
      "/workspace",
      "--readiness-host",
      "codex",
      "--sync-remote",
      "origin"
    ]);
    expect(recorded).toContainEqual(expect.objectContaining({ role: "dashboard", event: "signal", signal: "SIGTERM" }));
    expect(recorded).toContainEqual(expect.objectContaining({ role: "dashboard", event: "graceful_exit" }));
  });

  it("restarts a crashing Dashboard with capped backoff without replacing the main command status", async () => {
    const context = await testContext();
    const run = runSupervisor(context, [process.execPath, processFixture, "main-exit", "9", "500"], {
      MORYN_DASHBOARD_RESTART_BASE_MS: "15",
      MORYN_DASHBOARD_RESTART_MAX_MS: "40",
      TEST_DASHBOARD_CRASHES: "4",
      TEST_DASHBOARD_CRASH_COUNT_PATH: context.crashCount
    });

    await expect(run.close).resolves.toEqual({ code: 9, signal: null });
    const starts = (await events(context)).filter((event) => event.role === "dashboard" && event.event === "start");
    expect(starts).toHaveLength(5);
    expect(run.stderr()).toContain("restarting in 15 ms");
    expect(run.stderr()).toContain("restarting in 30 ms");
    expect(run.stderr().match(/restarting in 40 ms/g)).toHaveLength(2);
    expect(run.stderr()).not.toContain("restarting in 80 ms");
  });

  it.each([
    ["SIGTERM" as const, 31],
    ["SIGINT" as const, 32]
  ])("forwards %s to both process groups and preserves the main command's chosen exit", async (signal, exitCode) => {
    const context = await testContext();
    const run = runSupervisor(context, [process.execPath, processFixture, "main-signal", String(exitCode), "20"]);
    await waitForEvent(context, (event) => event.role === "main" && event.event === "start");
    await waitForEvent(context, (event) => event.role === "dashboard" && event.event === "start");

    run.child.kill(signal);

    await expect(run.close).resolves.toEqual({ code: exitCode, signal: null });
    const recorded = await events(context);
    expect(recorded).toContainEqual(expect.objectContaining({ role: "main", event: "signal", signal }));
    expect(recorded).toContainEqual(expect.objectContaining({ role: "dashboard", event: "signal", signal }));
    expect(recorded).toContainEqual(expect.objectContaining({ role: "dashboard", event: "graceful_exit" }));
  });

  it("bounds Dashboard shutdown without changing the main command result", async () => {
    const context = await testContext();
    const run = runSupervisor(context, [process.execPath, processFixture, "main-exit", "12", "80"], {
      MORYN_DASHBOARD_STOP_GRACE_MS: "30",
      TEST_DASHBOARD_IGNORE_SIGNALS: "1"
    });

    await expect(run.close).resolves.toEqual({ code: 12, signal: null });
    expect(run.stderr()).toContain("dashboard did not stop within 30 ms; sending SIGKILL");
    expect(await events(context)).not.toContainEqual(
      expect.objectContaining({ role: "dashboard", event: "graceful_exit" })
    );
  });

  it("refuses to start the Dashboard when no foreground command was supplied", async () => {
    const context = await testContext();
    const run = runSupervisor(context, []);

    await expect(run.close).resolves.toEqual({ code: 64, signal: null });
    expect(await events(context)).toEqual([]);
    expect(run.stderr()).toContain("usage: moryn-dashboard-entrypoint.mjs <main-command> [args...]");
  });

  it("documents the opt-in boundary without wiring tunnel or container restart management", async () => {
    const [documentation, source, packageJsonText] = await Promise.all([
      readFile("deploy/container/README.md", "utf8"),
      readFile(entrypoint, "utf8"),
      readFile("package.json", "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonText) as {
      bin: Record<string, string>;
      files: string[];
      scripts: Record<string, string>;
    };

    const normalizedDocumentation = documentation.replace(/\s+/g, " ");
    expect(normalizedDocumentation).toContain("Nothing invokes this entrypoint automatically");
    expect(normalizedDocumentation).toContain("does not start or restart a reverse proxy");
    expect(documentation).toContain("`forward-internal`");
    expect(normalizedDocumentation).toContain("does not configure or replace a Docker/Compose restart policy");
    expect(normalizedDocumentation).toContain("does not read, store, mint, rotate, or log access tokens");
    expect(source).not.toContain("forward-internal");
    expect(source).not.toContain("cloudflared");
    expect(packageJson.files).toContain("deploy/container");
    expect(Object.values(packageJson.bin)).not.toContain("deploy/container/moryn-dashboard-entrypoint.mjs");
    expect(Object.values(packageJson.scripts).join(" ")).not.toContain("moryn-dashboard-entrypoint");
  });
});
