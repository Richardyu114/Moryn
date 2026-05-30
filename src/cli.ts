#!/usr/bin/env node

import { join } from "node:path";
import { homedir } from "node:os";
import { Command, CommanderError } from "commander";
import {
  getOperationContract,
  getOperationContractByCliCommand,
  getOperationContractByMcpTool,
  getOperationContractIndex,
  getOperationContracts,
  getSelectionSourceContracts,
  version
} from "./index.js";
import { OperationContractLookupConflictError, OperationContractLookupError, type OperationContractLookupOption } from "./operation-contracts.js";
import { agentDoctor, agentEnter, agentFinish, agentGuide, agentStart, agentStatus } from "./core/agent-lifecycle.js";
import { initializeStore } from "./core/config.js";
import { rebuildDerivedViews } from "./core/derived.js";
import { createEngine } from "./core/engine.js";
import {
  commandForAgentFinishContext,
  commandForAgentStartContext,
  commandForAgentStatusContext,
  commandForArchiveContext,
  commandForLinkContext,
  commandForPromoteContext,
  commandForRecallContext,
  commandForQuarantineContext,
  commandForReviseContext,
  type MorynErrorContext,
  toErrorEnvelope
} from "./core/errors.js";
import { SYNC_MODES, initializeProjectConfig, resolveProjectContext } from "./core/project.js";
import {
  RECORD_KINDS,
  RECORD_PRIORITIES,
  RECORD_SCOPES,
  RECORD_STATES,
  isValidPatchPath
} from "./core/schema.js";
import { runMcpServer } from "./mcp/server.js";
import { getGitSyncStatus, initializeGitSync, pullGitSync, pushGitSync } from "./sync/git.js";

const program = new Command();
const recordKinds = RECORD_KINDS;
const recordScopes = RECORD_SCOPES;
const recordStates = RECORD_STATES;
const recordPriorities = RECORD_PRIORITIES;
const syncModes = SYNC_MODES;

const CLI_ARGUMENT_RECOVERY_ACTION_PREFIX = "retry with a valid" as const;

type CliArgumentRecoveryHint =
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "integer_range"; min: number; max: number; integer: true };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "allowed_values"; allowed_values: string[] };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      missing_argument: { option: string; placeholder: string };
      expected: { kind: "required_option"; required: true };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: string; value: string };
      expected: { kind: "non_empty_string"; min_length: 1 };
      retry_with: { option: string; value_placeholder: string };
    }
  | {
      rejected_argument: { option: "--content-json"; value: string };
      expected: { kind: "valid_json_object" | "json_object" };
      retry_with: { option: "--content-json"; value_placeholder: "<json object>" };
    }
  | {
      missing_one_of: Array<{ option: "--text" | "--content-json"; value_placeholder: string }>;
      expected: { kind: "choose_one"; options: ["--text", "--content-json"] };
      retry_with: Array<{ option: "--text" | "--content-json"; value_placeholder: string }>;
    }
  | {
      rejected_arguments: Array<{ option: "--text" | "--content-json"; value: string }>;
      expected: { kind: "choose_one"; options: ["--text", "--content-json"] };
      retry_with: Array<{ option: "--text" | "--content-json"; value_placeholder: string }>;
    };

class CliArgumentError extends Error {
  readonly recommended_action: string;
  readonly recovery_hint: CliArgumentRecoveryHint;

  constructor(message: string, recommendedAction: string, recoveryHint: CliArgumentRecoveryHint) {
    super(message);
    this.name = "CliArgumentError";
    this.recommended_action = recommendedAction;
    this.recovery_hint = recoveryHint;
  }
}

function storePath(): string {
  return parseNonEmptyString(program.opts<{ store?: string }>().store, "--store") ?? join(homedir(), ".moryn");
}

function printJson(value: unknown, options: { pretty?: boolean } = {}): void {
  process.stdout.write(`${JSON.stringify(value, null, options.pretty === false ? undefined : 2)}\n`);
}

function printError(error: unknown, context?: MorynErrorContext): void {
  process.stderr.write(`${JSON.stringify(toErrorEnvelope(error, context), null, 2)}\n`);
}

function cliRequiredOptionError(message: string): CliArgumentError | undefined {
  const match = /^required option '([^ ]+) ([^']+)' not specified$/.exec(message);
  if (!match) return undefined;
  const [, option, placeholder] = match;
  if (!option || !placeholder) return undefined;
  return requiredCliOptionError(option, placeholder, message);
}

function requiredCliOptionError(option: string, placeholder: string, message?: string): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: ${message ?? `required option '${option} ${placeholder}' not specified`}`,
    `retry with required ${option}`,
    {
      missing_argument: { option, placeholder },
      expected: { kind: "required_option", required: true },
      retry_with: { option, value_placeholder: placeholder }
    }
  );
}

function nonEmptyCliArgumentError(option: string): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: Invalid ${option}; must not be empty`,
    `retry with a non-empty ${option} value`,
    {
      rejected_argument: { option, value: "" },
      expected: { kind: "non_empty_string", min_length: 1 },
      retry_with: { option, value_placeholder: `<non-empty ${option.replace(/^--/, "")}>` }
    }
  );
}

function contentJsonCliArgumentError(value: string, expectedKind: "valid_json_object" | "json_object", detail?: string): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: Invalid --content-json${detail ? `; ${detail}` : ""}`,
    "retry with a valid --content-json JSON object",
    {
      rejected_argument: { option: "--content-json", value },
      expected: { kind: expectedKind },
      retry_with: { option: "--content-json", value_placeholder: "<json object>" }
    }
  );
}

const WRITE_CONTENT_RETRY_OPTIONS = [
  { option: "--text", value_placeholder: "<text>" },
  { option: "--content-json", value_placeholder: "<json object>" }
] as const;

function writeContentChoiceCliArgumentError(
  message: string,
  rejectedArguments?: Array<{ option: "--text" | "--content-json"; value: string }>
): CliArgumentError {
  return new CliArgumentError(
    `Invalid argument: ${message}`,
    "retry with exactly one write content input",
    {
      ...(rejectedArguments
        ? { rejected_arguments: rejectedArguments }
        : { missing_one_of: [...WRITE_CONTENT_RETRY_OPTIONS] }),
      expected: { kind: "choose_one", options: ["--text", "--content-json"] },
      retry_with: [...WRITE_CONTENT_RETRY_OPTIONS]
    }
  );
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
    throw contentJsonCliArgumentError(value, "valid_json_object", message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw contentJsonCliArgumentError(value, "json_object", "expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseLimit(value: string, option = "--limit"): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new CliArgumentError(
      `Invalid argument: Invalid ${option}; must be an integer between 1 and 100`,
      `${CLI_ARGUMENT_RECOVERY_ACTION_PREFIX} ${option} value`,
      {
        rejected_argument: { option, value },
        expected: { kind: "integer_range", min: 1, max: 100, integer: true },
        retry_with: { option, value_placeholder: "<integer 1-100>" }
      }
    );
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
    throw new CliArgumentError(
      `Invalid argument: Invalid ${option}; expected one of ${allowed.join(", ")}`,
      `retry with a supported ${option} value`,
      {
        rejected_argument: { option, value },
        expected: { kind: "allowed_values", allowed_values: [...allowed] },
        retry_with: { option, value_placeholder: `<${option.slice(2)} from allowed_values>` }
      }
    );
  }
  return value as T;
}

function parseEnumList<T extends string>(values: string[], allowed: readonly T[], option: string): T[] {
  return values.map((value) => parseEnum(value, allowed, option) as T);
}

function parseNonEmptyString(value: string | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0) {
    throw nonEmptyCliArgumentError(option);
  }
  return value;
}

function collectNonEmptyOption(option: string) {
  return (value: string, previous: string[] = []): string[] => {
    if (value.length === 0) {
      throw nonEmptyCliArgumentError(option);
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

function compactUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
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

program.command("init")
  .option("--repair", "Replace an invalid local config.json after explicit confirmation")
  .action(async (options) => {
    printJson({ ok: true, ...await initializeStore(storePath(), { repair: options.repair }) });
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
    if (!type) throw requiredCliOptionError("--type", "<type>");
    if (!scope) throw requiredCliOptionError("--scope", "<scope>");
    const content = parseContentJson(options.contentJson);
    const text = parseNonEmptyString(options.text, "--text");
    const reason = parseNonEmptyString(options.reason, "--reason");
    if (content && text !== undefined) {
      throw writeContentChoiceCliArgumentError(
        "use either --text or --content-json, not both",
        [
          { option: "--text", value: text },
          { option: "--content-json", value: options.contentJson }
        ]
      );
    }
    if (!content && text === undefined) {
      throw writeContentChoiceCliArgumentError("required option '--text <text>' or '--content-json <json>' not specified");
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
    const limit = parseLimit(options.limit);
    const recallInput = {
      record_ids: options.recordId,
      query: parseNonEmptyString(query, "query"),
      project_id: projectId,
      kinds: parseEnumList(options.kind, recordKinds, "--kind"),
      scopes: parseEnumList(options.scope, recordScopes, "--scope"),
      types: options.type,
      states: parseEnumList(options.state, recordStates, "--state"),
      tags: options.tag,
      files: options.file,
      limit
    };
    const contextArguments = {
      ...(options.recordId.length ? { record_ids: options.recordId } : {}),
      ...(recallInput.query !== undefined ? { query: recallInput.query } : {}),
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      ...(recallInput.kinds.length ? { kinds: recallInput.kinds } : {}),
      ...(recallInput.scopes.length ? { scopes: recallInput.scopes } : {}),
      ...(options.type.length ? { types: options.type } : {}),
      ...(recallInput.states.length ? { states: recallInput.states } : {}),
      ...(options.tag.length ? { tags: options.tag } : {}),
      ...(options.file.length ? { files: options.file } : {}),
      ...(options.limit !== "10" ? { limit } : {})
    };
    const context = {
      tool: "recall",
      command: commandForRecallContext(contextArguments),
      arguments: contextArguments
    };
    try {
      printJson(await engine.recall(recallInput));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
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
    const patch = parseAssignments(options.set);
    const reason = parseNonEmptyString(options.reason, "--reason");
    const context = {
      tool: "revise",
      command: commandForReviseContext({ record_id: recordId, patch, reason }),
      arguments: {
        record_id: recordId,
        patch,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.revise({
        record_id: recordId,
        patch,
        reason,
        source: { client: "cli" },
        confirmed: options.confirm
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("promote")
  .argument("<record-id>")
  .requiredOption("--state <state>")
  .option("--reason <reason>")
  .option("--confirm", "Confirm a high-risk canonical promotion")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const targetState = parseEnum(options.state, recordStates, "--state")!;
    const reason = parseNonEmptyString(options.reason, "--reason");
    const context = {
      tool: "promote",
      command: commandForPromoteContext({ record_id: recordId, target_state: targetState, reason }),
      arguments: {
        record_id: recordId,
        target_state: targetState,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.promote({
        record_id: recordId,
        target_state: targetState,
        reason,
        source: { client: "cli" },
        confirmed: options.confirm
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("archive")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const reason = parseNonEmptyString(options.reason, "--reason");
    const context = {
      tool: "archive",
      command: commandForArchiveContext({ record_id: recordId, reason }),
      arguments: {
        record_id: recordId,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.archive({ record_id: recordId, reason, source: { client: "cli" } }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("quarantine")
  .argument("<record-id>")
  .option("--reason <reason>")
  .action(async (recordId, options) => {
    const engine = createCliEngine();
    const reason = parseNonEmptyString(options.reason, "--reason");
    const context = {
      tool: "quarantine",
      command: commandForQuarantineContext({ record_id: recordId, reason }),
      arguments: {
        record_id: recordId,
        ...(reason !== undefined ? { reason } : {})
      }
    };
    try {
      printJson(await engine.quarantine({ record_id: recordId, reason, source: { client: "cli" } }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

program.command("link")
  .argument("<record-id>")
  .argument("<linked-record-id>")
  .requiredOption("--type <type>")
  .action(async (recordId, linkedRecordId, options) => {
    const engine = createCliEngine();
    const context = {
      tool: "link",
      command: commandForLinkContext({ record_id: recordId, linked_record_id: linkedRecordId, link_type: options.type }),
      arguments: {
        record_id: recordId,
        linked_record_id: linkedRecordId,
        link_type: options.type
      }
    };
    try {
      printJson(await engine.link({
        record_id: recordId,
        linked_record_id: linkedRecordId,
        link_type: options.type,
        source: { client: "cli" }
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
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

const contracts = program.command("contracts");

contracts.command("selection-sources")
  .description("Print stable selection-source field-path contracts.")
  .action(() => {
    printJson(getSelectionSourceContracts());
  });

contracts.command("operations")
  .description("Print stable CLI and MCP operation contracts.")
  .option("--index", "Print a compact operation lookup index")
  .option("--operation <id>", "Print one operation contract by id")
  .option("--mcp-tool <tool>", "Print one operation contract by MCP tool name")
  .option("--cli-command <command>", "Print one operation contract by display CLI command")
  .action((options: { index?: boolean; operation?: string; mcpTool?: string; cliCommand?: string }) => {
    const operation = parseNonEmptyString(options.operation, "--operation");
    const mcpTool = parseNonEmptyString(options.mcpTool, "--mcp-tool");
    const cliCommand = parseNonEmptyString(options.cliCommand, "--cli-command");
    const lookupOptions: OperationContractLookupOption[] = [
      ...(options.index ? [{ mode: "index" as const, option: "--index" }] : []),
      ...(operation ? [{ mode: "operation" as const, option: "--operation" }] : []),
      ...(mcpTool ? [{ mode: "mcp_tool" as const, option: "--mcp-tool" }] : []),
      ...(cliCommand ? [{ mode: "cli_command" as const, option: "--cli-command" }] : [])
    ];
    if (lookupOptions.length > 1) {
      throw new OperationContractLookupConflictError(lookupOptions, "--index, --operation, --mcp-tool, or --cli-command");
    }
    if (options.index) {
      printJson(getOperationContractIndex(), { pretty: false });
      return;
    }
    if (operation) {
      const contract = getOperationContract(operation);
      if (!contract) throw new OperationContractLookupError("operation", operation);
      printJson(contract, { pretty: false });
      return;
    }
    if (mcpTool) {
      const contract = getOperationContractByMcpTool(mcpTool);
      if (!contract) throw new OperationContractLookupError("mcp_tool", mcpTool);
      printJson(contract, { pretty: false });
      return;
    }
    if (cliCommand) {
      const contract = getOperationContractByCliCommand(cliCommand);
      if (!contract) throw new OperationContractLookupError("cli_command", cliCommand);
      printJson(contract, { pretty: false });
      return;
    }
    printJson(getOperationContracts(), { pretty: false });
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
    const pull = parseBooleanDefault(options.pull, true);
    const agentOptions = parseAgentOptions(options);
    const contextArguments = compactUndefined({
      project_id: parseNonEmptyString(options.projectId, "--project-id"),
      project_path: parseNonEmptyString(options.project, "--project"),
      sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      current_task: parseNonEmptyString(options.currentTask, "--current-task"),
      refresh_since: parseNonEmptyString(options.refreshSince, "--refresh-since"),
      ...(options.limit !== "20" ? { limit: parseLimit(options.limit) } : {}),
      ...(pull === false ? { pull } : {}),
      agent: agentOptions
    });
    const context = {
      tool: "agent_start",
      command: commandForAgentStartContext(contextArguments),
      arguments: contextArguments
    };
    try {
      printJson(await agentStart({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
        currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
        refreshSince: parseNonEmptyString(options.refreshSince, "--refresh-since"),
        limit: parseLimit(options.limit),
        pull,
        agent: agentOptions
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
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
    const push = parseBooleanDefault(options.push, true);
    const agentOptions = parseAgentOptions(options);
    const status = parseNonEmptyString(options.status, "--status")!;
    const contextInput = {
      project_id: parseNonEmptyString(options.projectId, "--project-id"),
      project_path: parseNonEmptyString(options.project, "--project"),
      sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      current_task: parseNonEmptyString(options.currentTask, "--current-task"),
      status,
      ...(push === false ? { push } : {}),
      agent: agentOptions
    };
    const contextArguments = compactUndefined(contextInput);
    const context = {
      tool: "agent_status",
      command: commandForAgentStatusContext(contextInput),
      arguments: contextArguments
    };
    try {
      printJson(await agentStatus({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
        currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
        status,
        push,
        agent: agentOptions
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
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
    const push = parseBooleanDefault(options.push, true);
    const agentOptions = parseAgentOptions(options);
    const summary = parseNonEmptyString(options.summary, "--summary")!;
    const contextInput = {
      project_id: parseNonEmptyString(options.projectId, "--project-id"),
      project_path: parseNonEmptyString(options.project, "--project"),
      sync_remote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
      current_task: parseNonEmptyString(options.currentTask, "--current-task"),
      summary,
      ...(push === false ? { push } : {}),
      agent: agentOptions
    };
    const contextArguments = compactUndefined(contextInput);
    const context = {
      tool: "agent_finish",
      command: commandForAgentFinishContext(contextInput),
      arguments: contextArguments
    };
    try {
      printJson(await agentFinish({
        storePath: storePath(),
        projectPath: options.project,
        projectId: options.projectId,
        syncRemote: parseNonEmptyString(options.syncRemote, "--sync-remote"),
        currentTask: parseNonEmptyString(options.currentTask, "--current-task"),
        summary,
        push,
        agent: agentOptions
      }));
    } catch (error) {
      printError(error, context);
      process.exitCode = 1;
    }
  });

const project = program.command("project");

project.command("init")
  .option("--path <path>", "Project path", process.cwd())
  .option("--project-id <id>")
  .option("--tag <tag>", "Project tag", collectNonEmptyOption("--tag"), [])
  .option("--default-skill <selector>", "Default skill selector", collectNonEmptyOption("--default-skill"), [])
  .option("--sync-mode <mode>", "Sync mode")
  .option("--repair", "Replace an invalid existing .moryn.json after explicit confirmation")
  .action(async (options) => {
    printJson({
      ok: true,
      ...await initializeProjectConfig(options.path, {
        project_id: options.projectId,
        tags: options.tag,
        default_skills: options.defaultSkill,
        sync: options.syncMode === undefined
          ? undefined
          : { mode: parseEnum(options.syncMode, syncModes, "--sync-mode") },
        repair: options.repair
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
    printError(cliRequiredOptionError(message) ?? new Error(`Invalid argument: ${message}`));
    process.exitCode = error.exitCode;
    return;
  }

  printError(error);
  process.exitCode = 1;
});
