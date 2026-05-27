#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { Command, CommanderError } from "commander";
import { version } from "./index.js";
import { initializeStore } from "./core/config.js";
import { rebuildDerivedViews } from "./core/derived.js";
import { createEngine } from "./core/engine.js";
import { toErrorEnvelope } from "./core/errors.js";
import { initializeProjectConfig, resolveProjectContext } from "./core/project.js";
import { runMcpServer } from "./mcp/server.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "./sync/git.js";

const program = new Command();
const recordKinds = ["memory", "skill", "soul", "session_summary", "agent_note"] as const;
const recordScopes = ["global", "project", "topic", "session", "artifact"] as const;
const recordStates = ["raw", "candidate", "canonical", "archived", "quarantined"] as const;
const recordPriorities = ["low", "normal", "high"] as const;
const syncModes = ["manual", "session", "interval"] as const;

function storePath(): string {
  return program.opts<{ store?: string }>().store ?? join(homedir(), ".memora");
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
    if (!key || !rest.length) {
      throw new Error(`Invalid assignment: ${assignment}`);
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

program
  .name("mem")
  .description("Memora CLI")
  .version(version)
  .configureOutput({
    outputError: () => {}
  })
  .exitOverride()
  .option("--store <path>", "Override Memora store path");

program.command("init").action(async () => {
  printJson({ ok: true, ...await initializeStore(storePath()) });
});

program.command("write")
  .requiredOption("--kind <kind>")
  .option("--type <type>")
  .option("--scope <scope>")
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--tag <tag>", "Record tag", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--state <state>")
  .option("--confidence <n>", "Record confidence")
  .option("--priority <priority>")
  .option("--derived-from <id>", "Source record id for provenance", (value: string, previous: string[] = []) => [...previous, value], [])
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
    if (content && options.text !== undefined) {
      throw new Error("Invalid argument: use either --text or --content-json, not both");
    }
    if (!content && options.text === undefined) {
      throw new Error("Invalid argument: required option '--text <text>' or '--content-json <json>' not specified");
    }
    const result = await engine.write({
      kind: parseEnum(options.kind, recordKinds, "--kind")!,
      type,
      scope: parseEnum(scope, recordScopes, "--scope")!,
      project_id: projectId,
      tags: [...(project?.config?.tags ?? []), ...options.tag],
      content: content ?? { text: options.text, format: "text" },
      state: parseEnum(options.state, recordStates, "--state"),
      confidence: parseConfidence(options.confidence),
      priority: parseEnum(options.priority, recordPriorities, "--priority"),
      source: { client: "cli" },
      confirmed: options.confirm,
      provenance: options.reason || options.derivedFrom.length
        ? { reason: options.reason, derived_from: options.derivedFrom }
        : undefined
    });
    printJson(result);
  });

program.command("recall")
  .argument("[query]", "Search query")
  .option("--record-id <id>", "Record id", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--project-id <id>")
  .option("--project <path>")
  .option("--kind <kind>", "Record kind", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--scope <scope>", "Record scope", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--type <type>", "Record type", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--state <state>", "Record state", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--tag <tag>", "Record tag", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--file <path>", "Related file path", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--limit <n>", "Result limit", "10")
  .action(async (query, options) => {
    const engine = createCliEngine();
    const projectId = await resolveOptionalProject(options);
    printJson(await engine.recall({
      record_ids: options.recordId,
      query,
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
      current_task: options.currentTask
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
      reason: options.reason,
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
      reason: options.reason,
      source: { client: "cli" },
      confirmed: options.confirm
    }));
  });

program.command("archive")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.archive({ record_id: recordId, reason: options.reason, source: { client: "cli" } }));
  });

program.command("quarantine")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    printJson(await engine.quarantine({ record_id: recordId, reason: options.reason, source: { client: "cli" } }));
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
      cursor: options.cursor,
      current_task: options.currentTask,
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

const project = program.command("project");

project.command("init")
  .option("--path <path>", "Project path", process.cwd())
  .option("--project-id <id>")
  .option("--tag <tag>", "Project tag", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--default-skill <selector>", "Default skill selector", (value: string, previous: string[] = []) => [...previous, value], [])
  .option("--sync-mode <mode>", "Sync mode", "session")
  .action(async (options) => {
    printJson({
      ok: true,
      ...await initializeProjectConfig(options.path, {
        project_id: options.projectId,
        tags: options.tag,
        default_skills: options.defaultSkill,
        sync: { mode: parseEnum(options.syncMode, syncModes, "--sync-mode") }
      })
    });
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
    if (options.push) {
      printJson(await pushGitSync(storePath(), { message: options.message }));
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
