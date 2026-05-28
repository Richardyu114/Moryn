#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { Command, CommanderError } from "commander";
import { version } from "./index.js";
import { agentDoctor, agentEnter, agentFinish, agentGuide, agentStart, agentStatus } from "./core/agent-lifecycle.js";
import { initializeStore } from "./core/config.js";
import { rebuildDerivedViews } from "./core/derived.js";
import { createEngine } from "./core/engine.js";
import { toErrorEnvelope } from "./core/errors.js";
import { initializeProjectConfig, resolveProjectContext } from "./core/project.js";
import { isValidPatchPath } from "./core/schema.js";
import { runMcpServer } from "./mcp/server.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "./sync/git.js";

const program = new Command();
const recordKinds = ["memory", "skill", "soul", "session_summary", "agent_note"] as const;
const recordScopes = ["global", "project", "topic", "session", "artifact"] as const;
const recordStates = ["raw", "candidate", "canonical", "archived", "quarantined"] as const;
const recordPriorities = ["low", "normal", "high"] as const;
const syncModes = ["manual", "session", "interval"] as const;

function storePath(): string {
  return parseNonEmptyString(program.opts<{ store?: string }>().store, "--store") ?? join(homedir(), ".moryn");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printError(error: unknown): void {
  process.stderr.write(`${JSON.stringify(toErrorEnvelope(error), null, 2)}\n`);
}

function createCliEngine() {
  const path = storePath();
  return createEngine({
    storePath: path,
    syncStatus: () => getGitSyncStatus(path)
  });
}

async function resolveOptionalProject(options: { project?: string; projectId?: string }): Promise<string | undefined> {
  if (!options.project && !options.projectId) return undefined;
  return (await resolveProjectContext({ projectPath: options.project, projectId: options.projectId })).project_id;
}

async function resolveProjectOptions(options: { project?: string; projectId?: string }): Promise<{ project_id?: string; default_skills?: string[] }> {
  if (!options.project && !options.projectId) return {};
  const project = await resolveProjectContext({ projectPath: options.project, projectId: options.projectId });
  return {
    project_id: project.project_id,
    default_skills: project.config?.default_skills
  };
}

function parseAssignmentValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseAssignments(assignments: string[]): Record<string, unknown> {
  return Object.fromEntries(assignments.map((assignment) => {
    const [key, ...rest] = assignment.split("=");
    if (!key || !isValidPatchPath(key) || !rest.length) {
      throw new Error(`Invalid argument: Invalid --set assignment: ${assignment}`);
    }
    return [key, parseAssignmentValue(rest.join("="))];
  }));
}

function parseContentJson(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid argument: Invalid --content-json; ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid argument: Invalid --content-json; expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseLimit(value: string, option = "--limit"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error(`Invalid argument: Invalid ${option}; must be an integer between 1 and 100`);
  }
  return parsed;
}

function parseConfidence(value: string | undefined, option = "--confidence"): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid argument: Invalid ${option}; must be a number between 0 and 1`);
  }
  return parsed;
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], option: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid argument: Invalid ${option}; expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseEnumList<T extends string>(values: string[], allowed: readonly T[], option: string): T[] {
  return values.map((value) => parseEnum(value, allowed, option) as T);
}

function parseNonEmptyString(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw new Error(`Invalid argument: Invalid ${option}; must not be empty`);
  }
  return value;
}

function collectNonEmptyOption(option: string) {
  return (value: string, previous: string[] = []): string[] => {
    if (value.length === 0) {
      throw new Error(`Invalid argument: Invalid ${option}; must not be empty`);
    }
    return [...previous, value];
  };
}

function validateSyncOperationOptions(options: { status?: boolean; push?: boolean; pull?: boolean; message?: string }): void {
  const selected = [options.status, options.push, options.pull].filter(Boolean).length;
  if (selected > 1) {
    throw new Error("Invalid argument: choose only one sync operation");
  }
  if (options.message !== undefined && !options.push) {
    throw new Error("Invalid argument: --message requires --push");
  }
}

function parseBooleanDefault(value: unknown, fallback: boolean): boolean {
  return value === undefined ? fallback : Boolean(value);
}

function parseAgentOptions(options: { agent?: string; sessionId?: string; model?: string; deviceId?: string }) {
  return {
    client: parseNonEmptyString(options.agent, "--agent") ?? "cli",
    session_id: parseNonEmptyString(options.sessionId, "--session-id"),
    model: parseNonEmptyString(options.model, "--model"),
    device_id: parseNonEmptyString(options.deviceId, "--device-id")
  };
}

program
  .name("moryn")
  .description("Moryn CLI")
  .version(version)
  .configureOutput({
    outputError: () => {}
  })
  .exitOverride()
  .option("--store <path>", "Override Moryn store path");

program.command("init").action(async () => {
  printJson({ ok: true, ...await initializeStore(storePath()) });
});

program.command("write")
  .requiredOption("--kind <kind>")
  .option("--type <type>")
  .option("--scope <scope>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--tag <tag>", "Record tag", collectNonEmptyOption("--tag"), [])
  .option("--state <state>")
  .option("--confidence <n>", "Record confidence")
  .option("--priority <priority>")
  .option("--derived-from <id>", "Source record id for provenance", collectNonEmptyOption("--derived-from"), [])
  .option("--reason <reason>", "Provenance reason")
  .option("--confirm", "Confirm a high-risk canonical write")
  .option("--text <text>")
  .option("--content-json <json>", "Structured JSON object content")
  .action(async (options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options);
    const project = options.project ? await resolveProjectContext({ projectPath: options.project, projectId: options.projectId }) : undefined;
    const type = options.type ?? (options.kind === "session_summary" ? "summary" : undefined);
    const scope = options.scope ?? (options.kind === "session_summary" ? "project" : undefined);
    if (!type) throw new Error("Invalid argument: required option '--type <type>' not specified");
    if (!scope) throw new Error("Invalid argument: required option '--scope <scope>' not specified");
    const content = parseContentJson(options.contentJson);
    const text = parseNonEmptyString(options.text, "--text");
    const reason = parseNonEmptyString(options.reason, "--reason");
    if (content && text !== undefined) {
      throw new Error("Invalid argument: use either --text or --content-json, not both");
    }
    if (!content && text === undefined) {
      throw new Error("Invalid argument: required option '--text <text>' or '--content-json <json>' not specified");
    }
    const result = await engine.write({
      kind: parseEnum(options.kind, recordKinds, "--kind")!,
      type,
      scope: parseEnum(scope, recordScopes, "--scope")!,
      project_id: projectId,
      tags: [...(project?.config?.tags ?? []), ...options.tag],
      content: content ?? { text, format: "text" },
      state: parseEnum(options.state, recordStates, "--state"),
      confidence: parseConfidence(options.confidence),
      priority: parseEnum(options.priority, recordPriorities, "--priority"),
      source: { client: "cli" },
      confirmed: options.confirm,
      provenance: reason || options.derivedFrom.length
        ? { reason, derived_from: options.derivedFrom }
        : undefined
    });
    printJson(result);
  });

program.command("recall")
  .argument("[query]", "Search query")
  .option("--record-id <id>", "Record id", collectNonEmptyOption("--record-id"), [])
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--kind <kind>", "Record kind", collectNonEmptyOption("--kind"), [])
  .option("--scope <scope>", "Record scope", collectNonEmptyOption("--scope"), [])
  .option("--type <type>", "Record type", collectNonEmptyOption("--type"), [])
  .option("--state <state>", "Record state", collectNonEmptyOption("--state"), [])
  .option("--tag <tag>", "Record tag", collectNonEmptyOption("--tag"), [])
  .option("--file <path>", "Related file path", collectNonEmptyOption("--file"), [])
  .option("--limit <n>", "Result limit", "10")
  .action(async (query, options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options);
    printJson(await engine.recall({
      record_ids: options.recordId,
      query: parseNonEmptyString(query, "query"),
      project_id: projectId,
      kinds: parseEnumList(options.kind, recordKinds, "--kind"),
      scopes: parseEnumList(options.scope, recordScopes, "--scope"),
      types: options.type,
      states: parseEnumList(options.state, recordStates, "--state"),
      tags: options.tag,
      files: options.file,
      limit: parseLimit(options.limit)
    }));
  });

program.command("boot")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--current-task <task>")
  .action(async (options) => {
    const engine = createCliEngine();
    const project = await resolveProjectOptions(options);
    printJson(await engine.boot({
      project_id: project.project_id,
      default_skills: project.default_skills,
      current_task: parseNonEmptyString(options.currentTask, "--current-task")
    }));
  });

program.command("revise")
  .argument("<record-id>")
  .requiredOption("--set <assignment>", "Patch assignment, repeatable", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--reason <reason>")
  .option("--confirm", "Confirm a high-risk or conflicting canonical revision")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.revise({
      record_id: recordId,
      patch: parseAssignments(options.set),
      reason: parseNonEmptyString(options.reason, "--reason"),
      source: { client: "cli" },
      confirmed: options.confirm
    }));
  });

program.command("promote")
  .argument("<record-id>")
  .requiredOption("--state <state>")
  .option("--reason <reason>")
  .option("--confirm", "Confirm a high-risk canonical promotion")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.promote({
      record_id: recordId,
      target_state: parseEnum(options.state, recordStates, "--state")!,
      reason: parseNonEmptyString(options.reason, "--reason"),
      source: { client: "cli" },
      confirmed: options.confirm
    }));
  });

program.command("archive")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.archive({ record_id: recordId, reason: parseNonEmptyString(options.reason, "--reason"), source: { client: "cli" } }));
  });

program.command("quarantine")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.quarantine({ record_id: recordId, reason: parseNonEmptyString(options.reason, "--reason"), source: { client: "cli" } }));
  });

program.command("link")
  .argument("<record-id>")
  .argument("<linked-record-id>")
  .requiredOption("--type <type>")
  .action(async (recordId, linkedRecordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.link({
      record_id: recordId,
      linked_record_id: linkedRecordId,
      link_type: options.type,
      source: { client: "cli" }
    }));
  });

program.command("list-recent")
  .option("--limit <n>", "Result limit", "20")
  .action(async (options) => {
    const engine = createCliEngine();
    printJson(await engine.listRecent(parseLimit(options.limit)));
  });

program.command("refresh")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--cursor <cursor>")
  .option("--current-task <task>")
  .option("--limit <n>", "Change limit", "20")
  .action(async (options) => {
    const engine = createCliEngine();
    printJson(await engine.refresh({
      project_id: await resolveOptionalProject(options),
      cursor: parseNonEmptyString(options.cursor, "--cursor"),
      current_task: parseNonEmptyString(options.currentTask, "--current-task"),
      limit: parseLimit(options.limit)
    }));
  });

program.command("rebuild").action(async () => {
  printJson(await rebuildDerivedViews(storePath()));
});

program.command("mcp").action(async () => {
  const path = storePath();
  const engine = createEngine({
    storePath: path,
    syncStatus: () => getGitSyncStatus(path)
  });
  await runMcpServer(engine, { storePath: path });
});

const agent = program.command("agent");

agent.command("guide")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Shared Git remote for cross-device handoff")
  .option("--current-task <task>")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    printJson(agentGuide({
      storePath: storePath(),
      projectPath: options.project,
      projectId: options.projectId,
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      agent: parseAgentOptions(options)
    }));
  });

agent.command("enter")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before startup")
  .option("--current-task <task>")
  .option("--refresh-since <cursor>")
  .option("--limit <n>", "Refresh change or project discovery limit", "20")
  .option("--no-pull", "Do not pull sync before boot when starting a known project")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    printJson(await agentEnter({
      storePath: storePath(),
      projectPath: options.project,
      projectId: options.projectId,
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      refreshSince: parseNonEmptyString(options.refreshSince, "--refresh-since"),
      limit: parseLimit(options.limit),
      pull: parseBooleanDefault(options.pull, true),
      agent: parseAgentOptions(options)
    }));
  });

agent.command("doctor")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Expected Git sync remote for cross-device handoff")
  .option("--current-task <task>")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    printJson(await agentDoctor({
      storePath: storePath(),
      projectPath: options.project,
      projectId: options.projectId,
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      agent: parseAgentOptions(options)
    }));
  });

agent.command("start")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before startup")
  .option("--current-task <task>")
  .option("--refresh-since <cursor>")
  .option("--limit <n>", "Refresh change limit", "20")
  .option("--no-pull", "Do not pull sync before boot")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    printJson(await agentStart({
      storePath: storePath(),
      projectPath: options.project,
      projectId: options.projectId,
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      refreshSince: parseNonEmptyString(options.refreshSince, "--refresh-since"),
      limit: parseLimit(options.limit),
      pull: parseBooleanDefault(options.pull, true),
      agent: parseAgentOptions(options)
    }));
  });

agent.command("status")
  .requiredOption("--status <text>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before publishing status")
  .option("--current-task <task>")
  .option("--no-push", "Do not push sync after writing the status")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    printJson(await agentStatus({
      storePath: storePath(),
      projectPath: options.project,
      projectId: options.projectId,
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      status: parseNonEmptyString(options.status, "--status")!,
      push: parseBooleanDefault(options.push, true),
      agent: parseAgentOptions(options)
    }));
  });

agent.command("finish")
  .requiredOption("--summary <text>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--sync-remote <remote>", "Initialize or connect Git sync before handoff")
  .option("--current-task <task>")
  .option("--no-push", "Do not push sync after writing the handoff")
  .option("--agent <client>", "Agent client name")
  .option("--session-id <id>")
  .option("--model <model>")
  .option("--device-id <id>")
  .action(async (options) => {
    printJson(await agentFinish({
      storePath: storePath(),
      projectPath: options.project,
      projectId: options.projectId,
      syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
      summary: parseNonEmptyString(options.summary, "--summary")!,
      push: parseBooleanDefault(options.push, true),
      agent: parseAgentOptions(options)
    }));
  });

const project = program.command("project");

project.command("init")
  .option("--path <path>", "Project path", process.cwd())
  .option("--project-id <id>")
  .option("--tag <tag>", "Project tag", collectNonEmptyOption("--tag"), [])
  .option("--default-skill <selector>", "Default skill selector", collectNonEmptyOption("--default-skill"), [])
  .option("--sync-mode <mode>", "Sync mode")
  .action(async (options) => {
    printJson({
      ok: true,
      ...await initializeProjectConfig(options.path, {
        project_id: options.projectId,
        tags: options.tag,
        default_skills: options.defaultSkill,
        sync: options.syncMode === undefined
          ? undefined
          : { mode: parseEnum(options.syncMode, syncModes, "--sync-mode") }
      })
    });
  });

project.command("list")
  .option("--limit <n>", "Project limit", "20")
  .option("--current-task <task>", "Current task to prefill in each agent_start next action")
  .option("--sync-remote <remote>", "Shared Git remote to prefill in each agent_start next action")
  .option("--agent <client>", "Agent client name to prefill in each agent_start next action")
  .option("--session-id <id>", "Agent session id to prefill in each agent_start next action")
  .option("--model <model>", "Agent model to prefill in each agent_start next action")
  .option("--device-id <id>", "Agent device id to prefill in each agent_start next action")
  .action(async (options) => {
    const engine = createCliEngine();
    printJson(await engine.listProjects({
      limit: parseLimit(options.limit),
      current_task: parseNonEmptyString(options.currentTask, "--current-task"),
      sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      agent: options.agent || options.sessionId || options.model || options.deviceId
        ? parseAgentOptions(options)
        : undefined
    }));
  });

const sync = program.command("sync");

sync.command("init")
  .argument("<remote>")
  .action(async (remote) => {
    printJson(await initializeGitSync(storePath(), remote));
  });

sync
  .option("--status", "Show sync status")
  .option("--push", "Commit and push local events")
  .option("--pull", "Pull remote events")
  .option("--message <message>", "Commit message for --push")
  .action(async (options) => {
    validateSyncOperationOptions(options);
    if (options.push) {
      printJson(await pushGitSync(storePath(), { message: parseNonEmptyString(options.message, "--message") }));
      return;
    }
    if (options.pull) {
      printJson(await pullGitSync(storePath()));
      return;
    }
    printJson(await getGitSyncStatus(storePath()));
  });

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
    return;
  }

  if (error instanceof CommanderError) {
    const message = error.message.startsWith("error: ") ? error.message.slice("error: ".length) : error.message;
    printError(new Error(`Invalid argument: ${message}`));
    process.exitCode = error.exitCode;
    return;
  }

  printError(error);
  process.exitCode = 1;
});
