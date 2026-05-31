import { operationArgumentsByTool, operationCliArgvByTool, type OperationArgumentMetadata } from "../operation-contracts.js";
import { commandLineForCliInterface } from "./cli-command-line.js";

type ActionInterfaces<TArguments> = {
  cli: {
    command: string;
    command_line: string;
    argv: string[];
    executable: string;
    args: string[];
    exec_file: {
      executable: string;
      args: string[];
    };
    placeholders: string[];
    has_placeholders: boolean;
  };
  mcp: {
    tool: string;
    arguments: Record<string, unknown>;
  };
};

const DIRECT_CLI_EXECUTABLES = new Set(["moryn-agent-smoke"]);

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

function pathValue(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)[key]
      : undefined;
  }, root);
}

function setPathValue(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts.at(-1);
  if (leaf) current[leaf] = value;
}

function hasScalarPathParent(root: Record<string, unknown>, path: string): boolean {
  const parentKey = path.split(".").at(0);
  const parentValue = parentKey ? root[parentKey] : undefined;
  return parentValue !== undefined && (typeof parentValue !== "object" || parentValue === null || Array.isArray(parentValue));
}

function clonePlainValue(value: unknown): unknown {
  if (Array.isArray(value)) return [...value];
  if (typeof value === "object" && value !== null) return { ...value as Record<string, unknown> };
  return value;
}

function argumentValue(argumentsByName: Record<string, unknown>, argument: OperationArgumentMetadata): unknown {
  if (!argument.mcp) return argumentsByName[argument.name];
  if (!argument.mcp.path) return argumentsByName[argument.mcp.argument];
  const nestedValue = pathValue(argumentsByName, argument.mcp.path);
  if (nestedValue !== undefined) return nestedValue;
  const literalPathValue = argumentsByName[argument.mcp.path];
  return literalPathValue === undefined ? argumentsByName[argument.name] : literalPathValue;
}

function shouldSkipNestedCliArgument(
  argumentsByName: Record<string, unknown>,
  argument: OperationArgumentMetadata,
  operationArguments: OperationArgumentMetadata[]
): boolean {
  if (!argument.parent_argument || !argument.cli || !argument.mcp?.path) return false;
  const parentArgument = operationArguments.find((candidate) => candidate.name === argument.parent_argument);
  return Boolean(parentArgument?.cli && cliArgumentValue(argumentsByName, parentArgument, operationArguments) !== undefined);
}

function cliArgumentValue(argumentsByName: Record<string, unknown>, argument: OperationArgumentMetadata, operationArguments: OperationArgumentMetadata[]): unknown {
  return Boolean(argument.cli && argument.mcp && argument.mcp.argument === argument.name)
    ? parentObjectValueForArguments(argumentsByName, argument, operationArguments)
    : argumentValue(argumentsByName, argument);
}

function parentObjectValueForArguments(
  argumentsByName: Record<string, unknown>,
  argument: OperationArgumentMetadata,
  operationArguments: OperationArgumentMetadata[]
): unknown {
  const parentValue = argumentValue(argumentsByName, argument);
  if (parentValue !== undefined && (typeof parentValue !== "object" || parentValue === null || Array.isArray(parentValue))) return parentValue;
  const mergedValue = typeof parentValue === "object" && parentValue !== null && !Array.isArray(parentValue)
    ? { ...parentValue as Record<string, unknown> }
    : {};
  for (const childArgument of operationArguments) {
    if (childArgument.parent_argument !== argument.name || !childArgument.mcp?.path) continue;
    const key = childArgument.mcp.path.split(".").at(-1);
    if (!key || mergedValue[key] !== undefined) continue;
    const childValue = argumentValue(argumentsByName, childArgument);
    if (childValue !== undefined) mergedValue[key] = childValue;
  }
  return Object.keys(mergedValue).length > 0 ? mergedValue : undefined;
}

function pushFlagValue(argv: string[], flag: string, value: unknown): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      argv.push(flag, String(entry));
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    argv.push(flag, JSON.stringify(value));
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

function cliPlaceholders(argv: readonly string[]): string[] {
  return Array.from(new Set(argv.flatMap((arg) => {
    const match = /^<([^<>]+)>$/.exec(arg);
    return match ? [match[1]!] : [];
  })));
}

export function mcpArgumentsForAction(tool: string, argumentsByName: Record<string, unknown>): Record<string, unknown> {
  const operationArguments = operationArgumentList(tool);
  if (operationArguments.length === 0) return argumentsByName;
  const flattenedNestedArguments = new Set(operationArguments.flatMap((argument) => {
    return argument.parent_argument && argument.mcp?.path ? [argument.name, argument.mcp.path] : [];
  }));
  const normalizedArguments = Object.fromEntries(
    Object.entries(argumentsByName)
      .filter(([name]) => !flattenedNestedArguments.has(name))
      .map(([name, value]) => [name, clonePlainValue(value)])
  );
  for (const argument of operationArguments) {
    if (!argument.mcp) continue;
    const value = argumentValue(argumentsByName, argument);
    if (value === undefined) continue;
    if (argument.mcp.path) {
      if (hasScalarPathParent(normalizedArguments, argument.mcp.path)) continue;
      setPathValue(normalizedArguments, argument.mcp.path, clonePlainValue(value));
    } else {
      normalizedArguments[argument.mcp.argument] = clonePlainValue(value);
    }
  }
  return normalizedArguments;
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
    if (shouldSkipNestedCliArgument(argumentsByName, argument, operationArguments)) continue;
    const value = cliArgumentValue(argumentsByName, argument, operationArguments);
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
  const argv = cliArgvForAction(input.tool, input.arguments);
  const executable = DIRECT_CLI_EXECUTABLES.has(argv[0] ?? "") ? argv[0]! : "moryn";
  const args = executable === "moryn" ? argv : argv.slice(1);
  const placeholders = cliPlaceholders(args);
  return {
    cli: {
      command: input.command,
      command_line: commandLineForCliInterface(executable, args),
      argv,
      executable,
      args,
      exec_file: { executable, args },
      placeholders,
      has_placeholders: placeholders.length > 0
    },
    mcp: {
      tool: input.tool,
      arguments: mcpArgumentsForAction(input.tool, input.arguments)
    }
  };
}

export type { ActionInterfaces };
