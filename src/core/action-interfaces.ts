import { operationArgumentsByTool, operationCliArgvByTool, type OperationArgumentMetadata } from "../operation-contracts.js";

type ActionInterfaces<TArguments> = {
  cli: {
    command: string;
    argv: string[];
  };
  mcp: {
    tool: string;
    arguments: TArguments;
  };
};

const POSITIONAL_ALIASES: Record<string, string> = {
  "record-id": "record_id",
  "linked-record-id": "linked_record_id"
};

const FLAG_OBJECT_KEYS: Record<string, string[]> = {
  agent: ["client", "session_id", "model", "device_id"]
};

const RUNTIME_TOOL_ARGUMENTS: Record<string, OperationArgumentMetadata[]> = {
  "moryn-agent-smoke": [
    {
      name: "remote",
      type: "string",
      required: true,
      cli: { flag: "--remote" },
      mcp: { argument: "remote" }
    }
  ]
};

function operationArgumentList(tool: string): OperationArgumentMetadata[] {
  const operationArguments = Object.values(operationArgumentsByTool(tool));
  return operationArguments.length > 0 ? operationArguments : RUNTIME_TOOL_ARGUMENTS[tool] ?? [];
}

function argumentValue(argumentsByName: Record<string, unknown>, argument: OperationArgumentMetadata): unknown {
  if (!argument.mcp) return argumentsByName[argument.name];
  if (!argument.mcp.path) return argumentsByName[argument.mcp.argument];
  const root = argumentsByName[argument.mcp.argument];
  return argument.mcp.path.split(".").reduce<unknown>((value, key) => {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  }, root);
}

function pushFlagValue(argv: string[], flag: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      argv.push(flag, String(entry));
    }
    return;
  }
  argv.push(flag, String(value));
}

function pushFlagValues(argv: string[], argument: OperationArgumentMetadata, value: unknown): void {
  const flags = argument.cli?.flags;
  if (!flags?.length) {
    const flag = argument.cli?.flag;
    if (flag) pushFlagValue(argv, flag, value);
    return;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const values = value as Record<string, unknown>;
    const keys = FLAG_OBJECT_KEYS[argument.name] ?? flags.map((flag) => flag.replace(/^--/, "").replace(/-/g, "_"));
    flags.forEach((flag, index) => pushFlagValue(argv, flag, values[keys[index] ?? ""]));
    return;
  }
  pushFlagValue(argv, flags[0]!, value);
}

function pushBooleanFlag(argv: string[], argument: OperationArgumentMetadata, value: unknown): void {
  if (argument.cli?.flag && value === true) argv.push(argument.cli.flag);
  if (argument.cli?.negative_flag && value === false) argv.push(argument.cli.negative_flag);
}

function cliArgvPrefix(tool: string): string[] {
  const prefix: string[] = [];
  for (const part of operationCliArgvByTool(tool)) {
    if (/^<[^<>]+>$/.test(part)) {
      if (prefix.at(-1)?.startsWith("--")) prefix.pop();
      continue;
    }
    prefix.push(part);
  }
  return prefix;
}

export function cliArgvForAction(tool: string, argumentsByName: Record<string, unknown>): string[] {
  const operationArguments = operationArgumentList(tool);
  const positionals = operationArguments
    .filter((argument) => argument.cli?.positional && argumentValue(argumentsByName, argument) !== undefined)
    .map((argument) => ({
      argument,
      name: POSITIONAL_ALIASES[argument.cli?.positional ?? ""] ?? argument.cli?.positional ?? argument.name
    }))
    .sort((left, right) => {
      return Object.prototype.hasOwnProperty.call(argumentsByName, left.name) === Object.prototype.hasOwnProperty.call(argumentsByName, right.name)
        ? 0
        : Object.prototype.hasOwnProperty.call(argumentsByName, left.name) ? -1 : 1;
    });
  const argv = cliArgvPrefix(tool);
  for (const { argument } of positionals) {
    const value = argumentValue(argumentsByName, argument);
    if (Array.isArray(value)) {
      argv.push(...value.map(String));
    } else {
      argv.push(String(value));
    }
  }
  for (const argument of operationArguments) {
    if (argument.cli?.positional) continue;
    const value = argumentValue(argumentsByName, argument);
    if (argument.type === "boolean") {
      pushBooleanFlag(argv, argument, value);
      continue;
    }
    pushFlagValues(argv, argument, value);
  }
  return argv;
}

export function actionInterfaces<TArguments extends Record<string, unknown>>(input: {
  tool: string;
  command: string;
  arguments: TArguments;
}): ActionInterfaces<TArguments> {
  return {
    cli: {
      command: input.command,
      argv: cliArgvForAction(input.tool, input.arguments)
    },
    mcp: {
      tool: input.tool,
      arguments: input.arguments
    }
  };
}

export type { ActionInterfaces };
