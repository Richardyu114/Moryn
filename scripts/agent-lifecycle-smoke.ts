import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface CliOptions {
  remote?: string;
  keepTemp?: boolean;
  useSource?: boolean;
}

interface JsonAction {
  action: string;
  tool: string;
  command: string;
  required_fields: string[];
  arguments: Record<string, unknown>;
}

interface AgentStatusOutput {
  record: {
    updated_at: string;
  };
  sync: {
    push?: { pushed?: boolean };
  };
  next: {
    actions: JsonAction[];
  };
}

interface AgentStartOutput {
  refresh: {
    cursor: string;
    changes: Array<{ summary: string; importance: string }>;
  };
  boot: {
    recent_changes: Array<{ content?: { text?: string } }>;
  };
  sync: {
    pull?: { pulled?: boolean };
  };
  next: {
    actions: JsonAction[];
  };
}

interface AgentFinishOutput {
  sync: {
    push?: { pushed?: boolean };
  };
  next: {
    actions: JsonAction[];
  };
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    remote: process.env.MORYN_AGENT_LIFECYCLE_REMOTE?.trim() || process.env.MORYN_PRIVATE_GIT_REMOTE?.trim() || undefined,
    keepTemp: process.env.MORYN_SMOKE_KEEP_TEMP === "1",
    useSource: process.env.MORYN_SMOKE_USE_DIST === "1" ? false : true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      const remote = argv[index + 1]?.trim();
      if (!remote) throw new Error("--remote requires a Git remote path or URL");
      options.remote = remote;
      index += 1;
    } else if (arg === "--keep-temp") {
      options.keepTemp = true;
    } else if (arg === "--source") {
      options.useSource = true;
    } else if (arg === "--dist") {
      options.useSource = false;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`Usage: npm run smoke:agent-lifecycle -- [--remote <git-remote>] [--source|--dist] [--keep-temp]\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const { stdout } = await exec(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env
  });
  return stdout;
}

async function runJson<T>(command: string, args: string[], options: RunOptions = {}): Promise<T> {
  return JSON.parse(await run(command, args, options)) as T;
}

function requireAction(actions: JsonAction[], action: string, tool: string): JsonAction {
  const found = actions.find((candidate) => candidate.action === action && candidate.tool === tool);
  if (!found) throw new Error(`Missing next action ${action} for ${tool}`);
  return found;
}

function requireChange(output: AgentStartOutput, summary: string): void {
  if (!output.refresh.changes.some((change) => change.summary.includes(summary))) {
    throw new Error(`Expected refresh changes to include: ${summary}`);
  }
}

function requireRecentChange(output: AgentStartOutput, summary: string): void {
  if (!output.boot.recent_changes.some((record) => record.content?.text?.includes(summary))) {
    throw new Error(`Expected boot recent_changes to include: ${summary}`);
  }
}

async function resolveMorynCommand(useSource: boolean): Promise<{ command: string; argsPrefix: string[] }> {
  if (useSource) {
    return { command: "node", argsPrefix: ["--import", "tsx", "src/cli.ts"] };
  }

  const distCli = join(process.cwd(), "dist", "cli.js");
  return { command: "node", argsPrefix: [distCli] };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "moryn-agent-lifecycle-smoke-"));
  const storeCodex = join(root, "store-codex");
  const storeGemini = join(root, "store-gemini");
  const project = join(root, "project");
  const remote = options.remote ?? join(root, "remote.git");
  const { command, argsPrefix } = await resolveMorynCommand(options.useSource ?? false);

  try {
    if (!options.remote) {
      await run("git", ["init", "--bare", remote]);
    }

    await run(command, [...argsPrefix, "project", "init", "--path", project, "--project-id", "moryn-smoke", "--tag", "typescript"]);

    const statusSummary = "Codex smoke status reached Gemini";
    const status = await runJson<AgentStatusOutput>(command, [
      ...argsPrefix,
      "--store",
      storeCodex,
      "agent",
      "status",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "codex",
      "--session-id",
      "codex-smoke",
      "--current-task",
      "verify cross device lifecycle smoke",
      "--status",
      statusSummary
    ]);

    if (status.sync.push?.pushed !== true) throw new Error("Codex status did not push to sync remote");
    const statusFinish = requireAction(status.next.actions, "finish_session", "agent_finish");
    const statusRefresh = requireAction(status.next.actions, "refresh_context", "agent_start");
    if (statusRefresh.arguments.refresh_since !== status.record.updated_at) {
      throw new Error("Status refresh_context cursor does not match status record timestamp");
    }
    if (!statusFinish.required_fields.includes("summary")) {
      throw new Error("Status finish_session action must require summary");
    }

    const geminiStart = await runJson<AgentStartOutput>(command, [
      ...argsPrefix,
      "--store",
      storeGemini,
      "agent",
      "start",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "gemini",
      "--session-id",
      "gemini-smoke",
      "--current-task",
      "continue cross device lifecycle smoke",
      "--refresh-since",
      "2000-01-01T00:00:00.000Z"
    ]);

    if (geminiStart.sync.pull?.pulled !== true) throw new Error("Gemini start did not pull from sync remote");
    requireChange(geminiStart, statusSummary);
    requireRecentChange(geminiStart, statusSummary);
    requireAction(geminiStart.next.actions, "publish_status", "agent_status");
    requireAction(geminiStart.next.actions, "finish_session", "agent_finish");
    requireAction(geminiStart.next.actions, "refresh_context", "agent_start");

    const finishSummary = "Gemini smoke finish reached Codex";
    const finish = await runJson<AgentFinishOutput>(command, [
      ...argsPrefix,
      "--store",
      storeGemini,
      "agent",
      "finish",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "gemini",
      "--session-id",
      "gemini-smoke",
      "--summary",
      finishSummary
    ]);

    if (finish.sync.push?.pushed !== true) throw new Error("Gemini finish did not push to sync remote");
    const startNextSession = requireAction(finish.next.actions, "start_next_session", "agent_start");
    if (!startNextSession.command.includes("--current-task <current_task>")) {
      throw new Error("Finish start_next_session action must include a current_task placeholder");
    }

    const codexStart = await runJson<AgentStartOutput>(command, [
      ...argsPrefix,
      "--store",
      storeCodex,
      "agent",
      "start",
      "--project",
      project,
      "--sync-remote",
      remote,
      "--agent",
      "codex",
      "--session-id",
      "codex-smoke-2",
      "--current-task",
      "verify Gemini handoff",
      "--refresh-since",
      status.record.updated_at
    ]);

    if (codexStart.sync.pull?.pulled !== true) throw new Error("Codex start did not pull Gemini handoff");
    requireChange(codexStart, finishSummary);

    log(`agent lifecycle smoke passed (${options.remote ? "remote" : "local"} Git remote)`);
    log(statusSummary);
    log(finishSummary);
  } finally {
    if (options.keepTemp) {
      log(`kept smoke directory: ${root}`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
